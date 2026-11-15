import { moduleSection } from './bundle.ts';

/** Cache only versioned executable/style assets, never pages, RPCs, or streams. */
export function versionedAsset(url: string, contentType: string): boolean {
  if (!/^(?:text\/javascript|application\/javascript|text\/css)(?:;|$)/i.test(contentType)) return false;
  const parsed = new URL(url, 'http://local.invalid');
  if (parsed.pathname.startsWith('/assets/')) return /^\/assets\/[\w-]+-[\w-]{8,}\.(?:js|css)$/.test(parsed.pathname) && !parsed.search;
  // DSH's combo endpoint accepts only exact, advertised immutable revisions.
  return /^\/plugins\/\?\?.+\/client\.js(?:&rev=[a-f0-9]{12,32})$/.test(url) && !url.includes('client.js.map');
}

export const SETTINGS_MODULE = '@deepseek-ai/dsh-client-ui-settings-general';
// 0.1.6 prints the indicator expression spaced and with "quotes"; 0.2.x
// minifies it to no spaces and template literals. The quote is captured so the
// rewritten expression keeps the bundle's own style.
export const SETTINGS_ANCHOR = /state:\s*wide\s*&&\s*desktopUpdate\.presentation\?\.phase\s*!==\s*(["'`])installing\1\s*\?\s*connectionIndicator\s*:\s*void 0,/;

export function settingsBundleRequest(url: string): boolean {
  try { const path = decodeURIComponent(url); return path.startsWith('/plugins/') && path.includes(`${SETTINGS_MODULE}/client.js`) && !path.includes('client.js.map'); }
  catch { return false; }
}

/** One indicator owner on remote pages. Never alter the real Connection state. */
export function adaptSettingsBundle(source: string): string {
  const found = moduleSection(source, SETTINGS_MODULE);
  if (!found) return source;
  const { start, end, section } = found;
  // Exactly one indicator expression is rewritten; duplicates stay official.
  if ((section.match(new RegExp(SETTINGS_ANCHOR.source, 'g')) ?? []).length !== 1 || !section.includes('function SettingsRoot(')) return source;
  const replacement = (_match: string, quote: string) => `state: globalThis.__DSH_CLOUDFLARE_RECOVERY_OWNERS__?.size ? void 0 : (wide && desktopUpdate.presentation?.phase !== ${quote}installing${quote} ? connectionIndicator : void 0),`;
  return source.slice(0, start) + section.replace(new RegExp(SETTINGS_ANCHOR.source), replacement) + source.slice(end);
}

export function matchesEtag(header: string | undefined, etag: string): boolean {
  return header?.split(',').some(value => { const tag = value.trim(); return tag === '*' || tag.replace(/^W\//, '') === etag; }) ?? false;
}
