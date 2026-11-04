import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(8000),
  }).strict()).min(1).max(32),
  context: z.object({
    stats: z.object({
      totalEvents: count,
      totalVolume: z.number().nonnegative().finite().max(Number.MAX_SAFE_INTEGER),
      connections: count,
    }).strict(),
    hubCount: count,
  }).strict(),
}).strict();

export class ChatRequestError extends Error {
  constructor(readonly status: 400 | 413) { super('Invalid chat request'); }
}

export async function readChatRequest(request: Request) {
  const limit = 128 * 1024;
  const length = request.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > limit) throw new ChatRequestError(413);
  if (!request.body) throw new ChatRequestError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new ChatRequestError(413);
      }
      chunks.push(value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    const parsed = schema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)));
    if (!parsed.success) throw new ChatRequestError(400);
    return parsed.data;
  } catch (error) {
    throw error instanceof ChatRequestError ? error : new ChatRequestError(400);
  } finally { reader.releaseLock(); }
}
