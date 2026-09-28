# Shifts and cloud Z — API contract

Status: the contract the till (pos-android `feat/shifts`) and the dashboard build against.
Spec: `pos-android/docs/shifts-plan.md` §4.4–§4.6. Owner: the pos-server `feat/shifts` branch.
Anything here that differs from the plan is called out under **Deviations** at the end.

**Bounds on the shift writes (§1.1, §1.3).** Money (`openingCash`, `countedCash`,
`expectedCash`) is rounded to the cent and must fit 12 digits with 2 decimals
(|x| < 10¹⁰); `sequenceNumber` is 0…2³¹−1; `NaN`/`Infinity` are refused. Anything else is a
`422` (the till parks it) — never a `500`. `NaN`/`Infinity` inside `till` is stored as text
and counts as a mismatch.

Conventions

- Prefix: `/api/v1`. Till calls use the machine JWT (`Authorization: Bearer <machine token>`);
  `{machineId}` in the path must be the token's machine (403 otherwise). The shift writes —
  §1.1 open, §1.3 close, §1.4 ack, §1.5 last-closed — take **only** a machine token: a
  dashboard (user) token is `403 {"detail": "machine_token_required"}`. Other
  `/sync/{machineId}/…` paths that admit a user token require the user to be in the machine's
  tenant (a distributor: their own terminal; a super admin: any) — `403 tenant_forbidden` /
  `403 Access denied` otherwise.
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
  - known and still open → `businessDate`, `openedAt`, `openingCash`, `openedByUserId`,
    `openedByName`, `sequenceNumber` are corrected from the body (a sale can beat this event to
    the cloud and create the shift with inferred values);
  - known and closed → returned untouched.
- A `sequenceNumber` at or below one this till already used (a reinstall resetting its
  counter, say) is **accepted and flagged** — `sequenceOutOfOrder: true` on the Shift — never
  refused: a refusal would jam the till's outbox. The dashboard should show it; a Z orders a
  till's shifts by that number.
- `409 {"detail": "another_shift_open:<openShiftId>"}` — the cloud still has a different
  shift of this till open. With a strictly ordered outbox this means the previous shift's
  close has not been accepted yet: deliver it first, then retry this.
- `403 {"detail": "shift_belongs_to_another_machine"}` — the cloud holds this shift id for a
  **different** machine (see "Another machine's shift" below). Exactly this status and body.
- `400 {"detail": "Machine must be assigned to a shop"}` (as every sync write).

**Another machine's shift.** A shift id belongs to the machine the cloud first recorded it
for. When a physical till is re-paired as a **new** machine while a shift is open, that
shift stays the old machine's in the cloud, and the till's new machine can never use it:
its open and close are `403 shift_belongs_to_another_machine`, a document naming it is an
orphan of the new machine (§1.2), and a heartbeat claiming it is ignored (§1.6). The till is
expected to stop sending that shift's open/close on the 403 and carry on with a new shift.

### 1.2 `POST /sync/{machineId}/transactions` — documents

As today, with two renames on each document: `tradingDayId` → **`shiftId`**, `dayDate` →
**`businessDate`**. The old names are no longer read.

Shift resolution per document:
- `shiftId` known, a shift of **this** till → the document belongs to it (a re-push of an
  existing document with a different `shiftId` moves it, unless its current shift is already
  in a Z — then it stays).
- `shiftId` known, a shift of **another** till (a till re-paired as a new machine, §1.1) →
  treated exactly like an absent `shiftId`: stored as an **orphan** of the pushing till,
  `accepted`, never a conflict. It is in no X and no Z, and is counted in `orphanDocuments`.
  Never moved into, and never recomputing, the other till's shift.
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
- `shiftId` absent → the document is stored with **no shift** (an orphan). The server never
  guesses a shift for it and never creates one: a Z takes no orphan, and each till's orphan
  count is shown (`orphanDocuments` on the machines list and on z-candidates). A re-push of a
  known document without `shiftId` leaves it in the shift it is already in — unless that is
  another till's shift not yet in a Z, which it leaves to become an orphan.
- A document whose `id` the cloud already holds for **another** machine (the same physical
  till pushed it before it was re-paired) is left untouched and answered
  `{"status": "duplicate", "reason": "held_by_another_machine"}`, so the till clears it.

An X or Z counts only the documents of the shift's own till: a document held under another
till's shift (possible before this was refused) is in neither, and counts as an orphan of
its own till.

Each tender leg in `payments[]` may carry:
- `nayaxMeta` — the acquirer reply, as a JSON **string** (the till) or an object; stored as
  an object. A string that is not a JSON object is kept as `{"raw": "<string>"}`, never
  rejected — so is one over 16 KB (`{"raw": <first 16 KB>, "truncated": true}`), one nested
  too deep to parse, and one carrying `NaN`/`Infinity` (not JSON; the database refuses it).
  The document-level `nayaxMeta` accepts both forms too.
- `creditPayments` — number of credit instalments (integer, optional); stored in the leg's
  meta as `creditPayments`. An unreadable value (not a number, negative, beyond 2³¹−1,
  infinite) is dropped, not rejected.

`200` body unchanged: `{"serverTime", "results": [{"id", "status": "accepted|duplicate|rejected", "reason"?, "serverReceivedAt"?}]}`.

**A document for a shift that is already closed** (it reached the cloud after the close) is
always accepted and stored — a fiscal document is never dropped:
- shift not in a Z yet → the shift's server X is recomputed to include it, and its
  `lateDocuments` count goes up; the next Z takes it;
- shift already in a Z → the Z's figures are frozen, so the document is stored but not in
  the Z, and both the shift's and the Z's `lateDocuments` go up ("document arrived after Z").
Only documents new to the cloud count this way; a plain re-push of a known one does not. But
for a shift already in a Z:
- a known document **moved into** it (a re-push naming it, e.g. a former orphan) is not in the
  Z's figures either and counts in `lateDocuments` of the shift and the Z;
- a known document of it **re-pushed with different fiscal content** — number, document type,
  `totalAmount`, `documentDiscount`, `vatAmount`, tip or its method, refund link, tender legs,
  or whether its status counts as a sale — is stored as sent and counts in
  `amendedDocuments` of the shift and the Z (whose figures stay as built). A status change
  between two sale statuses (`completed` → `refunded` when its credit note is issued) is not
  an amendment.

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
  "closeRequestId": "…",         // the requestId of a remote close-shift instruction (a Z run's or a standalone one, §2.14), else null/absent

  // Optional, recommended: lets the cloud create the shift if its open event was lost, and
  // fills what a shift created by a sale lacks (float, number, opener; businessDate and,
  // if no open event ever arrived, openedAt, are taken as the till's).
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
- `403 {"detail": "shift_belongs_to_another_machine"}` — another machine's shift (§1.1).
  Checked **first**: it is the answer whatever `transactionIds` lists, never the missing-ids
  `409` (those documents are not this till's, so that loop could never end), and also for a
  shift the other machine has already closed (not `200 duplicate`).

A `closeRequestId` the cloud does not know for this till is ignored (the close is still
accepted). An accepted close also completes every pending instruction that named this
shift, whichever `requestId` the close carried.

A close for a shift that was closed administratively (dead-till recovery, §2.9) returns
`200 duplicate` with that shift's figures. A duplicate close also completes a remote
instruction still waiting for that shift (and builds the Z if it was the last till), exactly
as the first close would have — unless the shift is already in a Z. When the close answers a remote instruction
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

The `requestId` is either a Z run item or a standalone close request (§2.14); the two
are resolved by id and behave the same for every phase. A `shiftId` that is another
machine's shift (§1.1) is not recorded on the item or request.

`200 {"ok": true, "itemStatus": "<z-run item status, or the close request's status>"}`; `404 {"detail": "close_request_not_found"}`.
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

The heartbeat **never** answers 422: an over-long string is cut to its column
(`appVersion` 64, `serialNumber` 64, `batteryStatus` 32), and any field that cannot be read
(wrong type, bad UUID/date, negative count, a count beyond 2³¹−1) is treated as not sent.
One exception to "not sent = none": an **unreadable** `openShiftId` (not a UUID) leaves the
stored claim as it was; only an absent or null one means "no shift open".

Request adds (both optional; null **or absent** = "no shift open" — the claim is replaced
on every beat):
```json
{ "openShiftId": "…", "openShiftOpenedAt": "…" }
```
An `openShiftId` that is another machine's shift (§1.1) is stored as "none open" (and
logged): it is not this till's, its close would be `403`, and kept it would show in the Z
wizard as an open shift not yet in the cloud forever. A Z run or a remote close never asks
this till to close it.
Response
```json
{
  "ok": true,
  "serverTime": "…",
  "zReportedThroughSequence": 11,   // highest sequenceNumber of this till's shifts that is in a Z; null if none. Always present.
  "recentShiftZs": [                 // this till's shifts taken by a Z in the last 30 days, newest Z first, at most 50. Always present ([] if none).
    {"shiftId": "…", "zReportId": "…", "zNumber": 7}
  ],
  "pendingCloseShift": {"requestId": "…", "shiftId": "…"}   // only when a remote close is waiting for this till
}
```
`recentShiftZs` is how the till learns the Z number of an older shift (for shift history and
X reprints); the close response only carries it when the shift is already in a Z.
`pendingCloseDay` is gone. The till purges synced documents of shifts with
`sequenceNumber <= zReportedThroughSequence`. `pendingCloseShift` is repeated on every beat
until the till's close is accepted (or the run ends), so the till must dedupe by `requestId`.
It comes from a Z run or from a standalone close request (§2.14) — one per beat, a Z
run's first. When both are pending they name the same shift, and the one accepted close
completes both.

### 1.7 Ably event `close-shift`

The till's Ably token (`GET /machines/me/ably-auth`) grants `subscribe` and `history` on its
channel, so an attach with `rewind=1` works and picks up an event published while the till
was reconnecting.

On channel `pos:{tenantId}:{machineId}`:
```json
{"serverTime": "…", "requestId": "…", "shiftId": "…", "initiatedBy": "manager name"}
```
Same instruction as `pendingCloseShift`, from a Z run or a standalone close request
(§2.14); the till must treat both idempotently by `requestId`.
`shiftId` is the shift the cloud believes is open (may be null if the cloud has not seen the
open yet — close whatever is open, and send its id in the ack).
It may also be the id the till itself reported open on its heartbeat before its open event
reached the cloud: a remote close of such a shift is accepted (the id is kept as the till's
claim and tied to the shift when its open, a document or the close itself arrives), and the
close is matched by `closeRequestId`, else by that shift id.

### 1.8 Removed — `410 {"detail": "upgrade_required"}`

`POST /sync/{m}/trading-day`, `GET /sync/{m}/trading-day/current`, `POST /sync/{m}/z-report`,
`POST /sync/{m}/close-day/ack`, `GET /sync/{m}/last-close`. Still authenticated first.

---

## 2. Dashboard → cloud

User JWT + `X-Tenant-Id`. Role scoping as the rest of the dashboard (shop-scoped roles see
their shop, company managers their company tree, distributors their machines).
**Producing a Z** (z-runs create/proceed/cancel, administrative close) needs the roles that
could close a day before: `company_manager`, `shop_manager`, `distributor`, `super_admin`
(`get_current_machine_admin`). So does closing a till's shift remotely without a Z (§2.14),
narrowed to the till: a distributor's own terminals, a company manager's company tree, a
shop manager's shop. Reading shifts / Z reports needs any signed-in role that can see the
shop. **A distributor acts on their own terminals only** in every z-run endpoint (§2.3–§2.7):
the candidates list only their tills, and a run over — or a read, proceed or cancel of a run
holding — another distributor's till is `403 Access denied`. A shop with no tenant is
`403 tenant_forbidden` to everyone.

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
    "tillReportedOpenShiftId": "…" | null,   // from the heartbeat (the cloud may not have the open yet); null unless a
                                               // close could still answer it: not a shift the cloud holds closed,
                                               // not another till's, not a till that is not in this shop
    "inShop": true, "isActive": true,          // false for a till listed only for its closed shifts of this shop
    "orphanDocuments": 0,                      // documents of this till in no shift of its own (named none, or another till's); no Z takes them
    "closedShifts": [ShiftSummary, …],         // closed and not in a Z, oldest first (sequenceNumber, then openedAt)
    "activeRun": {"runId": "…", "itemStatus": "waiting_close"} | null
  }]
}
```
The shop's active, assigned tills — **plus any till, whatever its state, that still has closed
shifts of this shop no Z has taken** (retired, unpaired, or moved to another shop before that
was refused): `inShop: false`. Such a till's shifts can be included like any other; it is never
asked to close a shift (`includeOpenShift` does not apply). A till's candidates are its shifts
**worked in this shop** (`shopId` of the shift), never those of another shop. `status` is the
same status light as the machines page (real pairing state, pending close, flags' inputs).
`ShiftSummary` = §3.1 without `tillTotals` /
`reconstructionBasis` — it includes `lateDocuments`, so a shift with late documents is
visible before the Z is produced.

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
- `400 {"detail": "no_machines"}` · `400 {"detail": "machine_not_in_shop:<id>"}` (not a candidate
  till of this shop, §2.3) ·
  `400 {"detail": "through_shift_not_candidate:<machineId>"}` ·
  `409 {"detail": "nothing_to_report"}` (no till has a closed shift to include or an open one to close) ·
  `409 {"detail": "z_run_in_progress:<runId>"}` (a live run already covers one of these tills) ·
  `422 {"detail": "z_scope_machine_one_till"}` (tenant `zScope = machine` and more than one till).
- A till in the list with nothing to include gets an `excluded` item with `errorCode: "nothing_to_report"`.

### 2.5 `GET /z-runs/{id}`
`200` ZRun · `404`. Also sweeps expiry and, when every item is `ready`/`excluded`, finalises.

### 2.6 `POST /z-runs/{id}/proceed`
`{"excludeMachineIds": ["…"]}` — build now without those tills (their shifts wait for the next
Z; no gap for them). A till whose item is `failed` or `expired` must be listed. Only a till
that is **not** `ready` is left out: a `ready` till in the list stays in the Z. `200` ZRun
(`completed` with the Z, or `failed` with `errorCode` if the build was refused — see below) ·
`409 {"detail": {"code": "items_not_ready", "machineIds": [...]}}` if a non-excluded till is
not ready · `409 {"detail": "nothing_to_report"}` if nothing is left ·
`409 {"detail": "run_not_waiting"}`.

**A refused build.** The build re-checks everything under row locks. If it refuses, the run
becomes `failed` with `errorCode` one of `through_shift_unavailable` (another Z took the
shifts), `open_shift_before_through` (an older shift of that till is still open on the
cloud — a gap), `shift_already_in_z`, or `build_error` (anything else went wrong while
building — logged on the server); nothing is written and no Z number is used. Start a
new run. A failed build never fails the till's close that triggered it: the close is
accepted and the run alone is marked `failed`.

### 2.7 `POST /z-runs/{id}/cancel`
`200` ZRun (`cancelled`; open items → `excluded`). A till that already received the instruction
still closes its shift; that shift simply waits for the next Z. `409 run_not_waiting` when finished.

### 2.8 Z reports
- `GET /z-reports` — as before plus `shopId` (already there). `from`/`to` now filter on the Z's
  `businessDate`; `closedFrom`/`closedTo` (ISO datetimes, naive = UTC) on `closedAt`.
  `machineId`/`machineIds` match a Z that contains that till. **With none of `from`, `to`,
  `closedFrom`, `closedTo` given, the list covers the last 90 days** (`from` = today − 90 days,
  UTC). Items are **ZReport** (§3.5) without `perMachine`/`shifts`. The response says which
  window applied:
  `{"page", "pageSize", "total", "items": [...], "window": {"from": "2026-07-01" | null, "to": … | null, "defaulted": true}}`.
- `GET /z-reports/{id}` — **ZReport** with `perMachine` (§3.6), `shifts` (full **Shift**
  objects, §3.1 — `tillTotals` and `reconstructionBasis` included — plus `machineName`, and
  `zNumber` = this Z's) and `business`: the header **frozen when the Z was built** (§3.7),
  never live settings. `business` is `null` only for a legacy Z of a till with no shop.

### 2.9 `POST /machines/{machineId}/shifts/{shiftId}/administrative-close`
Dead-till recovery (replaces `trading-day/reconstruct-close`). Body `{"force": false, "note": "…"}`.
Closes that open shift from the cloud's documents: `reconstructed`, `unattended`, uncounted.
It then is an ordinary Z candidate, and a Z run or close request waiting for that shift is
completed by it (the run builds if that was the last till), and the till's heartbeat claim of
it is dropped. `reconstructionBasis.lastReportedPendingDocuments` is the status light's reading
(`pendingDocuments`, else the outbox depth `pendingCount`). Guards: 409 `shift_not_open`, 409 `terminal_is_online…`,
409 `terminal_recently_seen…` (silent < 2h) unless `force`. `200 {"created": true, "shift": Shift}`
(`created: false` if already closed). `POST /machines/{id}/trading-day/reconstruct-close` → 410.
`POST /machines/{id}/replacement-code` is refused with `409 open_shift…` while the till has an open shift.

### 2.10 Machines list/detail (status light)
Fields renamed on `GET /machines` / `GET /machines/{id}`: `tradingDayStatus` → `shiftStatus`
(`open|none`), `tradingDayId` → `openShiftId`, `dayDate` → `businessDate`, `openedAt`,
`openedBy` (name), `closeDayPending` → `closeShiftPending` (a Z run **or** a standalone
close request, §2.14, is waiting for this till's close); new `closedShiftsAwaitingZ` (count),
`orphanDocuments` (documents in no shift of their own till), `openShiftSequence` (the open shift's
`sequenceNumber`, null if none open or unnumbered — so a list can name "משמרת #N" without
fetching the shift), `pendingCloseSource` (`"z_run"` | `"request"` | null — what is waiting for
this till's close; a Z run's wins when both are) and `pendingZRunId` (that run, when it is a Z
run). `reportedOpenShiftId` (the heartbeat claim) is null unless a close could still answer it:
not a shift the cloud holds closed, not another till's.
`status`: `no_open_shift` replaces `day_closed`, `shift_close_pending` replaces `close_pending`.
`statusFlags`: `shift_open_past_its_date` (replaces `day_open_past_its_date`),
`closed_shifts_awaiting_z` (closed un-Z'd shifts with a businessDate before today); "today" is
the tenant's timezone.

### 2.10b A till keeps its shop while it has shifts to report
`PUT /machines/{id}` changing `shopId` (to another shop or to null) or setting `isActive: false`,
`DELETE /machines/{id}`, and `DELETE /shops/{id}` (for each of its tills) are refused while the
till has an open shift or closed shifts no Z has taken:
`409 {"detail": "machine_has_open_shift"}` · `409 {"detail": "machine_has_shifts_awaiting_z"}`.
Close the shift and produce the Z first. A till's shifts are its shop's fiscal record: moved,
they would reach the wrong shop's Z; retired, no Z at all.

### 2.11 Removed
`POST /machines/close-day`, `GET /close-day-requests/{id}` → 410 `upgrade_required` (use z-runs).

### 2.11b Tips report
`GET /shops/{shopId}/tips/report?shiftId=…` — the query parameter `tradingDayId` is now `shiftId`.
Transaction reads (`TransactionOut`, list items) carry `shiftId` instead of `tradingDayId`.

### 2.12 Tenant setting
`PATCH /tenants/{id}/settings {"zScope": "shop" | "machine"}` (default `shop`). Read from the
tenant level only; `PATCH /companies/{id}/settings` and `/shops/{id}/settings` refuse it
with `400 "zScope is a tenant setting"`. Only a distributor or super admin may **change**
it (the branding roles): anyone else passing the tenant guard gets `403 "Insufficient
permissions to change zScope"` for a new value, while re-sending the stored value with
other settings still saves. The dashboard edits it in the tenant settings dialog ("הפקת
דו״ח Z"), read-only for other roles. `machine` makes `POST /z-runs` refuse more than one till
(`422 z_scope_machine_one_till`); it affects only Zs produced after the change.

### 2.13 Day summary `GET /reports/day-summary`
Unchanged path and totals. Groups Zs by the Z's `businessDate`. `contributors` are per-till
sections of each Z (one row per Z × till: `zReportId`, `shopSequenceNumber`, `machineId`,
`machineName`, …); `machineCount` = distinct tills across those sections.

### 2.14 Remote shift close without a Z

An operator closes one till's open shift from the dashboard, without producing a Z. The
till receives **exactly** a Z run's instruction (§1.6 heartbeat `pendingCloseShift`, §1.7
Ably `close-shift`), with the request's id as `requestId`, so a till in the field needs no
change: its `shift-close/ack` (§1.4) and its close's `closeRequestId` (§1.3) resolve to the
request. It closes unattended (no count). The request completes only when the close is
**accepted** with every document; no Z is built, and the closed shift is an ordinary
candidate for the shop's next Z.

`POST /machines/{machineId}/close-shift` (no body) → `201` **ShiftCloseRequest** (§3.8), or
`200` with the request already pending for this till (a second click sends nothing new).
- `409 {"detail": "no_open_shift"}` — neither the cloud nor the till's heartbeat has a shift open.
- `409 {"detail": "machine_not_assigned"}` — the till has no shop.
- `409 {"detail": "z_run_in_progress:<runId>"}` — a Z run is already closing this till's shift.
- `403` / `404` as the other machine actions. Roles: §2 (machine admin, narrowed to the till).

A Z run started while a request is pending is allowed: its item names the same open shift,
and the one accepted close completes both (and builds the Z if it was the last till).

`GET /shift-close-requests/{id}` → ShiftCloseRequest · `404`. Sweeps expiry, and completes a
pending request whose shift the cloud already holds closed (e.g. closed administratively).

`POST /shift-close-requests/{id}/cancel` → ShiftCloseRequest (`cancelled`) · `409
request_not_pending`. The heartbeat stops handing it over; a till that already received it
still closes its shift, which then waits for the next Z. Its later ack or close changes
nothing on the request.

Statuses: `waiting_close` (sent, not acknowledged) → `closing` (`received` or `deferred` ack;
`deferred` keeps `errorCode`, e.g. `card_in_flight`) → `completed` (close accepted). Ends
early as `failed` (a `failed` ack), `expired` (36 h after creation, like a Z run's items) or
`cancelled`.

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
  "lateDocuments": 0,            // documents that arrived after the close (see §1.2); >0 = show a badge
  "amendedDocuments": 0,         // documents rewritten after the shift went into a Z (§1.2); >0 = show a badge
  "sequenceOutOfOrder": false,   // opened with a sequenceNumber at or below one its till already used (§1.1)
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
| `grossSales` | Σ sales of `totalAmount`, before document discounts (= `totalSales + discountsTotal`) |
| `discountsTotal` | Σ sales of `documentDiscount` |
| `totalRefunds` | Σ credit notes (type 330, or `refundOfTransactionId` set) of `totalAmount`, positive |
| `totalCash` | Σ cash tender legs of sales − Σ cash legs of credit notes (tips excluded) |
| `totalCard` | same for card legs |
| `totalTips` | Σ `tipAmount` (`totalCashTips` / `totalCardTips` split by `tipPaymentMethod`, server only; a tip with no `tipPaymentMethod` takes the sale's own tender — cash if the sale is cash, else card — so the two always add up to `totalTips`) |
| `vatTotal` | Σ `vatAmount` of sales − Σ of credit notes; **null** if any document has none |
| `firstTransactionNumber`, `lastTransactionNumber` | lowest / highest document number issued in the shift, cancelled documents included (numeric order when numeric), server only |

Server expected cash = `openingCash + totalCash + totalCashTips`.

### 3.3 The till's X (`till`) and what `totalsMismatch` compares

Only keys the till sends are compared (tolerance 0.01); a non-numeric value is a mismatch.

| till key | compared with (server, same documents) |
|---|---|
| `totalSales` | **gross** sales: `serverTotals.grossSales` (Σ `totalAmount` of sales) |
| `totalDiscounts` or `discountsTotal` | `serverTotals.discountsTotal` (Σ `documentDiscount` of sales) |
| `totalRefunds` | `serverTotals.totalRefunds` |
| `totalCash`, `totalCard` | `serverTotals.totalCash`, `.totalCard` (tender legs, sales − credit notes, tips excluded) |
| `totalTips` | `serverTotals.totalTips` |
| `vatTotal` | `serverTotals.vatTotal` (a mismatch if the server's is null) |
| `transactionsCount` | `serverTotals.transactionsCount` |

Note the asymmetry on purpose: `serverTotals.totalSales` (and every Z) is **net of document
discounts** — the money collected — while the till's `totalSales` is its line totals. The
server stores both (`grossSales`, `discountsTotal`) so the two can be shown side by side.
Shifts closed before these were stored were backfilled from their documents (a shift
already in a Z counts only the documents that reached the cloud before that Z was built).

### 3.4 ZRun
```json
{
  "id", "shopId", "status": "waiting|building|completed|failed|cancelled|expired",
  "businessDate", "createdAt", "updatedAt", "expiresAt", "createdByUserId",
  "zReportId", "zNumber", "errorCode", "errorMessage",
  "items": [{
    "id", "machineId", "machineName",
    "throughShiftId",
    "closeShiftId",                  // the shift the till is asked to close — the till's own claim
                                     // (heartbeat/ack) while the cloud has not seen that shift yet
    "status": "waiting_close|closing|ready|excluded|failed|expired",
    "errorCode", "errorMessage", "sentAt", "receivedAt", "readyAt", "updatedAt",
    "online": true,                  // the till's reachability, as the status light reads it
    "pendingDocuments": 3,           // the till's LAST REPORTED backlog (a reading, not live); null = never reported
    "pendingAsOf": "…",              // when that reading was taken
    "documentsOnCloud": 41           // while waiting_close/closing: documents of the closing shift the cloud holds; else null
  }]
}
```
36 h after the run was created, items still waiting for a till (`waiting_close`, `closing`)
become `expired`. If any item is `ready`, the Z is then **built at once with the ready tills**
— `expired` and `failed` items are left out (they keep their status; their shifts wait for the
next Z, no gap for them) — and the run becomes `completed` (or `failed` if the build is
refused). If nothing is ready the run becomes `expired`. A till is
in at most one live run: `waiting_close`, `closing` and `ready` items of a `waiting` run hold
it (`409 z_run_in_progress`).

### 3.5 ZReport
```json
{
  "id", "tenantId", "shopId", "shopName", "shopSequenceNumber",
  "businessDate", "periodStart", "periodEnd", "shiftCount", "machineCount",
  "zRunId", "createdByUserId", "closedAt", "createdAt",
  "totalSales", "totalRefunds", "discountsTotal", "totalCashSales", "totalCardSales",
  "grossSales",                            // totalSales + discountsTotal (null if discountsTotal is)
  "netSales",                              // totalSales − totalRefunds
  "totalTips", "totalCashTips", "totalCardTips", "vatTotal", "transactionsCount",
  "paymentBreakdown": {"cash": "…", "card": "…", "<other method>": "…"},
  "openingCash", "expectedCash", "actualCash", "discrepancy",   // actualCash/discrepancy null if any shift uncounted
  "unattended", "reconstructed",           // any included shift unattended / reconstructed
  "lateDocuments": 0,                      // documents of its shifts that arrived (or moved in) after it was built (not in its figures)
  "amendedDocuments": 0,                   // documents of its shifts rewritten after it was built (its figures are as built)
  "legacy": false,                         // true for a pre-shift, till-issued Z (machineId set, no perMachine)
  "machineId": null, "machineName": null   // legacy rows only
}
```

### 3.6 Per-till section (`perMachine[]`)
```json
{
  "machineId", "machineName",
  "posNumber",        // the register number; null when the till has none (never the machine code)
  "machineCode",      // the till's machine code (Zs built from now on)
  "shiftIds": [...], "shiftCount", "firstShiftSequence", "lastShiftSequence",
  "firstDocumentNumber", "lastDocumentNumber",
  "transactionsCount", "salesCount", "creditNotesCount", "nonSaleDocumentsCount",
  "totalSales", "grossSales", "netSales", "totalRefunds", "discountsTotal", "vatTotal", "vatMissingCount",
  "totalCash", "totalCard", "paymentBreakdown": {…},
  "totalTips", "totalCashTips", "totalCardTips",
  "openingCash", "expectedCash", "countedCash", "overShort", "uncountedShiftCount",
  "reconstructedShiftCount", "unattendedShiftCount"
}
```
Money values are decimal strings. `countedCash` / `overShort` are null if any of the till's
shifts is uncounted. Sections are served as they were stored when the Z was built — except
that `grossSales` / `netSales` are derived from the section's own figures for a Z built before
they were stored. A Z built before this change may carry a machine code in `posNumber`
(non-numeric); it is not rewritten.

### 3.7 Z header (`business` on the Z detail)
```json
{
  "businessName": "…", "vatNumber": "515151515", "companyRegNumber": null,
  "companyId": "<company uuid>", "address": "…", "addressNumber": "1", "city": "…", "zip": null,
  "branchId": "…", "shopId": "…", "shopName": "…", "capturedAt": "<when it was frozen>"
}
```
Taken from tenant → company → shop settings (`businessInfo` overrides, then the company and
shop records) at build time. Zs that existed before this was added were backfilled from the
settings at migration time (`capturedAt` = then).

### 3.8 ShiftCloseRequest (§2.14)
```json
{
  "id", "machineId", "machineName", "shopId",
  "shiftId": "…",                 // the shift asked to close (null only if nobody named one yet);
                                  // may be a shift only the till has reported so far (see §1.7)
  "status": "waiting_close|closing|completed|failed|expired|cancelled",
  "errorCode", "errorMessage",
  "createdAt", "updatedAt", "expiresAt", "createdByUserId",
  "sentAt", "receivedAt", "completedAt",
  "online", "pendingDocuments", "pendingAsOf",   // as on a Z run item (§3.4)
  "documentsOnCloud": 12,         // while pending; null once ended
  "shift": ShiftSummary | null    // the shift being closed; its X once completed
}
```

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
- A shift can be closed remotely without a Z (§2.14, `shift_close_requests`), over the same
  till wire path as a Z run's close; the plan had remote close only inside a Z run.
- Shifts store `grossSales` and `discountsTotal` beside the net `totalSales` (§3.2).
- A shift is one machine's: another machine's shift id (a till re-paired as a new machine
  with a shift open) makes the document an orphan, the open/close a 403, and the heartbeat
  claim "none open" (§1.1). The plan did not cover re-pairing mid-shift.
