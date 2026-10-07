'use client';

/**
 * Messages to tills (הודעות לקופות): write a message, send it to a company, shop,
 * point of sale or single till, and watch each till receive it and its employee
 * acknowledge it ("קראתי").
 *
 * A till shows the message full-screen until acknowledged; it fetches on the realtime
 * wake-up the send triggers, or on its 30 s heartbeat. Who it reaches is fixed when it
 * goes out: the active tills in the target this manager can see. Same roles as manage
 * tills (the machines admins); the server decides the scope.
 *
 * "מתי לשלוח": now, at a chosen time (מתוזמן), or on fixed weekdays at a fixed time
 * (קבוע). Times are the tenant's local time; the server sends scheduled ones when they
 * come due (lazily, on the tills' next fetch), and each recurring occurrence needs its
 * own "קראתי". A recurring message's list row shows its latest occurrence.
 *
 * "סוג תצוגה": full-screen (default) or a banner ("באנר מבצעים") — a slim coloured strip at
 * the top of the till's sell screen and tables floor, with an optional product whose chip
 * adds it to the order, a colour and an end ("עד מתי"). A banner that went out can still
 * change its text, product, colour and end.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import {
  Ban,
  CalendarClock,
  CheckCheck,
  ChevronDown,
  Megaphone,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Repeat,
  Send,
} from 'lucide-react';
import {
  cancelTillMessage,
  fetchTillMessages,
  pauseTillMessage,
  resendTillMessage,
  resumeTillMessage,
  sendTillMessage,
  updateTillMessage,
} from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDate, formatShortDateTime, isoDate } from '@/lib/format';
import type {
  TillMessage,
  TillMessageColor,
  TillMessageDisplay,
  TillMessageLevel,
  TillMessageReceipt,
  TillMessageScheduleKind,
  TillMessageUpdate,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { ProductListPicker } from '@/components/dashboard/promotions/group-picker';
import {
  EMPTY_ORG_SCOPE,
  deepestOrgScope,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';
import { ScopePicker, useOrgScopeLabel } from '@/components/dashboard/live/scope-picker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { DatePicker, DateTimePicker, TimeInput } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const REFRESH_MS = 15_000;
const BODY_MAX = 2000;
const TITLE_MAX = 200;
const DEFAULT_TZ = 'Asia/Jerusalem';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WORK_DAYS = [0, 1, 2, 3, 4];

type Expiry = 'none' | '1h' | '4h' | 'endOfDay' | 'custom';
const EXPIRIES: Expiry[] = ['none', '1h', '4h', 'endOfDay', 'custom'];
const WHEN: TillMessageScheduleKind[] = ['now', 'scheduled', 'recurring'];
/** Recurring: how long each occurrence is shown ('eod' = to the end of its day), in hours. */
const TTL_HOURS = ['eod', '1', '2', '4', '8', '12'];

const pad = (n: number) => String(n).padStart(2, '0');

/** A datetime-local value ("YYYY-MM-DDTHH:mm") for a Date, in the browser's zone. */
function localInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** An instant as "YYYY-MM-DDTHH:mm" wall time in `tz` (for editing in the tenant's zone). */
function inZone(iso: string | null | undefined, tz: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * The expiry to send. Sent now: an instant (ISO). Scheduled: relative to the send time,
 * as wall time without an offset — the server reads it in the tenant's zone.
 */
function expiryValue(choice: Expiry, custom: string, sendAtLocal: string | null): string | null {
  if (choice === 'none') return null;
  if (sendAtLocal) {
    const base = new Date(sendAtLocal);
    if (Number.isNaN(base.getTime())) return null;
    if (choice === '1h') return localInput(new Date(base.getTime() + 3_600_000));
    if (choice === '4h') return localInput(new Date(base.getTime() + 4 * 3_600_000));
    if (choice === 'endOfDay') return `${sendAtLocal.slice(0, 10)}T23:59`;
    return custom || null;
  }
  const now = new Date();
  if (choice === '1h') return new Date(now.getTime() + 3_600_000).toISOString();
  if (choice === '4h') return new Date(now.getTime() + 4 * 3_600_000).toISOString();
  if (choice === 'endOfDay') {
    const end = new Date(now);
    end.setHours(23, 59, 59, 0);
    return end.toISOString();
  }
  if (choice === 'custom' && custom) {
    const d = new Date(custom);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function time(iso: string | null | undefined): string {
  return isoDate(iso) ? formatShortDateTime(iso) : '';
}

/** dd/MM HH:mm in the message's zone (the tenant's), whatever the browser's. */
function zonedTime(iso: string | null | undefined, tz: string | null | undefined): string {
  return isoDate(iso) ? formatShortDateTime(iso, tz || DEFAULT_TZ) : '';
}

function shortDate(ymd: string | null | undefined): string {
  return ymd ? formatDate(ymd) : '';
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return DEFAULT_TZ;
  }
}

function useErrorText() {
  const t = useTranslations('tillMessages');
  const tb = useTranslations('specials.banner');
  const tc = useTranslations('common');
  return (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (typeof detail === 'string' && t.has(`errors.${detail}`)) return t(`errors.${detail}`);
    if (typeof detail === 'string' && tb.has(`errors.${detail}`)) return tb(`errors.${detail}`);
    return axiosErrorToToastMessage(err, tc('error'));
  };
}

// ── Banners ("באנר מבצעים") ──────────────────────────────────────────────────

const DISPLAYS: TillMessageDisplay[] = ['fullscreen', 'banner'];
const COLORS: TillMessageColor[] = ['amber', 'blue', 'green', 'red', 'purple', 'dark'];
/** The till's presets (pos-android domain/SpecialsBanner.kt), for the swatches and the preview. */
const COLOR_STYLE: Record<TillMessageColor, { bg: string; fg: string }> = {
  amber: { bg: '#FFC233', fg: '#2B1D00' },
  blue: { bg: '#0A6CFF', fg: '#FFFFFF' },
  green: { bg: '#1E9E4A', fg: '#FFFFFF' },
  red: { bg: '#E5322D', fg: '#FFFFFF' },
  purple: { bg: '#8E44D9', fg: '#FFFFFF' },
  dark: { bg: '#1C1C1E', fg: '#FFFFFF' },
};

const isBanner = (m: Pick<TillMessage, 'display'>) => m.display === 'banner';

/** "סוג תצוגה": full-screen until "קראתי", or the specials strip. */
function DisplayChoice({ value, onChange }: { value: TillMessageDisplay; onChange: (v: TillMessageDisplay) => void }) {
  const tb = useTranslations('specials.banner');
  return (
    <div className="space-y-2">
      <Label id="msg-display">{tb('display')}</Label>
      <div role="radiogroup" aria-labelledby="msg-display" className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        {DISPLAYS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={value === k}
            onClick={() => onChange(k)}
            className={cn(
              'flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors',
              value === k ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
            )}
          >
            {k === 'banner' ? <Megaphone className="h-4 w-4" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
            {tb(k)}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{value === 'banner' ? tb('bannerHint') : tb('fullscreenHint')}</p>
    </div>
  );
}

/** A banner's product, colour and a preview of the strip as the till draws it. */
function BannerFields({
  title,
  body,
  productId,
  onProduct,
  color,
  onColor,
}: {
  title: string;
  body: string;
  productId: string | null;
  onProduct: (id: string | null) => void;
  color: TillMessageColor;
  onColor: (c: TillMessageColor) => void;
}) {
  const tb = useTranslations('specials.banner');
  const style = COLOR_STYLE[color];
  const line = [title.trim(), body.trim()].filter(Boolean).join(' · ');
  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      <ProductListPicker
        label={tb('product')}
        value={productId ? [productId] : []}
        onChange={(ids) => onProduct(ids.length ? ids[ids.length - 1] : null)}
      />
      <p className="text-xs text-muted-foreground">{tb('productHint')}</p>
      <div className="space-y-1">
        <Label id="msg-color">{tb('color')}</Label>
        <div role="radiogroup" aria-labelledby="msg-color" className="flex flex-wrap gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={tb(`colors.${c}`)}
              title={tb(`colors.${c}`)}
              onClick={() => onColor(c)}
              className={cn(
                'h-11 w-11 rounded-full border-2 transition-transform',
                color === c ? 'scale-110 border-foreground' : 'border-transparent',
              )}
              style={{ backgroundColor: COLOR_STYLE[c].bg }}
            />
          ))}
        </div>
      </div>
      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">{tb('preview')}</span>
        <div
          className="flex min-h-10 items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold"
          style={{ backgroundColor: style.bg, color: style.fg }}
        >
          <span aria-hidden>📣</span>
          <span className="min-w-0 flex-1 truncate">{line || '…'}</span>
          {productId ? (
            <span className="shrink-0 rounded-full px-3 py-1 text-xs font-bold" style={{ backgroundColor: `${style.fg}2E` }}>
              +
            </span>
          ) : null}
          <span aria-hidden className="opacity-80">
            ✕
          </span>
        </div>
      </div>
    </div>
  );
}

const RECEIPT_STYLE: Record<TillMessageReceipt['status'], string> = {
  sent: 'border-muted-foreground/30 text-muted-foreground',
  delivered: 'border-sky-400/60 text-sky-800 dark:text-sky-300',
  acknowledged: 'border-emerald-400/60 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300',
};

const MESSAGE_STYLE: Record<TillMessage['status'], string> = {
  active: 'bg-primary/10 text-primary',
  expired: 'bg-muted text-muted-foreground',
  cancelled: 'bg-destructive/10 text-destructive',
  scheduled: 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  paused: 'bg-muted text-muted-foreground',
  ended: 'bg-muted text-muted-foreground',
};

// ── Recurrence fields (compose and edit) ─────────────────────────────────────

interface RecurrenceDraft {
  days: number[];
  time: string;
  startDate: string;
  endDate: string;
  ttl: string;
}

const EMPTY_RECURRENCE: RecurrenceDraft = { days: WORK_DAYS, time: '08:00', startDate: '', endDate: '', ttl: 'eod' };

function recurrenceBody(r: RecurrenceDraft) {
  return {
    recurDays: r.days,
    recurTime: r.time,
    recurStartDate: r.startDate || null,
    recurEndDate: r.endDate || null,
    occurrenceTtlMinutes: r.ttl === 'eod' ? null : Math.round(Number(r.ttl) * 60),
  };
}

function recurrenceValid(r: RecurrenceDraft): boolean {
  return r.days.length > 0 && /^\d{2}:\d{2}$/.test(r.time) && (!r.startDate || !r.endDate || r.endDate >= r.startDate);
}

function useDaysLabel() {
  const t = useTranslations('tillMessages');
  return (days: number[]) => {
    const sorted = [...days].sort();
    if (sorted.length === 7) return t('schedule.everyDay');
    if (sorted.join() === WORK_DAYS.join()) return t('schedule.weekdays');
    return sorted.map((d) => t(`weekdays.${d}`)).join(' ');
  };
}

function RecurrenceFields({
  value,
  onChange,
  idPrefix,
}: {
  value: RecurrenceDraft;
  onChange: (next: RecurrenceDraft) => void;
  idPrefix: string;
}) {
  const t = useTranslations('tillMessages');
  const set = (patch: Partial<RecurrenceDraft>) => onChange({ ...value, ...patch });
  const ttlOptions = TTL_HOURS.includes(value.ttl) ? TTL_HOURS : [...TTL_HOURS, value.ttl];
  const ttlLabel = (x: string) => (x === 'eod' ? t('schedule.ttlEndOfDay') : t('schedule.ttlHours', { count: Number(x) }));
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>{t('schedule.days')}</Label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('schedule.days')}>
          {ALL_DAYS.map((d) => {
            const on = value.days.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() => set({ days: on ? value.days.filter((x) => x !== d) : [...value.days, d].sort() })}
                className={cn(
                  'min-h-11 min-w-11 rounded-full border px-2 text-sm font-medium transition-colors',
                  on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-transparent text-foreground',
                )}
              >
                {t(`weekdays.${d}`)}
              </button>
            );
          })}
        </div>
        <div className="flex gap-3 text-xs">
          <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => set({ days: ALL_DAYS })}>
            {t('schedule.everyDay')}
          </button>
          <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => set({ days: WORK_DAYS })}>
            {t('schedule.weekdays')}
          </button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-time`}>{t('schedule.time')}</Label>
          <TimeInput
            id={`${idPrefix}-time`}
            required
            value={value.time}
            onChange={(e) => set({ time: e.target.value })}
            className="h-11"
          />
        </div>
        <div className="space-y-1">
          <Label>{t('schedule.ttl')}</Label>
          <Select
            value={value.ttl}
            onValueChange={(v) => v && set({ ttl: v as string })}
            items={ttlOptions.map((x) => ({ value: x, label: ttlLabel(x) }))}
          >
            <SelectTrigger className="h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ttlOptions.map((x) => (
                <SelectItem key={x} value={x} label={ttlLabel(x)}>
                  {ttlLabel(x)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-start`}>{t('schedule.startDate')}</Label>
          <DatePicker
            id={`${idPrefix}-start`}
            value={value.startDate}
            onChange={(e) => set({ startDate: e.target.value })}
            className="h-11"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-end`}>{t('schedule.endDate')}</Label>
          <DatePicker
            id={`${idPrefix}-end`}
            value={value.endDate}
            min={value.startDate || undefined}
            onChange={(e) => set({ endDate: e.target.value })}
            className="h-11"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('schedule.ttlHint')}</p>
    </div>
  );
}

// ── The list ─────────────────────────────────────────────────────────────────

function ReceiptRow({ r, banner = false }: { r: TillMessageReceipt; banner?: boolean }) {
  const t = useTranslations('tillMessages');
  const tb = useTranslations('specials.banner');
  const where = [r.shopName, r.areaName].filter(Boolean).join(' › ');
  // A banner is not acknowledged: "הוצג" once the till has it, "הוסתר ע״י" once closed there.
  const label =
    banner && r.status === 'acknowledged'
      ? tb('hiddenBy', { name: r.acknowledgedByName || t('receipt.unknownUser'), at: time(r.acknowledgedAt) })
      : banner && r.status === 'delivered'
        ? tb('seen')
        : null;
  return (
    <li className="flex min-h-11 items-center gap-2 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          {r.machineName}
          {r.posNumber ? <span className="ms-1 text-xs text-muted-foreground">({t('register', { n: r.posNumber })})</span> : null}
        </p>
        {where ? <p className="truncate text-xs text-muted-foreground">{where}</p> : null}
      </div>
      <span
        className={cn('inline-flex shrink-0 items-center rounded border px-1.5 py-1 text-[11px] leading-tight', RECEIPT_STYLE[r.status])}
        title={r.deliveredAt ? t('receipt.deliveredAt', { at: time(r.deliveredAt) }) : undefined}
      >
        {label ??
          (r.status === 'acknowledged'
            ? t('receipt.acknowledgedBy', {
                name: r.acknowledgedByName || t('receipt.unknownUser'),
                at: time(r.acknowledgedAt),
              })
            : t(`receipt.${r.status}`))}
      </span>
    </li>
  );
}

function ScheduleLine({ m }: { m: TillMessage }) {
  const t = useTranslations('tillMessages');
  const daysLabel = useDaysLabel();
  const tz = m.timezone || DEFAULT_TZ;
  if (m.scheduleKind === 'scheduled' && m.status === 'scheduled') {
    return (
      <p className="flex items-center gap-1.5 text-xs font-medium text-amber-900 dark:text-amber-300">
        <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {t('schedule.scheduledFor', { at: zonedTime(m.sendAt, tz) })}
      </p>
    );
  }
  if (m.scheduleKind !== 'recurring' || !m.recurrence) return null;
  const r = m.recurrence;
  const range =
    r.startDate && r.endDate
      ? t('schedule.range', { from: shortDate(r.startDate), to: shortDate(r.endDate) })
      : r.startDate
        ? t('schedule.from', { from: shortDate(r.startDate) })
        : r.endDate
          ? t('schedule.until', { to: shortDate(r.endDate) })
          : '';
  return (
    <div className="space-y-0.5 text-xs">
      <p className="flex items-center gap-1.5 font-medium">
        <Repeat className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span>
          {t('schedule.recurringSummary', { days: daysLabel(r.days), time: r.time })}
          {range ? ` · ${range}` : ''}
        </span>
      </p>
      <p className="text-muted-foreground">
        {m.status === 'cancelled' || m.status === 'paused'
          ? null
          : m.nextOccurrenceAt
            ? t('schedule.next', { at: zonedTime(m.nextOccurrenceAt, tz) })
            : t('schedule.noNext')}
        {m.status !== 'cancelled' && m.status !== 'paused' ? ' · ' : ''}
        {m.occurrence ? t('schedule.occurrence', { at: zonedTime(m.occurrence.startsAt, tz) }) : t('schedule.occurrenceNone')}
      </p>
    </div>
  );
}

function EditPanel({ m, onDone }: { m: TillMessage; onDone: () => void }) {
  const t = useTranslations('tillMessages');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const tz = m.timezone || DEFAULT_TZ;
  const [title, setTitle] = useState(m.title ?? '');
  const [body, setBody] = useState(m.body);
  const [sendAt, setSendAt] = useState(inZone(m.sendAt, tz));
  const [rec, setRec] = useState<RecurrenceDraft>(() => {
    const r = m.recurrence;
    if (!r) return EMPTY_RECURRENCE;
    return {
      days: r.days,
      time: r.time,
      startDate: r.startDate ?? '',
      endDate: r.endDate ?? '',
      ttl: r.occurrenceTtlMinutes ? String(r.occurrenceTtlMinutes / 60) : 'eod',
    };
  });
  const recurring = m.scheduleKind === 'recurring';
  // A message that went out (now, or scheduled and sent): only a banner gets here — its
  // text, product, colour and end change; never when or how it went out.
  const sent = (m.scheduleKind ?? 'now') === 'now' || (m.scheduleKind === 'scheduled' && !!m.sentAt);
  const [display, setDisplay] = useState<TillMessageDisplay>(m.display ?? 'fullscreen');
  const [productId, setProductId] = useState<string | null>(m.productId ?? null);
  const [color, setColor] = useState<TillMessageColor>(m.color ?? 'amber');
  const [until, setUntil] = useState(inZone(m.expiresAt, tz));
  const banner = display === 'banner';
  const tb = useTranslations('specials.banner');
  const valid = body.trim().length > 0 && (sent || (recurring ? recurrenceValid(rec) : !!sendAt));

  const save = useMutation({
    mutationFn: () => {
      const patch: TillMessageUpdate = { title: title.trim() || null, body: body.trim() };
      if (!sent) Object.assign(patch, recurring ? recurrenceBody(rec) : { sendAt });
      if (!sent) patch.display = display;
      if (banner) Object.assign(patch, { productId, color });
      // "עד מתי": wall time in the tenant's zone; empty — until cancelled. Not per occurrence.
      if (banner && !recurring && until !== inZone(m.expiresAt, tz)) patch.expiresAt = until || null;
      return updateTillMessage(m.id, patch);
    },
    onSuccess: () => {
      toast.success(t('schedule.saved'));
      void qc.invalidateQueries({ queryKey: ['till-messages'] });
      onDone();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  return (
    <form
      className="space-y-3 border-t bg-muted/30 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !save.isPending) save.mutate();
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={`edit-title-${m.id}`}>{t('compose.titleLabel')}</Label>
        <Input
          id={`edit-title-${m.id}`}
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          className="h-11 text-base"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`edit-body-${m.id}`}>{t('compose.bodyLabel')}</Label>
        <textarea
          id={`edit-body-${m.id}`}
          required
          rows={3}
          value={body}
          maxLength={BODY_MAX}
          onChange={(e) => setBody(e.target.value)}
          className="w-full min-w-0 rounded-lg border border-input bg-background px-2.5 py-2 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
      </div>
      {sent ? null : <DisplayChoice value={display} onChange={setDisplay} />}
      {banner ? (
        <BannerFields title={title} body={body} productId={productId} onProduct={setProductId} color={color} onColor={setColor} />
      ) : null}
      {banner && !recurring ? (
        <div className="space-y-1">
          <Label htmlFor={`edit-until-${m.id}`}>{tb('until')}</Label>
          <div className="flex gap-2">
            <DateTimePicker
              id={`edit-until-${m.id}`}
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="h-11 flex-1"
            />
            {until ? (
              <Button type="button" variant="ghost" className="min-h-11" onClick={() => setUntil('')}>
                {tb('untilNone')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {sent ? null : recurring ? (
        <RecurrenceFields value={rec} onChange={setRec} idPrefix={`edit-${m.id}`} />
      ) : (
        <div className="space-y-1">
          <Label htmlFor={`edit-send-${m.id}`}>{t('schedule.sendAt')}</Label>
          <DateTimePicker
            id={`edit-send-${m.id}`}
            required
            value={sendAt}
            onChange={(e) => setSendAt(e.target.value)}
            className="h-11"
          />
        </div>
      )}
      <p className="text-xs text-muted-foreground">{sent ? tb('editHint') : t('schedule.editHint')}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-11 flex-1 sm:flex-none" disabled={!valid || save.isPending}>
          {t('schedule.save')}
        </Button>
        <Button type="button" variant="ghost" className="min-h-11" onClick={onDone}>
          {t('schedule.cancelEdit')}
        </Button>
      </div>
    </form>
  );
}

function MessageCard({ m }: { m: TillMessage }) {
  const t = useTranslations('tillMessages');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['till-messages'] });

  const cancel = useMutation({
    mutationFn: () => cancelTillMessage(m.id),
    onSuccess: () => {
      toast.success(t('cancelled'));
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const resend = useMutation({
    mutationFn: () => resendTillMessage(m.id),
    onSuccess: (out) => {
      toast.success(t('resent', { count: out.notified }));
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const pause = useMutation({
    mutationFn: () => (m.status === 'paused' ? resumeTillMessage(m.id) : pauseTillMessage(m.id)),
    onSuccess: (out) => {
      toast.success(out.status === 'paused' ? t('schedule.paused') : t('schedule.resumed'));
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const kind = m.scheduleKind ?? 'now';
  const banner = isBanner(m);
  const tb = useTranslations('specials.banner');
  // A banner is not acknowledged: the bar is how many tills show it.
  const pct = m.counts.total
    ? Math.round(((banner ? m.counts.delivered : m.counts.acknowledged) / m.counts.total) * 100)
    : 0;
  const showCounts = kind === 'now' || m.counts.total > 0;
  const occurrenceLive = kind !== 'recurring' || !!m.occurrence?.live;
  const swatch = COLOR_STYLE[m.color ?? 'amber'];
  return (
    <li className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="space-y-2 p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {m.title ? <p className="font-semibold">{m.title}</p> : null}
            <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className={cn('rounded-full px-2 py-0.5 text-[11px]', MESSAGE_STYLE[m.status])}>
              {t(`status.${m.status}`)}
            </span>
            {/* The kind: a banner in its colour, full-screen plain. */}
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                banner ? '' : 'bg-muted text-muted-foreground',
              )}
              style={banner ? { backgroundColor: swatch.bg, color: swatch.fg } : undefined}
            >
              {banner ? <Megaphone className="h-3 w-3" aria-hidden /> : null}
              {banner ? tb('kindBanner') : tb('kindFullscreen')}
            </span>
          </div>
        </div>
        {banner && m.productName ? (
          <p className="text-xs font-medium">{tb('productTag', { name: m.productName })}</p>
        ) : null}
        <ScheduleLine m={m} />
        <p className="text-xs text-muted-foreground">
          {t('meta', {
            target: `${t(`levels.${m.targetLevel}`)} ${m.targetName ?? ''}`.trim(),
            at: time(m.createdAt),
            sender: m.senderName ?? '—',
          })}
          {m.expiresAt && (m.status === 'active' || m.status === 'scheduled')
            ? ` · ${banner ? tb('endAt', { at: time(m.expiresAt) }) : t('expiresAt', { at: time(m.expiresAt) })}`
            : ''}
        </p>
        {showCounts ? (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span>
                {banner
                  ? tb('countsBanner', {
                      acknowledged: m.counts.acknowledged,
                      delivered: m.counts.delivered,
                      total: m.counts.total,
                    })
                  : t('counts', {
                      acknowledged: m.counts.acknowledged,
                      delivered: m.counts.delivered,
                      total: m.counts.total,
                    })}
              </span>
              <span className="tabular-nums text-muted-foreground">{pct}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {m.tills.length > 0 ? (
            <Button
              variant="ghost"
              className="min-h-11 flex-1 justify-between sm:flex-none"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
            >
              {t('tills', { count: m.tills.length })}
              <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />
            </Button>
          ) : null}
          {m.canManage ? (
            <>
              {m.status === 'active' && m.counts.total > 0 && occurrenceLive ? (
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={resend.isPending || m.counts.acknowledged === m.counts.total}
                  onClick={() => resend.mutate()}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  {t('resend')}
                </Button>
              ) : null}
              {m.canEdit ? (
                <Button
                  variant="outline"
                  className="min-h-11"
                  aria-expanded={editing}
                  onClick={() => setEditing((e) => !e)}
                >
                  <Pencil className="h-4 w-4" aria-hidden />
                  {t('schedule.edit')}
                </Button>
              ) : null}
              {kind === 'recurring' ? (
                <Button variant="outline" className="min-h-11" disabled={pause.isPending} onClick={() => pause.mutate()}>
                  {m.status === 'paused' ? <Play className="h-4 w-4" aria-hidden /> : <Pause className="h-4 w-4" aria-hidden />}
                  {m.status === 'paused' ? t('schedule.resume') : t('schedule.pause')}
                </Button>
              ) : null}
              <Button
                variant="outline"
                className="min-h-11 text-destructive"
                disabled={cancel.isPending}
                onClick={() => {
                  if (window.confirm(kind === 'now' ? t('cancelConfirm') : t('schedule.cancelConfirm'))) cancel.mutate();
                }}
              >
                <Ban className="h-4 w-4" aria-hidden />
                {t('cancel')}
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {editing ? <EditPanel m={m} onDone={() => setEditing(false)} /> : null}
      {open ? (
        <ul className="divide-y border-t">
          {m.tills.map((r) => (
            <ReceiptRow key={r.machineId} r={r} banner={banner} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

export default function TillMessagesPage() {
  const t = useTranslations('tillMessages');
  const errorText = useErrorText();
  const qc = useQueryClient();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [scope, setScope] = useState<OrgScope>(EMPTY_ORG_SCOPE);
  const [expiry, setExpiry] = useState<Expiry>('none');
  const [customExpiry, setCustomExpiry] = useState('');
  const [when, setWhen] = useState<TillMessageScheduleKind>('now');
  const [sendAt, setSendAt] = useState('');
  const [rec, setRec] = useState<RecurrenceDraft>(EMPTY_RECURRENCE);
  // "סוג תצוגה": full-screen (default) or the specials banner, with its product and colour.
  const [display, setDisplay] = useState<TillMessageDisplay>('fullscreen');
  const [productId, setProductId] = useState<string | null>(null);
  const [color, setColor] = useState<TillMessageColor>('amber');
  const banner = display === 'banner';
  const tb = useTranslations('specials.banner');
  const target = deepestOrgScope(scope);
  const targetLabel = useOrgScopeLabel(scope);

  const list = useQuery({
    queryKey: ['till-messages'],
    queryFn: () => fetchTillMessages({ limit: 50 }),
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
  });

  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const tenantZone = list.data?.items.find((i) => i.timezone)?.timezone ?? DEFAULT_TZ;
  const zoneDiffers = useMemo(() => browserZone() !== tenantZone, [tenantZone]);

  const expiresAt = useMemo(
    () => (when === 'recurring' ? null : expiryValue(expiry, customExpiry, when === 'scheduled' ? sendAt || null : null)),
    [customExpiry, expiry, sendAt, when],
  );
  const canSend =
    body.trim().length > 0 &&
    !!target &&
    target.level !== 'tenant' &&
    !!target.id &&
    (when === 'recurring' || expiry !== 'custom' || !!expiresAt) &&
    (when !== 'scheduled' || !!sendAt) &&
    (when !== 'recurring' || recurrenceValid(rec));

  const send = useMutation({
    mutationFn: () =>
      sendTillMessage({
        title: title.trim() || null,
        body: body.trim(),
        targetLevel: target!.level as TillMessageLevel,
        targetId: target!.id!,
        expiresAt,
        scheduleKind: when,
        ...(when === 'scheduled' ? { sendAt } : {}),
        ...(when === 'recurring' ? recurrenceBody(rec) : {}),
        ...(banner ? { display, productId, color } : {}),
      }),
    onSuccess: (out) => {
      toast.success(
        when === 'scheduled'
          ? t('schedule.scheduledToast')
          : when === 'recurring'
            ? t('schedule.recurringToast')
            : t('sent', { count: out.counts?.total ?? 0 }),
      );
      setTitle('');
      setBody('');
      setProductId(null);
      void qc.invalidateQueries({ queryKey: ['till-messages'] });
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const submitLabel = send.isPending
    ? t('compose.sending')
    : when === 'scheduled'
      ? t('schedule.submitScheduled')
      : when === 'recurring'
        ? t('schedule.submitRecurring')
        : t('compose.send');

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Megaphone className="mt-1 h-6 w-6 shrink-0 text-muted-foreground" aria-hidden />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('compose.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSend && !send.isPending) send.mutate();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="msg-title">{t('compose.titleLabel')}</Label>
              <Input
                id="msg-title"
                value={title}
                maxLength={TITLE_MAX}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('compose.titlePlaceholder')}
                className="h-11 text-base"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="msg-body">{t('compose.bodyLabel')}</Label>
              <textarea
                id="msg-body"
                required
                rows={4}
                value={body}
                maxLength={BODY_MAX}
                onChange={(e) => setBody(e.target.value)}
                placeholder={t('compose.bodyPlaceholder')}
                className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              />
              <p className="text-end text-[11px] tabular-nums text-muted-foreground">
                {body.length}/{BODY_MAX}
              </p>
            </div>
            <DisplayChoice value={display} onChange={setDisplay} />
            {banner ? (
              <BannerFields title={title} body={body} productId={productId} onProduct={setProductId} color={color} onColor={setColor} />
            ) : null}
            <div className="space-y-2">
              <Label>{t('compose.target')}</Label>
              <ScopePicker value={scope} onChange={setScope} defaultOpen />
            </div>

            <div className="space-y-2">
              <Label id="msg-when">{t('schedule.when')}</Label>
              <div role="radiogroup" aria-labelledby="msg-when" className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
                {WHEN.map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={when === k}
                    onClick={() => setWhen(k)}
                    className={cn(
                      'flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors',
                      when === k ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
                    )}
                  >
                    {k === 'now' ? (
                      <Send className="h-4 w-4" aria-hidden />
                    ) : k === 'scheduled' ? (
                      <CalendarClock className="h-4 w-4" aria-hidden />
                    ) : (
                      <Repeat className="h-4 w-4" aria-hidden />
                    )}
                    {t(`schedule.${k}`)}
                  </button>
                ))}
              </div>
              {when === 'scheduled' ? (
                <div className="space-y-1">
                  <Label htmlFor="msg-send-at">{t('schedule.sendAt')}</Label>
                  <DateTimePicker
                    id="msg-send-at"
                    required
                    value={sendAt}
                    min={localInput(new Date())}
                    onChange={(e) => setSendAt(e.target.value)}
                    className="h-11"
                  />
                </div>
              ) : null}
              {when === 'recurring' ? (
                <>
                  <RecurrenceFields value={rec} onChange={setRec} idPrefix="msg-rec" />
                  <p className="text-xs text-muted-foreground">{t('schedule.audienceHint')}</p>
                </>
              ) : null}
              {when !== 'now' && zoneDiffers ? (
                <p className="text-xs text-muted-foreground">{t('schedule.tzHint', { tz: tenantZone })}</p>
              ) : null}
            </div>

            {when !== 'recurring' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  {/* A banner's "עד מתי": with no end it shows until cancelled (not until read). */}
                  <Label>{banner ? tb('until') : t('compose.expiry')}</Label>
                  <Select
                    value={expiry}
                    onValueChange={(v) => v && setExpiry(v as Expiry)}
                    items={EXPIRIES.map((x) => ({ value: x, label: banner && x === 'none' ? tb('untilNone') : t(`expiry.${x}`) }))}
                  >
                    <SelectTrigger className="h-11 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EXPIRIES.map((x) => {
                        const label = banner && x === 'none' ? tb('untilNone') : t(`expiry.${x}`);
                        return (
                          <SelectItem key={x} value={x} label={label}>
                            {label}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
                {expiry === 'custom' ? (
                  <div className="space-y-1">
                    <Label htmlFor="msg-expiry">{t('compose.expiryAt')}</Label>
                    <DateTimePicker
                      id="msg-expiry"
                      value={customExpiry}
                      onChange={(e) => setCustomExpiry(e.target.value)}
                      className="h-11"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="sticky bottom-0 -mx-4 space-y-2 border-t bg-card/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
              <p className="text-xs text-muted-foreground">
                {target ? t('compose.sendTo', { target: targetLabel }) : t('compose.pickTarget')}
              </p>
              <Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={!canSend || send.isPending}>
                {when === 'recurring' ? (
                  <Repeat className="h-4 w-4" aria-hidden />
                ) : when === 'scheduled' ? (
                  <CalendarClock className="h-4 w-4" aria-hidden />
                ) : (
                  <Send className="h-4 w-4" aria-hidden />
                )}
                {submitLabel}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-semibold">
            <CheckCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('sentTitle')}
          </h2>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {list.dataUpdatedAt
              ? t('updatedAgo', {
                  ago: formatDistanceToNow(new Date(list.dataUpdatedAt), { addSuffix: true, locale: he }),
                })
              : null}
          </span>
        </div>
        {list.isError && !list.data ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <span>{axiosErrorToToastMessage(list.error, t('loadError'))}</span>
            <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
              {t('retry')}
            </Button>
          </div>
        ) : list.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-28 w-full rounded-xl" />
            <Skeleton className="h-28 w-full rounded-xl" />
          </div>
        ) : (list.data?.items.length ?? 0) === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="space-y-2">
            {list.data!.items.map((m) => (
              <MessageCard key={m.id} m={m} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
