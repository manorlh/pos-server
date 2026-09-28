# Shifts and cloud Z — manual testing

End-to-end checklist for shifts on the till and the Z produced in the cloud. The wire
contract is `docs/SHIFTS_API.md`; the plan is `pos-android/docs/shifts-plan.md`.

## Prerequisites

- pos-server at migration head `e4f5a6b7c8d9` (take a `pg_dump` into `~/dev/pos-backups` first)
- A till on the shifts build, paired and assigned to a shop, online (Ably connected)
- A second till in the same shop for the multi-till cases
- Dashboard user with `company_manager`, `shop_manager`, `distributor` or `super_admin`
  (producing a Z needs one of these; a cashier or shift supervisor may only close shifts)

## Shift on the till

- [ ] Open a shift with a float; the machines page shows the shift open (`shiftStatus: open`)
- [ ] The next shift's float is prefilled with the previous shift's counted cash
      (else expected); after a reinstall it comes from `GET /sync/{m}/shifts/last-closed`
- [ ] Sell a few documents (cash, card, split, one with a document discount, one refund)
- [ ] Close the shift with a count: an X prints; the shift becomes closed on the cloud only
      after every document synced (`GET /shifts?machineId=…` shows `closeAcceptedAt`)
- [ ] The X in the dashboard (`GET /shifts/{id}`) equals the printed X; `totalsMismatch`
      is false (a discounted shift must not be flagged)
- [ ] With a document discount: `serverTotals.grossSales` = the printed gross,
      `discountsTotal` = the printed discounts, `totalSales` = gross − discounts; the shift
      page shows gross and discounts above the net sales
- [ ] A shift whose till X disagrees: the mismatch table's "בענן" column is filled for
      gross sales and discounts too (not empty)
- [ ] Close without counting: `countedCash` and `discrepancy` are null, not 0
- [ ] Open a second shift at once and sell; the machines page shows
      `closedShiftsAwaitingZ: 1`
- [ ] The machines row badge reads "משמרת #N פתוחה" with the till's own number
      (`openShiftSequence` on `GET /machines`), and the machine page links that shift

## Offline close, then a new shift

- [ ] Take the till offline, close shift N, open N+1, sell
- [ ] Bring it online: the outbox delivers open(N)→docs(N)→close(N)→open(N+1)→docs(N+1)
- [ ] No document of N+1 lands in N (compare `GET /shifts/{id}` counts with the till)
- [ ] While close(N) is still queued, a document of N+1 is answered
      `409 another_shift_open` and retried later — never `rejected`

## Remote shift close without a Z

- [ ] Machines page → row menu → "סגור משמרת מרחוק" (shown only for a till with an open
      shift, to a Z-producing role): the dialog explains no count and no Z; confirm
- [ ] Online till: it receives `close-shift` at once, closes unattended (no count), tells
      the cashier, and offers a new shift; the dialog goes `waiting_close → closing →
      completed` and shows the shift's sales, with links to its X and to the Z wizard
- [ ] No Z was built; the shift appears in the wizard's closed shifts for the next Z
- [ ] Offline till: the dialog waits (showing the till offline and its last reported
      backlog); the till closes on its next heartbeat after it comes back
- [ ] Card payment in flight: the dialog shows `card_in_flight`, then completes once the
      payment settles
- [ ] While waiting, "documents of the shift already in the cloud" rises as the till syncs
- [ ] Close the dialog and ask again: the same request comes back (200) with its progress
- [ ] "ביטול הבקשה": the heartbeat stops handing it over; if the till already had it, the
      shift still closes and waits for the next Z; the request stays `cancelled`
- [ ] A Z run already closing the till: the remote close is refused (`z_run_in_progress`)
- [ ] A remote close pending, then a Z run including that till's open shift: one close on
      the till completes both, and the Z is built
- [ ] Not answered for 36 h: the request becomes `expired`
- [ ] A shop manager may close a till of their own shop, not of another shop

## Z from the dashboard

- [ ] `GET /shops/{id}/z-candidates` lists each till's closed shifts oldest first and its open shift
- [ ] Z with no open shifts (`includeOpenShift: false`): run completes at once, Z number is the
      shop's next, Z totals = sum of the included X reports
- [ ] "Up to shift" in the middle: the older shifts are included, the newer one waits;
      the next Z takes it (no gap, no double count)
- [ ] Z with a till's open shift included: the till receives `close-shift`, closes unattended
      (no count), the item goes `waiting_close → closing → ready`, and the Z is built when the
      close is accepted; the till's shift history shows the Z number
- [ ] Offline till with an open shift: the run waits; the till closes on its next heartbeat
- [ ] Card payment in flight on the till: it defers (`card_in_flight`), the item shows it,
      and it closes once the payment settles
- [ ] While a till's item waits, the progress line shows the till online/offline, its last
      reported unsent documents with the reading's age, and how many of the closing
      shift's documents the cloud holds
- [ ] Stuck till: `proceed` excluding it builds the Z without it; its shifts stay for the next Z
- [ ] A second run for a till already in a live run is refused (`z_run_in_progress`)
- [ ] `cancel` a waiting run; a later ack/close from the till builds nothing
- [ ] Tenant settings dialog → "הפקת דו״ח Z" → "דו״ח Z לכל קופה", save: a run with two
      tills is refused (`z_scope_machine_one_till`); one till per Z works. Switch back to
      "דו״ח Z לסניף". The option is absent from company and shop settings
- [ ] Z detail (`GET /z-reports/{id}`): business header, per-till sections with first/last
      document number, tenders, discounts, refunds, VAT, tips, and cash (float, expected,
      counted, over/short — null if any shift was uncounted)
- [ ] After the Z, the till's heartbeat carries `zReportedThroughSequence` and the till purges
      the synced documents of those shifts

## Dead till

- [ ] Till with an open shift silent for more than 2 h: `administrative-close` closes it from
      the cloud's documents (reconstructed, unattended, uncounted); refused while online or
      seen < 2 h unless `force`
- [ ] The reconstructed shift is taken by the next Z; the Z shows `reconstructed`
- [ ] `replacement-code` is refused while the till has an open shift, allowed after

## Old builds

- [ ] A pre-shift till gets `410 upgrade_required` on `/trading-day`, `/trading-day/current`,
      `/z-report`, `/close-day/ack`, `/last-close`; the dashboard's old close-day endpoints
      answer 410 too

## API smoke

```bash
H=(-H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT")

curl "${H[@]}" "$API/shops/$SHOP/z-candidates"

curl -X POST "${H[@]}" -H "Content-Type: application/json" \
  -d '{"shopId":"'$SHOP'","machines":[{"machineId":"'$MACHINE'"}]}' "$API/z-runs"

curl "${H[@]}" "$API/z-runs/$RUN"
curl -X POST "${H[@]}" -H "Content-Type: application/json" \
  -d '{"excludeMachineIds":["'$STUCK'"]}' "$API/z-runs/$RUN/proceed"

curl "${H[@]}" "$API/z-reports/$Z"

curl -X POST "${H[@]}" "$API/machines/$MACHINE/close-shift"     # remote close, no Z
curl "${H[@]}" "$API/shift-close-requests/$REQ"
curl -X POST "${H[@]}" "$API/shift-close-requests/$REQ/cancel"
curl "${H[@]}" "$API/shifts?shopId=$SHOP&awaitingZ=true"
```
