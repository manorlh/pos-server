/**
 * One order on the kitchen screen: number / table, source and service, waiter or pickup name, the
 * age timer in colour and words, the order note, the changes that need a "ראיתי", the items by
 * round (a later round is a "תוספת"), held items apart, and the buttons the cloud would accept
 * (lib/kdsBoard.ts). Shared by the Windows app and the browser KDS (`/kds`).
 */

import { AlertTriangle, CloudOff, Flame, Printer, ShoppingBag, Store, Users, Utensils } from 'lucide-react';
import type { KdsOrder, KdsTask, KdsView } from '@/lib/kdsScreenTypes';
import {
  ackButton,
  changeText,
  fallbackButtons,
  groupText,
  isCancelled,
  isHeld,
  isReady,
  orderButtons,
  orderTimer,
  orderTitle,
  pendingChanges,
  qtyText,
  rounds,
  serviceText,
  sourceText,
  taskButton,
  TIMER_TEXT,
  waitingFor,
  epochMs,
  type KdsButton,
  type KdsScreenRole,
  type TimerLevel,
} from '@/lib/kdsBoard';
import { Chip, TouchButton } from './parts';

const LEVEL: Record<TimerLevel, { ring: string; head: string; time: string }> = {
  normal: { ring: 'ring-white/10', head: 'bg-white/[0.06]', time: 'text-white' },
  warn: { ring: 'ring-amber-400', head: 'bg-amber-500/25', time: 'text-amber-300' },
  late: { ring: 'ring-red-500', head: 'bg-red-600/35', time: 'text-red-300' },
  done: { ring: 'ring-emerald-500/70', head: 'bg-emerald-600/20', time: 'text-emerald-300' },
};

const hhmm = (iso: string | null) => {
  const ms = epochMs(iso);
  return ms === null ? '' : new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
};

const SOURCE_ICON: Record<string, typeof Store> = { table: Utensils, kiosk: Store, external: ShoppingBag };

export interface CardProps {
  order: KdsOrder;
  role: KdsScreenRole;
  settings: KdsView['stationSettings'];
  /** The cloud's clock. */
  nowMs: number;
  offline: boolean;
  fresh: boolean;
  flashKey: string | null;
  onPress: (b: KdsButton, order: KdsOrder) => void;
  /** "הדפס": the card as a bon on the host's printer (the browser KDS with the Windows bridge); absent — no button. */
  onPrint?: (order: KdsOrder) => void;
}

export function KdsCard({ order, role, settings, nowMs, offline, fresh, flashKey, onPress, onPrint }: CardProps) {
  const timer = orderTimer(order, settings, nowMs);
  const tone = LEVEL[timer.level];
  const expo = role !== 'station';
  const press = (b: KdsButton) => onPress(b, order);
  const flash = (b: KdsButton) => flashKey === `${b.key}|${b.label}`;
  const SourceIcon = SOURCE_ICON[order.source] ?? ShoppingBag;
  const service = serviceText(order.serviceType);
  const group = groupText(order);
  const changes = pendingChanges(order);
  const live = order.tasks.filter((t) => !isHeld(t));
  const held = order.tasks.filter((t) => isHeld(t) && !isCancelled(t));
  const byRound = rounds(live);
  const buttons = orderButtons(order, role);
  const waiting = expo && !order.viewOnly && (order.groupState === 'waiting' || order.groupState === null) && !order.allReady ? waitingFor(order) : [];
  const urgent = (order.priority ?? 0) > 0;
  return (
    <article
      className={[
        'flex flex-col overflow-hidden rounded-2xl bg-[#171b22] ring-2',
        tone.ring,
        fresh ? 'r2m-kds-fresh' : '',
        urgent ? 'outline outline-4 outline-offset-2 outline-red-500/70' : '',
      ].join(' ')}
    >
      <header className={`flex items-start justify-between gap-3 px-4 py-3 ${tone.head}`}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[34px] font-black leading-none">
              <bdi>{orderTitle(order)}</bdi>
            </h2>
            {urgent ? (
              <Chip className="bg-red-600 text-white">
                <Flame size={14} /> דחוף
              </Chip>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip>
              <SourceIcon size={14} /> {sourceText(order.source)}
            </Chip>
            {service ? <Chip className={order.serviceType === 'take_away' ? 'bg-sky-500/20 text-sky-200' : 'bg-white/10 text-white/85'}>{service}</Chip> : null}
            {order.guests ? (
              <Chip>
                <Users size={14} /> {order.guests}
              </Chip>
            ) : null}
            {order.zoneName ? <Chip>{order.zoneName}</Chip> : null}
            {order.viewOnly ? <Chip className="bg-white/5 text-white/60">לצפייה</Chip> : null}
            {group ? <Chip className={order.groupState === 'ready_for_pickup' ? 'bg-emerald-500 text-emerald-950' : 'bg-white/10 text-white/70'}>{group}</Chip> : null}
            {order.pending && offline ? (
              <Chip className="bg-amber-400/90 text-black">
                <CloudOff size={14} /> ממתין לשליחה
              </Chip>
            ) : null}
          </div>
        </div>
        <div className={`shrink-0 text-end ${tone.time}`}>
          <div className={`text-[34px] font-black leading-none tabular-nums ${timer.level === 'late' ? 'r2m-kds-late' : ''}`}>
            {timer.minutes}
            <span className="ms-1 text-base font-bold">דק׳</span>
          </div>
          <div className="mt-1 text-base font-extrabold">{TIMER_TEXT[timer.level]}</div>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-2 px-3 py-3">
        {order.waiterName || order.pickupName ? (
          <div className="flex flex-wrap gap-x-4 px-1 text-lg text-white/75">
            {order.waiterName ? (
              <span>
                מלצר: <b className="text-white">{order.waiterName}</b>
              </span>
            ) : null}
            {order.pickupName ? (
              <span>
                שם: <b className="text-white">{order.pickupName}</b>
              </span>
            ) : null}
          </div>
        ) : null}
        {urgent && order.priorityReason ? <div className="px-1 text-base font-bold text-red-300">דחוף: {order.priorityReason}</div> : null}
        {order.orderNote ? <div className="rounded-xl bg-amber-400 px-3 py-2 text-lg font-bold text-black">הערה: {order.orderNote}</div> : null}

        {changes.map((c) => (
          <div
            key={c.id}
            className={`flex items-center gap-3 rounded-xl border-2 px-3 py-2 ${c.kind === 'cancel' ? 'border-red-500 bg-red-600/25' : 'border-amber-400 bg-amber-500/20'}`}
          >
            <AlertTriangle className={c.kind === 'cancel' ? 'shrink-0 text-red-300' : 'shrink-0 text-amber-300'} size={26} />
            <div className="min-w-0 flex-1 text-xl font-extrabold leading-snug">{changeText(c, order)}</div>
            <TouchButton button={ackButton(c)} onPress={press} flashing={flash(ackButton(c))} className="min-w-[96px] bg-white text-black" />
          </div>
        ))}

        {order.tasks
          .filter((t) => fallbackButtons(t).length > 0)
          .map((t) => (
            <div key={`fb-${t.id}`} className="space-y-2 rounded-xl border-2 border-amber-400 bg-amber-500/15 p-2">
              <div className="flex items-center gap-2 text-lg font-bold">
                <Printer size={20} className="shrink-0 text-amber-300" />
                <span>
                  הודפס בגיבוי — {qtyText(t.activeQty)} × {t.name}
                </span>
              </div>
              <div className="flex gap-2">
                {fallbackButtons(t).map((b) => (
                  <TouchButton key={b.label} button={b} onPress={press} flashing={flash(b)} className="flex-1" />
                ))}
              </div>
            </div>
          ))}

        {byRound.map((r) => (
          <section key={r.roundNo} className="space-y-1">
            {r.roundNo > 1 ? (
              <div className="flex items-center gap-2 rounded-lg bg-sky-500/15 px-2 py-1 text-base font-extrabold text-sky-300">
                תוספת · סבב {r.roundNo}
                {r.releasedAt ? <span className="font-bold text-sky-300/70">{hhmm(r.releasedAt)}</span> : null}
              </div>
            ) : byRound.length > 1 ? (
              <div className="px-2 text-sm font-bold text-white/50">סבב 1</div>
            ) : null}
            <ul className="space-y-1">
              {r.tasks.map((t) => (
                <TaskRow key={t.id} order={order} task={t} expo={expo} offline={offline} onPress={press} flash={flash} />
              ))}
            </ul>
          </section>
        ))}

        {held.length > 0 ? (
          <div className="rounded-xl border border-dashed border-white/20 px-3 py-2">
            <div className="text-sm font-bold text-white/55">בהמתנה (טרם הוצא)</div>
            {held.map((t) => (
              <div key={t.id} className="text-lg text-white/55">
                {qtyText(t.activeQty)} × {t.name}
                {t.course ? ` · ${t.course}` : ''}
              </div>
            ))}
          </div>
        ) : null}

        {order.otherStations && order.otherStations.length > 0 ? <div className="px-1 text-base text-white/50">גם ב: {order.otherStations.join(', ')}</div> : null}
        {waiting.length > 0 ? <div className="px-1 text-lg font-bold text-amber-200">ממתין ל: {waiting.join(', ')}</div> : null}
        {order.groupOverride ? <div className="px-1 text-base text-white/60">אושר לפני שהכול מוכן: {order.groupOverride}</div> : null}
      </div>

      {buttons.length > 0 || onPrint ? (
        <footer className="flex flex-wrap gap-2 border-t border-white/10 p-3">
          {buttons.map((b) => (
            <TouchButton key={b.key + b.label} button={b} onPress={press} flashing={flash(b)} className={b.primary ? 'min-h-[60px] flex-[2_1_55%] text-xl' : 'flex-[1_1_35%]'} />
          ))}
          {onPrint ? (
            <button
              type="button"
              aria-label="הדפסת בון"
              onClick={() => onPrint(order)}
              className="flex min-h-[52px] flex-[0_0_auto] touch-manipulation items-center justify-center gap-2 rounded-xl bg-white/10 px-4 text-lg font-extrabold text-white/85 active:scale-[0.96]"
            >
              <Printer size={20} /> הדפס
            </button>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

function TaskRow({
  order,
  task: t,
  expo,
  offline,
  onPress,
  flash,
}: {
  order: KdsOrder;
  task: KdsTask;
  expo: boolean;
  offline: boolean;
  onPress: (b: KdsButton) => void;
  flash: (b: KdsButton) => boolean;
}) {
  const cancelled = isCancelled(t);
  const done = isReady(t) && !cancelled;
  const button = taskButton(order, t);
  const qty = t.cancelledQty > 0 && !cancelled ? `${qtyText(t.orderedQty)}→${qtyText(t.activeQty)}` : qtyText(cancelled ? t.orderedQty : t.activeQty);
  return (
    <li className={`flex items-start gap-2 rounded-xl px-2 py-1.5 ${done ? 'bg-emerald-500/10' : t.state === 'preparing' ? 'bg-sky-500/10' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className={`text-[22px] font-extrabold leading-tight ${cancelled ? 'text-red-300/70 line-through' : done ? 'text-white/45 line-through' : 'text-white'}`}>
          <span className="tabular-nums">{qty}</span> × {t.name}
          {t.important && !cancelled && !done ? <span className="ms-2 rounded bg-yellow-300 px-1.5 align-middle text-sm font-black text-black">חשוב</span> : null}
        </div>
        {cancelled ? <div className="text-base font-bold text-red-300">בוטל</div> : null}
        {t.mealName ? <div className="text-sm text-white/50">{t.mealName}</div> : null}
        {t.mods.length ? <div className="text-lg leading-snug text-white/85">{t.mods.join(' · ')}</div> : null}
        {t.removals.length ? <div className="text-lg font-extrabold leading-snug text-red-400">{t.removals.map((r) => `בלי ${r}`).join(' · ')}</div> : null}
        {t.notes ? (
          <div className={`mt-0.5 inline-block rounded-md text-lg leading-snug ${t.important ? 'bg-yellow-300 px-2 font-extrabold text-black' : 'font-bold text-amber-200'}`}>{t.notes}</div>
        ) : null}
        {t.allergies.length ? (
          <div className="mt-1 inline-flex items-center gap-1 rounded-md border-2 border-white bg-red-600 px-2 py-0.5 text-lg font-black text-white">
            <AlertTriangle size={18} /> אלרגיה: {t.allergies.join(', ')}
          </div>
        ) : null}
        {t.seat || t.course || expo || t.overPrepared || t.remakeReason || (t.pending && offline) ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {t.seat ? <Chip className="bg-white/10 text-white/70">מקום {t.seat}</Chip> : null}
            {t.course ? <Chip className="bg-white/10 text-white/70">{t.course}</Chip> : null}
            {expo ? <Chip className={t.stationId ? 'bg-white/10 text-white/70' : 'bg-red-600 text-white'}>{t.stationName ?? 'ללא תחנה'}</Chip> : null}
            {t.overPrepared ? <Chip className="bg-amber-400 text-black">הוכן לפני הביטול</Chip> : null}
            {t.remakeReason ? <Chip className="bg-amber-400 text-black">הכנה מחדש: {t.remakeReason}</Chip> : null}
            {t.pending && offline ? (
              <Chip className="bg-amber-400/90 text-black">
                <CloudOff size={13} /> ממתין
              </Chip>
            ) : null}
          </div>
        ) : null}
      </div>
      {button ? <TouchButton button={button} onPress={onPress} flashing={flash(button)} className="w-[104px] shrink-0" /> : null}
    </li>
  );
}
