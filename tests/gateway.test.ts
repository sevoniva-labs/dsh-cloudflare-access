import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { Gateway, NativeSession, localAdmin } from '../src/gateway.ts';
import { PREFIX } from '../src/model.ts';
import { deployment, nativeHarness } from './fixtures.ts';
import { MODELS_MODULE } from '../src/models-compat.ts';
let native: Awaited<ReturnType<typeof nativeHarness>>, gateway: Gateway, port: number;
const controlPaths = [
  `${PREFIX}/status`, `${PREFIX}/provision`, '/%5f%5fdsh_cloudflare_access/status', '/something/../__dsh_cloudflare_access/status',
  ...['%3f', '%3F', '%23'].flatMap(segment => [
    `/${segment}/..${PREFIX}/status`, `/${segment}/%2e%2e${PREFIX}/status?check=1`, `/${segment}/a/../..${PREFIX}/provision`,
  ]),
  `/%2f..${PREFIX}/status`, `/x%2f..${PREFIX}/status`,
];
function http(path = '/', options: { method?: string; headers?: Record<string, string | undefined>; data?: unknown } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const headers: Record<string, string | undefined> = { host: deployment.hostname, 'cf-access-jwt-assertion': 'valid', ...options.headers };
    for (const key in headers) if (headers[key] === undefined) delete headers[key];
    const req = request({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers }, res => { let text = ''; res.on('data', d => { text += d; }); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text })); });
    req.on('error', reject); req.end(options.data === undefined ? undefined : JSON.stringify(options.data));
  });
}
beforeEach(async () => {
  native = await nativeHarness();
  gateway = new Gateway({ deployment, native: new NativeSession(native.port, base => native.connection.authenticatedUrl(base)), leaseMs: 1100, verify: async token => { if (token !== 'valid') throw new Error('invalid'); return { subject: 'user', email: 'owner@example.com', expires: Date.now() + 60_000, fingerprint: token }; } });
  await gateway.start(); port = (gateway.server.address() as AddressInfo).port;
});
afterEach(async () => { await gateway?.stop(); await native?.close(); });
describe('real official connection + protected loopback gateway', () => {
  test('browser-only static caching never caches pages, API, streams or authentication failures', async () => {
    const remove = native.ctx.get('webServer')!.register({ kind: 'prefix', path: '/assets', handler: (req, res) => {
      res.writeHead(200, { 'content-type': req.url!.includes('html') ? 'text/html' : 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' }); res.end('fixture');
    } });
    try {
      const path = '/assets/index-12345678.js';
      const r = await http(path);
      expect(r.headers['cache-control']).toBe('private, max-age=31536000, immutable');
      expect(r.headers['cdn-cache-control']).toBe('no-store'); expect(r.headers['cloudflare-cdn-cache-control']).toBe('no-store');
      expect((await http(path, { headers: { 'cf-access-jwt-assertion': 'bad' } })).status).toBe(403);
      for (const other of ['/', '/assets/dynamic.js', '/assets/html-12345678.js', '/assets/index-12345678.js?dynamic=1']) expect((await http(other)).headers['cache-control']).toBe('no-store');
      expect((await http('/api/echo', { method: 'POST', headers: { origin: `https://${deployment.hostname}` }, data: {} })).headers['cache-control']).toBe('no-store');
    } finally { remove(); }
  });
  test('adapted bundles revalidate by final bytes, return 304 only after authentication, and invalidate on changes', async () => {
    let source = readFileSync(createRequire(import.meta.url).resolve(`${MODELS_MODULE}/client`), 'utf8');
    const path = `/plugins/??${MODELS_MODULE}/client.js&rev=abcdef123456`;
    const remove = native.ctx.get('webServer')!.register({ kind: 'prefix', path: '/plugins', handler: (req, res) => {
      expect(req.headers['if-none-match']).toBeUndefined();
      res.writeHead(200, { 'content-type': 'text/javascript', etag: 'native-unchanged' }); res.end(source);
    } });
    try {
      const first = await http(path), etag = String(first.headers.etag);
      expect(first.status).toBe(200); expect(first.headers['cache-control']).toBe('private, no-cache');
      expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
      const second = await http(path, { headers: { 'if-none-match': etag } });
      expect(second.status).toBe(304); expect(second.text).toBe(''); expect(second.headers.etag).toBe(etag);
      expect((await http(path, { headers: { 'if-none-match': etag, 'cf-access-jwt-assertion': 'bad' } })).status).toBe(403);
      source += '\n// changed compatibility input';
      const changed = await http(path, { headers: { 'if-none-match': etag } });
      expect(changed.status).toBe(200); expect(changed.headers.etag).not.toBe(etag);
    } finally { remove(); }
  });
  test('lease returns opaque rotation metadata without bearer or identity claims', async () => {
    const call = () => http(`${PREFIX}/lease`, { method: 'POST', headers: { origin: `https://${deployment.hostname}` } });
    const a = await call(), b = await call();
    expect(a.status).toBe(200); const value = JSON.parse(a.text);
    expect(value).toMatchObject({ ok: true, leaseMs: 1100 });
    expect(value.sessionId).toMatch(/^[a-f0-9]{64}$/); expect(value.principal).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(b.text).sessionId).toBe(value.sessionId);
    expect(a.text).not.toContain('owner@example.com'); expect(a.text).not.toContain('valid');
    expect((await http(`${PREFIX}/lease`, { method: 'POST' })).status).toBe(403);
  });
  test('auth callback stays protected, constrains framing and rejects script/redirect injection', async () => {
    const path = `${PREFIX}/auth/complete?state=01234567-89ab-cdef-0123-456789abcdef`;
    const denied = await http(path, { headers: { 'cf-access-jwt-assertion': 'bad' } });
    expect(denied.status).toBe(403);
    const r = await http(path); expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(r.headers['content-security-policy']).toContain("script-src 'nonce-");
    expect(r.headers['x-frame-options']).toBe('SAMEORIGIN'); expect(r.headers['cache-control']).toBe('no-store');
    expect(r.text).toContain('parent.postMessage(message,location.origin)');
    expect(r.text).not.toContain('owner@example.com'); expect(r.headers.location).toBeUndefined();
    expect((await http(`${PREFIX}/auth/complete?state=${encodeURIComponent('</script>')}`)).status).toBe(400);
    expect((await http(`${PREFIX}/auth/complete?state=https://evil.example`)).status).toBe(400);
  });
  test('expired auth is distinguishable from denied auth and unavailable verification', async () => {
    const original = (gateway as unknown as { verify: unknown }).verify;
    for (const [error, status, code] of [
      [Object.assign(new Error(), { code: 'ERR_JWT_EXPIRED' }), 401, 'AUTH_REQUIRED'],
      [Object.assign(new Error(), { code: 'ERR_JWKS_TIMEOUT' }), 503, 'AUTH_UNAVAILABLE'],
      [new Error('invalid'), 403, 'ACCESS_DENIED'],
    ] as const) {
      (gateway as unknown as { verify: unknown }).verify = async () => { throw error; };
      const r = await http(`${PREFIX}/lease`, { method: 'POST', headers: { origin: `https://${deployment.hostname}` } });
      expect(r.status).toBe(status); expect(JSON.parse(r.text).code).toBe(code);
    }
    (gateway as unknown as { verify: unknown }).verify = original;
  });
  test('serves the native model editor with a scoped mirror only after Access authentication', async () => {
    const source = readFileSync(createRequire(import.meta.url).resolve(`${MODELS_MODULE}/client`), 'utf8');
    const path = `/plugins/??${MODELS_MODULE}/client.js&rev=test`;
    let requests = 0;
    const dispose = native.ctx.get('webServer')!.register({ kind: 'prefix', path: '/plugins', handler: (req, res) => {
      requests++;
      expect(req.headers['accept-encoding']).toBe('identity');
      expect(req.headers['if-none-match']).toBeUndefined();
      res.writeHead(200, { 'content-type': 'application/javascript', 'content-length': Buffer.byteLength(source), etag: 'original' });
      res.end(source);
    } });
    try {
      const denied = await http(path, { headers: { 'cf-access-jwt-assertion': 'bad' } });
      expect(denied.status).toBe(403); expect(requests).toBe(0);
      const response = await http(path, { headers: { 'accept-encoding': 'gzip', 'if-none-match': 'original' } });
      expect(response.status).toBe(200); expect(response.headers.etag).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).not.toContain('new ModelsSettingsStore(ctx, schema, ctx.settingsScope.describe())');
      expect(response.text).toContain('ctx.settingsScope.bind(');
      expect(() => new Script(response.text)).not.toThrow();
      expect(requests).toBe(1);
    } finally { dispose(); }
  });
  test('bootstraps native auth without leaking token or native cookie; survives refresh', async () => {
    for (let i = 0; i < 3; i++) { const r = await http(); expect(r.status).toBe(200); expect(r.headers['set-cookie']).toBeUndefined(); expect(r.headers.location).toBeUndefined(); expect(r.text).toContain('Native Harness'); }
  });
  test.each([
    ['no JWT', { 'cf-access-jwt-assertion': undefined }], ['forged JWT', { 'cf-access-jwt-assertion': 'bad' }], ['host mismatch', { host: 'evil.example' }], ['origin mismatch', { origin: 'https://evil.example' }],
  ])('rejects %s', async (_label, headers) => { expect((await http('/api/llm/listProviders', { headers })).status).toBe(403); });
  test('lists providers through official /api RPC, no public trustedHosts patch', async () => {
    const r = await http('/api/llm/listProviders', { method: 'POST', headers: { origin: `https://${deployment.hostname}`, 'content-type': 'application/json' }, data: { type: 'client-request', rpcId: 'test-1', method: 'llm/listProviders', payload: {} } });
    expect(r.status).toBe(200); expect(r.text).toContain('fixture-provider');
  });
  test('expired browser navigation offers explicit login recovery without redirect loops', async () => {
    const r = await http('/', { headers: { 'cf-access-jwt-assertion': 'bad', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
    expect(r.status).toBe(403); expect(r.headers.location).toBeUndefined();
    expect(r.headers['content-type']).toContain('text/html'); expect(r.text).toContain('/cdn-cgi/access/logout');
    expect(r.text).toContain('请重新登录'); expect(r.text).not.toContain('http-equiv="refresh"');
    const rpc = await http('/api/llm/listProviders', { method: 'POST', headers: { 'cf-access-jwt-assertion': 'bad', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } });
    expect(rpc.status).toBe(403); expect(rpc.headers['content-type']).toContain('application/json');
  });
  test('preserves POST payload, rewrites authority, strips CF secrets', async () => {
    const r = await http('/api/echo', { method: 'POST', headers: { origin: `https://${deployment.hostname}`, 'content-type': 'application/json' }, data: { message: 'hello' } });
    expect(r.status).toBe(200); expect(JSON.parse(r.text)).toMatchObject({ body: { message: 'hello' }, cookie: true, cf: null, origin: `http://127.0.0.1:${native.port}` });
  });
  test('rejects mutation without same-origin', async () => { expect((await http('/api/echo', { method: 'POST', data: {} })).status).toBe(403); });
  test.each(controlPaths)('does not expose local control path %s', async path => {
    expect((await http(path)).status).toBe(403);
    expect((await http(path, { method: 'POST', headers: { origin: `https://${deployment.hostname}` }, data: {} })).status).toBe(403);
  });
  test('preserves encoded filenames and combo queries; stamps upstream requests after header cleanup', async () => {
    const remove = native.ctx.get('webServer')!.register({ kind: 'prefix', path: '/files', handler(req, res) {
      res.end(JSON.stringify({ path: req.url, marker: req.headers['x-dsh-cloudflare-proxy'], local: localAdmin(req, native.port, !native.connection.requestRejection(req)) }));
    } });
    try {
      for (const path of ['/files/a%23b', '/files/a%3fb', '/files/%E4%B8%AD.txt', '/files/??a.js,b.js&rev=123']) {
        const response = await http(path, { headers: { 'x-dsh-cloudflare-proxy': 'spoofed', connection: 'x-dsh-cloudflare-proxy' } });
        expect(response.status).toBe(200);
        expect(JSON.parse(response.text)).toEqual({ path, marker: '1', local: false });
      }
    } finally { remove(); }
    expect((await http('/bad%ZZ')).status).toBe(400);
    expect((await http('/bad%5cpath')).status).toBe(400);
  });
  test('raw WebSocket targets cannot reach control routes or pass bootstrap tokens', async () => {
    let hits = 0;
    const remove = native.ctx.get('webServer')!.registerUpgrade({ path: PREFIX, handler(_req, socket) { hits++; socket.destroy(); } });
    try {
      for (const path of [...controlPaths, '/ws?token=private', '/bad%ZZ']) {
        const response = await http(path, { headers: { origin: `https://${deployment.hostname}`, connection: 'Upgrade', upgrade: 'websocket' } });
        expect(response.status).toBe(path.startsWith('/ws?') || path === '/bad%ZZ' ? 400 : 403);
      }
      expect(hits).toBe(0);
    } finally { remove(); }
  });
  test('does not pass launch query token to native server', async () => { expect((await http('/?token=anything')).status).toBe(400); });
  test('identity endpoint and local logout revoke the bearer session', async () => {
    expect(JSON.parse((await http(`${PREFIX}/session`)).text)).toMatchObject({ remote: true, email: 'owner@example.com' });
    expect((await http(`${PREFIX}/logout`, { method: 'POST', headers: { origin: `https://${deployment.hostname}` } })).status).toBe(200);
    expect((await http()).status).toBe(403);
  });
  test('proxies authenticated native WebSocket and closes it when browser lease stops', async () => {
    const wss = new WebSocketServer({ noServer: true });
    const remove = native.ctx.get('webServer')!.registerUpgrade({ path: '/ws', handler(req, socket, head) { if (native.connection.requestRejection(req)) { socket.destroy(); return; } wss.handleUpgrade(req, socket, head, ws => { ws.on('message', d => ws.send(d)); }); } });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { host: deployment.hostname, origin: `https://${deployment.hostname}`, 'cf-access-jwt-assertion': 'valid' } });
    await once(ws, 'open'); const message = once(ws, 'message'); ws.send('native-ws-ok'); expect(String((await message)[0])).toBe('native-ws-ok');
    await once(ws, 'close');
    await expect.poll(() => gateway.diagnostics().webSockets).toMatchObject({ opened: 1, closed: 1, active: 0, lastClose: { reason: 'lease-expired' } });
    remove(); wss.close();
  });
  test('WS rejects unauthenticated or cross-origin upgrade', async () => {
    for (const headers of [{ host: deployment.hostname }, { host: deployment.hostname, origin: 'https://evil.example', 'cf-access-jwt-assertion': 'valid' }]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
      const status = await new Promise<number>(resolve => { ws.on('error', () => {}); ws.on('unexpected-response', (_r, response) => { resolve(response.statusCode!); response.resume(); ws.terminate(); }); });
      expect(status).toBe(403);
    }
  });
});
test('local administration requires loopback Host, cookie and write Origin; refuses proxy headers', () => {
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3333', origin: 'http://127.0.0.1:3333' } };
  expect(localAdmin(req as never, 3333, true)).toBe(true);
  expect(localAdmin(req as never, 3333, false)).toBe(false);
  for (const header of [{ origin: 'https://evil.test' }, { 'cf-access-jwt-assertion': 'valid' }, { 'x-forwarded-for': '127.0.0.1' }, { 'x-dsh-cloudflare-proxy': '1' }, { 'x-dsh-cloudflare-proxy': '' }, { host: 'evil.test' }]) expect(localAdmin({ ...req, headers: { ...req.headers, ...header } } as never, 3333, true)).toBe(false);
});
