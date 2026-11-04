import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ESLint } from 'eslint';

test('real lint covers application, tests, executor source/output and tooling while excluding only downloaded browser artifacts', async () => {
  const eslint = new ESLint();
  for (const path of ['app/agents/page.tsx', 'app/api/world-chat/route.ts', 'hooks/useAgentEvents.ts', 'packages/executor/src/StateStore.ts', 'packages/executor/dist/StateStore.js', 'tests/source-privacy.test.ts', 'tests/ui-offline.mjs', 'eslint.config.mjs']) {
    assert.equal(await eslint.isPathIgnored(path), false, `Source must remain linted: ${path}`);
  }
  assert.equal(await eslint.isPathIgnored('.cache/security-chrome/157.0.8103.38/linux-x64/chrome-linux64/resources/inspector_overlay/main.js'), true);
});
