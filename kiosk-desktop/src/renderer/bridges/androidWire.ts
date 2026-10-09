/**
 * The Android bridge's version and names (bridges/android.ts), on their own with no imports — so
 * scripts/build-android-bundle.mjs (plain Node) can stamp the bundle's manifest with them. Pinned by
 * test/fixtures/android_bridge_api.json, the same bytes as pos-android's kiosk_web_bridge_api.json.
 */

/** The bridge API this bundle speaks (manifest.json `bridgeApi`); an APK that speaks less refuses the bundle. */
export const ANDROID_BRIDGE_API = 1;

/** Calls that are answered. */
export const ANDROID_CALLS = ['bootstrap', 'shellView', 'startPayment', 'cancelPayment', 'receiptChoice', 'helpRequest', 'voucherApply', 'voucherRemove'] as const;
/** One-way messages to the APK. */
export const ANDROID_SENDS = ['reportFlow', 'funnel', 'activity', 'ready', 'error'] as const;
/** What the APK pushes. */
export const ANDROID_EVENTS = ['view', 'pay', 'toast', 'shell', 'scan'] as const;

/** The APK's own origin: the bundle, and the kiosk's media under /media/ (pos-android KioskWebAssets.kt). */
export const ANDROID_ORIGIN = 'https://appassets.androidplatform.net';
