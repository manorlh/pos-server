"""
Who may switch a till's Z mode ("Z בקופה" / "Z סניפי", `zMode`), and when — the owner's
rules on top of `app.services.till_z.set_z_mode`:

* **The super admin alone** (`403 super_admin_only`): the mode decides how the business
  reports its takings.
* **Over a clean break** (`409 till_open`): the till's shift is closed first, so its first
  Z of the new mode starts from nothing. `set_z_mode` adds the rest of the break — no
  closed shift waiting for a Z of the old mode (`unreported_shifts`), no Z under way.

A shop or a point of sale is switched as a whole (`PUT /shops/{id}/z-mode`): every till
of it, all or nothing, each by the same rules.
"""
from __future__ import annotations

from typing import Iterable, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.user import User, UserRole
from app.services import till_z
from app.services.till_z import TillZRefused


def check_switch(db: Session, user: User, machine: POSMachine, mode: Optional[str]) -> None:
    """Refuse a change of `machine`'s mode the rules forbid; the same mode again passes."""
    if mode is None or till_z.z_mode_of(machine) == mode:
        return
    if user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super_admin_only")
    # Up front, so a shop or point of sale switches all or nothing: never while a till may
    # hold Zs it closed with no connection (docs/SPEC_OFFLINE_TILL_Z.md §4.4).
    till_z.refuse_while_producing_offline(db, machine)
    if getattr(machine, "independent_till", False):
        # "קופה עצמאית" joins the shop Z only through the shop's card "קופות בזד הסניפי"
        # (app/services/independent_till.py), which also brings it back into the LAN group.
        raise TillZRefused(
            status.HTTP_409_CONFLICT,
            {
                "detail": "independent_till",
                "machineId": str(machine.id),
                "message": "הקופה מוגדרת כקופה עצמאית — מצרפים אותה ל-Z הסניפי בכרטיס \"קופות בזד הסניפי\" בדף הסניף.",
            },
        )
    open_shift = (
        db.query(Shift)
        .filter(Shift.machine_id == machine.id, Shift.status == ShiftStatus.OPEN)
        .first()
    )
    if open_shift is not None:
        raise TillZRefused(
            status.HTTP_409_CONFLICT,
            {"detail": "till_open", "machineId": str(machine.id), "shiftId": str(open_shift.id)},
        )


def switch_all(db: Session, user: User, machines: Iterable[POSMachine], mode: str) -> List[POSMachine]:
    """
    Switch every till to `mode` — all or nothing: the first refusal (any till) is raised
    before anything is written, with the till named. The tills that changed.
    """
    tills = list(machines)
    for machine in tills:
        try:
            check_switch(db, user, machine, mode)
        except TillZRefused as refused:
            refused.body.setdefault("machineId", str(machine.id))
            raise
    changed = []
    for machine in tills:
        try:
            if till_z.set_z_mode(db, machine, mode):
                changed.append(machine)
        except TillZRefused as refused:
            refused.body.setdefault("machineId", str(machine.id))
            raise
    return changed
