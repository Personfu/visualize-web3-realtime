import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import { readChatRequest, ChatRequestError } from '../features/World/ai/chatRequest';
import { POST } from '../app/api/world-chat/route';

const fixture = { messages: [{ role: 'user', content: 'Offline scene question' }], context: { stats: { totalEvents: 0, totalVolume: 0, connections: 0 }, hubCount: 0 } };

test('bounded chat parser accepts a complete synthetic request without any model operation', async () => {
  const result = await readChatRequest(new Request('http://localhost/api/world-chat', { method: 'POST', body: JSON.stringify(fixture) }));
  assert.deepEqual(result, fixture);
});

test('the real route rejects malformed and incomplete input before touching any provider', async () => {
  const fetch = globalThis.fetch;
  let attempted = 0;
  globalThis.fetch = async () => { attempted++; throw new Error('Network forbidden in offline validation'); };
  try {
    for (const body of ['{', 'null', '[]', JSON.stringify({ messages: fixture.messages }), JSON.stringify({ ...fixture, messages: [{ role: 'system', content: 'invalid' }] }), JSON.stringify({ ...fixture, context: { ...fixture.context, hubCount: -1 } })]) {
      const response = await POST(new NextRequest('http://localhost/api/world-chat', { method: 'POST', body }));
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(await response.json(), { error: 'Invalid chat request' });
    }
    assert.equal(attempted, 0);
  } finally { globalThis.fetch = fetch; }
});

test('the actual streamed byte limit cancels oversized input without trusting Content-Length', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(128 * 1024)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  });
  const request = new Request('http://localhost/api/world-chat', { method: 'POST', body, duplex: 'half' } as RequestInit);
  await assert.rejects(readChatRequest(request), error => error instanceof ChatRequestError && error.status === 413);
  assert.equal(cancelled, true);
});
