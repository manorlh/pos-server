'use client';

/**
 * "כרטיס שולחן" (P:/specs/live-tables-cloud.md §2–§4, the contract in §6; pos-server
 * app/services/table_card.py and app/services/table_actions.py): a side sheet (a bottom sheet on a phone)
 * with the table's lines by diner and course — what went to the kitchen, when and in which round — its
 * payments (parts paid, payments given back) and balance, who opened it and its waiter, its times, the
 * next course's countdown and its history; and the actions: print the bill (on a printer chosen), a
 * kitchen reprint (everything, a round or lines — the till's picker), fire / hold a course, rush, change
 * the waiter, move to a free table, merge another open table into it, a table note, release the lock and
 * cancel. No payment action: those are the till's.
 *
 * Who does each (the order's `route`): the cloud's tables — the cloud, at once (200); the LAN host or a
 * single till — a command to it, followed here until it answers or the timeout says "לא זמינה" (202).
 * A till inside the table ("פתוח כעת בקופה 2 (דנה)") blocks every action that changes it; the bill, a
 * reprint and releasing the lock stay.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency, formatDateTime, formatQuantity, formatTime } from '@/lib/format';
import {
  actionView,
  countdown,
  directErrorView,
  groupLines,
  pickKey,
  seatedText,
  stillWaiting,
  toggleRound,
  type ActionView,
  type Pick,
} from '@/lib/liveTables';
import { remoteCancelView, stillSending } from '@/lib/remoteTableCancel';
import { billPrintOnView } from '@/lib/remotePrint';
import { tableDisplay } from '@/lib/tableRestore';
import {
  cancelOpenTable,
  fetchBillPrinters,
  fetchCancelReasons,
  fetchRemoteCancel,
  fetchTableCard,
  fetchTableCommand,
  fetchTableWaiters,
  forceReleaseTable,
  postTableAction,
  tablesErrorCode,
  tablesErrorDetail,
  type CardAction,
  type CardLine,
  type TableActionBody,
  type TableCard,
  type TablesLive,
} from '@/lib/tablesApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type SentAction = Exclude<CardAction, 'release' | 'cancel'>;

/** The card's actions, in the order the sheet lists them. */
const ACTIONS: CardAction[] = ['print-bill', 'reprint', 'fire', 'hold', 'rush', 'set-waiter', 'move', 'merge', 'note', 'release', 'cancel'];

/** The side sheet on a wide screen (the dialog is a bottom sheet on a phone by itself). */
const SHEET =
  'sm:top-0 sm:left-0 sm:h-dvh sm:max-h-dvh sm:w-[30rem] sm:max-w-[calc(100%-2rem)] sm:translate-x-0 sm:translate-y-0 sm:rounded-none sm:rounded-s-xl sm:content-start';

/** The clock the floor's and the card's times are written by: a tick every 15 seconds. */
export function useNow(stepMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(id);
  }, [stepMs]);
  return now;
}

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16),
  );
}

interface Following {
  commandId: string;
  action: string;
  startedAt: number;
  timeoutSeconds: number;
  hostName: string | null;
  /** "הדפס חשבון" on another till: where it is to print. */
  printOnName: string | null;
}

export function TableCardSheet({
  shopId,
  tableId,
  live,
  onClose,
  onChanged,
}: {
  shopId: string;
  tableId: string;
  live: TablesLive | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations('tables.card');
  const qc = useQueryClient();
  const { data: card, isLoading } = useQuery({
    queryKey: ['table-card', tableId],
    queryFn: () => fetchTableCard(tableId),
    refetchInterval: 5_000,
  });
  const [panel, setPanel] = useState<CardAction | null>(null);
  const [following, setFollowing] = useState<Following | null>(null);
  const [outcome, setOutcome] = useState<(ActionView & { action: string }) | null>(null);
  const requestId = useRef<string>(newRequestId());
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['table-card', tableId] });
    onChanged();
  };
  const open = (action: CardAction | null) => {
    // A new request for every panel opened: a retry of the same one keeps its id (one command, one ticket).
    requestId.current = newRequestId();
    setOutcome(null);
    setPanel(action);
  };

  const { data: status, dataUpdatedAt } = useQuery({
    queryKey: ['table-command', following?.commandId],
    queryFn: () => fetchTableCommand(following!.commandId),
    enabled: following !== null,
    refetchInterval: (q) =>
      following && stillWaiting(actionView(q.state.data ?? null, following.startedAt, following.timeoutSeconds, Date.now()))
        ? 1_000
        : false,
  });
  const followView = following
    ? billPrintOnView(
        actionView(status ?? null, following.startedAt, following.timeoutSeconds, Math.max(dataUpdatedAt, following.startedAt)),
        status ?? null,
        following.printOnName,
      )
    : null;
  const followRefresh = followView !== null && !stillWaiting(followView) && followView.refresh;
  useEffect(() => {
    if (followRefresh) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followRefresh]);

  const send = useMutation({
    mutationFn: ({ action, body }: { action: SentAction; body: Partial<TableActionBody> }) => {
      const order = card?.order;
      if (!order) throw new Error('no_order');
      return postTableAction(tableId, action, {
        orderId: order.id,
        expectedVersion: order.version,
        requestId: requestId.current,
        ...body,
      });
    },
    onSuccess: (out, vars) => {
      if (out.mode === 'via_till') {
        setFollowing({
          commandId: out.commandId,
          action: vars.action,
          startedAt: Date.now(),
          timeoutSeconds: out.timeoutSeconds,
          hostName: out.hostName,
          printOnName: out.printOnName ?? null,
        });
        setPanel(null);
        return;
      }
      const printers = Array.isArray(out.printers) ? (out.printers as string[]) : [];
      const printing = ['fire', 'reprint', 'rush'].includes(vars.action);
      toast.success(
        [
          t(`result.done.${vars.action}`),
          printing && printers.length > 0 ? t('printedOn', { printers: printers.join(', ') }) : null,
          printing && printers.length === 0 && !out.replayed ? t('noPrinter') : null,
        ]
          .filter(Boolean)
          .join(' · '),
      );
      setPanel(null);
      refresh();
    },
    onError: (err, vars) => {
      const code = tablesErrorCode(err);
      const detail = tablesErrorDetail(err);
      const view = directErrorView(code, { till: (detail?.till as string | undefined) ?? null });
      if (view) {
        setOutcome({ ...view, action: vars.action });
        if (view.refresh || code === 'table_in_use') refresh();
      } else {
        toast.error(axiosErrorToToastMessage(err, t('error')));
      }
    },
  });

  const order = card?.order ?? null;
  const title = card ? tableDisplay(card.table).text : '';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={SHEET}>
        <DialogHeader>
          <DialogTitle>{card ? t('title', { table: title }) : ''}</DialogTitle>
        </DialogHeader>
        {isLoading || !card ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="space-y-3 text-sm">
            <Summary card={card} />
            {card.heldBy ? (
              // §4: a till is inside — what changes the table waits.
              <div className="flex items-start gap-2 rounded-lg border border-violet-500 bg-violet-50 p-2 text-violet-900 dark:bg-violet-950/40 dark:text-violet-100">
                <Lock className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-semibold">
                    {/* §8: the device and the employee in it now, since when ("פתוח כעת: קופה 3 (בר) · דנה"). */}
                    {card.lock?.holderText
                      ? t('heldNow', { holder: card.lock.holderText, since: formatTime(card.lock.since ?? card.lock.acquiredAt) })
                      : t('heldBanner', { till: card.heldBy })}
                  </div>
                  <div className="text-xs">{t('heldHint')}</div>
                </div>
              </div>
            ) : null}
            {order && card.route ? <RouteNote card={card} /> : null}
            {following && followView ? (
              <ResultLine view={followView} action={following.action} hostName={following.hostName} />
            ) : null}
            {outcome ? <ResultLine view={outcome} action={outcome.action} hostName={card.route?.hostName ?? null} /> : null}

            {order ? (
              <ActionBar card={card} panel={panel} onOpen={open} busy={send.isPending} />
            ) : (
              <p className="text-muted-foreground">{t('free')}</p>
            )}
            {panel && order ? (
              <div className="rounded-lg border bg-muted/30 p-2">
                <Panel
                  panel={panel}
                  card={card}
                  shopId={shopId}
                  live={live}
                  busy={send.isPending}
                  onSend={(action, body) => send.mutate({ action, body })}
                  onBack={() => open(null)}
                  onDone={() => {
                    open(null);
                    refresh();
                  }}
                />
              </div>
            ) : null}

            {order ? <Lines card={card} /> : null}
            {order ? <Payments card={card} /> : null}
            {order ? <History card={card} /> : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── The head ──────────────────────────────────────────────────────────────────

function Summary({ card }: { card: TableCard }) {
  const t = useTranslations('tables.card');
  const tl = useTranslations('tables.live');
  const now = useNow();
  const o = card.order;
  const next = card.nextCourse;
  const c = countdown(next ?? null, now);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {card.table.zoneName ? <span>{card.table.zoneName}</span> : null}
        <span>{t('seats', { seats: card.table.seats })}</span>
      </div>
      {o ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <span>{t('guests', { guests: o.guests ?? 0 })}</span>
          <span>{t('minutes', { time: seatedText(card.minutesOpen ?? null) || '—' })}</span>
          <span className="font-semibold">{t('total', { total: formatCurrency(o.total) })}</span>
          <span>{t('waiter', { name: o.waiterName ?? '—' })}</span>
          <span className="col-span-2 text-xs text-muted-foreground">
            {t('openedBy', { name: o.openedByName ?? '—', at: o.openedAt ? formatDateTime(o.openedAt) : '—' })}
            {card.lastSentAt ? ` · ${t('lastSent', { at: formatTime(card.lastSentAt) })}` : ''}
          </span>
          {next && c ? (
            <span className="col-span-2 font-medium text-orange-700 dark:text-orange-400">
              {c.kind === 'in'
                ? tl('nextIn', { course: next.name, minutes: c.minutes })
                : c.kind === 'now'
                  ? tl('nextNow', { course: next.name })
                  : c.kind === 'paused'
                    ? tl('nextPaused', { course: next.name })
                    : tl('nextWaiting', { course: next.name })}
            </span>
          ) : null}
          {card.note?.text ? (
            <span className="col-span-2 rounded bg-amber-50 px-2 py-1 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
              {t('noteShown', { text: card.note.text })} · {card.note.printed ? t('notePrinted') : t('noteWaiting')}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RouteNote({ card }: { card: TableCard }) {
  const t = useTranslations('tables.card');
  const route = card.route!;
  if (route.mode === 'cloud') return null;
  if (route.mode === 'blocked') {
    return (
      <p className="rounded border border-amber-500 p-2 text-xs text-amber-800 dark:text-amber-300">
        {t(`route.blocked.${route.why ?? 'no_till'}`, { host: route.hostName ?? '?' })}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      {t(`route.${route.mode}`, { host: route.hostName ?? '?' })}
      {!card.order?.hasCart ? ` ${t('noCart')}` : ''}
    </p>
  );
}

function ResultLine({ view, action, hostName }: { view: ActionView; action: string; hostName: string | null }) {
  const t = useTranslations('tables.card');
  const text =
    view.phase === 'done'
      ? t.has(`result.${view.key}`)
        ? t(`result.${view.key}`, view.values ?? {})
        : t('result.done.other')
      : view.phase === 'sending'
        ? t(`result.${view.key}`, { host: hostName ?? '?', ...(view.values ?? {}) })
        : t.has(`result.${view.key}`)
          ? t(`result.${view.key}`, view.values ?? {})
          : t('result.refused.other', { reason: view.key });
  const tone =
    view.phase === 'done'
      ? 'border-green-600 text-green-700 dark:text-green-400'
      : view.phase === 'sending'
        ? ''
        : 'border-amber-500 text-amber-800 dark:text-amber-300';
  return (
    <div className={`flex items-center gap-2 rounded border p-2 ${tone}`} data-action={action}>
      {view.phase === 'sending' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : null}
      <span>{text}</span>
    </div>
  );
}

function ActionBar({
  card,
  panel,
  onOpen,
  busy,
}: {
  card: TableCard;
  panel: CardAction | null;
  onOpen: (a: CardAction | null) => void;
  busy: boolean;
}) {
  const t = useTranslations('tables.card');
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {ACTIONS.map((a) => {
        const state = card.actions[a] ?? { allowed: false, why: 'forbidden' };
        const why = state.why ? (state.why.startsWith('blocked:') ? 'blocked' : state.why) : null;
        return (
          <Button
            key={a}
            size="sm"
            variant={panel === a ? 'default' : a === 'cancel' ? 'destructive' : 'outline'}
            className="h-auto min-h-9 whitespace-normal py-1.5 text-xs"
            disabled={!state.allowed || busy}
            title={!state.allowed && why ? t(`why.${why}`) : undefined}
            onClick={() => onOpen(panel === a ? null : a)}
          >
            {t(`actions.${a}`)}
          </Button>
        );
      })}
    </div>
  );
}

// ── The action panels ─────────────────────────────────────────────────────────

function Panel({
  panel,
  card,
  shopId,
  live,
  busy,
  onSend,
  onBack,
  onDone,
}: {
  panel: CardAction;
  card: TableCard;
  shopId: string;
  live: TablesLive | null;
  busy: boolean;
  onSend: (action: SentAction, body: Partial<TableActionBody>) => void;
  onBack: () => void;
  onDone: () => void;
}) {
  switch (panel) {
    case 'print-bill':
      return <BillPanel card={card} busy={busy} onSend={onSend} onBack={onBack} />;
    case 'reprint':
      return <ReprintPanel card={card} busy={busy} onSend={onSend} onBack={onBack} />;
    case 'fire':
    case 'hold':
      return <CoursePanel card={card} hold={panel === 'hold'} busy={busy} onSend={onSend} onBack={onBack} />;
    case 'rush':
      return <ConfirmPanel hint="rushHint" busy={busy} onConfirm={() => onSend('rush', {})} onBack={onBack} />;
    case 'set-waiter':
      return <WaiterPanel card={card} shopId={shopId} busy={busy} onSend={onSend} onBack={onBack} />;
    case 'move':
    case 'merge':
      return <TablePickPanel card={card} live={live} merge={panel === 'merge'} busy={busy} onSend={onSend} onBack={onBack} />;
    case 'note':
      return <NotePanel card={card} busy={busy} onSend={onSend} onBack={onBack} />;
    case 'release':
      return <ReleasePanel card={card} onBack={onBack} onDone={onDone} />;
    case 'cancel':
      return <CancelPanel card={card} onBack={onBack} onDone={onDone} />;
    default:
      return null;
  }
}

function PanelFoot({ busy, onBack, onConfirm, confirmLabel, disabled }: {
  busy: boolean;
  onBack: () => void;
  onConfirm?: () => void;
  confirmLabel?: string;
  disabled?: boolean;
}) {
  const t = useTranslations('tables.card');
  return (
    <div className="mt-2 flex justify-end gap-2">
      <Button size="sm" variant="ghost" onClick={onBack}>
        {t('back')}
      </Button>
      {onConfirm ? (
        <Button size="sm" disabled={busy || disabled} onClick={onConfirm}>
          {busy ? <Loader2 className="me-1 h-4 w-4 animate-spin" /> : null}
          {confirmLabel ?? t('send')}
        </Button>
      ) : null}
    </div>
  );
}

/** "הדפס חשבון" where the table is held (the default, as before) — or on another till (bill-print-other-till §7). */
const ON_OWNER = 'owner';

function BillPanel({ card, busy, onSend, onBack }: {
  card: TableCard;
  busy: boolean;
  onSend: (a: SentAction, b: Partial<TableActionBody>) => void;
  onBack: () => void;
}) {
  const t = useTranslations('tables.card');
  const { data, isLoading } = useQuery({
    queryKey: ['bill-printers', card.table.id],
    queryFn: () => fetchBillPrinters(card.table.id),
  });
  const printers = data?.printers ?? [];
  const remote = data?.remotePrint ?? null;
  // Another till: offered only where the till that holds the table may relay it (its parameters, its build).
  const targets = remote?.available ? remote.targets : [];
  const [key, setKey] = useState<string | null>(null);
  const [where, setWhere] = useState<string>(ON_OWNER);
  const chosen = printers.find((p) => p.key === key) ?? printers[0] ?? null;
  const target = where === ON_OWNER ? null : (targets.find((x) => x.machineId === where && x.available) ?? null);
  const onOwner = where === ON_OWNER || target === null;
  return (
    <div className="space-y-2">
      {targets.length > 0 ? (
        <div className="space-y-1">
          <div className="font-medium">{t('billWhere')}</div>
          <label className="flex cursor-pointer items-center gap-2 rounded border bg-background p-2">
            <input type="radio" name="bill-where" checked={onOwner} onChange={() => setWhere(ON_OWNER)} />
            <span>{t('billOnOwner', { till: remote?.ownerName ?? '?' })}</span>
            <span className="text-xs text-muted-foreground">{t('billOwnerDefault')}</span>
          </label>
          {targets.map((x) => (
            <label
              key={x.machineId}
              className={`flex items-center gap-2 rounded border bg-background p-2 ${x.available ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
            >
              <input
                type="radio"
                name="bill-where"
                disabled={!x.available}
                checked={!onOwner && where === x.machineId}
                onChange={() => setWhere(x.machineId)}
              />
              <span>{t('billOnTill', { till: x.label ?? x.tillName ?? '?' })}</span>
              {x.available ? null : <span className="text-xs text-amber-700 dark:text-amber-400">{t('needsUpdate')}</span>}
            </label>
          ))}
          <p className="text-xs text-muted-foreground">{t('billOnHint')}</p>
        </div>
      ) : null}
      {onOwner ? (
        <>
          <div className="font-medium">{t('billTitle')}</div>
          <p className="text-xs text-muted-foreground">{t('billHint')}</p>
          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : printers.length === 0 ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">{t('noPrinters')}</p>
          ) : (
            <div className="space-y-1">
              {printers.map((p) => (
                <label key={p.key} className="flex cursor-pointer items-center gap-2 rounded border bg-background p-2">
                  <input type="radio" name="bill-printer" checked={chosen?.key === p.key} onChange={() => setKey(p.key)} />
                  <span>{p.name ?? t('ownPrinter')}</span>
                  <span className="text-xs text-muted-foreground">{p.tillName}</span>
                </label>
              ))}
            </div>
          )}
        </>
      ) : null}
      <PanelFoot
        busy={busy}
        onBack={onBack}
        disabled={onOwner ? !chosen : false}
        onConfirm={() => {
          if (!onOwner && target) onSend('print-bill', { printOn: target.machineId });
          else if (chosen) onSend('print-bill', { machineId: chosen.machineId, printerId: chosen.printerId });
        }}
      />
    </div>
  );
}

function ReprintPanel({ card, busy, onSend, onBack }: {
  card: TableCard;
  busy: boolean;
  onSend: (a: SentAction, b: Partial<TableActionBody>) => void;
  onBack: () => void;
}) {
  const t = useTranslations('tables.card');
  const rounds = card.rounds ?? [];
  const [scope, setScope] = useState<'all' | 'round' | 'lines'>('all');
  const [roundId, setRoundId] = useState<string | null>(rounds[rounds.length - 1]?.id ?? null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const picked = new Set(picks.map(pickKey));
  const togglePick = (p: Pick) =>
    setPicks((cur) => (picked.has(pickKey(p)) ? cur.filter((x) => pickKey(x) !== pickKey(p)) : [...cur, p]));
  const noLog = !card.order?.hasCart;
  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {(['all', 'round', 'lines'] as const).map((s) => (
          <Button key={s} size="sm" variant={scope === s ? 'default' : 'outline'} disabled={noLog && s !== 'all'} onClick={() => setScope(s)}>
            {t(`reprint.${s === 'round' ? 'roundScope' : s}`)}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t('reprint.hint')}</p>
      {scope !== 'all' ? (
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {rounds.map((r) => (
            <div key={r.id} className="rounded border bg-background p-2">
              <label className="flex cursor-pointer items-center gap-2 font-medium">
                {scope === 'round' ? (
                  <input type="radio" name="reprint-round" checked={roundId === r.id} onChange={() => setRoundId(r.id)} />
                ) : (
                  <input
                    type="checkbox"
                    checked={r.lines.length > 0 && r.lines.every((l) => picked.has(pickKey({ roundId: r.id, lineId: l.lineId })))}
                    onChange={() => setPicks((cur) => toggleRound(cur, r))}
                  />
                )}
                {t('reprint.round', { n: r.number, at: r.at ? formatTime(r.at) : t('reprint.earlier') })}
              </label>
              <ul className="ms-6 mt-1 space-y-0.5 text-xs">
                {r.lines.map((l) => (
                  <li key={l.lineId} className="flex items-center gap-2">
                    {scope === 'lines' ? (
                      <input
                        type="checkbox"
                        checked={picked.has(pickKey({ roundId: r.id, lineId: l.lineId }))}
                        onChange={() => togglePick({ roundId: r.id, lineId: l.lineId })}
                      />
                    ) : null}
                    <span>
                      {formatQuantity(l.quantity)} × {l.name}
                      {l.course ? <span className="text-muted-foreground"> · {l.course}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
      {scope === 'lines' ? <p className="text-xs">{t('reprint.selected', { count: picks.length })}</p> : null}
      <PanelFoot
        busy={busy}
        onBack={onBack}
        disabled={(scope === 'round' && !roundId) || (scope === 'lines' && picks.length === 0)}
        onConfirm={() =>
          onSend('reprint', scope === 'all' ? { scope } : scope === 'round' ? { scope, roundId: roundId ?? undefined } : { scope, picks })
        }
      />
    </div>
  );
}

function CoursePanel({ card, hold, busy, onSend, onBack }: {
  card: TableCard;
  hold: boolean;
  busy: boolean;
  onSend: (a: SentAction, b: Partial<TableActionBody>) => void;
  onBack: () => void;
}) {
  const t = useTranslations('tables.card');
  const courses = (card.courses ?? []).filter((c) => (hold ? (c.waiting || c.paused) && c.holdable : c.waiting));
  return (
    <div className="space-y-2">
      <div className="font-medium">{t(hold ? 'holdTitle' : 'fireTitle')}</div>
      {courses.length === 0 ? <p className="text-xs text-muted-foreground">{t('why.no_course')}</p> : null}
      <div className="flex flex-wrap gap-1.5">
        {courses.map((c) =>
          hold ? (
            <Button
              key={c.id}
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onSend('hold', { courseId: c.id, hold: !c.paused })}
            >
              {c.paused ? t('unhold', { course: c.name }) : t('holdCourse', { course: c.name })}
            </Button>
          ) : (
            <Button key={c.id} size="sm" disabled={busy} onClick={() => onSend('fire', { courseId: c.id })}>
              {t('fireCourse', { course: c.name })}
              {c.paused ? <span className="ms-1 text-xs opacity-80">({t('paused')})</span> : null}
            </Button>
          ),
        )}
      </div>
      <PanelFoot busy={busy} onBack={onBack} />
    </div>
  );
}

function ConfirmPanel({ hint, busy, onConfirm, onBack }: { hint: string; busy: boolean; onConfirm: () => void; onBack: () => void }) {
  const t = useTranslations('tables.card');
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t(hint)}</p>
      <PanelFoot busy={busy} onBack={onBack} onConfirm={onConfirm} />
    </div>
  );
}

function WaiterPanel({ card, shopId, busy, onSend, onBack }: {
  card: TableCard;
  shopId: string;
  busy: boolean;
  onSend: (a: SentAction, b: Partial<TableActionBody>) => void;
  onBack: () => void;
}) {
  const t = useTranslations('tables.card');
  const { data: waiters = [], isLoading } = useQuery({ queryKey: ['table-waiters', shopId], queryFn: () => fetchTableWaiters(shopId) });
  const current = card.order?.waiterPosUserId ?? null;
  const anyOnShift = waiters.some((w) => w.onShift);
  // "גם שיוך" (P:/specs/table-waiter-assignment.md §4): the table's assignment moves with the order.
  const [alsoAssignment, setAlsoAssignment] = useState(false);
  return (
    <div className="space-y-2">
      <div className="font-medium">{t('waiterTitle')}</div>
      {!isLoading && !anyOnShift ? <p className="text-xs text-muted-foreground">{t('noOnShift')}</p> : null}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={alsoAssignment} onChange={(e) => setAlsoAssignment(e.target.checked)} />
        {t('alsoAssignment')}
      </label>
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
          {waiters.map((w) => (
            <Button
              key={w.posUserId}
              size="sm"
              variant={w.posUserId === current ? 'default' : 'outline'}
              disabled={busy || w.posUserId === current}
              onClick={() => onSend('set-waiter', { waiterPosUserId: w.posUserId, ...(alsoAssignment ? { alsoAssignment: true } : {}) })}
            >
              {w.name ?? '?'}
              {w.onShift ? <span className="ms-1 text-[10px] text-green-700 dark:text-green-400">● {t('onShift')}</span> : null}
            </Button>
          ))}
        </div>
      )}
      <PanelFoot busy={busy} onBack={onBack} />
    </div>
  );
}

function TablePickPanel({ card, live, merge, busy, onSend, onBack }: {
  card: TableCard;
  live: TablesLive | null;
  merge: boolean;
  busy: boolean;
  onSend: (a: SentAction, b: Partial<TableActionBody>) => void;
  onBack: () => void;
}) {
  const t = useTranslations('tables.card');
  const mine = card.order;
  const choices = useMemo(() => {
    const rows = (live?.tables ?? []).filter((tb) => tb.id !== card.table.id);
    if (merge) {
      // Another open table of the same kind (the cloud's, or the same till's copies), no till inside it.
      return rows.filter((tb) => tb.order && tb.order.source === mine?.source && tb.state !== 'locked');
    }
    return rows.filter((tb) => !tb.order && tb.state !== 'locked');
  }, [live, card.table.id, merge, mine?.source]);
  return (
    <div className="space-y-2">
      <div className="font-medium">{merge ? t('mergeTitle', { table: tableDisplay(card.table).text }) : t('moveTitle')}</div>
      {merge ? <p className="text-xs text-muted-foreground">{t('mergeHint')}</p> : null}
      {choices.length === 0 ? <p className="text-xs text-muted-foreground">{t(merge ? 'noOpen' : 'noFree')}</p> : null}
      <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
        {choices.map((tb) => (
          <Button
            key={tb.id}
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              onSend(
                merge ? 'merge' : 'move',
                merge
                  ? { sources: [{ tableId: tb.id, orderId: tb.order!.id, expectedVersion: tb.order!.version }] }
                  : { targetTableId: tb.id },
              )
            }
          >
            {tableDisplay(tb).text}
            {tb.zoneName ? <span className="ms-1 text-[10px] text-muted-foreground">{tb.zoneName}</span> : null}
            {merge && tb.order ? <span className="ms-1 text-[10px]">{formatCurrency(tb.order.total)}</span> : null}
          </Button>
        ))}
      </div>
      <PanelFoot busy={busy} onBack={onBack} />
    </div>
  );
}

function NotePanel({ card, busy, onSend, onBack }: {
  card: TableCard;
  busy: boolean;
  onSend: (a: SentAction, b: Partial<TableActionBody>) => void;
  onBack: () => void;
}) {
  const t = useTranslations('tables.card');
  const [text, setText] = useState(card.note?.text ?? '');
  return (
    <div className="space-y-2">
      <Label htmlFor="table-note">{t('actions.note')}</Label>
      <Input
        id="table-note"
        value={text}
        maxLength={120}
        placeholder={t('notePlaceholder')}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">{t('noteHint')}</p>
      <PanelFoot busy={busy} onBack={onBack} onConfirm={() => onSend('note', { text: text.trim() || null })} confirmLabel={t('save')} />
    </div>
  );
}

function ReleasePanel({ card, onBack, onDone }: { card: TableCard; onBack: () => void; onDone: () => void }) {
  const t = useTranslations('tables.card');
  const tt = useTranslations('tables');
  const release = useMutation({
    mutationFn: () => forceReleaseTable(card.table.id),
    onSuccess: () => {
      toast.success(tt('released'));
      onDone();
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('error'))),
  });
  return (
    <div className="space-y-2">
      <p className="rounded border border-amber-500 p-2 text-xs text-amber-800 dark:text-amber-300">
        {t('releaseWarn', { till: card.heldBy ?? '?' })}
      </p>
      <PanelFoot busy={release.isPending} onBack={onBack} onConfirm={() => release.mutate()} confirmLabel={t('actions.release')} />
    </div>
  );
}

/** "בטל שולחן" (#85): the cloud's tables at once; the LAN host by a command, followed here. */
function CancelPanel({ card, onBack, onDone }: { card: TableCard; onBack: () => void; onDone: () => void }) {
  const t = useTranslations('tables.card');
  const tt = useTranslations('tables');
  const qc = useQueryClient();
  const { data: reasons = [] } = useQuery({ queryKey: ['table-cancel-reasons'], queryFn: () => fetchCancelReasons() });
  const [reasonId, setReasonId] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [remote, setRemote] = useState<{ commandId: string; startedAt: number; timeoutSeconds: number } | null>(null);
  const reason = reasons.find((r) => r.id === reasonId);
  const order = card.order!;
  const { data: remoteStatus, dataUpdatedAt } = useQuery({
    queryKey: ['remote-table-cancel', remote?.commandId],
    queryFn: () => fetchRemoteCancel(remote!.commandId),
    enabled: remote !== null,
    refetchInterval: (q) =>
      remote && stillSending(remoteCancelView(q.state.data ?? null, remote.startedAt, remote.timeoutSeconds, Date.now())) ? 1000 : false,
  });
  const remoteView = remote
    ? remoteCancelView(remoteStatus ?? null, remote.startedAt, remote.timeoutSeconds, Math.max(dataUpdatedAt, remote.startedAt))
    : null;
  const remoteRefresh = remoteView !== null && !stillSending(remoteView) && remoteView.refresh;
  useEffect(() => {
    if (remoteRefresh) qc.invalidateQueries({ queryKey: ['table-card', card.table.id] });
  }, [remoteRefresh, qc, card.table.id]);
  const cancel = useMutation({
    mutationFn: () =>
      cancelOpenTable(card.table.id, {
        reasonId,
        reasonText: reasonText.trim() || null,
        orderId: order.id,
        expectedVersion: order.version,
      }),
    onSuccess: (out) => {
      if (out?.mode === 'via_till') {
        setRemote({ commandId: out.commandId, startedAt: Date.now(), timeoutSeconds: out.timeoutSeconds });
        return;
      }
      if (out?.voidTicketsError || out?.kdsError) toast.warning(tt('voidTicket.notQueued'));
      else if (out?.voidTickets?.length) toast.success(tt('cancelledWithVoid'));
      else toast.success(tt('cancelledToast'));
      onDone();
    },
    onError: (err) => {
      const code = tablesErrorCode(err);
      const detail = tablesErrorDetail(err);
      if (code === 'table_in_use') toast.error(t('result.refused.table_in_use', { till: String(detail?.till ?? '?') }));
      else toast.error(code && tt.has(`errors.${code}`) ? tt(`errors.${code}`) : axiosErrorToToastMessage(err, t('error')));
      if (code === 'order_changed' || code === 'table_order_not_open') onDone();
    },
  });
  if (remoteView) {
    return (
      <div className="space-y-2">
        <div className={`flex items-center gap-2 rounded border p-2 ${remoteView.phase === 'done' ? 'border-green-600 text-green-700' : ''}`}>
          {stillSending(remoteView) ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : null}
          <span>{tt(`remoteCancel.${remoteView.key}`, remoteView.values)}</span>
        </div>
        <PanelFoot busy={false} onBack={stillSending(remoteView) ? onBack : onDone} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {card.cancel?.mode === 'via_till' ? tt('remoteCancel.viaTillHint', { host: card.cancel.hostName ?? '?' }) : tt('cancelStuckHint')}
      </p>
      <div className="flex flex-wrap gap-1">
        {reasons.map((r) => (
          <Button key={r.id} size="sm" variant={reasonId === r.id ? 'default' : 'outline'} onClick={() => setReasonId(r.id)}>
            {r.name}
          </Button>
        ))}
      </div>
      <div className="space-y-1">
        <Label>{tt('reasonText')}</Label>
        <Input value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
      </div>
      <PanelFoot
        busy={cancel.isPending}
        onBack={onBack}
        disabled={!reasonId || (reason?.requiresNote === true && !reasonText.trim())}
        onConfirm={() => cancel.mutate()}
        confirmLabel={tt('cancelTable')}
      />
    </div>
  );
}

// ── The order ─────────────────────────────────────────────────────────────────

function lineStateText(t: ReturnType<typeof useTranslations>, l: CardLine): string {
  if (l.silent) return t('lineState.silent');
  if (l.state === 'sent') return l.sentAt ? t('lineState.sent', { at: formatTime(l.sentAt) }) : t('lineState.sentNoTime');
  if (l.state === 'partly_sent') return t('lineState.partly_sent', { sent: formatQuantity(l.sentQuantity), qty: formatQuantity(l.quantity) });
  if (l.state === 'held') return l.courseHeld ? t('lineState.paused') : t('lineState.held');
  return t('lineState.waiting');
}

function Lines({ card }: { card: TableCard }) {
  const t = useTranslations('tables.card');
  if (!card.order?.hasCart) return null;
  const groups = groupLines(card.lines ?? []);
  return (
    <section className="space-y-2">
      <h3 className="font-semibold">{t('lines')}</h3>
      {groups.length === 0 ? <p className="text-xs text-muted-foreground">{t('noLines')}</p> : null}
      {groups.map((g) => (
        <div key={g.seat ?? 'table'} className="rounded-lg border">
          <div className="border-b bg-muted/40 px-2 py-1 text-xs font-medium">
            {g.seat === null ? t('forTable') : g.seatName ? t('seatNamed', { seat: g.seat, name: g.seatName }) : t('seat', { seat: g.seat })}
          </div>
          {g.courses.map((c) => (
            <div key={c.course?.id ?? 'none'} className="px-2 py-1">
              {c.course ? <div className="text-[11px] font-medium text-muted-foreground">{c.course.name}</div> : null}
              <ul className="space-y-1">
                {c.lines.map((l) => (
                  <li key={l.id} className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div>
                        <span className="tabular-nums">{formatQuantity(l.quantity)}</span> × {l.name}
                      </div>
                      {[...l.mods, ...l.removals].length || l.notes ? (
                        <div className="text-[11px] text-muted-foreground">
                          {[...l.mods, ...l.removals, l.notes].filter(Boolean).join(' · ')}
                        </div>
                      ) : null}
                      <div className={`text-[11px] ${l.state === 'sent' ? 'text-green-700 dark:text-green-400' : 'text-orange-700 dark:text-orange-400'}`}>
                        {lineStateText(t, l)}
                        {l.rounds.length ? ` · ${t('rounds', { rounds: l.rounds.join(', ') })}` : ''}
                      </div>
                    </div>
                    <span className="shrink-0 tabular-nums">{formatCurrency(l.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function Payments({ card }: { card: TableCard }) {
  const t = useTranslations('tables.card');
  const p = card.payments;
  return (
    <section className="space-y-1">
      <h3 className="font-semibold">{t('payments')}</h3>
      {p && (p.partials.length > 0 || p.reversals.length > 0) ? (
        <ul className="space-y-0.5 text-xs">
          {p.partials.map((x, i) => (
            <li key={`p${i}`} className="flex justify-between">
              <span>{t('partial', { number: x.number ?? '—' })}</span>
              <span className="tabular-nums">{formatCurrency(x.amount)}</span>
            </li>
          ))}
          {p.reversals.map((x, i) => (
            <li key={`r${i}`} className="flex justify-between text-destructive">
              <span>{t('reversal', { number: x.creditNumber ?? '—' })}</span>
              <span className="tabular-nums">−{formatCurrency(x.amount)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t('noPayments')}</p>
      )}
      <div className="flex justify-between border-t pt-1 font-semibold">
        <span>{t('balance')}</span>
        <span className="tabular-nums">{formatCurrency(card.balance ?? card.order?.total ?? 0)}</span>
      </div>
    </section>
  );
}

function History({ card }: { card: TableCard }) {
  const t = useTranslations('tables.card');
  const items = card.history ?? [];
  return (
    <section className="space-y-1">
      <h3 className="font-semibold">{t('history')}</h3>
      {items.length === 0 ? <p className="text-xs text-muted-foreground">{t('historyEmpty')}</p> : null}
      <ul className="space-y-0.5 text-xs">
        {items.map((h, i) => {
          const what =
            h.source === 'command'
              ? t('command', {
                  action: t.has(`actions.${h.action}`) ? t(`actions.${h.action}`) : String(h.action),
                  host: h.hostName ?? '?',
                  outcome: t.has(`outcome.${h.outcome}`) ? t(`outcome.${h.outcome}`) : String(h.outcome),
                })
              : t.has(`event.${h.kind}`)
                ? t(`event.${h.kind}`, { detail: eventDetail(h.details) })
                : h.kind;
          return (
            <li key={i} className="flex gap-2">
              <span className="shrink-0 tabular-nums text-muted-foreground">{h.at ? formatTime(h.at) : '—'}</span>
              <span className="min-w-0">
                {what}
                {h.by ? <span className="text-muted-foreground"> · {h.by}</span> : null}
                {h.fromDashboard ? <span className="text-muted-foreground"> · {t('fromDashboard')}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The words an event's details add ("עיקריות", "לשולחן 14", the note). */
function eventDetail(details: Record<string, unknown> | undefined): string {
  if (!details) return '';
  const d = details;
  const pick = d.courseName ?? d.toName ?? d.text ?? (d.toNumber !== undefined ? `${d.fromNumber ?? ''} → ${d.toNumber}` : null) ?? d.reason ?? null;
  return pick === null || pick === undefined ? '' : String(pick);
}
