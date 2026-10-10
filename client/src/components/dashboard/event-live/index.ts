/**
 * feat/event-live — what the Manager Cockpit (`/dashboard`) plugs in. Every component takes
 * `{ scope, context?, onDone }` (./types.ts).
 */
export { LiveEventLauncher } from './live-event-launcher';
export { LiveScreen } from './live-screen';
export { LiveEventLink } from './live-event-link';
export type { AlertAction, AlertItem, CockpitProps, CockpitScope } from './types';
export { PushAlertsSheet } from './push-alerts-sheet';
export { useAlertItems } from './use-alert-items';
export { ProducerShell } from './producer-shell';
export { ProducerAccessDialog } from './producer-access-dialog';
export { ForecastCard } from './forecast-card';
// "שיוך קופות מהיר לאירוע": "הוסף/הסר קופות" (feat/event-quick-assign).
export { EventTillsQuickAction } from './event-tills-quick-action';
