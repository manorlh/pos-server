# Close-day (remote Z-close) testing

End-to-end checklist for cloud-initiated close-day and trading-day status on the Machines dashboard.

## Prerequisites

- pos-server running with MQTT broker reachable
- pos-desktop paired, assigned to a shop, MQTT connected
- Dashboard user with `company_manager`, `shop_manager`, `distributor`, or `super_admin`
- An **open trading day** on the POS with at least one synced transaction (so server `trading_days.status = open`)

## Trading-day status on Machines page

- [ ] Open day on POS and sync at least one sale
- [ ] Machines page shows **יום פתוח** for that device
- [ ] `openedAt` / `openedBy` appear when day is open
- [ ] After Z-close, badge shows **אין יום פתוח**

## Single-machine remote close

- [ ] Machine is MQTT online (badge **מחובר**)
- [ ] Click **סגור יום** on machine card
- [ ] Confirm in dialog — progress dialog opens
- [ ] POS shows Close Day dialog with remote banner
- [ ] Enter closing cash and confirm on POS
- [ ] Progress item moves: sent → received → completed
- [ ] Z-report appears under **דוחות Z**

## Batch close

- [ ] Select two machines with open days (checkboxes)
- [ ] Sticky toolbar **סגור יום במכשירים שנבחרו** works
- [ ] Both POS units receive close dialog

## Failure cases

- [ ] Offline machine → item fails immediately with `machine_offline`
- [ ] Machine with no open day on server → `no_open_day`
- [ ] Dismiss close dialog on POS → item `failed` / `cancelled`
- [ ] Duplicate pending request for same machine rejected

## API smoke (optional)

```bash
# List machines (includes tradingDayStatus)
curl -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT" \
  "$API/machines"

# Trigger close-day
curl -X POST -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT" \
  -H "Content-Type: application/json" \
  -d '{"machineIds":["MACHINE_UUID"]}' \
  "$API/machines/close-day"

# Poll progress
curl -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT" \
  "$API/close-day-requests/REQUEST_UUID"
```
