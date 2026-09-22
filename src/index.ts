import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import '@deepseek-ai/dsh-host-webserver';
import '@deepseek-ai/dsh-client-connection';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { mkdir } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { Controller } from './controller.ts';
import { json, localAdmin, NativeSession } from './gateway.ts';
import { PREFIX, publicError, UserError, fail } from './model.ts';
import { StateStore } from './store.ts';

export const name = 'dsh-cloudflare-access';
export const inject = ['webServer', 'connection', 'credentials'];
export interface Config { instance: string; gatewayPort: number; dataDir?: string; cloudflaredPath?: string }
export const Config = z.object({ instance: z.string().default('web'), gatewayPort: z.natural().min(1024).max(65535).default(3082), dataDir: z.string(), cloudflaredPath: z.string() });
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type']).startsWith('application/json')) fail('CONTENT_TYPE', '需要 JSON 请求。', 415);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 32_768) fail('BODY_SIZE', '请求过大。', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* Invalid JSON. */ }
  fail('JSON', 'JSON 格式错误。');
}
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!/^[a-z0-9-]{1,40}$/.test(config.instance)) fail('INSTANCE', 'instance 仅支持小写字母、数字和连字符。');
  if (ctx.webServer.host !== '127.0.0.1') fail('BIND', '使用 Cloudflare 插件时，官方 webServer 必须仅监听 127.0.0.1。');
  if (config.gatewayPort === ctx.webServer.port) fail('PORT', '入口端口不能与 Harness 端口相同。');
  const directory = config.dataDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-cloudflare-access', config.instance);
  if (!isAbsolute(directory) || (config.cloudflaredPath && !isAbsolute(config.cloudflaredPath))) fail('PATH', '请使用绝对路径。');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let controller: Controller | undefined;
  let compromised = false;
  const release = await lockfile.lock(directory, { lockfilePath: join(directory, 'instance.lock'), stale: 30_000, update: 10_000, retries: 0, onCompromised: () => { compromised = true; void controller?.dispose(); } }).catch(() => fail('INSTANCE_LOCK', '该配置目录正在被另一个实例使用，或上次异常退出尚未超过 30 秒。'));
  ctx.effect(() => () => release().catch(() => {}), 'cloudflare instance lock');
  const store = new StateStore(directory);
  // Load the installation ID before binding its unique credential reference.
  await store.load();
  const ref = credentialRef(`DSH_CLOUDFLARE_ACCESS_${store.state.installationId.replaceAll('-', '_').toUpperCase()}_TUNNEL`);
  controller = new Controller(store, {
    set: value => ctx.credentials.set(ref, value),
    get: async () => (await ctx.credentials.resolve(ref))?.value,
    clear: () => ctx.credentials.unset(ref),
  }, new NativeSession(ctx.webServer.port, base => ctx.connection.authenticatedUrl(base)), config.gatewayPort, config.cloudflaredPath);
  const activeController = controller;
  ctx.effect(() => () => activeController.dispose(), 'cloudflare lifecycle');
  await controller.init();
  if (compromised) { await controller.dispose(); fail('INSTANCE_LOCK', '本机实例锁失效，入口已停止。'); }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: async (req, res) => {
    if (!localAdmin(req, ctx.webServer.port, !ctx.connection.requestRejection(req))) { json(res, 403, { error: 'Cloudflare 配置仅允许本机已认证浏览器访问。' }); return; }
    try {
      const path = new URL(req.url!, 'http://local.invalid').pathname.slice(PREFIX.length);
      if (compromised) fail('INSTANCE_LOCK', '本机实例锁失效，入口已停止。', 503);
      if (req.method === 'GET' && (path === '/status' || path === '/session')) { json(res, 200, activeController.status()); return; }
      if (req.method !== 'POST' || !/^\/[a-z-]+$/.test(path)) { json(res, 404, { error: 'Not found' }); return; }
      const result = await activeController.execute(path.slice(1), await body(req)); json(res, 200, result);
    } catch (error) { json(res, error instanceof UserError ? error.status : 500, { error: publicError(error).message, code: publicError(error).code }); }
  } }), 'cloudflare local settings');
}
