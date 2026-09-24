import { afterEach, expect, test, vi } from 'vitest';
import { createClient } from '../src/client.ts';
import { publicError, UserError } from '../src/model.ts';
afterEach(() => vi.unstubAllGlobals());
test('settings navigation uses the approved product name', () => {
  vi.stubGlobal('location', { hostname: '127.0.0.1' });
  let dictionaries: { zh: { nav: string }; en: { nav: string } } | undefined;
  let label: (() => string) | undefined;
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    inject: (_services: string[], fn: (value: unknown) => void) => fn(ctx),
    locale: {
      register: (_namespace: string, values: typeof dictionaries) => { dictionaries = values; return () => {}; },
      bind: () => () => dictionaries!.zh.nav,
    },
    slots: {
      inject: (_name: string, fn: () => unknown) => fn(),
      register: (spec: { label: () => string }) => { label = spec.label; },
    },
  };
  const client = createClient(() => ({ createElement: () => null }));
  client.apply(ctx as never);
  expect(label?.()).toBe('Cloudflare 零信任接入');
  expect(client.name).toBe('dsh-cloudflare-access-client');
});

type Element = { type: string; props: Record<string, unknown>; children: unknown[] };
function renderSettings(values: { status: unknown; preview?: unknown; confirmation?: string }) {
  vi.stubGlobal('location', { hostname: '127.0.0.1' });
  const state = [values.status, '', '', false, '', [], '', [], 'otp', '', '', '', values.preview, values.confirmation ?? ''];
  let index = 0, tree: unknown;
  const react = {
    Fragment: 'fragment', useEffect() {},
    useState: () => [state[index++], () => {}],
    createElement: (type: string | (() => unknown), props: Record<string, unknown> | null, ...children: unknown[]) =>
      typeof type === 'function' ? type() : { type, props: props ?? {}, children },
  };
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    inject: (_services: string[], fn: (value: unknown) => void) => fn(ctx),
    locale: { register: () => () => {}, bind: () => () => 'Cloudflare 零信任接入' },
    slots: {
      inject: (_name: string, fn: () => unknown) => fn(),
      register: (_spec: unknown, render: () => unknown) => { tree = render(); },
    },
  };
  createClient(() => react).apply(ctx as never);
  const elements: Element[] = [], labels: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') labels.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node) {
      const el = node as Element; elements.push(el); el.children.forEach(walk);
    }
  };
  walk(tree);
  return { text: labels.join('\n'), buttons: elements.filter(el => el.type === 'button') };
}
test('remote settings explain shared permissions without exposing configuration actions', () => {
  const view = renderSettings({ status: { remote: true, email: 'owner@example.com' } });
  expect(view.text).toContain('所有获准用户共享此 Harness 的会话、文件和工具权限。');
  expect(view.text).toContain('请在 Harness 主机上修改访问设置。');
  expect(view.buttons.map(el => el.children[0])).toEqual(['退出登录']);
  expect(view.text).not.toContain('API Token');
});
test('local settings distinguish the entry state from tunnel and device verification', () => {
  const view = renderSettings({ status: { remote: false, running: true, enabled: true, connector: 'connected', deployment: { hostname: 'harness.example.com', postureChecks: [] } } });
  expect(view.text).toContain('远程入口已启用');
  expect(view.text).toContain('隧道：已连接');
  expect(view.text).toContain('设备验证：未配置');
  expect(view.text).toContain('API Token 仅用于配置 Cloudflare 资源，不写入磁盘。');
  expect(view.text).toContain('删除本实例管理的 DNS 记录、Tunnel 和 Access 应用，保留共享登录方式。');
  expect(view.buttons.find(el => el.children[0] === '启用入口')?.props.disabled).toBe(true);
  expect(view.buttons.find(el => el.children[0] === '停用入口')?.props.disabled).toBe(false);
});
test.each(['', 'harness.example.com'])('publication retains the shared-permission notice and hostname confirmation: %s', confirmation => {
  const view = renderSettings({ status: { remote: false }, confirmation, preview: { createOtp: true, setup: { hostname: 'harness.example.com', emails: ['owner@example.com'] } } });
  expect(view.text).toContain('确认发布');
  expect(view.text).toContain('允许访问的邮箱：owner@example.com');
  expect(view.text).toContain('邮箱验证码登录');
  expect(view.text).toContain('仅向可信管理员开放。所有获准用户共享此 Harness 的会话、文件和工具权限。');
  expect(view.text).toContain('输入完整访问域名以确认');
  expect(view.buttons.find(el => el.children[0] === '发布配置')?.props.disabled).toBe(confirmation !== 'harness.example.com');
});
test('unexpected errors show an actionable message without internal error details', () => {
  expect(publicError(new Error('private-token-and-path'))).toEqual({ code: 'INTERNAL', message: '操作失败，请检查 Harness 主机上的服务状态。' });
  expect(publicError(new UserError('PLAN', '请重新检查配置。'))).toEqual({ code: 'PLAN', message: '请重新检查配置。' });
});
