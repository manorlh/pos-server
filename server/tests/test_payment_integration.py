"""
"סוג אינטגרציית אשראי" (app/services/payment_integration.py) and the write-only
Z-Credit secrets (app/services/payment_secrets.py).

* Resolution down the layers: `auto` is transparent, `auto` + `nayaxEnabled` is Nayax,
  the till's own choice wins, and a till without a terminal of its own skips an
  inherited `agamento` for the external type above it (else Nayax, asking for its address).
* Per-type validation: the fields each type needs, reported as missing.
* The no-builtin rule: `agamento` on a P18's own layer is a 422.
* Secrets: never in a layer's JSON, encrypted at rest, a masked echo keeps them, `null`
  removes them, and only a till on Z-Credit gets the password in its sync.
"""
from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.payment_secret import PaymentIntegrationSecret
from app.models.user import UserRole
from app.routers import machines as machines_router
from app.routers import payment_integration as pi_router
from app.routers import settings as settings_router
from app.routers import sync as sync_router
from app.schemas.pos_settings import PosSettingsV1Patch
from app.schemas.shop import ShopCreate
from app.services import payment_integration as PI
from app.services import payment_secrets as PS
from app.services import settings_notify
from shift_world import accept_str_uuids, make_world

SECRET = "s3cr3t-pass"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.woken = []
    monkeypatch.setattr(
        settings_router, "notify_machine_settings", lambda _db, m, reason: world.woken.append((str(m.id), reason))
    )
    monkeypatch.setattr(settings_router, "notify_machines_for_shop_settings", lambda *a, **k: None)
    monkeypatch.setattr(settings_router, "notify_machines_for_company_settings", lambda *a, **k: None)
    monkeypatch.setattr(settings_notify, "notify_machine_settings", lambda *a, **k: None)
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    return world


def _patch_machine(w, till, **body):
    data = PosSettingsV1Patch(**body)
    with patch.object(settings_router, "_machine_for_read", return_value=till):
        return settings_router.patch_machine_settings(
            machine_id=str(till.id), data=data, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )


def _patch_shop(w, **body):
    data = PosSettingsV1Patch(**body)
    with patch.object(settings_router, "_check_shop_settings_write", lambda *a: None):
        return settings_router.patch_shop_settings(
            shop_id=str(w.shop.id), data=data, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )


def _pulled(w, till):
    return sync_router.get_settings_sync(machine_id=str(till.id), since=None, machine=till, db=w.db).settings


def _row(w, till):
    rows = {r["id"]: r for r in machines_router._enrich_machines_batch(list(w.tills), w.db)}
    return rows[till.id]


# ── Resolution (pure) ────────────────────────────────────────────────────────


def test_nothing_set_is_todays_behaviour():
    res = PI.resolve([("company", {}), ("shop", {})], has_builtin_terminal=True)
    assert (res.integration, res.automatic, res.source, res.explicit) == ("agamento", True, None, None)
    assert res.missing == []


def test_auto_with_nayax_enabled_is_nayax_for_compatibility():
    res = PI.resolve([("shop", {"nayaxEnabled": True, "paymentIntegration": "auto"})], True)
    assert (res.integration, res.automatic) == ("nayax_lan", True)
    assert res.missing == ["nayaxDeviceHost"]
    res = PI.resolve([("shop", {"nayaxEnabled": True, "nayaxDeviceHost": "10.0.0.5"})], True)
    assert res.missing == []


def test_the_most_specific_explicit_choice_wins_and_auto_is_transparent():
    layers = [
        ("company", {"paymentIntegration": "zcredit"}),
        ("shop", {"paymentIntegration": "auto"}),
        ("machine", {}),
    ]
    res = PI.resolve(layers, True)
    assert (res.integration, res.source, res.automatic) == ("zcredit", "company", False)
    layers[-1] = ("machine", {"paymentIntegration": "agamento"})
    res = PI.resolve(layers, True)
    assert (res.integration, res.source, res.explicit) == ("agamento", "machine", "agamento")


def test_a_till_without_a_terminal_skips_an_inherited_agamento():
    # A tablet in a shop of 55Fs: the shop's "built-in" is not the tablet's; the
    # company's external type is.
    layers = [("company", {"paymentIntegration": "zcredit"}), ("shop", {"paymentIntegration": "agamento"})]
    res = PI.resolve(layers, has_builtin_terminal=False)
    assert (res.integration, res.source) == ("zcredit", "company")
    # Nothing external above it: automatic Nayax, which asks for the pinpad's address.
    res = PI.resolve([("shop", {"paymentIntegration": "agamento"})], has_builtin_terminal=False)
    assert (res.integration, res.automatic, res.missing) == ("nayax_lan", True, ["nayaxDeviceHost"])


def test_tap_to_pay_is_reserved_and_never_resolves():
    res = PI.resolve([("shop", {"paymentIntegration": "tap_to_pay"})], True)
    assert res.integration == "agamento"


# ── Per-type validation ──────────────────────────────────────────────────────


def test_zcredit_needs_terminal_password_pinpad_and_mode():
    res = PI.resolve([("shop", {"paymentIntegration": "zcredit"})], True)
    assert res.missing == ["zcreditTerminalNumber", "zcreditPassword", "zcreditPinpadId", "zcreditMode"]
    full = {
        "paymentIntegration": "zcredit",
        "zcreditTerminalNumber": "0012345678",
        "zcreditPinpadId": "100000",
        "zcreditMode": "test",
    }
    res = PI.resolve([("company", full)], True, secrets_set=["zcreditPassword"])
    assert res.missing == []
    # The key is optional: WebCheckout's, not the pinpad's.
    assert "zcreditKey" not in PI.REQUIRED_FIELDS["zcredit"]


@pytest.mark.parametrize("raw, clean", [("0012345678", "0012345678"), (" 123 ", "123"), ("", None)])
def test_terminal_numbers_are_digits_with_leading_zeros_kept(raw, clean):
    assert PI.validate_terminal_number(raw) == clean


@pytest.mark.parametrize("raw", ["12a", "08-80", "1" * 21])
def test_a_terminal_number_that_is_not_digits_is_refused(raw):
    with pytest.raises(ValidationError):
        PosSettingsV1Patch(zcreditTerminalNumber=raw)


@pytest.mark.parametrize("raw, clean", [("PINPAD100000", "100000"), ("pinpad42", "42"), ("100000", "100000")])
def test_a_pinpad_id_is_stored_without_its_prefix(raw, clean):
    assert PosSettingsV1Patch(zcreditPinpadId=raw).zcredit_pinpad_id == clean


@pytest.mark.parametrize("body", [{"zcreditPinpadId": "PINPAD 1"}, {"zcreditMode": "sandbox"},
                                  {"paymentIntegration": "tap_to_pay"}, {"paymentIntegration": "visa"}])
def test_bad_values_are_refused(body):
    with pytest.raises(ValidationError):
        PosSettingsV1Patch(**body)


def test_a_bad_secret_is_a_422_that_never_echoes_it(w):
    with pytest.raises(HTTPException) as exc:
        _patch_machine(w, w.tills[0], zcreditPassword="abc\ndef")
    assert exc.value.status_code == 422
    assert exc.value.detail["code"] == "secret_invalid"
    assert "abc" not in str(exc.value.detail)
    assert _secret_rows(w) == []


def test_secrets_are_redacted_from_the_request_log():
    from app.observability.body_logging import redact_json

    logged = redact_json({"zcreditPassword": SECRET, "zcreditKey": "k", "zcreditTerminalNumber": "1"})
    assert SECRET not in str(logged) and logged["zcreditTerminalNumber"] == "1"


# ── The no-builtin rule (machine level) ──────────────────────────────────────


def test_agamento_on_a_p18_is_a_422_and_writes_nothing(w):
    p18 = w.tills[0]
    p18.device_model = "P18"
    w.db.commit()
    with pytest.raises(HTTPException) as exc:
        _patch_machine(w, p18, paymentIntegration="agamento")
    assert exc.value.status_code == 422
    assert exc.value.detail["code"] == "agamento_needs_builtin_terminal"
    assert not p18.settings


def test_a_p18_may_take_an_external_type_and_a_55f_agamento(w):
    p18, n55f = w.tills
    p18.device_model = "P18"
    w.db.commit()
    _patch_machine(w, p18, paymentIntegration="zcredit")
    assert p18.settings["paymentIntegration"] == "zcredit"
    _patch_machine(w, n55f, paymentIntegration="agamento")
    assert n55f.settings["paymentIntegration"] == "agamento"


def test_auto_removes_the_layers_own_choice(w):
    till = w.tills[0]
    _patch_machine(w, till, paymentIntegration="nayax_lan", nayaxDeviceHost="10.0.0.9")
    assert till.settings["paymentIntegration"] == "nayax_lan"
    _patch_machine(w, till, paymentIntegration="auto", nayaxDeviceHost=None)
    assert "paymentIntegration" not in till.settings
    assert "nayaxDeviceHost" not in till.settings


# ── Secrets: write-only, encrypted, layered ──────────────────────────────────


def _secret_rows(w):
    return w.db.query(PaymentIntegrationSecret).all()


def test_a_password_never_lands_in_the_settings_json(w):
    till = w.tills[0]
    res = _patch_machine(w, till, paymentIntegration="zcredit", zcreditPassword=SECRET, zcreditTerminalNumber="0012345678")
    assert "zcreditPassword" not in till.settings
    assert "zcreditPassword" not in res.settings
    assert SECRET not in str(till.settings)
    rows = _secret_rows(w)
    assert [(r.level, r.key) for r in rows] == [("machine", "zcreditPassword")]
    assert SECRET not in rows[0].ciphertext
    assert PS.decrypt(rows[0].ciphertext) == SECRET
    # Reading the layer back never shows it.
    with patch.object(settings_router, "_machine_for_read", return_value=till):
        got = settings_router.get_machine_settings(
            machine_id=str(till.id), include_effective=True, current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )
    assert SECRET not in str(got.model_dump())


def test_only_a_secret_moves_the_layer_and_wakes_the_till(w):
    till = w.tills[0]
    _patch_machine(w, till, zcreditPassword=SECRET)
    assert till.settings_updated_at is not None
    assert w.woken == [(str(till.id), "machine_settings_updated")]


def test_the_mask_keeps_and_null_removes(w):
    till = w.tills[0]
    _patch_machine(w, till, zcreditPassword=SECRET)
    _patch_machine(w, till, zcreditPassword="••••")
    assert PS.decrypt(_secret_rows(w)[0].ciphertext) == SECRET
    _patch_machine(w, till, zcreditPassword=None)
    assert _secret_rows(w) == []


def test_a_shops_password_reaches_its_tills_and_a_tills_own_wins(w):
    till, other = w.tills
    _patch_shop(w, paymentIntegration="zcredit", zcreditPassword="shop-pass", zcreditTerminalNumber="0012345678",
                zcreditPinpadId="PINPAD100000", zcreditMode="test")
    assert w.shop.settings["zcreditPinpadId"] == "100000"
    pulled = _pulled(w, till)
    assert pulled["paymentIntegration"] == "zcredit"
    assert pulled["zcreditPassword"] == "shop-pass"
    assert (pulled["zcreditTerminalNumber"], pulled["zcreditPinpadId"], pulled["zcreditMode"]) == (
        "0012345678", "100000", "test",
    )
    # The WebCheckout key never goes to a till.
    _patch_shop(w, zcreditKey="k" * 64)
    assert "zcreditKey" not in _pulled(w, till)
    _patch_machine(w, other, zcreditPassword="till-pass")
    assert _pulled(w, other)["zcreditPassword"] == "till-pass"
    assert _pulled(w, till)["zcreditPassword"] == "shop-pass"


def test_a_till_not_on_zcredit_never_gets_the_password(w):
    till = w.tills[0]
    _patch_shop(w, zcreditPassword="shop-pass")
    pulled = _pulled(w, till)
    assert "zcreditPassword" not in pulled
    # Automatic: no explicit type goes out, the till decides by its hardware as before.
    assert "paymentIntegration" not in pulled
    _patch_machine(w, till, paymentIntegration="agamento")
    pulled = _pulled(w, till)
    assert pulled["paymentIntegration"] == "agamento"
    assert "zcreditPassword" not in pulled


def test_a_p18_under_an_agamento_shop_is_sent_the_external_type_above(w):
    p18 = w.tills[0]
    p18.device_model = "P18"
    w.company.settings = {"paymentIntegration": "zcredit"}
    w.shop.settings = {"paymentIntegration": "agamento"}
    w.db.commit()
    assert _pulled(w, p18)["paymentIntegration"] == "zcredit"
    assert _pulled(w, w.tills[1])["paymentIntegration"] == "agamento"


# ── The machines list and the dashboard's context ────────────────────────────


def test_the_machines_list_names_the_integration_and_what_is_missing(w):
    till = w.tills[0]
    row = _row(w, till)
    assert (row["paymentIntegration"], row["paymentIntegrationAutomatic"], row["paymentIntegrationMissing"]) == (
        "agamento", True, [],
    )
    _patch_shop(w, paymentIntegration="zcredit", zcreditTerminalNumber="0012345678")
    row = _row(w, till)
    assert (row["paymentIntegration"], row["paymentIntegrationSource"]) == ("zcredit", "shop")
    assert row["paymentIntegrationMissing"] == ["zcreditPassword", "zcreditPinpadId", "zcreditMode"]
    _patch_machine(w, till, zcreditPassword=SECRET, zcreditPinpadId="100000", zcreditMode="production")
    assert _row(w, till)["paymentIntegrationMissing"] == []


def test_the_context_says_what_a_p18_may_choose_and_where_secrets_are(w):
    p18 = w.tills[0]
    p18.device_model = "P18"
    w.db.commit()
    _patch_shop(w, paymentIntegration="zcredit", zcreditPassword="shop-pass")
    with patch("app.routers.machines._machine_for_read", return_value=p18):
        ctx = pi_router.get_payment_integration_context(
            level="machine", target_id=str(p18.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
        )
    options = {o["value"]: o for o in ctx["options"]}
    assert ctx["hasBuiltinTerminal"] is False and ctx["hasNfc"] is True
    assert options["agamento"]["selectable"] is False
    assert options["agamento"]["reason"] == "needs_builtin_terminal"
    assert options["zcredit"]["selectable"] and options["nayax_lan"]["selectable"]
    assert (options["tap_to_pay"]["selectable"], options["tap_to_pay"]["reason"]) == (False, "soon")
    assert ctx["inherited"] == {"integration": "zcredit", "source": "shop"}
    assert ctx["secrets"]["zcreditPassword"] == {"set": True, "source": "shop", "own": False, "updatedAt": None}
    assert ctx["resolved"]["integration"] == "zcredit"
    assert "zcreditPassword" not in ctx["resolved"]["missing"]
    assert "shop-pass" not in str(ctx)


def test_a_new_shop_can_open_with_an_integration_type():
    data = ShopCreate(name="S", companyId=uuid.uuid4(), paymentIntegration="zcredit")
    assert data.payment_integration == "zcredit"
    assert ShopCreate(name="S", companyId=uuid.uuid4()).payment_integration is None
    with pytest.raises(ValidationError):
        ShopCreate(name="S", companyId=uuid.uuid4(), paymentIntegration="tap_to_pay")
