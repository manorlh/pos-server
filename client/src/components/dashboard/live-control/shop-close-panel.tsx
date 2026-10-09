'use client';

/**
 * "סגירת יום סניפית" (pos-server app/services/remote_till_z.py, behind REMOTE_TILL_Z_ENABLED): one
 * action per shop, offered exactly as the shop is configured — where its Z is produced ("יופק בענן" /
 * "יופק בקופה הראשית: …"), which tills are in it, which make their own Z, the kiosks — and disabled
 * with the server's reason otherwise ("לא זמין עדיין: …").
 *
 * Never blocking: the confirmation dialog sends and closes at once; the progress of each till
 * ("ממתין למכירה פתוחה", "נסגר", "לא מחובר") shows inline here while the run goes on, with cancel and
 * the existing "build without" where the configuration allows leaving a till for the next Z.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarCheck, Wifi, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AreaShiftsDialog } from './area-shifts-dialog';
import { HeldSalesDialog } from './held-sales-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import {
  cancelShopClose,
  fetchShopClosePreview,
  fetchShopCloseRun,
  forceShopClose,
  forceShopCloseCloudRefunds,
  proceedShopClose,
  requestShopClose,
} from '@/lib/liveControlApi';
import type { CloudRefundPending } from '@/lib/types';
import { money, tenderLabel } from '@/lib/remoteTillZ';
import {
  confirmationAsked,
  forceReasonOk,
  itemTone,
  leavableIds,
  notClosedIds,
  runActive,
  runCounts,
  shopConfirmLabel,
  type ShopClosePreview,
  type ShopCloseRow,
} from '@/lib/remoteShopClose';

const TONE: Record<string, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  wait: 'text-amber-700 dark:text-amber-400',
  bad: 'text-destructive',
  muted: 'text-muted-foreground',
};

const key = (shopId: string, areaId?: string | null) => ['device-commands', 'shop-close', shopId, areaId ?? 'shop'] as const;

function errorDetail(e: unknown): { code?: string; message?: string } | undefined {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return detail && typeof detail === 'object' ? (detail as { code?: string; message?: string }) : undefined;
}

function Online({ online }: { online: boolean | null }) {
  if (online == null) return null;
  return online ? (
    <Badge variant="outline" className="gap-1"><Wifi className="size-3" aria-hidden />מחובר</Badge>
  ) : (
    <Badge variant="secondary" className="gap-1"><WifiOff className="size-3" aria-hidden />לא מחובר</Badge>
  );
}

function DeviceLine({ row, showAction }: { row: ShopCloseRow; showAction: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-1.5 rounded-lg border p-2 text-sm">
      <span className="font-medium">{row.name}</span>
      {row.posNumber ? <span className="text-xs text-muted-foreground">#{row.posNumber}</span> : null}
      {row.isKiosk ? <Badge variant="outline">קיוסק · {row.kindLabel}</Badge> : null}
      <Online online={row.online} />
      <span className="ms-auto tabular-nums">{money(row.net)}</span>
      <span className="w-full text-xs text-muted-foreground">
        {row.openShift ? 'משמרת פתוחה' : row.shiftsAwaitingZ > 0 ? `${row.shiftsAwaitingZ} משמרות ממתינות ל-Z` : 'אין משמרות ל-Z'}
        {row.closesWithShopZ ? ' · ייסגר ויפיק Z משלו יחד עם ה-Z הסניפי' : ''}
        {row.openBasket ? ` · ${row.openBasket}` : ''}
        {showAction && !row.action.available && row.action.whyNot ? ` · ${row.action.label}: ${row.action.whyNot}` : ''}
        {showAction && row.action.available ? ` · ${row.action.label} — מ"סגירה / Z" בשורת הקופה` : ''}
      </span>
    </li>
  );
}

/** The confirmation: every till's figures, the shop total and the next number. Sends and closes. */
/**
 * "זיכוי באשראי מהענן — חובה לפני ה-Z הבא": each credit note a till of the Z still owes, on its line —
 * one the close issues into the closing shift is said so; any other holds the Z.
 */
function CloudRefundLines({ pending }: { pending: CloudRefundPending[] }) {
  if (pending.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-sm">
      {pending.map((r) => (
        <li key={r.refundId} className={r.landsInThisZ ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400'}>
          <span className="font-medium">{r.words}</span>
          {' · '}
          {r.landsInThisZ ? `יופק במשמרת שנסגרת בקופה ${r.machineName ?? '—'}` : r.message}
          {r.warning ? <span className="block text-xs">{r.warning}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function ShopCloseDialog({
  p,
  onClose,
  forceReason,
  forceCloudRefundReason,
}: {
  p: ShopClosePreview;
  onClose: () => void;
  forceReason?: string;
  forceCloudRefundReason?: string;
}) {
  const qc = useQueryClient();
  const [checked, setChecked] = useState<string | null>(null);
  const [asked, setAsked] = useState<{ flag: 'confirmCloudData' | 'confirmOpenTills'; text: string; message?: string } | null>(null);
  const [flags, setFlags] = useState<{ confirmCloudData?: boolean; confirmOpenTills?: boolean }>({});
  const [askedChecked, setAskedChecked] = useState(false);
  const send = useMutation({
    mutationFn: (extra: { confirmCloudData?: boolean; confirmOpenTills?: boolean }) =>
      requestShopClose({
        shopId: p.shopId,
        totalsKey: p.totalsKey,
        ...extra,
        ...(forceReason ? { forceReason } : {}),
        ...(forceCloudRefundReason ? { forceCloudRefundReason } : {}),
        ...(p.areaId ? { areaId: p.areaId } : {}),
      }),
    onSuccess: () => {
      toast.success('נשלח לקופות — כל קופה תיסגר כשאין בה מכירה או תשלום פתוחים');
      qc.invalidateQueries({ queryKey: key(p.shopId, p.areaId) });
      onClose();
    },
    onError: (e: unknown) => {
      const detail = errorDetail(e);
      if (detail?.code === 'totals_changed') {
        toast.error('הסכומים בסניף השתנו מאז — בדקו שוב ואשרו');
        setChecked(null);
        qc.invalidateQueries({ queryKey: key(p.shopId, p.areaId) });
        onClose();
        return;
      }
      const confirm = confirmationAsked(detail?.code);
      if (confirm) {
        setAsked({ ...confirm, message: detail?.message });
        setAskedChecked(false);
        return;
      }
      toast.error(detail?.message ?? axiosErrorToToastMessage(e, 'השליחה נכשלה'));
    },
  });
  const confirmed = checked === p.totalsKey && (!asked || askedChecked);
  const go = () => {
    const next = asked ? { ...flags, [asked.flag]: true } : flags;
    setFlags(next);
    if (asked) setAsked(null);
    send.mutate(next);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{p.shopClose.label} · {p.areaName ?? p.shopName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            כל קופה ב-Z הסניפי תסגור את המשמרת רק כשאין בה מכירה או תשלום פתוחים. כשכולן ייסגרו יופק ה-Z הסניפי ({p.source.label}).
          </p>
          <ul className="space-y-1.5">
            {p.inShopZ.map((row) => <DeviceLine key={row.machineId} row={row} showAction={false} />)}
          </ul>
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
            <dt className="text-muted-foreground">Z סניפי הבא (צפוי)</dt>
            <dd className="tabular-nums">{p.nextShopZNumber}</dd>
          </dl>
          {p.ownZ.length > 0 ? (
            <p className="text-muted-foreground">
              לא נכללות (Z משלהן): {p.ownZ.map((r) => r.name).join(', ')}
            </p>
          ) : null}
          {(p.leftovers ?? []).length > 0 ? (
            <p className="text-muted-foreground">
              נכללים גם מסמכים ממתינים של: {(p.leftovers ?? []).map((r) => `${r.name} (${money(r.net)})`).join(', ')}
            </p>
          ) : null}
          {forceReason ? (
            <p className="rounded-lg bg-amber-50 p-2 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
              כפיית התחלה (תמיכה): {forceReason}
            </p>
          ) : null}
          <CloudRefundLines pending={p.cloudRefundGuard?.pending ?? []} />
          {forceCloudRefundReason ? (
            <p className="rounded-lg bg-amber-50 p-2 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
              כפייה (תמיכה) — ה-Z יופק בלי מסמכי הזיכוי שעוד לא הופקו, והם ייכנסו ל-Z הבא: {forceCloudRefundReason}
            </p>
          ) : null}
          <label className="flex min-h-11 items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 size-4 accent-primary"
              checked={checked === p.totalsKey}
              onChange={(e) => setChecked(e.target.checked ? p.totalsKey : null)}
            />
            <span>בדקתי את הסכומים ואני מאשר/ת סגירת יום לכל הקופות שברשימה</span>
          </label>
          {asked ? (
            <div className="space-y-2 rounded-lg bg-amber-50 p-2 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
              {asked.message ? <p>{asked.message}</p> : null}
              <label className="flex min-h-11 items-start gap-2">
                <input type="checkbox" className="mt-1 size-4 accent-primary" checked={askedChecked} onChange={(e) => setAskedChecked(e.target.checked)} />
                <span>{asked.text}</span>
              </label>
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="min-h-11" onClick={onClose}>
            ביטול
          </Button>
          <Button className="min-h-11" disabled={!confirmed || send.isPending} onClick={go}>
            {send.isPending ? 'שולח…' : shopConfirmLabel()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Inline in the remote control panel: the shop's day close, its source and its live progress. */
export function ShopClosePanel({ shopId, areaId }: { shopId: string; areaId?: string | null }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [areaShifts, setAreaShifts] = useState(false);
  const preview = useQuery({
    queryKey: key(shopId, areaId),
    queryFn: () => fetchShopClosePreview(shopId, areaId),
    retry: (count, e) => ![403, 404].includes((e as { response?: { status?: number } })?.response?.status ?? 0) && count < 2,
    // Live while a run goes on; otherwise as the device rows.
    refetchInterval: (q) =>
      [403, 404].includes((q.state.error as { response?: { status?: number } } | null)?.response?.status ?? 0)
        ? false
        : runActive(q.state.data?.run?.status)
          ? 5_000
          : 30_000,
  });
  // A run that finished (or was cancelled) leaves the preview: its outcome stays shown until dismissed.
  const liveRunId = preview.data?.run?.id ?? null;
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  // Adjusted while rendering (react.dev "storing information from previous renders"), not in an effect.
  if (liveRunId && liveRunId !== lastRunId) setLastRunId(liveRunId);
  const finished = useQuery({
    queryKey: [...key(shopId, areaId), 'run', lastRunId],
    queryFn: () => fetchShopCloseRun(lastRunId!),
    enabled: !!lastRunId && !liveRunId && !!preview.data,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: key(shopId, areaId) });
  const cancel = useMutation({
    mutationFn: (runId: string) => cancelShopClose(runId),
    onSuccess: () => {
      toast.success('סגירת היום בוטלה — קופות שעוד לא נסגרו לא יתבקשו עוד');
      refresh();
    },
    onError: (e) => toast.error(errorDetail(e)?.message ?? axiosErrorToToastMessage(e, 'הביטול נכשל')),
  });
  const proceed = useMutation({
    mutationFn: ({ runId, ids }: { runId: string; ids: string[] }) => proceedShopClose(runId, ids),
    onSuccess: () => {
      toast.success('ה-Z הסניפי מופק בלי הקופות שלא נסגרו — המשמרות שלהן ייכנסו ל-Z הבא');
      refresh();
    },
    onError: (e) => toast.error(errorDetail(e)?.message ?? axiosErrorToToastMessage(e, 'ההפקה נכשלה')),
  });
  const [forceReason, setForceReason] = useState('');
  const [startReason, setStartReason] = useState('');
  const [refundStartReason, setRefundStartReason] = useState('');
  const [refundForceReason, setRefundForceReason] = useState('');
  const forceRefunds = useMutation({
    mutationFn: ({ runId, reason }: { runId: string; reason: string }) => forceShopCloseCloudRefunds(runId, reason),
    onSuccess: () => {
      toast.success('ה-Z הופק בכפייה — זיכויי האשראי מהענן ייכנסו ל-Z הבא');
      setRefundForceReason('');
      refresh();
    },
    onError: (e) => toast.error(errorDetail(e)?.message ?? axiosErrorToToastMessage(e, 'הכפייה נכשלה')),
  });
  const [heldFor, setHeldFor] = useState<string | null>(null);
  const force = useMutation({
    mutationFn: ({ runId, ids, reason }: { runId: string; ids: string[]; reason: string }) => forceShopClose(runId, ids, reason),
    onSuccess: () => {
      toast.success('ה-Z הסניפי הופק בכפייה — הקופות שלא נסגרו רשומות עליו, והמשמרות שלהן ייכנסו ל-Z הבא');
      setForceReason('');
      refresh();
    },
    onError: (e) => toast.error(errorDetail(e)?.message ?? axiosErrorToToastMessage(e, 'הכפייה נכשלה')),
  });

  if (preview.isPending) return <Skeleton className="h-20 w-full rounded-xl" />;
  // Not this user's (no Z section, or some of the shop's points of sale only) or off: nothing shown.
  const refusedStatus = (preview.error as { response?: { status?: number } } | null)?.response?.status;
  if (refusedStatus === 403 || refusedStatus === 404) return null;
  if (preview.isError || !preview.data) {
    return <p className="text-sm text-destructive">{axiosErrorToToastMessage(preview.error, 'טעינת סגירת היום נכשלה')}</p>;
  }
  const p = preview.data;
  const run = p.run ?? (lastRunId && finished.data?.id === lastRunId ? finished.data : null);
  const counts = run ? runCounts(run) : null;
  const waiting = run ? notClosedIds(run) : [];
  const leavable = run ? leavableIds(run) : [];
  return (
    <section className="space-y-2 rounded-xl border bg-card p-3 shadow-sm" aria-label={p.shopClose.label}>
      <div className="flex flex-wrap items-center gap-2">
        <CalendarCheck className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="font-semibold">
          {p.shopClose.label}
          {p.areaName ? ` · ${p.areaName}` : ''}
        </h3>
        <Badge variant="outline">{p.source.label}</Badge>
        {p.run ? null : run ? (
          <Button size="sm" variant="ghost" className="ms-auto min-h-10" onClick={() => setLastRunId(null)}>
            סגור
          </Button>
        ) : (
          <Button size="sm" className="ms-auto min-h-10" disabled={!p.shopClose.available} onClick={() => setConfirming(true)}>
            {p.shopClose.label}…
          </Button>
        )}
      </div>
      {!run && !p.shopClose.available && p.shopClose.whyNot ? <p className="text-sm text-muted-foreground">{p.shopClose.whyNot}</p> : null}
      {!run && !p.shopClose.available && p.shopClose.forceStartAllowed ? (
        <div className="space-y-2 rounded-lg border border-destructive/40 p-2">
          <p className="text-xs font-medium">התחלה בכפייה (תמיכה) — קופות במצב לא ידוע לא ייסגרו, והמשמרות שלהן ייכנסו ל-Z הבא</p>
          <Input
            value={startReason}
            onChange={(e) => setStartReason(e.target.value)}
            placeholder="סיבת הכפייה (חובה)"
            maxLength={300}
            className="min-h-10"
          />
          <Button size="sm" variant="destructive" className="min-h-10" disabled={!forceReasonOk(startReason)} onClick={() => setConfirming(true)}>
            {p.shopClose.label} בכפייה…
          </Button>
        </div>
      ) : null}
      {!run && !p.shopClose.available && p.shopClose.forceCloudRefundAllowed ? (
        <div className="space-y-2 rounded-lg border border-destructive/40 p-2">
          <p className="text-xs font-medium">
            התחלה בכפייה (תמיכה) — ה-Z יופק בלי מסמכי הזיכוי שעוד לא הופקו, והם ייכנסו ל-Z הבא (נרשם כחריגה)
          </p>
          <Input
            value={refundStartReason}
            onChange={(e) => setRefundStartReason(e.target.value)}
            placeholder="סיבת הכפייה (חובה)"
            maxLength={300}
            className="min-h-10"
          />
          <Button size="sm" variant="destructive" className="min-h-10" disabled={!forceReasonOk(refundStartReason)} onClick={() => setConfirming(true)}>
            {p.shopClose.label} בכפייה…
          </Button>
        </div>
      ) : null}
      {!run ? <CloudRefundLines pending={[...(p.cloudRefundGuard?.pending ?? []), ...(p.cloudRefundGuard?.warnings ?? [])]} /> : null}
      {p.shiftGuard.required && p.shiftGuard.blockers.length > 0 ? (
        <div className="space-y-1 text-sm">
          <p className="text-amber-700 dark:text-amber-400">{p.shiftGuard.label}: ה-Z ימתין לכל הקופות האלה</p>
          <ul className="space-y-0.5">
            {p.shiftGuard.blockers.map((b) => (
              <li key={b.machineId} className="flex flex-wrap gap-1.5">
                <span>{b.name}</span>
                {b.posNumber ? <span className="text-xs text-muted-foreground">#{b.posNumber}</span> : null}
                <span className="ms-auto text-amber-700 dark:text-amber-400">{b.words}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {p.shiftGuard.required && (p.shiftGuard.offlineClosed ?? []).length > 0 ? (
        <ul className="space-y-0.5 text-sm text-muted-foreground">
          {(p.shiftGuard.offlineClosed ?? []).map((b) => (
            <li key={b.machineId} className="flex flex-wrap gap-1.5">
              <span>{b.name}</span>
              {b.posNumber ? <span className="text-xs">#{b.posNumber}</span> : null}
              <span className="ms-auto">{b.words}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {run ? (
        <div className="space-y-2 text-sm">
          <p className="font-medium">
            {run.words}
            {counts && runActive(run.status) ? ` · ${counts.closed}/${counts.total} נסגרו` : ''}
          </p>
          {(run.warnings ?? []).map((w) => (
            <p key={w} className="text-xs text-amber-700 dark:text-amber-400">{w}</p>
          ))}
          <CloudRefundLines pending={run.pendingCloudRefunds ?? []} />
          {run.status === 'waiting' && run.forceCloudRefundsAllowed ? (
            <div className="w-full space-y-2 rounded-lg border border-destructive/40 p-2">
              <p className="text-xs font-medium">כפיית הפקה (תמיכה) — הזיכויים ייכנסו ל-Z הבא</p>
              <Input
                value={refundForceReason}
                onChange={(e) => setRefundForceReason(e.target.value)}
                placeholder="סיבת הכפייה (חובה)"
                maxLength={300}
                className="min-h-10"
              />
              <Button
                size="sm"
                variant="destructive"
                className="min-h-10"
                disabled={!forceReasonOk(refundForceReason) || forceRefunds.isPending}
                onClick={() => forceRefunds.mutate({ runId: run.id, reason: refundForceReason.trim() })}
              >
                כפה Z בלי הזיכויים
              </Button>
            </div>
          ) : null}
          <ul className="space-y-1">
            {run.items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-1.5">
                <span>{i.machineName ?? i.machineId}</span>
                {i.posNumber ? <span className="text-xs text-muted-foreground">#{i.posNumber}</span> : null}
                <span className={cn('ms-auto', TONE[itemTone(i.status, i.errorCode)])}>{i.words}</span>
                {i.heldSales != null && runActive(run.status) ? (
                  <Button size="sm" variant="outline" className="min-h-9" onClick={() => setHeldFor(i.id)}>
                    מכירות מושהות…
                  </Button>
                ) : null}
                {(i.heldSalesCancelled ?? []).length > 0 ? (
                  <span className="w-full text-xs text-muted-foreground">
                    בוטלו מהענן: {(i.heldSalesCancelled ?? []).map((c) => `${c.total ?? '—'} (${c.by ?? '—'}: ${c.reason ?? ''})`).join(' · ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {runActive(run.status) && run.status === 'waiting' ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="min-h-10" disabled={cancel.isPending} onClick={() => cancel.mutate(run.id)}>
                ביטול סגירת היום
              </Button>
              {waiting.length > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-10"
                  disabled={!run.leaveOutAllowed || leavable.length === 0 || proceed.isPending}
                  title={run.leaveOutWhyNot ?? undefined}
                  onClick={() => proceed.mutate({ runId: run.id, ids: leavable })}
                >
                  הפק בלי הקופות שלא נסגרו
                </Button>
              ) : null}
              {!run.leaveOutAllowed && run.leaveOutWhyNot && waiting.length > 0 ? (
                <p className="w-full text-xs text-muted-foreground">{run.leaveOutWhyNot} — אי אפשר להפיק בלי קופה.</p>
              ) : null}
            </div>
          ) : null}
          {run.status === 'waiting' && run.forceAllowed && !run.leaveOutAllowed && waiting.length > 0 ? (
            <div className="w-full space-y-2 rounded-lg border border-destructive/40 p-2">
              <p className="text-xs font-medium">כפיית הפקה (תמיכה) — המשמרות של הקופות שלא נסגרו ייכנסו ל-Z הבא</p>
              <Input
                value={forceReason}
                onChange={(e) => setForceReason(e.target.value)}
                placeholder="סיבת הכפייה (חובה) — למשל: המכשיר לא נדלק"
                maxLength={300}
                className="min-h-10"
              />
              <Button
                size="sm"
                variant="destructive"
                className="min-h-10"
                disabled={!forceReasonOk(forceReason) || force.isPending}
                onClick={() => force.mutate({ runId: run.id, ids: waiting, reason: forceReason.trim() })}
              >
                כפה הפקה בלי הקופות שלא נסגרו
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {p.ownZ.length > 0 ? (
        <details className="text-sm">
          <summary className="min-h-10 cursor-pointer py-2 text-muted-foreground">קופות עם Z משלהן ({p.ownZ.length})</summary>
          <ul className="space-y-1.5">
            {p.ownZ.map((row) => <DeviceLine key={row.machineId} row={row} showAction />)}
          </ul>
        </details>
      ) : null}
      {heldFor && run ? (() => {
        const item = run.items.find((x) => x.id === heldFor);
        return item ? (
          <HeldSalesDialog
            machineId={item.machineId}
            machineName={item.machineName ?? item.machineId}
            runId={run.id}
            state={item}
            onClose={() => setHeldFor(null)}
          />
        ) : null;
      })() : null}
      {areaId ? (
        <Button size="sm" variant="outline" className="min-h-10" onClick={() => setAreaShifts(true)}>
          סגירת משמרות לנקודת מכירה…
        </Button>
      ) : null}
      {areaShifts && areaId ? (
        <AreaShiftsDialog shopId={shopId} areaId={areaId} areaName={p.areaName ?? ''} onClose={() => setAreaShifts(false)} />
      ) : null}
      {!areaId && (p.areas ?? []).length > 0 ? (
        <details className="text-sm">
          <summary className="min-h-10 cursor-pointer py-2 text-muted-foreground">לפי נקודת מכירה ({(p.areas ?? []).length})</summary>
          <div className="space-y-2">
            {(p.areas ?? []).map((a) => (
              <ShopClosePanel key={a.areaId} shopId={shopId} areaId={a.areaId} />
            ))}
          </div>
        </details>
      ) : null}
      {confirming ? (
        <ShopCloseDialog
          p={p}
          forceReason={!p.shopClose.available && p.shopClose.forceStartAllowed ? startReason.trim() : undefined}
          forceCloudRefundReason={
            !p.shopClose.available && p.shopClose.forceCloudRefundAllowed ? refundStartReason.trim() : undefined
          }
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </section>
  );
}
