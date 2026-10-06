/**
 * The kiosk's shared UI: the screens and the config logic the dashboard's live preview draws,
 * which the Windows kiosk (`kiosk-desktop/`) renders on the real device. One code, one look.
 *
 * Rule for every file reached from here: no Next.js, no next-intl, no react-query, no dashboard
 * API — only React, lucide-react, qrcode.react, clsx/tailwind-merge (`lib/utils`) and
 * `lib/kioskConfig`.
 */

export * from '../components/dashboard/kiosks/preview-screens';
export * from './types';
