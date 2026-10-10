/**
 * The pre-payment check (pos-server docs/SPEC_KIOSK_INSIGHTS.md §5): never charge a total the
 * customer did not see. Shared with the browser kiosk (`/k` on the dashboard's site): the code
 * lives in client/src/lib/kioskBasketCheck.ts — one set of rules for both (the Android kiosk's
 * domain/KioskPriceCheck.kt is its twin).
 */
export * from '@dash-lib/kioskBasketCheck';
