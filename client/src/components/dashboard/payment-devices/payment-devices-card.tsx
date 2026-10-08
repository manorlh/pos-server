'use client';

/**
 * "מכשירי תשלום" of one shop, on the till-settings page ("אמצעי תשלום") when a shop is in
 * scope: the shop's switch "עבודה עם כמה מכשירי תשלום" (on / off / as the company), its
 * default device, and the devices — nickname, kind, where, which tills, active — with add /
 * edit / delete. Each write is saved at once and reaches the shop's tills on their next pull
 * (the server wakes them). A single till's own switch and default are in its settings dialog.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { patchShopSettings } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  connectionSummary,
  deviceServerError,
  deviceTillNames,
  sortDevices,
  triStateOf,
  triStateValue,
  type DeviceServerError,
  type PaymentDevice,
  type PaymentDeviceInput,
  type ShopPaymentDevices,
  type TriState,
} from '@/lib/paymentDevices';
import {
  createPaymentDevice,
  deletePaymentDevice,
  fetchShopPaymentDevices,
  shopPaymentDevicesKey,
  updatePaymentDevice,
} from '@/lib/paymentDevicesApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SimpleSelect } from '@/components/dashboard/kitchen-printers/printer-dialog';
import { PaymentDeviceDialog } from '@/components/dashboard/payment-devices/payment-device-dialog';
import { cn } from '@/lib/utils';

const NONE = '__none__';

export function PaymentDevicesCard({ shopId }: { shopId: string }) {
  const t = useTranslations('paymentDevices');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const queryKey = shopPaymentDevicesKey(shopId);
  const { data: page, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => fetchShopPaymentDevices(shopId),
    enabled: !!shopId,
  });

  const [dialog, setDialog] = useState<{ device: PaymentDevice | null } | null>(null);
  const [serverError, setServerError] = useState<DeviceServerError | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['payment-devices'] });

  const save = useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: PaymentDeviceInput }) =>
      id ? updatePaymentDevice(id, body) : createPaymentDevice(shopId, body),
    onSuccess: (_d, vars) => {
      toast.success(vars.id ? t('updated') : t('created'));
      setDialog(null);
      setServerError(null);
      void refresh();
    },
    onError: (err: unknown) => {
      const known = deviceServerError(err);
      if (known) setServerError(known);
      else toast.error(axiosErrorToToastMessage(err, tc('error')));
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deletePaymentDevice(id),
    onSuccess: () => {
      toast.success(t('deleted'));
      void refresh();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const saveShop = useMutation({
    mutationFn: (patch: { multiPaymentDevices?: boolean | null; defaultPaymentDeviceId?: string | null }) =>
      patchShopSettings(shopId, patch),
    onSuccess: () => {
      toast.success(t('saved'));
      void refresh();
    },
    onError: (err: unknown) => {
      const known = deviceServerError(err);
      toast.error(known?.msg ?? axiosErrorToToastMessage(err, tc('error')));
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <p className="text-muted-foreground text-xs">{t('explain')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isError ? (
          <p className="text-sm text-destructive">{t('loadError')}</p>
        ) : isLoading || !page ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <>
            {!page.canEdit ? <p className="text-xs text-amber-600 dark:text-amber-400">{t('readOnly')}</p> : null}
            <ShopSwitch
              page={page}
              disabled={!page.canEdit || saveShop.isPending}
              onChange={(state) => saveShop.mutate({ multiPaymentDevices: triStateValue(state) })}
            />
            <ShopDefault
              page={page}
              disabled={!page.canEdit || saveShop.isPending}
              onChange={(id) => saveShop.mutate({ defaultPaymentDeviceId: id })}
            />
            <DevicesTable
              page={page}
              onEdit={(device) => {
                setServerError(null);
                setDialog({ device });
              }}
              onDelete={(device) => {
                if (window.confirm(t('confirmDelete', { name: device.nickname }))) remove.mutate(device.id);
              }}
              busy={remove.isPending}
            />
            {page.canEdit ? (
              <Button
                size="sm"
                onClick={() => {
                  setServerError(null);
                  setDialog({ device: null });
                }}
              >
                <Plus className="ms-1 h-4 w-4" /> {t('add')}
              </Button>
            ) : null}
            {dialog ? (
              <PaymentDeviceDialog
                key={dialog.device?.id ?? 'new'}
                device={dialog.device}
                page={page}
                saving={save.isPending}
                serverError={serverError}
                onClose={() => {
                  setDialog(null);
                  setServerError(null);
                }}
                onSave={(body) => save.mutate({ id: dialog.device?.id ?? null, body })}
              />
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** On / off / as the company: the shop's own `multiPaymentDevices`. */
function ShopSwitch({
  page,
  disabled,
  onChange,
}: {
  page: ShopPaymentDevices;
  disabled: boolean;
  onChange: (state: TriState) => void;
}) {
  const t = useTranslations('paymentDevices');
  const own = triStateOf(page.multiPaymentDevices);
  const inherited = page.multiPaymentDevicesInherited;
  const source = page.multiPaymentDevicesInheritedSource;
  const choices: Array<{ v: TriState; label: string }> = [
    { v: 'on', label: t('switchOn') },
    { v: 'off', label: t('switchOff') },
    { v: 'inherit', label: t('switchInheritCompany') },
  ];
  return (
    <div className="space-y-1">
      <Label>{t('switchLabel')}</Label>
      <div role="radiogroup" aria-label={t('switchLabel')} className="flex w-full max-w-md rounded-md border bg-muted/40 p-0.5">
        {choices.map((c) => {
          const selected = own === c.v;
          return (
            <button
              key={c.v}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => !selected && onChange(c.v)}
              className={cn(
                'min-h-9 flex-1 rounded px-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                selected
                  ? cn('bg-background font-medium shadow-sm', c.v === 'off' ? 'text-destructive' : 'text-primary')
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      {own === 'inherit' ? (
        <p className="text-muted-foreground text-xs">
          {typeof inherited === 'boolean' && source
            ? t('inheritedState', {
                state: inherited ? t('switchOn') : t('switchOff'),
                source: t(`sources.${source}`),
              })
            : t('inheritedDefault')}
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">{t('switchHint')}</p>
    </div>
  );
}

/** The shop's default device ("ללא" = none set at the shop). */
function ShopDefault({
  page,
  disabled,
  onChange,
}: {
  page: ShopPaymentDevices;
  disabled: boolean;
  onChange: (id: string | null) => void;
}) {
  const t = useTranslations('paymentDevices');
  const devices = sortDevices(page.devices);
  const current = page.defaultPaymentDeviceId;
  const options = [
    { value: NONE, label: t('defaultNone') },
    ...devices.map((d) => ({ value: d.id, label: d.active ? d.nickname : `${d.nickname} (${t('inactive')})` })),
  ];
  if (current && !devices.some((d) => d.id === current)) options.push({ value: current, label: t('defaultUnknown') });
  return (
    <div className="max-w-md space-y-1">
      <Label>{t('defaultDevice')}</Label>
      <SimpleSelect
        value={current ?? NONE}
        onChange={(v) => {
          const next = v === NONE ? null : v;
          if (next !== current) onChange(next);
        }}
        options={options}
        disabled={disabled || devices.length === 0}
        ariaLabel={t('defaultDevice')}
      />
      <p className="text-muted-foreground text-xs">{t('defaultDeviceHint')}</p>
    </div>
  );
}

function DevicesTable({
  page,
  onEdit,
  onDelete,
  busy,
}: {
  page: ShopPaymentDevices;
  onEdit: (device: PaymentDevice) => void;
  onDelete: (device: PaymentDevice) => void;
  busy: boolean;
}) {
  const t = useTranslations('paymentDevices');
  const tc = useTranslations('common');
  const devices = sortDevices(page.devices);
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{t('devicesTitle')}</h3>
      {devices.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">{t('empty')}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.nickname')}</TableHead>
                <TableHead>{t('columns.kind')}</TableHead>
                <TableHead>{t('columns.connection')}</TableHead>
                <TableHead>{t('columns.tills')}</TableHead>
                <TableHead>{t('columns.status')}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.map((d) => {
                const names = deviceTillNames(d, page.machines);
                const secret =
                  d.kind === 'zcredit_pinpad' ? d.secrets?.zcreditPassword : d.kind === 'synqpay' ? d.secrets?.synqpayApiKey : null;
                return (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.nickname}</TableCell>
                    <TableCell>{t(`kinds.${d.kind}`)}</TableCell>
                    <TableCell>
                      <span dir="ltr" className="font-mono text-xs">
                        {connectionSummary(d)}
                      </span>
                      {secret !== null && secret !== undefined ? (
                        <span
                          className={cn(
                            'ms-2 text-xs',
                            secret.rejectedAt ? 'text-destructive' : secret.set ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400',
                          )}
                        >
                          {secret.rejectedAt
                            ? t('keyRejected')
                            : secret.set
                              ? t('secretSet')
                              : d.kind === 'synqpay'
                                ? t('notPaired')
                                : t('secretNotSet')}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">{names === null ? t('allTills') : names.join(', ') || '—'}</TableCell>
                    <TableCell>
                      <Badge variant={d.active ? 'secondary' : 'outline'}>{d.active ? t('active') : t('inactive')}</Badge>
                    </TableCell>
                    <TableCell>
                      {page.canEdit ? (
                        <div className="flex gap-1">
                          <Button size="icon-sm" variant="ghost" aria-label={tc('edit')} onClick={() => onEdit(d)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={tc('delete')}
                            disabled={busy}
                            onClick={() => onDelete(d)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
