"""
Production vouchers — the §18 controls, the replacement voucher (§16), the simulator (§18.1) and the
§15 reports (app/services/prepaid_voucher_controls.py, …_replacement.py, …_simulator.py,
…_extra_reports.py; the contract's section H):

* **Pause** — an event / batch / type / production stops redeeming at once (lookup, redeem, reserve),
  with the reason in Hebrew; other batches go on; it ends on resume or at its "until".
* **Quota** — at most N redemptions (overall / per day / in a range): the next one refused with a clear
  text; a reversed redemption frees one; raising it is logged.
* **Test vouchers** — redeemable only at a till in training mode; their names say "שובר בדיקה"; out of
  settlement; never marked once something real happened to the batch.
* **Replacement** — the original cancelled, the replacement of the same batch with what was left (or a
  part of it); never twice, never for a voucher used up or held by an open sale.
* **Simulator** — the golden engine on a sample basket: a package whole or incomplete, one of N, value
  split to the agora, cover and top-up, a blocked / forced reduction; nothing written.
* **Reports** — exceptions (flags, reversals, cancellations, replacements), catalog, overrides (not recorded yet).
* **The hook** — the core's refusal check ends with the controls' check; a database without the tables
  refuses nothing. **The migration** — idempotent, offline, on the single head.
"""
from __future__ import annotations

import importlib.util
import io
import pathlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch, PrepaidVoucherRedemption
from app.models.prepaid_voucher_extras import PrepaidVoucherExtraEvent
from app.models.shop import Shop
from app.routers import prepaid_voucher_extras as X
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import PrepaidVoucherBatchCreate, PrepaidVoucherLookupIn
from app.schemas.prepaid_voucher_extras import (
    PauseIn,
    QuotaIn,
    QuotaUpdate,
    ReplacementIn,
    ResumeIn,
    SettlementAgreementIn,
    SimulateIn,
    StaffTestBatchIn,
    StaffTestMarkIn,
)
from app.services import prepaid_voucher_analytics as PVA
from app.services import prepaid_voucher_controls as CTL
from app.services import prepaid_voucher_replacement as RPL
from app.services import prepaid_voucher_simulator as SIM
from app.services import production_voucher_rules as PR
from test_prepaid_voucher_types import make_type
from test_prepaid_vouchers import _ctx, redeem, refused, vouchers, w  # noqa: F401 — `w` is the fixture

ROOT = pathlib.Path(__file__).absolute().parents[1]
FEATURES = ["accounting", "override"]


def batch(w, *, count=3, name="ארוחות", customer="קייטרינג אלון", event="פסטיבל הקיץ", **extra):
    body = PrepaidVoucherBatchCreate(
        name=name, companyId=w.company.id, customerName=customer, eventName=event, count=count,
        items=[{"productId": w.hotdog.id, "quantity": 1}, {"productId": w.drink.id, "quantity": 2}],
        redemptionAccounting="payment", splitAllowed=True, **extra,
    )
    return R.create_prepaid_voucher_batch(body, **_ctx(w))


def codes(w, b):
    return [v["code"] for v in vouchers(w, b)]


def take(w, code, till=None):
    return redeem(w, code, [(w.hotdog, 1)], till=till, features=FEATURES)


def look(w, code, till=None):
    till = till or w.tills[0]
    return R.lookup_prepaid_voucher(str(till.id), PrepaidVoucherLookupIn(code=code, features=FEATURES), machine=till, db=w.db)


def pause(w, kind, value, reason="תקלה בקופות", until=None):
    return X.create_prepaid_voucher_pause(PauseIn(scopeKind=kind, scopeValue=value, reason=reason, until=until), **_ctx(w))


def quota(w, kind, value, n, **kw):
    return X.create_prepaid_voucher_quota(QuotaIn(scopeKind=kind, scopeValue=value, maxRedemptions=n, **kw), **_ctx(w))


# ── Pause (§18.4) ─────────────────────────────────────────────────────────────


class TestPause:
    def test_an_event_paused_refuses_at_once_with_the_reason(self, w):
        b = batch(w)
        other = batch(w, name="גאלה", event="ערב גאלה")
        p = pause(w, "event", "פסטיבל הקיץ")
        assert p["active"] and p["text"] == "מימוש השוברים מושהה: תקלה בקופות"
        out = look(w, codes(w, b)[0])
        assert (out["redeemable"], out["reason"], out["message"]) == (False, CTL.PAUSED, "מימוש השוברים מושהה: תקלה בקופות")
        e = refused(take, w, codes(w, b)[0])
        assert (e.status_code, e.detail) == (409, CTL.PAUSED)
        assert take(w, codes(w, other)[0])["ok"]  # another event goes on

    def test_resume_and_the_audit(self, w):
        b = batch(w)
        p = pause(w, "batch", b["id"])
        assert p["scopeLabel"] == "ארוחות"
        X.resume_prepaid_voucher_pause(p["id"], ResumeIn(note="תוקן"), **_ctx(w))
        assert take(w, codes(w, b)[0])["ok"]
        actions = [e.action for e in w.db.query(PrepaidVoucherExtraEvent).order_by(PrepaidVoucherExtraEvent.created_at)]
        assert actions == ["pause", "resume"]
        listed = X.list_prepaid_voucher_pauses(active=False, **_ctx(w))["items"]
        assert (listed[0]["active"], listed[0]["resumeNote"]) == (False, "תוקן")

    def test_until_ends_it_and_says_so(self, w):
        b = batch(w)
        until = datetime.now(timezone.utc) + timedelta(hours=1)
        p = pause(w, "production", "קייטרינג אלון", until=until)
        assert p["text"].startswith("מימוש השוברים מושהה עד ") and p["text"].endswith(": תקלה בקופות")
        assert look(w, codes(w, b)[0])["reason"] == CTL.PAUSED
        from app.models.prepaid_voucher_extras import PrepaidRedemptionPause

        w.db.query(PrepaidRedemptionPause).update({"until": datetime.now(timezone.utc) - timedelta(minutes=1)})
        w.db.commit()
        assert take(w, codes(w, b)[0])["ok"]
        e = refused(pause, w, "event", "x", until=datetime.now(timezone.utc) - timedelta(minutes=5))
        assert e.detail == CTL.UNTIL_PAST

    def test_a_type_paused(self, w):
        t = make_type(w, redemptionAccounting="payment", pricing="cover")
        b = R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(
            name="מסוג", companyId=w.company.id, typeId=t["id"], count=1), **_ctx(w))
        pause(w, "type", t["id"])
        assert look(w, codes(w, b)[0])["reason"] == CTL.PAUSED
        assert refused(pause, w, "type", str(uuid.uuid4())).status_code == 404
        assert refused(pause, w, "shop", "x").detail == CTL.BAD_SCOPE


# ── Quota (§18.3) ─────────────────────────────────────────────────────────────


class TestQuota:
    def test_the_next_redemption_over_the_quota_is_refused(self, w):
        b = batch(w, count=4)
        q = quota(w, "batch", b["id"], 2)
        cs = codes(w, b)
        take(w, cs[0])
        take(w, cs[1], till=w.tills[1])
        out = look(w, cs[2])
        assert (out["reason"], out["message"]) == (CTL.QUOTA_REACHED, "הגעת למכסת המימושים של הסדרה \"ארוחות\" (2 מימושים)")
        assert refused(take, w, cs[2]).detail == CTL.QUOTA_REACHED
        listed = X.list_prepaid_voucher_quotas(**_ctx(w))["items"][0]
        assert (listed["used"], listed["reached"], listed["warning"], listed["percent"]) == (2, True, True, 100.0)
        # Raising it is logged with before and after.
        X.update_prepaid_voucher_quota(q["id"], QuotaUpdate(maxRedemptions=3, reason="תוספת"), **_ctx(w))
        assert take(w, cs[2])["ok"]
        ev = w.db.query(PrepaidVoucherExtraEvent).filter(PrepaidVoucherExtraEvent.action == "quota_update").one()
        assert (ev.details["before"]["maxRedemptions"], ev.details["after"]["maxRedemptions"], ev.reason) == (2, 3, "תוספת")

    def test_a_reversed_redemption_frees_one(self, w):
        b = batch(w, count=3)
        quota(w, "event", "פסטיבל הקיץ", 1)
        first = take(w, codes(w, b)[0])
        assert refused(take, w, codes(w, b)[1]).detail == CTL.QUOTA_REACHED
        R.reverse_prepaid_redemption(str(w.tills[0].id), first["redemptionId"], machine=w.tills[0], db=w.db)
        w.db.commit()
        assert take(w, codes(w, b)[1])["ok"]

    def test_per_day_counts_today_only(self, w):
        b = batch(w, count=3)
        quota(w, "production", "קייטרינג אלון", 1, period="day")
        out = take(w, codes(w, b)[0])
        w.db.query(PrepaidVoucherRedemption).filter(PrepaidVoucherRedemption.id == uuid.UUID(out["redemptionId"])).update(
            {"redeemed_at": datetime.now(timezone.utc) - timedelta(days=2)})
        w.db.commit()
        assert take(w, codes(w, b)[1])["ok"]
        e = refused(take, w, codes(w, b)[2])
        assert e.detail == CTL.QUOTA_REACHED
        assert look(w, codes(w, b)[2])["message"] == "הגעת למכסת המימושים של ההפקה \"קייטרינג אלון\" (מימוש אחד ביום)"

    def test_a_range_not_running_limits_nothing(self, w):
        b = batch(w, count=2)
        now = datetime.now(timezone.utc)
        quota(w, "batch", b["id"], 0, period="range", periodFrom=now + timedelta(days=1), periodTo=now + timedelta(days=2))
        assert take(w, codes(w, b)[0])["ok"]
        assert refused(quota, w, "batch", b["id"], 1, period="range").detail == CTL.BAD_PERIOD

    def test_another_scope_is_not_counted(self, w):
        b = batch(w, count=2)
        other = batch(w, name="אחרת", event="ערב גאלה", count=2)
        quota(w, "event", "פסטיבל הקיץ", 1)
        take(w, codes(w, other)[0])
        assert take(w, codes(w, b)[0])["ok"]


class TestScope:
    """A pause or a quota never reaches another company's batches, and a narrower manager never sees them."""

    def _other_company(self, w):
        from app.models.company import Company
        from app.models.user import User, UserRole

        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other", vat_number="514141414")
        w.db.add(other)
        w.db.flush()
        cm = User(id=uuid.uuid4(), role=UserRole.COMPANY_MANAGER, tenant_id=w.tenant.id, email="o@x", username="other",
                  company_id=other.id)
        w.db.add(cm)
        w.db.flush()
        from app.models.dashboard_access import DashboardAccessProfile

        w.db.add(DashboardAccessProfile(user_id=cm.id, full_access=True, sections={}))
        w.db.commit()
        return other, cm

    def test_a_company_manager_pauses_their_company_only(self, w):
        b = batch(w)
        other, cm = self._other_company(w)
        # No company named: the manager's own — the batch of the first company keeps redeeming.
        p = X.create_prepaid_voucher_pause(PauseIn(scopeKind="event", scopeValue="פסטיבל הקיץ", reason="תקלה"),
                                           current_user=cm, active_tenant_id=w.tenant.id, db=w.db)
        assert p["companyId"] == str(other.id)
        assert take(w, codes(w, b)[0])["ok"]
        e = refused(X.create_prepaid_voucher_pause, PauseIn(scopeKind="event", scopeValue="x", reason="תקלה",
                                                             companyId=w.company.id),
                    current_user=cm, active_tenant_id=w.tenant.id, db=w.db)
        assert e.status_code == 403
        assert refused(X.create_prepaid_voucher_pause, PauseIn(scopeKind="batch", scopeValue=b["id"], reason="תקלה"),
                       current_user=cm, active_tenant_id=w.tenant.id, db=w.db).status_code in (403, 404)
        # The super admin's pause of the first company is not the other manager's to see or resume
        # (a tenant-wide one — no company — applies to every company, so everyone sees it).
        mine = X.create_prepaid_voucher_pause(PauseIn(scopeKind="event", scopeValue="פסטיבל הקיץ", reason="תקלה",
                                                      companyId=w.company.id), **_ctx(w))
        seen = X.list_prepaid_voucher_pauses(active=False, current_user=cm, active_tenant_id=w.tenant.id, db=w.db)["items"]
        assert [x["id"] for x in seen] == [p["id"]]
        e = refused(X.resume_prepaid_voucher_pause, mine["id"], None, current_user=cm, active_tenant_id=w.tenant.id, db=w.db)
        assert e.status_code == 404

    def test_a_quota_of_another_company_does_not_count_here(self, w):
        b = batch(w, count=2)
        other, cm = self._other_company(w)
        X.create_prepaid_voucher_quota(QuotaIn(scopeKind="production", scopeValue="קייטרינג אלון", maxRedemptions=0),
                                       current_user=cm, active_tenant_id=w.tenant.id, db=w.db)
        assert take(w, codes(w, b)[0])["ok"]
        assert X.list_prepaid_voucher_quotas(**_ctx(w))["items"][0]["companyId"] == str(other.id)

    def test_a_tenant_wide_pause_is_lifted_by_whoever_could_make_it(self, w):
        b = batch(w)
        p = pause(w, "event", "פסטיבל הקיץ")  # the super admin, no company: every company
        other, cm = self._other_company(w)
        assert X.list_prepaid_voucher_pauses(active=True, current_user=cm, active_tenant_id=w.tenant.id,
                                             db=w.db)["items"][0]["editable"] is False
        e = refused(X.resume_prepaid_voucher_pause, p["id"], None, current_user=cm, active_tenant_id=w.tenant.id, db=w.db)
        assert e.status_code == 403
        assert look(w, codes(w, b)[0])["reason"] == CTL.PAUSED

    def test_a_test_batch_takes_no_place_in_a_quota(self, w):
        w.db.query(Shop).filter(Shop.id == w.shop.id).update({"training_mode": True})
        w.db.commit()
        real = batch(w, count=2)
        quota(w, "production", "קייטרינג אלון", 1)
        t = staff_batch(w)
        assert take(w, codes(w, t)[0])["ok"]
        assert take(w, codes(w, real)[0])["ok"]
        assert refused(take, w, codes(w, real)[1]).detail == CTL.QUOTA_REACHED

    def test_the_audit_trail_of_what_one_manages(self, w):
        b = batch(w)
        pause(w, "batch", b["id"])
        other, cm = self._other_company(w)
        assert X.prepaid_voucher_control_events(batch_id=None, limit=200, current_user=cm, active_tenant_id=w.tenant.id,
                                                db=w.db)["items"] == []
        assert [e["action"] for e in X.prepaid_voucher_control_events(batch_id=None, limit=200, **_ctx(w))["items"]] == ["pause"]


# ── Staff test vouchers (§18.5) ───────────────────────────────────────────────


def staff_batch(w, **extra):
    body = StaffTestBatchIn(
        name="ניסיון", companyId=w.company.id, customerName="קייטרינג אלון", eventName="פסטיבל הקיץ", count=2,
        items=[{"productId": w.hotdog.id, "quantity": 1}], redemptionAccounting="payment", testNote="בדיקת צוות", **extra,
    )
    return X.create_prepaid_voucher_test_batch(body, **_ctx(w))


class TestTestVouchers:
    def test_only_at_a_till_in_training_mode(self, w):
        b = staff_batch(w)
        assert b["name"] == "שובר בדיקה · ניסיון"
        assert b["typeName"].startswith("שובר בדיקה")
        out = look(w, codes(w, b)[0])
        assert (out["reason"], out["message"]) == (CTL.TEST_ONLY, "שובר בדיקה — ניתן לממש רק בקופת בדיקה")
        assert out["typeName"].startswith("שובר בדיקה")  # what the receipt prints
        assert refused(take, w, codes(w, b)[0]).detail == CTL.TEST_ONLY
        w.db.query(Shop).filter(Shop.id == w.shop.id).update({"training_mode": True})
        w.db.commit()
        assert take(w, codes(w, b)[0])["ok"]

    def test_the_signed_in_user_needs_the_permission(self, w):
        from app.models.pos_user import PosUser, PosUserRole
        from app.models.pos_user_session import PosUserSession
        from app.services import till_permissions as TP

        b = staff_batch(w)
        w.db.query(Shop).filter(Shop.id == w.shop.id).update({"training_mode": True})
        pu = PosUser(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, username="dana", pin_hash="x",
                     role=PosUserRole.CASHIER, permission_overrides={"states": {CTL.TEST_PERMISSION: TP.DENY}})
        w.db.add(pu)
        w.db.flush()
        w.db.add(PosUserSession(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, pos_user_id=pu.id,
                                machine_id=w.tills[0].id))
        w.db.commit()
        out = look(w, codes(w, b)[0])
        assert (out["reason"], out["message"]) == (CTL.TEST_NOT_PERMITTED,
                                                   "שובר בדיקה — לעובד המחובר אין הרשאת \"מימוש שובר בדיקה\"")
        # A cashier without an override needs a manager's approval at the till — the cloud lets it through.
        pu.permission_overrides = None
        w.db.commit()
        assert take(w, codes(w, b)[0])["ok"]
        # Another till, nobody signed in there: the till's own check stands alone.
        assert take(w, codes(w, b)[1], till=w.tills[1])["ok"]
        assert TP.legacy_effective("cashier").state(CTL.TEST_PERMISSION) == TP.APPROVAL

    def test_out_of_every_settlement(self, w):
        real = batch(w, count=2)
        b = staff_batch(w)
        w.db.query(Shop).filter(Shop.id == w.shop.id).update({"training_mode": True})
        w.db.commit()
        take(w, codes(w, b)[0])
        take(w, codes(w, real)[0])
        a = X.create_settlement_agreement(SettlementAgreementIn(
            name="א", companyId=w.company.id, productionName="קייטרינג אלון"), **_ctx(w))
        assert [r["batchName"] for r in a["batches"]] == ["ארוחות"]
        assert a["totals"]["chargeable"] == 1

    def test_marking_only_before_anything_real(self, w):
        b = batch(w, count=2)
        take(w, codes(w, b)[0])
        e = refused(X.mark_prepaid_voucher_test_batch, b["id"], StaffTestMarkIn(), **_ctx(w))
        assert (e.status_code, e.detail) == (409, CTL.TEST_HAS_HISTORY)
        fresh = batch(w, name="ריקה", count=1)
        out = X.mark_prepaid_voucher_test_batch(fresh["id"], StaffTestMarkIn(note="לצוות"), **_ctx(w))
        assert [i["name"] for i in out["items"]] == ["שובר בדיקה · ריקה"]
        assert refused(X.mark_prepaid_voucher_test_batch, fresh["id"], None, **_ctx(w)).detail == CTL.ALREADY_TEST
        out = X.unmark_prepaid_voucher_test_batch(fresh["id"], **_ctx(w))
        assert out["items"] == []
        row = w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(fresh["id"])).one()
        assert row.name == "ריקה"
        assert X.prepaid_voucher_batch_controls(fresh["id"], **_ctx(w))["test"] is False


# ── Replacement (§16) ─────────────────────────────────────────────────────────


class TestReplacement:
    def test_the_original_is_cancelled_and_the_replacement_inherits_what_was_left(self, w):
        b = batch(w, count=2)
        code = codes(w, b)[0]
        take(w, code)  # a hot dog taken, two drinks left
        original = vouchers(w, b)[0]
        out = X.replace_prepaid_voucher(original["id"], ReplacementIn(reasonKind="damaged", reason="נקרע"), **_ctx(w))
        new = out["voucher"]
        assert (out["original"]["status"], new["status"], new["serial"], new["batchId"]) == ("cancelled", "active", 3, b["id"])
        assert {i["name"]: i["remaining"] for i in new["items"]} == {"נקניקייה": 0, "שתייה": 2}
        assert new["code"] != original["code"] and new["note"] == "שובר חלופי לשובר #1"
        assert look(w, code)["reason"] == "prepaid_voucher_cancelled"
        assert redeem(w, new["code"], [(w.drink, 2)], features=FEATURES)["ok"]
        chain = X.prepaid_voucher_replacement_chain(new["id"], **_ctx(w))
        assert [c["serial"] for c in chain["chain"]] == [1, 3]
        ev = R.prepaid_voucher_events(b["id"], **_ctx(w))["items"]
        assert any(e["action"] == "replace_voucher" and "ניזוק" in (e["reason"] or "") for e in ev)

    def test_a_fixed_value_voucher_redeemed_in_part_is_not_replaced(self, w):
        b = batch(w, count=1, tillValue=80, pricing="fixed")
        v = vouchers(w, b)[0]
        take(w, v["code"])
        e = refused(X.replace_prepaid_voucher, v["id"], ReplacementIn(reasonKind="damaged", reason="נקרע"), **_ctx(w))
        assert (e.status_code, e.detail) == (409, RPL.PARTLY_VALUED)

    def test_an_explicit_part_never_more(self, w):
        b = batch(w, count=1)
        v = vouchers(w, b)[0]
        e = refused(X.replace_prepaid_voucher, v["id"], ReplacementIn(
            reasonKind="lost", reason="אבד", items=[{"productId": w.drink.id, "quantity": 3}]), **_ctx(w))
        assert e.detail == RPL.BAD_ITEMS
        out = X.replace_prepaid_voucher(v["id"], ReplacementIn(
            reasonKind="lost", reason="אבד", items=[{"productId": w.drink.id, "quantity": 1}]), **_ctx(w))
        assert {i["name"]: i["remaining"] for i in out["voucher"]["items"]} == {"נקניקייה": 0, "שתייה": 1}

    def test_never_twice_never_used_up(self, w):
        b = batch(w, count=2)
        v = vouchers(w, b)
        X.replace_prepaid_voucher(v[0]["id"], ReplacementIn(reasonKind="lost", reason="אבד"), **_ctx(w))
        e = refused(X.replace_prepaid_voucher, v[0]["id"], ReplacementIn(reasonKind="lost", reason="אבד"), **_ctx(w))
        assert (e.status_code, e.detail) == (409, RPL.ALREADY_REPLACED)
        redeem(w, v[1]["code"], [(w.hotdog, 1), (w.drink, 2)], features=FEATURES)
        e = refused(X.replace_prepaid_voucher, v[1]["id"], ReplacementIn(reasonKind="lost", reason="אבד"), **_ctx(w))
        assert e.detail == RPL.NOTHING_TO_REPLACE
        assert refused(X.replace_prepaid_voucher, v[1]["id"], ReplacementIn(reasonKind="stolen", reason="xx"),
                       **_ctx(w)).detail == RPL.BAD_REASON

    def test_a_voucher_held_by_an_open_sale_is_not_replaced(self, w):
        from app.schemas.prepaid_voucher import PrepaidVoucherReserveIn

        b = R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(
            name="הנחה", companyId=w.company.id, count=1, kind="order_discount", discountType="fixed", discountValue=10,
        ), **_ctx(w))
        v = vouchers(w, b)[0]
        till = w.tills[0]
        R.reserve_prepaid_voucher(str(till.id), PrepaidVoucherReserveIn(
            code=v["code"], clientRequestId=str(uuid.uuid4()), saleRef="s1",
            lines=[{"id": "l1", "productIds": [str(w.hotdog.id)], "quantity": 1, "grossAgorot": 2500}],
            supportedKinds=["items", "order_discount", "item_discount"],
        ), machine=till, db=w.db)
        e = refused(X.replace_prepaid_voucher, v["id"], ReplacementIn(reasonKind="lost", reason="אבד"), **_ctx(w))
        assert (e.status_code, e.detail) == (409, RPL.IN_USE)

    def test_a_sale_that_held_it_and_never_ended(self, w):
        from app.models.prepaid_voucher import PrepaidVoucherReservation

        b = R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(
            name="הנחה", companyId=w.company.id, count=1, kind="order_discount", discountType="fixed", discountValue=10,
        ), **_ctx(w))
        v = vouchers(w, b)[0]
        w.db.add(PrepaidVoucherReservation(
            id=uuid.uuid4(), tenant_id=w.tenant.id, voucher_id=uuid.UUID(v["id"]), batch_id=uuid.UUID(b["id"]),
            machine_id=w.tills[0].id, client_request_id="r1", sale_ref="s1", uses=1, status="held",
            expires_at=datetime.now(timezone.utc) - timedelta(hours=1),
        ))
        w.db.commit()
        e = refused(X.replace_prepaid_voucher, v["id"], ReplacementIn(reasonKind="lost", reason="אבד"), **_ctx(w))
        assert (e.status_code, e.detail) == (409, RPL.HELD)
        out = X.replace_prepaid_voucher(v["id"], ReplacementIn(reasonKind="lost", reason="אבד, העסקה נבדקה", force=True),
                                        **_ctx(w))
        assert out["voucher"]["usesLeft"] == 1

    def test_not_while_the_batch_is_assigned_offline(self, w):
        from app.services import prepaid_voucher_offline as PVO

        b = batch(w, count=1, offlineAllowed=True)
        PVO.assign(w.db, w.admin, w.tenant.id, b["id"], "machine", str(w.tills[0].id))
        w.db.commit()
        e = refused(X.replace_prepaid_voucher, vouchers(w, b)[0]["id"], ReplacementIn(reasonKind="lost", reason="אבד"),
                    **_ctx(w))
        assert (e.status_code, e.detail) == (409, RPL.ASSIGNED_OFFLINE)

    def test_what_is_left_on_a_grouped_or_used_voucher(self):
        from types import SimpleNamespace

        goods = SimpleNamespace(kind="items")
        assert RPL._what_left(SimpleNamespace(status="partially_used", remaining={"g:a": 1, "g:b": 1, "total": 0}), goods) is False
        assert RPL._what_left(SimpleNamespace(status="partially_used", remaining={"g:a": 0, "g:b": 1, "total": 1}), goods) is True
        assert RPL._what_left(SimpleNamespace(status="used", remaining={"x": 1}), goods) is False

    def test_listed_with_the_batch(self, w):
        b = batch(w, count=1)
        X.replace_prepaid_voucher(vouchers(w, b)[0]["id"], ReplacementIn(reasonKind="lost", reason="אבד"), **_ctx(w))
        out = X.list_prepaid_voucher_replacements(scope=PVA.Scope(), **_ctx(w))
        assert [(i["batchName"], i["originalSerial"], i["replacementSerial"], i["reasonText"]) for i in out["items"]] == [
            ("ארוחות", 1, 2, "אבד")]


# ── Simulator (§18.1) ─────────────────────────────────────────────────────────


def sim(w, terms, lines, *, is_batch=False, **kw):
    key = "batchId" if is_batch else "typeId"
    body = SimulateIn(**{key: terms["id"]}, lines=[{"productId": p.id, "quantity": q} for p, q in lines], **kw)
    return X.simulate_prepaid_voucher(body, **_ctx(w))


class TestSimulator:
    def test_a_package_whole_its_value_split_to_the_agora(self, w):
        t = make_type(w, items=[{"productId": w.hotdog.id, "quantity": 1}, {"productId": w.drink.id, "quantity": 2}],
                      redemptionAccounting="payment")
        out = sim(w, t, [(w.hotdog, 1), (w.drink, 2)])
        assert out["ok"] and out["refusal"] is None
        assert [u["status"] for u in out["units"]] == ["assigned"] * 3
        values = [u["valueAgorot"] for u in out["units"]]
        assert sum(values) == 8000 and out["totals"]["coveredAgorot"] == 8000
        assert out["document"] == {"coveredAgorot": 8000, "tender": "production_voucher", "deduction": None}
        assert [(g["name"], g["taken"], g["maxQty"]) for g in out["groups"]] == [("נקניקייה", 1, 1), ("שתייה", 2, 2)]
        assert "productionPrice" not in str(out)
        # Nothing was written.
        assert w.db.query(PrepaidVoucherBatch).count() == 0

    def test_incomplete_and_not_on_the_voucher(self, w):
        t = make_type(w, items=[{"productId": w.hotdog.id, "quantity": 1}, {"productId": w.drink.id, "quantity": 2}])
        out = sim(w, t, [(w.hotdog, 1), (w.drink, 1)])
        assert (out["ok"], out["refusal"]["code"]) == (False, PR.PACKAGE_INCOMPLETE)
        assert out["refusal"]["text"] == "חסר שתייה להשלמת שובר ארוחה"
        extra = w.general
        out = sim(w, t, [(w.hotdog, 1), (w.drink, 3)])
        assert [u["status"] for u in out["units"]] == ["assigned", "assigned", "assigned", PR.UNIT_TOTAL_FULL]
        out = sim(w, t, [(extra, 1)])
        assert out["units"][0]["status"] in ("unusable", PR.UNIT_NOT_ELIGIBLE)
        assert out["ok"] is False

    def test_cover_and_its_top_up(self, w):
        t = make_type(w, pricing="cover", tillValue=30, allowTopUp=True)
        out = sim(w, t, [(w.hotdog, 1), (w.drink, 1)])  # ₪25 + ₪12 against ₪30
        assert (out["totals"]["coveredAgorot"], out["totals"]["topUpAgorot"], out["note"]) == (3000, 700, "נדרשת השלמה של ₪7")
        t2 = make_type(w, code="nt", pricing="cover", tillValue=30, allowTopUp=False)
        out = sim(w, t2, [(w.hotdog, 1), (w.drink, 1)])
        assert out["refusal"]["code"] == PR.TOP_UP_NOT_ALLOWED

    def test_a_reduction_on_a_no_discount_product(self, w):
        w.hotdog.no_discount = True
        w.db.commit()
        t = make_type(w, tillValue=20)  # ₪25 + ₪12 at ₪20: both lowered
        out = sim(w, t, [(w.hotdog, 1), (w.drink, 1)])
        assert out["refusal"]["code"] == PR.DISCOUNT_BLOCKED
        t2 = make_type(w, code="m2", tillValue=20, discountBlockPolicy={"mode": "manager"})
        out = sim(w, t2, [(w.hotdog, 1), (w.drink, 1)])
        assert out["refusal"]["code"] == PR.APPROVAL_NEEDED
        out = sim(w, t2, [(w.hotdog, 1), (w.drink, 1)], approved=True)
        assert out["ok"] and out["needsApproval"]
        hot = next(u for u in out["units"] if u["productId"] == str(w.hotdog.id))
        assert hot["forced"] and hot["reductionAgorot"] > 0

    def test_groups_with_a_value_each(self, w):
        t = make_type(w, code="grp", selection="groups", tillValue=80, totalQty=2, items=[], redemptionAccounting="payment",
                      groups=[{"name": "מנה", "minQty": 1, "maxQty": 1, "productIds": [w.hotdog.id], "value": 50},
                              {"name": "שתייה", "minQty": 1, "maxQty": 1, "productIds": [w.drink.id], "value": 30}])
        out = sim(w, t, [(w.hotdog, 1), (w.drink, 1)])
        assert out["ok"] and [(u["groupName"], u["valueAgorot"]) for u in out["units"]] == [("מנה", 5000), ("שתייה", 3000)]
        out = sim(w, t, [(w.drink, 2)])
        assert out["ok"] is False
        assert [u["status"] for u in out["units"]] == ["assigned", PR.UNIT_GROUP_FULL]
        assert out["refusal"]["code"] == PR.PACKAGE_INCOMPLETE

    def test_a_discount_voucher(self, w):
        b = R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(
            name="הנחה", companyId=w.company.id, count=1, kind="order_discount", discountType="fixed", discountValue=10,
        ), **_ctx(w))
        out = sim(w, b, [(w.hotdog, 1), (w.drink, 1)], is_batch=True)
        assert (out["ok"], out["kind"], out["totals"]["coveredAgorot"]) == (True, "order_discount", 1000)
        assert sum(u["deductionAgorot"] for u in out["units"]) == 1000

    def test_a_batch_says_whether_it_is_paused(self, w):
        b = batch(w, count=1)
        pause(w, "batch", b["id"])
        out = sim(w, b, [(w.hotdog, 1)], is_batch=True)
        assert out["controls"]["paused"] == "מימוש השוברים מושהה: תקלה בקופות"
        assert refused(X.simulate_prepaid_voucher, SimulateIn(lines=[]), **_ctx(w)).detail == SIM.NEED_TERMS


# ── Reports (§15) ─────────────────────────────────────────────────────────────


class TestReports:
    def test_exceptions_in_one_list(self, w):
        b = batch(w, count=4)
        cs = codes(w, b)
        first = take(w, cs[0])
        R.reverse_prepaid_redemption(str(w.tills[0].id), first["redemptionId"], machine=w.tills[0], db=w.db)
        second = take(w, cs[1])
        w.db.query(PrepaidVoucherRedemption).filter(PrepaidVoucherRedemption.id == uuid.UUID(second["redemptionId"])).update(
            {"flags": ["over_use"]})
        w.db.commit()
        vs = vouchers(w, b)
        R.cancel_prepaid_voucher(vs[2]["id"], **_ctx(w))
        X.replace_prepaid_voucher(vs[3]["id"], ReplacementIn(reasonKind="lost", reason="אבד"), **_ctx(w))
        out = X.prepaid_voucher_exceptions_report(scope=PVA.Scope(), **_ctx(w))
        assert out["counts"] == {"reversed": 1, "over_use": 1, "cancelled": 1, "replaced": 1}
        assert {i["kindText"] for i in out["items"]} >= {"מימוש שבוטל", "שובר שבוטל", "שובר שהוחלף בשובר חלופי"}
        assert out["overridesRecorded"] is True
        # A till filter keeps only what happened at a till.
        out = X.prepaid_voucher_exceptions_report(scope=PVA.make_scope(machine_id=[str(w.tills[0].id)]), **_ctx(w))
        assert set(out["counts"]) == {"reversed", "over_use"}

    def test_overrides_from_the_cores_audit(self, w):
        from app.models.prepaid_voucher import PrepaidVoucherOverrideAudit

        b = batch(w)
        v = vouchers(w, b)[0]
        w.db.add(PrepaidVoucherOverrideAudit(
            id=uuid.uuid4(), tenant_id=w.tenant.id, batch_id=uuid.UUID(b["id"]), voucher_id=uuid.UUID(v["id"]),
            product_id=str(w.hotdog.id), product_name="נקניקייה", list_price_agorot=2500, value_agorot=2000,
            reduction_agorot=500, reduction_bp=2000, policy="manager", approved_by_pos_user_name="רון",
            machine_id=w.tills[0].id, pos_user_name="דנה",
        ))
        w.db.commit()
        out = X.prepaid_voucher_overrides_report(scope=PVA.Scope(), **_ctx(w))
        assert out["recorded"] is True
        row = out["items"][0]
        assert (row["productName"], row["reductionAgorot"], row["reductionBp"], row["approvedBy"], row["preset"],
                row["machineName"]) == ("נקניקייה", 500, 2000, "רון", False, "Till 1")
        assert out["totals"] == {"units": 1, "reductionAgorot": 500, "preset": 0, "approved": 1}
        assert X.prepaid_voucher_exceptions_report(scope=PVA.Scope(), **_ctx(w))["counts"] == {"override": 1}

    def test_catalog(self, w):
        w.drink.no_discount = True
        w.db.commit()
        batch(w)
        out = X.prepaid_voucher_catalog_report(scope=PVA.Scope(), **_ctx(w))
        rows = {r["productName"]: r for r in out["rows"]}
        assert (rows["שתייה"]["noDiscount"], rows["שתייה"]["usable"], rows["שתייה"]["quantity"]) == (True, True, 2)
        assert out["batches"][0]["catalogMode"] == "frozen"
        assert out["totals"] == {"batches": 1, "entries": 2, "blocked": 0, "noDiscount": 1}

    def test_settlement_report_and_unassigned_batches(self, w):
        b = batch(w, count=2, productionPrice=10)
        loose = batch(w, name="בלי הסכם", customer="אחר", count=1)
        take(w, codes(w, b)[0])
        X.create_settlement_agreement(SettlementAgreementIn(name="א", companyId=w.company.id,
                                                            productionName="קייטרינג אלון"), **_ctx(w))
        out = X.prepaid_voucher_settlement_report(scope=PVA.Scope(), **_ctx(w))
        assert (out["totals"]["chargeable"], out["totals"]["amountAgorot"]) == (1, 1000)
        assert [u["name"] for u in out["unassigned"]] == [loose["name"]]


# ── The hook and the migration ────────────────────────────────────────────────


class TestHook:
    def test_without_the_tables_nothing_is_refused(self, w, monkeypatch):
        b = batch(w)
        pause(w, "batch", b["id"])
        monkeypatch.setattr(CTL, "tables_ready", lambda db: False)
        v = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == uuid.UUID(b["id"])).first()
        assert CTL.refusal_reason(w.db, w.tills[0], v) is None

    def test_the_core_checks_come_first(self, w):
        b = batch(w, count=1)
        R.cancel_prepaid_voucher(vouchers(w, b)[0]["id"], **_ctx(w))
        pause(w, "batch", b["id"])
        assert look(w, codes(w, b)[0])["reason"] == "prepaid_voucher_cancelled"


class TestMigration:
    def _module(self):
        path = ROOT / "alembic" / "versions" / "e4b9d2a7c6f1_prepaid_voucher_extras.py"
        spec = importlib.util.spec_from_file_location("migration_e4b9d2a7c6f1", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_idempotent_and_offline(self):
        import sqlalchemy as sa
        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext

        module = self._module()
        assert module.down_revision == "c5d2a8e4f913"
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            for t in ("tenants", "companies", "users", "report_events", "prepaid_voucher_batches", "prepaid_vouchers",
                      "prepaid_productions"):
                conn.execute(sa.text(f"CREATE TABLE {t} (id CHAR(32) PRIMARY KEY)"))
            conn.execute(sa.text("CREATE TABLE prepaid_voucher_reservations (id CHAR(32) PRIMARY KEY, batch_id CHAR(32), "
                                 "status VARCHAR(16), expires_at TIMESTAMP)"))
            # One table already made by the API's create_all, without its index.
            conn.execute(sa.text("CREATE TABLE prepaid_voucher_deliveries (id CHAR(32) PRIMARY KEY, batch_id CHAR(32), "
                                 "delivered_at TIMESTAMP)"))
            with Operations.context(MigrationContext.configure(conn)):
                module.upgrade()
                module.upgrade()  # idempotent
            insp = sa.inspect(conn)
            assert all(insp.has_table(t) for t in module.TABLES)
            assert "ix_prepaid_voucher_deliveries_batch" in {i["name"] for i in insp.get_indexes("prepaid_voucher_deliveries")}
            assert module.HELD_INDEX[0] in {i["name"] for i in insp.get_indexes("prepaid_voucher_reservations")}
            with Operations.context(MigrationContext.configure(conn)):
                module.downgrade()
            assert not any(sa.inspect(conn).has_table(t) for t in module.TABLES)
            assert sa.inspect(conn).get_indexes("prepaid_voucher_reservations") == []
        buf = io.StringIO()
        offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
        with Operations.context(offline):
            module.upgrade()
        assert buf.getvalue().count("CREATE TABLE") == len(module.TABLES) == 10

    def test_on_the_single_head(self):
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        script = ScriptDirectory.from_config(Config(str(ROOT / "alembic.ini")))
        heads = script.get_heads()
        assert len(heads) == 1
        assert "e4b9d2a7c6f1" in {r.revision for r in script.walk_revisions("base", heads[0])}
