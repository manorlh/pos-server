'use client';

/**
 * The few iOS building blocks the catalog import page is laid out with — the same look as
 * the compare board (dashboard/compare): white very-round cards on a grouped grey
 * background, small grey section headers, inset list rows with hairlines, a segmented
 * control. Dark mode follows the system.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** iOS system colours. */
export const IOS = {
  blue: '#007AFF',
  green: '#34C759',
  orange: '#FF9500',
  yellow: '#FFCC00',
  red: '#FF3B30',
  grey: '#8E8E93',
  indigo: '#5856D6',
  teal: '#30B0C7',
  whatsapp: '#25D366',
} as const;

export const SF_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Rubik, Arial, sans-serif';

const HAIRLINE = 'bg-[#3C3C4349] dark:bg-[#54545899]';

export function IosCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'rounded-[22px] bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_16px_rgba(0,0,0,0.04)] dark:bg-[#1C1C1E] dark:shadow-none',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A grouped section's header: small and grey, above its card. */
export function IosSectionHeader({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="mb-1.5 mt-5 flex items-end justify-between gap-3 px-4">
      <h2 className="text-[13px] font-normal uppercase tracking-wide text-[#6D6D72] dark:text-[#8E8E93]">{children}</h2>
      {trailing}
    </div>
  );
}

/** A hairline between list rows, inset from the start like iOS (past an icon, if any). */
export function IosHairline({ inset = 16 }: { inset?: number }) {
  return <span className={cn('absolute left-0 top-0 h-px', HAIRLINE)} style={{ right: inset }} />;
}

/** One row of an inset list: a coloured icon square, a title and a line under it. */
export function IosRow({
  icon,
  iconColor,
  title,
  subtitle,
  trailing,
  onClick,
  disabled,
  first,
}: {
  icon: ReactNode;
  iconColor: string;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  first?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="relative flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-black/[0.02] active:bg-black/5 disabled:cursor-default disabled:opacity-50 dark:hover:bg-white/[0.03] dark:active:bg-white/5"
    >
      {first ? null : <IosHairline inset={58} />}
      <span
        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] text-white [&_svg]:h-[18px] [&_svg]:w-[18px]"
        style={{ backgroundColor: iconColor }}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[17px] leading-snug">{title}</span>
        {subtitle ? <span className="block text-[13px] leading-snug text-[#8E8E93]">{subtitle}</span> : null}
      </span>
      {trailing}
    </button>
  );
}

/** The segmented control: a grey track, a white thumb on the chosen segment. */
export function IosSegmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { id: T; label: ReactNode }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex rounded-[9px] bg-[#7676801F] p-[2px] dark:bg-[#7676803D]', className)} role="tablist">
      {options.map((option) => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(option.id)}
            className={cn(
              'min-h-8 flex-1 whitespace-nowrap rounded-[7px] px-3 text-[13px] transition-all',
              on
                ? 'bg-white font-semibold text-black shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)] dark:bg-[#636366] dark:text-white'
                : 'font-medium text-black/80 dark:text-white/80',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A filled iOS button (blue by default). */
export function IosButton({
  children,
  onClick,
  disabled,
  color = IOS.blue,
  variant = 'filled',
  className,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  color?: string;
  variant?: 'filled' | 'tinted' | 'plain';
  className?: string;
  type?: 'button' | 'submit';
}) {
  const style =
    variant === 'filled'
      ? { backgroundColor: color, color: '#fff' }
      : variant === 'tinted'
        ? { backgroundColor: `${color}1F`, color }
        : { color };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={style}
      className={cn(
        'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[12px] px-4 text-[15px] font-semibold transition-opacity active:opacity-60 disabled:opacity-40 [&_svg]:h-4 [&_svg]:w-4',
        variant === 'plain' && 'px-2',
        className,
      )}
    >
      {children}
    </button>
  );
}
