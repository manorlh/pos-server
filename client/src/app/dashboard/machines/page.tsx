'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, fetchCloseDayRequest, postCloseDay } from '@/lib/api';
import { CloseDayRequest, PosMachine, Shop, Company } from '@/lib/types';
import { useAuth } from '@/lib/auth';
import { normalizePosMachine } from '@/lib/posMachine';
import { findBySameId } from '@/lib/entityLookup';
import { entitySelectItems } from '@/lib/selectItems';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Monitor, Wifi, WifiOff, Send, KeyRound, RefreshCw, Link2, Store, Info, Trash2, Smartphone, CalendarClock } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { QRCodeSVG } from 'qrcode.react';
import type { PairingSessionCreateResponse } from '@/lib/types';
import { he } from 'date-fns/locale';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const statusColor: Record<string, 'default' | 'secondary' | 'outline'> = {
  assigned: 'default',
  paired: 'secondary',
  unpaired: 'outline',
};

const MQTT_ONLINE_WINDOW_MS = 90 * 1000;

export default function MachinesPage() {
  const t = useTranslations('machines');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { user: me, authHydrated } = useAuth();
  const [pairOpen, setPairOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [pushTarget, setPushTarget] = useState<'machine' | 'shop'>('machine');
  const [selectedMachine, setSelectedMachine] = useState<PosMachine | null>(null);
  const [machineCode, setMachineCode] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairCompanyId, setPairCompanyId] = useState('');
  const [pairShopId, setPairShopId] = useState('');
  const [pairPreAssignLabel, setPairPreAssignLabel] = useState<string | null>(null);

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignShopId, setAssignShopId] = useState('');
  const [filterShopId, setFilterShopId] = useState<string>('all');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const [shopEditOpen, setShopEditOpen] = useState(false);
  const [editShopId, setEditShopId] = useState('');

  const [removeOpen, setRemoveOpen] = useState(false);
  const [fieldInstallOpen, setFieldInstallOpen] = useState(false);
  const [fieldSession, setFieldSession] = useState<PairingSessionCreateResponse | null>(null);
  const [fieldPairedCount, setFieldPairedCount] = useState(0);
  // Pre-checked when the dialog opens so the warning copy can tell the operator
  // upfront whether the row will be hard-deleted or only decommissioned.
  const [removeMachineHasHistory, setRemoveMachineHasHistory] = useState(false);

  const [closeDayOpen, setCloseDayOpen] = useState(false);
  const [closeDayTarget, setCloseDayTarget] = useState<'machine' | 'shop'>('machine');
  const [selectedMachineIds, setSelectedMachineIds] = useState<Set<string>>(new Set());
  const [closeProgressOpen, setCloseProgressOpen] = useState(false);
  const [closeProgressRequestId, setCloseProgressRequestId] = useState<string | null>(null);
  const [closeProgressData, setCloseProgressData] = useState<CloseDayRequest | null>(null);

  const canAssignMachine =
    authHydrated && (me?.role === 'distributor' || me?.role === 'super_admin');
  const canEditAssignedShop =
    authHydrated &&
    (me?.role === 'company_manager' || me?.role === 'distributor' || me?.role === 'super_admin');
  const canRemoveMachine =
    authHydrated && (me?.role === 'distributor' || me?.role === 'super_admin');
  const canCloseDay =
    authHydrated &&
    (me?.role === 'company_manager' ||
      me?.role === 'shop_manager' ||
      me?.role === 'distributor' ||
      me?.role === 'super_admin');
  const showAssignHelp =
    authHydrated && (me?.role === 'super_admin' || me?.role === 'distributor');

  const { data: machines = [], isLoading } = useQuery<PosMachine[]>({
    queryKey: ['machines'],
    queryFn: async () => {
      const { data } = await api.get('/machines');
      const list = Array.isArray(data) ? data : [];
      return list.map((row: Record<string, unknown>) => normalizePosMachine(row));
    },
  });

  const { data: shops = [] } = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => api.get('/shops').then((r) => r.data),
  });

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ['companies'],
    queryFn: () => api.get('/companies').then((r) => r.data),
  });

  const { data: pairShops = [] } = useQuery<Shop[]>({
    queryKey: ['shops', 'byCompany', pairCompanyId],
    queryFn: () =>
      api.get('/shops', { params: { companyId: pairCompanyId } }).then((r) => r.data),
    enabled: !!pairCompanyId && pairOpen,
  });

  const visibleMachines = machines.filter((m) => {
    if (filterShopId === 'all') return true;
    if (filterShopId === '__none__') return !m.shopId;
    return m.shopId === filterShopId;
  });

  const resetPairDialog = () => {
    setMachineCode('');
    setPairingCode(null);
    setPairCompanyId('');
    setPairShopId('');
    setPairPreAssignLabel(null);
  };

  const generateCode = useMutation({
    mutationFn: (payload: { companyId?: string; shopId?: string }) =>
      api.post('/pairing/generate', {
        ...(payload.companyId ? { companyId: payload.companyId } : {}),
        ...(payload.shopId ? { shopId: payload.shopId } : {}),
      }),
    onSuccess: (res) => setPairingCode(res.data.code),
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const createFieldSession = useMutation({
    mutationFn: () => api.post<PairingSessionCreateResponse>('/pairing/sessions'),
    onSuccess: (res) => {
      setFieldSession(res.data);
      setFieldPairedCount(0);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('fieldInstall.startError'))),
  });

  const revokeFieldSession = useMutation({
    mutationFn: (sessionId: string) => api.delete(`/pairing/sessions/${sessionId}`),
    onSuccess: () => {
      setFieldSession(null);
      setFieldPairedCount(0);
      setFieldInstallOpen(false);
      toast.success(t('fieldInstall.sessionEnded'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const pushCatalog = useMutation({
    mutationFn: (payload: { machineId?: string; shopId?: string }) => {
      if (payload.shopId) {
        return api.post('/catalog/push', {
          productIds: 'all',
          categoryIds: 'all',
          targets: { shopIds: [payload.shopId] },
        });
      }
      return api.post('/catalog/push', {
        productIds: 'all',
        categoryIds: 'all',
        targets: { machineIds: [payload.machineId!] },
      });
    },
    onSuccess: () => {
      toast.success(t('pushSuccess'));
      setPushOpen(false);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const closeDayMutation = useMutation({
    mutationFn: (payload: { machineIds?: string[]; shopId?: string }) => postCloseDay(payload),
    onSuccess: (data) => {
      setCloseProgressRequestId(data.requestId);
      setCloseProgressData({ id: data.requestId, status: data.status, items: data.items });
      setCloseProgressOpen(true);
      setCloseDayOpen(false);
      setSelectedMachineIds(new Set());
      qc.invalidateQueries({ queryKey: ['machines'] });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const assignMachine = useMutation({
    mutationFn: ({
      machineId,
      shopId,
    }: {
      machineId: string;
      shopId: string;
    }) =>
      api.post(`/pairing/machines/${machineId}/assign`, { shopId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['machines'] });
      toast.success(t('assignSuccess'));
      setAssignOpen(false);
      setAssignShopId('');
      setSelectedMachine(null);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const updateMachineShop = useMutation({
    mutationFn: ({ machineId, shopId }: { machineId: string; shopId: string | null }) =>
      api.put(`/machines/${machineId}`, { shopId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['machines'] });
      toast.success(t('shopUpdateSuccess'));
      setShopEditOpen(false);
      setEditShopId('');
      setSelectedMachine(null);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  // Smart delete on the server returns mode='hard' (row gone) or mode='soft'
  // (row kept, decommissioned to preserve historical FKs). We surface the
  // chosen mode in the toast so operators know what actually happened.
  const removeMachine = useMutation({
    mutationFn: async (machineId: string) => {
      const { data } = await api.delete(`/machines/${machineId}`);
      return data as { deleted: boolean; mode: 'hard' | 'soft'; machineId: string };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['machines'] });
      toast.success(data.mode === 'hard' ? t('removedHard') : t('removedSoft'));
      setRemoveOpen(false);
      setSelectedMachine(null);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const openAssign = (m: PosMachine) => {
    setSelectedMachine(m);
    setAssignShopId('');
    setAssignOpen(true);
  };

  const openShopEdit = (m: PosMachine) => {
    setSelectedMachine(m);
    setEditShopId(m.shopId ?? '');
    setShopEditOpen(true);
  };

  const openPush = (m: PosMachine) => {
    setSelectedMachine(m);
    setPushTarget(m.shopId ? 'machine' : 'machine');
    setPushOpen(true);
  };

  const openCloseDay = (m: PosMachine) => {
    setSelectedMachine(m);
    setCloseDayTarget(m.shopId ? 'machine' : 'machine');
    setCloseDayOpen(true);
  };

  const toggleMachineSelected = (id: string) => {
    setSelectedMachineIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * Open the remove dialog. We treat any non-`paired` machine as "probably has
   * history" — once a machine has been assigned to a shop it has almost
   * certainly produced sync_logs, so the soft-delete copy is the safe default.
   * The server still re-checks authoritatively before deleting.
   */
  const openRemove = (m: PosMachine) => {
    setSelectedMachine(m);
    setRemoveMachineHasHistory(
      m.pairingStatus === 'assigned' ||
        !!m.lastSyncAt ||
        !!m.lastHeartbeatAt,
    );
    setRemoveOpen(true);
  };

  useEffect(() => {
    const tmr = window.setInterval(() => setNowMs(Date.now()), 15000);
    return () => window.clearInterval(tmr);
  }, []);

  useEffect(() => {
    if (!fieldInstallOpen || !fieldSession?.sessionId) return;
    const poll = () => {
      void api
        .get<Array<{ id: string; machinesPairedCount: number }>>('/pairing/sessions/active')
        .then((r) => {
          const row = r.data.find((s) => s.id === fieldSession.sessionId);
          if (row) setFieldPairedCount(row.machinesPairedCount);
        })
        .catch(() => undefined);
    };
    poll();
    const tmr = window.setInterval(poll, 5000);
    return () => window.clearInterval(tmr);
  }, [fieldInstallOpen, fieldSession?.sessionId]);

  const isMqttOnline = (m: PosMachine): boolean => {
    if (!m.lastHeartbeatAt) return false;
    const ts = new Date(m.lastHeartbeatAt).getTime();
    if (!Number.isFinite(ts)) return false;
    return nowMs - ts <= MQTT_ONLINE_WINDOW_MS;
  };

  const canCloseMachine = (m: PosMachine): boolean =>
    m.pairingStatus === 'assigned' &&
    m.tradingDayStatus === 'open' &&
    isMqttOnline(m) &&
    !m.closeDayPending;

  const tradingDayBadgeVariant = (m: PosMachine): 'default' | 'secondary' | 'outline' => {
    if (m.closeDayPending) return 'secondary';
    if (m.tradingDayStatus === 'open') return 'default';
    return 'outline';
  };

  const tradingDayLabel = (m: PosMachine): string => {
    if (m.closeDayPending) return t('tradingDayPending');
    if (m.tradingDayStatus === 'open') return t('tradingDayOpen');
    return t('tradingDayNone');
  };

  const closeItemStatusLabel = (status: string): string => {
    const map: Record<string, string> = {
      pending: t('closeDayItemStatus.pending'),
      sent: t('closeDayItemStatus.sent'),
      received: t('closeDayItemStatus.received'),
      completed: t('closeDayItemStatus.completed'),
      failed: t('closeDayItemStatus.failed'),
      cancelled: t('closeDayItemStatus.cancelled'),
      expired: t('closeDayItemStatus.expired'),
    };
    return map[status] ?? status;
  };

  const bulkCloseTargets = visibleMachines.filter((m) => selectedMachineIds.has(m.id) && canCloseMachine(m));

  const selectableMachines = visibleMachines.filter(
    (m) => m.pairingStatus === 'assigned',
  );
  const allSelectableSelected =
    selectableMachines.length > 0 &&
    selectableMachines.every((m) => selectedMachineIds.has(m.id));
  const someSelectableSelected =
    selectableMachines.some((m) => selectedMachineIds.has(m.id)) && !allSelectableSelected;

  const toggleSelectAll = () => {
    if (allSelectableSelected) {
      setSelectedMachineIds(new Set());
    } else {
      setSelectedMachineIds(new Set(selectableMachines.map((m) => m.id)));
    }
  };

  useEffect(() => {
    if (!closeProgressOpen || !closeProgressRequestId) return;
    const terminal = new Set(['completed', 'failed', 'cancelled', 'expired']);
    const poll = () => {
      void fetchCloseDayRequest(closeProgressRequestId)
        .then((data) => {
          setCloseProgressData(data);
          const allDone = data.items.every((item) => terminal.has(item.status));
          if (allDone) qc.invalidateQueries({ queryKey: ['machines'] });
        })
        .catch(() => undefined);
    };
    poll();
    const tmr = window.setInterval(poll, 2000);
    return () => window.clearInterval(tmr);
  }, [closeProgressOpen, closeProgressRequestId, qc]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <div className="flex gap-2">
          {canAssignMachine ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setFieldSession(null);
                setFieldPairedCount(0);
                setFieldInstallOpen(true);
              }}
            >
              <Smartphone className="h-4 w-4 ms-1" /> {t('fieldInstall.btn')}
            </Button>
          ) : null}
          <Button
            onClick={() => {
              resetPairDialog();
              setPairOpen(true);
            }}
            size="sm"
          >
            <KeyRound className="h-4 w-4 ms-1" /> {t('generateCode')}
          </Button>
        </div>
      </div>

      {showAssignHelp ? (
        <div
          className="rounded-lg border border-primary/25 bg-primary/5 p-4 text-sm"
          role="note"
        >
          <div className="flex gap-3">
            <Info className="h-5 w-5 shrink-0 text-primary mt-0.5" aria-hidden />
            <div className="space-y-2 min-w-0">
              <p className="font-semibold text-foreground">{t('workflowTitle')}</p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                <li>{t('workflowStep1')}</li>
                <li>{t('workflowStep2')}</li>
                <li>{t('workflowStep3')}</li>
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      {!isLoading && machines.length > 0 ? (
        <div className="max-w-sm space-y-1">
          <Label>{t('filterByShop')}</Label>
          <Select
            value={filterShopId}
            onValueChange={(v) => setFilterShopId(v ?? 'all')}
            items={[
              { value: 'all', label: t('allShops') },
              { value: '__none__', label: t('shopUnassignedFilter') },
              ...entitySelectItems(shops),
            ]}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('allShops')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" label={t('allShops')}>
                {t('allShops')}
              </SelectItem>
              <SelectItem value="__none__" label={t('shopUnassignedFilter')}>
                {t('shopUnassignedFilter')}
              </SelectItem>
              {shops.map((s) => (
                <SelectItem key={s.id} value={s.id} label={s.name}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-32" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : machines.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
          <Monitor className="h-12 w-12 opacity-30" />
          <p className="text-center">{t('noMachines')}</p>
        </div>
      ) : visibleMachines.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
          <Monitor className="h-12 w-12 opacity-30" />
          <p className="text-center">{t('noMachinesForShop')}</p>
        </div>
      ) : (
        <>
          {canCloseDay && selectableMachines.length > 0 ? (
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-lg border bg-background/95 p-3 shadow-sm backdrop-blur">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={allSelectableSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelectableSelected;
                  }}
                  onChange={toggleSelectAll}
                  aria-label={allSelectableSelected ? t('deselectAll') : t('selectAll')}
                />
                <span>
                  {allSelectableSelected ? t('deselectAll') : t('selectAll')}
                  <span className="text-muted-foreground">
                    {' '}
                    ({t('selectedCount', {
                      selected: selectableMachines.filter((m) => selectedMachineIds.has(m.id)).length,
                      total: selectableMachines.length,
                    })})
                  </span>
                </span>
              </label>
              {selectedMachineIds.size > 0 ? (
                <>
                  <span className="hidden h-4 w-px bg-border sm:block" aria-hidden />
                  <span className="text-sm text-muted-foreground">
                    {t('closeDayBulk', { count: bulkCloseTargets.length })}
                  </span>
                  <Button
                    size="sm"
                    disabled={bulkCloseTargets.length === 0 || closeDayMutation.isPending}
                    onClick={() =>
                      closeDayMutation.mutate({ machineIds: bulkCloseTargets.map((m) => m.id) })
                    }
                  >
                    <CalendarClock className="h-4 w-4 me-1" />
                    {closeDayMutation.isPending ? t('closeDaySending') : t('closeDayConfirm')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setSelectedMachineIds(new Set())}>
                    {tc('cancel')}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {visibleMachines.map((m) => (
            <Card key={m.id}>
              <CardHeader className="flex flex-row items-start justify-between pb-2">
                <div className="flex items-start gap-2 min-w-0">
                  {canCloseDay && m.pairingStatus === 'assigned' ? (
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 accent-primary"
                      checked={selectedMachineIds.has(m.id)}
                      onChange={() => toggleMachineSelected(m.id)}
                      aria-label={m.name}
                    />
                  ) : null}
                  <div className="min-w-0">
                  <CardTitle className="text-base">{m.name}</CardTitle>
                  <p className="text-xs text-muted-foreground">{m.machineCode}</p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  <span className="text-muted-foreground shrink-0">{t('statusLabel')}</span>
                  <Badge variant={statusColor[m.pairingStatus] ?? 'outline'} className="shrink-0">
                    {m.pairingStatus === 'unpaired'
                      ? t('pairingStatusLabels.unpaired')
                      : m.pairingStatus === 'paired'
                        ? t('pairingStatusLabels.paired')
                        : m.pairingStatus === 'assigned'
                          ? t('pairingStatusLabels.assigned')
                          : m.pairingStatus}
                  </Badge>
                </div>
                <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{t('mqttStatus')}</span>
                    <Badge variant={isMqttOnline(m) ? 'default' : 'outline'}>
                      {isMqttOnline(m) ? t('mqttOnline') : t('mqttOffline')}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {m.lastHeartbeatAt ? (
                      <>
                        <Wifi className={`h-3.5 w-3.5 ${isMqttOnline(m) ? 'text-green-500' : ''}`} />
                        {t('lastSeen')}{' '}
                        {formatDistanceToNow(new Date(m.lastHeartbeatAt), { addSuffix: true, locale: he })}
                      </>
                    ) : (
                      <>
                        <WifiOff className="h-3.5 w-3.5" /> {t('neverSeen')}
                      </>
                    )}
                  </div>
                </div>
                <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{t('syncPullStatus')}</span>
                    <Badge variant={m.lastSyncAt ? 'secondary' : 'outline'}>
                      {m.lastSyncAt ? t('synced') : t('neverSynced')}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {m.lastSyncAt ? (
                      <>
                        <Wifi className="h-3.5 w-3.5 text-green-500" />
                        {t('lastSync')}{' '}
                        {formatDistanceToNow(new Date(m.lastSyncAt), { addSuffix: true, locale: he })}
                      </>
                    ) : (
                      <>
                        <WifiOff className="h-3.5 w-3.5" /> {t('neverSynced')}
                      </>
                    )}
                  </div>
                </div>
                {m.lastCatalogChangeAt ? (
                  <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">{t('catalogFreshness')}</span>
                      <Badge variant={m.catalogPullStale ? 'outline' : 'default'}>
                        {m.catalogPullStale ? t('catalogStale') : t('catalogUpToDate')}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('lastCloudChange')}{' '}
                      {formatDistanceToNow(new Date(m.lastCatalogChangeAt), { addSuffix: true, locale: he })}
                    </div>
                  </div>
                ) : null}
                <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{t('tradingDayStatusLabel')}</span>
                    <Badge variant={tradingDayBadgeVariant(m)}>{tradingDayLabel(m)}</Badge>
                  </div>
                  {m.tradingDayStatus === 'open' && m.openedAt ? (
                    <div className="text-xs text-muted-foreground">
                      {t('tradingDayOpenedAt')}{' '}
                      {formatDistanceToNow(new Date(m.openedAt), { addSuffix: true, locale: he })}
                      {m.openedBy ? ` · ${t('tradingDayOpenedBy')} ${m.openedBy}` : null}
                    </div>
                  ) : null}
                </div>
                {m.pairingStatus === 'assigned' || m.shopId ? (
                  <p className="text-xs text-muted-foreground">
                    {t('shop')}:{' '}
                    {m.shopId
                      ? shops.find((s) => s.id === m.shopId)?.name ?? m.shopId
                      : t('shopNotSet')}
                  </p>
                ) : null}
                <div className="flex flex-col gap-2">
                  {!authHydrated ? (
                    <>
                      <Skeleton className="h-9 w-full" />
                      <Skeleton className="h-9 w-full" />
                    </>
                  ) : (
                    <>
                      {m.pairingStatus === 'paired' && canAssignMachine ? (
                        <Button variant="secondary" size="sm" className="w-full" onClick={() => openAssign(m)}>
                          <Link2 className="h-3.5 w-3.5 me-1" />
                          {t('assignToMerchant')}
                        </Button>
                      ) : null}
                      {m.pairingStatus === 'paired' && !canAssignMachine ? (
                        <p className="text-xs text-amber-700 dark:text-amber-500">{t('assignNoPermission')}</p>
                      ) : null}
                      {m.pairingStatus === 'assigned' && canEditAssignedShop ? (
                        <Button variant="outline" size="sm" className="w-full" onClick={() => openShopEdit(m)}>
                          <Store className="h-3.5 w-3.5 me-1" />
                          {t('changeShop')}
                        </Button>
                      ) : null}
                      {canCloseDay ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={() => openCloseDay(m)}
                          disabled={!canCloseMachine(m)}
                        >
                          <CalendarClock className="h-3.5 w-3.5 me-1" /> {t('closeDay')}
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => openPush(m)}
                        disabled={m.pairingStatus !== 'assigned'}
                      >
                        <Send className="h-3.5 w-3.5 me-1" /> {t('pushCatalog')}
                      </Button>
                      {canRemoveMachine ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/40"
                          onClick={() => openRemove(m)}
                        >
                          <Trash2 className="h-3.5 w-3.5 me-1" /> {t('remove')}
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        </>
      )}

      <Dialog
        open={pairOpen}
        onOpenChange={(open) => {
          setPairOpen(open);
          if (!open) resetPairDialog();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('pairTitle')}</DialogTitle>
          </DialogHeader>
          {pairingCode ? (
            <div className="text-center space-y-3 py-4">
              <p className="text-muted-foreground text-sm">{t('pairInstruction')}</p>
              <p className="text-4xl font-mono font-bold tracking-widest text-primary">{pairingCode}</p>
              <p className="text-xs text-muted-foreground">{t('pairExpiry')}</p>
              {pairPreAssignLabel ? (
                <p className="text-sm text-muted-foreground">{t('pairPreAssigned', { target: pairPreAssignLabel })}</p>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPairingCode(null);
                  setPairPreAssignLabel(null);
                }}
              >
                <RefreshCw className="h-3.5 w-3.5 me-1" /> {t('generateNew')}
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label>{t('machineCode')}</Label>
                <Input
                  value={machineCode}
                  onChange={(e) => setMachineCode(e.target.value)}
                  placeholder={t('machineCodePlaceholder')}
                />
                <p className="text-xs text-muted-foreground">{t('machineCodeHint')}</p>
              </div>
              <div className="space-y-3 rounded-lg border border-dashed p-3">
                <div>
                  <p className="text-sm font-medium">{t('pairAssignOptional')}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t('pairAssignHint')}</p>
                </div>
                <div className="space-y-2">
                  <Label>{t('selectCompanyOptional')}</Label>
                  <Select
                    value={pairCompanyId}
                    onValueChange={(v) => {
                      setPairCompanyId(v ?? '');
                      setPairShopId('');
                    }}
                    items={entitySelectItems(companies)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('selectCompanyOptional')} />
                    </SelectTrigger>
                    <SelectContent>
                      {companies.map((c) => (
                        <SelectItem key={c.id} value={c.id} label={c.name}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t('selectShopOptional')}</Label>
                  <Select
                    value={pairShopId}
                    onValueChange={(v) => setPairShopId(v ?? '')}
                    disabled={!pairCompanyId}
                    items={entitySelectItems(pairShops)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('selectShopOptional')} />
                    </SelectTrigger>
                    <SelectContent>
                      {pairShops.map((s) => (
                        <SelectItem key={s.id} value={s.id} label={s.name}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPairOpen(false)}>
                  {tc('cancel')}
                </Button>
                <Button
                  onClick={() => {
                    const companyName = pairCompanyId
                      ? findBySameId(companies, pairCompanyId)?.name
                      : undefined;
                    const shopName = pairShopId
                      ? findBySameId(pairShops, pairShopId)?.name
                      : undefined;
                    if (companyName && shopName) {
                      setPairPreAssignLabel(`${companyName} — ${shopName}`);
                    } else if (companyName) {
                      setPairPreAssignLabel(companyName);
                    } else {
                      setPairPreAssignLabel(null);
                    }
                    generateCode.mutate({
                      ...(pairCompanyId ? { companyId: pairCompanyId } : {}),
                      ...(pairShopId ? { shopId: pairShopId } : {}),
                    });
                  }}
                  disabled={!machineCode || generateCode.isPending}
                >
                  {t('generate')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('assignTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              {t('assignDesc')} <strong>{selectedMachine?.name}</strong>
            </p>
            <div className="space-y-2">
              <Label>{t('selectShop')}</Label>
              <Select
                value={assignShopId}
                onValueChange={(v) => setAssignShopId(v ?? '')}
                items={entitySelectItems(shops)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('selectShop')} />
                </SelectTrigger>
                <SelectContent>
                  {shops.map((s) => (
                    <SelectItem key={s.id} value={s.id} label={s.name}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>
              {tc('cancel')}
            </Button>
            <Button
              disabled={!selectedMachine || !assignShopId || assignMachine.isPending}
              onClick={() =>
                selectedMachine &&
                assignMachine.mutate({
                  machineId: selectedMachine.id,
                  shopId: assignShopId,
                })
              }
            >
              {assignMachine.isPending ? t('assigning') : t('assignConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={shopEditOpen} onOpenChange={setShopEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('changeShopTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">{t('changeShopDesc')}</p>
            <div className="space-y-2">
              <Label>{t('selectShopOptional')}</Label>
              <Select
                value={editShopId || '__none__'}
                onValueChange={(v) => setEditShopId(v == null || v === '__none__' ? '' : v)}
                items={[{ value: '__none__', label: t('noShop') }, ...entitySelectItems(shops)]}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('selectShopOptional')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__" label={t('noShop')}>
                    {t('noShop')}
                  </SelectItem>
                  {shops.map((s) => (
                    <SelectItem key={s.id} value={s.id} label={s.name}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShopEditOpen(false)}>
              {tc('cancel')}
            </Button>
            <Button
              disabled={!selectedMachine || updateMachineShop.isPending}
              onClick={() =>
                selectedMachine &&
                updateMachineShop.mutate({
                  machineId: selectedMachine.id,
                  shopId: editShopId || null,
                })
              }
            >
              {updateMachineShop.isPending ? t('savingShop') : t('saveShop')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pushOpen} onOpenChange={setPushOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('pushTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('pushScopeIntro')}</p>
            {selectedMachine?.shopId ? (
              <div className="space-y-2">
                <Label>{t('pushScopeLabel')}</Label>
                <Select
                  value={pushTarget}
                  onValueChange={(v) => setPushTarget(v as 'machine' | 'shop')}
                  items={[
                    { value: 'machine', label: t('pushThisDevice') },
                    { value: 'shop', label: t('pushAllInShop') },
                  ]}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="machine" label={t('pushThisDevice')}>
                      {t('pushThisDevice')}
                    </SelectItem>
                    <SelectItem value="shop" label={t('pushAllInShop')}>
                      {t('pushAllInShop')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('pushThisDeviceOnlyHint')}</p>
            )}
            <p className="text-sm text-muted-foreground">
              {t('pushConfirm')} <strong>{selectedMachine?.name}</strong> {t('pushConfirmSuffix')}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPushOpen(false)}>
              {tc('cancel')}
            </Button>
            <Button
              onClick={() => {
                if (!selectedMachine) return;
                if (pushTarget === 'shop' && selectedMachine.shopId) {
                  pushCatalog.mutate({ shopId: selectedMachine.shopId });
                } else {
                  pushCatalog.mutate({ machineId: selectedMachine.id });
                }
              }}
              disabled={pushCatalog.isPending}
            >
              <Send className="h-3.5 w-3.5 me-1" />
              {pushCatalog.isPending ? t('pushing') : t('pushNow')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={closeDayOpen} onOpenChange={setCloseDayOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('closeDayTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('closeDayScopeIntro')}</p>
            {selectedMachine?.shopId ? (
              <div className="space-y-2">
                <Label>{t('pushScopeLabel')}</Label>
                <Select
                  value={closeDayTarget}
                  onValueChange={(v) => setCloseDayTarget(v as 'machine' | 'shop')}
                  items={[
                    { value: 'machine', label: t('closeDayThisDevice') },
                    { value: 'shop', label: t('closeDayAllOpenInShop') },
                  ]}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="machine" label={t('closeDayThisDevice')}>
                      {t('closeDayThisDevice')}
                    </SelectItem>
                    <SelectItem value="shop" label={t('closeDayAllOpenInShop')}>
                      {t('closeDayAllOpenInShop')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('pushThisDeviceOnlyHint')}</p>
            )}
            <p className="text-sm text-muted-foreground">{t('closeDayProgressHint')}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloseDayOpen(false)}>
              {tc('cancel')}
            </Button>
            <Button
              onClick={() => {
                if (!selectedMachine) return;
                if (closeDayTarget === 'shop' && selectedMachine.shopId) {
                  closeDayMutation.mutate({ shopId: selectedMachine.shopId });
                } else {
                  closeDayMutation.mutate({ machineIds: [selectedMachine.id] });
                }
              }}
              disabled={closeDayMutation.isPending || !selectedMachine || !canCloseMachine(selectedMachine)}
            >
              <CalendarClock className="h-3.5 w-3.5 me-1" />
              {closeDayMutation.isPending ? t('closeDaySending') : t('closeDayConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={closeProgressOpen} onOpenChange={setCloseProgressOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('closeDayProgressTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t('closeDayProgressHint')}</p>
          <div className="max-h-72 overflow-y-auto space-y-2 py-2">
            {(closeProgressData?.items ?? []).map((item) => (
              <div
                key={item.id}
                className="flex items-start justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">{item.machineName ?? item.machineId}</p>
                  {item.errorMessage ? (
                    <p className="text-xs text-destructive mt-0.5">{item.errorMessage}</p>
                  ) : null}
                </div>
                <Badge variant={item.status === 'completed' ? 'default' : item.status === 'failed' ? 'outline' : 'secondary'}>
                  {closeItemStatusLabel(item.status)}
                </Badge>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setCloseProgressOpen(false);
                setCloseProgressRequestId(null);
                setCloseProgressData(null);
                qc.invalidateQueries({ queryKey: ['machines'] });
              }}
            >
              {t('closeDayDismiss')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={fieldInstallOpen}
        onOpenChange={(open) => {
          setFieldInstallOpen(open);
          if (!open) {
            setFieldSession(null);
            setFieldPairedCount(0);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('fieldInstall.title')}</DialogTitle>
          </DialogHeader>
          {!fieldSession ? (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">{t('fieldInstall.subtitle')}</p>
              <p className="text-sm text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/40 rounded-md p-3">
                {t('fieldInstall.securityHint')}
              </p>
              <Button
                className="w-full"
                onClick={() => createFieldSession.mutate()}
                disabled={createFieldSession.isPending}
              >
                {createFieldSession.isPending ? t('fieldInstall.starting') : t('fieldInstall.start')}
              </Button>
            </div>
          ) : (
            <div className="space-y-4 py-2 text-center">
              <p className="text-sm text-muted-foreground">{t('fieldInstall.subtitle')}</p>
              <div className="flex justify-center">
                <QRCodeSVG value={fieldSession.mobileUrl} size={220} level="M" />
              </div>
              <p className="text-sm font-medium">
                {t('fieldInstall.sessionTtl', {
                  expiresAt: format(new Date(fieldSession.expiresAt), 'HH:mm dd/MM/yyyy'),
                  hours: fieldSession.sessionExpireHours,
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(fieldSession.expiresAt), { addSuffix: true, locale: he })}
              </p>
              <p className="text-sm">{t('fieldInstall.pairedCount', { count: fieldPairedCount })}</p>
              <p className="text-xs text-amber-800 dark:text-amber-200">{t('fieldInstall.securityHint')}</p>
              <a
                href={fieldSession.mobileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {t('fieldInstall.openMobileLink')}
              </a>
              <DialogFooter className="sm:justify-center">
                <Button
                  variant="destructive"
                  onClick={() => revokeFieldSession.mutate(fieldSession.sessionId)}
                  disabled={revokeFieldSession.isPending}
                >
                  {revokeFieldSession.isPending ? t('fieldInstall.ending') : t('fieldInstall.endSession')}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('removeTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm">
              {t('removeConfirm')} <strong>{selectedMachine?.name}</strong>?
            </p>
            <div
              className={
                'rounded-md border p-3 text-sm ' +
                (removeMachineHasHistory
                  ? 'bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-100'
                  : 'bg-destructive/10 border-destructive/30 text-destructive')
              }
            >
              {removeMachineHasHistory ? t('removeWarningSoft') : t('removeWarningHard')}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveOpen(false)}>
              {tc('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={!selectedMachine || removeMachine.isPending}
              onClick={() => selectedMachine && removeMachine.mutate(selectedMachine.id)}
            >
              <Trash2 className="h-3.5 w-3.5 me-1" />
              {removeMachine.isPending ? t('removing') : t('removeBtnConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
