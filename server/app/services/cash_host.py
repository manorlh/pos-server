"""
"שרת מזומן" — the cash host device role (P:/specs/cash-paylink.md §2, §9ב, §10, §12, contract §11).

The owner, 14.10: "מבלי להיות תלוי בקיוסק" — a quiet Windows mini-PC with no screen, on a small UPS,
running the same kiosk-desktop app in a role of its own (`cash_host`). It drives the shop's PayLink
cash units ("עמדות מזומן", app/services/cash_stations.py) over USB and serves the kiosks over the LAN.

* **What it is.** `pos_machines.is_cash_host` (set at pairing only, `deviceRole: "cash_host"`) on a
  non-fiscal machine: no register number, no shifts, documents or sales of its own — every fiscal till
  endpoint answers it 403 `cash_host_not_a_till` (app/services/display_devices.py `DeviceNotFiscal`).
  Unlike a dedicated local server it is never in the shop's LAN group nor a host of it: like a display
  device it is left out of every list of tills (main till, tables / print host, the shop Z…). Its own
  endpoints admit it alone (`require_cash_host`, app/middleware/auth.py): its journal, its commands'
  acknowledgements.
* **Windows only** (§1: the maker's driver and DLL run on Windows; firmware updates only from there).
  A code for any other platform is refused (422 `cash_host_windows_only`); never offered in the browser.
* **Needs a shop**; never counted as a till license (`countsAsTillLicense: false` — it is non-fiscal).
* **Its heartbeat** carries the `cash` block (§11.9), kept on the machine (`cash_status`).
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

ROLE = "cash_host"
LABEL = "שרת מזומן"
DEFAULT_NAME = "שרת מזומן"

NOT_A_TILL = "cash_host_not_a_till"
NOT_A_TILL_MESSAGE = "שרת מזומן אינו קופה: אין בו מכירות, משמרות, מסמכים או Z — הוא מנהל את מכשירי המזומן של הקיוסקים."
WINDOWS_ONLY = "cash_host_windows_only"
WINDOWS_ONLY_MESSAGE = (
    "שרת מזומן הוא מחשב Windows (הדרייבר של PayLink רץ רק ב-Windows) — אותה תוכנת קיוסק, בתפקיד שרת מזומן. "
    "בחרו פלטפורמה Windows."
)
REQUIRES_SHOP_MESSAGE = "שרת מזומן משרת סניף מסוים: בחרו חברה וסניף לפני יצירת הקוד."
ONLY_A_CASH_HOST = "cash_host_only"
ONLY_A_CASH_HOST_MESSAGE = "רק שרת מזומן (או קיוסק מארח) מדווח יומן מזומן ומאשר פקודות מזומן."

# ── "מארח עמדת מזומן" (P:/specs/cash-paylink.md §14.1) ─────────────────────────────────────────
# The owner, 16.10: the PayLink on USB at a Windows kiosk's PC — that kiosk runs the station too, and the other
# kiosks reach it (over the LAN or through the cloud, `cashRoute`). It stays a kiosk (fiscal); the flag
# `pos_machines.cash_host_embedded` is set on the dashboard's device page, off by default.
EMBEDDED_LABEL = "קיוסק מארח"
EMBEDDED_NOT_ALLOWED = "embedded_host_not_allowed"
EMBEDDED_HAS_STATIONS = "host_has_stations"


def is_cash_host(machine: Any) -> bool:
    """A machine paired as "שרת מזומן": the flag, on a non-fiscal machine (always so by pairing)."""
    if machine is None:
        return False
    return getattr(machine, "is_cash_host", False) is True and getattr(machine, "is_fiscal", True) is False


def embedded_refusal(machine: Any) -> Optional[str]:
    """Why this device may not be a host kiosk (Hebrew), or None: a Windows till / kiosk of a shop, active, paired."""
    from app.models.pos_machine import PairingStatus
    from app.services.display_devices import PLATFORM_WINDOWS

    if machine is None:
        return "המכשיר לא נמצא."
    if is_cash_host(machine):
        return "המכשיר הוא שרת מזומן ייעודי — הוא כבר מנהל עמדות."
    if getattr(machine, "is_fiscal", True) is False:
        return "מסך או שרת מקומי אינו יכול לנהל עמדת מזומן — רק קיוסק Windows."
    if (getattr(machine, "platform", None) or "").lower() != PLATFORM_WINDOWS:
        return "רק קיוסק Windows יכול לנהל עמדת מזומן: הדרייבר של PayLink רץ רק ב-Windows."
    if getattr(machine, "shop_id", None) is None:
        return "המכשיר אינו משויך לסניף."
    if not getattr(machine, "is_active", True) or getattr(machine, "pairing_status", PairingStatus.ASSIGNED) != PairingStatus.ASSIGNED:
        return "המכשיר אינו פעיל."
    return None


def is_embedded_host(machine: Any) -> bool:
    """A host kiosk: the flag on, on a device that may be one (`embedded_refusal`)."""
    if machine is None or getattr(machine, "cash_host_embedded", False) is not True:
        return False
    return embedded_refusal(machine) is None


def hosts_cash(machine: Any) -> bool:
    """Runs cash stations: a dedicated cash host, or a host kiosk (§14.1)."""
    return is_cash_host(machine) or is_embedded_host(machine)


def platform_refusal(platform: Optional[str], role: Optional[str]) -> Optional[Dict[str, str]]:
    """A cash host's code is for Windows: the 422 body for another platform, else None (None means Windows)."""
    from app.services.display_devices import PLATFORM_WINDOWS

    if role == ROLE and platform not in (None, PLATFORM_WINDOWS):
        return {"detail": WINDOWS_ONLY, "message": WINDOWS_ONLY_MESSAGE}
    return None


def apply_on_pairing(db: Session, pairing_code: Any, machine: Any, options: Optional[Dict[str, Any]] = None) -> bool:
    """
    A cash-host code just paired this (non-fiscal) machine into its shop: its name — the one typed, else
    "שרת מזומן". Its stations are set on the dashboard's "עמדות מזומן" page. Commits; never raises (the
    pairing stands whatever happens here). True when named.
    """
    from app.services.machine_names import is_generated_name

    options = options if isinstance(options, dict) else {}
    try:
        name = options.get("name")
        if name:
            machine.name = name
        elif is_generated_name(getattr(machine, "name", None)):
            machine.name = DEFAULT_NAME
        db.commit()
    except Exception:  # noqa: BLE001 - a name is cosmetic
        db.rollback()
        logger.exception("cash host %s: name not set", getattr(machine, "id", None))
        return False
    return True
