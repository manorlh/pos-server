'use client';

/**
 * "שליטה מרחוק" on tills (pos-server app/routers/device_commands.py): the devices of the scope with
 * their live state (online, locked, the commands on their way and what each device answered —
 * "נשלח" / "בוצע בקופה" / "נדחה: באמצע מכירה"), and the actions for one, several or all of them.
 * Every action is audited on the server; nothing on a till interrupts a sale in progress.
 *
 * `DeviceControlPanel` is the body (the machines page's tab); `DeviceControlSheet` the same in a
 * sheet, for the board and a device row.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Lock, Megaphone, ReceiptText, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import { DEVICE_ACTIONS, actionLabel, commandStatusLabel, commandTone, type DeviceAction, type DeviceRow } from '@/lib/liveControl';
import { fetchClosePreview, fetchDeviceFeatures, fetchDevices, liveKeys, requestRemoteClose, sendDeviceCommand } from '@/lib/liveControlApi';
import { confirmLabel, money, requestStateLabel, tenderLabel, type RemoteClosePreview } from '@/lib/remoteTillZ';
import { ShopClosePanel } from './shop-close-panel';
import type { LiveControlScope, LiveControlSheetProps } from './types';

const TONE: Record<string, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  wait: 'text-amber-700 dark:text-amber-400',
  bad: 'text-destructive',
  muted: 'text-muted-foreground',
};

/** `enabled`: false for a user the server would refuse (the cockpit's feed asks only what each may read). */
export function useDevices(scope: LiveControlScope, enabled = true) {
  const s = { companyId: scope.companyId ?? null, shopId: scope.shopId ?? null };
  return useQuery({
    queryKey: liveKeys.devices(s),
    queryFn: () => fetchDevices(s),
    refetchInterval: 10_000,
    enabled,
  });
}

/**
 * "סגירת משמרת / הפקת Z מרחוק" for one till: its current totals, confirmed by the manager; the till
 * closes (or makes its Z, numbered in sequence) once no sale or card payment is open — never forced.
 */
function RemoteCloseDialog({ machineId, onClose }: { machineId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const preview = useQuery({ queryKey: ['device-commands', 'close-preview', machineId], queryFn: () => fetchClosePreview(machineId) });
  const [checked, setChecked] = useState<string | null>(null);
  const p: RemoteClosePreview | undefined = preview.data;
  const send = useMutation({
    mutationFn: () => requestRemoteClose(machineId, p!.totalsKey),
    onSuccess: () => {
      toast.success('נשלח לקופה — ייסגר כשאין בה מכירה או תשלום פתוחים');
      qc.invalidateQueries({ queryKey: ['device-commands'] });
      onClose();
    },
    onError: (e: unknown) => {
      const detail = (e as { response?: { data?: { detail?: { code?: string } } } })?.response?.data?.detail;
      if (detail?.code === 'totals_changed') {
        toast.error('הסכומים בקופה השתנו מאז — בדקו שוב ואשרו');
        setChecked(null);
        qc.invalidateQueries({ queryKey: ['device-commands', 'close-preview', machineId] });
        return;
      }
      toast.error(axiosErrorToToastMessage(e, 'השליחה נכשלה'));
    },
  });
  const confirmed = !!p && checked === p.totalsKey;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{p ? `${p.kindLabel} מרחוק · ${p.name}` : 'סגירת משמרת / Z מרחוק'}</DialogTitle>
        </DialogHeader>
        {preview.isPending ? (
          <Skeleton className="h-40 w-full rounded-xl" />
        ) : preview.isError || !p ? (
          <p className="text-sm text-destructive">{axiosErrorToToastMessage(preview.error, 'הטעינה נכשלה')}</p>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              {p.kind === 'till_z'
                ? 'הקופה תסגור את המשמרת, תשדר את עסקאות האשראי ותפיק Z לפי הרצף שלה — רק כשאין בה מכירה או תשלום פתוחים.'
                : 'הקופה תסגור את המשמרת — רק כשאין בה מכירה או תשלום פתוחים. המשמרת תיכנס ל-Z של הסניף.'}
            </p>
            {!p.online ? <p className="rounded-lg bg-amber-50 p-2 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">הקופה לא מחוברת כרגע — הבקשה תגיע אליה כשתתחבר.</p> : null}
            {p.openShift ? (
              <p>
                משמרת פתוחה{p.openShift.openedBy ? ` · ${p.openShift.openedBy}` : ''}
                {p.openShift.openedAt ? ` · מ-${new Date(p.openShift.openedAt).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}
              </p>
            ) : null}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-xl border p-3">
              <dt className="text-muted-foreground">מסמכים</dt>
              <dd className="tabular-nums">{p.totals.transactions}</dd>
              <dt className="text-muted-foreground">מכירות</dt>
              <dd className="tabular-nums">{money(p.totals.totalSales)}</dd>
              <dt className="text-muted-foreground">זיכויים</dt>
              <dd className="tabular-nums">{money(p.totals.totalRefunds)}</dd>
              <dt className="font-medium">נטו</dt>
              <dd className="font-semibold tabular-nums">{money(p.totals.net)}</dd>
              {Object.entries(p.totals.byTender).map(([method, amount]) => (
                <div key={method} className="contents">
                  <dt className="text-muted-foreground">{tenderLabel(method)}</dt>
                  <dd className="tabular-nums">{money(amount)}</dd>
                </div>
              ))}
              {p.kind === 'till_z' && p.nextZNumber != null ? (
                <>
                  <dt className="text-muted-foreground">Z הבא</dt>
                  <dd className="tabular-nums">{p.nextZNumber}</dd>
                </>
              ) : null}
            </dl>
            {p.pending ? (
              <p className="text-amber-700 dark:text-amber-400">
                כבר יש בקשה פתוחה לקופה: {requestStateLabel(p.pending.status, p.pending.errorCode)}
              </p>
            ) : null}
            {!p.canRequest ? <p className="text-muted-foreground">{p.whyNot}</p> : (
              <label className="flex min-h-11 items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-primary"
                  checked={confirmed}
                  onChange={(e) => setChecked(e.target.checked ? p.totalsKey : null)}
                />
                <span>בדקתי את הסכומים ואני מאשר/ת {p.kind === 'till_z' ? 'הפקת Z' : 'סגירת משמרת'} בקופה הזו</span>
              </label>
            )}
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" className="min-h-11" onClick={onClose}>
            ביטול
          </Button>
          <Button className="min-h-11" disabled={!p || !p.canRequest || !confirmed || send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? 'שולח…' : p ? confirmLabel(p) : 'אישור'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeviceControlPanel({ scope, preselect }: { scope: LiveControlScope; preselect?: string | null }) {
  const qc = useQueryClient();
  const devices = useDevices(scope);
  // Off on the server (the default): no remote close / Z offered at all.
  const features = useQuery({ queryKey: ['device-commands', 'features'], queryFn: fetchDeviceFeatures, staleTime: 5 * 60_000 });
  const [closing, setClosing] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preselect ? [preselect] : []));
  const [confirming, setConfirming] = useState<DeviceAction | null>(null);
  const [lockMessage, setLockMessage] = useState('הקופה נעולה — פנו למנהל');

  const tills = useMemo(() => (devices.data ?? []).filter((d) => !d.isKiosk), [devices.data]);
  // Only tills shown here are ever sent to (a preselected kiosk or another shop's till is not).
  const chosen = useMemo(() => tills.filter((d) => selected.has(d.machineId)).map((d) => d.machineId), [tills, selected]);
  const allSelected = tills.length > 0 && tills.every((d) => selected.has(d.machineId));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const send = useMutation({
    mutationFn: (action: DeviceAction) =>
      sendDeviceCommand({ action, machineIds: chosen, message: action === 'lock' ? lockMessage : undefined }),
    onSuccess: (rows, action) => {
      toast.success(`${actionLabel(action)} — נשלח ל-${rows.length} ${rows.length === 1 ? 'מכשיר' : 'מכשירים'}`);
      setConfirming(null);
      qc.invalidateQueries({ queryKey: ['device-commands'] });
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'השליחה נכשלה')),
  });

  if (devices.isPending) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {features.data?.remoteTillZ && scope.shopId ? <ShopClosePanel shopId={scope.shopId} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={allSelected}
            onChange={(e) => setSelected(e.target.checked ? new Set(tills.map((d) => d.machineId)) : new Set())}
          />
          בחר הכל ({tills.length})
        </label>
        <Link href="/dashboard/till-messages" className="inline-flex min-h-11 items-center gap-1.5 text-sm text-primary hover:underline">
          <Megaphone className="size-4" aria-hidden />
          הודעה לקופה
        </Link>
      </div>

      <ul className="space-y-2">
        {tills.length === 0 ? <li className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">אין קופות בהיקף</li> : null}
        {tills.map((d: DeviceRow) => {
          const last = d.recent[0];
          return (
            <li key={d.machineId}>
              <label
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-3 shadow-sm',
                  selected.has(d.machineId) && 'border-primary ring-1 ring-primary',
                  d.state.locked && 'bg-amber-50 dark:bg-amber-950/20',
                )}
              >
                <input type="checkbox" className="mt-1 size-4 accent-primary" checked={selected.has(d.machineId)} onChange={() => toggle(d.machineId)} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{d.name}</span>
                    {d.posNumber ? <span className="text-xs text-muted-foreground">#{d.posNumber}</span> : null}
                    {d.online ? (
                      <Badge variant="outline" className="gap-1"><Wifi className="size-3" aria-hidden />מחובר</Badge>
                    ) : (
                      <Badge variant="secondary" className="gap-1"><WifiOff className="size-3" aria-hidden />לא מחובר</Badge>
                    )}
                    {d.state.locked ? (
                      <Badge variant="destructive" className="gap-1"><Lock className="size-3" aria-hidden />נעולה</Badge>
                    ) : null}
                  </div>
                  {d.state.locked && d.state.message ? <p className="text-sm">“{d.state.message}”</p> : null}
                  {d.open.length > 0 ? (
                    <p className="text-sm text-amber-700 dark:text-amber-400">
                      {d.open.map((c) => `${actionLabel(c.action)}: ${commandStatusLabel(c.status, c.detail)}`).join(' · ')}
                    </p>
                  ) : last ? (
                    <p className={cn('text-sm', TONE[commandTone(last.status)])}>
                      {actionLabel(last.action)}: {commandStatusLabel(last.status, last.detail)}
                    </p>
                  ) : null}
                </div>
                {features.data?.remoteTillZ ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="min-h-10 shrink-0 gap-1"
                    onClick={(e) => {
                      e.preventDefault();
                      setClosing(d.machineId);
                    }}
                  >
                    <ReceiptText className="size-4" aria-hidden /> סגירה / Z
                  </Button>
                ) : null}
              </label>
            </li>
          );
        })}
      </ul>

      {closing ? <RemoteCloseDialog machineId={closing} onClose={() => setClosing(null)} /> : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {DEVICE_ACTIONS.map((a) => (
          <Button
            key={a.action}
            variant={a.danger ? 'outline' : 'secondary'}
            className={cn('min-h-12 whitespace-normal', a.danger && 'border-destructive/40 text-destructive')}
            disabled={chosen.length === 0 || send.isPending}
            onClick={() => setConfirming(a.action)}
            title={a.hint}
          >
            {a.label}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        <RefreshCw className="me-1 inline size-3" aria-hidden />
        הסטטוס מתעדכן כל כמה שניות. נעילה, ניתוק משתמש, הפעלה מחדש והתקנת עדכון לא קוטעים מכירה או תשלום — הם מתבצעים כשהקופה פנויה.
      </p>

      <Dialog open={confirming != null} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{confirming ? actionLabel(confirming) : ''}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{DEVICE_ACTIONS.find((a) => a.action === confirming)?.hint}</p>
          <p className="text-sm">
            {chosen.length === 1 ? 'מכשיר אחד' : `${chosen.length} מכשירים`}:{' '}
            {tills.filter((d) => selected.has(d.machineId)).map((d) => d.name).join(', ')}
          </p>
          {confirming === 'lock' ? (
            <Input value={lockMessage} onChange={(e) => setLockMessage(e.target.value)} maxLength={300} className="h-11" aria-label="הודעה על מסך הנעילה" />
          ) : null}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirming(null)} className="min-h-11">ביטול</Button>
            <Button onClick={() => confirming && send.mutate(confirming)} disabled={send.isPending} className="min-h-11">
              {send.isPending ? 'שולח…' : 'שלח'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function DeviceControlSheet({ scope, context, onDone }: LiveControlSheetProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onDone()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>שליטה מרחוק בקופות</DialogTitle>
        </DialogHeader>
        <DeviceControlPanel scope={scope} preselect={context?.machineId ?? scope.machineId ?? null} />
      </DialogContent>
    </Dialog>
  );
}
