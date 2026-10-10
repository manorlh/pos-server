/**
 * The kiosk's own keyboard (a touch kiosk has no physical one, and the Windows touch keyboard must
 * never come up): the Android kiosk's KioskKeyboard.kt, drawn from the model in
 * core/kioskKeys.ts (client/src/lib/kioskKeys.ts, pinned by test/fixtures/kiosk_keyboard_layout.json).
 *
 * It lives with the shared screens (client/src/components/dashboard/kiosks/preview-entry.tsx) so
 * the dashboard's live preview shows the very same keyboard: the letter rows always left to right
 * (the Israeli keyboard's ק is at the top left in Hebrew too), the bottom row in the screen's
 * direction (the other language · 123 · space · backspace), big keys that pop on the press, the
 * backspace repeating while held; and the digits pad for the phone, the table and a tip amount.
 */

export { DigitsPad, KioskKeyboard as Keyboard, keyHeight } from '@kiosk-shared/index';
