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
STATUS_WORDS = {STATUS_OPEN: "משמרת פתוחה", STATUS_PENDING: "ממתין לקבלה"}
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


def required(db: Session, shop: Any, *, area_id: Any = None) -> bool:
    """Does a Z of this shop (or of this area of it) need every till's shifts closed and accepted?"""
    if shop is None or not flag_on():
        return False
    try:
        return _value(db, company_id=getattr(shop, "company_id", None), shop_id=shop.id, area_id=area_id)
    except Exception:  # noqa: BLE001 - a rule read never breaks a run; logged, read as off
        logger.exception("zRequireAllShiftsClosed unreadable for shop %s", getattr(shop, "id", None))
        return False


def till_status(db: Session, machine: POSMachine, shop_id: Any, *, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """
    Why this till blocks the Z, or None: a shift open (on the cloud or as the till reports it),
    or closed on the till and not yet accepted by the cloud (the cloud still holds it open while
    the till no longer does, or documents of it are still on their way).
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
    if state is None:
        return None
    online = is_online(machine.last_heartbeat_at, now=now)
    words = STATUS_WORDS[state]
    return {
        "machineId": str(machine.id),
        "name": machine.name,
        "posNumber": machine.pos_number,
        "status": state,
        "online": online,
        "words": f"{OFFLINE_WORD} · {words}" if not online else words,
    }


def blockers(db: Session, shop: Any, machines: Iterable[POSMachine], *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    out = []
    for m in machines:
        found = till_status(db, m, shop.id, now=now)
        if found is not None:
            out.append(found)
    return out


def shop_blockers(db: Session, shop: Any, *, area_id: Any = None, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """The tills of the shop Z's scope (its own-Z tills never) that block it now."""
    from app.models.tenant import Tenant
    from app.services import z_runs as ZR

    tills = ZR.shop_tills(db, shop.id)
    tenant = db.get(Tenant, shop.tenant_id) if getattr(shop, "tenant_id", None) is not None else None
    own = ZR.per_till_ids(db, tills, tenant, shop)
    scoped = [m for m in tills if m.id not in own and (area_id is None or str(m.area_id) == str(area_id))]
    return blockers(db, shop, scoped, now=now)


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
    from app.services import z_runs as ZR

    text = check_force(user, reason)
    who = getattr(user, "username", None) or getattr(user, "email", None) or str(getattr(user, "id", ""))
    excluded = set(exclude_machine_ids)
    leaving = [i for i in run.items if i.machine_id in excluded
               and i.status not in (ZR.ZRunItemStatus.EXCLUDED, ZR.ZRunItemStatus.READY)]
    # The run's own clock (z_runs) decides expiry; `now` only when the caller gives one.
    run = ZR.proceed_without(db, run, excluded, now=now, deferred_by=f"{who} (תמיכה)", forced_reason=text)
    _record(db, run, leaving, who, text, now or datetime.now(timezone.utc))
    logger.warning("shop Z run %s forced past open shifts by %s: %s (left out %s)",
                   run.id, who, text, [str(i.machine_id) for i in leaving])
    return run


def _record(db: Session, run: Any, leaving: List[Any], who: str, reason: str, now: datetime) -> None:
    from app.services.local_shop_z import FORCED_EXCEPTION, _record_safely

    machine = next((i.machine for i in leaving if i.machine is not None), None)
    if machine is None:
        return
    tills = [
        {"machineId": str(i.machine_id), "name": i.machine.name if i.machine else None,
         "posNumber": i.machine.pos_number if i.machine else None, "status": i.status, "errorCode": i.error_code}
        for i in leaving
    ]
    _record_safely(
        db, machine,
        exception_type=FORCED_EXCEPTION,
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
    )
