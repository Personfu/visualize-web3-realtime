import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync, realpathSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { validateViewerUrl } from '../packages/core/src/transport';
import { managedStatePath, prepareStatePath } from '../packages/executor/src/statePath';

test('viewer credentials can reach only reviewed executor endpoints, never arbitrary or upstream destinations', () => {
  for (const url of ['ws://localhost:8765/', 'ws://127.0.0.1:8765/', 'ws://[::1]:8765/']) {
    assert.equal(validateViewerUrl(url, true), url);
  }
  assert.equal(validateViewerUrl('wss://api.speraxos.io/agents/v1/stream'), 'wss://api.speraxos.io/agents/v1/stream');
  for (const url of ['wss://outside.invalid/', 'ws://169.254.169.254/', 'wss://api.speraxos.io.outside.invalid/agents/v1/stream', 'ws://user@localhost:8765/', 'ws://localhost:8765/?apiKey=fixture', 'ws://localhost:8765/#fixture', 'ws://localhost:8765/unreviewed', 'ws://localhost:8766/']) {
    assert.throws(() => validateViewerUrl(url, true));
  }
  assert.throws(() => validateViewerUrl('wss://api.speraxos.io/agents/v1/stream', true));
});

function temporary(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'web3-state-policy-'));
  t.after(() => {
    const target = realpathSync(root);
    assert.ok(target.startsWith(realpathSync(tmpdir()) + sep) && basename(target).startsWith('web3-state-policy-') && !lstatSync(root).isSymbolicLink());
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('state paths stay in the managed folder without silently moving an external database', t => {
  const root = temporary(t);
  assert.equal(managedStatePath(':memory:', root), ':memory:');
  assert.equal(managedStatePath('./data/executor.db', root), join(realpathSync(root), 'data', 'executor.db'));
  assert.equal(managedStatePath('./data/custom.sqlite', root), join(realpathSync(root), 'data', 'custom.sqlite'));
  for (const path of ['../outside.db', 'data/../../outside.db', 'data/nested/executor.db', 'data/CON.db', 'data/NUL.sqlite', 'data/state.txt', resolve(root, '../outside.db')]) {
    assert.throws(() => prepareStatePath(path, root));
  }
  assert.deepEqual(readdirSync(root), [], 'invalid configuration must not create directories');
  assert.equal(prepareStatePath('data/executor.db', root), join(realpathSync(root), 'data', 'executor.db'));
  assert.deepEqual(readdirSync(join(root, 'data')), [], 'path preparation never opens a native SQLite database');
});

test('state directory and sidecar symlinks are refused in a disposable filesystem', t => {
  const root = temporary(t);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(root, 'data'), 'junction');
  assert.throws(() => prepareStatePath('data/executor.db', root), /unsafe/);
  unlinkSync(join(root, 'data'));
  mkdirSync(join(root, 'data'));
  symlinkSync(outside, join(root, 'data', 'executor.db-wal'), 'junction');
  assert.throws(() => prepareStatePath('data/executor.db', root), /unsafe/);
  assert.deepEqual(readdirSync(outside), []);
});
