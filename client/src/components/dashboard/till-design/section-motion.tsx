'use client';

/**
 * "עיצוב קופה" → "הנפשות" (P:/specs/till-motion.md "תיקון 14.10"): the kiosk's Motion Engine screen
 * (components/dashboard/kiosks/section-motion.tsx, motion-events.tsx, motion-preview-stage.tsx) on the till —
 * its events in their groups, its presets ("כמו היום" — today's screens, the default — Runner Standard, Slow,
 * Fast, Custom, and "ללא הנפשות", one button), every event's parameters, per level, inherited and set here,
 * saved with the design ("בדיקה ושמירה"). Beside it, a tables map: a table opens into its order with the
 * chosen kind, and "לשולחנות" plays it back.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Armchair, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motionActive, resolveMotionEvent } from '@/lib/kioskMotionEngine';
import { planMotionPreview } from '@/lib/kioskMotionPreview';
import { MotionHostContext, type MotionHost } from '@/components/dashboard/kiosks/motion-host';
import { useMotionText } from '@/components/dashboard/kiosks/motion-labels';
import { MiniOrderScreen, MiniTablesMap, playPlan, rectWithin } from '@/components/dashboard/kiosks/motion-preview-stage';
import { MotionScreen } from '@/components/dashboard/kiosks/section-motion';
import { useIssueText, useTillEditor } from './editor-context';

/** The till design editor as the motion screen's host: `motion` of the draft, at this level. */
export function TillMotionHost({ children }: { children: ReactNode }) {
  const ed = useTillEditor();
  const ts = useTranslations('tillDesign.settings');
  const issueText = useIssueText();
  const value = useMemo<MotionHost>(() => {
    const hit = (path: string) => (p: string) => p === path || p.startsWith(`${path}.`);
    return {
      surface: 'till',
      draft: ed.draft.motion ?? {},
      inherited: ed.inherited.motion ?? {},
      canEdit: ed.canEdit,
      apply: (edits) => {
        for (const e of edits) {
          if (e.reset) ed.reset(e.path);
          else ed.set(e.path, e.value);
        }
      },
      errorsAt: (path) => Array.from(new Set([...ed.errors, ...ed.serverErrors].filter((e) => hit(path)(e.path)).map(issueText))),
      hasErrors: ed.errors.length > 0,
      dirty: false,
      // The device decides reduced motion and the light profile (a weak till); the screen shows the full play.
      reduceMotion: { draft: false, inherited: false },
      profile: { draft: 'full', inherited: 'full' },
      canPlayLive: () => false,
      labels: { inherited: ts('inherited'), inheritFrom: ts(`inheritFrom.${ed.level}`), overridden: ts('overridden') },
      level: ed.level,
    };
  }, [ed, ts, issueText]);
  return <MotionHostContext.Provider value={value}>{children}</MotionHostContext.Provider>;
}

/** "הנפשות" of the till design. */
export function TillMotionSection() {
  return (
    <TillMotionHost>
      <MotionScreen />
    </TillMotionHost>
  );
}

/** The viewer's own "reduce motion" (the OS / browser setting). */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

type Phase = 'map' | 'opening' | 'order' | 'closing';

/**
 * The tables demo: a small tables map; a table opens into its order with the draft's `tableOpen` (its kind,
 * time, curve, intensity and direction, at the global speed) and "לשולחנות" plays it backwards. A viewer who
 * asked their device to reduce motion sees the event's gentle fallback unless they ask for the full play.
 */
export function TillTablesDemo() {
  const ed = useTillEditor();
  const tx = useMotionText('till');
  const t = useTranslations('tillDesign.motion.live');
  const prefersReduced = usePrefersReducedMotion();
  const [full, setFull] = useState(false);
  const [phase, setPhase] = useState<Phase>('map');
  const [picked, setPicked] = useState(1);
  const rootRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const reduce = prefersReduced && !full;
  const spec = resolveMotionEvent(ed.draft.motion, 'tableOpen', { surface: 'till', reduceMotion: reduce });
  const active = motionActive(spec);

  useEffect(() => () => stopRef.current?.(), []);

  const play = (reverse: boolean, tileEl: HTMLElement | null) => {
    const root = rootRef.current;
    stopRef.current?.();
    stopRef.current = null;
    const done = reverse ? 'map' : 'order';
    if (!root || !active) {
      setPhase(done);
      return;
    }
    const tile = tileEl ? rectWithin(root, tileEl) : undefined;
    const plan = planMotionPreview(spec, 'tables', { flyDx: 0, flyDy: 0, tile }, { reverse });
    if (plan.tracks.length === 0) {
      setPhase(done);
      return;
    }
    setPhase(reverse ? 'closing' : 'opening');
    stopRef.current = playPlan(
      root,
      plan,
      {
        onSwap: () => {},
        onCount: () => {},
        onDone: () => {
          stopRef.current = null;
          setPhase(done);
        },
      },
      true,
    );
  };

  const tileOf = () => rootRef.current?.querySelector<HTMLElement>('[data-role="tile"]') ?? null;
  const orderShown = phase === 'order' || phase === 'closing';

  return (
    <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Armchair className="h-4 w-4 text-primary" /> {t('title')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>
      <div
        ref={rootRef}
        dir="rtl"
        className="relative h-72 select-none overflow-hidden rounded-xl border bg-background [perspective:1200px]"
        data-phase={phase}
      >
        <div data-role="map" className="absolute inset-0 bg-muted/40 [backface-visibility:hidden]">
          <MiniTablesMap
            t={tx.t}
            picked={picked}
            onPick={(i, el) => {
              if (phase !== 'map') return;
              setPicked(i);
              play(false, el);
            }}
          />
        </div>
        <div
          data-role="order"
          aria-hidden={!orderShown}
          className={cn('absolute inset-0 [backface-visibility:hidden]', orderShown ? 'opacity-100' : 'pointer-events-none opacity-0')}
        >
          <MiniOrderScreen
            t={tx.t}
            title={t('orderOf', { n: picked + 1 })}
            onBack={phase === 'order' ? () => play(true, tileOf()) : undefined}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        {active ? (
          <span dir="ltr" className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
            {t('playing', { kind: tx.kind(spec.animationType), ms: spec.durationMs })}
          </span>
        ) : (
          <span>{t('off')}</span>
        )}
        {phase === 'map' ? <span>{t('tap')}</span> : null}
      </div>
      {prefersReduced ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/60 bg-amber-50 p-2 text-[11px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{t('reduced')}</span>
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" className="size-3.5" checked={full} onChange={(e) => setFull(e.target.checked)} />
            {t('reducedToggle')}
          </label>
        </div>
      ) : null}
    </div>
  );
}
