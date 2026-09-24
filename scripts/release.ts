import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'sevoniva-labs/dsh-cloudflare-access';
const packageName = '@sevoniva/dsh-cloudflare-access';
const registry = 'https://registry.npmjs.org/';
const directory = 'artifacts/release';
interface Manifest {
  name: string; version: string; private?: boolean;
  repository: { url: string };
  publishConfig: { access: string; registry: string; tag: string };
}
export interface ReleaseInfo {
  name: string; version: string; tag: string; distTag: string; prerelease: boolean; filename: string;
}
interface Artifact extends ReleaseInfo { integrity: string; sha256: string }
interface RegistryVersion { name: string; version: string; dist: { integrity: string; tarball: string } }

export function releaseInfo(pkg: Manifest, ref: string, source: string): ReleaseInfo {
  assert.equal(source, repository, 'Unexpected repository');
  assert.equal(pkg.name, packageName, 'Unexpected package name');
  assert.notEqual(pkg.private, true, 'Package is private');
  assert.equal(pkg.repository.url, `https://github.com/${repository}.git`, 'Repository URL mismatch');
  const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.exec(pkg.version);
  assert.ok(version, 'Use a stable version or an alpha.N, beta.N, rc.N prerelease');
  assert.equal(ref, `refs/tags/v${pkg.version}`, 'Tag must match package.json version');
  const distTag = version[4] ?? 'latest';
  assert.deepEqual(pkg.publishConfig, { access: 'public', registry, tag: distTag }, 'publishConfig must match the release channel');
  return { name: pkg.name, version: pkg.version, tag: `v${pkg.version}`, distTag, prerelease: distTag !== 'latest', filename: `sevoniva-dsh-cloudflare-access-${pkg.version}.tgz` };
}

export function validateFiles(files: string[]): void {
  const required = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'dist/client.js', 'dist/index.js', 'dist/index.js.map'];
  assert.ok(required.every(file => files.includes(file)), 'Package is missing required files');
  assert.ok(files.every(file => required.includes(file) || /^src\/[a-z-]+\.ts$/.test(file)), 'Unexpected package contents');
}

export function verifyArchive(info: Artifact, bytes: Buffer): void {
  assert.equal(info.sha256, createHash('sha256').update(bytes).digest('hex'), 'SHA-256 mismatch');
  assert.equal(info.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`, 'Package integrity mismatch');
}

async function artifact(): Promise<Artifact> {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as Manifest;
  const expected = releaseInfo(pkg, process.env.GITHUB_REF ?? '', process.env.GITHUB_REPOSITORY ?? '');
  const info = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')) as Artifact;
  for (const key of Object.keys(expected) as (keyof ReleaseInfo)[]) assert.equal(info[key], expected[key], `Artifact ${key} mismatch`);
  verifyArchive(info, await readFile(join(directory, info.filename)));
  assert.equal(await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8'), `${info.sha256}  ${info.filename}\n`);
  return info;
}

async function prepare(): Promise<void> {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as Manifest;
  const info = releaseInfo(pkg, process.env.GITHUB_REF ?? '', process.env.GITHUB_REPOSITORY ?? '');
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  assert.equal(lock.version, info.version, 'Lockfile version mismatch');
  assert.equal(lock.packages[''].version, info.version, 'Lockfile root version mismatch');
  await mkdir(directory, { recursive: true });
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { encoding: 'utf8' }));
  assert.equal(packed.length, 1);
  assert.equal(packed[0].filename, info.filename);
  assert.equal(packed[0].name, info.name);
  assert.equal(packed[0].version, info.version);
  validateFiles(packed[0].files.map((file: { path: string }) => file.path));
  const bytes = await readFile(join(directory, info.filename));
  const output: Artifact = { ...info, integrity: packed[0].integrity, sha256: createHash('sha256').update(bytes).digest('hex') };
  verifyArchive(output, bytes);
  await writeFile(join(directory, 'release.json'), `${JSON.stringify(output, null, 2)}\n`);
  await writeFile(join(directory, 'SHA256SUMS.txt'), `${output.sha256}  ${info.filename}\n`);
  console.log(`Prepared ${info.name}@${info.version} (${info.distTag})`);
}

async function version(info: ReleaseInfo): Promise<RegistryVersion | undefined> {
  const response = await fetch(`${registry}${encodeURIComponent(info.name)}/${encodeURIComponent(info.version)}`, { signal: AbortSignal.timeout(20_000), cache: 'no-store' });
  if (response.status === 404) return undefined;
  assert.ok(response.ok, `Registry lookup failed: HTTP ${response.status}`);
  return await response.json() as RegistryVersion;
}

export function verifyVersion(info: Artifact, published: RegistryVersion): void {
  assert.equal(published.name, info.name);
  assert.equal(published.version, info.version);
  assert.equal(published.dist.integrity, info.integrity, 'Published version contains different bytes');
  assert.equal(new URL(published.dist.tarball).origin, new URL(registry).origin, 'Unexpected tarball host');
}

async function publish(): Promise<void> {
  const info = await artifact();
  let published = await version(info);
  if (published) {
    verifyVersion(info, published);
    console.log('Identical version already published; dist-tags unchanged.');
  } else {
    execFileSync('npm', ['publish', join(directory, info.filename), '--ignore-scripts', '--access', 'public', '--tag', info.distTag, '--registry', registry, '--provenance'], { stdio: 'inherit' });
    for (let attempt = 0; attempt < 36; attempt++) {
      published = await version(info);
      if (published) break;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    assert.ok(published, 'Published version not yet visible. Re-run after registry propagation; do not change the version.');
    verifyVersion(info, published);
  }
  const response = await fetch(published.dist.tarball, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `Tarball download failed: HTTP ${response.status}`);
  verifyArchive(info, Buffer.from(await response.arrayBuffer()));
  console.log(`Verified registry metadata and tarball for ${info.name}@${info.version}`);
}

async function release(): Promise<void> {
  const info = await artifact();
  assert.ok(process.env.GH_TOKEN, 'GH_TOKEN is required');
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(info.tag)}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000),
  });
  const assets = [join(directory, info.filename), join(directory, 'SHA256SUMS.txt')];
  if (response.status === 404) {
    const notes = join(directory, 'RELEASE_NOTES.md');
    await writeFile(notes, [
      '通过 Cloudflare Access 和 Tunnel 远程访问 DeepSeek Harness。社区插件，非官方产品。',
      info.prerelease ? '本版本为预发布版本。' : '',
      '## 安装', '```sh', `dsh plugin --profile web add github:${repository}#${info.tag}`, '```',
      `兼容范围、配置步骤及安全说明见 [README](https://github.com/${repository}/blob/${info.tag}/README.md)。`,
      '本页安装包与 npm 发布包一致。下载 `.tgz` 和 `SHA256SUMS.txt` 后，运行 `shasum -a 256 -c SHA256SUMS.txt` 校验。',
      '## 界面', '插件设置页，使用示例数据展示，未连接实际 Cloudflare 部署。',
      `![连接状态](https://raw.githubusercontent.com/${repository}/${info.tag}/docs/images/connection-status.png)`,
      '<details><summary>访问设置与确认发布</summary>\n',
      `![访问设置](https://raw.githubusercontent.com/${repository}/${info.tag}/docs/images/access-setup.png)`,
      '</details>',
    ].join('\n\n'));
    execFileSync('gh', ['release', 'create', info.tag, ...assets, '--repo', repository, '--verify-tag', '--generate-notes', '--notes-file', notes, '--title', `${info.tag} · Cloudflare 零信任接入`, ...(info.prerelease ? ['--prerelease', '--latest=false'] : ['--latest'])], { stdio: 'inherit' });
  } else {
    assert.ok(response.ok, `Release lookup failed: HTTP ${response.status}`);
    const existing = await response.json() as { draft: boolean; prerelease: boolean; assets: { name: string; digest?: string }[] };
    assert.equal(existing.draft, false, 'Existing release is a draft');
    assert.equal(existing.prerelease, info.prerelease, 'Release channel mismatch');
    for (const file of assets) {
      const name = file.slice(file.lastIndexOf('/') + 1), previous = existing.assets.find(asset => asset.name === name);
      if (previous) assert.equal(previous.digest, `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`, 'Existing release asset differs; refusing to overwrite');
      else execFileSync('gh', ['release', 'upload', info.tag, file, '--repo', repository], { stdio: 'inherit' });
    }
  }
  const verified = JSON.parse(execFileSync('gh', ['release', 'view', info.tag, '--repo', repository, '--json', 'assets,isDraft,isPrerelease'], { encoding: 'utf8' })) as { isDraft: boolean; isPrerelease: boolean; assets: { name: string; digest?: string }[] };
  assert.equal(verified.isDraft, false);
  assert.equal(verified.isPrerelease, info.prerelease);
  for (const file of assets) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    assert.equal(verified.assets.find(asset => asset.name === name)?.digest, `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`, 'Uploaded release asset mismatch');
  }
  console.log(`https://github.com/${repository}/releases/tag/${info.tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2];
  if (command === 'prepare') await prepare();
  else if (command === 'publish') await publish();
  else if (command === 'release') await release();
  else throw new Error('Usage: release.ts prepare|publish|release');
}
