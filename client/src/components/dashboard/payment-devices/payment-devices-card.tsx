'use client';

/**
 * "מכשירי תשלום" of one shop, on the till-settings page ("אמצעי תשלום") when a shop is in
 * scope:
 *
 * - the shop's switch "עבודה עם כמה מכשירי תשלום" (on / off / as the company), saved at once;
 * - "אופן בחירת המכשיר" — the default for the shop's tills: a fixed device, or a group to choose
 *   from (none ticked = every device of the shop); saved with its own button;
 * - what each till of the shop uses now (its effective mode and devices; "סליקה מובנית — לא
 *   רלוונטי" for one with its own clearing), with its settings one click away;
 * - the devices — nickname, kind, where, active — with add / edit / delete.
 *
 * Everything reaches the shop's tills on their next pull (the server wakes them).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Settings2, Trash2 } from 'lucide-react';
import { patchShopSettings } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  choiceDraftOf,
  choiceError,
  choicePatch,
  connectionSummary,
  deviceServerError,
  sameChoice,
  sortDevices,
  tillSummary,
  triStateOf,
  triStateValue,
  type DeviceChoiceDraft,
  type DeviceServerError,
  type PaymentDevice,
  type PaymentDeviceInput,
  type PaymentDeviceMachine,
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
import { EntityPosSettingsDialog } from '@/components/dashboard/entity-settings-dialog';
import { PaymentDeviceDialog } from '@/components/dashboard/payment-devices/payment-device-dialog';
import { DeviceChoiceEditor } from '@/components/dashboard/payment-devices/device-choice-editor';
import { cn } from '@/lib/utils';

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
  const [tillSettings, setTillSettings] = useState<string | null>(null);

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
    mutationFn: (patch: {
      multiPaymentDevices?: boolean | null;
      paymentDeviceMode?: 'fixed' | 'group' | null;
      fixedPaymentDeviceId?: string | null;
      paymentDeviceGroup?: string[] | null;
    }) => patchShopSettings(shopId, patch),
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
      <CardContent className="space-y-5">
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
            <ShopChoice
              key={`${page.paymentDeviceMode}:${page.fixedPaymentDeviceId}:${(page.paymentDeviceGroup ?? ['-']).join(',')}`}
              page={page}
              saving={saveShop.isPending}
              onSave={(draft) => saveShop.mutate(choicePatch(draft))}
            />
            <TillsSummary page={page} onOpen={(id) => setTillSettings(id)} />
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
            {/* One till's own settings (its switch and device choice among them). */}
            <EntityPosSettingsDialog
              level="machine"
              entityId={tillSettings}
              open={!!tillSettings}
              onOpenChange={(open) => {
                if (!open) {
                  setTillSettings(null);
                  void refresh();
                }
              }}
            />
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

/** "אופן בחירת המכשיר" at the shop: the default for its tills, saved with its own button. */
function ShopChoice({
  page,
  saving,
  onSave,
}: {
  page: ShopPaymentDevices;
  saving: boolean;
  onSave: (draft: DeviceChoiceDraft) => void;
}) {
  const t = useTranslations('paymentDevices');
  const stored = choiceDraftOf({
    paymentDeviceMode: page.paymentDeviceMode,
    fixedPaymentDeviceId: page.fixedPaymentDeviceId,
    paymentDeviceGroup: page.paymentDeviceGroup,
  });
  const [draft, setDraft] = useState<DeviceChoiceDraft>(stored);
  const devices = sortDevices(page.devices);
  const error = choiceError(draft, null, devices.map((d) => d.id));
  const dirty = !sameChoice(draft, stored);
  return (
    <div className="max-w-xl space-y-2 rounded-lg border p-3">
      <DeviceChoiceEditor
        level="shop"
        draft={draft}
        onChange={setDraft}
        devices={devices}
        inherited={null}
        disabled={!page.canEdit || saving}
      />
      <p className="text-muted-foreground text-xs">{t('modeShopHint')}</p>
      {page.canEdit ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={!dirty || !!error || saving} onClick={() => onSave(draft)}>
            {t('choiceSave')}
          </Button>
          <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={() => setDraft(stored)}>
            {t('choiceDiscard')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** One line per till: what it uses now, and its settings. */
function TillsSummary({ page, onOpen }: { page: ShopPaymentDevices; onOpen: (machineId: string) => void }) {
  const t = useTranslations('paymentDevices');
  const describe = (m: PaymentDeviceMachine): string => {
    const s = tillSummary(m, page.devices);
    const name = (d: PaymentDevice) => (d.active ? d.nickname : `${d.nickname} ${t('inactiveSuffix')}`);
    switch (s.state) {
      case 'builtin':
        return t('summaryBuiltin');
      case 'off':
        return t('summaryOff');
      case 'fixed':
        return t('summaryFixed', { name: name(s.devices[0]) });
      case 'fixed_missing':
        return t('summaryFixedMissing');
      case 'group_all':
        return t('summaryGroupAll');
      default:
        return t('summaryGroup', { names: s.devices.map(name).join(', ') });
    }
  };
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{t('tillsTitle')}</h3>
      {page.machines.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('tillsEmpty')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {page.machines.map((m) => {
            const state = tillSummary(m, page.devices).state;
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="font-medium">{m.name}</span>
                {m.ownChoice ? (
                  <Badge variant="outline" className="text-xs">
                    {t('tillOwn')}
                  </Badge>
                ) : null}
                <span
                  className={cn(
                    'min-w-0 flex-1 text-xs',
                    state === 'fixed_missing' ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {describe(m)}
                </span>
                {page.canEdit && !m.hasBuiltinTerminal ? (
                  <Button size="sm" variant="ghost" onClick={() => onOpen(m.id)}>
                    <Settings2 className="h-4 w-4" /> {t('tillSettings')}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
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
                <TableHead>{t('columns.status')}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.map((d) => {
                const key = d.kind === 'synqpay' ? d.secrets?.synqpayApiKey : null;
                return (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.nickname}</TableCell>
                    <TableCell>{t(`kinds.${d.kind}`)}</TableCell>
                    <TableCell>
                      <span dir="ltr" className="font-mono text-xs">
                        {connectionSummary(d)}
                      </span>
                      {key ? (
                        <span
                          className={cn(
                            'ms-2 text-xs',
                            key.rejectedAt ? 'text-destructive' : key.set ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400',
                          )}
                        >
                          {key.rejectedAt ? t('keyRejected') : key.set ? t('secretSet') : t('notPaired')}
                        </span>
                      ) : null}
                    </TableCell>
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
