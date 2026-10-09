/**
 * The cockpit's registry ("הניהול שלי") — the one place a feature plugs into the manager's
 * screen: its quick action (a big button opening a bottom sheet in place), its attention-feed
 * provider ("דורש תשומת לב"), its card.
 *
 * The integration contract (the coordinator's, 09.10.2026):
 *
 * * `CockpitScope` = `{ companyId?, shopId?, areaId?, machineId?, eventId? }`;
 * * `CockpitActionProps` = `{ scope, context?: { productId?, machineId?, categoryId? }, onDone }`;
 * * a quick action = `{ id, labelKey, icon, gate, Sheet }` (+ `bar`: in the quick-actions bar);
 * * an attention provider = `{ id, gate, useItems(scope) → { items: AttentionItem[], loading } }`,
 *   `AttentionItem` = `{ id, severity, title, body, actions: { labelKey, actionId, context }[] }`.
 *
 * Every entry has a `gate` (lib/cockpitGates.ts): the sections (and roles) the server checks on
 * the routes it calls — a manager sees only what they may do. An action whose `Sheet` is null is a
 * slot another branch fills at merge (`quickMessage`, `quickPromo`, `blockItem`, `deviceControl`,
 * `liveEvent`, `vouchers`, `stockUpdate`; providers `anomalies`, `pushAlerts`): replace the null
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
import { MACHINE_ADMIN_ROLES, OPEN_GATE } from '@/lib/cockpitGates';
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
  // ── Slots: registered at merge by their branches ──
  /** "הודעה מהירה" — feat/insights-actions. */
  { id: 'quickMessage', labelKey: 'quickMessage', icon: MessageSquareText, gate: { sections: ['quick_actions'], level: 'edit' }, Sheet: null, bar: true },
  /** "מבצע מהיר" / happy hour — feat/insights-actions. */
  { id: 'quickPromo', labelKey: 'quickPromo', icon: BadgePercent, gate: { sections: ['quick_actions'], level: 'edit' }, Sheet: null, bar: true },
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
  // ── Slots: registered at merge ──
  /** Insight anomalies (a till barely selling, an abnormal average or cash) — feat/insights-actions. */
  { id: 'anomalies', gate: { sections: ['reports'], level: 'view' }, useItems: useNoItems },
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
