import { fail, UserError } from './model.ts';
export interface Row { id: string; [key: string]: unknown }
interface Envelope<T> { success: boolean; result: T; errors?: { code: number }[]; result_info?: { page?: number; total_pages?: number; count?: number; per_page?: number } }

/** No write retries: a timeout may mean a remote write succeeded. Reconcile first. */
export class Cloudflare {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    if (typeof token !== 'string' || token.length < 10 || token.length > 4096 || /\s/.test(token)) fail('TOKEN', '请填写 Cloudflare API Token（不是 Global API Key）。');
  }
  private async envelope<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.cloudflare.com/client/v4${path}`, {
        method, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: 'error',
      });
    } catch { throw new UserError('CF_NETWORK', 'Cloudflare 请求中断，操作结果尚未确认。请先核对云端资源，再重新检查配置。', 502); }
    let data: Envelope<T>;
    try { data = await response.json() as Envelope<T>; } catch { throw new UserError('CF_RESPONSE', 'Cloudflare 返回了无法解析的响应。', 502); }
    if (!response.ok || data.success !== true) {
      const code = data.errors?.[0]?.code;
      throw new UserError('CF_API', `Cloudflare ${method} ${path.split('?')[0]} 失败（HTTP ${response.status}${typeof code === 'number' ? `，代码 ${code}` : ''}）。请检查 Token 范围和权限。`, 502);
    }
    return data;
  }
  async request<T>(method: string, path: string, body?: unknown): Promise<T> { return (await this.envelope<T>(method, path, body)).result; }
  async list<T extends Row = Row>(path: string): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.envelope<T[]>('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=50&page=${page}`);
      if (!Array.isArray(data.result)) fail('CF_RESPONSE', 'Cloudflare 列表响应格式异常。');
      rows.push(...data.result);
      if (data.result_info?.total_pages !== undefined ? page >= data.result_info.total_pages : data.result.length < 50) return rows;
    }
    fail('CF_PAGINATION', 'Cloudflare 资源数量超出检查范围，无法确认是否存在冲突。操作已停止。');
  }
}

export function applicationMatches(app: Row, hostname: string): boolean {
  const destinations = Array.isArray(app.destinations) ? app.destinations as { uri?: string; type?: string; hostname?: string }[] : [];
  const domains = [app.domain, ...destinations.map(x => x.uri ?? x.hostname)].filter((x): x is string => typeof x === 'string');
  return domains.some(value => {
    const host = value.replace(/^https?:\/\//, '').split('/')[0]!.toLowerCase();
    const pattern = host.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${pattern}$`).test(hostname);
  });
}
