"""
"תמיכה מרחוק" — QuickSupport installed by the till (app/services/remote_support.py,
app/routers/remote_support.py; P:/specs/quicksupport-autoinstall.md §2, §2א).

* Four built-in till parameters, set by a super admin like every till parameter: the download URL
  (https:// only; the official TeamViewer download by default), the signer's SHA-256 fingerprints
  (canonical lower-case hex, empty by default), the allowed package names, and the automatic install
  after pairing (on by default). Every write is checked; the tills get them like any parameter.
* The heartbeat's `remoteSupport` report: cleaned key by key into `device_info`, never a 422.
* The first pin (TOFU): an install from the official host with an allowed package, while no pin is
  set, pins the reported fingerprint globally — with the till and the time — for a super admin to
  confirm or replace ("השתמש כטביעת האצבע המותרת" from the device page).
* A later report that does not match the pin: "חתימת QuickSupport לא תואמת בקופה X" (medium), once,
  closed by itself when the till's report matches again.

Fingerprints and URLs here are obvious fakes; the one real value is the official download, which is
the parameter's default.
"""
from __future__ import annotations

import inspect
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.audit_exception import AuditException
from app.models.platform_setting import PlatformSetting
from app.models.till_parameter import TillParameter, TillParameterChange
from app.models.user import User, UserRole
from app.routers import machines as machines_router
from app.routers import remote_support as RR
from app.routers import till_parameters as R
from app.routers.sync import get_till_parameters_sync
from app.schemas.pos_machine import MachineHeartbeatBody
from app.schemas.till_parameter import TillParameterUpdate, TillParameterValueIn
from app.services import exceptions as EX
from app.services import problems as P
from app.services import remote_support as RS
from app.services import till_parameters as TP
from app.services.exception_alerts import catalog as CAT
from app.services.exception_alerts import push as PUSH
from shift_world import accept_str_uuids, make_world

FP_A = "a1" * 32
FP_B = "b2" * 32
FP_C = "c3" * 32
FAKE_URL = "https://files.example.test/support/qs.apk"
OFFICIAL = RS.OFFICIAL_APK_URL
PKG = RS.DEFAULT_PACKAGE
T0 = datetime(2026, 10, 14, 9, 0, tzinfo=timezone.utc)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    monkeypatch.setattr(TP, "publish_settings_notify", lambda *a, **k: None)
    published = []
    monkeypatch.setattr(RS, "_start_publish", lambda targets: published.append(list(targets)))
    world = make_world()
    world.published = published
    TP.ensure_builtin_parameters(world.db)
    world.db.commit()
    return world


def _admin(email="boss@r2m.test"):
    return MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=None, email=email, username="boss")


def _definition(w, key) -> TillParameter:
    return w.db.query(TillParameter).filter(TillParameter.key == key).one()


def _set(w, key, scope_type, scope_id, value):
    tasks = BackgroundTasks()
    out = R.set_till_parameter_value(
        parameter_id=_definition(w, key).id,
        body=TillParameterValueIn(scopeType=scope_type, scopeId=scope_id, value=value),
        background_tasks=tasks,
        _admin=_admin(),
        db=w.db,
    )
    return out.value


def _set_default(w, key, value):
    return R.update_till_parameter(
        parameter_id=_definition(w, key).id,
        body=TillParameterUpdate(defaultValue=value),
        background_tasks=BackgroundTasks(),
        _admin=_admin(),
        db=w.db,
    )


def _pulled(w, till):
    resp = get_till_parameters_sync(machine_id=str(till.id), machine=till, db=w.db)
    return resp.model_dump(mode="json", by_alias=True)["parameters"]


def _beat(w, till, block):
    body = MachineHeartbeatBody.model_validate({"remoteSupport": block})
    return machines_router.post_my_heartbeat(body=body, machine=till, db=w.db, request=None)


def _report(signers=(FP_A,), *, installed=True, package=PKG, source=OFFICIAL):
    block = {"installed": installed, "package": package, "signerSha256": list(signers)}
    if source is not None:
        block["installedFrom"] = source
    return block


def _mismatches(w, till=None):
    w.db.expire_all()
    q = w.db.query(AuditException).filter(AuditException.exception_type == RS.EXCEPTION_TYPE)
    if till is not None:
        q = q.filter(AuditException.machine_id == till.id)
    return q.order_by(AuditException.occurred_at).all()


# ── The parameters ───────────────────────────────────────────────────────────


def test_four_builtins_with_their_defaults():
    specs = {p.key: p for p in TP.BUILTIN_PARAMETERS if p.key in RS.KEYS}
    assert set(specs) == set(RS.KEYS)
    assert (specs[RS.APK_URL_KEY].value_type, specs[RS.APK_URL_KEY].default_value) == (
        "string", "https://download.teamviewer.com/download/TeamViewerQS.apk")
    assert (specs[RS.SIGNER_KEY].value_type, specs[RS.SIGNER_KEY].default_value) == ("string", "")
    assert (specs[RS.PACKAGES_KEY].value_type, specs[RS.PACKAGES_KEY].default_value) == (
        "string", "com.teamviewer.quicksupport.market")
    assert (specs[RS.AUTO_INSTALL_KEY].value_type, specs[RS.AUTO_INSTALL_KEY].default_value) == ("boolean", True)
    assert specs[RS.AUTO_INSTALL_KEY].label == "התקנה אוטומטית של תמיכה מרחוק (QuickSupport) אחרי חיבור הקופה"
    # The hints say what each one is: the official download, the pin and its first install, "חסר".
    assert "הרשמית" in specs[RS.APK_URL_KEY].description and "https://" in specs[RS.APK_URL_KEY].description
    assert "חסר" in specs[RS.APK_URL_KEY].description
    assert "התקנה הראשונה" in specs[RS.SIGNER_KEY].description and "מנהל-על" in specs[RS.SIGNER_KEY].description
    for spec in specs.values():
        assert "תמיכה מרחוק" in spec.label
        assert not spec.admin_only  # the parameters router takes a super admin and nobody else anyway


def test_every_till_gets_them_with_the_defaults(w):
    got = _pulled(w, w.tills[0])
    assert got[RS.APK_URL_KEY] == OFFICIAL
    assert got[RS.SIGNER_KEY] == ""
    assert got[RS.PACKAGES_KEY] == PKG
    assert got[RS.AUTO_INSTALL_KEY] is True


def test_a_company_overrides_the_global_default(w):
    _set(w, RS.APK_URL_KEY, "company", w.company.id, FAKE_URL)
    _set(w, RS.SIGNER_KEY, "company", w.company.id, FP_A.upper())
    _set(w, RS.AUTO_INSTALL_KEY, "shop", w.shop.id, False)
    got = _pulled(w, w.tills[0])
    assert (got[RS.APK_URL_KEY], got[RS.SIGNER_KEY], got[RS.AUTO_INSTALL_KEY]) == (FAKE_URL, FP_A, False)
    assert _pulled(w, w.other_till)[RS.AUTO_INSTALL_KEY] is True  # another shop of the company


def test_only_a_super_admin_sets_them():
    for fn in (R.set_till_parameter_value, R.update_till_parameter, R.create_till_parameter,
               RR.get_signer_pin, RR.confirm_signer_pin, RR.replace_signer_pin):
        default = inspect.signature(fn).parameters["_admin"].default
        assert getattr(default, "dependency", None) is R.get_current_super_admin, fn.__name__


# ── Validation ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("value, stored", [
    (FAKE_URL, FAKE_URL),
    (f"  {OFFICIAL}  ", OFFICIAL),
    ("HTTPS://files.example.test/qs.apk", "HTTPS://files.example.test/qs.apk"),
    ("https://files.example.test:8443/qs.apk?v=1", "https://files.example.test:8443/qs.apk?v=1"),
    ("", ""),
])
def test_the_url_is_https_or_empty(w, value, stored):
    assert _set(w, RS.APK_URL_KEY, "company", w.company.id, value) == stored


@pytest.mark.parametrize("bad", [
    "http://files.example.test/qs.apk",
    "ftp://files.example.test/qs.apk",
    "files.example.test/qs.apk",
    "https://",
    "https:///qs.apk",
    "https://user:secret@files.example.test/qs.apk",
    "https://files.example.test/q s.apk",
    "https://files.example.test:port/qs.apk",
])
def test_anything_else_is_a_422_in_hebrew(w, bad):
    with pytest.raises(HTTPException) as caught:
        _set(w, RS.APK_URL_KEY, "company", w.company.id, bad)
    assert caught.value.status_code == 422
    assert "כתובת הורדה" in caught.value.detail


@pytest.mark.parametrize("value, stored", [
    (FP_A, FP_A),
    (":".join(FP_A.upper()[i:i + 2] for i in range(0, 64, 2)), FP_A),  # keytool's form
    (f" {FP_A.upper()} , {FP_B} ,", f"{FP_A},{FP_B}"),
    (f"{FP_A},{FP_A.upper()}", FP_A),
    (f"{FP_A}\n{FP_B}", f"{FP_A},{FP_B}"),
    ("", ""),
])
def test_fingerprints_are_stored_canonical(w, value, stored):
    assert _set(w, RS.SIGNER_KEY, "company", w.company.id, value) == stored


@pytest.mark.parametrize("bad", [
    "a1" * 31,             # 62 digits
    "a1" * 33,             # 66
    "g1" * 32,             # not hex
    f"{FP_A} {FP_B}",      # two without a comma: one 128-digit "fingerprint"
    ",".join(f"{i:064x}" for i in range(11)),  # more than ten
])
def test_a_bad_fingerprint_is_a_422(w, bad):
    with pytest.raises(HTTPException) as caught:
        _set(w, RS.SIGNER_KEY, "company", w.company.id, bad)
    assert caught.value.status_code == 422
    assert "טביעת אצבע" in caught.value.detail


def test_package_names(w):
    assert _set(w, RS.PACKAGES_KEY, "company", w.company.id, f" {PKG} , com.example.qs_alt ,{PKG}") == (
        f"{PKG},com.example.qs_alt")
    for bad in ("", " , ", "quicksupport", "1com.example.qs", "com.example-qs.app", "com..example", "com.example.",
                ",".join(f"com.example.p{i}" for i in range(11))):
        with pytest.raises(HTTPException) as caught:
            _set(w, RS.PACKAGES_KEY, "company", w.company.id, bad)
        assert caught.value.status_code == 422, bad
        assert "חבילה" in caught.value.detail


def test_the_global_default_is_checked_too(w):
    with pytest.raises(HTTPException) as caught:
        _set_default(w, RS.APK_URL_KEY, "http://files.example.test/qs.apk")
    assert caught.value.status_code == 422
    with pytest.raises(HTTPException):
        _set_default(w, RS.SIGNER_KEY, "not-a-fingerprint")
    out = _set_default(w, RS.SIGNER_KEY, FP_B.upper())
    assert out.default_value == FP_B
    # Set by hand: the pin's record says so.
    assert RS.pin_out(w.db)["source"] == RS.SOURCE_MANUAL
    # An unchanged default of another parameter is not re-checked (a label edit still saves).
    R.update_till_parameter(
        parameter_id=_definition(w, RS.PACKAGES_KEY).id, body=TillParameterUpdate(label="חבילות"),
        background_tasks=BackgroundTasks(), _admin=_admin(), db=w.db,
    )


def test_clean_value_directly():
    assert RS.clean_value(RS.SIGNER_KEY, None) is None
    assert RS.clean_value(RS.AUTO_INSTALL_KEY, False) is False
    with pytest.raises(RS.RemoteSupportValueError):
        RS.clean_value(RS.APK_URL_KEY, 5)
    assert RS.is_official(OFFICIAL)
    assert not RS.is_official("http://download.teamviewer.com/download/TeamViewerQS.apk")
    assert not RS.is_official("https://download.teamviewer.com.evil.test/qs.apk")
    assert not RS.is_official("https://download.teamviewer.com:8443/qs.apk")
    assert not RS.is_official(FAKE_URL)


# ── The report ───────────────────────────────────────────────────────────────


def test_the_report_is_cleaned_key_by_key():
    assert RS.clean_report("nope") is None
    assert RS.clean_report([]) is None
    assert RS.clean_report({}) is None
    assert RS.clean_report({"extra": 1}) is None
    out = RS.clean_report({
        "installed": "yes",                       # not a boolean: dropped
        "package": "not a package",               # dropped
        "signerSha256": [FP_A.upper(), "zz", 5],  # the good one kept, canonical
        "installedFrom": f"{OFFICIAL}?token=s3cr3t#x",
        "extra": True,
    })
    assert out == {"signerSha256": [FP_A], "installedFrom": OFFICIAL}
    assert RS.clean_report({"installed": False}) == {"installed": False}
    assert RS.clean_report({"installed": True, "signerSha256": ["zz"]}) == {"installed": True}
    assert RS.clean_report({"installedFrom": "http://download.teamviewer.com/x"}) is None
    assert RS.clean_report({"signerSha256": f"{FP_A},{FP_B}"}) == {"signerSha256": [FP_A, FP_B]}


def test_an_unreadable_block_never_fails_the_beat(w):
    till = w.tills[0]
    body = MachineHeartbeatBody.model_validate({"remoteSupport": ["not", "an", "object"]})
    assert body.remote_support is None
    assert machines_router.post_my_heartbeat(body=body, machine=till, db=w.db, request=None)["ok"] is True
    assert _beat(w, till, {"installed": "maybe"})["ok"] is True
    assert RS.REPORT_KEY not in (till.device_info or {})


def test_a_check_that_fails_keeps_the_report_and_the_beat(w, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("db hiccup")

    monkeypatch.setattr(RS, "check_pin", boom)
    till = w.tills[0]
    assert _beat(w, till, _report(source=FAKE_URL))["ok"] is True
    report = till.device_info[RS.REPORT_KEY]
    assert report["installed"] is True and report["signerSha256"] == [FP_A]
    assert "pinStatus" not in report


def test_the_report_is_kept_on_the_machine_and_the_page(w):
    till = w.tills[0]
    till.device_info = {"platform": "android", "serial": "X1"}
    w.db.commit()
    _beat(w, till, {"installed": False})
    w.db.refresh(till)
    assert till.device_info["platform"] == "android"  # the rest of device_info stays
    assert till.device_info[RS.REPORT_KEY]["installed"] is False
    _beat(w, till, _report(source=FAKE_URL))
    w.db.refresh(till)
    report = till.device_info[RS.REPORT_KEY]
    assert (report["installed"], report["package"], report["signerSha256"]) == (True, PKG, [FP_A])
    assert report["installedFrom"] == FAKE_URL
    assert report["pinStatus"] == RS.STATUS_NO_PIN  # not from the official host: nothing pinned
    # The device page reads it from the machine's `deviceInfo`.
    out = machines_router.get_machine(str(till.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert out["deviceInfo"][RS.REPORT_KEY]["signerSha256"] == [FP_A]


# ── The first pin ────────────────────────────────────────────────────────────


def test_the_first_install_from_the_official_host_pins_the_signer(w):
    till = w.tills[0]
    _beat(w, till, _report((FP_A,)))
    w.db.expire_all()
    assert _definition(w, RS.SIGNER_KEY).default_value == FP_A
    assert till.device_info[RS.REPORT_KEY]["pinStatus"] == RS.STATUS_PINNED_NOW
    pin = RS.pin_out(w.db)
    assert pin["value"] == [FP_A] and pin["source"] == RS.SOURCE_AUTO
    assert pin["auto"]["machineId"] == str(till.id)
    assert pin["auto"]["tillLabel"] == "קופה 1"
    assert pin["auto"]["shopName"] == "Center"
    assert pin["auto"]["installedFrom"] == OFFICIAL and pin["auto"]["at"]
    # The change log names the till, not a user.
    change = w.db.query(TillParameterChange).filter(TillParameterChange.parameter_key == RS.SIGNER_KEY).one()
    assert (change.action, change.old_value, change.new_value) == ("default", "", FP_A)
    assert str(till.id) in change.user_email and change.user_role == "machine"
    # Every till gets it — they were told after the commit.
    assert len(w.published) == 1 and len(w.published[0]) == 3
    assert _pulled(w, w.tills[1])[RS.SIGNER_KEY] == FP_A


@pytest.mark.parametrize("change", [
    {"installedFrom": FAKE_URL},                                   # our own host: never trusted blind
    {"installedFrom": "https://download.teamviewer.com.evil.test/x.apk"},
    {"installedFrom": None},                                       # not installed by the till
    {"package": "com.example.lookalike"},                          # not an allowed package
    {"installed": False},
    {"signerSha256": []},
])
def test_no_first_pin_otherwise(w, change):
    block = {**_report((FP_A,)), **change}
    block = {k: v for k, v in block.items() if v is not None}
    _beat(w, w.tills[0], block)
    w.db.expire_all()
    assert _definition(w, RS.SIGNER_KEY).default_value == ""
    assert RS.pin_out(w.db)["source"] is None
    assert w.published == []


def test_no_first_pin_over_a_pin_set_for_the_till(w):
    _set(w, RS.SIGNER_KEY, "company", w.company.id, FP_B)
    _beat(w, w.tills[0], _report((FP_A,)))
    w.db.expire_all()
    assert _definition(w, RS.SIGNER_KEY).default_value == ""  # the global stays empty
    assert len(_mismatches(w, w.tills[0])) == 1               # and the till's own pin was not met


def test_no_first_pin_on_an_inactive_parameter(w):
    _definition(w, RS.SIGNER_KEY).is_active = False
    w.db.commit()
    _beat(w, w.tills[0], _report((FP_A,)))
    w.db.expire_all()
    assert _definition(w, RS.SIGNER_KEY).default_value == ""


def test_the_first_pin_is_set_once(w):
    _beat(w, w.tills[0], _report((FP_A,)))
    _beat(w, w.tills[1], _report((FP_B,)))
    w.db.expire_all()
    assert _definition(w, RS.SIGNER_KEY).default_value == FP_A
    assert RS.pin_out(w.db)["auto"]["machineId"] == str(w.tills[0].id)
    assert w.tills[1].device_info[RS.REPORT_KEY]["pinStatus"] == RS.STATUS_MISMATCH


# ── The mismatch ─────────────────────────────────────────────────────────────


def test_a_report_that_does_not_match_raises_one_medium_alert_until_it_matches(w):
    _set_default(w, RS.SIGNER_KEY, FP_A)
    till = w.tills[1]
    report = _report((FP_B,), source=None)
    RS.apply_heartbeat(w.db, till, report, now=T0)
    w.db.commit()
    (row,) = _mismatches(w, till)
    assert (row.severity, row.status) == ("medium", "new")
    assert row.details["summary"] == "חתימת QuickSupport לא תואמת בקופה 2"
    assert row.details["reported"] == [FP_B] and row.details["pinned"] == [FP_A]
    assert (row.shop_id, row.company_id, row.tenant_id) == (w.shop.id, w.company.id, w.tenant.id)
    assert till.device_info[RS.REPORT_KEY]["pinStatus"] == RS.STATUS_MISMATCH

    # The same report again — soon, or past the recheck — is the same alert.
    RS.apply_heartbeat(w.db, till, report, now=T0 + timedelta(minutes=1))
    RS.apply_heartbeat(w.db, till, report, now=T0 + RS.RECHECK_AFTER + timedelta(minutes=1))
    w.db.commit()
    assert len(_mismatches(w, till)) == 1

    # The till now reports the pinned signer: the alert is over by itself.
    RS.apply_heartbeat(w.db, till, _report((FP_A,), source=None), now=T0 + timedelta(minutes=30))
    w.db.commit()
    (row,) = _mismatches(w, till)
    assert row.details["resolvedAt"] and row.status == "reviewed"
    assert till.device_info[RS.REPORT_KEY]["pinStatus"] == RS.STATUS_MATCH


def test_a_pin_changed_to_match_closes_the_alert_at_the_next_check(w):
    _set_default(w, RS.SIGNER_KEY, FP_A)
    till = w.tills[0]
    RS.apply_heartbeat(w.db, till, _report((FP_B,)), now=T0)
    w.db.commit()
    _set_default(w, RS.SIGNER_KEY, f"{FP_A},{FP_B}")
    RS.apply_heartbeat(w.db, till, _report((FP_B,)), now=T0 + timedelta(minutes=1))  # not rechecked yet
    assert _mismatches(w, till)[0].details["resolvedAt"] is None
    RS.apply_heartbeat(w.db, till, _report((FP_B,)), now=T0 + RS.RECHECK_AFTER + timedelta(minutes=2))
    w.db.commit()
    assert _mismatches(w, till)[0].details["resolvedAt"]


def test_another_wrong_signer_is_a_new_alert_and_closes_the_old(w):
    _set_default(w, RS.SIGNER_KEY, FP_A)
    till = w.tills[0]
    RS.apply_heartbeat(w.db, till, _report((FP_B,)), now=T0)
    RS.apply_heartbeat(w.db, till, _report((FP_C,)), now=T0 + timedelta(minutes=1))
    w.db.commit()
    first, second = _mismatches(w, till)
    assert first.details["resolvedAt"] and second.details["resolvedAt"] is None
    assert second.details["reported"] == [FP_C]


def test_quicksupport_removed_closes_the_alert(w):
    _set_default(w, RS.SIGNER_KEY, FP_A)
    till = w.tills[0]
    RS.apply_heartbeat(w.db, till, _report((FP_B,)), now=T0)
    RS.apply_heartbeat(w.db, till, {"installed": False}, now=T0 + timedelta(minutes=1))
    w.db.commit()
    assert _mismatches(w, till)[0].details["resolvedAt"]


def test_the_alert_is_a_known_kind_in_the_devices_problems():
    assert CAT.kind_spec(RS.EXCEPTION_TYPE).label == "חתימת QuickSupport לא תואמת"
    assert CAT.kind_spec(RS.EXCEPTION_TYPE).severity == "medium"
    assert P.KIND_GROUP[RS.EXCEPTION_TYPE] == "devices"
    rule = EX.RULES_BY_TYPE[RS.EXCEPTION_TYPE]
    assert rule.push_only and not rule.push_default  # always recorded; the phone only where a level asks
    assert RS.EXCEPTION_TYPE in CAT.OPT_IN_KINDS
    assert PUSH.category_of(SimpleNamespace(kind=RS.EXCEPTION_TYPE, details={})) == "sensitive_actions"


def test_the_alert_reaches_the_exceptions_log(w):
    from app.models.exception_alerts import ExceptionLogEntry

    _set_default(w, RS.SIGNER_KEY, FP_A)
    _beat(w, w.tills[0], _report((FP_B,)))
    w.db.expire_all()
    entries = w.db.query(ExceptionLogEntry).filter(ExceptionLogEntry.kind == RS.EXCEPTION_TYPE).all()
    assert len(entries) == 1
    assert entries[0].summary == "חתימת QuickSupport לא תואמת בקופה 1"
    assert entries[0].machine_id == w.tills[0].id


# ── The super admin's actions ────────────────────────────────────────────────


def test_confirm_the_automatic_pin(w):
    _beat(w, w.tills[0], _report((FP_A,)))
    with pytest.raises(HTTPException) as caught:
        RR.confirm_signer_pin(body=RR.ConfirmIn(value=FP_B), _admin=_admin(), db=w.db)
    assert (caught.value.status_code, caught.value.detail) == (409, "remote_support_pin_changed")
    out = RR.confirm_signer_pin(body=RR.ConfirmIn(value=FP_A.upper()), _admin=_admin("chief@r2m.test"), db=w.db)
    assert out["source"] == RS.SOURCE_CONFIRMED
    assert out["confirmedBy"] == "chief@r2m.test" and out["confirmedAt"]
    assert out["auto"]["machineId"] == str(w.tills[0].id)  # still says where it came from
    with pytest.raises(HTTPException) as caught:
        RR.confirm_signer_pin(body=None, _admin=_admin(), db=w.db)
    assert (caught.value.status_code, caught.value.detail) == (409, "remote_support_pin_not_auto")


def test_nothing_to_confirm_without_an_automatic_pin(w):
    with pytest.raises(HTTPException) as caught:
        RR.confirm_signer_pin(body=None, _admin=_admin(), db=w.db)
    assert caught.value.status_code == 409


def test_replace_by_hand(w):
    _beat(w, w.tills[0], _report((FP_A,)))
    tasks = BackgroundTasks()
    out = RR.replace_signer_pin(body=RR.ReplaceIn(sha256=[FP_B.upper(), FP_C]), background_tasks=tasks,
                                _admin=_admin(), db=w.db)
    assert out["value"] == [FP_B, FP_C] and out["source"] == RS.SOURCE_MANUAL and out["setBy"] == "boss@r2m.test"
    assert out["auto"] is None
    assert len(tasks.tasks) == 1  # every till told
    assert _pulled(w, w.tills[1])[RS.SIGNER_KEY] == f"{FP_B},{FP_C}"
    # The same value again changes nothing and tells nobody.
    tasks = BackgroundTasks()
    RR.replace_signer_pin(body=RR.ReplaceIn(sha256=f"{FP_B},{FP_C}"), background_tasks=tasks, _admin=_admin(), db=w.db)
    assert tasks.tasks == []


def test_use_a_tills_fingerprint_as_the_allowed_one(w):
    _set_default(w, RS.SIGNER_KEY, FP_A)
    till = w.tills[1]
    _beat(w, till, _report((FP_B,), source=None))
    out = RR.replace_signer_pin(body=RR.ReplaceIn(fromMachineId=till.id), background_tasks=BackgroundTasks(),
                                _admin=_admin(), db=w.db)
    assert out["value"] == [FP_B] and out["source"] == RS.SOURCE_MANUAL
    assert out["machine"]["reported"] == [FP_B] and out["machine"]["status"] == RS.STATUS_MATCH
    meta = w.db.get(PlatformSetting, RS.PIN_SETTING_KEY).value
    assert meta["fromMachine"]["machineId"] == str(till.id)


@pytest.mark.parametrize("body, code", [
    ({}, "remote_support_pin_source"),
    ({"sha256": FP_A, "fromMachineId": "TILL"}, "remote_support_pin_source"),
    ({"fromMachineId": "TILL"}, "remote_support_no_report"),
    ({"sha256": "abc"}, None),
    ({"sha256": ""}, None),
])
def test_replace_refusals(w, body, code):
    if body.get("fromMachineId") == "TILL":
        body = {**body, "fromMachineId": w.tills[0].id}
    with pytest.raises(HTTPException) as caught:
        RR.replace_signer_pin(body=RR.ReplaceIn(**body), background_tasks=BackgroundTasks(), _admin=_admin(), db=w.db)
    assert caught.value.status_code == 422
    if code is not None:
        assert caught.value.detail == code
    else:
        assert "טביעת אצבע" in caught.value.detail


def test_a_machine_that_does_not_exist_is_a_404(w):
    with pytest.raises(HTTPException) as caught:
        RR.get_signer_pin(machine_id=uuid.uuid4(), _admin=_admin(), db=w.db)
    assert caught.value.status_code == 404


def test_the_device_view_of_the_pin(w):
    till = w.tills[0]
    out = RR.get_signer_pin(machine_id=till.id, _admin=_admin(), db=w.db)
    assert out["value"] == [] and out["source"] is None and out["officialHost"] == "download.teamviewer.com"
    assert out["machine"] == {"id": str(till.id), "effective": [], "reported": [], "status": None,
                              "differsFromGlobal": False}
    _set(w, RS.SIGNER_KEY, "shop", w.shop.id, FP_C)
    _beat(w, till, _report((FP_B,), source=None))
    out = RR.get_signer_pin(machine_id=till.id, _admin=_admin(), db=w.db)
    assert out["machine"]["effective"] == [FP_C] and out["machine"]["status"] == RS.STATUS_MISMATCH
    assert out["machine"]["differsFromGlobal"] is True
