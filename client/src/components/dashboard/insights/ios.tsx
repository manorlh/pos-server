'use client';

/**
 * The control board's iOS visual language (src/app/dashboard/compare/page.tsx) as shared
 * pieces for the insights page and the control board's open-tables widget: a grouped
 * grey background, white rounded cards, small grey section headers, a segmented control,
 * a switch, figure widgets with ▲/▼ deltas, the system colours; dark mode included.
 *
 * Chart colours are CSS variables set on `InsightsSurface` (`--ins-*`), so recharts
 * marks follow the dark theme too — validated with the dataviz palette checks: the blue
 * accent on both surfaces, and a single-hue sequential ramp for the heat map.
 */

import type { CSSProperties, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';

export const IOS = {
  blue: '#007AFF',
  orange: '#FF9500',
  green: '#34C759',
  red: '#FF3B30',
  purple: '#AF52DE',
  teal: '#30B0C7',
  indigo: '#5856D6',
  pink: '#FF2D55',
  gray: '#8E8E93',
};

export const SF_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Rubik, Arial, sans-serif';

/** Chart tokens: the accent, the de-emphasis grey, the grid hairline, the heat ramp. */
export const CHART = {
  accent: 'var(--ins-accent)',
  accentWash: 'var(--ins-accent-wash)',
  muted: 'var(--ins-muted)',
  grid: 'var(--ins-grid)',
  surface: 'var(--ins-surface)',
  heat: ['var(--ins-heat-1)', 'var(--ins-heat-2)', 'var(--ins-heat-3)', 'var(--ins-heat-4)', 'var(--ins-heat-5)'],
};

const SURFACE_VARS =
  '[--ins-accent:#007AFF] [--ins-accent-wash:rgba(0,122,255,0.10)] [--ins-muted:#8E8E93] [--ins-grid:#E5E5EA] [--ins-surface:#FFFFFF] ' +
  '[--ins-heat-1:#7AB3FF] [--ins-heat-2:#4D97FF] [--ins-heat-3:#1F7BFF] [--ins-heat-4:#0A62D0] [--ins-heat-5:#004A9E] ' +
  'dark:[--ins-accent:#0A84FF] dark:[--ins-accent-wash:rgba(10,132,255,0.16)] dark:[--ins-muted:#8E8E93] dark:[--ins-grid:#38383A] dark:[--ins-surface:#1C1C1E] ' +
  'dark:[--ins-heat-1:#1F5FAE] dark:[--ins-heat-2:#2F78D2] dark:[--ins-heat-3:#4A93EE] dark:[--ins-heat-4:#79B2FF] dark:[--ins-heat-5:#B0D3FF]';

/** The page's grouped background, its font and the chart tokens. */
export function InsightsSurface({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        '-mx-2 rounded-[28px] bg-[#F2F2F7] px-3 pb-6 pt-4 text-black antialiased dark:bg-black dark:text-white sm:mx-0 sm:px-5',
        SURFACE_VARS,
        className,
      )}
      style={{ fontFamily: SF_FONT }}
    >
      {children}
    </div>
  );
}

/** Only the chart tokens, for a widget that sits on someone else's surface. */
export function ChartTokens({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(SURFACE_VARS, className)}>{children}</div>;
}

export const tooltipStyle: CSSProperties = {
  borderRadius: 14,
  border: 'none',
  boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
  fontFamily: SF_FONT,
  fontSize: 13,
  direction: 'rtl',
};

/** An iOS card: white, very round, a hairline and a soft shadow; #1C1C1E in the dark. */
export function Card({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <div
      id={id}
      className={cn(
        'rounded-[22px] bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_16px_rgba(0,0,0,0.04)] dark:bg-[#1C1C1E] dark:shadow-none',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A grouped section's header, as in iOS Settings: small, grey, above the card. */
export function SectionHeader({ children, trailing, id }: { children: ReactNode; trailing?: ReactNode; id?: string }) {
  return (
    <div id={id} className="mb-1.5 mt-5 flex scroll-mt-4 flex-wrap items-end justify-between gap-2 px-4">
      <h2 className="text-[13px] font-normal uppercase tracking-wide text-[#6D6D72] dark:text-[#8E8E93]">{children}</h2>
      {trailing}
    </div>
  );
}

/** iOS segmented control: a grey track and a white thumb on the chosen segment. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
  label?: string;
}) {
  return (
    <div className={cn('flex rounded-[9px] bg-[#7676801F] p-[2px] dark:bg-[#7676803D]', className)} role="tablist" aria-label={label}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.id)}
            className={cn(
              'min-h-8 flex-1 whitespace-nowrap rounded-[7px] px-3 text-[13px] transition-all',
              on
                ? 'bg-white font-semibold text-black shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)] dark:bg-[#636366] dark:text-white'
                : 'font-medium text-black/80 dark:text-white/80',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** iOS switch. */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors',
        checked ? 'bg-[#34C759]' : 'bg-[#78788029] dark:bg-[#78788052]',
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_3px_8px_rgba(0,0,0,0.15),0_3px_1px_rgba(0,0,0,0.06)] transition-all',
          checked ? 'right-[2px]' : 'right-[22px]',
        )}
      />
    </button>
  );
}

export function changePct(a: number, b: number): number | null {
  if (b === 0) return a === 0 ? 0 : null;
  return ((a - b) / Math.abs(b)) * 100;
}

export function signedPct(pct: number | null | undefined, digits = 1): string {
  if (pct === null || pct === undefined) return '—';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(digits)}%`;
}

/**
 * iOS Stocks style: a coloured ▲/▼ and the percentage. `invert` for figures where less is
 * better (discounts, refunds): a rise shows red. `pct` overrides the computed change.
 */
export function Delta({
  a,
  b,
  pct,
  invert = false,
  pill = false,
}: {
  a: number;
  b: number;
  pct?: number | null;
  invert?: boolean;
  pill?: boolean;
}) {
  const t = useTranslations('insights');
  const value = pct !== undefined ? pct : changePct(a, b);
  const same = value === 0 || a === b;
  const up = value !== null ? value > 0 : a > b;
  const good = invert ? !up : up;
  const color = same ? IOS.gray : good ? IOS.green : IOS.red;
  const text = value === null ? t('newValue') : signedPct(value);
  if (pill) {
    return (
      <span
        className="inline-flex min-w-16 items-center justify-center gap-0.5 rounded-md px-2 py-1 text-[13px] font-semibold tabular-nums text-white"
        style={{ backgroundColor: color }}
        dir="ltr"
      >
        {text}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-[13px] font-semibold tabular-nums" style={{ color }} dir="ltr">
      {same ? null : up ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
      {text}
    </span>
  );
}

/** A widget like iOS's: a coloured label on top, the figure large, the comparison under it. */
export function Widget({
  title,
  color,
  value,
  sub,
  delta,
}: {
  title: string;
  color: string;
  value: string;
  sub?: ReactNode;
  delta?: ReactNode;
}) {
  return (
    <Card className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#3C3C43] dark:text-[#EBEBF5]">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        <span className="truncate">{title}</span>
      </span>
      <span className="truncate text-[26px] font-bold leading-tight tracking-tight text-black dark:text-white">{value}</span>
      {sub || delta ? (
        <span className="flex flex-wrap items-center gap-2 text-[13px] text-[#8E8E93]">
          {sub ? <span className="tabular-nums">{sub}</span> : null}
          {delta}
        </span>
      ) : null}
    </Card>
  );
}

/** One of several figures in a card, iOS style: value, label, an optional line under it. */
export function Figure({ value, label, sub }: { value: ReactNode; label: string; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-0.5 px-2 text-center">
      <span className="text-[20px] font-bold">{value}</span>
      <span className="text-[13px] text-[#8E8E93]">{label}</span>
      {sub ? <span className="text-[12px] font-semibold tabular-nums">{sub}</span> : null}
    </div>
  );
}

/** A capsule meter, as iOS Screen Time draws its bars. */
export function Capsule({ value, max, color = CHART.accent }: { value: number; max: number; color?: string }) {
  const width = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="h-[6px] rounded-full bg-[#7676801F]">
      <div className="h-[6px] rounded-full" style={{ width: `${width}%`, backgroundColor: color }} />
    </div>
  );
}

/** An inset-list row separator, as in iOS grouped lists. */
export function RowDivider() {
  return <span className="absolute left-0 right-4 top-0 h-px bg-[#3C3C4349] dark:bg-[#54545899]" aria-hidden />;
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-[15px] text-[#8E8E93]', className)}>{children}</p>;
}

/** A small chip: an icon and a label in the colour of what it means (never colour alone). */
export function Chip({ color, icon, children }: { color: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-semibold"
      style={{ backgroundColor: `${color}1F`, color: 'inherit' }}
    >
      {icon ? <span style={{ color }} className="inline-flex" aria-hidden>{icon}</span> : null}
      {children}
    </span>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-[22px] bg-white dark:bg-[#1C1C1E]', className)} />;
}

/** Hours as "07:00", the way the control board writes them. */
export function hh(hour: number): string {
  return `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`;
}

/** "120" → "2:00 ש׳" style durations come from the messages; this is the h:mm part. */
export function hoursMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** A plain business date "2026-09-27" as "27/9". */
export function dayMonth(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d}/${m}`;
}
