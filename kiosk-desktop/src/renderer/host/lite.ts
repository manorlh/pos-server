/**
 * The "lite" profile (§13.4): for old PCs (Windows 7, Celeron J1900, 4 GB, Chromium 108 that may
 * draw in software) — no animations or transitions at all, no shadows. The screens are light by
 * default anyway (no blur, no backdrop-filter, transform/opacity only); lite switches off the rest.
 *
 * Order: the address (`?lite=1` / `?lite=0`), then what the device keeps, then the host's hint
 * (the Windows shell knows the OS, the memory and the CPU), then "reduce motion".
 */

export interface LiteInputs {
  search?: string;
  stored?: string | null;
  hint?: boolean;
  reducedMotion?: boolean;
}

export const LITE_STORE_KEY = 'r2m.app.lite';

export function liteMode(i: LiteInputs): boolean {
  const q = new URLSearchParams(i.search ?? '').get('lite');
  if (q === '1' || q === 'true') return true;
  if (q === '0' || q === 'false') return false;
  if (i.stored === '1') return true;
  if (i.stored === '0') return false;
  return i.hint === true || i.reducedMotion === true;
}

/** From the page itself (any storage error = nothing kept). */
export function liteFromPage(hint?: boolean): boolean {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(LITE_STORE_KEY);
  } catch {
    stored = null;
  }
  let reducedMotion = false;
  try {
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    reducedMotion = false;
  }
  return liteMode({ search: window.location.search, stored, hint, reducedMotion });
}
