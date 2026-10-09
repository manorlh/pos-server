"""
"סגירת משמרת / הפקת Z מרחוק" from remote control ("שליטה מרחוק") — behind `REMOTE_TILL_Z_ENABLED`
(env, default off).

The safeguards (the owner's):

* **Never automatic.** Only a dashboard user who holds remote control and the Z section asks it,
  for one till, after confirming that till's current totals: the preview's `totalsKey` must still
  match when the request is made (a sale since then → 409 `totals_changed` with the new figures).
* **Only when no sale or card payment is open.** The request is the existing till-Z / shift-close
  request (app/services/till_z.py, app/services/shift_close_requests.py) with `wait_for_rest`: the
  till holds it while a basket, a payment screen or a card is open (a `deferred` ack) and runs it at
  rest. Never `force` — never closes mid-sale.
* **The till's existing Z flow.** A till in `zMode = till` closes its shift, transmits its card
  deals and asks the cloud for its Z number — strictly sequential in its run (z_sequence) — and
  prints; a till in the shop's Z (`zMode = cloud`) is offered a shift close only, its shift then
  waits for the shop's Z as any closed shift does. Kiosks keep their own path (kiosk_z).
"""
from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine

KIND_TILL_Z = "till_z"
KIND_CLOSE_SHIFT = "close_shift"
KIND_LABELS = {KIND_TILL_Z: "הפקת Z", KIND_CLOSE_SHIFT: "סגירת משמרת"}


def enabled() -> bool:
    return os.environ.get("REMOTE_TILL_Z_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")


def require_enabled() -> None:
    if not enabled():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "remote_till_z_off", "message": "סגירת משמרת / Z מרחוק עדיין לא פעילה"},
        )


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    return (value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)).isoformat()


def _money(value: Any) -> float:
    return float(value or 0)


def kind_of(machine: POSMachine) -> str:
    from app.services.till_z import Z_MODE_TILL, z_mode_of

    return KIND_TILL_Z if z_mode_of(machine) == Z_MODE_TILL else KIND_CLOSE_SHIFT


def _refuse_device(db: Session, machine: POSMachine) -> None:
    """A kiosk has its own Z path; a display device makes no Z; an unassigned till nothing."""
    from app.models.kiosk import KioskDevice

    if getattr(machine, "is_fiscal", True) is False:
        raise HTTPException(status_code=422, detail={"code": "not_fiscal", "message": "מכשיר תצוגה אינו מפיק Z"})
    if db.query(KioskDevice.machine_id).filter(KioskDevice.machine_id == machine.id).first() is not None:
        raise HTTPException(status_code=422, detail={"code": "kiosk_use_kiosks", "message": "קיוסק נסגר מלשונית הקיוסקים"})


def _shifts(db: Session, machine: POSMachine, kind: str) -> List[Any]:
    """What the request will take: a till Z — every shift of the till no Z took yet (in its shop);
    a shift close — the open shift."""
    from app.services.shifts import find_open_shift
    from app.services.z_builder import unreported_shifts

    if kind == KIND_TILL_Z:
        return list(unreported_shifts(db, machine.id, shop_id=machine.shop_id))
    open_shift = find_open_shift(db, machine.id)
    return [open_shift] if open_shift is not None else []


def _totals_out(totals: Any) -> Dict[str, Any]:
    net = _money(totals.total_sales) - _money(totals.total_refunds)
    return {
        "transactions": int(totals.transactions_count or 0),
        "sales": int(totals.sales_count or 0),
        "creditNotes": int(totals.credit_notes_count or 0),
        "totalSales": _money(totals.total_sales),
        "totalRefunds": _money(totals.total_refunds),
        "net": round(net, 2),
        "discounts": _money(totals.discounts_total),
        "tips": _money(totals.total_tips),
        "byTender": {k: _money(v) for k, v in sorted((totals.payment_breakdown or {}).items())},
        "firstDocument": totals.first_transaction_number,
        "lastDocument": totals.last_transaction_number,
    }


def _key(kind: str, shift_ids: List[Any], t: Dict[str, Any]) -> str:
    raw = "|".join([
        kind, ",".join(sorted(str(s) for s in shift_ids)), str(t["transactions"]),
        f'{t["totalSales"]:.2f}', f'{t["totalRefunds"]:.2f}', str(t["lastDocument"] or ""),
    ])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]


def _pending(db: Session, machine: POSMachine, kind: str) -> Optional[Dict[str, Any]]:
    from app.services import shift_close_requests as close_requests
    from app.services import till_z

    if kind == KIND_TILL_Z:
        rid = till_z.pending_by_machine(db, [machine.id]).get(machine.id)
        if rid is None:
            return None
        from app.models.till_z_request import TillZRequest

        req = db.get(TillZRequest, rid)
        return {"kind": kind, "id": str(req.id), "status": req.status, "errorCode": req.error_code,
                "waitForRest": bool(req.wait_for_rest), "createdAt": _iso(req.created_at)}
    req = close_requests.oldest_pending(db, machine)
    if req is None:
        return None
    return {"kind": kind, "id": str(req.id), "status": req.status, "errorCode": req.error_code,
            "waitForRest": bool(req.wait_for_rest), "createdAt": _iso(req.created_at)}


def preview(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """What the manager confirms: the till, what it will do, the figures it will close on."""
    from app.services.machine_status import is_online
    from app.services.shift_totals import compute_totals
    from app.services.z_sequence import last_machine_z_number

    _refuse_device(db, machine)
    kind = kind_of(machine)
    shifts = _shifts(db, machine, kind)
    open_shift = next((s for s in shifts if getattr(s, "closed_at", None) is None), None)
    totals = _totals_out(compute_totals(db, [s.id for s in shifts]))
    last = last_machine_z_number(db, machine.id) if kind == KIND_TILL_Z else None
    why = None
    if kind == KIND_CLOSE_SHIFT and open_shift is None:
        why = "אין משמרת פתוחה בקופה"
    elif kind == KIND_TILL_Z and not shifts:
        why = "אין משמרות שעוד לא נכללו ב-Z"
    elif kind == KIND_CLOSE_SHIFT and _local_mode(db, machine):
        why = LOCAL_MODE_SHIFT_TEXT
    elif too_old(machine):
        why = TOO_OLD_TEXT
    return {
        "machineId": str(machine.id),
        "name": machine.name,
        "posNumber": machine.pos_number,
        "online": is_online(machine.last_heartbeat_at, now=now),
        "kind": kind,
        "kindLabel": KIND_LABELS[kind],
        "openShift": {
            "id": str(open_shift.id),
            "openedAt": _iso(getattr(open_shift, "opened_at", None)),
            "openedBy": getattr(open_shift, "opened_by", None),
        } if open_shift is not None else None,
        "shiftsCount": len(shifts),
        "totals": totals,
        "lastZNumber": last,
        "nextZNumber": (last + 1) if last is not None else None,
        "pending": _pending(db, machine, kind),
        "totalsKey": _key(kind, [s.id for s in shifts], totals),
        "canRequest": why is None,
        "whyNot": why,
    }


# ── As a remote command: the shape of app/services/device_commands.command_out ─────────────────
#
# So the dashboard's shared status chip / "פקודות שנשלחו" tray shows these requests beside every
# other command sent to a device: {id, machineId, batchId, action, message, status, detail,
# source, createdBy, createdAt, deliveredAt, doneAt, expiresAt}, status one of the commands'
# (pending, delivered, done, refused, failed, cancelled, expired), `detail` the till's reason.

#: The actions as the commands' audit names them.
ACTION_CLOSE_SHIFT = "close_shift"
ACTION_TILL_Z = "till_z"
ACTION_SHOP_CLOSE = "shop_close"

_COMMAND_STATUS = {
    "waiting_close": "pending", "waiting": "pending",
    "closing": "delivered", "in_progress": "delivered",
    "ready": "done", "completed": "done",
    "failed": "failed", "expired": "expired",
    "cancelled": "cancelled", "excluded": "cancelled",
}


def as_command(
    *,
    id: Any,
    machine_id: Any,
    action: str,
    status_value: str,
    detail: Optional[str] = None,
    batch_id: Any = None,
    created_by: Optional[str] = None,
    created_at: Optional[datetime] = None,
    sent_at: Optional[datetime] = None,
    received_at: Optional[datetime] = None,
    done_at: Optional[datetime] = None,
    expires_at: Optional[datetime] = None,
) -> Dict[str, Any]:
    st = _COMMAND_STATUS.get(str(status_value), "pending")
    # Delivered = the till acknowledged it (a push sent is not yet a till that has it).
    if st == "pending" and received_at is not None:
        st = "delivered"
    return {
        "id": str(id),
        "machineId": str(machine_id),
        "batchId": str(batch_id) if batch_id else None,
        "action": action,
        "message": None,
        "status": st,
        "detail": detail,
        "source": "dashboard",
        "createdBy": created_by,
        "createdAt": _iso(created_at),
        "deliveredAt": _iso(received_at),
        "doneAt": _iso(done_at),
        "expiresAt": _iso(expires_at),
    }


def _request_command(kind: str, out: Dict[str, Any], user: Any) -> Dict[str, Any]:
    return as_command(
        id=out["id"], machine_id=out["machineId"],
        action=ACTION_TILL_Z if kind == KIND_TILL_Z else ACTION_CLOSE_SHIFT,
        status_value=out["status"], detail=out.get("errorCode"),
        created_by=getattr(user, "username", None) or getattr(user, "email", None),
        created_at=out.get("createdAt"), sent_at=out.get("sentAt"), received_at=out.get("receivedAt"),
        done_at=out.get("completedAt"), expires_at=out.get("expiresAt"),
    )


#: The first till build that honours `waitForRest` (pos-android feat/live-control c21f40d, the
#: merge carrying fab76fc onto the release line: 0.1.334). An older till would close mid-sale, so it
#: is never asked from remote control. `REMOTE_TILL_Z_MIN_TILL_VERSION` (a version code) raises it
#: to the release build that carries it.
MIN_WAIT_FOR_REST_VERSION_CODE = 334
TOO_OLD_TEXT = "הקופה צריכה עדכון גרסה לפני סגירה מרחוק"


def min_version_code() -> int:
    raw = (os.environ.get("REMOTE_TILL_Z_MIN_TILL_VERSION") or "").strip()
    return max(int(raw), MIN_WAIT_FOR_REST_VERSION_CODE) if raw.isdigit() else MIN_WAIT_FOR_REST_VERSION_CODE


def too_old(machine: POSMachine) -> bool:
    """The till never said its version, or its build predates `waitForRest`."""
    from app.services.cloud_card_refunds import till_version_code

    code = till_version_code(getattr(machine, "app_version", None))
    return code is None or code < min_version_code()


def who(user: Any) -> str:
    return getattr(user, "username", None) or getattr(user, "email", None) or str(getattr(user, "id", ""))


def _local_mode(db: Session, machine: POSMachine) -> bool:
    """The till's shop works in local mode (a main till closes its tills over the LAN)."""
    from app.models.shop import Shop
    from app.services.local_shop_z import local_mode_of_shop

    shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
    return shop is not None and local_mode_of_shop(db, shop)


#: Not yet from remote control: a shop whose tills the main till closes over the LAN.
LOCAL_MODE_SHIFT_TEXT = "לא זמין עדיין: ברשת מקומית המשמרות נסגרות דרך הקופה הראשית"


def request(db: Session, user: Any, machine: POSMachine, *, totals_key: str, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    The confirmed request: the figures still as confirmed, then the existing request with
    `wait_for_rest` (never `force`). The caller commits.
    """
    from app.services import shift_close_requests as close_requests
    from app.services import till_z

    current = preview(db, machine, now=now)
    if not current["canRequest"]:
        raise HTTPException(status_code=409, detail={"code": "nothing_to_close", "message": current["whyNot"], "preview": current})
    if not totals_key or totals_key != current["totalsKey"]:
        raise HTTPException(status_code=409, detail={
            "code": "totals_changed",
            "message": "הסכומים בקופה השתנו מאז שאושרו — בדקו שוב ואשרו",
            "preview": current,
        })
    if current["kind"] == KIND_TILL_Z:
        try:
            req, created = till_z.request_for_machine(db, user, machine, force=False, wait_for_rest=True, now=now)
        except till_z.TillZRefused as refused:
            raise HTTPException(status_code=refused.status_code, detail=refused.body)
        out = till_z.request_to_out(db, req, now=now)
    else:
        req, created = close_requests.request_close(db, user, machine, wait_for_rest=True, now=now)
        out = close_requests.request_to_out(db, req, now=now)
    return {"kind": current["kind"], "created": created, "request": out, "confirmed": current,
            "command": _request_command(current["kind"], out, user)}


# ── "סגירת יום סניפית": the shop's day close, by its configuration ────────────────────────────
#
# Driven entirely by what is configured (nothing decided here):
# * each till's `z_mode` — `cloud`: in the shop Z; `till`: its own Z (independent / "Z לכל
#   קופה"), never in the shop Z; a shop may be mixed;
# * where the shop Z is produced — the shop's effective producer and `shopZFrom` (local_shop_z,
#   main_till): the cloud (a Z run, numbered by z_sequence at the build), or the main till on
#   the LAN (its own round and numbering);
# * kiosks — in the shop Z as any till of `zMode = cloud`, or their own Z (kiosk_z), and the
#   "close with the shop Z" setting (kiosk_ops) — exactly as the run already does.
#
# Covered from remote control: the cloud producer — the existing Z run, started through the
# wizard's own path (routers/z_runs.create_run_from_body) with `wait_for_rest`. Not yet: a main
# till producer (its LAN round closes tills by itself) — shown "לא זמין עדיין" with why.

SHOP_CLOSE_LABEL = "סגירת יום סניפית"


def _kiosk_ids(db: Session, machines: List[POSMachine]) -> set:
    from app.models.kiosk import KioskDevice

    ids = [m.id for m in machines]
    if not ids:
        return set()
    return {r[0] for r in db.query(KioskDevice.machine_id).filter(KioskDevice.machine_id.in_(ids)).all()}


def _closes_with_shop_z(db: Session, machine: POSMachine) -> bool:
    try:
        from app.services import kiosk_config as KC

        return (KC.effective_config(db, machine).get("operations") or {}).get("closeWithShopZ") is True
    except Exception:  # noqa: BLE001 - shown only; the run decides as always
        return False


def _till_ref(m: POSMachine) -> str:
    return f"{m.name} ({m.pos_number})" if m.pos_number else (m.name or "")


def source_of(db: Session, shop: Any, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Where the shop Z is produced, in the owner's words, and whether remote control may start it."""
    from app.services import main_till as MT
    from app.services.local_shop_z import CLOUD, effective_producer

    producer = effective_producer(db, shop, now=now)
    refusal = MT.dashboard_z_refusal(db, shop)
    main = MT.main_till_of_shop(db, shop.id)
    if producer.kind != CLOUD or producer.configured_kind != CLOUD:
        machine = None
        mid = producer.machine_id or producer.configured_machine_id
        if mid:
            try:
                machine = db.get(POSMachine, uuid.UUID(str(mid)))
            except ValueError:
                machine = None
        name = _till_ref(machine) if machine is not None else (_till_ref(main) if main is not None else "")
        why = "לא זמין עדיין: ה-Z הסניפי מופק בקופה הראשית ברשת המקומית — הפיקו ממנה או בקשו ממנה מאשף ה-Z"
        if producer.handover is not None:
            why = "לא זמין כרגע: הפקת ה-Z הסניפי עוברת בין הקופה הראשית לענן — " + str(producer.handover.get("message") or "")
        return {"kind": "main_till", "label": f"יופק בקופה הראשית: {name}" if name else "יופק בקופה הראשית",
                "machineId": str(machine.id) if machine is not None else None, "available": False, "whyNot": why}
    if refusal is not None:
        name = _till_ref(main) if main is not None else ""
        return {"kind": "main_till", "label": f"יופק בקופה הראשית: {name}" if name else "יופק בקופה הראשית",
                "machineId": str(main.id) if main is not None else None, "available": False,
                "whyNot": "לא זמין עדיין: ה-Z הסניפי מופק בקופה הראשית בלבד (פרמטר \"Z סניפי — מאיפה מפיקים\") — הפיקו ממנה"}
    return {"kind": "cloud", "label": "יופק בענן", "machineId": None, "available": True, "whyNot": None}


def current_run(db: Session, shop_id: Any):
    """The shop's cloud Z run under way, if any — remote control's or the wizard's."""
    from app.models.z_run import ZRun, ZRunStatus

    return (
        db.query(ZRun)
        .filter(ZRun.shop_id == shop_id, ZRun.status.in_([ZRunStatus.WAITING, ZRunStatus.BUILDING]))
        .order_by(ZRun.created_at.desc())
        .first()
    )


def _super_admin(user: Any) -> bool:
    from app.models.user import UserRole

    return getattr(user, "role", None) == UserRole.SUPER_ADMIN


def run_progress(db: Session, run: Any, *, now: Optional[datetime] = None, user: Any = None) -> Dict[str, Any]:
    """The run as the wizard reads it, each till's state in the owner's words, and its outcome."""
    from app.models.z_run import ZRunStatus
    from app.services import z_runs as ZR

    out = ZR.run_to_out(db, run, now=now)
    by = None
    if getattr(run, "created_by_user_id", None) is not None:
        from app.models.user import User

        creator = db.get(User, run.created_by_user_id)
        by = (creator.username or creator.email) if creator is not None else None
    commands = []
    for item in out["items"]:
        item["words"] = item_words(item["status"], item["errorCode"], item.get("online"))
        # One command per till, the run its batch: the shared chip / tray reads these.
        commands.append(as_command(
            id=item["id"], machine_id=item["machineId"], batch_id=run.id, action=ACTION_SHOP_CLOSE,
            status_value=item["status"], detail=item["errorCode"], created_by=by,
            created_at=run.created_at, sent_at=item["sentAt"], received_at=item["receivedAt"],
            done_at=item["readyAt"], expires_at=run.expires_at,
        ))
    out["commands"] = commands
    # "בנה בלי הקופה" (the existing proceed_without) only where the configuration lets a till wait
    # for the next Z: never in local mode, never under "חובה לסגור את כל הקופות".
    required = ZR._all_tills_required(db, run) if run.status == ZRunStatus.WAITING else None
    out["leaveOutAllowed"] = run.status == ZRunStatus.WAITING and required is None
    out["leaveOutWhyNot"] = (
        "במצב רשת מקומית ה-Z הסניפי כולל את כל הקופות" if required == "local"
        else "בסניף מופעל \"חסימת Z כשיש משמרות פתוחות\"" if required == "shifts"
        else "בסניף מוגדר \"חובה לסגור את כל הקופות\"" if required
        else None
    )
    # Support's force past it (app/services/z_shift_guard.py): the super admin only, never local mode.
    out["forceAllowed"] = bool(required) and required != "local" and _super_admin(user)
    st = out["status"]
    out["words"] = (
        f"הושלם — Z סניפי מס' {out['zNumber']}" if st == ZRunStatus.COMPLETED and out.get("zNumber") is not None
        else "הושלם" if st == ZRunStatus.COMPLETED
        else "בוטל" if st == "cancelled"
        else "ממתין לקופות" if st == ZRunStatus.WAITING
        else "מפיק את ה-Z" if st == ZRunStatus.BUILDING
        else str(st)
    )
    return out


#: A run item's state in the owner's words ("ממתין למכירה פתוחה", "נסגר").
ITEM_WORDS = {
    "waiting_close": "ממתין לסגירה",
    "closing": "נסגר עכשיו",
    "ready": "נסגר",
    "excluded": "לא נכלל",
    "failed": "נכשל",
    "expired": "פג תוקף",
    "cancelled": "בוטל",
}
WAIT_WORDS = {
    "sale_open": "ממתין למכירה פתוחה",
    "payment_in_progress": "ממתין לסיום תשלום",
    "card_in_flight": "ממתין לעסקת אשראי",
    "printing": "ממתין למדפסת",
    "kiosk_ordering": "לקוח מזמין בקיוסק",
    "kiosk_paying": "לקוח משלם בקיוסק",
}


def item_words(status_value: str, error_code: Optional[str], online: Optional[bool]) -> str:
    if status_value in ("waiting_close", "closing"):
        if error_code in WAIT_WORDS:
            return WAIT_WORDS[error_code]
        if online is False:
            return "לא מחובר — ממתין שיתחבר"
    return ITEM_WORDS.get(status_value, status_value)


def shop_preview(db: Session, shop: Any, *, now: Optional[datetime] = None, user: Any = None) -> Dict[str, Any]:
    """
    What the manager sees for the shop: where its Z is produced, every device by its
    configuration (in the shop Z / its own Z / a kiosk), the figures the shop Z would take, the
    next shop Z number, the run under way (its progress per till), and which actions the
    configuration allows — each with why not, in Hebrew.
    """
    from app.services import kiosk_z
    from app.services import z_runs as ZR
    from app.services.close_progress import till_backlog
    from app.services.local_shop_z import local_mode_of_shop
    from app.services.shift_totals import compute_totals
    from app.services.z_sequence import last_shop_z_number

    from app.models.tenant import Tenant

    now = now or datetime.now(timezone.utc)
    tenant = db.get(Tenant, shop.tenant_id) if getattr(shop, "tenant_id", None) is not None else None
    # Exactly the tills the wizard's run takes: the seated ones, and any that left the shop with
    # closed shifts of it still awaiting a Z (z_runs.shop_tills) — their shifts are this shop's.
    tills = ZR.shop_tills(db, shop.id)
    kiosks = _kiosk_ids(db, tills)
    own_ids = ZR.per_till_ids(db, tills, tenant, shop)
    in_shop_z: List[Dict[str, Any]] = []
    own_z: List[Dict[str, Any]] = []
    shop_shift_ids: List[Any] = []
    local = source_of(db, shop, now=now)
    local_mode = local["kind"] == "main_till" and local_mode_of_shop(db, shop)
    for m in tills:
        seated = ZR.is_seated_in(m, shop.id)
        cand = ZR.till_candidates(db, m, shop.id)
        shifts = ([cand.open_shift] if cand.open_shift is not None else []) + list(cand.closed)
        row = {
            "machineId": str(m.id),
            "name": m.name,
            "posNumber": m.pos_number,
            "seated": seated,
            "isKiosk": m.id in kiosks,
            "kindLabel": kiosk_z.KIND_LABELS[kiosk_z.kind_of(m)],
            "openShift": cand.open_shift is not None,
            "shiftsAwaitingZ": len(shifts),
            "net": _totals_out(compute_totals(db, [x.id for x in shifts]))["net"] if shifts else 0.0,
            **till_backlog(m, now=now),
        }
        if m.id in own_ids:
            # Its own Z ("Z לכל קופה" / independent): never in the shop Z; its own remote Z.
            why = ("קיוסק — מלשונית הקיוסקים" if m.id in kiosks
                   else "הקופה אינה משויכת עוד לסניף" if not seated
                   else TOO_OLD_TEXT if too_old(m)
                   else None if shifts else "אין משמרות שעוד לא נכללו ב-Z")
            row["action"] = {"kind": KIND_TILL_Z, "label": "הפקת Z לקופה", "available": why is None, "whyNot": why}
            if m.id in kiosks:
                # "סגירה יחד עם ה-Z הסניפי" (kiosk_ops): the run asks it to close and make its own Z.
                row["closesWithShopZ"] = _closes_with_shop_z(db, m)
            own_z.append(row)
        else:
            shop_shift_ids.extend(x.id for x in shifts)
            why = ("קיוסק — מלשונית הקיוסקים" if m.id in kiosks
                   else "הקופה אינה משויכת עוד לסניף — משמרותיה הסגורות ייכללו ב-Z הסניפי" if not seated
                   else LOCAL_MODE_SHIFT_TEXT if local_mode
                   else TOO_OLD_TEXT if too_old(m)
                   else None if cand.open_shift is not None else "אין משמרת פתוחה")
            if seated and too_old(m):
                row["needsUpdate"] = True
            row["action"] = {"kind": KIND_CLOSE_SHIFT, "label": "סגירת משמרת", "available": why is None, "whyNot": why}
            in_shop_z.append(row)
    totals = _totals_out(compute_totals(db, shop_shift_ids))
    live = current_run(db, shop.id)
    run = run_progress(db, live, now=now, user=user) if live is not None else None
    if run is not None:
        by_machine = {str(r["machineId"]): r for r in in_shop_z}
        for item in run["items"]:
            row = by_machine.get(str(item["machineId"]))
            if row is not None:
                row["runItem"] = {"status": item["status"], "errorCode": item["errorCode"],
                                  "words": item_words(item["status"], item["errorCode"], item.get("online"))}
    why = None
    if not in_shop_z:
        why = "אין בסניף קופות ב-Z הסניפי (כל הקופות מפיקות Z משלהן)"
    elif ZR.z_scope_of(tenant) == ZR.Z_SCOPE_MACHINE and len(in_shop_z) > 1:
        # The business makes a Z per till (`zScope = machine`): one shop-wide close can't be one
        # Z. Not yet from remote control — the wizard does it till by till.
        why = "לא זמין עדיין: העסק מוגדר ל-Z נפרד לכל קופה — הפיקו מאשף ה-Z, קופה אחר קופה"
    elif not local["available"]:
        why = local["whyNot"]
    elif any(r.get("needsUpdate") for r in in_shop_z):
        names = ", ".join(r["name"] or "" for r in in_shop_z if r.get("needsUpdate"))
        why = f"{TOO_OLD_TEXT}: {names}"
    elif run is not None:
        why = "סגירת יום של הסניף כבר בתהליך"
    elif not shop_shift_ids:
        why = "אין משמרות שעוד לא נכללו ב-Z הסניפי"
    raw = "|".join([str(shop.id), ",".join(sorted(str(x) for x in shop_shift_ids)), str(totals["transactions"]),
                    f'{totals["totalSales"]:.2f}', f'{totals["totalRefunds"]:.2f}', str(totals["lastDocument"] or "")])
    return {
        "shopId": str(shop.id),
        "shopName": shop.name,
        "source": local,
        "inShopZ": in_shop_z,
        "ownZ": own_z,
        "totals": totals,
        "lastShopZNumber": last_shop_z_number(db, shop.id),
        "nextShopZNumber": last_shop_z_number(db, shop.id) + 1,
        "run": run,
        # "חסימת Z כשיש משמרות פתוחות": on here? and which tills hold the Z now (the close waits
        # for every one of them; only a super admin forces past one that never comes back).
        "shiftGuard": _guard_out(db, shop, now=now),
        "shopClose": {"label": SHOP_CLOSE_LABEL, "available": why is None, "whyNot": why},
        "totalsKey": hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20],
    }


def _guard_out(db: Session, shop: Any, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    from app.services import z_shift_guard as G

    required = G.required(db, shop)
    return {"label": G.LABEL, "required": required, "blockers": G.shop_blockers(db, shop, now=now) if required else []}


def shop_request(
    db: Session,
    user: Any,
    tenant_id: Any,
    shop: Any,
    *,
    totals_key: str,
    confirm_open_tills: bool = False,
    confirm_cloud_data: bool = False,
    now: Optional[datetime] = None,
):
    """
    The confirmed day close: the figures still as confirmed, then the shop's cloud Z run through
    the wizard's own path (the same refusals and confirmations), every till of the shop Z asked to
    close at rest (`wait_for_rest`, never forced). The Z is built by the run as always — numbered
    by z_sequence, strictly next. The caller commits. Returns the run or a refusal response.
    """
    from app.routers.z_runs import create_run_from_body
    from app.schemas.z_run import ZRunCreateIn, ZRunMachineIn
    from app.services import z_runs as ZR

    current = shop_preview(db, shop, now=now)
    if not current["shopClose"]["available"]:
        raise HTTPException(status_code=409, detail={"code": "shop_close_unavailable",
                                                     "message": current["shopClose"]["whyNot"], "preview": current})
    if not totals_key or totals_key != current["totalsKey"]:
        raise HTTPException(status_code=409, detail={
            "code": "totals_changed",
            "message": "הסכומים בסניף השתנו מאז שאושרו — בדקו שוב ואשרו",
            "preview": current,
        })
    body = ZRunCreateIn(
        shopId=shop.id,
        machines=[ZRunMachineIn(machineId=uuid.UUID(r["machineId"])) for r in current["inShopZ"]],
        confirmOpenTills=confirm_open_tills,
        confirmCloudData=confirm_cloud_data,
    )
    return create_run_from_body(db, user, tenant_id, body, wait_for_rest=True)
