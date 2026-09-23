import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext, Script } from 'node:vm';
import { expect, test } from 'vitest';
import { adaptSettingsBundle, matchesEtag, settingsBundleRequest, SETTINGS_MODULE, versionedAsset } from '../src/web-assets.ts';
const require = createRequire(import.meta.url);
const source = readFileSync(require.resolve(`${SETTINGS_MODULE}/client`), 'utf8');

test('only versioned code/style URLs with the matching response MIME are browser-cacheable', () => {
  for (const path of ['/assets/index-8VXBH-f-.js', '/assets/vendor-BNsW4eBh.css', '/plugins/??@deepseek-ai/a/client.js,b/client.js&rev=abcdef123456']) {
    expect(versionedAsset(path, path.endsWith('css') ? 'text/css' : 'text/javascript; charset=utf-8')).toBe(true);
    expect(versionedAsset(path, 'text/html')).toBe(false);
    expect(versionedAsset(path, 'application/json')).toBe(false);
  }
  for (const path of ['/', '/api/private.js', '/plugins/events', '/plugins/??a/client.js', '/plugins/??a/client.js&rev=abcdef123456&dynamic=1', '/assets/index.js', '/assets/index-8VXBH-f-.js?token=private', '/assets/index-8VXBH-f-.js.map']) {
    expect(versionedAsset(path, 'text/javascript')).toBe(false);
  }
});
test('adaptation only affects the official connection indicator while this plugin owns recovery UI', () => {
  const adapted = adaptSettingsBundle(source);
  expect(adapted).not.toBe(source); expect(() => new Script(adapted)).not.toThrow();
  expect(adapted).toContain('connection.reconnect();');
  expect(adapted).toContain('connectionState: connection.state');
  expect(readFileSync(require.resolve(`${SETTINGS_MODULE}/client`), 'utf8')).toBe(source);
  const expression = adapted.match(/state: (globalThis\.__DSH_CLOUDFLARE_RECOVERY_OWNERS__.+),/)![1]!;
  const values = { wide: true, desktopUpdate: {}, connectionIndicator: 'disconnected' };
  expect(runInNewContext(expression, values)).toBe('disconnected');
  expect(runInNewContext(expression, { ...values, __DSH_CLOUDFLARE_RECOVERY_OWNERS__: new Set([{}]) })).toBeUndefined();
  expect(runInNewContext(expression, { ...values, __DSH_CLOUDFLARE_RECOVERY_OWNERS__: new Set() })).toBe('disconnected');
});
test('unknown or duplicate official bundle layouts retain the official indicator', () => {
  for (const value of ['other', source + source, source.replace('function SettingsRoot(props)', 'function OtherRoot(props)')]) expect(adaptSettingsBundle(value)).toBe(value);
  const adapted = adaptSettingsBundle(source); expect(adaptSettingsBundle(adapted)).toBe(adapted);
  const sibling = 'window.__ModuleLoader__.load({ id: "sibling", factory(){ return "untouched" } });';
  expect(adaptSettingsBundle(sibling + source + sibling).endsWith(sibling)).toBe(true);
  expect(settingsBundleRequest(`/plugins/??${SETTINGS_MODULE}/client.js&rev=abcdef123456`)).toBe(true);
  expect(settingsBundleRequest(`/plugins/??${SETTINGS_MODULE}/client.js.map&rev=abcdef123456`)).toBe(false);
  expect(settingsBundleRequest(`/api/${SETTINGS_MODULE}/client.js`)).toBe(false);
});
test('conditional validation accepts weak/list validators but rejects mismatched bytes', () => {
  expect(matchesEtag('W/"one", "two"', '"one"')).toBe(true);
  expect(matchesEtag('*', '"one"')).toBe(true);
  expect(matchesEtag('"two"', '"one"')).toBe(false);
  expect(matchesEtag(undefined, '"one"')).toBe(false);
});
