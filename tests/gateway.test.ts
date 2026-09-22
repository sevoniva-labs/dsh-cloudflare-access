import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { Gateway, NativeSession, localAdmin } from '../src/gateway.ts';
import { PREFIX } from '../src/model.ts';
import { deployment, nativeHarness } from './fixtures.ts';
let native: Awaited<ReturnType<typeof nativeHarness>>, gateway: Gateway, port: number;
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
  test.each([`${PREFIX}/status`, `${PREFIX}/provision`, '/%5f%5fdsh_cloudflare_access/status', '/something/../__dsh_cloudflare_access/status'])('does not expose local control path %s', async path => { expect((await http(path)).status).toBe(403); });
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
    await once(ws, 'close'); remove(); wss.close();
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
  for (const header of [{ origin: 'https://evil.test' }, { 'cf-access-jwt-assertion': 'valid' }, { 'x-forwarded-for': '127.0.0.1' }, { host: 'evil.test' }]) expect(localAdmin({ ...req, headers: { ...req.headers, ...header } } as never, 3333, true)).toBe(false);
});
