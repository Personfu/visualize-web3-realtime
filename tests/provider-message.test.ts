import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePumpMessage } from '../packages/providers/src/pump-fun/message';

test('malformed remote messages cannot contaminate numeric graph state', () => {
  for (const value of [null, [], 1, { mint: {} }, { mint: 'fixture', solAmount: '5' }, { mint: 'fixture', marketCapSol: Infinity }, { mint: 'fixture', tokenAmount: -1 }, { mint: 'fixture', name: {} }, { mint: 'fixture', txType: 'unexpected' }]) {
    assert.equal(parsePumpMessage(value), null);
  }
  assert.deepEqual(parsePumpMessage({ mint: 'synthetic', txType: 'buy', solAmount: 12, unknown: 'ignored' }), { mint: 'synthetic', txType: 'buy', solAmount: 12 });
});
