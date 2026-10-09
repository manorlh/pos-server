'use client';

import { useMemo, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, fetchMachines } from '@/lib/api';
import { PosMachine, Shop, Company, type DeviceModel } from '@/lib/types';
import { useAuth } from '@/lib/auth';
import { useCanProduceZ, zWizardHref } from '@/lib/zAccess';
import { usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { findBySameId, sameId } from '@/lib/entityLookup';
import { entitySelectItems } from '@/lib/selectItems';
import { registerNumberOf } from '@/lib/registerNumber';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import Link from 'next/link';
import { Monitor, Plus, RefreshCw, Info, Trash2, Smartphone, FilePlus2, Search, Send, Layers, MonitorCog } from 'lucide-react';
import { MachineGroupsPanel } from '@/components/dashboard/machines/machine-groups';
import { ClockDriftBanner } from '@/components/dashboard/machine-health';
import { DocumentPrefixConflictsAlert } from '@/components/dashboard/machines/document-prefix';
import { formatDistanceToNow } from 'date-fns';
import { formatDateTime } from '@/lib/format';
import { QRCodeSVG } from 'qrcode.react';
import type { PairingSessionCreateResponse } from '@/lib/types';
import { useRoleAccess } from '@/lib/accessApi';
import { he } from 'date-fns/locale';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MachineStatusDot, machineStatus } from '@/components/dashboard/machine-status';
import { MachinesTable } from '@/components/dashboard/machines/machines-table';
// "שליטה מרחוק בקופות" (components/dashboard/live-control).
import { DeviceControlSheet } from '@/components/dashboard/live-control';
import { DeviceSearchDialog } from '@/components/dashboard/machines/device-search';
import { RemoteShiftCloseDialog } from '@/components/dashboard/machines/remote-shift-close';
import { TransmitNowDialog } from '@/components/dashboard/machines/card-transmission';
import {
  TerminalMismatchAlert,
  TerminalNumberDialog,
  type TerminalNumberTarget,
} from '@/components/dashboard/machines/card-terminal';
import { RequestTillZDialog, ZModeDialog } from '@/components/dashboard/till-z/till-z-dialogs';
import { useZErrorText } from '@/components/dashboard/z-wizard/z-errors';
import { MachineAreaDialog } from '@/components/dashboard/areas/machine-area-dialog';
import { EntityPosSettingsDialog } from '@/components/dashboard/entity-settings-dialog';
import { AREA_NONE } from '@/lib/api';
import { DeviceModelSelect } from '@/components/dashboard/machines/device-model';
import {
  DeviceCapabilityList,
  DevicePlatformPicker,
  DeviceProfileDialog,
  DeviceRolePicker,
  EMPTY_KIOSK_DRAFT,
  KdsScreenFields,
  KioskOptionsFields,
} from '@/components/dashboard/machines/device-role';
import { WebKioskLink } from '@/components/dashboard/machines/web-kiosk-link';
import { WebScreenLink } from '@/components/dashboard/machines/web-screen-link';
import { WorkConfigStep } from '@/components/dashboard/machines/work-config';
import {
  EMPTY_DRAFT as EMPTY_WORK_CONFIG,
  draftError as workConfigDraftError,
  pairingOutcomeText,
  planOf as workConfigPlanOf,
  type PairingOutcome,
  type WorkConfigDraft,
} from '@/lib/workConfig';
import {
  EMPTY_KDS_SCREEN,
  addDeviceMissing,
  deviceProfileErrorMessage,
  isFiscalRole,
  kioskDraftError,
  modelNeeded,
  pairingRequestBody,
  platformsFor,
  roleNeedsShop,
  type DevicePlatform,
  type DeviceRole,
  type KdsScreenDraft,
  type KioskDraft,
} from '@/lib/deviceProfile';

const MQTT_ONLINE_WINDOW_MS = 300 * 1000;

export default function MachinesPage() {
  const t = useTranslations('machines');
  const tStatus = useTranslations('machineStatus');
  const tAreas = useTranslations('areas');
  const tc = useTranslations('common');
  // Moving or retiring a till is refused (409) while it holds shifts; those codes have words.
  const zErrors = useZErrorText();
  const qc = useQueryClient();
  const { user: me, authHydrated } = useAuth();
  // The list narrows to whatever the bar points at — a company (via its shops), a
  // shop, or one device. Its own "filter by shop" dropdown is gone; that was the
  // duplicate the shared scope replaces.
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'machine' });
  // "שליטה מרחוק": undefined = closed, null = the scope's tills, an id = that till preselected.
  const [remoteFor, setRemoteFor] = useState<string | null | undefined>(undefined);
  const [pairOpen, setPairOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [pushTarget, setPushTarget] = useState<'machine' | 'shop'>('machine');
  const [selectedMachine, setSelectedMachine] = useState<PosMachine | null>(null);
  const [machineCode, setMachineCode] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingCodeId, setPairingCodeId] = useState<string | null>(null);
  const [pairingComplete, setPairingComplete] = useState(false);
  const [pairCompanyId, setPairCompanyId] = useState('');
  const [pairShopId, setPairShopId] = useState('');
  const [pairPreAssignLabel, setPairPreAssignLabel] = useState<string | null>(null);
  /** Required before a code is generated: the till learns from it whether it prints. */
  const [pairDeviceModel, setPairDeviceModel] = useState<DeviceModel | ''>('');
  /**
   * "סוג מכשיר (תפקיד)", required too: a kiosk is made one as it pairs, with these options
   * (docs/SPEC_DEVICE_ROLE_MODEL.md) — no convert step afterwards.
   */
  const [pairDeviceRole, setPairDeviceRole] = useState<DeviceRole | ''>('');
  const [pairKiosk, setPairKiosk] = useState<KioskDraft>(EMPTY_KIOSK_DRAFT);
  /** Android unless chosen: a Windows install cannot redeem an Android code, nor back. */
  const [pairPlatform, setPairPlatform] = useState<DevicePlatform>('android');
  /** A KDS's screen (kind, stations) / the board's name: made as it pairs. */
  const [pairKds, setPairKds] = useState<KdsScreenDraft>(EMPTY_KDS_SCREEN);
  /** "מסך — לא קופה": a KDS or the board gets no register number, no sales, no Z. */
  const pairIsDisplay = pairDeviceRole !== '' && !isFiscalRole(pairDeviceRole);
  /**
   * "תצורת עבודה" (docs/SPEC_DEVICE_WORK_CONFIG.md): "לפי הסניף" unless chosen; the code carries
   * it and the device gets it as it pairs. Starts over when the shop, role or platform change.
   */
  const [pairWorkConfig, setPairWorkConfig] = useState<WorkConfigDraft>(EMPTY_WORK_CONFIG);
  /** How applying it went, once the device paired (the code's `workConfigResult`). */
  const [pairWorkConfigOutcome, setPairWorkConfigOutcome] = useState<PairingOutcome | null>(null);

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignShopId, setAssignShopId] = useState('');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const [shopEditOpen, setShopEditOpen] = useState(false);
  const [editShopId, setEditShopId] = useState('');

  const [removeOpen, setRemoveOpen] = useState(false);
  const [closeShiftTarget, setCloseShiftTarget] = useState<PosMachine | null>(null);
  const [transmitTarget, setTransmitTarget] = useState<PosMachine | null>(null);
  const [tillZTarget, setTillZTarget] = useState<PosMachine | null>(null);
  const [zModeTarget, setZModeTarget] = useState<PosMachine | null>(null);
  const [fieldInstallOpen, setFieldInstallOpen] = useState(false);
  const [fieldSession, setFieldSession] = useState<PairingSessionCreateResponse | null>(null);
  const [fieldPairedCount, setFieldPairedCount] = useState(0);
  // Pre-checked when the dialog opens so the warning copy can tell the operator
  // upfront whether the row will be hard-deleted or only decommissioned.
  const [removeMachineHasHistory, setRemoveMachineHasHistory] = useState(false);

  // "הרשאות": the super admin may have taken a device action from this role (the server
  // refuses it too); the roles' own rules stand.
  const { denied } = useRoleAccess();
  const canAssignMachine =
    authHydrated && (me?.role === 'distributor' || me?.role === 'super_admin') && !denied.has('pairDevices');
  const canEditAssignedShop =
    authHydrated &&
    (me?.role === 'company_manager' || me?.role === 'distributor' || me?.role === 'super_admin') &&
    !denied.has('moveDevices');
  const canRemoveMachine =
    authHydrated && (me?.role === 'distributor' || me?.role === 'super_admin') && !denied.has('removeDevices');
  // Producing a Z and closing a till's shift remotely need the same roles.
  const canProduceZ = useCanProduceZ();
  const showAssignHelp =
    authHydrated && (me?.role === 'super_admin' || me?.role === 'distributor');
  // "קבוצות מכשירים", the page's second tab: a catalog writer over a company makes them (the
  // server decides per company).
  const [pageTab, setPageTab] = useState<'devices' | 'groups'>('devices');
  const tGroups = useTranslations('machineGroups');
  const canCreateGroups =
    authHydrated && (me?.role === 'super_admin' || me?.role === 'distributor' || me?.role === 'company_manager');

  const { data: machines = [], isLoading } = useQuery<PosMachine[]>({
    queryKey: ['machines'],
    queryFn: fetchMachines,
    // While a close is on its way to a till, look again now and then, so "close
    // pending" turns into the closed shift without a manual reload. Slowly: the
    // wizard and the close dialog poll the close itself.
    refetchInterval: (q) => (q.state.data?.some((m) => m.closeShiftPending) ? 20_000 : false),
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

  /*
   * The register number a till paired into the chosen shop would get. A peek — the
   * server allocates nothing until a machine actually lands in the shop — so choosing
   * a shop and cancelling costs the shop's numbering nothing. Never cached: another
   * till paired meanwhile moves it on.
   */
  const { data: pairNextRegister } = useQuery<{ shopId: string; nextRegisterNumber: number }>({
    queryKey: ['shops', pairShopId, 'next-register-number'],
    queryFn: () => api.get(`/shops/${pairShopId}/next-register-number`).then((r) => r.data),
    enabled: !!pairShopId && pairOpen,
    staleTime: 0,
  });

  /**
   * Machines in scope. A device in scope is that device alone; a shop is its
   * machines; a company is every machine in every shop under it (the scope's
   * `machineOptions` already resolves the subtree).
   */
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  /** "חיפוש מכשיר": the cloud's device search (serial, SIM, IP…), across shops and tenants. */
  const [deviceSearchOpen, setDeviceSearchOpen] = useState(false);
  /** `''` = every area, `none` = tills in no area, else an area id. */
  const [areaFilter, setAreaFilter] = useState('');
  const [areaTarget, setAreaTarget] = useState<PosMachine | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<PosMachine | null>(null);
  const [deviceModelTarget, setDeviceModelTarget] = useState<PosMachine | null>(null);
  const [terminalTarget, setTerminalTarget] = useState<TerminalNumberTarget | null>(null);
  /** Narrow the rows to tills on the wrong card terminal (the alert's toggle). */
  const [onlyTerminalMismatch, setOnlyTerminalMismatch] = useState(false);

  const visibleMachines = effective.machineId
    ? machines.filter((m) => sameId(m.id, effective.machineId))
    : effective.shopId
      ? machines.filter((m) => sameId(m.shopId, effective.shopId))
      : effective.companyId
        ? machines.filter((m) => scope.machineOptions.some((o) => sameId(o.id, m.id)))
        : machines;

  const resetPairDialog = () => {
    setMachineCode('');
    setPairingCode(null);
    setPairingCodeId(null);
    setPairingComplete(false);
    setPairCompanyId('');
    setPairShopId('');
    setPairPreAssignLabel(null);
    setPairDeviceModel('');
    setPairDeviceRole('');
    setPairKiosk(EMPTY_KIOSK_DRAFT);
    setPairPlatform('android');
    setPairKds(EMPTY_KDS_SCREEN);
    setPairWorkConfig(EMPTY_WORK_CONFIG);
    setPairWorkConfigOutcome(null);
  };

  /**
   * "Add a terminal" from a group header. The company and shop are already known at
   * that point, so the operator never has to re-pick them — choosing the wrong branch
   * in the dialog is exactly the mistake this removes. The label is provisional; the
   * generate step recomputes it from the loaded lists.
   */
  const openPairForShop = (shop: Shop, companyLabel: string) => {
    resetPairDialog();
    setPairCompanyId(shop.companyId);
    setPairShopId(shop.id);
    setPairPreAssignLabel(companyLabel ? `${companyLabel} — ${shop.name}` : shop.name);
    setPairOpen(true);
  };

  const finishPairDialog = () => {
    qc.invalidateQueries({ queryKey: ['machines'] });
    setPairOpen(false);
    resetPairDialog();
  };

  const generateCode = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/pairing/generate', body),
    onSuccess: (res) => {
      setPairingCode(res.data.code);
      setPairingCodeId(res.data.id);
      setPairingComplete(false);
    },
    // A kiosk without a shop, or a controlling till that is not valid: the server's Hebrew.
    onError: (err: unknown) =>
      toast.error(deviceProfileErrorMessage(err) ?? axiosErrorToToastMessage(err, tc('error'))),
  });
  const pairDraft = {
    role: pairDeviceRole,
    model: pairDeviceModel,
    machineCode,
    companyId: pairCompanyId,
    shopId: pairShopId,
    platform: pairPlatform,
    kds: pairKds,
  };
  const pairMissing = addDeviceMissing(pairDraft);
  const pairWorkConfigPlan = pairShopId && pairDeviceRole ? workConfigPlanOf(pairWorkConfig, 'pairing') : null;
  const pairWorkConfigOutcomeText = pairingOutcomeText(pairWorkConfigOutcome);
  const pairMissingHint =
    pairMissing === 'role'
      ? t('deviceRole.required')
      : pairMissing === 'model'
        ? t('deviceModel.required')
        : pairMissing === 'shop'
          ? pairIsDisplay
            ? t('deviceRole.displayNeedsShop')
            : t('deviceRole.kioskNeedsShop')
          : pairMissing === 'stations'
            ? t('deviceRole.stationsRequired')
            : undefined;

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
      qc.invalidateQueries({ queryKey: ['machines'] });
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
    onError: (err: unknown) => toast.error(zErrors.forError(err)),
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
    onError: (err: unknown) => toast.error(zErrors.forError(err)),
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
    onError: (err: unknown) => toast.error(zErrors.forError(err)),
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

  // Poll until the POS consumes the pairing code, then refresh the machines list.
  // With a work configuration: until applying it has an outcome too (it runs right after).
  const pairAwaitingWorkConfig = pairingComplete && !!pairWorkConfigPlan && pairWorkConfigOutcome === null;
  useEffect(() => {
    if (!pairOpen || !pairingCodeId || (pairingComplete && !pairAwaitingWorkConfig)) return;
    const poll = () => {
      void api
        .get<{
          isUsed: boolean;
          workConfig?: Record<string, unknown> | null;
          workConfigResult?: Record<string, unknown> | null;
        }>(`/pairing/codes/${pairingCodeId}`)
        .then((r) => {
          if (r.data.isUsed) {
            setPairingComplete(true);
            qc.invalidateQueries({ queryKey: ['machines'] });
          }
          const result = r.data.workConfigResult;
          if (r.data.isUsed && !r.data.workConfig) {
            // The plan changed nothing for a new device ("לפי הסניף" already): no outcome to wait for.
            setPairWorkConfigOutcome({ preset: null, plan: null, applied: null });
          } else if (r.data.isUsed && r.data.workConfig && result) {
            setPairWorkConfigOutcome({
              preset: (r.data.workConfig.preset as PairingOutcome['preset']) ?? null,
              plan: r.data.workConfig,
              applied: result.applied === true,
              message: typeof result.message === 'string' ? result.message : null,
            });
          }
        })
        .catch(() => undefined);
    };
    poll();
    const tmr = window.setInterval(poll, 2500);
    return () => window.clearInterval(tmr);
  }, [pairOpen, pairingCodeId, pairingComplete, pairAwaitingWorkConfig, qc]);

  /*
   * The server decides this now.
   *
   * It used to be recomputed here from `lastHeartbeatAt` against a 90-second constant
   * copied from the server. Two copies of one threshold is how a dashboard ends up
   * telling a manager a till is reachable while the server's own gate refuses it. Falls
   * back to the old local calculation only for a payload from a server that predates
   * `online`, so a mid-deploy page does not show every terminal as offline.
   */
  const isDeviceOnline = (m: PosMachine): boolean => {
    if (typeof m.online === 'boolean') return m.online;
    if (!m.lastHeartbeatAt) return false;
    const ts = new Date(m.lastHeartbeatAt).getTime();
    if (!Number.isFinite(ts)) return false;
    return nowMs - ts <= MQTT_ONLINE_WINDOW_MS;
  };

  /*
   * Status filter, applied after the scope filter.
   *
   * Counts come from `visibleMachines` rather than the filtered list, so selecting one
   * status does not rewrite the tallies underneath it — the point of the strip is to
   * see the whole picture while looking at one slice of it.
   */
  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of visibleMachines) {
      const s = machineStatus(m);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return counts;
  }, [visibleMachines]);

  /*
   * Search narrows the rows, never the tallies or the selection. It matches what is
   * printed on the row — the register label ("קופה 2"), the terminal's name and the
   * code on its sticker — so an operator holding a device can find it without knowing
   * which branch it is in.
   */
  const searchTerm = search.trim().toLowerCase();

  /*
   * The areas to filter by: the ones the tills in view are in now, read off the rows
   * themselves, so the filter works at any scope without a request per shop. With
   * several shops in view each area carries its shop's name — "Bar" is in more than one.
   */
  const areaOptions = useMemo(() => {
    const byId = new Map<string, { id: string; label: string }>();
    const shopIds = new Set(visibleMachines.map((m) => m.shopId ?? ''));
    for (const m of visibleMachines) {
      if (!m.areaId || byId.has(m.areaId)) continue;
      const shopName = shopIds.size > 1 ? findBySameId(shops, m.shopId)?.name : null;
      const name = m.areaName ?? m.areaId.slice(0, 8);
      byId.set(m.areaId, { id: m.areaId, label: shopName ? `${name} · ${shopName}` : name });
    }
    return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label, 'he-IL'));
  }, [shops, visibleMachines]);
  const areaFilterItems = [
    { value: '__all__', label: tAreas('filter.all') },
    { value: AREA_NONE, label: tAreas('filter.none') },
    ...areaOptions.map((o) => ({ value: o.id, label: o.label })),
  ];
  const activeAreaFilter =
    areaFilter === '' || areaFilter === AREA_NONE || areaOptions.some((o) => o.id === areaFilter)
      ? areaFilter
      : '';

  const terminalMismatchCount = visibleMachines.filter(
    (m) => m.terminalStatus === 'mismatch',
  ).length;

  // Every till of the shop, not only the rows the filters leave: the write reaches them all.
  const openTerminalForShop = (shop: Shop) =>
    setTerminalTarget({
      level: 'shop',
      shopId: shop.id,
      shopName: shop.name,
      machines: machines.filter((m) => sameId(m.shopId, shop.id)),
    });

  const shownMachines = (
    statusFilter ? visibleMachines.filter((m) => machineStatus(m) === statusFilter) : visibleMachines
  )
    .filter((m) => !onlyTerminalMismatch || m.terminalStatus === 'mismatch')
    .filter((m) =>
      activeAreaFilter === ''
        ? true
        : activeAreaFilter === AREA_NONE
          ? !m.areaId
          : m.areaId === activeAreaFilter,
    )
    .filter(
    (m) =>
      searchTerm === '' ||
      m.name.toLowerCase().includes(searchTerm) ||
      m.machineCode.toLowerCase().includes(searchTerm) ||
      // The serial on the unit's label, too (the cloud's full search: "חיפוש מכשיר").
      (m.serialNumber ?? '').toLowerCase().includes(searchTerm) ||
      (registerNumberOf(m) !== null &&
        t('registerLabel', { number: registerNumberOf(m)! }).includes(searchTerm)),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setRemoteFor(null)}>
            <MonitorCog className="h-4 w-4 ms-1" /> שליטה מרחוק
          </Button>
          {remoteFor !== undefined ? (
            <DeviceControlSheet
              scope={{ companyId: effective.companyId ?? null, shopId: effective.shopId ?? null }}
              context={{ machineId: remoteFor }}
              onDone={() => setRemoteFor(undefined)}
            />
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setDeviceSearchOpen(true)}>
            <Search className="h-4 w-4 ms-1" /> {t('deviceSearchButton')}
          </Button>
          {deviceSearchOpen ? (
            <DeviceSearchDialog
              open
              onClose={() => setDeviceSearchOpen(false)}
              shops={shops}
              companies={companies}
              superAdmin={authHydrated && me?.role === 'super_admin'}
            />
          ) : null}
          {canProduceZ ? (
            <Link
              href={zWizardHref(effective.shopId, effective.machineId)}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <FilePlus2 className="h-4 w-4 ms-1" /> {t('produceZ')}
            </Link>
          ) : null}
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
            {/* Named for what the operator wants, not for the mechanism that does it:
                the pairing code is a step inside "add a terminal", not the goal. */}
            <Plus className="h-4 w-4 ms-1" /> {t('addMachine')}
          </Button>
        </div>
      </div>

      {/* "מכשירים" | "קבוצות מכשירים" (the groups a catalog menu can be assigned to). */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('title')}>
        <Button
          role="tab"
          aria-selected={pageTab === 'devices'}
          variant={pageTab === 'devices' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setPageTab('devices')}
        >
          <Monitor className="h-4 w-4 ms-1" aria-hidden /> {tGroups('devicesTab')}
        </Button>
        <Button
          role="tab"
          aria-selected={pageTab === 'groups'}
          variant={pageTab === 'groups' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setPageTab('groups')}
        >
          <Layers className="h-4 w-4 ms-1" aria-hidden /> {tGroups('tab')}
        </Button>
      </div>

      {pageTab === 'groups' ? (
        <ScopeGate resolution={resolution}>
          <MachineGroupsPanel
            machines={machines}
            shops={shops}
            companies={companies}
            companyId={effective.companyId ?? null}
            canCreate={canCreateGroups}
          />
        </ScopeGate>
      ) : (
      <>
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

      <ScopeGate resolution={resolution}>
      {!isLoading ? <ClockDriftBanner machines={visibleMachines} /> : null}
      {/* "קידומות מסמכים כפולות בעסק" (docs/SPEC_DOCUMENT_PREFIX.md §5): the business's one tax file. */}
      <DocumentPrefixConflictsAlert
        companyId={effective.companyId}
        shopId={effective.shopId}
        canEdit={canProduceZ}
      />
      {!isLoading ? (
        <TerminalMismatchAlert
          count={terminalMismatchCount}
          onlyMismatch={onlyTerminalMismatch}
          onToggle={setOnlyTerminalMismatch}
        />
      ) : null}

      {/*
        Status tallies, doubling as a filter.

        Ordered by the resolver's own precedence so the states that need attention sit
        first and a shop with one sick till does not have to hunt for it among thirty
        healthy rows. A status with no terminals is omitted rather than shown as zero —
        a row of zeroes is noise, and their absence is already the answer.
      */}
      {!isLoading && visibleMachines.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setStatusFilter(null)}
            className={`rounded-full border px-3 py-1 text-xs ${
              statusFilter === null ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
            }`}
          >
            {tStatus('filterAll')} ({visibleMachines.length})
          </button>
          {(
            [
              'offline_with_unsynced',
              'offline',
              'pending_sync',
              'shift_close_pending',
              'no_open_shift',
              'online',
              'not_paired',
              'retired',
            ] as const
          )
            .filter((s) => (statusCounts.get(s) ?? 0) > 0)
            .map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(statusFilter === s ? null : s)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
                  statusFilter === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
                }`}
              >
                <MachineStatusDot m={{ status: s } as PosMachine} />
                {tStatus(`status.${s}`)} ({statusCounts.get(s)})
              </button>
            ))}
        </div>
      ) : null}

      {!isLoading && visibleMachines.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-sm">
            <Search
              className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('searchPlaceholder')}
              aria-label={t('search')}
              // Both sides restated: the base input's shared `px` is dropped the moment
              // one logical side is overridden, which would leave no end padding.
              className="ps-9 pe-2.5"
            />
          </div>
          <Select
            value={activeAreaFilter || '__all__'}
            onValueChange={(v) => setAreaFilter(!v || v === '__all__' ? '' : String(v))}
            items={areaFilterItems}
          >
            <SelectTrigger className="w-auto min-w-44" aria-label={tAreas('filter.label')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {areaFilterItems.map((i) => (
                <SelectItem key={i.value} value={i.value} label={i.label}>
                  {i.label}
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
        {shownMachines.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
            <Monitor className="h-10 w-10 opacity-30" />
            <p className="text-center">{t('noMachinesForSearch')}</p>
          </div>
        ) : (
          <MachinesTable
            machines={shownMachines}
            shops={shops}
            companies={companies}
            permissions={{
              authHydrated,
              canAssignMachine,
              canEditAssignedShop,
              canRemoveMachine,
              canProduceZ,
            }}
            actions={{
              onAssign: openAssign,
              onEditShop: openShopEdit,
              onPush: openPush,
              onRemove: openRemove,
              onCloseShift: setCloseShiftTarget,
              onTransmit: setTransmitTarget,
              onEditArea: setAreaTarget,
              onEditSettings: setSettingsTarget,
              onEditDeviceModel: setDeviceModelTarget,
              onTerminalNumber: (m) => setTerminalTarget({ level: 'machine', machine: m }),
              onRequestTillZ: setTillZTarget,
              onEditZMode: setZModeTarget,
              onRemoteControl: (m) => setRemoteFor(m.id),
            }}
            isDeviceOnline={isDeviceOnline}
            onAddMachineToShop={openPairForShop}
            onTerminalNumberForShop={canProduceZ ? openTerminalForShop : undefined}
          />
        )}
        </>
      )}
      </ScopeGate>
      </>
      )}

      <Dialog
        open={pairOpen}
        onOpenChange={(open) => {
          setPairOpen(open);
          if (!open) resetPairDialog();
        }}
      >
        <DialogContent className="max-h-[92dvh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('pairTitle')}</DialogTitle>
          </DialogHeader>
          {pairingCode ? (
            <div className="text-center space-y-3 py-4">
              {pairingComplete ? (
                <>
                  <p className="text-sm font-medium text-primary">{t('pairComplete')}</p>
                  <p className="text-xs text-muted-foreground">{t('pairCompleteHint')}</p>
                  {/* "תצורת עבודה": applied, or why not (the device page offers "החל עכשיו"). */}
                  {pairWorkConfigOutcomeText ? (
                    <p
                      className={
                        pairWorkConfigOutcomeText.tone === 'ok'
                          ? 'text-xs text-emerald-700 dark:text-emerald-400'
                          : 'text-xs text-destructive'
                      }
                    >
                      {pairWorkConfigOutcomeText.text}
                    </p>
                  ) : pairAwaitingWorkConfig ? (
                    <p className="text-xs text-muted-foreground animate-pulse">מחיל את תצורת העבודה…</p>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="text-muted-foreground text-sm">{t('pairInstruction')}</p>
                  <p className="text-4xl font-mono font-bold tracking-widest text-primary">{pairingCode}</p>
                  <p className="text-xs text-muted-foreground">{t('pairExpiry')}</p>
                  <p className="text-sm text-muted-foreground animate-pulse">{t('pairWaiting')}</p>
                  {/* "דפדפן (Web)": the kiosk's link and QR with the code (docs/SPEC_KIOSK.md §27). */}
                  {pairDeviceRole === 'kiosk' && pairPlatform === 'web' ? <WebKioskLink code={pairingCode} /> : null}
                  {/* The browser KDS / board: `/kds`, `/board` with the code (docs/SPEC_KDS.md §13). */}
                  {(pairDeviceRole === 'kds' || pairDeviceRole === 'order_status_board') && pairPlatform === 'web' ? (
                    <WebScreenLink code={pairingCode} role={pairDeviceRole} />
                  ) : null}
                </>
              )}
              {pairPreAssignLabel ? (
                <p className="text-sm text-muted-foreground">{t('pairPreAssigned', { target: pairPreAssignLabel })}</p>
              ) : null}
              {pairDeviceRole === 'kiosk' ? (
                <p className="text-sm text-muted-foreground">{t('deviceRole.kioskReady')}</p>
              ) : null}
              {pairIsDisplay ? (
                <p className="text-sm text-muted-foreground">{t('deviceRole.displayReady')}</p>
              ) : null}
              {/* A peek, not a reservation: shown only until the device pairs, since the
                  shop's next number moves on the moment this one is taken. A screen gets none. */}
              {!pairingComplete &&
              !pairIsDisplay &&
              pairShopId &&
              pairNextRegister &&
              sameId(pairNextRegister.shopId, pairShopId) ? (
                <p className="text-sm font-medium">
                  {t('pairWillGetNumber', { number: pairNextRegister.nextRegisterNumber })}
                </p>
              ) : null}
              {pairingComplete ? (
                <Button className="w-full" onClick={finishPairDialog}>
                  {t('pairFinish')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPairingCode(null);
                    setPairingCodeId(null);
                    setPairingComplete(false);
                    setPairPreAssignLabel(null);
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5 me-1" /> {t('generateNew')}
                </Button>
              )}
            </div>
          ) : (
            <>
              {/* "סוג מכשיר (תפקיד)" and "דגם מכשיר": both required (docs/SPEC_DEVICE_ROLE_MODEL.md). */}
              <div className="space-y-2">
                <Label>{t('deviceRole.label')}</Label>
                <DeviceRolePicker
                  value={pairDeviceRole}
                  onChange={(role) => {
                    setPairDeviceRole(role);
                    setPairWorkConfig(EMPTY_WORK_CONFIG);
                    // The browser runs a kiosk, a KDS or a board — never a till.
                    if (!platformsFor(role).includes(pairPlatform)) setPairPlatform('android');
                  }}
                />
                {pairIsDisplay ? (
                  <p className="rounded-md bg-sky-50 p-2 text-xs text-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
                    {t('deviceRole.kdsNote')}
                  </p>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label>{t('deviceRole.platform')}</Label>
                <DevicePlatformPicker
                  value={pairPlatform}
                  onChange={(platform) => {
                    setPairPlatform(platform);
                    setPairWorkConfig(EMPTY_WORK_CONFIG);
                  }}
                  role={pairDeviceRole}
                />
                <p className="text-xs text-muted-foreground">{t('deviceRole.platformHint')}</p>
              </div>
              {modelNeeded({ platform: pairPlatform }) ? (
                <div className="space-y-2">
                  <Label htmlFor="pair-device-model">{t('deviceModel.label')}</Label>
                  <DeviceModelSelect
                    id="pair-device-model"
                    value={pairDeviceModel}
                    onChange={setPairDeviceModel}
                  />
                  {pairDeviceModel && !pairIsDisplay ? (
                    <DeviceCapabilityList model={pairDeviceModel} kiosk={pairDeviceRole === 'kiosk'} />
                  ) : !pairDeviceModel ? (
                    <p className="text-xs text-muted-foreground">{t('deviceModel.hint')}</p>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{pairPlatform === 'web'
                    ? pairDeviceRole === 'kds' || pairDeviceRole === 'order_status_board'
                      ? t('deviceRole.webScreenNoModel')
                      : t('deviceRole.webNoModel')
                    : t('deviceRole.windowsNoModel')}</p>
              )}
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
                  <p className="text-sm font-medium">
                    {pairDeviceRole === 'kiosk'
                      ? t('deviceRole.kioskNeedsShop')
                      : roleNeedsShop(pairDeviceRole)
                        ? t('deviceRole.displayNeedsShop')
                        : t('pairAssignOptional')}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">{t('pairAssignHint')}</p>
                </div>
                <div className="space-y-2">
                  <Label>{t('selectCompanyOptional')}</Label>
                  <Select
                    value={pairCompanyId}
                    onValueChange={(v) => {
                      setPairCompanyId(v ?? '');
                      setPairShopId('');
                      setPairWorkConfig(EMPTY_WORK_CONFIG);
                      // A kiosk's controlling tills are of its own company.
                      setPairKiosk((k) => ({ ...k, controllerMachineIds: [] }));
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
                    onValueChange={(v) => {
                      setPairShopId(v ?? '');
                      setPairWorkConfig(EMPTY_WORK_CONFIG);
                    }}
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
                  {pairShopId &&
                  !pairIsDisplay &&
                  pairNextRegister &&
                  sameId(pairNextRegister.shopId, pairShopId) ? (
                    <p className="text-xs text-muted-foreground">
                      {t('pairNextRegister', {
                        label: t('registerLabel', { number: pairNextRegister.nextRegisterNumber }),
                      })}
                    </p>
                  ) : null}
                </div>
              </div>
              {/* A kiosk's name, controlling tills and device lock — made as it pairs. */}
              {pairDeviceRole === 'kiosk' ? (
                <KioskOptionsFields
                  shopId={pairShopId || null}
                  machineId={null}
                  value={pairKiosk}
                  onChange={setPairKiosk}
                />
              ) : null}
              {/* A KDS's screen (kind, stations) or the board's name — made as it pairs. */}
              {pairDeviceRole === 'kds' || pairDeviceRole === 'order_status_board' ? (
                <KdsScreenFields
                  shopId={pairShopId || null}
                  role={pairDeviceRole}
                  value={pairKds}
                  onChange={setPairKds}
                />
              ) : null}
              {/* "תצורת עבודה": after the shop and the role — "לפי הסניף" unless chosen. */}
              {pairShopId && pairDeviceRole ? (
                <WorkConfigStep
                  shopId={pairShopId}
                  role={pairDeviceRole}
                  platform={pairPlatform}
                  value={pairWorkConfig}
                  onChange={setPairWorkConfig}
                />
              ) : null}
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
                    if (pairMissing) return;
                    setPairWorkConfigOutcome(null);
                    generateCode.mutate({
                      ...pairingRequestBody(pairDraft, pairKiosk),
                      ...(pairWorkConfigPlan ? { workConfig: pairWorkConfigPlan } : {}),
                    });
                  }}
                  disabled={
                    !!pairMissing ||
                    generateCode.isPending ||
                    (!!pairWorkConfigPlan && !!workConfigDraftError(pairWorkConfig, null)) ||
                    (pairDeviceRole === 'kiosk' && !!kioskDraftError(pairKiosk))
                  }
                  title={pairMissingHint}
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

      <MachineAreaDialog
        machine={areaTarget}
        open={!!areaTarget}
        onOpenChange={(open) => (!open ? setAreaTarget(null) : undefined)}
      />

      {/* This till's own POS settings, over what it inherits from its shop. */}
      <EntityPosSettingsDialog
        level="machine"
        entityId={settingsTarget?.id ?? null}
        open={!!settingsTarget}
        onOpenChange={(open) => (!open ? setSettingsTarget(null) : undefined)}
      />

      {/* "סוג מכשיר": role and model, changed together over a clean break. */}
      <DeviceProfileDialog
        machine={deviceModelTarget}
        open={!!deviceModelTarget}
        onOpenChange={(open) => (!open ? setDeviceModelTarget(null) : undefined)}
      />

      {/* One till's card terminal number, or every till's in a shop. */}
      <TerminalNumberDialog
        key={
          terminalTarget
            ? terminalTarget.level === 'machine'
              ? `terminal-${terminalTarget.machine.id}`
              : `terminal-shop-${terminalTarget.shopId}`
            : 'terminal-none'
        }
        target={terminalTarget}
        open={!!terminalTarget}
        onOpenChange={(open) => (!open ? setTerminalTarget(null) : undefined)}
      />

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
                  expiresAt: formatDateTime(fieldSession.expiresAt),
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

      <RemoteShiftCloseDialog
        key={closeShiftTarget?.id ?? 'none'}
        machine={closeShiftTarget}
        open={!!closeShiftTarget}
        onOpenChange={(next) => {
          if (!next) setCloseShiftTarget(null);
        }}
      />

      <TransmitNowDialog
        key={`transmit-${transmitTarget?.id ?? 'none'}`}
        machine={transmitTarget}
        open={!!transmitTarget}
        onOpenChange={(next) => {
          if (!next) setTransmitTarget(null);
        }}
      />

      <RequestTillZDialog
        key={`till-z-${tillZTarget?.id ?? 'none'}`}
        machine={tillZTarget}
        open={!!tillZTarget}
        onOpenChange={(next) => {
          if (!next) setTillZTarget(null);
        }}
      />

      <ZModeDialog
        machine={zModeTarget}
        open={!!zModeTarget}
        onOpenChange={(next) => {
          if (!next) setZModeTarget(null);
        }}
      />
    </div>
  );
}
