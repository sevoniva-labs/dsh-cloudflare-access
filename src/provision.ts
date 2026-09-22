import { Cloudflare, applicationMatches, type Row } from './cloudflare.ts';
import { authDomain, fail, sameSetup, validateSetup, type Deployment, type Setup } from './model.ts';
import { StateStore } from './store.ts';

export interface Vault { set(value: string): Promise<void>; get(): Promise<string | undefined>; clear(): Promise<void> }
export interface Preview { setup: Setup; authDomain: string; zoneName: string; idpId?: string; createOtp: boolean; resume: boolean }

export class Provisioner {
  constructor(readonly store: StateStore, readonly vault: Vault, readonly gatewayPort: number) {}
  get marker(): string { return `dsh-cloudflare-access-${this.store.state.installationId}`; }
  private ownsApp(app: Row): boolean {
    // Legacy deployments used the name as a marker. Tags keep ownership separate
    // from the application name shown on the Cloudflare login page.
    return app.name === this.marker || (Array.isArray(app.tags) && app.tags.includes(this.marker));
  }
  async discover(api: Cloudflare) {
    const zones = await api.list<Row & { name: string; account: { id: string; name: string } }>('/zones');
    return zones.map(z => ({ id: z.id, name: z.name, accountId: z.account.id, accountName: z.account.name }));
  }
  async providers(api: Cloudflare, accountId: string) {
    if (!/^[a-f0-9]{32}$/i.test(accountId)) fail('INPUT', '账号 ID 格式错误。');
    return (await api.list(`/accounts/${accountId}/access/identity_providers`)).map(p => ({ id: p.id, name: String(p.name), type: String(p.type) }));
  }
  async preview(api: Cloudflare, raw: unknown): Promise<Preview> {
    const setup = validateSetup(raw), a = `/accounts/${setup.accountId}`;
    const existing = this.store.state.deployment;
    if (existing && !sameSetup(existing, setup)) fail('EXISTING_DEPLOYMENT', '本实例已有部署。为避免覆盖，请先停用并清理本插件创建的资源，或使用独立配置目录。');
    const [zone, org, providers, apps, dns, tunnels] = await Promise.all([
      api.request<Row & { name: string; account: { id: string } }>('GET', `/zones/${setup.zoneId}`),
      api.request<{ auth_domain: string }>('GET', `${a}/access/organizations`),
      api.list(`${a}/access/identity_providers`), api.list(`${a}/access/apps`),
      api.list(`/zones/${setup.zoneId}/dns_records?name=${encodeURIComponent(setup.hostname)}`),
      api.list(`${a}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(this.marker)}`),
    ]);
    if (zone.account.id !== setup.accountId || !setup.hostname.endsWith(`.${zone.name}`)) fail('ZONE', '必须选择该账号下的子域名，不能覆盖根域名。');
    for (const app of apps) if (applicationMatches(app, setup.hostname) && (!this.ownsApp(app) || app.domain !== setup.hostname || app.type !== 'self_hosted')) fail('APP_CONFLICT', '该域名已有 Access 应用（包括通配符或路径应用）；不会覆盖，请选择新子域名。');
    if (apps.some(app => this.ownsApp(app) && (app.domain !== setup.hostname || app.type !== 'self_hosted'))) fail('OWNERSHIP', '本插件的 Access 应用已被修改，请先人工核对，不会另建同名资源。');
    if (tunnels.some(t => t.config_src !== 'cloudflare')) fail('TUNNEL_MODE', '本插件的 Tunnel 配置模式不一致，拒绝覆盖。');
    for (const record of dns) if (record.comment !== this.marker || record.type !== 'CNAME' || !tunnels.some(t => record.content === `${t.id}.cfargotunnel.com`)) fail('DNS_CONFLICT', '该子域名已有 DNS 记录；不会覆盖，请选择新子域名。');
    if (apps.filter(x => this.ownsApp(x)).length > 1 || tunnels.length > 1 || dns.length > 1) fail('AMBIGUOUS', '发现重复的部署资源，请先在 Cloudflare 核对。');
    const idp = providers.find(x => setup.identityProvider === 'otp' ? x.type === 'onetimepin' : x.id === setup.identityProvider);
    if (!idp && setup.identityProvider !== 'otp') fail('IDP', '所选登录方式不存在或已被移除。');
    if (setup.postureChecks.length) {
      const available = await api.list(`${a}/devices/posture`);
      if (setup.postureChecks.some(id => !available.some(x => x.id === id))) fail('POSTURE', '设备检查不存在；不会降级为仅身份认证。');
    }
    return { setup, authDomain: authDomain(org.auth_domain), zoneName: zone.name, idpId: idp?.id, createOtp: !idp, resume: !!existing };
  }
  async provision(api: Cloudflare, preview: Preview): Promise<Deployment> {
    // Recheck immediately before writes: previews are not a lock on Cloudflare.
    const checked = await this.preview(api, preview.setup);
    const d: Deployment = this.store.state.deployment ?? { ...checked.setup, authDomain: checked.authDomain, zoneName: checked.zoneName, gatewayPort: this.gatewayPort };
    this.store.state.deployment = d;
    this.store.state.phase = 'provisioning'; this.store.state.enabled = false; delete this.store.state.lastError;
    await this.store.save();
    const a = `/accounts/${d.accountId}`, z = `/zones/${d.zoneId}`;
    let idpId = checked.idpId;
    if (!idpId) {
      // OTP is shared account infrastructure; never delete it during cleanup.
      const idp = await api.request<Row>('POST', `${a}/access/identity_providers`, { name: 'One-time PIN', type: 'onetimepin', config: {} });
      idpId = idp.id;
    }
    let app = (await api.list(`${a}/access/apps`)).find(x => this.ownsApp(x) && x.domain === d.hostname);
    if (!app) app = await api.request<Row>('POST', `${a}/access/apps`, {
      name: 'DeepSeek Harness', tags: [this.marker], type: 'self_hosted', domain: d.hostname,
      session_duration: '1h', allowed_idps: [idpId], auto_redirect_to_identity: true,
      http_only_cookie_attribute: true, same_site_cookie_attribute: 'lax', app_launcher_visible: true,
    });
    if (typeof app.aud !== 'string' || !app.aud || app.type !== 'self_hosted' || app.domain !== d.hostname) fail('APP_INVALID', 'Access 应用响应缺少有效 audience；发布已停止。');
    d.appId = app.id; d.audience = app.aud; await this.store.save();
    const expected = {
      name: this.marker, decision: 'allow', precedence: 1,
      include: d.emails.map(email => ({ email: { email } })), exclude: [],
      require: [{ login_method: { id: idpId } }, ...d.postureChecks.map(id => ({ device_posture: { integration_uid: id } }))],
    };
    const policies = await api.list(`${a}/access/apps/${app.id}/policies`);
    let policy = policies[0];
    if (policies.length > 1 || (policy && !policyMatches(policy, expected))) fail('POLICY_DRIFT', 'Access 策略与预览不一致；不会覆盖或放宽已有策略。');
    if (!policy) policy = await api.request<Row>('POST', `${a}/access/apps/${app.id}/policies`, expected);
    d.policyId = policy.id; await this.store.save();
    // A readable policy is required before a tunnel or public DNS is created.
    const readback = await api.list(`${a}/access/apps/${app.id}/policies`);
    if (readback.length !== 1 || !policyMatches(readback[0]!, expected)) fail('POLICY_VERIFY', '认证策略回读验证失败；没有发布域名。');
    let tunnel = (await api.list(`${a}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(this.marker)}`))[0];
    if (!tunnel) tunnel = await api.request<Row>('POST', `${a}/cfd_tunnel`, { name: this.marker, config_src: 'cloudflare' });
    d.tunnelId = tunnel.id; await this.store.save();
    await api.request('PUT', `${a}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ingress: [
      { hostname: d.hostname, service: `http://127.0.0.1:${d.gatewayPort}`, originRequest: { access: {
        required: true, teamName: d.authDomain.replace('.cloudflareaccess.com', ''), audTag: [d.audience],
      } } }, { service: 'http_status:404' },
    ] } });
    const token = await api.request<string>('GET', `${a}/cfd_tunnel/${tunnel.id}/token`);
    if (typeof token !== 'string' || token.length < 20) fail('TUNNEL_TOKEN', '没有取得有效的 Tunnel 运行凭据。');
    await this.vault.set(token);
    const records = await api.list(`${z}/dns_records?name=${encodeURIComponent(d.hostname)}`);
    if (records.some(r => r.comment !== this.marker || r.type !== 'CNAME' || r.content !== `${tunnel.id}.cfargotunnel.com`)) fail('DNS_CONFLICT', '发布期间发现 DNS 冲突，已停止；认证资源保留供恢复。');
    if (records.some(r => r.proxied !== true) || records.length > 1) fail('DNS_DRIFT', '本插件的 DNS 代理状态或记录数量已改变，请人工核对。');
    const dns = records[0] ?? await api.request<Row>('POST', `${z}/dns_records`, {
      type: 'CNAME', name: d.hostname, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, ttl: 1, comment: this.marker,
    });
    d.dnsId = dns.id; this.store.state.phase = 'configured'; await this.store.save();
    return d;
  }
  /** Caller must stop local serving first. Only recorded, verified owned resources. */
  async cleanup(api: Cloudflare, confirmedHostname: string): Promise<void> {
    const d = this.store.state.deployment;
    if (!d || confirmedHostname !== d.hostname) fail('CONFIRM', '请完整输入当前域名确认清理。');
    if (this.store.state.enabled) fail('RUNNING', '请先停用远程入口。');
    const a = `/accounts/${d.accountId}`, z = `/zones/${d.zoneId}`;
    // First reconcile uncertain writes using this installation's unique marker.
    const apps = (await api.list(`${a}/access/apps`)).filter(x => this.ownsApp(x));
    const tunnels = await api.list(`${a}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(this.marker)}`);
    const dns = (await api.list(`${z}/dns_records?name=${encodeURIComponent(d.hostname)}`)).filter(x => x.comment === this.marker);
    if (apps.length > 1 || tunnels.length > 1 || dns.length > 1) fail('AMBIGUOUS', '资源重复，请在 Cloudflare 手动核对后再清理。');
    if (apps.some(x => x.domain !== d.hostname || x.type !== 'self_hosted') || dns.some(x => x.type !== 'CNAME' || x.content !== `${tunnels[0]?.id ?? d.tunnelId}.cfargotunnel.com`)) fail('OWNERSHIP', '资源与本插件记录不一致，拒绝删除。');
    // DNS first, Access last: no removal step exposes an unprotected origin.
    for (const r of dns) await api.request('DELETE', `${z}/dns_records/${r.id}`);
    for (const t of tunnels) await api.request('DELETE', `${a}/cfd_tunnel/${t.id}`);
    for (const app of apps) await api.request('DELETE', `${a}/access/apps/${app.id}`);
    await this.vault.clear();
    delete this.store.state.deployment; delete this.store.state.lastError;
    this.store.state.phase = 'unconfigured'; await this.store.save();
  }
}
export function policyMatches(actual: Row, expected: Record<string, unknown>): boolean {
  const canonical = (v: unknown): string => JSON.stringify(Array.isArray(v) ? [...v].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : v);
  return actual.name === expected.name && actual.decision === 'allow'
    && ['include', 'require', 'exclude'].every(key => canonical(actual[key] ?? []) === canonical(expected[key] ?? []));
}
