'use client';

/**
 * The pieces every action sheet shares: the iOS sheet itself (a bottom sheet on a phone, a
 * centred card on a wide screen, dark with the system), grouped rows, the target picker
 * ("לאן"), the duration picker ("עד מתי"), and who may act.
 */

import { useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { fetchEvent } from '@/lib/eventsApi';
import {
  DURATION_CHOICES,
  targetKey,
  targetOptions,
  type ActionContext,
  type ActionScope,
  type DurationChoice,
  type TargetOption,
} from '@/lib/insightsActions';
import { fetchPromoProduct } from '@/lib/promotionsApi';
import { useScope } from '@/lib/scope';
import { cn } from '@/lib/utils';
import { useSystemDark } from '@/components/dashboard/control-board/board-ui';
import { SF_FONT, Segmented } from '@/components/dashboard/insights/ios';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** The roles that may act (the till messages' and the promotions' writers are the same four). */
const ACTION_ROLES = new Set(['super_admin', 'distributor', 'company_manager', 'shop_manager']);

/** Whether the signed-in user may run quick actions: the role, and "פעולות מהירות" at edit. */
export function useCanAct(): boolean {
  const role = useAuth((s) => s.user?.role);
  const access = useDashboardAccess();
  return !!role && ACTION_ROLES.has(role) && canAccess(access, 'quick_actions', 'edit');
}

export function ActionSheet({
  title,
  subtitle,
  children,
  footer,
  onClose,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  const dark = useSystemDark();
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className={cn(
          dark && 'dark',
          'max-h-[92dvh] gap-0 overflow-y-auto bg-[#F2F2F7] p-0 text-black dark:bg-[#1C1C1E] dark:text-white sm:max-w-lg',
        )}
        style={{ fontFamily: SF_FONT }}
      >
        <DialogHeader className="px-5 pt-5 pb-3 text-start">
          <DialogTitle className="text-[20px] font-bold tracking-tight">{title}</DialogTitle>
          {subtitle ? <DialogDescription className="text-[13px] text-[#8E8E93]">{subtitle}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-4 px-4 pb-4">{children}</div>
        {footer ? (
          <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-[#3C3C4349] bg-[#F2F2F7]/95 px-4 py-3 backdrop-blur dark:border-[#54545899] dark:bg-[#1C1C1E]/95">
            {footer}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** A grouped block: a small grey header and a white rounded card. */
export function SheetGroup({ label, hint, children }: { label?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section>
      {label ? <h3 className="mb-1.5 px-3 text-[13px] uppercase tracking-wide text-[#6D6D72] dark:text-[#8E8E93]">{label}</h3> : null}
      <div className="rounded-[14px] bg-white p-3 dark:bg-[#2C2C2E]">{children}</div>
      {hint ? <p className="mt-1.5 px-3 text-[12px] leading-snug text-[#8E8E93]">{hint}</p> : null}
    </section>
  );
}

export function PrimaryButton({ children, disabled, onClick, tone = 'blue' }: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  tone?: 'blue' | 'red' | 'green';
}) {
  const colors = {
    blue: 'bg-[#007AFF] dark:bg-[#0A84FF]',
    red: 'bg-[#FF3B30] dark:bg-[#FF453A]',
    green: 'bg-[#34C759] dark:bg-[#30D158]',
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn('min-h-11 rounded-xl px-5 text-[15px] font-semibold text-white active:opacity-70 disabled:opacity-40', colors[tone])}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="min-h-11 rounded-xl px-4 text-[15px] text-[#007AFF] active:opacity-60 disabled:opacity-40 dark:text-[#0A84FF]"
    >
      {children}
    </button>
  );
}

/** The names the target picker needs: the org lists of the scope bar, and the event. */
export function useTargets(scope: ActionScope, context?: ActionContext): TargetOption[] {
  const s = useScope();
  const event = useQuery({
    queryKey: ['event', scope.eventId],
    queryFn: () => fetchEvent(scope.eventId!),
    enabled: !!scope.eventId,
    staleTime: 300_000,
  });
  return useMemo(
    () =>
      targetOptions(scope, context, {
        companies: s.companies.map((c) => ({ id: c.id, name: c.name })),
        shops: s.shops.map((sh) => ({ id: sh.id, name: sh.name, companyId: sh.companyId })),
        machines: s.machines.map((m) => ({ id: m.id, name: m.name, shopId: m.shopId, areaId: m.areaId, areaName: m.areaName })),
        event: event.data ? { id: event.data.id, name: event.data.name } : null,
        areaName: s.machines.find((m) => m.areaId && m.areaId === scope.areaId)?.areaName ?? null,
      }),
    [context, event.data, s.companies, s.machines, s.shops, scope],
  );
}

export function TargetPicker({ options, value, onChange }: { options: TargetOption[]; value: string; onChange: (key: string) => void }) {
  const t = useTranslations('insightsActions.target');
  if (options.length === 0) return <p className="text-[15px] text-[#8E8E93]">{t('none')}</p>;
  return (
    <ul className="divide-y divide-[#3C3C4349] dark:divide-[#54545899]" role="radiogroup" aria-label={t('label')}>
      {options.slice(0, 12).map((o) => {
        const key = targetKey(o);
        const on = key === value;
        return (
          <li key={key}>
            <button
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(key)}
              className="flex min-h-11 w-full items-center justify-between gap-3 py-1.5 text-start"
            >
              <span className="min-w-0">
                <span className="block truncate text-[15px]">{o.name}</span>
                <span className="block text-[12px] text-[#8E8E93]">{t(`levels.${o.level}`)}</span>
              </span>
              <span
                aria-hidden
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
                  on ? 'border-[#007AFF] bg-[#007AFF] dark:border-[#0A84FF] dark:bg-[#0A84FF]' : 'border-[#C7C7CC]',
                )}
              >
                {on ? <span className="h-2 w-2 rounded-full bg-white" /> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function DurationPicker({
  value,
  onChange,
  untilDate,
  onUntilDate,
  minDate,
  maxDate,
}: {
  value: DurationChoice;
  onChange: (v: DurationChoice) => void;
  untilDate: string;
  onUntilDate: (v: string) => void;
  minDate: string;
  maxDate: string;
}) {
  const t = useTranslations('insightsActions.duration');
  return (
    <div className="space-y-2">
      <Segmented
        value={value}
        onChange={onChange}
        label={t('label')}
        options={DURATION_CHOICES.map((c) => ({ id: c, label: t(c) }))}
      />
      {value === 'until' ? (
        <label className="flex items-center justify-between gap-3 pt-1">
          <span className="text-[15px]">{t('untilDate')}</span>
          <DatePicker
            value={untilDate}
            min={minDate}
            max={maxDate}
            onChange={(e) => onUntilDate(e.target.value)}
            dir="ltr"
            className="w-40 shrink-0 text-[15px] text-[#007AFF]"
          />
        </label>
      ) : null}
    </div>
  );
}

/** A product's name (the pickers' cached look-up). */
export function useProductName(productId?: string): string | undefined {
  const q = useQuery({
    queryKey: ['promo-product', productId],
    queryFn: () => fetchPromoProduct(productId!),
    enabled: !!productId,
    staleTime: 300_000,
  });
  return q.data?.name;
}

export function NoPermission() {
  const t = useTranslations('insightsActions');
  return <p className="rounded-[14px] bg-white p-3 text-[15px] text-[#8E8E93] dark:bg-[#2C2C2E]">{t('noPermission')}</p>;
}

/** Today in the browser's calendar, "YYYY-MM-DD" (the server checks the real limits). */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
