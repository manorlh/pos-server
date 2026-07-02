# Shop-level Inventory (מלאי סניף) — Manual End-to-End Testing Guide

> **Status (2026-06):** Feature implemented across **pos-server** (cloud API + dashboard) and **pos-desktop** (offline POS). This guide is for **manual E2E verification** before release.

This document walks through testing the full inventory lifecycle: opt a product into stock tracking, set the out-of-stock policy via the settings hierarchy, receive/adjust/count stock in the dashboard, sync to a POS till, sell offline, enforce the policy, upload movements, and verify the cloud reconciles authoritative per-shop counts.

---

## What the feature does

- Inventory is tracked **per shop** (`shop_id` + global `product_id`). Movements record `machine_id` for audit only.
- Tracking is **opt-in per product** (`Product.trackStock`, default false), so untracked products behave exactly as before.
- Stock is a **movement ledger**, not an absolute value. Every change is an append-only **movement** (a signed delta with a client-generated UUID). The authoritative on-hand is the sum of movements, materialized into a `stock_levels` cache for fast reads.
- Applying movements is **idempotent** (`ON CONFLICT (id) DO NOTHING`) and order-independent — safe to re-sync.
- **POS display** = last cloud `base_quantity` + sum of local **unsynced** movement deltas. POS pulls stock after the outbox flush to minimize the double-count window.
- **Out-of-stock policy** (`block` / `warn` / `allow`) is a setting resolved through the **tenant → company → shop** hierarchy. Default when unset: `allow` (no disruption).
- Negative stock is allowed (sold more than known) and surfaced as a negative/low alert, corrected by a stocktake.

> **Important conceptual note:** Enabling "Track stock" on a product does **not** by itself create inventory. The legacy `stockQuantity` / "In stock" product field is **separate** from shop-level inventory. A newly tracked product starts at **0 on hand** in every shop until you record a **goods receipt** or **stocktake**.

---

## Prerequisites

- [ ] Cloud server running and reachable (`pos-server`), DB migrated to head (`alembic upgrade head`, includes revision `e1f2a3b4c5d6`).
- [ ] Dashboard client running (`pos-server/client`).
- [ ] A POS till (`pos-desktop`) paired to a shop and able to sync catalog + transactions.
- [ ] At least one **company**, **shop**, and **POS machine** assigned to that shop.
- [ ] A logged-in dashboard user with catalog + stock permissions (super_admin / distributor / company_manager / shop_manager).

> Tip: confirm the till already syncs catalog and uploads a normal transaction before testing inventory, to isolate inventory-specific issues.

---

## Test data to prepare

| Item | Purpose |
|------|---------|
| Product **S1** — "Track stock" ON, no reorder min | Main happy-path tracked product |
| Product **S2** — "Track stock" ON, reorder min = 5 | Low-stock highlight test |
| Product **U1** — "Track stock" OFF | Negative/untracked test (no enforcement) |
| Shop **Shop-A** with a paired till | Primary shop under test |
| Shop **Shop-B** (optional) | Per-shop isolation test |

---

## Part 1 — Cloud dashboard: enable tracking & set policy

### 1.1 Enable stock tracking on products
1. Go to **Products** in the sidebar, edit **S1**.
2. Toggle **Track stock** (מעקב מלאי) ON, save.
3. Repeat for **S2** (and leave **U1** OFF).

- [ ] Reopening S1 / S2 shows "Track stock" still ON.
- [ ] U1 shows "Track stock" OFF.

### 1.2 Set the out-of-stock policy (hierarchy)
1. Open the settings dialog (tenant, company, or shop scope) where the POS settings form renders.
2. Set **Out-of-stock policy** to `block` for Shop-A (or company/tenant), save.

- [ ] The selector persists the chosen value after refresh.
- [ ] A shop-level value overrides company; company overrides tenant (resolved via merge).
- [ ] When left unset everywhere, the effective policy is `allow`.

---

## Part 2 — Dashboard stock view (`/dashboard/shops/stock`)

### 2.1 Initial state
1. Go to **מלאי סניף** (Shop stock) in the sidebar.
2. Select **Shop-A** in the shop dropdown.

- [ ] Tracked products **S1** and **S2** appear in the table with **on-hand = 0**.
- [ ] Untracked **U1** does **not** appear.
- [ ] If no products are tracked at all, an informative empty message is shown (not a blank table).
- [ ] No `422` / failed network request on the products list (pageSize is within the API limit of 200).

### 2.2 Goods receipt
1. Click **Goods receipt** (קבלת סחורה).
2. Pick **S1**, quantity **10**, optional note, save.

- [ ] Toast confirms the receipt.
- [ ] S1 row updates to **10** without a manual refresh.

### 2.3 Adjustment (+/−)
1. On the **S1** row, open **Adjust** (התאמה).
2. Enter delta **−3**, save.

- [ ] S1 updates to **7**.
- [ ] Entering delta **0** is rejected (cannot be zero).

### 2.4 Stocktake (absolute count)
1. On the **S2** row, open **Stocktake** (ספירת מלאי).
2. Enter counted quantity **4**, save.

- [ ] S2 updates to **4**.
- [ ] Because S2's reorder min = 5, a **low-stock** badge appears (4 ≤ 5).

### 2.5 Negative display
1. Adjust **S1** by **−20**.

- [ ] S1 shows **−13** rendered in a destructive/negative style.
- [ ] The value is not clamped to 0.

### 2.6 Per-shop isolation (optional)
1. Switch the dropdown to **Shop-B**.

- [ ] Shop-B shows its own counts (tracked products at 0 if untouched), independent of Shop-A.

---

## Part 3 — Sync to the POS till

1. On the till, trigger a catalog sync (or wait for MQTT catalog notify / reconnect).
2. Trigger a stock pull (runs automatically after the outbox flush; reconnect to force it).

- [ ] Tracked products show their **on-hand** on the product tiles (e.g. S1 = current cloud value).
- [ ] Untracked products show no on-hand badge.
- [ ] No errors in the till logs during stock upsert.

> **Delta-sync check (important):** After the first pull, change **only** stock in the dashboard (e.g. a goods receipt for S1) and let the till pull again. The new base must reach the till. The sync **watermark** must include movement timestamps (same delta-sync gap previously fixed for vouchers and tenant settings) — otherwise dashboard-only stock changes won't propagate.

---

## Part 4 — Selling & out-of-stock enforcement (offline-capable)

> Set the effective policy per the case below (Part 1.2) and re-pull settings on the till before each sub-test.

### 4.1 Policy = `allow` (default)
1. Set on-hand of S1 to a small number (e.g. 2) via dashboard, pull on till.
2. Add **S1** to the cart beyond stock (e.g. ×5), checkout, complete.

- [ ] Add-to-cart is **never blocked**.
- [ ] Sale completes; on-hand goes negative locally (base + unsynced deltas).

### 4.2 Policy = `warn`
1. Set policy to `warn`, re-pull on till. On-hand S1 = 2.
2. Add **S1** when at/over the limit.

- [ ] A **warning dialog** appears showing remaining on-hand and asks to continue.
- [ ] **Cancel** → item is NOT added.
- [ ] **Continue** → item IS added; sale can complete.

### 4.3 Policy = `block`
1. Set policy to `block`, re-pull on till. On-hand S1 = 0 (or sell down to 0).
2. Try to add **S1** when on-hand would go negative.

- [ ] A **block message** appears; the item is **NOT** added.
- [ ] Adding within available stock (on-hand ≥ requested) still works normally.

### 4.4 Untracked product (U1)
1. With any policy, add **U1** in any quantity.

- [ ] No stock check, no dialog — behaves exactly as before.

### 4.5 On-hand reflects unsynced sales
1. While **offline**, sell **S1 × 1** (tracked).

- [ ] The product tile's on-hand decreases immediately (base + local unsynced delta).
- [ ] One `sale` movement is stored locally with `synced = 0` and its own UUID.

---

## Part 5 — Upload & cloud reconciliation

1. Reconnect the till and let a transaction sync run.

- [ ] The transaction uploads including `stockMovements[]`.
- [ ] After the flush, local movements for that transaction are marked **synced = 1**.
- [ ] A **stock pull** runs right after the flush; the till's `base_quantity` now matches the cloud, and on-hand no longer double-counts the just-synced sale.
2. In the dashboard stock view for Shop-A, refresh.

- [ ] On-hand reflects the POS sale (decremented by the sold quantity).

### 5.1 Idempotency / re-sync
1. Force a re-sync of the same transaction (e.g. retry, or re-trigger the outbox).

- [ ] On-hand is **not** decremented twice (movement UUIDs are de-duplicated on the cloud).
- [ ] No duplicate `stock_movements` rows for the same movement id.

---

## Part 6 — Multi-till eventual consistency (optional, needs 2 tills)

1. Pair a second till to **Shop-A**, sync stock on both. On-hand S1 = 10 on both.
2. Sell **S1 × 3** on Till-1 and **S1 × 4** on Till-2 while **both offline**.

- [ ] Each till shows its own locally-adjusted on-hand (7 and 6 respectively).
3. Reconnect both and let them sync, then pull stock.

- [ ] Cloud authoritative on-hand = **3** (10 − 3 − 4), summing both tills' movements.
- [ ] Both tills converge to 3 after pulling. Transient divergence before both sync is expected.

---

## Part 7 — Cloud verification (DB spot-check, optional)

```sql
-- materialized on-hand per shop/product
SELECT shop_id, product_id, quantity, reorder_min, updated_at
FROM stock_levels
WHERE shop_id = '<SHOP_ID>';

-- movement ledger for a product in a shop
SELECT id, delta, reason, transaction_id, machine_id, occurred_at, created_at
FROM stock_movements
WHERE shop_id = '<SHOP_ID>' AND product_id = '<GLOBAL_PRODUCT_ID>'
ORDER BY created_at;

-- sanity: sum of movements should equal the cached level quantity
SELECT
  (SELECT quantity FROM stock_levels WHERE shop_id = '<SHOP_ID>' AND product_id = '<GLOBAL_PRODUCT_ID>') AS cached,
  (SELECT COALESCE(SUM(delta), 0) FROM stock_movements WHERE shop_id = '<SHOP_ID>' AND product_id = '<GLOBAL_PRODUCT_ID>') AS ledger_sum;
```

- [ ] `cached` equals `ledger_sum` for the product under test.
- [ ] Movement `reason` values are correct (`sale`, `goods_receipt`, `adjustment`, `stocktake`).

---

## Regression checklist (quick pass)

- [ ] Selling an **untracked** product behaves exactly as before (no stock checks, no badges).
- [ ] Normal catalog sync still applies products/categories correctly.
- [ ] Products list in the dashboard still loads (no `pageSize` 422).
- [ ] Toggling "Track stock" off again hides the product from the shop stock view.
- [ ] A shop with zero tracked products shows the informative empty state, not an error.

---

## Known limitations / things to watch

- **Out-of-stock policy does not block at checkout, only at add-to-cart** in the current flow — confirm whether a cashier can still reach an oversell via cart edits.
- **Refund / void compensating movements** are a follow-up tied to the existing refund/void work and are **not** in this phase. Refunding a sale will not automatically restock yet.
- **Double-count window:** between an offline sale and the post-flush stock pull, on-hand is computed as base + unsynced deltas. After the pull the base already includes the sale, so the window must close cleanly — watch for a brief double-decrement if the pull races the flush.
- **Watermark coverage:** dashboard-only stock changes (no product edit) must still reach the till; verify the stock sync watermark includes movement timestamps.
- **Negative stock** is intentional, not a bug; it is corrected by a stocktake.

---

## Issue reporting template

When filing a bug from this guide, include:

- Part/step number (e.g. **4.3**) and product/shop/policy used.
- Expected vs. actual (on-hand value? dialog shown? blocked or allowed?).
- Online/offline state and whether a sync + stock pull had completed.
- Effective out-of-stock policy and where it was set (tenant/company/shop).
- Till logs around the sale + relevant `stock_levels` / `stock_movements` rows.
- Screenshot of any on-screen dialog or the stock table.
