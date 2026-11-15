import { readFileSync } from 'node:fs';
import semver from 'semver';
import { expect, test } from 'vitest';
import { escapeRegExp, moduleSection } from '../src/bundle.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { engines: { dsh: string } };
// 0.2.x emits template literals around the module id; build one without backticks in this file.
const TICK = String.fromCharCode(96);

test('locates formatted and minified module registrations', () => {
  const formatted = 'window.__ModuleLoader__.load({\n\tid: "@scope/mod",\n\tfactory: () => {}\n});\n';
  const minified = '\nwindow.__ModuleLoader__.load({id:' + TICK + '@scope/mod' + TICK + ',factory:r=>{}});\n';
  expect(moduleSection(formatted, '@scope/mod')?.section).toContain('id: "@scope/mod"');
  expect(moduleSection(minified, '@scope/mod')?.section).toContain('factory:r=>{}');
  expect(moduleSection(formatted, '@scope/other')).toBeUndefined();
  expect(moduleSection(formatted + minified, '@scope/mod')).toBeUndefined();
  expect(moduleSection('no registration', '@scope/mod')).toBeUndefined();
});

test('escapes regular-expression metacharacters in module ids', () => {
  expect(escapeRegExp('a.b(c)')).toBe('a\\.b\\(c\\)');
  const bundle = 'window.__ModuleLoader__.load({id: "a.b(c)", factory: () => {}});';
  expect(moduleSection(bundle, 'a.b(c)')?.section).toContain('a.b(c)');
  expect(moduleSection(bundle, 'axb(c)')).toBeUndefined();
});

test('declared Harness support covers every verified runtime and nothing newer', () => {
  for (const version of ['0.1.6-alpha.2', '0.2.2-rc.1', '0.2.2-rc.3']) {
    expect(semver.satisfies(version, pkg.engines.dsh, { includePrerelease: true }), version).toBe(true);
  }
  for (const version of ['0.1.5', '0.2.0', '0.3.0-rc.1']) {
    expect(semver.satisfies(version, pkg.engines.dsh, { includePrerelease: true }), version).toBe(false);
  }
});
