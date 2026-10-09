'use client';

/**
 * "עדכון שקט" (pos-server docs/SPEC_UPDATES.md §5): per device, whether its app updates go in
 * with nobody at the screen ("פעיל") or need a tap ("דורש לחיצה"), and how to turn it on — the
 * exact adb command per device type with its conditions, or the Android Enterprise QR for a
 * factory-reset device (the APK by a short-lived link the cloud signs). On a device-owner till,
 * "הפעל מחדש". The rules and the Hebrew are lib/deviceManagement.ts.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Loader2, Power, QrCode, ShieldCheck, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { phaseOfReboot } from '@/lib/deviceCommands';
import { trackCommand } from '@/lib/deviceCommandsStore';
import { formatDateTime } from '@/lib/format';
import {
  ADB_ACCOUNTS_CHECK,
  ADB_COMMAND,
  ADB_CONDITIONS,
  ADB_OWNER_CHECK,
  ADB_USERS_CHECK,
  DEVICE_TYPES,
  OWNER_EFFECTS,
  QR_STEPS,
  androidVersion,
  canReboot,
  deviceTypeFor,
  kioskLockLabel,
  qrText,
  qrWarning,
  rebootPending,
  rebootStatusLabel,
  silentLabel,
  silentState,
  tapReason,
  withWifi,
  type DeviceManagementReport,
  type RebootRequest,
  type WifiSecurity,
  type WithDeviceManagement,
} from '@/lib/deviceManagement';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { cn } from '@/lib/utils';

/** What the components read off a machine (the page) or a rollout row. */
export type DeviceManagementTarget = WithDeviceManagement & {
  id: string;
  name?: string | null;
  shopId?: string | null;
  platform?: string | null;
  deviceModel?: string | null;
  deviceInfo?: Record<string, unknown> | null;
};

interface ProvisioningQr {
  payload: Record<string, unknown>;
  payloadJson: string;
  release: { id: string; versionName: string; versionCode: number; source: 'assigned' | 'newest' };
  shopId: string;
  shopName?: string | null;
  downloadUrl: string;
  expiresAt: string;
  signatureChecksum: string;
  signingCertSha256: string;
  adbCommand: string;
  warnings: string[];
}

const STATE_STYLE = {
  silent: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  tap: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  unknown: 'bg-muted text-muted-foreground',
} as const;

/** "עדכון שקט: פעיל / דורש לחיצה" — the rollout table's and the device page's chip. */
export function SilentUpdateBadge({ dm, className }: { dm?: DeviceManagementReport | null; className?: string }) {
  const state = silentState(dm);
  return (
    <span
      className={cn('inline-block rounded-full px-2 py-0.5 text-xs font-medium', STATE_STYLE[state], className)}
      title={dm?.updatePath ?? undefined}
    >
      {silentLabel(dm)}
    </span>
  );
}

function CopyLine({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-xs" dir="ltr">
        {text}
      </code>
      <Button
        size="sm"
        variant="outline"
        aria-label={label ?? 'העתקה'}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => toast.error('ההעתקה נכשלה'),
          );
        }}
      >
        {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      </Button>
    </div>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="list-decimal space-y-1 ps-5 text-sm">
      {items.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </ol>
  );
}

/**
 * "איך מפעילים": the adb command per device type (with the checks before it), or the QR for a
 * factory-reset device. `shopId` (or the device's own) picks the release the QR installs.
 */
export function SilentUpdateHelpDialog({
  open,
  onOpenChange,
  target,
  shopId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target?: DeviceManagementTarget | null;
  shopId?: string | null;
}) {
  const guessed = target ? deviceTypeFor(target) : null;
  const [tab, setTab] = useState<'adb' | 'qr'>('adb');
  const [typeId, setTypeId] = useState<string>(guessed?.id ?? DEVICE_TYPES[0].id);
  const [qr, setQr] = useState<ProvisioningQr | null>(null);
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [security, setSecurity] = useState<WifiSecurity>('WPA');
  const [skipEncryption, setSkipEncryption] = useState(false);
  const type = DEVICE_TYPES.find((t) => t.id === typeId) ?? DEVICE_TYPES[0];
  const dm = target?.deviceManagement;
  const reason = tapReason(dm);
  const shop = shopId ?? target?.shopId ?? null;

  const generate = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { skipEncryption };
      if (target?.id) body.machineId = target.id;
      else if (shop) body.shopId = shop;
      const { data } = await api.post<ProvisioningQr>('/device-management/provisioning-qr', body);
      return data;
    },
    onSuccess: setQr,
    onError: (e) => {
      const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
      if (detail === 'no_android_release') toast.error('אין גרסת אנדרואיד פעילה בענן — העלו גרסה ב"עדכוני גרסה".');
      else if (detail === 'apk_signature_unreadable') toast.error('לא ניתן לקרוא את חתימת ה-APK של הגרסה.');
      else toast.error(axiosErrorToToastMessage(e, 'יצירת הקוד נכשלה'));
    },
  });

  const payload = qr ? withWifi(qr.payload, ssid.trim() ? { ssid, password, security } : null) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" aria-hidden />
            עדכון שקט — בעלות מכשיר
          </DialogTitle>
          <DialogDescription>
            כשאפליקציית הקופה היא בעלת המכשיר (Device Owner), עדכוני גרסה מותקנים בלי לחיצה על &quot;התקן&quot; ובלי
            אישור באנדרואיד. מגדירים פעם אחת לכל מכשיר.
          </DialogDescription>
        </DialogHeader>

        {target ? (
          <div className="rounded-md border p-2 text-sm space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{target.name}</span>
              <SilentUpdateBadge dm={dm} />
              {dm?.sdk ? <span className="text-xs text-muted-foreground">{androidVersion(dm.sdk)}</span> : null}
            </div>
            {reason ? <p className="text-xs text-muted-foreground">{reason}</p> : null}
          </div>
        ) : null}

        <div className="flex gap-2" role="tablist">
          <Button size="sm" variant={tab === 'adb' ? 'default' : 'outline'} onClick={() => setTab('adb')} role="tab">
            <Terminal className="h-4 w-4 me-1" aria-hidden />
            פקודת adb (מכשיר בלי חשבונות)
          </Button>
          <Button size="sm" variant={tab === 'qr' ? 'default' : 'outline'} onClick={() => setTab('qr')} role="tab">
            <QrCode className="h-4 w-4 me-1" aria-hidden />
            QR (אחרי איפוס להגדרות יצרן)
          </Button>
        </div>

        {tab === 'adb' ? (
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <Label>סוג המכשיר</Label>
              <div className="flex flex-wrap gap-1.5">
                {DEVICE_TYPES.map((t) => (
                  <Button
                    key={t.id}
                    size="sm"
                    variant={t.id === type.id ? 'default' : 'outline'}
                    onClick={() => setTypeId(t.id)}
                  >
                    {t.name} · {t.android}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <p className="font-medium">1. בדיקות לפני (מחשב עם adb, המכשיר מחובר ב-USB):</p>
              <CopyLine text={ADB_ACCOUNTS_CHECK} />
              <CopyLine text={ADB_USERS_CHECK} />
              <CopyLine text={ADB_OWNER_CHECK} />
            </div>
            <div className="space-y-1">
              <p className="font-medium">2. הפקודה:</p>
              <CopyLine text={ADB_COMMAND} label="העתקת הפקודה" />
              <p className="text-xs text-muted-foreground">
                התשובה המצופה: &quot;Success: Device owner set to package il.co.runnersys.pos&quot;. שגיאה &quot;already
                several accounts&quot; = יש חשבון במכשיר.
              </p>
            </div>
            <div className="space-y-1">
              <p className="font-medium">תנאים:</p>
              <Steps items={ADB_CONDITIONS} />
            </div>
            <div className="space-y-1 rounded-md border bg-muted/30 p-2">
              <p className="font-medium">{type.name} · {type.android}</p>
              <ul className="list-disc space-y-0.5 ps-5">
                {type.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <Steps items={QR_STEPS} />
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="dm-wifi-ssid">רשת Wi-Fi (לא חובה)</Label>
                <Input id="dm-wifi-ssid" value={ssid} onChange={(e) => setSsid(e.target.value)} dir="ltr" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dm-wifi-password">סיסמה</Label>
                <Input
                  id="dm-wifi-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  dir="ltr"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dm-wifi-security">אבטחה</Label>
                <select
                  id="dm-wifi-security"
                  className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                  value={security}
                  onChange={(e) => setSecurity(e.target.value as WifiSecurity)}
                >
                  <option value="WPA">WPA / WPA2</option>
                  <option value="WEP">WEP</option>
                  <option value="NONE">פתוחה</option>
                </select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              הסיסמה נשארת בדפדפן — היא נכנסת לקוד בלבד ולא נשלחת לשרת. מי שמחזיק בקוד יכול לראות אותה.
            </p>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={skipEncryption}
                onChange={(e) => setSkipEncryption(e.target.checked)}
              />
              לדלג על הצפנת המכשיר (אנדרואיד 7–9 בלבד; מקצר את ההגדרה)
            </label>
            <Button onClick={() => generate.mutate()} disabled={generate.isPending || (!target?.id && !shop)}>
              {generate.isPending ? <Loader2 className="h-4 w-4 me-1 animate-spin" aria-hidden /> : <QrCode className="h-4 w-4 me-1" aria-hidden />}
              {qr ? 'יצירת קוד חדש' : 'יצירת קוד QR'}
            </Button>
            {!target?.id && !shop ? <p className="text-xs text-destructive">בחרו סניף כדי ליצור קוד.</p> : null}
            {qr && payload ? (
              <div className="space-y-2">
                {qr.warnings.map((w) => (
                  <p
                    key={w}
                    className={cn(
                      'rounded-md p-2 text-xs',
                      w === 'debug_key' || w === 'localhost'
                        ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
                        : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
                    )}
                  >
                    {qrWarning(w)}
                  </p>
                ))}
                <div className="flex flex-wrap items-start gap-4">
                  <div className="rounded-md bg-white p-3">
                    <QRCodeSVG value={qrText(payload)} size={280} level="M" aria-label="קוד QR להגדרת בעלות מכשיר" />
                  </div>
                  <div className="space-y-1 text-xs">
                    <p>
                      גרסה: <span className="font-mono" dir="ltr">{qr.release.versionName}</span>
                      {qr.release.source === 'assigned' ? ' (משויכת לסניף)' : ' (החדשה ביותר)'}
                    </p>
                    {qr.shopName ? <p>סניף: {qr.shopName}</p> : null}
                    <p>הקישור להורדה בתוקף עד {formatDateTime(qr.expiresAt)}</p>
                    <p className="break-all">
                      חתימה (SHA-256): <span className="font-mono" dir="ltr">{qr.signingCertSha256}</span>
                    </p>
                  </div>
                </div>
                <details className="text-xs">
                  <summary className="cursor-pointer">תוכן הקוד (JSON)</summary>
                  <CopyLine text={qrText(payload)} label="העתקת ה-JSON" />
                </details>
              </div>
            ) : null}
          </div>
        )}

        <div className="space-y-1 rounded-md border p-2 text-sm">
          <p className="font-medium">מה משתנה במכשיר שבבעלות הקופה</p>
          <ul className="list-disc space-y-0.5 ps-5">
            {OWNER_EFFECTS.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <p className="text-xs text-destructive">
            חשוב: לפני שמגדירים מכשירים, מפתח החתימה של ה-APK חייב להיות הסופי. החלפת מפתח מחייבת התקנה מחדש בכל
            מכשיר, ומכשיר שבבעלות הקופה צריך קודם &quot;שחרור בעלות מכשיר&quot; במסך הטכנאי.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            סגירה
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The rollout table's cell: the chip, and "איך מפעילים" for a device that is not silent. */
export function SilentUpdateCell({ target }: { target: DeviceManagementTarget }) {
  const [open, setOpen] = useState(false);
  const state = silentState(target.deviceManagement);
  if (target.platform === 'windows') return <span className="text-xs text-muted-foreground">תמיד שקט</span>;
  return (
    <div className="space-y-0.5">
      <SilentUpdateBadge dm={target.deviceManagement} />
      {state !== 'silent' ? (
        <button type="button" className="block text-xs text-primary underline" onClick={() => setOpen(true)}>
          איך מפעילים
        </button>
      ) : null}
      {open ? <SilentUpdateHelpDialog open onOpenChange={setOpen} target={target} /> : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="text-muted-foreground">{label}:</span>
      <span>{children}</span>
    </div>
  );
}

/** The device page's card: status, "איך מפעילים", and "הפעל מחדש" on a device-owner till. */
export function DeviceManagementCard({ machine }: { machine: DeviceManagementTarget }) {
  const qc = useQueryClient();
  const [help, setHelp] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (machine.platform === 'windows') return null;
  const dm = machine.deviceManagement;
  const req = machine.rebootRequest;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">עדכון שקט ובעלות מכשיר</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setHelp(true)}>
              <ShieldCheck className="h-4 w-4 me-1" aria-hidden />
              איך מפעילים
            </Button>
            {canReboot(machine) ? (
              <Button size="sm" variant="outline" onClick={() => setConfirm(true)} disabled={rebootPending(req)}>
                <Power className="h-4 w-4 me-1" aria-hidden />
                הפעל מחדש
              </Button>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        <Row label="עדכון שקט">
          <SilentUpdateBadge dm={dm} />
        </Row>
        {dm ? (
          <>
            <Row label="בעלות מכשיר">
              {dm.deviceOwner ? `כן${dm.provisionedBy === 'qr' ? ' (QR)' : dm.provisionedBy === 'adb' ? ' (adb)' : ''}` : 'לא'}
            </Row>
            <Row label="אנדרואיד">{androidVersion(dm.sdk)}</Row>
            <Row label="נעילת קיוסק">{kioskLockLabel(dm.kioskLock)}</Row>
            {dm.vendorInstaller ? <Row label="מתקין יצרן">{dm.vendorInstaller.toUpperCase()}</Row> : null}
            {dm.permissionsGranted?.length ? (
              <Row label="הרשאות שניתנו אוטומטית">{dm.permissionsGranted.map((p) => p.replace('android.permission.', '')).join(', ')}</Row>
            ) : null}
            {dm.permissionsMissing?.length ? (
              <Row label="הרשאות חסרות">{dm.permissionsMissing.map((p) => p.replace('android.permission.', '')).join(', ')}</Row>
            ) : null}
            {dm.ownerReleasedAt && !dm.deviceOwner ? (
              <Row label="שחרור בעלות מכשיר">
                {formatDateTime(dm.ownerReleasedAt)} · {dm.ownerReleasedBy ?? 'טכנאי'}
              </Row>
            ) : null}
            {tapReason(dm) ? <p className="text-xs text-muted-foreground">{tapReason(dm)}</p> : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">המכשיר עוד לא דיווח (גרסת אפליקציה ישנה, או שלא התחבר מאז).</p>
        )}
        {machine.deviceManagementReportedAt ? (
          <p className="text-xs text-muted-foreground">דווח {formatDateTime(machine.deviceManagementReportedAt)}</p>
        ) : null}
        {req ? (
          <p className={cn('text-xs', rebootPending(req) ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>
            הפעלה מחדש: {rebootStatusLabel(req)}
            {req.requestedBy ? ` · ${req.requestedBy}` : ''}
            {req.requestedAt ? ` · ${formatDateTime(req.requestedAt)}` : ''}
          </p>
        ) : null}
      </CardContent>
      {help ? <SilentUpdateHelpDialog open onOpenChange={setHelp} target={machine} /> : null}
      {confirm ? (
        <RebootDialog
          machineId={machine.id}
          name={machine.name ?? ''}
          onClose={() => setConfirm(false)}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: ['machine', machine.id] });
            void qc.invalidateQueries({ queryKey: ['machines'] });
          }}
        />
      ) : null}
    </Card>
  );
}

function RebootDialog({
  machineId,
  name,
  onClose,
  onDone,
}: {
  machineId: string;
  name: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const run = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ created: boolean; rebootRequest: RebootRequest }>(`/machines/${machineId}/reboot`);
      return data;
    },
    onSuccess: (data) => {
      // "פקודות שנשלחו" (lib/deviceCommandsStore.ts): followed in the background (its popup, the
      // tray, the device's chip) — the dialog closes, nothing waits for the device.
      const req = data?.rebootRequest;
      if (req?.id) {
        const p = phaseOfReboot(req.status, req.reason);
        trackCommand({ kind: 'reboot', id: req.id, action: 'reboot', machineId, machineName: name || null, phase: p.phase, detail: p.detail });
      }
      if (!data?.created) toast.info('בקשה כבר ממתינה למכשיר');
      onDone();
      onClose();
    },
    onError: (e) => {
      const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
      if (detail === 'reboot_needs_device_owner') toast.error('רק מכשיר שבבעלות הקופה (Device Owner) ניתן להפעלה מחדש מהענן.');
      else toast.error(axiosErrorToToastMessage(e, 'השליחה נכשלה'));
    },
  });
  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>הפעל מחדש — {name}</DialogTitle>
          <DialogDescription>
            המכשיר יופעל מחדש בפעימה הבאה שלו (עד דקה), אבל אף פעם לא באמצע מכירה, תשלום, שולחן פתוח או פעולת אשראי —
            אז הבקשה נדחית ומנסה שוב, עד 30 דקות. סל פתוח שלא נשמר עלול ללכת לאיבוד, לכן רק כשהקופה פנויה.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            ביטול
          </Button>
          <Button variant="destructive" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? <Loader2 className="h-4 w-4 me-1 animate-spin" aria-hidden /> : <Power className="h-4 w-4 me-1" aria-hidden />}
            הפעל מחדש
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
