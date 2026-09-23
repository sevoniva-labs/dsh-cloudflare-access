import { expect, test } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller } from '../src/controller.ts';
import { NativeSession } from '../src/gateway.ts';
import { StateStore } from '../src/store.ts';
import { deployment } from './fixtures.ts';

async function waitUntil(condition: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('fixture did not recover before deadline');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
test('real child exit and SIGKILL recover without restarting the controller', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-supervisor-process-'));
  const store = new StateStore(directory);
  store.state.phase = 'configured'; store.state.deployment = { ...deployment, dnsId: 'fixture' };
  const owner = new Controller(store, { get: async () => 'fixture-token', set: async () => {}, clear: async () => {} }, new NativeSession(1, base => base), 0, fileURLToPath(new URL('./fixtures/cloudflared-stub.mjs', import.meta.url)));
  try {
    await owner.execute('start', {});
    await waitUntil(() => owner.connector.status === 'retrying');
    expect(owner.status()).toMatchObject({ enabled: true, running: true, connector: 'retrying' });
    await waitUntil(() => owner.connector.status === 'connected');
    const first = Number(await readFile(join(directory, 'fixture.pid'), 'utf8'));
    expect(Number.isSafeInteger(first) && first > 0).toBe(true);
    process.kill(first, 'SIGKILL');
    await waitUntil(() => owner.connector.status === 'retrying');
    await waitUntil(() => owner.connector.status === 'connected');
    const second = Number(await readFile(join(directory, 'fixture.pid'), 'utf8'));
    expect(second).not.toBe(first);
    expect(owner.status().lastError).toBeUndefined();
    await owner.execute('stop', {});
    expect(owner.status()).toMatchObject({ enabled: false, running: false, connector: 'stopped' });
    expect((await readdir(directory)).filter(x => x.endsWith('.runtime'))).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(() => process.kill(second, 0)).toThrow();
    expect(owner.connector.status).toBe('stopped');
  } finally { await owner.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 20_000);
