import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fail } from './model.ts';
import { privateWrite } from './store.ts';
const run = promisify(execFile);
export const CLOUDFLARED_VERSION = '2026.9.1';

export class Connector {
  private child?: ChildProcess;
  private stopping = false;
  status: 'stopped' | 'starting' | 'connected' | 'failed' = 'stopped';
  constructor(readonly directory: string, private readonly configuredPath?: string, private readonly onFailure: () => void = () => {}) {}
  async executable(): Promise<string | undefined> {
    const candidates = this.configuredPath ? [this.configuredPath] : [join(this.directory, 'bin', 'cloudflared'), join(homedir(), '.local/bin/cloudflared'), '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'];
    for (const file of candidates) {
      try {
        await access(file, constants.X_OK);
        const { stdout } = await run(file, ['--version'], { timeout: 5000, maxBuffer: 4096 });
        if (/cloudflared version \d{4}\.\d+\.\d+/.test(stdout)) return file;
      } catch { /* Try the next explicit location; never run arbitrary shell text. */ }
    }
    return undefined;
  }
  async install(): Promise<void> {
    if (this.child) fail('RUNNING', '请先停用入口，再安装连接器。');
    const platform = process.platform, arch = process.arch;
    if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) fail('PLATFORM', '自动安装暂支持 macOS/Linux 的 arm64 和 x64；请手动指定官方 cloudflared 路径。');
    const assetName = `cloudflared-${platform}-${arch === 'x64' ? 'amd64' : arch}${platform === 'darwin' ? '.tgz' : ''}`;
    const response = await fetch(`https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${CLOUDFLARED_VERSION}`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) fail('DOWNLOAD', '无法读取官方发布信息，请通过系统代理重试或手动安装 cloudflared。');
    const release = await response.json() as { tag_name: string; assets: { name: string; browser_download_url: string; digest: string }[] };
    const asset = release.assets.find(x => x.name === assetName);
    if (release.tag_name !== CLOUDFLARED_VERSION || !asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') || asset.browser_download_url !== `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${assetName}`) fail('CHECKSUM', '官方发布缺少可验证的 SHA-256，已停止安装。');
    const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120_000) });
    if (!download.ok || !download.body) fail('DOWNLOAD', '官方连接器下载失败。');
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of download.body as unknown as AsyncIterable<Uint8Array>) { size += chunk.length; if (size > 100 * 1024 * 1024) fail('DOWNLOAD', '下载文件超过预期大小。'); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) fail('CHECKSUM', '连接器校验失败，未安装。');
    const temp = await mkdtemp(join(tmpdir(), 'dsh-cloudflare-access-download-'));
    try {
      let binary = bytes;
      if (platform === 'darwin') {
        const archive = join(temp, 'release.tgz'); await privateWrite(archive, bytes);
        // Extract only the named binary, not other archive entries or paths.
        await run('/usr/bin/tar', ['-xzf', archive, '-C', temp, 'cloudflared'], { timeout: 15_000 });
        binary = await readFile(join(temp, 'cloudflared'));
      }
      const target = join(this.directory, 'bin', 'cloudflared');
      await privateWrite(target, binary); await chmod(target, 0o700);
      const { stdout } = await run(target, ['--version'], { timeout: 5000 });
      if (!stdout.includes(`version ${CLOUDFLARED_VERSION}`)) { await unlink(target); fail('VERSION', '连接器版本验证失败。'); }
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  async start(token: string): Promise<void> {
    if (this.child) return;
    const binary = await this.executable();
    if (!binary) fail('CONNECTOR_MISSING', '尚未安装官方 cloudflared，请点击安装连接器。');
    const tokenFile = join(this.directory, 'tunnel-token.runtime'); await privateWrite(tokenFile, token);
    this.stopping = false; this.status = 'starting';
    const child = spawn(binary, ['tunnel', '--no-autoupdate', 'run', '--token-file', tokenFile], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TUNNEL_LOGLEVEL: 'info' } });
    this.child = child;
    // Do not persist/forward raw cloudflared logs: they may contain infrastructure details.
    let tail = '';
    child.stderr?.on('data', (data: Buffer) => { tail = (tail + data.toString()).slice(-4096); if (tail.includes('Registered tunnel connection')) this.status = 'connected'; });
    child.once('exit', () => { this.child = undefined; this.status = this.stopping ? 'stopped' : 'failed'; void unlink(tokenFile).catch(() => {}); if (!this.stopping) this.onFailure(); });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => { this.child = undefined; this.status = 'failed'; void unlink(tokenFile).catch(() => {}); reject(new Error('connector spawn')); }); });
  }
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child) await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref();
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
    });
    this.child = undefined; this.status = 'stopped';
    await unlink(join(this.directory, 'tunnel-token.runtime')).catch(() => {});
  }
}
