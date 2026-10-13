"""The voucher fast mode — the owner's decisions of 13.10.2026 (P:/specs/voucher-fast-mode.md §0):
"מצב מהיר כשהעובד לא צריך לבחור פריט", "המכשיר עובר להיות בקר סריקה".

Nine flat keys, set at every level (tenant, company, shop, point of sale, till) and merged like
`voucherAutoApply`:

    voucherFastMode             "off" | "station" | "all"            unset = "station"
    voucherFastAutoClose        "on" | "off"                         unset = "on"
    voucherStationCamera        "off" | "always" | "tap"             unset = "tap"
    voucherStationCameraFacing  "back" | "front"                     unset = "back"
    voucherVibrate              "off" | "approve" | "reject" | "both" unset = "both"
    voucherSoundBoost           "on" | "off"                         unset = "on"
    voucherStationCatalogSwitch "off" | "manager" | "free"           unset = "manager"
    voucherStationHeader        "logo" | "text" | "both" | "none"    unset = "logo"
    voucherStationTitle         free text, up to 40 characters       unset = "עמדת מימוש שוברים"

Always sent to the till resolved; a value outside a choice's values, or a title over 40 characters
(with a Hebrew message), is a 422; `null` (and a blank title) resets a layer; each change is logged
with its level; the dashboard's preview has the inherited value and its source.

Mock-based like tests/test_voucher_success_screen_settings.py.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from pydantic import ValidationError

from app.models.till_parameter import TillParameterChange
from app.models.user import UserRole
from app.routers.settings import get_machine_settings, get_shop_settings, patch_company_settings
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services.settings_merge import MANAGED_SETTING_KEYS, merge_all_settings_layers, patch_to_camel_dict
from app.services.voucher_redeem_settings import _audited_keys
from app.services.voucher_station_settings import (
    DEFAULT_STATION_TITLE,
    STATION_TITLE_MAX,
    STATION_TITLE_TOO_LONG,
    VOUCHER_FAST_CHOICES,
    VOUCHER_FAST_MODE_SETTING_KEYS,
    resolve_auto_apply,
    resolve_show_entitlement,
    resolve_station_paid_items,
    resolve_voucher_fast_mode,
    resolve_voucher_sounds,
    resolve_voucher_station,
    resolve_voucher_success,
)
from test_voucher_pay_options import _patch_area, _patch_machine, _patch_shop, _patch_tenant, _sync, _user, _world

MODE = "voucherFastMode"
AUTO_CLOSE = "voucherFastAutoClose"
CAMERA = "voucherStationCamera"
FACING = "voucherStationCameraFacing"
VIBRATE = "voucherVibrate"
BOOST = "voucherSoundBoost"
CATALOG = "voucherStationCatalogSwitch"
HEADER = "voucherStationHeader"
TITLE = "voucherStationTitle"

#: The contract with the till: every choice's values (in the dashboard's order) and its default.
CHOICES = {
    MODE: (("off", "station", "all"), "station"),
    AUTO_CLOSE: (("on", "off"), "on"),
    CAMERA: (("off", "always", "tap"), "tap"),
    FACING: (("back", "front"), "back"),
    VIBRATE: (("off", "approve", "reject", "both"), "both"),
    BOOST: (("on", "off"), "on"),
    CATALOG: (("off", "manager", "free"), "manager"),
    HEADER: (("logo", "text", "both", "none"), "logo"),
}
KEYS = (*CHOICES, TITLE)
DEFAULTS = {**{k: d for k, (_, d) in CHOICES.items()}, TITLE: "עמדת מימוש שוברים"}
#: A value other than the default for every key — what a level sets in the tests below.
OTHER = {
    MODE: "all", AUTO_CLOSE: "off", CAMERA: "always", FACING: "front", VIBRATE: "reject",
    BOOST: "off", CATALOG: "free", HEADER: "both", TITLE: "עמדת שוברים — אירוע",
}
CHOICE_CASES = [(k, v) for k, (values, _) in CHOICES.items() for v in values]


def _audit_rows(db):
    return [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], TillParameterChange)]


def _patch_company(company, db, body):
    with patch("app.routers.settings._check_company_access"), patch(
        "app.routers.settings._check_company_settings_write"
    ), patch("app.routers.settings.notify_machines_for_company_settings"):
        return patch_company_settings(
            company_id=str(company.id),
            data=PosSettingsV1Patch.model_validate(body),
            current_user=_user(UserRole.COMPANY_MANAGER),
            active_tenant_id=company.tenant_id,
            db=db,
        )


def _fast(settings):
    return {k: settings[k] for k in KEYS}


def _app_client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.database import get_db
    from app.middleware.auth import get_active_tenant_id, get_current_machine_admin, get_current_user
    from app.routers import settings as S

    app = FastAPI()
    app.include_router(S.router)
    app.dependency_overrides[get_db] = lambda: None
    app.dependency_overrides[get_current_user] = lambda: _user(UserRole.SUPER_ADMIN)
    app.dependency_overrides[get_current_machine_admin] = lambda: _user(UserRole.SUPER_ADMIN)
    app.dependency_overrides[get_active_tenant_id] = lambda: None
    return TestClient(app)


LEVEL_PATHS = ["/tenants/t1/settings", "/companies/c1/settings", "/shops/s1/settings", "/areas/a1/settings", "/machines/m1/settings"]


# ── The contract ─────────────────────────────────────────────────────────────


def test_the_keys_their_values_and_defaults_are_the_contract_with_the_till() -> None:
    assert VOUCHER_FAST_MODE_SETTING_KEYS == KEYS
    assert VOUCHER_FAST_CHOICES == CHOICES
    assert DEFAULT_STATION_TITLE == "עמדת מימוש שוברים" and STATION_TITLE_MAX == 40
    for key in KEYS:
        assert key in MANAGED_SETTING_KEYS  # merged per layer and synced
        assert key in _audited_keys()  # every change is logged


def test_unset_is_the_owners_defaults() -> None:
    assert resolve_voucher_fast_mode({}) == DEFAULTS


@pytest.mark.parametrize("key", list(CHOICES))
@pytest.mark.parametrize("junk", ["ON", "Off", "STATION", "maybe", "", " off", 1, 0, True, False, None, [], {}])
def test_an_unknown_choice_is_its_default(key, junk) -> None:
    assert resolve_voucher_fast_mode({key: junk}) == DEFAULTS


@pytest.mark.parametrize("key,value", CHOICE_CASES)
def test_a_known_choice_resolves_to_itself(key, value) -> None:
    assert resolve_voucher_fast_mode({key: value}) == {**DEFAULTS, key: value}


@pytest.mark.parametrize(
    "stored,shown",
    [
        ("עמדת חלוקה", "עמדת חלוקה"),
        ("  עמדת   חלוקה \n", "עמדת חלוקה"),  # read as written: one line, trimmed
        ("א" * 40, "א" * 40),
    ],
)
def test_a_title_resolves_to_itself_as_one_trimmed_line(stored, shown) -> None:
    assert resolve_voucher_fast_mode({TITLE: stored})[TITLE] == shown


@pytest.mark.parametrize("junk", ["", "   ", "\n\t", "א" * 41, 5, True, None, ["x"], {"he": "x"}])
def test_a_blank_too_long_or_non_text_title_is_the_default(junk) -> None:
    assert resolve_voucher_fast_mode({TITLE: junk})[TITLE] == "עמדת מימוש שוברים"


def test_they_stand_apart_from_the_other_voucher_keys() -> None:
    merged = dict(OTHER)
    for other in (
        resolve_voucher_station, resolve_station_paid_items, resolve_show_entitlement, resolve_auto_apply,
        resolve_voucher_success, resolve_voucher_sounds,
    ):
        assert not set(other(merged)) & set(KEYS)
    assert set(resolve_voucher_fast_mode({"voucherAutoClose": "off", "voucherStation": "on"})) == set(KEYS)
    resolve_voucher_fast_mode(merged)
    assert merged == OTHER  # a view: nothing written back


# ── Validation: 422 outside the values / over 40 characters ──────────────────


@pytest.mark.parametrize("key,value", CHOICE_CASES)
def test_the_patch_takes_each_choice(key, value) -> None:
    assert patch_to_camel_dict(PosSettingsV1Patch.model_validate({key: value})) == {key: value}


@pytest.mark.parametrize("key", list(CHOICES))
@pytest.mark.parametrize("bad", ["ON", "maybe", "", " on", 1, True, ["off"], {"v": "off"}])
def test_a_choice_outside_its_values_is_refused(key, bad) -> None:
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({key: bad})


@pytest.mark.parametrize(
    "sent,stored",
    [
        ("עמדת חלוקה", "עמדת חלוקה"),
        ("  עמדת   חלוקה  ", "עמדת חלוקה"),  # trimmed, one space between words
        ("שורה\nשנייה\tוטאב", "שורה שנייה וטאב"),  # one line
        ("א\x00ב", "א ב"),  # no control characters
        ("א" * 40, "א" * 40),
        ("  " + "א" * 40 + "   ", "א" * 40),  # 40 after trimming
    ],
)
def test_the_patch_takes_a_title_trimmed(sent, stored) -> None:
    assert patch_to_camel_dict(PosSettingsV1Patch.model_validate({TITLE: sent})) == {TITLE: stored}


@pytest.mark.parametrize("blank", ["", "   ", "\n"])
def test_a_blank_title_is_a_reset(blank) -> None:
    data = PosSettingsV1Patch.model_validate({TITLE: blank})
    assert data.voucher_station_title is None
    assert TITLE in data.model_dump(exclude_unset=True, by_alias=True)  # sent: a reset, not "unchanged"


def test_a_title_over_40_characters_is_refused_in_hebrew() -> None:
    with pytest.raises(ValidationError) as exc_info:
        PosSettingsV1Patch.model_validate({TITLE: "א" * 41})
    (error,) = exc_info.value.errors()
    assert error["type"] == STATION_TITLE_TOO_LONG
    assert error["msg"] == "לא ניתן לשמור כיתוב של 41 תווים: הכיתוב בראש עמדת שובר יכול להיות עד 40 תווים."
    assert error["ctx"] == {"value": 41, "limit": 40}


@pytest.mark.parametrize("bad", [5, True, ["x"], {"he": "x"}])
def test_a_title_that_is_not_text_is_refused(bad) -> None:
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({TITLE: bad})


@pytest.mark.parametrize("path", LEVEL_PATHS)
@pytest.mark.parametrize(
    "body",
    [{MODE: "fast"}, {AUTO_CLOSE: "yes"}, {CAMERA: "on"}, {FACING: "rear"}, {VIBRATE: "on"}, {BOOST: True},
     {CATALOG: "manager_code"}, {HEADER: "title"}, {TITLE: "א" * 41}],
)
def test_every_levels_endpoint_answers_422_for_a_value_outside_the_rules(path, body) -> None:
    assert _app_client().patch(path, json=body).status_code == 422


@pytest.mark.parametrize("path", LEVEL_PATHS)
def test_every_levels_endpoint_says_why_a_title_is_too_long_in_hebrew(path) -> None:
    res = _app_client().patch(path, json={TITLE: "ב" * 45})
    assert res.status_code == 422
    (error,) = res.json()["detail"]
    assert error["msg"] == "לא ניתן לשמור כיתוב של 45 תווים: הכיתוב בראש עמדת שובר יכול להיות עד 40 תווים."


# ── Every level: set, inherit, reset; the sync payload ───────────────────────


def test_sync_sends_the_defaults_when_nothing_sets_them() -> None:
    _, _, _, area, machine, db = _world()
    assert _fast(_sync(machine, db, area).settings) == DEFAULTS


@pytest.mark.parametrize("level", range(5))
def test_a_value_at_any_one_level_reaches_the_till(level) -> None:
    layers = [{} for _ in range(5)]
    layers[level] = dict(OTHER)
    _, _, _, area, machine, db = _world(*layers)
    assert _fast(_sync(machine, db, area).settings) == OTHER


def test_sync_carries_each_level_down_and_the_deepest_wins() -> None:
    cases = [
        (({MODE: "off", TITLE: "דוכן"}, {}, {}, {}, {}), {MODE: "off", TITLE: "דוכן"}),  # the tenant's
        (({MODE: "off"}, {MODE: "all", VIBRATE: "off"}, {}, {}, {}), {MODE: "all", VIBRATE: "off"}),  # the company's
        (({}, {CAMERA: "off"}, {CAMERA: "always", FACING: "front"}, {}, {}), {CAMERA: "always", FACING: "front"}),  # the shop's
        (({}, {}, {HEADER: "none"}, {HEADER: "text", TITLE: "קופה 2"}, {}), {HEADER: "text", TITLE: "קופה 2"}),  # the point of sale's
        (({BOOST: "off"}, {CATALOG: "off"}, {CATALOG: "free"}, {AUTO_CLOSE: "off"}, {AUTO_CLOSE: "on", CATALOG: "off"}),
         {BOOST: "off", AUTO_CLOSE: "on", CATALOG: "off"}),  # the till's
    ]
    for layers, expected in cases:
        _, _, _, area, machine, db = _world(*layers)
        assert _fast(_sync(machine, db, area).settings) == {**DEFAULTS, **expected}, layers


@pytest.mark.parametrize(
    "junk",
    [{MODE: "fast"}, {CAMERA: True}, {FACING: None}, {VIBRATE: 1}, {HEADER: ["logo"]}, {TITLE: ""},
     {TITLE: "א" * 41}, {TITLE: 7}, {k: None for k in KEYS}],
)
def test_sync_sends_a_junk_value_as_the_default(junk) -> None:
    _, _, _, area, machine, db = _world({}, {}, junk)
    assert _fast(_sync(machine, db, area).settings) == DEFAULTS


def test_every_level_takes_and_resets_them() -> None:
    tenant, company, shop, area, machine, db = _world()
    bodies = [
        {MODE: "off", TITLE: "רשת"},
        {MODE: "all", CAMERA: "off"},
        {CAMERA: "always", FACING: "front", TITLE: "סניף"},
        {VIBRATE: "approve", HEADER: "text"},
        {VIBRATE: "off", BOOST: "off", CATALOG: "free", AUTO_CLOSE: "off"},
    ]
    _patch_tenant(tenant, db, bodies[0])
    _patch_company(company, db, bodies[1])
    _patch_shop(shop, db, bodies[2])
    _patch_area(area, shop, db, bodies[3])
    _patch_machine(machine, area, db, bodies[4])
    layers = (tenant, company, shop, area, machine)
    assert [e.settings for e in layers] == bodies
    expected = {
        **DEFAULTS, MODE: "all", CAMERA: "always", FACING: "front", TITLE: "סניף", VIBRATE: "off", HEADER: "text",
        BOOST: "off", CATALOG: "free", AUTO_CLOSE: "off",
    }
    assert resolve_voucher_fast_mode(merge_all_settings_layers(company, shop, tenant, machine, area)) == expected
    _patch_machine(machine, area, db, {k: None for k in bodies[4]})
    assert machine.settings == {}
    assert _fast(_sync(machine, db, area).settings) == {**expected, VIBRATE: "approve", BOOST: "on", CATALOG: "manager", AUTO_CLOSE: "on"}
    _patch_area(area, shop, db, {VIBRATE: None, HEADER: None})
    _patch_shop(shop, db, {CAMERA: None, FACING: None, TITLE: "   "})  # a blank title resets too
    _patch_company(company, db, {MODE: None, CAMERA: None})
    assert [e.settings for e in (company, shop, area)] == [{}, {}, {}]
    assert _fast(_sync(machine, db, area).settings) == {**DEFAULTS, MODE: "off", TITLE: "רשת"}  # back to the tenant's
    _patch_tenant(tenant, db, {MODE: None, TITLE: None})
    assert tenant.settings == {}
    assert _fast(_sync(machine, db, area).settings) == DEFAULTS


def test_a_title_is_stored_trimmed() -> None:
    _, _, shop, _, _, db = _world()
    _patch_shop(shop, db, {TITLE: "  עמדת   מימוש  "})
    assert shop.settings == {TITLE: "עמדת מימוש"}


def test_a_patch_of_one_leaves_the_others_alone() -> None:
    _, _, shop, _, _, db = _world({}, {}, {MODE: "off", "voucherSoundApprove": "off", TITLE: "דוכן"})
    _patch_shop(shop, db, {CAMERA: "always"})
    assert shop.settings == {MODE: "off", "voucherSoundApprove": "off", TITLE: "דוכן", CAMERA: "always"}
    _patch_shop(shop, db, {MODE: None})
    assert shop.settings == {"voucherSoundApprove": "off", TITLE: "דוכן", CAMERA: "always"}


# ── The dashboard's preview: the inherited value and its source ──────────────


def test_a_shops_preview_shows_the_effective_values_and_their_source() -> None:
    _, _, shop, _, _, db = _world(
        {MODE: "off", TITLE: "רשת"}, {MODE: "all", VIBRATE: "approve"}, {MODE: "station", HEADER: "none"}
    )
    with patch("app.routers.settings._check_shop_access"):
        res = get_shop_settings(
            shop_id=str(shop.id), include_effective=True, current_user=_user(UserRole.SHOP_MANAGER, shop.id),
            active_tenant_id=shop.tenant_id, db=db,
        )
    assert (res.effective[MODE], res.effective_sources[MODE]) == ("all", "company")  # not its own value
    assert (res.effective[VIBRATE], res.effective_sources[VIBRATE]) == ("approve", "company")
    assert (res.effective[TITLE], res.effective_sources[TITLE]) == ("רשת", "tenant")
    assert res.effective[HEADER] == "logo" and HEADER not in (res.effective_sources or {})
    assert res.settings == {MODE: "station", HEADER: "none"}  # its own layer, raw


def test_a_tills_preview_shows_the_defaults_when_no_level_sets_them() -> None:
    _, _, _, area, machine, db = _world()
    with patch("app.routers.settings._machine_for_read", return_value=machine), patch(
        "app.routers.settings.get_area", return_value=area
    ):
        res = get_machine_settings(
            machine_id=str(machine.id), include_effective=True, current_user=_user(UserRole.SUPER_ADMIN),
            active_tenant_id=machine.tenant_id, db=db,
        )
    assert _fast(res.effective) == DEFAULTS
    assert not set(KEYS) & set(res.effective_sources or {})


# ── The change log (till_parameter_changes) ──────────────────────────────────


def test_each_change_is_logged_with_its_level_and_old_and_new_value() -> None:
    tenant, company, shop, area, machine, db = _world({}, {}, {}, {}, {CAMERA: "off", TITLE: "קופה 1"})
    _patch_tenant(tenant, db, {MODE: "off"})
    _patch_company(company, db, {VIBRATE: "reject", BOOST: "off"})
    _patch_shop(shop, db, {TITLE: "  עמדת  שוברים "})
    _patch_area(area, shop, db, {HEADER: "both", CATALOG: "free", FACING: "front", AUTO_CLOSE: "off"})
    _patch_machine(machine, area, db, {CAMERA: None, TITLE: ""})
    rows = _audit_rows(db)
    assert [(r.parameter_key, r.scope_type, r.action, r.old_value, r.new_value) for r in rows] == [
        (MODE, "tenant", "set", None, "off"),
        (VIBRATE, "company", "set", None, "reject"),
        (BOOST, "company", "set", None, "off"),
        (TITLE, "shop", "set", None, "עמדת שוברים"),  # logged as stored
        (AUTO_CLOSE, "area", "set", None, "off"),
        (FACING, "area", "set", None, "front"),
        (CATALOG, "area", "set", None, "free"),
        (HEADER, "area", "set", None, "both"),
        (CAMERA, "machine", "clear", "off", None),
        (TITLE, "machine", "clear", "קופה 1", None),
    ]
    assert [r.scope_id for r in rows] == [e.id for e in (tenant, company, company, shop, area, area, area, area, machine, machine)]


def test_an_unchanged_value_is_not_logged() -> None:
    _, _, shop, _, _, db = _world({}, {}, {MODE: "all", TITLE: "דוכן"})
    _patch_shop(shop, db, {MODE: "all", TITLE: " דוכן "})  # the same once trimmed
    assert _audit_rows(db) == []
    _patch_shop(shop, db, {MODE: "off"})
    rows = _audit_rows(db)
    assert [(r.parameter_key, r.action, r.old_value, r.new_value) for r in rows] == [(MODE, "set", "all", "off")]
