"""
"מספר שולחן על החשבונית" (the owner, 14.10.2026: "אופציה מספר שולחן על החשבונית";
P:/specs/receipt-table-number.md).

`receiptTableInfo` — a till parameter (company → shop → point of sale → till, and in "עיצוב קופה" beside
the tables' look: app/services/table_tile_look.py `till_design_groups`) listing what of the table a
table's document prints, one line under the document's title:

    שולחן 12 · גן · 4 סועדים · מלצר: דנה

`table` (the table's number and name), `zone`, `guests`, `waiter` — stored as a comma list in that
order, the line's; `none` (or nothing set: the default) prints no line, as before.

Printed by the till (pos-android domain/ReceiptTableInfo.kt) on a table's tax invoice / receipt — a
part paid on its own too — the credit notes of those, every copy, and what another till prints of
them; here, on the cloud's copy of the document (app/services/print_documents.py `build_invoice_copy`).
A document of no table (a quick sale, a kiosk) has none. The facts are the table order's
(`table_orders`) — its number and name as written at the payment, its guests and its waiter.

The line's rule is pinned by tests/fixtures/receipt_table_line_cases.json, byte-identical in
pos-android app/src/test/resources (and read by the dashboard's client lib/receiptTableInfo.ts).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple

# The table ↔ document link the history's table search and the waiters' Z read (one rule).
from app.services.table_documents import ORDER_MARGIN, extra_document_ids, uuid_text as _uuid_text

KEY = "receiptTableInfo"

#: What the line may say, in the order it says them.
FIELDS: Tuple[str, ...] = ("table", "zone", "guests", "waiter")
FIELD_LABELS: Dict[str, str] = {
    "table": "מספר ושם השולחן",
    "zone": "אזור",
    "guests": "סועדים",
    "waiter": "מלצר",
}
#: Nothing — written so a level that turns it off is never mistaken for "not set".
NONE = "none"

TABLE_WORD = "שולחן"
ONE_GUEST = "סועד אחד"
GUESTS_WORD = "סועדים"
WAITER_WORD = "מלצר"
SEPARATOR = " · "
#: A restored table ("ש-12", whose number is the cloud's 9012) is named by its label alone.
RESTORED_PREFIX = "ש-"

PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=KEY,
        label="חשבונית — פרטי השולחן",
        value_type="string",
        default_value=None,
        description=(
            "שורה אחת מתחת לכותרת של חשבונית / קבלה של שולחן, למשל \"שולחן 12 · גן · 4 סועדים · מלצר: דנה\": "
            + ", ".join(f"{code} ({FIELD_LABELS[code]})" for code in FIELDS)
            + f". רשימה מופרדת בפסיקים, או {NONE} — בלי שורה. ריק (ברירת המחדל) — בלי שורה, כמו היום. "
            "מודפסת על חשבונית או קבלה של שולחן (גם תשלום חלקי), על חשבונית זיכוי שלהן, על העתק, "
            "בהדפסה בקופה אחרת ובהעתק מהענן. מסמך שלא קשור לשולחן (הזמנה מהירה, קיוסק) — בלי שורה. "
            "הפרטים כפי שנרשמו בהזמנת השולחן בזמן התשלום. ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה, "
            "וגם בעיצוב קופה."
        ),
    ),
)

LEVEL_KEYS: Tuple[str, ...] = (KEY,)
VALIDATED_KEYS = frozenset(LEVEL_KEYS)

#: The till design's group (the "שולחנות ומפה" card, `/till-design/table-display`).
TILL_DESIGN_GROUP = "receiptTable"
TILL_DESIGN_GROUP_LABEL = "חשבונית — פרטי השולחן"


def _codes(value: Any) -> List[str]:
    if isinstance(value, (list, tuple)):
        return [str(p).strip().lower() for p in value]
    if not isinstance(value, str):
        raise ValueError(f"{KEY} must be a comma list of {', '.join(FIELDS)}, or {NONE}")
    text = value.strip().lower()
    if not text or text == NONE:
        return []
    return [p.strip() for p in text.split(",")]


def parse_fields(value: Any) -> List[str]:
    """
    What a stored value asks for, as the till reads it: in the line's order; None, blank or `none` —
    nothing; a code it does not know is skipped (never a reason to print nothing).
    """
    if value is None:
        return []
    try:
        codes = set(_codes(value))
    except ValueError:
        return []
    return [f for f in FIELDS if f in codes]


def clean_value(key: str, value: Any) -> Any:
    """The stored form — `table,guests` in the line's order, or `none` — else ValueError."""
    if key != KEY or value is None:
        return value
    codes = [c for c in _codes(value) if c]
    unknown = [c for c in codes if c not in FIELDS]
    if unknown:
        raise ValueError(f"{KEY}: unknown item {unknown[0]!r} (one of {', '.join(FIELDS)}, or {NONE})")
    fields = [f for f in FIELDS if f in codes]
    return ",".join(fields) if fields else NONE


@dataclass(frozen=True)
class TableFacts:
    """The table a document paid, as its order recorded it. None: not known."""

    number: Optional[int] = None
    name: Optional[str] = None
    zone: Optional[str] = None
    guests: Optional[int] = None
    waiter: Optional[str] = None
    #: "3B" (P:/specs/table-scope.md §6.4): shown instead of the number, which is then an internal one.
    label: Optional[str] = None

    @property
    def title(self) -> Optional[str]:
        """
        "12", "12 · VIP 1", "3B", "3B · VIP" — or a restored table by its label alone ("ש-12"), as the till's floor
        shows it.
        """
        name = (self.name or "").strip() or None
        shown = (self.label or "").strip() or (str(self.number) if self.number is not None else None)
        if shown is None:
            return name
        if name is None:
            return shown
        return name if name.startswith(RESTORED_PREFIX) else f"{shown}{SEPARATOR}{name}"


def _text(value: Any) -> Optional[str]:
    text = (value or "").strip() if isinstance(value, str) else None
    return text or None


def table_line(fields: Iterable[str], facts: Optional[TableFacts], term: Optional[str] = None) -> Optional[str]:
    """
    "שולחן 12 · גן · 4 סועדים · מלצר: דנה" — or None: nothing asked, no table, or none of it known. [term]: the word
    before the table (`tableTerm`, "תא 3B"); none — "שולחן".
    """
    word = (term or "").strip() or TABLE_WORD
    wanted = set(fields or ())
    if facts is None or not wanted:
        return None
    parts: List[str] = []
    for field in FIELDS:
        if field not in wanted:
            continue
        if field == "table":
            title = facts.title
            if title:
                parts.append(f"{word} {title}")
        elif field == "zone":
            zone = _text(facts.zone)
            if zone:
                parts.append(zone)
        elif field == "guests":
            if isinstance(facts.guests, int) and facts.guests > 0:
                parts.append(ONE_GUEST if facts.guests == 1 else f"{facts.guests} {GUESTS_WORD}")
        elif field == "waiter":
            waiter = _text(facts.waiter)
            if waiter:
                parts.append(f"{WAITER_WORD}: {waiter}")
    return SEPARATOR.join(parts) or None


# ── The cloud's documents ───────────────────────────────────────────────────────

#: How far before a document its table may have been opened: app/services/table_documents.py's
#: `ORDER_MARGIN` (a long evening, a till's clock). The ids and the extras' documents are its helpers
#: too (`uuid_text`, `extra_document_ids`). The one-document lookup below stays its own: it also
#: follows a re-issue to its original and an order whose extras hold payments given back only,
#: which the history's batched `orders_by_tx` does not ask for.


def order_of_document(db, tx: Any) -> Any:
    """
    The table order `tx` paid — its sale, a part paid on its own, a payment given back — else, for a
    credit note (or a re-issue's new invoice), the one the document it stands for paid. None: no table's.
    The same link as the history's table search and the waiters' Z (`table_orders.transaction_id`,
    `extras_json.partials[].tx`, `extras_json.reversals[].credit`).
    """
    from app.models.tables import TableOrder

    if tx is None or getattr(tx, "shop_id", None) is None:
        return None
    ids = [i for i in (
        _uuid_text(tx.id),
        _uuid_text(getattr(tx, "refund_of_transaction_id", None)),
        _uuid_text(getattr(tx, "reissue_of_transaction_id", None)),
    ) if i]
    if not ids:
        return None
    direct = (
        db.query(TableOrder)
        .filter(TableOrder.shop_id == tx.shop_id, TableOrder.transaction_id.in_(ids))
        .all()
    )
    by_tx = {_uuid_text(o.transaction_id): o for o in direct}
    for wanted in ids:
        if wanted in by_tx:
            return by_tx[wanted]
    moment = getattr(tx, "created_at", None)
    query = db.query(TableOrder).filter(
        TableOrder.shop_id == tx.shop_id,
        TableOrder.extras_json.isnot(None),
        TableOrder.extras_json.like('%"partials"%') | TableOrder.extras_json.like('%"reversals"%'),
    )
    if moment is not None:
        query = query.filter(TableOrder.opened_at >= moment - ORDER_MARGIN)
    found: Dict[str, Any] = {}
    for order in query.all():
        for doc in extra_document_ids(order):
            found.setdefault(doc, order)
    for wanted in ids:
        if wanted in found:
            return found[wanted]
    return None


def facts_of_order(db, order: Any) -> Optional[TableFacts]:
    """The order's table as written — its number and name then, its zone's name, guests and waiter."""
    if order is None:
        return None
    zone = None
    if order.zone_id is not None:
        from app.models.tables import TableZone

        row = db.query(TableZone.name).filter(TableZone.id == order.zone_id).first()
        zone = row[0] if row is not None else None
    waiter = _text(getattr(order, "waiter_pos_user_name", None)) or _text(getattr(order, "opened_by_pos_user_name", None))
    return TableFacts(
        number=order.table_number, name=order.table_name, zone=zone, guests=order.guests, waiter=waiter,
        label=getattr(order, "table_label", None),
    )


def _document_params(db, tx: Any) -> Dict[str, Any]:
    from app.services.till_parameters import raw_parameters_for_machine, resolve_for_shop

    machine = getattr(tx, "machine", None)
    try:
        if machine is not None:
            return raw_parameters_for_machine(db, machine)
        if getattr(tx, "shop", None) is not None:
            return resolve_for_shop(db, tx.shop)
    except Exception:  # noqa: BLE001 - a copy prints without the line rather than not at all
        return {}
    return {}


def fields_for_document(db, tx: Any) -> List[str]:
    """`receiptTableInfo` as it stands for the document's till (else its shop)."""
    return parse_fields(_document_params(db, tx).get(KEY))


def line_for_document(db, tx: Any) -> Optional[str]:
    """The line the document's copy carries under its title, or None — the word before it the till's `tableTerm`."""
    from app.services.table_scope import term_of

    params = _document_params(db, tx)
    fields = parse_fields(params.get(KEY))
    if not fields:
        return None
    return table_line(fields, facts_of_order(db, order_of_document(db, tx)), term=term_of(params))
