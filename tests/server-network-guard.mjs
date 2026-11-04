import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../test-results/', import.meta.url));
const result = fileURLToPath(new URL('../test-results/server-network.json', import.meta.url));
mkdirSync(directory, { recursive: true });
let blockedFetchCalls = 0;
const save = () => writeFileSync(result, JSON.stringify({ blockedFetchCalls }) + '\n');
save();

// Transparent test-only egress denial, never a synthetic upstream response.
globalThis.fetch = async () => {
  blockedFetchCalls++;
  save();
  throw new Error('Outbound fetch is forbidden in offline production verification');
};
