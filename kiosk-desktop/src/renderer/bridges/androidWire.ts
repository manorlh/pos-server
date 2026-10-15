/**
 * The Android bridge's version and names (bridges/android.ts), on their own with no imports — so
 * scripts/build-android-bundle.mjs (plain Node) can stamp the bundle's manifest with them. Pinned by
 * test/fixtures/android_bridge_api.json, the same bytes as pos-android's kiosk_web_bridge_api.json.
 */

/**
 * The bridge API this bundle needs (manifest.json `bridgeApi`); an APK that speaks less refuses the bundle. It stays 1:
 * what API 2 adds ("placeOpenOrder") is used only where the APK says it speaks it ([ANDROID_PLACE_OPEN_ORDER_API]),
 * so the same bundle still runs, as before, on an APK of API 1.
 */
export const ANDROID_BRIDGE_API = 1;

/** The newest bridge API this bundle speaks (the shared fixture's `bridgeApi`): used where `R2MAndroid.bridgeApi()` reaches it. */
export const ANDROID_WIRE_API = 2;

/** The first bridge API with "placeOpenOrder" ("תשלום בקופה" from the web screens, as the Windows kiosk's call). */
export const ANDROID_PLACE_OPEN_ORDER_API = 2;

/**
 * Calls that are answered ("placeOpenOrder": bridgeApi 2 only). "cashOwedChoice" / "cashSplit" (P:/specs/cash-paylink.md
 * §11.15, bridgeApi stays 2): called only on what the APK's `pay.cash` offers (`stage: "owed_choice"`, `canSplit`) — an
 * older APK never offers them.
 */
export const ANDROID_CALLS = [
  'bootstrap',
  'shellView',
  'startPayment',
  'cancelPayment',
  'receiptChoice',
  'helpRequest',
  'voucherApply',
  'voucherRemove',
  'placeOpenOrder',
  'cashOwedChoice',
  'cashSplit',
] as const;
/** One-way messages to the APK. */
export const ANDROID_SENDS = ['reportFlow', 'funnel', 'activity', 'ready', 'error'] as const;
/** What the APK pushes. */
export const ANDROID_EVENTS = ['view', 'pay', 'toast', 'shell', 'scan'] as const;

/** The APK's own origin: the bundle, and the kiosk's media under /media/ (pos-android KioskWebAssets.kt). */
export const ANDROID_ORIGIN = 'https://appassets.androidplatform.net';
