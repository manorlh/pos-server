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

### "חסימת Z כשיש משמרות פתוחות" — `zRequireAllShiftsClosed` (same flag)

Till parameter, company → shop → area, **default on**; `app/services/z_shift_guard.py`. While
REMOTE_TILL_Z_ENABLED is off nothing applies and the tills receive it as `false`.

- On: the cloud shop Z run takes every till — none left out at the start (`open_tills_block_z`),
  "build without" refused (409 `z_requires_all_shifts_closed`), no build at expiry without a till,
  the master till's "סגור" refused. Blocking tills shown with their state (מנותקת / משמרת פתוחה /
  ממתין לקבלה) in the remote shop close and to the main till (`GET /sync/{m}/shop-z/shift-guard`).
- The main till's local shop Z (Android `LocalShopZRunner`): refused before the round for a till
  the round does not close, and after the round while the cloud still holds a shift open or
  unaccepted ("נסה שוב"). With no connection the LAN round's own word stands (every participant
  closed, none skipped) — decided, as the cloud cannot be asked.
- Force: super admin only (403), typed reason (422) — `POST /z-runs/{run}/force`,
  `POST /device-commands/shop-close/{run}/force`; the existing "build without": the Z's
  `openTillsLeftOut` lists each till with who / when / `forcedReason`, a `shop_z_producer_forced`
  exception records it, their shifts go into the next Z (numbering continues). Never in local mode.
- A till's own Z ("Z לכל קופה") is the till itself, its close part of the Z — unchanged. Support's Z
  for a dead till (`support_z.py`) was already the super admin's with reason and audit — unchanged.
- Off: exactly today's behaviour. Tests: `tests/test_z_shift_guard.py`, Android `LocalShopZTest`.

### Independent review (09.10) — fixed before the flag goes on

`tests/test_remote_z_review_fixes.py` (the reviewer's probes, inverted). Before turning the flag on:

- **Asked only by capability.** Remote close / Z / day close ask a till only when its heartbeat says
  `capabilities: ["remote_close_v2"]` (the build with every remote-close safeguard) — not a version
  count, which differs per branch. Otherwise: "הקופה צריכה עדכון גרסה לפני סגירה מרחוק". Kiosks are
  exempt (their own Z path): a Windows kiosk in the shop Z never holds the day close.
- [ ] Optional extra floor `REMOTE_TILL_Z_MIN_TILL_VERSION` (a till version code, e.g. the release
      APK's versionCode) — a non-numeric value stops the server at startup.
- Offline tills block only when their state is unknown. Last report "no shift open" with 0 documents
  pending, said by the till after the last shift the cloud saw for it, offline since: never blocks —
  "לא מחובר — המשמרת האחרונה סגורה", a one-line warning on the run, and — when the run does not take
  the till — recorded on the Z on its own line "קופות לא מחוברות (משמרת אחרונה סגורה): …". A shift
  it opened offline reaches the next Z the ordinary way: its open report or first document, then its
  close. Never reported, its last report had a shift open or documents pending, or its "closed" is
  older than its last shift on the cloud (an administrative close included — it no longer wipes the
  till's claim): "מצב לא ידוע — ייתכן שיש משמרת פתוחה" (or "מנותקת · משמרת פתוחה"), blocks; only a
  super admin starts anyway, with a typed reason (recorded as `z_forced_open_shifts`).
- The main till always asks the cloud before its local shop Z, whatever its own parameter says;
  the cloud's shop-level answer decides — skipped when the till knows it is offline, short timeouts
  otherwise; no answer: the LAN round decides.
- The force passes the open-shifts rule only, and is offered only when that rule is what blocks;
  "חובה לסגור את כל הקופות" and local mode keep their own rules and paths.
- Realtime pushes to tills (close-shift, till Z) go only after the commit; a till never marks a
  request done on a 404 (it retries).

**Intentional improvements that apply with the flag off too** (the verification accepted them in the
safe direction): one start of a shop's Z at a time (advisory lock); a cancel withdraws the kiosks asked
to close with the shop Z and records who cancelled; the wizard's "build without" prints who approved
it; the tills re-check "at rest" right before closing, drop stale realtime replays and stop retrying a
cancelled request; the main till asks the cloud before its local shop Z; pushes after the commit.

### Configuration matrix — remote close as configured (`tests/test_remote_close_matrix.py`)

Every row is a test. "Offered" = shown on the dashboard; "allowed" = the server accepts it.

**Parameters** (each at company only, shop over company, area over shop — the nearest level wins;
a shop Z reads the shop's value, an area Z its area's):

| Parameter | Default | On | Off |
| --- | --- | --- | --- |
| `zRequireAllShiftsClosed` "חסימת Z כשיש משמרות פתוחות" | on | No Z while a till is open / not accepted / unknown; no "build without"; support may force with a reason | As before |
| `allowCloseWithHeldSales` "סגירה עם מכירות מושהות" | off | Till: "סגור והשאר מושהות"; dashboard: "סגור בכל זאת — המכירות המושהות יישמרו" for a manager | Till: close only once every held sale is paid or cancelled; dashboard: support only, with a reason |
| `remoteCancelHeldSales` "ביטול מכירות מושהות מהענן בסגירה מרחוק" | on | "בטל מכירות מושהות וסגור" offered (Z edit + reason; exactly the listed sales) | Not offered; refused "בסניף כבוי ..."; the till ignores such a command |

**Till configuration** ("סגירת יום סניפית"):

| Configuration | Day close | Source shown | Per till |
| --- | --- | --- | --- |
| Every till in the shop Z, cloud | Offered, allowed | "יופק בענן" | Shift close |
| Every till its own Z | Not offered: "אין בסניף קופות ב-Z הסניפי (כל הקופות מפיקות Z משלהן)" | — | Its own Z, its next number |
| Mixed | Offered; takes only the shop-Z tills | "יופק בענן" | Shift close / its own Z |
| `shopZFrom` main till, main till online | "לא זמין עדיין: …" | "יופק בקופה הראשית: …" | Shift close |
| `shopZFrom` main till, main till offline | Offered, allowed (the existing rule) | "יופק בענן" | Shift close |
| Local mode | "לא זמין עדיין: …" | "יופק בקופה הראשית: …" | "לא זמין עדיין: ברשת מקומית המשמרות נסגרות דרך הקופה הראשית" |
| `zScope = machine` | "לא זמין עדיין: העסק מוגדר ל-Z נפרד לכל קופה …" | "יופק בענן" | — |
| Kiosk in the shop Z | Offered, allowed; never held by the kiosk's version | "יופק בענן" | "קיוסק — מלשונית הקיוסקים" |
| Kiosk with its own Z | Offered, allowed; "close with the shop Z" shown | "יופק בענן" | "קיוסק — מלשונית הקיוסקים" |

**Each till's state** (all-cloud shop, `zRequireAllShiftsClosed` on):

| Till state | Day close | Shown |
| --- | --- | --- |
| At rest | Allowed; it closes | "נסגר" |
| Open sale (basket, payment, card in flight) | Allowed; the till waits | "ממתין למכירה פתוחה" — neither held-sales option closes over it |
| Held sales | Allowed; the till waits | "ממתין — מכירות מושהות (N)" + the list; "בטל מכירות מושהות וסגור" / "סגור בכל זאת — המכירות המושהות יישמרו" per the parameters |
| Offline, last report "no shift open", 0 pending, after its last shift | Allowed; never waits for it | "לא מחובר — המשמרת האחרונה סגורה"; a warning on the run; on the Z's own line when not taken |
| Offline with an open shift | Allowed to start; waits for it; "build without" refused | "מנותקת · משמרת פתוחה"; support may force with a reason |
| Offline, state unknown (never reported, open / pending last report, or "closed" older than its last shift) | Not allowed to start | "מצב לא ידוע — ייתכן שיש משמרת פתוחה"; support may start anyway with a reason |
| Old app without `remote_close_v2` | Not allowed | "הקופה צריכה עדכון גרסה לפני סגירה מרחוק" (kiosks exempt) |

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
