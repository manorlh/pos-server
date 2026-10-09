/**
 * The cockpit's registry ("הניהול שלי") — the one place a feature plugs into the manager's
 * screen: its quick action (a big button opening a bottom sheet in place), its attention-feed
 * provider ("דורש תשומת לב"), its card.
 *
 * The integration contract (the coordinator's, 09.10.2026):
 *
 * * `CockpitScope` = `{ companyId?, shopId?, areaId?, machineId?, eventId? }`;
 * * `CockpitActionProps` = `{ scope, context?: { productId?, machineId?, categoryId?, prefillText? }, onDone }`
 *   (`prefillText`: the text a sheet starts with, e.g. an anomaly's line for a till message);
 * * a quick action = `{ id, labelKey, icon, gate, Sheet }` (+ `bar`: in the quick-actions bar;
 *   + `ownDialog` when the sheet is a whole dialog of its own, like the insights' sheets; + `variants`
 *   when the sheet depends on what the user holds — "הודעה לקופות");
 * * an attention provider = `{ id, gate, useItems(scope) → { items: AttentionItem[], loading } }`,
 *   `AttentionItem` = `{ id, severity, title, body, actions: { labelKey, actionId, context }[] }`.
 *
 * Every entry has a `gate` (lib/cockpitGates.ts): the sections (and roles) the server checks on
 * the routes it calls — a manager sees only what they may do. An action whose `Sheet` is null is a
 * slot another branch fills at merge (`blockItem`, `deviceControl`, `vouchers`, `stockUpdate`;
 * providers `stock`, `voucherAnomalies`, `targets`; cards `targets`, `slowItems` — filled at the
 * 09.10 integration merge: feat/insights-actions' `quickMessage`, `quickPromo` (with Happy hour as
 * its second mode) and `anomalies`; feat/event-live's `liveEvent`, `pushAlerts` and `forecast`):
 * replace the null
 * (or `useNoItems`) with the feature's component — nothing else changes. Section ids: the
 * catalogue's (lib/dashboardAccess.ts) — `cockpit`, `quick_actions`, `item_blocks`,
 * `device_control`, `live_event`, `alerts`.
 */

import {
  BadgePercent,
  Ban,
  Bell,
  Boxes,
  CreditCard,
  Megaphone,
  MessageSquareText,
  MonitorCog,
  Radio,
  TicketCheck,
} from 'lucide-react';
import { QuickMessageSheet, QuickPromoSheet } from '@/components/dashboard/insights-actions';
import { MACHINE_ADMIN_ROLES, OPEN_GATE, TILL_MESSAGE_GATES, type CockpitGate } from '@/lib/cockpitGates';
import { ForecastSlotCard, LiveEventSlot, useAlertAttentionItems } from './event-live-slots';
import { useAnomalyAttentionItems } from './insights-slots';
import { useFailedPaymentItems, useNoItems, useTillAlertItems } from './providers';
import { FailedPaymentsSheet } from './sheets/failed-payments-sheet';
import { TillMessageSheet } from './sheets/till-message-sheet';
import type { AttentionProvider, CockpitAction, CockpitCard } from './types';

export type {
  AttentionAction,
  AttentionItem,
  AttentionProvider,
  AttentionSeverity,
  CockpitAction,
  CockpitActionContext,
  CockpitActionProps,
  CockpitCard,
  CockpitGate,
  CockpitScope,
} from './types';

/** The till's own sheet (its details and remote actions), opened by the page — not a registered sheet. */
export const TILL_DETAILS_ACTION = 'tillDetails';

/**
 * The insights' quick actions (feat/insights-actions): "פעולות מהירות" at edit, and the roles the
 * server also checks — the till messages' machine-admin roles, the same four as the promotions'
 * writers (the sheets themselves show "no permission" to anyone else).
 */
const INSIGHT_ACTION_GATE: CockpitGate = { sections: ['quick_actions'], level: 'edit', roles: MACHINE_ADMIN_ROLES };

/**
 * The LIST, `GET /failed-payments` (`reports|z|cockpit:view`, no role check): the feed and its
 * review sheet read only it. A payment's own routes are not the cockpit's — reading its decision
 * commands (`GET /failed-payments/*`) is `reports|z`, deciding is a reports edit — and stay on the
 * transactions page; anything here that calls them must be gated `reports|z` on its own.
 */
const FAILED_PAYMENTS_GATE: CockpitGate = { sections: ['reports', 'z', 'cockpit'], level: 'view' };

/** The quick actions, in the bar's order. */
export const QUICK_ACTIONS: CockpitAction[] = [
  // ── Built here ──
  /**
   * "הודעה לקופות" — the one message button (the coordinator, 09.10.2026): with "הודעות לקופות"
   * at edit, the till messages' own sheet (`POST /till-messages`, full screen allowed); with only
   * "פעולות מהירות", the insights' banner sheet (`POST /insights/quick-actions/messages`, cancelled
   * through the quick actions). lib/cockpitGates.ts `TILL_MESSAGE_GATES`, tested there.
   */
  {
    id: 'tillMessage',
    labelKey: 'tillMessage',
    icon: Megaphone,
    gate: TILL_MESSAGE_GATES.button,
    Sheet: TillMessageSheet,
    variants: [
      { gate: TILL_MESSAGE_GATES.full, Sheet: TillMessageSheet },
      { gate: TILL_MESSAGE_GATES.banner, Sheet: QuickMessageSheet, ownDialog: true },
    ],
    bar: true,
  },
  {
    id: 'failedPayments',
    labelKey: 'failedPayments',
    icon: CreditCard,
    // The feed item's "לבדיקה" opens it: the same gate as the feed, or the item loses its button.
    gate: FAILED_PAYMENTS_GATE,
    Sheet: FailedPaymentsSheet,
    bar: false,
  },
  // ── feat/insights-actions: its sheets are whole dialogs of their own (`ownDialog`) ──
  /**
   * "הודעה מהירה" — from an attention item only (an anomaly's till, with its line; a slow product):
   * not in the bar, where "הודעה לקופות" is the one message button.
   */
  { id: 'quickMessage', labelKey: 'quickMessage', icon: MessageSquareText, gate: INSIGHT_ACTION_GATE, Sheet: QuickMessageSheet, ownDialog: true, bar: false },
  /**
   * "מבצע מהיר | Happy hour" — one button, one sheet with two modes (the owner: "בלי מיליון
   * לשוניות"). On an item's product, the quick promotion; from the bar, ad hoc (a product, a
   * category or the basket) or a scheduled happy hour.
   */
  { id: 'quickPromo', labelKey: 'quickPromo', icon: BadgePercent, gate: INSIGHT_ACTION_GATE, Sheet: QuickPromoSheet, ownDialog: true, bar: true },
  // ── Slots: registered at merge by their branches ──
  /** "חסום / אזל". */
  { id: 'blockItem', labelKey: 'blockItem', icon: Ban, gate: { sections: ['item_blocks'], level: 'edit' }, Sheet: null, bar: true },
  /** "שליטה בקופות וקיוסקים". */
  { id: 'deviceControl', labelKey: 'deviceControl', icon: MonitorCog, gate: { sections: ['device_control'], level: 'edit' }, Sheet: null, bar: true },
  /**
   * "מצב אירוע חי" — feat/event-live (event-live-slots.tsx): the full live screen at once (the scope's
   * event, else the one live now), or the picker. The server: `live_event` at view for the screen.
   */
  { id: 'liveEvent', labelKey: 'liveEvent', icon: Radio, gate: { sections: ['live_event'], level: 'view' }, Sheet: LiveEventSlot, ownDialog: true, bar: true },
  /** "שוברים". */
  { id: 'vouchers', labelKey: 'vouchers', icon: TicketCheck, gate: { sections: ['prepaid_vouchers'], level: 'view' }, Sheet: null, bar: true },
  /** "עדכון מלאי" — on Saturdays. */
  {
    id: 'stockUpdate',
    labelKey: 'stockUpdate',
    icon: Boxes,
    gate: { sections: ['stock'], level: 'edit', weekdays: [6] },
    Sheet: null,
    bar: true,
  },
];

/** The attention feed's providers ("דורש תשומת לב"); their items are merged and ordered. */
export const ATTENTION_PROVIDERS: AttentionProvider[] = [
  // ── Built here ──
  { id: 'tillAlerts', gate: OPEN_GATE, useItems: useTillAlertItems },
  { id: 'failedPayments', gate: FAILED_PAYMENTS_GATE, useItems: useFailedPaymentItems },
  /**
   * Insight anomalies (a till barely selling, an abnormal average or cash), then a few slow
   * products — feat/insights-actions (insights-slots.ts). The board's own "מה דורש תשומת לב"
   * block of that branch is not mounted: these same items are here.
   */
  { id: 'anomalies', gate: { sections: ['reports'], level: 'view' }, useItems: useAnomalyAttentionItems },
  /** Phone (push) alerts — feat/event-live (`useAlertItems`, `GET /push/alerts`: `alerts` at view). */
  { id: 'pushAlerts', gate: { sections: ['alerts'], level: 'view' }, useItems: useAlertAttentionItems },
  // ── Slots: registered at merge ──
  /** Low stock, sold out, active blocks. */
  { id: 'stock', gate: { sections: ['stock', 'item_blocks'], level: 'view' }, useItems: useNoItems },
  /** Vouchers anomalies. */
  { id: 'voucherAnomalies', gate: { sections: ['prepaid_vouchers'], level: 'view' }, useItems: useNoItems },
  /** Targets behind. */
  { id: 'targets', gate: { sections: ['cockpit'], level: 'view' }, useItems: useNoItems },
];

/** The cockpit's own cards beyond the board's (slots, registered at merge). */
export const COCKPIT_CARDS: CockpitCard[] = [
  { id: 'targets', gate: { sections: ['cockpit'], level: 'view' }, Card: null },
  { id: 'slowItems', gate: { sections: ['reports'], level: 'view' }, Card: null },
  /** "תחזית ואיוש" — feat/event-live (`ForecastCard`, `GET /insights/staffing`: `reports` at view). */
  { id: 'forecast', gate: { sections: ['reports'], level: 'view' }, Card: ForecastSlotCard },
];

/** An action by id (an attention item's button). */
export function actionById(id: string): CockpitAction | undefined {
  return QUICK_ACTIONS.find((a) => a.id === id);
}

/** Icons the feed uses for its severities. */
export const ALERT_ICON = Bell;
