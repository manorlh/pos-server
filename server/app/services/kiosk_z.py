"""
A kiosk's shift and Z by its Z mode — "סגירת משמרת" or "הפקת Z" (docs/SPEC_KIOSK.md §25).

The owner: "אם הקיוסק הוא חלק זד עצמאי אז תאפשר להפיק זד כמו שמופיע בקופה וגם בענן, אבל אם הוא
חלק מסניפי אז תאפשר לסגור משמרת."

**The mode, per device.** A kiosk is a till (`kiosk_devices` on a `pos_machines` row), so its
mode is decided exactly as any till's (app/services/independent_till.py `role_of`): the shop's
Z mode, overridden per machine ("לדרוס") by the independent flag — set on the shop page's
"קופות בזד הסניפי" card, kiosks listed there like any till:

* ``shop`` — part of the shop Z (``z_mode = cloud``). Offered **"סגירת משמרת"** only: the
  existing remote close (`shift_close_requests`, the `close-shift` event and `pendingCloseShift`),
  after which the closed shift waits for the shop's next Z and goes in as the kiosk's part.
  "הפקת Z" for it is refused (`422 machine_not_till_z`, with why, in Hebrew).
* ``independent`` — "Z עצמאי" (``independent_till``, always ``z_mode = till``): its own Z in its
  own run (Z 1 on a new run, never renumbered). Offered **"הפקת Z"**: the existing till-Z
  request (`till_z.request_for_machine`, the `till-z` event and `pendingTillZ`) — the kiosk
  waits for any payment, closes its shift, transmits its card deals, asks the cloud for the
  number and prints. A bare "סגירת משמרת" is not offered for it (`409 kiosk_makes_own_z`): a
  shift close is not its Z.
* ``own`` — the shop's "Z לכל קופה" (``z_mode = till``, not independent): as ``independent``.

**Never during a payment.** The kiosk itself holds a close or a Z while a customer orders or
pays (the till's `deferred` ack, `kiosk_paying` / `kiosk_ordering`); the cloud keeps offering
the request and the kiosk beats fast while it waits (`fast_beat`), so it runs the moment the
customer is done. The state each screen shows (`shiftClose` / `tillZRequest` on the kiosk's
summary) says so: queued (the kiosk is offline), sent, waiting for the payment / the customer,
closing / producing, closed / Z N, failed and why.

**Where the Z prints.** On the kiosk, as any till's Z — or, when a controlling till of the
kiosk's shop asked with ``message = "print:controller"``, on that till: the kiosk is told so
in the till-Z answer (`printOn`) and does not print; the controlling till prints the Z from
the cloud's document once it is in.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

from fastapi import status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine

KIND_SHOP = "shop"
KIND_INDEPENDENT = "independent"
KIND_OWN = "own"

#: How each list shows the kiosk's mode.
KIND_LABELS = {KIND_SHOP: "Z סניפי", KIND_INDEPENDENT: "Z עצמאי", KIND_OWN: "Z לכל קופה"}

ACTION_CLOSE_SHIFT = "close_shift"
ACTION_TILL_Z = "till_z"

#: A till Z command's message when the controlling till prints the Z itself.
PRINT_ON_CONTROLLER = "print:controller"

#: How far back a request still shows on the kiosk's summary.
STATE_WINDOW = timedelta(hours=36)
#: A kiosk's own last report counts as "now" for this long (it syncs every ~15 s).
LIVE_STATUS_WINDOW = timedelta(minutes=2)
#: A kiosk beats fast for this long after a close or a Z was asked of it.
FAST_BEAT_WINDOW = timedelta(minutes=15)

#: The deferral codes a kiosk answers while a customer holds it (and the till's own).
PAYING_CODES = ("kiosk_paying", "card_in_flight")
ORDERING_CODES = ("kiosk_ordering",)

#: The kiosk's `flowState` values that hold a close or a Z.
PAYING_FLOWS = ("paying",)
ORDERING_FLOWS = ("ordering", "success")

#: Why a close or a Z failed, as the screens say it.
FAILURE_TEXTS = {
    "no_open_shift": "אין משמרת פתוחה בקיוסק",
    "open_tables": "יש שולחנות פתוחים בקיוסק",
    "shift_changed": "המשמרת בקיוסק השתנתה — לא נסגר דבר",
    "unknown_shift": "המשמרת שנתבקשה כבר לא פתוחה בקיוסק",
    "shift_belongs_to_another_machine": "המשמרת שייכת למכשיר אחר",
    "expired": "הקיוסק לא ענה בזמן — הבקשה פגה",
    "cancelled": "הבקשה בוטלה",
    "till_z_disabled": "הקיוסק לא מפיק Z משלו",
    "z_run_in_progress": "יש Z סניפי בתהליך שכולל את הקיוסק",
    "shift_of_another_machine": "משמרת של מכשיר אחר",
}


def _now(now: Optional[datetime]) -> datetime:
    return now or datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value


def _iso(value: Optional[datetime]) -> Optional[str]:
    value = _aware(value)
    return value.isoformat() if value is not None else None


# ── The mode ─────────────────────────────────────────────────────────────────


def kind_of(machine: Optional[POSMachine]) -> str:
    """`shop` | `independent` | `own` — the till's role, decided per device (the override included)."""
    from app.services import independent_till as IT

    if machine is None:
        return KIND_SHOP
    return {
        IT.ROLE_INDEPENDENT: KIND_INDEPENDENT,
        IT.ROLE_OWN_Z: KIND_OWN,
    }.get(IT.role_of(machine), KIND_SHOP)


def makes_own_z(machine: Optional[POSMachine]) -> bool:
    return kind_of(machine) != KIND_SHOP


def action_of(kind: str) -> str:
    """The one shift / Z action a kiosk of [kind] is offered."""
    return ACTION_CLOSE_SHIFT if kind == KIND_SHOP else ACTION_TILL_Z


def _name(machine: POSMachine, device_name: Optional[str] = None) -> str:
    return (device_name or machine.name or "הקיוסק").strip() or "הקיוסק"


def check_action(machine: POSMachine, action: str, *, device_name: Optional[str] = None) -> None:
    """
    Refuse the shift / Z action the kiosk's mode does not offer (the wording matches the mode
    everywhere). `close_shift` on a kiosk that makes its own Z → 409 `kiosk_makes_own_z`;
    `till_z` on a shop-Z kiosk → 422 `machine_not_till_z` (the existing code, now with why).
    Anything else passes.
    """
    from app.services.kiosk_control import KioskCommandRefused
    from app.services.till_z import TillZRefused

    if action not in (ACTION_CLOSE_SHIFT, ACTION_TILL_Z):
        return
    kind = kind_of(machine)
    name = _name(machine, device_name)
    if action == ACTION_CLOSE_SHIFT and kind != KIND_SHOP:
        raise KioskCommandRefused(
            status.HTTP_409_CONFLICT, "kiosk_makes_own_z",
            f"{name} מפיק Z משלו ({KIND_LABELS[kind]}) — השתמשו ב\"הפקת Z\": ה-Z סוגר את המשמרת בעצמו. "
            "סגירת משמרת לבדה אינה ה-Z שלו.",
        )
    if action == ACTION_TILL_Z and kind == KIND_SHOP:
        raise TillZRefused(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {
                "detail": "machine_not_till_z",
                "machineId": str(machine.id),
                "message": (
                    f"{name} חלק מה-Z הסניפי — אין לו Z משלו. השתמשו ב\"סגירת משמרת\": "
                    "המשמרת תיכלל ב-Z הסניפי הבא."
                ),
            },
        )


def requires_manager(machine: POSMachine, action: str) -> bool:
    """From a controlling till, a kiosk's Z needs a manager (a PIN on that till), like a lock."""
    return action == ACTION_TILL_Z and makes_own_z(machine)


def require_manager_for_z(db: Session, till: POSMachine, pos_user_id: Optional[str]) -> Any:
    """`kiosk_control.require_till_manager`, said for a Z. Raises KioskCommandRefused (403)."""
    from app.services.kiosk_control import KioskCommandRefused, require_till_manager

    try:
        return require_till_manager(db, till, pos_user_id)
    except KioskCommandRefused as refused:
        raise KioskCommandRefused(
            refused.status_code, refused.body["detail"],
            "הפקת Z לקיוסק דורשת אישור מנהל הסניף (קוד מנהל בקופה).",
        ) from refused


# ── The state of the last close / Z, for every screen ────────────────────────


def _live_flow(status_report: Any, synced_at: Optional[datetime], now: datetime) -> Optional[str]:
    """The kiosk's own `flowState`, when its last report is recent enough to mean now."""
    if not isinstance(status_report, dict):
        return None
    synced = _aware(synced_at)
    if synced is None or now - synced > LIVE_STATUS_WINDOW:
        return None
    flow = status_report.get("flowState")
    return flow if isinstance(flow, str) else None


def _held_state(code: Optional[str], flow: Optional[str]) -> Optional[str]:
    if code in PAYING_CODES or flow in PAYING_FLOWS:
        return "waiting_payment"
    if code in ORDERING_CODES or flow in ORDERING_FLOWS:
        return "waiting_customer"
    return None


def _failure_text(code: Optional[str], message: Optional[str]) -> Optional[str]:
    if code and code.split(":")[0] in FAILURE_TEXTS:
        return FAILURE_TEXTS[code.split(":")[0]]
    return (message or code or None) and str(message or code)[:300]


STATE_TEXTS = {
    "queued": "הקיוסק לא מחובר — הבקשה ממתינה ותבוצע כשיתחבר",
    "sent": "הבקשה נשלחה לקיוסק",
    "waiting_payment": "ממתין לסיום תשלום בקיוסק",
    "waiting_customer": "ממתין — לקוח באמצע הזמנה בקיוסק",
    "closing": "הקיוסק סוגר את המשמרת…",
    "producing": "הקיוסק מפיק את ה-Z…",
    "closed": "המשמרת נסגרה ✓ — תיכלל ב-Z הסניפי הבא",
    "nothing": "אין מה לדווח — אין משמרות שלא נכללו ב-Z",
    "expired": "הקיוסק לא ענה בזמן — הבקשה פגה",
    "cancelled": "הבקשה בוטלה",
}


def _pending_state(sent_at, received_at, online: bool, code: Optional[str], flow: Optional[str], working: str) -> str:
    held = _held_state(code, flow)
    if held is not None:
        return held
    if received_at is not None:
        return working
    if not online:
        return "queued"
    return "sent" if sent_at is not None else "queued"


def shift_close_out(req: Any, machine: POSMachine, *, flow: Optional[str], now: datetime) -> Dict[str, Any]:
    """One `ShiftCloseRequest` as the screens show it."""
    from app.models.shift_close_request import PENDING_CLOSE_REQUEST_STATUSES
    from app.services.machine_status import is_online
    from app.services.shift_close_requests import named_shift_id

    pending = req.status in PENDING_CLOSE_REQUEST_STATUSES
    detail = None
    if pending:
        state = _pending_state(
            req.sent_at, req.received_at, is_online(machine.last_heartbeat_at, now=now),
            req.error_code, flow, "closing",
        )
    elif req.status == "completed":
        state = "closed"
    elif req.status in ("expired", "cancelled"):
        state = req.status
    else:
        state = "failed"
        detail = _failure_text(req.error_code, req.error_message)
    shift_id = named_shift_id(req)
    return {
        "id": str(req.id),
        "state": state,
        "status": req.status,
        "pending": pending,
        "errorCode": req.error_code,
        "detail": detail,
        "message": (f"לא נסגרה: {detail}" if state == "failed" and detail else STATE_TEXTS.get(state, state)),
        "shiftId": str(shift_id) if shift_id else None,
        "requestedAt": _iso(req.created_at),
        "finishedAt": _iso(req.completed_at or req.failed_at),
    }


def till_z_out(
    req: Any, machine: POSMachine, *, flow: Optional[str], now: datetime,
    print_on: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """One `TillZRequest` as the screens show it (with the Z's number once it is in)."""
    from app.models.till_z_request import PENDING_TILL_Z_STATUSES
    from app.services.machine_status import is_online

    pending = req.status in PENDING_TILL_Z_STATUSES
    detail = None
    number = None
    if pending:
        state = _pending_state(
            req.sent_at, req.received_at, is_online(machine.last_heartbeat_at, now=now),
            req.error_code, flow, "producing",
        )
    elif req.status == "completed":
        z = req.z_report if req.z_report_id is not None else None
        number = z.machine_sequence_number if z is not None else None
        state = "done" if req.z_report_id is not None else "nothing"
    elif req.status in ("expired", "cancelled"):
        state = req.status
    else:
        state = "failed"
        detail = _failure_text(req.error_code, req.error_message)
    if state == "done":
        message = f"Z מס׳ {number} הופק ✓" if number is not None else "ה-Z הופק ✓"
    elif state == "failed":
        message = f"ה-Z לא הופק: {detail}" if detail else "ה-Z לא הופק"
    else:
        message = STATE_TEXTS.get(state, state)
    return {
        "id": str(req.id),
        "state": state,
        "status": req.status,
        "pending": pending,
        "errorCode": req.error_code,
        "detail": detail,
        "message": message,
        "zReportId": str(req.z_report_id) if req.z_report_id else None,
        "zNumber": number,
        "force": bool(getattr(req, "force_close", False)),
        "printOn": (print_on or {}).get("printOn", "kiosk"),
        "printOnMachineId": (print_on or {}).get("machineId"),
        "requestedAt": _iso(req.created_at),
        "finishedAt": _iso(req.completed_at or req.failed_at),
    }


def _latest_by_machine(rows: Iterable[Any]) -> Dict[Any, Any]:
    out: Dict[Any, Any] = {}
    for row in rows:
        best = out.get(row.machine_id)
        if best is None or (_aware(row.created_at) or datetime.min.replace(tzinfo=timezone.utc)) >= (
            _aware(best.created_at) or datetime.min.replace(tzinfo=timezone.utc)
        ):
            out[row.machine_id] = row
    return out


def print_targets(db: Session, request_ids: Sequence[Any]) -> Dict[str, Dict[str, Any]]:
    """
    Per till-Z request: printed on a controlling till rather than the kiosk — when that till
    asked with `print:controller` and is a till of the kiosk's own shop (it can read the Z).
    """
    from app.models.kiosk import KioskCommand

    ids = [r for r in request_ids if r is not None]
    if not ids:
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    rows = (
        db.query(KioskCommand)
        .filter(
            KioskCommand.request_id.in_(ids),
            KioskCommand.action == ACTION_TILL_Z,
            KioskCommand.message == PRINT_ON_CONTROLLER,
            KioskCommand.requested_by_machine_id.isnot(None),
        )
        .order_by(KioskCommand.created_at)
        .all()
    )
    for row in rows:
        kiosk = db.get(POSMachine, row.kiosk_machine_id)
        till = db.get(POSMachine, row.requested_by_machine_id)
        if kiosk is None or till is None or till.shop_id is None or str(till.shop_id) != str(kiosk.shop_id):
            continue
        out[str(row.request_id)] = {"printOn": "controller", "machineId": str(till.id), "name": till.name}
    return out


def summary_fields(
    db: Session, devices: Sequence[Any], machines: Dict[Any, POSMachine], *, now: Optional[datetime] = None,
) -> Dict[Any, Dict[str, Any]]:
    """
    Per kiosk: its mode (`zKind`, `zKindLabel`, `independentTill`), the one action it is
    offered (`zAction`), and the last close / Z asked of it (`shiftClose`, `tillZRequest`,
    the last 36 h). Batched: two queries for the lot.
    """
    from app.models.shift_close_request import ShiftCloseRequest
    from app.models.till_z_request import TillZRequest

    now = _now(now)
    ids = [d.machine_id for d in devices if d.machine_id in machines]
    if not ids:
        return {}
    since = now - STATE_WINDOW
    closes = _latest_by_machine(
        db.query(ShiftCloseRequest)
        .filter(ShiftCloseRequest.machine_id.in_(ids), ShiftCloseRequest.created_at >= since)
        .all()
    )
    zs = _latest_by_machine(
        db.query(TillZRequest).filter(TillZRequest.machine_id.in_(ids), TillZRequest.created_at >= since).all()
    )
    targets = print_targets(db, [r.id for r in zs.values()])
    out: Dict[Any, Dict[str, Any]] = {}
    for device in devices:
        machine = machines.get(device.machine_id)
        if machine is None:
            continue
        kind = kind_of(machine)
        flow = _live_flow(getattr(device, "status", None), getattr(device, "last_kiosk_sync_at", None), now)
        close = closes.get(machine.id)
        z = zs.get(machine.id)
        out[device.machine_id] = {
            "zKind": kind,
            "zKindLabel": KIND_LABELS[kind],
            "independentTill": bool(getattr(machine, "independent_till", False)),
            "zAction": action_of(kind),
            "shiftClose": shift_close_out(close, machine, flow=flow, now=now) if close is not None else None,
            "tillZRequest": (
                till_z_out(z, machine, flow=flow, now=now, print_on=targets.get(str(z.id))) if z is not None else None
            ),
        }
    return out


# ── The kiosk's side ─────────────────────────────────────────────────────────


def fast_beat(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> bool:
    """
    Should this kiosk beat every few seconds? While a close or a Z asked of it in the last
    minutes is still pending — so one held by a customer runs the moment they are done.
    """
    from app.models.kiosk import KioskDevice
    from app.models.shift_close_request import PENDING_CLOSE_REQUEST_STATUSES, ShiftCloseRequest
    from app.models.till_z_request import PENDING_TILL_Z_STATUSES, TillZRequest

    now = _now(now)
    if db.get(KioskDevice, machine.id) is None:
        return False
    since = now - FAST_BEAT_WINDOW
    close = (
        db.query(ShiftCloseRequest.id)
        .filter(
            ShiftCloseRequest.machine_id == machine.id,
            ShiftCloseRequest.status.in_(PENDING_CLOSE_REQUEST_STATUSES),
            ShiftCloseRequest.created_at >= since,
        )
        .first()
    )
    if close is not None:
        return True
    z = (
        db.query(TillZRequest.id)
        .filter(
            TillZRequest.machine_id == machine.id,
            TillZRequest.status.in_(PENDING_TILL_Z_STATUSES),
            TillZRequest.created_at >= since,
        )
        .first()
    )
    return z is not None


def till_z_answer_extra(db: Session, machine: POSMachine, body: Any) -> Dict[str, Any]:
    """
    Added to the kiosk's `POST /sync/{m}/till-z` answer: `printOn: "controller"` (and who)
    when the Z it answers was asked by a controlling till that prints it itself. Nothing
    otherwise — every other till prints its Z as always.
    """
    request_id = getattr(body, "till_z_request_id", None)
    if request_id is None:
        return {}
    try:
        target = print_targets(db, [request_id]).get(str(request_id))
    except Exception:  # noqa: BLE001 - a hint never fails the Z
        return {}
    if target is None:
        return {}
    return {"printOn": "controller", "printOnMachineId": target["machineId"], "printOnName": target["name"]}


def kiosk_machine_ids(db: Session, machine_ids: Iterable[Any]) -> List[uuid.UUID]:
    """Which of these machines are kiosks."""
    from app.models.kiosk import KioskDevice

    ids = [m for m in machine_ids if m is not None]
    if not ids:
        return []
    return [row[0] for row in db.query(KioskDevice.machine_id).filter(KioskDevice.machine_id.in_(ids)).all()]
