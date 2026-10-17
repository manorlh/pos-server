/**
 * The till's colours, as the Android till paints them (P:/specs/till-visual-parity): the engine's `theme` (the brand —
 * the design's accent over `brandPrimaryColor` —, the mode, "צבע גופן") through the shared look (client lib posLook.ts:
 * Theme.kt's schemes, mixed in Oklab like Compose), set as CSS variables on the till's root. Every till stylesheet —
 * till.css, theme/look.css and each screen's own css/*.css — paints with these variables only, so a screen added later
 * is in the Android colours by itself, light and dark.
 *
 * The old `--t-*` names stay (every screen uses them) and now carry the Android roles; `--pos-*` are the Material roles
 * by name for new rules, `--pos-d-*` the designed templates' neutrals (TillDesignLocal.kt DesignColors).
 */

import { useEffect, useState } from 'react';
import { designColors, nightColors, over, posScheme, schemeVars, type PosScheme } from '@dash-lib/posLook';
import type { TillThemeState } from '../../../../shared/till/protocol';

/** The `--t-*` tokens from a scheme: what till.css has always painted with, in the Android roles. */
export function tillTokens(s: PosScheme): Record<string, string> {
  // Success text darker than the cash button's green, so it reads on its soft fill (4.5:1).
  const ok = s.dark ? '#30D158' : '#157A35';
  const warn = s.dark ? '#FBBF24' : '#B45309';
  return {
    '--t-bg': s.background,
    '--t-surface': s.surface,
    '--t-text': s.onSurface,
    '--t-muted': s.onSurfaceVariant,
    '--t-line': s.outlineVariant,
    '--t-accent': s.primary,
    '--t-accent-text': s.onPrimary,
    // Selected rows and chips (Theme.kt secondaryContainer), the iPhone's faint brand wash.
    '--t-accent-soft': s.secondaryContainer,
    '--t-ok': ok,
    '--t-ok-soft': over(ok, s.dark ? 0.2 : 0.12, s.surface),
    '--t-warn': warn,
    '--t-warn-soft': s.dark ? '#3A2A0A' : '#FEF3C7',
    '--t-danger': s.error,
    '--t-danger-soft': s.errorContainer,
    '--t-off': s.dark ? '#636366' : '#AEAEB2',
    // A step under the grouped grey, light enough for the secondary label on it (4.5:1).
    '--t-off-soft': s.dark ? s.surfaceContainerHigh : '#EFEFF4',
  };
}

/** Every variable the till's root carries for this theme (and `colorScheme`, for the form controls). `night`: the "לילה" template's own palette over the scheme. */
export function tillThemeVars(theme: TillThemeState | undefined, systemDark: boolean, night = false): Record<string, string> {
  const dark = night || (theme?.mode === 'dark' ? true : theme?.mode === 'light' ? false : systemDark);
  const s = posScheme({ brand: theme?.brand ?? null, dark, text: theme?.textColor ?? null });
  const vars: Record<string, string> = { ...schemeVars(s), ...tillTokens(s), colorScheme: dark ? 'dark' : 'light' };
  if (night) {
    const n = nightColors(theme?.brand ?? s.primary);
    Object.assign(vars, {
      '--t-bg': n.page,
      '--t-surface': n.surface,
      '--t-line': n.border,
      '--t-text': n.text,
      '--t-muted': n.secondary,
      '--t-accent': n.accent,
      '--t-accent-text': n.onAccent,
      '--t-accent-soft': n.accentTint,
      '--pos-d-page': n.page,
      '--pos-d-surface': n.surface,
      '--pos-d-border': n.border,
      '--pos-d-text': n.text,
      '--pos-d-secondary': n.secondary,
      '--pos-d-accent-tint': n.accentTint,
      '--pos-primary': n.accent,
      '--pos-on-primary': n.onAccent,
    });
  } else {
    const d = designColors(s);
    vars['--pos-d-accent'] = d.accent;
  }
  // The sign-in's wash: the brand at 8% (LoginScreen.kt), as rgba — Chromium 108 has no color-mix().
  vars['--pos-primary-wash'] = rgba(vars['--pos-primary'] ?? s.primary, 0.08);
  return vars;
}

/** `#RRGGBB` at `alpha` as rgba(). */
export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', '').slice(-6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The device's dark setting, followed live (Android: isSystemInDarkTheme). Chromium 108: matchMedia's change event. */
export function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => darkQuery()?.matches === true);
  useEffect(() => {
    const query = darkQuery();
    if (!query) return;
    const on = () => setDark(query.matches);
    query.addEventListener('change', on);
    return () => query.removeEventListener('change', on);
  }, []);
  return dark;
}

function darkQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
}
