/**
 * The two TypeScript kiosk hosts are near-copies: the Windows kiosk's renderer/kiosk/KioskApp.tsx and
 * the browser kiosk's client components/kiosk-web/web-kiosk-app.tsx. Both draw the same shared screens
 * (client kiosk-shared). This test reads both sources and fails when they drift apart where the
 * customer would notice (PARITY.md guard rail 8):
 *
 *  - the shared screens each one renders, and the props it passes each one;
 *  - the screens' model (`const m: PreviewModel = { … }`): the same keys;
 *  - the money and the offers through the ONE shared code — the order's tip
 *    (kiosk-shared/checkout-rules.ts), the upsell window (kiosk-shared/upsell-window.ts) and the meal
 *    upsell (kiosk-shared/basket-upsell.ts) — never a local copy.
 *
 * A difference that belongs to one platform is listed below with its reason.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const WINDOWS = readFileSync(path.join(here, '..', 'src', 'renderer', 'kiosk', 'KioskApp.tsx'), 'utf8');
const WEB = readFileSync(path.join(here, '..', '..', 'client', 'src', 'components', 'kiosk-web', 'web-kiosk-app.tsx'), 'utf8');

/** Shared screens one host draws and the other does not, and why. */
const ONLY_ONE: Record<string, string> = {
  WaitLogo: 'the browser kiosk draws its loading screen itself (the Windows kiosk shows the window only once ready)',
};

/** The names a host imports from the shared screens (kiosk-shared's index). */
function sharedImports(src: string): string[] {
  const m = /import \{([^}]*)\} from '(?:@kiosk-shared\/index|@\/kiosk-shared)';/s.exec(src);
  if (!m) throw new Error('no kiosk-shared import');
  return m[1]
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith('type '));
}

/** The attributes of every `<Name …>` in `src` — braces, strings and nested JSX skipped whole. */
function propsOf(src: string, name: string): Set<string> | null {
  const out = new Set<string>();
  let found = false;
  const open = new RegExp(`<${name}(?=[\\s/>])`, 'g');
  for (let m = open.exec(src); m; m = open.exec(src)) {
    found = true;
    let i = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    let attrs = '';
    for (; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (depth === 0 && (ch === '"' || ch === "'")) {
        quote = ch;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (depth === 0 && ch === '>') break;
      if (depth === 0 && ch !== '}') attrs += ch;
      else if (depth === 0) attrs += ' ';
    }
    for (const a of attrs.matchAll(/(?:^|\s)([A-Za-z][\w]*)(?==|\s|\/|$)/g)) out.add(a[1]);
  }
  return found ? out : null;
}

/** The top-level keys of `const m: PreviewModel = { … }`. */
function modelKeys(src: string): string[] {
  const start = src.indexOf('const m: PreviewModel = {');
  if (start < 0) throw new Error('no screens model');
  let i = src.indexOf('{', start) + 1;
  let depth = 1;
  let body = '';
  for (; i < src.length && depth > 0; i++) {
    const ch = src[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    body += depth === 1 ? ch : ' ';
  }
  const keys = [...body.matchAll(/(?:^|[,\n])\s*(?:\/\/[^\n]*\n\s*)*([A-Za-z_]\w*)\s*(?=[:,(]|\n|$)/g)].map((m) => m[1]);
  // …and the ones set on it afterwards (`m.quickAdd = …`).
  const later = [...src.matchAll(/^\s*m\.([A-Za-z_]\w*)\s*=[^=]/gm)].map((m) => m[1]);
  return [...new Set([...keys, ...later])].sort();
}

describe('the Windows and the browser kiosk hosts draw the shared screens alike', () => {
  const shared = [...new Set([...sharedImports(WINDOWS), ...sharedImports(WEB)])].filter((n) => /^[A-Z]/.test(n));

  it('render the same shared screens (but the listed platform ones)', () => {
    const drawn = (src: string) => shared.filter((n) => propsOf(src, n) !== null && !(n in ONLY_ONE)).sort();
    expect(drawn(WINDOWS)).toEqual(drawn(WEB));
  });

  for (const name of shared) {
    it(`<${name}>: the same props`, () => {
      const w = propsOf(WINDOWS, name);
      const c = propsOf(WEB, name);
      if (w === null || c === null || name in ONLY_ONE) return;
      expect([...w].sort(), name).toEqual([...c].sort());
    });
  }

  it('the screens’ model: the same keys', () => {
    expect(modelKeys(WINDOWS)).toEqual(modelKeys(WEB));
  });

  it('the tip, the basket’s offers and the meal upsell through the one shared code', () => {
    for (const [host, src] of [
      ['windows', WINDOWS],
      ['web', WEB],
    ] as const) {
      expect(src, host).toMatch(/import \{ mealUpsellIds \} from '(?:@kiosk-shared|@\/kiosk-shared)\/basket-upsell';/);
      // "הגדלת מכירה" as the Android kiosk asks it: the shared window, never a strip on the basket.
      expect(src, host).toMatch(/useKioskUpsell\(cfg, view\.catalog\.upsellRules, allProducts, resting, /);
      expect(src, host).toMatch(/<CartScreen m=\{m\} upsell=\{NO_BASKET_OFFERS\} \/>/);
      expect(src, host).toMatch(/if \(!taken && upsellWin\.afterAdd\(/);
      expect(src, host).toMatch(/if \(upsellWin\.atStep\('to_pay', cartIdsRef\.current\)\) return;/);
      expect(src, host).toMatch(/upsellWin\.atStep\('to_cart', cartIdsRef\.current\);/);
      expect(src, host).toMatch(/if \(!upsellWin\.window\.required\) finishUpsell\(\);/);
      expect(src, host).toMatch(/mealUpsellIds\(view\.catalog\.upsellRules, productId, view\.catalog\.meals,/);
      // Every tip the host charges or shows: the shared rule with the config's switches.
      const tips = [...src.matchAll(/tipOfDetails\(([^)]*)\)/g)].map((m) => m[1]);
      expect(tips.length, host).toBeGreaterThan(0);
      for (const args of tips) expect(args, host).toMatch(/, cfg\.payment$/);
    }
  });
});
