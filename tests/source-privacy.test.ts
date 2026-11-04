import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('machine-specific compiler caches cannot enter the published source tree', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0');
  assert.deepEqual(files.filter(file => /(?:^|\/)(?:__pycache__|\.turbo)\/|\.(?:pyc|tsbuildinfo)$/.test(file)), []);
});

test('tracked source and documentation contain no literal credential-bearing RPC fallback', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0');
  const candidates = files.filter(file => /\.(?:[cm]?[jt]sx?|md|ya?ml|json)$/.test(file) || file === '.env.example');
  const findings = candidates.filter(file => /[?&](?:api-key|apiKey|api_key)=[A-Za-z0-9_-]{20,}/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(findings, [], 'Credential-bearing source URLs need contextual review; never print matched values');
});
