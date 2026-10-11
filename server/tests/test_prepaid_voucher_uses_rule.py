"""
"מקסימום שימושים בעסקה" above "מספר שימושים בכל שובר" (app/schemas/prepaid_voucher.py MaxUsesOverUses).

The owner typed 10 uses per sale on a voucher of 1 use, the server lowered it to 1 in silence and
the dashboard said "לא בוצע שינוי". Now a body that SENDS a higher value is refused — 422,
`prepaid_voucher_max_uses_per_sale_over_uses`, with the value and the limit in the Hebrew text — on
a new batch, a new type, a type's edit, a batch's edit and the bulk edit. Stored terms from before
(or uses lowered without touching it) are still read as the most they can be, never refused.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.prepaid_voucher import PrepaidVoucherBatch
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import (
    MAX_USES_PER_SALE_OVER_USES,
    PrepaidBatchBulkEditIn,
    PrepaidVoucherBatchCreate,
    PrepaidVoucherBatchUpdate,
    PrepaidVoucherTypeCreate,
    PrepaidVoucherTypeUpdate,
    max_uses_over_message,
)
from test_prepaid_voucher_edit import discount_batch
from test_prepaid_vouchers import _ctx, w  # noqa: F401 — `w` is the fixture

DISCOUNT = {"kind": "order_discount", "discountType": "fixed", "discountValue": 30}


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def test_the_message_says_the_value_the_limit_and_what_to_do():
    text = max_uses_over_message(10, 1)
    assert text.startswith("לא ניתן לשמור 10:")
    assert "(1)" in text and "יותר מ-1 פעמים" in text and "הגדילו קודם את מספר השימושים בכל שובר" in text


class TestNewBatchesAndTypes:
    def test_a_new_batch_sending_more_than_its_uses_is_refused(self, w):
        with pytest.raises(ValidationError) as e:
            PrepaidVoucherBatchCreate(name="x", companyId=w.company.id, count=1, usesPerVoucher=2, maxUsesPerSale=10, **DISCOUNT)
        (err,) = e.value.errors()
        assert err["type"] == MAX_USES_PER_SALE_OVER_USES
        assert err["ctx"] == {"value": 10, "limit": 2} and err["msg"].startswith("לא ניתן לשמור 10:")

    def test_within_its_uses_it_is_kept(self, w):
        b = PrepaidVoucherBatchCreate(name="x", companyId=w.company.id, count=1, usesPerVoucher=5, maxUsesPerSale=5, **DISCOUNT)
        assert b.max_uses_per_sale == 5

    def test_a_new_type_sending_more_than_its_uses_is_refused(self, w):
        with pytest.raises(ValidationError) as e:
            PrepaidVoucherTypeCreate(companyId=w.company.id, name="x", usesPerVoucher=1, maxUsesPerSale=3, **DISCOUNT)
        assert e.value.errors()[0]["type"] == MAX_USES_PER_SALE_OVER_USES

    def test_a_types_edit_sending_more_is_refused_with_the_limit(self, w):
        t = R.create_prepaid_voucher_type(
            PrepaidVoucherTypeCreate(companyId=w.company.id, name="כרטיסייה", usesPerVoucher=3, maxUsesPerSale=2, **DISCOUNT), **_ctx(w))
        e = refused(R.update_prepaid_voucher_type, t["id"], PrepaidVoucherTypeUpdate(maxUsesPerSale=4), **_ctx(w))
        assert e.status_code == 422
        assert (e.detail["code"], e.detail["value"], e.detail["limit"]) == (MAX_USES_PER_SALE_OVER_USES, 4, 3)
        # Lowering the uses without touching the maximum: read as the most it can be, never refused.
        out = R.update_prepaid_voucher_type(t["id"], PrepaidVoucherTypeUpdate(usesPerVoucher=1), **_ctx(w))
        assert (out["usesPerVoucher"], out["maxUsesPerSale"]) == (1, 1)


class TestEdits:
    def test_a_batch_edit_sending_more_than_its_uses_is_refused_not_lowered(self, w):
        b = discount_batch(w, usesPerVoucher=3)
        e = refused(R.update_prepaid_voucher_batch, b["id"], PrepaidVoucherBatchUpdate(maxUsesPerSale=10), **_ctx(w))
        assert e.status_code == 422
        assert (e.detail["code"], e.detail["value"], e.detail["limit"]) == (MAX_USES_PER_SALE_OVER_USES, 10, 3)
        assert "לא ניתן לשמור 10" in e.detail["message"]
        assert R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(maxUsesPerSale=3), **_ctx(w))["maxUsesPerSale"] == 3

    def test_stored_terms_from_before_never_block_another_edit(self, w):
        b = discount_batch(w, usesPerVoucher=2)
        row = w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(b["id"])).one()
        row.max_uses_per_sale = 5  # written before the rule
        w.db.commit()
        out = R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(maxUsesPerDay=2), **_ctx(w))
        assert (out["maxUsesPerDay"], out["maxUsesPerSale"]) == (2, 2)

    def test_the_bulk_edit_reports_it_per_batch_with_the_message(self, w):
        small, big = discount_batch(w, usesPerVoucher=1), discount_batch(w, usesPerVoucher=5)
        body = PrepaidBatchBulkEditIn(batchIds=[small["id"], big["id"]], changes={"maxUsesPerSale": 4},
                                      clientRequestId=str(uuid.uuid4()))
        items = {it["batchId"]: it for it in R.bulk_edit_prepaid_voucher_batches(body, **_ctx(w))["items"]}
        assert (items[small["id"]]["status"], items[small["id"]]["reason"]) == ("refused", MAX_USES_PER_SALE_OVER_USES)
        assert items[small["id"]]["message"].startswith("לא ניתן לשמור 4:")
        assert items[big["id"]]["status"] == "applied"
