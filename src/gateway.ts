import { createServer, request, type IncomingMessage, type ServerResponse, type IncomingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';
import { PREFIX, authDomain, fail, type Deployment } from './model.ts';

export interface Identity { email: string; subject: string; expires: number; fingerprint: string }
export type Verifier = (token: string) => Promise<Identity>;
export function accessVerifier(d: Deployment, fetcher: typeof fetch = fetch): Verifier {
  const issuer = `https://${authDomain(d.authDomain)}`;
  if (!d.audience) fail('AUDIENCE', 'Access audience 缺失。');
  const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000, [customFetch]: fetcher });
  return async token => {
    const { payload } = await jwtVerify(token, keys, { issuer, audience: d.audience, algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'email', 'iat'], maxTokenAge: '2h' });
    if (payload.type !== 'app' || typeof payload.email !== 'string' || !d.emails.includes(payload.email.toLowerCase()) || !payload.sub || !payload.exp) throw new Error('identity');
    return { email: payload.email.toLowerCase(), subject: payload.sub, expires: payload.exp * 1000, fingerprint: createHash('sha256').update(token).digest('hex') };
  };
}
export function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}
export function loopback(address: string | undefined): boolean { return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'; }
export function localAdmin(req: IncomingMessage, port: number, authenticated: boolean): boolean {
  if (!loopback(req.socket.remoteAddress) || !authenticated) return false;
  if (Object.keys(req.headers).some(x => x.startsWith('cf-') || x.startsWith('x-forwarded-') || x === 'forwarded')) return false;
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
    if (hop.has(key) || nominated.includes(key) || key === 'cookie' || key === 'authorization' || key === 'set-cookie' || key === 'forwarded' || key.startsWith('cf-') || key.startsWith('x-forwarded-')) continue;
    result[key] = value;
  }
  if (websocket) { result.connection = 'Upgrade'; result.upgrade = 'websocket'; }
  return result;
}
export interface GatewayOptions { deployment: Deployment; native: NativeSession; verify?: Verifier; leaseMs?: number }
/** Loopback-only origin: ALL HTTP and WS traffic is independently authenticated. */
export class Gateway {
  readonly server = createServer();
  private readonly verify: Verifier;
  private readonly sockets = new Set<Socket>();
  private readonly active = new Map<Duplex, { identity: Identity; since: number }>();
  private readonly leases = new Map<string, number>();
  private readonly revoked = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  constructor(private readonly options: GatewayOptions) {
    this.verify = options.verify ?? accessVerifier(options.deployment);
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
    if (id.expires <= Date.now() || this.revoked.has(id.fingerprint)) throw new Error('expired');
    return id;
  }
  private path(req: IncomingMessage): string {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Error('path');
    // Normalize encoded slashes and dot segments before excluding control paths.
    const decoded = decodeURIComponent(req.url.split('?')[0]!);
    if (decoded.includes('\\')) throw new Error('path');
    return new URL(decoded, 'http://local.invalid').pathname;
  }
  private upstreamHeaders(req: IncomingMessage, cookie: string, ws = false): IncomingHttpHeaders {
    const headers = clean(req.headers, ws), host = `127.0.0.1:${this.options.native.port}`;
    headers.host = host; headers.origin = `http://${host}`; headers.cookie = cookie;
    return headers;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let id: Identity;
    try { id = await this.identity(req); } catch { json(res, 403, { error: '需要有效的 Cloudflare Access 认证。' }); return; }
    const path = this.path(req);
    if (path === `${PREFIX}/session` && req.method === 'GET') { json(res, 200, { remote: true, email: id.email, expires: id.expires, deviceChecks: this.options.deployment.postureChecks.length }); return; }
    if (path === `${PREFIX}/lease` && req.method === 'POST') { this.leases.set(id.fingerprint, Date.now()); json(res, 200, { ok: true }); return; }
    if (path === `${PREFIX}/logout` && req.method === 'POST') {
      this.revoked.set(id.fingerprint, id.expires);
      for (const [socket, entry] of this.active) if (entry.identity.fingerprint === id.fingerprint) socket.destroy();
      json(res, 200, { ok: true }); return;
    }
    if (path === PREFIX || path.startsWith(`${PREFIX}/`)) { json(res, 403, { error: '仅允许在本机配置 Cloudflare。' }); return; }
    // Never forward bootstrap query parameters to the native runtime.
    if (new URL(req.url!, 'http://local.invalid').searchParams.has('token')) { json(res, 400, { error: '不接受本机启动凭据。' }); return; }
    const cookie = await this.options.native.get();
    const upstream = request({ agent: false, hostname: '127.0.0.1', port: this.options.native.port, path: req.url, method: req.method, headers: this.upstreamHeaders(req, cookie) }, response => {
      if (response.statusCode === 401) { this.options.native.reset(); response.resume(); json(res, 503, { error: '本机会话已更新，请重试。请求未被自动重放。' }); return; }
      const headers = clean(response.headers);
      headers['cache-control'] = 'no-store'; headers['referrer-policy'] = 'no-referrer';
      if (headers.location && (!headers.location.startsWith('/') || headers.location.startsWith('//') || headers.location.includes('token='))) { response.destroy(); json(res, 502, { error: '拒绝了非预期的上游重定向。' }); return; }
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
    const path = this.path(req);
    if (path === PREFIX || path.startsWith(`${PREFIX}/`)) { socket.destroy(); return; }
    const cookie = await this.options.native.get();
    const upstream = request({ agent: false, hostname: '127.0.0.1', port: this.options.native.port, path: req.url, method: 'GET', headers: this.upstreamHeaders(req, cookie, true) });
    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
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
