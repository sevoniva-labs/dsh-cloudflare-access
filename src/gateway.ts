import { createServer, request, type IncomingMessage, type ServerResponse, type IncomingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';
import { PREFIX, authDomain, fail, type Deployment } from './model.ts';
import { adaptModelsBundle, modelsBundleRequest } from './models-compat.ts';
import { adaptSettingsBundle, matchesEtag, settingsBundleRequest, versionedAsset } from './web-assets.ts';

export interface Identity { email: string; subject: string; expires: number; fingerprint: string }
export type Verifier = (token: string) => Promise<Identity>;
export function accessVerifier(d: Deployment, fetcher: typeof fetch = fetch, maxTokenAgeSeconds = 7200): Verifier {
  const issuer = `https://${authDomain(d.authDomain)}`;
  if (!d.audience) fail('AUDIENCE', 'Access audience 缺失。');
  const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000, [customFetch]: async (...args) => {
    try { return await fetcher(...args); } catch { throw new AuthUnavailable(); }
  } });
  return async token => {
    const { payload } = await jwtVerify(token, keys, { issuer, audience: d.audience, algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'email', 'iat'], maxTokenAge: maxTokenAgeSeconds });
    if (payload.type !== 'app' || typeof payload.email !== 'string' || !d.emails.includes(payload.email.toLowerCase()) || !payload.sub || !payload.exp) throw new Error('identity');
    return { email: payload.email.toLowerCase(), subject: payload.sub, expires: Math.min(payload.exp, payload.iat! + maxTokenAgeSeconds) * 1000, fingerprint: createHash('sha256').update(token).digest('hex') };
  };
}
class AuthUnavailable extends Error {}
class AuthExpired extends Error {}

function authenticationFailure(error: unknown): { status: number; code: string; error: string } {
  const code = (error as { code?: string })?.code;
  if (error instanceof AuthUnavailable || code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JWKS_INVALID' || code === 'ERR_JOSE_GENERIC') return { status: 503, code: 'AUTH_UNAVAILABLE', error: '认证服务暂不可用，请稍后重试。' };
  if (error instanceof AuthExpired || code === 'ERR_JWT_EXPIRED') return { status: 401, code: 'AUTH_REQUIRED', error: '登录已过期，请重新登录。' };
  return { status: 403, code: 'ACCESS_DENIED', error: '当前请求未通过访问验证。' };
}

/** This page is protected by the same Access policy and origin JWT checks. */
function authenticationComplete(req: IncomingMessage, res: ServerResponse): void {
  const state = new URL(req.url!, 'http://local.invalid').searchParams.get('state');
  if (!state || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) { json(res, 400, { code: 'INVALID_STATE', error: '登录请求无效，请从原页面重试。' }); return; }
  const nonce = randomBytes(18).toString('base64');
  const message = JSON.stringify({ type: 'dsh-cloudflare-access:authenticated', state });
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`,
  });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录完成</title><p>登录完成，可以关闭此窗口返回 Harness。</p><script nonce="${nonce}">const message=${message};if(parent!==window){parent.postMessage(message,location.origin)}else{if(typeof BroadcastChannel!=="undefined"){const channel=new BroadcastChannel(message.type);channel.postMessage(message);setTimeout(()=>channel.close(),100)}setTimeout(()=>window.close(),300)}</script></html>`);
}
export function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}
export function loopback(address: string | undefined): boolean { return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'; }
const proxyMarker = 'x-dsh-cloudflare-proxy';
export function localAdmin(req: IncomingMessage, port: number, authenticated: boolean): boolean {
  if (!loopback(req.socket.remoteAddress) || !authenticated) return false;
  if (Object.keys(req.headers).some(x => x.startsWith('cf-') || x.startsWith('x-forwarded-') || x === 'forwarded' || x === proxyMarker)) return false;
  const host = req.headers.host;
  if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host ?? '')) return false;
  return req.method === 'GET' ? (!req.headers.origin || req.headers.origin === `http://${host}`) : req.headers.origin === `http://${host}`;
}

/** Keeps native DSH browser credentials on the server, obtained through its public API. */
export class NativeSession {
  private cookie?: string;
  private pending?: Promise<string>;
  constructor(readonly port: number, private readonly authenticatedUrl: (base: string) => string) {}
  reset(): void { this.cookie = undefined; }
  async get(): Promise<string> {
    if (this.cookie) return this.cookie;
    if (this.pending) return this.pending;
    this.pending = new Promise<string>((resolve, reject) => {
      const target = new URL(this.authenticatedUrl(`http://127.0.0.1:${this.port}`));
      if (target.origin !== `http://127.0.0.1:${this.port}`) { reject(new Error('bootstrap origin')); return; }
      const r = request(target, { method: 'GET' }, res => {
        res.resume();
        const cookies = res.headers['set-cookie']?.filter(x => x.startsWith('dsh-auth-'));
        if (res.statusCode !== 303 || cookies?.length !== 1) { reject(new Error('native bootstrap')); return; }
        this.cookie = cookies[0]!.split(';')[0]!;
        resolve(this.cookie);
      });
      r.setTimeout(5000, () => r.destroy(new Error('bootstrap timeout')));
      r.on('error', () => reject(new Error('native bootstrap'))); r.end();
    });
    try { return await this.pending; } finally { this.pending = undefined; }
  }
}

const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function clean(headers: IncomingHttpHeaders, websocket = false): IncomingHttpHeaders {
  const nominated = String(headers.connection ?? '').split(',').map(x => x.trim().toLowerCase());
  const result: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (hop.has(key) || nominated.includes(key) || key === 'cookie' || key === 'authorization' || key === 'set-cookie' || key === 'forwarded' || key === proxyMarker || key.startsWith('cf-') || key.startsWith('x-forwarded-')) continue;
    result[key] = value;
  }
  if (websocket) { result.connection = 'Upgrade'; result.upgrade = 'websocket'; }
  return result;
}
export interface GatewayOptions { deployment: Deployment; native: NativeSession; verify?: Verifier; leaseMs?: number; maxTokenAgeSeconds?: number }
/** Loopback-only origin: ALL HTTP and WS traffic is independently authenticated. */
export class Gateway {
  readonly server = createServer();
  private readonly verify: Verifier;
  private readonly sockets = new Set<Socket>();
  private readonly active = new Map<Duplex, { identity: Identity; since: number }>();
  private readonly leases = new Map<string, number>();
  private readonly revoked = new Map<string, number>();
  private readonly leaseSecret = randomBytes(32);
  private timer?: NodeJS.Timeout;
  private webSockets = { active: 0, opened: 0, closed: 0, lastClose: undefined as { durationMs: number; reason: string } | undefined };
  diagnostics() { return { webSockets: { ...this.webSockets, lastClose: this.webSockets.lastClose && { ...this.webSockets.lastClose } } }; }
  constructor(private readonly options: GatewayOptions) {
    this.verify = options.verify ?? accessVerifier(options.deployment, fetch, options.maxTokenAgeSeconds);
    this.server.on('request', (req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) json(res, 502, { error: '远程入口暂不可用，请检查本机 Harness。' }); else res.destroy(); }); });
    this.server.on('upgrade', (req, socket, head) => { void this.upgrade(req, socket, head).catch(() => socket.destroy()); });
    this.server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
    this.server.on('clientError', (_e, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
    this.server.requestTimeout = 300_000;
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.deployment.gatewayPort, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    this.timer = setInterval(() => this.sweep(), 1000); this.timer.unref();
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    for (const socket of this.active.keys()) socket.destroy();
    for (const socket of this.sockets) socket.destroy();
    this.active.clear(); this.leases.clear(); this.revoked.clear();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
  private sweep(): void {
    const now = Date.now(), lease = this.options.leaseMs ?? 90_000;
    for (const [socket, { identity, since }] of this.active) {
      if (identity.expires <= now || this.revoked.has(identity.fingerprint) || now - (this.leases.get(identity.fingerprint) ?? since) > lease) socket.destroy();
    }
    for (const [fp, exp] of this.revoked) if (exp <= now) this.revoked.delete(fp);
    for (const [fp, time] of this.leases) if (time + lease < now) this.leases.delete(fp);
  }
  private track(socket: Duplex, identity: Identity): void {
    this.active.set(socket, { identity, since: Date.now() });
    socket.once('close', () => this.active.delete(socket));
  }
  private async identity(req: IncomingMessage, websocket = false): Promise<Identity> {
    const host = this.options.deployment.hostname, origin = `https://${host}`;
    if (!loopback(req.socket.remoteAddress) || req.headers.host !== host) throw new Error('host');
    if ((websocket || !['GET', 'HEAD'].includes(req.method ?? '')) ? req.headers.origin !== origin : req.headers.origin && req.headers.origin !== origin) throw new Error('origin');
    if (!['GET', 'HEAD'].includes(req.method ?? '') && req.headers['sec-fetch-site'] === 'cross-site') throw new Error('cross-site');
    const assertion = req.headers['cf-access-jwt-assertion'];
    if (typeof assertion !== 'string' || assertion.length > 16384) throw new Error('assertion');
    const id = await this.verify(assertion);
    if (id.expires <= Date.now()) throw new AuthExpired();
    if (this.revoked.has(id.fingerprint)) throw new Error('revoked');
    return id;
  }
  private path(req: IncomingMessage): string {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Error('path');
    // Match the native router's parsing order before checking decoded aliases.
    const target = new URL(req.url, 'http://local.invalid');
    if (target.origin !== 'http://local.invalid') throw new Error('path');
    const decoded = decodeURIComponent(target.pathname);
    if (decoded.includes('\\')) throw new Error('path');
    // The pathname setter preserves encoded ?/# as path data, not delimiters.
    target.pathname = decoded;
    return target.pathname;
  }
  private upstreamHeaders(req: IncomingMessage, cookie: string, ws = false): IncomingHttpHeaders {
    const headers = clean(req.headers, ws), host = `127.0.0.1:${this.options.native.port}`;
    headers.host = host; headers.origin = `http://${host}`; headers.cookie = cookie;
    headers[proxyMarker] = '1';
    return headers;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let id: Identity;
    try { id = await this.identity(req); } catch (error) {
      const failure = authenticationFailure(error);
      if (req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document') {
        // A stale Access cookie must not trap the browser on an unexplained JSON error.
        // Keep 403 and require an explicit login action; never auto-redirect in a loop.
        res.writeHead(failure.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
        res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>请重新登录</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:440px;margin:15vh auto;padding:24px;color:#27272a}h1{font-size:24px}a{display:inline-block;color:#fff;background:#27272a;border-radius:6px;padding:8px 18px;text-decoration:none}</style><h1>请重新登录</h1><p>当前认证无效或已过期。退出后，重新打开此地址登录。</p><a href="/cdn-cgi/access/logout">退出当前登录</a></html>');
      } else json(res, failure.status, { code: failure.code, error: failure.error });
      return;
    }
    let path: string;
    try { path = this.path(req); } catch { json(res, 400, { error: '请求路径无效。' }); return; }
    if (path === `${PREFIX}/auth/complete` && req.method === 'GET') { authenticationComplete(req, res); return; }
    if (path === `${PREFIX}/session` && req.method === 'GET') { json(res, 200, { remote: true, email: id.email, expires: id.expires, deviceChecks: this.options.deployment.postureChecks.length }); return; }
    if (path === `${PREFIX}/lease` && req.method === 'POST') {
      this.leases.set(id.fingerprint, Date.now());
      json(res, 200, {
        ok: true, sessionId: createHmac('sha256', this.leaseSecret).update(id.fingerprint).digest('hex'),
        principal: createHash('sha256').update(`${this.options.deployment.audience}:${id.subject}`).digest('hex'),
        expires: id.expires, leaseMs: this.options.leaseMs ?? 90_000,
      }); return;
    }
    if (path === `${PREFIX}/logout` && req.method === 'POST') {
      this.revoked.set(id.fingerprint, id.expires);
      for (const [socket, entry] of this.active) if (entry.identity.fingerprint === id.fingerprint) socket.destroy();
      json(res, 200, { ok: true }); return;
    }
    if (path === PREFIX || path.startsWith(`${PREFIX}/`)) { json(res, 403, { error: '仅允许在本机配置 Cloudflare。' }); return; }
    // Never forward bootstrap query parameters to the native runtime.
    if (new URL(req.url!, 'http://local.invalid').searchParams.has('token')) { json(res, 400, { error: '不接受本机启动凭据。' }); return; }
    const cookie = await this.options.native.get();
    const adaptModels = req.method === 'GET' && modelsBundleRequest(req.url!);
    const adaptSettings = req.method === 'GET' && settingsBundleRequest(req.url!);
    const adaptScript = adaptModels || adaptSettings;
    const upstreamHeaders = this.upstreamHeaders(req, cookie);
    if (adaptScript) {
      upstreamHeaders['accept-encoding'] = 'identity';
      delete upstreamHeaders['if-none-match']; delete upstreamHeaders['if-modified-since']; delete upstreamHeaders.range;
    }
    const upstream = request({ agent: false, hostname: '127.0.0.1', port: this.options.native.port, path: req.url, method: req.method, headers: upstreamHeaders }, response => {
      if (response.statusCode === 401) { this.options.native.reset(); response.resume(); json(res, 503, { error: '本机会话已更新，本次请求未重试。请确认操作结果后再试。' }); return; }
      const headers = clean(response.headers);
      const cacheable = ['GET', 'HEAD'].includes(req.method ?? '') && response.statusCode === 200 && versionedAsset(req.url!, String(headers['content-type'] ?? ''));
      headers['cache-control'] = cacheable ? (modelsBundleRequest(req.url!) || settingsBundleRequest(req.url!) ? 'private, no-cache' : 'private, max-age=31536000, immutable') : 'no-store';
      // Browser-local code caching must never turn authenticated resources into
      // shared CDN responses. HTML, credentials, RPCs and streams stay no-store.
      headers['cdn-cache-control'] = 'no-store'; headers['cloudflare-cdn-cache-control'] = 'no-store';
      headers['referrer-policy'] = 'no-referrer';
      if (headers.location && (!headers.location.startsWith('/') || headers.location.startsWith('//') || headers.location.includes('token='))) { response.destroy(); json(res, 502, { error: '拒绝了非预期的上游重定向。' }); return; }
      if (adaptScript && response.statusCode === 200 && !headers['content-encoding'] && String(headers['content-type']).includes('javascript')) {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) { response.destroy(); if (!res.headersSent) json(res, 502, { error: '模型设置资源过大。' }); return; }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (res.writableEnded) return;
          let output = Buffer.concat(chunks).toString('utf8');
          if (adaptModels) output = adaptModelsBundle(output);
          if (adaptSettings) output = adaptSettingsBundle(output);
          delete headers.etag; delete headers['last-modified']; delete headers['content-length'];
          // These bytes also depend on this plugin's compatibility layer, not
          // only the official bundle revision. Revalidate after every reload.
          if (cacheable) {
            const etag = `"${createHash('sha256').update(output).digest('hex')}"`;
            headers.etag = etag; headers['cache-control'] = 'private, no-cache';
            if (matchesEtag(req.headers['if-none-match'], etag)) { res.writeHead(304, headers); res.end(); return; }
          }
          res.writeHead(200, headers); res.end(output);
        });
        response.on('error', () => { if (!res.headersSent) json(res, 502, { error: '无法读取设置页面资源。' }); else res.destroy(); });
        return;
      }
      res.writeHead(response.statusCode ?? 502, headers); response.pipe(res);
      response.on('error', () => res.destroy());
    });
    // Track upstream sockets as well: long SSE/RPC streams must not outlive auth.
    upstream.on('socket', socket => this.track(socket, id));
    upstream.on('error', () => { if (!res.headersSent) json(res, 502, { error: '本机 Harness 暂不可用。' }); else res.destroy(); });
    res.on('close', () => upstream.destroy());
    req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
  }
  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => socket.destroy());
    let id: Identity;
    try { id = await this.identity(req, true); } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    let path: string;
    try { path = this.path(req); } catch { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    if (path === PREFIX || path.startsWith(`${PREFIX}/`)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    if (new URL(req.url!, 'http://local.invalid').searchParams.has('token')) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    const cookie = await this.options.native.get();
    const upstream = request({ agent: false, hostname: '127.0.0.1', port: this.options.native.port, path: req.url, method: 'GET', headers: this.upstreamHeaders(req, cookie, true) });
    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      const started = Date.now();
      this.webSockets.active++; this.webSockets.opened++;
      socket.once('close', () => {
        this.webSockets.active--; this.webSockets.closed++;
        const reason = id.expires <= Date.now() ? 'auth-expired' : this.revoked.has(id.fingerprint) ? 'revoked' : Date.now() - (this.leases.get(id.fingerprint) ?? started) > (this.options.leaseMs ?? 90_000) ? 'lease-expired' : 'transport-closed';
        this.webSockets.lastClose = { durationMs: Date.now() - started, reason };
      });
      upstreamSocket.on('error', () => socket.destroy());
      const headers = clean(response.headers, true);
      const lines = Object.entries(headers).flatMap(([key, values]) => (Array.isArray(values) ? values : [values]).filter(v => v !== undefined).map(v => `${key}: ${v}`));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstreamSocket.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      this.track(socket, id); this.track(upstreamSocket, id);
      socket.pipe(upstreamSocket).pipe(socket);
      socket.once('close', () => upstreamSocket.destroy()); upstreamSocket.once('close', () => socket.destroy());
    });
    upstream.on('response', response => { if (response.statusCode === 401) this.options.native.reset(); response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
    upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy()); upstream.end();
  }
}
