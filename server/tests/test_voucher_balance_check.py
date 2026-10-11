""""בירור יתרת שובר" — the till's menu item that reads a production voucher's balance (the owner, 11.10.2026).

The setting `voucherBalanceCheck` ("auto" | "on" | "off", unset = "auto") is set and inherited like
`voucherRedeemFlow` (422 outside the enum, `null` resets, each change logged, the dashboard's preview
with its source) and reaches the till resolved with `voucherBalanceCheckEnabled`: "auto" = an active
batch (not cancelled, not expired) the till's shop can redeem, by the redemption's own scoping. A batch
made / cancelled / expiring moves the settings watermark, and a made / edited / cancelled one wakes
its tills.

The lookup the menu item calls is read only (nothing held or taken however often it runs) and carries
the voucher's redemptions, newest first, at most 20, with when / which till / which shop / what /
document number; another company's till sees no history, another tenant's code is a 404.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.company import Company
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherRedemption,
    PrepaidVoucherReservation,
)
from app.models.shop import Shop
from app.models.till_parameter import TillParameterChange
from app.models.transaction import Transaction, TransactionStatus
from app.models.user import UserRole
from app.routers import prepaid_vouchers as R
from app.routers.settings import get_shop_settings
from app.routers.sync import get_settings_sync
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services import voucher_balance_check as VBC
from app.services.prepaid_voucher_lookup_extras import TILL_HISTORY_LIMIT
from app.services.settings_merge import MANAGED_SETTING_KEYS, patch_to_camel_dict
from test_prepaid_voucher_kinds import (  # noqa: F401 — `w` is the fixture
    _ctx,
    basket,
    codes,
    confirm,
    lookup,
    make,
    redeem_goods,
    reserve,
    w,
)
from test_voucher_pay_options import _patch_machine, _patch_shop, _sync, _user, _world

KEY = "voucherBalanceCheck"
ENABLED = "voucherBalanceCheckEnabled"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── The setting (mock-based, like tests/test_voucher_redeem_flow_settings.py) ──


def test_the_key_values_and_default_are_the_contract_with_the_till() -> None:
    assert VBC.VOUCHER_BALANCE_SETTING_KEYS == (KEY,)
    assert VBC.VOUCHER_BALANCE_CHECK_ENABLED_KEY == ENABLED
    assert VBC.MODES == ("auto", "on", "off")
    assert VBC.DEFAULT_MODE == "auto"
    assert KEY in MANAGED_SETTING_KEYS
    assert ENABLED not in MANAGED_SETTING_KEYS  # decided per till, never stored


@pytest.mark.parametrize("junk", ["AUTO", "true", "", 1, True, None, [], {}])
def test_an_unknown_stored_value_counts_as_auto(junk) -> None:
    assert VBC.resolve_mode({KEY: junk}) == "auto"
    assert VBC.resolve_mode({}) == "auto"


@pytest.mark.parametrize("mode", ["auto", "on", "off"])
def test_the_patch_takes_each_mode_and_null(mode) -> None:
    assert patch_to_camel_dict(PosSettingsV1Patch.model_validate({KEY: mode})) == {KEY: mode}
    assert PosSettingsV1Patch.model_validate({KEY: None}).model_dump(exclude_unset=True, by_alias=True) == {KEY: None}


@pytest.mark.parametrize("bad", ["AUTO", "enabled", "", 1, True, ["on"]])
def test_a_value_outside_the_enum_is_a_422(bad) -> None:
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({KEY: bad})


def test_the_endpoint_answers_422_for_a_value_outside_the_enum() -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.database import get_db
    from app.middleware.auth import get_active_tenant_id, get_current_machine_admin
    from app.routers import settings as S

    app = FastAPI()
    app.include_router(S.router)
    app.dependency_overrides[get_db] = lambda: None
    app.dependency_overrides[get_current_machine_admin] = lambda: _user(UserRole.SUPER_ADMIN)
    app.dependency_overrides[get_active_tenant_id] = lambda: None
    assert TestClient(app).patch("/machines/m1/settings", json={KEY: "always"}).status_code == 422


def test_sync_sends_the_mode_and_enabled_for_each_mode() -> None:
    # The mocked world has no batches: "auto" resolves off, "on" / "off" are what they say.
    _, _, _, area, machine, db = _world()
    s = _sync(machine, db, area).settings
    assert (s[KEY], s[ENABLED]) == ("auto", False)
    _, _, _, area, machine, db = _world({}, {KEY: "on"})
    s = _sync(machine, db, area).settings
    assert (s[KEY], s[ENABLED]) == ("on", True)
    _, _, _, area, machine, db = _world({}, {KEY: "on"}, {}, {}, {KEY: "off"})
    s = _sync(machine, db, area).settings
    assert (s[KEY], s[ENABLED]) == ("off", False)


def test_inheritance_the_deepest_wins_and_a_reset_inherits_again() -> None:
    _, _, shop, area, machine, db = _world({KEY: "off"}, {}, {KEY: "on"})
    assert _sync(machine, db, area).settings[KEY] == "on"  # the shop beats the tenant
    _patch_machine(machine, area, db, {KEY: "off"})
    assert machine.settings == {KEY: "off"}
    assert _sync(machine, db, area).settings[KEY] == "off"
    _patch_machine(machine, area, db, {KEY: None})
    assert machine.settings == {}
    assert _sync(machine, db, area).settings[KEY] == "on"
    _patch_shop(shop, db, {KEY: None})
    assert _sync(machine, db, area).settings[KEY] == "off"


def test_the_dashboard_preview_has_the_value_its_source_and_what_auto_means_there() -> None:
    _, _, shop, _, _, db = _world({}, {KEY: "on"}, {})
    with patch("app.routers.settings._check_shop_access"), patch(
        "app.routers.settings.voucher_balance.has_active_for_shop", return_value=True
    ):
        res = get_shop_settings(
            shop_id=str(shop.id), include_effective=True, current_user=_user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=shop.tenant_id, db=db,
        )
    assert res.effective[KEY] == "on"
    assert res.effective_sources[KEY] == "company"
    assert res.effective[VBC.VOUCHER_BALANCE_CHECK_ACTIVE_KEY] is True
    assert res.settings == {}


def test_each_change_is_logged() -> None:
    _, _, _, area, machine, db = _world()
    _patch_machine(machine, area, db, {KEY: "off"})
    rows = [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], TillParameterChange)]
    assert [(r.parameter_key, r.scope_type, r.action, r.old_value, r.new_value) for r in rows] == [
        (KEY, "machine", "set", None, "off"),
    ]


# ── "auto" against real batches ──────────────────────────────────────────────


def _sync_real(w, till=None, since=None):
    till = till or w.tills[0]
    with patch("app.routers.sync.update_machine_sync_timestamp"), patch(
        "app.routers.sync.machine_area_for_sync", return_value=(None, [])
    ):
        return get_settings_sync(machine_id=str(till.id), since=since, machine=till, db=w.db)


def _enabled(w, till=None) -> bool:
    return _sync_real(w, till).settings[ENABLED]


def _batch_row(w, batch) -> PrepaidVoucherBatch:
    return w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(batch["id"])).one()


def _company_with_till(w, name="Other Co", parent=None):
    company = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name=name, vat_number="516161616",
                      parent_company_id=parent.id if parent is not None else None)
    w.db.add(company)
    w.db.flush()
    shop = Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=company.id, name=f"{name} shop", settings={})
    w.db.add(shop)
    w.db.flush()
    till = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=shop.id, distributor_id=w.admin.id, name=f"{name} till",
        machine_code=f"M-{uuid.uuid4().hex[:6]}", pos_number="91", is_active=True,
        pairing_status=PairingStatus.ASSIGNED,
    )
    w.db.add(till)
    w.db.commit()
    return company, shop, till


def test_auto_follows_the_batches_the_till_can_redeem(w):
    assert _enabled(w) is False  # no batch at all
    b = make(w, kind="items", count=1)
    assert _enabled(w) is True
    assert _enabled(w, w.other_till) is True  # a company-wide batch reaches every shop
    R.cancel_prepaid_voucher_batch(b["id"], None, **_ctx(w))
    assert _enabled(w) is False  # cancelled ones do not count


def test_an_expired_batch_does_not_count_and_a_not_yet_valid_one_does(w):
    b = make(w, kind="items", count=1)
    row = _batch_row(w, b)
    row.valid_until = _now() - timedelta(minutes=1)
    w.db.commit()
    assert _enabled(w) is False
    row.valid_from = _now() + timedelta(days=1)
    row.valid_until = _now() + timedelta(days=2)
    w.db.commit()
    assert _enabled(w) is True


def test_a_batch_for_named_shops_reaches_only_their_tills(w):
    make(w, kind="items", count=1, shopIds=[w.other_shop.id])
    assert _enabled(w) is False
    assert _enabled(w, w.other_till) is True


def test_another_companys_batches_do_not_count_and_a_parents_do(w):
    other_company, _, other_till = _company_with_till(w)
    row = _batch_row(w, make(w, kind="items", count=1))
    assert _enabled(w, other_till) is False  # a sibling company's batch: not redeemable there
    # The redemption's rule: a batch reaches its company's shops and those of the companies under it.
    w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == row.id).update({"company_id": other_company.id})
    w.company.parent_company_id = other_company.id
    w.db.commit()
    assert _enabled(w) is True
    assert _enabled(w, other_till) is True


def test_another_tenants_batches_do_not_count(w):
    from app.models.tenant import Tenant

    row = _batch_row(w, make(w, kind="items", count=1))
    t2 = Tenant(id=uuid.uuid4(), name="T2", slug="t2", timezone="Asia/Jerusalem")
    w.db.add(t2)
    w.db.flush()
    w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == row.id).update({"tenant_id": t2.id})
    w.db.commit()
    assert _enabled(w) is False


def test_on_and_off_ignore_the_batches(w):
    w.shop.settings = {KEY: "on"}
    w.db.commit()
    assert (_sync_real(w).settings[KEY], _enabled(w)) == ("on", True)
    make(w, kind="items", count=1)
    w.shop.settings = {KEY: "off"}
    w.db.commit()
    assert (_sync_real(w).settings[KEY], _enabled(w)) == ("off", False)


def _age_layers(w, at: datetime) -> None:
    for layer in (w.tenant, w.company, w.shop):
        layer.updated_at = at
        layer.settings_updated_at = at
    w.db.commit()


def test_a_batch_made_cancelled_or_expiring_moves_the_watermark(w):
    hour_ago = _now() - timedelta(hours=1)
    _age_layers(w, hour_ago)
    first = _sync_real(w)
    since = first.settings_updated_at.isoformat()
    assert _sync_real(w, since=since).sync_type == "unchanged"

    row = _batch_row(w, make(w, kind="items", count=1))
    row.updated_at = hour_ago + timedelta(minutes=10)
    w.db.commit()
    made = _sync_real(w, since=since)
    assert made.sync_type == "delta" and made.settings[ENABLED] is True
    since = made.settings_updated_at.isoformat()
    assert _sync_real(w, since=since).sync_type == "unchanged"

    row.valid_until = hour_ago + timedelta(minutes=20)  # ended since the last pull
    row.updated_at = hour_ago + timedelta(minutes=11)  # (a script's edit: its own stamp stays old)
    w.db.commit()
    ended = _sync_real(w, since=since)
    assert ended.sync_type == "delta" and ended.settings[ENABLED] is False
    assert ended.settings_updated_at == hour_ago + timedelta(minutes=20)  # the end of its validity
    since = ended.settings_updated_at.isoformat()

    row.valid_until = None
    row.status = "cancelled"
    row.updated_at = hour_ago + timedelta(minutes=30)
    w.db.commit()
    cancelled = _sync_real(w, since=since)
    assert cancelled.sync_type == "delta" and cancelled.settings[ENABLED] is False


def test_with_on_or_off_the_batches_do_not_move_the_watermark(w):
    hour_ago = _now() - timedelta(hours=1)
    w.shop.settings = {KEY: "on"}
    _age_layers(w, hour_ago)
    since = _sync_real(w).settings_updated_at.isoformat()
    row = _batch_row(w, make(w, kind="items", count=1))
    row.updated_at = hour_ago + timedelta(minutes=10)
    w.db.commit()
    assert _sync_real(w, since=since).sync_type == "unchanged"


def test_a_batch_made_or_cancelled_wakes_the_tills_it_reaches(w):
    with patch("app.services.ably_notify.publish_settings_notify") as pub:
        b = make(w, kind="items", count=1, shopIds=[w.other_shop.id])
    assert {c.args[1] for c in pub.call_args_list} == {str(w.other_till.id)}
    with patch("app.services.ably_notify.publish_settings_notify") as pub:
        R.cancel_prepaid_voucher_batch(b["id"], None, **_ctx(w))
    assert {c.args[1] for c in pub.call_args_list} == {str(w.other_till.id)}
    with patch("app.services.ably_notify.publish_settings_notify") as pub:
        make(w, kind="items", count=1)
    assert {c.args[1] for c in pub.call_args_list} == {str(t.id) for t in (*w.tills, w.other_till)}


def test_the_shop_preview_says_whether_auto_is_on_there(w):
    make(w, kind="items", count=1, shopIds=[w.other_shop.id])
    with patch("app.routers.settings._check_shop_access"):
        here = get_shop_settings(shop_id=str(w.shop.id), include_effective=True, current_user=w.admin,
                                 active_tenant_id=w.tenant.id, db=w.db)
        there = get_shop_settings(shop_id=str(w.other_shop.id), include_effective=True, current_user=w.admin,
                                  active_tenant_id=w.tenant.id, db=w.db)
    assert here.effective[KEY] == "auto" and here.effective[VBC.VOUCHER_BALANCE_CHECK_ACTIVE_KEY] is False
    assert there.effective[VBC.VOUCHER_BALANCE_CHECK_ACTIVE_KEY] is True
    assert VBC.has_active_for_company(w.db, w.company) is True


# ── The lookup: read only, with the redemptions ──────────────────────────────


def _counts(w, code):
    w.db.expire_all()
    v = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.code == code).one()
    return (
        v.status, dict(v.remaining or {}), v.uses_left, v.first_redeemed_at, v.last_redeemed_at,
        w.db.query(PrepaidVoucherReservation).count(), w.db.query(PrepaidVoucherRedemption).count(),
    )


def test_the_lookup_never_holds_or_takes_anything(w):
    goods = codes(w, make(w, kind="items", count=1, splitAllowed=True,
                          items=[{"productId": w.hotdog.id, "quantity": 3}]))[0]
    discount = codes(w, make(w, "order_discount", count=1, usesPerVoucher=2))[0]
    redeem_goods(w, goods, "r-1", "s-1")
    before = {c: _counts(w, c) for c in (goods, discount)}
    for _ in range(25):
        for c in (goods, discount):
            out = lookup(w, c)
            assert out["redeemable"] is True
    w.db.rollback()  # what the request's session does at its end: nothing was left to write
    assert {c: _counts(w, c) for c in (goods, discount)} == before
    out = lookup(w, discount)
    assert (out["quota"], out["used"], out["remaining"], out["usesAvailable"]) == (2, 0, 2, 2)


def test_the_redemptions_newest_first_at_most_20_with_when_where_and_what(w):
    code = codes(w, make(w, kind="items", count=1, splitAllowed=True,
                         items=[{"productId": w.hotdog.id, "quantity": 30}]))[0]
    for n in range(22):
        redeem_goods(w, code, f"r-{n}", f"s-{n}")
    rows = (
        w.db.query(PrepaidVoucherRedemption)
        .order_by(PrepaidVoucherRedemption.client_request_id)
        .all()
    )
    base = datetime(2026, 10, 1, 8, 0, tzinfo=timezone.utc)
    by_request = {r.client_request_id: r for r in rows}
    for n in range(22):  # one minute apart, r-21 the newest (the clock's resolution is no tie-breaker)
        by_request[f"r-{n}"].redeemed_at = base + timedelta(minutes=n)
    newest = by_request["r-21"]
    tx = Transaction(
        id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=w.tills[0].id, shop_id=w.shop.id,
        transaction_number="7001", status=TransactionStatus.COMPLETED, document_type=320,
        created_at=base, updated_at=base,
    )
    w.db.add(tx)
    newest.transaction_id = str(tx.id)
    w.db.commit()
    R.reverse_prepaid_redemption(str(w.tills[0].id), str(by_request["r-20"].id), machine=w.tills[0], db=w.db)

    out = lookup(w, code)
    history = out["redemptions"]
    assert len(history) == TILL_HISTORY_LIMIT == 20
    assert out["redemptionsTotal"] == 22
    assert [h["id"] for h in history] == [str(by_request[f"r-{n}"].id) for n in range(21, 1, -1)]
    first = dict(history[0])
    at = first.pop("at")
    assert datetime.fromisoformat(at.replace("Z", "+00:00")) == base + timedelta(minutes=21)
    assert first == {
        "id": str(newest.id),
        "machineName": "Till 1",
        "shopName": "Center",
        "posUserName": None,
        "quantity": 1,
        "items": [{"productId": str(w.hotdog.id), "name": "נקניקייה", "quantity": 1}],
        "uses": None,
        "amountAgorot": None,
        "status": "redeemed",
        "reversedAt": None,
        "documentNumber": "7001",
    }
    assert history[1]["status"] == "reversed" and history[1]["reversedAt"] is not None
    assert history[1]["documentNumber"] is None
    assert out["remaining"] == 30 - 22 + 1  # the reversed one gave its unit back
    assert out["firstRedeemedAt"] is not None and out["lastRedeemedAt"] is not None
    assert "validShops" not in out  # every shop of the company


def test_a_discount_voucher_lists_its_uses_and_amount(w):
    code = codes(w, make(w, "order_discount", count=1, usesPerVoucher=2))[0]
    held = reserve(w, code, basket(("l1", w.sandwich, 1, 40)))
    confirm(w, held["reservationId"], tx="tx-d", amount=3000)
    (row,) = lookup(w, code)["redemptions"]
    assert (row["quantity"], row["uses"], row["amountAgorot"], row["items"], row["status"]) == (1, 1, 3000, [], "redeemed")


def test_another_companys_till_sees_no_history_and_another_tenants_code_is_not_found(w):
    code = codes(w, make(w, kind="items", count=1, splitAllowed=True, shopIds=[w.shop.id],
                         items=[{"productId": w.hotdog.id, "quantity": 2}]))[0]
    redeem_goods(w, code, "r-1", "s-1")
    _, _, stranger = _company_with_till(w)
    out = lookup(w, code, till=stranger)
    assert (out["redeemable"], out["reason"]) == (False, "prepaid_voucher_wrong_shop")  # as before
    assert (out["redemptions"], out["redemptionsTotal"]) == ([], 0)
    assert (out["lastRedeemedAt"], out["firstRedeemedAt"]) == (None, None)
    assert "validShops" not in out  # not even the names of the shops
    # The same company's own till does see it, with the shops it is valid in.
    mine = lookup(w, code, till=w.other_till)
    assert mine["redemptionsTotal"] == 1 and mine["redemptions"][0]["shopName"] == "Center"
    assert mine["validShops"] == [{"id": str(w.shop.id), "name": "Center"}]

    from app.models.tenant import Tenant

    t2 = Tenant(id=uuid.uuid4(), name="T2", slug="t2b", timezone="Asia/Jerusalem")
    w.db.add(t2)
    w.db.flush()
    stranger.tenant_id = t2.id
    w.db.commit()
    with pytest.raises(HTTPException) as e:
        lookup(w, code, till=stranger)
    assert (e.value.status_code, e.value.detail) == (404, "prepaid_voucher_not_found")
