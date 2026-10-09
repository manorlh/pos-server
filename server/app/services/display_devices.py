"""
"מכשיר תצוגה" — a KDS kitchen screen and the "מוכן / לא מוכן" order-status board are not
tills (docs/SPEC_DEVICE_ROLE_MODEL.md §2.2).

The owner: "מכשירים KDS ומסך מוכן/לא מוכן אינם מערכות קופה וחשבונאיות". What a device is
— till, kiosk, KDS or board — and what it runs on (Android / Windows) is chosen when it is
added on the dashboard, during pairing.

* **Stored.** `pos_machines.is_fiscal` (false for a display device) and
  `pos_machines.platform`. The screen itself is the KDS module's `kds_devices` row (a
  board is the row's role "pickup"), so the KDS page and the machine page never disagree:
  `display_role`.
* **Pairing.** A KDS / board code (`pairing_codes.device_role`) needs a shop; its screen
  (`kds_options`) is checked when the code is made (`check_pairing_request`). The machine
  is created non-fiscal — no register number, no document prefix — and its screen row
  and the till parameter `kdsScreen` are written right after it lands in the shop
  (`apply_on_pairing`, which never fails the pairing and never leaves it fiscal). A code
  for one platform refuses a device of the other (422 `platform_mismatch`) before
  anything is created.
* **Enforced.** Every fiscal till endpoint depends on `require_fiscal_machine`
  (app/middleware/auth.py): 403 `device_not_fiscal`. Display devices are left out of
  every list of tills that counts for money — the shop Z (`z_runs.is_seated_in` /
  `shop_tills`, and so the local shop Z and the Z participation card), the main till and
  every host election (`independent_till.lan_members`), "Z לכל הקופות"
  (`till_z.shop_till_z_machines`), register numbers (`register_number`), the overview's
  tills, report events' tills, kiosk controllers. The Tax Authority export is built from
  documents, and a display device can file none.
* **The KDS page** assigning an existing till as a screen for the first time
  (`kds.save_device` → `make_screen`) turns it into a display device too — only over a
  clean break (`device_profile.check_clean_break`), no closed shift waiting for a Z, no
  untransmitted card sales, not a kiosk, not the shop's main till. Its register number
  stays spent (the shop's counter never goes back) and its documents keep theirs. A till
  that already showed a screen before this rule (a `kds_devices` row on a fiscal machine)
  is left a till; the dashboard flags it (`kdsScreen` on a fiscal machine).
* **Never back.** A display device never becomes a till or a kiosk again, and a till
  never a display device, from the machine page: 409 `device_role_change_requires_pairing`
  — remove the device and add it again with a new code.
* **The web till** (web-till spec v2 §9.1). The browser ("web") and the iPad / iPhone shell
  ("ios") are a kiosk, a KDS or a board; a till there only with `WEB_TILL_ENABLED` on
  (`roles_for_platform`) — at pairing and on the machine page alike (422
  `web_platform_not_a_till`). A web / iOS till is an ordinary fiscal till for the cloud.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Sequence, Tuple

from fastapi import HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

ROLE_TILL = "till"
ROLE_KIOSK = "kiosk"
ROLE_KDS = "kds"
ROLE_ORDER_STATUS_BOARD = "order_status_board"
FISCAL_ROLES = (ROLE_TILL, ROLE_KIOSK)
NON_FISCAL_ROLES = (ROLE_KDS, ROLE_ORDER_STATUS_BOARD)
ROLES = FISCAL_ROLES + NON_FISCAL_ROLES

PLATFORM_ANDROID = "android"
PLATFORM_WINDOWS = "windows"
#: The browser on the dashboard's own site: the kiosk (`/k`, docs/SPEC_KIOSK.md §27), the KDS
#: (`/kds`) and the "מוכן / לא מוכן" board (`/board`, docs/SPEC_KDS.md §13) — never a till.
PLATFORM_WEB = "web"
#: The iPad / iPhone shell (web-till spec v2 §4.2, §9.1): the same r2m-app screens as the browser,
#: in a Capacitor app. Its codes and devices follow the browser's rules (`WEB_TILL_PLATFORMS`).
PLATFORM_IOS = "ios"
PLATFORMS = (PLATFORM_ANDROID, PLATFORM_WINDOWS, PLATFORM_WEB, PLATFORM_IOS)
PLATFORM_LABELS = {
    PLATFORM_ANDROID: "Android", PLATFORM_WINDOWS: "Windows", PLATFORM_WEB: "דפדפן (Web)",
    PLATFORM_IOS: "iPad / iPhone (iOS)",
}
#: The roles a browser may be added as.
WEB_ROLES = (ROLE_KIOSK, ROLE_KDS, ROLE_ORDER_STATUS_BOARD)
#: "קופת WEB" (web-till spec v2): the platforms whose till is the web till — the r2m-app till
#: screens driven by a till engine, never by the page. Their till exists only behind
#: `settings.web_till_enabled` (`WEB_TILL_ENABLED`, off): `web_till_enabled`.
WEB_TILL_PLATFORMS = (PLATFORM_WEB, PLATFORM_IOS)
WEB_PLATFORM_NOT_A_TILL = "web_platform_not_a_till"
WEB_PLATFORM_NOT_A_TILL_MESSAGE = (
    "בדפדפן אפשר להפעיל קיוסק, מסך מטבח (KDS) או מסך מוכן / לא מוכן — לא קופה. לקופה בחרו Android או Windows."
)
IOS_PLATFORM_NOT_A_TILL_MESSAGE = (
    "ב-iPad / iPhone אפשר להפעיל קיוסק, מסך מטבח (KDS) או מסך מוכן / לא מוכן — לא קופה. לקופה בחרו Android או Windows."
)

#: The KDS module's screen roles a KDS code may ask for; a board is always "pickup".
KDS_SCREEN_ROLES = ("station", "expo", "manager")
BOARD_SCREEN_ROLE = "pickup"
DEFAULT_KDS_SCREEN_ROLE = "expo"

NOT_FISCAL = "device_not_fiscal"
NOT_FISCAL_MESSAGE = "מכשיר תצוגה (מסך מטבח / מסך מוכן) אינו קופה: אין בו מכירות, משמרות, Z או תשלומים."
ROLE_CHANGE_REQUIRES_PAIRING = "device_role_change_requires_pairing"
PLATFORM_MISMATCH = "platform_mismatch"

REQUIRES_SHOP_MESSAGES = {
    ROLE_KDS: "מסך מטבח (KDS) נפתח בסניף מסוים: בחרו חברה וסניף לפני יצירת הקוד.",
    ROLE_ORDER_STATUS_BOARD: "מסך מוכן / לא מוכן נפתח בסניף מסוים: בחרו חברה וסניף לפני יצירת הקוד.",
}
STATION_NEEDED_MESSAGE = (
    "מסך עמדה צריך לפחות עמדת מטבח אחת. בחרו עמדות, או סוג מסך אחר (Expo / מנהל מטבח)."
)
STATION_NOT_FOUND_MESSAGE = "אחת מעמדות המטבח שנבחרו לא נמצאה. רעננו את הדף ובחרו שוב."


# ── What a machine is ─────────────────────────────────────────────────────────


def is_fiscal(machine: Any) -> bool:
    """A till or a kiosk. A machine not flushed yet (None) is one: the column's default."""
    return getattr(machine, "is_fiscal", True) is not False


def is_fiscal_role(role: Optional[str]) -> bool:
    """`till` / `kiosk` (or no role: a till); not `kds` / `order_status_board`."""
    return role not in NON_FISCAL_ROLES


def platform_of_device_info(device_info: Any) -> str:
    """
    `device_info.platform == "windows"` is Windows, `"web"` the browser, `"ios"` the iPad /
    iPhone shell; anything else, or nothing, Android.
    """
    if isinstance(device_info, dict):
        said = str(device_info.get("platform") or "").strip().lower()
        if said == PLATFORM_WINDOWS:
            return PLATFORM_WINDOWS
        if said == PLATFORM_WEB:
            return PLATFORM_WEB
        if said == PLATFORM_IOS:
            return PLATFORM_IOS
    return PLATFORM_ANDROID


def web_till_enabled() -> bool:
    """`WEB_TILL_ENABLED`: a till may be added on the web / iOS platforms (off by default)."""
    from app.config import get_settings

    return bool(getattr(get_settings(), "web_till_enabled", False))


def roles_for_platform(platform: Optional[str]) -> Tuple[str, ...]:
    """
    The roles a device of `platform` may be added as, or switched to: every role on Android
    and Windows; on the web / iOS a kiosk, a KDS or a board — and a till only with
    `WEB_TILL_ENABLED` on.
    """
    if platform in WEB_TILL_PLATFORMS:
        return WEB_ROLES + ((ROLE_TILL,) if web_till_enabled() else ())
    return ROLES


def web_platform_refusal(platform: Optional[str], role: Optional[str]) -> Optional[Dict[str, str]]:
    """
    A code for the browser (or the iOS shell) is a kiosk's, a KDS's or a board's — a till's
    only with `WEB_TILL_ENABLED` on (422 body `web_platform_not_a_till`), else None. No role
    is a till.
    """
    if platform not in WEB_TILL_PLATFORMS:
        return None
    if (role or ROLE_TILL) in roles_for_platform(platform):
        return None
    message = IOS_PLATFORM_NOT_A_TILL_MESSAGE if platform == PLATFORM_IOS else WEB_PLATFORM_NOT_A_TILL_MESSAGE
    return {"detail": WEB_PLATFORM_NOT_A_TILL, "message": message}


def platform_of(machine: Any) -> str:
    """The stored platform, else what the device said at pairing (an older row)."""
    stored = getattr(machine, "platform", None)
    if stored in PLATFORMS:
        return stored
    return platform_of_device_info(getattr(machine, "device_info", None))


def display_role(kds_device: Any) -> str:
    """A display device's role: the board for a "pickup" screen, else a KDS."""
    if kds_device is not None and getattr(kds_device, "role", None) == BOARD_SCREEN_ROLE:
        return ROLE_ORDER_STATUS_BOARD
    return ROLE_KDS


#: Where `prime_kds` / `kds_device_of` keep a machine's screen row on the instance.
_KDS_CACHE = "_kds_device_cached"
_NONE = object()


def kds_device_of(db: Optional[Session], machine: Any):
    """The machine's `kds_devices` row (active or not), or None. Cached per instance."""
    cached = getattr(machine, "__dict__", {}).get(_KDS_CACHE, None)
    if cached is not None:
        return None if cached is _NONE else cached
    if db is None:
        from sqlalchemy.orm import object_session

        db = object_session(machine)
    if db is None or getattr(machine, "id", None) is None:
        return None
    from app.models.kds import KdsDevice

    with db.no_autoflush:
        row = db.query(KdsDevice).filter(KdsDevice.machine_id == machine.id).first()
    _cache(machine, row)
    return row


def _cache(machine: Any, row: Any) -> None:
    if hasattr(machine, "__dict__"):
        machine.__dict__[_KDS_CACHE] = row if row is not None else _NONE


def forget(machine: Any) -> None:
    """The screen row changed: look it up again when asked."""
    if hasattr(machine, "__dict__"):
        machine.__dict__.pop(_KDS_CACHE, None)


def prime_kds(db: Session, machines: Sequence[Any]) -> None:
    """The screen rows of these machines in one query (a list), cached on each."""
    from app.models.kds import KdsDevice

    ids = [m.id for m in machines if getattr(m, "id", None) is not None]
    if not ids:
        return
    rows = {d.machine_id: d for d in db.query(KdsDevice).filter(KdsDevice.machine_id.in_(ids)).all()}
    for m in machines:
        _cache(m, rows.get(m.id))


def role_of_display(db: Optional[Session], machine: Any) -> str:
    return display_role(kds_device_of(db, machine))


def kds_screen_fields(kds_device: Any) -> Optional[Dict[str, Any]]:
    """The machine's screen, for the dashboard: its KDS role, name and whether it is on."""
    if kds_device is None:
        return None
    return {
        "role": kds_device.role,
        "name": kds_device.name,
        "isActive": bool(kds_device.is_active),
        "shopId": str(kds_device.shop_id) if kds_device.shop_id else None,
    }


# ── The refusal ───────────────────────────────────────────────────────────────


class DeviceNotFiscal(HTTPException):
    """
    A fiscal action asked of a display device. Answered `{"detail": "device_not_fiscal",
    "message": <Hebrew>}` by `not_fiscal_handler` (app/main.py); without the handler it is
    still a plain `{"detail": "device_not_fiscal"}` of the same status.
    """

    def __init__(self, machine: Any = None, status_code: int = status.HTTP_403_FORBIDDEN,
                 message: str = NOT_FISCAL_MESSAGE):
        super().__init__(status_code=status_code, detail=NOT_FISCAL)
        self.body: Dict[str, Any] = {"detail": NOT_FISCAL, "message": message}
        if machine is not None and getattr(machine, "id", None) is not None:
            self.body["machineId"] = str(machine.id)


async def not_fiscal_handler(request: Request, exc: DeviceNotFiscal) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=exc.body, headers=exc.headers)


def refuse_unless_fiscal(machine: Any, status_code: int = status.HTTP_403_FORBIDDEN) -> None:
    """403 (a till endpoint) / 409 (a dashboard action) `device_not_fiscal` for a display device."""
    if not is_fiscal(machine):
        raise DeviceNotFiscal(machine, status_code)


def not_fiscal_response(machine: Any, status_code: int = status.HTTP_409_CONFLICT) -> Optional[JSONResponse]:
    """For a dashboard route that answers refusals as responses: None for a fiscal machine."""
    if is_fiscal(machine):
        return None
    refusal = DeviceNotFiscal(machine, status_code)
    return JSONResponse(status_code=status_code, content=refusal.body)


# ── Adding one ────────────────────────────────────────────────────────────────


def _clean_name(value: Any) -> Optional[str]:
    return " ".join(str(value or "").split())[:100] or None


def check_pairing_request(db: Session, *, role: str, shop_id: Any, kds: Any = None) -> Dict[str, Any]:
    """
    A KDS / board code's screen, checked while the dialog is open: a shop (400
    `kds_requires_shop` / `order_status_board_requires_shop`), and for a station screen at
    least one station of the tenant (422 `station_device_needs_a_station` /
    `station_not_found`) — the rules of `kds.save_device`. Raises
    `device_profile.DeviceProfileRefused`.
    """
    from app.models.shop import Shop
    from app.services.device_profile import _refuse
    from app.services.kds import _station_names

    if shop_id is None:
        raise _refuse(f"{role}_requires_shop", None, REQUIRES_SHOP_MESSAGES[role], status.HTTP_400_BAD_REQUEST)
    shop = db.get(Shop, shop_id)
    if shop is None:
        raise _refuse("shop_not_found", None, "הסניף לא נמצא.", status.HTTP_404_NOT_FOUND)
    name = _clean_name(getattr(kds, "name", None))
    if role == ROLE_ORDER_STATUS_BOARD:
        return {"name": name, "screenRole": BOARD_SCREEN_ROLE, "stationIds": []}
    screen_role = getattr(kds, "screen_role", None) or DEFAULT_KDS_SCREEN_ROLE
    stations = [str(s) for s in (getattr(kds, "station_ids", None) or [])] if screen_role == "station" else []
    if screen_role == "station":
        names = _station_names(db, shop.tenant_id)
        if any(s not in names for s in stations):
            raise _refuse("station_not_found", None, STATION_NOT_FOUND_MESSAGE, status.HTTP_422_UNPROCESSABLE_ENTITY)
        stations = list(dict.fromkeys(stations))
        if not stations:
            raise _refuse(
                "station_device_needs_a_station", None, STATION_NEEDED_MESSAGE, status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
    return {"name": name, "screenRole": screen_role, "stationIds": stations}


class PlatformMismatch(ValueError):
    """The code is for one platform and the device runs the other (422, nothing created)."""

    def __init__(self, code_platform: str, device_platform: str):
        super().__init__(PLATFORM_MISMATCH)
        self.body = {
            "detail": PLATFORM_MISMATCH,
            "codePlatform": code_platform,
            "devicePlatform": device_platform,
            "message": (
                f"קוד הצימוד נוצר למכשיר {PLATFORM_LABELS.get(code_platform, code_platform)}, אבל המכשיר הזה "
                f"הוא {PLATFORM_LABELS.get(device_platform, device_platform)}. צרו קוד חדש בדשבורד "
                "(מכשירים ← הוספת מכשיר) ובחרו את הפלטפורמה הנכונה."
            ),
        }


def check_platform(pairing_code: Any, device_info: Any) -> str:
    """The device's platform; `PlatformMismatch` when the code names the other one."""
    device_platform = platform_of_device_info(device_info)
    wanted = getattr(pairing_code, "platform", None)
    if wanted in PLATFORMS and wanted != device_platform:
        raise PlatformMismatch(wanted, device_platform)
    return device_platform


def apply_on_pairing(db: Session, pairing_code: Any, machine: Any) -> bool:
    """
    Give a display device a code just paired its screen: the `kds_devices` row (a board's
    role "pickup"; a KDS's screen role and stations) and `kdsScreen`, so an Android device
    opens its kitchen screen. Runs after the machine landed in the code's shop, and
    commits. Never raises: the machine is non-fiscal already (it was created so), and a
    screen that cannot be written now is assigned on the KDS page. A station no longer
    there is dropped; a station screen left with none is an Expo. True when written.
    """
    from app.models.pos_machine import PairingStatus
    from app.models.shop import Shop
    from app.schemas.kds import KdsDeviceIn
    from app.services import kds as KDS

    role = getattr(pairing_code, "device_role", None)
    if role not in NON_FISCAL_ROLES or getattr(pairing_code, "target_machine_id", None) is not None:
        return False
    if is_fiscal(machine):
        logger.warning("display code %s paired machine %s that is fiscal; left as it is", pairing_code.id, machine.id)
        return False
    if machine.shop_id is None or machine.pairing_status != PairingStatus.ASSIGNED:
        logger.warning("display code %s paired machine %s with no shop; no screen yet", pairing_code.id, machine.id)
        return False
    options = getattr(pairing_code, "kds_options", None)
    options = options if isinstance(options, dict) else {}
    try:
        shop = db.get(Shop, machine.shop_id)
        screen_role = BOARD_SCREEN_ROLE if role == ROLE_ORDER_STATUS_BOARD else (
            options.get("screenRole") if options.get("screenRole") in KDS_SCREEN_ROLES else DEFAULT_KDS_SCREEN_ROLE
        )
        stations = []
        if screen_role == "station":
            names = KDS._station_names(db, shop.tenant_id)
            stations = [s for s in (options.get("stationIds") or []) if str(s) in names]
            if not stations:
                logger.warning("KDS code %s: its stations are gone; machine %s is an Expo", pairing_code.id, machine.id)
                screen_role = DEFAULT_KDS_SCREEN_ROLE
        body = KdsDeviceIn.model_validate({
            "name": options.get("name") or machine.name,
            "role": screen_role,
            "stationIds": stations,
            "isActive": True,
        })
        KDS.save_device(db, shop, machine.id, body)
        db.commit()
    except Exception as exc:  # noqa: BLE001 - the pairing stands; the KDS page assigns the screen
        db.rollback()
        logger.warning("display code %s: machine %s has no screen yet (%s)", pairing_code.id, machine.id, exc)
        return False
    forget(machine)
    return True


# ── An existing till made a screen on the KDS page ────────────────────────────


def _kds_refusal(code: str, message: str, status_code: int = status.HTTP_409_CONFLICT) -> HTTPException:
    """The KDS router's shape: `{"detail": {"code", "message"}}` (the dashboard shows `message`)."""
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def make_screen(db: Session, machine: Any) -> None:
    """
    The KDS page assigns a till of the shop as a screen for the first time: it becomes a
    display device — "מסך מטבח אינו קופה". Only over a clean break (the rules of every
    change of role), and only once nothing fiscal is left half-done on it. Its register
    number stays spent in the shop and its documents keep theirs; the machine gives up
    its number and document prefix. Raises 409 `{code, message}`; the caller commits.
    """
    from app.models.shift import Shift, ShiftStatus
    from app.services import device_profile as DP
    from app.services import kiosk_control, transmissions
    from app.services.main_till import main_till_of_shop

    if not is_fiscal(machine):
        return
    label = DP._label(machine)
    prefix = f"לא ניתן להפוך את {label} למסך מטבח"
    if kiosk_control.get_device(db, machine.id) is not None:
        raise _kds_refusal(
            "kds_screen_is_kiosk",
            f"{prefix}: היא קיוסק. החזירו אותה לקופה רגילה בעמוד הקיוסקים, או הוסיפו מסך חדש בקוד צימוד.",
        )
    main = main_till_of_shop(db, machine.shop_id)
    if main is not None and main.id == machine.id:
        raise _kds_refusal(
            "device_profile_main_till",
            f"{prefix}: היא הקופה הראשית של הסניף. קבעו קופה ראשית אחרת בעמוד הסניף, ואז נסו שוב.",
        )
    try:
        DP.check_clean_break(db, machine, prefix)
    except DP.DeviceProfileRefused as refused:
        raise _kds_refusal(refused.body["detail"], refused.body["message"], refused.status_code) from refused
    awaiting = (
        db.query(Shift.id)
        .filter(Shift.machine_id == machine.id, Shift.status == ShiftStatus.CLOSED, Shift.z_report_id.is_(None))
        .count()
    )
    if awaiting:
        raise _kds_refusal(
            "kds_screen_shifts_awaiting_z",
            f"{prefix}: יש בה {awaiting} משמרות סגורות שטרם נכללו ב-Z. הפיקו Z, ואז נסו שוב.",
        )
    if transmissions.has_untransmitted(db, machine):
        raise _kds_refusal(
            "device_profile_untransmitted",
            f"{prefix}: יש בה עסקאות אשראי שטרם שודרו. שדרו קודם (\"שידור עכשיו\"), ואז נסו שוב.",
        )
    machine.is_fiscal = False
    machine.pos_number = None
    machine.document_prefix = None


# ── Changing the role of a display device ────────────────────────────────────


def role_change_refusal(machine: Any, current: str, wanted: str):
    """409 `device_role_change_requires_pairing`: a till never becomes a screen, nor back."""
    from app.services.device_profile import _label, _refuse

    labels = {
        ROLE_TILL: "קופה", ROLE_KIOSK: "קיוסק", ROLE_KDS: "מסך מטבח (KDS)",
        ROLE_ORDER_STATUS_BOARD: "מסך מוכן / לא מוכן",
    }
    return _refuse(
        ROLE_CHANGE_REQUIRES_PAIRING, machine,
        f"לא ניתן להפוך את {_label(machine)} מ{labels.get(current, current)} ל{labels.get(wanted, wanted)}: "
        "מסך מטבח ומסך מוכן / לא מוכן אינם קופה ואינם מערכת חשבונאית. הסירו את המכשיר והוסיפו אותו "
        "מחדש עם קוד צימוד חדש (מכשירים ← הוספת מכשיר).",
        currentRole=current, requestedRole=wanted,
    )


def change_display_role(db: Session, machine: Any, wanted: str, kds: Any = None) -> bool:
    """
    A KDS made the board or back (both display devices), from the machine page: the
    screen row's role — "pickup" for the board; for a KDS the screen asked (`kds`), else
    an Expo. Raises `device_profile.DeviceProfileRefused`. The caller commits. True when changed.
    """
    from app.models.shop import Shop
    from app.schemas.kds import KdsDeviceIn
    from app.services import kds as KDS
    from app.services.device_profile import _refuse

    current = role_of_display(db, machine)
    if wanted == current:
        return False
    if machine.shop_id is None:
        raise _refuse(
            f"{wanted}_requires_shop", machine, REQUIRES_SHOP_MESSAGES[wanted], status.HTTP_400_BAD_REQUEST,
        )
    shop = db.get(Shop, machine.shop_id)
    options = check_pairing_request(db, role=wanted, shop_id=shop.id, kds=kds)
    existing = kds_device_of(db, machine)
    body = KdsDeviceIn.model_validate({
        "name": options.get("name") or (existing.name if existing is not None else machine.name),
        "role": options["screenRole"],
        "stationIds": options["stationIds"],
        "isActive": bool(existing.is_active) if existing is not None else True,
    })
    KDS.save_device(db, shop, machine.id, body)
    forget(machine)
    return True


def pairing_options(role: Optional[str], options: Optional[Dict[str, Any]]) -> Tuple[Optional[dict], Optional[dict]]:
    """(kiosk_options, kds_options) of a code, from `device_profile.check_pairing_request`'s answer."""
    if role == ROLE_KIOSK:
        return options, None
    if role in NON_FISCAL_ROLES:
        return None, options
    return None, None
