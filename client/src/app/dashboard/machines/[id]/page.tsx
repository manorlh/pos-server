'use client';

/**
 * One POS terminal, from the inside: health, sync state, its shift, its recent shifts
 * and Z reports, its transactions, and which of its shop's products it sells (its own
 * catalog).
 *
 * The health panel and the clock-skew grading are the same components the
 * machines list uses, so a battery that reads "unknown" here means exactly what
 * it means there — not zero, not a fault. Actions that change a device (assign,
 * change shop, push catalogue, remove) deliberately stay on the
 * machines list, which already implements them with their confirmations; this page
 * links across rather than growing a second copy of them.
 */

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Pencil, Store, Wifi, WifiOff } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { api, fetchMachine, fetchShifts, fetchShops, fetchZReports, updateMachineLicense } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useCanProduceZ, zWizardHref } from '@/lib/zAccess';
import { usePageScope, useSyncScopeFromRoute } from '@/lib/scope';
import { findBySameId } from '@/lib/entityLookup';
import { registerNumberOf } from '@/lib/registerNumber';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import { MachineHealthPanel, ClockSkewChip } from '@/components/dashboard/machine-health';
import { SalesStats } from '@/components/dashboard/sales-stats';
import { MachineCatalogCard } from '@/components/dashboard/machines/machine-catalog';
import {
  MachineNameMismatchHint,
  MachineShiftSummary,
} from '@/components/dashboard/machines/machine-row';
import {
  DeviceCapabilityList,
  DeviceModelWarningNote,
  DevicePlatformBadge,
  DeviceProfileDialog,
  DeviceRoleBadge,
  DisplayDeviceNote,
  KioskPinpadWarning,
} from '@/components/dashboard/machines/device-role';
import { WebScreenNote } from '@/components/dashboard/machines/web-screen-note';
import { isDisplayDevice } from '@/lib/deviceProfile';
import {
  DocumentPrefixBusinessStatus,
  DocumentPrefixDialog,
  DocumentPrefixValue,
} from '@/components/dashboard/machines/document-prefix';
import { LicenseBadge, useIsSuperAdmin } from '@/components/dashboard/license-fields';
import { TrainingBadge, TrainingStripe } from '@/components/dashboard/training-badge';
import { LicenseDialog } from '@/components/dashboard/tenant-license-dialog';
import { DeadTillRecovery } from '@/components/dashboard/dead-till-recovery';
import {
  TransmissionHistory,
  TransmissionSummary,
  TransmitNowButton,
  UntransmittedSales,
} from '@/components/dashboard/machines/card-transmission';
import { MachineAreaDialog } from '@/components/dashboard/areas/machine-area-dialog';
import { RequestTillZButton, ZModeField } from '@/components/dashboard/till-z/till-z-dialogs';
import { SupportZButton } from '@/components/dashboard/machines/support-z-dialog';
import { TillResetButton } from '@/components/dashboard/machines/till-reset-dialog';
import { TillReplacements } from '@/components/dashboard/machines/till-replacements';
import { DeviceManagementCard } from '@/components/dashboard/machines/device-management';
import { MachineLanServerCard } from '@/components/dashboard/machines/machine-lan-server-card';
import { WorkConfigCard } from '@/components/dashboard/machines/work-config';
import { tillResetTone, type TillResetRecord } from '@/lib/tillReset';
import { IndependentTillBadge } from '@/components/dashboard/independent-till-badge';
import { LatestTillZRequest } from '@/components/dashboard/till-z/till-z-request';
import { ZBadges } from '@/components/dashboard/z-report/z-badges';
import { useZNumberLabel } from '@/components/dashboard/z-report/z-number';
import { zModeOf } from '@/lib/tillZ';
import {
  RemoteShiftCloseDialog,
  canCloseShiftRemotely,
} from '@/components/dashboard/machines/remote-shift-close';
import {
  CountedCash,
  OverShort,
  ShiftBadges,
  useShiftLabel,
} from '@/components/dashboard/shifts/shift-parts';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DeviceCommandChip } from '@/components/dashboard/device-commands/command-chip';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  PosMachine,
  ShiftListResponse,
  Shop,
  TransactionListResponse,
  ZReportListResponse,
} from '@/lib/types';

const RECENT_LIMIT = 10;

/** The server's online window, used only when a response predates its own `online`. */
const ONLINE_WINDOW_MS = 300 * 1000;

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value ?? '—'}</p>
    </div>
  );
}

export default function MachineDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('machineDetail');
  const tMachines = useTranslations('machines');
  const tZ = useTranslations('zReports');
  const tTx = useTranslations('transactions');
  const tShifts = useTranslations('shifts');
  const tSend = useTranslations('transmission');
  const tTillZ = useTranslations('tillZ');
  const tTillReset = useTranslations('tillReset');
  const shiftLabel = useShiftLabel();
  const zNumberLabel = useZNumberLabel();
  const canProduceZ = useCanProduceZ();
  const [closeShiftOpen, setCloseShiftOpen] = useState(false);
  const [areaOpen, setAreaOpen] = useState(false);
  const [deviceModelOpen, setDeviceModelOpen] = useState(false);
  const [documentPrefixOpen, setDocumentPrefixOpen] = useState(false);
  const tAreas = useTranslations('areas');
  const tLicense = useTranslations('license');
  const isSuperAdmin = useIsSuperAdmin();
  const [licenseOpen, setLicenseOpen] = useState(false);
  const queryClient = useQueryClient();

  usePageScope({ maxLevel: 'machine', silent: true });

  // The machine itself, by id — not found in the list: the list holds active tills
  // only, is shop-scoped for some roles and pages at 100, and a removed or shop-less
  // till must still have a page (its dead-till recovery lives here).
  const machineQuery = useQuery<PosMachine>({
    queryKey: ['machine', id],
    queryFn: () => fetchMachine(id),
    retry: (count, err) => {
      const code = httpStatus(err);
      return code !== 403 && code !== 404 && count < 2;
    },
    // A close someone asked for is on its way: keep the shift line honest meanwhile.
    refetchInterval: (q) => (q.state.data?.closeShiftPending ? 15_000 : false),
  });
  const shopsQuery = useQuery<Shop[]>({ queryKey: ['shops'], queryFn: () => fetchShops() });

  const machine = machineQuery.data;
  const shop = findBySameId(shopsQuery.data ?? [], machine?.shopId);
  const registerNumber = machine ? registerNumberOf(machine) : null;
  const registerLabel =
    registerNumber !== null ? tMachines('registerLabel', { number: registerNumber }) : null;

  // Same as the shop page: the route drives the shared scope, and the shop and
  // company fill in as they resolve so the breadcrumb trail is complete.
  useSyncScopeFromRoute({
    companyId: shop?.companyId ?? null,
    shopId: machine?.shopId ?? null,
    machineId: id,
  });

  const zParams = useMemo(
    () => ({ machineIds: [id], page: 1, pageSize: RECENT_LIMIT }),
    [id],
  );
  const zReports = useQuery<ZReportListResponse>({
    queryKey: ['z-reports', zParams],
    queryFn: () => fetchZReports(zParams),
    enabled: !!machine,
  });

  const shiftParams = useMemo(
    () => ({ machineId: id, page: 1, pageSize: RECENT_LIMIT }),
    [id],
  );
  const shifts = useQuery<ShiftListResponse>({
    queryKey: ['shifts', shiftParams],
    queryFn: () => fetchShifts(shiftParams),
    enabled: !!machine,
  });

  const txParams = useMemo(
    () => ({ machineId: id, page: 1, pageSize: RECENT_LIMIT }),
    [id],
  );
  const transactions = useQuery<TransactionListResponse>({
    queryKey: ['transactions', txParams],
    queryFn: () => api.get('/transactions', { params: txParams }).then((r) => r.data),
    enabled: !!machine,
  });

  if (machineQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!machine) {
    const code = httpStatus(machineQuery.error);
    const why =
      code === 404
        ? t('notFound')
        : code === 403
          ? t('forbidden')
          : axiosErrorToToastMessage(machineQuery.error, t('loadFailed'));
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">{tMachines('title')}</h1>
        <p className={`text-sm ${code === 404 || code === 403 ? 'text-muted-foreground' : 'text-destructive'}`}>
          {why}
        </p>
        <Link
          href="/dashboard/machines"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {tMachines('title')}
        </Link>
      </div>
    );
  }

  const removed = machine.isActive === false;
  const online =
    typeof machine.online === 'boolean'
      ? machine.online
      : !!machine.lastHeartbeatAt &&
        machineQuery.dataUpdatedAt - new Date(machine.lastHeartbeatAt).getTime() <= ONLINE_WINDOW_MS;
  // As on the machines list: offered only for a terminal that is actually unreachable.
  const showDeadTill = !removed && !online && machine.pairingStatus === 'assigned';
  const zRows = zReports.data?.items ?? [];
  // A till that produces its own Z is asked for it; the cloud wizard never builds one for it.
  const tillMode = zModeOf(machine) === 'till';
  const zSpansTills = zRows.some((r) => (r.machineCount ?? 1) > 1);
  // "מסך — לא קופה" (docs/SPEC_DEVICE_ROLE_MODEL.md §2.2): a KDS / the board has no
  // shifts, Z, document prefix or card transmission — those controls are not offered.
  const display = isDisplayDevice(machine);

  return (
    <div className="space-y-6">
      {/* The till's shop is in training mode: whatever it sells is practice. */}
      <TrainingStripe shop={shop} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Monitor className="h-5 w-5 text-muted-foreground" aria-hidden />
            {/* The register number is how the shop names this till; the free-text
                name stays beside it when it says something else. No shop, no number. */}
            <h1 className="text-2xl font-bold">{registerLabel ?? machine.name}</h1>
            {registerLabel && machine.name.trim() !== registerLabel ? (
              <span className="text-base text-muted-foreground">{machine.name}</span>
            ) : null}
            <MachineNameMismatchHint m={machine} />
            <Badge variant="outline">
              {tMachines(`pairingStatusLabels.${machine.pairingStatus}`)}
            </Badge>
            {removed ? (
              <Badge variant="destructive" title={t('removedHint')}>
                {t('removed')}
              </Badge>
            ) : null}
            <ClockSkewChip machine={machine} />
            {/* The last command sent to this device and its status ("פקודות שנשלחו"). */}
            <DeviceCommandChip machineId={machine.id} />
          </div>
          {shop ? (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Store className="h-3.5 w-3.5" aria-hidden />
              <Link href={`/dashboard/shops/${shop.id}`} className="hover:underline">
                {shop.name}
              </Link>
              <TrainingBadge shop={shop} />
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('shopNone')}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Two separate actions: closing the shift only files its X; the Z is the
              wizard's. */}
          {canProduceZ && canCloseShiftRemotely(machine) && !display ? (
            <Button size="sm" variant="outline" onClick={() => setCloseShiftOpen(true)}>
              {tMachines('closeShiftRemotely')}
            </Button>
          ) : null}
          {display ? null : canProduceZ && tillMode ? (
            <RequestTillZButton m={machine} />
          ) : canProduceZ && !removed && machine.shopId && machine.pairingStatus === 'assigned' ? (
            <Link
              href={zWizardHref(machine.shopId, machine.id)}
              className={buttonVariants({ size: 'sm' })}
            >
              {tMachines('produceZForTill')}
            </Link>
          ) : null}
          {/* "הפקת Z מהענן (תמיכה)": a dead till's Z from the cloud — support alone (offline till Z §4.6). */}
          {isSuperAdmin && !removed && machine.pairingStatus === 'assigned' && !display ? (
            <SupportZButton machineId={machine.id} />
          ) : null}
          {/* "איפוס נתוני קופה (תמיכה)": the only reset of a till's data — support alone (§4.7). */}
          {isSuperAdmin && !removed && machine.pairingStatus === 'assigned' ? (
            <TillResetButton machineId={machine.id} />
          ) : null}
          <Link
            href="/dashboard/machines"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {t('manage')}
          </Link>
        </div>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-4 lg:grid-cols-5">
          {registerNumber !== null ? (
            <Field
              label={t('registerNumber')}
              value={<span className="tabular-nums">{registerNumber}</span>}
            />
          ) : null}
          <Field label={t('machineCode')} value={<span className="font-mono">{machine.machineCode}</span>} />
          {/* "קידומת מסמכים": every document number of this till is printed `<prefix>-<number>`. */}
          {display ? null : (
          <Field
            label={tMachines('documentPrefix.label')}
            value={
              <span className="inline-flex items-center gap-1">
                <DocumentPrefixValue machine={machine} />
                {/* PUT /machines/{id} is the machine admins' — the same set that produces a Z. */}
                {canProduceZ && !removed && machine.shopId ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => setDocumentPrefixOpen(true)}
                    aria-label={tMachines('documentPrefix.editTitle')}
                    title={tMachines('documentPrefix.editTitle')}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                ) : null}
              </span>
            }
          />
          )}
          {/* Unique in the whole business (every branch): the tax file is one per business. */}
          {machine.shopId && !removed && !display ? (
            <Field
              label={tMachines('documentPrefix.businessLabel')}
              value={<DocumentPrefixBusinessStatus machineId={machine.id} canEdit={canProduceZ} />}
            />
          ) : null}
          {/* "סוג מכשיר (תפקיד)": קופה / קיוסק (docs/SPEC_DEVICE_ROLE_MODEL.md). */}
          <Field
            label={tMachines('deviceRole.label')}
            value={
              <span className="inline-flex flex-wrap items-center gap-1">
                {tMachines(`deviceRole.${machine.deviceRole ?? 'till'}`)}
                {(machine.deviceRole === 'kiosk' && machine.kioskEnabled === false) || display || machine.kdsScreen ? (
                  <DeviceRoleBadge m={machine} />
                ) : null}
                <DevicePlatformBadge m={machine} showAndroid />
                {display || machine.kdsScreen ? (
                  <Link href="/dashboard/kds" className="text-xs text-primary hover:underline">
                    {tMachines('deviceRole.kds')}
                  </Link>
                ) : null}
                {machine.deviceRole === 'kiosk' ? (
                  <Link href="/dashboard/kiosks" className="text-xs text-primary hover:underline">
                    {tMachines('deviceRole.kioskSettings')}
                  </Link>
                ) : null}
                {canProduceZ && !removed ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => setDeviceModelOpen(true)}
                    aria-label={tMachines('deviceRole.change')}
                    title={tMachines('deviceRole.change')}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                ) : null}
              </span>
            }
          />
          <Field
            label={tMachines('deviceModel.label')}
            value={
              <span className="inline-flex items-center gap-1">
                {machine.deviceModel ? (
                  tMachines(`deviceModel.${machine.deviceModel}`)
                ) : (
                  <span className="text-muted-foreground" title={tMachines('deviceModel.unknownHint')}>
                    {tMachines('deviceModel.unknown')}
                  </span>
                )}
                {/* PUT /machines/{id}/device-profile — the machine admins', the same set that produces a Z. */}
                {canProduceZ && !removed ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => setDeviceModelOpen(true)}
                    aria-label={tMachines('deviceRole.change')}
                    title={tMachines('deviceRole.change')}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                ) : null}
              </span>
            }
          />
          {machine.shopId ? (
            <Field
              label={tAreas('area')}
              value={
                <span className="inline-flex items-center gap-1">
                  {machine.areaName ?? <span className="text-muted-foreground">{tAreas('noArea')}</span>}
                  {/* PUT /machines/{id} is the machine admins' — the same set that produces a Z. */}
                  {canProduceZ && !removed ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => setAreaOpen(true)}
                      aria-label={tAreas('machineAreaTitle')}
                      title={tAreas('machineAreaTitle')}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  ) : null}
                </span>
              }
            />
          ) : null}
          {/* `PUT /machines/{id}` {zMode} is the Z producers'; read-only for everyone else. */}
          {display ? null : (
          <Field
            label={tTillZ('mode.label')}
            value={
              <span className="inline-flex flex-wrap items-center gap-1">
                <ZModeField
                  machine={machine}
                  // The owner's rule: the super admin alone switches a till's Z mode.
                  canEdit={isSuperAdmin && !removed && machine.pairingStatus === 'assigned'}
                />
                <IndependentTillBadge machine={machine} />
                {/* Support produced this till's Z from the cloud (offline till Z §4.6). */}
                {machine.supportZ ? (
                  <Badge variant="destructive" className="text-[11px]" title={tTillZ('offline.supportHint', { by: String(machine.supportZ.by ?? ''), at: formatDateTime(String(machine.supportZ.at ?? '')) })}>
                    {tTillZ('offline.support')}
                  </Badge>
                ) : null}
                {/* The last reset support ordered from the cloud, and what the till did (§4.7). */}
                {machine.tillReset ? (
                  <Badge
                    variant={tillResetTone((machine.tillReset as unknown as TillResetRecord).status)}
                    className="text-[11px]"
                    title={tTillReset('badgeHint', {
                      kind: String(machine.tillReset.kindText ?? ''),
                      by: String(machine.tillReset.by ?? ''),
                      at: formatDateTime(String(machine.tillReset.requestedAt ?? '')),
                    })}
                  >
                    {tTillReset(`status.${(machine.tillReset as unknown as TillResetRecord).status}`)}
                  </Badge>
                ) : null}
                {/* Zs closed at the till with no connection, not in the cloud yet. */}
                {machine.offlineTillZConflict ? (
                  <Badge variant="destructive" className="text-[11px]" title={tTillZ('offline.conflictHint')}>
                    {tTillZ('offline.conflict')}
                  </Badge>
                ) : machine.offlineTillZPending ? (
                  <Badge variant="outline" className="text-[11px] border-amber-500 text-amber-700 dark:text-amber-300">
                    {tTillZ('offline.pending', { count: machine.offlineTillZPending })}
                  </Badge>
                ) : null}
              </span>
            }
          />
          )}
          <Field
            label={tMachines('lastSeen')}
            value={
              machine.lastHeartbeatAt ? (
                <span className="flex items-center gap-1.5">
                  <Wifi className="h-3.5 w-3.5 text-green-500" aria-hidden />
                  {formatDistanceToNow(new Date(machine.lastHeartbeatAt), {
                    addSuffix: true,
                    locale: he,
                  })}
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <WifiOff className="h-3.5 w-3.5" aria-hidden />
                  {tMachines('neverSeen')}
                </span>
              )
            }
          />
          <Field
            label={tMachines('lastSync')}
            value={
              machine.lastSyncAt
                ? formatDistanceToNow(new Date(machine.lastSyncAt), {
                    addSuffix: true,
                    locale: he,
                  })
                : tMachines('neverSynced')
            }
          />
          {display ? null : (
          <Field
            label={tMachines('shift.label')}
            value={
              <span className="space-y-0.5">
                <MachineShiftSummary m={machine} />
                {/* Named from the machines response itself (openShiftSequence), so it
                    does not wait on, or depend on, the recent-shifts page below. */}
                {machine.shiftStatus === 'open' && machine.openShiftId ? (
                  <Link
                    href={`/dashboard/shifts/${machine.openShiftId}`}
                    className="block text-xs font-normal text-muted-foreground hover:underline"
                  >
                    {shiftLabel({ sequenceNumber: machine.openShiftSequence ?? null })}
                  </Link>
                ) : null}
              </span>
            }
          />
          )}
          {/* "לקוח קבוע / זמני" for this till alone — a till lent to an event. The super
              admin's to change; the till also keeps any earlier end of its shop or above. */}
          <Field
            label={tLicense('label')}
            value={
              <span className="inline-flex items-center gap-1">
                {machine.licenseType === 'temporary' ? (
                  <LicenseBadge value={machine} />
                ) : (
                  tLicense('permanent')
                )}
                {isSuperAdmin && !removed ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => setLicenseOpen(true)}
                    aria-label={tLicense('machineTitle', { name: machine.name })}
                    title={tLicense('machineTitle', { name: machine.name })}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                ) : null}
              </span>
            }
          />
          {/* What the model can do (the server's flags), "בקרוב" for LANDI / Feitian, and a
              warning when the device named another model than the one chosen. */}
          <div className="col-span-full space-y-2">
            {/* "מסך — לא קופה": what a KDS / the board is; a till with a pre-rule KDS screen is flagged. */}
            <DisplayDeviceNote m={machine} />
            {/* "רץ בדפדפן": a web kiosk / KDS / board — where it opens, what browser (SPEC_KDS §13). */}
            <WebScreenNote m={machine} />
            <DeviceCapabilityList
              model={machine.deviceModel ?? null}
              flags={machine}
              kiosk={machine.deviceRole === 'kiosk'}
            />
            <DeviceModelWarningNote m={machine} />
            {/* "מכשירי הסליקה הם חיצוניים": a kiosk with no pinpad address cannot take a card. */}
            <KioskPinpadWarning m={machine} />
          </div>
        </CardContent>
      </Card>

      {removed ? (
        <div className="rounded-md border bg-muted/40 p-3 text-sm">{t('removedNotice')}</div>
      ) : null}

      {showDeadTill && !display ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('deadTillTitle')}
            </CardTitle>
            <p className="text-xs text-muted-foreground">{t('deadTillHint')}</p>
          </CardHeader>
          <CardContent>
            <DeadTillRecovery m={machine} />
          </CardContent>
        </Card>
      ) : null}

      {/* "הוחלפה קופה": the till's device replacements (offline till Z §4.6.2). */}
      <TillReplacements replacements={machine.replacements} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {tMachines('health.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <MachineHealthPanel machine={machine} />
        </CardContent>
      </Card>

      {/* "עדכון שקט": device owner / silent updates, how to turn it on (adb or QR), "הפעל מחדש". */}
      <DeviceManagementCard machine={machine} />

      {/* "תצורת עבודה" (docs/SPEC_DEVICE_WORK_CONFIG.md): how the device works, each value with
          where it comes from — set on the device or inherited from the shop / company. */}
      {machine.shopId ? <WorkConfigCard machineId={machine.id} /> : null}

      {/* "לא משמש כשרת מקומי" (docs/SPEC_LAN_MODE.md §3): never the shop's local server. */}
      {!display ? <MachineLanServerCard machineId={machine.id} shopId={machine.shopId} /> : null}

      {/* Card sales waiting for Shva, the batches the till reported, and — for a till
          that dies with its batch — the list to take to the card company. */}
      <Card id="transmission" className={display ? 'hidden' : undefined}>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {tSend('title')}
              </CardTitle>
              <p className="text-xs text-muted-foreground">{tSend('hint')}</p>
            </div>
            {canProduceZ && !removed ? <TransmitNowButton m={machine} /> : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-0 pb-2">
          <div className="px-4">
            <TransmissionSummary m={machine} />
          </div>
          <div>
            <h3 className="px-4 pb-1 text-xs font-medium text-muted-foreground">
              {tSend('untransmittedTitle')}
            </h3>
            <UntransmittedSales m={machine} />
          </div>
          <div>
            <h3 className="px-4 pb-1 text-xs font-medium text-muted-foreground">
              {tSend('historyTitle')}
            </h3>
            <TransmissionHistory machineId={machine.id} />
          </div>
        </CardContent>
      </Card>

      <SalesStats scope={{ companyId: null, shopId: null, machineId: machine.id }} />

      <MachineCatalogCard machine={machine} />

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('recentShifts')}
            </CardTitle>
            <Link
              href={`/dashboard/shifts?machine=${machine.id}`}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {t('allShifts')}
            </Link>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tShifts('col.shift')}</TableHead>
                <TableHead>{tShifts('col.businessDate')}</TableHead>
                <TableHead>{tShifts('col.opened')}</TableHead>
                <TableHead className="text-end">{tShifts('col.sales')}</TableHead>
                <TableHead className="text-end">{tShifts('col.counted')}</TableHead>
                <TableHead className="text-end">{tShifts('col.overShort')}</TableHead>
                <TableHead>{tShifts('col.state')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shifts.isLoading ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ) : (shifts.data?.items ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                    {t('noShifts')}
                  </TableCell>
                </TableRow>
              ) : (
                (shifts.data?.items ?? []).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">
                      <Link href={`/dashboard/shifts/${s.id}`} className="hover:underline">
                        {shiftLabel(s)}
                      </Link>
                    </TableCell>
                    <TableCell>{formatDate(s.businessDate)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(s.openedAt)}
                      {s.openedByName ? ` · ${s.openedByName}` : ''}
                    </TableCell>
                    <TableCell className="text-end font-medium">
                      {formatCurrency(s.serverTotals?.totalSales)}
                    </TableCell>
                    <TableCell className="text-end">
                      {s.status === 'open' ? '—' : <CountedCash value={s.countedCash} />}
                    </TableCell>
                    <TableCell className="text-end">
                      {s.status === 'open' ? '—' : <OverShort value={s.discrepancy} />}
                    </TableCell>
                    <TableCell>
                      <ShiftBadges shift={s} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('zReports')}
            </CardTitle>
            <Link
              href={`/dashboard/z-reports?machine=${machine.id}`}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {t('allZReports')}
            </Link>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* A Z per shop covers every till in it; a tenant on one Z per till has Zs of
              this till alone. Said from the Zs themselves, so it is true in both. */}
          <p className="px-4 pb-2 text-xs text-muted-foreground">
            {zSpansTills ? t('zReportsHint') : t('zReportsHintOwn')}
          </p>
          {tillMode && machine.shopId ? (
            <div className="mx-4 mb-3 rounded-md border bg-muted/30 px-3 py-2">
              <LatestTillZRequest machineId={machine.id} shopId={machine.shopId} />
            </div>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tZ('zNumber')}</TableHead>
                <TableHead>{tZ('businessDate')}</TableHead>
                <TableHead>{tZ('closedAt')}</TableHead>
                <TableHead className="text-end">{tZ('tills')}</TableHead>
                <TableHead className="text-end">{tZ('totalSales')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {zReports.isLoading ? (
                <TableRow>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ) : zRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    {t('noZReports')}
                  </TableCell>
                </TableRow>
              ) : (
                zRows.map((report) => (
                  <TableRow key={report.id}>
                    <TableCell className="font-medium tabular-nums">
                      <Link href={`/dashboard/z-reports/${report.id}`} className="hover:underline">
                        {zNumberLabel(report)}
                      </Link>
                      <ZBadges z={report} />
                    </TableCell>
                    <TableCell>{formatDate(report.businessDate)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(report.closedAt)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {report.machineCount ?? (report.legacy ? 1 : '—')}
                    </TableCell>
                    <TableCell className="text-end font-medium">
                      {formatCurrency(report.totalSales)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('transactions')}
            </CardTitle>
            <Link
              href={`/dashboard/transactions?machine=${machine.id}`}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {t('allTransactions')}
            </Link>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tTx('createdAt')}</TableHead>
                <TableHead>{tTx('txNumber')}</TableHead>
                <TableHead>{tTx('status')}</TableHead>
                <TableHead className="text-end">{tTx('amount')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.isLoading ? (
                <TableRow>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ) : (transactions.data?.items ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    {t('noTransactions')}
                  </TableCell>
                </TableRow>
              ) : (
                (transactions.data?.items ?? []).map((tx) => (
                  <TableRow key={tx.id}>
                    <TableCell>{formatDateTime(tx.createdAt)}</TableCell>
                    <TableCell className="font-mono text-xs">{tx.documentNumber ?? tx.transactionNumber}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{tTx(`statusLabels.${tx.status}`)}</Badge>
                    </TableCell>
                    <TableCell className="text-end font-medium">
                      {formatCurrency(tx.totalAmount)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <MachineAreaDialog machine={machine} open={areaOpen} onOpenChange={setAreaOpen} />
      {/* "סוג מכשיר": the role and the model, changed over a clean break (server-checked). */}
      <DeviceProfileDialog machine={machine} open={deviceModelOpen} onOpenChange={setDeviceModelOpen} />
      <DocumentPrefixDialog machine={machine} open={documentPrefixOpen} onOpenChange={setDocumentPrefixOpen} />
      <LicenseDialog
        title={tLicense('machineTitle', { name: machine.name })}
        initial={machine}
        open={licenseOpen}
        onOpenChange={setLicenseOpen}
        onSave={async (v) => {
          await updateMachineLicense(machine.id, v);
          await queryClient.invalidateQueries({ queryKey: ['machine', id] });
          await queryClient.invalidateQueries({ queryKey: ['machines'] });
        }}
      />

      <RemoteShiftCloseDialog
        key={machine.id}
        machine={machine}
        open={closeShiftOpen}
        onOpenChange={setCloseShiftOpen}
      />
    </div>
  );
}
