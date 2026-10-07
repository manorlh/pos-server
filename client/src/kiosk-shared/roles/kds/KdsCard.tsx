/**
 * One order on the kitchen screen: number / table, source and service, waiter or pickup name, the
 * age timer in colour and words, the order note, the changes that need a "ראיתי", the items by
 * round (a later round is a "תוספת"), held items apart, and the buttons the cloud would accept
 * (lib/kdsBoard.ts). Shared by the Windows app and the browser KDS (`/kds`).
 *
 * The screen's look (theme.ts `useKdsLook`, docs/SPEC_KDS.md §14) decides its colours, its density
 * and which fields it shows. `variant`: "full" (the tickets, rail and big layouts), "lane" (a
 * lane of the columns layout — only that lane's items, with the lane's "הכול מוכן"), "summary"
 * (the Expo's "לאיסוף" lane — the order in one line and its pickup buttons).
 */

import { AlertTriangle, CloudOff, Flame, Printer, ShoppingBag, Store, Users, Utensils } from 'lucide-react';
import type { KdsField, KdsOrder, KdsTask, KdsView } from '@/lib/kdsScreenTypes';
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
} from '@/lib/kdsBoard';
import { itemsSummary } from '@/lib/kdsLayouts';
import { screenThresholds } from '@/lib/screenLook';
import { Chip, TouchButton } from './parts';
import { levelVars, useKdsLook } from './theme';

const hhmm = (iso: string | null) => {
  const ms = epochMs(iso);
  return ms === null ? '' : new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
};

const SOURCE_ICON: Record<string, typeof Store> = { table: Utensils, kiosk: Store, external: ShoppingBag };

/** Sizes per density ("normal" = the card as it always was). */
const SIZE = {
  compact: { head: 'px-3 py-2', title: 'text-[28px]', time: 'text-[28px]', body: 'gap-1.5 px-2 py-2', item: 'text-[20px]', sub: 'text-base', mod: 'text-base', btn: '', task: 'w-[84px]', foot: 'gap-1.5 p-2' },
  normal: { head: 'px-4 py-3', title: 'text-[34px]', time: 'text-[34px]', body: 'gap-2 px-3 py-3', item: 'text-[22px]', sub: 'text-lg', mod: 'text-lg', btn: '', task: 'w-[104px]', foot: 'gap-2 p-3' },
  large: { head: 'px-5 py-4', title: 'text-[42px]', time: 'text-[40px]', body: 'gap-2.5 px-4 py-3', item: 'text-[27px]', sub: 'text-xl', mod: 'text-xl', btn: '', task: 'w-[112px]', foot: 'gap-2.5 p-3' },
  /** The "big" layout's few cards (a small kitchen, a bar): read across the room. */
  huge: { head: 'px-6 py-5', title: 'text-[60px]', time: 'text-[54px]', body: 'gap-3 px-5 py-4', item: 'text-[36px]', sub: 'text-2xl', mod: 'text-[26px]', btn: 'min-h-[76px] text-[26px]', task: 'w-[140px]', foot: 'gap-3 p-4' },
} as const;

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
  variant?: 'full' | 'lane' | 'summary';
  /** "lane": the lane's items, and its "הכול מוכן". */
  laneTasks?: KdsTask[];
  laneButton?: KdsButton | null;
  /** The card fills its slot's height and scrolls inside (the rail, the big cards). */
  fill?: boolean;
  /** Its size, over the screen's density ("huge": the big layout). */
  tier?: keyof typeof SIZE;
}

export function KdsCard({ order, role, settings, nowMs, offline, fresh, flashKey, onPress, onPrint, variant = 'full', laneTasks, laneButton, fill = false, tier }: CardProps) {
  const { theme, look } = useKdsLook();
  const show = (f: KdsField) => look.fields[f] !== false;
  const size = SIZE[tier ?? look.density] ?? SIZE.normal;
  const timer = orderTimer(order, settings, nowMs, { thresholds: screenThresholds(look), ageColors: look.ageColors });
  const expo = role !== 'station';
  const press = (b: KdsButton) => onPress(b, order);
  const flash = (b: KdsButton) => flashKey === `${b.key}|${b.label}`;
  const SourceIcon = SOURCE_ICON[order.source] ?? ShoppingBag;
  const service = serviceText(order.serviceType);
  const group = groupText(order);
  const changes = variant === 'summary' ? [] : pendingChanges(order).filter((c) => variant !== 'lane' || !c.taskId || (laneTasks ?? []).some((t) => t.id === c.taskId));
  const source = variant === 'lane' ? (laneTasks ?? []) : order.tasks;
  const live = source.filter((t) => !isHeld(t));
  const held = variant === 'full' ? order.tasks.filter((t) => isHeld(t) && !isCancelled(t)) : [];
  const byRound = rounds(live);
  const buttons = variant === 'lane' ? (laneButton ? [laneButton] : []) : orderButtons(order, role);
  const waiting = expo && variant === 'full' && !order.viewOnly && (order.groupState === 'waiting' || order.groupState === null) && !order.allReady ? waitingFor(order) : [];
  const urgent = (order.priority ?? 0) > 0;
  const lateGlow = timer.level === 'late';
  return (
    <article
      style={levelVars(theme, timer.level)}
      className={[
        'flex flex-col overflow-hidden rounded-xl border-[length:var(--k-ring-w)] border-[var(--k-lv-ring)] bg-[var(--k-card)] text-[var(--k-text)]',
        // In a column of cards a card keeps its height (it never shrinks to its header); filling a slot it scrolls inside.
        fill ? 'h-full min-h-0' : 'shrink-0',
        fresh ? 'r2m-kds-fresh' : '',
        urgent ? 'outline outline-4 outline-offset-2 outline-[var(--k-late)]' : '',
      ].join(' ')}
    >
      <header className={`flex shrink-0 items-start justify-between gap-3 bg-[var(--k-lv-head)] ${size.head}`}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className={`truncate font-black leading-none ${size.title}`}>
              <bdi>{orderTitle(order)}</bdi>
            </h2>
            {urgent ? (
              <Chip className="bg-[var(--k-late)] text-white">
                <Flame size={14} /> דחוף
              </Chip>
            ) : null}
          </div>
          {variant === 'lane' ? null : (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {show('table') ? (
                <Chip>
                  <SourceIcon size={14} /> {sourceText(order.source)}
                </Chip>
              ) : null}
              {service ? <Chip className={order.serviceType === 'take_away' ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent-text)]' : undefined}>{service}</Chip> : null}
              {show('guests') && order.guests ? (
                <Chip>
                  <Users size={14} /> {order.guests}
                </Chip>
              ) : null}
              {show('table') && order.zoneName ? <Chip>{order.zoneName}</Chip> : null}
              {order.viewOnly ? <Chip className="bg-[var(--k-chip)] text-[var(--k-muted)]">לצפייה</Chip> : null}
              {group ? <Chip className={order.groupState === 'ready_for_pickup' ? 'bg-[var(--k-pickup)] text-[var(--k-on-pickup)]' : undefined}>{group}</Chip> : null}
              {order.pending && offline ? (
                <Chip className="bg-[var(--k-warn)] text-black">
                  <CloudOff size={14} /> ממתין לשליחה
                </Chip>
              ) : null}
            </div>
          )}
        </div>
        <div className="shrink-0 text-end text-[var(--k-lv-time)]">
          <div className={`font-black leading-none tabular-nums ${size.time} ${lateGlow ? 'r2m-kds-late' : ''}`}>
            {timer.minutes}
            <span className="ms-1 text-base font-bold">דק׳</span>
          </div>
          <div className="mt-1 text-base font-extrabold">{TIMER_TEXT[timer.level]}</div>
        </div>
      </header>

      <div className={`flex flex-1 flex-col ${size.body} ${fill ? 'min-h-0 touch-pan-y overflow-y-auto overscroll-contain' : ''}`}>
        {variant !== 'lane' && ((show('waiter') && order.waiterName) || (show('name') && order.pickupName)) ? (
          <div className={`flex flex-wrap gap-x-4 px-1 text-[var(--k-muted)] ${size.sub}`}>
            {show('waiter') && order.waiterName ? (
              <span>
                מלצר: <b className="text-[var(--k-text)]">{order.waiterName}</b>
              </span>
            ) : null}
            {show('name') && order.pickupName ? (
              <span>
                שם: <b className="text-[var(--k-text)]">{order.pickupName}</b>
              </span>
            ) : null}
          </div>
        ) : null}
        {urgent && order.priorityReason && variant === 'full' ? <div className="px-1 text-base font-bold text-[var(--k-late)]">דחוף: {order.priorityReason}</div> : null}
        {show('notes') && order.orderNote && variant !== 'lane' ? (
          <div className={`rounded-lg bg-[var(--k-note)] px-3 py-2 font-bold text-[var(--k-on-note)] ${size.sub}`}>הערה: {order.orderNote}</div>
        ) : null}

        {changes.map((c) => (
          <div
            key={c.id}
            className={`flex items-center gap-3 rounded-lg border-2 px-3 py-2 ${c.kind === 'cancel' ? 'border-[var(--k-late)] bg-[var(--k-urgent)]' : 'border-[var(--k-warn)] bg-[var(--k-chip)]'}`}
          >
            <AlertTriangle className={c.kind === 'cancel' ? 'shrink-0 text-[var(--k-late)]' : 'shrink-0 text-[var(--k-warn)]'} size={26} />
            <div className="min-w-0 flex-1 text-xl font-extrabold leading-snug">{changeText(c, order)}</div>
            <TouchButton button={ackButton(c)} onPress={press} flashing={flash(ackButton(c))} className="min-w-[96px] !bg-[var(--k-text)] !text-[var(--k-bg)]" />
          </div>
        ))}

        {variant === 'summary' ? (
          <SummaryLine order={order} />
        ) : (
          <>
            {source
              .filter((t) => fallbackButtons(t).length > 0)
              .map((t) => (
                <div key={`fb-${t.id}`} className="space-y-2 rounded-lg border-2 border-[var(--k-warn)] bg-[var(--k-chip)] p-2">
                  <div className="flex items-center gap-2 text-lg font-bold">
                    <Printer size={20} className="shrink-0 text-[var(--k-warn)]" />
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
                  <div className="flex items-center gap-2 rounded-md bg-[var(--k-accent-soft)] px-2 py-1 text-base font-extrabold text-[var(--k-accent-text)]">
                    תוספת · סבב {r.roundNo}
                    {r.releasedAt ? <span className="font-bold opacity-75">{hhmm(r.releasedAt)}</span> : null}
                  </div>
                ) : byRound.length > 1 ? (
                  <div className="px-2 text-sm font-bold text-[var(--k-faint)]">סבב 1</div>
                ) : null}
                <ul className="space-y-1">
                  {r.tasks.map((t) => (
                    <TaskRow key={t.id} order={order} task={t} expo={expo && variant === 'full'} offline={offline} onPress={press} flash={flash} itemClass={size.item} modClass={size.mod} btnClass={`${size.task} ${size.btn}`} />
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}

        {held.length > 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--k-line)] px-3 py-2">
            <div className="text-sm font-bold text-[var(--k-faint)]">בהמתנה (טרם הוצא)</div>
            {held.map((t) => (
              <div key={t.id} className="text-lg text-[var(--k-faint)]">
                {qtyText(t.activeQty)} × {t.name}
                {show('course') && t.course ? ` · ${t.course}` : ''}
              </div>
            ))}
          </div>
        ) : null}

        {variant === 'full' && order.otherStations && order.otherStations.length > 0 ? <div className="px-1 text-base text-[var(--k-faint)]">גם ב: {order.otherStations.join(', ')}</div> : null}
        {waiting.length > 0 ? <div className="px-1 text-lg font-bold text-[var(--k-warn)]">ממתין ל: {waiting.join(', ')}</div> : null}
        {variant === 'full' && order.groupOverride ? <div className="px-1 text-base text-[var(--k-muted)]">אושר לפני שהכול מוכן: {order.groupOverride}</div> : null}
      </div>

      {buttons.length > 0 || (onPrint && variant === 'full') ? (
        <footer className={`flex shrink-0 flex-wrap border-t border-[var(--k-line)] ${size.foot}`}>
          {buttons.map((b) => (
            <TouchButton key={b.key + b.label} button={b} onPress={press} flashing={flash(b)} className={`${b.primary ? 'min-h-[60px] flex-[2_1_55%] text-xl' : 'flex-[1_1_35%]'} ${size.btn}`} />
          ))}
          {onPrint && variant === 'full' ? (
            <button
              type="button"
              aria-label="הדפסת בון"
              onClick={() => onPrint(order)}
              className="flex min-h-[52px] flex-[0_0_auto] touch-manipulation items-center justify-center gap-2 rounded-xl bg-[var(--k-quiet)] px-4 text-lg font-extrabold text-[var(--k-on-quiet)] active:scale-[0.96]"
            >
              <Printer size={20} /> הדפס
            </button>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

/** "לאיסוף": the order's items in one line. */
function SummaryLine({ order }: { order: KdsOrder }) {
  const { look } = useKdsLook();
  const parts = itemsSummary(order, { ...look.fields, modifiers: false, notes: false });
  return (
    <div className="px-1 text-lg leading-snug text-[var(--k-muted)]">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? ' · ' : ''}
          {p.text}
          {p.allergyText ? <span className="ms-1.5 rounded bg-[#dc2626] px-1.5 text-base font-black text-white">{p.allergyText}</span> : null}
        </span>
      ))}
    </div>
  );
}

function TaskRow({
  order,
  task: t,
  expo,
  offline,
  onPress,
  flash,
  itemClass,
  modClass,
  btnClass,
}: {
  order: KdsOrder;
  task: KdsTask;
  expo: boolean;
  offline: boolean;
  onPress: (b: KdsButton) => void;
  flash: (b: KdsButton) => boolean;
  itemClass: string;
  modClass: string;
  btnClass: string;
}) {
  const { look } = useKdsLook();
  const show = (f: KdsField) => look.fields[f] !== false;
  const cancelled = isCancelled(t);
  const done = isReady(t) && !cancelled;
  const button = taskButton(order, t);
  const qty = t.cancelledQty > 0 && !cancelled ? `${qtyText(t.orderedQty)}→${qtyText(t.activeQty)}` : qtyText(cancelled ? t.orderedQty : t.activeQty);
  const chips = (show('course') && t.course) || t.seat || expo || t.overPrepared || t.remakeReason || (t.pending && offline);
  return (
    <li className={`flex items-start gap-2 rounded-lg px-2 py-1.5 ${done ? 'bg-[var(--k-chip)]' : t.state === 'preparing' ? 'bg-[var(--k-accent-soft)]' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className={`font-extrabold leading-tight ${itemClass} ${cancelled ? 'text-[var(--k-late)] line-through opacity-70' : done ? 'text-[var(--k-faint)] line-through' : 'text-[var(--k-text)]'}`}>
          <span className="tabular-nums">{qty}</span> × {t.name}
          {t.important && !cancelled && !done ? <span className="ms-2 rounded bg-[var(--k-note)] px-1.5 align-middle text-sm font-black text-[var(--k-on-note)]">חשוב</span> : null}
        </div>
        {cancelled ? <div className="text-base font-bold text-[var(--k-late)]">בוטל</div> : null}
        {show('modifiers') && t.mealName ? <div className="text-sm text-[var(--k-faint)]">{t.mealName}</div> : null}
        {show('modifiers') && t.mods.length ? <div className={`${modClass} leading-snug text-[var(--k-chip-text)]`}>{t.mods.join(' · ')}</div> : null}
        {show('modifiers') && t.removals.length ? <div className={`${modClass} font-extrabold leading-snug text-[var(--k-late)]`}>{t.removals.map((r) => `בלי ${r}`).join(' · ')}</div> : null}
        {show('notes') && t.notes ? (
          <div className={`mt-0.5 inline-block rounded-md leading-snug ${modClass} ${t.important ? 'bg-[var(--k-note)] px-2 font-extrabold text-[var(--k-on-note)]' : 'font-bold text-[var(--k-warn)]'}`}>{t.notes}</div>
        ) : null}
        {show('allergens') && t.allergies.length ? (
          <div className={`mt-1 inline-flex items-center gap-1 rounded-md border-2 border-white bg-[#dc2626] px-2 py-0.5 font-black text-white ${modClass}`}>
            <AlertTriangle size={18} /> אלרגיה: {t.allergies.join(', ')}
          </div>
        ) : null}
        {chips ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {t.seat ? <Chip className="bg-[var(--k-chip)] text-[var(--k-muted)]">מקום {t.seat}</Chip> : null}
            {show('course') && t.course ? <Chip className="bg-[var(--k-chip)] text-[var(--k-muted)]">{t.course}</Chip> : null}
            {expo ? <Chip className={t.stationId ? 'bg-[var(--k-chip)] text-[var(--k-muted)]' : 'bg-[var(--k-late)] text-white'}>{t.stationName ?? 'ללא תחנה'}</Chip> : null}
            {t.overPrepared ? <Chip className="bg-[var(--k-warn)] text-black">הוכן לפני הביטול</Chip> : null}
            {t.remakeReason ? <Chip className="bg-[var(--k-warn)] text-black">הכנה מחדש: {t.remakeReason}</Chip> : null}
            {t.pending && offline ? (
              <Chip className="bg-[var(--k-warn)] text-black">
                <CloudOff size={13} /> ממתין
              </Chip>
            ) : null}
          </div>
        ) : null}
      </div>
      {button ? <TouchButton button={button} onPress={onPress} flashing={flash(button)} className={`shrink-0 ${btnClass}`} /> : null}
    </li>
  );
}
