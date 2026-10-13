"""
"תצורת עבודה של הסניף" (app/services/work_profile.py, P:/specs/shop-work-config.md).

What each class pins — the spec's acceptance items (§7) first:

1. **Set up with "מסעדה עם שולחנות"** — the tables ("רשת מקומית") and the kitchen are set at once;
   the Z and the local server wait for the first till.
2. **The first till** — offered as the main till; paired with no plan of its own it becomes it,
   "רשת מקומית" on and the shop Z on the local server: everything applied.
3. **The second till** — offered as "קופה ברשת המקומית" (Windows: "קופה מרוחקת").
4. **"Z לכל קופה"** — every till (and kiosk) offered its own Z.
5. **"העתק מסניף קיים"** — every field the same, no device.
6. **A Z change with a till open** — refused with the reason, nothing changed.
7. **A distributor** — sets the profile at set-up, cannot change the Z once there are tills.
8. **The change log** — every change in `till_parameter_changes` (and the work-types card's too).

And: the templates (pinned for the dashboard), the strict check (Hebrew, with the value and what it
may be), the status read from the shop as it stands, who reads and who saves.

Runs on the owner's six-till shop of tests/test_independent_till.py ("רשת מקומית" on).
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.models.kiosk import KioskDevice
from app.models.pairing_code import PairingCode
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shift import ShiftStatus
from app.models.shop import Shop
from app.models.till_parameter import TillParameterChange
from app.models.user import User, UserRole
from app.routers import machines as machines_router
from app.routers import shops as shops_router
from app.routers import work_config as WR
from app.routers import work_profile as WPR
from app.schemas.shop import ShopCreate, ShopCreateResponse
from app.services import kiosk_control
from app.services import local_shop_z as LZ
from app.services import main_till as MT
from app.services import menu_broadcast as B
from app.services import pairing as P
from app.services import settings_notify
from app.services import till_parameters as TP
from app.services import work_config as WC
from app.services import work_profile as WP
from app.services import work_profile_templates as T
from test_independent_till import owner_setup, w  # noqa: F401

GOLDEN = Path(__file__).parent / "fixtures" / "shop_work_templates.json"
LAN = "רשת מקומית (קופה ראשית)"
SYNCED = "מסונכרן בין הקופות"
FIRST_TILL = "יופעל כשתצומד הקופה הראשונה"


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    sent = []
    monkeypatch.setattr(TP, "publish_parameters_notify", lambda targets: sent.append(list(targets)))
    monkeypatch.setattr(kiosk_control, "notify_device_lock", lambda machine: None)
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    monkeypatch.setattr(settings_notify, "notify_machines_for_shop_settings", lambda *a, **k: None)
    monkeypatch.setattr(shops_router, "ensure_default_pos_user", lambda *a, **k: None)
    monkeypatch.setattr(shops_router, "reconcile_shops", lambda *a, **k: set())
    return sent


@pytest.fixture
def seat(monkeypatch):
    """The register number's regex is Postgres-only: seat the machine in the shop directly."""

    def _assign(db, machine_id, shop_id):
        machine = db.get(POSMachine, machine_id)
        machine.shop_id = shop_id
        machine.pairing_status = PairingStatus.ASSIGNED
        db.flush()
        return machine

    monkeypatch.setattr(P, "assign_machine_to_shop", _assign)


# ── Helpers ──────────────────────────────────────────────────────────────────


def template(template_id, **changes):
    """A template's profile as the dashboard sends it: "חסימות פריטים" (never in a template) at its default."""
    profile = next(t["profile"] for t in T.templates() if t["id"] == template_id)
    profile[T.ITEM_BLOCKS] = dict(T.DEFAULT_ITEM_BLOCKS)
    profile.update(changes)
    return profile


def user_of(w, role, **extra):
    u = User(id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, email=f"{uuid.uuid4().hex[:6]}@x",
             username=uuid.uuid4().hex[:6], **extra)
    w.db.add(u)
    w.db.commit()
    return u


_branches = iter(range(900, 999))


def create(w, user=None, **body):
    shop = shops_router.create_shop(
        ShopCreate.model_validate({
            "name": "סניף חדש", "companyId": str(w.company.id), "branchId": str(next(_branches)), **body,
        }),
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    return shop


def refused(fn, *args, **kwargs):
    with pytest.raises(HTTPException) as err:
        fn(*args, **kwargs)
    return err.value.status_code, err.value.detail


def get(w, shop, user=None):
    return WPR.get_shop_work_profile(shop.id, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


class _Recorded:
    def add_task(self, fn, *args, **kwargs):
        fn(*args, **kwargs)


def put(w, shop, profile, user=None):
    return WPR.put_shop_work_profile(
        shop.id, WPR.WorkProfilePutIn(profile=profile), _Recorded(),
        current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def offer(w, shop, role="till", platform="android", user=None):
    return WR.get_shop_work_config(
        shop.id, role=role, platform=platform, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def pair(w, shop, *, plan=None, role=None, platform=None, by=None, name="קופה"):
    """A device redeems a pairing code of `shop` (flushed, not committed — as tests/test_work_config.py)."""
    code = PairingCode(
        id=uuid.uuid4(), code=f"C{uuid.uuid4().hex[:7].upper()}", distributor_id=(by or w.admin).id,
        tenant_id=w.tenant.id, shop_id=shop.id, device_role=role, work_config=plan, platform=platform,
        kiosk_options={"name": "קיוסק", "lockDevice": False} if role == "kiosk" else None,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5), is_used=False,
    )
    w.db.add(code)
    w.db.flush()
    info = {"platform": platform} if platform else {}
    machine = P.validate_pairing_code(w.db, code.code, info, name)
    assert machine is not None and machine.pairing_status == PairingStatus.ASSIGNED
    return machine, code.id


def states(view):
    return {name: entry["state"] for name, entry in view["status"].items()}


def changes(w, key=None):
    q = w.db.query(TillParameterChange)
    if key is not None:
        q = q.filter(TillParameterChange.parameter_key == key)
    return q.all()


# ── The templates ─────────────────────────────────────────────────────────────


class TestTemplates:
    def test_the_six_are_the_dashboards(self):
        assert T.templates() == json.loads(GOLDEN.read_text(encoding="utf-8"))
        assert [t["id"] for t in T.templates()] == [
            "restaurant_tables", "restaurant_kds", "quick_counter", "kiosks", "independent_till", "event",
        ]

    def test_each_is_a_valid_profile_with_its_own_id(self):
        for t in T.templates():
            assert t["name"] and t["description"]
            # "חסימות פריטים" is not in a template (the golden file is pinned): validated, it is the default.
            assert T.ITEM_BLOCKS not in t["profile"]
            assert T.validate(t["profile"]) == {**t["profile"], T.ITEM_BLOCKS: T.DEFAULT_ITEM_BLOCKS}
            assert t["profile"]["templateId"] == t["id"]

    def test_the_spec_table(self):
        rows = {t["id"]: t["profile"] for t in T.templates()}
        assert [(p["zType"], p["localServer"], p["tablesMode"], p["kitchen"]) for p in rows.values()] == [
            ("shop_local", True, "lan", "printer"),
            ("shop_local", True, "lan", "kds"),
            ("shop_cloud", False, "off", "printer"),
            ("shop_cloud", False, "off", "kds"),
            ("per_till", False, "single", "printer"),
            ("shop_cloud", False, "off", "printer"),
        ]
        assert rows["event"]["vouchers"]["station"] is True

    def test_the_endpoint(self, w):
        assert WPR.get_work_profile_templates(current_user=w.admin) == T.templates()


# ── The strict check ─────────────────────────────────────────────────────────


class TestValidation:
    @pytest.mark.parametrize("changes, field, words", [
        ({"zType": "shop"}, "zType", "per_till, shop_cloud, shop_local"),
        ({"tablesMode": "LAN"}, "tablesMode", "\"LAN\""),
        ({"customerDisplay": "yes"}, "customerDisplay", "true או false"),
        ({"tips": {"enabled": True}}, "tips.distribution", "חסר"),
        ({"vouchers": {"station": False, "balanceCheck": "maybe"}}, "vouchers.balanceCheck", "auto, on, off"),
        ({"zType": "shop_local", "localServer": False, "tablesMode": "off"}, "localServer", "מחייב שרת מקומי"),
        ({"localServer": True}, "localServer", "zType=shop_cloud"),
        ({"tablesMode": "lan"}, "tablesMode", "מחייב שרת מקומי"),
        ({"templateId": "bar"}, "templateId", "restaurant_tables"),
        ({"color": "red"}, "color", "לא מוכר"),
    ])
    def test_refused_in_hebrew_with_the_value_and_the_limit(self, w, changes, field, words):
        profile = template("quick_counter", **changes)
        with pytest.raises(T.ProfileInvalid) as err:
            T.validate(profile)
        assert err.value.field == field and words in err.value.message
        code, detail = refused(put, w, w.shop, profile)
        assert code == 422 and detail["code"] == "work_profile_invalid" and detail["field"] == field

    def test_a_missing_field(self):
        profile = template("quick_counter")
        del profile["kitchen"]
        with pytest.raises(T.ProfileInvalid) as err:
            T.validate(profile)
        assert err.value.field == "kitchen" and "\"מטבח\"" in err.value.message

    def test_a_profile_of_ones_own(self):
        profile = template("quick_counter", templateId=None)
        del profile["templateId"]
        assert T.validate(profile)["templateId"] is None


# ── 1. Set up with "מסעדה עם שולחנות" ────────────────────────────────────────


class TestSetUp:
    def test_the_tables_and_the_kitchen_now_the_z_waits(self, w):
        shop = create(w, workProfile=template("restaurant_tables"))
        out = ShopCreateResponse.model_validate(shop).model_dump(by_alias=True)["workProfileStatus"]
        assert out["applied"] is True and out["stored"] is True and out["hasTills"] is False
        assert out["profile"] == template("restaurant_tables")
        assert out["status"]["tablesMode"] == {"state": "applied"}
        assert out["status"]["kitchen"] == {"state": "applied"}
        assert out["status"]["zType"] == {"state": "pending", "reason": FIRST_TILL}
        assert out["status"]["localServer"] == {"state": "pending", "reason": FIRST_TILL}
        assert TP.resolve_for_shop(w.db, shop)["tablesMode"] == LAN
        assert T.stored(shop.settings) == template("restaurant_tables")
        # The creator chooses everything while there is no till.
        assert all(out["canEdit"].values())

    def test_the_kds_template_turns_the_kitchen_screen_on(self, w):
        shop = create(w, workProfile=template("restaurant_kds", attendance=True, customerDisplay=True,
                                              tips={"enabled": True, "distribution": "equal_pool"}))
        view = get(w, shop)
        assert set(states(view).values()) == {"applied", "pending"}
        params = TP.resolve_for_shop(w.db, shop)
        assert params["kdsEnabled"] is True and params["workflowTargets"] == "kds"
        assert params["attendanceEnabled"] is True
        assert shop.settings["customerDisplay"]["enabled"] is True
        assert shop.settings["tipsEnabled"] is True and shop.settings["tipDistribution"] == "equal_pool"

    def test_no_profile_no_status(self, w):
        shop = create(w)
        assert ShopCreateResponse.model_validate(shop).model_dump(by_alias=True)["workProfileStatus"] is None
        view = get(w, shop)
        assert view["stored"] is False and view["profile"]["zType"] == "shop_cloud"

    def test_an_invalid_profile_creates_nothing(self, w):
        before = w.db.query(Shop).count()
        code, detail = refused(create, w, workProfile=template("quick_counter", zType="cloud"))
        assert code == 422 and detail["field"] == "zType"
        assert w.db.query(Shop).count() == before

    def test_a_refusal_never_fails_the_creation(self, w):
        # The company's kitchen works in "תהליך הזמנה": a KDS needs a station screen the new shop lacks.
        from app.services import kds_workflow as WF

        WF.save_values(w.db, "company", w.company.id, {
            "enabled": True, "defaultMode": "ORDER_PROCESS", "allowedModes": ["ORDER_PROCESS"], "targets": ["printer"],
        })
        w.db.commit()
        shop = create(w, workProfile=template("kiosks"))
        out = shop.work_profile_status
        assert shop.id is not None and out["applied"] is False
        assert out["refused"]["code"] == "work_profile_kitchen_invalid" and out["refused"]["field"] == "kitchen"
        assert "מסך מטבח" in out["refused"]["message"]
        assert T.stored(w.db.get(Shop, shop.id).settings) is None  # all or nothing


# ── 2–3. Pairing follows the profile ──────────────────────────────────────────


class TestPairing:
    def test_the_first_till_is_the_main_till_and_everything_applies(self, w, seat, _quiet):
        shop = create(w, workProfile=template("restaurant_tables"))
        view = offer(w, shop)
        assert view["suggestedPreset"] == "main_till"
        assert view["suggestedPlan"] == {"preset": "main_till", "enableLocalNetwork": True}
        assert "הקופה הראשית" in view["suggestedReason"]
        machine, code_id = pair(w, shop)
        assert MT.main_till_of_shop(w.db, shop.id).id == machine.id
        assert w.db.get(Shop, shop.id).local_network is True and LZ.local_mode_of_shop(w.db, shop)
        assert set(states(get(w, shop)).values()) == {"applied"}
        result = w.db.get(PairingCode, code_id).work_config_result
        assert result["applied"] is True and result["source"] == "workProfile"
        assert WC.pairing_outcome(w.db, machine)["preset"] == "main_till"
        assert _quiet  # the shop's tills told

    def test_the_second_till_joins_the_local_network(self, w, seat):
        shop = create(w, workProfile=template("restaurant_tables"))
        main, _ = pair(w, shop)
        assert offer(w, shop)["suggestedPreset"] == "lan_member"
        second, _ = pair(w, shop, name="קופה 2")
        assert MT.main_till_of_shop(w.db, shop.id).id == main.id
        ctx = WC.context_for_machine(w.db, second)
        assert WC.current_preset(ctx) == "lan_member" and second.z_mode == "cloud"
        # A Windows device never joins the LAN: closed through the cloud.
        assert offer(w, shop, platform="windows")["suggestedPreset"] == "remote_shop_z"
        assert set(states(get(w, shop)).values()) == {"applied"}

    def test_a_windows_first_till_waits_for_an_android_main_till(self, w, seat):
        shop = create(w, workProfile=template("restaurant_tables"))
        assert offer(w, shop, platform="windows")["suggestedPreset"] == "shop_z_cloud"
        pair(w, shop, platform="windows")
        view = get(w, shop)
        assert view["status"]["localServer"] == {"state": "pending", "reason": "ממתין לקופה ראשית"}
        assert MT.main_till_of_shop(w.db, shop.id) is None

    def test_a_non_super_admins_pairing_does_not_apply_the_z(self, w, seat, _quiet):
        dist = user_of(w, UserRole.DISTRIBUTOR)
        shop = create(w, user=dist, workProfile=template("restaurant_tables"))
        # The dialog: the suggestion's fiscal plan is the super admin's, as before.
        with pytest.raises(WC.WorkConfigRefused) as err:
            WC.check_pairing_request(
                w.db, dist, shop_id=shop.id, role="till", platform="android",
                plan={"preset": "main_till", "enableLocalNetwork": True},
            )
        assert err.value.status_code == 403 and err.value.body["detail"] == "super_admin_only"
        # Paired with no plan by a distributor: "לפי הסניף", exactly as before.
        sent = len(_quiet)
        machine, code_id = pair(w, shop, by=dist)
        assert MT.main_till_of_shop(w.db, shop.id) is None
        assert w.db.get(Shop, shop.id).local_network is False and machine.z_mode == "cloud"
        assert w.db.get(PairingCode, code_id).work_config_result is None
        assert len(_quiet) == sent
        view = get(w, shop, dist)
        assert view["status"]["zType"] == {"state": "pending", "reason": WP.WAIT_SUPER_ADMIN}
        assert view["status"]["localServer"] == {"state": "pending", "reason": WP.WAIT_SUPER_ADMIN}
        assert WP.WAIT_SUPER_ADMIN == "ממתין למנהל-על — יש להחיל את תצורת העבודה מדף הסניף"
        assert view["canEdit"]["zType"] is False
        # The distributor's re-save changes nothing on the tills (and is not refused: no Z change).
        out = put(w, shop, template("restaurant_tables", attendance=True), dist)
        assert out["status"]["zType"]["state"] == "pending" and MT.main_till_of_shop(w.db, shop.id) is None
        # The super admin's re-save on the shop page applies it.
        out = put(w, shop, template("restaurant_tables", attendance=True))
        assert MT.main_till_of_shop(w.db, shop.id).id == machine.id
        assert LZ.local_mode_of_shop(w.db, shop)
        assert set(states(out).values()) == {"applied"}

    def test_the_qr_and_assign_paths_follow_the_same_rule(self, w):
        dist = user_of(w, UserRole.DISTRIBUTOR)
        shop = create(w, workProfile=template("independent_till"))
        till = w.six[1]
        till.shop_id = shop.id
        w.db.commit()
        # A distributor's: nothing applied.
        assert WP.apply_on_pairing(w.db, till, user_id=dist.id) is None
        assert till.z_mode == "cloud"
        assert get(w, shop)["status"]["zType"] == {"state": "pending", "reason": WP.WAIT_SUPER_ADMIN}
        # A super admin's: the profile's own Z.
        assert WP.apply_on_pairing(w.db, till, user_id=w.admin.id) is True
        assert till.z_mode == "till"
        assert get(w, shop)["status"]["zType"] == {"state": "applied"}

    def test_a_code_with_a_plan_of_its_own_wins(self, w, seat):
        shop = create(w, workProfile=template("quick_counter"))
        machine, _ = pair(w, shop, plan={"preset": "own_z"})
        assert machine.z_mode == "till"

    def test_a_shop_without_a_profile_is_as_before(self, w, seat):
        shop = create(w)
        assert offer(w, shop)["suggestedPreset"] is None
        machine, code_id = pair(w, shop)
        assert w.db.get(PairingCode, code_id).work_config_result is None
        assert MT.main_till_of_shop(w.db, shop.id) is None


# ── 4. "Z לכל קופה" ─────────────────────────────────────────────────────────


class TestPerTill:
    def test_every_till_and_kiosk_gets_its_own_z(self, w, seat):
        shop = create(w, workProfile=template("independent_till"))
        assert offer(w, shop)["suggestedPreset"] == "own_z"
        first, _ = pair(w, shop)
        assert first.z_mode == "till" and not first.independent_till
        assert offer(w, shop)["suggestedPreset"] == "own_z"
        second, _ = pair(w, shop, name="קופה 2")
        assert second.z_mode == "till"
        assert offer(w, shop, role="kiosk")["suggestedPreset"] == "kiosk_own_z"
        kiosk, _ = pair(w, shop, role="kiosk", name="קיוסק")
        assert w.db.get(KioskDevice, kiosk.id) is not None and kiosk.independent_till and kiosk.z_mode == "till"
        assert set(states(get(w, shop)).values()) == {"applied"}

    def test_a_shop_z_profile_gives_a_kiosk_the_shop_z(self, w):
        shop = create(w, workProfile=template("kiosks"))
        assert offer(w, shop, role="kiosk")["suggestedPreset"] == "kiosk_shop_z"
        assert offer(w, shop, role="kds")["suggestedPreset"] is None


# ── 5. "העתק מסניף קיים" ─────────────────────────────────────────────────────


class TestCopy:
    def test_every_field_the_same_no_device(self, w, seat):
        profile = template("restaurant_kds", attendance=True, tips={"enabled": True, "distribution": "by_sales"},
                           vouchers={"station": True, "balanceCheck": "on"})
        source = create(w, workProfile=profile)
        pair(w, source)
        copied = create(w, copyWorkProfileFromShopId=str(source.id))
        assert copied.work_profile_status["applied"] is True
        assert get(w, copied)["profile"] == profile
        assert w.db.query(POSMachine).filter(POSMachine.shop_id == copied.id).count() == 0
        assert get(w, copied)["status"]["zType"] == {"state": "pending", "reason": FIRST_TILL}

    def test_a_shop_with_no_profile_is_copied_as_it_stands(self, w):
        owner_setup(w)
        copied = create(w, copyWorkProfileFromShopId=str(w.shop.id))
        profile = get(w, copied)["profile"]
        assert profile["zType"] == "shop_local" and profile["localServer"] is True

    def test_only_a_shop_one_sees(self, w):
        from app.models.company import Company

        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other", vat_number="514141414")
        w.db.add(other)
        w.db.commit()
        boss = user_of(w, UserRole.COMPANY_MANAGER, company_id=other.id)
        before = w.db.query(Shop).count()
        code, _ = refused(create, w, user=boss, companyId=str(other.id), copyWorkProfileFromShopId=str(w.shop.id))
        assert code == 403 and w.db.query(Shop).count() == before

    def test_not_both(self, w):
        code, detail = refused(
            create, w, workProfile=template("event"), copyWorkProfileFromShopId=str(w.shop.id),
        )
        assert code == 422 and detail["field"] == "copyWorkProfileFromShopId"


# ── 6. The Z of a shop with tills ─────────────────────────────────────────────


class TestTillsExist:
    def test_an_open_till_refuses_the_change_and_nothing_changes(self, w):
        owner_setup(w)
        w.shift(w.six[2], 1, status=ShiftStatus.OPEN)
        w.db.commit()
        profile = template("independent_till", attendance=True)
        code, detail = refused(put, w, w.shop, profile)
        assert code == 409 and detail["code"] == "till_open" and detail["field"] == "zType"
        assert "קופה 3" in detail["message"] and "משמרת פתוחה" in detail["message"]
        w.db.expire_all()
        assert [m.z_mode for m in w.six[:5]] == ["cloud"] * 5
        assert w.db.get(Shop, w.shop.id).local_network is True
        assert TP.resolve_for_shop(w.db, w.shop).get("attendanceEnabled") is not True
        assert T.stored(w.db.get(Shop, w.shop.id).settings) is None and not changes(w)
        # The status says so, from the shop as it stands.
        view = get(w, w.shop)
        assert view["profile"]["zType"] == "shop_local" and view["status"]["zType"] == {"state": "applied"}

    def test_switched_to_per_till(self, w):
        owner_setup(w)
        out = put(w, w.shop, template("independent_till"))
        assert [m.z_mode for m in w.six] == ["till"] * 6
        assert w.shop.local_network is False and not LZ.local_mode_of_shop(w.db, w.shop)
        assert set(states(out).values()) == {"applied"}
        assert {"zMode", "localNetwork", "tablesMode", T.SETTINGS_KEY} <= set(out["changes"])
        assert {(c.scope_type, c.new_value) for c in changes(w, "zMode")} == {("machine", "till")}

    def test_switched_to_the_cloud(self, w):
        owner_setup(w)
        out = put(w, w.shop, template("quick_counter"))
        assert w.shop.local_network is False
        assert out["status"]["zType"] == {"state": "applied"} and out["status"]["localServer"] == {"state": "applied"}

    def test_a_shop_with_tills_and_no_main_till_gets_one(self, w):
        w.shop.local_network = False
        w.db.commit()
        out = put(w, w.shop, template("restaurant_tables"))
        assert MT.main_till_of_shop(w.db, w.shop.id).id == w.six[0].id
        assert LZ.local_mode_of_shop(w.db, w.shop)
        assert set(states(out).values()) == {"applied"}

    def test_the_shop_z_producer_guard(self, w):
        from test_independent_till import report

        owner_setup(w)
        report(w, w.six[0], pending=2, last=7)
        w.db.commit()
        code, detail = refused(put, w, w.shop, template("quick_counter"))
        assert code == 409 and detail["code"] == LZ.BUSY and detail["field"] == "localServer"
        assert "2 דוחות Z סניפיים" in detail["message"]
        w.db.expire_all()
        assert w.db.get(Shop, w.shop.id).local_network is True

    def test_a_blocked_z_does_not_block_the_rest(self, w):
        owner_setup(w)
        assert put(w, w.shop, template("restaurant_tables"))["status"]["zType"] == {"state": "applied"}
        # Till 3 is put on its own Z by hand, and is open now: the profile's Z waits, with why.
        w.six[2].z_mode = "till"
        w.shift(w.six[2], 1, status=ShiftStatus.OPEN)
        w.db.commit()
        view = get(w, w.shop)
        assert view["status"]["zType"]["state"] == "blocked" and "קופה 3" in view["status"]["zType"]["reason"]
        out = put(w, w.shop, template("restaurant_tables", attendance=True))
        assert out["status"]["attendance"] == {"state": "applied"}
        assert out["status"]["zType"]["state"] == "blocked"


# ── 7. Who may ────────────────────────────────────────────────────────────────


class TestPermissions:
    def test_a_distributor_sets_it_up_but_not_the_z_once_there_are_tills(self, w, seat):
        dist = user_of(w, UserRole.DISTRIBUTOR)
        shop = create(w, user=dist, workProfile=template("restaurant_tables"))
        assert shop.work_profile_status["applied"] is True
        assert all(get(w, shop, dist)["canEdit"].values())
        # Before any till, the distributor changes anything, the Z too.
        assert put(w, shop, template("quick_counter"), dist)["profile"]["zType"] == "shop_cloud"
        pair(w, shop, by=dist)
        can = get(w, shop, dist)["canEdit"]
        assert can["zType"] is False and can["localServer"] is False and can["shopZFrom"] is False
        assert can["tablesMode"] and can["kitchen"] and can["attendance"] and can["tips"] and can["vouchers"]
        code, detail = refused(put, w, shop, template("independent_till"), dist)
        assert code == 403 and detail["code"] == "work_profile_forbidden" and "zType" in detail["fields"]
        assert "מנהל-על" in detail["message"]
        assert T.stored(w.db.get(Shop, shop.id).settings)["zType"] == "shop_cloud"
        # The rest is still theirs.
        out = put(w, shop, template("quick_counter", attendance=True, tablesMode="synced"), dist)
        assert out["status"]["attendance"] == {"state": "applied"} and out["status"]["tablesMode"] == {"state": "applied"}
        # The super admin changes the Z.
        assert get(w, shop)["canEdit"]["zType"] is True

    def test_a_shop_manager_reads_and_changes_nothing(self, w):
        boss = user_of(w, UserRole.SHOP_MANAGER, shop_id=w.shop.id)
        view = get(w, w.shop, boss)
        assert not any(view["canEdit"].values())
        code, detail = refused(put, w, w.shop, view["profile"], boss)
        assert code == 403 and detail["code"] == "work_profile_forbidden"

    def test_a_company_manager_of_another_company_cannot_read(self, w):
        from app.models.company import Company

        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other", vat_number="514141414")
        w.db.add(other)
        w.db.commit()
        boss = user_of(w, UserRole.COMPANY_MANAGER, company_id=other.id)
        code, _ = refused(get, w, w.shop, boss)
        assert code == 403


# ── 8. The change log ─────────────────────────────────────────────────────────


class TestChangeLog:
    def test_every_change_is_logged(self, w):
        w.shop.local_network = False
        w.db.commit()
        profile = template(
            "quick_counter", shopZFrom="any_and_dashboard", tablesMode="synced", kitchen="both",
            customerDisplay=True, attendance=True, tips={"enabled": True, "distribution": "by_sales"},
            vouchers={"station": True, "balanceCheck": "off"},
        )
        out = put(w, w.shop, profile)
        assert set(states(out).values()) == {"applied"}
        logged = {(c.parameter_key, c.scope_type) for c in changes(w)}
        assert {
            ("shopZFrom", "shop"), ("tablesMode", "shop"), ("kdsEnabled", "shop"), ("workflowTargets", "shop"),
            ("customerDisplay.enabled", "shop"), ("attendanceEnabled", "shop"), ("tipsEnabled", "shop"),
            ("tipDistribution", "shop"), ("voucherStation", "shop"), ("voucherBalanceCheck", "shop"),
            ("workProfile", "shop"),
        } <= logged
        assert all(c.user_role == "super_admin" and c.user_email == w.admin.email for c in changes(w))
        # The same again: nothing more.
        count = len(changes(w))
        put(w, w.shop, profile)
        assert len(changes(w)) == count

    def test_the_work_types_card_logs_the_tables_too(self, w):
        B.set_work_types(w.db, w.shop, w.admin, tables=True, tables_mode=SYNCED)
        row = changes(w, "tablesMode")
        assert [(r.scope_type, r.new_value, r.user_role) for r in row] == [("shop", SYNCED, "super_admin")]
        # Off: the shop's value, and a till's own value let go of — each in the log.
        from test_independent_till import set_param

        set_param(w, "tablesMode", "machine", w.six[1].id, SYNCED)
        w.db.commit()
        B.set_work_types(w.db, w.shop, w.admin, tables=False)
        rows = {(r.scope_type, r.action, r.new_value) for r in changes(w, "tablesMode")}
        assert ("shop", "set", "כבוי") in rows and ("machine", "clear", None) in rows


# ── The status follows the shop ───────────────────────────────────────────────


class TestStatus:
    def test_a_change_elsewhere_shows_as_not_applied(self, w):
        w.shop.local_network = False
        w.db.commit()
        put(w, w.shop, template("quick_counter", attendance=True))
        from test_independent_till import set_param

        set_param(w, "attendanceEnabled", "shop", w.shop.id, False)
        w.db.commit()
        entry = get(w, w.shop)["status"]["attendance"]
        assert entry["state"] == "blocked" and "כבוי" in entry["reason"]

    def test_the_local_network_switched_off_on_the_shop_page(self, w):
        owner_setup(w)
        put(w, w.shop, template("restaurant_tables"))
        w.shop.local_network = False
        w.db.commit()
        view = get(w, w.shop)
        # Nothing stands in the way: it waits for a super admin's save on the shop's page.
        assert view["status"]["localServer"] == {"state": "pending", "reason": WP.WAIT_SUPER_ADMIN}
        assert view["status"]["zType"] == {"state": "pending", "reason": WP.WAIT_SUPER_ADMIN}
        assert set(states(put(w, w.shop, template("restaurant_tables"))).values()) == {"applied"}
