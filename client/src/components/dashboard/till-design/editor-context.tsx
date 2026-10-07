'use client';

/**
 * The till design editor's shared state: the draft (the effective config being edited at one
 * level), what that level inherits, the till parameters' "auto" values, the catalog of a till in
 * scope, the chosen device profile and preview mode, and the setters every field uses. A field
 * reads its value, its inherited value and whether this level sets it through `useTillField`.
 */

import { createContext, useContext } from 'react';
import { useTranslations } from 'next-intl';
import {
  getPath,
  jsonEqual,
  type Mode,
  type Profile,
  type TillDesignConfig,
  type TillDesignIssue,
  type TillDesignLegacy,
} from '@/lib/tillDesign';
import type { KioskSourceCatalog } from '@/lib/kioskApi';
import type { TillDesignLevel } from '@/lib/tillDesignApi';

export interface TillEditorValue {
  level: TillDesignLevel;
  draft: TillDesignConfig;
  inherited: TillDesignConfig;
  canEdit: boolean;
  /** The "auto" values as the till parameters set them at this level (null: not loaded). */
  legacy: TillDesignLegacy | null;
  catalog: KioskSourceCatalog | null;
  catalogLoading: boolean;
  /** The device profile being edited and previewed. */
  profile: Profile;
  setProfile: (p: Profile) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  errors: TillDesignIssue[];
  serverErrors: TillDesignIssue[];
  set: (path: string, value: unknown) => void;
  reset: (path: string) => void;
}

export const TillEditorContext = createContext<TillEditorValue | null>(null);

export function useTillEditor(): TillEditorValue {
  const ctx = useContext(TillEditorContext);
  if (!ctx) throw new Error('useTillEditor must be used inside the till design editor');
  return ctx;
}

/** Equal for the "נקבע כאן" badge: an empty text over no text is no override; null = undefined. */
export function sameSetting(value: unknown, inherited: unknown): boolean {
  const norm = (v: unknown) => (v === undefined ? null : v);
  if ((value === '' && norm(inherited) === null) || (inherited === '' && norm(value) === null)) return true;
  return jsonEqual(norm(value), norm(inherited));
}

/** A validation error (the client's or the server's) as Hebrew: its code in words, else its message. */
export function useIssueText(): (e: TillDesignIssue) => string {
  const t = useTranslations('tillDesign.validation');
  return (e) => (e.code && t.has(e.code) ? t(e.code) : e.message || e.code || e.path);
}

/** The errors at `path` or under it, as text. */
export function useFieldErrors(path: string): string[] {
  const text = useIssueText();
  const { errors, serverErrors } = useTillEditor();
  const hit = (p: string) => p === path || p.startsWith(`${path}.`) || p.startsWith(`${path}[`);
  return Array.from(new Set([...errors, ...serverErrors].filter((e) => hit(e.path)).map(text)));
}

export function useTillField<T>(path: string) {
  const ed = useTillEditor();
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
