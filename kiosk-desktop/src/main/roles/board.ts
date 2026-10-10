/**
 * Role module "מסך מוכן / לא מוכן" (order status board): the pickup numbers in preparation and
 * ready, from the KDS feed of its own `pickup` KDS device — not a till. Shared with the browser
 * board (`/board` on the dashboard's site): the code lives in client/src/lib/kdsScreenEngine.ts.
 */
export { BoardModule, boardView } from '@dash-lib/kdsScreenEngine';
