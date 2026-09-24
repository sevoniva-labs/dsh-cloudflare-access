export const PREFIX = '/__dsh_cloudflare_access';
export const SUPPORTED_DSH = '0.1.6-alpha.2';
export interface Setup {
  accountId: string; zoneId: string; hostname: string; emails: string[];
  identityProvider: string; postureChecks: string[];
}
export interface Deployment extends Setup {
  authDomain: string; zoneName: string; gatewayPort: number;
  appId?: string; audience?: string; policyId?: string; tunnelId?: string; dnsId?: string;
}
export interface State {
  version: 1; installationId: string; enabled: boolean;
  phase: 'unconfigured' | 'provisioning' | 'configured' | 'error';
  deployment?: Deployment; lastError?: string;
}
export class UserError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
export function fail(code: string, message: string, status = 400): never { throw new UserError(code, message, status); }
export function publicError(error: unknown): { code: string; message: string } {
  return error instanceof UserError ? { code: error.code, message: error.message } : { code: 'INTERNAL', message: '操作失败，请检查 Harness 主机上的服务状态。' };
}
export function validateSetup(input: unknown): Setup {
  if (!input || typeof input !== 'object') fail('INPUT', '配置格式错误。');
  const p = input as Record<string, unknown>;
  for (const key of ['accountId', 'zoneId']) if (typeof p[key] !== 'string' || !/^[a-f0-9]{32}$/i.test(p[key])) fail('INPUT', '请选择有效的 Cloudflare 账号和域名。');
  if (typeof p.hostname !== 'string') fail('HOSTNAME', '请填写子域名。');
  const hostname = p.hostname.trim().toLowerCase();
  if (hostname.length > 253 || !hostname.includes('.') || !hostname.split('.').every(x => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(x))) fail('HOSTNAME', '请填写完整子域名，不要包含协议、路径、端口或通配符。');
  if (!Array.isArray(p.emails) || p.emails.length < 1 || p.emails.length > 50 || !p.emails.every(x => typeof x === 'string' && /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(x))) fail('EMAILS', '请填写 1–50 个有效邮箱，不支持通配符。');
  const emails = [...new Set((p.emails as string[]).map(x => x.toLowerCase()))].sort();
  if (typeof p.identityProvider !== 'string' || !/^(otp|[a-zA-Z0-9-]{1,80})$/.test(p.identityProvider)) fail('IDP', '请选择登录方式。');
  const postureChecks = p.postureChecks ?? [];
  if (!Array.isArray(postureChecks) || postureChecks.length > 10 || !postureChecks.every(x => typeof x === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(x))) fail('POSTURE', '最多填写 10 个设备检查 ID，每个 ID 仅支持字母、数字和连字符，长度为 1–80 个字符。');
  return { accountId: p.accountId as string, zoneId: p.zoneId as string, hostname, emails, identityProvider: p.identityProvider, postureChecks: [...new Set(postureChecks as string[])].sort() };
}
export function sameSetup(a: Setup, b: Setup): boolean {
  return JSON.stringify(validateSetup(a)) === JSON.stringify(validateSetup(b));
}
export function authDomain(value: unknown): string {
  if (typeof value !== 'string') fail('ORGANIZATION', '请先在 Cloudflare 完成 Zero Trust 初始化。');
  const domain = value.replace(/^https:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain)) fail('ORGANIZATION', 'Cloudflare 返回了不支持的认证域名。');
  return domain;
}
