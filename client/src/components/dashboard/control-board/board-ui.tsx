'use client';

/**
 * The control board's building blocks: its card, the round tinted icon badge, the
 * ▲/▼ change, the wordmark, the filter box and the light/dark switch.
 *
 * The colours are the `--cb-*` tokens of globals.css (Tailwind `bg-cb-card`,
 * `text-cb-blue-ink`, …), never literal hex, so the board's dark mode is one place.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { deltaTone, pctChange } from '@/lib/controlBoard';

/**
 * The system's dark mode. The app has no theme switch of its own, so the board follows
 * the phone or computer it is on: the page puts `.dark` on itself (and its sheets),
 * which re-themes everything under it through the same tokens as the rest of the app.
 */
export function useSystemDark(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    () => false,
  );
}

/** The classes a portalled sheet needs to look like the board it opens from. */
export function boardSurface(dark: boolean): string {
  return cn('cb-board', dark && 'dark');
}

/** A white rounded card with a hairline and a very soft shadow. */
export function BoardCard({
  className,
  children,
  id,
  labelledBy,
}: {
  className?: string;
  children: React.ReactNode;
  id?: string;
  labelledBy?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn(
        'min-w-0 rounded-2xl border border-cb-line bg-cb-card p-4 shadow-[var(--cb-shadow)] md:p-5',
        className,
      )}
    >
      {children}
    </section>
  );
}

export type BadgeTone = 'blue' | 'purple' | 'green' | 'teal' | 'amber' | 'red';

const BADGE: Record<BadgeTone, string> = {
  blue: 'bg-cb-blue/12 text-cb-blue-ink',
  purple: 'bg-cb-purple/12 text-cb-purple-ink',
  green: 'bg-cb-green/15 text-cb-green-ink',
  teal: 'bg-cb-teal/15 text-cb-teal-ink',
  amber: 'bg-cb-amber/15 text-cb-amber-ink',
  red: 'bg-cb-red/12 text-cb-red-ink',
};

/** A round tinted badge around an icon, as on the KPI cards. */
export function IconBadge({
  icon: Icon,
  tone,
  className,
}: {
  icon: React.ElementType;
  tone: BadgeTone;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn('flex size-10 shrink-0 items-center justify-center rounded-full md:size-11', BADGE[tone], className)}
    >
      <Icon className="size-5" />
    </span>
  );
}

/** A card's title row: an icon, the title, and whatever sits at the end. */
export function CardTitle({
  id,
  icon: Icon,
  children,
  trailing,
}: {
  id?: string;
  icon?: React.ElementType;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <h2 id={id} className="flex min-w-0 items-center gap-2 text-base font-semibold text-cb-ink">
        {Icon ? <Icon className="size-[18px] shrink-0 text-cb-muted" aria-hidden /> : null}
        <span className="truncate">{children}</span>
      </h2>
      {trailing}
    </div>
  );
}

/**
 * The change from b to a: an arrow and a percentage, green when it is good news and red
 * when not (`invert` where less is better). The arrow and the words in its label carry
 * the direction too, so it is never colour alone.
 */
export function Delta({
  a,
  b,
  invert = false,
  className,
}: {
  a: number;
  b: number;
  invert?: boolean;
  className?: string;
}) {
  const t = useTranslations('controlBoard.kpi');
  const pct = pctChange(a, b);
  const { direction, good } = deltaTone(a, b, invert);
  const text = pct === null ? t('new') : `${Math.abs(pct).toFixed(1)}%`;
  const Icon = direction === 'up' ? ChevronUp : direction === 'down' ? ChevronDown : Minus;
  const label =
    direction === 'flat' ? t('same') : pct === null ? t('new') : t(direction === 'up' ? 'up' : 'down', { pct: text });
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 text-xs font-semibold tabular-nums',
        good === null ? 'text-cb-muted' : good ? 'text-cb-green-ink' : 'text-cb-red-ink',
        className,
      )}
      dir="ltr"
      title={label}
    >
      <Icon className="size-3.5" aria-hidden />
      <span aria-hidden>{direction === 'flat' ? '0%' : text}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The same change as a small filled pill, for a list's end column. */
export function DeltaPill({ a, b, invert = false }: { a: number; b: number; invert?: boolean }) {
  const { good } = deltaTone(a, b, invert);
  return (
    <span
      className={cn(
        'inline-flex min-w-14 justify-center rounded-md px-1.5 py-0.5',
        good === null ? 'bg-cb-soft' : good ? 'bg-cb-green/12' : 'bg-cb-red/12',
      )}
    >
      <Delta a={a} b={b} invert={invert} />
    </span>
  );
}

/** "RUNNER POS": bold italic, navy, with POS in the board's blue. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      dir="ltr"
      className={cn('select-none text-lg font-black italic leading-none tracking-tight text-cb-navy', className)}
    >
      RUNNER <span className="text-cb-blue">POS</span>
    </span>
  );
}

export interface FilterOption {
  value: string;
  label: string;
  /** Nesting (a subsidiary company), drawn as an indent in the list. */
  depth?: number;
}

/**
 * One of the filter row's boxes — "סניף: רמת גן" — over a native select, so a phone
 * opens its own picker and a keyboard works as everywhere else.
 */
export function FilterBox({
  label,
  value,
  options,
  onChange,
  disabled = false,
  display,
  className,
}: {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** What the box reads; the chosen option's label when absent. */
  display?: string;
  className?: string;
}) {
  const chosen = options.find((o) => o.value === value);
  return (
    <label
      className={cn(
        'relative flex h-11 min-w-0 items-center gap-1.5 rounded-xl border border-cb-line bg-cb-card px-3 text-sm shadow-[var(--cb-shadow)] transition-colors focus-within:border-cb-blue focus-within:ring-2 focus-within:ring-cb-blue/30',
        disabled ? 'opacity-60' : 'hover:border-cb-blue/50',
        className,
      )}
    >
      <span className="shrink-0 text-cb-muted">{label}:</span>
      <span className="min-w-0 flex-1 truncate font-semibold text-cb-ink">{display ?? chosen?.label ?? ''}</span>
      <ChevronDown className="size-4 shrink-0 text-cb-muted" aria-hidden />
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.depth ? `${'  '.repeat(o.depth)}↳ ${o.label}` : o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A two-or-three way switch (segmented control). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg bg-cb-soft p-0.5">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.id)}
            className={cn(
              'min-h-8 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-cb-blue/40',
              on ? 'bg-cb-card text-cb-ink shadow-sm' : 'text-cb-muted hover:text-cb-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
