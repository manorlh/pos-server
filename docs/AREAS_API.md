# Shop areas — requirements and API contract

Status: the contract the server (`feat/shop-areas`), the dashboard (`feat/shop-areas-ui`) and
the till (pos-android `feat/shop-areas`) build against. Conventions are those of
`SHIFTS_API.md` (prefix `/api/v1`, camelCase JSON, UUID strings, `{"detail": ...}` errors,
`detail` codes split on the first `:`).

## 0. What an area is (decided 2026-09-29)

- An **area** groups tills inside one shop: bar, kitchen, terrace, second floor.
- An area belongs to **exactly one shop**. A till is in **at most one area** (or unassigned).
- Areas are **archived, never deleted** — old shifts, Zs and reports keep pointing at them.
- An area is a **filter over the shop's tills, not a new fiscal scope.** A "Z for an area" is
  an ordinary shop Z run whose till list is the area's tills: same per-shop gapless Z number,
  same through-shift rules, same remote close. `zScope` is untouched; there is no area
  sequence.
- **History is stamped, not joined.** A shift records the till's area *when the shift is
  created in the cloud*. Every area report filters on the shift's stamped area, never the
  till's current one — moving a till must never rewrite past totals. A till moved while a
  shift is open takes the new area from its **next** shift.
- Future (not in this release): applying configuration to the tills of an area (a settings
  layer between shop and till). Nothing here may make that harder — keep area membership a
  plain `pos_machines.area_id`.

## 1. Data

- `shop_areas`: `id`, `tenant_id`, `shop_id` (FK, not null), `name` (≤100, trimmed, not
  empty), `sort_order` int default 0, `archived_at` nullable, `created_at`, `updated_at`.
  Name unique per shop among **non-archived** areas, case-insensitive (partial unique index
  on `(shop_id, lower(name)) WHERE archived_at IS NULL`).
- `pos_machines.area_id` nullable FK → `shop_areas.id`. Invariant: the area's `shop_id` equals
  the machine's `shop_id`. Any code path that changes a machine's shop (PUT machine, assign,
  adopt/replacement, unpair/retire) clears `area_id` unless the new shop is the area's shop.
- `shifts.area_id` nullable FK, set in `app/services/shifts.py::_new_shift` from
  `machine.area_id` and never updated afterwards.
- `z_runs.area_id` and `z_reports.area_id` nullable FK. The Z's frozen `header` gains
  `areaId` and `areaName` (null for a whole-shop / hand-picked Z).
- Alembic: one migration, down-revision = current head on main.

## 2. Dashboard API

Permissions: reading areas = whoever may read the shop; writing areas and assigning tills =
whoever may `PUT /shops/{shopId}` (reuse that check — do not invent a new role). Tenant
isolation as everywhere else.

### 2.1 Areas

- `GET /shops/{shopId}/areas?includeArchived=false` →
  `[{id, shopId, name, sortOrder, archivedAt, machineCount, status}]`, ordered by
  `sortOrder, name`. `machineCount` counts active machines currently in the area.
  `status` is the roll-up (§2.4).
- `POST /shops/{shopId}/areas` `{name, sortOrder?}` → `201` area. `409 area_name_taken`.
- `PATCH /areas/{areaId}` `{name?, sortOrder?}` → area. `409 area_name_taken`,
  `409 area_archived` (rename of an archived area is refused; restore first).
- `POST /areas/{areaId}/archive` → area. `409 area_has_machines` while any active machine
  is in it. Idempotent.
- `POST /areas/{areaId}/restore` → area. `409 area_name_taken` if a live area took the name.
- `PUT /areas/{areaId}/machines` `{machineIds: [...]}` → area with machines. Sets the
  area's membership to exactly this list: listed machines join (from unassigned or another
  area of the same shop), machines previously in it and not listed become unassigned.
  `400 machine_not_in_shop:<id>`, `409 area_archived`.

### 2.2 Machines

- `POSMachineResponse` gains `areaId` and `areaName` (null when unassigned).
- `PUT /machines/{id}` accepts `areaId` (explicit `null` clears; omitted = unchanged).
  `400 area_not_in_machine_shop`, `409 area_archived`.
- `GET /machines?areaId=<uuid|none>` filters (`none` = unassigned).
- Any change of a machine's area, and any rename of an area, notifies the affected tills the
  same way a settings change does, so they refetch §3.

### 2.3 Shifts, Z runs, Z reports, reports

- `ShiftOut` gains `areaId`, `areaName`. `GET /shifts?areaId=<uuid|none>` filters on the
  **stamped** area.
- Z candidates (`GET` in `routers/z_runs.py`) accept `?areaId=<uuid>`: only tills currently
  in that area are returned.
- `ZRunCreateIn` gains optional `areaId`. When set: the area must be in `shopId`
  (`400 area_not_in_shop`) and not archived (`409 area_archived`), and every listed machine
  must be currently in that area (`400 machine_not_in_area:<id>`). The user may still drop
  tills from the list. The run and its Z record `area_id`; the header freezes the name.
  `ZRunOut`, Z report list and detail responses gain `areaId`, `areaName`.
  Note: the Z still takes each till's shifts through the chosen shift, whatever area those
  shifts are stamped with (a till moved mid-cycle) — the Z is about the till; the area
  reports are about the stamp.
- `GET /z-reports?areaId=<uuid|none>` filters.
- Every existing sales report endpoint in `routers/reports.py` that filters by shop/machine
  gains `areaId=<uuid|none>`, filtering transactions via their shift's stamped area.
  Transactions with no shift fall under `none`.
- New `GET /reports/sales-by-area?shopId=&dateFrom=&dateTo=` → one row per area of the shop
  that had sales in the window (archived included, flagged) plus an `Unassigned` row
  (`areaId: null`) when non-zero: `{areaId, areaName, archived, transactionsCount, gross,
  discounts, net, refunds, cash, card, other, tips}` and a `totals` row. The rows must sum
  exactly to the shop total for the same window — a test asserts it. Use the same money
  definitions as the existing shop sales report; do not invent new ones.
  Export: CSV of the same rows (either a `format=csv` variant or client-side from the JSON —
  follow whatever the existing reports already do).

### 2.4 Area status roll-up

`status` on an area: `{worst, counts}` where `counts` maps **every** primary status value
from `app/services/machine_status.py` (`not_paired`, `retired`, `offline_with_unsynced`,
`no_open_shift`, `offline`, `pending_sync`, `shift_close_pending`, `online` — zeros
included) to how many of the area's active machines have it, and `worst` is the most
severe by the `ROLLUP_SEVERITY` order defined **in machine_status.py** (highest first:
`offline_with_unsynced`, `offline`, `shift_close_pending`, `pending_sync`,
`no_open_shift`, `online`; `retired` and `not_paired` are excluded). `worst` is null for an
empty area (or one holding only unpaired tills). The dashboard renders it and never
re-derives it.

## 3. Till

- `GET /machines/me` and `GET /sync/{machineId}/settings` gain `area: {id, name} | null`.
- The till stores it with its other synced settings and shows it where the till's own name
  is shown (settings / device info) and on the printed and on-screen X under the till
  name: `אזור: <name>` / `Area: <name>`. Nothing else on the till changes: the till never
  sends an area, never filters by it, and an older server without the field means "no area".
- The X records the area name it printed (so a reprint shows the same area even after a
  move or rename).

## 4. Out of scope for this release

Area managers as a role; configuration per area; a till in several areas; free tags.

## Deviations (server, `feat/shop-areas`)

What the server does where this contract was silent, impossible, or wrong. Everything
else is implemented as written above.

1. **§2.4 status names.** The contract first named `close_pending` and `day_closed`, which
   are not values of `machine_status.py`. The real ones are used: `shift_close_pending`
   and `no_open_shift` (fixed in §2.4 above). `counts` always carries all eight keys.
2. **Area response shape.** Every area response (list, create, patch, archive, restore,
   membership) is `{id, shopId, name, sortOrder, archivedAt, machineCount, status,
   machines, createdAt, updatedAt}`, where `machines` is the area's active tills
   `[{id, name, posNumber, status}]` — not only on `PUT …/machines`.
3. **Extra column `pos_machines.area_changed_at`.** Set whenever a till's area changes. The
   settings watermark (`settingsUpdatedAt`) is `max(shop/company/tenant stamps,
   area_changed_at, area.updated_at)`, so after the "settings" notification a delta pull
   (`since=`) returns the new area instead of `unchanged`. Membership is still only
   `pos_machines.area_id`.
4. **`area` on every settings response.** `GET /sync/{id}/settings` carries top-level
   `area: {id, name} | null` on `full`, `delta` **and** `unchanged` responses (and on the
   no-shop responses, where it is null), so the value is always the current truth.
5. **Retiring clears the area.** `PUT /machines/{id}` with `isActive: false` also takes the
   till out of its area (an area counts active tills only, and an archived area must not
   hold a till that is later reactivated). Archiving an area also clears any retired till
   still pointing at it. A replacement device (`adopt`) keeps the till's area, like its
   shop and register number.
6. **Membership refusals.** In `PUT /areas/{id}/machines`, an unknown id, another shop's or
   tenant's till, and a retired till are all `400 machine_not_in_shop:<id>`; nothing is
   changed when any id is refused. Re-sending the same list changes and notifies nothing.
7. **Unknown or foreign area ids** are `400 area_not_in_machine_shop` (`PUT /machines`) and
   `400 area_not_in_shop` (`POST /z-runs`, `GET …/z-candidates?areaId=`), never a 404 or a
   403 that would confirm another tenant's area exists. An unknown area on an `/areas/{id}`
   route is `404 Area not found`; another tenant's is `403 tenant_forbidden`, as for shops.
8. **Validation.** A name that is empty after trimming, longer than 100, or missing is a
   `422`. An `areaId` filter that is neither a UUID nor `none` is a `422`. `PATCH` with the
   area's current name is not a rename (allowed on an archived area); a `sortOrder`
   change on an archived area is allowed.
9. **Z candidates** also return top-level `areaId`/`areaName` (echo of the filter) and, per
   till, `areaId`/`areaName` (its area now).
10. **Z names.** `ZRunOut.areaName` is the area's name until the Z is built, then the name
    frozen in the Z's header. Z list and detail `areaName` is always the frozen header name;
    the detail's `business` object carries `areaId` and `areaName` too. The header of a
    whole-shop Z has both keys present and null. `ShiftOut.areaName` is the stamped area's
    **current** name (the stamp is the id; a shift has no frozen header).
11. **`GET /z-reports?areaId=`** filters on the area the Z was run for (`z_reports.area_id`);
    `none` is every whole-shop, hand-picked and legacy Z.
12. **Sales by area.** `GET /reports/sales-by-area?shopId=&dateFrom=&dateTo=` also accepts
    `from`/`to` (the other reports' names) and `fromHour`/`toHour`/`tz`. Response:
    `{shopId, dateFrom, dateTo, window, generatedAt, rows, totals}`. The Unassigned row and
    the `totals` row have `areaId: null` and `areaName: null` (the dashboard labels them).
    `transactionsCount` is sales + credit notes (the cashier report's `documentCount`).
    Money is the per-cashier report's definitions (one shared function), as floats rounded
    to the agora; the totals are the sum of the rows and equal the cashier report's shop
    totals. No server-side CSV exists for any report, so the export is client-side.
13. **`GET /reports/day-summary` has no `areaId`.** It is built from Z reports, not
    documents, so "documents of an area" does not apply; `GET /z-reports?areaId=` answers
    the Z side. `products`, `cashiers` and `tips` have `areaId=<uuid|none>`.
14. **Deleting a shop** (only possible when nothing fiscal references it) deletes its areas
    with it (`shop_areas.shop_id … ON DELETE CASCADE`).
15. **Permissions** are exactly `PUT /shops/{id}`'s (`_check_shop_override_write`): that
    check refuses only cashiers, so a shift supervisor of the shop may write its areas, as
    it may edit the shop itself today.

