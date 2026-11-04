import assert from 'node:assert/strict';
import { test } from 'node:test';
import evmModule from '../providers/_shared/evm-ws.ts';
import ercModule from '../providers/erc8004/erc8004-ws.ts';

// These legacy TypeScript modules use the root CommonJS package contract.
const { EvmWebSocket } = evmModule;
const { ERC8004WebSocket } = ercModule;

// Inert callback fixture. It never opens a network transport or submits an RPC.
function environment(t, failConstruction = false) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const sockets = [];
  const logs = [];
  class FixtureSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    readyState = 0;
    sent = [];
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;
    constructor() {
      if (failConstruction) throw new Error('Synthetic endpoint detail must not be logged');
      sockets.push(this);
    }
    send(message) { this.sent.push(JSON.parse(message)); }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      const late = this.onclose;
      queueMicrotask(() => late?.());
    }
    open() { this.readyState = 1; this.onopen?.(); }
    frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: FixtureSocket });
  for (const method of ['log', 'error', 'warn']) t.mock.method(console, method, (...args) => { logs.push(args); });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'WebSocket', original);
    else delete globalThis.WebSocket;
  });
  return { sockets, logs };
}

function providers() {
  const common = {
    wsUrl: 'wss://offline.invalid/', chain: 'fixture\nconfiguration', providerId: 'fixture',
    isPaused: () => false,
    onEvent: () => { throw new Error('No chain event expected from subscription fixtures'); },
  };
  return [
    new EvmWebSocket({ ...common, fallbackUrl: 'wss://offline.invalid/', nativeSymbol: 'UNIT', knownTokens: {}, swapTopics: [], transferTopic: '0xfixture', minTransferValue: 0n, maxEventsPerSecond: 1, onSwap: () => { throw new Error('No swap in offline verification'); } }),
    new ERC8004WebSocket({ ...common, onCollection: () => { throw new Error('No collection in offline verification'); } }),
  ];
}

test('RPC subscription IDs and transport exception details never enter provider logs', async t => {
  const { sockets, logs } = environment(t);
  const clients = providers();
  try {
    for (const client of clients) {
      client.connect();
      const socket = sockets.at(-1);
      socket.open();
      assert.equal(socket.sent[0].method, 'eth_subscribe');
      for (const result of ['normal-subscription', 'forged\r\nlog entry', '\u001b[2Jterminal-control']) {
        socket.frame({ jsonrpc: '2.0', id: 1, result });
      }
      assert.equal(client.isConnected(), true);
      socket.onerror?.({ message: 'private transport detail', target: { url: 'wss://offline.invalid/' } });
      client.disconnect();
    }
    await Promise.resolve();
    assert.equal(logs.some(args => args.some(value => typeof value !== 'string' || /[\r\n\u001b]/.test(value) || value.includes('private transport detail') || value.includes('normal-subscription') || value.includes('offline.invalid'))), false, 'Only fixed diagnostic categories may be logged');
    assert.equal(logs.filter(args => args[0]?.endsWith('subscription acknowledged')).length, 6);
  } finally { for (const client of clients) client.disconnect(); }
});

test('explicit disconnect and stale close callbacks cannot restart an old transport', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sockets } = environment(t);
  const clients = providers();
  try {
    for (const client of clients) {
      const initial = sockets.length;
      client.connect(); client.connect();
      assert.equal(sockets.length, initial + 1, 'Do not duplicate a connecting socket');
      const first = sockets.at(-1);
      first.open();
      const staleClose = first.onclose;
      client.disconnect();
      staleClose?.();
      await Promise.resolve();
      t.mock.timers.tick(10_000);
      assert.equal(sockets.length, initial + 1);
      assert.equal(client.isConnected(), false);
      client.connect();
      const replacement = sockets.at(-1);
      replacement.open();
      staleClose?.();
      t.mock.timers.tick(10_000);
      assert.equal(sockets.length, initial + 2);
      assert.equal(client.isConnected(), true);
      client.disconnect();
    }
  } finally { for (const client of clients) client.disconnect(); }
});

test('constructor failures use a safe category and pending retries stop on disconnect', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { logs } = environment(t, true);
  for (const client of providers()) { client.connect(); client.disconnect(); }
  t.mock.timers.tick(10_000);
  assert.equal(logs.length, 2);
  assert.equal(logs.every(args => args.length === 1 && args[0].endsWith('WebSocket creation failed')), true);
});
