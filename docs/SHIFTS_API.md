# Shifts and cloud Z — API contract

Status: the contract the till (pos-android `feat/shifts`) and the dashboard build against.
Spec: `pos-android/docs/shifts-plan.md` §4.4–§4.6. Owner: the pos-server `feat/shifts` branch.
Anything here that differs from the plan is called out under **Deviations** at the end.

Conventions

- Prefix: `/api/v1`. Till calls use the machine JWT (`Authorization: Bearer <machine token>`);
  `{machineId}` in the path must be the token's machine (403 otherwise).
- JSON keys are camelCase. Ids are UUID strings. Timestamps are ISO-8601 with offset.
  `businessDate` is `YYYY-MM-DD` (the till's local date the shift opened).
- **Money:** inputs accept a JSON number or a decimal string. **Responses return money as
  decimal strings** (`"123.40"`) — that is how the server's Decimal serialises. Parse them
  as decimals, never floats.
- `null` always means "unknown / not counted / not applicable", never zero.
- **Absent = null.** The till's encoder drops null fields, so every nullable request field
  may be omitted and an omitted field is read exactly as `null` (e.g. no `countedCash` =
  not counted; no `openShiftId` on the heartbeat = no shift open). Never 0, never a 422.
- Errors are `{"detail": ...}`. Where `detail` is a string with a `:` suffix
  (`another_shift_open:<id>`), split on the first `:`.

---

## 1. Till → cloud

### 1.1 `POST /sync/{machineId}/shifts` — report an opened shift

The till opens shifts on its own (offline too) and reports them. Idempotent by `id`.

Request
```json
{
  "id": "5b0c…",                 // till-generated, required
  "businessDate": "2026-09-27",  // required
  "sequenceNumber": 12,          // per-till counter, required for new tills (nullable accepted)
  "openedAt": "2026-09-27T06:01:12+03:00",  // required
  "openingCash": 500.00,         // float counted into the drawer; null = not entered
  "openedByUserId": "…",         // the till user's id (pos_users id as the till knows it); string, nullable
  "openedByName": "דנה"           // display name, nullable
}
```

Responses
- `200` → **Shift** object (§3.1). Cases:
  - unknown id → created `open`;
  - known and still open → `openedAt`, `openingCash`, `openedByUserId`, `openedByName`,
    `sequenceNumber` are corrected from the body (a sale can beat this event to the cloud and
    create the shift with inferred values); `businessDate` is kept;
  - known and closed → returned untouched.
- `409 {"detail": "another_shift_open:<openShiftId>"}` — the cloud still has a different
  shift of this till open. With a strictly ordered outbox this means the previous shift's
  close has not been accepted yet: deliver it first, then retry this.
- `403 {"detail": "shift_belongs_to_another_machine"}`.
- `400 {"detail": "Machine must be assigned to a shop"}` (as every sync write).

### 1.2 `POST /sync/{machineId}/transactions` — documents

As today, with two renames on each document: `tradingDayId` → **`shiftId`**, `dayDate` →
**`businessDate`**. The old names are no longer read.

Shift resolution per document:
- `shiftId` known → the document belongs to it (a re-push of an existing document with a
  different `shiftId` moves it, unless its current shift is already in a Z — then it stays).
- `shiftId` unknown and **no** shift of this till is open → that shift is created `open`
  from the document (`businessDate`, `openedAt` = document `createdAt`).
- `shiftId` unknown while **another** shift of this till is open → **the whole batch is
  refused, nothing is written:**
  ```json
  409 {"detail": "another_shift_open", "openShiftId": "<id>", "unknownShiftIds": ["<id>", …]}
  ```
  Retryable: deliver the open shift's close (and the new shift's open) first, then resend.
  The server never "adopts" the open shift any more — that is what silently put shift N+1's
  sales into shift N.
- `shiftId` absent (legacy) → the till's open shift, else a new one.

`200` body unchanged: `{"serverTime", "results": [{"id", "status": "accepted|duplicate|rejected", "reason"?, "serverReceivedAt"?}]}`.

### 1.3 `POST /sync/{machineId}/shifts/{shiftId}/close` — close a shift (X)

Sent after the shift's documents (outbox order: open(N) → documents(N) → close(N) → open(N+1)).
A shift is `closed` on the cloud only when this is accepted, and that needs every listed
document on the cloud. **It creates no Z.**

Request
```json
{
  "closedAt": "2026-09-27T15:02:00+03:00",   // required
  "closedByUserId": "…", "closedByName": "…", // nullable
  "unattended": false,          // true = closed remotely with nobody at the drawer
  "countedCash": 1234.50,       // null/absent = not counted (always null when unattended; the server enforces it)
  "expectedCash": 1210.00,      // the till's own expected drawer (opening + cash + cash tips)
  "transactionIds": ["…", "…"], // every document of this shift, required (may be empty)
  "lastTransactionNumber": "1043", // nullable
  "till": {                      // the till's X figures, stored verbatim for audit (§3.3 keys)
    "totalSales": 3400.00,       // GROSS: Σ totalAmount of sales, before document discounts
    "totalDiscounts": 25.00,     // optional: Σ documentDiscount of sales
    "totalRefunds": 50.00,
    "totalCash": 710.00, "totalCard": 2640.00,
    "totalTips": 20.00, "vatTotal": 510.93,
    "transactionsCount": 41
  },
  "closeRequestId": "…",         // the requestId of a remote close-shift instruction, else null/absent

  // Optional, recommended: lets the cloud create the shift if its open event was lost.
  "businessDate": "2026-09-27", "sequenceNumber": 12, "openedAt": "…",
  "openingCash": 500.00, "openedByUserId": "…", "openedByName": "…"
}
```

Optional header `X-Elevation-Token`: a grant with scope `shift:close` (a cashier may close
alone, so this is never demanded). When presented it is checked strictly (401
`elevation_expired`/`elevation_*` on a bad one) and consumed only when the close is accepted;
the approver is recorded on the shift.

Responses
- `200`
  ```json
  {
    "status": "accepted",        // or "duplicate" (already closed: nothing is rewritten)
    "shiftId": "…",
    "serverTotals": { …§3.2… },  // recomputed by the server from the documents it holds
    "totalsMismatch": false,     // true if any §3.3 key sent in `till` differs from the server by > 0.01
    "zReportId": null, "zNumber": null,  // set once the shift is in a Z (a duplicate may carry them)
    "serverTime": "…"
  }
  ```
- `409` — documents not on the cloud yet. Push them, then retry the close (same loop as the old Z):
  ```json
  {"detail": "missing_transactions", "missingIds": ["…"], "staleIds": ["…"]}
  ```
  `staleIds`: documents the cloud holds under a *different* shift (still open or closed but
  not in a Z). Re-pushing them (they carry this `shiftId`) moves them; treat them like
  missing ones.
- `409 {"detail": "shift_unknown"}` — the cloud has never heard of this shift and the body
  did not carry `businessDate` + `openedAt`. Send the open (§1.1), then retry.
- `403 {"detail": "shift_belongs_to_another_machine"}`.

A close for a shift that was closed administratively (dead-till recovery, §2.9) returns
`200 duplicate` with that shift's figures. When the close answers a remote instruction
(`closeRequestId`) and it was the last till the Z run waited for, the Z is built in the same
request and `zReportId`/`zNumber` are already set in this response.

Till behaviour this contract assumes (confirmed by the till side): the open fields are
repeated in every close; `staleIds` are re-pushed like `missingIds`; `zReportId`/`zNumber`
are read from any 200 (a duplicate included); an ack answered 404 or 410 is dropped.

### 1.4 `POST /sync/{machineId}/shift-close/ack` — acknowledge a remote close instruction

```json
{
  "requestId": "…",             // from the Ably event / heartbeat
  "phase": "received",          // received | deferred | completed | failed
  "shiftId": "…",               // the shift the till is closing / closed (nullable on failed)
  "errorCode": "card_in_flight", // optional, for deferred/failed
  "errorMessage": "…"            // optional
}
```
- `received`: the till has the instruction (item → `closing`).
- `deferred`: the till cannot close yet; it will retry by itself. The till sends
  `errorCode: "card_in_flight"` for a card payment in flight. The item becomes `closing`
  and `errorCode`/`errorMessage` are shown to the operator.
- `completed`: informational — the item only becomes ready when the **close** (§1.3) is
  accepted with all documents; an ack alone never makes it ready.
- `failed`: the till gave up (item → `failed`).

`200 {"ok": true, "itemStatus": "<z-run item status>"}`; `404 {"detail": "close_request_not_found"}`.
An ack for a cancelled/expired/finished run is accepted and changes nothing.

### 1.5 `GET /sync/{machineId}/shifts/last-closed`

Prefills the next opening float when the till has no local row (e.g. after reinstall).
```json
{
  "shiftId": "…", "sequenceNumber": 11, "businessDate": "2026-09-27",
  "closedAt": "…", "countedCash": "1234.50", "expectedCash": "1210.00",
  "reconstructed": false
}
```
All fields `null` (and `reconstructed: false`) when this till has never closed a shift. Always 200.
Prefill rule on the till: `countedCash`, else `expectedCash`.

### 1.6 Heartbeat `POST /machines/me/heartbeat`

Request adds (both optional; null **or absent** = "no shift open" — the claim is replaced
on every beat):
```json
{ "openShiftId": "…", "openShiftOpenedAt": "…" }
```
Response
```json
{
  "ok": true,
  "serverTime": "…",
  "zReportedThroughSequence": 11,   // highest sequenceNumber of this till's shifts that is in a Z; null if none. Always present.
  "pendingCloseShift": {"requestId": "…", "shiftId": "…"}   // only when a remote close is waiting for this till
}
```
`pendingCloseDay` is gone. The till purges synced documents of shifts with
`sequenceNumber <= zReportedThroughSequence`. `pendingCloseShift` is repeated on every beat
until the till's close is accepted (or the run ends), so the till must dedupe by `requestId`.

### 1.7 Ably event `close-shift`

On channel `pos:{tenantId}:{machineId}`:
```json
{"serverTime": "…", "requestId": "…", "shiftId": "…", "initiatedBy": "manager name"}
```
Same instruction as `pendingCloseShift`; the till must treat both idempotently by `requestId`.
`shiftId` is the shift the cloud believes is open (may be null if the cloud has not seen the
open yet — close whatever is open, and send its id in the ack).

### 1.8 Removed — `410 {"detail": "upgrade_required"}`

`POST /sync/{m}/trading-day`, `GET /sync/{m}/trading-day/current`, `POST /sync/{m}/z-report`,
`POST /sync/{m}/close-day/ack`, `GET /sync/{m}/last-close`. Still authenticated first.

---

## 2. Dashboard → cloud

User JWT + `X-Tenant-Id`. Role scoping as the rest of the dashboard (shop-scoped roles see
their shop, company managers their company tree, distributors their machines).
**Producing a Z** (z-runs create/proceed/cancel, administrative close) needs the roles that
could close a day before: `company_manager`, `shop_manager`, `distributor`, `super_admin`
(`get_current_machine_admin`). Reading shifts / Z reports needs any signed-in role that can
see the shop.

### 2.1 `GET /shifts`
Query: `shopId`, `machineId`, `status` (`open|closed`), `awaitingZ` (`true` = closed and not
in a Z), `from`, `to` (on `businessDate`), `page` (1), `pageSize` (50, max 200).
`200 {"page", "pageSize", "total", "items": [Shift + {"machineName", "shopName"}]}` ordered by
`businessDate desc, openedAt desc`.

### 2.2 `GET /shifts/{id}`
`200` Shift + `machineName`, `shopName`, `paymentBreakdown` (server, from documents) · `404`.

### 2.3 `GET /shops/{shopId}/z-candidates`
```json
{
  "shopId": "…", "shopName": "…", "zScope": "shop",   // or "machine": one till per Z
  "machines": [{
    "machineId": "…", "machineName": "…", "posNumber": "2",
    "online": true, "status": "online", "pendingDocuments": 0, "pendingAsOf": "…",
    "openShift": ShiftSummary | null,
    "tillReportedOpenShiftId": "…" | null,   // from the heartbeat (the cloud may not have the open yet)
    "closedShifts": [ShiftSummary, …],         // closed and not in a Z, oldest first (sequenceNumber, then openedAt)
    "activeRun": {"runId": "…", "itemStatus": "waiting_close"} | null
  }]
}
```
Only active, assigned tills of the shop. `ShiftSummary` = §3.1 without `tillTotals` /
`reconstructionBasis`.

### 2.4 `POST /z-runs`
```json
{
  "shopId": "…",
  "machines": [{"machineId": "…", "throughShiftId": "…" , "includeOpenShift": true}],
  "businessDate": "2026-09-27"   // optional; default = shop-local date of the latest included shift
}
```
- `throughShiftId` omitted/null = all of this till's closed un-Z'd shifts. When given it must
  be one of them; every older one is included too (no gaps, D4).
- `includeOpenShift` omitted = `true` when the till has an open shift (the cloud's, or the
  one the till reports on its heartbeat). When true the cloud sends `close-shift` (Ably
  now if the till is online, heartbeat on its next beat) and the item waits for that close.
  An `includeOpenShift` run always takes *all* closed shifts of that till plus the open one
  (a `throughShiftId` is then refused with 400 `through_shift_with_open_shift`).
- `201` → **ZRun** (§3.4). When nothing needs closing the Z is built in the same request and
  the run comes back `completed` with `zReportId`.
- `400 {"detail": "no_machines"}` · `400 {"detail": "machine_not_in_shop:<id>"}` ·
  `400 {"detail": "through_shift_not_candidate:<machineId>"}` ·
  `409 {"detail": "nothing_to_report"}` (no till has a closed shift to include or an open one to close) ·
  `409 {"detail": "z_run_in_progress:<runId>"}` (a live run already covers one of these tills) ·
  `422 {"detail": "z_scope_machine_one_till"}` (tenant `zScope = machine` and more than one till).
- A till in the list with nothing to include gets an `excluded` item with `errorCode: "nothing_to_report"`.

### 2.5 `GET /z-runs/{id}`
`200` ZRun · `404`. Also sweeps expiry and, when every item is `ready`/`excluded`, finalises.

### 2.6 `POST /z-runs/{id}/proceed`
`{"excludeMachineIds": ["…"]}` — build now without those tills (their shifts wait for the next
Z; no gap for them). A till whose item is `failed` or `expired` must be listed. `200` ZRun
(`completed` with the Z, or `failed` with `errorCode` if the build was refused — see below) ·
`409 {"detail": {"code": "items_not_ready", "machineIds": [...]}}` if a non-excluded till is
not ready · `409 {"detail": "nothing_to_report"}` if nothing is left ·
`409 {"detail": "run_not_waiting"}`.

**A refused build.** The build re-checks everything under row locks. If it refuses, the run
becomes `failed` with `errorCode` one of `through_shift_unavailable` (another Z took the
shifts), `open_shift_before_through` (an older shift of that till is still open on the
cloud — a gap), `shift_already_in_z`; nothing is written and no Z number is used. Start a
new run.

### 2.7 `POST /z-runs/{id}/cancel`
`200` ZRun (`cancelled`; open items → `excluded`). A till that already received the instruction
still closes its shift; that shift simply waits for the next Z. `409 run_not_waiting` when finished.

### 2.8 Z reports
- `GET /z-reports` — as before plus `shopId` (already there). `from`/`to` now filter on the Z's
  `businessDate`. `machineId`/`machineIds` match a Z that contains that till.
  Items are **ZReport** (§3.5) without `perMachine`/`shifts`.
- `GET /z-reports/{id}` — **ZReport** with `perMachine` (§3.6), `shifts` (ShiftSummary list)
  and `business` (name, address, VAT id, branch).

### 2.9 `POST /machines/{machineId}/shifts/{shiftId}/administrative-close`
Dead-till recovery (replaces `trading-day/reconstruct-close`). Body `{"force": false, "note": "…"}`.
Closes that open shift from the cloud's documents: `reconstructed`, `unattended`, uncounted.
It then is an ordinary Z candidate. Guards: 409 `shift_not_open`, 409 `terminal_is_online…`,
409 `terminal_recently_seen…` (silent < 2h) unless `force`. `200 {"created": true, "shift": Shift}`
(`created: false` if already closed). `POST /machines/{id}/trading-day/reconstruct-close` → 410.
`POST /machines/{id}/replacement-code` is refused with `409 open_shift…` while the till has an open shift.

### 2.10 Machines list/detail (status light)
Fields renamed on `GET /machines` / `GET /machines/{id}`: `tradingDayStatus` → `shiftStatus`
(`open|none`), `tradingDayId` → `openShiftId`, `dayDate` → `businessDate`, `openedAt`,
`openedBy` (name), `closeDayPending` → `closeShiftPending`; new `closedShiftsAwaitingZ` (count).
`status`: `no_open_shift` replaces `day_closed`, `shift_close_pending` replaces `close_pending`.
`statusFlags`: `shift_open_past_its_date` (replaces `day_open_past_its_date`),
`closed_shifts_awaiting_z` (closed un-Z'd shifts with a businessDate before today); "today" is
the tenant's timezone.

### 2.11 Removed
`POST /machines/close-day`, `GET /close-day-requests/{id}` → 410 `upgrade_required` (use z-runs).

### 2.11b Tips report
`GET /shops/{shopId}/tips/report?shiftId=…` — the query parameter `tradingDayId` is now `shiftId`.
Transaction reads (`TransactionOut`, list items) carry `shiftId` instead of `tradingDayId`.

### 2.12 Tenant setting
`PATCH /tenants/{id}/settings {"zScope": "shop" | "machine"}` (default `shop`). Read from the
tenant level only.

### 2.13 Day summary `GET /reports/day-summary`
Unchanged path and totals. Groups Zs by the Z's `businessDate`. `contributors` are per-till
sections of each Z (one row per Z × till: `zReportId`, `shopSequenceNumber`, `machineId`,
`machineName`, …); `machineCount` = distinct tills across those sections.

---

## 3. Objects

### 3.1 Shift
```json
{
  "id", "tenantId", "machineId", "shopId",
  "businessDate", "sequenceNumber", "status": "open|closed",
  "openedAt", "openingCash", "openedByUserId", "openedByName",
  "closedAt", "closeAcceptedAt", "closedByUserId", "closedByName",
  "unattended": false,
  "countedCash", "expectedCash", "discrepancy",     // discrepancy = counted - expected, null if uncounted
  "serverTotals": {§3.2} | null,                     // null while open
  "tillTotals": {…as sent…} | null,
  "totalsMismatch": false,
  "reconstructed": false, "reconstructionBasis": {…} | null,
  "zReportId": null, "zNumber": null
}
```

### 3.2 X figures (`serverTotals`)
Over the shift's documents with status `completed | refunded | partial_refund`:

| key | definition |
|---|---|
| `transactionsCount` | number of those documents (sales + credit notes) |
| `totalSales` | Σ sales (non-credit-note) of `totalAmount − documentDiscount` (tips excluded) |
| `totalRefunds` | Σ credit notes (type 330, or `refundOfTransactionId` set) of `totalAmount`, positive |
| `totalCash` | Σ cash tender legs of sales − Σ cash legs of credit notes (tips excluded) |
| `totalCard` | same for card legs |
| `totalTips` | Σ `tipAmount` (`totalCashTips` / `totalCardTips` split by `tipPaymentMethod`, server only) |
| `vatTotal` | Σ `vatAmount` of sales − Σ of credit notes; **null** if any document has none |
| `firstTransactionNumber`, `lastTransactionNumber` | lowest / highest document number issued in the shift, cancelled documents included (numeric order when numeric), server only |

Server expected cash = `openingCash + totalCash + totalCashTips`.

### 3.3 The till's X (`till`) and what `totalsMismatch` compares

Only keys the till sends are compared (tolerance 0.01); a non-numeric value is a mismatch.

| till key | compared with (server, same documents) |
|---|---|
| `totalSales` | **gross** sales: Σ `totalAmount` of sales (= `serverTotals.totalSales` + discounts) |
| `totalDiscounts` or `discountsTotal` | Σ `documentDiscount` of sales |
| `totalRefunds` | `serverTotals.totalRefunds` |
| `totalCash`, `totalCard` | `serverTotals.totalCash`, `.totalCard` (tender legs, sales − credit notes, tips excluded) |
| `totalTips` | `serverTotals.totalTips` |
| `vatTotal` | `serverTotals.vatTotal` (a mismatch if the server's is null) |
| `transactionsCount` | `serverTotals.transactionsCount` |

Note the asymmetry on purpose: `serverTotals.totalSales` (and every Z) is **net of document
discounts** — the money collected — while the till's `totalSales` is its line totals.

### 3.4 ZRun
```json
{
  "id", "shopId", "status": "waiting|building|completed|failed|cancelled|expired",
  "businessDate", "createdAt", "updatedAt", "expiresAt", "createdByUserId",
  "zReportId", "zNumber", "errorCode", "errorMessage",
  "items": [{
    "id", "machineId", "machineName",
    "throughShiftId", "closeShiftId",
    "status": "waiting_close|closing|ready|excluded|failed|expired",
    "errorCode", "errorMessage", "sentAt", "receivedAt", "readyAt", "updatedAt"
  }]
}
```
36 h after the run was created, items still waiting for a till (`waiting_close`, `closing`)
become `expired`; the run stays `waiting` if another item is `ready` (then `proceed` without
the expired tills, or `cancel`), and becomes `expired` itself if nothing is ready. A till is
in at most one live run: `waiting_close`, `closing` and `ready` items of a `waiting` run hold
it (`409 z_run_in_progress`).

### 3.5 ZReport
```json
{
  "id", "tenantId", "shopId", "shopName", "shopSequenceNumber",
  "businessDate", "periodStart", "periodEnd", "shiftCount", "machineCount",
  "zRunId", "createdByUserId", "closedAt", "createdAt",
  "totalSales", "totalRefunds", "discountsTotal", "totalCashSales", "totalCardSales",
  "totalTips", "totalCashTips", "totalCardTips", "vatTotal", "transactionsCount",
  "paymentBreakdown": {"cash": "…", "card": "…", "<other method>": "…"},
  "openingCash", "expectedCash", "actualCash", "discrepancy",   // actualCash/discrepancy null if any shift uncounted
  "unattended", "reconstructed",           // any included shift unattended / reconstructed
  "legacy": false,                         // true for a pre-shift, till-issued Z (machineId set, no perMachine)
  "machineId": null, "machineName": null   // legacy rows only
}
```

### 3.6 Per-till section (`perMachine[]`)
```json
{
  "machineId", "machineName", "posNumber",
  "shiftIds": [...], "shiftCount", "firstShiftSequence", "lastShiftSequence",
  "firstDocumentNumber", "lastDocumentNumber",
  "transactionsCount", "salesCount", "creditNotesCount", "nonSaleDocumentsCount",
  "totalSales", "totalRefunds", "discountsTotal", "vatTotal", "vatMissingCount",
  "totalCash", "totalCard", "paymentBreakdown": {…},
  "totalTips", "totalCashTips", "totalCardTips",
  "openingCash", "expectedCash", "countedCash", "overShort", "uncountedShiftCount",
  "reconstructedShiftCount", "unattendedShiftCount"
}
```
Money values are decimal strings. `countedCash` / `overShort` are null if any of the till's
shifts is uncounted.

---

## Deviations from the plan

- A Z run can be `failed` (build refused under lock, see §2.6) — the plan lists the status but
  not when; also `expired` applies to the whole run only when nothing in it is ready.
- A till whose item is `failed`/`expired` must be named in `proceed`'s `excludeMachineIds`.
- Heartbeat: an absent `openShiftId` replaces the stored claim with "none open" (the till
  drops nulls), rather than leaving the last reading in place.
- Shift close accepts optional open fields so a lost open event is recoverable, and answers
  `409 shift_unknown` otherwise (plan is silent).
- `staleIds` on the missing-documents 409 is now meaningful (documents held under another shift).
- A batch of documents referencing an unknown shift while another is open is refused as a
  whole (409), since `/transactions` is a batch endpoint with per-document results.
- New scope `shift:close` (the till may keep sending none). `day:close` stays as a legacy name.
- Shifts also store the approver (`approved_by_user_id`/`approved_by_pos_user_id`), cash/card
  tip split and `close_accepted_at`; the heartbeat's reported open shift is stored on the machine.
- `POST /machines/close-day` and `GET /close-day-requests/{id}` return 410 (replaced by z-runs).
