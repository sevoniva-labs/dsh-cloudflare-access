// Isolated browser/cache acceptance; no production account or model requests.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Gateway, NativeSession } from '../src/gateway.ts';
import { MODELS_MODULE } from '../src/models-compat.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const require = createRequire(import.meta.url);
const fixturePath = '/assets/fixture-12345678.js';
const adaptedPath = `/plugins/??${MODELS_MODULE}/client.js&rev=abcdef123456`;
let adaptedSource = readFileSync(require.resolve(`${MODELS_MODULE}/client`), 'utf8');
let browser, native, edge, gateway, authorized = true;
const transfers = [];
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const close = server => new Promise(resolve => { if (!server) return resolve(); server.closeAllConnections(); server.close(resolve); });
try {
  native = createServer((req, res) => {
    if (req.url === '/?fixture-bootstrap') { res.writeHead(303, { 'set-cookie': 'dsh-auth-fixture=private; HttpOnly', location: '/' }); res.end(); }
    else if (req.url === fixturePath) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(`window.fixtureLoaded=true;/*${'fixture'.repeat(30_000)}*/`); }
    else if (req.url === adaptedPath) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(adaptedSource); }
    else if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Cache fixture</title><script>window.__ModuleLoader__={load(){}}</script><script src="${fixturePath}"></script><script src="${adaptedPath.replaceAll('&','&amp;')}"></script><p>Ready</p>`);
    } else { res.writeHead(404); res.end(); }
  });
  const nativePort = await listen(native);
  const deployment = { hostname: 'harness.example.com', audience: 'fixture', authDomain: 'fixture.cloudflareaccess.com', emails: ['owner@example.com'], postureChecks: [], gatewayPort: 0 };
  gateway = new Gateway({ deployment, native: new NativeSession(nativePort, base => base + '/?fixture-bootstrap'), verify: async token => {
    if (token !== 'valid') throw new Error('denied');
    return { subject: 'fixture', email: 'owner@example.com', expires: Date.now() + 60_000, fingerprint: token };
  } });
  await gateway.start();
  edge = createServer((req, res) => {
    const upstream = request({ host: '127.0.0.1', port: gateway.server.address().port, path: req.url, method: req.method, headers: { ...req.headers, host: deployment.hostname, origin: `https://${deployment.hostname}`, 'cf-access-jwt-assertion': authorized ? 'valid' : 'invalid' } }, response => {
      const record = { path: req.url, status: response.statusCode, bytes: 0 }; transfers.push(record);
      response.on('data', chunk => { record.bytes += chunk.length; });
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  const port = await listen(edge);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
  const context = await browser.newContext(), page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  assert.equal(await page.evaluate(() => window.fixtureLoaded), true);
  const firstBytes = transfers.reduce((n, r) => n + r.bytes, 0);
  transfers.length = 0;
  await page.reload();
  assert.equal(await page.evaluate(() => window.fixtureLoaded), true);
  assert.equal(transfers.filter(r => r.path === fixturePath).length, 0);
  assert.deepEqual(transfers.filter(r => r.path === adaptedPath), [{ path: adaptedPath, status: 304, bytes: 0 }]);
  const reloadBytes = transfers.reduce((n, r) => n + r.bytes, 0);
  assert.ok(reloadBytes < firstBytes / 10);
  console.log('PASS browser: normal reload uses immutable browser cache and authenticated 304 for adapted code', { firstBytes, reloadBytes });
  adaptedSource += '\nwindow.updatedFixture=true;'; transfers.length = 0;
  await page.reload();
  assert.equal(await page.evaluate(() => window.updatedFixture), true);
  assert.equal(transfers.find(r => r.path === adaptedPath)?.status, 200);
  console.log('PASS browser: changed compatibility bytes invalidate cached code without changing the native revision');
  authorized = false;
  const denied = await page.evaluate(async path => (await fetch(path, { cache: 'reload' })).status, fixturePath);
  assert.equal(denied, 403);
  const response = await page.reload(); assert.equal(response.status(), 403);
  console.log('PASS browser: cached code does not grant access to the application or bypass authentication');
} finally { await browser?.close(); await close(edge); await gateway?.stop(); await close(native); }
