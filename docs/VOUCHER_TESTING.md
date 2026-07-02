# Voucher (שובר) — Manual End-to-End Testing Guide

> **Status (2026-06):** Feature implemented across **pos-server** (cloud API + dashboard) and **pos-desktop** (offline POS). This guide is for **manual E2E verification** before release.

This document walks through testing the full voucher lifecycle: create a template in the cloud dashboard, link it to products/categories, sync to a POS till, sell, print, reprint, and verify cloud upload.

---

## What the feature does

- A **voucher** is a reusable, tenant-scoped print template (title, body, validity, value display, barcode/QR flags).
- A voucher can be linked to a **product** (`product.voucherId`) or to a **category** (`category.voucherId`).
- **Resolution precedence:** product voucher **>** category voucher **>** none. A product inherits its category's voucher only when it has no voucher of its own.
- On a sale, for **each voucher-linked line**, the POS prints **one שובר slip** (showing the purchased product and quantity) after the receipt, and records one `issued_vouchers` row.
- Vouchers work **offline** (after the catalog has synced once); issued vouchers upload with the next transaction sync.

---

## Prerequisites

- [ ] Cloud server running and reachable (`pos-server`), DB migrated to head (`alembic upgrade head`).
- [ ] Dashboard client running (`pos-server/client`).
- [ ] A POS till (`pos-desktop`) paired to a shop and able to sync catalog + transactions.
- [ ] A receipt printer configured and working on the till (voucher prints use the same printer path).
- [ ] At least one **company**, **shop**, and **POS machine** assigned to that shop.
- [ ] A logged-in dashboard user with catalog permissions (super_admin / distributor / company_manager / shop_manager).

> Tip: confirm the till already prints a normal receipt before testing vouchers, to isolate voucher-specific issues from printer issues.

---

## Test data to prepare

| Item | Purpose |
|------|---------|
| Voucher **A** — "Gift שובר", value = product price, barcode + QR on, validity 30 days | Main happy-path template |
| Voucher **B** — "Fixed שובר", value = fixed (e.g. 50), validity none | Fixed-value display test |
| Voucher **C** — created then **deactivated** | Inactive-template test |
| Product **P1** — linked directly to Voucher A | Product-level voucher |
| Product **P2** — no voucher, in a Category linked to Voucher B | Category inheritance |
| Product **P3** — own voucher A, in a category linked to Voucher B | Precedence (product wins) |
| Product **P4** — no voucher, category has no voucher | Negative (no slip) |

---

## Part 1 — Cloud dashboard: create & link

### 1.1 Create voucher templates
1. Go to **Vouchers** in the sidebar.
2. Create Voucher **A** (value mode = product price, barcode + QR enabled, validity 30).
3. Create Voucher **B** (value mode = fixed = 50).
4. Create Voucher **C** (any settings).

- [ ] All three appear in the vouchers list.
- [ ] Editing a voucher persists changes after refresh.

### 1.2 Link a voucher to a product
1. Go to **Products**, edit **P1**.
2. Set the **Voucher** dropdown to Voucher A, save.

- [ ] Reopening P1 shows Voucher A selected.

### 1.3 Link a voucher to a category
1. Go to **Categories**, edit P2's category.
2. Set the **Voucher** dropdown to Voucher B, save.

- [ ] Reopening the category shows Voucher B selected.
- [ ] The hint text explains products inherit unless they have their own voucher.

### 1.4 Precedence setup
1. Put **P3** in the same category as in 1.3 (linked to B).
2. Edit **P3** and set its own voucher to A.

- [ ] P3 has product voucher A; its category has voucher B.

### 1.5 Deactivate test
1. Edit Voucher **C**, set it inactive (or link it to a product then deactivate).

- [ ] Voucher C shows as inactive.

---

## Part 2 — Sync to the POS till

1. On the till, trigger a catalog sync (or wait for MQTT catalog notify / reconnect).
2. Confirm sync log shows vouchers applied (look for `Applied catalog pull: ... vouchers`).

- [ ] Products P1–P4 appear on the POS.
- [ ] No errors in the till logs during voucher upsert.

> **Delta-sync check (important):** After the first sync, change **only** the category's voucher in the dashboard (e.g. switch P2's category from B to A) and sync again. The change must reach the till even though the product rows themselves were not edited (the server bumps affected products' timestamps).

---

## Part 3 — Selling & printing

### 3.1 Product-level voucher (P1), quantity 1
1. Add **P1 × 1** to the cart, checkout (cash).
2. Complete the sale.

- [ ] Receipt prints first.
- [ ] **One שובר slip** prints after the receipt.
- [ ] Slip shows the product name and value per Voucher A (product price).
- [ ] Slip shows a serial (short code + full UUID text) and barcode/QR area if enabled.

### 3.2 Quantity > 1 (one slip per line, qty on slip)
1. Add **P1 × 3** to the cart, checkout, complete.

- [ ] Exactly **one** שובר slip prints (not three).
- [ ] The slip reflects the quantity (e.g. `× 3`) and the computed face value.

### 3.3 Category-inherited voucher (P2)
1. Sell **P2 × 1**.

- [ ] A שובר prints using **Voucher B** (fixed value 50), inherited from the category.

### 3.4 Precedence (P3)
1. Sell **P3 × 1**.

- [ ] The שובר uses **Voucher A** (product-level), NOT the category's Voucher B.

### 3.5 No voucher (P4)
1. Sell **P4 × 1**.

- [ ] Receipt prints; **no** שובר slip prints.

### 3.6 Mixed cart
1. Add P1, P2, and P4 together; checkout once.

- [ ] One receipt.
- [ ] Two שובר slips (P1 → A, P2 → B). None for P4.

---

## Part 4 — Error handling (missing / inactive template)

This verifies the accurate, translated error when a product references a voucher the till can't resolve.

**Setup option (simulate missing template):** link a product to a voucher, sync, then on the till sell it after the voucher was removed/deactivated and re-synced — or use Voucher C (inactive) linked to a product.

1. Sell a product whose voucher is **missing or inactive** on the till.

- [ ] The **sale still completes** (payment taken, transaction saved, receipt prints).
- [ ] A **red alert** shows with title **"השובר לא הונפק" / "Voucher not issued"** (NOT "Print error").
- [ ] The message names the product and explains no voucher was issued.
- [ ] No `issued_vouchers` row is created for that line.

> Compare against a **printer failure** case (turn the printer off): that should show the **receipt/voucher print failure** message ("…check the printer"), which is a different, correct message.

---

## Part 5 — Reprint (העתק) from history

1. Open **Transaction History** on the till.
2. Select a transaction that issued vouchers (e.g. from 3.1).

- [ ] The transaction shows "Issued vouchers / שוברים שהונפקו".
- [ ] A **reprint (העתק)** action is available per issued voucher.
3. Reprint one voucher.

- [ ] The slip prints again, marked as a copy (העתק).
- [ ] The `reprint_count` increments (reprinting again increases it further).
- [ ] Receipt copy reprint also works independently.

---

## Part 6 — Offline behavior

1. Ensure the catalog (incl. vouchers) has synced at least once.
2. **Disconnect the till from the network.**
3. Sell P1 (voucher-linked).

- [ ] Receipt + שובר print normally while offline.
- [ ] The issued voucher is stored locally.
4. **Reconnect** the network and let a transaction sync run.

- [ ] The transaction uploads to the cloud including its `issuedVouchers`.
- [ ] No duplicate issuance on re-sync.

---

## Part 7 — Cloud verification

1. In the dashboard, open **Transactions** and find the synced sale.

- [ ] The transaction detail lists the issued voucher(s) with product, quantity, value, serial, and status.
- [ ] Voucher IDs map to the correct cloud voucher template.

(Optional DB spot-check)

```sql
-- issued vouchers for a transaction
SELECT id, voucher_id, product_name, quantity, unit_value, face_value, status, reprint_count
FROM issued_vouchers
WHERE transaction_id = '<TX_ID>';

-- effective linkage
SELECT p.name, p.voucher_id AS product_voucher, c.voucher_id AS category_voucher
FROM products p JOIN categories c ON c.id = p.category_id
WHERE p.id = '<PRODUCT_ID>';
```

---

## Regression checklist (quick pass)

- [ ] Selling a product with **no** voucher behaves exactly as before (receipt only).
- [ ] Normal catalog sync still applies products/categories correctly.
- [ ] Deactivating a voucher in the dashboard does not crash sync.
- [ ] Clearing a category's voucher (set to "No voucher") removes inheritance after re-sync.

---

## Known limitations / things to watch

- **Post-sale notification:** a missing/inactive voucher does **not** block checkout — the sale completes and the cashier sees a transient alert. Watch for cashiers missing it.
- **Barcode/QR rendering:** confirm whether the slip prints a scannable barcode/QR vs. serial text only, depending on the current template renderer.
- **Partial multi-line failure:** if one voucher line fails to print mid-sale, earlier slips may have printed while issued records may not be saved — note exact behavior if you hit this.
- **Inactive templates on full sync:** an already-synced active copy may linger on the till until the next delta updates it.

---

## Issue reporting template

When filing a bug from this guide, include:

- Part/step number (e.g. **3.4**) and product/voucher used.
- Expected vs. actual (receipt printed? slip printed? how many? message text?).
- Online/offline state and whether a sync had completed.
- Till logs around the sale + relevant `issued_vouchers` rows.
- Screenshot of any on-screen alert (with exact title text).
