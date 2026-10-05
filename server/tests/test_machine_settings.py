"""A till's own settings: the last layer under tenant → company → shop.

Covers the merge order, the sync to the till (values and watermark), the dashboard's
GET/PATCH on `/machines/{id}/settings`, and the tip keys that the tip screen reads
(`tipPresets` validated; `tipPresets`/`tipDistribution` resettable with `null`).
Style matches the rest of tests/: no database; handlers called with mocked sessions.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.models.user import User, UserRole
from app.routers.settings import _build_patch, get_machine_settings, patch_machine_settings
from app.routers.sync import get_settings_sync
from app.schemas.pos_settings import TIP_PRESETS_MAX, PosSettingsV1Patch
from app.services.settings_merge import effective_settings_updated_at, merge_all_settings_layers


def _ts(minutes: int = 0) -> datetime:
    return datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc) + timedelta(minutes=minutes)


def _user(role: UserRole) -> User:
    u = MagicMock(spec=User)
    u.role = role
    return u


def _world(tenant_settings, company_settings, shop_settings, machine_settings, machine_stamp=None):
    tenant = MagicMock()
    tenant.id = uuid.uuid4()
    tenant.settings = tenant_settings
    tenant.settings_updated_at = _ts()
    tenant.updated_at = _ts()

    company = MagicMock()
    company.id = uuid.uuid4()
    company.tenant_id = tenant.id
    company.settings = company_settings
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
    shop.settings = shop_settings
    shop.settings_updated_at = _ts()
    shop.updated_at = _ts()
    shop.branch_id = None
    shop.address = None
    shop.city = None

    machine = MagicMock()
    machine.id = uuid.uuid4()
    machine.shop_id = shop.id
    machine.tenant_id = tenant.id
    machine.is_active = True
    machine.settings = machine_settings
    machine.settings_updated_at = machine_stamp

    db = MagicMock()

    def query_side(model):
        q = MagicMock()
        q.filter.return_value.first.return_value = {
            "Shop": shop,
            "Company": company,
            "Tenant": tenant,
        }.get(model.__name__)
        return q

    db.query.side_effect = query_side
    return tenant, company, shop, machine, db


def _sync(machine, db, since=None):
    with patch("app.routers.sync.update_machine_sync_timestamp"), patch(
        "app.routers.sync.machine_area_for_sync", return_value=(None, [])
    ):
        return get_settings_sync(machine_id=str(machine.id), since=since, machine=machine, db=db)


# ── Merge order ──────────────────────────────────────────────────────────────


def test_the_till_is_the_last_layer_and_wins() -> None:
    tenant, company, shop, machine, _ = _world(
        {"tipPresets": [5]}, {"tipPresets": [10]}, {"tipPresets": [12]}, {"tipPresets": [15, 20]}
    )
    assert merge_all_settings_layers(company, shop, tenant, machine)["tipPresets"] == [15, 20]
    # Without the till's layer the shop's value is what shows.
    assert merge_all_settings_layers(company, shop, tenant)["tipPresets"] == [12]


def test_a_till_with_no_settings_inherits_everything() -> None:
    tenant, company, shop, machine, _ = _world({}, {"tipPresets": [10]}, {}, {})
    assert merge_all_settings_layers(company, shop, tenant, machine)["tipPresets"] == [10]


# ── Sync to the till ─────────────────────────────────────────────────────────


def test_sync_carries_the_tills_own_tip_settings() -> None:
    _, _, _, machine, db = _world({}, {"tipPresets": [10, 12, 15]}, {}, {"tipPresets": [8, 10], "payCardTips": True})
    resp = _sync(machine, db)
    assert resp.settings["tipPresets"] == [8, 10]
    assert resp.settings["payCardTips"] is True


def test_a_change_at_the_till_moves_the_watermark() -> None:
    _, company, shop, machine, db = _world({}, {}, {}, {}, machine_stamp=_ts(30))
    assert effective_settings_updated_at(company, shop, None, machine) == _ts(30)
    # A delta pull from before the till's change is not answered "unchanged".
    resp = _sync(machine, db, since=_ts(10).isoformat())
    assert resp.sync_type == "delta"


def test_a_till_never_written_does_not_move_the_watermark() -> None:
    _, company, shop, machine, db = _world({}, {}, {}, {}, machine_stamp=None)
    assert effective_settings_updated_at(company, shop, None, machine) == _ts()
    resp = _sync(machine, db, since=_ts(5).isoformat())
    assert resp.sync_type == "unchanged"


# ── Dashboard: GET/PATCH /machines/{id}/settings ─────────────────────────────


def test_get_returns_the_tills_own_settings_and_what_it_inherits() -> None:
    _, _, _, machine, db = _world({}, {"tipPresets": [10]}, {"payCardTips": True}, {"tipPresets": [15]})
    with patch("app.routers.settings._machine_for_read", return_value=machine):
        res = get_machine_settings(
            machine_id=str(machine.id),
            include_effective=True,
            current_user=_user(UserRole.SHOP_MANAGER),
            active_tenant_id=machine.tenant_id,
            db=db,
        )
    assert res.settings == {"tipPresets": [15]}
    # Inherited = tenant + company + shop, without the till's own value.
    assert res.effective["tipPresets"] == [10]
    assert res.effective["payCardTips"] is True


def _patch_machine(machine, db, body: dict, role=UserRole.SHOP_MANAGER):
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.notify_machine_settings"
    ) as notify:
        res = patch_machine_settings(
            machine_id=str(machine.id),
            data=PosSettingsV1Patch.model_validate(body),
            current_user=_user(role),
            active_tenant_id=machine.tenant_id,
            db=db,
        )
    return res, notify


def test_patch_writes_the_tills_layer_stamps_it_and_tells_the_till() -> None:
    _, _, _, machine, db = _world({}, {}, {}, {})
    res, notify = _patch_machine(machine, db, {"tipPresets": [10, 15, 20], "payCardTips": True})
    assert machine.settings == {"tipPresets": [10, 15, 20], "payCardTips": True}
    assert isinstance(machine.settings_updated_at, datetime)
    assert res.settings == machine.settings
    notify.assert_called_once()


def test_null_resets_the_tills_tip_percentages_to_inherit() -> None:
    _, _, _, machine, db = _world({}, {"tipPresets": [10]}, {}, {"tipPresets": [15], "tipDistribution": "equal_pool"})
    _patch_machine(machine, db, {"tipPresets": None, "tipDistribution": None})
    assert machine.settings == {}


def test_zscope_is_refused_at_the_till() -> None:
    _, _, _, machine, db = _world({}, {}, {}, {})
    with pytest.raises(Exception):
        _patch_machine(machine, db, {"zScope": "machine"})


def test_a_till_cannot_be_left_without_a_payment_option() -> None:
    _, _, _, machine, db = _world({}, {}, {}, {})
    off = {k: False for k in ("payFastCashEnabled", "payCashEnabled", "payFastCardEnabled", "payCardEnabled")}
    with pytest.raises(Exception):
        _patch_machine(machine, db, off)


# ── The expected card terminal number ────────────────────────────────────────


def test_one_terminal_number_for_the_shop_reaches_every_till() -> None:
    _, _, _, machine, db = _world({}, {}, {"expectedTerminalNumber": "1807770"}, {})
    assert _sync(machine, db).settings["expectedTerminalNumber"] == "1807770"


def test_a_till_of_its_own_overrides_the_shops_number() -> None:
    _, _, _, machine, db = _world({}, {}, {"expectedTerminalNumber": "1807770"}, {"expectedTerminalNumber": "1807771"})
    assert _sync(machine, db).settings["expectedTerminalNumber"] == "1807771"


def test_no_number_anywhere_sends_no_check() -> None:
    _, _, _, machine, db = _world({}, {}, {}, {})
    assert "expectedTerminalNumber" not in _sync(machine, db).settings


@pytest.mark.parametrize("bad", ["18077a0", "1807-770", "123456789012345678901", "  x "])
def test_terminal_number_is_digits_only(bad) -> None:
    with pytest.raises(Exception):
        PosSettingsV1Patch.model_validate({"expectedTerminalNumber": bad})


def test_terminal_number_accepts_digits_or_empty_and_null_resets_the_till() -> None:
    assert PosSettingsV1Patch.model_validate({"expectedTerminalNumber": " 1807770 "}).expected_terminal_number == "1807770"
    assert PosSettingsV1Patch.model_validate({"expectedTerminalNumber": ""}).expected_terminal_number == ""
    _, _, _, machine, db = _world({}, {}, {"expectedTerminalNumber": "1807770"}, {"expectedTerminalNumber": "1807771"})
    _patch_machine(machine, db, {"expectedTerminalNumber": None})
    assert machine.settings == {}
    assert _sync(machine, db).settings["expectedTerminalNumber"] == "1807770"


# ── The clearing server (Shva / Pelecard) ────────────────────────────────────


def test_shops_clearing_server_reaches_the_till_and_a_till_can_override_it() -> None:
    _, _, _, machine, db = _world({}, {}, {"clearingServer": "SHVA"}, {})
    assert _sync(machine, db).settings["clearingServer"] == "SHVA"
    _, _, _, machine, db = _world({}, {}, {"clearingServer": "SHVA"}, {"clearingServer": "PELECARD"})
    assert _sync(machine, db).settings["clearingServer"] == "PELECARD"


def test_clearing_server_is_normalised_and_checked() -> None:
    assert PosSettingsV1Patch.model_validate({"clearingServer": " pelecard "}).clearing_server == "PELECARD"
    assert PosSettingsV1Patch.model_validate({"clearingServer": ""}).clearing_server == ""
    with pytest.raises(Exception):
        PosSettingsV1Patch.model_validate({"clearingServer": "VISA"})


def test_null_clearing_server_rejoins_the_shop() -> None:
    _, _, _, machine, db = _world({}, {}, {"clearingServer": "SHVA"}, {"clearingServer": "PELECARD"})
    _patch_machine(machine, db, {"clearingServer": None})
    assert _sync(machine, db).settings["clearingServer"] == "SHVA"


# ── tipPresets validation ────────────────────────────────────────────────────


def test_tip_presets_accept_up_to_the_maximum() -> None:
    ok = list(range(5, 5 + TIP_PRESETS_MAX))
    assert PosSettingsV1Patch.model_validate({"tipPresets": ok}).tip_presets == ok
    assert PosSettingsV1Patch.model_validate({"tipPresets": []}).tip_presets == []


@pytest.mark.parametrize(
    "bad",
    [list(range(1, TIP_PRESETS_MAX + 2)), [0], [101], [10, 10], [-5]],
)
def test_tip_presets_refuse_bad_lists(bad) -> None:
    with pytest.raises(Exception):
        PosSettingsV1Patch.model_validate({"tipPresets": bad})


def test_build_patch_keeps_a_null_for_the_tip_keys() -> None:
    data = PosSettingsV1Patch.model_validate({"tipPresets": None, "tipDistribution": None})
    assert _build_patch(data, _user(UserRole.SHOP_MANAGER)) == {"tipPresets": None, "tipDistribution": None}
