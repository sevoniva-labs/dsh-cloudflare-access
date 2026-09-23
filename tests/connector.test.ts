import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { Connector } from '../src/cloudflared.ts';
import { Controller } from '../src/controller.ts';
import { Gateway, NativeSession } from '../src/gateway.ts';
import { StateStore } from '../src/store.ts';
import { deployment } from './fixtures.ts';

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: mock.spawn }));
class Child extends EventEmitter {
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    this.signalCode = signal; this.emit('exit', null, signal); return true;
  });
  exit(code = 1) { this.exitCode = code; this.emit('exit', code, null); }
  registered() { this.stderr.emit('data', Buffer.from('Registered tunnel connection')); }
}
let directory: string, connector: Connector, children: Child[];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-connector-test-'));
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(1);
  children = []; mock.spawn.mockReset().mockImplementation(() => {
    const child = new Child(); children.push(child); queueMicrotask(() => child.emit('spawn'));
    return child as unknown as ChildProcess;
  });
  connector = new Connector(directory);
  vi.spyOn(connector, 'executable').mockResolvedValue('/fixture/cloudflared');
});
afterEach(async () => { await connector.stop(); vi.restoreAllMocks(); vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });
// Waiting for an attempt joins its asynchronous private-file write too.
const attempt = async (delay: number) => { await vi.advanceTimersByTimeAsync(delay); await connector.start('fixture-token'); };
const tokenPath = (index: number) => (mock.spawn.mock.calls[index]![1] as string[]).at(-1)!;

test('unexpected exit restarts once, retains no raw error, and removes only its own credentials', async () => {
  await connector.start('fixture-token'); children[0]!.registered();
  const oldFile = tokenPath(0); expect((await stat(oldFile)).mode & 0o777).toBe(0o600);
  children[0]!.exit();
  expect(connector.status).toBe('retrying'); expect(connector.lastError).toContain('自动重试');
  await attempt(999); expect(mock.spawn).toHaveBeenCalledTimes(1);
  await attempt(1); expect(mock.spawn).toHaveBeenCalledTimes(2);
  const newFile = tokenPath(1); expect(newFile).not.toBe(oldFile);
  children[0]!.emit('exit', 1, null); children[0]!.registered();
  expect(connector.status).toBe('starting');
  expect(await readFile(newFile, 'utf8')).toBe('fixture-token');
  await expect(stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
  children[1]!.registered(); expect(connector.status).toBe('connected'); expect(connector.lastError).toBeUndefined();
});
test('flapping processes back off to a capped delay and reset only after a stable connection', async () => {
  await connector.start('fixture-token');
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    children.at(-1)!.registered(); children.at(-1)!.exit();
    expect(connector.retryAt! - Date.now()).toBe(delay);
    const count = children.length; await attempt(delay); expect(children).toHaveLength(count + 1);
  }
  children.at(-1)!.registered(); await vi.advanceTimersByTimeAsync(30_000);
  children.at(-1)!.exit(); expect(connector.retryAt! - Date.now()).toBe(1000);
});
test('manual stop cancels backoff and does not restart or retain credential files', async () => {
  await connector.start('fixture-token'); children[0]!.exit(); await connector.stop();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mock.spawn).toHaveBeenCalledTimes(1); expect(connector.status).toBe('stopped');
  expect(connector.retryAt).toBeUndefined(); expect(await readdir(directory)).toEqual([]);
});
test('stop during executable lookup prevents a late spawn', async () => {
  let finish!: (path: string) => void;
  vi.mocked(connector.executable).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const starting = connector.start('fixture-token'), stopping = connector.stop();
  finish('/fixture/cloudflared'); await Promise.all([starting, stopping]);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mock.spawn).not.toHaveBeenCalled(); expect(connector.status).toBe('stopped');
});
test('concurrent starts share one process; repeated stop disarms a queued start', async () => {
  await Promise.all([connector.start('fixture-token'), connector.start('fixture-token')]);
  expect(children).toHaveLength(1);
  const stopping = connector.stop(), starting = connector.start('fixture-token'), stopAgain = connector.stop();
  await Promise.all([stopping, starting, stopAgain]); await vi.advanceTimersByTimeAsync(120_000);
  expect(children).toHaveLength(1); expect(connector.status).toBe('stopped');
});
test('spawn failure without an exit event retries and sanitizes its message', async () => {
  mock.spawn.mockImplementationOnce(() => {
    const child = new Child(); children.push(child);
    queueMicrotask(() => child.emit('error', new Error('secret-credential-must-not-be-shown')));
    return child as unknown as ChildProcess;
  });
  await connector.start('fixture-token');
  expect(connector.status).toBe('retrying'); expect(connector.lastError).not.toContain('secret-credential');
  await attempt(1000); expect(children).toHaveLength(2);
});
test('an error on a live process cannot create a duplicate child', async () => {
  await connector.start('fixture-token'); children[0]!.registered();
  children[0]!.emit('error', new Error('kill failure')); await vi.advanceTimersByTimeAsync(120_000);
  expect(children).toHaveLength(1); expect(connector.status).toBe('connected');
});
test('missing executable is observable and retries without spinning', async () => {
  vi.mocked(connector.executable).mockResolvedValueOnce(undefined);
  await connector.start('fixture-token'); expect(connector.status).toBe('retrying');
  expect(connector.lastError).toContain('尚未安装'); expect(mock.spawn).not.toHaveBeenCalled();
  await attempt(1000); expect(mock.spawn).toHaveBeenCalledTimes(1);
});
test('supervision can be explicitly restarted after a completed stop', async () => {
  await connector.start('fixture-token'); await connector.stop();
  await connector.start('new-fixture-token'); expect(children).toHaveLength(2);
  expect(await readFile(tokenPath(1), 'utf8')).toBe('new-fixture-token');
  children[1]!.registered(); expect(connector.status).toBe('connected');
});
test('controller keeps its authenticated gateway during recovery and cancels retries on stop', async () => {
  const store = new StateStore(directory);
  store.state.phase = 'configured'; store.state.deployment = { ...deployment, dnsId: 'fixture' };
  const owner = new Controller(store, { get: async () => 'fixture-token', set: async () => {}, clear: async () => {} }, new NativeSession(1, base => base), 0);
  connector = owner.connector; vi.spyOn(connector, 'executable').mockResolvedValue('/fixture/cloudflared');
  let port = 0;
  const originalStart = Gateway.prototype.start;
  vi.spyOn(Gateway.prototype, 'start').mockImplementation(async function (this: Gateway) {
    await originalStart.call(this); port = (this.server.address() as { port: number }).port;
  });
  try {
    await owner.execute('start', {}); children[0]!.registered(); children[0]!.exit();
    expect(owner.status()).toMatchObject({ enabled: true, running: true, connector: 'retrying' });
    expect(owner.status().lastError).toContain('自动重试');
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(403);
    await attempt(1000); children[1]!.registered();
    expect(owner.status()).toMatchObject({ running: true, connector: 'connected', lastError: undefined });
    children[1]!.exit(); await owner.execute('stop', {});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(children).toHaveLength(2); expect(owner.status()).toMatchObject({ enabled: false, running: false, connector: 'stopped' });
  } finally { await owner.dispose(); }
});
