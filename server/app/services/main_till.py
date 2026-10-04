"""
The shop's main till ("קופה ראשית") — one till the rest of the shop leans on.

A till marked `mainTill` (at its own level; the shop page's "תצורת עבודה — קופה ראשית"
card sets it) is, unless the shop names another till for that job explicitly:

* the tables host of the LAN mode («רשת מקומית (קופה ראשית)», `tablesHostTill`,
  app/services/tables.py) — every table, its number and its order, live on it;
* the print server (`printHostTill`, app/services/printers.py);
* the master of the shop Z (`shopZMasterTill`, app/routers/till_shop_z.py) — one Z for
  the whole shop, numbered once by the shop's counter, with a section per till and a
  breakdown per waiter (app/services/z_waiters.py).

And the shop Z comes from it alone, unless the shop's `shopZFrom` says otherwise:

* «הקופה הראשית בלבד» (default) — neither the dashboard's Z wizard nor another till may
  start the shop Z;
* «הקופה הראשית והדשבורד» — the dashboard's wizard too;
* «כל קופה בסניף והדשבורד» — any till of the shop, and the dashboard.

A shop without a main till keeps the rules it had: the dashboard, and the tills marked
`shopZMasterTill` — unless `shopZFrom` opens it to every till. A till's own Z ("Z לכל
קופה") is not a shop Z: none of this touches it.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shop import Shop

logger = logging.getLogger(__name__)

MAIN_TILL_KEY = "mainTill"
SHOP_Z_FROM_KEY = "shopZFrom"
SHOP_Z_MASTER_KEY = "shopZMasterTill"

Z_FROM_MAIN = "הקופה הראשית בלבד"
Z_FROM_MAIN_AND_DASHBOARD = "הקופה הראשית והדשבורד"
Z_FROM_ANY = "כל קופה בסניף והדשבורד"
Z_FROM_OPTIONS = (Z_FROM_MAIN, Z_FROM_MAIN_AND_DASHBOARD, Z_FROM_ANY)

#: The refusals, as `detail` (the till's) or `detail.code` (the dashboard's 409).
NOT_MASTER = "not_master_till"
ONLY_FROM_MAIN = "z_only_from_main_till"


def is_on(value: Any) -> bool:
    return value is True or str(value).strip().lower() in ("true", "1", "yes", "כן")


def till_order(machine: POSMachine):
    """Lowest register number first, so every till agrees on one of several marked."""
    number = (machine.pos_number or "").strip()
    return (0, int(number), "") if number.isdigit() else (1, 0, number or str(machine.id))


def _params(db: Session, machine: POSMachine) -> Dict[str, Any]:
    from app.services.till_parameters import till_parameters_for_machine

    return till_parameters_for_machine(db, machine).parameters


def main_till_of_shop(db: Session, shop_id: Any) -> Optional[POSMachine]:
    """The shop's active till whose `mainTill` resolves on; several — the lowest number."""
    from app.services.printers import shop_machines

    if shop_id is None:
        return None
    marked = [m for m in shop_machines(db, shop_id) if is_on(_params(db, m).get(MAIN_TILL_KEY))]
    return sorted(marked, key=till_order)[0] if marked else None


def till_ref(machine: Optional[POSMachine]) -> Optional[Dict[str, Any]]:
    if machine is None:
        return None
    return {"machineId": str(machine.id), "posNumber": machine.pos_number, "name": machine.name}


def z_from_of(db: Session, shop: Shop) -> str:
    """The shop's `shopZFrom` (its own value, else its company's), else the default."""
    from app.services.till_parameters import resolve_for_shop

    value = resolve_for_shop(db, shop).get(SHOP_Z_FROM_KEY)
    return value if value in Z_FROM_OPTIONS else Z_FROM_MAIN


def dashboard_z_refusal(db: Session, shop: Shop) -> Optional[Dict[str, Any]]:
    """
    None when the dashboard may start this shop's shop Z; else the 409's detail:
    `{code: z_only_from_main_till, mainTill: {machineId, posNumber, name}}`.

    A main till the cloud has lost (it crashed, is off, will not start) does not hold the
    shop's Z hostage: the dashboard may then produce it, and the main till's shift waits
    for the next Z like any till that did not close.
    """
    from app.services.machine_status import is_online

    main = main_till_of_shop(db, shop.id)
    if main is None or z_from_of(db, shop) != Z_FROM_MAIN or not is_online(main.last_heartbeat_at):
        return None
    return {"code": ONLY_FROM_MAIN, "mainTill": till_ref(main)}


def till_shop_z_refusal(db: Session, machine: POSMachine) -> Optional[str]:
    """
    None when this till may run its shop's Z ("סגירת Z סניפי"); else why not:
    `z_only_from_main_till` (the shop has a main till, and it is another) or
    `not_master_till` (no main till, and this till is not marked master).
    """
    shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
    if shop is not None and z_from_of(db, shop) == Z_FROM_ANY:
        return None
    main = main_till_of_shop(db, machine.shop_id)
    if main is not None:
        return None if main.id == machine.id else ONLY_FROM_MAIN
    return None if is_on(_params(db, machine).get(SHOP_Z_MASTER_KEY)) else NOT_MASTER


def shop_tills_out(db: Session, shop_id: Any) -> List[Dict[str, Any]]:
    from app.services.printers import shop_machines

    return [till_ref(m) for m in sorted(shop_machines(db, shop_id), key=till_order)]


# ── The main till is down: another takes over ───────────────────────────────

#: The till-level flags that name a till for a job; a takeover moves those the old host
#: held to the till taking over.
HOST_KEYS = (MAIN_TILL_KEY, "tablesHostTill", "printHostTill", SHOP_Z_MASTER_KEY)


def take_over(db: Session, machine: POSMachine, operator: Optional[str] = None) -> Dict[str, Any]:
    """
    "העבר את השרת לקופה הזו": the LAN mode's tables host (normally the main till) does not
    answer, and a manager at `machine` makes it the shop's main till in its place — the
    tables host, the print server and the master of the shop Z — moving to it every flag
    the old host held. The new host then takes the tables from the cloud (`host_seed`).

    Only when the cloud too sees the old host gone (409 `host_online` otherwise): a host
    the cloud hears but this till cannot reach is a network fault between the tills, and
    two hosts would split the tables. 409 `tables_not_lan` outside the LAN mode.
    """
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.machine_status import is_online
    from app.services.tables import MODE_LAN, TABLES_MODE_KEY, mode_of, tables_host_of_shop
    from app.services.till_parameters import ensure_builtin_parameters

    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="machine_has_no_shop")
    if mode_of(_params(db, machine).get(TABLES_MODE_KEY)) != MODE_LAN:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="tables_not_lan")
    old = tables_host_of_shop(db, machine.shop_id)
    if old is not None and old.id == machine.id:
        return {"mainTill": till_ref(machine), "previous": None}
    if old is not None and is_online(old.last_heartbeat_at):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "host_online", "host": till_ref(old)},
        )

    ensure_builtin_parameters(db)
    now = datetime.now(timezone.utc)
    by_key = {p.key: p for p in db.query(TillParameter).filter(TillParameter.key.in_(HOST_KEYS)).all()}
    moved = []
    for key in HOST_KEYS:
        parameter = by_key.get(key)
        if parameter is None or old is None:
            continue
        held = (
            db.query(TillParameterValue)
            .filter(
                TillParameterValue.parameter_id == parameter.id,
                TillParameterValue.scope_type == "machine",
                TillParameterValue.scope_id == old.id,
            )
            .all()
        )
        if not any(is_on(v.value) for v in held):
            continue
        db.query(TillParameterValue).filter(
            TillParameterValue.parameter_id == parameter.id,
            TillParameterValue.scope_type == "machine",
            TillParameterValue.scope_id.in_([old.id, machine.id]),
        ).delete(synchronize_session=False)
        db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=parameter.id, scope_type="machine", scope_id=machine.id, value=True,
        ))
        parameter.updated_at = now
        moved.append(key)
    db.flush()
    # The old host held its role by none of them (no host at all, or one named at a wider
    # level): this till is made the main till, and no other till of the shop is named host.
    if tables_host_of_shop(db, machine.shop_id) is None or tables_host_of_shop(db, machine.shop_id).id != machine.id:
        from app.services.printers import shop_machines

        others = [m.id for m in shop_machines(db, machine.shop_id) if m.id != machine.id]
        for key in (MAIN_TILL_KEY, "tablesHostTill"):
            parameter = by_key.get(key)
            if parameter is None:
                continue
            if others:
                db.query(TillParameterValue).filter(
                    TillParameterValue.parameter_id == parameter.id,
                    TillParameterValue.scope_type == "machine",
                    TillParameterValue.scope_id.in_(others),
                ).delete(synchronize_session=False)
            parameter.updated_at = now
        main = by_key[MAIN_TILL_KEY]
        db.query(TillParameterValue).filter(
            TillParameterValue.parameter_id == main.id,
            TillParameterValue.scope_type == "machine",
            TillParameterValue.scope_id == machine.id,
        ).delete(synchronize_session=False)
        db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=main.id, scope_type="machine", scope_id=machine.id, value=True,
        ))
        moved.append(MAIN_TILL_KEY)
        db.flush()
    logger.warning(
        "shop %s: main till taken over by %s from %s (%s) — %s",
        machine.shop_id, machine.id, old.id if old else None, operator or "?", ", ".join(moved),
    )
    return {"mainTill": till_ref(machine), "previous": till_ref(old), "moved": moved}
