"""
"צימוד מסוף SynqPay" — the till pairs with its terminal (docs/SPEC_SYNQPAY.md §2.2).

Nobody types an API key: the till sends `pair` with the terminal's serial number, the terminal
shows a 6-digit code for 30 seconds, the code typed at the till goes back in `authenticate`, and
the terminal answers with the key. The till keeps it (encrypted) and uses it at once, then sends
it here, so it survives a reinstall and the next settings sync hands the same key back.

Till (machine JWT):

POST /sync/{m}/synqpay/pairing       → `{synqpayApiKey, serialNumber?}`: stored encrypted on the
                                       machine's own layer (`payment_integration_secrets`), with
                                       when, by which till and on whose authority. A manager's
                                       write, like adding a printer from the till: a signed-in
                                       manager (`X-Pos-User-Id`) or a manager's grant
                                       (`X-Elevation-Token`). 409 `not_synqpay` when the till does
                                       not charge on an external SynqPay terminal. The answer
                                       never carries the key.
POST /sync/{m}/synqpay/key-rejected  → the terminal refused the key this till has (HTTP 401 /
                                       NOT_AUTHENTICATED): marked on the key, shown in the
                                       dashboard ("המפתח נדחה במסוף") until a new key replaces it.
"""
from __future__ import annotations

import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import CatalogActor, get_pos_machine_for_sync_path, require_catalog_authority
from app.models.pos_machine import POSMachine
from app.schemas.synqpay_pairing import SynqpayKeyRejectedIn, SynqpayPairingIn
from app.services import payment_integration as PI
from app.services import payment_secrets as PS
from app.services.permissions import Scope
from app.services.settings_merge import patch_settings_json, utc_now

logger = logging.getLogger(__name__)

# Display devices are not tills (app/services/display_devices.py).
from app.middleware.auth import FISCAL_SYNC_PATH

router = APIRouter(tags=["payment-integration"])


def _layers(db: Session, machine: POSMachine):
    from app.routers.settings import _machine_parents

    area, shop, company, tenant = _machine_parents(db, machine)
    return (
        PI.settings_layers(tenant, company, shop, area, machine),
        PI.secret_layers(tenant, company, shop, area, machine),
    )


@router.post("/sync/{machine_id}/synqpay/pairing", dependencies=FISCAL_SYNC_PATH)
def store_synqpay_pairing(
    machine_id: str,
    body: SynqpayPairingIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    actor: CatalogActor = Depends(require_catalog_authority(Scope.CATALOG_WRITE)),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    key = body.key_or_none()
    if key is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "secret_invalid"})
    settings_layers, _ = _layers(db, machine)
    res = PI.resolve(
        settings_layers,
        bool(getattr(machine, "has_builtin_terminal", True)),
        synqpay_device=PI.is_synqpay_device(machine),
    )
    if res.integration != PI.SYNQPAY:
        # A till on another integration, or ON a SynqPay terminal (built-in, Local Mode — no key).
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "not_synqpay"})

    row = PS.store_till_pairing(
        db, machine, key, serial=body.serial_number, pos_user_id=actor.pos_user_id, user_id=actor.user_id,
    )
    # The serial number the terminal answered to, on the till's own layer when no layer names
    # one yet: the dashboard shows it, and the till checks it is still that terminal.
    merged: Dict[str, Any] = {}
    for _, layer in settings_layers:
        if isinstance(layer, dict):
            merged.update(layer)
    if body.serial_number and not (isinstance(merged.get(PI.SYNQPAY_SERIAL_NUMBER), str) and merged[PI.SYNQPAY_SERIAL_NUMBER].strip()):
        machine.settings = patch_settings_json(machine.settings, {PI.SYNQPAY_SERIAL_NUMBER: body.serial_number})
    machine.settings_updated_at = utc_now()
    logger.info(
        "synqpay paired at till %s (serial %s) — user %s, till user %s",
        machine.id, body.serial_number or "-", actor.user_id, actor.pos_user_id,
    )
    db.commit()
    return {
        "machineId": str(machine.id),
        "origin": row.origin,
        "pairedAt": row.paired_at,
        "serialNumber": row.terminal_serial,
    }


@router.post("/sync/{machine_id}/synqpay/key-rejected", dependencies=FISCAL_SYNC_PATH)
def report_synqpay_key_rejected(
    machine_id: str,
    body: SynqpayKeyRejectedIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Idempotent: the first report of a refusal is the one kept."""
    _, id_layers = _layers(db, machine)
    row = PS.mark_rejected(db, id_layers, PS.SYNQPAY_API_KEY, machine)
    logger.warning("synqpay key refused by the terminal at till %s: %s", machine.id, (body.detail or "-")[:200])
    db.commit()
    return {"recorded": row is not None, "rejectedAt": row.rejected_at if row is not None else None}
