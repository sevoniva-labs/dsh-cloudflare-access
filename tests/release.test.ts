import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { releaseInfo, validateFiles, verifyArchive, verifyVersion } from '../scripts/release.ts';

const repository = 'sevoniva-labs/dsh-cloudflare-access';
const manifest = (version = '0.1.0-alpha.11', tag = 'alpha') => ({
  name: '@sevoniva/dsh-cloudflare-access', version,
  repository: { url: `https://github.com/${repository}.git` },
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/', tag },
});
const required = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'dist/client.js', 'dist/index.js', 'dist/index.js.map'];
test.each([['0.1.0-alpha.11', 'alpha'], ['0.2.0-beta.1', 'beta'], ['1.0.0-rc.0', 'rc'], ['1.0.0', 'latest']])('selects the release channel for %s', (version, channel) => {
  const info = releaseInfo(manifest(version, channel), `refs/tags/v${version}`, repository);
  expect(info.distTag).toBe(channel); expect(info.prerelease).toBe(channel !== 'latest');
});
test('rejects branches, mismatched tags and foreign repositories', () => {
  expect(() => releaseInfo(manifest(), 'refs/heads/main', repository)).toThrow('Tag must match');
  expect(() => releaseInfo(manifest(), 'refs/tags/v0.1.0-alpha.10', repository)).toThrow('Tag must match');
  expect(() => releaseInfo(manifest(), 'refs/tags/v0.1.0-alpha.11', 'other/repo')).toThrow('Unexpected repository');
});
test('rejects private packages, wrong package identities and prereleases marked latest', () => {
  const ref = 'refs/tags/v0.1.0-alpha.11';
  expect(() => releaseInfo({ ...manifest(), private: true }, ref, repository)).toThrow('Package is private');
  expect(() => releaseInfo({ ...manifest(), name: 'other' }, ref, repository)).toThrow('Unexpected package');
  expect(() => releaseInfo(manifest('0.1.0-alpha.11', 'latest'), ref, repository)).toThrow('publishConfig');
});
test.each(['1.0.0-dev.1', '01.0.0', '1.0.0-alpha.01', '../secret'])('rejects unsupported versions: %s', version => {
  expect(() => releaseInfo(manifest(version), `refs/tags/v${version}`, repository)).toThrow();
});
test('allows only distribution files and source modules', () => {
  expect(() => validateFiles([...required, 'src/client.ts'])).not.toThrow();
  expect(() => validateFiles(required.filter(file => file !== 'dist/client.js'))).toThrow('missing required');
  for (const file of ['.env', 'work/state.json', 'src/../secret.ts', '.npmrc', 'scripts/publish.ts']) expect(() => validateFiles([...required, file])).toThrow('Unexpected package contents');
});
test('verifies artifact bytes and rejects an already-published version with different integrity', () => {
  const bytes = Buffer.from('test-package');
  const info = { ...releaseInfo(manifest(), 'refs/tags/v0.1.0-alpha.11', repository), sha256: createHash('sha256').update(bytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  const published = { name: info.name, version: info.version, dist: { integrity: info.integrity, tarball: 'https://registry.npmjs.org/package.tgz' } };
  expect(() => verifyArchive(info, bytes)).not.toThrow();
  expect(() => verifyArchive(info, Buffer.from('changed'))).toThrow('SHA-256 mismatch');
  expect(() => verifyVersion(info, published)).not.toThrow();
  expect(() => verifyVersion(info, { ...published, dist: { ...published.dist, integrity: 'different' } })).toThrow('different bytes');
  expect(() => verifyVersion(info, { ...published, dist: { ...published.dist, tarball: 'https://other.example/package.tgz' } })).toThrow('Unexpected tarball host');
});
