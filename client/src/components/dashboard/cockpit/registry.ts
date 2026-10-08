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
 *   + `ownDialog` when the sheet is a whole dialog of its own, like the insights' sheets);
 * * an attention provider = `{ id, gate, useItems(scope) → { items: AttentionItem[], loading } }`,
 *   `AttentionItem` = `{ id, severity, title, body, actions: { labelKey, actionId, context }[] }`.
 *
 * Every entry has a `gate` (lib/cockpitGates.ts): the sections (and roles) the server checks on
 * the routes it calls — a manager sees only what they may do. An action whose `Sheet` is null is a
 * slot another branch fills at merge (`blockItem`, `deviceControl`, `liveEvent`, `vouchers`,
 * `stockUpdate`; provider `pushAlerts` — feat/insights-actions filled `quickMessage`,
 * `quickPromo`, `happyHour` and `anomalies` at the 09.10 integration merge): replace the null
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
  Sparkles,
  TicketCheck,
} from 'lucide-react';
import { HappyHourSheet, QuickMessageSheet, QuickPromoSheet } from '@/components/dashboard/insights-actions';
import { MACHINE_ADMIN_ROLES, OPEN_GATE, type CockpitGate } from '@/lib/cockpitGates';
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

/** The quick actions, in the bar's order. */
export const QUICK_ACTIONS: CockpitAction[] = [
  // ── Built here ──
  {
    id: 'tillMessage',
    labelKey: 'tillMessage',
    icon: Megaphone,
    // The till-messages routes: "הודעות לקופות" at edit, and the machine-admin roles.
    gate: { sections: ['till_messages'], level: 'edit', roles: MACHINE_ADMIN_ROLES },
    Sheet: TillMessageSheet,
    bar: true,
  },
  {
    id: 'failedPayments',
    labelKey: 'failedPayments',
    icon: CreditCard,
    gate: { sections: ['reports', 'z'], level: 'view' },
    Sheet: FailedPaymentsSheet,
    bar: false,
  },
  // ── feat/insights-actions: its sheets are whole dialogs of their own (`ownDialog`) ──
  /** "הודעה מהירה". */
  { id: 'quickMessage', labelKey: 'quickMessage', icon: MessageSquareText, gate: INSIGHT_ACTION_GATE, Sheet: QuickMessageSheet, ownDialog: true, bar: true },
  /** "מבצע מהיר" — on an item's product; from the bar, "מבצע מזדמן" (ad hoc: a product, a category or the basket). */
  { id: 'quickPromo', labelKey: 'quickPromo', icon: BadgePercent, gate: INSIGHT_ACTION_GATE, Sheet: QuickPromoSheet, ownDialog: true, bar: true },
  /** "Happy hour" — a scheduled promotion on chosen weekdays and hours. */
  { id: 'happyHour', labelKey: 'happyHour', icon: Sparkles, gate: INSIGHT_ACTION_GATE, Sheet: HappyHourSheet, ownDialog: true, bar: true },
  // ── Slots: registered at merge by their branches ──
  /** "חסום / אזל". */
  { id: 'blockItem', labelKey: 'blockItem', icon: Ban, gate: { sections: ['item_blocks'], level: 'edit' }, Sheet: null, bar: true },
  /** "שליטה בקופות וקיוסקים". */
  { id: 'deviceControl', labelKey: 'deviceControl', icon: MonitorCog, gate: { sections: ['device_control'], level: 'edit' }, Sheet: null, bar: true },
  /** "מצב אירוע חי". */
  { id: 'liveEvent', labelKey: 'liveEvent', icon: Radio, gate: { sections: ['live_event'], level: 'view' }, Sheet: null, bar: true },
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
  { id: 'failedPayments', gate: { sections: ['reports', 'z'], level: 'view' }, useItems: useFailedPaymentItems },
  /**
   * Insight anomalies (a till barely selling, an abnormal average or cash), then a few slow
   * products — feat/insights-actions (insights-slots.ts). The board's own "מה דורש תשומת לב"
   * block of that branch is not mounted: these same items are here.
   */
  { id: 'anomalies', gate: { sections: ['reports'], level: 'view' }, useItems: useAnomalyAttentionItems },
  // ── Slots: registered at merge ──
  /** Push alerts (a terminal not answering…). */
  { id: 'pushAlerts', gate: { sections: ['alerts'], level: 'view' }, useItems: useNoItems },
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
  { id: 'forecast', gate: { sections: ['reports'], level: 'view' }, Card: null },
];

/** An action by id (an attention item's button). */
export function actionById(id: string): CockpitAction | undefined {
  return QUICK_ACTIONS.find((a) => a.id === id);
}

/** Icons the feed uses for its severities. */
export const ALERT_ICON = Bell;
