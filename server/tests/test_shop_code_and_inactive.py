"""
Branch codes in sequence, and an inactive shop that locks its devices
(P:/specs/shop-code-and-inactive.md, approved 13.10.2026 with all of §4's recommendations).

Owner: "קוד סניף שיהיה אוטומטי ברצף, עם אופציה לשנות" and "אפשר להפוך לסניף לא פעיל, והפיכה
כזו גם תנעל את המכשירים (הרשאה לסופר אדמין)".

* **The next code** — the highest numeric code in the company plus 1, 1 with none (decision 3);
  `GET /shops/next-branch-code` peeks it for the create form. `POST /shops` without a code gets
  it; the form's suggestion left as it was (`branchIdAuto`) and taken meanwhile gets the next one
  without an error; a code typed by hand that is taken is still a 409. Drawn under a lock on the
  company row (asserted on compiled Postgres SQL — SQLite ignores `FOR UPDATE`).
* **The switch** — `isActive` changes are the super admin's only (403 Hebrew), need a reason
  (422), are logged (who, when, why), move the shop's settings watermark and wake every device of
  the shop (realtime `settings`, reason `shop_active`). The same value again changes nothing.
* **The contract** — `shopActive` beside `trainingMode`: `GET /machines/me`, the heartbeat and
  the settings sync (top level on every answer, "unchanged" included; `settings.shopActive` on a
  full / delta pull). True for a device in no shop.
* **Pairing** into an inactive shop is refused (409 `shop_inactive`) on every road: a code made
  for it, a code redeemed for it, a replacement unit, a QR claim, assigning or moving a machine.
* **Uploads are not blocked** — sales, shifts and a Z from an inactive shop's till are accepted:
  a document made before the lock must never be lost.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql

from app.models.company import Company
from app.models.device_pairing_request import DevicePairingRequest, DevicePairingStatus
from app.models.pairing_code import PairingCode
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.shop_active_log import ShopActiveLog
from app.models.transaction import Transaction
from app.models.user import User, UserRole
from app.routers import machines as machines_router
from app.routers import pairing as pairing_router
from app.routers import shops as shops_router
from app.routers import sync as sync_router
from app.schemas.pairing_code import MachineAssignRequest, PairingCodeGenerateRequest
from app.schemas.pos_machine import POSMachineUpdate
from app.schemas.shift import ShiftCloseIn, ShiftOpenIn
from app.schemas.shop import ShopCreate, ShopResponse, ShopUpdate
from app.schemas.till_z import TillZIn
from app.schemas.transaction import TransactionsBatchEnvelope
from app.services import ably_notify, branch_code, settings_notify, shop_active
from app.services import pairing as P
from app.services import pairing_mobile as PM
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    # Opening a shop seeds its operator and runs the company's product rules; reactivating one
    # runs them again — tested elsewhere (test_product_shop_scope.py), not here.
    monkeypatch.setattr(shops_router, "ensure_default_pos_user", lambda *a, **k: None)
    monkeypatch.setattr(shops_router, "reconcile_shops", lambda *a, **k: set())
    monkeypatch.setattr(shops_router, "notify_machines_for_shop_settings", lambda *a, **k: None)
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    # Every realtime `settings` signal: (tenant, machine, reason).
    world.signals = []
    monkeypatch.setattr(
        settings_notify, "publish_settings_notify",
        lambda tenant_id, machine_id, reason="settings_changed", hint=None: world.signals.append(
            (tenant_id, machine_id, reason)
        ),
    )
    for till in world.tills + [world.other_till]:
        till.z_mode = "cloud"
    world.db.commit()
    return world


def _user(w, role, **kw):
    u = User(id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, email=f"{uuid.uuid4().hex[:8]}@x",
             username=uuid.uuid4().hex[:8], **kw)
    w.db.add(u)
    w.db.flush()
    return u


def _manager(w):
    return _user(w, UserRole.COMPANY_MANAGER, company_id=w.company.id)


def _create(w, user=None, **body):
    return shops_router.create_shop(
        ShopCreate.model_validate({"name": "חדש", "companyId": str(w.company.id), **body}),
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _update(w, shop=None, user=None, **body):
    return shops_router.update_shop(
        str((shop or w.shop).id), ShopUpdate.model_validate(body),
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _next(w, user=None, company_id=None):
    return shops_router.get_next_branch_code(
        company_id=company_id or w.company.id, current_user=user or w.admin,
        active_tenant_id=w.tenant.id, db=w.db,
    )["nextBranchCode"]


def _refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def _codes(w, *codes):
    """Give the world's shops (and as many new ones as needed) these branch codes."""
    shops = [w.shop, w.other_shop]
    for i, code in enumerate(codes):
        if i < len(shops):
            shops[i].branch_id = code
        else:
            w.db.add(Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id,
                          name=f"S{i}", branch_id=code, settings={}))
    w.db.commit()


def _off(w, shop=None, reason="סגירת סניף"):
    return _update(w, shop, isActive=False, activeReason=reason)


# ── The next code ─────────────────────────────────────────────────────────────


class TestNextCode:
    @pytest.mark.parametrize("used, expected", [
        ([], "1"),
        ([None], "1"),
        (["1", "2", "4"], "5"),          # the highest plus 1, not the gap (decision 3)
        (["7", "A1", None, "003"], "8"),  # a non-digit code from before the rule does not count
        (["001"], "2"),
        (["9999999"], "1"),               # past 7 digits: the lowest free code, so it fits 1231
        (["9999999", "1", "2"], "3"),
    ])
    def test_the_highest_numeric_code_plus_one(self, used, expected):
        assert branch_code.next_code_after(used) == expected

    def test_the_create_forms_pre_fill(self, w):
        assert _next(w) == "1"  # a company with no codes yet
        _codes(w, "3", "10")
        assert _next(w) == "11"
        # Another company's codes are its own.
        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other", vat_number="514141414")
        w.db.add(other)
        w.db.add(Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=other.id, name="O", branch_id="50",
                      settings={}))
        w.db.commit()
        assert _next(w) == "11" and _next(w, company_id=other.id) == "51"

    def test_a_peek_holds_nothing(self, w):
        assert _next(w) == "1" and _next(w) == "1"
        assert _create(w).branch_id == "1"

    def test_who_may_ask_is_who_may_open_a_shop(self, w):
        assert _next(w, _manager(w)) == "1"
        assert _next(w, _user(w, UserRole.DISTRIBUTOR)) == "1"
        assert _refused(_next, w, _user(w, UserRole.SHOP_MANAGER, shop_id=w.shop.id)).status_code == 403
        # A manager of another company is not this one's.
        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other", vat_number="514141414")
        w.db.add(other)
        w.db.commit()
        stranger = _user(w, UserRole.COMPANY_MANAGER, company_id=other.id)
        assert _refused(_next, w, stranger).status_code == 403
        assert _refused(_next, w, company_id=uuid.uuid4()).status_code == 404


class TestCreate:
    def test_without_a_code_the_shop_gets_the_next_one(self, w):
        _codes(w, "4")
        assert _create(w).branch_id == "5"
        assert _create(w, branchId=None).branch_id == "6"
        assert _create(w, branchId="  ").branch_id == "7"

    def test_the_suggestion_left_as_it_was_is_kept_while_free(self, w):
        _codes(w, "1", "2")
        suggestion = _next(w)
        made = _create(w, branchId=suggestion, branchIdAuto=True)
        assert made.branch_id == suggestion == "3"
        # Not "auto-assigned" in the migration's sense: the code is the one the form showed.
        assert ShopResponse.model_validate(made).model_dump(by_alias=True)["branchIdAutoAssigned"] is False

    def test_a_suggestion_taken_meanwhile_becomes_the_next_without_an_error(self, w):
        _codes(w, "1", "2")
        mine = _next(w)
        theirs = _next(w)
        assert mine == theirs == "3"
        # Two people opened the form at once; the first saves.
        assert _create(w, branchId=theirs, branchIdAuto=True).branch_id == "3"
        # The second's suggestion is taken: the next code, no 409.
        assert _create(w, branchId=mine, branchIdAuto=True).branch_id == "4"
        # And a third, typed by hand meanwhile, past the run: the next is above it.
        assert _create(w, branchId="20").branch_id == "20"
        assert _create(w, branchId="3", branchIdAuto=True).branch_id == "21"

    def test_a_code_typed_by_hand_that_is_taken_is_still_a_409(self, w):
        _codes(w, "1", "2")
        e = _refused(_create, w, branchId="2")
        assert e.status_code == 409 and w.other_shop.name in e.detail
        assert w.db.query(Shop).filter(Shop.company_id == w.company.id).count() == 2

    def test_a_code_typed_by_hand_keeps_todays_rules(self, w):
        assert _refused(_create, w, branchId="A1").status_code == 400
        assert _refused(_create, w, branchId="12345678").status_code == 400
        assert _create(w, branchId="0042").branch_id == "0042"

    def test_existing_shops_are_untouched(self, w):
        _codes(w, "7", None)
        _create(w)
        w.db.expire_all()
        assert (w.shop.branch_id, w.other_shop.branch_id) == ("7", None)

    def test_the_code_is_drawn_under_the_companys_row_lock(self, w, monkeypatch):
        calls = []
        real_lock, real_assign = branch_code.lock_company, branch_code.assign_on_create
        monkeypatch.setattr(branch_code, "lock_company", lambda db, cid: (calls.append(("lock", cid)), real_lock(db, cid)))
        monkeypatch.setattr(
            branch_code, "assign_on_create",
            lambda db, cid, suggested=None: (calls.append(("assign", cid)), real_assign(db, cid, suggested))[1],
        )
        _create(w)
        assert calls == [("lock", w.company.id), ("assign", w.company.id)]
        sql = str(branch_code.lock_statement(w.company.id).compile(dialect=postgresql.dialect()))
        assert "FROM companies" in sql and sql.rstrip().endswith("FOR NO KEY UPDATE")


# ── The switch: the super admin's, with a reason, logged ──────────────────────


class TestTheSwitch:
    def test_only_the_super_admin_turns_a_shop_off(self, w):
        for user in (_manager(w), _user(w, UserRole.DISTRIBUTOR)):
            e = _refused(_update, w, user=user, isActive=False, activeReason="סיבה")
            assert e.status_code == 403 and e.detail["code"] == shop_active.SUPER_ADMIN_ONLY
            assert "מנהל-על" in e.detail["message"]
        w.db.expire_all()
        assert w.shop.is_active is True
        assert w.db.query(ShopActiveLog).count() == 0 and w.signals == []

    def test_anyone_who_edits_the_shop_still_saves_it_with_the_value_unchanged(self, w):
        # The edit form sends the row back, `isActive` included.
        out = _update(w, user=_manager(w), name="מרכז חדש", isActive=True)
        assert out.name == "מרכז חדש" and out.is_active is True
        assert w.db.query(ShopActiveLog).count() == 0

    @pytest.mark.parametrize("reason", [None, "", "   "])
    def test_a_change_needs_a_reason(self, w, reason):
        body = {"isActive": False} if reason is None else {"isActive": False, "activeReason": reason}
        e = _refused(_update, w, **body)
        assert e.status_code == 422 and e.detail["code"] == shop_active.REASON_REQUIRED
        assert "סיבה" in e.detail["message"]
        w.db.expire_all()
        assert w.shop.is_active is True and w.db.query(ShopActiveLog).count() == 0

    def test_turned_off_logged_signalled_and_the_watermark_moved(self, w):
        kds = POSMachine(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id,
                         name="מטבח", machine_code="M-KDS", is_active=True, is_fiscal=False,
                         pairing_status=PairingStatus.ASSIGNED)
        retired = POSMachine(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id,
                             name="ישנה", machine_code="M-OLD", is_active=False, pairing_status=PairingStatus.ASSIGNED)
        w.db.add_all([kds, retired])
        w.db.commit()
        before = w.shop.settings_updated_at
        before = before if before.tzinfo else before.replace(tzinfo=timezone.utc)

        out = _off(w, reason="  החוזה הסתיים  ")

        assert out.is_active is False
        row = w.db.query(ShopActiveLog).one()
        assert (row.shop_id, row.tenant_id, row.active, row.reason, row.user_id) == (
            w.shop.id, w.tenant.id, False, "החוזה הסתיים", w.admin.id,
        )
        assert row.created_at is not None
        after = w.shop.settings_updated_at
        assert (after if after.tzinfo else after.replace(tzinfo=timezone.utc)) > before
        # Every active device of the shop — tills and the KDS — and no other shop's.
        assert sorted(w.signals) == sorted(
            (str(w.tenant.id), str(m.id), "shop_active") for m in (w.tills[0], w.tills[1], kds)
        )

    def test_the_same_value_again_changes_nothing(self, w):
        _off(w)
        w.signals.clear()
        out = _update(w, isActive=False)  # no reason needed: no change
        assert out.is_active is False
        assert w.db.query(ShopActiveLog).count() == 1 and w.signals == []

    def test_back_on_is_the_super_admins_too_logged_and_signalled(self, w):
        _off(w)
        w.signals.clear()
        e = _refused(_update, w, user=_manager(w), isActive=True, activeReason="חזרנו")
        assert e.status_code == 403
        out = _update(w, isActive=True, activeReason="חוזה חודש")
        assert out.is_active is True
        rows = w.db.query(ShopActiveLog).order_by(ShopActiveLog.created_at).all()
        assert [(r.active, r.reason) for r in rows] == [(False, "סגירת סניף"), (True, "חוזה חודש")]
        assert {s[2] for s in w.signals} == {"shop_active"} and len(w.signals) == 2

    def test_the_log_as_the_dashboard_reads_it(self, w):
        _off(w, reason="ראשון")
        _update(w, isActive=True, activeReason="שני")
        out = shops_router.get_shop_active_log(
            str(w.shop.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert out["isActive"] is True and out["canChange"] is True
        assert [(e["active"], e["reason"]) for e in out["log"]] == [(True, "שני"), (False, "ראשון")]
        assert all(e["userName"] == "admin" and e["at"] for e in out["log"])
        seen = shops_router.get_shop_active_log(
            str(w.shop.id), current_user=_manager(w), active_tenant_id=w.tenant.id, db=w.db,
        )
        assert seen["canChange"] is False and len(seen["log"]) == 2

    def test_a_shop_opened_inactive_is_the_super_admins_with_a_reason(self, w):
        e = _refused(_create, w, _manager(w), isActive=False, activeReason="אירוע עתידי")
        assert e.status_code == 403
        assert _refused(_create, w, isActive=False).status_code == 422
        made = _create(w, isActive=False, activeReason="אירוע עתידי")
        assert made.is_active is False
        row = w.db.query(ShopActiveLog).filter(ShopActiveLog.shop_id == made.id).one()
        assert (row.active, row.reason) == (False, "אירוע עתידי")
        assert _create(w, _manager(w)).is_active is True


# ── The contract: `shopActive` where the devices read `trainingMode` ──────────


class TestTheContract:
    def test_machines_me(self, w):
        till = w.tills[0]
        assert machines_router.get_my_machine(machine=till)["shopActive"] is True
        _off(w)
        assert machines_router.get_my_machine(machine=till)["shopActive"] is False
        assert machines_router.get_my_machine(machine=w.other_till)["shopActive"] is True

    def test_the_heartbeat(self, w):
        till = w.tills[0]
        assert machines_router.post_my_heartbeat(body=None, machine=till, db=w.db)["shopActive"] is True
        _off(w)
        beat = machines_router.post_my_heartbeat(body=None, machine=till, db=w.db)
        assert beat["shopActive"] is False and "trainingMode" in beat

    def test_the_settings_sync_full_delta_and_unchanged(self, w):
        till = w.tills[0]
        first = sync_router.get_settings_sync(str(till.id), since=None, machine=till, db=w.db)
        assert first.shop_active is True and first.settings["shopActive"] is True
        since = first.settings_updated_at.isoformat()
        assert sync_router.get_settings_sync(str(till.id), since=since, machine=till, db=w.db).sync_type == "unchanged"

        _off(w)

        # The watermark moved: the next delta pull carries the flag, not "unchanged".
        delta = sync_router.get_settings_sync(str(till.id), since=since, machine=till, db=w.db)
        assert delta.sync_type == "delta"
        assert delta.shop_active is False and delta.settings["shopActive"] is False
        dumped = delta.model_dump(by_alias=True)
        assert dumped["shopActive"] is False and dumped["settings"]["shopActive"] is False
        assert dumped["trainingMode"] is False  # beside it, as before
        # An "unchanged" answer carries it as well.
        unchanged = sync_router.get_settings_sync(
            str(till.id), since=(delta.settings_updated_at + timedelta(seconds=1)).isoformat(), machine=till, db=w.db,
        )
        assert unchanged.sync_type == "unchanged" and unchanged.settings == {}
        assert unchanged.model_dump(by_alias=True)["shopActive"] is False
        # Back on: released the same way.
        _update(w, isActive=True, activeReason="חזרה")
        again = sync_router.get_settings_sync(str(till.id), since=since, machine=till, db=w.db)
        assert again.shop_active is True and again.settings["shopActive"] is True

    def test_a_device_in_no_shop_is_not_locked(self, w):
        loose = POSMachine(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=None, distributor_id=w.admin.id,
                           name="חדשה", machine_code="M-NEW", is_active=True, pairing_status=PairingStatus.PAIRED)
        w.db.add(loose)
        w.db.flush()
        assert machines_router.get_my_machine(machine=loose)["shopActive"] is True
        out = sync_router.get_settings_sync(str(loose.id), since=None, machine=loose, db=w.db)
        assert out.model_dump(by_alias=True)["shopActive"] is True


# ── Pairing into an inactive shop is refused ──────────────────────────────────


def _inactive(w, shop=None):
    shop = shop or w.shop
    shop.is_active = False
    w.db.flush()
    return shop


def _is_shop_inactive(e: HTTPException) -> bool:
    return e.status_code == 409 and e.detail["code"] == shop_active.SHOP_INACTIVE and "אינו פעיל" in e.detail["message"]


def _code(w, *, shop_id=None, target=None) -> PairingCode:
    # Added rather than made by `create_pairing_code`, whose commit reloads `expires_at` naive
    # from SQLite (tests/test_device_model.py does the same).
    code = PairingCode(
        id=uuid.uuid4(), code=f"C{uuid.uuid4().hex[:7].upper()}", distributor_id=w.admin.id,
        tenant_id=w.tenant.id, shop_id=shop_id, target_machine_id=target,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5), is_used=False,
    )
    w.db.add(code)
    w.db.flush()
    return code


def _paired(w) -> POSMachine:
    m = POSMachine(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=None, distributor_id=w.admin.id,
                   name="חדשה", machine_code=f"M-{uuid.uuid4().hex[:6]}", is_active=True,
                   pairing_status=PairingStatus.PAIRED)
    w.db.add(m)
    w.db.flush()
    return m


class TestPairing:
    def test_no_code_is_made_for_an_inactive_shop(self, w):
        _inactive(w)
        e = _refused(
            pairing_router.generate_pairing_code,
            body=PairingCodeGenerateRequest(shopId=w.shop.id),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert _is_shop_inactive(e)
        assert w.db.query(PairingCode).count() == 0

    def test_a_code_made_before_is_refused_when_redeemed_and_stays_unused(self, w):
        code = _code(w, shop_id=w.shop.id)
        _inactive(w)
        machines_before = w.db.query(POSMachine).count()
        e = _refused(P.validate_pairing_code, w.db, code.code, {}, "קופה")
        assert _is_shop_inactive(e)
        assert code.is_used is False and w.db.query(POSMachine).count() == machines_before
        # Back on: the same code is good again (the pairing itself is tests/test_register_number.py's —
        # its register number is drawn with a Postgres regex).
        w.shop.is_active = True
        w.db.flush()
        P.refuse_inactive_target(w.db, code)

    def test_a_replacement_unit_is_refused_too(self, w):
        till = w.tills[0]
        _inactive(w)
        e = _refused(
            machines_router.create_replacement_pairing_code,
            machine_id=till.id, body=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert _is_shop_inactive(e)
        code = _code(w, target=till.id)  # made while the shop was on
        version = till.token_version
        assert _is_shop_inactive(_refused(P.validate_pairing_code, w.db, code.code, {}, None))
        assert code.is_used is False and till.token_version == version

    def test_a_qr_claim_is_refused_and_the_device_keeps_waiting(self, w):
        _inactive(w)
        row = DevicePairingRequest(
            device_nonce="nonce-1", status=DevicePairingStatus.WAITING,
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=5), device_info={}, machine_name=None,
        )
        w.db.add(row)
        w.db.flush()
        session = type("S", (), {"id": uuid.uuid4(), "tenant_id": w.tenant.id, "machines_paired_count": 0})()
        machines_before = w.db.query(POSMachine).count()
        e = _refused(PM.claim_device_pairing, w.db, session, w.admin, "nonce-1", w.company.id, w.shop.id)
        assert _is_shop_inactive(e)
        assert row.status == DevicePairingStatus.WAITING and w.db.query(POSMachine).count() == machines_before

    def test_assigning_a_paired_machine_is_refused(self, w):
        _inactive(w)
        machine = _paired(w)
        e = _refused(
            pairing_router.assign_machine,
            str(machine.id), MachineAssignRequest(shopId=w.shop.id),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert _is_shop_inactive(e)
        assert machine.shop_id is None and machine.pairing_status == PairingStatus.PAIRED
        assert _is_shop_inactive(_refused(P.assign_machine_to_shop, w.db, machine.id, w.shop.id))

    def test_moving_a_machine_into_it_is_refused(self, w, monkeypatch):
        monkeypatch.setattr(machines_router, "refuse_leaving_shop_with_shifts", lambda db, m: None)
        _inactive(w)
        e = _refused(
            machines_router.update_machine,
            str(w.other_till.id), POSMachineUpdate.model_validate({"shopId": str(w.shop.id)}),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert _is_shop_inactive(e)
        w.db.expire_all()
        assert w.db.get(POSMachine, w.other_till.id).shop_id == w.other_shop.id
        # A till already in it is edited as ever (its own shop sent back is no move).
        out = machines_router.update_machine(
            str(w.tills[0].id), POSMachineUpdate.model_validate({"shopId": str(w.shop.id), "name": "קופה ראשית"}),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert out.name == "קופה ראשית" and out.shop_id == w.shop.id


# ── Uploads from an inactive shop are accepted ────────────────────────────────


def test_an_inactive_shops_till_still_uploads_its_sales_shift_and_z(w):
    """"מסמך שנוצר בקופה לפני הנעילה חייב להתקבל. אחרת הוא ילך לאיבוד" — nothing is blocked."""
    till = w.tills[0]
    till.z_mode = "till"
    till.last_heartbeat_at = datetime.now(timezone.utc)
    w.db.commit()
    _off(w)
    till = w.db.get(POSMachine, till.id)

    shift_id = uuid.uuid4()
    opened = sync_router.post_shift_open(
        str(till.id),
        ShiftOpenIn.model_validate({"id": str(shift_id), "businessDate": str(TODAY), "openedAt": NOW.isoformat(),
                                    "openingCash": "100", "sequenceNumber": 1}),
        machine=till, db=w.db,
    )
    assert opened.status == "open"
    doc_id = str(uuid.uuid4())
    sale = {
        "id": doc_id, "transactionNumber": "5001", "status": "completed", "documentType": 320,
        "totalAmount": "18.00", "createdAt": NOW.isoformat(), "updatedAt": NOW.isoformat(),
        "businessDate": str(TODAY), "paymentMethod": "cash", "shiftId": str(shift_id),
        "items": [{"id": str(uuid.uuid4()), "productName": "קפה", "sku": "C-1", "quantity": "1",
                   "unitPrice": "18.00", "totalPrice": "18.00"}],
    }
    pushed = sync_router.post_transactions(
        machine_id=str(till.id), body=TransactionsBatchEnvelope(transactions=[sale]), machine=till, db=w.db,
    )
    assert [r.status for r in pushed.results] == ["accepted"]
    assert w.db.get(Transaction, uuid.UUID(doc_id)) is not None
    closed = sync_router.post_shift_close(
        str(till.id), shift_id,
        ShiftCloseIn.model_validate({"closedAt": (NOW + timedelta(hours=3)).isoformat(), "countedCash": "118",
                                     "transactionIds": [doc_id], "lastTransactionNumber": "5001"}),
        machine=till, approval=None, db=w.db,
    )
    assert closed.status == "accepted"
    assert w.db.get(Shift, shift_id).status == ShiftStatus.CLOSED
    z = sync_router.post_till_z(
        machine_id=str(till.id),
        body=TillZIn.model_validate({"clientRequestId": str(uuid.uuid4()), "throughShiftId": str(shift_id)}),
        machine=till, db=w.db,
    )
    assert z.status_code == 201 and json.loads(z.body)["status"] == "created"
    # And the till is still told it is locked.
    assert machines_router.post_my_heartbeat(body=None, machine=till, db=w.db)["shopActive"] is False


# ── The migration ─────────────────────────────────────────────────────────────


class TestMigration:
    REVISION = "e5a1c9d3b7f2"

    def _module(self):
        import importlib.util
        import pathlib

        path = pathlib.Path(__file__).absolute().parents[1] / "alembic" / "versions" / f"{self.REVISION}_shop_active_log.py"
        spec = importlib.util.spec_from_file_location(f"migration_{self.REVISION}", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_idempotent_and_offline(self):
        import io

        import sqlalchemy as sa
        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext

        module = self._module()
        assert (module.revision, module.down_revision) == (self.REVISION, "c7e4a2f9d1b6")
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            for t in ("tenants", "shops"):
                conn.execute(sa.text(f"CREATE TABLE {t} (id CHAR(32) PRIMARY KEY)"))
            with Operations.context(MigrationContext.configure(conn)):
                module.upgrade()
                module.upgrade()  # idempotent
            insp = sa.inspect(conn)
            assert {c["name"] for c in insp.get_columns("shop_active_log")} == {
                "id", "tenant_id", "shop_id", "active", "reason", "user_id", "created_at",
            }
            assert "ix_shop_active_log_shop_created" in {i["name"] for i in insp.get_indexes("shop_active_log")}
        # A table the API's create_all made first (from the model): only what is missing is added.
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            for t in ("tenants", "shops"):
                conn.execute(sa.text(f"CREATE TABLE {t} (id CHAR(32) PRIMARY KEY)"))
            ShopActiveLog.__table__.create(conn)
            with Operations.context(MigrationContext.configure(conn)):
                module.upgrade()
        buf = io.StringIO()
        offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
        with Operations.context(offline):
            module.upgrade()
        sql = buf.getvalue()
        assert "CREATE TABLE shop_active_log" in sql and "CREATE INDEX ix_shop_active_log_shop_created" in sql
        assert "ALTER TABLE shops" not in sql  # existing shops untouched

    def test_on_the_single_head(self):
        import pathlib

        from alembic.config import Config
        from alembic.script import ScriptDirectory

        root = pathlib.Path(__file__).absolute().parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "alembic"))
        heads = ScriptDirectory.from_config(config).get_heads()
        assert len(heads) == 1
        assert self.REVISION in {r.revision for r in ScriptDirectory.from_config(config).walk_revisions("base", heads[0])}
