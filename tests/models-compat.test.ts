import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext, Script } from 'node:vm';
import { describe, expect, test, vi } from 'vitest';
import { adaptModelsBundle, modelDescribeFace, modelsBundleRequest, MODELS_MODULE } from '../src/models-compat.ts';
const require = createRequire(import.meta.url);
const source = readFileSync(require.resolve(`${MODELS_MODULE}/client`), 'utf8');
const view = { writable: true, hasDocument: true, namespaces: [{ ns: 'llm-pi-ai', revision: 1 }] };
const context = (read = async (): Promise<any> => ({ ok: true, value: view })) => ({ remote: { settings: { describe: read } } });

describe('model-scoped remote editor', () => {
  test('uses the official controller without changing global settings or installed source', () => {
    const adapted = adaptModelsBundle(source);
    expect(adapted).not.toBe(source);
    expect(() => new Script(adapted)).not.toThrow();
    expect(adapted).toContain('ctx.settingsScope.bind(');
    expect(adapted).not.toContain('isLoopback =');
    expect(readFileSync(require.resolve(`${MODELS_MODULE}/client`), 'utf8')).toBe(source);
    expect(adaptModelsBundle(adapted)).toBe(adapted);
  });
  test('leaves unknown, duplicate and unrelated bundles untouched', () => {
    const changed = source.replace('ModelsSettingsStore(ctx, schema,', 'DifferentStore(ctx, schema,');
    expect(adaptModelsBundle(changed)).toBe(changed);
    expect(adaptModelsBundle(source + source)).toBe(source + source);
    expect(adaptModelsBundle('unrelated')).toBe('unrelated');
    const sibling = 'window.__ModuleLoader__.load({id: "another", factory(){ const x = ctx.settingsScope.describe(); }});';
    expect(adaptModelsBundle(sibling + source + sibling).endsWith(sibling)).toBe(true);
  });
  test('only selects native single/combo JS routes', () => {
    expect(modelsBundleRequest(`/plugins/${MODELS_MODULE}/client.js?rev=1`)).toBe(true);
    expect(modelsBundleRequest(`/plugins/??other/client.js,${MODELS_MODULE}/client.js&rev=1`)).toBe(true);
    for (const url of [`/api/${MODELS_MODULE}/client.js`, `/plugins/${MODELS_MODULE}/client.js.map`, '/plugins/other/client.js', '/plugins/%FF']) expect(modelsBundleRequest(url)).toBe(false);
  });
  test('honors host writability and hides native document opener', async () => {
    const face = modelDescribeFace(context());
    await face.ensure();
    expect(face.getSnapshot().view).toMatchObject({ writable: true, hasDocument: false });
    const readOnly = modelDescribeFace(context(async () => ({ ok: true, value: { ...view, writable: false } })));
    await readOnly.ensure(); expect(readOnly.getSnapshot().view?.writable).toBe(false);
  });
  test('re-reads after saves and clears stale write capability after failure', async () => {
    const read = vi.fn().mockResolvedValueOnce({ ok: true, value: view }).mockResolvedValueOnce({ ok: false, error: { message: 'expired' } });
    const face = modelDescribeFace(context(read)); await face.ensure();
    face.acceptView({ ns: 'llm-pi-ai', revision: 2 } as any);
    expect(face.getSnapshot().view?.namespaces).toEqual([{ ns: 'llm-pi-ai', revision: 2 }]);
    await face.ensure(); expect(face.getSnapshot().view).toBeUndefined(); expect(face.getSnapshot().error).toBe('expired');
    expect(read).toHaveBeenCalledTimes(2);
  });
  test('a slow response cannot overwrite a newer one', async () => {
    let finish!: (response: any) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ ok: true, value: view });
    const face = modelDescribeFace(context(read)); const old = face.ensure(); await face.ensure();
    finish({ ok: false, error: { message: 'stale' } }); await old;
    expect(face.getSnapshot().view?.writable).toBe(true);
  });
  test('native store consumes the adapted face and preserves native revisioned operations', async () => {
    const start = source.indexOf('var ModelsSettingsStore = class {');
    const end = source.indexOf('\n\t\t};', start) + 6;
    const Store = runInNewContext(source.slice(start, end) + '\nModelsSettingsStore', {
      Map, Set, Promise, Error,
      _deepseek_ai_dsh_client_store: { createSnapshotStore(value: any) { return { getSnapshot: () => value, update: (fn: (s: any) => void) => fn(value) }; } },
      joinProviderDirectory: () => [],
    });
    const ctx = { remote: { ...context().remote, llm: { listProviders: async () => ({ ok: true, value: [] }), listConfigurableProviders: async () => ({ ok: true, value: [] }) } } };
    const store = new Store(ctx, {}, modelDescribeFace(ctx)); await store.load();
    expect(store.store.getSnapshot()).toMatchObject({ status: 'ready', writable: true });
    expect(adaptModelsBundle(source)).toContain('ctx.remote.settings.mutate(ns, ops, expectedRevision)');
    expect(adaptModelsBundle(source)).toContain('ctx.remote.credentials.set(ref, value)');
  });
});
