'use client';

/**
 * Small, accessible controls for the card editor: a radio-group "segmented" control, a native
 * select styled like the inputs, a textarea and a field label with a hint.
 */
import type { ComponentProps, ReactNode } from 'react';
import { useId } from 'react';

import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export const inputCls =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive';

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
  size = 'sm',
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
  size?: 'xs' | 'sm';
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1">
      <div id={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </div>
      <div role="radiogroup" aria-labelledby={id} className="inline-flex max-w-full flex-wrap gap-1 rounded-lg bg-muted p-1">
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={String(o.value)}
              type="button"
              role="radio"
              aria-checked={on}
              title={o.title}
              disabled={disabled}
              onClick={() => onChange(o.value)}
              className={cn(
                'rounded-md px-2 font-medium transition outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50',
                size === 'xs' ? 'h-6 text-xs' : 'h-7 text-[0.8rem]',
                on ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function NativeSelect({
  label,
  value,
  onChange,
  options,
  disabled,
  className,
  hideLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  disabled?: boolean;
  className?: string;
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <Label htmlFor={id} className={cn('text-xs', hideLabel && 'sr-only')}>
        {label}
      </Label>
      <select id={id} className={cn(inputCls, 'pe-7')} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function TextArea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      {...props}
      className={cn(
        'w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:border-destructive',
        className,
      )}
    />
  );
}

export function Hint({ children, tone = 'muted', id }: { children: ReactNode; tone?: 'muted' | 'warn' | 'error'; id?: string }) {
  return (
    <p
      id={id}
      className={cn(
        'text-xs',
        tone === 'muted' && 'text-muted-foreground',
        tone === 'warn' && 'text-amber-800 dark:text-amber-300',
        tone === 'error' && 'font-medium text-destructive',
      )}
    >
      {children}
    </p>
  );
}

export function Panel({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}
