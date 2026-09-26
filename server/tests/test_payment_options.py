"""Payment options a till offers, and whether each asks for a tip.

The parity table below is the contract with the Android till, which carries the
same rule in Kotlin against the same rows. Change a row here and the till has to
change with it. Style matches the rest of tests/: no database, no client; handler
functions are called directly with mocked sessions.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.models.user import User, UserRole
from app.routers.settings import (
    get_shop_settings,
    patch_company_settings,
    patch_shop_settings,
    patch_tenant_settings,
)
from app.routers.sync import get_settings_sync
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services.payment_options import (
    PAYMENT_OPTION_SETTING_KEYS,
    PAYMENT_OPTIONS,
    legacy_tip_flags,
    resolve_payment_options,
)
from app.services.settings_merge import (
    MANAGED_SETTING_KEYS,
    merge_all_settings_layers,
    patch_to_camel_dict,
)

ALL_OFF = {
    "payFastCashEnabled": False,
    "payCashEnabled": False,
    "payFastCardEnabled": False,
    "payCardEnabled": False,
}


def _ts() -> datetime:
    return datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc)


def _allowed(resolved: dict) -> dict:
    return {o.name: resolved[o.allowed_key] for o in PAYMENT_OPTIONS}


def _tips(resolved: dict) -> dict:
    return {o.name: resolved[o.tips_key] for o in PAYMENT_OPTIONS}


# What a shop that set nothing gets: the four original options, and not manual card,
# which is opt-in because the acquirer has to enable keyed entry for the merchant.
ALL_ALLOWED = {"fastCash": True, "cash": True, "fastCard": True, "card": True, "manualCard": False}
NO_TIPS = {"fastCash": False, "cash": False, "fastCard": False, "card": False, "manualCard": False}


# ── The options themselves ───────────────────────────────────────────────────

def test_the_options_and_their_keys_are_the_contract() -> None:
    # Renaming any of these strands the till and the dashboard, which read them
    # by name. The tender is what the stored document says; it never changes.
    assert [(o.name, o.tender, o.allowed_key, o.tips_key) for o in PAYMENT_OPTIONS] == [
        ("fastCash", "cash", "payFastCashEnabled", "payFastCashTips"),
        ("cash", "cash", "payCashEnabled", "payCashTips"),
        ("fastCard", "card", "payFastCardEnabled", "payFastCardTips"),
        ("card", "card", "payCardEnabled", "payCardTips"),
        ("manualCard", "card", "payManualCardEnabled", "payManualCardTips"),
    ]


def test_payment_option_keys_are_managed_and_therefore_synced() -> None:
    assert len(PAYMENT_OPTION_SETTING_KEYS) == 10
    for key in PAYMENT_OPTION_SETTING_KEYS:
        assert key in MANAGED_SETTING_KEYS
    # The legacy pair stays managed: layers hold it, and it is the fallback.
    assert "tipsEnabled" in MANAGED_SETTING_KEYS
    assert "cashTipsEnabled" in MANAGED_SETTING_KEYS


def test_patch_schema_accepts_every_option_key_and_the_legacy_pair() -> None:
    body = {key: False for key in PAYMENT_OPTION_SETTING_KEYS}
    body.update({"tipsEnabled": True, "cashTipsEnabled": True})
    assert patch_to_camel_dict(PosSettingsV1Patch.model_validate(body)) == body


def test_patch_schema_leaves_unsent_payment_keys_unset() -> None:
    # Unsent must stay absent, never become False: a stored False hides the option.
    data = PosSettingsV1Patch.model_validate({"payCashTips": True})
    assert patch_to_camel_dict(data) == {"payCashTips": True}


# ── Manual card: opt-in ──────────────────────────────────────────────────────

def test_manual_card_is_not_offered_until_switched_on() -> None:
    # Keyed entry is a telephone-order transaction the acquirer has to enable, and a
    # shop that never asked for it must not find the button on its tills.
    assert resolve_payment_options({})["payManualCardEnabled"] is False
    assert resolve_payment_options({"payManualCardEnabled": True})["payManualCardEnabled"] is True


def test_manual_card_is_not_switched_on_by_a_string() -> None:
    assert resolve_payment_options({"payManualCardEnabled": "true"})["payManualCardEnabled"] is False


def test_manual_card_tips_follow_the_card_rule_once_it_is_on() -> None:
    assert resolve_payment_options({"tipsEnabled": True})["payManualCardTips"] is False
    on = resolve_payment_options({"tipsEnabled": True, "payManualCardEnabled": True})
    assert on["payManualCardTips"] is True
    assert resolve_payment_options(
        {"tipsEnabled": True, "payManualCardEnabled": True, "payManualCardTips": False}
    )["payManualCardTips"] is False


def test_manual_card_switched_on_at_the_shop_beats_the_company_off() -> None:
    # Through the real sync path, so the layer merge is the one the till gets.
    resp = _sync({"payManualCardEnabled": False}, {"payManualCardEnabled": True})
    assert resp.settings["payManualCardEnabled"] is True
    resp = _sync({"payManualCardEnabled": True}, {})
    assert resp.settings["payManualCardEnabled"] is True


def test_manual_card_alone_is_enough_to_keep_a_layer_payable() -> None:
    from app.services.payment_options import any_allowed

    assert any_allowed({**ALL_OFF, "payManualCardEnabled": True}) is True
    assert any_allowed(ALL_OFF) is False


# ── Parity with the till (one test per row) ──────────────────────────────────

def test_parity_1_nothing_set_all_allowed_no_tips() -> None:
    r = resolve_payment_options({})
    assert _allowed(r) == ALL_ALLOWED
    assert _tips(r) == NO_TIPS


def test_parity_2_tips_enabled_covers_card_paths_only() -> None:
    r = resolve_payment_options({"tipsEnabled": True})
    assert _tips(r) == {"fastCash": False, "cash": False, "fastCard": True, "card": True, "manualCard": False}


def test_parity_3_tips_and_cash_tips_cover_all_four() -> None:
    r = resolve_payment_options({"tipsEnabled": True, "cashTipsEnabled": True})
    assert _tips(r) == {"fastCash": True, "cash": True, "fastCard": True, "card": True, "manualCard": False}


def test_parity_4_cash_tips_alone_turns_nothing_on() -> None:
    r = resolve_payment_options({"cashTipsEnabled": True, "tipsEnabled": False})
    assert _tips(r) == NO_TIPS


def test_parity_5_new_tips_key_beats_legacy_off() -> None:
    r = resolve_payment_options({"payFastCashTips": True, "tipsEnabled": False})
    assert _tips(r) == {"fastCash": True, "cash": False, "fastCard": False, "card": False, "manualCard": False}


def test_parity_6_new_tips_key_beats_legacy_on() -> None:
    r = resolve_payment_options({"payCardTips": False, "tipsEnabled": True})
    assert r["payCardTips"] is False
    assert r["payFastCardTips"] is True


def test_parity_7_hidden_option_never_asks_for_a_tip() -> None:
    r = resolve_payment_options({"payCashEnabled": False, "payCashTips": True})
    assert r["payCashEnabled"] is False
    assert r["payCashTips"] is False
    # The other three are untouched.
    assert r["payFastCashEnabled"] is True
    assert r["payFastCardEnabled"] is True
    assert r["payCardEnabled"] is True


def test_parity_8_a_string_is_not_a_bool_so_it_counts_as_unset() -> None:
    r = resolve_payment_options({"payFastCardEnabled": "true"})
    assert r["payFastCardEnabled"] is True
    # ... and "false" does not hide it either.
    assert resolve_payment_options({"payFastCardEnabled": "false"})["payFastCardEnabled"] is True


def test_parity_9_shop_layer_re_allows_what_its_company_hid() -> None:
    company = MagicMock()
    company.settings = {"payCashEnabled": False}
    shop = MagicMock()
    shop.settings = {"payCashEnabled": True}
    assert resolve_payment_options(merge_all_settings_layers(company))["payCashEnabled"] is False
    merged = merge_all_settings_layers(company, shop)
    assert resolve_payment_options(merged)["payCashEnabled"] is True


@pytest.mark.parametrize("junk", ["true", "false", 1, 0, None, [], {}])
def test_any_non_bool_value_counts_as_unset(junk) -> None:
    # 1 and 0 are the subtle ones: bool is a subclass of int, not the other way round.
    r = resolve_payment_options(
        {"payCashEnabled": junk, "payCardTips": junk, "tipsEnabled": True}
    )
    assert r["payCashEnabled"] is True
    assert r["payCardTips"] is True  # fell back to tipsEnabled


def test_legacy_fallback_also_requires_real_bools() -> None:
    r = resolve_payment_options({"tipsEnabled": "true", "cashTipsEnabled": 1})
    assert _tips(r) == NO_TIPS


def test_resolved_values_are_real_bools() -> None:
    for merged in ({}, {"tipsEnabled": True}, {"payCashEnabled": "x"}, ALL_OFF):
        r = resolve_payment_options(merged)
        assert set(r) == set(PAYMENT_OPTION_SETTING_KEYS)
        assert all(isinstance(v, bool) for v in r.values())


def test_resolving_does_not_mutate_the_merged_dict() -> None:
    merged = {"tipsEnabled": True}
    resolve_payment_options(merged)
    assert merged == {"tipsEnabled": True}


# ── Legacy pair for older APKs ───────────────────────────────────────────────

def test_legacy_flags_follow_the_resolved_options() -> None:
    assert legacy_tip_flags(resolve_payment_options({})) == {
        "tipsEnabled": False,
        "cashTipsEnabled": False,
    }
    # Tips turned on through a new key alone still reach an old till.
    assert legacy_tip_flags(resolve_payment_options({"payFastCashTips": True})) == {
        "tipsEnabled": True,
        "cashTipsEnabled": True,
    }
    # Card tips only.
    assert legacy_tip_flags(resolve_payment_options({"tipsEnabled": True})) == {
        "tipsEnabled": True,
        "cashTipsEnabled": False,
    }
    # Both cash paths hidden: stored cashTipsEnabled no longer means anything.
    hidden_cash = {
        "tipsEnabled": True,
        "cashTipsEnabled": True,
        "payFastCashEnabled": False,
        "payCashEnabled": False,
    }
    assert legacy_tip_flags(resolve_payment_options(hidden_cash)) == {
        "tipsEnabled": True,
        "cashTipsEnabled": False,
    }


# ── Sync to the till ─────────────────────────────────────────────────────────

def _sync(company_settings: dict, shop_settings: dict, tenant_settings=None):
    machine = MagicMock()
    machine.id = uuid.uuid4()
    machine.shop_id = uuid.uuid4()

    shop = MagicMock()
    shop.company_id = uuid.uuid4()
    shop.settings = shop_settings
    shop.settings_updated_at = _ts()
    shop.updated_at = _ts()
    shop.branch_id = None
    shop.address = None
    shop.city = None

    tenant = None
    if tenant_settings is not None:
        tenant = MagicMock()
        tenant.settings = tenant_settings
        tenant.settings_updated_at = _ts()
        tenant.updated_at = _ts()

    company = MagicMock()
    company.tenant_id = uuid.uuid4() if tenant else None
    company.settings = company_settings
    company.settings_updated_at = _ts()
    company.updated_at = _ts()
    company.name = "Co"
    company.vat_number = "1"
    company.address = "A"
    company.city = "C"

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

    with patch("app.routers.sync.update_machine_sync_timestamp"):
        return get_settings_sync(machine_id=str(machine.id), since=None, machine=machine, db=db)


def test_sync_carries_every_resolved_key_when_nothing_is_set() -> None:
    resp = _sync({}, {})
    for option in PAYMENT_OPTIONS:
        # Each option's own default, sent explicitly: a till must never have to
        # guess what an absent key means.
        assert resp.settings[option.allowed_key] is option.allowed_by_default
        assert resp.settings[option.tips_key] is False
    assert resp.settings["payManualCardEnabled"] is False
    assert resp.settings["tipsEnabled"] is False
    assert resp.settings["cashTipsEnabled"] is False


def test_sync_resolves_across_layers_and_derives_the_legacy_pair() -> None:
    tenant = {"tipsEnabled": True}
    company = {"payCashEnabled": False, "payCashTips": True, "payFastCardEnabled": "true"}
    shop = {"payFastCashTips": True, "payCardTips": False}
    resp = _sync(company, shop, tenant)

    assert {k: resp.settings[k] for k in PAYMENT_OPTION_SETTING_KEYS} == {
        "payFastCashEnabled": True,
        "payFastCashTips": True,
        "payCashEnabled": False,
        "payCashTips": False,
        "payFastCardEnabled": True,
        "payFastCardTips": True,
        "payCardEnabled": True,
        "payCardTips": False,
        "payManualCardEnabled": False,
        "payManualCardTips": False,
    }
    assert resp.settings["tipsEnabled"] is True
    assert resp.settings["cashTipsEnabled"] is True  # from fastCash, not the stored key


def test_sync_derived_legacy_pair_overrides_the_stored_one() -> None:
    # Stored says cash tips on, but both cash paths are hidden: an old till must
    # not be told to ask for a cash tip.
    stored = {
        "tipsEnabled": True,
        "cashTipsEnabled": True,
        "payFastCashEnabled": False,
        "payCashEnabled": False,
    }
    resp = _sync(stored, {})
    assert resp.settings["tipsEnabled"] is True
    assert resp.settings["cashTipsEnabled"] is False


def test_sync_never_writes_resolved_values_back_to_any_layer() -> None:
    tenant = {"tipsEnabled": True}
    company = {"payCashEnabled": False}
    shop = {"language": "en"}
    _sync(company, shop, tenant)
    assert tenant == {"tipsEnabled": True}
    assert company == {"payCashEnabled": False}
    assert shop == {"language": "en"}


# ── Dashboard: inherited preview resolved, the layer's own settings raw ──────

def _user(role: UserRole) -> User:
    u = MagicMock(spec=User)
    u.role = role
    return u


def _hierarchy(tenant_settings: dict, company_settings: dict, shop_settings: dict):
    tenant = MagicMock()
    tenant.id = uuid.uuid4()
    tenant.settings = tenant_settings
    tenant.settings_updated_at = _ts()

    company = MagicMock()
    company.id = uuid.uuid4()
    company.tenant_id = tenant.id
    company.settings = company_settings
    company.settings_updated_at = _ts()

    shop = MagicMock()
    shop.id = uuid.uuid4()
    shop.company_id = company.id
    shop.tenant_id = tenant.id
    shop.settings = shop_settings
    shop.settings_updated_at = _ts()

    db = MagicMock()

    def query_side(model):
        q = MagicMock()
        q.filter.return_value.first.return_value = {
            "Shop": shop,
            "Company": company,
            "Tenant": tenant,
        }[model.__name__]
        return q

    db.query.side_effect = query_side
    return tenant, company, shop, db


def test_shop_inherited_preview_is_resolved_and_shop_settings_stay_raw() -> None:
    tenant, company, shop, db = _hierarchy(
        {"tipsEnabled": True},
        {"payCashEnabled": False},
        {"receiptPrinterName": "BB"},
    )
    with patch("app.routers.settings._check_shop_access"):
        res = get_shop_settings(
            shop_id=str(shop.id),
            include_effective=True,
            current_user=_user(UserRole.SHOP_MANAGER),
            active_tenant_id=shop.tenant_id,
            db=db,
        )

    for key in PAYMENT_OPTION_SETTING_KEYS:
        assert isinstance(res.effective[key], bool)
    assert res.effective["payCashEnabled"] is False
    assert res.effective["payCardTips"] is True
    assert res.effective["payFastCashTips"] is False
    # The shop never set a payment key, so the dashboard must still see none —
    # that is how it tells "inherited" from "overridden".
    assert res.settings == {"receiptPrinterName": "BB"}
    assert shop.settings == {"receiptPrinterName": "BB"}
    assert company.settings == {"payCashEnabled": False}
    assert tenant.settings == {"tipsEnabled": True}


def test_shop_preview_shows_the_tips_choice_on_an_option_the_company_hid() -> None:
    # The company hides cash but keeps cash tips on. The shop's preview must say
    # "tips on" for cash, because re-allowing cash at the shop brings those tips
    # with it; showing the effective "off" would promise the shop the opposite.
    tenant, company, shop, db = _hierarchy(
        {},
        {"payCashEnabled": False, "payCashTips": True},
        {},
    )
    with patch("app.routers.settings._check_shop_access"):
        res = get_shop_settings(
            shop_id=str(shop.id),
            include_effective=True,
            current_user=_user(UserRole.SHOP_MANAGER),
            active_tenant_id=shop.tenant_id,
            db=db,
        )
    assert res.effective["payCashEnabled"] is False
    assert res.effective["payCashTips"] is True


def test_the_till_view_still_never_tips_on_a_hidden_option() -> None:
    merged = {"payCashEnabled": False, "payCashTips": True}
    assert resolve_payment_options(merged)["payCashTips"] is False
    assert resolve_payment_options(merged, effective=False)["payCashTips"] is True


# ── Refusing a write that leaves no payment option ───────────────────────────

def test_tenant_patch_hiding_all_four_is_refused() -> None:
    tenant, _, _, db = _hierarchy({}, {}, {})
    with patch("app.routers.settings._can_manage_tenant", return_value=True), patch(
        "app.routers.settings.notify_machines_for_tenant_settings"
    ):
        with pytest.raises(HTTPException) as exc:
            patch_tenant_settings(
                tenant_id=str(tenant.id),
                data=PosSettingsV1Patch.model_validate(ALL_OFF),
                current_user=_user(UserRole.DISTRIBUTOR),
                db=db,
            )
    assert exc.value.status_code == 422
    # The dashboard matches on the code, never on the wording.
    assert exc.value.detail["code"] == "no_payment_option_allowed"
    assert "payment option" in exc.value.detail["msg"]
    assert tenant.settings == {}
    db.commit.assert_not_called()


def test_company_patch_hiding_the_last_option_its_tenant_left_is_refused() -> None:
    three_off = {k: False for k in ("payFastCashEnabled", "payCashEnabled", "payFastCardEnabled")}
    _, company, _, db = _hierarchy(three_off, {}, {})
    with patch("app.routers.settings._check_company_access"), patch(
        "app.routers.settings._check_company_settings_write"
    ), patch("app.routers.settings.notify_machines_for_company_settings"):
        with pytest.raises(HTTPException) as exc:
            patch_company_settings(
                company_id=str(company.id),
                data=PosSettingsV1Patch.model_validate({"payCardEnabled": False}),
                current_user=_user(UserRole.COMPANY_MANAGER),
                active_tenant_id=company.tenant_id,
                db=db,
            )
    assert exc.value.status_code == 422
    assert exc.value.detail["code"] == "no_payment_option_allowed"
    assert company.settings == {}
    db.commit.assert_not_called()


def test_shop_patch_hiding_the_last_option_is_refused_but_leaving_one_is_not() -> None:
    _, _, shop, db = _hierarchy(
        {"payFastCashEnabled": False},
        {"payCashEnabled": False},
        {},
    )
    with patch("app.routers.settings._check_shop_settings_write"), patch(
        "app.routers.settings.notify_machines_for_shop_settings"
    ):
        with pytest.raises(HTTPException) as exc:
            patch_shop_settings(
                shop_id=str(shop.id),
                data=PosSettingsV1Patch.model_validate(
                    {"payFastCardEnabled": False, "payCardEnabled": False}
                ),
                current_user=_user(UserRole.SHOP_MANAGER),
                active_tenant_id=shop.tenant_id,
                db=db,
            )
        assert exc.value.status_code == 422
        assert exc.value.detail["code"] == "no_payment_option_allowed"
        assert shop.settings == {}

        res = patch_shop_settings(
            shop_id=str(shop.id),
            data=PosSettingsV1Patch.model_validate({"payFastCardEnabled": False}),
            current_user=_user(UserRole.SHOP_MANAGER),
            active_tenant_id=shop.tenant_id,
            db=db,
        )
    assert res.settings == {"payFastCardEnabled": False}


def test_shop_may_re_allow_what_its_parents_hid() -> None:
    _, _, shop, db = _hierarchy(ALL_OFF, {}, {})
    with patch("app.routers.settings._check_shop_settings_write"), patch(
        "app.routers.settings.notify_machines_for_shop_settings"
    ):
        res = patch_shop_settings(
            shop_id=str(shop.id),
            data=PosSettingsV1Patch.model_validate(
                {"payCashEnabled": True, "payFastCashEnabled": False}
            ),
            current_user=_user(UserRole.SHOP_MANAGER),
            active_tenant_id=shop.tenant_id,
            db=db,
        )
    assert res.settings == {"payCashEnabled": True, "payFastCashEnabled": False}


def test_a_shop_emptied_from_above_can_still_save_unrelated_settings() -> None:
    # Accepted gap: the tenant emptied this shop, and the check never looks down.
    # The dashboard re-sends the shop's own (unchanged) payment keys with every
    # save; those must not trip the check, or no other setting could be saved.
    _, _, shop, db = _hierarchy(
        {"payFastCashEnabled": False, "payCashEnabled": False, "payFastCardEnabled": False},
        {},
        {"payCardEnabled": False},
    )
    with patch("app.routers.settings._check_shop_settings_write"), patch(
        "app.routers.settings.notify_machines_for_shop_settings"
    ):
        res = patch_shop_settings(
            shop_id=str(shop.id),
            data=PosSettingsV1Patch.model_validate(
                {"payCardEnabled": False, "receiptPrinterName": "BB"}
            ),
            current_user=_user(UserRole.SHOP_MANAGER),
            active_tenant_id=shop.tenant_id,
            db=db,
        )
    assert res.settings == {"payCardEnabled": False, "receiptPrinterName": "BB"}


def test_a_parent_write_is_not_refused_for_emptying_a_child_shop() -> None:
    # Documented, accepted for now: only the layer being written is checked. The
    # shop hid three options itself; the company hiding the fourth empties it,
    # and the till shows a blocking message rather than the server refusing.
    three_off = {k: False for k in ("payFastCashEnabled", "payCashEnabled", "payFastCardEnabled")}
    _, company, shop, db = _hierarchy({}, {}, three_off)
    with patch("app.routers.settings._check_company_access"), patch(
        "app.routers.settings._check_company_settings_write"
    ), patch("app.routers.settings.notify_machines_for_company_settings"):
        res = patch_company_settings(
            company_id=str(company.id),
            data=PosSettingsV1Patch.model_validate({"payCardEnabled": False}),
            current_user=_user(UserRole.COMPANY_MANAGER),
            active_tenant_id=company.tenant_id,
            db=db,
        )
    assert res.settings == {"payCardEnabled": False}
    merged = merge_all_settings_layers(company, shop)
    assert not any(resolve_payment_options(merged)[o.allowed_key] for o in PAYMENT_OPTIONS)



# ── Reset to inherited ───────────────────────────────────────────────────────

def _patch_shop(shop, db, body: dict):
    with patch("app.routers.settings._check_shop_settings_write"), patch(
        "app.routers.settings.notify_machines_for_shop_settings"
    ):
        return patch_shop_settings(
            shop_id=str(shop.id),
            data=PosSettingsV1Patch.model_validate(body),
            current_user=_user(UserRole.SHOP_MANAGER),
            active_tenant_id=shop.tenant_id,
            db=db,
        )


def test_null_resets_a_payment_key_so_the_shop_inherits_again() -> None:
    _, company, shop, db = _hierarchy({}, {"payCashEnabled": True, "payCardTips": True}, {})

    _patch_shop(shop, db, {"payCashEnabled": False, "payCardTips": False})
    assert shop.settings == {"payCashEnabled": False, "payCardTips": False}
    merged = merge_all_settings_layers(company, shop)
    assert resolve_payment_options(merged)["payCashEnabled"] is False

    res = _patch_shop(shop, db, {"payCashEnabled": None})
    # Gone from the shop's own JSON, not stored as null and not stored as False.
    assert "payCashEnabled" not in shop.settings
    assert res.settings == {"payCardTips": False}
    merged = merge_all_settings_layers(company, shop)
    assert resolve_payment_options(merged)["payCashEnabled"] is True  # the company's again
    assert resolve_payment_options(merged)["payCardTips"] is False  # untouched override


def test_null_for_an_unset_payment_key_changes_nothing() -> None:
    _, _, shop, db = _hierarchy({}, {}, {"receiptPrinterName": "BB"})
    res = _patch_shop(shop, db, {"payFastCashTips": None})
    assert res.settings == {"receiptPrinterName": "BB"}


def test_null_still_does_not_unset_non_payment_keys() -> None:
    # Only branding and the payment option keys treat null as "inherit again".
    _, _, shop, db = _hierarchy({}, {}, {"receiptPrinterName": "BB", "tipsEnabled": True})
    res = _patch_shop(
        shop, db, {"receiptPrinterName": None, "tipsEnabled": None, "language": "en"}
    )
    assert res.settings == {"receiptPrinterName": "BB", "tipsEnabled": True, "language": "en"}


def test_a_reset_that_would_leave_nothing_allowed_is_refused() -> None:
    # The shop's own True is the only thing keeping cash on; resetting it would
    # inherit the parents' all-off.
    _, _, shop, db = _hierarchy(ALL_OFF, {}, {"payCashEnabled": True})
    with pytest.raises(HTTPException) as exc:
        _patch_shop(shop, db, {"payCashEnabled": None})
    assert exc.value.status_code == 422
    assert exc.value.detail["code"] == "no_payment_option_allowed"
    assert shop.settings == {"payCashEnabled": True}
