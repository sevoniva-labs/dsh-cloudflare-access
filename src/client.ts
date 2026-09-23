import type * as React from 'react';
import { PREFIX } from './model.ts';
import { installSessionRecovery, type BrowserConnection } from './session-recovery.ts';
interface ClientContext {
  connection: BrowserConnection;
  effect(fn: () => (() => void), label?: string): void;
  inject(services: string[], fn: (ctx: ClientContext) => void): void;
  slots: { inject(name: string, fn: () => unknown): unknown; register(spec: Record<string, unknown>, render: () => React.ReactNode): unknown };
  locale: { register(namespace: string, dictionaries: unknown): () => void; bind(namespace: string): (key: string) => string };
}
type Status = { remote: boolean; email?: string; expires?: number; phase?: string; enabled?: boolean; running?: boolean; connector?: string; lastError?: string; deployment?: { hostname: string; emails: string[]; postureChecks: string[] } };
type Zone = { id: string; name: string; accountId: string; accountName: string };
type Preview = { planId: string; expires: number; authDomain: string; createOtp: boolean; setup: { hostname: string; emails: string[]; postureChecks: string[] } };
async function api<T>(action: string, value?: unknown): Promise<T> {
  const response = await fetch(`${PREFIX}/${action}`, { method: value === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'manual', headers: { 'X-Requested-With': 'XMLHttpRequest', ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, body: value === undefined ? undefined : JSON.stringify(value) });
  if (response.type === 'opaqueredirect' || response.status === 401) throw new Error('登录已过期，请使用页面下方的登录入口。');
  let result;
  try { result = await response.json(); } catch { throw new Error('服务响应异常，请稍后重试。'); }
  if (!response.ok) throw new Error(result.error ?? `请求失败 (${response.status})`);
  return result as T;
}
export function createClient(require: (name: string) => unknown) {
  const R = require('react') as typeof React, h = R.createElement;
  const fieldStyle = { display: 'block', width: '100%', boxSizing: 'border-box' as const, padding: '9px 11px', marginTop: 6, border: '1px solid #8885', borderRadius: 7, background: 'transparent', color: 'inherit', font: 'inherit' };
  const buttonStyle = { padding: '9px 14px', border: '1px solid #8886', borderRadius: 7, background: 'transparent', color: 'inherit', cursor: 'pointer', marginRight: 8, marginTop: 10 };
  function Panel() {
    const [status, setStatus] = R.useState<Status>(), [error, setError] = R.useState(''), [note, setNote] = R.useState(''), [busy, setBusy] = R.useState(false);
    const [token, setToken] = R.useState(''), [zones, setZones] = R.useState<Zone[]>([]), [zoneId, setZone] = R.useState('');
    const [providers, setProviders] = R.useState<{ id: string; name: string; type: string }[]>([]), [provider, setProvider] = R.useState('otp');
    const [hostname, setHost] = R.useState(''), [emails, setEmails] = R.useState(''), [posture, setPosture] = R.useState(''), [preview, setPreview] = R.useState<Preview>(), [confirmation, setConfirmation] = R.useState('');
    const refresh = async () => setStatus(await api<Status>('session'));
    R.useEffect(() => { void refresh().catch(e => setError(e.message)); const timer = setInterval(() => { void refresh().catch(() => {}); }, 5000); return () => clearInterval(timer); }, []);
    const task = (fn: () => Promise<void>) => async () => { setBusy(true); setError(''); setNote(''); try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); } };
    const field = (label: string, value: string, change: (s: string) => void, type = 'text', placeholder = '') => h('label', { style: { display: 'block', marginTop: 14 } }, label, h('input', { type, value, placeholder, autoComplete: type === 'password' ? 'off' : undefined, style: fieldStyle, disabled: busy, onChange: (e: React.ChangeEvent<HTMLInputElement>) => { change(e.target.value); setPreview(undefined); } }));
    const button = (label: string, action: () => Promise<void>, disabled = false) => h('button', { type: 'button', disabled: busy || disabled, style: buttonStyle, onClick: task(action) }, label);
    const box = (children: React.ReactNode) => h('section', { style: { padding: 18, border: '1px solid #8884', borderRadius: 10, marginTop: 16 } }, children);
    const d = status?.deployment;
    return h('div', { style: { maxWidth: 780, margin: '0 auto', padding: 24, lineHeight: 1.6 } },
      h('h2', { style: { margin: 0 } }, 'Cloudflare 零信任接入'),
      error && h('div', { role: 'alert', style: { color: '#e56e63' } }, error),
      note && h('p', { role: 'status' }, note),
      !status ? h('p', null, '加载中…') : status.remote ? box(h(R.Fragment, null,
        h('h3', null, '已登录'), h('p', null, status.email),
        h('p', null, '当前使用共享工作环境。'),
        h('p', null, '访问设置请在运行 Harness 的电脑上修改。'),
        button('退出登录', async () => { await api('logout', {}); location.assign('/cdn-cgi/access/logout'); }),
      )) : h(R.Fragment, null,
        box(h(R.Fragment, null, h('strong', null, status.running ? '已启用' : '未启用'),
          h('p', null, `隧道：${({ stopped: '未启动', starting: '连接中', connected: '已连接', failed: '连接失败' } as Record<string, string>)[status.connector ?? 'stopped'] ?? '未知'}`),
          d && h('p', null, h('a', { href: `https://${d.hostname}`, target: '_blank', rel: 'noreferrer' }, d.hostname)),
          d && h('p', null, `设备验证：${d.postureChecks.length ? '已配置' : '未配置'}`),
          status.lastError && h('p', null, status.lastError),
          button('安装 cloudflared', async () => { await api('install-connector', {}); setNote('cloudflared 安装完成。'); }),
          d && button('启用', async () => { await api('start', {}); }, !!status.running),
          d && button('停用', async () => { await api('stop', {}); setNote('已停用，云端配置保留。'); }, !status.enabled),
        )),
        box(h(R.Fragment, null, h('h3', null, 'Cloudflare 凭据'),
          h('p', null, '用于配置 DNS、Access 和 Tunnel。此 Token 不保存。'),
          field('API Token', token, setToken, 'password'),
          button('验证并读取域名', async () => { const list = await api<Zone[]>('discover', { token }); setZones(list); setZone(''); setPreview(undefined); setNote(`已读取 ${list.length} 个域名。`); }, !token),
          h('details', { style: { marginTop: 12, fontSize: 12, opacity: .75 } }, h('summary', null, 'Token 权限'), h('p', null, 'Zone Read、DNS Edit、Cloudflare Tunnel Edit、Access Apps & Policies Edit、Access Organizations/Identity Providers Read。创建邮件验证码登录方式需 Identity Providers Edit；设备验证需 Device Posture Read。')),
        )),
        zones.length > 0 && box(h(R.Fragment, null, h('h3', null, '访问设置'),
          h('label', null, '域名', h('select', { 'aria-label': '域名', style: fieldStyle, value: zoneId, disabled: busy, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { const zone = zones.find(z => z.id === e.target.value); setZone(e.target.value); setPreview(undefined); setProviders([]); setProvider('otp'); if (zone) { setHost(`harness.${zone.name}`); void task(async () => setProviders(await api('providers', { token, accountId: zone.accountId })))(); } } }, h('option', { value: '' }, '请选择域名'), ...zones.map(z => h('option', { key: z.id, value: z.id }, `${z.name} · ${z.accountName}`)))),
          field('访问地址', hostname, setHost, 'text', 'harness.example.com'),
          field('允许的邮箱', emails, setEmails, 'text', 'you@example.com'),
          h('p', { style: { margin: '4px 0', fontSize: 12, opacity: .75 } }, '多个邮箱以逗号分隔。'),
          h('label', { style: { display: 'block', marginTop: 14 } }, '认证方式', h('select', { 'aria-label': '认证方式', style: fieldStyle, value: provider, disabled: busy, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { setProvider(e.target.value); setPreview(undefined); } }, h('option', { value: 'otp' }, '邮件验证码（One-time PIN）'), ...providers.filter(p => p.type !== 'onetimepin').map(p => h('option', { key: p.id, value: p.id }, `${p.name || p.type} (${p.type})`)))),
          h('details', { style: { marginTop: 16 } }, h('summary', null, '设备验证（可选）'),
            field('设备检查 ID', posture, setPosture),
            h('p', { style: { fontSize: 12, opacity: .75 } }, '需先在 Zero Trust 中创建设备检查。多个 ID 以逗号分隔，全部满足后才能访问。留空则只验证身份。')),
          button('检查配置', async () => { const zone = zones.find(z => z.id === zoneId)!; setPreview(await api<Preview>('preview', { token, setup: { accountId: zone.accountId, zoneId, hostname, emails: emails.split(',').map(s => s.trim()).filter(Boolean), identityProvider: provider, postureChecks: posture.split(',').map(s => s.trim()).filter(Boolean) } })); setToken(''); setConfirmation(''); }, !zoneId || !token || !emails),
        )),
        preview && box(h(R.Fragment, null, h('h3', null, '发布确认'),
          h('p', null, `访问地址：${preview.setup.hostname}`),
          h('p', null, `允许邮箱：${preview.setup.emails.join(', ')}`),
          h('p', null, `将创建 Access 应用、访问策略、Tunnel 和 DNS 记录${preview.createOtp ? '，并启用邮件验证码登录' : ''}。`),
          h('p', null, '获准用户共享此 Harness 的数据和工具权限。仅向可信管理员开放。'),
          h('p', { style: { fontSize: 12, opacity: .75 } }, '确认有效期：10 分钟。'),
          h('label', null, '输入访问地址以确认', h('input', { style: fieldStyle, value: confirmation, disabled: busy, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setConfirmation(e.target.value) })),
          button('发布', async () => { await api('provision', { planId: preview.planId, hostname: confirmation }); setPreview(undefined); setNote('已发布，等待隧道连接。'); }, confirmation !== preview.setup.hostname),
        )),
        d && box(h(R.Fragment, null, h('h3', null, '删除访问配置'),
          h('p', null, '删除本实例管理的 DNS、Tunnel 和 Access 应用，共享登录方式保留。请先停用并填写 API Token。'),
          button('删除配置…', async () => { const confirmed = window.prompt(`将删除 ${d.hostname} 的远程访问配置。输入完整域名确认：`); if (confirmed !== d.hostname) return; await api('cleanup', { token, hostname: confirmed }); setToken(''); setNote('访问配置已删除。'); }, !token || !!status.enabled),
        )),
      ), busy && h('p', { role: 'status' }, '处理中…'),
    );
  }
  return { name: 'dsh-cloudflare-access-client', inject: [], apply(ctx: ClientContext) {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) ctx.inject(['connection'], sub => {
      sub.effect(() => installSessionRecovery(sub.connection), 'cloudflare session recovery');
    });
    ctx.inject(['slots', 'locale'], sub => {
      sub.effect(() => sub.locale.register('dsh-cloudflare-access', { zh: { nav: 'Cloudflare 零信任接入' }, en: { nav: 'Cloudflare Zero Trust' } }), 'access locale');
      const t = sub.locale.bind('dsh-cloudflare-access');
      sub.slots.inject('settings.section', () => sub.slots.register({ name: 'settings.section', id: 'cloudflare', order: 25, label: () => t('nav'), locale: 'dsh-cloudflare-access' }, () => h(Panel)));
    });
  } };
}
