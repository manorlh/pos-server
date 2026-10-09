'use client';

/**
 * "הנפשות" → "אירועים" (spec §9): every event of the kiosk in four groups, each with its switch,
 * its kind (only the kinds it may play), duration, delay, direction, intensity, curve and repeats,
 * and under "מתקדם" the scales, the distance, the gaps, the hold, the stagger, the auto-advance and
 * the reduced-motion fallback. Every control writes `motion.events.<event>.<param>` (the five older
 * transitions' kinds also their older key), shows the value as resolved, where it comes from (this
 * level, above, the preset) and a reset; "הצג" plays the event on a sample stage, "לפני / אחרי"
 * beside what this level inherits; "העתק הגדרה" copies its values to another event.
 */

import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  Columns2,
  Copy,
  MonitorPlay,
  Play,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { kioskRenderProfile } from '@/lib/kioskConfig';
import {
  MOTION_DIRECTIONS,
  MOTION_EASINGS,
  MOTION_EASING_CURVES,
  MOTION_EVENT_TYPES,
  MOTION_FALLBACKS,
  MOTION_PARAMS,
  globalMultiplier,
  motionParamRange,
  resolveMotionEvent,
  type MotionDirection,
  type MotionEasing,
  type MotionEngineSettings,
  type MotionEventKey,
  type MotionFallback,
  type MotionParam,
  type MotionType,
} from '@/lib/kioskMotionEngine';
import {
  MOTION_ADVANCED_PARAMS,
  MOTION_EVENT_GROUPS,
  eventLayer,
  motionCopyEdits,
  motionDurationView,
  motionEventResetEdits,
  motionEventSource,
  motionEventView,
  motionParamEdits,
  motionParamSource,
  type MotionEdit,
  type MotionValueSource,
} from '@/lib/kioskMotionEditor';
import { useFieldErrors, useKioskEditor } from './editor-context';
import { FieldErrors, OptionSelect, SectionCard, Segmented } from './fields';
import { LIVE_PREVIEW_DEMOS, MOTION_EVENT_ICONS, MOTION_GROUP_ICONS, formatMultiplier, useMotionText } from './motion-labels';
import { MotionStage, MotionStageCaption, type MotionStageHandle } from './motion-preview-stage';

/* --------------------------------------------------------------- shared */

/** Applies the helpers' edits to the draft: a value, or back to what this level inherits. */
export function useApplyMotionEdits() {
  const ed = useKioskEditor();
  return (edits: readonly MotionEdit[]) => {
    for (const e of edits) {
      if (e.reset) ed.reset(e.path);
      else ed.set(e.path, e.value);
    }
  };
}

/** Where a value comes from: "set here" with a reset, "inherited from above", or nothing (the preset's). */
export function SourceMark({ source, onReset, compact = false }: { source: MotionValueSource; onReset?: () => void; compact?: boolean }) {
  const ts = useTranslations('kiosks.settings');
  const tx = useMotionText();
  const ed = useKioskEditor();
  if (source === 'preset') return null;
  if (source === 'parent') {
    return (
      <span className="text-[11px] text-muted-foreground" title={ts(`inheritFrom.${ed.level}`)}>
        {tx.t('sourceParent', { from: ts(`inheritFrom.${ed.level}`) })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5">
      <Badge variant="secondary" className={cn('bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200', compact && 'h-4 px-1.5 text-[10px]')}>
        {ts(`overridden.${ed.level}`)}
      </Badge>
      {onReset && ed.canEdit ? (
        <Button type="button" size="icon-xs" variant="ghost" title={tx.t('resetParam')} aria-label={tx.t('resetParam')} onClick={onReset}>
          <RotateCcw />
        </Button>
      ) : null}
    </span>
  );
}

/** A number typed freely: committed while valid, clamped into its range when the field is left. */
function MotionNumber({
  value,
  min,
  max,
  step = 1,
  decimals = 0,
  disabled,
  onCommit,
  ariaLabel,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  decimals?: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
  ariaLabel: string;
  suffix?: ReactNode;
}) {
  const [text, setText] = useState<string | null>(null);
  const parse = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));
  const tidy = (n: number) => (decimals > 0 ? Number(n.toFixed(decimals)) : Math.round(n));
  const ok = (n: number) => Number.isFinite(n) && n >= min && n <= max;
  const invalid = text !== null && !ok(parse(text));
  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        dir="ltr"
        inputMode={decimals > 0 ? 'decimal' : 'numeric'}
        className={cn('h-8 w-24 text-center tabular-nums', invalid && 'border-destructive focus-visible:ring-destructive/30')}
        value={text ?? (Number.isFinite(value) ? String(value) : '')}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setText(e.target.value);
          const n = parse(e.target.value);
          if (ok(n)) onCommit(tidy(n));
        }}
        onBlur={() => {
          if (text === null) return;
          const n = parse(text);
          if (Number.isFinite(n)) {
            const c = tidy(Math.min(max, Math.max(min, n)));
            if (c !== value) onCommit(c);
          }
          setText(null);
        }}
      />
      {suffix ? <span className="text-xs text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}

/** A named curve as a small graph (x → time, y → progress); "auto" has none. */
function CurveGlyph({ easing }: { easing: MotionEasing }) {
  if (easing === 'auto') return null;
  const [x1, y1, x2, y2] = MOTION_EASING_CURVES[easing];
  const P = (x: number, y: number) => `${2 + x * 24} ${26 - y * 20}`;
  return (
    <svg viewBox="0 0 28 32" className="h-8 w-7 shrink-0 text-primary" aria-hidden>
      <path d={`M${P(0, 0)} L${P(1, 0)}`} className="stroke-border" strokeWidth={1} />
      <path d={`M${P(0, 0)} C${P(x1, y1)} ${P(x2, y2)} ${P(1, 1)}`} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
    </svg>
  );
}

const DIRECTION_ICONS: Partial<Record<MotionDirection, typeof ArrowLeft>> = { left: ArrowLeft, right: ArrowRight, up: ArrowUp, down: ArrowDown };

/* ------------------------------------------------------------ the event */

function ParamField({
  event,
  param,
  children,
  hint,
  className,
}: {
  event: MotionEventKey;
  param: MotionParam;
  children: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  const ed = useKioskEditor();
  const tx = useMotionText();
  const apply = useApplyMotionEdits();
  const source = motionParamSource(ed.draft.motion, ed.inherited.motion, event, param);
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <div className="flex min-h-5 flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium">{tx.param(param)}</span>
        <SourceMark source={source} compact onReset={() => apply(motionParamEdits(ed.draft.motion, ed.inherited.motion, event, param, undefined))} />
      </div>
      {children}
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
      <FieldErrors path={`motion.events.${event}.${param}`} />
    </div>
  );
}

function CopyMenu({ event }: { event: MotionEventKey }) {
  const ed = useKioskEditor();
  const tx = useMotionText();
  const apply = useApplyMotionEdits();
  const own = Object.keys(eventLayer(ed.draft.motion, event)).length > 0;
  const copyTo = (target: MotionEventKey) => {
    const c = motionCopyEdits(ed.draft.motion, event, target);
    const name = tx.eventName(target);
    if (c.copied.length === 0) {
      toast.error(tx.t('copyNone', { target: name }));
      return;
    }
    apply(c.edits);
    toast.success(tx.t('copied', { n: c.copied.length, target: name }));
    if (c.skipped.length > 0) toast.message(tx.t('copySkipped', { n: c.skipped.length, target: name }));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={!ed.canEdit || !own}
        render={
          <Button type="button" size="sm" variant="outline" title={own ? undefined : tx.t('copyNothing')}>
            <Copy /> {tx.t('copyTo')}
          </Button>
        }
      />
      <DropdownMenuContent className="max-h-80 w-60" align="start">
        {MOTION_EVENT_GROUPS.map((g) => (
          <DropdownMenuGroup key={g.key}>
            <DropdownMenuLabel>{tx.group(g.key)}</DropdownMenuLabel>
            {g.events
              .filter((e) => e !== event)
              .map((e) => {
                const Icon = MOTION_EVENT_ICONS[e];
                return (
                  <DropdownMenuItem key={e} onClick={() => copyTo(e)}>
                    <Icon aria-hidden /> {tx.eventName(e)}
                  </DropdownMenuItem>
                );
              })}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EventBody({ event, stageRef, beforeRef, playBoth }: {
  event: MotionEventKey;
  stageRef: RefObject<MotionStageHandle | null>;
  beforeRef: RefObject<MotionStageHandle | null>;
  playBoth: () => void;
}) {
  const ed = useKioskEditor();
  const tx = useMotionText();
  const apply = useApplyMotionEdits();
  const [compare, setCompare] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const draft = ed.draft.motion as MotionEngineSettings;
  const inherited = ed.inherited.motion as MotionEngineSettings;
  const view = motionEventView(draft, event);
  const k = globalMultiplier(draft);
  const duration = motionDurationView(draft, event);
  const disabled = !ed.canEdit;
  const set = (param: MotionParam, value: unknown) => apply(motionParamEdits(draft, inherited, event, param, value));
  const range = (param: MotionParam) => motionParamRange(event, param) ?? { min: 0, max: 0 };
  const isNum = (param: MotionParam) => MOTION_PARAMS[param].kind === 'num';
  const timingHint = (param: MotionParam) =>
    k !== 1 && motionParamSource(draft, inherited, event, param) === 'preset' ? tx.t('paramHints.timing') : undefined;

  // As played: the draft's reduce-motion and render profile ("לפני": the inherited config's own).
  const after = resolveMotionEvent(draft, event, { reduceMotion: !!ed.draft.general.reduceMotion, profile: kioskRenderProfile(draft.effects) });
  const before = resolveMotionEvent(inherited, event, {
    reduceMotion: !!ed.inherited.general?.reduceMotion,
    profile: kioskRenderProfile(inherited?.effects),
  });
  const afterLight = kioskRenderProfile(draft.effects) === 'light';
  const beforeLight = kioskRenderProfile(inherited?.effects) === 'light';
  const demo = LIVE_PREVIEW_DEMOS[event];

  const numberField = (param: MotionParam, opts: { hint?: ReactNode; slider?: { step: number; max?: number } } = {}) => {
    const r = range(param);
    const value = view[param] as number;
    const num = isNum(param);
    return (
      <ParamField event={event} param={param} hint={opts.hint}>
        <div className="flex items-center gap-2">
          {opts.slider ? (
            <input
              type="range"
              className="h-2 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
              min={r.min}
              max={opts.slider.max ?? r.max}
              step={opts.slider.step}
              value={Math.min(opts.slider.max ?? r.max, value)}
              disabled={disabled}
              aria-label={tx.param(param)}
              onChange={(e) => set(param, num ? Number(Number(e.target.value).toFixed(2)) : Math.round(Number(e.target.value)))}
            />
          ) : null}
          <MotionNumber
            value={value}
            min={r.min}
            max={r.max}
            step={num ? 0.01 : param === 'intensity' ? 5 : 10}
            decimals={num ? 2 : 0}
            disabled={disabled}
            ariaLabel={tx.param(param)}
            onCommit={(v) => set(param, v)}
          />
        </div>
      </ParamField>
    );
  };

  const kindOptions = MOTION_EVENT_TYPES[event].map((kind) => ({ value: kind, label: tx.kind(kind) }));

  return (
    <div className="space-y-4 border-t bg-muted/15 px-3 pt-4 pb-3 animate-in fade-in slide-in-from-top-1 duration-200">
      <div className="space-y-2">
        {compare ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <MotionStage spec={before} handle={beforeRef} />
              <MotionStageCaption spec={before} label={tx.t('before')} light={beforeLight} />
            </div>
            <div className="space-y-1.5">
              <MotionStage spec={after} handle={stageRef} className="ring-1 ring-primary/40" />
              <MotionStageCaption spec={after} label={tx.t('after')} light={afterLight} />
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <MotionStage spec={after} handle={stageRef} />
            <MotionStageCaption spec={after} light={afterLight} />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={playBoth}>
            <Play /> {tx.t('play')}
          </Button>
          <Button type="button" size="sm" variant={compare ? 'secondary' : 'outline'} aria-pressed={compare} onClick={() => setCompare((v) => !v)}>
            <Columns2 /> {tx.t('compare')}
          </Button>
          {demo ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => ed.playMotion(demo)}>
              <MonitorPlay /> {tx.t('inLivePreview')}
            </Button>
          ) : null}
        </div>
        {compare ? <p className="text-[11px] text-muted-foreground">{tx.t('compareHint')}</p> : null}
      </div>

      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
        <ParamField event={event} param="animationType">
          <OptionSelect
            value={view.animationType}
            options={kindOptions}
            disabled={disabled}
            ariaLabel={tx.param('animationType')}
            className="w-full min-w-0"
            onChange={(v) => {
              set('animationType', v as MotionType);
              // A new kind: show it.
              window.setTimeout(playBoth, 40);
            }}
          />
        </ParamField>
        {numberField('durationMs', {
          slider: { step: 10, max: 3000 },
          hint: (
            <span dir="ltr" className="font-mono">
              {duration.explicit
                ? tx.t('formulaFixed', { ms: duration.ms })
                : tx.t('formula', { base: duration.baseMs, k: formatMultiplier(duration.multiplier), ms: duration.ms })}
            </span>
          ),
        })}
        {numberField('delayMs', { hint: timingHint('delayMs') })}
        {numberField('intensity', { slider: { step: 5 }, hint: tx.t('paramHints.intensity') })}
        <ParamField event={event} param="direction" className="sm:col-span-2">
          <Segmented<MotionDirection>
            value={view.direction}
            disabled={disabled}
            ariaLabel={tx.param('direction')}
            onChange={(d) => set('direction', d)}
            options={MOTION_DIRECTIONS.map((d) => {
              const Icon = DIRECTION_ICONS[d];
              return {
                value: d,
                label: (
                  <span className="inline-flex items-center gap-1">
                    {Icon ? <Icon className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                    {tx.direction(d)}
                  </span>
                ),
              };
            })}
          />
        </ParamField>
        <ParamField event={event} param="easing">
          <div className="flex items-center gap-2">
            <OptionSelect
              value={view.easing}
              options={MOTION_EASINGS.map((e) => ({ value: e, label: tx.easing(e) }))}
              disabled={disabled}
              ariaLabel={tx.param('easing')}
              className="w-full min-w-0"
              onChange={(v) => set('easing', v as MotionEasing)}
            />
            <CurveGlyph easing={view.easing} />
          </div>
        </ParamField>
        {numberField('repeat', { hint: tx.t('paramHints.repeat') })}
      </div>

      <div className="rounded-xl border bg-background/60">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={advanced}
          onClick={() => setAdvanced((v) => !v)}
        >
          {tx.t('advanced')}
          <ChevronDown className={cn('h-4 w-4 transition-transform duration-200', advanced && 'rotate-180')} />
        </button>
        {advanced ? (
          <div className="grid gap-x-5 gap-y-4 border-t p-3 sm:grid-cols-2 animate-in fade-in duration-200">
            {MOTION_ADVANCED_PARAMS.map((param) => {
              if (param === 'reducedMotionFallback') {
                return (
                  <ParamField key={param} event={event} param={param} hint={tx.t('paramHints.reducedMotionFallback')} className="sm:col-span-2">
                    <Segmented<MotionFallback>
                      value={view.reducedMotionFallback}
                      disabled={disabled}
                      ariaLabel={tx.param(param)}
                      onChange={(f) => set(param, f)}
                      options={MOTION_FALLBACKS.map((f) => ({ value: f, label: tx.fallback(f) }))}
                    />
                  </ParamField>
                );
              }
              const hint =
                param === 'scaleFrom' || param === 'scaleTo'
                  ? tx.t('paramHints.scale')
                  : param === 'distancePx'
                    ? tx.t('paramHints.distancePx')
                    : param === 'holdMs'
                      ? event === 'remove'
                        ? tx.t('paramHints.holdRemove')
                        : tx.t('paramHints.holdMs')
                      : param === 'staggerMs'
                        ? tx.t('paramHints.staggerMs')
                        : param === 'autoAdvanceDelayMs'
                          ? tx.t('paramHints.autoAdvanceDelayMs')
                          : timingHint(param);
              return <div key={param}>{numberField(param, { hint })}</div>;
            })}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <CopyMenu event={event} />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          title={tx.t('resetEventHint')}
          disabled={disabled || motionEventSource(draft, inherited, event) !== 'here'}
          onClick={() => apply(motionEventResetEdits(event))}
        >
          <RotateCcw /> {tx.t('resetEvent')}
        </Button>
      </div>
    </div>
  );
}

function EventRow({ event, open, onOpen }: { event: MotionEventKey; open: boolean; onOpen: (open: boolean) => void }) {
  const ed = useKioskEditor();
  const tx = useMotionText();
  const apply = useApplyMotionEdits();
  const stageRef = useRef<MotionStageHandle>(null);
  const beforeRef = useRef<MotionStageHandle>(null);
  const draft = ed.draft.motion as MotionEngineSettings;
  const inherited = ed.inherited.motion as MotionEngineSettings;
  const view = motionEventView(draft, event);
  const source = motionEventSource(draft, inherited, event);
  const errors = useFieldErrors(`motion.events.${event}`);
  const Icon = MOTION_EVENT_ICONS[event];
  const playing = view.enabled && view.animationType !== 'none';

  const playBoth = () => {
    stageRef.current?.play();
    beforeRef.current?.play();
  };
  const play = () => {
    if (open) return playBoth();
    onOpen(true);
    // The stage mounts with the row's body.
    window.setTimeout(playBoth, 80);
  };

  return (
    <div className={cn('transition-colors', open && 'bg-muted/20')}>
      <div className="flex items-center gap-2.5 px-3 py-2.5 sm:gap-3">
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border bg-background shadow-xs transition-colors',
            playing ? 'text-primary' : 'text-muted-foreground opacity-60',
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <button type="button" className="min-w-0 flex-1 text-start" aria-expanded={open} onClick={() => onOpen(!open)}>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={cn('text-sm font-medium', !view.enabled && 'text-muted-foreground line-through decoration-muted-foreground/40')}>
              {tx.eventName(event)}
            </span>
            <SourceMark source={source} compact />
            {errors.length > 0 ? (
              <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
                {errors.length}
              </Badge>
            ) : null}
          </span>
          <span className="line-clamp-1 text-xs text-muted-foreground">{tx.eventDesc(event)}</span>
        </button>
        <span className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium">{view.enabled ? tx.kind(view.animationType) : tx.t('off')}</span>
          <span dir="ltr" className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {playing ? `${view.durationMs}ms` : '—'}
          </span>
        </span>
        <Switch
          checked={view.enabled}
          disabled={!ed.canEdit}
          aria-label={`${tx.param('enabled')} — ${tx.eventName(event)}`}
          onCheckedChange={(v) => apply(motionParamEdits(draft, inherited, event, 'enabled', !!v))}
        />
        <Button type="button" size="icon-sm" variant="ghost" title={tx.t('playHint')} aria-label={`${tx.t('play')} — ${tx.eventName(event)}`} onClick={play}>
          <Play />
        </Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label={tx.eventName(event)} aria-expanded={open} onClick={() => onOpen(!open)}>
          <ChevronDown className={cn('transition-transform duration-200', open && 'rotate-180')} />
        </Button>
      </div>
      {open ? <EventBody event={event} stageRef={stageRef} beforeRef={beforeRef} playBoth={playBoth} /> : null}
    </div>
  );
}

type EventFilter = 'all' | 'custom' | 'off';

/** "אירועים": the four groups, a filter (all · changed · off), each event's row. */
export function MotionEventsCard() {
  const ed = useKioskEditor();
  const tx = useMotionText();
  const [filter, setFilter] = useState<EventFilter>('all');
  const [open, setOpen] = useState<ReadonlySet<MotionEventKey>>(() => new Set());
  const draft = ed.draft.motion as MotionEngineSettings;
  const inherited = ed.inherited.motion as MotionEngineSettings;
  const shown = (e: MotionEventKey) =>
    filter === 'all' ? true : filter === 'off' ? !motionEventView(draft, e).enabled : motionEventSource(draft, inherited, e) !== 'preset';
  const groups = MOTION_EVENT_GROUPS.map((g) => ({ ...g, events: g.events.filter(shown) })).filter((g) => g.events.length > 0);
  const toggle = (e: MotionEventKey, on: boolean) =>
    setOpen((s) => {
      const next = new Set(s);
      if (on) next.add(e);
      else next.delete(e);
      return next;
    });

  return (
    <SectionCard
      title={tx.t('eventsTitle')}
      description={tx.t('eventsHint')}
      action={
        <Segmented<EventFilter>
          value={filter}
          onChange={setFilter}
          ariaLabel={tx.t('eventsTitle')}
          options={(['all', 'custom', 'off'] as const).map((f) => ({ value: f, label: tx.t(`filter.${f}`) }))}
        />
      }
    >
      {groups.length === 0 ? <p className="text-sm text-muted-foreground">{tx.t('noneFiltered')}</p> : null}
      {groups.map((g) => {
        const GroupIcon = MOTION_GROUP_ICONS[g.key];
        return (
          <section key={g.key} className="space-y-2">
            <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground">
              <GroupIcon className="h-3.5 w-3.5" /> {tx.group(g.key)}
              <span className="font-mono text-[10px] font-normal tabular-nums">{g.events.length}</span>
            </h3>
            <div className="divide-y overflow-hidden rounded-2xl border bg-card">
              {g.events.map((e) => (
                <EventRow key={e} event={e} open={open.has(e)} onOpen={(on) => toggle(e, on)} />
              ))}
            </div>
          </section>
        );
      })}
    </SectionCard>
  );
}
