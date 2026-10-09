"""
The software details the open-format file names (A000 fields 1006–1012) — a platform
setting, the super admin's (`GET/PUT /system/open-format`), since they are the same for
every customer: the software house registers the software once with the Tax Authority.

Stored under `platform_settings["openFormat"]`:

* `softwareName` — 1007 "שם התוכנה", X(20).
* `softwareVersion` — 1008 "מהדורת התוכנה", X(20). Empty: derived — the newest active
  till release (`app_releases.version_name`, its build suffix cut: `0.1.207`).
* `manufacturerName` — 1010 "שם יצרן התוכנה", X(20) (Hebrew punctuation is written as its
  ASCII equivalent: `בע״מ` → `בע"מ`).
* `manufacturerVatNumber` — 1009 "מספר ע"מ של יצרן התוכנה", 9(9): the software house's
  ח.פ., check digit verified.
* `registrationNumber` — 1006 "מספר תעודת הרישום של התוכנה במערכת המס", 9(8): the
  certificate number the Tax Authority issued for the software. Empty: zeros.
* `outputDrive` — the drive the files are saved to ("C:"), for 1012 "נתיב מיקום שמירת
  הקבצים": `<drive>\\OPENFRMT\\<8 digits of the business number>.<YY>\\<MMDDhhmm>`
  (1.31 §2.2). Empty: 1012 stays blank.

Whatever is not configured falls back to `defaults.DEFAULT_SOFTWARE_INFO` and is listed in
`placeholders` so the dashboard and the export report can say what is still missing.
"""
from __future__ import annotations

import re
from dataclasses import replace
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.platform_setting import PlatformSetting
from app.services.open_format.defaults import DEFAULT_SOFTWARE_INFO, SoftwareInfo
from app.services.open_format.israeli_tax_id import israeli_9th_check_digit

SETTING_KEY = "openFormat"

FIELDS = (
    "softwareName",
    "softwareVersion",
    "manufacturerName",
    "manufacturerVatNumber",
    "registrationNumber",
    "outputDrive",
)

#: What each placeholder means to the owner, in the file's own words.
FIELD_LABELS = {
    "registrationNumber": "A000 1006 — מספר תעודת הרישום של התוכנה במערכת המס (8 ספרות)",
    "softwareName": "A000 1007 — שם התוכנה",
    "softwareVersion": "A000 1008 — מהדורת התוכנה",
    "manufacturerVatNumber": "A000 1009 — מספר ע\"מ של יצרן התוכנה",
    "manufacturerName": "A000 1010 — שם יצרן התוכנה",
    "outputDrive": "A000 1012 — הכונן לשמירת הקבצים (נתיב מיקום שמירת הקבצים)",
}

_DRIVE_RE = re.compile(r"^[A-Za-z]:$")


class SoftwareSettingsError(ValueError):
    def __init__(self, field: str, message: str):
        super().__init__(message)
        self.field = field
        self.message = message


def _text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _digits(value: Any) -> Optional[str]:
    text = _text(value)
    return "".join(c for c in text if c.isdigit()) if text else None


def validate(body: Dict[str, Any]) -> Dict[str, Optional[str]]:
    """The stored form of a PUT body. Raises `SoftwareSettingsError` (field, Hebrew message)."""
    from app.services.open_format.tax_report_generator import charset_text

    out: Dict[str, Optional[str]] = {}
    for key, width in (("softwareName", 20), ("softwareVersion", 20), ("manufacturerName", 20)):
        value = _text(body.get(key))
        if value is not None and len(charset_text(value)) > width:
            raise SoftwareSettingsError(key, f"עד {width} תווים.")
        out[key] = value
    vat = _digits(body.get("manufacturerVatNumber"))
    if vat is not None:
        if len(vat) != 9 or israeli_9th_check_digit(vat[:8]) != int(vat[8]):
            raise SoftwareSettingsError(
                "manufacturerVatNumber", "מספר עוסק/ח.פ. של יצרן התוכנה: 9 ספרות עם ספרת ביקורת תקינה."
            )
    out["manufacturerVatNumber"] = vat
    reg = _digits(body.get("registrationNumber"))
    if reg is not None and (len(reg) > 8 or len(reg) == 0):
        raise SoftwareSettingsError(
            "registrationNumber", "מספר תעודת הרישום של התוכנה: עד 8 ספרות (שדה 1006 בקובץ הוא 9(8))."
        )
    if reg is not None and not reg.strip("0"):
        # The simulator answers a zeroed 1006 "ערך השדה לא ולידי / השדה מאופס": zeros are
        # what the file writes while nothing is configured, never a configured value.
        raise SoftwareSettingsError(
            "registrationNumber", "מספר תעודת הרישום של התוכנה לא יכול להיות אפסים — יש להזין את המספר שרשות המסים הנפיקה."
        )
    out["registrationNumber"] = reg
    drive = _text(body.get("outputDrive"))
    if drive is not None and not _DRIVE_RE.match(drive):
        raise SoftwareSettingsError("outputDrive", "כונן בצורה X: (למשל C:).")
    out["outputDrive"] = drive.upper() if drive else None
    return out


def stored(db: Session) -> Dict[str, Optional[str]]:
    row = db.get(PlatformSetting, SETTING_KEY) if callable(getattr(db, "get", None)) else None
    value = row.value if isinstance(getattr(row, "value", None), dict) else {}
    return {key: _text(value.get(key)) for key in FIELDS}


def derived_version(db: Session) -> Optional[str]:
    """
    The newest active till release's version, build suffix cut ("0.1.207+abc…" → "0.1.207").
    Android releases only: the till app is the registered software; a Windows app build
    (its own a.b.c numbering) never becomes the file's version.
    """
    from app.models.app_release import AppRelease

    try:
        row = (
            db.query(AppRelease.version_name)
            .filter(AppRelease.is_active.is_(True), AppRelease.platform == "android")
            .order_by(AppRelease.version_code.desc(), AppRelease.created_at.desc())
            .first()
        )
    except Exception:  # noqa: BLE001 — a version label must never stop an export
        return None
    if row is None or not row[0]:
        return None
    return re.split(r"[+\s]", str(row[0]).strip(), maxsplit=1)[0] or None


def software_info(db: Session) -> SoftwareInfo:
    """The SoftwareInfo the file is written with: configured, else derived, else the placeholder."""
    s = stored(db)
    info = DEFAULT_SOFTWARE_INFO
    return replace(
        info,
        name=s["softwareName"] or info.name,
        version=s["softwareVersion"] or derived_version(db) or info.version,
        manufacturer_name=s["manufacturerName"] or info.manufacturer_name,
        manufacturer_id=s["manufacturerVatNumber"] or info.manufacturer_id,
        registration_number=s["registrationNumber"] or "0" * 8,
    )


def placeholders(db: Session) -> List[str]:
    """The fields the file still writes a placeholder for (not configured, nothing to derive)."""
    s = stored(db)
    missing = [key for key in ("registrationNumber", "softwareName", "manufacturerName", "manufacturerVatNumber", "outputDrive") if not s[key]]
    if not s["softwareVersion"] and not derived_version(db):
        missing.append("softwareVersion")
    return missing


def output_path(db: Session, vat_number: str, produced_at: datetime) -> str:
    """1012: `<drive>\\OPENFRMT\\<8 digits>.<YY>\\<MMDDhhmm>` (1.31 §2.2), or blank if no drive is set."""
    drive = stored(db)["outputDrive"]
    if not drive:
        return ""
    digits = "".join(c for c in str(vat_number or "") if c.isdigit()).zfill(9)[:8]
    return f"{drive}\\OPENFRMT\\{digits}.{produced_at:%y}\\{produced_at:%m%d%H%M}"


def get_settings(db: Session) -> Dict[str, Any]:
    info = software_info(db)
    return {
        **stored(db),
        "effective": {
            "softwareName": info.name,
            "softwareVersion": info.version,
            "manufacturerName": info.manufacturer_name,
            "manufacturerVatNumber": info.manufacturer_id,
            "registrationNumber": info.registration_number,
        },
        "derivedVersion": derived_version(db),
        "placeholders": placeholders(db),
        "labels": FIELD_LABELS,
    }


def set_settings(db: Session, user: Any, body: Dict[str, Any]) -> Dict[str, Any]:
    clean = validate(body)
    row = db.get(PlatformSetting, SETTING_KEY)
    if row is None:
        row = PlatformSetting(key=SETTING_KEY, value={})
        db.add(row)
    row.value = clean
    row.updated_by_user_id = getattr(user, "id", None)
    db.flush()
    return get_settings(db)
