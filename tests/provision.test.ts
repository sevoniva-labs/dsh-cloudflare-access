import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cloudflare, applicationMatches, type Row } from '../src/cloudflare.ts';
import { Provisioner } from '../src/provision.ts';
import { StateStore } from '../src/store.ts';
import { validateSetup } from '../src/model.ts';
import { deployment } from './fixtures.ts';

class FakeCloudflare {
  apps: Row[] = []; policies: Row[] = []; tunnels: Row[] = []; dns: Row[] = []; idps: Row[] = [{ id: 'otp-id', type: 'onetimepin' }];
  operations: string[] = []; uncertainDns = false; failAt = ''; tamperReadback = false; tunnelConfiguration: unknown;
  api = new Cloudflare('management-token-for-tests', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname.replace('/client/v4', ''), method = init?.method ?? 'GET';
    this.operations.push(`${method} ${path}`);
    if (this.failAt === `${method} ${path}`) return Response.json({ success: false, errors: [{ code: 1000, message: 'sensitive-value-must-not-leak' }] }, { status: 403 });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    let result: unknown;
    if (path === '/zones') result = [{ id: deployment.zoneId, name: deployment.zoneName, account: { id: deployment.accountId, name: 'Test' } }];
    else if (path === `/zones/${deployment.zoneId}`) result = { id: deployment.zoneId, name: deployment.zoneName, account: { id: deployment.accountId } };
    else if (path.endsWith('/access/organizations')) result = { auth_domain: deployment.authDomain };
    else if (path.endsWith('/devices/posture')) result = [{ id: 'posture-id' }];
    else if (path.endsWith('/identity_providers')) { if (method === 'POST') { result = { id: 'new-otp', ...body }; this.idps.push(result as Row); } else result = this.idps; }
    else if (path.endsWith('/policies')) { if (method === 'POST') { result = { id: 'policy-id', ...body }; this.policies.push(result as Row); } else result = this.tamperReadback && this.policies.length ? [{ ...this.policies[0], decision: 'bypass' }] : this.policies; }
    else if (path.endsWith('/access/apps')) { if (method === 'POST') { result = { id: 'app-id', aud: deployment.audience, ...body }; this.apps.push(result as Row); } else result = this.apps; }
    else if (path.endsWith('/access/apps/app-id') && method === 'PUT') { Object.assign(this.apps[0]!, body); result = this.apps[0]; }
    else if (path.endsWith('/cfd_tunnel')) { if (method === 'POST') { result = { id: 'tunnel-id', ...body }; this.tunnels.push(result as Row); } else result = this.tunnels.filter(t => t.name === url.searchParams.get('name')); }
    else if (path.endsWith('/configurations')) { this.tunnelConfiguration = body; result = body; }
    else if (path.endsWith('/token')) result = 'tunnel-runtime-token-never-in-state';
    else if (path.endsWith('/dns_records')) {
      if (method === 'POST') { result = { id: 'dns-id', ...body }; this.dns.push(result as Row); if (this.uncertainDns) { this.uncertainDns = false; throw new Error('simulated timeout after committed write'); } }
      else result = this.dns.filter(x => x.name === url.searchParams.get('name'));
    } else if (method === 'DELETE') {
      if (path.endsWith('/dns-id')) this.dns = [];
      else if (path.endsWith('/tunnel-id')) this.tunnels = [];
      else if (path.endsWith('/app-id')) { this.apps = []; this.policies = []; }
      else throw new Error(`unexpected DELETE ${path}`);
      result = {};
    } else throw new Error(`unexpected ${method} ${path}`);
    return Response.json({ success: true, result, result_info: { total_pages: 1 } });
  }) as typeof fetch);
}
let directory: string, store: StateStore, fake: FakeCloudflare, provision: Provisioner, secret: string | undefined;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-cloudflare-access-tests-')); store = new StateStore(directory); fake = new FakeCloudflare(); secret = undefined;
  provision = new Provisioner(store, { set: async x => { secret = x; }, get: async () => secret, clear: async () => { secret = undefined; } }, 3082);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const setup = () => validateSetup(deployment);
const deploy = async () => provision.provision(fake.api, await provision.preview(fake.api, setup()));
describe('transactional provisioning with mocked Cloudflare API', () => {
  test('preview is read-only; Access readback precedes tunnel, DNS published last', async () => {
    const preview = await provision.preview(fake.api, setup()); expect(fake.operations.every(x => x.startsWith('GET'))).toBe(true);
    await provision.provision(fake.api, preview);
    const writes = fake.operations.filter(x => !x.startsWith('GET'));
    expect(writes.map(x => x.split('/').at(-1))).toEqual(['apps', 'app-id', 'policies', 'cfd_tunnel', 'configurations', 'dns_records']);
    const tunnelIndex = fake.operations.findIndex(x => x.startsWith('POST') && x.endsWith('cfd_tunnel'));
    expect(fake.operations.slice(0, tunnelIndex).filter(x => x.startsWith('GET') && x.endsWith('policies'))).toHaveLength(2);
    expect(store.state.phase).toBe('configured'); expect(secret).toContain('tunnel-runtime-token');
    const data = await readFile(join(directory, 'state.json'), 'utf8'); expect(data).not.toContain('management-token'); expect(data).not.toContain('tunnel-runtime-token');
    expect((await stat(join(directory, 'state.json'))).mode & 0o777).toBe(0o600);
  });
  test('repeated provision reconciles own resources, no duplicate app/tunnel/DNS', async () => {
    await deploy(); await deploy(); expect(fake.apps).toHaveLength(1); expect(fake.tunnels).toHaveLength(1); expect(fake.dns).toHaveLength(1); expect(fake.policies).toHaveLength(1);
  });
  test('connector independently enforces the exact Access audience', async () => {
    await deploy();
    expect(fake.tunnelConfiguration).toEqual({ config: { ingress: [
      { hostname: deployment.hostname, service: 'http://127.0.0.1:3082', originRequest: { access: {
        required: true, teamName: deployment.authDomain.replace('.cloudflareaccess.com', ''), audTag: [deployment.audience],
      } } }, { service: 'http_status:404' },
    ] } });
  });
  test('records ownership by ID without exposing its UUID in the login application name', async () => {
    await deploy();
    expect(fake.apps[0]).toMatchObject({ name: 'DeepSeek Harness', id: store.state.deployment!.appId });
    fake.apps[0]!.name = 'Harness Team';
    await deploy(); expect(fake.apps).toHaveLength(1);
    await provision.cleanup(fake.api, deployment.hostname); expect(fake.apps).toHaveLength(0);
  });
  test('recognizes a legacy name marker but never adopts an unrecorded same-name app', async () => {
    await deploy(); fake.apps[0]!.name = provision.marker;
    await deploy(); expect(fake.apps).toHaveLength(1);
    fake.apps[0]!.name = 'DeepSeek Harness';
    delete store.state.deployment!.appId;
    await expect(deploy()).rejects.toThrow('已有 Access');
  });
  test('persists the app ID before renaming and recovers a failed rename', async () => {
    fake.failAt = `PUT /accounts/${deployment.accountId}/access/apps/app-id`;
    await expect(deploy()).rejects.toThrow('HTTP 403');
    const saved = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    expect(saved.deployment.appId).toBe('app-id'); expect(fake.apps[0]!.name).toBe(provision.marker);
    fake.failAt = ''; await deploy(); expect(fake.apps).toHaveLength(1); expect(fake.apps[0]!.name).toBe('DeepSeek Harness');
  });
  test('uncertain DNS write is recovered without duplicating it', async () => {
    fake.uncertainDns = true; await expect(deploy()).rejects.toMatchObject({ code: 'CF_NETWORK' });
    expect(fake.dns).toHaveLength(1); expect(store.state.phase).toBe('provisioning');
    await deploy(); expect(fake.dns).toHaveLength(1); expect(store.state.phase).toBe('configured');
  });
  test('foreign DNS is not overwritten or deleted', async () => {
    fake.dns.push({ id: 'foreign', type: 'A', name: deployment.hostname, content: '192.0.2.1' });
    await expect(deploy()).rejects.toThrow('已有 DNS'); expect(fake.operations.every(x => x.startsWith('GET'))).toBe(true);
  });
  test.each(['harness.example.com', '*.example.com', 'harness.example.com/admin'])('refuses conflicting Access app %s', async domain => {
    fake.apps.push({ id: 'foreign', name: 'foreign', type: 'self_hosted', domain }); await expect(deploy()).rejects.toThrow('已有 Access');
  });
  test('changed policy stops before tunnel or DNS publication', async () => {
    fake.tamperReadback = true; await expect(deploy()).rejects.toThrow('回读验证失败'); expect(fake.tunnels).toHaveLength(0); expect(fake.dns).toHaveLength(0);
  });
  test('device checks are AND requirements, no silent fallback', async () => {
    const selected = { ...setup(), postureChecks: ['posture-id'] };
    await provision.provision(fake.api, await provision.preview(fake.api, selected));
    expect(fake.policies[0]!.require).toEqual([{ login_method: { id: 'otp-id' } }, { device_posture: { integration_uid: 'posture-id' } }]);
  });
  test('invalid posture prevents every write', async () => { await expect(provision.preview(fake.api, { ...setup(), postureChecks: ['missing'] })).rejects.toThrow('设备检查不存在'); expect(fake.operations.every(x => x.startsWith('GET'))).toBe(true); });
  test('creates OTP only if missing and preserves shared identity provider on cleanup', async () => {
    fake.idps = []; await deploy(); await provision.cleanup(fake.api, deployment.hostname); expect(fake.idps).toHaveLength(1);
    expect(fake.operations.filter(x => x.startsWith('DELETE')).map(x => x.split('/').at(-1))).toEqual(['dns-id', 'tunnel-id', 'app-id']); expect(secret).toBeUndefined(); expect(store.state.phase).toBe('unconfigured');
  });
  test('cleanup needs exact confirmation and stopped service', async () => {
    await deploy(); await expect(provision.cleanup(fake.api, 'wrong.example.com')).rejects.toThrow('完整输入');
    store.state.enabled = true; await expect(provision.cleanup(fake.api, deployment.hostname)).rejects.toThrow('先停用'); expect(fake.dns).toHaveLength(1);
  });
  test('does not delete modified owned resource', async () => { await deploy(); fake.apps[0]!.domain = 'other.example.com'; await expect(provision.cleanup(fake.api, deployment.hostname)).rejects.toThrow('拒绝删除'); expect(fake.dns).toHaveLength(1); });
  test('permission errors are sanitized and do not publish', async () => { fake.failAt = `GET /accounts/${deployment.accountId}/access/organizations`; await expect(deploy()).rejects.toThrow('HTTP 403'); await expect(deploy()).rejects.not.toThrow('sensitive-value'); expect(fake.dns).toHaveLength(0); });
});
test.each(['https://example.com', '*.example.com', 'harness.example.com:443', 'a/../../b', '-bad.example.com'])('rejects unsafe hostname %s', hostname => { expect(() => validateSetup({ ...setup(), hostname })).toThrow(); });
test('matches wildcard and destination Access applications', () => { expect(applicationMatches({ id: 'x', destinations: [{ uri: '*.example.com/path' }] }, deployment.hostname)).toBe(true); expect(applicationMatches({ id: 'x', domain: 'other.example.com' }, deployment.hostname)).toBe(false); });
test('corrupt persisted state fails closed', async () => { await import('../src/store.ts').then(m => m.privateWrite(join(directory, 'state.json'), '{broken')); await expect(store.load()).rejects.toThrow('状态文件损坏'); });
