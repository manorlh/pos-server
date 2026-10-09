# Live control — progress and the flag-on checklists

Branch `feat/live-control` (pos-server + dashboard) and the till's `feat/live-control`.

## Shipped with the flags off (Friday)

- "אזל" / "חסום" blocks with scope and duration, ending on the one business day (04:00); legacy
  tills see blocks set by hand only (`isAvailable`), updated tills and kiosks read `blocks`.
- Remote control of tills and kiosks (lock / unlock, message, sync, refresh catalog, sign out,
  restart, install update) with per-action permissions, area narrowing, expiry and unlock edges.
- Targets and the till leaderboard (till parameter, off by default).
- Atomic stock writes (one upsert per change), at shop level.
- Every migration (the stock-locations tables and trigger included) deploys with the release.

## `STOCK_LOCATIONS_ENABLED` — before turning it on (Saturday)

- [x] #4 the shop page's old endpoints write through `stock_admin.update`.
- [x] #6 targets after midnight counted once.
- [x] #7 a refund goes back to the original sale's location (flag on only).
- [x] #11 one daily reset per location per business day.
- [x] A4 the till's reconcile matches the server's absorb rule (strict `<`, `resetAt` only for "set").
- [ ] **S4 — TODO in the release that turns the flag on:** drop the deploy-window trigger
      `stock_location_defaults` (`stock_levels_location_defaults`, `stock_movements_location_defaults`)
      added by migration `7c4e2a9d1f63`: by then no build that writes stock rows without
      `target_id` is running. A new migration: `DROP TRIGGER IF EXISTS … ; DROP FUNCTION IF EXISTS
      stock_location_defaults();`.
- [ ] Turn the flag on per environment, then check: the levels wizard, transfers, opening stock and
      the reset worker, the leftover report and low-stock alerts appear and work.

## `REMOTE_TILL_Z_ENABLED` — remote shift close / Z (off)

- Server: `GET /device-commands/{id}/close-preview`, `POST /device-commands/close` (confirmed
  totals, `wait_for_rest`, never forced); migration `c6d2e8f4a1b7`.
- Dashboard: "סגירה / Z" per till in "שליטה מרחוק", only while the server says it is on.
- Till: honours `waitForRest` on `pendingTillZ` / `pendingCloseShift` and the pushes.
