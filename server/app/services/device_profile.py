"""
"סוג מכשיר" — a device's role and model, chosen when it is added
(docs/SPEC_DEVICE_ROLE_MODEL.md).

* **Role.** "till", "kiosk", "kds" or "order_status_board". A kiosk is what it always
  was: a till with a `kiosk_devices` row (app/services/kiosk_control.py). A KDS and the
  "מוכן / לא מוכן" board are display devices — not tills, not accounting systems
  (`pos_machines.is_fiscal` false, app/services/display_devices.py) — told apart by their
  `kds_devices` row. There is no role column: the rows are the source of truth, so the
  kiosks page, the KDS page and the machine page can never disagree.
* **Adding a device.** The pairing code carries the role, and for a kiosk its options
  (name, controlling tills, device lock). A kiosk code must be pre-assigned to a shop.
  When a device redeems it, the new machine is converted right after it lands in the
  shop (`apply_on_pairing`), so the till's first `machines/me` already says
  `deviceRole: "kiosk"` and its first `kiosk/sync` answers `kiosk: true`.
* **Model.** `pos_machines.device_model` with its capability flags
  (app/models/pos_machine.py `device_capabilities`). The dashboard's choice is kept in
  `device_model_chosen`; at pairing the device's own word (`detect_device_model`) still
  wins, as it always did, and the machine page warns when the two differ.
* **Changing them** (`check_model_change`, `check_role_switch`): only over a clean break —
  no Z under way, no open shift, no documents the till reported unsynced, no Zs closed
  offline and not uploaded (or a till that may close them and is not seen), and for a
  kiosk not the shop's main till. Losing the built-in terminal also waits for its
  untransmitted card sales. The refusals carry a Hebrew `message` shown as is.
"""
from __future__ import annotations

import logging
import types
import uuid
from typing import Any, Dict, Iterable, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.kiosk import KioskDevice
from app.models.pos_machine import PairingStatus, POSMachine, device_has_builtin_terminal, set_kiosk_cache
from app.models.shop import Shop
from app.models.user import User
from app.services import display_devices as DD

logger = logging.getLogger(__name__)

ROLE_TILL = "till"
ROLE_KIOSK = "kiosk"
#: The display devices (app/services/display_devices.py): not tills, not accounting systems.
ROLE_KDS = DD.ROLE_KDS
ROLE_ORDER_STATUS_BOARD = DD.ROLE_ORDER_STATUS_BOARD
ROLES = (ROLE_TILL, ROLE_KIOSK, ROLE_KDS, ROLE_ORDER_STATUS_BOARD)

INVALID_CONTROLLER_MESSAGE = (
    "אחת הקופות השולטות שנבחרו אינה קופה פעילה של אותה חברה (או שהיא קיוסק בעצמה). בחרו שוב."
)


class DeviceProfileRefused(Exception):
    """A refusal with a body (`detail`, Hebrew `message`, …), answered as is."""

    def __init__(self, status_code: int, body: dict):
        super().__init__(body.get("detail"))
        self.status_code = status_code
        self.body = body


def _label(machine: POSMachine) -> str:
    number = (getattr(machine, "pos_number", None) or "").strip()
    return f"קופה {number}" if number else (getattr(machine, "name", None) or "המכשיר")


def _refuse(code: str, machine: Optional[POSMachine], message: str,
            status_code: int = status.HTTP_409_CONFLICT, **extra) -> DeviceProfileRefused:
    body = {"detail": code, "message": message, **extra}
    if machine is not None:
        body["machineId"] = str(machine.id)
    return DeviceProfileRefused(status_code, body)


# ── Roles ─────────────────────────────────────────────────────────────────────


def kiosk_device(db: Session, machine_id: Any) -> Optional[KioskDevice]:
    return db.get(KioskDevice, machine_id) if machine_id is not None else None


def kiosk_devices_by_machine(db: Session, machine_ids: Iterable[Any]) -> Dict[Any, KioskDevice]:
    ids = [i for i in machine_ids if i is not None]
    if not ids:
        return {}
    return {d.machine_id: d for d in db.query(KioskDevice).filter(KioskDevice.machine_id.in_(ids)).all()}


def prime_kiosks(db: Session, machines: Iterable[POSMachine]) -> Dict[Any, KioskDevice]:
    """
    The kiosk rows of these machines in one query, and each machine told whether it is a
    kiosk (`POSMachine.is_kiosk`, which turns its built-in terminal off) — so a list does
    not look each one up.
    """
    machines = list(machines)
    kiosks = kiosk_devices_by_machine(db, [m.id for m in machines])
    for m in machines:
        set_kiosk_cache(m, m.id in kiosks)
    # And their KDS screen rows: a display device's role, a till's legacy screen.
    DD.prime_kds(db, machines)
    return kiosks


def role_of(device: Optional[KioskDevice], machine: Optional[POSMachine] = None) -> str:
    """
    The machine's role as the dashboard shows it: a kiosk while it has a kiosk row; a
    display device's ("kds" / "order_status_board", by its screen row) when `machine` is
    one; else a till.
    """
    if machine is not None and not DD.is_fiscal(machine):
        return DD.role_of_display(None, machine)
    return ROLE_KIOSK if device is not None else ROLE_TILL


def current_role(db: Session, machine: POSMachine) -> str:
    """The machine's role now (`role_of` with its own rows)."""
    if not DD.is_fiscal(machine):
        return DD.role_of_display(db, machine)
    return role_of(kiosk_device(db, machine.id))


def effective_role(db: Optional[Session], machine: POSMachine) -> str:
    """
    The mode the device opens in (`machines/me`): a display device's role ("kds" /
    "order_status_board"); "kiosk" for an enabled kiosk; else "till" — a disabled kiosk
    works as a till, exactly as its `kiosk/sync` answers `kiosk: false`.
    """
    if not DD.is_fiscal(machine):
        return DD.role_of_display(db, machine)
    if db is None:
        return ROLE_TILL
    device = kiosk_device(db, machine.id)
    return ROLE_KIOSK if device is not None and device.enabled else ROLE_TILL


def machine_fields(machine: POSMachine, device: Optional[KioskDevice]) -> Dict[str, Any]:
    """The role and model fields of the machines list and the machine page."""
    from app.models.pos_machine import detect_device_model, device_driver_pending, device_has_cash_drawer_port

    model = getattr(machine, "device_model", None)
    screen = DD.kds_device_of(None, machine)
    return {
        "deviceRole": role_of(device, machine),
        # "מכשיר תצוגה" (docs/SPEC_DEVICE_ROLE_MODEL.md §2.2): false for a KDS / the board —
        # not a till; its platform; and its screen (on a fiscal till: a screen paired on the
        # KDS page before the rule, which the dashboard flags).
        "fiscal": DD.is_fiscal(machine),
        "platform": DD.platform_of(machine),
        "kdsScreen": DD.kds_screen_fields(screen),
        "kioskEnabled": bool(device.enabled) if device is not None else None,
        "deviceModelChosen": getattr(machine, "device_model_chosen", None),
        "deviceModelReported": detect_device_model(getattr(machine, "device_info", None)),
        "hasCashDrawerPort": device_has_cash_drawer_port(model),
        "deviceDriverPending": device_driver_pending(model),
    }


# ── Adding a device ───────────────────────────────────────────────────────────


def _stand_in(shop: Shop):
    """A kiosk-to-be for `validate_controllers`: it has a shop and no row yet."""
    return types.SimpleNamespace(id=uuid.uuid4(), tenant_id=shop.tenant_id, shop_id=shop.id, shop=shop)


def check_pairing_request(
    db: Session,
    *,
    role: Optional[str],
    shop_id: Optional[uuid.UUID],
    kiosk: Any = None,
    kds: Any = None,
) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """
    The role and its options a pairing code stores, checked now so the operator hears
    of a mistake while the dialog is open. A kiosk needs a shop (400 `kiosk_requires_shop`)
    and valid controlling tills (422 `invalid_controller`); its options are the kiosk's. A
    KDS / board needs a shop too, and a station screen its stations
    (`display_devices.check_pairing_request`); its options are the screen's.
    """
    from app.services import kiosk_control

    if role in DD.NON_FISCAL_ROLES:
        return role, DD.check_pairing_request(db, role=role, shop_id=shop_id, kds=kds)
    if role != ROLE_KIOSK:
        return role, None
    if shop_id is None:
        raise _refuse(
            "kiosk_requires_shop", None,
            "קיוסק נפתח בסניף מסוים: בחרו חברה וסניף לפני יצירת הקוד.",
            status.HTTP_400_BAD_REQUEST,
        )
    shop = db.get(Shop, shop_id)
    if shop is None:
        raise _refuse("shop_not_found", None, "הסניף לא נמצא.", status.HTTP_404_NOT_FOUND)
    name = " ".join((getattr(kiosk, "name", None) or "").split()) or None
    try:
        controllers = kiosk_control.validate_controllers(
            db, _stand_in(shop), getattr(kiosk, "controller_machine_ids", None) or []
        )
    except HTTPException as exc:
        raise _refuse(
            "invalid_controller", None, INVALID_CONTROLLER_MESSAGE,
            status.HTTP_422_UNPROCESSABLE_ENTITY, reason=str(exc.detail),
        ) from exc
    pinpad = clean_pinpad(None, kiosk)
    return ROLE_KIOSK, {
        "name": name,
        "controllerMachineIds": controllers,
        "lockDevice": bool(getattr(kiosk, "lock_device", False)),
        **({"pinpadHost": pinpad[0], "pinpadPort": pinpad[1]} if pinpad else {}),
    }


PINPAD_MESSAGES = {
    "host_invalid": "כתובת המסופון אינה תקינה: כתובת IPv4 (למשל 192.168.1.20) או שם מארח, בלי http:// ובלי פורט.",
    "port_invalid": "פורט המסופון חייב להיות מספר בין 1 ל-65535 (ברירת המחדל 8080).",
}


def clean_pinpad(machine: Optional[POSMachine], kiosk: Any) -> Optional[Tuple[str, int]]:
    """
    The kiosk's external pinpad address as given (`pinpadHost`, `pinpadPort`), cleaned the
    way the till's own `PUT /sync/{id}/payment-terminal` cleans it; None when no host was
    given (a level above may have one, or it is set later). 422 `pinpad_*` otherwise.
    """
    from app.services import payment_terminal

    host = getattr(kiosk, "pinpad_host", None)
    if host is None or not str(host).strip():
        return None
    try:
        return (
            payment_terminal.clean_pinpad_host(host),
            payment_terminal.clean_pinpad_port(getattr(kiosk, "pinpad_port", None)),
        )
    except payment_terminal.PinpadAddressError as exc:
        raise _refuse(
            f"pinpad_{exc.code}", machine, PINPAD_MESSAGES.get(exc.code, "כתובת המסופון אינה תקינה."),
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        ) from exc


def apply_pinpad(machine: POSMachine, host: Optional[str], port: Optional[int]) -> bool:
    """
    Write the kiosk's pinpad to the machine's own settings layer — the existing keys
    (`payment_terminal.pinpad_settings_patch`), exactly as the till writes an address typed
    on it. Nothing without a host. True when written; the caller commits and notifies.
    """
    from app.services import payment_terminal
    from app.services.settings_merge import patch_settings_json, utc_now

    if not host:
        return False
    machine.settings = patch_settings_json(
        machine.settings,
        payment_terminal.pinpad_settings_patch(host, port or payment_terminal.DEFAULT_PORT, payment_terminal.DEFAULT_PATH),
    )
    machine.settings_updated_at = utc_now()
    return True


def notify_settings(db: Session, machine: POSMachine) -> None:
    """After the commit: the till's own settings layer changed (the pinpad)."""
    from app.services import settings_notify

    try:
        settings_notify.notify_machine_settings(db, machine, reason="payment_terminal")
    except Exception:  # noqa: BLE001 - the till's next settings pull takes it anyway
        logger.warning("settings notify for machine %s failed", machine.id)


def _controller_still_valid(db: Session, machine: POSMachine, controller_id: Any) -> bool:
    from app.services import kiosk_control

    try:
        kiosk_control.validate_controllers(db, machine, [controller_id])
    except HTTPException:
        return False
    return True


def apply_on_pairing(db: Session, pairing_code, machine: POSMachine) -> bool:
    """
    Make the machine a code just paired what the code says: a kiosk, for a kiosk code.
    Runs after the machine landed in the code's shop, and commits. Never raises — the
    pairing stands whatever happens here (the machine then stays a till, and the kiosks
    page can still convert it). A controlling till that is no longer valid is dropped.
    True when the machine was made a kiosk.
    """
    from app.services import kiosk_control

    if getattr(pairing_code, "device_role", None) != ROLE_KIOSK:
        return False
    if getattr(pairing_code, "target_machine_id", None) is not None:
        return False  # a replacement keeps the role of the till it replaces
    if kiosk_device(db, machine.id) is not None:
        return False
    if machine.shop_id is None or machine.pairing_status != PairingStatus.ASSIGNED:
        logger.warning("kiosk code %s paired machine %s with no shop; left a till", pairing_code.id, machine.id)
        return False
    options = pairing_code.kiosk_options if isinstance(pairing_code.kiosk_options, dict) else {}
    controllers = [
        c for c in (options.get("controllerMachineIds") or []) if _controller_still_valid(db, machine, c)
    ]
    lock = bool(options.get("lockDevice"))
    user = db.get(User, pairing_code.distributor_id)
    try:
        kiosk_control.convert(
            db, user, machine, name=options.get("name"), controller_ids=controllers, lock_device=lock,
        )
        # "מסופון חיצוני ברשת — חובה לקיוסק": the address given with the code, if any.
        pinpad_written = apply_pinpad(machine, options.get("pinpadHost"), options.get("pinpadPort"))
        db.commit()
    except (HTTPException, IntegrityError) as exc:
        db.rollback()
        logger.warning("kiosk code %s: machine %s not converted (%s)", pairing_code.id, machine.id, exc)
        return False
    set_kiosk_cache(machine, True)
    if lock:
        kiosk_control.notify_device_lock(machine)
    if pinpad_written:
        notify_settings(db, machine)
    return True


# ── Changing them ─────────────────────────────────────────────────────────────


def check_clean_break(db: Session, machine: POSMachine, prefix: str) -> None:
    """
    The rules every change of role or model waits for, the same ones the independent-till
    switch and a replacement code wait for (app/services/independent_till.py,
    `till_z.may_be_producing_offline`). `prefix` opens the Hebrew message.
    """
    from app.services import till_z
    from app.services.independent_till import _open_shift

    till_z.expire_overdue(db)
    if till_z.live_z_run_item(db, machine.id) is not None or till_z._pending_query(db, machine.id).first() is not None:
        raise _refuse(
            "device_profile_z_in_progress", machine,
            f"{prefix}: יש Z בתהליך שכולל אותה. המתינו לסיומו ונסו שוב.",
        )
    if _open_shift(db, machine) is not None:
        raise _refuse(
            "device_profile_open_shift", machine,
            f"{prefix}: יש בה משמרת פתוחה. סגרו את המשמרת (בקופה או בסגירה מרחוק), ואז נסו שוב.",
        )
    pending = int(getattr(machine, "pending_documents", None) or 0)
    if pending > 0:
        raise _refuse(
            "device_profile_unsynced_documents", machine,
            f"{prefix}: לפי הדיווח האחרון שלה יש בה {pending} מסמכים שטרם סונכרנו לענן. "
            "חברו את הקופה לרשת והמתינו לסנכרון, ואז נסו שוב.",
            count=pending,
        )
    why = till_z.may_be_producing_offline(db, machine)
    if why is not None:
        reason = (
            "יש בה דוחות Z שנסגרו ללא חיבור וטרם סונכרנו לענן"
            if why.get("reason") == "pending"
            else "היא יכולה לסגור Z ללא חיבור ולא נראתה לאחרונה — ייתכן שיש בה דוחות Z שטרם סונכרנו"
        )
        raise _refuse(
            "device_profile_offline_zs", machine,
            f"{prefix}: {reason}. חברו את הקופה לרשת והמתינו לסנכרון, ואז נסו שוב.",
            **why,
        )


def check_model_change(db: Session, machine: POSMachine, new_model: Optional[str]) -> None:
    """Refuse a change of model unless the rules allow it now. The same model passes."""
    from app.services import transmissions

    if new_model == machine.device_model:
        return
    prefix = f"לא ניתן לשנות את הדגם של {_label(machine)}"
    check_clean_break(db, machine, prefix)
    loses_terminal = device_has_builtin_terminal(machine.device_model) and not device_has_builtin_terminal(new_model)
    if loses_terminal and transmissions.has_untransmitted(db, machine):
        raise _refuse(
            "device_profile_untransmitted", machine,
            f"{prefix}: יש בה עסקאות אשראי שטרם שודרו מהמסוף המובנה, והדגם החדש אינו כולל מסוף. "
            "שדרו קודם (\"שידור עכשיו\"), ואז נסו שוב.",
        )


def check_role_switch(db: Session, machine: POSMachine, role: str) -> None:
    """
    Refuse a change of role unless the rules allow it now. The same role passes. A till
    or kiosk never becomes a display device, nor back (409
    `device_role_change_requires_pairing`): remove it and add it again with a new code. A
    KDS and the board may trade places (both display devices).
    """
    from app.services.main_till import main_till_of_shop

    current = current_role(db, machine)
    if role == current:
        return
    if DD.is_fiscal_role(role) != DD.is_fiscal_role(current):
        raise DD.role_change_refusal(machine, current, role)
    if role in DD.NON_FISCAL_ROLES:
        return  # a screen's role: nothing fiscal on it to wait for
    label = _label(machine)
    if role == ROLE_KIOSK:
        prefix = f"לא ניתן להפוך את {label} לקיוסק"
        if not machine.is_active or machine.pairing_status != PairingStatus.ASSIGNED or machine.shop_id is None:
            raise _refuse(
                "device_profile_not_assigned", machine,
                f"{prefix}: קיוסק חייב להיות מכשיר פעיל ומשויך לסניף. שייכו אותו לסניף, ואז נסו שוב.",
            )
        main = main_till_of_shop(db, machine.shop_id)
        if main is not None and main.id == machine.id:
            raise _refuse(
                "device_profile_main_till", machine,
                f"{prefix}: היא הקופה הראשית של הסניף (שולחנות, שרת הדפסות ו-Z סניפי נשענים עליה). "
                "קבעו קופה ראשית אחרת בעמוד הסניף, ואז נסו שוב.",
            )
    else:
        prefix = f"לא ניתן להחזיר את {label} לקופה רגילה"
    check_clean_break(db, machine, prefix)


def change_model(machine: POSMachine, new_model: Optional[str]) -> bool:
    """Record the model the dashboard chose (the caller ran `check_model_change`)."""
    changed = new_model != machine.device_model
    machine.device_model = new_model
    machine.device_model_chosen = new_model
    return changed


class RoleChange:
    """What a change of role turned on, for the caller to tell the till after its commit."""

    def __init__(self, lock: bool = False, pinpad: bool = False):
        #: The device lock (`kioskMode`): `kiosk_control.notify_device_lock`.
        self.lock = lock
        #: The pinpad address in the till's own settings: `notify_settings`.
        self.pinpad = pinpad


def change_role(
    db: Session, user: User, machine: POSMachine, role: str, kiosk: Any = None, kds: Any = None,
) -> RoleChange:
    """
    Make the machine a kiosk (the kiosks page's conversion, with its controllers, device
    lock and — "מסופון חיצוני ברשת" — its pinpad address) or a regular till again (its
    orders and audit stay; the pinpad settings stay too); or a display device the KDS or
    the board (its screen row, `display_devices.change_display_role`). The caller ran
    `check_role_switch` and commits.
    """
    from app.services import kiosk_control

    if role in DD.NON_FISCAL_ROLES:
        DD.change_display_role(db, machine, role, kds)
        return RoleChange()
    device = kiosk_device(db, machine.id)
    if role == ROLE_KIOSK and device is None:
        lock = bool(getattr(kiosk, "lock_device", False))
        pinpad = clean_pinpad(machine, kiosk)  # 422 before anything changes
        try:
            kiosk_control.convert(
                db, user, machine,
                name=getattr(kiosk, "name", None),
                controller_ids=getattr(kiosk, "controller_machine_ids", None) or [],
                lock_device=lock,
            )
        except HTTPException as exc:
            if str(exc.detail).startswith("invalid_controller"):
                raise _refuse(
                    "invalid_controller", machine, INVALID_CONTROLLER_MESSAGE,
                    status.HTTP_422_UNPROCESSABLE_ENTITY, reason=str(exc.detail),
                ) from exc
            raise _refuse(
                str(exc.detail), machine,
                "לא ניתן להפוך את המכשיר לקיוסק: הוא כבר קיוסק, או שאינו משויך לסניף.",
            ) from exc
        set_kiosk_cache(machine, True)
        written = apply_pinpad(machine, *pinpad) if pinpad else False
        return RoleChange(lock=lock, pinpad=written)
    if role == ROLE_TILL and device is not None:
        kiosk_control.remove(db, device)
        set_kiosk_cache(machine, False)
    return RoleChange()
