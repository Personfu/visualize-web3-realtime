import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockProvider } from '../packages/providers/src/mock/MockProvider';

test('the offline starter graph supplies the identifiers and volume consumed by the renderer', () => {
  const provider = new MockProvider();
  const stats = provider.getStats();
  assert.equal(stats.topTokens.length, 1);
  const token = stats.topTokens[0];
  assert.equal(token.mint, token.tokenAddress);
  assert.equal(token.volumeSol, token.volume);
  assert.equal(token.volumeSol, 0);
  assert.equal(stats.totalTransactions, 0);
  assert.deepEqual(stats.traderEdges, []);
  assert.equal(provider.getConnections()[0].connected, false);
});
