import { afterEach, expect, test, vi } from 'vitest';
import { createClient } from '../src/client.ts';
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
