"""
A document's table, and a table's documents — "בהיסטוריית עסקאות תוסיף גם חיפוש לפי מספר שולחן"
(the owner, 14.10.2026; P:/specs/history-table-search.md).

**The link.** A document is not stamped with its table: the table order (`table_orders`) is.
Its sale is `transaction_id`; the parts paid on their own ("פיצול חשבון") are in
`extras_json.partials[].tx`; the credit notes of payments given back inside the table
("זיכוי / ביטול תשלום בשולחן") in `extras_json.reversals[].credit`. Any other credit note
belongs to the table of the document it refunds (`refund_of_transaction_id`). The order holds
the table's number and name as they were when it was written (`table_number`, `table_name`),
so renaming or renumbering a table later does not change history, and a restored table's
label ("ש-12", whose number is e.g. 9012) is found by that name. The waiters' part of a Z
(app/services/z_waiters.py) maps documents to orders through `orders_by_tx` here — one rule.

**Search.** `parse_table_query` reads the box: "ש12", "ש 12", "ש-12", "שולחן 12", "t12",
"table 12" ask for table 12 — and only for it (`explicit`); with a dedicated table filter
(`chip=True`: the till's "שולחן" chip, the `table` query param, the dashboard's "שולחן"
filter) the digits alone ("12") are a table number, never a document number or an amount, and
any other text a table name. Without the chip, text with a letter ("VIP 1", "בר 3") may also
be a table's name, alongside the usual search; digits alone stay the document / amount search.
The explicit form matches a name as a whole (it starts with the text and does not go on with a
digit: "ש-12" finds "ש-12 (2)", not "ש-120"); any other name search is a substring.
The same rules on the till (pos-android, the history search) and in the dashboard (client
lib/tableSearch.ts) — keep them identical.

**Labels** ("3B", P:/specs/table-scope.md §6.4): "ש3B", "שולחן 3B", "תא 3B", "t3b" — a table word and a label
that begins with a digit — and "שולחן VIP" / "תא VIP" (a word, a space, a label of letters) ask for the labelled
table, matched by the label's normalised form (`label_key`: "3-b" is "3B"); with the chip, "3B" alone. "תא" is a
table word too (`tableTerm`). The order keeps its label as written (`table_label`).
"""
from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List, Optional

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.tables import TableOrder
from app.models.transaction import Transaction

#: How far before the first document an order may have been opened (a long evening, a table
#: kept open past midnight, a till's clock): the window the orders are looked up in.
ORDER_MARGIN = timedelta(days=2)
#: The most table orders one search follows to their documents (a month of "שולחן 1"s).
SEARCH_ORDERS_MAX = 5000


def uuid_text(raw: Any) -> Optional[str]:
    try:
        return str(uuid.UUID(str(raw)))
    except (TypeError, ValueError, AttributeError):
        return None


def _extras(order: TableOrder) -> Dict[str, Any]:
    try:
        extras = json.loads(order.extras_json) if order.extras_json else None
    except (TypeError, ValueError):
        return {}
    return extras if isinstance(extras, dict) else {}


def _ids_in(extras: Dict[str, Any], key: str, field: str) -> List[str]:
    entries = extras.get(key)
    out = []
    for entry in entries if isinstance(entries, list) else []:
        tx = uuid_text(entry.get(field)) if isinstance(entry, dict) else None
        if tx:
            out.append(tx)
    return out


def part_tx_ids(order: TableOrder) -> List[str]:
    """The sales of the order's parts paid on their own."""
    return _ids_in(_extras(order), "partials", "tx")


def extra_document_ids(order: TableOrder) -> List[str]:
    """The order's documents besides its sale: the parts paid apart, the payments given back."""
    extras = _extras(order)
    return _ids_in(extras, "partials", "tx") + _ids_in(extras, "reversals", "credit")


def orders_by_tx(
    db: Session,
    shop_id: Any,
    documents: List[Any],
    *,
    ids_of: Callable[[TableOrder], List[str]] = part_tx_ids,
) -> Dict[str, TableOrder]:
    """
    Each table sale (and the original of a credit note) → the table order it paid. `documents`
    need `id`, `refund_of_transaction_id` and `created_at`. `ids_of` — what of an order's extras
    counts besides its sale (the parts paid apart; the table search adds the payments given back).
    """
    if shop_id is None or not documents:
        return {}
    wanted = {str(d.id) for d in documents}
    wanted |= {t for t in (uuid_text(d.refund_of_transaction_id) for d in documents) if t}
    found: Dict[str, TableOrder] = {}
    for order in (
        db.query(TableOrder)
        .filter(TableOrder.shop_id == shop_id, TableOrder.transaction_id.in_(sorted(wanted)))
        .all()
    ):
        tx = uuid_text(order.transaction_id)
        if tx:
            found[tx] = order
    # Parts paid on their own: on orders opened since a little before the first document.
    moments = [d.created_at for d in documents if d.created_at is not None]
    if moments:
        since = min(moments) - ORDER_MARGIN
        for order in (
            db.query(TableOrder)
            .filter(
                TableOrder.shop_id == shop_id,
                TableOrder.opened_at >= since,
                TableOrder.extras_json.like('%"partials"%'),
            )
            .all()
        ):
            for tx in ids_of(order):
                if tx in wanted:
                    found.setdefault(tx, order)
    return found


def table_ref(order: TableOrder) -> Dict[str, Any]:
    """What a document row says of its table (frozen on the order when it was written)."""
    return {
        "tableNumber": order.table_number,
        "tableName": order.table_name,
        # "3B" (P:/specs/table-scope.md §6.4): never text in `tableNumber` — the label beside it.
        "tableLabel": getattr(order, "table_label", None) or None,
        "tableOrderId": str(order.id),
        "tableOpenedAt": order.opened_at.isoformat() if order.opened_at else None,
    }


def tables_by_transaction(db: Session, shop_id: Any, rows: List[Any]) -> Dict[str, Dict[str, Any]]:
    """
    Per document id (as text), its table — `{tableNumber, tableName, tableOrderId,
    tableOpenedAt}` — for a page of one shop's documents (`rows`: `id`,
    `refund_of_transaction_id`, `created_at`). A document of no table is not in the map.
    """
    orders = orders_by_tx(db, shop_id, rows, ids_of=extra_document_ids)
    out: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        order = orders.get(str(r.id)) or orders.get(uuid_text(r.refund_of_transaction_id) or "")
        if order is not None:
            out[str(r.id)] = table_ref(order)
    return out


def tables_by_transaction_any_shop(db: Session, rows: List[Any]) -> Dict[str, Dict[str, Any]]:
    """`tables_by_transaction` for a page that may span shops (the dashboard's list): per shop."""
    by_shop: Dict[Any, List[Any]] = {}
    for r in rows:
        if r.shop_id is not None:
            by_shop.setdefault(r.shop_id, []).append(r)
    out: Dict[str, Dict[str, Any]] = {}
    for shop_id, shop_rows in by_shop.items():
        out.update(tables_by_transaction(db, shop_id, shop_rows))
    return out


# ── Search: "ש12", "ש 12", "ש-12", "שולחן 12", "t12", "table 12" ─────────────

#: The explicit form: a table word, an optional dash / "#" / maqaf, the number.
_EXPLICIT = re.compile(r"^(?:שולחן|ש|תא|table|t)\s*[-#\u05be]?\s*(\d{1,5})$", re.IGNORECASE | re.ASCII)
#: A label after a table word: one that begins with a digit ("ש3B", "תא 3B"), or — after a whole word and a
#: space — one of letters ("שולחן VIP", "תא A1").
_EXPLICIT_LABEL = re.compile(r"^(?:שולחן|ש|תא|table|t)\s*[-#\u05be]?\s*(\d[0-9A-Za-z\u05d0-\u05ea \-]*)$", re.IGNORECASE)
_WORD_LABEL = re.compile(r"^(?:שולחן|תא|table)\s+([A-Za-z\u05d0-\u05ea][0-9A-Za-z\u05d0-\u05ea \-]*)$", re.IGNORECASE)
_DIGITS = re.compile(r"^\d{1,5}$", re.ASCII)
#: What may not follow a whole name ("ש-12" is not "ש-120"). Not "": a name may end there.
_ASCII_DIGITS = frozenset("0123456789")


@dataclass(frozen=True)
class TableQuery:
    """
    A search read as a table: `number` — the table's number, `name` — text its name contains
    (the explicit form's own text too: "ש-12" is also a restored table's name), `explicit` — the
    search asks for a table and nothing else (the explicit form, or the table filter).

    `name_whole` (the explicit form only): the name must START with the text and not go on with
    a digit — "ש-12" finds "ש-12" and "ש-12 (2)", not "ש-120"; "שולחן 1" is not "שולחן 10".
    Any other name search is a substring ("VIP" finds "VIP 1").
    """

    number: Optional[int]
    name: Optional[str]
    explicit: bool
    name_whole: bool = False
    #: A label's normalised form ("3B" for "3-b"): the order's `table_label` read the same way.
    label_key: Optional[str] = None

    def matches(self, number: Optional[int], name: Optional[str], label: Optional[str] = None) -> bool:
        if self.number is not None and isinstance(number, int) and number == self.number:
            return True
        if self.label_key is not None and label:
            from app.services.table_labels import label_key

            if label_key(label) == self.label_key:
                return True
        if not self.name:
            return False
        wanted, have = self.name.casefold(), (name or "").strip().casefold()
        if not self.name_whole:
            return wanted in have
        return have.startswith(wanted) and have[len(wanted):len(wanted) + 1] not in _ASCII_DIGITS


def parse_table_query(text: Optional[str], *, chip: bool = False) -> Optional[TableQuery]:
    """What the box (or the table filter, `chip=True`) asks as a table, or None (not a table search)."""
    if not isinstance(text, str):
        return None
    t = " ".join(text.split())
    if not t:
        return None
    m = _EXPLICIT.match(t)
    if m:
        return TableQuery(number=int(m.group(1)), name=t, explicit=True, name_whole=True)
    for pattern in (_EXPLICIT_LABEL, _WORD_LABEL):
        m = pattern.match(t)
        key = _label_key_of(m.group(1)) if m else None
        if key is not None:
            # The table word's own text is also a restored table's name ("ש-3B").
            return TableQuery(number=None, name=t, explicit=True, name_whole=True, label_key=key)
    if chip:
        if _DIGITS.match(t):
            return TableQuery(number=int(t), name=None, explicit=True)
        return TableQuery(number=None, name=t, explicit=True, label_key=_label_key_of(t))
    if any(ch.isalpha() for ch in t):
        return TableQuery(number=None, name=t, explicit=False, label_key=_label_key_of(t))
    return None


def _label_key_of(text: str) -> Optional[str]:
    """The normalised label [text] is ("3-b" → "3B"), None when it is not one (a number, a refused character)."""
    from app.services import table_labels as TL

    try:
        parsed = TL.parse(text)
    except TL.LabelError:
        return None
    return parsed.key if parsed.is_label else None


def _escape_like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def order_match_clause(tq: TableQuery):
    """The `table_orders` rows a table query may find (`TableQuery.matches` confirms each)."""
    clauses = []
    if tq.number is not None:
        clauses.append(TableOrder.table_number == tq.number)
    if tq.label_key is not None:
        # The order's label read as its key: no spaces, no "-", upper case (`matches` confirms it).
        clauses.append(
            func.upper(func.replace(func.replace(TableOrder.table_label, " ", ""), "-", "")) == tq.label_key
        )
    if tq.name and tq.name_whole:
        # Starts with it; `matches` then refuses a name that goes on with a digit ("ש-120").
        clauses.append(func.trim(TableOrder.table_name).ilike(_escape_like(tq.name) + "%", escape="\\"))
    elif tq.name:
        clauses.append(TableOrder.table_name.ilike("%" + _escape_like(tq.name) + "%", escape="\\"))
    return or_(*clauses)


def transaction_ids_for_table(
    db: Session,
    tq: TableQuery,
    *,
    tenant_id: Any = None,
    shop_id: Any = None,
    since: Optional[datetime] = None,
) -> List[uuid.UUID]:
    """
    Every document of the orders a table query finds — their sales, the parts paid apart, the
    payments given back, and the credit notes of any of those — in the tenant and shop given.
    Orders opened or closed since `since` (less `ORDER_MARGIN`), newest first. The caller's own
    query still applies its dates and scope to the documents.
    """
    orders = db.query(TableOrder).filter(order_match_clause(tq))
    if tenant_id is not None:
        orders = orders.filter(TableOrder.tenant_id == tenant_id)
    if shop_id is not None:
        orders = orders.filter(TableOrder.shop_id == shop_id)
    if since is not None:
        floor = since - ORDER_MARGIN
        orders = orders.filter(or_(TableOrder.opened_at >= floor, TableOrder.closed_at >= floor))
    ids: List[str] = []
    for order in orders.order_by(TableOrder.opened_at.desc()).limit(SEARCH_ORDERS_MAX).all():
        if not tq.matches(order.table_number, order.table_name, getattr(order, "table_label", None)):
            continue
        sale = uuid_text(order.transaction_id)
        ids += ([sale] if sale else []) + extra_document_ids(order)
    paid = [uuid.UUID(t) for t in dict.fromkeys(ids)]
    found = list(paid)
    seen = set(paid)
    # A credit note made later (from the history) goes with the document it refunds.
    for start in range(0, len(paid), 500):
        notes = db.query(Transaction.id).filter(Transaction.refund_of_transaction_id.in_(paid[start:start + 500]))
        if tenant_id is not None:
            notes = notes.filter(Transaction.tenant_id == tenant_id)
        if shop_id is not None:
            notes = notes.filter(Transaction.shop_id == shop_id)
        for (note_id,) in notes.all():
            if note_id not in seen:
                seen.add(note_id)
                found.append(note_id)
    return found


def search_matches(
    q: Optional[str], matched: Optional[List[str]], table: Optional[Dict[str, Any]]
) -> Optional[List[str]]:
    """
    `matchedBy` with the table: a search in the explicit form ("ש12") found the document by its
    table alone (["table"]); a name ("VIP 1") adds "table" to the document / pickup reasons when
    its table's name holds it. Anything else is `matched` as is (None without a search).
    """
    tq = parse_table_query(q) if isinstance(q, str) else None
    if tq is None:
        return matched
    hit = table is not None and tq.matches(table.get("tableNumber"), table.get("tableName"), table.get("tableLabel"))
    if tq.explicit:
        return ["table"] if hit else []
    return [*(matched or []), "table"] if hit else matched

