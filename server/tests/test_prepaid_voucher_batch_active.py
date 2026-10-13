"""
"סדרה פעילה" — a production-voucher batch turned off / on from the cloud (app/services/
prepaid_voucher_controls.py `set_active`, through "ערוך סדרה": `PUT /prepaid-vouchers/batches/{id}/active`,
`PATCH` with `active`, the bulk edit). Built on "השהיית מימושים" — no table of its own.

What is pinned:

* **Off refuses** — lookup, redeem and both reserves refuse with the paused code (an older till refuses
  alike); the words are "הסדרה כבויה — לא ניתן לממש שוברים ממנה" when the switch made the pause (a pause
  from "בקרה ובדיקות" keeps its own words). **On restores** — every open pause of the batch's own resumed.
* **Idempotent** — off when off, on when on: nothing written, `changed: false`.
* **Audit** — the batch's log: `active_off` / `active_on` with the user (and the reason); the controls'
  log: `pause` / `resume` marked `source: batch_switch`.
* **Bulk** — `active` in "שינוי הגדרות לסדרות שנבחרו": each batch on its own line marked `bulk`, one
  already so `unchanged`; `activeReason` alone is no change.
* **Read model** — `active`, `inactive` (the open pause of its own) and `pausedBy` (its event /
  production / type paused: kind, name, reason) in the list and the detail; the list filter `active`.
* **Permission** — the edit's: whoever may edit the batch; the route's rule is PATCH's.
"""
from __future__ import annotations

import inspect
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.models.prepaid_voucher import PrepaidVoucherBatch
from app.models.prepaid_voucher_extras import PrepaidRedemptionPause, PrepaidVoucherExtraEvent
from app.models.tenant import Tenant
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import (
    PrepaidBatchActiveIn,
    PrepaidBatchBulkEditIn,
    PrepaidVoucherBatchCreate,
    PrepaidVoucherBatchUpdate,
)
from app.services import prepaid_voucher_analytics as PVA
from app.services import prepaid_voucher_controls as CTL
from app.services import prepaid_vouchers as PV
from test_prepaid_voucher_bulk_edit import apply, by_batch, preview
from test_prepaid_voucher_controls import batch, codes, hold, look, pause, take
from test_prepaid_voucher_edit import discount_batch
from test_prepaid_voucher_kinds import basket, reserve
from test_prepaid_voucher_types import make_type
from test_prepaid_vouchers import _ctx, make_batch, refused, w  # noqa: F401 — `w` is the fixture

OFF_TEXT = "הסדרה כבויה — לא ניתן לממש שוברים ממנה"


def switch(w, b, active, reason=None, user=None):
    return R.set_prepaid_voucher_batch_active(b["id"], PrepaidBatchActiveIn(active=active, reason=reason), **_ctx(w, user))


def detail(w, b, user=None):
    w.db.expire_all()
    return R.get_prepaid_voucher_batch(b["id"], **_ctx(w, user))


def listed(w, user=None, **filters):
    rows = R.list_prepaid_voucher_batches(include_cancelled=True, sort="newest", scope=PVA.make_scope(**filters),
                                          **_ctx(w, user))["items"]
    return {r["id"]: r for r in rows}


def events(w, b, *actions):
    return [e for e in R.prepaid_voucher_events(b["id"], **_ctx(w))["items"] if e["action"] in actions]


def extra_events(w):
    w.db.expire_all()
    return w.db.query(PrepaidVoucherExtraEvent).order_by(PrepaidVoucherExtraEvent.created_at).all()


def own_pauses(w, b):
    w.db.expire_all()
    return w.db.query(PrepaidRedemptionPause).filter(
        PrepaidRedemptionPause.scope_kind == "batch", PrepaidRedemptionPause.scope_value == b["id"]).all()


# ── Off refuses, on restores ──────────────────────────────────────────────────


class TestOffAndOn:
    def test_off_refuses_lookup_reserve_and_redeem_with_the_text_and_on_restores(self, w):
        b = batch(w, count=4)
        other = batch(w, name="גאלה", event="ערב גאלה")
        cs = codes(w, b)
        out = switch(w, b, False)
        assert (out["active"], out["changed"], out["inactive"]["reason"]) == (False, True, CTL.SWITCH_DEFAULT_REASON)

        seen = look(w, cs[0])
        assert (seen["redeemable"], seen["reason"], seen["message"]) == (False, CTL.PAUSED, OFF_TEXT)
        e = refused(take, w, cs[0])
        assert (e.status_code, e.detail) == (409, CTL.PAUSED)  # the paused code: an older till refuses alike
        e = refused(hold, w, cs[1])
        assert (e.status_code, e.detail) == (409, {"code": CTL.PAUSED, "message": OFF_TEXT})
        assert take(w, codes(w, other)[0])["ok"]  # another batch goes on

        back = switch(w, b, True)
        assert (back["active"], back["changed"], back["inactive"]) == (True, True, None)
        assert look(w, cs[0])["redeemable"] is True
        assert take(w, cs[0])["ok"]
        assert hold(w, cs[1])["reservationId"]

    def test_a_discount_reserve_is_refused_with_the_paused_code(self, w):
        d = discount_batch(w, count=1)
        switch(w, d, False)
        code = codes(w, d)[0]
        e = refused(reserve, w, code, basket(("l1", w.hotdog, 2, 60)))
        assert (e.status_code, e.detail) == (409, CTL.PAUSED)
        switch(w, d, True)
        assert reserve(w, code, basket(("l1", w.hotdog, 2, 60)))["reservationId"]

    def test_the_reason_is_the_pauses_and_the_offline_snapshot_says_off(self, w):
        b = batch(w)
        out = switch(w, b, False, reason="  האירוע נדחה  ")
        assert out["inactive"]["reason"] == "האירוע נדחה" and out["inactive"]["by"]
        (p,) = own_pauses(w, b)
        assert (p.reason, p.until, p.resumed_at) == ("האירוע נדחה", None, None)
        row = w.db.get(PrepaidVoucherBatch, uuid.UUID(b["id"]))
        assert CTL.offline_snapshot_fields(w.db, row)["paused"]["text"] == OFF_TEXT

    def test_a_pause_made_in_the_controls_keeps_its_own_words_and_on_resumes_it_too(self, w):
        b = batch(w)
        until = datetime.now(timezone.utc) + timedelta(hours=2)
        pause(w, "batch", b["id"], reason="ספירת מלאי", until=until)
        assert detail(w, b)["active"] is False  # the switch shows it off
        assert look(w, codes(w, b)[0])["message"].endswith(": ספירת מלאי")
        assert switch(w, b, False)["changed"] is False  # already off
        out = switch(w, b, True, reason="הספירה הסתיימה")
        assert (out["active"], out["changed"]) == (True, True)
        (p,) = own_pauses(w, b)
        assert p.resumed_at is not None and p.resume_note == "הספירה הסתיימה"
        assert take(w, codes(w, b)[0])["ok"]

    def test_patch_with_active_is_the_same_switch(self, w):
        b = make_batch(w, count=1)
        out = R.update_prepaid_voucher_batch(b["id"], PrepaidVoucherBatchUpdate(active=False, activeReason="סגירה"), **_ctx(w))
        assert out["active"] is False and out["inactive"]["reason"] == "סגירה"
        plan = R.preview_prepaid_voucher_batch_edit(b["id"], PrepaidVoucherBatchUpdate(active=True), **_ctx(w))
        assert plan["changes"] == [{"field": "active", "category": "active", "before": False, "after": True}]
        assert plan["effects"]["active"] == {"on": True, "vouchers": 1} and plan["confirm"] is True
        assert detail(w, b)["active"] is False  # the preview wrote nothing

    def test_a_cancelled_batch_takes_the_switch(self, w):
        b = make_batch(w, count=1)
        PV.cancel_batch(w.db, w.admin, w.tenant.id, b["id"])
        w.db.commit()
        assert switch(w, b, False)["active"] is False


# ── Idempotent ────────────────────────────────────────────────────────────────


class TestIdempotent:
    def test_off_when_off_and_on_when_on_write_nothing(self, w):
        b = batch(w)
        assert switch(w, b, True)["changed"] is False  # on when on
        assert own_pauses(w, b) == [] and events(w, b, CTL.ACTIVE_ON, CTL.ACTIVE_OFF) == []
        switch(w, b, False)
        again = switch(w, b, False, reason="שוב")
        assert (again["changed"], again["active"], again["inactive"]["reason"]) == (False, False, CTL.SWITCH_DEFAULT_REASON)
        assert len(own_pauses(w, b)) == 1
        switch(w, b, True)
        assert switch(w, b, True)["changed"] is False
        assert [e["action"] for e in events(w, b, CTL.ACTIVE_ON, CTL.ACTIVE_OFF)] == [CTL.ACTIVE_ON, CTL.ACTIVE_OFF]
        assert sorted(e.action for e in extra_events(w)) == ["pause", "resume"]


# ── Audit ─────────────────────────────────────────────────────────────────────


class TestAudit:
    def test_the_batch_log_says_who_turned_it_off_and_on(self, w):
        b = batch(w)
        switch(w, b, False, reason="האירוע בוטל")
        switch(w, b, True)
        on, off = events(w, b, CTL.ACTIVE_ON, CTL.ACTIVE_OFF)  # newest first
        assert (off["action"], off["userName"], off["reason"]) == (CTL.ACTIVE_OFF, w.admin.username or w.admin.email, "האירוע בוטל")
        assert (on["action"], on["userName"], on["reason"]) == (CTL.ACTIVE_ON, w.admin.username or w.admin.email, None)
        assert on["details"]["pauseIds"] == [off["details"]["pauseId"]]
        # Never inside an "update" line.
        assert events(w, b, "update") == []
        # The controls' log: the pause and its resume, marked as the switch's.
        by_action = {e.action: e for e in extra_events(w)}
        pause_ev, resume_ev = by_action["pause"], by_action["resume"]
        assert len(by_action) == 2
        assert (pause_ev.action, pause_ev.details["source"], pause_ev.batch_id) == ("pause", CTL.SWITCH_SOURCE, uuid.UUID(b["id"]))
        assert (resume_ev.action, resume_ev.details["source"]) == ("resume", CTL.SWITCH_SOURCE)

    def test_the_pauses_list_shows_the_switch_pause_with_the_tills_words(self, w):
        from app.routers import prepaid_voucher_extras as X

        b = batch(w)
        switch(w, b, False)
        (p,) = X.list_prepaid_voucher_pauses(active=True, **_ctx(w))["items"]
        assert (p["scopeKind"], p["scopeValue"], p["text"], p["reason"]) == ("batch", b["id"], OFF_TEXT, CTL.SWITCH_DEFAULT_REASON)


# ── Bulk ──────────────────────────────────────────────────────────────────────


class TestBulk:
    def test_many_batches_off_each_on_its_own_line_and_one_already_off_unchanged(self, w):
        a, b, c = make_batch(w, count=2), make_batch(w, count=1), discount_batch(w, count=1)
        switch(w, b, False)
        seen = preview(w, [a["id"], b["id"], c["id"]], active=False, activeReason="סוף האירוע")
        assert seen["fields"] == ["active"]
        item = by_batch(seen)[a["id"]]
        assert item["changes"] == [{"field": "active", "category": "active", "before": True, "after": False}]
        assert item["effects"]["active"] == {"on": False, "vouchers": 2}
        assert by_batch(seen)[b["id"]]["status"] == "unchanged"
        assert detail(w, a)["active"] is True  # the preview wrote nothing

        key = str(uuid.uuid4())
        out = apply(w, [a["id"], b["id"], c["id"]], request_id=key, active=False, activeReason="סוף האירוע")
        assert out["summary"] == {"total": 3, "applied": 2, "unchanged": 1, "refused": 0}
        assert by_batch(out)[b["id"]]["unchangedFields"] == ["active"]
        for x in (a, c):
            assert detail(w, x)["active"] is False
            (line,) = events(w, x, CTL.ACTIVE_OFF)
            assert (line["reason"], line["details"]["bulk"]) == ("סוף האירוע", {"requestId": key, "batches": 3})
        marks = {str(e.batch_id): (e.details or {}).get("bulk") for e in extra_events(w)}
        assert marks == {a["id"]: {"requestId": key, "batches": 3}, b["id"]: None, c["id"]: {"requestId": key, "batches": 3}}
        # A retry with the same id applies nothing again.
        again = apply(w, [a["id"], b["id"], c["id"]], request_id=key, active=False, activeReason="סוף האירוע")
        assert again["replayed"] is True and len(events(w, a, CTL.ACTIVE_OFF)) == 1

        back = apply(w, [a["id"], b["id"], c["id"]], active=True)
        assert back["summary"]["applied"] == 3
        assert all(detail(w, x)["active"] for x in (a, b, c))

    def test_a_reason_alone_is_no_change_and_a_batch_the_user_may_not_edit_is_refused(self, w):
        with pytest.raises(ValidationError):
            PrepaidBatchBulkEditIn(batchIds=[str(uuid.uuid4())], changes={"activeReason": "x"})
        own = make_batch(w, count=1, shops=[w.shop.id], user=w.manager)
        company_wide = make_batch(w, count=1)
        out = by_batch(apply(w, [own["id"], company_wide["id"]], user=w.manager, active=False))
        assert out[own["id"]]["status"] == "applied"
        assert (out[company_wide["id"]]["reason"], out[company_wide["id"]]["statusCode"]) == (PV.FORBIDDEN, 403)
        assert detail(w, company_wide)["active"] is True


# ── The read model and the filter ─────────────────────────────────────────────


class TestReadModel:
    @pytest.mark.parametrize("kind,value", [("event", "פסטיבל הקיץ"), ("production", "קייטרינג אלון")])
    def test_a_pause_above_the_batch_is_reported_in_paused_by(self, w, kind, value):
        b = batch(w)
        assert (detail(w, b)["active"], detail(w, b)["pausedBy"]) == (True, None)
        p = pause(w, kind, value, reason="תקלה בקופות")
        for row in (detail(w, b), listed(w)[b["id"]]):
            assert row["active"] is True  # its own switch is still on
            assert row["pausedBy"] == {"pauseId": p["id"], "kind": kind, "kindText": CTL.SCOPE_KIND_TEXT[kind],
                                       "name": value, "reason": "תקלה בקופות", "until": None}
        # Turning it on does not lift its event's / production's pause.
        assert switch(w, b, True)["changed"] is False
        assert look(w, codes(w, b)[0])["message"] == "מימוש השוברים מושהה: תקלה בקופות"

    def test_a_type_pause_is_reported_too(self, w):
        t = make_type(w, redemptionAccounting="payment", pricing="cover")
        b = R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(
            name="מסוג", companyId=w.company.id, typeId=t["id"], count=1), **_ctx(w))
        pause(w, "type", t["id"], reason="סוג בבדיקה")
        assert detail(w, b)["pausedBy"]["kind"] == "type" and detail(w, b)["pausedBy"]["reason"] == "סוג בבדיקה"

    def test_the_list_says_off_and_filters_by_it(self, w):
        on, off = make_batch(w, count=1), make_batch(w, count=1)
        switch(w, off, False, reason="סגירה")
        rows = listed(w)
        assert (rows[on["id"]]["active"], rows[off["id"]]["active"]) == (True, False)
        assert rows[off["id"]]["inactive"]["reason"] == "סגירה"
        assert set(listed(w, active="no")) == {off["id"]}
        assert set(listed(w, active="yes")) == {on["id"]}
        assert set(listed(w)) == {on["id"], off["id"]}
        e = refused(PVA.make_scope, active="maybe")
        assert (e.status_code, e.detail) == (400, f"{PVA.BAD_FILTER}:active")
        # The router's filter reads the query parameter.
        params = inspect.signature(R.voucher_scope).parameters
        assert R.voucher_scope(**{k: None for k in params if k != "active"}, active="no").active is False


# ── Permission ────────────────────────────────────────────────────────────────


class TestPermission:
    def test_the_edits_permission(self, w):
        own = make_batch(w, count=1, shops=[w.shop.id], user=w.manager)
        company_wide = make_batch(w, count=1)
        assert switch(w, own, False, user=w.manager)["active"] is False
        e = refused(switch, w, company_wide, False, user=w.manager)
        assert (e.status_code, e.detail) == (403, PV.FORBIDDEN)
        assert refused(switch, w, own, True, user=w.cashier).status_code == 403
        assert detail(w, company_wide)["active"] is True and detail(w, own)["active"] is False

    def test_another_tenants_batch_and_an_unknown_one_are_not_found(self, w):
        foreign = make_batch(w, count=1)
        other = Tenant(id=uuid.uuid4(), name="Other", slug="other-active", timezone="Asia/Jerusalem")
        w.db.add(other)
        w.db.flush()
        w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(foreign["id"])).update({"tenant_id": other.id})
        w.db.commit()
        for bid in (foreign["id"], str(uuid.uuid4())):
            e = refused(R.set_prepaid_voucher_batch_active, bid, PrepaidBatchActiveIn(active=False), **_ctx(w))
            assert (e.status_code, e.detail) == (404, PV.BATCH_NOT_FOUND)
        assert w.db.query(PrepaidRedemptionPause).count() == 0

    def test_the_route_is_the_batch_edits_section_and_level(self):
        from app.services import dashboard_sections as DS

        mine = DS.rule_for("PUT", "/prepaid-vouchers/batches/{batch_id}/active")
        edit = DS.rule_for("PATCH", "/prepaid-vouchers/batches/{batch_id}")
        assert mine.sections == edit.sections == ("prepaid_vouchers",)
        assert mine.needed_level("PUT") == edit.needed_level("PATCH") == "edit"
        paths = [(sorted(r.methods), r.path) for r in R.router.routes]
        assert (["PUT"], "/prepaid-vouchers/batches/{batch_id}/active") in paths
