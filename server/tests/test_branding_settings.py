"""White-label branding settings: delivery to the till, role gating, and removal.

Style matches the rest of tests/: no database, no client. The merge helpers and
the guard functions are exercised directly, because that is where the decisions
about what reaches a POS terminal actually live.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.user import User, UserRole
from app.routers.images import _BRANDING_LIMITS, _BRANDING_ROLES
from app.routers.settings import (
    BRANDING_WRITE_ROLES,
    _build_patch,
    patch_shop_settings,
    patch_tenant_settings,
)
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services.settings_merge import (
    BRANDING_SETTING_KEYS,
    MANAGED_SETTING_KEYS,
    merge_all_settings_layers,
    merge_settings,
    patch_settings_json,
)

LOGO = "https://res.cloudinary.com/demo/image/upload/v1/pos/t/branding/logo/a.png"
HERO = "https://res.cloudinary.com/demo/image/upload/v1/pos/t/branding/hero/b.jpg"


def _user(role: UserRole, **kw) -> User:
    u = MagicMock(spec=User)
    u.role = role
    for k, v in kw.items():
        setattr(u, k, v)
    return u


def _ts() -> datetime:
    return datetime(2026, 8, 1, 12, 0, 0, tzinfo=timezone.utc)


# ── Delivery to the till ─────────────────────────────────────────────────────

def test_branding_keys_are_managed_and_therefore_synced() -> None:
    # MANAGED_SETTING_KEYS is the whitelist GET /sync/{machine_id}/settings
    # filters on. Off this tuple, the till never sees them.
    assert BRANDING_SETTING_KEYS == ("brandLogoUrl", "brandHeroUrl")
    for key in BRANDING_SETTING_KEYS:
        assert key in MANAGED_SETTING_KEYS


def test_shop_branding_overrides_company_which_overrides_tenant() -> None:
    tenant = MagicMock()
    tenant.settings = {"brandLogoUrl": LOGO, "brandHeroUrl": HERO}
    company = MagicMock()
    company.settings = {"brandLogoUrl": "https://res.cloudinary.com/demo/co.png"}
    shop = MagicMock()
    shop.settings = {"brandLogoUrl": "https://res.cloudinary.com/demo/shop.png"}

    merged = merge_settings(company, shop, tenant)
    assert merged["brandLogoUrl"] == "https://res.cloudinary.com/demo/shop.png"
    # The distributor's hero still flows down: nothing below overrode it.
    assert merged["brandHeroUrl"] == HERO


def test_tenant_branding_reaches_a_shop_with_no_overrides() -> None:
    tenant = MagicMock()
    tenant.settings = {"brandLogoUrl": LOGO, "brandHeroUrl": HERO}
    company = MagicMock()
    company.settings = {}
    shop = MagicMock()
    shop.settings = {}

    merged = merge_settings(company, shop, tenant)
    assert merged == {"brandLogoUrl": LOGO, "brandHeroUrl": HERO}


def test_empty_string_at_a_lower_layer_switches_the_brand_off() -> None:
    # "" is a real value that wins the merge — a merchant opting out of the
    # distributor's hero, as distinct from simply not having set one.
    tenant = MagicMock()
    tenant.settings = {"brandHeroUrl": HERO}
    company = MagicMock()
    company.settings = {"brandHeroUrl": ""}
    merged = merge_all_settings_layers(company, tenant=tenant)
    assert merged["brandHeroUrl"] == ""


# ── Removal ──────────────────────────────────────────────────────────────────

def test_explicit_null_unsets_the_layer_so_it_inherits_again() -> None:
    data = PosSettingsV1Patch.model_validate({"brandLogoUrl": None})
    patch = _build_patch(data, _user(UserRole.DISTRIBUTOR))
    assert patch == {"brandLogoUrl": None}
    assert patch_settings_json({"brandLogoUrl": LOGO, "language": "he"}, patch) == {"language": "he"}


def test_empty_string_is_stored_rather_than_removed() -> None:
    data = PosSettingsV1Patch.model_validate({"brandLogoUrl": ""})
    patch = _build_patch(data, _user(UserRole.DISTRIBUTOR))
    assert patch == {"brandLogoUrl": ""}
    assert patch_settings_json({"brandLogoUrl": LOGO}, patch) == {"brandLogoUrl": ""}


def test_untouched_branding_keys_are_left_alone() -> None:
    data = PosSettingsV1Patch.model_validate({"language": "en"})
    patch = _build_patch(data, _user(UserRole.CASHIER))
    assert patch == {"language": "en"}
    assert patch_settings_json({"brandLogoUrl": LOGO}, patch) == {
        "brandLogoUrl": LOGO,
        "language": "en",
    }


# ── URL validation ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("bad", ["http://cdn.example.com/logo.png", "/logo.png", "javascript:x"])
def test_branding_urls_must_be_absolute_https(bad: str) -> None:
    # Android blocks cleartext traffic by default; a relative URL has no meaning
    # on a till that is not talking to the dashboard's origin.
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({"brandLogoUrl": bad})


def test_overlong_branding_url_is_rejected() -> None:
    with pytest.raises(ValidationError):
        PosSettingsV1Patch.model_validate({"brandHeroUrl": "https://x.test/" + "a" * 600})


def test_valid_https_url_and_empty_string_are_accepted() -> None:
    assert PosSettingsV1Patch.model_validate({"brandLogoUrl": LOGO}).brand_logo_url == LOGO
    assert PosSettingsV1Patch.model_validate({"brandHeroUrl": ""}).brand_hero_url == ""


# ── Role gating ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "role,allowed",
    [
        (UserRole.SUPER_ADMIN, True),
        (UserRole.DISTRIBUTOR, True),
        # Denied, and the reason is a chain rather than a single check:
        # `_ensure_membership_for_user_home_tenant` auto-grants TENANT_ADMIN to every
        # company manager on a dashboard load, and `_can_manage_tenant` accepts
        # TENANT_ADMIN — so allowing the role here let one merchant replace the
        # distributor's brand on every terminal in the tenant, other merchants' tills
        # included. Branding is the distributor's asset; it is the one tenant setting
        # whose point is that the people below cannot change it.
        (UserRole.COMPANY_MANAGER, False),
        (UserRole.SHOP_MANAGER, False),
        (UserRole.CASHIER, False),
    ],
)
def test_branding_write_roles(role: UserRole, allowed: bool) -> None:
    data = PosSettingsV1Patch.model_validate({"brandLogoUrl": LOGO})
    if allowed:
        assert _build_patch(data, _user(role)) == {"brandLogoUrl": LOGO}
    else:
        with pytest.raises(HTTPException) as exc:
            _build_patch(data, _user(role))
        assert exc.value.status_code == 403


def test_shop_manager_may_write_shop_settings_but_not_repaint_the_brand() -> None:
    # _check_shop_settings_write only bars cashiers, so this is the interaction
    # worth pinning: the shop-level guard passes and branding is still refused.
    shop_id = uuid.uuid4()
    shop = MagicMock()
    shop.id = shop_id
    shop.company_id = uuid.uuid4()
    shop.tenant_id = uuid.uuid4()
    shop.settings = {}

    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = shop
    manager = _user(UserRole.SHOP_MANAGER, shop_id=shop_id, company_id=shop.company_id)

    with pytest.raises(HTTPException) as exc:
        patch_shop_settings(
            shop_id=str(shop_id),
            data=PosSettingsV1Patch.model_validate({"brandLogoUrl": LOGO}),
            current_user=manager,
            active_tenant_id=shop.tenant_id,
            db=db,
        )
    assert exc.value.status_code == 403
    assert shop.settings == {}

    # ... while a printer name at the same level still goes through.
    with patch("app.routers.settings.notify_machines_for_shop_settings"):
        patch_shop_settings(
            shop_id=str(shop_id),
            data=PosSettingsV1Patch.model_validate({"receiptPrinterName": "BB"}),
            current_user=manager,
            active_tenant_id=shop.tenant_id,
            db=db,
        )
    assert shop.settings == {"receiptPrinterName": "BB"}


def test_distributor_sets_then_removes_tenant_branding() -> None:
    tenant_id = uuid.uuid4()
    tenant = MagicMock()
    tenant.id = tenant_id
    tenant.settings = {}
    tenant.settings_updated_at = _ts()

    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = tenant
    distributor = _user(UserRole.DISTRIBUTOR)

    with patch("app.routers.settings._can_manage_tenant", return_value=True), patch(
        "app.routers.settings.notify_machines_for_tenant_settings"
    ):
        res = patch_tenant_settings(
            tenant_id=str(tenant_id),
            data=PosSettingsV1Patch.model_validate({"brandLogoUrl": LOGO, "brandHeroUrl": HERO}),
            current_user=distributor,
            db=db,
        )
        assert res.settings == {"brandLogoUrl": LOGO, "brandHeroUrl": HERO}

        res = patch_tenant_settings(
            tenant_id=str(tenant_id),
            data=PosSettingsV1Patch.model_validate({"brandHeroUrl": None}),
            current_user=distributor,
            db=db,
        )
    assert res.settings == {"brandLogoUrl": LOGO}


def test_branding_upload_roles_match_branding_write_roles() -> None:
    # An upload no caller could ever save is just a way to fill up Cloudinary.
    assert set(_BRANDING_ROLES) == BRANDING_WRITE_ROLES
    assert UserRole.CASHIER not in BRANDING_WRITE_ROLES
    assert UserRole.SHOP_MANAGER not in BRANDING_WRITE_ROLES


def test_branding_upload_limits_are_bounded_for_a_cellular_terminal() -> None:
    assert _BRANDING_LIMITS["logo"]["max_bytes"] == 2 * 1024 * 1024
    assert _BRANDING_LIMITS["hero"]["max_bytes"] == 5 * 1024 * 1024
    for kind in ("logo", "hero"):
        limits = _BRANDING_LIMITS[kind]
        assert limits["min_width"] < limits["max_width"]
        assert limits["deliver_width"] <= 1600
        assert limits["deliver_height"] <= 1600
