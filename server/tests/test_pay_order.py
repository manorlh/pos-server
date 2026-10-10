""""סדר אמצעי התשלום": the `payOrder` setting — the order the till lists its payment buttons in.

Covers the schema (known ids only, no repeats), completing a stored list with the methods
it leaves out, the merge down tenant → company → shop → point of sale → till (the deepest
level that sets it wins whole), the dashboard's GET (inherited order and its source) and
PATCH (`null` resets), and what the till receives. The Android till carries the same
default order and completion rule (domain/PayOrder.kt, PayOrderTest).
Style matches tests/test_area_settings.py: no database; handlers on mocked sessions.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError

from app.models.user import User, UserRole
from app.routers.settings import (
    TIP_RESETTABLE_KEYS,
    get_area_settings,
    get_machine_settings,
    get_shop_settings,
    patch_area_settings,
    patch_machine_settings,
)
from app.routers.sync import get_settings_sync
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services.payment_options import (
    DEFAULT_PAY_ORDER,
    PAY_ORDER_BIG_BUTTONS,
    PAYMENT_OPTIONS,
    complete_pay_order,
    resolve_pay_order,
    validate_pay_order,
)
from app.services.settings_merge import MANAGED_SETTING_KEYS, merge_all_settings_layers

DEFAULT = list(DEFAULT_PAY_ORDER)


def _ts(minutes: int = 0) -> datetime:
    return datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc) + timedelta(minutes=minutes)


def _user(role: UserRole, shop_id=None) -> User:
    u = MagicMock(spec=User)
    u.role = role
    u.shop_id = shop_id
    return u


def _world(tenant_s, company_s, shop_s, area_s, machine_s):
    tenant = MagicMock()
    tenant.id = uuid.uuid4()
    tenant.settings = tenant_s
    tenant.settings_updated_at = _ts()
    tenant.updated_at = _ts()

    company = MagicMock()
    company.id = uuid.uuid4()
    company.tenant_id = tenant.id
    company.settings = company_s
    company.settings_updated_at = _ts()
    company.updated_at = _ts()
    company.name = "Co"
    company.vat_number = "1"
    company.address = "A"
    company.city = "C"

    shop = MagicMock()
    shop.id = uuid.uuid4()
    shop.company_id = company.id
    shop.tenant_id = tenant.id
    shop.settings = shop_s
    shop.settings_updated_at = _ts()
    shop.updated_at = _ts()
    shop.branch_id = None
    shop.address = None
    shop.city = None
    shop.training_mode = False

    area = MagicMock()
    area.id = uuid.uuid4()
    area.shop_id = shop.id
    area.tenant_id = tenant.id
    area.settings = area_s
    area.settings_updated_at = None

    machine = MagicMock()
    machine.id = uuid.uuid4()
    machine.shop_id = shop.id
    machine.area_id = area.id
    machine.tenant_id = tenant.id
    machine.is_active = True
    machine.settings = machine_s
    machine.settings_updated_at = None

    db = MagicMock()

    def query_side(model):
        q = MagicMock()
        q.filter.return_value.first.return_value = {
            "Shop": shop,
            "Company": company,
            "Tenant": tenant,
            "ShopArea": area,
        }.get(model.__name__)
        return q

    db.query.side_effect = query_side
    return tenant, company, shop, area, machine, db


# ── The ids ──────────────────────────────────────────────────────────────────


def test_the_default_order_is_the_payment_screen_as_drawn():
    # The big buttons ("אשראי מהיר", "מזומן עם עודף", "מזומן מהיר"), then the rows under them.
    assert DEFAULT == ["fastCard", "cash", "fastCash", "card", "manualCard", "voucher"]
    assert set(PAY_ORDER_BIG_BUTTONS) == {"fastCard", "cash", "fastCash"}
    # Every payment option has a place, and so does the voucher (no switch, but a row).
    assert {o.name for o in PAYMENT_OPTIONS} | {"voucher"} == set(DEFAULT)


# ── Schema validation ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "order",
    [
        DEFAULT,
        ["fastCash", "fastCard", "cash"],
        ["voucher"],
        list(reversed(DEFAULT)),
    ],
)
def test_known_ids_in_any_order_are_accepted(order):
    assert PosSettingsV1Patch.model_validate({"payOrder": order}).pay_order == order


@pytest.mark.parametrize(
    "order",
    [
        ["fastCash", "bitcoin"],  # unknown id
        ["cash", "cash"],  # repeat
        ["fastCard", "card", "fastCard"],  # repeat, not adjacent
        [],  # names nothing: `null` is how a layer resets
        ["FastCash"],  # ids are case-sensitive
        "fastCash,cash",  # not a list
        [1, 2],  # not ids
    ],
)
def test_anything_else_is_refused(order):
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({"payOrder": order})


def test_validate_names_the_unknown_id():
    with pytest.raises(ValueError, match="applePay"):
        validate_pay_order(["cash", "applePay"])


def test_null_is_a_reset_not_an_error():
    patch_model = PosSettingsV1Patch.model_validate({"payOrder": None})
    assert patch_model.pay_order is None
    assert "pay_order" in patch_model.model_fields_set


def test_pay_order_is_managed_and_resettable():
    assert "payOrder" in MANAGED_SETTING_KEYS
    assert "payOrder" in TIP_RESETTABLE_KEYS


# ── Completing a stored list ─────────────────────────────────────────────────


def test_missing_ids_follow_in_the_default_order():
    assert complete_pay_order(["fastCash", "card"]) == [
        "fastCash", "card", "fastCard", "cash", "manualCard", "voucher",
    ]


def test_a_full_list_is_kept_as_is():
    order = ["voucher", "manualCard", "card", "fastCash", "cash", "fastCard"]
    assert complete_pay_order(order) == order


def test_junk_in_the_stored_json_is_dropped_not_fatal():
    # A hand edit or a script: unknown ids and repeats go, the rest keep their places.
    assert complete_pay_order(["applePay", "cash", 7, None, "cash", "fastCard"]) == [
        "cash", "fastCard", "fastCash", "card", "manualCard", "voucher",
    ]


def test_absent_or_not_a_list_reads_as_unset():
    assert resolve_pay_order({}) is None
    assert resolve_pay_order({"payOrder": None}) is None
    assert resolve_pay_order({"payOrder": "cash,card"}) is None
    assert resolve_pay_order({"payOrder": ["card"]})[0] == "card"


# ── Merge per level: the deepest level that sets it wins, whole ──────────────


@pytest.mark.parametrize("level", ["tenant", "company", "shop", "area", "machine"])
def test_each_level_alone_decides(level):
    layers = {name: {} for name in ("tenant", "company", "shop", "area", "machine")}
    layers[level] = {"payOrder": ["fastCash", "fastCard"]}
    tenant, company, shop, area, machine, _ = _world(
        layers["tenant"], layers["company"], layers["shop"], layers["area"], layers["machine"]
    )
    merged = merge_all_settings_layers(company, shop, tenant, machine, area)
    assert resolve_pay_order(merged)[:2] == ["fastCash", "fastCard"]


def test_a_deeper_level_replaces_the_list_not_merges_it():
    tenant, company, shop, area, machine, _ = _world(
        {"payOrder": ["voucher"]},
        {"payOrder": ["manualCard", "card"]},
        {"payOrder": ["cash", "fastCash"]},
        {"payOrder": ["fastCash"]},
        {"payOrder": ["fastCard"]},
    )
    assert resolve_pay_order(merge_all_settings_layers(company, shop, tenant, machine, area)) == [
        "fastCard", "cash", "fastCash", "card", "manualCard", "voucher",
    ]
    # Without the till's own, its point of sale's; without that, the shop's.
    machine.settings = {}
    assert resolve_pay_order(merge_all_settings_layers(company, shop, tenant, machine, area))[0] == "fastCash"
    area.settings = {}
    assert resolve_pay_order(merge_all_settings_layers(company, shop, tenant, machine, area))[:2] == [
        "cash", "fastCash",
    ]


# ── Dashboard: the inherited order and where it comes from ───────────────────


def test_a_tills_view_shows_the_inherited_order_completed_and_its_source():
    _, _, _, area, machine, db = _world({}, {}, {"payOrder": ["card", "fastCash"]}, {}, {})
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ):
        res = get_machine_settings(
            machine_id=str(machine.id), include_effective=True,
            current_user=_user(UserRole.SUPER_ADMIN), active_tenant_id=machine.tenant_id, db=db,
        )
    assert res.settings == {}
    assert res.effective["payOrder"] == ["card", "fastCash", "fastCard", "cash", "manualCard", "voucher"]
    assert res.effective_sources["payOrder"] == "shop"


def test_nothing_set_above_means_no_inherited_order():
    _, _, shop, area, _, db = _world({}, {}, {}, {"payOrder": ["cash"]}, {})
    with patch("app.routers.settings.get_area", return_value=area):
        res = get_area_settings(
            area_id=str(area.id), include_effective=True,
            current_user=_user(UserRole.SHOP_MANAGER, shop.id), active_tenant_id=area.tenant_id, db=db,
        )
    # Its own list stays as stored (raw); the preview has none — the default order.
    assert res.settings == {"payOrder": ["cash"]}
    assert "payOrder" not in res.effective
    assert "payOrder" not in (res.effective_sources or {})


def test_a_shops_view_names_the_company():
    _, company, shop, _, _, db = _world({}, {"payOrder": ["voucher", "card"]}, {}, {}, {})
    with patch("app.routers.settings._check_shop_access"):
        res = get_shop_settings(
            shop_id=str(shop.id), include_effective=True,
            current_user=_user(UserRole.SUPER_ADMIN), active_tenant_id=shop.tenant_id, db=db,
        )
    assert res.effective["payOrder"][:2] == ["voucher", "card"]
    assert res.effective_sources["payOrder"] == "company"


# ── Dashboard: PATCH ─────────────────────────────────────────────────────────


def _patch_area(area, shop, db, body):
    with patch("app.routers.settings.get_area", return_value=area), patch(
        "app.routers.settings.notify_machines_for_area_settings"
    ) as notify:
        res = patch_area_settings(
            area_id=str(area.id),
            data=PosSettingsV1Patch.model_validate(body),
            current_user=_user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=area.tenant_id,
            db=db,
        )
    return res, notify


def _patch_machine(machine, area, db, body):
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ), patch("app.routers.settings.notify_machine_settings") as notify:
        res = patch_machine_settings(
            machine_id=str(machine.id),
            data=PosSettingsV1Patch.model_validate(body),
            current_user=_user(UserRole.SHOP_MANAGER),
            active_tenant_id=machine.tenant_id,
            db=db,
        )
    return res, notify


def test_patch_stores_the_list_as_sent_and_tells_the_tills():
    _, _, shop, area, _, db = _world({}, {}, {}, {}, {})
    _, notify = _patch_area(area, shop, db, {"payOrder": ["fastCash", "fastCard"]})
    assert area.settings == {"payOrder": ["fastCash", "fastCard"]}
    notify.assert_called_once()


def test_null_resets_the_layer_to_inherit():
    _, _, shop, area, _, db = _world({}, {}, {}, {"payOrder": ["cash"], "payCardEnabled": False}, {})
    _patch_area(area, shop, db, {"payOrder": None})
    assert area.settings == {"payCardEnabled": False}


def test_a_till_set_to_card_only_with_its_own_order():
    # "קופה 1 אשראי בלבד": the cash options blocked at that till, the card first.
    _, _, _, area, machine, db = _world({}, {}, {}, {}, {})
    _patch_machine(machine, area, db, {
        "payFastCashEnabled": False,
        "payCashEnabled": False,
        "payOrder": ["card", "fastCard"],
    })
    assert machine.settings == {
        "payFastCashEnabled": False,
        "payCashEnabled": False,
        "payOrder": ["card", "fastCard"],
    }


# ── What the till receives ───────────────────────────────────────────────────


def _sync(machine, db, area, since=None):
    with patch("app.routers.sync.update_machine_sync_timestamp"), patch(
        "app.routers.sync.machine_area_for_sync", return_value=(None, [])
    ), patch("app.routers.sync.get_area", return_value=area):
        return get_settings_sync(machine_id=str(machine.id), since=since, machine=machine, db=db)


def test_the_till_gets_the_deepest_order_completed():
    _, _, _, area, machine, db = _world(
        {}, {"payOrder": ["voucher"]}, {"payOrder": ["fastCash", "cash"]}, {}, {}
    )
    assert _sync(machine, db, area).settings["payOrder"] == [
        "fastCash", "cash", "fastCard", "card", "manualCard", "voucher",
    ]


def test_till_one_card_only_while_its_neighbour_keeps_the_shops_order():
    shop_order = {"payOrder": ["fastCash", "fastCard", "cash"]}
    till_one = {"payFastCashEnabled": False, "payCashEnabled": False, "payOrder": ["card", "fastCard"]}
    _, _, _, area, machine, db = _world({}, {}, shop_order, {}, till_one)
    one = _sync(machine, db, area).settings
    assert one["payOrder"][:2] == ["card", "fastCard"]
    assert one["payFastCashEnabled"] is False and one["payCashEnabled"] is False
    assert one["payFastCardEnabled"] is True and one["payCardEnabled"] is True

    machine.settings = {}
    two = _sync(machine, db, area).settings
    assert two["payOrder"][:3] == ["fastCash", "fastCard", "cash"]
    assert two["payFastCashEnabled"] is True


def test_with_no_order_set_the_till_gets_an_empty_list():
    # `[]` = keep each screen's own (today's) order. Sent rather than left out, so a reset
    # to inherit reaches a till on its next pull, a delta one included.
    _, _, _, area, machine, db = _world({}, {}, {}, {}, {})
    assert _sync(machine, db, area).settings["payOrder"] == []
    assert _sync(machine, db, area, since=_ts(-10).isoformat()).settings["payOrder"] == []


def test_the_order_never_turns_a_method_on():
    # The order names manual card; the settings still leave it off (it is opt-in).
    _, _, _, area, machine, db = _world({}, {}, {"payOrder": ["manualCard", "card"]}, {}, {})
    s = _sync(machine, db, area).settings
    assert s["payOrder"][0] == "manualCard"
    assert s["payManualCardEnabled"] is False
