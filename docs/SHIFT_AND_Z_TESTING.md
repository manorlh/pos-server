# Shifts and cloud Z — manual testing

End-to-end checklist for shifts on the till and the Z produced in the cloud. The wire
contract is `docs/SHIFTS_API.md`; the plan is `pos-android/docs/shifts-plan.md`.

## Prerequisites

- pos-server at migration head `a0b1c2d3e4f5` (take a `pg_dump` into `~/dev/pos-backups` first)
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
- [ ] Close without counting: `countedCash` and `discrepancy` are null, not 0
- [ ] Open a second shift at once and sell; the machines page shows
      `closedShiftsAwaitingZ: 1`

## Offline close, then a new shift

- [ ] Take the till offline, close shift N, open N+1, sell
- [ ] Bring it online: the outbox delivers open(N)→docs(N)→close(N)→open(N+1)→docs(N+1)
- [ ] No document of N+1 lands in N (compare `GET /shifts/{id}` counts with the till)
- [ ] While close(N) is still queued, a document of N+1 is answered
      `409 another_shift_open` and retried later — never `rejected`

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
- [ ] Stuck till: `proceed` excluding it builds the Z without it; its shifts stay for the next Z
- [ ] A second run for a till already in a live run is refused (`z_run_in_progress`)
- [ ] `cancel` a waiting run; a later ack/close from the till builds nothing
- [ ] Tenant `zScope: machine`: a run with two tills is refused; one till per Z works
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
curl "${H[@]}" "$API/shifts?shopId=$SHOP&awaitingZ=true"
```
