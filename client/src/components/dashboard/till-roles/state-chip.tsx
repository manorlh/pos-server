'use client';

import { useTranslations } from 'next-intl';
import { Check, ShieldQuestion, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { nextState, type PermState } from '@/lib/tillRoles';

const STYLE: Record<PermState, string> = {
  allow: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200',
  approval: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200',
  deny: 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200',
};

const ICON: Record<PermState, typeof Check> = { allow: Check, approval: ShieldQuestion, deny: X };

/** A tri-state cell: tap cycles allow → approval → deny. Changed cells get a ring. */
export function StateChip({
  state,
  onChange,
  disabled,
  changed,
  label,
}: {
  state: PermState;
  onChange?: (next: PermState) => void;
  disabled?: boolean;
  changed?: boolean;
  /** For screen readers: "<permission> — <role>". */
  label: string;
}) {
  const t = useTranslations('tillRoles.states');
  const Icon = ICON[state];
  const text = t(`${state}Short`);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange?.(nextState(state))}
      aria-label={`${label}: ${t(state)}`}
      title={t(state)}
      className={cn(
        'inline-flex min-w-[4.5rem] items-center justify-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
        STYLE[state],
        !disabled && 'cursor-pointer hover:brightness-95',
        disabled && 'cursor-default opacity-90',
        changed && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {text}
    </button>
  );
}

/** The same colours as a static badge (the users tab, the overrides dialog). */
export function StateBadge({ state }: { state: PermState }) {
  const t = useTranslations('tillRoles.states');
  const Icon = ICON[state];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs', STYLE[state])}>
      <Icon className="h-3 w-3" aria-hidden />
      {t(`${state}Short`)}
    </span>
  );
}
