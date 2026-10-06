'use client';

/**
 * "מסכי KDS": a till of the shop set up as a kitchen screen — a station screen (its
 * stations' tasks), the Expo, the pickup screen or the kitchen manager. Such a till
 * shows that screen instead of the sale screen (pos-server SPEC_KDS.md §3, §9).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import {
  KDS_ROLES,
  deleteDevice,
  saveDevice,
  type KdsDevice,
  type KdsDeviceInput,
  type KdsRole,
  type KdsShopMachine,
  type KdsShopOverview,
} from '@/lib/kdsApi';
import { errorCodeOf } from '@/lib/workflowMode';
import { cn } from '@/lib/utils';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function useKdsErrorText() {
  const tk = useTranslations('kds');
  const tc = useTranslations('common');
  return (err: unknown) => {
    const code = errorCodeOf(err);
    return code && tk.has(`errors.${code}`) ? tk(`errors.${code}`) : axiosErrorToToastMessage(err, tc('error'));
  };
}

/** "קופה 2 (קופה 2)" — the till's name with its register number. */
function useTillLabel() {
  const t = useTranslations('kds.page.devices');
  return (m: KdsShopMachine | undefined) => {
    if (!m) return t('unknownTill');
    return m.posNumber ? t('tillWithNumber', { name: m.name, n: String(m.posNumber) }) : m.name;
  };
}

export function DevicesSection({ shopId, overview }: { shopId: string; overview: KdsShopOverview }) {
  const t = useTranslations('kds.page.devices');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useKdsErrorText();
  const tillLabel = useTillLabel();
  const [dialog, setDialog] = useState<{ device: KdsDevice | null } | null>(null);

  const machines = new Map(overview.machines.map((m) => [m.id, m]));
  const used = new Set(overview.devices.map((d) => d.machineId).filter((id): id is string => !!id));
  const free = overview.machines.filter((m) => !used.has(m.id));

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['kds-shop', shopId] });
    qc.invalidateQueries({ queryKey: ['kds-board', shopId] });
  };

  const remove = useMutation({
    mutationFn: (machineId: string) => deleteDevice(shopId, machineId),
    onSuccess: () => {
      toast.success(t('deleted'));
      refresh();
    },
    onError: (err: unknown) => toast.error(errorText(err)),
  });

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        {overview.canEdit ? (
          <Button size="sm" disabled={free.length === 0} onClick={() => setDialog({ device: null })}>
            <Plus className="h-4 w-4" /> {t('add')}
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{t('hint')}</p>
      {overview.canEdit && free.length === 0 && overview.machines.length > 0 ? (
        <p className="text-xs text-muted-foreground">{t('noFreeTills')}</p>
      ) : null}

      {overview.devices.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">{t('empty')}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.name')}</TableHead>
                <TableHead>{t('columns.till')}</TableHead>
                <TableHead>{t('columns.role')}</TableHead>
                <TableHead>{t('columns.stations')}</TableHead>
                <TableHead>{tc('status')}</TableHead>
                <TableHead>{t('columns.lastSeen')}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.devices.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.name}</TableCell>
                  <TableCell>{tillLabel(d.machineId ? machines.get(d.machineId) : undefined)}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{t(`roles.${d.role}`)}</Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {d.role === 'station'
                      ? d.stations.map((s) => s.name).join(' · ') || '—'
                      : t('allStations')}
                  </TableCell>
                  <TableCell>
                    <Badge variant={d.isActive ? 'secondary' : 'outline'}>
                      {d.isActive ? tc('active') : tc('inactive')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {d.lastSeenAt ? formatDateTime(d.lastSeenAt) : t('never')}
                  </TableCell>
                  <TableCell>
                    {overview.canEdit && d.machineId ? (
                      <div className="flex gap-1">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={tc('edit')}
                          onClick={() => setDialog({ device: d })}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={tc('delete')}
                          disabled={remove.isPending}
                          onClick={() => {
                            if (window.confirm(t('confirmDelete', { name: d.name }))) remove.mutate(d.machineId as string);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {dialog ? (
        <DeviceDialog
          key={dialog.device?.id ?? 'new'}
          shopId={shopId}
          overview={overview}
          device={dialog.device}
          freeMachines={free}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function DeviceDialog({
  shopId,
  overview,
  device,
  freeMachines,
  onClose,
  onSaved,
}: {
  shopId: string;
  overview: KdsShopOverview;
  device: KdsDevice | null;
  freeMachines: KdsShopMachine[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('kds.page.devices');
  const td = useTranslations('kds.page.devices.dialog');
  const tc = useTranslations('common');
  const errorText = useKdsErrorText();
  const tillLabel = useTillLabel();

  const [machineId, setMachineId] = useState(device?.machineId ?? (freeMachines.length === 1 ? freeMachines[0].id : ''));
  const [name, setName] = useState(device?.name ?? '');
  const [role, setRole] = useState<KdsRole>(device?.role ?? 'station');
  const [stationIds, setStationIds] = useState<string[]>(device?.stations.map((s) => s.id) ?? []);
  const [isActive, setIsActive] = useState(device?.isActive ?? true);

  const needsStation = role === 'station' && stationIds.length === 0;
  const valid = !!machineId && !needsStation;

  const save = useMutation({
    mutationFn: (body: KdsDeviceInput) => saveDevice(shopId, machineId, body),
    onSuccess: () => {
      toast.success(t('saved'));
      onSaved();
    },
    onError: (err: unknown) => toast.error(errorText(err)),
  });

  const machineOptions = (device ? overview.machines.filter((m) => m.id === device.machineId) : freeMachines).map(
    (m) => ({ value: m.id, label: tillLabel(m) }),
  );

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{device ? td('editTitle') : td('addTitle')}</DialogTitle>
          <DialogDescription>{td('tillWarning')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{td('till')}</Label>
            <Select
              value={machineId || null}
              onValueChange={(v) => setMachineId(v ? String(v) : '')}
              items={machineOptions}
              disabled={!!device}
            >
              <SelectTrigger className="h-10" aria-label={td('till')}>
                <SelectValue placeholder={td('chooseTill')} />
              </SelectTrigger>
              <SelectContent>
                {machineOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value} label={o.label}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="kds-device-name">{td('name')}</Label>
            <Input
              id="kds-device-name"
              className="h-10"
              value={name}
              maxLength={100}
              placeholder={td('namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{td('role')}</Label>
            <div role="radiogroup" aria-label={td('role')} className="grid grid-cols-2 gap-2">
              {KDS_ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={role === r}
                  onClick={() => setRole(r)}
                  className={cn(
                    'min-h-11 rounded-lg border-2 px-3 py-2 text-start transition-colors',
                    role === r ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
                  )}
                >
                  <span className="block text-sm font-medium">{t(`roles.${r}`)}</span>
                  <span className="block text-xs text-muted-foreground">{t(`roleHints.${r}`)}</span>
                </button>
              ))}
            </div>
          </div>

          {role === 'station' ? (
            <div className="space-y-1.5">
              <Label>{td('stations')}</Label>
              {overview.stations.length === 0 ? (
                <p className="text-sm text-muted-foreground">{td('noStations')}</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {overview.stations.map((s) => {
                    const checked = stationIds.includes(s.id);
                    return (
                      <label
                        key={s.id}
                        className={cn(
                          'flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border-2 px-3',
                          checked ? 'border-primary/70 bg-primary/5' : 'border-border',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="h-5 w-5 accent-primary"
                          checked={checked}
                          onChange={(e) =>
                            setStationIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id)))
                          }
                        />
                        <span className="text-sm">{s.name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              {needsStation ? <p className="text-xs text-destructive">{td('stationsRequired')}</p> : null}
            </div>
          ) : null}

          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3">
            <span className="text-sm font-medium">{td('active')}</span>
            <Switch checked={isActive} onCheckedChange={setIsActive} aria-label={td('active')} />
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button
            disabled={!valid || save.isPending}
            onClick={() =>
              save.mutate({
                name: name.trim() || null,
                role,
                stationIds: role === 'station' ? stationIds : [],
                isActive,
              })
            }
          >
            {save.isPending ? tc('saving') : tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
