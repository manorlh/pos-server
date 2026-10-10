"""
"חסימת Z כשיש משמרות פתוחות" — the owner: "פרמטר: אם כל המשמרות לא נסגרו — אל תאפשר לסגור זד.
לתמיכה: לאפשר לסופר אדמין לכפות סגירה, ואז המשמרת הבאה תיכנס לזד הבא (אם המכשיר לא נדלק וכו')".

The till parameter `zRequireAllShiftsClosed` (company → shop → area, default on). On, a shop Z is
never produced while a till in its scope has a shift open, or closed and not yet accepted by the
cloud:

* the cloud run (app/services/z_runs.py): a till may not be left out at the start, `proceed`
  ("build without") is refused, the expiry builds nothing without it, the master till's "סגור"
  is refused — `open_tills_rule` / `_all_tills_required` read it as "every till";
* the main till's local shop Z (the till applies it; it asks the cloud when it cannot know,
  `GET /sync/{machine}/z-shift-guard`);
* a till's own Z ("Z לכל קופה") is the till itself, and its own close is part of the Z: nothing
  else is in its scope. Support's Z for a dead till (app/services/support_z.py) is already the
  super admin's, with a reason and an audit, and closes the till's shifts itself.

Only a super admin forces a shop Z past it (`force_without`), with a typed reason: the run's
existing "build without" — the tills left out are recorded on the Z with who, when and why, and
their shifts, open or still on their way, go into the next Z of the shop (nothing is lost: an open
shift stays open, a closed one waits for the next Z, a late document is filed in its shift as
always — app/services/document_filing.py). Audited: a `shop_z_producer_forced` exception.

Ships behind REMOTE_TILL_Z_ENABLED with the remote shop close: while that flag is off, nothing
here applies and the tills get the parameter as off.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from fastapi import HTTPException, status
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine

logger = logging.getLogger(__name__)

KEY = "zRequireAllShiftsClosed"
LABEL = "חסימת Z כשיש משמרות פתוחות"

#: Registered with the till parameters (app/services/till_parameters.py).
PARAMETER_SPECS = (
    dict(
        key=KEY,
        label=LABEL,
        value_type="boolean",
        default_value=True,
        description=(
            "כשמופעל (ברירת המחדל): לא מפיקים Z סניפי כל עוד יש בסניף (או בנקודת המכירה) קופה עם משמרת "
            "פתוחה, או עם משמרת שנסגרה ועוד לא התקבלה בענן — לא מאשף ה-Z, לא מהקופה הראשית ולא מסגירת "
            "היום מרחוק, ואי אפשר להפיק \"בלי הקופה\". רק סופר אדמין (תמיכה) יכול לכפות הפקה, עם סיבה; "
            "המשמרות של הקופה שנשארה בחוץ ייכנסו ל-Z הבא. כשכבוי — כמו היום. "
            "נקבע לחברה, לסניף או לנקודת מכירה."
        ),
    ),
)

#: A blocking till's status, in the owner's words.
STATUS_OPEN = "open_shift"
STATUS_PENDING = "pending_acceptance"
#: Offline with no shift the cloud knows of: it may have opened one the cloud never saw.
STATUS_UNKNOWN = "unknown"
UNKNOWN_WORDS = "מצב לא ידוע — ייתכן שיש משמרת פתוחה"
#: Offline since a report that said no shift was open: never blocks (a shift it opened since, the
#: cloud unaware, is not lost — it reaches the next Z the ordinary way: its open report or first
#: document, then its close).
STATUS_OFFLINE_CLOSED = "offline_last_closed"
OFFLINE_CLOSED_WORDS = "לא מחובר — המשמרת האחרונה סגורה"
OFFLINE_CLOSED_WARNING = (
    "לא מחובר — המשמרת האחרונה שדיווח עליה סגורה. אם נפתחה בו משמרת בלי חיבור, המסמכים שלה ייכנסו ל-Z הבא."
)
STATUS_WORDS = {STATUS_OPEN: "משמרת פתוחה", STATUS_PENDING: "ממתין לקבלה", STATUS_UNKNOWN: UNKNOWN_WORDS}
OFFLINE_WORD = "מנותקת"

REFUSED_CODE = "z_requires_all_shifts_closed"
REFUSED_MESSAGE = (
    "בסניף מופעל \"חסימת Z כשיש משמרות פתוחות\": אי אפשר להפיק את ה-Z בלי קופה שלא נסגרה. "
    "סגרו אותה, או פנו לתמיכה (סופר אדמין) לכפיית הפקה."
)
MIN_REASON = 5


def flag_on() -> bool:
    from app.services import remote_till_z

    return remote_till_z.enabled()


def _value(db: Session, *, company_id: Any, shop_id: Any, area_id: Any = None) -> bool:
    """The parameter at the area (if any) → the shop → the company → its default (on)."""
    from app.models.till_parameter import TillParameter, TillParameterValue

    parameter = db.query(TillParameter).filter(TillParameter.key == KEY).first()
    if parameter is None:
        return True  # not registered yet: the owner's default
    if getattr(parameter, "is_active", True) is False:
        return False  # deactivated by a super admin: as today
    chain = [("area", area_id), ("shop", shop_id), ("company", company_id)]
    on_chain = [
        and_(TillParameterValue.scope_type == kind, TillParameterValue.scope_id == ident)
        for kind, ident in chain if ident is not None
    ]
    rows = (
        db.query(TillParameterValue)
        .filter(TillParameterValue.parameter_id == parameter.id, or_(*on_chain))
        .all()
        if on_chain else []
    )
    by_scope = {(r.scope_type, str(r.scope_id)): r.value for r in rows}
    for kind, ident in chain:
        if ident is not None and (kind, str(ident)) in by_scope and by_scope[(kind, str(ident))] is not None:
            return _truthy(by_scope[(kind, str(ident))])
    default = getattr(parameter, "default_value", True)
    return True if default is None else _truthy(default)


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in ("1", "true", "yes", "on", "כן")


def till_required(db: Session, machine: POSMachine) -> bool:
    """
    Must THIS till be closed (and accepted) for a Z to go ahead? Its own resolved value — till › area
    › shop › company › default (on), as every till parameter (till_parameters_for_machine). So a bar
    area with the rule on and a kitchen area with it off: an open bar till holds the shop Z, an open
    kitchen till is left for the next Z. Off with the release flag; unreadable: on (fail closed).
    """
    if machine is None or not flag_on():
        return False
    try:
        from app.models.till_parameter import TillParameter
        from app.services.till_parameters import till_parameters_for_machine

        if db.query(TillParameter.id).filter(TillParameter.key == KEY).first() is None:
            return True  # not registered yet: the owner's default
        value = till_parameters_for_machine(db, machine).parameters.get(KEY)
        return False if value is None else _truthy(value)  # absent: deactivated by a super admin
    except Exception:  # noqa: BLE001 - never breaks a run; logged, and read as ON (fail closed)
        logger.exception("zRequireAllShiftsClosed unreadable for till %s", getattr(machine, "id", None))
        return True


def required(db: Session, shop: Any, *, area_id: Any = None) -> bool:
    """
    Does the rule hold anywhere in this shop's Z (or this area's)? True when any of its tills has it
    on (each till decides for itself — `till_required`); with no tills, the shop's (area's) own value.
    """
    if shop is None or not flag_on():
        return False
    try:
        tills = _scoped(db, shop, area_id)
        if tills:
            return any(till_required(db, m) for m in tills)
        return _value(db, company_id=getattr(shop, "company_id", None), shop_id=shop.id, area_id=area_id)
    except Exception:  # noqa: BLE001 - never breaks a run; logged, and read as ON (fail closed)
        logger.exception("zRequireAllShiftsClosed unreadable for shop %s", getattr(shop, "id", None))
        return True


def till_status(db: Session, machine: POSMachine, shop_id: Any, *, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """
    Why this till blocks the Z, or None: a shift open (on the cloud or as the till reports it),
    or closed on the till and not yet accepted by the cloud (the cloud still holds it open while
    the till no longer does, or documents of it are still on their way).

    Offline, it blocks only when its state is unknown — it never reported, its last report had a
    shift open, or documents still to send (or did not say how many). Its last report said none
    was open and nothing was pending: `offline_last_closed`, shown, never blocking (`blocks: False`).
    """
    from app.services import z_runs as ZR
    from app.services.machine_status import is_online

    now = now or datetime.now(timezone.utc)
    cand = ZR.till_candidates(db, machine, shop_id)
    seated = ZR.is_seated_in(machine, shop_id)
    reported = getattr(machine, "reported_open_shift_id", None)
    reported_live = seated and ZR._reported_open_is_live(db, machine)
    pending_docs = (getattr(machine, "pending_documents", None) or 0) > 0
    state = None
    if cand.open_shift is not None:
        # The cloud holds it open: open on the till too — or closed there and not accepted yet
        # (the till reports another shift open, or none with documents still on their way).
        state = STATUS_OPEN
        if seated and reported is not None and str(reported) != str(cand.open_shift.id):
            state = STATUS_PENDING
        elif seated and reported is None and pending_docs:
            state = STATUS_PENDING
    elif reported_live:
        state = STATUS_OPEN
    elif cand.closed and pending_docs:
        state = STATUS_PENDING
    online = is_online(machine.last_heartbeat_at, now=now)
    if state is None and seated and not online:
        last_pending = getattr(machine, "pending_documents", None)
        if last_pending is None:
            last_pending = getattr(machine, "pending_count", None)
        if reported is None and last_pending == 0 and _closed_claim_trusted(db, machine):
            # Its last report: no shift open, and it went offline after it.
            return {"machineId": str(machine.id), "name": machine.name, "posNumber": machine.pos_number,
                    "status": STATUS_OFFLINE_CLOSED, "online": False, "words": OFFLINE_CLOSED_WORDS,
                    "blocks": False}
        state = STATUS_UNKNOWN  # never reported, or its last report had a shift open
    if state is None:
        return None
    words = STATUS_WORDS[state]
    if state == STATUS_UNKNOWN:
        return {"machineId": str(machine.id), "name": machine.name, "posNumber": machine.pos_number,
                "status": state, "online": online, "words": words, "blocks": True}
    return {
        "machineId": str(machine.id),
        "name": machine.name,
        "posNumber": machine.pos_number,
        "status": state,
        "online": online,
        "words": f"{OFFLINE_WORD} · {words}" if not online else words,
        "blocks": True,
    }


def _closed_claim_trusted(db: Session, machine: POSMachine) -> bool:
    """
    The till's "no shift open" is trusted only when the till itself said so after the last shift
    the cloud saw for it (opened or closed — an administrative close included): a claim older than
    that says nothing about now.
    """
    from sqlalchemy import func

    from app.models.shift import Shift

    claimed_at = getattr(machine, "reported_open_shift_claimed_at", None)
    if claimed_at is None:
        return False
    last_opened, last_closed = (
        db.query(func.max(Shift.opened_at), func.max(Shift.closed_at)).filter(Shift.machine_id == machine.id).one()
    )
    claimed = _aware(claimed_at)
    return all(t is None or claimed > _aware(t) for t in (last_opened, last_closed))


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def blockers(db: Session, shop: Any, machines: Iterable[POSMachine], *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    out = []
    for m in machines:
        found = till_status(db, m, shop.id, now=now)
        if found is not None and found["blocks"] and till_required(db, m):
            out.append(found)
    return out


def _scoped(db: Session, shop: Any, area_id: Any = None) -> List[POSMachine]:
    from app.models.tenant import Tenant
    from app.services import z_runs as ZR

    tills = ZR.shop_tills(db, shop.id)
    tenant = db.get(Tenant, shop.tenant_id) if getattr(shop, "tenant_id", None) is not None else None
    own = ZR.per_till_ids(db, tills, tenant, shop)
    return [m for m in tills if m.id not in own and (area_id is None or str(m.area_id) == str(area_id))]


def offline_closed(db: Session, shop: Any, machines: Iterable[POSMachine], *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """The tills offline since a report of no shift open: shown and warned of, never blocking."""
    out = []
    for m in machines:
        found = till_status(db, m, shop.id, now=now)
        if found is not None and found["status"] == STATUS_OFFLINE_CLOSED and till_required(db, m):
            out.append(found)
    return out


def shop_offline_closed(db: Session, shop: Any, *, area_id: Any = None, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    return offline_closed(db, shop, _scoped(db, shop, area_id), now=now)


def shop_blockers(db: Session, shop: Any, *, area_id: Any = None, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """The tills of the shop Z's scope (its own-Z tills never) that block it now."""
    return blockers(db, shop, _scoped(db, shop, area_id), now=now)


def unknown_at_start(db: Session, shop: Any, tills: Iterable[POSMachine], *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """The tills a Z start would take as "closed" that the cloud cannot see (STATUS_UNKNOWN)."""
    out = []
    for m in tills:
        found = till_status(db, m, shop.id, now=now)
        if found is not None and found["status"] == STATUS_UNKNOWN and till_required(db, m):
            out.append(found)
    return out


def refuse_or_force_start(db: Session, shop: Any, user: Any, unknown: List[Dict[str, Any]], force_reason: Optional[str]) -> Optional[str]:
    """
    At a Z's start, with the rule on: a till in "מצב לא ידוע" holds it (409) — unless a super
    admin forces with a typed reason (returned, to be recorded once the run exists).
    """
    if not unknown:
        return None
    if force_reason is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
            "code": REFUSED_CODE,
            "message": (
                f"בסניף מופעל \"{LABEL}\": מצב הקופות הבאות לא ידוע (לא מחוברות) וייתכן שיש בהן משמרת "
                "פתוחה — חברו אותן, או פנו לתמיכה (סופר אדמין) לכפיית הפקה."
            ),
            "tills": unknown,
            "canForce": True,
        })
    return check_force(user, force_reason)


def record_forced_start(db: Session, run: Any, user: Any, unknown: List[Dict[str, Any]], reason: str,
                        *, now: Optional[datetime] = None) -> None:
    from app.services.exceptions import Detector, Found

    now = now or datetime.now(timezone.utc)
    who = getattr(user, "username", None) or getattr(user, "email", None) or str(getattr(user, "id", ""))
    machine = db.get(POSMachine, uuid.UUID(unknown[0]["machineId"])) if unknown else None
    if machine is None:
        return
    Detector(db)._record(machine, Found(
        type=EXCEPTION_TYPE,
        key=f"z_forced_open_shifts:start:{run.id}",
        occurred_at=now,
        details={
            "kind": "forced_start_unknown_tills",
            "runId": str(run.id),
            "shopId": str(run.shop_id),
            "tills": unknown,
            "reason": reason,
            "forcedBy": who,
            "summary": f"Z סניפי הותחל בכפייה ע״י {who} בלי {len(unknown)} קופות במצב לא ידוע (\"{LABEL}\"): {reason}",
        },
    ))
    logger.warning("shop Z run %s started past unknown tills by %s: %s", run.id, who, reason)


def note_offline_closed(run: Any, tills: List[Dict[str, Any]], now: datetime) -> List[Any]:
    """
    Recorded on the run, and so on the Z (`openTillsLeftOut`, reason `offline_last_closed`): the
    tills offline since a report of no shift open that this Z went ahead without waiting for.
    """
    import json

    from app.models.z_run import ZRunItem, ZRunItemStatus
    from app.services.z_runs import LEFT_OUT_CODE

    rows = []
    for t in tills:
        rows.append(ZRunItem(
            id=uuid.uuid4(),
            run_id=run.id,
            machine_id=uuid.UUID(t["machineId"]),
            include_open_shift=False,
            status=ZRunItemStatus.EXCLUDED,
            error_code=LEFT_OUT_CODE,
            error_message=json.dumps({
                "id": t["machineId"], "posNumber": t["posNumber"], "name": t["name"], "openShiftId": None,
                "reason": STATUS_OFFLINE_CLOSED, "warning": OFFLINE_CLOSED_WARNING, "notedAt": now.isoformat(),
            }, ensure_ascii=False),
        ))
    return rows


# ── The super admin's force ───────────────────────────────────────────────────


def check_force(user: Any, reason: Optional[str]) -> str:
    """Only a super admin, and only with a typed reason (403 / 422)."""
    from app.models.user import UserRole

    if getattr(user, "role", None) != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={
            "code": "force_super_admin_only",
            "message": "רק סופר אדמין (תמיכה) יכול לכפות הפקת Z בלי קופה שלא נסגרה",
        })
    text = (reason or "").strip()
    if len(text) < MIN_REASON:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={
            "code": "force_reason_required",
            "message": "יש להקליד את סיבת הכפייה",
        })
    return text[:300]


def force_without(db: Session, run: Any, user: Any, exclude_machine_ids: Iterable[uuid.UUID], reason: Optional[str],
                  *, now: Optional[datetime] = None):
    """
    The super admin's force: the run's existing "build without", past this rule (never past
    local mode), each till left out recorded on the Z with who, when and why; audited.
    """
    from app.services import remote_till_z
    from app.services import z_runs as ZR

    remote_till_z.require_enabled()  # off: no force at all — everything exactly as before
    text = check_force(user, reason)
    who = getattr(user, "username", None) or getattr(user, "email", None) or str(getattr(user, "id", ""))
    excluded = set(exclude_machine_ids)
    run = ZR.lock_run(db, run)
    # Only "חסימת Z כשיש משמרות פתוחות" is forced past; "חובה לסגור את כל הקופות" and local mode
    # keep their own rules (proceed_without refuses them as always).
    if ZR._all_tills_required(db, run) != "shifts":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
            "code": "force_not_applicable",
            "message": f"אין מה לכפות: \"{LABEL}\" אינו מה שעוצר את ה-Z",
        })
    leaving = [i for i in run.items if i.machine_id in excluded and i.status != ZR.ZRunItemStatus.EXCLUDED
               and (i.status != ZR.ZRunItemStatus.READY or i.error_code == "waiting_documents"
                    or (run.strict_cloud_check and not ZR.verify_item(db, run, i).ok))]
    # The run's own clock (z_runs) decides expiry; `now` only when the caller gives one.
    run = ZR.proceed_without(db, run, excluded, now=now, deferred_by=f"{who} (תמיכה)", forced_reason=text)
    _record(db, run, leaving, who, text, now or datetime.now(timezone.utc))
    logger.warning("shop Z run %s forced past open shifts by %s: %s (left out %s)",
                   run.id, who, text, [str(i.machine_id) for i in leaving])
    return run


#: Its own record ("Z סניפי הופק בכפייה בלי קופות שלא נסגרו"), never switched off by a tenant's rules.
EXCEPTION_TYPE = "z_forced_open_shifts"


def _record(db: Session, run: Any, leaving: List[Any], who: str, reason: str, now: datetime) -> None:
    from app.services.exceptions import Detector, Found

    machine = next((i.machine for i in leaving if i.machine is not None), None)
    if machine is None:
        return
    tills = [
        {"machineId": str(i.machine_id), "name": i.machine.name if i.machine else None,
         "posNumber": i.machine.pos_number if i.machine else None, "status": i.status, "errorCode": i.error_code}
        for i in leaving
    ]
    detector = Detector(db)
    detector._record(machine, Found(
        type=EXCEPTION_TYPE,
        key=f"z_forced_open_shifts:{run.id}",
        occurred_at=now,
        details={
            "kind": "forced_past_open_shifts",
            "runId": str(run.id),
            "shopId": str(run.shop_id),
            "zReportId": str(run.z_report_id) if run.z_report_id else None,
            "tills": tills,
            "reason": reason,
            "forcedBy": who,
            "summary": (
                f"Z סניפי הופק בכפייה ע״י {who} בלי {len(tills)} קופות שלא נסגרו "
                f"(\"{LABEL}\"): {reason}"
            ),
        },
    ))
