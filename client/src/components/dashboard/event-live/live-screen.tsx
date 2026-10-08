'use client';

/**
 * "מצב אירוע חי" — the event's big screen, for a manager or a producer during the event: dark,
 * high contrast, readable across a hall, one column on a phone and a 12-column wall on a TV.
 *
 * Data: `GET /report-events/{id}/live` (lib/eventLiveApi.ts), refreshed every 15 s while live
 * (every minute with Ably push connected, which also refetches on every till sync), slower
 * before and after. The screen stays awake (Wake Lock) and can go full screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ArrowRight,
  ChefHat,
  Expand,
  Minimize,
  Pencil,
  Radio,
  Receipt,
  Target,
  Ticket,
  TrendingUp,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  ablySseUrl,
  bigMoney,
  chartRows,
  compactMoney,
  kdsTone,
  liveRefetchMs,
  minutesText,
  orderTills,
  paceTone,
  parseTargetInput,
  progressFill,
  type EventLive,
  type LiveBucket,
  type Tone,
} from '@/lib/eventLive';
import { fetchEventLive, fetchLivePush, saveLiveTarget } from '@/lib/eventLiveApi';
import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';

// ── Look ─────────────────────────────────────────────────────────────────────

const C = {
  page: '#05070D',
  card: '#0D1322',
  line: '#1E2A44',
  ink: '#F5F7FC',
  muted: '#A3AFC7',
  blue: '#4C9AFF',
  green: '#2EE07A',
  amber: '#FFB020',
  red: '#FF4D4D',
};

const TONE: Record<Tone, string> = { good: C.green, warn: C.amber, bad: C.red, neutral: C.ink };

const TICK_MIN_MS = 10_000;

/** Over the whole dashboard shell (sidebar and bars included): the screen is the page. */
const OVERLAY = 'fixed inset-0 z-40 overflow-y-auto overscroll-contain';

function Panel({ children, className, title, icon }: { children: React.ReactNode; className?: string; title?: string; icon?: React.ReactNode }) {
  return (
    <section
      className={cn('flex min-w-0 flex-col rounded-3xl border p-4 md:p-5 2xl:p-7', className)}
      style={{ background: C.card, borderColor: C.line }}
    >
      {title ? (
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold uppercase tracking-wide md:text-lg 2xl:text-2xl" style={{ color: C.muted }}>
          {icon}
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}

function Stat({ label, value, sub, tone = 'neutral' }: { label: string; value: string; sub?: string | null; tone?: Tone }) {
  return (
    <div className="min-w-0">
      <div className="text-sm md:text-base 2xl:text-xl" style={{ color: C.muted }}>{label}</div>
      <div className="truncate font-bold tabular-nums leading-tight text-[clamp(1.75rem,3.6vw,4.5rem)]" style={{ color: TONE[tone] }}>
        {value}
      </div>
      {sub ? <div className="text-sm tabular-nums md:text-base 2xl:text-lg" style={{ color: C.muted }}>{sub}</div> : null}
    </div>
  );
}

// ── Behaviour ────────────────────────────────────────────────────────────────

/** Keeps a TV / phone awake while the screen is shown (best effort). */
function useWakeLock() {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    let cancelled = false;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    const request = () => {
      if (!nav.wakeLock || document.visibilityState !== 'visible') return;
      nav.wakeLock
        .request('screen')
        .then((l) => {
          if (cancelled) void l.release();
          else lock = l;
        })
        .catch(() => {});
    };
    request();
    document.addEventListener('visibilitychange', request);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', request);
      void lock?.release().catch(() => {});
    };
  }, []);
}

/** Ably push when the server offers it: every message refetches the screen. Returns whether connected. */
function useLivePush(eventId: string, onTick: () => void): boolean {
  const [connected, setConnected] = useState(false);
  const tick = useRef(onTick);
  const lastTick = useRef(0);
  useEffect(() => {
    tick.current = onTick;
  }, [onTick]);
  useEffect(() => {
    let source: EventSource | null = null;
    let retry: number | undefined;
    let stopped = false;
    const connect = async () => {
      try {
        const info = await fetchLivePush(eventId);
        if (stopped || !info.enabled || !info.token || typeof EventSource === 'undefined') return;
        source = new EventSource(ablySseUrl(info.channel, info.token));
        source.onopen = () => setConnected(true);
        source.onmessage = () => {
          // A busy event's tills sync all the time: at most one refetch every 10 seconds.
          const now = Date.now();
          if (now - lastTick.current >= TICK_MIN_MS) {
            lastTick.current = now;
            tick.current();
          }
        };
        source.onerror = () => {
          setConnected(false);
          source?.close();
          source = null;
          // A new token (they last an hour) and a new connection in a minute; polling covers the gap.
          if (!stopped) retry = window.setTimeout(connect, 60_000);
        };
      } catch {
        // No push: the screen polls.
      }
    };
    void connect();
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      source?.close();
    };
  }, [eventId]);
  return connected;
}

function useFullscreen(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);
  return [on, toggle];
}

// ── Parts ────────────────────────────────────────────────────────────────────

function TargetPanel({ live, onEdit }: { live: EventLive; onEdit: (() => void) | null }) {
  const t = useTranslations('eventLive');
  const target = live.target;
  const tone = paceTone(live);
  return (
    <Panel className="md:col-span-2 xl:col-span-5" title={t('total')} icon={<Target className="size-5 2xl:size-7" aria-hidden />}>
      <div className="font-black tabular-nums leading-none text-[clamp(3rem,8vw,9rem)]" style={{ color: C.ink }}>
        {bigMoney(live.totals.net)}
      </div>
      {target ? (
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-lg md:text-xl 2xl:text-3xl">
            <span style={{ color: C.muted }}>
              {t('target')} <b className="tabular-nums" style={{ color: C.ink }}>{bigMoney(target.amount)}</b>
            </span>
            <span className="font-bold tabular-nums" style={{ color: TONE[tone] }}>
              {target.progressPct !== null ? `${Math.round(target.progressPct)}%` : '—'}
            </span>
          </div>
          <div
            className="h-5 w-full overflow-hidden rounded-full md:h-6 2xl:h-9"
            style={{ background: C.line }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progressFill(target.progressPct))}
            aria-label={t('progress')}
          >
            <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${progressFill(target.progressPct)}%`, background: TONE[tone] === C.ink ? C.blue : TONE[tone] }} />
          </div>
          <div className="text-base md:text-lg 2xl:text-2xl" style={{ color: C.muted }}>
            {target.reached
              ? t('targetReached')
              : live.phase === 'live'
                ? target.etaAt
                  ? t('targetEta', { time: formatTime(target.etaAt, { timeZone: live.event.timezone }), left: bigMoney(target.remaining) })
                  : t('targetNoPace', { left: bigMoney(target.remaining) })
                : t('targetLeft', { left: bigMoney(target.remaining) })}
            {target.source === 'targets' ? ` · ${t('targetFromTargets')}` : ''}
          </div>
        </div>
      ) : (
        <p className="mt-4 text-lg 2xl:text-2xl" style={{ color: C.muted }}>{t('noTarget')}</p>
      )}
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          className="mt-3 inline-flex min-h-11 w-fit items-center gap-2 rounded-full border px-4 text-base outline-none focus-visible:ring-2"
          style={{ borderColor: C.line, color: C.ink }}
        >
          <Pencil className="size-4" aria-hidden />
          {target?.source === 'targets' ? t('editTargetOverride') : target ? t('editTarget') : t('setTarget')}
        </button>
      ) : null}
    </Panel>
  );
}

function PacePanel({ live }: { live: EventLive }) {
  const t = useTranslations('eventLive');
  const tone = paceTone(live);
  const pace = live.pace;
  return (
    <Panel className="xl:col-span-3" title={t('pace')} icon={<TrendingUp className="size-5 2xl:size-7" aria-hidden />}>
      {live.phase === 'upcoming' ? (
        <Stat label={t('startsIn')} value={minutesText(live.startsInMinutes)} />
      ) : (
        <div className="space-y-3">
          <Stat
            label={live.phase === 'live' ? t('projected') : t('final')}
            value={bigMoney(live.phase === 'live' ? pace.projected : live.totals.net)}
            sub={live.phase === 'live' && pace.low !== null && pace.high !== null ? t('band', { low: bigMoney(pace.low), high: bigMoney(pace.high) }) : null}
            tone={tone}
          />
          <div className="text-base md:text-lg 2xl:text-2xl" style={{ color: C.muted }}>
            {live.phase === 'live'
              ? t('perHour', { rate: bigMoney(pace.recentRatePerHour), avg: bigMoney(pace.averageRatePerHour) })
              : t('endedAt', { time: formatTime(live.event.endsAt, { timeZone: live.event.timezone }) })}
          </div>
          {live.phase === 'live' ? (
            <div className="text-base md:text-lg 2xl:text-2xl" style={{ color: C.muted }}>
              {t('remaining', { time: minutesText(live.remainingMinutes) })}
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function TicketPanel({ live }: { live: EventLive }) {
  const t = useTranslations('eventLive');
  return (
    <Panel className="xl:col-span-2" title={t('documents')} icon={<Receipt className="size-5 2xl:size-7" aria-hidden />}>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-1">
        <Stat label={t('avgTicket')} value={bigMoney(live.totals.avgTicket)} sub={t('sales', { n: live.totals.sales })} />
        <Stat
          label={t('docsPerHour')}
          value={live.totals.docsPerHour !== null ? String(Math.round(live.totals.docsPerHour)) : '—'}
          sub={t('lastHourDocs', { n: live.totals.docsLastHour })}
        />
      </div>
    </Panel>
  );
}

function VouchersPanel({ live }: { live: EventLive }) {
  const t = useTranslations('eventLive');
  const v = live.vouchers;
  return (
    <Panel className="xl:col-span-2" title={t('vouchers')} icon={<Ticket className="size-5 2xl:size-7" aria-hidden />}>
      <Stat label={t('vouchersRedeemed')} value={String(v.redemptions)} sub={t('vouchersLastHour', { n: v.lastHour })} />
      {v.byBatch.length ? (
        <ul className="mt-3 space-y-1 text-base 2xl:text-xl">
          {v.byBatch.slice(0, 3).map((b) => (
            <li key={b.batchId} className="flex justify-between gap-2">
              <span className="truncate" style={{ color: C.muted }}>{b.name}</span>
              <span className="tabular-nums font-semibold" style={{ color: C.ink }}>{b.redemptions}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

function ChartPanel({ live, bucket, onBucket }: { live: EventLive; bucket: LiveBucket; onBucket: (b: LiveBucket) => void }) {
  const t = useTranslations('eventLive');
  const rows = chartRows(live.series, live.event.timezone);
  return (
    <Panel className="min-h-[18rem] md:col-span-2 xl:col-span-8">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold uppercase tracking-wide md:text-lg 2xl:text-2xl" style={{ color: C.muted }}>
          {t('chartTitle', { minutes: bucket })}
        </h2>
        <div className="flex gap-1 rounded-full border p-1" style={{ borderColor: C.line }} role="group" aria-label={t('bucket')}>
          {([1, 5] as LiveBucket[]).map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={bucket === b}
              onClick={() => onBucket(b)}
              className="min-h-10 min-w-16 rounded-full px-3 text-base font-semibold"
              style={bucket === b ? { background: C.blue, color: '#04101F' } : { color: C.muted }}
            >
              {t('minutes', { n: b })}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="flex flex-1 items-center justify-center text-xl" style={{ color: C.muted }}>{t('noSalesYet')}</p>
      ) : (
        <div className="h-64 flex-1 md:h-80 2xl:h-[28rem]" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid stroke={C.line} vertical={false} />
              <XAxis dataKey="label" tick={{ fill: C.muted, fontSize: 14 }} tickLine={false} axisLine={{ stroke: C.line }} minTickGap={24} />
              <YAxis yAxisId="net" tick={{ fill: C.muted, fontSize: 14 }} tickFormatter={compactMoney} width={64} axisLine={false} tickLine={false} />
              <YAxis yAxisId="sum" orientation="right" tick={{ fill: C.muted, fontSize: 14 }} tickFormatter={compactMoney} width={64} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, color: C.ink, direction: 'rtl', fontSize: 16 }}
                formatter={(value, name) => [bigMoney(Number(value)), name === 'net' ? t('netPerBucket') : t('runningTotal')]}
              />
              <Bar yAxisId="net" dataKey="net" fill={C.blue} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              <Line yAxisId="sum" dataKey="cumulative" stroke={C.green} strokeWidth={3} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}

function ItemsPanel({ live }: { live: EventLive }) {
  const t = useTranslations('eventLive');
  const [scope, setScope] = useState<'lastHour' | 'event'>('lastHour');
  const rows = live.items[scope];
  return (
    <Panel className="xl:col-span-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold uppercase tracking-wide md:text-lg 2xl:text-2xl" style={{ color: C.muted }}>{t('topItems')}</h2>
        <div className="flex gap-1 rounded-full border p-1" style={{ borderColor: C.line }} role="group" aria-label={t('topItems')}>
          {(['lastHour', 'event'] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={scope === s}
              onClick={() => setScope(s)}
              className="min-h-10 rounded-full px-3 text-sm font-semibold md:text-base"
              style={scope === s ? { background: C.blue, color: '#04101F' } : { color: C.muted }}
            >
              {t(s === 'lastHour' ? 'itemsLastHour' : 'itemsEvent')}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-lg" style={{ color: C.muted }}>{t('noItems')}</p>
      ) : (
        <ol className="space-y-2">
          {rows.map((r, i) => (
            <li key={r.key} className="flex items-center gap-3 text-lg md:text-xl 2xl:text-3xl">
              <span className="w-8 shrink-0 text-center font-bold tabular-nums" style={{ color: i < 3 ? C.amber : C.muted }}>{i + 1}</span>
              <span className="min-w-0 flex-1 truncate" style={{ color: C.ink }}>{r.name}</span>
              <span className="font-bold tabular-nums" style={{ color: C.ink }}>{Math.round(r.quantity * 10) / 10}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function TillsPanel({ live }: { live: EventLive }) {
  const t = useTranslations('eventLive');
  const tills = orderTills(live.tills);
  const offline = tills.filter((x) => !x.online).length;
  return (
    <Panel className="md:col-span-2 xl:col-span-8">
      <h2 className="mb-3 flex flex-wrap items-center gap-3 text-base font-semibold uppercase tracking-wide md:text-lg 2xl:text-2xl" style={{ color: C.muted }}>
        {t('tills')}
        <span className="rounded-full px-3 py-0.5 text-sm normal-case md:text-base" style={{ background: offline ? C.red : C.line, color: offline ? '#1A0000' : C.ink }}>
          {offline ? t('offlineCount', { n: offline }) : t('allOnline')}
        </span>
      </h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
        {tills.map((till) => (
          <li key={till.machineId} className="rounded-2xl border p-3 2xl:p-4" style={{ borderColor: till.online ? C.line : C.red }}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-lg font-semibold md:text-xl 2xl:text-2xl" style={{ color: C.ink }}>{till.name}</span>
              <span className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold md:text-base" style={{ color: till.online ? C.green : C.red }}>
                {till.online ? <Wifi className="size-4" aria-hidden /> : <WifiOff className="size-4" aria-hidden />}
                {till.online ? t('online') : t('offline')}
              </span>
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="text-2xl font-bold tabular-nums md:text-3xl 2xl:text-4xl" style={{ color: C.ink }}>{bigMoney(till.net)}</span>
              <span className="text-sm tabular-nums md:text-base" style={{ color: C.muted }}>
                {t('tillDocs', { n: till.docs })}
                {till.lastSaleAt ? ` · ${formatTime(till.lastSaleAt, { timeZone: live.event.timezone })}` : ''}
              </span>
            </div>
            {!till.online && till.lastSeenAt ? (
              <div className="mt-1 text-sm" style={{ color: C.red }}>{t('lastSeen', { time: formatTime(till.lastSeenAt, { timeZone: live.event.timezone }) })}</div>
            ) : null}
            {till.pendingDocuments ? (
              <div className="mt-1 text-sm" style={{ color: C.amber }}>{t('pendingDocs', { n: till.pendingDocuments })}</div>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function KitchenPanel({ live }: { live: EventLive }) {
  const t = useTranslations('eventLive');
  const kds = live.kds;
  if (!kds) {
    return (
      <Panel className="xl:col-span-4" title={t('kitchen')} icon={<ChefHat className="size-5 2xl:size-7" aria-hidden />}>
        <p className="text-lg" style={{ color: C.muted }}>{t('noKds')}</p>
      </Panel>
    );
  }
  const tone = kdsTone(kds);
  return (
    <Panel className="xl:col-span-4" title={t('kitchen')} icon={<ChefHat className="size-5 2xl:size-7" aria-hidden />}>
      <div className="grid grid-cols-2 gap-4">
        <Stat label={t('kdsWaiting')} value={String(kds.openOrders)} sub={kds.lateOrders ? t('kdsLate', { n: kds.lateOrders, minutes: kds.lateMinutes }) : null} tone={kds.lateOrders ? 'bad' : 'neutral'} />
        <Stat label={t('kdsOldest')} value={kds.oldestWaitMinutes !== null ? minutesText(kds.oldestWaitMinutes) : '—'} tone={tone} />
        <Stat label={t('kdsAvgWait')} value={kds.avgWaitMinutes !== null ? minutesText(kds.avgWaitMinutes) : '—'} />
        <Stat
          label={t('kdsPrep')}
          value={kds.avgPrepMinutesLastHour !== null ? minutesText(kds.avgPrepMinutesLastHour) : '—'}
          sub={t('kdsReady', { n: kds.readyLastHour })}
        />
      </div>
    </Panel>
  );
}

function TargetEditor({ live, onClose, onSaved }: { live: EventLive; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('eventLive');
  const [text, setText] = useState(live.target?.source === 'event' ? String(live.target.amount) : '');
  const [saving, setSaving] = useState(false);
  const parsed = parseTargetInput(text);
  const save = async (value: number | null) => {
    setSaving(true);
    try {
      await saveLiveTarget(live.event.id, value);
      onSaved();
      onClose();
    } catch {
      toast.error(t('targetSaveFailed'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label={t('setTarget')}>
      <form
        className="w-full max-w-md space-y-4 rounded-3xl border p-5"
        style={{ background: C.card, borderColor: C.line, color: C.ink }}
        onSubmit={(e) => {
          e.preventDefault();
          if (parsed !== undefined) void save(parsed);
        }}
      >
        <h2 className="text-xl font-bold">{t('setTarget')}</h2>
        <p className="text-sm" style={{ color: C.muted }}>{t('targetHint')}</p>
        <input
          autoFocus
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="₪"
          aria-invalid={parsed === undefined}
          className="h-14 w-full rounded-2xl border bg-transparent px-4 text-2xl tabular-nums outline-none focus-visible:ring-2"
          style={{ borderColor: parsed === undefined ? C.red : C.line }}
        />
        {parsed === undefined ? <p className="text-sm" style={{ color: C.red }}>{t('targetInvalid')}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          {live.target?.source === 'event' ? (
            <button type="button" disabled={saving} onClick={() => void save(null)} className="min-h-11 rounded-full px-4" style={{ color: C.red }}>
              {t('clearTarget')}
            </button>
          ) : null}
          <button type="button" onClick={onClose} className="min-h-11 rounded-full border px-4" style={{ borderColor: C.line }}>
            {t('cancel')}
          </button>
          <button type="submit" disabled={saving || parsed === undefined} className="min-h-11 rounded-full px-5 font-semibold disabled:opacity-50" style={{ background: C.blue, color: '#04101F' }}>
            {t('save')}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── The screen ───────────────────────────────────────────────────────────────

/** A way back: a link (the page route) or a callback (opened in place by `LiveEventLauncher`). */
function BackControl({ backHref, onClose, className, style, children, label }: {
  backHref?: string;
  onClose?: () => void;
  className: string;
  style: React.CSSProperties;
  children: React.ReactNode;
  label?: string;
}) {
  if (onClose) {
    return (
      <button type="button" onClick={onClose} aria-label={label} className={className} style={style}>
        {children}
      </button>
    );
  }
  return (
    <Link href={backHref ?? '/dashboard'} aria-label={label} className={className} style={style}>
      {children}
    </Link>
  );
}

export function LiveScreen({ eventId, backHref, onClose }: { eventId: string; backHref?: string; onClose?: () => void }) {
  const t = useTranslations('eventLive');
  const queryClient = useQueryClient();
  const [bucket, setBucket] = useState<LiveBucket>(5);
  const [editing, setEditing] = useState(false);
  const [fullscreen, toggleFullscreen] = useFullscreen();
  useWakeLock();
  const refetchNow = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['event-live', eventId] });
  }, [queryClient, eventId]);
  const pushConnected = useLivePush(eventId, refetchNow);

  const query = useQuery<EventLive>({
    queryKey: ['event-live', eventId, bucket],
    queryFn: () => fetchEventLive(eventId, bucket),
    refetchInterval: (q) => liveRefetchMs(q.state.data?.phase, pushConnected),
  });
  const live = query.data;

  if (query.isError && !live) {
    return (
      <div className={cn(OVERLAY, "flex flex-col items-center justify-center gap-4 p-6 text-center text-xl")} style={{ background: C.page, color: C.ink }}>
        <p>{t('loadError')}</p>
        <BackControl backHref={backHref} onClose={onClose} className="rounded-full border px-5 py-3 text-base" style={{ borderColor: C.line }}>{t('back')}</BackControl>
      </div>
    );
  }
  if (!live) {
    return <div className={cn(OVERLAY, "flex items-center justify-center text-2xl")} style={{ background: C.page, color: C.muted }}>{t("loading")}</div>;
  }

  const phaseLabel = t(`phase.${live.phase}`);
  const phaseColor = live.phase === 'live' ? C.red : live.phase === 'upcoming' ? C.amber : C.muted;

  return (
    <div className={cn(OVERLAY, "px-3 pb-6 pt-3 md:px-6 md:pt-5 2xl:px-10")} style={{ background: C.page, color: C.ink }}>
      <header className="mb-4 flex flex-wrap items-center gap-3 md:mb-6">
        <BackControl backHref={backHref} onClose={onClose} label={t('back')} className="flex size-11 items-center justify-center rounded-full border" style={{ borderColor: C.line }}>
          <ArrowRight className="size-5" aria-hidden />
        </BackControl>
        <div className="min-w-0 flex-1 basis-[calc(100%-4rem)] sm:basis-0">
          <h1 className="truncate text-2xl font-black md:text-4xl 2xl:text-6xl">{live.event.name}</h1>
          <p className="truncate text-base md:text-lg 2xl:text-2xl" style={{ color: C.muted }}>
            {[live.event.shopName, `${live.event.startTime}–${live.event.endTime}`, live.event.producerName].filter(Boolean).join(' · ')}
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-base font-bold md:text-xl 2xl:text-2xl" style={{ background: `${phaseColor}22`, color: phaseColor }}>
          {live.phase === 'live' ? <span className="size-3 animate-pulse rounded-full" style={{ background: C.red }} aria-hidden /> : null}
          {phaseLabel}
        </span>
        <span className="text-2xl font-bold tabular-nums md:text-4xl 2xl:text-5xl" aria-label={t('clock')}>
          {formatTime(live.now, { timeZone: live.event.timezone })}
        </span>
        <span className="inline-flex items-center gap-1 text-sm" style={{ color: pushConnected ? C.green : C.muted }} title={pushConnected ? t('pushOn') : t('polling')}>
          <Radio className="size-4" aria-hidden />
          <span className="hidden md:inline">{pushConnected ? t('pushOn') : t('polling')}</span>
        </span>
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={fullscreen ? t('exitFullscreen') : t('fullscreen')}
          className="hidden size-11 items-center justify-center rounded-full border sm:flex"
          style={{ borderColor: C.line }}
        >
          {fullscreen ? <Minimize className="size-5" aria-hidden /> : <Expand className="size-5" aria-hidden />}
        </button>
      </header>

      <main className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 xl:grid-cols-12 2xl:gap-6">
        <TargetPanel live={live} onEdit={live.canSetTarget ? () => setEditing(true) : null} />
        <PacePanel live={live} />
        <TicketPanel live={live} />
        <VouchersPanel live={live} />
        <ChartPanel live={live} bucket={bucket} onBucket={setBucket} />
        <ItemsPanel live={live} />
        <TillsPanel live={live} />
        <KitchenPanel live={live} />
      </main>

      {editing ? <TargetEditor live={live} onClose={() => setEditing(false)} onSaved={refetchNow} /> : null}
    </div>
  );
}
