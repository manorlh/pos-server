'use client';

/**
 * "הנפשות" — the Motion Engine's management screen (spec §9–§12, lib/kioskMotionEngine.ts), for the kiosk
 * and for the till ("עיצוב קופה" → "הנפשות", P:/specs/till-motion.md): one screen, its host (motion-host.tsx)
 * says which.
 *   - the header: the pace in brief, "אפס הכל לברירת מחדל" — and on the kiosk "שדר לקיוסקים" (this level's
 *     review-and-save flow; the kiosks under the level take it on their next sync), on the till "ללא
 *     הנפשות" (one button: every event off) and the save of the design;
 *   - "קצב כללי": the preset as cards (the kiosk's Runner Standard / Slow / Fast / Custom / Classic; the
 *     till's "כמו היום" first — today's screens, its default), the global speed (slow 1.30 · normal 1 · fast
 *     0.75 · custom 0.50–2.00; on the kiosk written with the older `speed` too, so an older kiosk app keeps
 *     the pace), the durations' arithmetic (resolveDuration), and the kiosk's "אפקטים";
 *   - "אירועים" (motion-events.tsx): every event's own motion, with "הצג", "לפני / אחרי", "העתק".
 * Everything inherits level by level, like every other setting of the host.
 */

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Activity, Ban, Check, Gauge, History, Info, RadioTower, RotateCcw, SlidersHorizontal, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MOTION_EFFECTS, MOTION_ITEM_FLOWS } from '@/lib/kioskConfig';
import {
  MOTION_GLOBAL_SPEEDS,
  MOTION_MULTIPLIER_MAX,
  MOTION_MULTIPLIER_MIN,
  MOTION_SPEED_FACTORS,
  NONE_MOTION_PRESET,
  motionPresetOf,
  motionPresetsOf,
  type MotionGlobalSpeed,
  type MotionPreset,
} from '@/lib/kioskMotionEngine';
import {
  globalSpeedEdits,
  globalSpeedResetEdits,
  globalSpeedView,
  motionDurationView,
  motionEventCounts,
  noMotionEdits,
  presetExample,
  presetExampleEventsOf,
} from '@/lib/kioskMotionEditor';
import { useKioskField } from './editor-context';
import { FieldShell, Segmented } from './fields';
import { MotionEventsCard, SourceMark } from './motion-events';
import { KioskMotionHost, MotionCard, MotionErrors, sameSetting, useMotionHost } from './motion-host';
import { MOTION_EVENT_ICONS, formatMultiplier, useMotionText } from './motion-labels';

/* ---------------------------------------------------------------- shared */

function InheritedText() {
  const host = useMotionHost();
  return (
    <span className="text-[11px] text-muted-foreground" title={host.labels.inheritFrom}>
      {host.labels.inherited}
    </span>
  );
}

/* ---------------------------------------------------------------- header */

function StatChip({ icon: Icon, children }: { icon: typeof Gauge; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-background/80 px-2.5 py-1 text-xs font-medium shadow-xs backdrop-blur">
      <Icon className="h-3.5 w-3.5 text-primary" />
      {children}
    </span>
  );
}

/** "ללא הנפשות" (the till): one button — every event off at this level, whatever a level above set; again: back. */
function NoMotionButton() {
  const host = useMotionHost();
  const tx = useMotionText(host.surface);
  const on = motionPresetOf(host.draft, host.surface) === NONE_MOTION_PRESET;
  const inheritedNone = motionPresetOf(host.inherited, host.surface) === NONE_MOTION_PRESET;
  return (
    <Button
      type="button"
      variant={on ? 'destructive' : 'outline'}
      aria-pressed={on}
      disabled={!host.canEdit}
      title={tx.t('noMotionHint')}
      onClick={() => {
        if (!on) host.apply(noMotionEdits(true));
        // Back to what this level inherits — or, when the level above has none either, to today's.
        else host.apply(inheritedNone ? [{ path: 'motion.preset', value: 'legacy' }] : noMotionEdits(false));
      }}
    >
      <Ban /> {on ? tx.t('noMotionOn') : tx.t('noMotion')}
    </Button>
  );
}

function MotionHeader() {
  const host = useMotionHost();
  const tx = useMotionText(host.surface);
  const motion = host.draft;
  const preset = motionPresetOf(motion, host.surface);
  const speed = globalSpeedView(motion);
  const counts = motionEventCounts(motion, host.surface);
  const touched = !sameSetting(host.draft, host.inherited);
  const kiosk = host.surface === 'kiosk';
  const blocked = !host.canEdit
    ? tx.t('broadcastReadOnly')
    : host.hasErrors
      ? tx.t('broadcastErrors')
      : !host.dirty
        ? tx.t('broadcastNothing')
        : null;
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-primary/10 via-background to-background p-4 sm:p-5">
      <div
        className="pointer-events-none absolute inset-0 opacity-60 [mask-image:linear-gradient(to_bottom,black,transparent)]"
        style={{
          backgroundImage:
            'linear-gradient(to right, color-mix(in oklab, var(--border) 70%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklab, var(--border) 70%, transparent) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
        aria-hidden
      />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2.5">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Activity className="h-5 w-5" />
            </span>
            <div className="leading-tight">
              <h2 className="text-base font-semibold">{tx.t('title')}</h2>
              <span dir="ltr" className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                {tx.t('engine')}
              </span>
            </div>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">{tx.t('hint')}</p>
          <div className="flex flex-wrap gap-1.5">
            <StatChip icon={Gauge}>
              <span dir={preset === 'legacy' && !kiosk ? undefined : 'ltr'}>{tx.presetName(preset)}</span>
            </StatChip>
            <StatChip icon={Zap}>
              {tx.globalSpeed(speed.speed)}{' '}
              <span dir="ltr" className="font-mono">
                ×{formatMultiplier(speed.multiplier)}
              </span>
            </StatChip>
            <StatChip icon={SlidersHorizontal}>{tx.t('statsCustom', { n: counts.custom })}</StatChip>
            {counts.off > 0 ? <StatChip icon={MOTION_EVENT_ICONS.soldOut}>{tx.t('statsOff', { n: counts.off })}</StatChip> : null}
          </div>
        </div>
        <div className="flex w-full flex-col items-stretch gap-1.5 sm:w-auto sm:items-end">
          {kiosk && host.openReview ? (
            <>
              <Button type="button" className="shadow-sm" disabled={blocked !== null} title={blocked ?? undefined} onClick={host.openReview}>
                <RadioTower /> {tx.t('broadcast')}
              </Button>
              {blocked && host.canEdit ? <span className="text-[11px] text-muted-foreground">{blocked}</span> : null}
            </>
          ) : (
            <NoMotionButton />
          )}
          {touched && host.canEdit ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                if (window.confirm(tx.t('resetAllConfirm'))) host.apply([{ path: 'motion', reset: true }]);
              }}
            >
              <RotateCcw /> {tx.t('resetAll')}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="relative mt-4 flex items-start gap-2 rounded-xl border bg-background/70 p-2.5 text-xs text-muted-foreground backdrop-blur">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <span>
          <span className="font-medium text-foreground">{tx.t(`broadcastHint.${host.level}`)}</span> {tx.t('broadcastNote')}
        </span>
      </div>
      {preset === NONE_MOTION_PRESET ? (
        <p className="relative mt-2 flex items-start gap-2 rounded-xl border border-amber-300/60 bg-amber-50 p-2.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {tx.t('noMotionNote')}
        </p>
      ) : null}
      {host.reduceMotion.draft ? (
        <p className="relative mt-2 flex items-start gap-2 rounded-xl border border-amber-300/60 bg-amber-50 p-2.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {tx.t('reduceMotionOn')}
        </p>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------- the pace */

function PresetCards() {
  const host = useMotionHost();
  const tx = useMotionText(host.surface);
  const current = motionPresetOf(host.draft, host.surface);
  const overridden = !sameSetting(host.draft.preset, host.inherited.preset);
  const examples = presetExampleEventsOf(host.surface);
  // "ללא הנפשות" is the header's one button, not a card.
  const presets = motionPresetsOf(host.surface).filter((p) => p !== NONE_MOTION_PRESET);
  const set = (p: MotionPreset) => host.apply([{ path: 'motion.preset', value: p }]);
  return (
    <div className="space-y-2">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{tx.t('presetLabel')}</span>
          <SourceMark source={overridden ? 'here' : 'preset'} onReset={() => host.apply([{ path: 'motion.preset', reset: true }])} />
          {!overridden ? <InheritedText /> : null}
        </div>
        <p className="text-xs text-muted-foreground">{tx.t('presetHint')}</p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-3">
        {presets.map((p) => {
          const active = current === p;
          const ex = presetExample(p, host.surface);
          const today = p === 'legacy';
          return (
            <button
              key={p}
              type="button"
              disabled={!host.canEdit}
              aria-pressed={active}
              onClick={() => set(p)}
              className={cn(
                'flex flex-col gap-2.5 rounded-2xl border bg-background p-3 text-start transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60',
                active ? 'border-primary bg-primary/5 shadow-sm ring-1 ring-primary' : 'hover:border-foreground/20 hover:bg-muted/40',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span dir={today && host.surface === 'till' ? undefined : 'ltr'} className="text-sm font-semibold">
                  {tx.presetName(p)}
                </span>
                {active ? (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="h-3 w-3" />
                  </span>
                ) : null}
              </span>
              <span className="text-xs leading-snug text-muted-foreground">{tx.presetDesc(p)}</span>
              <span className="grid grid-cols-4 gap-1.5">
                {examples.map((e) => {
                  const ms = ex[e] ?? 0;
                  return (
                    <span key={e} className="min-w-0 space-y-1">
                      <span className="block h-1 overflow-hidden rounded-full bg-muted">
                        <span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.min(100, Math.round(ms / 13))}%` }} />
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">{tx.t(`example.${e}`)}</span>
                      <span dir="ltr" className="block text-end font-mono text-[11px] font-semibold tabular-nums">
                        {ms > 0 ? (
                          <>
                            {ms}
                            <span className="font-normal text-muted-foreground">ms</span>
                          </>
                        ) : (
                          <span className="font-normal text-muted-foreground">—</span>
                        )}
                      </span>
                    </span>
                  );
                })}
              </span>
              {today ? (
                <span className="inline-flex w-fit items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
                  <History className="h-3 w-3" /> {tx.t('legacyNote')}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <MotionErrors path="motion.preset" />
    </div>
  );
}

function GlobalSpeedField() {
  const host = useMotionHost();
  const tx = useMotionText(host.surface);
  const motion = host.draft;
  const inherited = host.inherited;
  const view = globalSpeedView(motion);
  const keys = host.surface === 'kiosk' ? (['globalSpeed', 'speedMultiplier', 'speed'] as const) : (['globalSpeed', 'speedMultiplier'] as const);
  const overridden = keys.some((k) => !sameSetting(motion[k], inherited[k]));
  const label = tx.t('globalSpeedLabel');
  return (
    <div className="space-y-2">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          <SourceMark source={overridden ? 'here' : 'preset'} onReset={() => host.apply(globalSpeedResetEdits(host.surface))} />
          {!overridden ? <InheritedText /> : null}
        </div>
        <p className="text-xs text-muted-foreground">{tx.t('globalSpeedHint')}</p>
      </div>
      <Segmented<MotionGlobalSpeed>
        value={view.speed}
        disabled={!host.canEdit}
        ariaLabel={label}
        onChange={(s) => host.apply(globalSpeedEdits(s, s === 'custom' ? view.multiplier : undefined, host.surface))}
        options={MOTION_GLOBAL_SPEEDS.map((s) => ({
          value: s,
          label: (
            <span className="inline-flex items-center gap-1.5">
              {tx.globalSpeed(s)}
              {s !== 'custom' ? (
                <span dir="ltr" className="font-mono text-[11px] opacity-60">
                  ×{formatMultiplier(MOTION_SPEED_FACTORS[s])}
                </span>
              ) : null}
            </span>
          ),
        }))}
      />
      {view.speed === 'custom' ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/30 px-3 py-2">
          <span className="text-xs font-medium">{tx.t('multiplier')}</span>
          <input
            type="range"
            className="h-2 min-w-40 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            min={MOTION_MULTIPLIER_MIN}
            max={MOTION_MULTIPLIER_MAX}
            step={0.05}
            value={view.multiplier}
            disabled={!host.canEdit}
            aria-label={tx.t('multiplier')}
            onChange={(e) => host.apply(globalSpeedEdits('custom', Number(e.target.value), host.surface))}
          />
          <Badge variant="outline" dir="ltr" className="font-mono tabular-nums">
            ×{formatMultiplier(view.multiplier)}
          </Badge>
        </div>
      ) : null}
      {view.fromOlder && host.surface === 'kiosk' ? <p className="text-[11px] text-muted-foreground">{tx.t('speedFromOlder', { k: formatMultiplier(view.multiplier) })}</p> : null}
      <MotionErrors path="motion.globalSpeed" />
      <MotionErrors path="motion.speedMultiplier" />
    </div>
  );
}

/** resolveDuration in the open: each example event's base × the speed = what it plays. */
function DurationMath() {
  const host = useMotionHost();
  const tx = useMotionText(host.surface);
  const motion = host.draft;
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 bg-muted/50 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
        <span>{tx.t('durationTitle')}</span>
        <span dir="ltr" className="font-mono">
          resolveDuration
        </span>
      </div>
      <ul className="divide-y">
        {presetExampleEventsOf(host.surface).map((e) => {
          const d = motionDurationView(motion, e, 'full', host.surface);
          const Icon = MOTION_EVENT_ICONS[e];
          return (
            <li key={e} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5 text-xs">
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {tx.eventName(e)}
              </span>
              <span dir="ltr" className={cn('font-mono text-[11px] tabular-nums', d.explicit && 'text-sky-700 dark:text-sky-300')}>
                {d.explicit
                  ? tx.t('formulaFixed', { ms: d.ms })
                  : tx.t('formula', { base: d.baseMs, k: formatMultiplier(d.multiplier), ms: d.ms })}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "אפקטים" (the kiosk): אוטומטי (by the device's strength) · מלא · קל — how much is drawn, not a motion. */
function EffectsPicker() {
  const t = useTranslations('kiosks.motion');
  const tf = useTranslations('kiosks.fields');
  const path = 'motion.effects';
  const f = useKioskField<string>(path);
  const label = tf(path);
  return (
    <FieldShell path={path} label={label} hint={t('effectsHint')}>
      <Segmented<string>
        value={f.value}
        options={MOTION_EFFECTS.map((v) => ({ value: v, label: t(`effectsOption.${v}`) }))}
        onChange={f.set}
        disabled={f.disabled}
        ariaLabel={label}
      />
    </FieldShell>
  );
}

/**
 * "תהליך פריט עם תוספות והערות" (`motion.itemFlow`, the kiosk): חלון אחד (today's) · דף אחר דף — a page per
 * add-on group the dish has, then its notes, sliding by "מעבר בין מסכים" with the tiles entering by "כניסת הפריטים".
 */
function ItemFlowPicker() {
  const t = useTranslations('kiosks.motion');
  const tf = useTranslations('kiosks.fields');
  const path = 'motion.itemFlow';
  const f = useKioskField<string | undefined>(path);
  const label = tf(path);
  return (
    <FieldShell path={path} label={label} hint={t('itemFlowHint')}>
      <Segmented<string>
        value={f.value ?? 'sheet'}
        options={MOTION_ITEM_FLOWS.map((v) => ({ value: v, label: t(`itemFlowOption.${v}`) }))}
        onChange={f.set}
        disabled={f.disabled}
        ariaLabel={label}
      />
    </FieldShell>
  );
}

function MotionGlobalCard() {
  const host = useMotionHost();
  const tx = useMotionText(host.surface);
  return (
    <MotionCard title={tx.t('globalTitle')} description={tx.t('globalHint')}>
      <PresetCards />
      <div className="grid gap-5 xl:grid-cols-2">
        <GlobalSpeedField />
        <DurationMath />
      </div>
      {host.surface === 'kiosk' ? (
        <>
          <EffectsPicker />
          <ItemFlowPicker />
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">{tx.t('perfNote')}</p>
    </MotionCard>
  );
}

/** The screen itself, inside a motion host (the kiosk's or the till design's). */
export function MotionScreen() {
  return (
    <div className="space-y-4">
      <MotionHeader />
      <MotionGlobalCard />
      <MotionEventsCard />
    </div>
  );
}

/** The kiosk settings editor's "הנפשות". */
export function MotionSection() {
  return (
    <KioskMotionHost>
      <MotionScreen />
    </KioskMotionHost>
  );
}
