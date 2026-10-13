'use client';

/**
 * "בקשות אישור מרחוק" on an employee's card (P:\specs\manager-approval-mobile.md §4, "עקיפה
 * לעובד מסוים"): for all request types, and optionally per type — "רשאי לאשר גם כשאינו במשמרת",
 * a personal ceiling and "לא מקבל בקשות". Empty = as the employee's till role says.
 * `GET/PUT /shops/{shopId}/pos-users/{posUserId}/approval-overrides`; the types come from the
 * catalogue (`GET /approvals/catalog`).
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  EMPTY_OVERRIDE_DRAFT,
  apiErrorOf,
  limitKeyOf,
  overrideDraftErrors,
  overrideDraftOf,
  overridesBody,
  type ApprovalOverrides,
  type CatalogType,
  type LimitUnit,
  type OverrideDraft,
} from '@/lib/approvals';
import { fetchApprovalCatalog, fetchApprovalOverrides, saveApprovalOverrides } from '@/lib/approvalsApi';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

const NATIVE_SELECT =
  'border-input bg-background h-9 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export interface OverridesTarget {
  shopId: string;
  posUserId: string;
  name: string;
}

export function ApprovalOverridesDialog({ target, onClose }: { target: OverridesTarget | null; onClose: () => void }) {
  const t = useTranslations('approvals.overrides');
  const open = target !== null;
  const data = useQuery({
    queryKey: ['approvals', 'overrides', target?.shopId ?? null, target?.posUserId ?? null],
    queryFn: () => fetchApprovalOverrides(target?.shopId ?? '', target?.posUserId ?? ''),
    enabled: open,
    retry: false,
  });
  const catalog = useQuery({ queryKey: ['approvals', 'catalog'], queryFn: fetchApprovalCatalog, enabled: open, staleTime: 60 * 60_000, retry: false });

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title', { name: target?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('hint')}</DialogDescription>
        </DialogHeader>
        {data.isLoading || catalog.isLoading ? (
          <Loader2 className="mx-auto size-5 animate-spin" aria-hidden />
        ) : data.isError || !data.data ? (
          <p className="text-destructive text-sm" role="alert">
            {apiErrorOf(data.error).status === 403 ? t('noPermission') : t('loadFailed')}
          </p>
        ) : target ? (
          <OverridesForm
            key={JSON.stringify(data.data)}
            target={target}
            initial={data.data}
            types={catalog.data?.types ?? []}
            onDone={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function OverridesForm({
  target,
  initial,
  types,
  onDone,
}: {
  target: OverridesTarget;
  initial: ApprovalOverrides;
  types: CatalogType[];
  onDone: () => void;
}) {
  const t = useTranslations('approvals.overrides');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [all, setAll] = useState<OverrideDraft>(() => overrideDraftOf(initial.all));
  const [byType, setByType] = useState<Record<string, OverrideDraft>>(() =>
    Object.fromEntries(Object.entries(initial.types ?? {}).map(([k, v]) => [k, overrideDraftOf(v)])),
  );
  const [adding, setAdding] = useState('');
  const typeOf = useMemo(() => new Map(types.map((x) => [x.key, x])), [types]);
  const free = types.filter((x) => !(x.key in byType));
  const invalid = overrideDraftErrors(all).length > 0 || Object.values(byType).some((d) => overrideDraftErrors(d).length > 0);

  const save = useMutation({
    mutationFn: () => saveApprovalOverrides(target.shopId, target.posUserId, overridesBody(all, byType)),
    onSuccess: (next) => {
      toast.success(t('saved'));
      qc.setQueryData(['approvals', 'overrides', target.shopId, target.posUserId], next);
      onDone();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('saveFailed'))),
  });

  return (
    <div className="space-y-4">
      <section className="space-y-2 rounded-xl border p-3">
        <h3 className="text-sm font-semibold">{t('all')}</h3>
        <OverrideFields idPrefix="all" draft={all} onChange={setAll} units={['amount', 'percent', 'count']} />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t('perType')}</h3>
        {Object.keys(byType).length === 0 ? <p className="text-muted-foreground text-xs">{t('noTypes')}</p> : null}
        {Object.entries(byType).map(([key, draft]) => {
          const type = typeOf.get(key);
          return (
            <div key={key} className="space-y-2 rounded-xl border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{type?.label ?? key}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={t('removeType', { type: type?.label ?? key })}
                  onClick={() =>
                    setByType((prev) => {
                      const next = { ...prev };
                      delete next[key];
                      return next;
                    })
                  }
                >
                  <Trash2 className="text-destructive size-4" aria-hidden />
                </Button>
              </div>
              <OverrideFields
                idPrefix={key}
                draft={draft}
                onChange={(d) => setByType((prev) => ({ ...prev, [key]: d }))}
                units={type?.limitUnit ? [type.limitUnit] : []}
              />
            </div>
          );
        })}
        {free.length ? (
          <div className="flex items-center gap-2">
            <select
              className={NATIVE_SELECT}
              aria-label={t('chooseType')}
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
            >
              <option value="">{t('chooseType')}</option>
              {free.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              className="h-9 shrink-0"
              disabled={!adding}
              onClick={() => {
                setByType((prev) => ({ ...prev, [adding]: EMPTY_OVERRIDE_DRAFT }));
                setAdding('');
              }}
            >
              <Plus className="size-4" aria-hidden />
              {t('addType')}
            </Button>
          </div>
        ) : null}
      </section>

      {invalid ? <p className="text-destructive text-xs">{t('invalid')}</p> : null}
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          {tc('cancel')}
        </Button>
        <Button onClick={() => save.mutate()} disabled={invalid || save.isPending}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </DialogFooter>
    </div>
  );
}

function OverrideFields({
  idPrefix,
  draft,
  onChange,
  units,
}: {
  idPrefix: string;
  draft: OverrideDraft;
  onChange: (next: OverrideDraft) => void;
  /** The ceilings this row offers: all three for "all types", the type's own unit otherwise. */
  units: LimitUnit[];
}) {
  const t = useTranslations('approvals.overrides');
  const bad = new Set(overrideDraftErrors(draft));
  return (
    <div className="space-y-2">
      <label className="flex min-h-9 items-center justify-between gap-3 text-sm">
        {t('offShift')}
        <Switch checked={draft.offShift} onCheckedChange={(v) => onChange({ ...draft, offShift: v })} aria-label={t('offShift')} />
      </label>
      <label className="flex min-h-9 items-center justify-between gap-3 text-sm">
        {t('noRequests')}
        <Switch checked={draft.noRequests} onCheckedChange={(v) => onChange({ ...draft, noRequests: v })} aria-label={t('noRequests')} />
      </label>
      {units.map((unit) => {
        const key = limitKeyOf(unit);
        if (!key) return null;
        const id = `override-${idPrefix}-${key}`;
        return (
          <div key={key} className="flex items-center justify-between gap-3 text-sm">
            <label htmlFor={id}>{t(`ceiling.${unit}`)}</label>
            <Input
              id={id}
              inputMode="decimal"
              className="h-9 w-28"
              value={draft[key]}
              placeholder={t('asRole')}
              aria-invalid={bad.has(key)}
              onChange={(e) => onChange({ ...draft, [key]: e.target.value })}
            />
          </div>
        );
      })}
    </div>
  );
}
