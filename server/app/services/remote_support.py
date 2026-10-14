"""
"תמיכה מרחוק": TeamViewer QuickSupport installed by the till itself (P:/specs/quicksupport-autoinstall.md
§2, §2א). The cloud's half: the till parameters, the till's report, the signer pin and its alert.

* **Till parameters** (a super admin's, like every till parameter: the default is global, and a
  company, shop, point of sale or till may set its own; registered in app/services/till_parameters.py):
  - `remoteSupportApkUrl` — where the till downloads the APK: https:// only. The default is
    TeamViewer's official QuickSupport download; a file we host is allowed too.
  - `remoteSupportSignerSha256` — the allowed SHA-256 fingerprints of the APK's signing
    certificate, comma-separated, stored canonical: 64 lower-case hex digits, no colons, no spaces.
    Empty by default: then the till installs only from `OFFICIAL_HOST` and reports the signer of
    that first install, which the cloud pins (below).
  - `remoteSupportPackages` — the package names the till agrees to install, comma-separated;
    `com.teamviewer.quicksupport.market` by default. At least one.
  - `remoteSupportAutoInstall` — on by default: after pairing, and at every start while QuickSupport
    is missing, the till installs it in the background (silently on a device-owner till).
  `clean_value` checks a value on every write (the parameters router, `validate_keyed_value`).
* **The till's report** — the heartbeat's `remoteSupport` block: `installed`, `package`,
  `signerSha256` (a list), and `installedFrom` (the URL the till itself installed it from, when it
  did). Cleaned key by key (`clean_report`) — a bad key is dropped, never a 422 — and kept in
  `pos_machines.device_info["remoteSupport"]`, with how it stands against the pin (`pinStatus`).
* **The first pin** (Trust On First Use): while the till's own `remoteSupportSignerSha256` and the
  global default are both empty, a report of an install from https://download.teamviewer.com with
  an allowed package sets the global default to the reported fingerprint(s). The platform setting
  `remote_support_signer_pin` records which till and when; the dashboard says "נקבע אוטומטית מהתקנה
  ראשונה (קופה X, תאריך)" and a super admin confirms it or replaces it (app/routers/remote_support.py).
* **A mismatch** — a later report none of whose fingerprints is pinned for that till: the exception
  `quicksupport_signer_mismatch` ("חתימת QuickSupport לא תואמת בקופה X", medium), once per till and
  per reported / pinned pair; closed by itself once the till's report matches again (or QuickSupport
  is gone from it).

Everything that runs on the heartbeat swallows its own errors: a report never fails a beat.
"""
from __future__ import annotations

import hashlib
import logging
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import urlsplit

from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# ── The parameters ───────────────────────────────────────────────────────────

APK_URL_KEY = "remoteSupportApkUrl"
SIGNER_KEY = "remoteSupportSignerSha256"
PACKAGES_KEY = "remoteSupportPackages"
AUTO_INSTALL_KEY = "remoteSupportAutoInstall"
KEYS = (APK_URL_KEY, SIGNER_KEY, PACKAGES_KEY, AUTO_INSTALL_KEY)
#: The keys whose values `clean_value` checks beyond their type.
VALIDATED_KEYS = (APK_URL_KEY, SIGNER_KEY, PACKAGES_KEY)

#: TeamViewer's own download host: the only one a till installs from while no fingerprint is pinned.
OFFICIAL_HOST = "download.teamviewer.com"
#: The official QuickSupport APK (the owner, 14.10.2026): `remoteSupportApkUrl`'s default.
OFFICIAL_APK_URL = f"https://{OFFICIAL_HOST}/download/TeamViewerQS.apk"
DEFAULT_PACKAGE = "com.teamviewer.quicksupport.market"
#: At most this many fingerprints, and this many package names, in one value or one report.
LIST_MAX = 10
PACKAGE_MAX = 255
URL_MAX = 500

_SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
#: An Android package name: two segments or more, each a letter, then letters, digits or `_`.
_PACKAGE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$")
_LEVELS = "ניתן לקבוע ערך אחר לחברה, לסניף, לנקודת מכירה או לקופה."

PARAMETER_SPECS = (
    dict(
        key=AUTO_INSTALL_KEY,
        label="התקנה אוטומטית של תמיכה מרחוק (QuickSupport) אחרי חיבור הקופה",
        value_type="boolean",
        default_value=True,
        description=(
            "אחרי צימוד הקופה, ובכל עלייה שבה TeamViewer QuickSupport חסר, הקופה מורידה ומתקינה אותו ברקע "
            "(במסכי ההקמה, ליד \"הפעלה אוטומטית\"). במכשיר בנעילת קופה ההתקנה שקטה לגמרי; אחרת מופיע מסך "
            "\"התקנת תמיכה מרחוק\" עם \"התקן\" (אנדרואיד מבקש אישור, ולפעמים גם \"התקנה ממקורות לא ידועים\") "
            "ו\"לא עכשיו\", והמסך חוזר בעלייה הבאה. כבוי: QuickSupport מותקן רק כשלוחצים \"תמיכה מרחוק\". "
            + _LEVELS
        ),
    ),
    dict(
        key=APK_URL_KEY,
        label="תמיכה מרחוק: כתובת הורדה של QuickSupport",
        value_type="string",
        default_value=OFFICIAL_APK_URL,
        description=(
            "מכאן הקופה מורידה את TeamViewer QuickSupport (קובץ APK) כשהוא חסר, ובודקת את שם החבילה ואת "
            "חתימת TeamViewer לפני ההתקנה. "
            f"ברירת המחדל היא כתובת ההורדה הרשמית של TeamViewer QuickSupport ({OFFICIAL_APK_URL}). "
            "אפשר גם קובץ APK שהעלינו לאחסון שלנו, אבל רק כשמוגדרת \"טביעת אצבע של חותם QuickSupport\": "
            f"בלי טביעת אצבע הקופה מורידה רק מהאתר הרשמי ({OFFICIAL_HOST}). https:// בלבד. "
            "ריק: אין הורדה אוטומטית, והקופה מציגה \"חסר\" כמו היום. "
            + _LEVELS
        ),
    ),
    dict(
        key=SIGNER_KEY,
        label="תמיכה מרחוק: טביעת אצבע של חותם QuickSupport (SHA-256)",
        value_type="string",
        default_value="",
        description=(
            "טביעת האצבע (SHA-256) של תעודת החותם של TeamViewer. הקופה מתקינה קובץ שהורד (גם עדכון) רק אם "
            "התעודה שחתמה עליו זהה לאחת מהרשימה; אחרת ההתקנה נחסמת ומופיעה חריגה \"חתימת QuickSupport לא "
            "תואמת\". "
            f"ריק (ברירת מחדל): הקופה מתקינה רק מהאתר הרשמי ({OFFICIAL_HOST}), והענן קובע כאן אוטומטית את "
            "טביעת האצבע מההתקנה הראשונה שמדווחת, ומציג \"נקבע אוטומטית מהתקנה ראשונה\" עם הקופה והתאריך. "
            "מנהל-על מאשר או מחליף (גם מדף המכשיר: \"השתמש כטביעת האצבע המותרת\"). "
            "64 תווים הקסדצימליים לכל טביעה; כמה טביעות מופרדות בפסיק. אפשר להדביק עם נקודתיים (AB:CD:…), "
            "באותיות גדולות או קטנות; נשמר בלי נקודתיים ובאותיות קטנות. מהקובץ הרשמי: "
            "apksigner verify --print-certs, או keytool -printcert -jarfile. "
            + _LEVELS
        ),
    ),
    dict(
        key=PACKAGES_KEY,
        label="תמיכה מרחוק: שמות חבילה מותרים של QuickSupport",
        value_type="string",
        default_value=DEFAULT_PACKAGE,
        description=(
            "שמות החבילה (Android) שהקופה מסכימה להתקין כ-QuickSupport, מופרדים בפסיק. קובץ שהורד עם שם "
            f"חבילה אחר לא יותקן. ברירת מחדל: {DEFAULT_PACKAGE}; אפשר להוסיף מקבילים. לפחות שם אחד. "
            + _LEVELS
        ),
    ),
)


class RemoteSupportValueError(ValueError):
    """A value the parameter does not take; the message is the dashboard's (Hebrew)."""


def _items(value: str) -> List[str]:
    """A list value's items: split on commas (or semicolons, new lines), trimmed, empty ones dropped."""
    return [item.strip() for item in re.split(r"[,;\r\n]", value) if item.strip()]


def _digest(item: str) -> str:
    return re.sub(r"[\s:]", "", item).lower()


def _https_parts(value: str):
    """`urlsplit` of an absolute https:// URL with a host and no credentials, else None."""
    if not value or len(value) > 2000 or any(ch.isspace() for ch in value):
        return None
    try:
        parts = urlsplit(value)
        parts.port  # noqa: B018 - raises on a port that is not a number
    except ValueError:
        return None
    if parts.scheme.lower() != "https" or not parts.hostname:
        return None
    if parts.username is not None or parts.password is not None:
        return None
    return parts


def clean_url(value: Any) -> str:
    """`remoteSupportApkUrl`: trimmed; empty (no auto-install), or an absolute https:// URL."""
    if not isinstance(value, str):
        raise RemoteSupportValueError("כתובת הורדה: טקסט")
    url = value.strip()
    if not url:
        return ""
    if any(ch.isspace() for ch in url):
        raise RemoteSupportValueError("כתובת הורדה: בלי רווחים בכתובת")
    parts = _https_parts(url)
    if parts is None:
        try:
            has_credentials = "@" in urlsplit(url).netloc
        except ValueError:
            has_credentials = False
        if has_credentials:
            raise RemoteSupportValueError("כתובת הורדה: בלי שם משתמש או סיסמה בכתובת")
        raise RemoteSupportValueError("כתובת הורדה: רק כתובת https:// מלאה (או ריק)")
    return url


def clean_fingerprints(value: Any) -> str:
    """`remoteSupportSignerSha256`: empty, or 64-hex fingerprints, lower case, comma-joined, no repeats."""
    if not isinstance(value, str):
        raise RemoteSupportValueError("טביעת אצבע: טקסט")
    out: List[str] = []
    for item in _items(value):
        digest = _digest(item)
        if not _SHA256_HEX.match(digest):
            raise RemoteSupportValueError(
                f"טביעת אצבע לא תקינה: «{item[:100]}». נדרשים 64 תווים הקסדצימליים (0-9, A-F), "
                "עם נקודתיים או בלי; כמה טביעות מופרדות בפסיק"
            )
        if digest not in out:
            out.append(digest)
    if len(out) > LIST_MAX:
        raise RemoteSupportValueError(f"טביעת אצבע: עד {LIST_MAX} טביעות")
    return ",".join(out)


def clean_packages(value: Any) -> str:
    """`remoteSupportPackages`: one Android package name or more, comma-joined, no repeats."""
    if not isinstance(value, str):
        raise RemoteSupportValueError("שמות חבילה: טקסט")
    out: List[str] = []
    for item in _items(value):
        if len(item) > PACKAGE_MAX or not _PACKAGE.match(item):
            raise RemoteSupportValueError(
                f"שם חבילה לא תקין: «{item[:100]}». אותיות באנגלית, ספרות ו-_, לפחות שני חלקים מופרדים "
                f"בנקודה (כמו {DEFAULT_PACKAGE}); כמה שמות מופרדים בפסיק"
            )
        if item not in out:
            out.append(item)
    if not out:
        raise RemoteSupportValueError("שמות חבילה: לפחות שם חבילה אחד")
    if len(out) > LIST_MAX:
        raise RemoteSupportValueError(f"שמות חבילה: עד {LIST_MAX} שמות")
    return ",".join(out)


def clean_value(key: str, value: Any) -> Any:
    """A value of one of `VALIDATED_KEYS` as stored and sent to the tills; any other key's as given."""
    if value is None:
        return None
    if key == APK_URL_KEY:
        return clean_url(value)
    if key == SIGNER_KEY:
        return clean_fingerprints(value)
    if key == PACKAGES_KEY:
        return clean_packages(value)
    return value


def fingerprints_of(value: Any) -> List[str]:
    """The valid fingerprints in a stored value (or a list), canonical; never raises."""
    items = value if isinstance(value, list) else _items(value) if isinstance(value, str) else []
    out: List[str] = []
    for item in items:
        if not isinstance(item, str):
            continue
        digest = _digest(item)
        if _SHA256_HEX.match(digest) and digest not in out:
            out.append(digest)
    return out[:LIST_MAX]


def packages_of(value: Any) -> List[str]:
    """The valid package names in a stored value; never raises."""
    if not isinstance(value, str):
        return []
    return [p for p in _items(value) if len(p) <= PACKAGE_MAX and _PACKAGE.match(p)][:LIST_MAX]


def is_official(url: Any) -> bool:
    """An https:// URL on TeamViewer's own download host."""
    parts = _https_parts(url.strip()) if isinstance(url, str) else None
    return parts is not None and (parts.hostname or "").lower() == OFFICIAL_HOST and parts.port in (None, 443)


# ── The till's report ────────────────────────────────────────────────────────

#: Where the report lives: `pos_machines.device_info[REPORT_KEY]`.
REPORT_KEY = "remoteSupport"
#: How the report stands against the till's pin (`pinStatus`).
STATUS_MATCH = "match"
STATUS_MISMATCH = "mismatch"
STATUS_NO_PIN = "no_pin"
STATUS_PINNED_NOW = "pinned_first"
#: A report that did not change is checked against the pin again at most this often.
RECHECK_AFTER = timedelta(minutes=10)


def clean_report(block: Any) -> Optional[Dict[str, Any]]:
    """
    The heartbeat's `remoteSupport` as kept: known keys only, each checked on its own — a bad one is
    dropped, the rest kept. None when the block is not an object or nothing in it is readable.
    `installedFrom` keeps the scheme, host and path only (never a query that may carry a token).
    """
    if hasattr(block, "model_dump"):
        block = block.model_dump(by_alias=True, exclude_none=True)
    if not isinstance(block, dict):
        return None
    out: Dict[str, Any] = {}
    installed = block.get("installed")
    if isinstance(installed, bool):
        out["installed"] = installed
    package = block.get("package")
    if isinstance(package, str) and len(package.strip()) <= PACKAGE_MAX and _PACKAGE.match(package.strip()):
        out["package"] = package.strip()
    signers = block.get("signerSha256")
    if isinstance(signers, (list, str)):
        found = fingerprints_of(signers)
        if found or signers in ([], ""):
            out["signerSha256"] = found
    source = block.get("installedFrom")
    if isinstance(source, str):
        parts = _https_parts(source.strip())
        if parts is not None:
            url = f"https://{parts.netloc}{parts.path}"
            if len(url) <= URL_MAX:
                out["installedFrom"] = url
    return out or None


def report_of(machine: Any) -> Optional[Dict[str, Any]]:
    info = getattr(machine, "device_info", None)
    report = info.get(REPORT_KEY) if isinstance(info, dict) else None
    return report if isinstance(report, dict) else None


def _utc(value: Optional[datetime]) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _parse(text: Any) -> Optional[datetime]:
    if not isinstance(text, str):
        return None
    try:
        return _utc(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


_FACTS = ("installed", "package", "signerSha256", "installedFrom")


def apply_heartbeat(db: Session, machine: Any, block: Any, *, now: Optional[datetime] = None) -> None:
    """
    The beat's `remoteSupport` onto the machine, then checked against the pin (the first pin, or a
    mismatch's exception). Absent or unreadable: as it was. Never raises.
    """
    if block is None:
        return
    try:
        report = clean_report(block)
        if report is None:
            return
        now = _utc(now)
        info = dict(machine.device_info) if isinstance(getattr(machine, "device_info", None), dict) else {}
        before = info.get(REPORT_KEY) if isinstance(info.get(REPORT_KEY), dict) else {}
        changed = {k: before.get(k) for k in _FACTS if k in before} != report
        checked = _parse(before.get("checkedAt"))
        if not changed and checked is not None and now - checked < RECHECK_AFTER:
            return
        stored = dict(report)
        stored["reportedAt"] = now.isoformat() if changed else before.get("reportedAt") or now.isoformat()
        try:
            with db.begin_nested():
                stored["pinStatus"] = check_pin(db, machine, report, previous=before.get("pinStatus"), now=now)
        except Exception:  # noqa: BLE001 - the report is kept even when the check fails
            logger.exception("remote support pin check failed for %s", getattr(machine, "id", None))
            stored["pinStatus"] = before.get("pinStatus")
        stored["checkedAt"] = now.isoformat()
        stored = {k: v for k, v in stored.items() if v is not None}
        info[REPORT_KEY] = stored
        machine.device_info = info
    except Exception:  # noqa: BLE001 - a report never fails a heartbeat
        logger.exception("remote support report not applied for %s", getattr(machine, "id", None))


# ── The pin ──────────────────────────────────────────────────────────────────

#: The platform setting that says where the global pin came from.
PIN_SETTING_KEY = "remote_support_signer_pin"
SOURCE_AUTO = "auto"
SOURCE_CONFIRMED = "confirmed"
SOURCE_MANUAL = "manual"


def parameters_for(db: Session, machine: Any) -> Dict[str, Any]:
    """The four "תמיכה מרחוק" parameters as this till gets them (its chain, else the defaults)."""
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.till_parameters import resolve_till_parameters, scope_chain_for_machine

    parameters = db.query(TillParameter).filter(TillParameter.key.in_(KEYS)).all()
    if not parameters:
        return {}
    chain = scope_chain_for_machine(db, machine)
    on_chain = [
        and_(TillParameterValue.scope_type == kind, TillParameterValue.scope_id == ident)
        for kind, ident in chain.scopes()
    ]
    values = (
        db.query(TillParameterValue)
        .filter(TillParameterValue.parameter_id.in_([p.id for p in parameters]), or_(*on_chain))
        .all()
        if on_chain else []
    )
    return resolve_till_parameters(parameters, values, chain).parameters


def _signer_parameter(db: Session, *, lock: bool = False):
    from app.models.till_parameter import TillParameter

    query = db.query(TillParameter).filter(TillParameter.key == SIGNER_KEY)
    if lock:
        query = query.with_for_update()
    return query.first()


def pin_meta(db: Session) -> Dict[str, Any]:
    from app.models.platform_setting import PlatformSetting

    row = db.get(PlatformSetting, PIN_SETTING_KEY)
    return dict(row.value) if row is not None and isinstance(row.value, dict) else {}


def _save_meta(db: Session, value: Dict[str, Any], user_id: Any = None) -> None:
    from app.models.platform_setting import PlatformSetting

    row = db.get(PlatformSetting, PIN_SETTING_KEY)
    if row is None:
        row = PlatformSetting(key=PIN_SETTING_KEY, value={})
        db.add(row)
    row.value = value
    row.updated_by_user_id = user_id
    row.updated_at = datetime.now(timezone.utc)


def till_label(machine: Any) -> str:
    """"קופה 3", else the till's name — how the alert and the dashboard name it."""
    number = getattr(machine, "pos_number", None)
    if number:
        return f"קופה {number}"
    name = (getattr(machine, "name", None) or "").strip()
    if not name:
        return "קופה"
    return name if name.startswith("קופה") else f"קופה {name}"


def _machine_meta(db: Session, machine: Any) -> Dict[str, Any]:
    from app.models.shop import Shop

    shop = db.get(Shop, machine.shop_id) if getattr(machine, "shop_id", None) else None
    return {
        "machineId": str(machine.id),
        "machineName": getattr(machine, "name", None),
        "posNumber": getattr(machine, "pos_number", None),
        "tillLabel": till_label(machine),
        "shopId": str(shop.id) if shop is not None else None,
        "shopName": shop.name if shop is not None else None,
        "tenantId": str(machine.tenant_id) if getattr(machine, "tenant_id", None) else None,
    }


#: Who the change log names for the first pin: the till, not a user.
def _auto_actor(machine: Any) -> Any:
    return SimpleNamespace(id=None, email=f"auto: {till_label(machine)} ({machine.id})"[:255], role="machine")


def set_global_pin(
    db: Session, parameter: Any, value: str, *, user: Any, meta: Dict[str, Any], now: datetime,
) -> bool:
    """The global default of `remoteSupportSignerSha256` (audited) and where it came from. True when it changed."""
    from app.services import till_parameter_audit as AUDIT

    changed = parameter.default_value != value
    if changed:
        AUDIT.record_change(
            db, parameter=parameter, scope_type=AUDIT.DEFINITION_SCOPE, scope_id=None,
            action=AUDIT.DEFAULT, old_value=parameter.default_value, new_value=value, user=user, now=now,
        )
        parameter.default_value = value
        parameter.updated_at = now
    _save_meta(db, {**meta, "value": value}, getattr(user, "id", None))
    return changed


def note_manual_pin(db: Session, value: Any, user: Any, *, now: Optional[datetime] = None) -> None:
    """The parameters page changed the global default: no longer "נקבע אוטומטית"."""
    now = _utc(now)
    _save_meta(db, {
        "source": SOURCE_MANUAL if fingerprints_of(value) else None,
        "value": value,
        "setAt": now.isoformat(),
        "setBy": getattr(user, "email", None) or getattr(user, "username", None),
    }, getattr(user, "id", None))


def maybe_pin_first(
    db: Session, machine: Any, report: Dict[str, Any], params: Dict[str, Any], *, now: datetime,
) -> bool:
    """
    The first pin (§2א): the till's report of its own install from the official host, an allowed
    package, while the global default is empty too. True when the pin was set.
    """
    signers = report.get("signerSha256") or []
    if not signers or report.get("installed") is not True or not is_official(report.get("installedFrom")):
        return False
    if report.get("package") not in packages_of(params.get(PACKAGES_KEY)):
        return False
    parameter = _signer_parameter(db, lock=True)
    if parameter is None or not parameter.is_active or fingerprints_of(parameter.default_value):
        return False
    value = ",".join(signers[:LIST_MAX])
    meta = {
        "source": SOURCE_AUTO,
        "at": now.isoformat(),
        "package": report.get("package"),
        "installedFrom": report.get("installedFrom"),
        **_machine_meta(db, machine),
    }
    set_global_pin(db, parameter, value, user=_auto_actor(machine), meta=meta, now=now)
    db.flush()
    logger.warning(
        "remote support: signer pin set from the first install on machine %s (%s): %s",
        machine.id, till_label(machine), value,
    )
    notify_all_after_commit(db)
    return True


# ── The mismatch ─────────────────────────────────────────────────────────────

EXCEPTION_TYPE = "quicksupport_signer_mismatch"
EXCEPTION_LABEL = "חתימת QuickSupport לא תואמת"
EXCEPTION_SEVERITY = "medium"


def _rows_of(db: Session, machine: Any):
    from app.models.audit_exception import AuditException

    return (
        db.query(AuditException)
        .filter(AuditException.exception_type == EXCEPTION_TYPE, AuditException.machine_id == machine.id)
        .order_by(AuditException.occurred_at)
        .all()
    )


def _is_open(row: Any) -> bool:
    return not (row.details or {}).get("resolvedAt")


def resolve_mismatches(db: Session, machine: Any, *, now: datetime, why: str) -> int:
    """The till's open mismatch alerts, over by themselves (the report matches, or QuickSupport is gone)."""
    from app.services.exception_alerts.status_watch import resolve

    closed = 0
    for row in _rows_of(db, machine):
        if _is_open(row):
            resolve(row, now, why)
            closed += 1
    return closed


def raise_mismatch(
    db: Session, machine: Any, report: Dict[str, Any], pin: Sequence[str], *, now: datetime,
) -> Optional[Any]:
    """"חתימת QuickSupport לא תואמת בקופה X" — once per reported / pinned pair, while it lasts."""
    from app.models.audit_exception import AuditException
    from app.models.shop import Shop
    from app.services.exception_alerts.status_watch import resolve

    signers = report.get("signerSha256") or []
    pair = ",".join(sorted(signers)) + "|" + ",".join(sorted(pin))
    prefix = f"{EXCEPTION_TYPE}:{machine.id}:{hashlib.sha256(pair.encode()).hexdigest()[:24]}"
    rows = _rows_of(db, machine)
    if any(_is_open(r) and r.dedupe_key.startswith(prefix) for r in rows):
        return None
    for row in rows:
        if _is_open(row):
            resolve(row, now, "דיווח חדש מהקופה")
    shop = db.get(Shop, machine.shop_id) if getattr(machine, "shop_id", None) else None
    label = till_label(machine)
    row = AuditException(
        id=uuid.uuid4(),
        tenant_id=machine.tenant_id,
        company_id=shop.company_id if shop is not None else None,
        shop_id=machine.shop_id,
        area_id=getattr(machine, "area_id", None),
        machine_id=machine.id,
        exception_type=EXCEPTION_TYPE,
        severity=EXCEPTION_SEVERITY,
        dedupe_key=f"{prefix}:{sum(1 for r in rows if r.dedupe_key.startswith(prefix))}"[:200],
        details={
            "summary": f"{EXCEPTION_LABEL} ב{label}",  # "חתימת QuickSupport לא תואמת בקופה 3"
            "till": label,
            "package": report.get("package"),
            "reported": list(signers),
            "pinned": list(pin),
            "installedFrom": report.get("installedFrom"),
            "resolvedAt": None,
        },
        occurred_at=now,
        detected_at=now,
        status="new",
    )
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        return None  # another process recorded it first
    logger.warning("remote support: signer mismatch on machine %s: %s not in %s", machine.id, signers, list(pin))
    return row


def check_pin(
    db: Session, machine: Any, report: Dict[str, Any], *, previous: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Optional[str]:
    """
    The report against the till's pin: `pinned_first` (this report set the first pin), `match`,
    `mismatch` (the exception raised), `no_pin`, or None (nothing installed / no signer said).
    """
    now = _utc(now)
    signers = report.get("signerSha256") or []
    if report.get("installed") is not True or not signers:
        if report.get("installed") is False and previous == STATUS_MISMATCH:
            resolve_mismatches(db, machine, now=now, why="QuickSupport לא מותקן בקופה")
        return None
    params = parameters_for(db, machine)
    pin = fingerprints_of(params.get(SIGNER_KEY))
    if not pin:
        return STATUS_PINNED_NOW if maybe_pin_first(db, machine, report, params, now=now) else STATUS_NO_PIN
    if set(signers) & set(pin):
        if previous == STATUS_MISMATCH:
            resolve_mismatches(db, machine, now=now, why="החתימה תואמת")
        return STATUS_MATCH
    raise_mismatch(db, machine, report, pin, now=now)
    return STATUS_MISMATCH


# ── Telling the tills ────────────────────────────────────────────────────────

_NOTIFY = "remote_support_notify"


def _publish(targets) -> None:
    from app.services.till_parameters import publish_parameters_notify

    try:
        publish_parameters_notify(targets)
    except Exception:  # noqa: BLE001
        logger.exception("remote support: parameters notify failed")


def _start_publish(targets) -> None:
    """Off the request: every active till may be many (the first pin is global)."""
    threading.Thread(target=_publish, args=(targets,), name="remote-support-notify", daemon=True).start()


def _after_commit(session: Session) -> None:
    targets = session.info.pop(_NOTIFY, None)
    if targets:
        _start_publish(targets)


def notify_all_after_commit(db: Session) -> None:
    """Every active till pulls its parameters once this transaction commits (dropped on a rollback)."""
    from sqlalchemy import event

    from app.services.till_parameters import notify_targets_for_all

    db.info[_NOTIFY] = notify_targets_for_all(db)
    if not db.info.get(_NOTIFY + ".installed"):
        db.info[_NOTIFY + ".installed"] = True
        event.listen(db, "after_commit", _after_commit)
        event.listen(db, "after_rollback", lambda s: s.info.pop(_NOTIFY, None))


# ── The dashboard ────────────────────────────────────────────────────────────


def pin_out(db: Session, machine: Any = None) -> Dict[str, Any]:
    """`GET /remote-support/signer-pin`: the global pin, where it came from, and one till against it."""
    parameter = _signer_parameter(db)
    meta = pin_meta(db)
    value = fingerprints_of(parameter.default_value) if parameter is not None else []
    # The record speaks for the value it was written with: a pin changed since is no longer "auto".
    source = meta.get("source") if value and fingerprints_of(meta.get("value")) == value else None
    out: Dict[str, Any] = {
        "key": SIGNER_KEY,
        "parameterId": str(parameter.id) if parameter is not None else None,
        "active": bool(parameter.is_active) if parameter is not None else False,
        "value": value,
        "source": source,
        "auto": None,
        "confirmedAt": meta.get("confirmedAt") if source == SOURCE_CONFIRMED else None,
        "confirmedBy": meta.get("confirmedBy") if source == SOURCE_CONFIRMED else None,
        "setAt": meta.get("setAt") if source == SOURCE_MANUAL else None,
        "setBy": meta.get("setBy") if source == SOURCE_MANUAL else None,
        "officialHost": OFFICIAL_HOST,
    }
    if source in (SOURCE_AUTO, SOURCE_CONFIRMED) and meta.get("machineId"):
        out["auto"] = {
            k: meta.get(k)
            for k in ("machineId", "machineName", "posNumber", "tillLabel", "shopId", "shopName", "at",
                      "package", "installedFrom")
        }
    if machine is not None:
        report = report_of(machine) or {}
        effective = fingerprints_of(parameters_for(db, machine).get(SIGNER_KEY))
        reported = fingerprints_of(report.get("signerSha256"))
        if not reported:
            status = None
        elif not effective:
            status = STATUS_NO_PIN
        else:
            status = STATUS_MATCH if set(reported) & set(effective) else STATUS_MISMATCH
        out["machine"] = {
            "id": str(machine.id),
            "effective": effective,
            "reported": reported,
            "status": status,
            "differsFromGlobal": effective != value,
        }
    return out


class PinError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def confirm_pin(db: Session, user: Any, *, expected: Any = None, now: Optional[datetime] = None) -> Dict[str, Any]:
    """"אשר": the automatic pin, kept as it is, confirmed by a super admin."""
    now = _utc(now)
    parameter = _signer_parameter(db, lock=True)
    meta = pin_meta(db)
    value = fingerprints_of(parameter.default_value) if parameter is not None else []
    if not value or meta.get("source") != SOURCE_AUTO or fingerprints_of(meta.get("value")) != value:
        raise PinError(409, "remote_support_pin_not_auto")
    if expected is not None and fingerprints_of(expected) != value:
        raise PinError(409, "remote_support_pin_changed")
    _save_meta(db, {
        **meta,
        "source": SOURCE_CONFIRMED,
        "confirmedAt": now.isoformat(),
        "confirmedBy": getattr(user, "email", None) or getattr(user, "username", None),
    }, getattr(user, "id", None))
    return meta


def replace_pin(
    db: Session, user: Any, *, sha256: Any = None, from_machine: Any = None, now: Optional[datetime] = None,
) -> bool:
    """
    "החלף" / "השתמש כטביעת האצבע המותרת": the global pin set to the fingerprints given, or to those a
    till reported. True when the value changed (the caller tells the tills).
    """
    from app.services.till_parameters import ensure_builtin_parameters

    now = _utc(now)
    if (sha256 is None) == (from_machine is None):
        raise PinError(422, "remote_support_pin_source")
    if from_machine is not None:
        report = report_of(from_machine) or {}
        found = fingerprints_of(report.get("signerSha256"))
        if not found:
            raise PinError(422, "remote_support_no_report")
        value = ",".join(found)
    else:
        raw = ",".join(sha256) if isinstance(sha256, list) and all(isinstance(s, str) for s in sha256) else sha256
        try:
            value = clean_fingerprints(raw)
        except RemoteSupportValueError as exc:
            raise PinError(422, str(exc)) from exc
        if not value:
            raise PinError(422, "טביעת אצבע: לפחות טביעה אחת")
    ensure_builtin_parameters(db)
    parameter = _signer_parameter(db, lock=True)
    if parameter is None:
        raise PinError(404, "till_parameter_not_found")
    meta: Dict[str, Any] = {
        "source": SOURCE_MANUAL,
        "setAt": now.isoformat(),
        "setBy": getattr(user, "email", None) or getattr(user, "username", None),
    }
    if from_machine is not None:
        meta["fromMachine"] = _machine_meta(db, from_machine)
    return set_global_pin(db, parameter, value, user=user, meta=meta, now=now)
