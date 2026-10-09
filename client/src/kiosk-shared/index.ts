/**
 * The kiosk's shared UI: the screens and the config logic the dashboard's live preview draws,
 * which the Windows kiosk (`kiosk-desktop/`) renders on the real device. One code, one look.
 *
 * Rule for every file reached from here: no Next.js, no next-intl, no react-query, no dashboard
 * API — only React, lucide-react, qrcode.react, clsx/tailwind-merge (`lib/utils`) and
 * `lib/kioskConfig`.
 */

export * from '../components/dashboard/kiosks/preview-screens';
export * from '../components/dashboard/kiosks/preview-motion';
// "מנוע הנפשות": the feedback the engine's events play — the press, "נוסף להזמנה", the badge, the success, the error.
export * from '../components/dashboard/kiosks/preview-feedback';
// "כיתוב רץ": the scrolling strip (the menu and the basket place it; TickerFrame the other screens).
export * from '../components/dashboard/kiosks/preview-ticker';
// The kiosk's keyboard and its entry window (the name, the phone, the table, a tip amount, a note);
// its model is `lib/kioskKeys` (pure, like `lib/kioskConfig`).
export * from '../components/dashboard/kiosks/preview-entry';
// The dish's and the meal's choices and the basket's promotions, priced by lib/kioskMoney.ts (the till's rules).
export * from '../components/dashboard/kiosks/preview-dish';
export * from './types';
// "מבנה הקיוסק" (config `layout`): the layouts' screens and their one switch point (kiosk-shared/layouts).
export * from './layouts';
// "איך תרצו לשלם?" (docs/SPEC_KIOSK.md §23): the method step and "גשו לקופה לתשלום" (the browser kiosk uses them).
export * from './pay-method';
// "אפקטים" (`motion.effects`): the web kiosks' render profile — the config's, or the device's (auto).
export * from './render-profile';
