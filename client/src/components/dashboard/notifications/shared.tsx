'use client';

/**
 * Pieces shared by "הודעות" (/dashboard/notifications) and "מועדון לקוחות"
 * (/dashboard/club): tabs, a side drawer, the reason dialog every audited action
 * asks through, a transient reveal of a full phone number, and the error text.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EyeOff } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime, isoDate } from '@/lib/format';
import { apiErrorCode, apiUserMessage } from '@/lib/notificationsApi';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export const NC = 'notificationsClub';

/** dd/MM/yyyy HH:mm, or '' for nothing / an unreadable value. */
export function formatWhen(iso: string | null | undefined): string {
  return isoDate(iso) ? formatDateTime(iso) : '';
}

/** The server's `userMessage`, else our text for its code, else a generic error. */
export function useNcErrorText() {
  const t = useTranslations(`${NC}.errors`);
  const tc = useTranslations('common');
  return (err: unknown): string => {
    const message = apiUserMessage(err);
    if (message) return message;
    const code = apiErrorCode(err);
    if (code && t.has(code)) return t(code);
    if (code) return t('withCode', { code });
    return axiosErrorToToastMessage(err, tc('error'));
  };
}

export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: Array<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <Button
          key={tab.id}
          role="tab"
          aria-selected={value === tab.id}
          variant={value === tab.id ? 'default' : 'outline'}
          size="sm"
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </Button>
      ))}
    </div>
  );
}

/** A panel from the inline-end edge on a wide screen; the phone's bottom sheet below `sm`. */
export function SideDrawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'sm:max-w-xl',
          'sm:top-0 sm:left-0 sm:h-dvh sm:max-h-dvh sm:translate-x-0 sm:translate-y-0 sm:rounded-none sm:content-start',
        )}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-4">{children}</div>
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Every audited action (reveal a number, resend, suspend…) asks why. The reason goes
 * to the server's audit trail; `required` blocks the confirm until one is typed.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending,
  destructive = false,
  required = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  onConfirm: (reason: string) => void;
  pending?: boolean;
  destructive?: boolean;
  required?: boolean;
}) {
  const t = useTranslations(`${NC}.common`);
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const blocked = required && trimmed.length < 2;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setReason('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!blocked && !pending) onConfirm(trimmed);
          }}
        >
          <Label htmlFor="nc-reason">{required ? t('reasonRequired') : t('reasonOptional')}</Label>
          <textarea
            id="nc-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            rows={3}
            className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            autoFocus
          />
          <p className="text-xs text-muted-foreground">{t('reasonAudited')}</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={blocked || pending}>
              {pending ? t('working') : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A plain "are you sure" for an action that takes no reason. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
}) {
  const t = useTranslations(`${NC}.common`);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? t('working') : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** How long a revealed number stays on screen. */
export const REVEAL_SECONDS = 30;

/**
 * A full number the server just revealed (audited): shown for REVEAL_SECONDS, then
 * dropped. Never put in a query cache, a URL or storage — only this component's prop.
 */
export function TransientReveal({ value, onHide }: { value: string; onHide: () => void }) {
  const t = useTranslations(`${NC}.common`);
  const [left, setLeft] = useState(REVEAL_SECONDS);

  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => {
      const remaining = REVEAL_SECONDS - Math.floor((Date.now() - started) / 1000);
      if (remaining <= 0) {
        window.clearInterval(id);
        onHide();
      } else {
        setLeft(remaining);
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [onHide]);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
      <span dir="ltr" className="font-mono text-base font-semibold tracking-wide">
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{t('revealHidesIn', { seconds: left })}</span>
      <Button type="button" size="sm" variant="ghost" onClick={onHide}>
        <EyeOff aria-hidden />
        {t('hide')}
      </Button>
    </div>
  );
}

/** A labelled row inside a drawer. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

const ANY = '__any__';

/** A labelled select; `anyLabel` adds an "all" option that maps to ''. */
export function SimpleSelect({
  id,
  label,
  value,
  onChange,
  options,
  anyLabel,
  disabled,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  anyLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const items = anyLabel ? [{ value: ANY, label: anyLabel }, ...options] : options;
  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Select
        value={anyLabel ? value || ANY : value}
        onValueChange={(v) => onChange(!v || v === ANY ? '' : String(v))}
        items={items}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((o) => (
            <SelectItem
              key={o.value}
              value={o.value}
              label={o.label}
              disabled={'disabled' in o ? o.disabled : false}
            >
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function Textarea(props: React.ComponentProps<'textarea'>) {
  const { className, ...rest } = props;
  return (
    <textarea
      {...rest}
      className={cn(
        'w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50',
        className,
      )}
    />
  );
}
