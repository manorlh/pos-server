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
      Only the server's env changes (`STOCK_LOCATIONS_ENABLED=true`): the dashboard reads
      `GET /stock/features`, the tills read each product's location (`level`, `targetId`) from their
      stock sync. `STOCK_RESET_WORKER_ENABLED` stays at its default (on) on at least one instance; it
      does nothing while the flag is off, and two instances never reset a location twice (#11).
- [ ] Decide: the insights' stock (low stock, anomalies — `insights/data.py` `load_stock`) sums each
      shop's locations (shop, points of sale, devices); a product managed only at the **company**
      level (its rows have no shop) is not counted there. Fine for Saturday if no product is managed
      at the company level only; otherwise count the company's rows for its shops.

## `REMOTE_TILL_Z_ENABLED` — remote shift close / Z (off)

- Server: `GET /device-commands/{id}/close-preview`, `POST /device-commands/close` (confirmed
  totals, `wait_for_rest`, never forced); migration `c6d2e8f4a1b7`.
- Dashboard: "סגירה / Z" per till in "שליטה מרחוק", only while the server says it is on.
- Till: honours `waitForRest` on `pendingTillZ` / `pendingCloseShift` and the pushes.

### "סגירת יום סניפית" — by the shop's configuration

Server `GET /device-commands/shop-close-preview`, `POST /device-commands/shop-close`,
`GET|POST /device-commands/shop-close/{run}[/proceed|/cancel]`; migration `d7f3a1c9e5b2`
(`z_runs.wait_for_rest`). Dashboard: an inline panel at the top of "שליטה מרחוק" (shop scope),
non-blocking. Each till's request also reads as a device command (`commands`, the shape of
`device_commands.command_out`). Tests: `tests/test_remote_shop_close.py`.

| Configuration (as set in the system) | From remote control |
| --- | --- |
| Every till in the shop Z (`zMode = cloud`), the shop Z produced in the cloud | **Covered.** One action; the existing Z run through the wizard's own path; each till closes at rest; Z numbered strictly next |
| Mixed (some tills `zMode = till`) | **Covered.** The run takes exactly the shop-Z tills; the others keep their own remote Z and number |
| Every till with its own Z / independent tills | **Covered.** No shop close ("אין בסניף קופות ב-Z הסניפי"); per-till remote Z with its next number |
| Kiosks in the shop Z / with their own Z / "close with the shop Z" | **Covered.** In the run when in the shop Z; their own Z otherwise, the setting shown; the run's kiosk hook unchanged |
| `shopZFrom` = main till only, main till online (not local mode) | **לא זמין עדיין** — shown "יופק בקופה הראשית: …" with why (the dashboard may not start that shop's Z) |
| `shopZFrom` = main only, main till offline | **Covered** — the existing rule: the dashboard may produce it, so may remote control |
| Local mode (a main till on the LAN produces the shop Z) | **לא זמין עדיין** — the main till's LAN round closes the tills itself (it parks open baskets), so "never mid-sale" can't be promised from here yet; a till's own shift close in local mode likewise |
| One till per Z for the business (`zScope = machine`) | **לא זמין עדיין** — the wizard does it till by till |
| A till offline | Covered: the run waits for it, shown "לא מחובר — ממתין שיתחבר"; "הפק בלי" only where the existing `proceed_without` allows (not under "חובה לסגור את כל הקופות", never in local mode) |
| A sale open / cancel mid-way | Covered: the till defers (`sale_open`, "ממתין למכירה פתוחה") and is asked again each beat; cancel ends the run, no Z, no number taken; closed shifts go to the next Z with the next number |
| Shift modes | Shifts are per device; there is no per-cashier shift mode in the system |

## Saturday — decided at the Friday integration (09.10)

The coordinator's decisions on the `integration/fri` merge; event-live's and the vouchers' items
are kept here too, as this is the release's progress file.

- [ ] **Event targets: one owner.** live-control's `sales_targets` becomes the single source of an
      event's target, through event-live's `register_target_provider`
      (`app/services/report_events/targets.py`; nothing registers it yet). The live screen's own
      typed target (`report_events.live_target`) is used only when the event has no sales target,
      and `target_reached` gets one alert source. Today two places can raise it: live-control's
      sales-target hits (`app/services/sales_targets.py`) and event-live's live-screen target
      (`exception_alerts/external.py` `report_target_reached`). `exception_alerts/catalog.py` has
      the one kind.
- [ ] **Producer settlement by the production's billing basis.** event-live's "עמדת מפיק"
      settlement (`app/services/report_events/producer.py` `settlement`) bills every batch by
      redemption. It should follow the production's `billing_basis` (`prepaid_productions`:
      `redemption` / `delivery`), ideally by reading voucher-extras' settlement service
      (`app/services/prepaid_voucher_settlement.py`) instead of computing its own amounts. No
      exposure today: an event's settlement for its producer is off by default, and switching it
      on takes `prepaid_voucher_prices`. The producer is shown a batch's own production price only
      while the owner who switched it on holds that section.
