'use client';

import { useMemo, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
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
import { buildCompanyTree, companyPathLabel } from '@/lib/companyTree';
import {
  DEFAULT_SORT,
  EMPTY_FILTERS,
  STORAGE_KEY as DEVICES_VIEW_STORAGE_KEY,
  applyDeviceFilters,
  hasActiveFilters,
  hasViewParams,
  nextSort,
  parseStoredView,
  serializeStoredView,
  sortDevices,
  viewFromParams,
  viewToParams,
  type DeviceFilters,
  type DeviceSort,
  type DeviceViewContext,
  type DevicesLayout,
  type StoredDevicesView,
} from '@/lib/devicesView';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import Link from 'next/link';
import { Monitor, Plus, RefreshCw, Info, Trash2, Smartphone, FilePlus2, Search, SearchX, Send, Layers, MonitorCog } from 'lucide-react';
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
import { DevicesList, useIsWideScreen } from '@/components/dashboard/machines/devices-list';
import { DevicesToolbar, useDeviceFilterOptions } from '@/components/dashboard/machines/devices-toolbar';
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
import { DeviceLicensePicker, LicenseCountsPanel } from '@/components/dashboard/machines/device-license';
import { licensedRoleOf, pairingLicenseOf, type LicenseProduct } from '@/lib/deviceLicense';
import { WebKioskLink } from '@/components/dashboard/machines/web-kiosk-link';
import { DeviceTerminalFields } from '@/components/dashboard/machines/device-terminal';
import {
  defaultTerminalType,
  emptyTerminalDraft,
  takesTerminal,
  terminalDraftHasErrors,
  terminalPairingBody,
  terminalTypesFor,
  type TerminalDraft,
} from '@/lib/deviceTerminal';
import { WebScreenLink } from '@/components/dashboard/machines/web-screen-link';
import { CustomerDisplayPairingFields, CustomerDisplayWebLink } from '@/components/dashboard/customer-display/customer-display-devices';
import { WorkConfigStep } from '@/components/dashboard/machines/work-config';
import { useEventTillSelection } from '@/components/dashboard/events/assign-to-event';
import { ShopSyncDialog } from '@/components/dashboard/machines/sync-status';
import { fetchSyncStatuses } from '@/lib/syncStatusApi';

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map();
import {
  EMPTY_DRAFT as EMPTY_WORK_CONFIG,
  draftError as workConfigDraftError,
  pairingOutcomeText,
  planOf as workConfigPlanOf,
  type PairingOutcome,
  type WorkConfigDraft,
} from '@/lib/workConfig';
import { buildPairingQr, expiryEpochSeconds, resolvePairingServer } from '@/lib/pairingCodeQr';
import {
  DEVICE_NAME_MAX,
  EMPTY_KDS_SCREEN,
  addDeviceMissing,
  deviceProfileErrorMessage,
  expectedRegisterNumber,
  isFiscalRole,
  capabilitiesOf,
  modelNeeded,
  pairingRequestBody,
  platformOfChoice,
  platformsFor,
  WINDOWS7_CHOICE,
  roleNeedsShop,
  type DevicePlatform,
  type DeviceRole,
  type KdsScreenDraft,
  type KioskDraft,
} from '@/lib/deviceProfile';

const MQTT_ONLINE_WINDOW_MS = 300 * 1000;

/** The viewer's remembered search, filters, sort and layout; null when none (or storage is refused). */
function readStoredDevicesView(): StoredDevicesView | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(DEVICES_VIEW_STORAGE_KEY);
    return raw ? parseStoredView(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Where the list starts: a link's own filters win (a view someone shared), else what this viewer
 * left it at, else everything. The layout is the viewer's alone — never in the link.
 */
function initialDevicesView(search: string): StoredDevicesView {
  const stored = readStoredDevicesView();
  if (hasViewParams(search)) return { ...viewFromParams(search), layout: stored?.layout ?? 'table' };
  return stored ?? { filters: EMPTY_FILTERS, sort: DEFAULT_SORT, layout: 'table' };
}

export default function MachinesPage() {
  const t = useTranslations('machines');
  const tv = useTranslations('machines.devicesView');
  const tModel = useTranslations('machines.deviceModel');
  const tRole = useTranslations('machines.deviceRole');
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
  /**
   * "שם המכשיר" — optional, a till's. Blank: the server names it ("קופה N" once it has its number).
   * (The "קוד מכשיר" this field replaces was required but never sent: the server makes the machine's code.)
   */
  const [pairName, setPairName] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingCodeId, setPairingCodeId] = useState<string | null>(null);
  /** When the code expires (the server's `expiresAt`): the QR carries it, so the till can refuse a late scan. */
  const [pairingExpiresAt, setPairingExpiresAt] = useState<string | null>(null);
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
  /** "סוג רישיון" for a till / kiosk ('' — the role's default; lib/deviceLicense.ts). */
  const [pairLicense, setPairLicense] = useState<LicenseProduct | ''>('');
  const [pairKiosk, setPairKiosk] = useState<KioskDraft>(EMPTY_KIOSK_DRAFT);
  /**
   * "מסופון אשראי" (lib/deviceTerminal.ts): a till's or a kiosk's terminal type and its fields, for the role it
   * was chosen for. Null (or a type the device cannot take after a role / platform / model change): today's
   * default — a kiosk on a Nayax pinpad, a till by the shop.
   */
  const [pairTerminalState, setPairTerminal] = useState<{ role: DeviceRole | ''; draft: TerminalDraft } | null>(null);
  /** Android unless chosen: a Windows install cannot redeem an Android code, nor back. */
  const [pairPlatform, setPairPlatform] = useState<DevicePlatform>('android');
  /** "Windows 7 (קופה)" (P:/specs/windows7-till.md): a Windows till for the Windows 7 build — till only, "קופה בלבד". */
  const [pairWin7, setPairWin7] = useState(false);
  /** A KDS's screen (kind, stations) / the board's name: made as it pairs. */
  const [pairKds, setPairKds] = useState<KdsScreenDraft>(EMPTY_KDS_SCREEN);
  /** "מסך לקוח": the till it mirrors ('' = chosen later on the customer-display page). */
  const [pairMirrorTill, setPairMirrorTill] = useState('');
  /** "מסך — לא קופה": a KDS or the board gets no register number, no sales, no Z. */
  // "שרת מקומי" (P:/specs/dedicated-local-server.md) is not a till either, but no screen: its own notes.
  // "שרת מזומן" (P:/specs/cash-paylink.md) is a server too: Windows, a shop, a name, no work config.
  const pairIsCashHost = pairDeviceRole === 'cash_host';
  const pairIsServer = pairDeviceRole === 'local_server' || pairIsCashHost;
  const pairIsDisplay = pairDeviceRole !== '' && !isFiscalRole(pairDeviceRole) && !pairIsServer;
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
  // "שייך לאירוע" (feat/event-quick-assign): its button, the table's checkboxes, its bar and dialogs.
  const eventAssign = useEventTillSelection({ machines, shops });
  /**
   * "חיפוש מכשיר": the cloud's device search (serial, SIM, IP…), across shops and tenants — for
   * what is outside the scope. Opened from the list's empty answer, it starts with its search.
   */
  const [deviceSearchOpen, setDeviceSearchOpen] = useState(false);
  const [deviceSearchQuery, setDeviceSearchQuery] = useState('');
  const [areaTarget, setAreaTarget] = useState<PosMachine | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<PosMachine | null>(null);
  const [deviceModelTarget, setDeviceModelTarget] = useState<PosMachine | null>(null);
  const [terminalTarget, setTerminalTarget] = useState<TerminalNumberTarget | null>(null);
  /** Narrow the rows to tills on the wrong card terminal (the alert's toggle). */
  const [onlyTerminalMismatch, setOnlyTerminalMismatch] = useState(false);

  const visibleMachines = useMemo(
    () =>
      effective.machineId
        ? machines.filter((m) => sameId(m.id, effective.machineId))
        : effective.shopId
          ? machines.filter((m) => sameId(m.shopId, effective.shopId))
          : effective.companyId
            ? machines.filter((m) => scope.machineOptions.some((o) => sameId(o.id, m.id)))
            : machines,
    [machines, effective.machineId, effective.shopId, effective.companyId, scope.machineOptions],
  );

  /*
   * "מכשירים" — one search, the filters, the sort and the layout (lib/devicesView.ts). They live
   * in the page's query too (next to the scope's own `company` / `shop` / `machine`), so a
   * filtered list can be shared or bookmarked, and per viewer in localStorage, so the page opens
   * the way it was left. Read once as the page mounts; written back a moment after a change
   * (typing does not rewrite the address on every key).
   */
  const searchParams = useSearchParams();
  const [initialView] = useState(() => initialDevicesView(searchParams.toString()));
  const [filters, setFilters] = useState<DeviceFilters>(initialView.filters);
  const [sort, setSort] = useState<DeviceSort>(initialView.sort);
  const [layout, setLayout] = useState<DevicesLayout>(initialView.layout);
  // A phone always gets cards; table or cards is a desktop's choice.
  const wide = useIsWideScreen();
  const shownLayout: DevicesLayout = wide ? layout : 'cards';

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const query = viewToParams(window.location.search, filters, sort);
      const href = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
      if (href !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
        // Next keeps its router in step with a native replaceState (no history entry, no refetch).
        window.history.replaceState(null, '', href);
      }
      try {
        window.localStorage.setItem(DEVICES_VIEW_STORAGE_KEY, serializeStoredView({ filters, sort, layout }));
      } catch {
        // Private browsing refuses storage; the page still works, it just will not remember.
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [filters, sort, layout]);

  const companyTree = useMemo(() => buildCompanyTree(companies), [companies]);
  const viewContext = useMemo<DeviceViewContext>(
    () => ({
      shopName: (id) => findBySameId(shops, id)?.name,
      companyName: (id) => {
        const shop = findBySameId(shops, id);
        return shop ? companyPathLabel(companyTree, shop.companyId, '') : null;
      },
      registerLabel: (n) => t('registerLabel', { number: n }),
      modelLabel: (m) => (tModel.has(m) ? tModel(m) : m),
      roleLabel: (r) => (tRole.has(r) ? tRole(r) : r),
      platformLabel: (p) => tRole(`platforms.${p}`),
    }),
    [shops, companyTree, t, tModel, tRole],
  );
  const filterResult = useMemo(
    () => applyDeviceFilters(visibleMachines, filters, viewContext),
    [visibleMachines, filters, viewContext],
  );
  const shownMachines = useMemo(
    () =>
      sortDevices(
        onlyTerminalMismatch ? filterResult.rows.filter((m) => m.terminalStatus === 'mismatch') : filterResult.rows,
        sort,
        viewContext,
      ),
    [filterResult, onlyTerminalMismatch, sort, viewContext],
  );
  const filterOptions = useDeviceFilterOptions({ rows: visibleMachines, result: filterResult, shops });

  /**
   * "סנכרון" (P:/specs/device-sync-status.md §3): each shown device's sync state — read apart from the
   * list (it compares with the cloud's versions), every minute; the column fills in when it arrives.
   */
  const syncIds = useMemo(
    () => shownMachines.filter((m) => m.shopId && m.isActive !== false).map((m) => m.id).sort(),
    [shownMachines],
  );
  const syncStatuses = useQuery({
    queryKey: ['machines-sync-status', syncIds.join(',')],
    queryFn: () => fetchSyncStatuses(syncIds),
    enabled: syncIds.length > 0,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const syncByMachine = useMemo(
    () => new Map((syncStatuses.data ?? []).map((s) => [s.machineId, s] as const)),
    [syncStatuses.data],
  );
  /** "סנכרן את כל הסניף": the shop, and its devices' names as they were when it was asked. */
  const [syncShop, setSyncShop] = useState<{ shop: Shop; names: ReadonlyMap<string, string> } | null>(null);
  const openSyncShop = (shop: Shop) =>
    setSyncShop({
      shop,
      names: new Map(machines.filter((m) => sameId(m.shopId, shop.id)).map((m) => [m.id, m.name] as const)),
    });

  const resetPairDialog = () => {
    setPairName('');
    setPairingCode(null);
    setPairingCodeId(null);
    setPairingExpiresAt(null);
    setPairingComplete(false);
    setPairCompanyId('');
    setPairShopId('');
    setPairPreAssignLabel(null);
    setPairDeviceModel('');
    setPairDeviceRole('');
    setPairLicense('');
    setPairKiosk(EMPTY_KIOSK_DRAFT);
    setPairTerminal(null);
    setPairPlatform('android');
    setPairWin7(false);
    setPairKds(EMPTY_KDS_SCREEN);
    setPairMirrorTill('');
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
      setPairingExpiresAt(typeof res.data.expiresAt === 'string' ? res.data.expiresAt : null);
      setPairingComplete(false);
    },
    // A kiosk without a shop, or a controlling till that is not valid: the server's Hebrew.
    onError: (err: unknown) =>
      toast.error(deviceProfileErrorMessage(err) ?? axiosErrorToToastMessage(err, tc('error'))),
  });
  const pairDraft = {
    role: pairDeviceRole,
    model: pairDeviceModel,
    name: pairName,
    companyId: pairCompanyId,
    shopId: pairShopId,
    platform: pairPlatform,
    windows7: pairWin7,
    kds: pairKds,
    mirrorTillId: pairMirrorTill,
  };
  const pairMissing = addDeviceMissing(pairDraft);
  const pairSells = takesTerminal(pairDeviceRole);
  const pairBuiltinTerminal =
    pairPlatform !== 'android' ? false : pairDeviceModel ? capabilitiesOf(pairDeviceModel, { kiosk: pairDeviceRole === 'kiosk' }).builtinTerminal : null;
  const pairTerminalTypes = terminalTypesFor({ role: pairDeviceRole, platform: pairPlatform, builtinTerminal: pairBuiltinTerminal });
  const pairTerminal: TerminalDraft =
    pairTerminalState && pairTerminalState.role === pairDeviceRole && pairTerminalTypes.includes(pairTerminalState.draft.type)
      ? pairTerminalState.draft
      : emptyTerminalDraft(defaultTerminalType(pairDeviceRole));
  const pairTerminalBody = pairSells ? terminalPairingBody(pairTerminal, pairDeviceRole) : null;
  /** "הקופה תקבל מספר N": the server's own peek for the chosen shop, before anything is created. */
  const pairExpectedNumber = expectedRegisterNumber(
    { role: pairDeviceRole, shopId: pairShopId },
    pairNextRegister,
  );
  /*
   * The QR beside the code (docs/SPEC_PAIRING_QR.md): the API base the device must reach — the dashboard's own
   * configured public API URL — with the code and its expiry, for the till's camera. Null (the code stays as
   * text) when there is nothing a device could use: no public API URL (a development box on localhost).
   * Android only: a Windows install and a browser have their own ways in.
   */
  const pairQrServer = resolvePairingServer(
    process.env.NEXT_PUBLIC_API_URL,
    typeof window === 'undefined' ? '' : window.location.origin,
  );
  const pairQr =
    pairingCode && pairPlatform === 'android'
      ? buildPairingQr({
          server: pairQrServer ?? '',
          code: pairingCode,
          exp: expiryEpochSeconds(pairingExpiresAt) ?? 0,
        })
      : null;
  const pairWorkConfigPlan = pairShopId && pairDeviceRole ? workConfigPlanOf(pairWorkConfig, 'pairing') : null;
  const pairWorkConfigOutcomeText = pairingOutcomeText(pairWorkConfigOutcome);
  const pairMissingHint =
    pairMissing === 'role'
      ? t('deviceRole.required')
      : pairMissing === 'model'
        ? t('deviceModel.required')
        : pairMissing === 'shop'
          ? pairIsCashHost
            ? t('deviceRole.cashHostNeedsShop')
            : pairIsServer
            ? t('deviceRole.localServerNeedsShop')
            : pairIsDisplay
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDeviceSearchQuery('');
              setDeviceSearchOpen(true);
            }}
            title={tv('searchEverywhereHint')}
          >
            <Search className="h-4 w-4 ms-1" /> {t('deviceSearchButton')}
          </Button>
          {pageTab === 'devices' ? eventAssign.button : null}
          {deviceSearchOpen ? (
            <DeviceSearchDialog
              open
              onClose={() => setDeviceSearchOpen(false)}
              shops={shops}
              companies={companies}
              superAdmin={authHydrated && me?.role === 'super_admin'}
              initialQuery={deviceSearchQuery}
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

      {/* "רישיונות מכשירים" — the count per license product, for billing (a super admin / distributor). */}
      {!isLoading ? <LicenseCountsPanel /> : null}

      {!isLoading && visibleMachines.length > 0 ? (
        <DevicesToolbar
          filters={filters}
          onFiltersChange={setFilters}
          options={filterOptions}
          shown={shownMachines.length}
          total={visibleMachines.length}
          sort={sort}
          onSortChange={setSort}
          layout={shownLayout}
          onLayoutChange={setLayout}
          canChooseLayout={wide}
        />
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
            <SearchX className="h-10 w-10 opacity-30" aria-hidden />
            <p className="text-center">{tv('noMatches')}</p>
            <div className="flex flex-wrap justify-center gap-2">
              {hasActiveFilters(filters) ? (
                <Button variant="outline" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
                  {tv('clearAll')}
                </Button>
              ) : null}
              {/* Not in this scope: perhaps in another shop — the cloud's search, with the same words. */}
              {filters.q.trim() ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setDeviceSearchQuery(filters.q);
                    setDeviceSearchOpen(true);
                  }}
                >
                  <Search className="h-4 w-4 ms-1" aria-hidden /> {tv('searchEverywhere')}
                </Button>
              ) : null}
            </div>
            {filters.q.trim() ? <p className="text-center text-xs">{tv('searchEverywhereHint')}</p> : null}
          </div>
        ) : (
          <DevicesList
            machines={shownMachines}
            layout={shownLayout}
            sort={sort}
            onSort={(key) => setSort((current) => nextSort(current, key))}
            newest={filterResult.newest}
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
            selection={pageTab === 'devices' ? eventAssign.selection : undefined}
            syncByMachine={syncByMachine}
            onSyncShop={openSyncShop}
          />
        )}
        </>
      )}
      </ScopeGate>
      {eventAssign.ui}
      <ShopSyncDialog
        shopId={syncShop?.shop.id ?? null}
        shopName={syncShop?.shop.name ?? ''}
        names={syncShop?.names ?? EMPTY_NAMES}
        open={syncShop !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSyncShop(null);
            qc.invalidateQueries({ queryKey: ['machines-sync-status'] });
          }
        }}
      />
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
                    <p className="text-xs text-muted-foreground animate-pulse">מחיל את תצורת המכשיר…</p>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="text-muted-foreground text-sm">{t('pairInstruction')}</p>
                  {/* The code, and beside it its QR for the till's camera ("סריקת קוד מהדשבורד" on the pairing screen). */}
                  <div className="flex flex-wrap items-center justify-center gap-4">
                    <p className="text-4xl font-mono font-bold tracking-widest text-primary">{pairingCode}</p>
                    {pairQr ? (
                      <div className="flex flex-col items-center gap-1">
                        <div className="rounded-md bg-white p-2">
                          <QRCodeSVG value={pairQr} size={148} level="M" />
                        </div>
                        <span className="text-xs text-muted-foreground">{t('pairQrHint')}</span>
                      </div>
                    ) : null}
                  </div>
                  {pairPlatform === 'android' && !pairQr ? (
                    <p className="text-xs text-muted-foreground">{t('pairQrUnavailable')}</p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">{t('pairExpiry')}</p>
                  <p className="text-sm text-muted-foreground animate-pulse">{t('pairWaiting')}</p>
                  {/* "דפדפן (Web)": the kiosk's link and QR with the code (docs/SPEC_KIOSK.md §27). */}
                  {pairDeviceRole === 'kiosk' && pairPlatform === 'web' ? <WebKioskLink code={pairingCode} /> : null}
                  {/* The browser KDS / board: `/kds`, `/board` with the code (docs/SPEC_KDS.md §13). */}
                  {(pairDeviceRole === 'kds' || pairDeviceRole === 'order_status_board') && pairPlatform === 'web' ? (
                    <WebScreenLink code={pairingCode} role={pairDeviceRole} />
                  ) : null}
                  {/* "מסך לקוח" in a browser: /display with the code (P:/specs/customer-display.md §4). */}
                  {pairDeviceRole === 'customer_display' && pairPlatform === 'web' ? <CustomerDisplayWebLink code={pairingCode} /> : null}
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
              {pairIsServer ? (
                <p className="text-sm text-muted-foreground">
                  {pairIsCashHost ? t('deviceRole.cashHostReady') : t('deviceRole.localServerReady')}
                </p>
              ) : null}
              {/* A peek, not a reservation: shown only until the device pairs, since the
                  shop's next number moves on the moment this one is taken. A screen gets none. */}
              {!pairingComplete && pairExpectedNumber !== null ? (
                <p className="text-sm font-medium">{t('pairWillGetNumber', { number: pairExpectedNumber })}</p>
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
                    setPairLicense('');
                    setPairWorkConfig(EMPTY_WORK_CONFIG);
                    // The browser runs a kiosk, a KDS or a board — never a till; a cash server is Windows only.
                    if (!platformsFor(role).includes(pairPlatform)) setPairPlatform(platformsFor(role)[0] ?? 'android');
                    // "Windows 7 (קופה)" is a till's only.
                    if (role !== 'till') setPairWin7(false);
                  }}
                />
                {pairIsDisplay ? (
                  <p className="rounded-md bg-sky-50 p-2 text-xs text-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
                    {t('deviceRole.kdsNote')}
                  </p>
                ) : null}
                {pairIsServer && !pairIsCashHost ? (
                  <p className="rounded-md bg-violet-50 p-2 text-xs text-violet-900 dark:bg-violet-950/40 dark:text-violet-200">
                    {t('deviceRole.localServerNote')}
                  </p>
                ) : null}
                {pairIsCashHost ? (
                  <p className="rounded-md bg-emerald-50 p-2 text-xs text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
                    {t('deviceRole.cashHostNote')}
                  </p>
                ) : null}
              </div>
              {/* "סוג רישיון" (P:/specs/device-license-type.md): a till or a kiosk only — the role's default first. */}
              {licensedRoleOf(pairDeviceRole) ? (
                <div className="space-y-2">
                  <Label>{t('license.label')}</Label>
                  <DeviceLicensePicker
                    role={pairDeviceRole}
                    value={pairWin7 ? 'till' : pairingLicenseOf(pairDeviceRole, pairLicense) ?? ''}
                    onChange={setPairLicense}
                    // Windows 7 runs the till only: "קופה בלבד", nothing else.
                    options={pairWin7 ? ['till'] : undefined}
                  />
                  <p className="text-xs text-muted-foreground">{t('license.hint')}</p>
                </div>
              ) : null}
              <div className="space-y-2">
                <Label>{t('deviceRole.platform')}</Label>
                <DevicePlatformPicker
                  value={pairWin7 ? WINDOWS7_CHOICE : pairPlatform}
                  onChange={(choice) => {
                    setPairPlatform(platformOfChoice(choice));
                    setPairWin7(choice === WINDOWS7_CHOICE);
                    // Windows 7 is a till only (role and license fixed).
                    if (choice === WINDOWS7_CHOICE) {
                      setPairDeviceRole('till');
                      setPairLicense('till');
                    }
                    setPairWorkConfig(EMPTY_WORK_CONFIG);
                  }}
                  role={pairDeviceRole}
                />
                <p className="text-xs text-muted-foreground">{t('deviceRole.platformHint')}</p>
                {pairWin7 ? (
                  <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    {t('deviceRole.windows7Note')}
                  </p>
                ) : null}
              </div>
              {modelNeeded({ platform: pairPlatform }) ? (
                <div className="space-y-2">
                  <Label htmlFor="pair-device-model">{t('deviceModel.label')}</Label>
                  <DeviceModelSelect
                    id="pair-device-model"
                    value={pairDeviceModel}
                    onChange={setPairDeviceModel}
                  />
                  {pairDeviceModel && !pairIsDisplay && !pairIsServer ? (
                    <DeviceCapabilityList model={pairDeviceModel} kiosk={pairDeviceRole === 'kiosk'} />
                  ) : !pairDeviceModel ? (
                    <p className="text-xs text-muted-foreground">{t('deviceModel.hint')}</p>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{pairPlatform === 'web'
                    ? pairDeviceRole === 'kds' || pairDeviceRole === 'order_status_board' || pairDeviceRole === 'customer_display'
                      ? t('deviceRole.webScreenNoModel')
                      : t('deviceRole.webNoModel')
                    : t('deviceRole.windowsNoModel')}</p>
              )}
              {/* "שם המכשיר" — optional, a till's (and a local server's). Blank: "קופה N" / "שרת מקומי". */}
              {pairDeviceRole === 'till' || pairIsServer ? (
                <div className="space-y-2">
                  <Label htmlFor="pair-device-name">{t('deviceName.label')}</Label>
                  <Input
                    id="pair-device-name"
                    value={pairName}
                    maxLength={DEVICE_NAME_MAX}
                    onChange={(e) => setPairName(e.target.value)}
                    placeholder={
                      pairIsCashHost
                        ? t('deviceRole.cash_host')
                        : pairIsServer
                        ? t('deviceRole.local_server')
                        : pairExpectedNumber !== null
                          ? t('registerLabel', { number: pairExpectedNumber })
                          : t('deviceName.placeholder')
                    }
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">{t('deviceName.hint')}</p>
                </div>
              ) : null}
              <div className="space-y-3 rounded-lg border border-dashed p-3">
                <div>
                  <p className="text-sm font-medium">
                    {pairDeviceRole === 'kiosk'
                      ? t('deviceRole.kioskNeedsShop')
                      : pairIsCashHost
                        ? t('deviceRole.cashHostNeedsShop')
                        : pairIsServer
                        ? t('deviceRole.localServerNeedsShop')
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
                  {/* Before "צור": the number the server would give a till in this shop now — a peek, nothing reserved. */}
                  {pairExpectedNumber !== null ? (
                    <p
                      role="status"
                      className="rounded-md bg-primary/10 px-3 py-2 text-sm font-medium text-primary"
                    >
                      {t('pairWillGetNumber', { number: pairExpectedNumber })}
                      <span className="block text-xs font-normal text-muted-foreground">
                        {t('pairWillGetNumberHint')}
                      </span>
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
              {/* "מסופון אשראי": the terminal type the device's platform and role can charge on, and its fields. */}
              {pairSells ? (
                <DeviceTerminalFields
                  role={pairDeviceRole as 'till' | 'kiosk'}
                  platform={pairPlatform}
                  builtinTerminal={pairBuiltinTerminal}
                  value={pairTerminal}
                  onChange={(draft) => setPairTerminal({ role: pairDeviceRole, draft })}
                  idPrefix="pair-terminal"
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
              {/* "מסך לקוח": its name and the till it mirrors. */}
              {pairDeviceRole === 'customer_display' ? (
                <CustomerDisplayPairingFields
                  shopId={pairShopId || null}
                  name={pairKds.name}
                  onNameChange={(name) => setPairKds({ ...pairKds, name })}
                  tillId={pairMirrorTill}
                  onTillChange={setPairMirrorTill}
                />
              ) : null}
              {/* "תצורת עבודה": after the shop and the role — "לפי הסניף" unless chosen. */}
              {pairShopId && pairDeviceRole && pairDeviceRole !== 'customer_display' && !pairIsServer ? (
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
                    const pairLicenseProduct = pairWin7 ? 'till' : pairingLicenseOf(pairDeviceRole, pairLicense);
                    generateCode.mutate({
                      ...pairingRequestBody(pairDraft, pairKiosk),
                      ...(pairTerminalBody ? { terminal: pairTerminalBody } : {}),
                      ...(pairWorkConfigPlan ? { workConfig: pairWorkConfigPlan } : {}),
                      ...(pairLicenseProduct ? { licenseProduct: pairLicenseProduct } : {}),
                    });
                  }}
                  disabled={
                    !!pairMissing ||
                    generateCode.isPending ||
                    (!!pairWorkConfigPlan && !!workConfigDraftError(pairWorkConfig, null)) ||
                    (pairSells && terminalDraftHasErrors(pairTerminal))
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
