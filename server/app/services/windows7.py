"""
"Windows 7 (קופה)" — the Windows app's build for old PCs (P:/specs/windows7-till.md).

The owner (10.10.2026): Windows 7 runs ONLY the till. The Windows app has a second build for Windows 7 / 8.1 x64
(Celeron J1900, 4 GB): the same code on Electron 22. It says so at pairing — `device_info.appBuild == "win7"` beside
`platform: "windows"` — and it:

* pairs only as a till: a code of another role (a kiosk, a KDS, a board, a customer display, a cash host) is
  refused before anything is created (422 `windows7_till_only`, Hebrew `message`);
* may not be made another role later (409 `windows7_till_only` from the device-profile change);
* takes app updates of its own platform, `windows7` (app/services/app_updates.py) — never a standard installer
  (Electron 44), which does not start on Windows 7.

The dashboard's "הוספת מכשיר" offers "Windows 7 (קופה)": a `windows7: true` code request must be a till (the role
"till" or none) with the license "קופה בלבד" (`till`, or none — then `till`), on the Windows platform.

The app itself enforces the same (kiosk-desktop core/appBuild.ts): another role is shown as refused, never run.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

#: `device_info.appBuild` of the Windows 7 build.
APP_BUILD_WIN7 = "win7"

TILL_ONLY = "windows7_till_only"
TILL_ONLY_MESSAGE = (
    "גרסת Windows 7 תומכת בקופה בלבד. קיוסק, מסך מטבח ומסכים אחרים דורשים Windows 10 ומעלה — "
    "צרו קוד של קופה, או התקינו את המכשיר על Windows 10/11."
)
LICENSE_TILL_ONLY = "windows7_license_till_only"
LICENSE_TILL_ONLY_MESSAGE = "מחשב Windows 7 הוא קופה בלבד: סוג הרישיון שלו הוא \"קופה בלבד\" (לא קיוסק ולא משולב)."
NOT_WINDOWS = "windows7_platform_windows"
NOT_WINDOWS_MESSAGE = "Windows 7 היא התקנה של Windows: בחרו את הפלטפורמה Windows."

#: The only role the build runs; a code with no role is a till's.
ROLES = (None, "till")


def is_windows7_device_info(device_info: Any) -> bool:
    """The device said it runs the Windows 7 build (`appBuild: "win7"`, on Windows)."""
    if not isinstance(device_info, dict):
        return False
    platform = str(device_info.get("platform") or "").strip().lower()
    build = str(device_info.get("appBuild") or "").strip().lower()
    return platform == "windows" and build == APP_BUILD_WIN7


def is_windows7_machine(machine: Any) -> bool:
    return is_windows7_device_info(getattr(machine, "device_info", None))


def role_allowed(role: Optional[str]) -> bool:
    return role in ROLES


def refusal_body(code: str = TILL_ONLY, message: str = TILL_ONLY_MESSAGE, **extra: Any) -> Dict[str, Any]:
    return {"detail": code, "message": message, **extra}


def check_pairing_request(platform: Optional[str], role: Optional[str], license_product: Optional[str]) -> Optional[Dict[str, Any]]:
    """
    A "Windows 7 (קופה)" code request: the 422 body when it does not fit (not Windows, not a till, a license other
    than "קופה בלבד"), else None. The caller then makes a Windows till code with the license `till`.
    """
    if platform not in (None, "windows"):
        return refusal_body(NOT_WINDOWS, NOT_WINDOWS_MESSAGE)
    if not role_allowed(role):
        return refusal_body(role=role)
    if license_product not in (None, "till"):
        return refusal_body(LICENSE_TILL_ONLY, LICENSE_TILL_ONLY_MESSAGE)
    return None
