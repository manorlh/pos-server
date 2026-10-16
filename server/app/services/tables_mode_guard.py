"""
A change of how a shop's tills share their tables, while tables are open (the reliability audit of
tables and kitchen tickets, 13.10.2026 — the owner: no table that disappears or doubles).

The tables mode (`tablesMode`) decides where a till's open orders live:

* «קופה אחת» (single) — in the till's own database; the cloud has a copy for the reports, without
  the dishes (`cart_json` null);
* «מסונכרן בין הקופות» (synced) — in the cloud (`source = synced`);
* «רשת מקומית (קופה ראשית)» (lan) — on the shop's local server, mirrored to the cloud with the
  dishes (`source = local`, `cart_json` set);
* «כבוי» — nowhere.

Moving a till — or the whole shop — from one to another while orders are open there would leave
them where no till looks any more (the table shows free, a second order opens on it), or show them
twice. Nothing here can carry an open order across safely while the tills learn the new mode one by
one (some still writing the old way), so the change is refused while it would strand one — with the
tables named, in Hebrew — and goes through once they are closed or moved:

* a till leaving «קופה אחת» with its own tables open;
* the last tills leaving «מסונכרן» with synced tables open;
* the last tills leaving «רשת מקומית», or the local server itself leaving it, with tables open on
  the server — or while the server's copy in the cloud is not complete (changes on their way, or the
  server not heard): the cloud cannot see what it never got.

A till leaving the local server's group for its own tables (member → independent) moves nothing: the
orders it worked on stay on the server. The local server moving to another device keeps the mode and
is the switch's business (app/services/local_server_switch.py): the new server starts from the
cloud's copy.

The check runs inside the shop Z's own guard (`local_shop_z.ProducerGuard`), which every transition
already passes through — the till parameters page, the work profile, a device's work configuration,
"קופה עצמאית", the local network switch, the dedicated server — and the card "סוגי עבודה". The
refusal is a `LocalShopZRefused` (409 `tables_open_on_mode_change`): every caller already rolls back
and answers it. It is never forced: forcing would lose an order.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.tables import TableOrder

REFUSED = "tables_open_on_mode_change"
CLOSE_FIRST = "יש לסגור או להעביר את השולחנות הפתוחים לפני מעבר מצב."
#: At most this many tables named in the message (all of them in `tables`).
NAMED = 8


def _local_shop_z_refused():
    from app.services.local_shop_z import LocalShopZRefused

    return LocalShopZRefused


def _modes(db: Session, shop: Shop) -> Dict[str, str]:
    """Each active till of the shop → its tables mode now (off / single / synced / lan)."""
    from app.services import tables as T
    from app.services.printers import shop_machines

    return {str(m.id): T.mode_of(T.machine_params(db, m).get(T.TABLES_MODE_KEY)) for m in shop_machines(db, shop.id)}


def _host_id(db: Session, shop: Shop) -> Optional[str]:
    from app.services import tables as T

    host = T.tables_host_of_shop(db, shop.id)
    return str(host.id) if host is not None else None


def _open(db: Session, shop: Shop) -> List[TableOrder]:
    from app.services.table_labels import natural_sorted

    # The natural order ("3", "3A", "10" — P:/specs/table-scope.md §6.2).
    return natural_sorted(
        db.query(TableOrder)
        .filter(TableOrder.shop_id == shop.id, TableOrder.status == "open")
        .order_by(TableOrder.table_number)
        .all(),
        number=lambda o: o.table_number,
        label=lambda o: getattr(o, "table_label", None),
    )


def is_lan_order(order: TableOrder) -> bool:
    """On the local server: the server's mirror carries the dishes; a single till's report never does."""
    return order.source == "local" and order.cart_json is not None


def is_single_order(order: TableOrder) -> bool:
    return order.source == "local" and order.cart_json is None


def _label(machine: Optional[POSMachine]) -> str:
    from app.services.printers import machine_label

    return machine_label(machine) or "?"


def _table(order: TableOrder) -> str:
    name = (order.table_name or "").strip()
    label = (getattr(order, "table_label", None) or "").strip()
    return name or label or str(order.table_number if order.table_number is not None else "?")


class TablesModeGuard:
    """Pins each shop's tills' tables modes before a change; `check` after it (flushed)."""

    def __init__(self, db: Session, shops: Iterable[Optional[Shop]]):
        self.db = db
        self.before: Dict[Any, Tuple[Shop, Dict[str, str], Optional[str]]] = {}
        for shop in shops:
            if shop is None or shop.id in self.before:
                continue
            self.before[shop.id] = (shop, _modes(db, shop), _host_id(db, shop))

    def check(self) -> None:
        self.db.flush()
        for shop, before, host_before in self.before.values():
            after = _modes(self.db, shop)
            changed = {m: (b, after.get(m, b)) for m, b in before.items() if after.get(m, b) != b}
            if not changed:
                continue
            lines, tables = problems(self.db, shop, before, after, changed, host_before)
            if lines:
                raise _local_shop_z_refused()(status.HTTP_409_CONFLICT, {
                    "detail": REFUSED,
                    "message": " ".join(lines[:NAMED] + ([f"ועוד {len(lines) - NAMED}."] if len(lines) > NAMED else [])) + " " + CLOSE_FIRST,
                    "tables": tables,
                    "shopId": str(shop.id),
                    "canForce": False,
                })


def problems(
    db: Session,
    shop: Shop,
    before: Dict[str, str],
    after: Dict[str, str],
    changed: Dict[str, Tuple[str, str]],
    host_before: Optional[str],
) -> Tuple[List[str], List[Dict[str, Any]]]:
    """What the change would strand: the Hebrew lines and the tables, `([], [])` when nothing."""
    from app.services import tables as T

    lines: List[str] = []
    tables: List[Dict[str, Any]] = []
    open_orders = _open(db, shop)
    lan_open = [o for o in open_orders if is_lan_order(o)]
    synced_open = [o for o in open_orders if o.source == "synced"]
    machines = {str(m.id): m for m in db.query(POSMachine).filter(POSMachine.shop_id == shop.id).all()}

    def note(order: TableOrder, line: str, pool: str, machine_id: Optional[str] = None) -> None:
        lines.append(line)
        tables.append({
            "orderId": str(order.id), "tableId": str(order.table_id), "tableNumber": order.table_number,
            "tableName": order.table_name, "pool": pool, "machineId": machine_id,
        })

    # A till leaving «קופה אחת»: its own tables would be left in its database, out of every floor.
    for machine_id, (was, now) in changed.items():
        if was != T.MODE_SINGLE:
            continue
        label = _label(machines.get(machine_id))
        mine = [o for o in open_orders if is_single_order(o) and str(o.updated_machine_id) == machine_id]
        there = lan_open if now == T.MODE_LAN else synced_open if now == T.MODE_SYNCED else []
        busy = {o.table_id for o in there}
        where = "בשרת המקומי" if now == T.MODE_LAN else "בענן"
        for o in mine:
            if o.table_id in busy:
                note(o, f"שולחן {_table(o)} פתוח גם בקופה {label} וגם {where}.", "single", machine_id)
            else:
                note(o, f"שולחן {_table(o)} פתוח בקופה {label}.", "single", machine_id)

    # The last tills leaving «מסונכרן»: its tables would be left in the cloud, out of every floor.
    if any(m == T.MODE_SYNCED for m in before.values()) and not any(m == T.MODE_SYNCED for m in after.values()):
        for o in synced_open:
            note(o, f"שולחן {_table(o)} פתוח במצב «מסונכרן בין הקופות».", "synced")

    # The local server's group gone — the last tills leave «רשת מקומית»: its tables would be left on
    # the server. The server alone leaving it (another device serves the group after the change):
    # the new one starts from the cloud's copy — only an incomplete copy is refused.
    lan_before = any(m == T.MODE_LAN for m in before.values())
    lan_after = any(m == T.MODE_LAN for m in after.values())
    host_leaves = host_before is not None and before.get(host_before) == T.MODE_LAN and after.get(host_before) != T.MODE_LAN
    if lan_before and not lan_after:
        for o in lan_open:
            note(o, f"שולחן {_table(o)} פתוח בשרת המקומי.", "lan")
    if lan_before and (not lan_after or host_leaves):
        host = machines.get(host_before) if host_before else None
        if host is not None and not (lan_open and not lan_after):
            report = host.lan_sync if isinstance(getattr(host, "lan_sync", None), dict) else {}
            pending = int(report.get("pending") or 0)
            if pending > 0:
                # Its last word: changes the cloud does not have yet.
                lines.append(
                    f"השרת המקומי ({_label(host)}) עוד לא העביר לענן {pending} שינויים בשולחנות — "
                    "המתינו שיעבירו (\"הכל בענן\") ונסו שוב."
                )
            elif not _heard(host) and _heard(host, within=RECENTLY_SERVING):
                # Silent now, serving a moment ago: it may hold tables the cloud never got.
                lines.append(
                    f"השרת המקומי ({_label(host)}) לא מחובר — ייתכן שיש בו שולחנות פתוחים שלא הגיעו לענן. "
                    "חברו אותו, או העבירו את השרת המקומי לקופה אחרת, לפני מעבר מצב."
                )
    return lines, tables


#: A local server silent longer than this is gone, not cut off: what it held is reported, judged,
#: when it comes back (the former server's report, app/services/tables_handover.py).
RECENTLY_SERVING = timedelta(hours=12)


def _heard(machine: POSMachine, within: Optional[timedelta] = None) -> bool:
    from app.services.machine_status import is_online

    if within is None:
        return is_online(machine.last_heartbeat_at)
    beat = machine.last_heartbeat_at
    if beat is None:
        return False
    if beat.tzinfo is None:
        beat = beat.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - beat <= within
