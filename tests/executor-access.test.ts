import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import WebSocket from 'ws';
import { ExecutorAccess } from '../packages/executor/src/ExecutorAccess';
import { createExecutorRestHandler, type ExecutorRestServices } from '../packages/executor/src/ExecutorRest';
import { EventBroadcaster } from '../packages/executor/src/EventBroadcaster';
import { executorProtocols } from '../packages/core/src/transport';
import { SperaxOSClient } from '../packages/executor/src/SperaxOSClient';
import { ExecutorServer } from '../packages/executor/src/ExecutorServer';
import { HealthMonitor } from '../packages/executor/src/HealthMonitor';

const fixtureToken = 'offline-fixture-'.repeat(3);
const viewerToken = 'offline-viewer-'.repeat(3);

test('health failures retain a safe category without exposing exception text', () => {
  const monitor = new HealthMonitor();
  monitor.addCheck('synthetic', () => { throw new Error('Offline exception detail must remain private'); });
  const health = monitor.getHealth();
  assert.equal(health.status, 'critical');
  assert.equal(health.checks[0].name, 'synthetic');
  assert.equal(health.checks[0].message, 'Health check failed');
});

test('the real executor rejects missing authority before opening SQLite or an upstream service', () => {
  assert.throws(() => new ExecutorServer({
    port: 0, accessToken: '', speraxosUrl: 'https://unused.invalid', speraxosApiKey: '',
    maxAgents: 1, taskPollInterval: 1000, heartbeatInterval: 1000, statePath: ':memory:',
  }), /configured executor access token/);
});

async function fixture() {
  let reads = 0;
  let writes = 0;
  let snapshots = 0;
  const access = new ExecutorAccess(fixtureToken, ['http://localhost:3100'], viewerToken);
  const services: ExecutorRestServices = {
    getStatus: () => { reads++; return { executorId: 'fixture', status: 'running', activeAgents: [], uptime: 0, totalTasksProcessed: 0, totalToolCalls: 0, lastHeartbeat: 0 }; },
    getHealth: () => ({ status: 'healthy', checks: [] }),
    getAgents: () => { reads++; return []; },
    getTasks: () => { reads++; return []; },
    enqueueTask: () => { writes++; return 'synthetic-task'; },
    spawnAgent: async () => { writes++; return { agentId: 'fixture', name: 'Synthetic', role: 'fixture', createdAt: 0 }; },
    saveAgent: () => {},
    stopAgent: async () => { writes++; },
  };
  const server = createServer(createExecutorRestHandler(access, services));
  const broadcaster = new EventBroadcaster(0, access);
  broadcaster.start(() => { snapshots++; return { agents: [], tasks: [], recentEvents: [] }; }, server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    counts: () => ({ reads, writes, snapshots }),
    close: async () => { broadcaster.stop(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

test('configuration fails closed without a bounded access token or with an untrusted browser origin', () => {
  for (const token of ['', 'undefined', 'null', 'x'.repeat(31), 'x'.repeat(257)]) {
    assert.throws(() => new ExecutorAccess(token), /configured executor/);
  }
  for (const origin of ['*', 'http://outside.invalid', 'https://example.invalid/path', 'https://user@example.invalid']) {
    assert.throws(() => new ExecutorAccess(fixtureToken, [origin]), /origin configuration/);
  }
  assert.throws(() => new ExecutorAccess(fixtureToken, [], fixtureToken), /separate bounded/);
});

test('all REST capability paths deny invalid credentials before JSON parsing or service calls', async t => {
  const f = await fixture(); t.after(f.close);
  const routes: [string, string][] = [['GET','/api/status'],['GET','/api/agents'],['GET','/api/tasks'],['GET','/api/tasks/fixture'],['POST','/api/tasks'],['POST','/api/agents/spawn'],['POST','/api/agents/fixture/stop'],['DELETE','/api/tasks/fixture']];
  for (const [method, path] of routes) {
    for (const accept of ['application/json', 'text/html']) {
      for (const authorization of [undefined, 'Bearer undefined', `Bearer ${'x'.repeat(40)}`]) {
        const response = await fetch(f.http + path, { method, body: method === 'POST' ? '{' : undefined, headers: { Accept: accept, ...(authorization ? { Authorization: authorization } : {}) } });
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.deepEqual(await response.json(), { error: 'Unauthorized' });
      }
    }
  }
  assert.deepEqual(f.counts(), { reads: 0, writes: 0, snapshots: 0 });
});

test('authorized synthetic REST works; origins, query credentials and oversized bodies do not reach services', async t => {
  const f = await fixture(); t.after(f.close);
  const headers = { Authorization: `Bearer ${fixtureToken}`, 'Content-Type': 'application/json' };
  const status = await fetch(f.http + '/api/status', { headers });
  assert.equal(status.status, 200); await status.text();
  const post = await fetch(f.http + '/api/tasks', { method: 'POST', headers, body: JSON.stringify({ description: 'offline synthetic fixture' }) });
  assert.equal(post.status, 201); await post.text();
  for (const [path, extra] of [['/api/tasks?apiKey=fixture', {}], ['/api/tasks', { Origin: 'https://outside.invalid' }]] as const) {
    const denied = await fetch(f.http + path, { headers: { ...headers, ...extra } });
    assert.equal(denied.status, 403); await denied.text();
  }
  for (const [body, expected] of [['{',400],['[]',400],['x'.repeat(1024 * 1024 + 1),413]] as const) {
    const denied = await fetch(f.http + '/api/tasks', { method: 'POST', headers, body });
    assert.equal(denied.status, expected); await denied.text();
    assert.equal(denied.headers.get('cache-control'), 'private, no-store');
  }
  assert.deepEqual(f.counts(), { reads: 1, writes: 1, snapshots: 0 });
});

test('CORS preflight is limited to the configured origin and exposes no application state', async t => {
  const f = await fixture(); t.after(f.close);
  const response = await fetch(f.http + '/api/tasks', { method: 'OPTIONS', headers: { Origin: 'http://localhost:3100' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:3100');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(f.counts(), { reads: 0, writes: 0, snapshots: 0 });
});

async function deniedSocket(url: string, protocols: string[] = [], origin?: string, authorization?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols, { ...(origin ? { origin } : {}), ...(authorization ? { headers: { Authorization: authorization } } : {}) });
    socket.on('error', () => {});
    socket.once('open', () => { socket.terminate(); reject(new Error('Unexpected accepted connection')); });
    socket.once('unexpected-response', (_, response) => { response.resume(); socket.terminate(); resolve(response.statusCode ?? 0); });
  });
}

test('WebSocket authorization precedes snapshot creation, including browser origins and credential conflicts', async t => {
  const f = await fixture(); t.after(f.close);
  for (const [url, protocols, origin] of [[f.ws, [], undefined], [f.ws, executorProtocols('x'.repeat(40)), undefined], [f.ws, executorProtocols(viewerToken), 'https://outside.invalid'], [f.ws + '?apiKey=fixture', executorProtocols(viewerToken), undefined], [f.ws, executorProtocols(fixtureToken), undefined]] as const) {
    assert.equal(await deniedSocket(url, [...protocols], origin), 401);
  }
  assert.equal(await deniedSocket(f.ws, executorProtocols(viewerToken), undefined, `Bearer ${fixtureToken}`), 401);
  assert.equal(await deniedSocket(f.ws, ['web3viz.v1', ...executorProtocols(viewerToken).slice(1), ...executorProtocols('x'.repeat(40)).slice(1)]), 401);
  assert.equal(f.counts().snapshots, 0);
  const socket = new WebSocket(f.ws, executorProtocols(viewerToken), { origin: 'http://localhost:3100' });
  const [data] = await once(socket, 'message');
  assert.equal(JSON.parse(data.toString()).type, 'snapshot');
  assert.equal(socket.protocol, 'web3viz.v1');
  assert.equal(f.counts().snapshots, 1);
  socket.terminate();
});

test('viewer authority cannot enqueue, spawn or stop; duplicate Authorization headers fail closed', async t => {
  const f = await fixture(); t.after(f.close);
  const headers = { Authorization: `Bearer ${viewerToken}` };
  const read = await fetch(f.http + '/api/status', { headers });
  assert.equal(read.status, 200); await read.text();
  for (const path of ['/api/tasks', '/api/agents/spawn', '/api/agents/fixture/stop']) {
    const denied = await fetch(f.http + path, { method: 'POST', headers, body: '{' });
    assert.equal(denied.status, 401); await denied.text();
  }
  const duplicated = await new Promise<number>((resolve, reject) => {
    const req = request(f.http + '/api/status', { headers: ['Host', new URL(f.http).host, 'Authorization', `Bearer ${fixtureToken}`, 'Authorization', `Bearer ${fixtureToken}`] }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(duplicated, 401);
  assert.deepEqual(f.counts(), { reads: 1, writes: 0, snapshots: 0 });
});

test('upstream redirects never forward a credential or request to the destination', async t => {
  let destinationRequests = 0;
  const destination = createServer((_, res) => { destinationRequests++; res.writeHead(200).end('{}'); });
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
  const upstream = createServer((_, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${(destination.address() as AddressInfo).port}/sink` }).end();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => { destination.closeAllConnections(); destination.close(); upstream.closeAllConnections(); upstream.close(); });
  const client = new SperaxOSClient(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, fixtureToken);
  assert.equal(await client.healthCheck(), false);
  await assert.rejects(client.getAgentStatus('synthetic'), TypeError);
  assert.equal(destinationRequests, 0);
});

test('the upstream SDK sends a header credential on loopback, without a credential URL or real API', async t => {
  let safeRequest = false;
  const server = createServer();
  const wss = new (await import('ws')).WebSocketServer({ server });
  wss.on('connection', (socket, request) => {
    safeRequest = request.headers.authorization === `Bearer ${fixtureToken}` && !request.url?.includes(fixtureToken) && !request.url?.includes('apiKey');
    socket.send(JSON.stringify({ eventId: 'fixture', type: 'heartbeat', agentId: 'fixture', timestamp: 1, payload: {} }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); server.close(); });
  const client = new SperaxOSClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, fixtureToken);
  let stop: () => void = () => {};
  await new Promise<void>(resolve => { stop = client.subscribeEvents('synthetic-agent', () => resolve()); });
  stop();
  assert.equal(safeRequest, true);
});
