'use client';

/**
 * The kiosk settings editor's shared state: the draft (the effective config being
 * edited at one level), what that level inherits, and the setters every field uses.
 * A field reads its value, its inherited value and whether this level overrides it
 * through `useKioskField(path)`.
 */

import { createContext, useContext } from 'react';
import { useTranslations } from 'next-intl';
import {
  getPath,
  jsonEqual,
  type KioskConfig,
  type KioskFont,
  type KioskValidationError,
  type UiStyle,
} from '@/lib/kioskConfig';
import type { KioskLevel, KioskServerError, KioskSourceCatalog } from '@/lib/kioskApi';
import type { LayoutTemplate } from '@/lib/kioskLayout';
import { LANDSCAPE_GENERAL_KEYS, LANDSCAPE_OVERRIDE_KEYS, type LandscapeSection } from '@/lib/kioskLandscape';
import type { MotionDemo } from './kiosk-preview';

import type { PreviewScreen } from '@/kiosk-shared/types';

// Shared with the Windows kiosk (kiosk-desktop), which renders the same screens.
export type { PreviewScreen };

export interface KioskEditorValue {
  level: KioskLevel;
  draft: KioskConfig;
  /**
   * What this level inherits, rebased onto the draft's "סגנון ממשק" (`rebaseInherited`): the
   * fields compare, prune and reset against it.
   */
  inherited: KioskConfig;
  canEdit: boolean;
  /** May upload media (`POST /kiosks/media`): any role that may save this level. */
  canUpload: boolean;
  fonts: KioskFont[];
  kdsAvailable: boolean;
  /** The shop whose printers the printing section offers; null at company level. */
  shopId: string | null;
  catalog: KioskSourceCatalog | null;
  catalogLoading: boolean;
  /** The till's own category images, by id (the kiosk's own override them). */
  categoryImageUrls: Record<string, string>;
  errors: KioskValidationError[];
  serverErrors: KioskServerError[];
  set: (path: string, value: unknown) => void;
  reset: (path: string) => void;
  /** Pick a "סגנון ממשק": values that follow the old style move to the new one's. */
  setUiStyle: (style: UiStyle) => void;
  /** Pick a "מבנה" (layout.template): values that follow the old template move to the new one's. */
  setLayoutTemplate: (template: LayoutTemplate) => void;
  /** The live preview's language (the texts editor's tab). */
  previewLang: string;
  setPreviewLang: (lang: string) => void;
  /** The text the live preview marks (the texts editor's focused field), or null. */
  setHighlightText: (key: string | null) => void;
  showScreen: (screen: PreviewScreen) => void;
  /** "הצג" of "הנפשות ומעברים": play that transition in the live preview. */
  playMotion: (demo: MotionDemo) => void;
  /** The draft differs from what this level has saved. */
  dirty: boolean;
  /** "שדר לקיוסקים": open this level's review-and-save flow (as the save bar's button). */
  openReview: () => void;
  /**
   * "לאורך / לרוחב" (P:/specs/kiosk-landscape-design.md §5): in landscape, the fields that have a landscape
   * counterpart edit `landscape.<path>` (useKioskField); the rest are shared by both orientations.
   */
  orientation?: KioskEditorOrientation;
  setOrientation?: (o: KioskEditorOrientation) => void;
}

export type KioskEditorOrientation = 'portrait' | 'landscape';

/** The landscape block's path for a design path (`theme.cartStyle` → `landscape.theme.cartStyle`), or null. */
export function landscapePathOf(path: string): string | null {
  const [section, key, ...rest] = path.split('.');
  // "גודל כרטיסי לקחת / לשבת" (lib/kioskServiceSize.ts): the service cards' size has a landscape value too.
  if (rest.length === 0 && section === 'general' && key && (LANDSCAPE_GENERAL_KEYS as readonly string[]).includes(key)) return `landscape.${path}`;
  if (rest.length > 0 || !key || !(section in LANDSCAPE_OVERRIDE_KEYS)) return null;
  return (LANDSCAPE_OVERRIDE_KEYS[section as LandscapeSection] as readonly string[]).includes(key) ? `landscape.${path}` : null;
}

export const KioskEditorContext = createContext<KioskEditorValue | null>(null);

export function useKioskEditor(): KioskEditorValue {
  const ctx = useContext(KioskEditorContext);
  if (!ctx) throw new Error('useKioskEditor must be used inside the kiosk settings editor');
  return ctx;
}

/** Equal for the "overridden?" badge: an empty text over no text is no override. */
export function sameSetting(value: unknown, inherited: unknown): boolean {
  const norm = (v: unknown) => (v === undefined ? null : v);
  if ((value === '' && norm(inherited) === null) || (inherited === '' && norm(value) === null)) return true;
  return jsonEqual(norm(value), norm(inherited));
}

/** A refused save's error as Hebrew: its code in words, else the server's own message. */
export function useServerErrorText(): (e: KioskServerError) => string {
  const t = useTranslations('kiosks.validation.server');
  return (e) => (e.code && t.has(e.code) ? t(e.code) : e.message || e.code || e.path);
}

/** The errors (client rules, then the server's) at `path` or under it, as text. */
export function useFieldErrors(path: string): string[] {
  const t = useTranslations('kiosks.validation');
  const serverText = useServerErrorText();
  const { errors, serverErrors, orientation } = useKioskEditor();
  // In landscape a design field's errors are its landscape value's.
  const at = (orientation === 'landscape' && landscapePathOf(path)) || path;
  const hit = (p: string) => p === at || p.startsWith(`${at}.`);
  const out: string[] = [];
  for (const e of errors) {
    if (hit(e.path)) out.push(t.has(e.code) ? t(e.code, e.params ?? {}) : e.code);
  }
  for (const e of serverErrors) {
    if (hit(e.path)) out.push(serverText(e));
  }
  return Array.from(new Set(out));
}

/**
 * A field at `path` as the editor's orientation shows it. In landscape, a design key with a landscape counterpart
 * reads `landscape.<path>` — unset ("כמו לאורך"): the portrait value — and writes there; `reset` takes the
 * landscape value back to what this level inherits (a higher level's, or none: like portrait).
 */
export function useKioskField<T>(path: string) {
  const ed = useKioskEditor();
  const lp = ed.orientation === 'landscape' ? landscapePathOf(path) : null;
  if (lp) {
    const own = getPath(ed.draft, lp) as T | undefined;
    const inheritedOwn = getPath(ed.inherited, lp) as T | undefined;
    const portrait = getPath(ed.draft, path) as T;
    return {
      value: (own ?? portrait) as T,
      inheritedValue: (inheritedOwn ?? getPath(ed.inherited, path)) as T,
      overridden: !sameSetting(own, inheritedOwn),
      set: (next: T) => ed.set(lp, next),
      reset: () => ed.reset(lp),
      disabled: !ed.canEdit,
      landscape: { path: lp, set: own !== undefined && own !== null, inherited: inheritedOwn !== undefined && inheritedOwn !== null },
    };
  }
  const value = getPath(ed.draft, path) as T;
  const inheritedValue = getPath(ed.inherited, path) as T;
  return {
    value,
    inheritedValue,
    overridden: !sameSetting(value, inheritedValue),
    set: (next: T) => ed.set(path, next),
    reset: () => ed.reset(path),
    disabled: !ed.canEdit,
    landscape: null as { path: string; set: boolean; inherited: boolean } | null,
  };
}
