'use client';

/**
 * iOS-style building blocks for the menu pages ("תוספות ושינויים", "הגדלות מכירה"), in
 * the look of the control board (`app/dashboard/compare`): grouped rounded lists on a
 * grey canvas, segmented controls, switches and chips.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** The grey canvas a page's grouped lists sit on. */
export function IosCanvas({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        '-mx-2 rounded-[28px] bg-[#F2F2F7] px-3 pb-6 pt-4 text-black antialiased dark:bg-black dark:text-white sm:mx-0 sm:px-5',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** An iOS card: white, very round, a hairline and a soft shadow; #1C1C1E in the dark. */
export function IosCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-[22px] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_16px_rgba(0,0,0,0.04)] dark:bg-[#1C1C1E] dark:shadow-none',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A grouped section's header, as in iOS Settings: small, grey, above the card. */
export function IosSectionHeader({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="mb-1.5 mt-4 flex items-end justify-between gap-2 px-4">
      <h2 className="text-[13px] font-normal uppercase tracking-wide text-[#6D6D72] dark:text-[#8E8E93]">{children}</h2>
      {trailing}
    </div>
  );
}

/** The grey footnote under a grouped section. */
export function IosFootnote({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 px-4 text-[12px] leading-snug text-[#6D6D72] dark:text-[#8E8E93]">{children}</p>;
}

/** One row of a grouped list, with a hairline between rows. */
export function IosRow({
  children,
  className,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  const body = (
    <div className="flex min-h-11 items-center gap-3 px-4 py-2.5">{children}</div>
  );
  return (
    <div
      className={cn(
        'border-b border-black/[0.08] last:border-b-0 dark:border-white/[0.1]',
        onClick && 'cursor-pointer transition-colors hover:bg-black/[0.03] active:bg-black/[0.06] dark:hover:bg-white/[0.04]',
        className,
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    >
      {body}
    </div>
  );
}

/** iOS segmented control: a grey track and a white thumb on the chosen segment. */
export function IosSegmented<T extends string>({
  value,
  options,
  onChange,
  className,
  disabled,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn('flex rounded-[9px] bg-[#7676801F] p-[2px] dark:bg-[#7676803D]', className)} role="tablist">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={on}
            disabled={disabled}
            onClick={() => onChange(o.id)}
            className={cn(
              'min-h-8 flex-1 whitespace-nowrap rounded-[7px] px-3 text-[13px] transition-all disabled:opacity-60',
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
export function IosSwitch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors disabled:opacity-50',
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

/** A toggle chip: grey when off, tinted when on. */
export function IosChip({
  on,
  onClick,
  children,
  tone = 'blue',
  disabled,
  title,
}: {
  on: boolean;
  onClick?: () => void;
  children: ReactNode;
  tone?: 'blue' | 'red' | 'orange' | 'green';
  disabled?: boolean;
  title?: string;
}) {
  const tones = {
    blue: 'bg-[#007AFF] text-white',
    red: 'bg-[#FF3B30] text-white',
    orange: 'bg-[#FF9500] text-white',
    green: 'bg-[#34C759] text-white',
  } as const;
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-8 items-center gap-1 rounded-full px-3 text-[13px] font-medium transition-colors disabled:opacity-50',
        on ? tones[tone] : 'bg-[#7676801F] text-black/85 hover:bg-[#76768029] dark:bg-[#7676803D] dark:text-white/85',
      )}
    >
      {children}
    </button>
  );
}

/** A small rounded tag for a row's facts ("חובה", "עד 5", "2 חינם"). */
export function IosTag({
  children,
  tone = 'grey',
}: {
  children: ReactNode;
  tone?: 'grey' | 'blue' | 'red' | 'green' | 'orange';
}) {
  const tones = {
    grey: 'bg-[#7676801F] text-[#3C3C43] dark:bg-[#7676803D] dark:text-white/80',
    blue: 'bg-[#007AFF]/12 text-[#007AFF]',
    red: 'bg-[#FF3B30]/12 text-[#FF3B30]',
    green: 'bg-[#34C759]/15 text-[#248A3D] dark:text-[#30D158]',
    orange: 'bg-[#FF9500]/15 text-[#C93400] dark:text-[#FF9F0A]',
  } as const;
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold', tones[tone])}>
      {children}
    </span>
  );
}

/** The blue text button of iOS ("עריכה", "הוסף"). */
export function IosTextButton({
  children,
  onClick,
  disabled,
  tone = 'blue',
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'blue' | 'red';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1 text-[15px] font-medium active:opacity-60 disabled:opacity-40',
        tone === 'red' ? 'text-[#FF3B30]' : 'text-[#007AFF]',
      )}
    >
      {children}
    </button>
  );
}
