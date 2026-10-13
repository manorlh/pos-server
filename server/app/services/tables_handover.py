"""
The LAN mode's tables mirror after the server moved (reliability audit of tables and kitchen
tickets, 13.10.2026 — the owner: "שלא יהיו כפילויות בבונים, או פדיחות שקשורות להיעלמות שולחן").

`apply_local_report` (app/services/tables.py) takes the host's mirror newest-version-wins: the host
is the one source of the shop's table orders in the LAN mode. Two reports must not be taken that
way, because the till sending them is not that source any more:

* **A former host's** (`"formerHost": true`, P:/specs/local-server-switch.md §8, gap 1) — judged
  already: an order the cloud changed since the switch is a conflict, kept for the dashboard.
* **A host that does not know yet that it is not one** — the server moved while it was cut off
  from the cloud (an auto failover, a forced switch, the parameters changed): it still pushes its
  changes as the newest. Its report is judged the same way (`judged_report`), so the new server's
  edits are never overwritten by a stale version.

And in a judged report, an **open order on a table that already has another open order** in the
cloud is a conflict too (`other_open_order`): applying it would leave the table with two open
orders — the new server's floor shows one of them, the other is an order nobody sees, and the
day's close waits on it. Closures are taken first (`closures_first`), so a former host that paid
a table and seated it again in the same report is not refused for its own closed order.

"שחזור שולחן" (`mark_restored`): the claim is one conditional UPDATE, and the till that claimed an
order may finish its restore within `RESTORE_RETRY_WINDOW` (`restored_by`) — a lost answer or a
table that could not be opened never strands a closed order that no till may restore any more.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, List, Optional, Sequence

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.tables import TableEvent, TableOrder

#: How long the till that claimed a closed order for "שחזור שולחן" may claim it again, to finish it.
RESTORE_RETRY_WINDOW = timedelta(minutes=30)


def judged_report(db: Session, machine: POSMachine) -> bool:
    """
    Whether `machine`'s plain mirror (no `formerHost`) is judged as a former host's: it is in the
    LAN mode and the shop's tables host is another device. A single-till ("קופה אחת") report, and
    the host's own, are taken as always.
    """
    from app.services import tables as T

    if machine.shop_id is None:
        return False
    if T.mode_of(T.machine_params(db, machine).get(T.TABLES_MODE_KEY)) != T.MODE_LAN:
        return False
    host = T.tables_host_of_shop(db, machine.shop_id)
    return host is not None and str(host.id) != str(machine.id)


def other_open_order(db: Session, table_id: Any, order_id: Any) -> Optional[TableOrder]:
    """Another open order on the table, as the cloud has it now (this request's closures included)."""
    return (
        db.query(TableOrder)
        .filter(TableOrder.table_id == table_id, TableOrder.status == "open", TableOrder.id != order_id)
        .order_by(TableOrder.opened_at)
        .first()
    )


def restored_by(db: Session, order: TableOrder, machine: POSMachine, now: datetime) -> bool:
    """`order` was claimed for restoring by `machine` within `RESTORE_RETRY_WINDOW` (its "restore" event)."""
    from app.services.areas import as_utc

    at = as_utc(order.restored_at) if order.restored_at is not None else None
    if at is None or at < as_utc(now) - RESTORE_RETRY_WINDOW:
        return False
    event = (
        db.query(TableEvent)
        .filter(TableEvent.order_id == order.id, TableEvent.kind == "restore")
        .order_by(TableEvent.occurred_at.desc())
        .first()
    )
    return event is not None and event.machine_id is not None and str(event.machine_id) == str(machine.id)


def closures_first(orders: Sequence[Any]) -> List[Any]:
    """The report's orders with the closed ones first (stable), so a table freed and seated again in one report is one open order."""
    return sorted(orders, key=lambda item: (getattr(item, "status", "open") or "open") == "open")
