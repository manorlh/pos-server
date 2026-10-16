'use client';

/**
 * "סוג רישיון" of a till / kiosk device (lib/deviceLicense.ts, pos-server app/services/device_license.py,
 * P:/specs/device-license-type.md): "קופה בלבד", "קיוסק בלבד" or "קיוסק + קופה (משולב)".
 *
 * * The add-device dialog picks it beside the role (`DeviceLicensePicker`, the role's default first).
 * * Lists show `DeviceLicenseBadge`; the machine page `DeviceLicenseValue` (with "שינוי סוג רישיון" for a
 *   super admin / distributor, `PUT /machines/{id}/license-product`) and `DeviceLicenseMismatchNote`.
 * * The machines page's "רישיונות מכשירים" (`LicenseCountsPanel`): active tills and kiosks per product,
 *   per organization / company / shop — for billing.
 * The server refuses whatever does not fit (a Hebrew `message`, shown as is).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, BadgeCheck, Loader2, Pencil } from 'lucide-react';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { deviceProfileErrorMessage } from '@/lib/deviceProfile';
import {
  LICENSE_PRODUCTS,
  licenseCountRows,
  licenseOptionsFor,
  licensedRoleOf,
  mayManageLicense,
  parseLicenseProduct,
  type LicenseCountsAnswer,
  type LicenseProduct,
} from '@/lib/deviceLicense';
import { formatDateTime } from '@/lib/format';
import type { PosMachine } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
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

/** Whether the signed-in user may set a license (a super admin; a distributor — the server checks their own). */
export function useMayManageLicense(): boolean {
  const role = useAuth((s) => s.user?.role ?? null);
  return mayManageLicense(role);
}

/** The products a role fits, each with its one line (the first is the role's default). */
export function DeviceLicensePicker({
  role,
  value,
  onChange,
  options,
  disabled,
}: {
  role: unknown;
  value: LicenseProduct | '';
  onChange: (next: LicenseProduct) => void;
  /** Override of the role's products (a role change: the new role's). */
  options?: readonly LicenseProduct[];
  disabled?: boolean;
}) {
  const t = useTranslations('machines.license');
  const offered = options ?? licenseOptionsFor(role);
  if (!offered.length) return null;
  const selected = value && offered.includes(value) ? value : offered[0];
  return (
    <div role="radiogroup" aria-label={t('label')} className="grid gap-2 sm:grid-cols-2">
      {offered.map((product, index) => {
        const on = selected === product;
        return (
          <button
            key={product}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(product)}
            className={cn(
              'flex items-start gap-2 rounded-lg border p-3 text-start transition-colors',
              on ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/60',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <BadgeCheck className={cn('mt-0.5 h-4 w-4 shrink-0', on ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
            <span>
              <span className="block text-sm font-medium">
                {t(`product.${product}`)}
                {index === 0 && !options ? <span className="ms-1 text-xs font-normal text-muted-foreground">({t('default')})</span> : null}
              </span>
              <span className="block text-xs text-muted-foreground">{t(`explain.${product}`)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** "קופה בלבד" / "קיוסק בלבד" / "קיוסק + קופה" on a list row; a warning when it does not fit the role. */
export function DeviceLicenseBadge({ m }: { m: Pick<PosMachine, 'licenseProduct' | 'licenseMismatch'> }) {
  const t = useTranslations('machines.license');
  const product = parseLicenseProduct(m.licenseProduct);
  if (!product) return null;
  if (m.licenseMismatch) {
    return (
      <Badge variant="outline" className="h-4 gap-0.5 border-amber-400 px-1 text-[10px] font-normal text-amber-800 dark:text-amber-300" title={t('mismatch')}>
        <AlertTriangle className="h-2.5 w-2.5" aria-hidden />
        {t(`short.${product}`)}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={cn(
        'h-4 px-1 text-[10px] font-normal',
        product === 'kiosk_till' ? 'border-primary/50 text-primary' : 'text-muted-foreground',
      )}
      title={`${t('label')}: ${t(`product.${product}`)}`}
    >
      {t(`short.${product}`)}
    </Badge>
  );
}

/** The machine page's "סוג רישיון": the product, who set it and when, and the change for an admin. */
export function DeviceLicenseValue({ machine, canEdit }: { machine: PosMachine; canEdit: boolean }) {
  const t = useTranslations('machines.license');
  const mayManage = useMayManageLicense();
  const [open, setOpen] = useState(false);
  const product = parseLicenseProduct(machine.licenseProduct);
  if (!product) return <span className="text-muted-foreground">—</span>;
  const last = (machine.licenseProductHistory ?? []).at(-1) ?? null;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="inline-flex flex-wrap items-center gap-1">
        {t(`product.${product}`)}
        {mayManage && canEdit ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => setOpen(true)}
            aria-label={t('change')}
            title={t('change')}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </Button>
        ) : null}
      </span>
      <span className="text-xs text-muted-foreground">
        {machine.licenseProductStored == null
          ? t('derived')
          : last
            ? t(last.source === 'pairing' ? 'pairedBy' : 'changedBy', {
                time: formatDateTime(last.at),
                name: last.byName ?? '—',
              })
            : t('derived')}
      </span>
      {open ? <DeviceLicenseDialog machine={machine} open={open} onOpenChange={setOpen} /> : null}
    </span>
  );
}

/** "סוג הרישיון לא תואם את התפקיד" — e.g. a kiosk code whose conversion failed at pairing. */
export function DeviceLicenseMismatchNote({ m }: { m: PosMachine }) {
  const t = useTranslations('machines.license');
  const tr = useTranslations('machines.deviceRole');
  const product = parseLicenseProduct(m.licenseProduct);
  if (!m.licenseMismatch || !product) return null;
  return (
    <p className="flex items-start gap-1.5 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      {t('mismatchHint', { product: t(`product.${product}`), role: tr(licensedRoleOf(m.deviceRole) ?? 'till') })}
    </p>
  );
}

export function DeviceLicenseDialog({
  machine,
  open,
  onOpenChange,
}: {
  machine: PosMachine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('machines.license');
  const tr = useTranslations('machines.deviceRole');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const role = licensedRoleOf(machine.deviceRole) ?? 'till';
  const current = parseLicenseProduct(machine.licenseProductStored ?? machine.licenseProduct);
  const [choice, setChoice] = useState<LicenseProduct | ''>(current ?? '');
  const [error, setError] = useState<string | null>(null);
  const offered = licenseOptionsFor(role);
  const chosen = choice && offered.includes(choice) ? choice : offered[0];
  const unchanged = chosen === parseLicenseProduct(machine.licenseProductStored);

  const save = useMutation({
    mutationFn: () => api.put(`/machines/${machine.id}/license-product`, { licenseProduct: chosen }).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['machines'] });
      void qc.invalidateQueries({ queryKey: ['machine', machine.id] });
      void qc.invalidateQueries({ queryKey: ['kiosks'] });
      void qc.invalidateQueries({ queryKey: ['license-counts'] });
      toast.success(t('saved'));
      onOpenChange(false);
    },
    onError: (err) => setError(deviceProfileErrorMessage(err) ?? axiosErrorToToastMessage(err, tc('error'))),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('changeTitle')}</DialogTitle>
          <DialogDescription>{t('changeDesc', { role: tr(role) })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <DeviceLicensePicker
            role={role}
            value={chosen}
            onChange={(next) => {
              setChoice(next);
              setError(null);
            }}
          />
          <p className="text-xs text-muted-foreground">{t('hint')}</p>
          {error ? (
            <p role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button disabled={unchanged || save.isPending} title={unchanged ? t('noChange') : undefined} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            {tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "רישיונות מכשירים": active tills and kiosks per product, per organization / company / shop (billing). */
export function LicenseCountsPanel() {
  const t = useTranslations('machines.license');
  const role = useAuth((s) => s.user?.role ?? null);
  const [open, setOpen] = useState(false);
  const [allTenants, setAllTenants] = useState(false);
  const counts = useQuery({
    queryKey: ['license-counts', allTenants],
    queryFn: () =>
      api
        .get<LicenseCountsAnswer>('/machines/license-products/counts', { params: allTenants ? { allTenants: true } : {} })
        .then((r) => r.data),
    enabled: open && mayManageLicense(role),
  });
  if (!mayManageLicense(role)) return null;
  const rows = licenseCountRows(counts.data);
  return (
    <div className="rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t('countsTitle')}</span>
        <span className="text-xs text-muted-foreground">{t('countsHint')}</span>
        <Button size="sm" variant="outline" className="ms-auto" onClick={() => setOpen((v) => !v)}>
          {open ? t('countsHide') : t('countsShow')}
        </Button>
      </div>
      {open ? (
        <div className="mt-3 space-y-2">
          {role === 'super_admin' ? (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={allTenants} onChange={(e) => setAllTenants(e.target.checked)} />
              {t('countsAllTenants')}
            </label>
          ) : null}
          {counts.isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
          ) : counts.isError ? (
            <p className="text-sm text-destructive">{deviceProfileErrorMessage(counts.error) ?? axiosErrorToToastMessage(counts.error, '')}</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('countsEmpty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="px-2 py-1 text-start font-normal">{t('countsName')}</th>
                    {LICENSE_PRODUCTS.map((p) => (
                      <th key={p} className="px-2 py-1 text-end font-normal">
                        {t(`short.${p}`)}
                      </th>
                    ))}
                    <th className="px-2 py-1 text-end font-normal">{t('countsTotal')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key} className={cn('border-b last:border-0', row.level === 'tenant' && 'bg-muted/40 font-medium')}>
                      <td className={cn('px-2 py-1', row.level === 'company' && 'ps-4', (row.level === 'shop' || row.level === 'unassigned') && 'ps-8')}>
                        {row.level === 'unassigned' ? (
                          <span className="text-muted-foreground">{t('countsUnassigned')}</span>
                        ) : (
                          <>
                            <span className="me-1 text-xs text-muted-foreground">{t(`level.${row.level}`)}</span>
                            {row.name ?? '—'}
                          </>
                        )}
                      </td>
                      {LICENSE_PRODUCTS.map((p) => (
                        <td key={p} className="px-2 py-1 text-end tabular-nums">
                          {row.counts[p]}
                        </td>
                      ))}
                      <td className="px-2 py-1 text-end font-medium tabular-nums">{row.counts.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
