import { PREFIX } from './model.ts';

export type RecoveryState = 'connected' | 'recovering' | 'offline' | 'login' | 'denied' | 'unavailable' | 'account-changed';
export interface Lease { ok: true; sessionId: string; principal: string; expires: number; leaseMs: number }
export interface BrowserConnection {
  reconnect(): void;
  state: { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void };
}
export class ProbeError extends Error {
  constructor(readonly kind: 'login' | 'denied' | 'unavailable' | 'network') { super(kind); }
}

/** Only this read-only/idempotent probe is retried. Never replay Harness RPCs. */
export async function probeLease(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Lease> {
  let response: Response;
  try {
    response = await fetcher(`${PREFIX}/lease`, {
      method: 'POST', credentials: 'same-origin', redirect: 'manual', cache: 'no-store', signal,
      headers: { 'content-type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: '{}',
    });
  } catch { throw new ProbeError('network'); }
  if (response.type === 'opaqueredirect' || response.status === 401) throw new ProbeError('login');
  if (response.status === 403) throw new ProbeError('denied');
  if (!response.ok) throw new ProbeError('unavailable');
  let value: Lease;
  try { value = await response.json(); } catch { throw new ProbeError('unavailable'); }
  if (value.ok !== true || typeof value.sessionId !== 'string' || !value.sessionId || typeof value.principal !== 'string' || !value.principal || !Number.isFinite(value.expires) || !Number.isFinite(value.leaseMs) || value.leaseMs < 1000) throw new ProbeError('unavailable');
  return value;
}

export interface RecoveryOptions {
  connection: BrowserConnection;
  probe: (signal: AbortSignal) => Promise<Lease>;
  authenticate: (interactive: boolean, signal: AbortSignal) => Promise<void>;
  render: (state: RecoveryState) => void;
  online?: () => boolean;
  now?: () => number;
}

/** One auth/lease coordinator; the official Connection owns transport retries. */
export class SessionRecovery {
  private stopped = false;
  private accountChanged = false;
  private pending?: Promise<void>;
  private queued = false;
  private timer?: ReturnType<typeof setTimeout>;
  private probeAbort?: AbortController;
  private authAbort?: AbortController;
  private unsubscribe?: () => void;
  private lease?: Lease;
  private failedSince?: number;
  private silentAttempted = false;
  private needsReconnect = false;
  private lastReconnect = -Infinity;
  private lastSuccess = -Infinity;
  private state?: RecoveryState;
  private readonly now: () => number;
  constructor(private readonly options: RecoveryOptions) { this.now = options.now ?? Date.now; }

  start(): void {
    this.unsubscribe = this.options.connection.state.subscribe(() => {
      if (this.stopped || this.accountChanged) return;
      if (this.options.connection.state.getSnapshot() === 'connected' && this.failedSince === undefined && this.lease) this.show('connected');
      // Native Connection owns its retry loop. Its own reconnect() emits
      // "connecting" synchronously: forcing another reconnect here cancels
      // slow handshakes and creates a self-sustaining reconnect loop.
      else if (this.options.connection.state.getSnapshot() !== 'connected') this.schedule(1000);
    });
    void this.check();
  }
  stop(): void {
    this.stopped = true; clearTimeout(this.timer); this.probeAbort?.abort(); this.authAbort?.abort(); this.unsubscribe?.();
  }
  wake(): void {
    if (this.stopped || this.accountChanged) return;
    const state = this.options.connection.state.getSnapshot();
    this.needsReconnect ||= state === 'disconnected' || (state === 'connected' && this.lease !== undefined && this.now() - this.lastSuccess > this.lease.leaseMs / 2);
    void this.check();
  }
  networkChanged(): void {
    if (this.stopped || this.accountChanged) return;
    if (this.options.online?.() === false) {
      this.probeAbort?.abort(); this.authAbort?.abort(); this.needsReconnect = true; this.show('offline');
    } else this.wake();
  }
  /** Must be called directly from a user gesture so a login window is allowed. */
  login(): void {
    if (this.stopped || this.accountChanged) return;
    this.authAbort?.abort();
    const abort = this.authAbort = new AbortController();
    const result = this.options.authenticate(true, abort.signal);
    void result.then(() => { if (!abort.signal.aborted && !this.stopped) { this.needsReconnect = true; void this.check(); } }, () => {}).finally(() => { if (this.authAbort === abort) this.authAbort = undefined; });
  }
  check(): Promise<void> {
    if (this.stopped || this.accountChanged) return Promise.resolve();
    if (this.pending) { this.queued = true; return this.pending; }
    clearTimeout(this.timer);
    this.pending = this.run().finally(() => {
      this.pending = undefined;
      if (this.queued) { this.queued = false; if (!this.stopped) this.schedule(0); }
    });
    return this.pending;
  }
  private show(state: RecoveryState): void {
    if (!this.stopped && (!this.accountChanged || state === 'account-changed') && this.state !== state) { this.state = state; this.options.render(state); }
  }
  private schedule(delay: number): void {
    if (this.stopped || this.accountChanged) return;
    clearTimeout(this.timer); this.timer = setTimeout(() => { void this.check(); }, delay);
  }
  private async run(): Promise<void> {
    if (this.options.online?.() === false) { this.show('offline'); this.schedule(30_000); return; }
    const abort = this.probeAbort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 8000);
    try {
      const lease = await this.options.probe(abort.signal);
      if (this.stopped) return;
      if (this.lease && lease.principal !== this.lease.principal) {
        this.accountChanged = true; this.queued = false; this.needsReconnect = false;
        clearTimeout(this.timer); this.authAbort?.abort(); this.authAbort = undefined;
        this.show('account-changed'); return;
      }
      const recovered = this.failedSince !== undefined;
      const changed = this.lease !== undefined && this.lease.sessionId !== lease.sessionId;
      this.lease = lease; this.lastSuccess = this.now(); this.failedSince = undefined; this.silentAttempted = false;
      this.authAbort?.abort(); this.authAbort = undefined;
      this.needsReconnect ||= changed || recovered;
      if (this.needsReconnect && this.now() - this.lastReconnect >= 3000) {
        this.needsReconnect = false; this.lastReconnect = this.now(); this.options.connection.reconnect();
      }
      this.show(this.options.connection.state.getSnapshot() === 'connected' ? 'connected' : 'recovering');
      const expiryDelay = lease.expires - this.now() + 250;
      this.schedule(Math.max(1000, Math.min(this.needsReconnect ? 3000 : 30_000, lease.leaseMs / 3, expiryDelay)));
    } catch (error) {
      if (this.stopped) return;
      this.failedSince ??= this.now(); this.needsReconnect = true;
      const kind = error instanceof ProbeError ? error.kind : 'network';
      if (this.options.online?.() === false) this.show('offline');
      else if (kind === 'denied') this.show('denied');
      else if (kind === 'login') {
        if (!this.silentAttempted && !this.authAbort) {
          this.silentAttempted = true; this.show('recovering');
          const auth = this.authAbort = new AbortController();
          try {
            await this.options.authenticate(false, auth.signal);
            if (!this.stopped && !auth.signal.aborted) this.queued = true;
          } catch { if (!this.stopped && !auth.signal.aborted) this.show('login'); }
          finally { if (this.authAbort === auth) this.authAbort = undefined; }
        } else this.show('login');
      } else if (this.now() - this.failedSince >= 5000) this.show(kind === 'unavailable' ? 'unavailable' : 'recovering');
      this.schedule(kind === 'login' || kind === 'denied' ? 30_000 : 5000);
    } finally { clearTimeout(timeout); if (this.probeAbort === abort) this.probeAbort = undefined; }
  }
}

export const AUTH_MESSAGE = 'dsh-cloudflare-access:authenticated';

/** Access protects this URL too. No tokens cross window boundaries. */
export function authenticateBrowser(interactive: boolean, signal: AbortSignal): Promise<void> {
  const state = crypto.randomUUID();
  const url = `${PREFIX}/auth/complete?state=${encodeURIComponent(state)}`;
  return new Promise((resolve, reject) => {
    let frame: HTMLIFrameElement | undefined;
    let channel: BroadcastChannel | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (ok: boolean) => {
      clearTimeout(timer); frame?.remove(); channel?.close(); window.removeEventListener('message', message);
      signal.removeEventListener('abort', aborted); ok ? resolve() : reject(new Error('Authentication requires interaction'));
    };
    const aborted = () => finish(false);
    const message = (event: MessageEvent) => {
      if (frame && event.origin === location.origin && event.source === frame.contentWindow && event.data?.type === AUTH_MESSAGE && event.data?.state === state) finish(true);
    };
    if (signal.aborted) { reject(new Error('aborted')); return; }
    signal.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(false), interactive ? 300_000 : 8000);
    if (interactive) {
      // noopener prevents an external identity provider from navigating Harness.
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(AUTH_MESSAGE);
        channel.onmessage = event => { if (event.data?.state === state && event.data?.type === AUTH_MESSAGE) finish(true); };
      }
      window.open(url, '_blank', 'noopener');
    } else {
      frame = document.createElement('iframe'); frame.hidden = true; frame.title = '登录状态检查';
      frame.referrerPolicy = 'no-referrer';
      window.addEventListener('message', message); frame.src = url; document.body.append(frame);
    }
  });
}

export function installSessionRecovery(connection: BrowserConnection): () => void {
  let banner: HTMLDivElement | undefined;
  const labels: Record<Exclude<RecoveryState, 'connected'>, string> = {
    recovering: '正在恢复连接…', offline: '网络已断开，恢复后自动连接。', login: '登录已过期，请重新登录。',
    denied: '当前账号无访问权限。', unavailable: '服务暂不可用，正在重试。', 'account-changed': '登录账号已更换，请保存草稿后重新打开页面。',
  };
  const recovery = new SessionRecovery({ connection, probe: probeLease, authenticate: authenticateBrowser, online: () => navigator.onLine,
    render: state => {
      banner?.remove(); banner = undefined;
      if (state === 'connected') return;
      banner = document.createElement('div'); banner.setAttribute('role', 'status');
      banner.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:99999;background:#27272a;color:white;padding:12px 20px;border-radius:8px;box-shadow:0 4px 24px #0005;display:flex;align-items:center;gap:12px';
      const text = document.createElement('span'); text.textContent = labels[state]; banner.append(text);
      if (state !== 'account-changed' && state !== 'offline') {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = state === 'login' ? '登录' : '重试';
        button.style.cssText = 'color:inherit;background:none;border:1px solid #888;border-radius:4px;padding:4px 10px;cursor:pointer';
        button.onclick = () => state === 'login' ? recovery.login() : recovery.wake(); banner.append(button);
      }
      document.body.append(banner);
    },
  });
  const visible = () => { if (document.visibilityState === 'visible') recovery.wake(); };
  const wake = () => recovery.wake(), network = () => recovery.networkChanged();
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pageshow', wake); window.addEventListener('focus', wake);
  window.addEventListener('online', network); window.addEventListener('offline', network);
  recovery.start();
  return () => {
    recovery.stop(); banner?.remove(); document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('pageshow', wake); window.removeEventListener('focus', wake);
    window.removeEventListener('online', network); window.removeEventListener('offline', network);
  };
}
