# Refund (החזרה / חשבונית זיכוי) — Manual End-to-End Testing Guide

> **Status (2026-06):** Refund improvements implemented in **pos-desktop** (offline POS).
> **Not yet verified end-to-end** — this guide is for **manual E2E verification** before release.

This document walks through testing the refund lifecycle: full and partial refunds, multiple
partial refunds against the same sale, card refunds via the Nayax terminal, restock on refund,
the credit-note (refund) receipt, and reprinting it from history.

---

## What the feature does

- A **refund** creates a **new transaction** (document type **330**, credit note / חשבונית זיכוי)
  that is **linked to the original sale** via `refundOfTransactionId`.
- **Full refund** refunds all **remaining** (not-yet-refunded) items on the original sale.
- **Partial refund** lets the cashier choose quantities per line, capped by the **remaining**
  refundable quantity.
- **Multiple partial refunds** are supported: remaining quantity per line is recomputed from all
  prior refunds, so you can refund a sale in several steps until nothing remains.
- The **original sale status** becomes `partial_refund` while items remain refundable, and
  `refunded` once everything has been refunded.
- **Cash refunds** are recorded with `paymentMethod: 'cash'`.
- **Card refunds** call the **Nayax** terminal (Ashrait `tranType: 53`) against the original
  terminal transaction ID before the refund is saved; the result is stored in `nayaxMeta`.
- **Stock is restocked** on refund: each refunded line creates a **positive** `stock_movements`
  row with `reason='refund'` (sale movements are *not* re-applied).
- A **refund receipt** (credit note) auto-prints after a successful refund and can be **reprinted**
  from Transaction History.

---

## Prerequisites

- [ ] A POS till (`pos-desktop`) paired to a shop, with catalog synced and able to record sales.
- [ ] A receipt printer configured and working (refund receipts use the same printer path).
- [ ] At least a few products, including **stock-tracked** products (`track_stock = 1`) so restock
      can be verified.
- [ ] A trading day **open** (refunds are same-day; see Known limitations for cross-day).
- [ ] For card-refund tests: a **Nayax terminal** configured in Settings and reachable, plus a
      prior **card sale** taken on that terminal (so a real `originalTransactionId` exists).

> Tip: confirm a normal sale + receipt print works before testing refunds, to isolate
> refund-specific issues from sale/printer issues.

---

## Test data to prepare

| Item | Purpose |
|------|---------|
| Product **S1** — stock-tracked, on-hand known (e.g. 10) | Restock verification |
| Product **S2** — stock-tracked | Multi-line / partial refund |
| Product **N1** — not stock-tracked | No stock movement on refund |
| Sale **TX-CASH** — cash sale of S1 ×2, S2 ×3, N1 ×1 | Cash refund happy path |
| Sale **TX-CARD** — card sale (Nayax) of S1 ×1 | Card refund path |

---

## Part 1 — Cash full refund + restock

1. Record **TX-CASH** (cash): S1 ×2, S2 ×3, N1 ×1. Note on-hand for S1 and S2 before/after the sale.
2. Open **Transaction History**, find TX-CASH.

- [ ] A **Refund** button is shown for the completed sale.

3. Click **Refund**, leave it on **Full Refund**, confirm the amount equals the sale total.
4. Submit.

- [ ] Refund succeeds; success message shown.
- [ ] A **credit-note receipt** prints automatically with title **"חשבונית זיכוי" / "Credit note / Refund"**.
- [ ] The receipt shows **"זיכוי עבור מסמך #… / Refund for document #…"** referencing TX-CASH's number.
- [ ] The receipt shows the **amount refunded** (not a normal payment/change line).
- [ ] In history, the **original sale** TX-CASH now shows status **refunded**.
- [ ] A **new refund transaction** (document type 330) appears in history, linked to TX-CASH.

5. Verify stock restocked:

- [ ] S1 on-hand increased by **2**, S2 increased by **3** (back to pre-sale levels).
- [ ] N1 (not tracked) shows **no** stock change.
- [ ] No double counting (refund must NOT re-apply the original sale's negative movements).

---

## Part 2 — Partial refund

1. Record a fresh cash sale **TX-PART**: S2 ×3.
2. From history, click **Refund** → choose **Partial Refund**.
3. Set quantity for S2 to **1** (leave 2 remaining).

- [ ] The amount-to-return updates to reflect 1 unit (with proportional line discount if any).

4. Submit.

- [ ] Credit-note prints for the partial amount.
- [ ] TX-PART status becomes **partial_refund** (not `refunded`).
- [ ] S2 on-hand increased by **1**.

---

## Part 3 — Multiple partial refunds on the same sale

Continue with **TX-PART** from Part 2 (S2 ×3, of which 1 already refunded → 2 remaining).

1. Open **Refund** on TX-PART again.

- [ ] The Refund button is still available because the sale is `partial_refund`.
- [ ] The dialog shows **remaining = 2** for S2 (not the original 3).

2. Refund **1** more unit. Submit.

- [ ] Succeeds; TX-PART stays **partial_refund**; S2 on-hand +1.

3. Open **Refund** on TX-PART a third time, refund the **last remaining 1** (or use Full Refund).

- [ ] Remaining shows **1**.
- [ ] After submit, TX-PART becomes **refunded**.

4. Try to open **Refund** on TX-PART once more.

- [ ] Either the Refund button is gone, or the dialog reports **"לא נותר… / Nothing left to refund"**
      and blocks submission.
- [ ] Total refunded across all three refunds equals the original S2 ×3 total (no over-refund).

---

## Part 4 — Card refund via Nayax

> Requires a real Nayax terminal and a prior **card** sale (TX-CARD).

1. Confirm **TX-CARD** was paid by card and stored a `nayaxMeta` with a terminal `transactionId`.
2. From history, **Refund** TX-CARD (full).

- [ ] The dialog hints that the refund will go back to the **card** terminal.
3. Submit and follow terminal prompts.

- [ ] The Nayax terminal processes a **refund** (Ashrait `tranType 53`) against the original
      transaction.
- [ ] On approval: refund transaction is saved with `paymentMethod: 'card'` and a `nayaxMeta`
      containing the refund result; credit-note prints; original becomes `refunded`/`partial_refund`.
- [ ] Stock restocks as in the cash case.

**Negative cases:**

- [ ] If the terminal **declines**, an error **"החזר בכרטיס לא אושר / Card refund was not approved"**
      shows and **no** refund transaction is saved, **no** stock change.
- [ ] If the original card sale has **no** terminal transaction ID, error
      **"…מזהה עסקה מקורי חסר / original terminal transaction ID is missing"**; nothing saved.
- [ ] If the Nayax terminal is **not configured**, error **"…לא מוגדר / not configured"**; nothing saved.

---

## Part 5 — Reprint refund receipt from history

1. In **Transaction History**, locate a **refund document** (one with `refundOfTransactionId` set,
   from any part above).

- [ ] It shows a **"הדפס קבלת זיכוי / Reprint refund receipt"** action (not the normal sale-receipt
      reprint).
- [ ] Normal **sale** receipts show **"Reprint receipt (copy)"** and a **Refund** button only for
      `completed` / `partial_refund` sales — **not** for refund documents.

2. Click **Reprint refund receipt**.

- [ ] The credit-note prints again, still titled as a credit note and still referencing the original
      document number.

---

## Part 6 — Validation & edge cases

- [ ] **Partial with nothing selected:** open partial refund, set all quantities to 0, submit →
      error **"בחר לפחות פריט אחד / Select at least one item to refund"**; nothing saved.
- [ ] **Refund a fully-refunded sale:** blocked (button hidden or `nothingRemaining` error).
- [ ] **Cancelled/pending sale:** Refund button is not offered.
- [ ] **Refund document itself:** cannot be refunded (no Refund button on credit notes).

---

## Cloud / sync verification (if applicable)

1. Let a transaction sync run after a refund.

- [ ] The refund transaction (document type 330) uploads and is linked to the original.
- [ ] The original sale's status change (`partial_refund` / `refunded`) reflects in the cloud.
- [ ] Refund stock movements upload with `reason='refund'` and positive deltas; no duplicates on
      re-sync.

(Optional local DB spot-check on the till)

```sql
-- the refund transaction and its link to the original
SELECT id, transaction_number, document_type, status, refund_of_transaction_id, payment_method
FROM transactions
WHERE refund_of_transaction_id = '<ORIGINAL_TX_ID>';

-- stock movements created by a refund (should be positive, reason='refund')
SELECT product_id, delta, reason, transaction_id, occurred_at
FROM stock_movements
WHERE transaction_id = '<REFUND_TX_ID>';
```

---

## Regression checklist (quick pass)

- [ ] A normal sale (no refund) behaves exactly as before; sale stock movements are still negative.
- [ ] Refunding does **not** double-decrement stock (the old bug: refunds applied sale movements).
- [ ] Full refund of a single-line sale closes it out as `refunded`.
- [ ] Cash and card refunds both produce a credit-note receipt.
- [ ] Reprinting a sale receipt still works independently of refund reprint.

---

## Known limitations / things to watch

- **Cross-day refunds:** refunds are intended same-day. A cross-day attempt should surface
  **"החזר עסקה מימים קודמים אינו נתמך / Cross-day refunds are not supported"** — confirm the exact
  behavior in your build.
- **In-memory vs DB status:** after a refund the original row should update to
  `partial_refund`/`refunded` in the on-screen list (today's transactions) as well as in the DB —
  watch for stale status if the refund is for an older (non-today) sale that isn't in the in-memory list.
- **Card refund partial:** verify the terminal accepts multiple partial `tranType 53` refunds
  against one original transaction up to the original amount.
- **Receipt wording/RTL:** check Hebrew and English credit-note layouts (title, "refund of document",
  amount refunded line).

---

## Issue reporting template

When filing a bug from this guide, include:

- Part/step number (e.g. **3.2**) and products/sale used.
- Expected vs. actual (refund saved? receipt printed? status? stock delta? terminal outcome?).
- Cash vs card, and online/offline state.
- Till logs around the refund + relevant `transactions` and `stock_movements` rows.
- Screenshot of any on-screen alert (with exact title text).
