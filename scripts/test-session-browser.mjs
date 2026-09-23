// Isolated browser acceptance: no Cloudflare account, Harness task, or LLM calls.
// Install Playwright separately, or set PLAYWRIGHT_MODULE to an existing module.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';
import { Gateway, NativeSession } from '../src/gateway.ts';
import { PREFIX } from '../src/model.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

let token = 'initial', principal = 'fixture-owner', mode = 'valid', commands = 0;
let browser, gateway, native, edge;
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const close = server => new Promise(resolve => { if (!server) return resolve(); server.closeAllConnections(); server.close(resolve); });
const bundle = await build({ entryPoints: ['src/session-recovery.ts'], bundle: true, format: 'iife', globalName: 'Recovery', platform: 'browser', write: false });
const html = `<!doctype html><meta charset="utf-8"><title>Session recovery fixture</title><textarea aria-label="Draft"></textarea><button id="command">Run fixture</button><script src="/fixture.js"></script><script>
window.connects=0;window.networkState=undefined;const listeners=new Set();let handshake;
const connection={reconnect(){window.connects++;clearTimeout(handshake);window.networkState='connecting';listeners.forEach(f=>f());handshake=setTimeout(()=>{window.networkState='connected';listeners.forEach(f=>f())},5000)},state:{getSnapshot:()=>window.networkState,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)}}};
window.recover=()=>{window.networkState='disconnected';listeners.forEach(f=>f());window.dispatchEvent(new Event('online'))};
window.reportConnection=state=>{window.networkState=state;listeners.forEach(f=>f())};
window.notices=[];new MutationObserver(()=>{const notice=document.querySelector('[role="status"]');if(notice)window.notices.push(notice.textContent)}).observe(document.body,{childList:true,subtree:true});
window.disposeRecovery=Recovery.installSessionRecovery(connection);
window.reportConnection('connecting');handshake=setTimeout(()=>window.reportConnection('connected'),Number(new URLSearchParams(location.search).get('initialDelay')||1000));
document.getElementById('command').onclick=()=>fetch('/fixture-command',{method:'POST'});
</script>`;
try {
  native = createServer((req, res) => {
    if (req.url === '/?fixture-bootstrap') { res.writeHead(303, { 'set-cookie': 'dsh-auth-fixture=private; HttpOnly', location: '/' }); res.end(); }
    else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('Native fixture'); }
  });
  const nativePort = await listen(native);
  const deployment = { hostname: 'harness.example.com', audience: 'fixture', authDomain: 'fixture.cloudflareaccess.com', emails: ['owner@example.com'], postureChecks: [], gatewayPort: 0 };
  gateway = new Gateway({ deployment, native: new NativeSession(nativePort, base => base + '/?fixture-bootstrap'), verify: async assertion => {
    if (assertion !== token) throw new Error('invalid');
    return { subject: principal, email: 'owner@example.com', expires: Date.now() + 60_000, fingerprint: token };
  } });
  await gateway.start();
  const gatewayPort = gateway.server.address().port;
  edge = createServer((req, res) => {
    if (req.url?.split('?')[0] === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
    if (req.url === '/fixture.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle.outputFiles[0].text); return; }
    if (req.url === '/fixture-command') { commands++; res.end('ok'); return; }
    if (req.url === '/fixture-login' && req.method === 'POST') { mode = 'valid'; token = 'interactive'; res.end('ok'); return; }
    const callback = req.url?.startsWith(`${PREFIX}/auth/complete`);
    if (mode === 'offline') { res.writeHead(503); res.end(); return; }
    if (mode === 'denied') { res.writeHead(403); res.end(); return; }
    if (mode === 'sso' && callback) { mode = 'valid'; token = 'sso-renewed'; }
    if (mode === 'login' && callback) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Fixture login</title><button onclick="fetch(\'/fixture-login\',{method:\'POST\'}).then(()=>location.reload())">Fixture sign in</button>'); return;
    }
    if (mode === 'sso' || mode === 'login') { res.writeHead(401); res.end(); return; }
    const upstream = request({ host: '127.0.0.1', port: gatewayPort, path: req.url, method: req.method, headers: { ...req.headers, host: deployment.hostname, origin: `https://${deployment.hostname}`, 'cf-access-jwt-assertion': token } }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  const port = await listen(edge);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
  const context = await browser.newContext();
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  for (const delay of [1000, 3000, 5000]) {
    await page.goto(`http://127.0.0.1:${port}/?initialDelay=${delay}`);
    await page.waitForFunction(() => window.networkState === 'connected');
    assert.deepEqual(await page.evaluate(() => window.notices), []);
    assert.equal(await page.evaluate(() => window.connects), 0);
  }
  console.log('PASS browser: repeated page loads with 1/3/5-second initial handshakes show no recovery warning');
  const slow = await context.newPage();
  await slow.goto(`http://127.0.0.1:${port}/?initialDelay=10000`);
  await slow.getByText('正在连接服务…', { exact: true }).waitFor();
  await slow.waitForFunction(() => window.networkState === 'connected');
  assert.equal(await slow.locator('[role="status"]').count(), 0);
  assert.equal(await slow.evaluate(() => window.connects), 0);
  await slow.close();
  console.log('PASS browser: a slow first handshake is shown accurately and clears without restarting it');
  await page.getByLabel('Draft').fill('Preserve this unsent draft');
  await page.getByRole('button', { name: 'Run fixture', exact: true }).click();
  await page.waitForFunction(() => !!window.disposeRecovery);
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const wake = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const connects = () => page.evaluate(() => window.connects);
  const assertPreserved = async () => {
    assert.equal(await page.getByLabel('Draft').inputValue(), 'Preserve this unsent draft');
    assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin); assert.equal(commands, 1);
  };
  mode = 'offline'; await wake(); await page.waitForTimeout(5500);
  await page.getByText('服务暂不可用，正在重试。', { exact: true }).waitFor();
  let before = await connects(); mode = 'valid'; await wake();
  await page.waitForFunction(n => window.connects > n, before); await assertPreserved();
  await page.waitForFunction(() => window.networkState === 'connected', undefined, { timeout: 15_000 });
  await page.waitForTimeout(7000);
  assert.equal(await connects(), before + 1);
  assert.equal(await page.getByText('正在重新连接…', { exact: true }).count(), 0);
  console.log('PASS browser: outage/recovery preserves draft and does not replay commands');
  console.log('PASS browser: slow native handshake completes without a forced-reconnect feedback loop');

  before = await connects(); mode = 'sso'; await wake();
  await page.waitForFunction(n => window.connects > n, before); await assertPreserved();
  assert.equal(await page.locator('iframe').count(), 0);
  console.log('PASS browser: expired application session silently renews via protected callback');

  before = await connects(); mode = 'login'; await wake();
  await page.getByRole('button', { name: '登录', exact: true }).waitFor({ timeout: 15_000 });
  const opened = context.waitForEvent('page'); await page.getByRole('button', { name: '登录', exact: true }).click();
  const popup = await opened; await popup.getByRole('button', { name: 'Fixture sign in' }).click();
  await page.waitForFunction(n => window.connects > n, before); await assertPreserved();
  console.log('PASS browser: interactive login returns to the original page using nonce-bound notification');

  mode = 'denied'; await wake(); await page.getByText('当前账号无访问权限。', { exact: true }).waitFor();
  assert.equal(await page.locator('iframe').count(), 0); await assertPreserved();
  console.log('PASS browser: denied access does not create an authentication redirect loop');
  mode = 'valid'; principal = 'different-fixture-owner'; await wake();
  const changed = page.getByText('登录账号已更换，请保存草稿后重新打开页面。', { exact: true });
  await changed.waitFor(); before = await connects();
  await page.evaluate(() => { window.reportConnection('connected'); window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); });
  await page.waitForTimeout(5500);
  await changed.waitFor(); assert.equal(await connects(), before); await assertPreserved();
  console.log('PASS browser: late connection/network events cannot clear the account-change guard');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close(); await close(edge); await gateway?.stop(); await close(native);
}
