/** Cache only versioned executable/style assets, never pages, RPCs, or streams. */
export function versionedAsset(url: string, contentType: string): boolean {
  if (!/^(?:text\/javascript|application\/javascript|text\/css)(?:;|$)/i.test(contentType)) return false;
  const parsed = new URL(url, 'http://local.invalid');
  if (parsed.pathname.startsWith('/assets/')) return /^\/assets\/[\w-]+-[\w-]{8,}\.(?:js|css)$/.test(parsed.pathname) && !parsed.search;
  // DSH's combo endpoint accepts only exact, advertised immutable revisions.
  return /^\/plugins\/\?\?.+\/client\.js(?:&rev=[a-f0-9]{12,32})$/.test(url) && !url.includes('client.js.map');
}

export const SETTINGS_MODULE = '@deepseek-ai/dsh-client-ui-settings-general';
const indicator = 'state: wide && desktopUpdate.presentation?.phase !== "installing" ? connectionIndicator : void 0,';

export function settingsBundleRequest(url: string): boolean {
  try { const path = decodeURIComponent(url); return path.startsWith('/plugins/') && path.includes(`${SETTINGS_MODULE}/client.js`) && !path.includes('client.js.map'); }
  catch { return false; }
}

/** One indicator owner on remote pages. Never alter the real Connection state. */
export function adaptSettingsBundle(source: string): string {
  const marker = `id: "${SETTINGS_MODULE}"`, start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) return source;
  const next = source.indexOf('window.__ModuleLoader__.load(', start), end = next < 0 ? source.length : next;
  const section = source.slice(start, end);
  if (section.split(indicator).length !== 2 || !section.includes('function SettingsRoot(props)')) return source;
  const replacement = 'state: globalThis.__DSH_CLOUDFLARE_RECOVERY_OWNERS__?.size ? void 0 : (wide && desktopUpdate.presentation?.phase !== "installing" ? connectionIndicator : void 0),';
  return source.slice(0, start) + section.replace(indicator, replacement) + source.slice(end);
}

export function matchesEtag(header: string | undefined, etag: string): boolean {
  return header?.split(',').some(value => { const tag = value.trim(); return tag === '*' || tag.replace(/^W\//, '') === etag; }) ?? false;
}
