import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fail, publicError } from './model.ts';
import { privateWrite } from './store.ts';
const run = promisify(execFile);
export const CLOUDFLARED_VERSION = '2026.9.1';

export class Connector {
  private child?: ChildProcess;
  private stopping = true;
  private generation = 0;
  private intent = 0;
  private token?: string;
  private pending?: Promise<void>;
  private stopPending?: Promise<void>;
  private retryTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private retries = 0;
  private readonly cleanups = new Set<Promise<void>>();
  status: 'stopped' | 'starting' | 'connected' | 'retrying' = 'stopped';
  lastError?: string;
  retryAt?: number;
  constructor(readonly directory: string, private readonly configuredPath?: string) {}
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
    if (!this.stopping || this.child || this.pending) fail('RUNNING', '请先停用入口，再安装连接器。');
    const platform = process.platform, arch = process.arch;
    if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) fail('PLATFORM', '自动安装暂支持 macOS/Linux 的 arm64 和 x64；请手动指定官方 cloudflared 路径。');
    const assetName = `cloudflared-${platform}-${arch === 'x64' ? 'amd64' : arch}${platform === 'darwin' ? '.tgz' : ''}`;
    const response = await fetch(`https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${CLOUDFLARED_VERSION}`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) fail('DOWNLOAD', '无法读取 cloudflared 发布信息，请检查网络或手动安装。');
    const release = await response.json() as { tag_name: string; assets: { name: string; browser_download_url: string; digest: string }[] };
    const asset = release.assets.find(x => x.name === assetName);
    if (release.tag_name !== CLOUDFLARED_VERSION || !asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') || asset.browser_download_url !== `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${assetName}`) fail('CHECKSUM', 'cloudflared 发布信息不符合预期或缺少 SHA-256 校验值，安装已停止。');
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
    const intent = ++this.intent;
    if (this.stopPending) await this.stopPending;
    if (intent !== this.intent) return;
    if (!this.stopping) return this.pending;
    this.stopping = false; this.token = token; this.retries = 0;
    await this.launch();
  }
  private active(generation: number): boolean { return !this.stopping && generation === this.generation; }
  private cleanup(path: string): void {
    const done = unlink(path).catch(() => {});
    this.cleanups.add(done); void done.then(() => this.cleanups.delete(done));
  }
  private retry(generation: number, message: string): void {
    if (!this.active(generation) || this.retryTimer) return;
    clearTimeout(this.stableTimer);
    const cap = Math.min(60_000, 1000 * 2 ** Math.min(this.retries++, 6));
    const delay = Math.ceil(cap * (0.8 + Math.random() * 0.2));
    this.status = 'retrying'; this.lastError = message; this.retryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined; this.retryAt = undefined;
      if (this.active(generation)) void this.launch();
    }, delay);
    this.retryTimer.unref();
  }
  private launch(): Promise<void> {
    if (this.pending) return this.pending;
    const generation = ++this.generation;
    const task = this.run(generation).catch(error => this.retry(generation, publicError(error).message)).finally(() => {
      if (this.pending === task) this.pending = undefined;
    });
    this.pending = task;
    return task;
  }
  private async run(generation: number): Promise<void> {
    const binary = await this.executable();
    if (!this.active(generation)) return;
    if (!binary) fail('CONNECTOR_MISSING', '尚未安装官方 cloudflared，请先停用入口并安装连接器。');
    // Each generation owns its credential file. A late exit cannot remove the
    // replacement process's credentials, even when unlink is delayed.
    const tokenFile = join(this.directory, `tunnel-token-${randomUUID()}.runtime`);
    let child: ChildProcess | undefined;
    try {
      await privateWrite(tokenFile, this.token!);
      if (!this.active(generation)) { this.cleanup(tokenFile); return; }
      this.status = 'starting';
      child = spawn(binary, ['tunnel', '--no-autoupdate', 'run', '--token-file', tokenFile], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TUNNEL_LOGLEVEL: 'info' } });
      this.child = child;
      const owned = child;
      let tail = '', ended = false, spawned = false;
      const endedOnce = () => {
        if (ended) return;
        ended = true; this.cleanup(tokenFile);
        if (this.child === owned) this.child = undefined;
        this.retry(generation, '连接器意外退出，正在自动重试。');
      };
      // Never persist or expose raw connector logs or credentials.
      child.stderr?.on('data', (data: Buffer) => {
        if (!this.active(generation) || ended) return;
        tail = (tail + data.toString()).slice(-4096);
        if (this.status !== 'connected' && tail.includes('Registered tunnel connection')) {
          this.status = 'connected'; this.lastError = undefined;
          // Do not reset backoff for a process that connects then immediately dies.
          this.stableTimer = setTimeout(() => { if (this.active(generation)) this.retries = 0; }, 30_000);
          this.stableTimer.unref();
        }
      });
      child.once('exit', endedOnce);
      await new Promise<void>(resolve => {
        owned.once('spawn', () => { spawned = true; resolve(); });
        owned.on('error', () => {
          // After spawning, an error does not prove the process is dead. Only
          // its exit can authorize replacement, preventing duplicate children.
          if (!spawned) { endedOnce(); resolve(); }
        });
      });
    } catch (error) { if (!child) this.cleanup(tokenFile); throw error; }
  }
  stop(): Promise<void> {
    ++this.intent;
    if (this.stopPending) return this.stopPending;
    this.stopping = true; this.token = undefined; ++this.generation;
    clearTimeout(this.retryTimer); clearTimeout(this.stableTimer);
    this.retryTimer = undefined; this.retryAt = undefined;
    const task = (async () => {
      await this.pending;
      const child = this.child;
      if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref();
        child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
      });
      this.child = undefined; this.status = 'stopped'; this.lastError = undefined;
      await Promise.all(this.cleanups);
    })().finally(() => { if (this.stopPending === task) this.stopPending = undefined; });
    this.stopPending = task;
    return task;
  }
}
