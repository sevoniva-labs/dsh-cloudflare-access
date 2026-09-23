import { randomUUID } from 'node:crypto';
import { Cloudflare } from './cloudflare.ts';
import { Connector } from './cloudflared.ts';
import { Gateway, NativeSession } from './gateway.ts';
import { fail, publicError } from './model.ts';
import { Provisioner, type Preview, type Vault } from './provision.ts';
import { StateStore } from './store.ts';

interface Plan { id: string; api: Cloudflare; preview: Preview; expires: number }
export class Controller {
  readonly provisioner: Provisioner;
  readonly connector: Connector;
  private gateway?: Gateway;
  private plan?: Plan;
  private planTimer?: NodeJS.Timeout;
  private busy = false;
  private disposed = false;
  private current?: Promise<unknown>;
  constructor(readonly store: StateStore, readonly vault: Vault, readonly native: NativeSession, gatewayPort: number, cloudflaredPath?: string, private readonly maxTokenAgeSeconds = 7200) {
    this.provisioner = new Provisioner(store, vault, gatewayPort);
    this.connector = new Connector(store.directory, cloudflaredPath, () => { void this.gateway?.stop(); this.gateway = undefined; });
  }
  async init(): Promise<void> {
    await this.store.load();
    if (this.store.state.enabled) {
      try { await this.start(); } catch (error) { this.store.state.lastError = publicError(error).message; await this.store.save(); }
    }
  }
  status() {
    const { state } = this.store;
    return { remote: false, phase: state.phase, enabled: state.enabled, running: !!this.gateway, connector: this.connector.status, busy: this.busy, deployment: state.deployment, lastError: state.lastError };
  }
  async execute(action: string, body: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) fail('DISPOSED', '插件正在停止。', 503);
    if (this.busy) fail('BUSY', '另一个操作正在进行，请稍后。', 409);
    this.busy = true;
    this.current = this.dispatch(action, body);
    try { return await this.current; }
    catch (error) {
      this.store.state.lastError = publicError(error).message;
      await this.store.save(); throw error;
    } finally { this.busy = false; this.current = undefined; }
  }
  private async dispatch(action: string, body: Record<string, unknown>): Promise<unknown> {
    const api = () => new Cloudflare(body.token as string);
    switch (action) {
      case 'discover': return this.provisioner.discover(api());
      case 'providers': return this.provisioner.providers(api(), String(body.accountId));
      case 'preview': {
        this.clearPlan();
        const client = api(), preview = await this.provisioner.preview(client, body.setup);
        const plan = { id: randomUUID(), api: client, preview, expires: Date.now() + 600_000 };
        this.plan = plan;
        this.planTimer = setTimeout(() => this.clearPlan(), 600_000); this.planTimer.unref();
        return { planId: plan.id, expires: plan.expires, ...preview };
      }
      case 'provision': {
        const plan = this.plan;
        if (!plan || plan.id !== body.planId || plan.expires < Date.now() || body.hostname !== plan.preview.setup.hostname) fail('PLAN', '预览已过期或未确认域名，请重新预览。');
        this.clearPlan();
        if (this.gateway) fail('RUNNING', '请先停用入口。');
        if (!await this.connector.executable()) fail('CONNECTOR_MISSING', '请先安装官方 cloudflared，再发布。');
        await this.provisioner.provision(plan.api, plan.preview);
        await this.start(); return this.status();
      }
      case 'install-connector': await this.connector.install(); return { installed: true };
      case 'start': await this.start(); return this.status();
      case 'stop': await this.stop(); return this.status();
      case 'cleanup': await this.stop(); await this.provisioner.cleanup(api(), String(body.hostname)); return this.status();
      default: fail('NOT_FOUND', '不存在的操作。', 404);
    }
  }
  private clearPlan(): void { clearTimeout(this.planTimer); this.plan = undefined; }
  private async start(): Promise<void> {
    if (this.gateway) return;
    const d = this.store.state.deployment;
    if (this.store.state.phase !== 'configured' || !d?.dnsId || !d.audience) fail('NOT_CONFIGURED', '请先完成部署配置。');
    const token = await this.vault.get(); if (!token) fail('CREDENTIAL', 'Tunnel 运行凭据丢失，请使用原配置重新预览并恢复。');
    const gateway = new Gateway({ deployment: d, native: this.native, maxTokenAgeSeconds: this.maxTokenAgeSeconds });
    try {
      await gateway.start(); this.gateway = gateway;
      await this.connector.start(token);
      this.store.state.enabled = true; delete this.store.state.lastError; await this.store.save();
    } catch (error) { await this.connector.stop(); await gateway.stop(); this.gateway = undefined; throw error; }
  }
  private async stop(): Promise<void> {
    this.store.state.enabled = false; await this.store.save();
    await this.connector.stop(); await this.gateway?.stop(); this.gateway = undefined;
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.clearPlan();
    await this.current?.catch(() => {});
    this.clearPlan();
    // Preserve the owner's enabled preference across a normal host restart.
    await this.connector.stop(); await this.gateway?.stop(); this.gateway = undefined;
  }
}
