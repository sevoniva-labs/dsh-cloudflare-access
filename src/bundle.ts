/** Byte-level helpers for rewriting one plugin's module inside a Harness client bundle.
 *
 * 0.1.6 emits a formatted registration (`id: "name"` on its own line);
 * 0.2.x minifies it to `id:\`name\`` with template literals. Both register the
 * module through the same `window.__ModuleLoader__.load(...)` wrapper, so a
 * section lookup only needs the id and the wrapper that follows it.
 */

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ModuleSection { start: number; end: number; section: string }

/**
 * Locate exactly one module registration for `id` in a client bundle.
 * @param source - full client bundle text as served by Harness.
 * @param id - module id the bundle registers.
 * @returns the registration offsets and text, or undefined when the id is
 * missing or registered more than once, so an unknown layout stays untouched.
 */
export function moduleSection(source: string, id: string): ModuleSection | undefined {
  const matches = [...source.matchAll(new RegExp(`id:\\s*(["'\`])${escapeRegExp(id)}\\1`, 'g'))];
  if (matches.length !== 1) return undefined;
  const start = matches[0]!.index!;
  const next = source.indexOf('window.__ModuleLoader__.load(', start);
  const end = next < 0 ? source.length : next;
  return { start, end, section: source.slice(start, end) };
}
