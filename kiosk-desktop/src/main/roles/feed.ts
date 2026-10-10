/**
 * The KDS feed (`GET /sync/{m}/kds/board?since=` every 3 s, the last board kept in the kv) — shared
 * with the browser screens at `/kds` and `/board`: the code lives in
 * client/src/lib/kdsScreenEngine.ts. This shell gives it its SQLite kv and its Api (RoleContext).
 */
export { KdsFeed, OFFLINE_AFTER_MS, type FeedState } from '@dash-lib/kdsScreenEngine';
