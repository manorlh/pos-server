"""
"חסימות מהקופה" — which till may block what, and who releases (P:/specs/item-block-control.md;
app/services/item_block_control.py, app/routers/item_blocks.py).

Each test names a way the feature could look right and still let a cashier stop the kiosk, the
online orders or the menu by mistake — or lock a manager out of releasing:

* the role read from the wrong level, or the main till not managing by default;
* a regular till writing past its point of sale or its channels, or a managing one past its cap;
* a user without "חסימה מעבר לקופה" writing wide, or a manager's approval not counting;
* a release allowed where the till could not block (own_scope), or refused where the shop said
  "any block in the shop"; a company's or an automatic block released from a till;
* the till's list saying "שחרר" where the cloud would refuse it;
* the quick block on the phone blocking the wrong channels, or "זמין" leaving the item stopped.

Runs on the item-blocks world (tests/test_item_blocks.py), SQLite in memory.
"""
from __future__ import annotations

import json
import types
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError

from app.models.pos_user import PosUser, PosUserRole
from app.models.sold_out import SoldOutMark
from app.routers import item_blocks as R
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services import item_block_control as C
from app.services import sold_out as svc
from app.services import till_permissions as TPERM

from test_item_blocks import _block, _dev_block, _refusal, _sells, b, dev  # noqa: F401
from test_product_availability import world  # noqa: F401

ALL = ["pos", "kiosk", "online", "menu"]


def _home(area=True):
    return types.SimpleNamespace(id=uuid.uuid4(), area_id=uuid.uuid4() if area else None)


def _rules(**values):
    sources = {k: "machine" for k in values}
    return C.rules_of(values, sources, is_main_till=False)


# ── The setting ──────────────────────────────────────────────────────────────


class TestTheSetting:
    def test_a_layer_is_checked_key_by_key(self):
        assert C.clean({"role": "managing", "localChannels": ["kiosk", "pos"], "localRelease": False}) == {
            "role": "managing", "localChannels": ["pos", "kiosk"], "localRelease": False,
        }
        assert C.clean(None) is None and C.clean({}) is None
        assert C.clean({"role": None, "localMaxLevel": "shop"}) == {"localMaxLevel": "shop"}, "a null key inherits"
        for bad in (
            {"role": "boss"}, {"localChannels": []}, {"localChannels": ["tv"]}, {"managingMaxLevel": "machine"},
            {"releaseMode": "all"}, {"localRelease": "yes"}, {"somethingElse": 1},
            {"quickDefaults": {"level": "area"}}, {"quickDefaults": {"duration": {"mode": "minutes", "minutes": 0}}},
        ):
            with pytest.raises(C.ItemBlockSettingsError):
                C.clean(bad)

    def test_quick_defaults_fill_what_is_left_out(self):
        assert C.clean({"quickDefaults": {"channels": ["kiosk"]}})["quickDefaults"] == {
            "channels": ["kiosk"], "level": "shop", "duration": {"mode": "end_of_day"},
        }
        assert C.clean({"quickDefaults": {"duration": {"mode": "minutes", "minutes": 30}}})["quickDefaults"]["duration"] == {
            "mode": "minutes", "minutes": 30,
        }

    def test_the_settings_patch_refuses_a_bad_value_and_clears_with_null(self):
        with pytest.raises(ValidationError):
            PosSettingsV1Patch(itemBlocks={"role": "boss"})
        from app.routers.settings import _item_blocks_patch

        assert _item_blocks_patch(PosSettingsV1Patch(itemBlocks=None)) == {"itemBlocks": None}
        assert _item_blocks_patch(PosSettingsV1Patch()) == {}
        assert _item_blocks_patch(PosSettingsV1Patch(itemBlocks={"role": "local"})) == {"itemBlocks": {"role": "local"}}

    def test_levels_merge_key_by_key_the_most_specific_winning(self):
        values, sources = C.merged([
            ("tenant", {"itemBlocks": {"releaseMode": "any_in_shop"}}),
            ("company", {"itemBlocks": {"role": "none", "localMaxLevel": "shop"}}),
            ("shop", {"itemBlocks": {"role": "local"}}),
            ("area", None),
            ("machine", {"itemBlocks": {"role": "managing", "bogus": 1, "localChannels": ["moon"]}}),
        ])
        assert values == {"releaseMode": "any_in_shop", "role": "managing", "localMaxLevel": "shop"}
        assert sources == {"releaseMode": "tenant", "role": "machine", "localMaxLevel": "company"}

    def test_the_defaults_and_the_main_till(self):
        assert C.rules_of({}, {}, is_main_till=False).out() == {
            "role": "local", "localMaxLevel": "area", "localChannels": ["pos"], "managingMaxLevel": "shop",
            "releaseMode": "own_scope", "localRelease": True,
        }
        main = C.rules_of({}, {}, is_main_till=True)
        assert (main.role, main.sources["role"]) == ("managing", "main_till")
        assert C.rules_of({"role": "none"}, {"role": "shop"}, is_main_till=True).role == "none", "a level beats the main till"


# ── What a till may write ────────────────────────────────────────────────────


class TestWriteMatrix:
    @pytest.mark.parametrize(
        "role,level,channels,expected",
        [
            # A regular till: its point of sale, the tills' channel — nothing more.
            ("local", "machine", ["pos"], "ITEM_BLOCK"),
            ("local", "area", ["pos"], "ITEM_BLOCK"),
            ("local", "shop", ["pos"], None),
            ("local", "area", ["pos", "kiosk"], None),
            ("local", "machine", ["online"], None),
            # A managing till: anything up to the shop; past the local caps it needs the wide permission.
            ("managing", "area", ["pos"], "ITEM_BLOCK"),
            ("managing", "area", ALL, "ITEM_BLOCK_WIDE"),
            ("managing", "shop", ["pos"], "ITEM_BLOCK_WIDE"),
            ("managing", "shop", ALL, "ITEM_BLOCK_WIDE"),
            # None: nothing at all.
            ("none", "machine", ["pos"], None),
        ],
    )
    def test_role_level_and_channels(self, role, level, channels, expected):
        verdict = C.write_verdict(_rules(role=role), _home(), level, channels)
        assert (verdict.needs if verdict.ok else None) == expected
        if not verdict.ok:
            assert verdict.message, "a refusal always says why, in Hebrew"

    def test_the_caps_move_with_the_settings(self):
        wide_local = _rules(role="local", localMaxLevel="shop", localChannels=["pos", "kiosk"])
        assert C.write_verdict(wide_local, _home(), "shop", ["pos", "kiosk"]).needs == "ITEM_BLOCK"
        assert not C.write_verdict(wide_local, _home(), "shop", ["online"]).ok
        only_itself = _rules(role="local", localMaxLevel="machine")
        assert not C.write_verdict(only_itself, _home(), "area", ["pos"]).ok
        area_manager = _rules(role="managing", managingMaxLevel="area")
        assert C.write_verdict(area_manager, _home(), "area", ALL).needs == "ITEM_BLOCK_WIDE"
        assert not C.write_verdict(area_manager, _home(), "shop", ["pos"]).ok

    def test_a_till_with_no_point_of_sale_stops_at_itself(self):
        assert not C.write_verdict(_rules(role="local"), _home(area=False), "shop", ["pos"]).ok
        assert C.write_verdict(_rules(role="local"), _home(area=False), "machine", ["pos"]).ok

    def test_where_a_target_reaches_from_the_till(self):
        home = _home()
        assert C.target_level(home, "machine", home.id) == "machine"
        assert C.target_level(home, "machine", uuid.uuid4(), home.area_id) == "area", "another device of its point of sale"
        assert C.target_level(home, "machine", uuid.uuid4(), uuid.uuid4()) == "shop"
        assert C.target_level(home, "area", home.area_id) == "area"
        assert C.target_level(home, "area", uuid.uuid4()) == "shop"
        assert C.target_level(home, "event", uuid.uuid4()) == "shop"
        assert C.target_level(home, "company", uuid.uuid4()) is None

    def test_what_the_sheet_offers_and_its_narrowest_default(self):
        local = C.allowed_out(_rules(role="local"), _home())
        assert local == {
            "levels": ["machine", "area"], "channels": ["pos"], "localLevels": ["machine", "area"],
            "localChannels": ["pos"], "defaults": {"level": "area", "channels": ["pos"]},
        }
        managing = C.allowed_out(_rules(role="managing"), _home())
        assert managing["levels"] == ["machine", "area", "shop", "event"] and managing["channels"] == ALL
        assert managing["defaults"] == {"level": "area", "channels": ["pos"]}, "the narrowest, even when wide is allowed"
        assert C.allowed_out(_rules(role="none"), _home())["levels"] == []
        assert C.allowed_out(_rules(role="local"), _home(area=False))["defaults"]["level"] == "machine"


class TestReleaseRules:
    @pytest.mark.parametrize(
        "values,level,channels,expected",
        [
            ({"role": "local"}, "area", ["pos"], "ITEM_BLOCK"),
            ({"role": "local"}, "shop", ALL, None),  # own_scope: not what it could block
            ({"role": "local", "releaseMode": "any_in_shop"}, "shop", ALL, "ITEM_BLOCK_WIDE"),
            ({"role": "local", "releaseMode": "any_in_shop"}, "area", ["pos"], "ITEM_BLOCK"),
            ({"role": "none"}, "area", ["pos"], "ITEM_BLOCK"),  # localRelease on by default
            ({"role": "none", "localRelease": False}, "area", ["pos"], None),
            ({"role": "none", "localRelease": False, "releaseMode": "any_in_shop"}, "area", ["pos"], None),
            ({"role": "managing"}, "shop", ALL, "ITEM_BLOCK_WIDE"),
            ({"role": "managing", "managingMaxLevel": "area"}, "shop", ["pos"], None),
        ],
    )
    def test_by_role_and_mode(self, values, level, channels, expected):
        verdict = C.release_verdict(_rules(**values), _home(), level, channels)
        assert (verdict.needs if verdict.ok else None) == expected


# ── On the till's routes ─────────────────────────────────────────────────────


@pytest.fixture
def ctl(dev):
    """dev + till users by permission: a narrow one (ITEM_BLOCK alone), one asking for wide, one denied wide."""
    from app.services import till_parameters as TP

    def user(name, states):
        u = PosUser(id=uuid.uuid4(), tenant_id=dev.tid, shop_id=dev.h_shop.id, username=name, pin_hash="x",
                    role=PosUserRole.CASHIER, is_active=True, permission_overrides={"states": states})
        dev.db.add(u)
        return u

    dev.narrow = user("narrow", {"ITEM_BLOCK": "allow", "ITEM_BLOCK_WIDE": "deny"})
    dev.asks = user("asks", {"ITEM_BLOCK": "allow", "ITEM_BLOCK_WIDE": "approval"})
    dev.waiter = user("waiter", {"ITEM_BLOCK": "deny", "ITEM_BLOCK_WIDE": "deny"})
    TP.ensure_builtin_parameters(dev.db)
    dev.db.commit()
    return dev


def _role(w, entity, **values):
    settings = dict(entity.settings or {})
    settings["itemBlocks"] = values
    entity.settings = settings
    w.db.commit()


def _clear(w, machine, block_id, approver, kiosk_id=None):
    return R.device_clear(
        str(machine.id), uuid.UUID(str(block_id)), pos_user_id=str(approver.id) if approver else None,
        machine=machine, db=w.db, kiosk_id=kiosk_id,
    )


def _make_main(w, machine):
    from app.models.till_parameter import TillParameter, TillParameterValue

    parameter = w.db.query(TillParameter).filter(TillParameter.key == "mainTill").one()
    w.db.add(TillParameterValue(
        id=uuid.uuid4(), parameter_id=parameter.id, scope_type="machine", scope_id=machine.id, value=True,
    ))
    w.db.commit()


class TestTheTillsRole:
    def test_a_till_is_regular_by_default_and_the_main_till_manages(self, ctl):
        assert C.rules_for_machine(ctl.db, ctl.h1).role == "local"
        _make_main(ctl, ctl.h1)
        rules = C.rules_for_machine(ctl.db, ctl.h1)
        assert (rules.role, rules.sources["role"]) == ("managing", "main_till")
        assert C.rules_for_machine(ctl.db, ctl.h2).role == "local"

    def test_every_level_and_the_most_specific_wins(self, ctl):
        _role(ctl, ctl.H, role="none", localMaxLevel="shop")
        assert C.rules_for_machine(ctl.db, ctl.h1).role == "none"
        _role(ctl, ctl.h_shop, role="managing")
        assert C.rules_for_machine(ctl.db, ctl.h1).role == "managing"
        _role(ctl, ctl.bar, role="local", localChannels=["pos", "kiosk"])
        rules = C.rules_for_machine(ctl.db, ctl.h1)
        assert (rules.role, rules.local_max_level, rules.local_channels) == ("local", "shop", ("pos", "kiosk"))
        assert (rules.sources["role"], rules.sources["localMaxLevel"]) == ("area", "company")
        _role(ctl, ctl.h1, role="managing", managingMaxLevel="area")
        assert C.rules_for_machine(ctl.db, ctl.h1).out()["managingMaxLevel"] == "area"
        assert C.rules_for_machine(ctl.db, ctl.h2).role == "managing", "h2 is not in the bar: the shop's"

    def test_the_till_gets_the_six_in_its_parameters(self, ctl):
        from app.routers.sync import get_till_parameters_sync

        out = get_till_parameters_sync(str(ctl.h1.id), machine=ctl.h1, request=None, db=ctl.db)
        assert out.parameters["itemBlocks"] == {
            "role": "local", "localMaxLevel": "area", "localChannels": ["pos"], "managingMaxLevel": "shop",
            "releaseMode": "own_scope", "localRelease": True,
        }
        _make_main(ctl, ctl.h1)
        out = get_till_parameters_sync(str(ctl.h1.id), machine=ctl.h1, request=None, db=ctl.db)
        assert out.parameters["itemBlocks"]["role"] == "managing"
        assert out.parameters["mainTill"] is True, "the scalars stay as they were"


class TestTillWrites:
    def test_a_regular_till_blocks_its_point_of_sale_for_the_tills_by_default(self, ctl):
        out = _dev_block(ctl, ctl.h1, ctl.narrow)
        assert (out["block"]["level"], out["block"]["channels"]) == ("area", ["pos"])
        assert (_sells(ctl, ctl.h1), _sells(ctl, ctl.h2)) == (False, True), "the kiosk keeps selling"

    def test_a_regular_till_never_stops_the_kiosk_the_orders_or_the_menu(self, ctl):
        for body in (
            {"channels": ["pos", "kiosk"]}, {"channels": ["online"]}, {"channels": ALL, "level": "area"},
            {"target": "all"}, {"channels": ["pos"], "level": "shop"},
        ):
            status_code, code = _refusal(_dev_block(ctl, ctl.h1, ctl.mgr, **body))
            assert (status_code, code) == (403, "block_scope_not_allowed"), body
        assert ctl.db.query(SoldOutMark).count() == 0

    def test_a_till_set_none_blocks_nothing(self, ctl):
        _role(ctl, ctl.h1, role="none")
        assert _refusal(_dev_block(ctl, ctl.h1, ctl.mgr, channels=["pos"])) == (403, "block_scope_not_allowed")

    def test_a_managing_till_blocks_everywhere_with_the_wide_permission(self, ctl):
        _role(ctl, ctl.h1, role="managing")
        out = _dev_block(ctl, ctl.h1, ctl.mgr, level="shop", channels=ALL)
        assert (out["block"]["level"], out["block"]["channels"]) == ("shop", ALL)
        assert out["block"]["releasable"] is True and out["block"]["releaseNeeds"] == "ITEM_BLOCK_WIDE"

    def test_without_the_wide_permission_only_the_local_part(self, ctl):
        _role(ctl, ctl.h1, role="managing")
        assert _dev_block(ctl, ctl.h1, ctl.narrow, channels=["pos"])["block"]["level"] == "area"
        out = _dev_block(ctl, ctl.h1, ctl.narrow, level="shop", channels=ALL)
        assert out.status_code == 403
        detail = json.loads(out.body)["detail"]
        assert (detail["code"], detail["needs"]) == ("block_scope_not_allowed", "ITEM_BLOCK_WIDE")
        # A user asking for approval: the till asks a manager — and the manager's code (as the approver) passes.
        refused = _dev_block(ctl, ctl.h1, ctl.asks, channels=ALL)
        assert json.loads(refused.body)["detail"] == {
            "code": "block_scope_not_allowed", "message": R._WIDE_MESSAGE, "needs": "ITEM_BLOCK_WIDE",
        }
        assert _dev_block(ctl, ctl.h1, ctl.mgr, channels=ALL)["block"]["channels"] == ALL

    def test_a_cashier_role_asks_and_a_supervisor_role_does_not(self):
        assert TPERM.DEFAULTS[TPERM.CASHIER]["ITEM_BLOCK_WIDE"] == "approval"
        assert TPERM.DEFAULTS[TPERM.SUPERVISOR]["ITEM_BLOCK_WIDE"] == "allow"
        assert TPERM.DEFAULTS[TPERM.MANAGER]["ITEM_BLOCK_WIDE"] == "allow"
        assert TPERM.DEFAULTS[TPERM.WAITER]["ITEM_BLOCK_WIDE"] == "deny"
        assert TPERM.legacy_role_for(TPERM.DEFAULTS[TPERM.SUPERVISOR]) == "cashier"
        assert TPERM.legacy_role_for(TPERM.DEFAULTS[TPERM.MANAGER]) == "shop_manager"

    def test_a_managing_till_capped_at_its_point_of_sale(self, ctl):
        _role(ctl, ctl.h1, role="managing", managingMaxLevel="area")
        assert _dev_block(ctl, ctl.h1, ctl.mgr, channels=ALL)["block"]["level"] == "area"
        assert _refusal(_dev_block(ctl, ctl.h1, ctl.mgr, level="shop", channels=["pos"])) == (403, "block_scope_not_allowed")

    def test_the_kiosk_and_a_controlling_till_keep_todays_rules(self, ctl):
        from app.models.kiosk import KioskDevice

        out = _dev_block(ctl, ctl.h2, ctl.mgr, level="shop", target="all")
        assert out["block"]["channels"] == ["kiosk"], "a kiosk blocks for the kiosks, whatever the role"
        device = ctl.db.get(KioskDevice, ctl.h2.id)
        device.controller_machine_ids = [str(ctl.h1.id)]
        ctl.db.commit()
        panel = _dev_block(ctl, ctl.h1, ctl.mgr, level="machine", kioskId=ctl.h2.id)
        assert panel["block"]["origin"] == "controller"
        # Released from the kiosk panel — named or not — though h1 is a regular till with the tills' channel only.
        assert _clear(ctl, ctl.h1, panel["block"]["id"], ctl.mgr)["inForce"] is False


class TestTillReleases:
    def _shop_block(self, w):
        return _block(w, "shop", w.h_shop.id)

    def test_own_scope_releases_what_it_could_block_and_no_more(self, ctl):
        mine = _dev_block(ctl, ctl.h1, ctl.narrow)["block"]
        wide = self._shop_block(ctl)
        assert _refusal(_clear(ctl, ctl.h1, wide.id, ctl.mgr)) == (403, "block_scope_not_allowed")
        assert _clear(ctl, ctl.h1, mine["id"], ctl.narrow)["inForce"] is False

    def test_any_in_shop_releases_the_shops_blocks_with_the_wide_permission(self, ctl):
        _role(ctl, ctl.h_shop, releaseMode="any_in_shop")
        wide = self._shop_block(ctl)
        out = _clear(ctl, ctl.h1, wide.id, ctl.narrow)
        assert json.loads(out.body)["detail"]["needs"] == "ITEM_BLOCK_WIDE"
        assert _clear(ctl, ctl.h1, wide.id, ctl.mgr)["inForce"] is False

    def test_none_releases_only_with_local_release(self, ctl):
        mine = _dev_block(ctl, ctl.h1, ctl.narrow)["block"]
        _role(ctl, ctl.h1, role="none", localRelease=False)
        assert _refusal(_clear(ctl, ctl.h1, mine["id"], ctl.mgr)) == (403, "block_scope_not_allowed")
        _role(ctl, ctl.h1, role="none")
        assert _clear(ctl, ctl.h1, mine["id"], ctl.narrow)["inForce"] is False

    def test_a_managing_till_releases_anything_of_the_shop(self, ctl):
        _role(ctl, ctl.h1, role="managing")
        wide = self._shop_block(ctl)
        assert _clear(ctl, ctl.h1, wide.id, ctl.mgr)["inForce"] is False

    def test_the_companys_and_the_automatic_blocks_never(self, ctl):
        _role(ctl, ctl.h1, role="managing")
        company = _block(ctl, "company", ctl.H.id)
        assert _refusal(_clear(ctl, ctl.h1, company.id, ctl.mgr)) == (403, "not_from_here")
        auto = svc.block(
            ctl.db, tenant_id=ctl.tid, product=ctl.P, target=svc.resolve_target(ctl.db, "shop", ctl.h_shop.id, ctl.tid),
            source="auto", by_name=svc.AUTO_BY,
        )
        ctl.db.commit()
        assert _refusal(_clear(ctl, ctl.h1, auto.id, ctl.mgr)) == (403, "not_from_here")


class TestTheTillsList:
    def _list(self, w, machine, user=None, **kw):
        return R.device_blocks(
            str(machine.id), kiosk_id=None, machine=machine, db=w.db,
            pos_user_id=str(user.id) if user else None, **kw,
        )

    def test_releasable_is_what_the_cloud_would_accept(self, ctl):
        mine = _dev_block(ctl, ctl.h1, ctl.narrow)["block"]
        shop = _block(ctl, "shop", ctl.h_shop.id)
        company = _block(ctl, "company", ctl.H.id)
        listed = {r["id"]: r for r in self._list(ctl, ctl.h1)["blocks"]}
        assert (listed[mine["id"]]["releasable"], listed[mine["id"]]["releaseNeeds"]) == (True, "ITEM_BLOCK")
        assert listed[str(shop.id)]["releasable"] is False and listed[str(shop.id)]["releaseHint"] == C.HINT_MANAGING
        assert listed[str(company.id)]["releaseHint"] == C.HINT_CLOUD
        assert all(r["removable"] == r["releasable"] for r in listed.values())

    def test_for_the_signed_in_user(self, ctl):
        _role(ctl, ctl.h1, role="managing")
        shop = _block(ctl, "shop", ctl.h_shop.id)
        by = lambda u: {r["id"]: r for r in self._list(ctl, ctl.h1, u)["blocks"]}[str(shop.id)]  # noqa: E731
        assert (by(ctl.mgr)["releasable"], by(ctl.mgr)["releaseNeeds"]) == (True, "ITEM_BLOCK_WIDE")
        assert by(ctl.asks)["releasable"] is True, "approval: the till asks a manager"
        assert by(ctl.narrow)["releasable"] is False, "denied: not offered"
        assert by(ctl.waiter)["releasable"] is False

    def test_one_products_blocks_with_its_categorys(self, ctl):
        _dev_block(ctl, ctl.h1, ctl.narrow)
        _dev_block(ctl, ctl.h1, ctl.narrow, productId=ctl.Q.id)
        _dev_block(ctl, ctl.h1, ctl.narrow, productId=None, categoryId=ctl.P.category_id)
        rows = self._list(ctl, ctl.h1, product_id=ctl.P.id)["blocks"]
        assert sorted(r["itemType"] for r in rows) == ["category", "product"]
        assert all(r["productId"] in (str(ctl.P.id), None) for r in rows)

    def test_the_rules_ride_on_the_list(self, ctl):
        out = self._list(ctl, ctl.h1)
        assert out["itemBlocks"]["role"] == "local"
        assert out["allowed"]["defaults"] == {"level": "area", "channels": ["pos"]}
        kiosk = R.device_blocks(str(ctl.h2.id), kiosk_id=None, machine=ctl.h2, db=ctl.db)
        assert "itemBlocks" not in kiosk, "a kiosk keeps its own sheet"


# ── The dashboard ────────────────────────────────────────────────────────────


def _ctx(w, user=None):
    return {"current_user": user or w.users.admin, "active_tenant_id": w.tid, "db": w.db}


class TestControlFromTheDashboard:
    def test_a_level_shows_its_own_what_it_inherits_and_the_tills(self, ctl):
        _role(ctl, ctl.H, localMaxLevel="shop")
        _make_main(ctl, ctl.h1)
        view = R.get_control(level="shop", ident=ctl.h_shop.id, **_ctx(ctl))
        assert view["own"] == {} and view["inherited"] == {"localMaxLevel": "shop"}
        assert view["inheritedFrom"] == {"localMaxLevel": "company"} and view["canWrite"] is True
        tills = {t["id"]: t for t in view["tills"]}
        assert str(ctl.h2.id) not in tills, "a kiosk has no role"
        assert (tills[str(ctl.h1.id)]["role"], tills[str(ctl.h1.id)]["roleSource"], tills[str(ctl.h1.id)]["isMainTill"]) == (
            "managing", "main_till", True,
        )
        assert view["mainTill"]["id"] == str(ctl.h1.id)

    def test_save_a_level_and_refuse_a_bad_value(self, ctl):
        body = R.ControlIn(level="area", id=ctl.bar.id, values={"role": "managing", "localChannels": ["pos", "menu"]})
        view = R.put_control(body, BackgroundTasks(), **_ctx(ctl))
        assert view["own"] == {"role": "managing", "localChannels": ["pos", "menu"]}
        assert C.rules_for_machine(ctl.db, ctl.h1).role == "managing"
        with pytest.raises(HTTPException) as refused:
            R.put_control(R.ControlIn(level="area", id=ctl.bar.id, values={"role": "boss"}), BackgroundTasks(), **_ctx(ctl))
        assert refused.value.status_code == 422
        R.put_control(R.ControlIn(level="area", id=ctl.bar.id, values=None), BackgroundTasks(), **_ctx(ctl))
        assert "itemBlocks" not in (ctl.bar.settings or {})

    def test_who_may_change_which_level(self, ctl):
        with pytest.raises(HTTPException):
            R.put_control(R.ControlIn(level="company", id=ctl.H.id, values={"role": "none"}), BackgroundTasks(), **_ctx(ctl, ctl.users.h_shop_manager))
        with pytest.raises(HTTPException):
            R.put_control(R.ControlIn(level="shop", id=ctl.a_shop.id, values={"role": "none"}), BackgroundTasks(), **_ctx(ctl, ctl.users.h_shop_manager))
        view = R.put_control(R.ControlIn(level="shop", id=ctl.h_shop.id, values={"role": "none"}), BackgroundTasks(), **_ctx(ctl, ctl.users.h_shop_manager))
        assert view["own"] == {"role": "none"}

    def test_several_managing_tills_or_all_of_them(self, ctl):
        from app.models.pos_machine import POSMachine

        h3 = POSMachine(id=uuid.uuid4(), tenant_id=ctl.tid, shop_id=ctl.h_shop.id, distributor_id=uuid.uuid4(),
                        name="h3", machine_code="M-h3", pos_number="77", is_active=True)
        ctl.db.add(h3)
        ctl.db.commit()
        _make_main(ctl, ctl.h1)
        # Several: h3 joins the main till.
        view = R.put_managing_tills(
            R.ManagingIn(shopId=ctl.h_shop.id, machineIds=[ctl.h1.id, h3.id]), BackgroundTasks(), **_ctx(ctl),
        )
        roles = {t["id"]: (t["role"], t["ownRole"]) for t in view["tills"]}
        assert roles[str(ctl.h1.id)] == ("managing", None), "the main till inherits it: nothing written"
        assert roles[str(h3.id)] == ("managing", "managing")
        # All of them, h1 left out: the shop says managing, h1 is set back to regular.
        view = R.put_managing_tills(
            R.ManagingIn(shopId=ctl.h_shop.id, all=True, machineIds=[h3.id]), BackgroundTasks(), **_ctx(ctl),
        )
        assert view["own"] == {"role": "managing"}
        roles = {t["id"]: (t["role"], t["ownRole"]) for t in view["tills"]}
        assert roles == {str(ctl.h1.id): ("local", "local"), str(h3.id): ("managing", None)}
        # Back to the main till alone.
        view = R.put_managing_tills(R.ManagingIn(shopId=ctl.h_shop.id, machineIds=[ctl.h1.id]), BackgroundTasks(), **_ctx(ctl))
        roles = {t["id"]: (t["role"], t["ownRole"]) for t in view["tills"]}
        assert view["own"] == {} and roles == {str(ctl.h1.id): ("managing", None), str(h3.id): ("local", None)}
        with pytest.raises(HTTPException):
            R.put_managing_tills(R.ManagingIn(shopId=ctl.h_shop.id, machineIds=[ctl.a1.id]), BackgroundTasks(), **_ctx(ctl))

    def test_a_point_of_sale_of_its_own(self, ctl):
        view = R.put_managing_tills(
            R.ManagingIn(shopId=ctl.h_shop.id, areaId=ctl.bar.id, all=True, machineIds=[ctl.h1.id]), BackgroundTasks(), **_ctx(ctl),
        )
        assert view["level"] == "area" and view["own"] == {"role": "managing"}
        assert C.rules_for_machine(ctl.db, ctl.h1).sources["role"] == "area"

    def test_the_till_cards_switch(self, ctl):
        _make_main(ctl, ctl.h1)
        view = R.post_machine_managing(ctl.h1.id, R.MachineManagingIn(managing=False), BackgroundTasks(), **_ctx(ctl))
        assert (view["till"]["role"], view["till"]["ownRole"]) == ("local", "local")
        view = R.post_machine_managing(ctl.h1.id, R.MachineManagingIn(managing=True), BackgroundTasks(), **_ctx(ctl))
        assert (view["till"]["role"], view["till"]["ownRole"]) == ("managing", None)


class TestQuickBlock:
    def _quick(self, w, state, product=None):
        return R.post_quick(R.QuickIn(productId=(product or w.P).id, shopId=w.h_shop.id, state=state), **_ctx(w))

    def test_one_tap_sold_out_then_available(self, ctl):
        out = self._quick(ctl, "sold_out")["item"]
        assert out["state"] == "sold_out" and out["scopeLevel"] == "shop"
        mark = ctl.db.query(SoldOutMark).one()
        assert (mark.scope, list(svc.channels_of(mark)), mark.until_mode, mark.origin) == ("shop", ALL, "end_of_day", "dashboard")
        assert (_sells(ctl, ctl.h1), _sells(ctl, ctl.h2)) == (False, False)
        assert self._quick(ctl, "available")["item"]["state"] == "available"
        assert (_sells(ctl, ctl.h1), _sells(ctl, ctl.h2)) == (True, True)

    def test_blocked_replaces_sold_out(self, ctl):
        self._quick(ctl, "sold_out")
        assert self._quick(ctl, "blocked")["item"]["state"] == "blocked"
        live = ctl.db.query(SoldOutMark).filter(SoldOutMark.cleared_at.is_(None)).all()
        assert [m.kind for m in live] == ["blocked"]

    def test_available_lifts_the_shops_blocks_below_it_but_not_the_companys(self, ctl):
        _dev_block(ctl, ctl.h1, ctl.narrow)  # the bar, the tills
        _block(ctl, "company", ctl.H.id)
        out = self._quick(ctl, "available")["item"]
        assert out["state"] == "sold_out" and [b["level"] for b in out["blocks"]] == ["company"]

    def test_one_channel_in_the_quick_defaults(self, ctl):
        _role(ctl, ctl.h_shop, quickDefaults={"channels": ["kiosk"], "duration": {"mode": "none"}})
        out = self._quick(ctl, "blocked")
        assert out["quickDefaults"]["channels"] == ["kiosk"]
        mark = ctl.db.query(SoldOutMark).one()
        assert (list(svc.channels_of(mark)), mark.until) == (["kiosk"], None)
        assert (_sells(ctl, ctl.h1), _sells(ctl, ctl.h2)) == (True, False)
        # A tills-only block is outside the quick channel: "זמין" leaves it.
        _dev_block(ctl, ctl.h1, ctl.narrow)
        assert self._quick(ctl, "available")["item"]["state"] == "available"
        assert _sells(ctl, ctl.h1) is False

    def test_the_search_and_whats_blocked_first(self, ctl):
        self._quick(ctl, "sold_out", ctl.Q)
        listed = R.get_quick(shop_id=ctl.h_shop.id, q=None, **_ctx(ctl))
        assert [i["name"] for i in listed["items"]] == ["Soda", "Cola"], "blocked first with no search"
        assert listed["quickDefaults"] == C.QUICK_DEFAULTS
        found = R.get_quick(shop_id=ctl.h_shop.id, q="col", **_ctx(ctl))
        assert [(i["name"], i["state"]) for i in found["items"]] == [("Cola", "available")]
        with pytest.raises(HTTPException):
            R.get_quick(shop_id=ctl.a_shop.id, q=None, **_ctx(ctl, ctl.users.h_shop_manager))

    def test_the_full_forms_defaults_come_with_the_targets(self, ctl):
        _role(ctl, ctl.H, quickDefaults={"level": "company"})
        targets = R.list_targets(shop_id=ctl.h_shop.id, **_ctx(ctl))
        assert targets["quickDefaults"]["level"] == "company"
