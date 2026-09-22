import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Fiber } from '@deepseek-ai/cordis';
import * as Plugin from '../src/index.ts';
import { PREFIX } from '../src/model.ts';
import { NativeSession } from '../src/gateway.ts';
import { nativeHarness } from './fixtures.ts';
let native: Awaited<ReturnType<typeof nativeHarness>>, directory: string, fiber: Fiber, cookie: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-cloudflare-access-plugin-'));
  native = await nativeHarness();
  fiber = native.ctx.plugin(Plugin, { dataDir: directory, instance: 'test', gatewayPort: 33082 }); await fiber.await();
  cookie = await new NativeSession(native.port, base => native.connection.authenticatedUrl(base)).get();
});
afterEach(async () => { await fiber?.dispose(); await native?.close(); await rm(directory, { recursive: true, force: true }); });
const call = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${native.port}${PREFIX}/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: `http://127.0.0.1:${native.port}`, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
test('native plugin registers authenticated local settings and survives restart', async () => {
  expect(await (await call('status')).json()).toMatchObject({ remote: false, running: false, phase: 'unconfigured' });
  await fiber.restart(); expect((await call('status')).status).toBe(200);
});
test('unauthenticated browser cannot read admin status', async () => { expect((await call('status', undefined, { cookie: '' })).status).toBe(403); });
test('forwarded request cannot configure even with a native browser cookie', async () => { expect((await call('discover', { token: 'test-secret-value' }, { 'cf-access-jwt-assertion': 'irrelevant' })).status).toBe(403); });
test('invalid Token error never writes the supplied secret to state', async () => {
  const response = await call('discover', { token: 'private token with whitespace' }); expect(response.status).toBe(400);
  const persisted = await readFile(join(directory, 'state.json'), 'utf8'); expect(persisted).not.toContain('private token'); expect((await stat(join(directory, 'state.json'))).mode & 0o777).toBe(0o600);
});
test('second process/plugin instance cannot manage the same state directory', async () => {
  const duplicate = native.ctx.plugin({ ...Plugin, name: 'cloudflare-duplicate-test' }, { dataDir: directory, gatewayPort: 33083 });
  await expect(duplicate.await()).rejects.toThrow('另一个实例'); await duplicate.dispose();
});
test('unload removes the admin route without replacing native API', async () => {
  await fiber.dispose(); const response = await call('status'); expect(response.headers.get('content-type')).not.toContain('application/json');
  const rpc = await fetch(`http://127.0.0.1:${native.port}/api/llm/listProviders`, { method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${native.port}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'after-unload', method: 'llm/listProviders', payload: {} }) });
  expect(rpc.status).toBe(200); expect(await rpc.text()).toContain('fixture-provider');
});
