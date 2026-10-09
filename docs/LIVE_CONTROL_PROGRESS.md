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

## Saturday — decided at the Friday integration (09.10)

The coordinator's decisions on the `integration/fri` merge; event-live's and the vouchers' items
are kept here too, as this is the release's progress file.

- [x] **Event targets: one owner.** (feat/event-followups — the live screen reads the event's shop
      sales target first, its "הגדרת יעד" writes that target, migration `7f2e55223360` moves every
      typed `live_target` into one, and `target_reached` comes from the sales-target hits only.) live-control's `sales_targets` becomes the single source of an
      event's target, through event-live's `register_target_provider`
      (`app/services/report_events/targets.py`; nothing registers it yet). The live screen's own
      typed target (`report_events.live_target`) is used only when the event has no sales target,
      and `target_reached` gets one alert source. Today two places can raise it: live-control's
      sales-target hits (`app/services/sales_targets.py`) and event-live's live-screen target
      (`exception_alerts/external.py` `report_target_reached`). `exception_alerts/catalog.py` has
      the one kind.
- [x] **Producer settlement by the production's billing basis.** (feat/event-followups — through
      `prepaid_voucher_settlement.batch_figures`: an active agreement written for the event, else
      each batch's production's `billing_basis` over the event; the price rule kept.) event-live's "עמדת מפיק"
      settlement (`app/services/report_events/producer.py` `settlement`) bills every batch by
      redemption. It should follow the production's `billing_basis` (`prepaid_productions`:
      `redemption` / `delivery`), ideally by reading voucher-extras' settlement service
      (`app/services/prepaid_voucher_settlement.py`) instead of computing its own amounts. No
      exposure today: an event's settlement for its producer is off by default, and switching it
      on takes `prepaid_voucher_prices`. The producer is shown a batch's own production price only
      while the owner who switched it on holds that section.
