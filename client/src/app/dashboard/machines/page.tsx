'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PosMachine, Shop, Merchant } from '@/lib/types';
import { useAuth } from '@/lib/auth';
import { normalizePosMachine } from '@/lib/posMachine';
import { findBySameId } from '@/lib/entityLookup';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Monitor, Wifi, WifiOff, Send, KeyRound, RefreshCw, Link2, Store, Info, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
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

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignMerchantId, setAssignMerchantId] = useState('');
  const [assignShopId, setAssignShopId] = useState('');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const [shopEditOpen, setShopEditOpen] = useState(false);
  const [editShopId, setEditShopId] = useState('');

  const [removeOpen, setRemoveOpen] = useState(false);
  // Pre-checked when the dialog opens so the warning copy can tell the operator
  // upfront whether the row will be hard-deleted or only decommissioned.
  const [removeMachineHasHistory, setRemoveMachineHasHistory] = useState(false);

  const canAssignMachine =
    authHydrated && (me?.role === 'distributor' || me?.role === 'super_admin');
  const canEditAssignedShop =
    authHydrated &&
    (me?.role === 'merchant_admin' || me?.role === 'distributor' || me?.role === 'super_admin');
  const canRemoveMachine =
    authHydrated && (me?.role === 'distributor' || me?.role === 'super_admin');
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

  const { data: merchants = [] } = useQuery<Merchant[]>({
    queryKey: ['merchants'],
    queryFn: () => api.get('/merchants').then((r) => r.data),
  });

  const { data: assignShops = [] } = useQuery<Shop[]>({
    queryKey: ['shops', 'byMerchant', assignMerchantId],
    queryFn: () =>
      api.get('/shops', { params: { merchantId: assignMerchantId } }).then((r) => r.data),
    enabled: !!assignMerchantId && assignOpen,
  });

  const { data: editShops = [] } = useQuery<Shop[]>({
    queryKey: ['shops', 'byMerchant', selectedMachine?.merchantId],
    queryFn: () =>
      api
        .get('/shops', { params: { merchantId: selectedMachine!.merchantId } })
        .then((r) => r.data),
    enabled: !!selectedMachine?.merchantId && shopEditOpen,
  });

  const generateCode = useMutation({
    mutationFn: (code: string) => api.post('/pairing/generate', { machineCode: code }),
    onSuccess: (res) => setPairingCode(res.data.code),
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

  const assignMachine = useMutation({
    mutationFn: ({
      machineId,
      merchantId,
      shopId,
    }: {
      machineId: string;
      merchantId: string;
      shopId?: string;
    }) =>
      api.post(`/pairing/machines/${machineId}/assign`, {
        merchantId,
        ...(shopId ? { shopId } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['machines'] });
      toast.success(t('assignSuccess'));
      setAssignOpen(false);
      setAssignMerchantId('');
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
    setAssignMerchantId('');
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

  /**
   * Open the remove dialog. We treat any non-`paired` machine as "probably has
   * history" — once a machine has been assigned to a merchant it has almost
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

  const isMqttOnline = (m: PosMachine): boolean => {
    if (!m.lastHeartbeatAt) return false;
    const ts = new Date(m.lastHeartbeatAt).getTime();
    if (!Number.isFinite(ts)) return false;
    return nowMs - ts <= MQTT_ONLINE_WINDOW_MS;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <Button
          onClick={() => {
            setMachineCode('');
            setPairingCode(null);
            setPairOpen(true);
          }}
          size="sm"
        >
          <KeyRound className="h-4 w-4 ms-1" /> {t('generateCode')}
        </Button>
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
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {machines.map((m) => (
            <Card key={m.id}>
              <CardHeader className="flex flex-row items-start justify-between pb-2">
                <div>
                  <CardTitle className="text-base">{m.name}</CardTitle>
                  <p className="text-xs text-muted-foreground">{m.machineCode}</p>
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
                {m.merchantId && (
                  <p className="text-xs text-muted-foreground">
                    {t('merchant')}: {merchants.find((x) => x.id === m.merchantId)?.name ?? m.merchantId}
                  </p>
                )}
                {m.pairingStatus === 'assigned' ? (
                  <p className="text-xs text-muted-foreground">
                    {t('shop')}:{' '}
                    {m.shopId
                      ? shops.find((s) => s.id === m.shopId)?.name ?? m.shopId
                      : t('shopNotSet')}
                  </p>
                ) : m.shopId ? (
                  <p className="text-xs text-muted-foreground">
                    {t('shop')}: {shops.find((s) => s.id === m.shopId)?.name ?? m.shopId}
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
                      {m.pairingStatus === 'assigned' && canEditAssignedShop && m.merchantId ? (
                        <Button variant="outline" size="sm" className="w-full" onClick={() => openShopEdit(m)}>
                          <Store className="h-3.5 w-3.5 me-1" />
                          {t('changeShop')}
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
      )}

      <Dialog open={pairOpen} onOpenChange={setPairOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('pairTitle')}</DialogTitle>
          </DialogHeader>
          {pairingCode ? (
            <div className="text-center space-y-3 py-4">
              <p className="text-muted-foreground text-sm">{t('pairInstruction')}</p>
              <p className="text-4xl font-mono font-bold tracking-widest text-primary">{pairingCode}</p>
              <p className="text-xs text-muted-foreground">{t('pairExpiry')}</p>
              <Button variant="outline" size="sm" onClick={() => setPairingCode(null)}>
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
              <DialogFooter>
                <Button variant="outline" onClick={() => setPairOpen(false)}>
                  {tc('cancel')}
                </Button>
                <Button onClick={() => generateCode.mutate(machineCode)} disabled={!machineCode || generateCode.isPending}>
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
              <Label>{t('selectMerchant')}</Label>
              <Select
                value={assignMerchantId}
                onValueChange={(v) => {
                  setAssignMerchantId(v ?? '');
                  setAssignShopId('');
                }}
                itemToStringLabel={(v) => {
                  if (v == null || v === '') return '';
                  return findBySameId(merchants, String(v))?.name ?? String(v);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('selectMerchant')} />
                </SelectTrigger>
                <SelectContent>
                  {merchants.map((mer) => (
                    <SelectItem key={mer.id} value={mer.id} label={mer.name}>
                      {mer.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('selectShopOptional')}</Label>
              <Select
                value={assignShopId || '__none__'}
                onValueChange={(v) => setAssignShopId(v == null || v === '__none__' ? '' : v)}
                disabled={!assignMerchantId}
                itemToStringLabel={(v) => {
                  if (v == null || v === '' || v === '__none__') return t('noShop');
                  return findBySameId(assignShops, String(v))?.name ?? String(v);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('selectShopOptional')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__" label={t('noShop')}>
                    {t('noShop')}
                  </SelectItem>
                  {assignShops.map((s) => (
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
              disabled={!selectedMachine || !assignMerchantId || assignMachine.isPending}
              onClick={() =>
                selectedMachine &&
                assignMachine.mutate({
                  machineId: selectedMachine.id,
                  merchantId: assignMerchantId,
                  shopId: assignShopId || undefined,
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
                itemToStringLabel={(v) => {
                  if (v == null || v === '' || v === '__none__') return t('noShop');
                  return findBySameId(editShops, String(v))?.name ?? String(v);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('selectShopOptional')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__" label={t('noShop')}>
                    {t('noShop')}
                  </SelectItem>
                  {editShops.map((s) => (
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
                  itemToStringLabel={(v) =>
                    v === 'shop' ? t('pushAllInShop') : t('pushThisDevice')
                  }
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
