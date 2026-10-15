'use client';

/**
 * "עמדות מזומן" — the small parts the list, the station page and the device card share: the state pill, a
 * tone badge, who may do what, and the confirm dialog every maintenance action goes through.
 */

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { stationPillOf, stationPillTone, type CashStation, type Tone } from '@/lib/cashStations';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  info: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  warn: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  bad: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  muted: 'bg-muted text-muted-foreground',
};

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  info: 'text-sky-700 dark:text-sky-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-destructive',
  muted: 'text-muted-foreground',
};

export function ToneBadge({ tone, children, title, className }: { tone: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONE_CLASS[tone], className)}
    >
      {children}
    </span>
  );
}

/** The station's state ("מוכנה", "תפוסה", "תקלה"…) with its reason when the host gave one. */
export function StationPill({ station, withReason = true }: { station: Pick<CashStation, 'isActive' | 'host' | 'status'>; withReason?: boolean }) {
  const t = useTranslations('cashStations.pill');
  const pill = stationPillOf(station);
  const reason = station.status?.reason;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <ToneBadge tone={stationPillTone(pill)}>{t(pill)}</ToneBadge>
      {withReason && reason && pill !== 'ready' ? <span className="text-xs text-muted-foreground">{reason}</span> : null}
    </span>
  );
}

/** The roles that may see (and change) the stations: the kiosks' (pos-server kiosk_control.KIOSK_ROLES). */
const STATION_ROLES = ['super_admin', 'distributor', 'company_manager', 'shop_manager'];

/**
 * Who may do what — the server's own rules (dashboard_sections.py ROUTE_RULES): change a station or close an
 * owed item or assign a kiosk — `devices` at edit; send a command to its host — `devices` or `device_control`
 * at edit.
 */
export function useCashAccess(): { canEdit: boolean; canCommand: boolean; hydrated: boolean } {
  const role = useAuth((s) => s.user?.role ?? null);
  const hydrated = useAuth((s) => s.authHydrated);
  const access = useDashboardAccess();
  const roleOk = !!role && STATION_ROLES.includes(role);
  return {
    hydrated,
    canEdit: roleOk && canAccess(access, 'devices', 'edit'),
    canCommand: roleOk && (canAccess(access, 'devices', 'edit') || canAccess(access, 'device_control', 'edit')),
  };
}

/** "בטוח?" before an action that reaches the device or closes money: its title, what happens, and the button. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending,
  disabled,
  destructive,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  children?: ReactNode;
}) {
  const tc = useTranslations('common');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children ? <div className="space-y-3">{children}</div> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} disabled={disabled || pending} onClick={onConfirm}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A label above a value, as the device page's fields. */
export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-0.5', className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm font-medium">{children}</div>
    </div>
  );
}

/** A plain select (the native one: short lists of codes, inside forms and filters). */
export function NativeSelect({
  value,
  onChange,
  options,
  id,
  disabled,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  id?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30',
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
