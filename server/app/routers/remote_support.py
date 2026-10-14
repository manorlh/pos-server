"""
"תמיכה מרחוק" — the QuickSupport signer pin, the super admin's (app/services/remote_support.py,
P:/specs/quicksupport-autoinstall.md §2א).

GET  /remote-support/signer-pin[?machineId=]  → the global `remoteSupportSignerSha256`, where it came from
                                                 ("נקבע אוטומטית מהתקנה ראשונה": which till, when; confirmed;
                                                 set by hand), and one till's report against its own pin
POST /remote-support/signer-pin/confirm        → "אשר": the automatic pin kept, confirmed
                                                 (`{value?}`: 409 `remote_support_pin_changed` if it moved)
PUT  /remote-support/signer-pin                → "החלף" `{sha256}`, or "השתמש כטביעת האצבע המותרת"
                                                 `{fromMachineId}`: the till's reported fingerprint(s)

Every change of the value tells every active till to pull its parameters (Ably `settings`).
"""
from __future__ import annotations

import uuid
from typing import List, Optional, Union

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_super_admin
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.services import remote_support as RS
from app.services import till_parameters as TP

router = APIRouter(tags=["remote-support"])


def _machine(db: Session, machine_id: Optional[uuid.UUID]) -> Optional[POSMachine]:
    if machine_id is None:
        return None
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if machine is None:
        raise HTTPException(status_code=404, detail="machine_not_found")
    return machine


def _raise(exc: RS.PinError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.get("/remote-support/signer-pin")
def get_signer_pin(
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    TP.ensure_builtin_parameters(db)
    db.commit()  # `ensure_builtin_parameters` may have created them
    return RS.pin_out(db, _machine(db, machine_id))


class ConfirmIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The value the dashboard showed; when given, it must still be the pin.
    value: Optional[Union[str, List[str]]] = None


@router.post("/remote-support/signer-pin/confirm")
def confirm_signer_pin(
    body: Optional[ConfirmIn] = None,
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """`409 remote_support_pin_not_auto` when the pin is not the automatic one (or already confirmed)."""
    try:
        RS.confirm_pin(db, _admin, expected=body.value if body is not None else None)
    except RS.PinError as exc:
        _raise(exc)
    db.commit()
    return RS.pin_out(db)


class ReplaceIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The fingerprint(s): a comma list or a list; with or without colons, any case.
    sha256: Optional[Union[str, List[str]]] = None
    #: Or the till whose reported fingerprint(s) to use ("השתמש כטביעת האצבע המותרת").
    from_machine_id: Optional[uuid.UUID] = Field(None, alias="fromMachineId")


@router.put("/remote-support/signer-pin")
def replace_signer_pin(
    body: ReplaceIn,
    background_tasks: BackgroundTasks,
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """
    `422 remote_support_pin_source` (neither or both given), `422 remote_support_no_report` (the till
    reported no fingerprint), `422 <Hebrew>` (a fingerprint that is not 64 hex digits), `404`.
    """
    machine = _machine(db, body.from_machine_id)
    try:
        changed = RS.replace_pin(db, _admin, sha256=body.sha256, from_machine=machine)
    except RS.PinError as exc:
        _raise(exc)
    db.commit()
    if changed:
        background_tasks.add_task(TP.publish_parameters_notify, TP.notify_targets_for_all(db))
    return RS.pin_out(db, machine)
