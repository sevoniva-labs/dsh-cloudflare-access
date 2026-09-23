/** Model-page-only compatibility for Harness 0.1.6-alpha.2.
 * Applied to authenticated gateway responses, never to installed Harness files.
 * Unknown bundle layouts stay unchanged (read-only).
 */
export const MODELS_MODULE = '@deepseek-ai/dsh-client-ui-settings-models';
const anchor = 'new ModelsSettingsStore(ctx, schema, ctx.settingsScope.describe())';

// The native editor already uses revisioned settings.mutate and credentials APIs.
// Give only this controller a host describe face; all other settings keep their
// original remote persistence policy. Read failures discard the writable view.
export function modelDescribeFace(ctx: { remote: { settings: { describe(): Promise<{ ok: boolean; value?: Record<string, unknown>; error?: { message: string } }> } } }) {
  let snapshot: { status: string; view?: Record<string, unknown>; error: string | null } = { status: 'idle', error: null };
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async ensure() {
      const current = ++generation;
      try {
        const response = await ctx.remote.settings.describe();
        if (current !== generation) return;
        if (!response.ok || !response.value) throw new Error(response.error?.message ?? '无法读取模型设置。');
        snapshot = { status: 'ready', view: { ...response.value, hasDocument: false }, error: null };
      } catch (error) {
        if (current !== generation) return;
        // Do not use "unavailable": older locally patched bundles retry that
        // state through their read-only fallback. The controller reports errors
        // for an idle face without a held view, without an extra wire request.
        snapshot = { status: 'idle', error: error instanceof Error ? error.message : '无法读取模型设置。' };
      }
      publish();
    },
    acceptView(view: { ns: string }) {
      ++generation;
      if (!snapshot.view) return;
      const namespaces = snapshot.view.namespaces as { ns: string }[];
      snapshot = { ...snapshot, view: { ...snapshot.view, namespaces: namespaces.map(row => row.ns === view.ns ? view : row) } };
      publish();
    },
  };
}

export function modelsBundleRequest(url: string): boolean {
  try {
    const decoded = decodeURIComponent(url);
    return decoded.startsWith('/plugins/') && decoded.includes(`${MODELS_MODULE}/client.js`) && !decoded.includes('client.js.map');
  } catch { return false; }
}

export function adaptModelsBundle(source: string): string {
  const marker = `id: "${MODELS_MODULE}"`;
  const start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) return source;
  const next = source.indexOf('window.__ModuleLoader__.load(', start);
  const end = next < 0 ? source.length : next;
  const section = source.slice(start, end);
  if (section.split(anchor).length !== 2 || !section.includes('function createModelsOperations(ctx)')) return source;
  // Function source is self-contained and comes from this package, not a URL,
  // user input, or a runtime credential. No eval runs in the browser.
  const replacement = `new ModelsSettingsStore(ctx, schema, (${modelDescribeFace.toString()})(ctx))`;
  return source.slice(0, start) + section.replace(anchor, replacement) + source.slice(end);
}
