/**
 * The kiosk's own keyboard model — a 1:1 port of the Android kiosk's domain/KioskKeys.kt. It lives
 * with the dashboard (client/src/lib/kioskKeys.ts) because the very same keyboard and entry window
 * are drawn on the dashboard's live preview (preview-entry.tsx, shared through @kiosk-shared);
 * test/kioskKeys.test.ts pins it to the shared fixture kiosk_keyboard_layout.json.
 */

export * from '@dash-lib/kioskKeys';
export { startKeyboard as start } from '@dash-lib/kioskKeys';
