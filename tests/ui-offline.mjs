import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { secureBrowserExecutable, assertPatchedVersion } from './security/browser-policy.mjs';

async function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    assert.equal(existsSync(join(root, file)), false, 'Use a disposable checkout without private environment files');
  }
  const address = createServer();
  address.listen(0, '127.0.0.1'); await once(address, 'listening');
  const port = address.address().port;
  await new Promise(resolve => address.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' });
  const server = spawn(process.execPath, ['--import', new URL('./server-network-guard.mjs', import.meta.url).href, fileURLToPath(import.meta.resolve('next/dist/bin/next')), 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let browser;
  const result = { browser: null, node: process.version, sandboxRequested: true, serverErrorCodes: [], compiledChatProbes: 0, blockedServerFetch: null, pages: [], externalHttp: 0, webSockets: 0, pageErrors: 0, errorCategories: [], consoleErrors: 0 };
  server.stderr.on('data', chunk => {
    for (const code of chunk.toString().match(/\bERR_[A-Z_]+\b/g) ?? []) {
      if (!result.serverErrorCodes.includes(code)) result.serverErrorCodes.push(code);
    }
  });
  mkdirSync(join(root, 'test-results'), { recursive: true });
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      assert.equal(server.exitCode, null, 'The isolated production server exited');
      try {
        const response = await fetch(origin + '/world', { redirect: 'error', signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        if (response.ok) { ready = true; break; }
      } catch { /* Wait only for our new loopback server. */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(ready, true, 'Production server must become ready');
    browser = await chromium.launch({ executablePath: secureBrowserExecutable(), chromiumSandbox: true });
    result.browser = browser.version();
    assertPatchedVersion(result.browser); // Before any page or app input.
    const valid = JSON.stringify({ messages: [{ role: 'user', content: 'Offline fixture' }], context: { stats: { totalEvents: 0, totalVolume: 0, connections: 0 }, hubCount: 0 } });
    for (const accept of ['application/json', 'text/html']) {
      for (const [body, status] of [['{', 400], ['null', 400], ['{"messages":[]}', 400], ['x'.repeat(128 * 1024 + 1), 413], [valid, 503]]) {
        const response = await fetch(origin + '/api/world-chat', { method: 'POST', body, headers: { Accept: accept, 'Content-Type': 'application/json' }, redirect: 'error' });
        assert.equal(response.status, status);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.deepEqual(await response.json(), { error: status === 503 ? 'AI service unavailable' : 'Invalid chat request' });
        result.compiledChatProbes++;
      }
    }
    for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        result.externalHttp++;
        return route.abort('blockedbyclient');
      });
      await context.routeWebSocket('**/*', socket => { result.webSockets++; socket.close({ code: 1008, reason: 'Offline verification only' }); });
      const page = await context.newPage();
      page.on('pageerror', error => {
        result.pageErrors++;
        const known = error.message.match(/Minified React error #\d+|Cannot read properties of (?:undefined|null) \(reading '[A-Za-z_$][\w$]*'\)|[A-Za-z_$][\w$]* is not defined|Error creating WebGL context|[A-Za-z_$.][\w$.]* is not a function/);
        result.errorCategories.push({ name: error.name, category: known?.[0] ?? 'unclassified browser exception' });
      });
      page.on('console', message => { if (message.type() === 'error') result.consoleErrors++; });
      page.setDefaultTimeout(15_000);
      try {
        for (const path of ['/world', '/agents']) {
          const response = await page.goto(origin + path, { waitUntil: 'networkidle' });
          assert.equal(response.status(), 200);
          if (path === '/agents') {
            await page.getByRole('button', { name: 'Run Demo', exact: true }).click();
            await page.getByText('CodeReviewer', { exact: true }).first().waitFor({ state: 'visible' });
            assert.equal(await page.getByRole('button', { name: 'Run Demo', exact: true }).count(), 0);
          }
          // Agents also has a 2D timeline canvas. Require Three's actual renderer.
          const canvas = page.locator('canvas[data-engine^="three.js"]').first();
          await canvas.waitFor({ state: 'visible' });
          const webgl = await canvas.evaluate(element => {
            const gl = element.getContext('webgl2') || element.getContext('webgl');
            return !!gl && !gl.isContextLost() && element.width > 0 && element.height > 0;
          });
          assert.equal(webgl, true, 'A real, live WebGL renderer is required');
          assert.equal(await page.evaluate(() => document.fonts.check('400 12px "IBM Plex Mono"')), true);
          await page.screenshot({ path: join(root, 'test-results', `${path.slice(1)}-${viewport.width}.png`), fullPage: true });
          result.pages.push({ path, viewport: viewport.width, status: response.status(), webgl, demo: path === '/agents' });
        }
      } catch (error) {
        await page.screenshot({ path: join(root, 'test-results', `failure-${viewport.width}.png`), fullPage: true });
        throw error;
      } finally { await context.close(); }
    }
    assert.equal(result.externalHttp, 0, 'The idle/demo viewer must not request external assets or services');
    assert.equal(result.webSockets, 0, 'Offline demo must not open a live WebSocket');
    assert.equal(result.pageErrors, 0, 'No hydration, hook-order or rendering exceptions');
    assert.equal(result.consoleErrors, 0, 'No browser console errors');
    result.blockedServerFetch = JSON.parse(readFileSync(join(root, 'test-results/server-network.json'), 'utf8')).blockedFetchCalls;
    assert.equal(result.blockedServerFetch, 0, 'No hidden server-side provider fetch');
    console.log(`Offline production UI: ${result.pages.length} pages passed; Chrome ${result.browser}; no external HTTP/WS or browser errors.`);
  } finally {
    writeFileSync(join(root, 'test-results/ui-result.json'), JSON.stringify(result, null, 2) + '\n');
    await browser?.close();
    const stopped = once(server, 'exit');
    server.kill();
    if (server.exitCode === null) await stopped;
  }
}

main().catch(error => {
  console.error('Offline production UI failed:', error.name, error.message);
  process.exitCode = 1;
});
