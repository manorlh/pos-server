"""
"שינוי הגדרות לסדרות שנבחרו" (app/services/prepaid_voucher_bulk_edit.py): the same change for many
batches, each one through "ערוך סדרה" (app/services/prepaid_voucher_edit.py).

What is pinned:

* **Only the fields sent change** — the rest of every batch stays as it was; a field that is not the
  bulk edit's (a name, the goods, the count) is refused for the whole request.
* **Each batch on its own** — a refusal (the single edit's reason, a field the batch's kind does not
  have, a cancelled batch) is reported and never blocks the others.
* **Scoping** — another tenant's batch and an unknown id: `prepaid_voucher_batch_not_found`; a batch
  the user may not edit: `prepaid_voucher_forbidden` — reported, never skipped; a role that edits no
  batch is refused outright.
* **Idempotent** — a retry with the same `clientRequestId` answers the first result and applies
  nothing again; the same id for another request is refused.
* **The preview is the apply** — the same outcome per batch, and the preview writes nothing.
* **Audit** — each batch's "update" line is the single edit's, with `details.bulk`.
* **The cap** — at most 200 batches a request.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.prepaid_voucher import PrepaidVoucherBatch
from app.models.tenant import Tenant
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import (
    MAX_BULK_BATCHES,
    PrepaidBatchBulkEditIn,
    PrepaidOfflineAssignIn,
    PrepaidVoucherBatchCreate,
    PrepaidVoucherBatchUpdate,
)
from app.services import prepaid_voucher_bulk_edit as PBE
from app.services import prepaid_voucher_offline as PVO
from app.services import prepaid_vouchers as PV
from test_prepaid_voucher_edit import discount_batch, updates
from test_prepaid_vouchers import _ctx, make_batch, w  # noqa: F401 — `w` is the fixture

UNTIL = datetime(2026, 12, 31, 21, 59, tzinfo=timezone.utc)


def body(ids, request_id=None, **changes):
    return PrepaidBatchBulkEditIn(batchIds=[str(i) for i in ids], changes=changes, clientRequestId=request_id)


def preview(w, ids, user=None, **changes):
    return R.preview_prepaid_voucher_batches_bulk_edit(body(ids, **changes), **_ctx(w, user))


def apply(w, ids, user=None, request_id=None, **changes):
    return R.bulk_edit_prepaid_voucher_batches(body(ids, request_id or str(uuid.uuid4()), **changes), **_ctx(w, user))


def row(w, b) -> PrepaidVoucherBatch:
    w.db.expire_all()
    return w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(b["id"])).one()


def by_batch(out):
    return {it["batchId"]: it for it in out["items"]}


def groups_batch(w, count=2, total=2):
    groups = [
        {"name": "מנה", "minQty": 1, "maxQty": 2, "productIds": [w.hotdog.id]},
        {"name": "שתייה", "minQty": 1, "maxQty": 2, "productIds": [w.drink.id]},
    ]
    b = PrepaidVoucherBatchCreate(name="ארוחה", companyId=w.company.id, count=count, selection="groups", groups=groups,
                                  totalQty=total, redemptionAccounting="payment")
    return R.create_prepaid_voucher_batch(b, **_ctx(w))


class TestOnlyTheFieldsSent:
    def test_every_batch_gets_the_change_and_nothing_else_moves(self, w):
        a, b = make_batch(w, count=2), make_batch(w, count=3, shops=[w.shop.id])
        before = {x["id"]: (row(w, x).name, row(w, x).free_text, row(w, x).shop_ids, row(w, x).stacking,
                            row(w, x).redemption_accounting, row(w, x).show_code) for x in (a, b)}
        out = apply(w, [a["id"], b["id"]], validUntil=UNTIL, splitAllowed=True)
        assert out["summary"] == {"total": 2, "applied": 2, "unchanged": 0, "refused": 0}
        assert out["fields"] == ["splitAllowed", "validUntil"]
        for x in (a, b):
            r = row(w, x)
            assert (PV._utc(r.valid_until), r.split_allowed) == (UNTIL, True)
            assert (r.name, r.free_text, r.shop_ids, r.stacking, r.redemption_accounting, r.show_code) == before[x["id"]]
        item = by_batch(out)[a["id"]]
        assert {c["field"] for c in item["changes"]} == {"validUntil", "splitAllowed"}
        assert item["effects"]["validity"] == {"vouchers": 2}

    def test_a_field_already_so_is_unchanged_not_written(self, w):
        a = make_batch(w, count=1)
        out = apply(w, [a["id"]], showCode=False)
        assert by_batch(out)[a["id"]]["status"] == "unchanged"
        assert by_batch(out)[a["id"]]["unchangedFields"] == ["showCode"]
        assert updates(w, a) == []

    @pytest.mark.parametrize("changes", [
        {"name": "אחר"}, {"items": [{"productId": str(uuid.uuid4()), "quantity": 1}]}, {"count": 9},
        {"productionPrice": 10}, {"customerName": "x"}, {},
    ])
    def test_only_the_bulk_fields_are_taken(self, w, changes):
        with pytest.raises(ValidationError):
            PrepaidBatchBulkEditIn(batchIds=[str(uuid.uuid4())], changes=changes)

    def test_a_value_the_single_edit_refuses_is_refused_for_the_whole_request(self, w):
        with pytest.raises(ValidationError):
            PrepaidBatchBulkEditIn(batchIds=[str(uuid.uuid4())], changes={"stacking": "sometimes"})


class TestEachBatchOnItsOwn:
    def test_a_refusal_never_blocks_the_others_and_says_why(self, w):
        goods = make_batch(w, count=2)
        discount = discount_batch(w)
        cancelled = make_batch(w, count=1)
        PV.cancel_batch(w.db, w.admin, w.tenant.id, cancelled["id"])
        w.db.commit()
        out = apply(w, [goods["id"], discount["id"], cancelled["id"]], splitAllowed=True, validUntil=UNTIL)
        items = by_batch(out)
        assert items[goods["id"]]["status"] == "applied"
        assert (items[discount["id"]]["status"], items[discount["id"]]["reason"], items[discount["id"]]["fields"]) == (
            "refused", PBE.NOT_APPLICABLE, ["splitAllowed"])
        assert (items[cancelled["id"]]["status"], items[cancelled["id"]]["reason"]) == ("refused", PV.BATCH_CANCELLED)
        assert out["summary"] == {"total": 3, "applied": 1, "unchanged": 0, "refused": 2}
        assert row(w, goods).split_allowed is True
        assert row(w, discount).valid_until is None and row(w, cancelled).valid_until is None

    def test_the_single_edits_own_rule_refuses_its_batch_only(self, w):
        assigned = R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(
            name="אופליין", companyId=w.company.id, count=2, offlineAllowed=True, redemptionAccounting="payment",
            items=[{"productId": w.hotdog.id, "quantity": 1}]), **_ctx(w))
        R.assign_prepaid_batch_offline(assigned["id"], PrepaidOfflineAssignIn(target="machine", machineId=str(w.tills[0].id)), **_ctx(w))
        free = R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(
            name="רגיל", companyId=w.company.id, count=1, offlineAllowed=True, redemptionAccounting="payment",
            items=[{"productId": w.hotdog.id, "quantity": 1}]), **_ctx(w))
        out = apply(w, [assigned["id"], free["id"]], offlineAllowed=False)
        items = by_batch(out)
        assert (items[assigned["id"]]["status"], items[assigned["id"]]["reason"]) == ("refused", PVO.OFFLINE_ASSIGNED)
        assert items[free["id"]]["status"] == "applied"
        assert row(w, assigned).offline_allowed is True and row(w, free).offline_allowed is False

    def test_a_fixed_value_without_one_is_the_single_edits_refusal(self, w):
        valued = make_batch(w, count=1)
        PV.update_batch(w.db, w.admin, w.tenant.id, valued["id"], PrepaidVoucherBatchUpdate(tillValue=40))
        w.db.commit()
        plain = make_batch(w, count=1)
        out = apply(w, [valued["id"], plain["id"]], pricing="fixed")
        items = by_batch(out)
        assert items[valued["id"]]["status"] == "applied" and row(w, valued).pricing == "fixed"
        assert (items[plain["id"]]["status"], items[plain["id"]]["statusCode"]) == ("refused", 422)
        assert items[plain["id"]]["reason"] == "tillValue is required for a fixed value"

    def test_groups_change_only_on_a_batch_with_groups(self, w):
        meal, goods = groups_batch(w), make_batch(w, count=1)
        out = apply(w, [meal["id"], goods["id"]], totalQty=3)
        items = by_batch(out)
        assert items[meal["id"]]["status"] == "applied" and row(w, meal).total_qty == 3
        assert items[meal["id"]]["effects"]["contents"]["unredeemed"] == 2
        assert (items[goods["id"]]["reason"], items[goods["id"]]["fields"]) == (PBE.NOT_APPLICABLE, ["totalQty"])
        # Out of the groups' range: the single edit's own check.
        bad = by_batch(apply(w, [meal["id"]], totalQty=9))[meal["id"]]
        assert bad["status"] == "refused" and "totalQty must be between" in bad["reason"]

    def test_a_discounts_rules_are_not_a_goods_batchs(self, w):
        goods, discount = make_batch(w, count=1), discount_batch(w)
        items = by_batch(apply(w, [goods["id"], discount["id"]], maxUsesPerDay=2))
        assert items[goods["id"]]["reason"] == PBE.NOT_APPLICABLE
        assert items[discount["id"]]["status"] == "applied" and row(w, discount).max_uses_per_day == 2


    def test_a_batch_that_fails_half_way_is_rolled_back_whole_and_the_others_kept(self, w, monkeypatch):
        a, b, c = make_batch(w, count=1), make_batch(w, count=1), make_batch(w, count=1)
        real_event = PV._event

        def failing(db, batch, *args, **kwargs):
            if str(batch.id) == b["id"]:
                raise RuntimeError("the log could not be written")  # after the columns were set
            return real_event(db, batch, *args, **kwargs)

        monkeypatch.setattr(PV, "_event", failing)
        out = apply(w, [a["id"], b["id"], c["id"]], validUntil=UNTIL, showCode=True)
        items = by_batch(out)
        assert [items[x["id"]]["status"] for x in (a, b, c)] == ["applied", "refused", "applied"]
        assert items[b["id"]]["reason"] == PBE.FAILED
        assert (row(w, b).valid_until, row(w, b).show_code) == (None, False)
        assert row(w, a).show_code is True and row(w, c).show_code is True
        assert len(updates(w, a)) == 1 and updates(w, b) == [] and len(updates(w, c)) == 1


class TestScoping:
    def test_what_the_user_may_not_edit_is_refused_never_skipped(self, w):
        own = make_batch(w, count=1, shops=[w.shop.id], user=w.manager)
        company_wide = make_batch(w, count=1)
        other_tenant = Tenant(id=uuid.uuid4(), name="Other", slug="other", timezone="Asia/Jerusalem")
        w.db.add(other_tenant)
        w.db.flush()
        foreign = make_batch(w, count=1)
        row(w, foreign).tenant_id = other_tenant.id
        w.db.commit()
        missing = str(uuid.uuid4())
        ids = [own["id"], company_wide["id"], foreign["id"], missing, "not-a-uuid"]
        for out in (preview(w, ids, user=w.manager, showCode=True), apply(w, ids, user=w.manager, showCode=True)):
            items = by_batch(out)
            assert len(out["items"]) == 5
            assert items[own["id"]]["status"] in ("ok", "applied")
            assert (items[company_wide["id"]]["reason"], items[company_wide["id"]]["statusCode"]) == (PV.FORBIDDEN, 403)
            for bid in (foreign["id"], missing, "not-a-uuid"):
                assert (items[bid]["status"], items[bid]["reason"]) == ("refused", PV.BATCH_NOT_FOUND)
            # Nothing of a batch the user may not edit is told back.
            assert items[company_wide["id"]]["name"] is None and items[foreign["id"]]["name"] is None
        assert row(w, own).show_code is True
        assert row(w, company_wide).show_code is False and row(w, foreign).show_code is False

    def test_a_shop_manager_cannot_widen_a_batch_to_every_shop(self, w):
        own = make_batch(w, count=1, shops=[w.shop.id], user=w.manager)
        item = by_batch(apply(w, [own["id"]], user=w.manager, shopIds=None))[own["id"]]
        assert (item["reason"], item["statusCode"]) == (PV.FORBIDDEN, 403)

    def test_a_role_that_edits_no_batch_is_refused_outright(self, w):
        a = make_batch(w, count=1)
        for call in (preview, apply):
            with pytest.raises(HTTPException) as e:
                call(w, [a["id"]], user=w.cashier, showCode=True)
            assert e.value.status_code == 403


class TestIdempotent:
    def test_a_retry_answers_the_first_result_and_applies_nothing_again(self, w):
        a, b = make_batch(w, count=1), make_batch(w, count=1)
        key = str(uuid.uuid4())
        first = apply(w, [a["id"], b["id"]], request_id=key, validUntil=UNTIL)
        assert first["replayed"] is False and first["clientRequestId"] == key
        # Changed meanwhile by hand: a retry must not put the bulk's value back.
        PV.update_batch(w.db, w.admin, w.tenant.id, a["id"], PrepaidVoucherBatchUpdate(validUntil=None))
        w.db.commit()
        again = apply(w, [a["id"], b["id"]], request_id=key, validUntil=UNTIL)
        assert again["replayed"] is True
        assert again["items"] == first["items"] and again["summary"] == first["summary"]
        assert row(w, a).valid_until is None
        assert len(updates(w, b)) == 1 and len(updates(w, a)) == 2

    def test_the_same_id_for_another_request_is_refused(self, w):
        a = make_batch(w, count=1)
        key = str(uuid.uuid4())
        apply(w, [a["id"]], request_id=key, showCode=True)
        with pytest.raises(HTTPException) as e:
            apply(w, [a["id"]], request_id=key, showCode=False)
        assert e.value.detail["code"] == "idempotency_key_reused"

    def test_the_apply_needs_its_request_id(self, w):
        a = make_batch(w, count=1)
        with pytest.raises(HTTPException) as e:
            R.bulk_edit_prepaid_voucher_batches(body([a["id"]], None, showCode=True), **_ctx(w))
        assert (e.value.status_code, e.value.detail) == (422, PBE.REQUEST_ID_REQUIRED)


class TestPreviewIsTheApply:
    def test_the_same_outcome_per_batch_and_the_preview_writes_nothing(self, w):
        goods, discount, valued = make_batch(w, count=2), discount_batch(w), make_batch(w, count=1)
        cancelled = make_batch(w, count=1)
        PV.cancel_batch(w.db, w.admin, w.tenant.id, cancelled["id"])
        w.db.commit()
        ids = [goods["id"], discount["id"], valued["id"], cancelled["id"], str(uuid.uuid4())]
        changes = dict(validUntil=UNTIL, stacking="unlimited", maxVouchersPerSale=3, includeExtras=True)
        seen = preview(w, ids, **changes)
        assert row(w, goods).valid_until is None and updates(w, goods) == []
        done = apply(w, ids, **changes)
        as_applied = {"ok": "applied", "unchanged": "unchanged", "refused": "refused"}
        for p, a in zip(seen["items"], done["items"]):
            assert (p["batchId"], as_applied[p["status"]], p.get("reason")) == (a["batchId"], a["status"], a.get("reason"))
            assert p.get("changes") == a.get("changes") and p.get("effects") == a.get("effects")
        assert {it["status"] for it in seen["items"]} == {"ok", "refused"}


class TestAudit:
    def test_each_batch_logs_the_single_edits_line_marked_bulk(self, w):
        a, b = make_batch(w, count=1), make_batch(w, count=1)
        key = str(uuid.uuid4())
        apply(w, [a["id"], b["id"]], request_id=key, stacking="distinct_batches", maxVouchersPerSale=4)
        for x in (a, b):
            (line,) = updates(w, x)
            assert line["details"]["bulk"] == {"requestId": key, "batches": 2}
            assert line["details"]["fields"] == ["max_vouchers_per_sale", "stacking"]
            assert line["userName"]
        # The single edit's line has no such mark.
        PV.update_batch(w.db, w.admin, w.tenant.id, a["id"], PrepaidVoucherBatchUpdate(showCode=True))
        w.db.commit()
        assert "bulk" not in updates(w, a)[0]["details"]


class TestCap:
    def test_at_most_200_batches(self, w):
        assert MAX_BULK_BATCHES == 200
        PrepaidBatchBulkEditIn(batchIds=[str(uuid.uuid4()) for _ in range(200)], changes={"showCode": True})
        with pytest.raises(ValidationError):
            PrepaidBatchBulkEditIn(batchIds=[str(uuid.uuid4()) for _ in range(201)], changes={"showCode": True})

    def test_a_batch_twice_is_one_edit(self, w):
        a = make_batch(w, count=1)
        out = apply(w, [a["id"], a["id"]], showCode=True)
        assert len(out["items"]) == 1 and len(updates(w, a)) == 1


def test_the_routes_are_mounted_before_the_batch_id_routes():
    paths = [(sorted(r.methods), r.path) for r in R.router.routes]
    assert (["POST"], "/prepaid-vouchers/batches/bulk-edit-preview") in paths
    assert (["POST"], "/prepaid-vouchers/batches/bulk-edit") in paths
