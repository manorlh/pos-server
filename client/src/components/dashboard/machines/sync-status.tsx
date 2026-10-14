'use client';

/**
 * "סנכרון" — a device's sync state against the cloud (P:/specs/device-sync-status.md §3; pos-server
 * `GET /machines/{id}/sync-status`, lib/syncStatus.ts):
 *
 * * **The card** (the device's page, its health drawer): a row per domain — ✓ מעודכן, ⏳ ממתין with
 *   what changed and when, ✗ with the device's error — and its last pull; what the device has not
 *   uploaded ("3 מסמכים, הישן מ-10:31"); "לא מעודכן מ-…" when it is stale.
 * * **"סנכרן עכשיו"**: the `sync_now` command (woken over Ably), then the device's report is read
 *   every few seconds — each domain ממתין → נמשך → ✓ — until everything arrived ("הכל התקבל ✓"),
 *   or 60 seconds pass: what is still missing and why, or "המכשיר לא ענה".
 * * **The list's cell** (`SyncCell`) and **"סנכרן את כל הסניף"** (`ShopSyncDialog`): a line per device.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw } from 'lucide-react';

import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatTime, formatTimeAgo } from '@/lib/format';
import {
  PROGRESS_LABEL,
  STATE_LABEL,
  SYNC_POLL_MS,
  SYNC_RUN_TIMEOUT_MS,
  branchSummary,
  domainNote,
  domainProgress,
  listCell,
  markOf,
  outboxLine,
  outcomeText,
  runOutcome,
  type CommandView,
  type DeviceSyncStatus,
  type DomainProgress,
  type RunOutcome,
  type Tone,
} from '@/lib/syncStatus';
import { newKey } from '@/lib/deviceCommands';
import { fetchCommandViews, fetchShopSyncStatus, fetchSyncStatus, sendSyncNow } from '@/lib/syncStatusApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  wait: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
  muted: 'text-muted-foreground',
};

const PROGRESS_TONE: Record<DomainProgress, Tone> = { waiting: 'muted', pulling: 'wait', done: 'ok', error: 'error' };

const hhmm = (iso: string) => formatTime(iso);

/** The clock the screen reads: every second while `fast` (a run), else every half minute. */
function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000);
    return () => clearInterval(id);
  }, [fast]);
  return now;
}

const FINAL_COMMAND = new Set(['done', 'refused', 'failed', 'expired', 'cancelled']);

/** A run asks every few seconds until a little after its 60 seconds, then at the card's own pace. */
function runDeadline(startedAt: number): number {
  return startedAt + SYNC_RUN_TIMEOUT_MS + 5_000;
}

function outcomeTone(o: RunOutcome): Tone {
  if (o.kind === 'all_received') return 'ok';
  if (o.kind === 'running') return 'wait';
  if (o.kind === 'not_reporting') return 'muted';
  return 'error';
}

interface Run {
  startedAt: number;
  commandId: string | null;
  sendError: string | null;
}

// ── The card ────────────────────────────────────────────────────────────────

export function SyncStatusCard({
  machineId,
  machineName,
  embedded = false,
}: {
  machineId: string;
  machineName?: string | null;
  /** Inside another panel (the health drawer): no card frame of its own. */
  embedded?: boolean;
}) {
  const queryClient = useQueryClient();
  const [run, setRun] = useState<Run | null>(null);
  const [sending, setSending] = useState(false);

  const deadline = run ? runDeadline(run.startedAt) : 0;
  const status = useQuery({
    queryKey: ['machine-sync-status', machineId],
    queryFn: () => fetchSyncStatus(machineId),
    refetchInterval: (q) => (run && !q.state.error && Date.now() < deadline ? SYNC_POLL_MS : 30_000),
  });
  const command = useQuery({
    queryKey: ['sync-now-command', run?.commandId],
    queryFn: async () => (await fetchCommandViews([run!.commandId!]))[0] ?? null,
    enabled: !!run?.commandId,
    refetchInterval: (q) => {
      const st = q.state.data?.status;
      if (st && FINAL_COMMAND.has(st)) return false;
      return Date.now() < deadline ? SYNC_POLL_MS : false;
    },
  });

  const now = useNow(!!run);
  const outcome: RunOutcome | null = run
    ? run.sendError
      ? { kind: 'refused', detail: run.sendError }
      : runOutcome(status.data, run.startedAt, now, command.data ?? null, hhmm)
    : null;
  const running = outcome?.kind === 'running';

  const start = async () => {
    setSending(true);
    const startedAt = Date.now();
    try {
      const rows = await sendSyncNow({ machineIds: [machineId] }, new Map([[machineId, machineName ?? '']]));
      setRun({ startedAt, commandId: rows[0]?.id ?? null, sendError: null });
    } catch (err) {
      setRun({ startedAt, commandId: null, sendError: axiosErrorToToastMessage(err, 'השליחה נכשלה') });
    } finally {
      setSending(false);
      queryClient.invalidateQueries({ queryKey: ['machine-sync-status', machineId] });
    }
  };

  const s = status.data;
  const body = (
    <div className="space-y-3">
      {status.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : status.error ? (
        <p className="text-xs text-muted-foreground">{axiosErrorToToastMessage(status.error, 'לא ניתן לקרוא את מצב הסנכרון')}</p>
      ) : s ? (
        <>
          {!s.reported ? (
            <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              המכשיר עוד לא מדווח מצב סנכרון — צריך גרסה שמדווחת. &quot;סנכרן עכשיו&quot; עדיין שולח לו סנכרון.
            </p>
          ) : (
            <ul className="divide-y rounded-md border text-sm">
              {s.domains.map((d) => {
                const m = markOf(d.status);
                const progress = run && running ? domainProgress(d, s, run.startedAt, command.data ?? null) : null;
                const note = domainNote(d, hhmm);
                return (
                  <li key={d.domain} className="flex items-start gap-2 px-3 py-2">
                    <span className={cn('w-5 shrink-0 text-center font-semibold', TONE_TEXT[m.tone])} aria-hidden>
                      {m.mark}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{d.label}</span>
                        <span className={cn('text-xs', TONE_TEXT[m.tone])}>{STATE_LABEL[d.status]}</span>
                        {d.stale ? <span className="text-xs font-medium text-red-600">לא מעודכן יותר מדי זמן</span> : null}
                      </div>
                      {note ? <div className="break-words text-xs text-muted-foreground">{note}</div> : null}
                    </div>
                    <div className="shrink-0 text-end text-[11px] text-muted-foreground">
                      {progress ? (
                        <span className={cn('font-medium', TONE_TEXT[PROGRESS_TONE[progress]])}>{PROGRESS_LABEL[progress]}</span>
                      ) : d.pulledAt ? (
                        <span title={d.pulledAt}>נמשך {formatTimeAgo(d.pulledAt, now)}</span>
                      ) : (
                        <span>לא נמשך</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {s.outbox ? <>לא הועלה: {outboxLine(s.outbox, hhmm)}</> : 'המכשיר לא מדווח מה עוד לא הועלה'}
            </span>
            {s.reportedAt ? <span title={s.reportedAt}>דיווח אחרון {formatTimeAgo(s.reportedAt, now)}</span> : null}
          </div>
          {s.stale && s.staleSince ? (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">
              המכשיר מחובר ולא מעודכן מ-{hhmm(s.staleSince)} (יותר מ-{s.staleMinutes} דקות)
            </p>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" onClick={start} disabled={sending || running}>
          {sending || running ? <Loader2 className="h-4 w-4 animate-spin ms-1" aria-hidden /> : <RefreshCw className="h-4 w-4 ms-1" aria-hidden />}
          סנכרן עכשיו
        </Button>
        {outcome ? (
          <span className={cn('text-sm font-medium', TONE_TEXT[outcomeTone(outcome)])} role="status">
            {outcomeText(outcome)}
          </span>
        ) : null}
      </div>
      {outcome?.kind === 'incomplete' && outcome.missing.length > 0 ? (
        <ul className="list-disc space-y-0.5 ps-5 text-xs text-muted-foreground">
          {outcome.missing.map((m) => (
            <li key={m.domain}>
              <span className="font-medium text-foreground">{m.label}</span> — {m.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  if (embedded) return body;
  return (
    <Card id="sync">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">סנכרון</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

// ── The list's cell ─────────────────────────────────────────────────────────

export function SyncCell({ status }: { status: DeviceSyncStatus | null | undefined }) {
  const c = listCell(status);
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium', TONE_TEXT[c.tone])} title={c.title}>
      <span aria-hidden>{c.mark}</span>
      {c.count ? <span className="tabular-nums">{c.count}</span> : null}
      <span className="sr-only">{c.title}</span>
    </span>
  );
}

// ── "סנכרן את כל הסניף" ─────────────────────────────────────────────────────

export function ShopSyncDialog({
  shopId,
  shopName,
  names,
  open,
  onOpenChange,
}: {
  shopId: string | null;
  shopName: string;
  /** Device names by id (the list's labels) — memoized by the caller: a new map would send again. */
  names: ReadonlyMap<string, string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>סנכרן את כל הסניף</DialogTitle>
          <DialogDescription>{shopName}: כל מכשיר מקבל &quot;סנכרן עכשיו&quot;, ונבדק שהכל התקבל (עד 60 שניות).</DialogDescription>
        </DialogHeader>
        {/* A run per opening: mounted with the dialog, forgotten when it closes. */}
        {open && shopId ? <ShopSyncRun key={shopId} shopId={shopId} names={names} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ShopSyncRun({ shopId, names }: { shopId: string; names: ReadonlyMap<string, string> }) {
  const [startedAt] = useState(() => Date.now());
  // One key per run: a second mount of the same run (React's dev double effect) gets the same commands back.
  const [key] = useState(() => newKey());
  const [commands, setCommands] = useState<CommandView[] | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    sendSyncNow({ shopId }, names, key)
      .then((rows) => {
        if (live) setCommands(rows);
      })
      .catch((err) => {
        if (live) setSendError(axiosErrorToToastMessage(err, 'השליחה נכשלה'));
      });
    return () => {
      live = false;
    };
  }, [shopId, names, key]);

  const deadline = runDeadline(startedAt);
  const commandIds = useMemo(() => (commands ?? []).map((c) => c.id ?? '').filter(Boolean), [commands]);
  const now = useNow(true);
  const statuses = useQuery({
    queryKey: ['shop-sync-status', shopId, key],
    queryFn: () => fetchShopSyncStatus(shopId),
    enabled: commands !== null,
    refetchInterval: () => (Date.now() < deadline ? SYNC_POLL_MS : false),
  });
  const views = useQuery({
    queryKey: ['shop-sync-commands', key, commandIds.join(',')],
    queryFn: () => fetchCommandViews(commandIds),
    enabled: commandIds.length > 0,
    refetchInterval: () => (Date.now() < deadline ? SYNC_POLL_MS : false),
  });

  const byMachine = useMemo(() => {
    const map = new Map<string, CommandView>();
    for (const c of commands ?? []) if (c.machineId) map.set(c.machineId, c);
    for (const v of views.data ?? []) {
      const mine = (commands ?? []).find((c) => c.id === v.id);
      if (mine?.machineId) map.set(mine.machineId, { ...v, machineId: mine.machineId });
    }
    return map;
  }, [commands, views.data]);

  if (sendError) return <p className="text-sm text-red-600">{sendError}</p>;
  if (commands === null || !statuses.data) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> שולח…
      </div>
    );
  }
  const summary = branchSummary(statuses.data.items ?? [], byMachine, startedAt, now, hhmm, names);
  const allReceived = summary.rows.length > 0 && summary.counts.received === summary.rows.length;
  return (
    <div className="space-y-3">
      <p
        className={cn('text-sm font-medium', summary.done ? (allReceived ? TONE_TEXT.ok : TONE_TEXT.error) : TONE_TEXT.wait)}
        role="status"
      >
        {summary.done ? null : <Loader2 className="me-1 inline h-4 w-4 animate-spin" aria-hidden />}
        {summary.text}
      </p>
      <ul className="divide-y rounded-md border text-sm">
        {summary.rows.map((r) => (
          <li key={r.machineId} className="space-y-0.5 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{r.name}</span>
              <span className={cn('shrink-0 text-xs font-medium', TONE_TEXT[outcomeTone(r.outcome)])}>{outcomeText(r.outcome)}</span>
            </div>
            {r.outcome.kind === 'incomplete' && r.outcome.missing.length > 0 ? (
              <div className="text-xs text-muted-foreground">
                {r.outcome.missing.map((m) => `${m.label} — ${m.reason}`).join(' · ')}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
