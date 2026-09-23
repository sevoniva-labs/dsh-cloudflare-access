import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { authenticateBrowser, AUTH_MESSAGE, installSessionRecovery, probeLease, ProbeError, SessionRecovery, type Lease, type RecoveryState } from '../src/session-recovery.ts';

let controllers: SessionRecovery[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
afterEach(() => { controllers.forEach(c => c.stop()); controllers = []; vi.useRealTimers(); vi.unstubAllGlobals(); });
const lease = (sessionId = 'one', principal = 'owner'): Lease => ({ ok: true, sessionId, principal, expires: Date.now() + 3600_000, leaseMs: 90_000 });
function setup() {
  let online = true, state: string | undefined = 'connected';
  const listeners = new Set<() => void>();
  const connection = { reconnect: vi.fn(), state: { getSnapshot: () => state, subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; } } };
  const probe = vi.fn<(_signal: AbortSignal) => Promise<Lease>>().mockImplementation(async () => lease());
  const authenticate = vi.fn<(_interactive: boolean, _signal: AbortSignal) => Promise<void>>().mockRejectedValue(new Error('login'));
  const render = vi.fn<(_state: RecoveryState) => void>();
  const recovery = new SessionRecovery({ connection, probe, authenticate, render, online: () => online });
  controllers.push(recovery);
  return { recovery, connection, probe, authenticate, render, setOnline: (value: boolean) => { online = value; recovery.networkChanged(); }, setState: (value: string | undefined) => { state = value; listeners.forEach(fn => fn()); } };
}
test('first connection is not recovery, including when the native service starts later', async () => {
  const s = setup(); s.setState(undefined); s.recovery.start(); await vi.advanceTimersByTimeAsync(0);
  expect(s.render).toHaveBeenLastCalledWith('connecting');
  s.setState('connecting'); await vi.advanceTimersByTimeAsync(6000);
  expect(s.connection.reconnect).not.toHaveBeenCalled();
  expect(s.render.mock.calls).toEqual([['connecting']]);
  s.setState('connected'); expect(s.render).toHaveBeenLastCalledWith('connected');
  s.setState('disconnected'); expect(s.render).toHaveBeenLastCalledWith('recovering');
});
test('normal startup and brief reconnects stay quiet, slow connections and auth failures remain visible', async () => {
  const s = setup(), visible = new Set<{ textContent?: string; children: { textContent?: string }[] }>();
  const element = () => {
    const el = { textContent: '', children: [] as { textContent?: string }[], style: { cssText: '' }, setAttribute() {}, append(child: { textContent?: string }) { this.children.push(child); }, remove() { visible.delete(el); } };
    return el;
  };
  vi.stubGlobal('document', { createElement: element, body: { append: (el: ReturnType<typeof element>) => visible.add(el) }, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('navigator', { onLine: true });
  const fetcher = vi.fn().mockImplementation(async () => Response.json(lease())); vi.stubGlobal('fetch', fetcher);
  s.setState(undefined);
  const dispose = installSessionRecovery(s.connection);
  const text = () => [...visible].flatMap(el => el.children.map(child => child.textContent)).join(' ');
  try {
    await vi.advanceTimersByTimeAsync(0); s.setState('connecting');
    await vi.advanceTimersByTimeAsync(6000); expect(visible.size).toBe(0);
    s.setState('connected'); await vi.advanceTimersByTimeAsync(5000); expect(visible.size).toBe(0);
    s.setState('connecting'); await vi.advanceTimersByTimeAsync(2000);
    expect(visible.size).toBe(0); s.setState('connected');
    s.setState('disconnected'); await vi.advanceTimersByTimeAsync(3000);
    expect(text()).toContain('正在重新连接');
    s.setState('connected'); expect(visible.size).toBe(0);
    fetcher.mockImplementation(async () => new Response('', { status: 403 }));
    s.setState('disconnected'); await vi.advanceTimersByTimeAsync(1000);
    expect(text()).toContain('当前账号无访问权限');
    dispose(); await vi.advanceTimersByTimeAsync(120_000); expect(visible.size).toBe(0);
  } finally { dispose(); }
});
test('a genuinely slow first connection is shown after the grace period and cancels on dispose', async () => {
  const s = setup(), visible = new Set<unknown>(), appended: string[] = [];
  const element = () => {
    const el = { textContent: '', style: { cssText: '' }, setAttribute() {}, append(child: { textContent: string }) { appended.push(child.textContent); }, remove() { visible.delete(el); } };
    return el;
  };
  vi.stubGlobal('document', { createElement: element, body: { append: (el: unknown) => visible.add(el) }, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json(lease())));
  s.setState('connecting');
  let dispose = installSessionRecovery(s.connection);
  try {
    await vi.advanceTimersByTimeAsync(7999); expect(visible.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1); expect(visible.size).toBe(1); expect(appended).toContain('正在连接服务…');
    expect(appended).not.toContain('正在重新连接…');
    s.setState('connected'); expect(visible.size).toBe(0); dispose();
    s.setState(undefined); dispose = installSessionRecovery(s.connection);
    await vi.advanceTimersByTimeAsync(0); dispose(); await vi.advanceTimersByTimeAsync(9000);
    expect(visible.size).toBe(0);
  } finally { dispose(); }
});
test('healthy lease heartbeats do not reload or repeatedly reconnect', async () => {
  const s = setup(); s.recovery.start(); await vi.advanceTimersByTimeAsync(91_000);
  expect(s.probe).toHaveBeenCalledTimes(4); expect(s.connection.reconnect).not.toHaveBeenCalled();
  expect(s.render.mock.calls).toEqual([['connected']]);
});
test('one transient failure does not display a login prompt; recovery reconnects once', async () => {
  const s = setup(); await s.recovery.check(); s.probe.mockRejectedValueOnce(new ProbeError('network'));
  await s.recovery.check(); expect(s.render).toHaveBeenLastCalledWith('connected');
  await vi.advanceTimersByTimeAsync(5000); expect(s.connection.reconnect).toHaveBeenCalledTimes(1);
  expect(s.authenticate).not.toHaveBeenCalled(); expect(s.render).toHaveBeenLastCalledWith('connected');
});
test('a prolonged outage has bounded retry and no false authentication claim', async () => {
  const s = setup(); s.probe.mockRejectedValue(new ProbeError('network'));
  await s.recovery.check(); await vi.advanceTimersByTimeAsync(15_000);
  expect(s.probe).toHaveBeenCalledTimes(4); expect(s.render).toHaveBeenLastCalledWith('recovering');
  expect(s.authenticate).not.toHaveBeenCalled();
});
test('expired session attempts SSO once, then offers interactive login without a page reload', async () => {
  const s = setup(); await s.recovery.check(); s.probe.mockRejectedValue(new ProbeError('login'));
  await s.recovery.check(); await vi.advanceTimersByTimeAsync(60_000);
  expect(s.authenticate).toHaveBeenCalledTimes(1); expect(s.authenticate.mock.calls[0]?.[0]).toBe(false);
  expect(s.render).toHaveBeenLastCalledWith('login');
  s.authenticate.mockImplementationOnce(async () => { s.probe.mockResolvedValue(lease('renewed')); });
  s.recovery.login(); expect(s.authenticate.mock.calls[1]?.[0]).toBe(true);
  await vi.advanceTimersByTimeAsync(0); expect(s.connection.reconnect).toHaveBeenCalledTimes(1);
  expect(s.render).toHaveBeenLastCalledWith('connected');
});
test('silent SSO completion is rechecked at the gateway before restoring the connection', async () => {
  const s = setup(); await s.recovery.check(); s.probe.mockRejectedValueOnce(new ProbeError('login'));
  s.authenticate.mockResolvedValueOnce(); await s.recovery.check(); await vi.advanceTimersByTimeAsync(0);
  expect(s.probe).toHaveBeenCalledTimes(3); expect(s.connection.reconnect).toHaveBeenCalledTimes(1);
});
test('denied access never enters a silent login loop', async () => {
  const s = setup(); s.probe.mockRejectedValue(new ProbeError('denied')); await s.recovery.check();
  await vi.advanceTimersByTimeAsync(120_000); expect(s.authenticate).not.toHaveBeenCalled();
  expect(s.render).toHaveBeenLastCalledWith('denied'); expect(s.connection.reconnect).not.toHaveBeenCalled();
});
test('network and foreground recovery work after a suspended tab', async () => {
  const s = setup(); s.recovery.start(); await vi.advanceTimersByTimeAsync(0);
  s.setOnline(false); s.setState('disconnected'); const before = s.probe.mock.calls.length;
  await vi.advanceTimersByTimeAsync(300_000); expect(s.probe).toHaveBeenCalledTimes(before);
  s.setOnline(true); await vi.advanceTimersByTimeAsync(0);
  expect(s.connection.reconnect).toHaveBeenCalledTimes(1); s.setState('connected');
  expect(s.render).toHaveBeenLastCalledWith('connected');
});
test('credential rotation reconnects the official transport without renewing an old fingerprint', async () => {
  const s = setup(); await s.recovery.check(); s.probe.mockResolvedValue(lease('rotated'));
  await s.recovery.check(); expect(s.connection.reconnect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(90_000); expect(s.connection.reconnect).toHaveBeenCalledTimes(1);
});
test('native connecting notifications do not schedule another forced reconnect', async () => {
  const s = setup();
  s.connection.reconnect.mockImplementation(() => {
    s.setState('connecting');
    setTimeout(() => s.setState('connected'), 5000);
  });
  s.recovery.start(); await vi.advanceTimersByTimeAsync(0);
  s.probe.mockResolvedValue(lease('rotated')); await s.recovery.check();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(s.connection.reconnect).toHaveBeenCalledTimes(1);
  expect(s.render).toHaveBeenLastCalledWith('connected');
});
test('focus and heartbeat do not abort a native handshake already in progress', async () => {
  const s = setup(); s.setState('connecting'); s.recovery.start();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 8; i++) { s.recovery.wake(); await vi.advanceTimersByTimeAsync(1000); }
  expect(s.connection.reconnect).not.toHaveBeenCalled();
  s.setState('connected'); expect(s.render).toHaveBeenLastCalledWith('connected');
});
test('resuming a suspended page rebuilds a stale connection even when it still reports connected', async () => {
  const s = setup(); await s.recovery.check();
  vi.setSystemTime(Date.now() + 300_000); s.recovery.wake(); await vi.advanceTimersByTimeAsync(0);
  expect(s.connection.reconnect).toHaveBeenCalledTimes(1);
});
test('a second rapid token rotation is deferred, not dropped by the reconnect throttle', async () => {
  const s = setup(); await s.recovery.check(); s.probe.mockResolvedValue(lease('two')); await s.recovery.check();
  s.probe.mockResolvedValue(lease('three')); await s.recovery.check();
  expect(s.connection.reconnect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000); expect(s.connection.reconnect).toHaveBeenCalledTimes(2);
});
test('changed account requires explicit page recovery and does not reconnect automatically', async () => {
  const s = setup(); await s.recovery.check(); s.probe.mockResolvedValue(lease('two', 'different-owner'));
  await s.recovery.check(); expect(s.render).toHaveBeenLastCalledWith('account-changed');
  s.recovery.wake(); await vi.advanceTimersByTimeAsync(90_000); expect(s.probe).toHaveBeenCalledTimes(2);
  expect(s.connection.reconnect).not.toHaveBeenCalled();
});
test('account-change guard survives late connection, focus, network and login events', async () => {
  const s = setup(); s.recovery.start(); await vi.advanceTimersByTimeAsync(0);
  s.setState('connecting'); s.probe.mockResolvedValue(lease('two', 'different-owner'));
  await s.recovery.check(); expect(s.render).toHaveBeenLastCalledWith('account-changed');
  const probes = s.probe.mock.calls.length, renders = s.render.mock.calls.length;
  s.setState('connected'); s.setState('disconnected'); s.setState('connecting');
  s.setOnline(false); s.setOnline(true); s.recovery.wake(); s.recovery.login();
  await s.recovery.check(); await vi.advanceTimersByTimeAsync(120_000);
  expect(s.render).toHaveBeenCalledTimes(renders);
  expect(s.render).toHaveBeenLastCalledWith('account-changed');
  expect(s.probe).toHaveBeenCalledTimes(probes);
  expect(s.authenticate).not.toHaveBeenCalled(); expect(s.connection.reconnect).not.toHaveBeenCalled();
});
test('concurrent focus/pageshow/online events share one probe and one follow-up', async () => {
  const s = setup(); let resolve!: (value: Lease) => void;
  s.probe.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const pending = s.recovery.check(); for (let i = 0; i < 10; i++) s.recovery.wake();
  expect(s.probe).toHaveBeenCalledTimes(1); resolve(lease()); await pending;
  await vi.advanceTimersByTimeAsync(0); expect(s.probe).toHaveBeenCalledTimes(2);
});
test('dispose aborts pending authentication and cannot reconnect or render late', async () => {
  const s = setup(); s.probe.mockRejectedValue(new ProbeError('login'));
  let complete!: () => void;
  s.authenticate.mockImplementationOnce((_interactive, signal) => new Promise(resolve => { complete = resolve; signal.addEventListener('abort', resolve as () => void); }));
  const pending = s.recovery.check(); await vi.advanceTimersByTimeAsync(0);
  s.recovery.stop(); const count = s.render.mock.calls.length; complete(); await pending;
  await vi.advanceTimersByTimeAsync(120_000); expect(s.render).toHaveBeenCalledTimes(count);
  expect(s.connection.reconnect).not.toHaveBeenCalled(); expect(s.probe).toHaveBeenCalledTimes(1);
});
test('virtual eight-hour run spans eight credential rotations without manual reload', async () => {
  const s = setup(), started = Date.now();
  s.probe.mockImplementation(async () => lease(String(Math.floor((Date.now() - started) / 3600_000))));
  s.recovery.start(); await vi.advanceTimersByTimeAsync(8 * 3600_000);
  expect(s.connection.reconnect).toHaveBeenCalledTimes(8); expect(s.authenticate).not.toHaveBeenCalled();
});
test.each([
  [401, 'login'], [403, 'denied'], [502, 'unavailable'], [503, 'unavailable'],
] as const)('probe classifies HTTP %i as %s', async (status, kind) => {
  await expect(probeLease(new AbortController().signal, vi.fn().mockResolvedValue(new Response('', { status })))).rejects.toMatchObject({ kind });
});
test('probe uses the official AJAX header, does not follow auth redirects, and validates payloads', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(lease()));
  await probeLease(new AbortController().signal, fetcher);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'manual', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  fetcher.mockResolvedValueOnce({ type: 'opaqueredirect' });
  await expect(probeLease(new AbortController().signal, fetcher)).rejects.toMatchObject({ kind: 'login' });
  fetcher.mockResolvedValueOnce(new Response('<html>unexpected response</html>'));
  await expect(probeLease(new AbortController().signal, fetcher)).rejects.toMatchObject({ kind: 'unavailable' });
  fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
  await expect(probeLease(new AbortController().signal, fetcher)).rejects.toMatchObject({ kind: 'unavailable' });
});
test('silent iframe accepts only its own same-origin nonce and cleans up', async () => {
  const listeners = new Map<string, (e: unknown) => void>();
  const frame = { contentWindow: {}, remove: vi.fn(), src: '', hidden: false, title: '', referrerPolicy: '' };
  vi.stubGlobal('location', { origin: 'https://harness.example.com' });
  vi.stubGlobal('window', { addEventListener: (name: string, fn: (e: unknown) => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) });
  vi.stubGlobal('document', { createElement: () => frame, body: { append: vi.fn() } });
  const pending = authenticateBrowser(false, new AbortController().signal);
  const state = new URL(frame.src, 'https://harness.example.com').searchParams.get('state');
  for (const e of [{ origin: 'https://evil.example', source: frame.contentWindow, data: { type: AUTH_MESSAGE, state } }, { origin: location.origin, source: {}, data: { type: AUTH_MESSAGE, state } }, { origin: location.origin, source: frame.contentWindow, data: { type: AUTH_MESSAGE, state: 'wrong' } }]) listeners.get('message')?.(e);
  expect(frame.remove).not.toHaveBeenCalled();
  listeners.get('message')?.({ origin: location.origin, source: frame.contentWindow, data: { type: AUTH_MESSAGE, state } });
  await pending; expect(frame.remove).toHaveBeenCalledTimes(1); expect(listeners.size).toBe(0);
});
