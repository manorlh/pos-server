'use client';

/**
 * What the settlement, the reports and the controls tabs share: the refusal codes in Hebrew
 * (`prepaidVouchers.extras.errors`, with the facts some codes carry), money that hides itself
 * without the prices section, a stat tile, a section frame and a "reason" dialog (void, resume).
 */

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDate, formatDateTime, isoDate } from '@/lib/format';
import { agorotText } from '@/lib/prepaidVoucherFilters';
import { errorCodeOf } from '@/lib/prepaidVoucherExtras';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export const SELECT_CLASS = 'h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30';
export const TEXTAREA_CLASS =
  'w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';
export const TH = 'px-2 py-1.5 text-start font-medium whitespace-nowrap';
export const TH_END = 'px-2 py-1.5 text-end font-medium whitespace-nowrap';
export const TD = 'px-2 py-1.5';
export const TD_END = 'px-2 py-1.5 text-end tabular-nums';

/** dd/mm/yyyy hh:mm, or '' for none. */
export const whenText = (iso: string | null | undefined) => (iso && isoDate(iso) ? formatDateTime(iso) : '');
/** dd/mm/yyyy of an ISO instant or a yyyy-mm-dd day, or ''. */
export const dayText = (iso: string | null | undefined) => (iso && isoDate(iso) ? formatDate(iso) : '');

/** ₪ from agorot; "—" when the amount is hidden (no prices section) or unknown. */
export function money(agorot: number | null | undefined): string {
  return agorot === null || agorot === undefined ? '—' : agorotText(agorot);
}

/**
 * A refusal in Hebrew: a code we know (with its facts as `{a}`, `{b}`), else the server's own
 * text or the fallback. Use `prepaidVouchers.extras.errors.<code>`.
 */
export function useExtrasErrorText() {
  const t = useTranslations('prepaidVouchers');
  const tc = useTranslations('common');
  return (err: unknown, fallback?: string): string => {
    const e = errorCodeOf(err);
    if (e) {
      const [a = '', b = ''] = e.facts;
      if (t.has(`extras.errors.${e.code}`)) return t(`extras.errors.${e.code}`, { a, b });
      // The core's codes (a voucher or batch not found, forbidden…).
      if (t.has(`errors.${e.code}`)) return t(`errors.${e.code}`);
    }
    return axiosErrorToToastMessage(err, fallback ?? tc('error'));
  };
}

export function StatTile({ label, value, hint, tone, className }: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad' | 'muted';
  className?: string;
}) {
  return (
    <div className={cn(
      'rounded-xl bg-card p-3 ring-1 ring-foreground/10',
      tone === 'muted' && 'bg-muted/40',
      tone === 'warn' && 'ring-amber-500/40',
      tone === 'bad' && 'ring-destructive/40',
      tone === 'good' && 'ring-emerald-500/40',
      className,
    )}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function Section({ title, actions, children, className }: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-2 rounded-xl bg-card p-3 ring-1 ring-foreground/10', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {actions ? <div className="flex flex-wrap items-center gap-2 print:hidden">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">{children}</p>;
}

/**
 * Asks for a reason (or a note) before an action that is never undone: void an invoice or a
 * delivery, resume a pause. [required]: the button waits for text.
 */
export function ReasonDialog({ open, title, label, confirm, required = true, pending, onConfirm, onOpenChange, children }: {
  open: boolean;
  title: string;
  label: string;
  confirm: string;
  required?: boolean;
  pending: boolean;
  onConfirm: (text: string) => void;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
}) {
  const tc = useTranslations('common');
  const [text, setText] = useState('');
  const ready = !required || text.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setText(''); onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
        <div className="space-y-1">
          <Label htmlFor="pvx-reason">{label}</Label>
          <textarea id="pvx-reason" rows={3} maxLength={1000} className={TEXTAREA_CLASS} value={text}
            onChange={(e) => setText(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>{tc('cancel')}</Button>
          <Button variant="destructive" disabled={!ready || pending} onClick={() => onConfirm(text.trim())}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A small rounded tag ("שובר בדיקה", "מבוטלת", "פעילה"). */
export function Tag({ children, tone = 'muted', className }: {
  children: ReactNode;
  tone?: 'muted' | 'primary' | 'good' | 'warn' | 'bad';
  className?: string;
}) {
  return (
    <span className={cn(
      'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
      tone === 'muted' && 'bg-muted text-muted-foreground',
      tone === 'primary' && 'bg-primary/10 text-primary',
      tone === 'good' && 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
      tone === 'warn' && 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
      tone === 'bad' && 'bg-destructive/10 text-destructive',
      className,
    )}>
      {children}
    </span>
  );
}
