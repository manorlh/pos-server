/**
 * Role module "מסך מטבח (KDS)": the kitchen screen of a KDS device (station / expo / manager), on
 * the cloud's KDS API — the feed and the ordered, durable outbox of the screen's actions (sent at
 * once, shown applied, retried in order with the same id, refusals said in Hebrew). Not a till.
 *
 * Shared with the browser KDS (`/kds` on the dashboard's site): the code lives in
 * client/src/lib/kdsScreenEngine.ts (docs/SPEC_KDS.md §9, §13).
 */
export {
  KdsModule,
  KDS_CACHE_KEY,
  KDS_OUTBOX_KEY,
  ERROR_SHOW_MS,
  SERVER_ERROR_TRIES,
  OUTBOX_MAX,
  QUEUED_TEXT,
  refusalCode,
  deliveryOf,
  backoffMs,
  kdsView,
  type KdsActionBody,
  type OutboxEntry,
  type Delivery,
  type KdsModuleOptions,
} from '@dash-lib/kdsScreenEngine';
