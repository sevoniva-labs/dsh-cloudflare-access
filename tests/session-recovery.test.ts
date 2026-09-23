import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { authenticateBrowser, AUTH_MESSAGE, probeLease, ProbeError, SessionRecovery, type Lease, type RecoveryState } from '../src/session-recovery.ts';

let controllers: SessionRecovery[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
afterEach(() => { controllers.forEach(c => c.stop()); controllers = []; vi.useRealTimers(); vi.unstubAllGlobals(); });
const lease = (sessionId = 'one', principal = 'owner'): Lease => ({ ok: true, sessionId, principal, expires: Date.now() + 3600_000, leaseMs: 90_000 });
function setup() {
  let online = true, state = 'connected';
  const listeners = new Set<() => void>();
  const connection = { reconnect: vi.fn(), state: { getSnapshot: () => state, subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; } } };
  const probe = vi.fn<(_signal: AbortSignal) => Promise<Lease>>().mockImplementation(async () => lease());
  const authenticate = vi.fn<(_interactive: boolean, _signal: AbortSignal) => Promise<void>>().mockRejectedValue(new Error('login'));
  const render = vi.fn<(_state: RecoveryState) => void>();
  const recovery = new SessionRecovery({ connection, probe, authenticate, render, online: () => online });
  controllers.push(recovery);
  return { recovery, connection, probe, authenticate, render, setOnline: (value: boolean) => { online = value; recovery.networkChanged(); }, setState: (value: string) => { state = value; listeners.forEach(fn => fn()); } };
}
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
