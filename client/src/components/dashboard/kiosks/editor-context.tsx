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
  showScreen: (screen: PreviewScreen) => void;
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
  const { errors, serverErrors } = useKioskEditor();
  const hit = (p: string) => p === path || p.startsWith(`${path}.`);
  const out: string[] = [];
  for (const e of errors) {
    if (hit(e.path)) out.push(t.has(e.code) ? t(e.code, e.params ?? {}) : e.code);
  }
  for (const e of serverErrors) {
    if (hit(e.path)) out.push(serverText(e));
  }
  return Array.from(new Set(out));
}

export function useKioskField<T>(path: string) {
  const ed = useKioskEditor();
  const value = getPath(ed.draft, path) as T;
  const inheritedValue = getPath(ed.inherited, path) as T;
  return {
    value,
    inheritedValue,
    overridden: !sameSetting(value, inheritedValue),
    set: (next: T) => ed.set(path, next),
    reset: () => ed.reset(path),
    disabled: !ed.canEdit,
  };
}
