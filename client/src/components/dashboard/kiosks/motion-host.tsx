'use client';

/**
 * "הנפשות" — where the Motion Engine's screen (section-motion.tsx, motion-events.tsx) reads and writes:
 * the kiosk's settings editor, or the till design's ("עיצוב קופה" → "הנפשות", P:/specs/till-motion.md).
 * Both hold a `motion` section at one level (company → shop → … ) with what the level inherits; the screen
 * only needs the surface, the two `motion`s, the edits, the errors at a path and a few labels.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { kioskRenderProfile } from '@/lib/kioskConfig';
import type { MotionEngineSettings, MotionEventKey, MotionProfile, MotionSurface } from '@/lib/kioskMotionEngine';
import type { MotionEdit } from '@/lib/kioskMotionEditor';
import { sameSetting, useKioskEditor, useServerErrorText } from './editor-context';
import { LIVE_PREVIEW_DEMOS } from './motion-labels';

export interface MotionHost {
  surface: MotionSurface;
  /** This level's `motion` as edited ({} when it has none). */
  draft: MotionEngineSettings;
  /** What this level inherits ({} when nothing above sets it). */
  inherited: MotionEngineSettings;
  canEdit: boolean;
  /** Applies the helpers' edits (lib/kioskMotionEditor.ts): a value, or back to what this level inherits. */
  apply: (edits: readonly MotionEdit[]) => void;
  /** The errors at `path` or under it, as text. */
  errorsAt: (path: string) => string[];
  /** Any error in the whole draft (the save is blocked). */
  hasErrors: boolean;
  /** The draft differs from what this level has saved. */
  dirty: boolean;
  /** The kiosk's "שדר לקיוסקים" (its review-and-save flow); the till saves with its design's bar. */
  openReview?: () => void;
  /** Reduced motion and the render profile as the draft / what it inherits play them (the kiosk's `general`, `effects`). */
  reduceMotion: { draft: boolean; inherited: boolean };
  profile: { draft: MotionProfile; inherited: MotionProfile };
  /** "בתצוגה המקדימה": play the event in the big live preview, when the host has one for it. */
  playLive?: (event: MotionEventKey) => void;
  canPlayLive: (event: MotionEventKey) => boolean;
  /** The level's words: "עובר בירושה", "מ<רמה>", "נקבע כאן". */
  labels: { inherited: string; inheritFrom: string; overridden: string };
  /** The kiosk's level, for its broadcast hint ("company" | "shop" | "kiosk"); the till's level otherwise. */
  level: string;
}

export const MotionHostContext = createContext<MotionHost | null>(null);

export function useMotionHost(): MotionHost {
  const ctx = useContext(MotionHostContext);
  if (!ctx) throw new Error('useMotionHost must be used inside a motion host (the kiosk or the till design editor)');
  return ctx;
}

/** Equal for the "set here?" mark: null = undefined, as the editors compare. */
export { sameSetting };

/** The kiosk settings editor as the motion screen's host. */
export function KioskMotionHost({ children }: { children: ReactNode }) {
  const ed = useKioskEditor();
  const ts = useTranslations('kiosks.settings');
  const tv = useTranslations('kiosks.validation');
  const serverText = useServerErrorText();
  const value = useMemo<MotionHost>(() => {
    const hit = (path: string) => (p: string) => p === path || p.startsWith(`${path}.`);
    return {
      surface: 'kiosk',
      draft: (ed.draft.motion ?? {}) as MotionEngineSettings,
      inherited: (ed.inherited.motion ?? {}) as MotionEngineSettings,
      canEdit: ed.canEdit,
      apply: (edits) => {
        for (const e of edits) {
          if (e.reset) ed.reset(e.path);
          else ed.set(e.path, e.value);
        }
      },
      errorsAt: (path) => {
        const out: string[] = [];
        for (const e of ed.errors) if (hit(path)(e.path)) out.push(tv.has(e.code) ? tv(e.code, e.params ?? {}) : e.code);
        for (const e of ed.serverErrors) if (hit(path)(e.path)) out.push(serverText(e));
        return Array.from(new Set(out));
      },
      hasErrors: ed.errors.length > 0,
      dirty: ed.dirty,
      openReview: ed.openReview,
      reduceMotion: { draft: !!ed.draft.general?.reduceMotion, inherited: !!ed.inherited.general?.reduceMotion },
      profile: { draft: kioskRenderProfile(ed.draft.motion?.effects), inherited: kioskRenderProfile(ed.inherited.motion?.effects) },
      playLive: (event) => {
        const demo = LIVE_PREVIEW_DEMOS[event];
        if (demo) ed.playMotion(demo);
      },
      canPlayLive: (event) => !!LIVE_PREVIEW_DEMOS[event],
      labels: { inherited: ts('inherited'), inheritFrom: ts(`inheritFrom.${ed.level}`), overridden: ts(`overridden.${ed.level}`) },
      level: ed.level,
    };
  }, [ed, ts, tv, serverText]);
  return <MotionHostContext.Provider value={value}>{children}</MotionHostContext.Provider>;
}

/** A card of the motion screen (the host's own card styles aside: it reads no editor). */
export function MotionCard({ title, description, action, children }: { title: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <CardTitle className="text-base">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {action ? <div className="flex items-center gap-2">{action}</div> : null}
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  );
}

/** The errors at `path` (or under it). */
export function MotionErrors({ path }: { path: string }) {
  const host = useMotionHost();
  const errors = host.errorsAt(path);
  if (errors.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {errors.map((e) => (
        <li key={e} className="text-xs text-destructive">
          {e}
        </li>
      ))}
    </ul>
  );
}
