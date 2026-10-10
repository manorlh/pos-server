"""
The shop-wide daily pickup sequence of the self-order kiosks (`pickup.scope = "shop"`).

Every kiosk of a shop draws its order's pickup number from one counter per (shop,
business date). A kiosk asks with its own order key, so a retry after a lost answer gets
the same number back (`kiosk_pickup_allocations`, unique per shop + date + key). After
`max` the sequence wraps to `start`. Offline, the kiosk falls back to its own sequence
("kiosk" scope) — that is the till's business, not this module's.

**"מספר בלבד" (`pickup.labelFormat: "number"`, the owner 09.10.2026).** With its letter, a
number is told apart by the kiosk's prefix ("A-17" / "B-17", each kiosk its own sequence).
Alone it is not, so the number-only format always draws from this shop-wide counter
(kiosk_config `repair` forces `scope: "shop"`): one number per (shop, business date) across
every kiosk, until the day's sequence wraps after `max`. A number the kiosk had to draw alone
(the cloud did not answer) keeps its letter and the offline tag in either format ("AL-17",
"L-17"), so it can never be mistaken for one of the shop's.

**Search.** `parse_pickup_query` reads "17", "A17", "A-17" or "a-17" (spaces and dashes
dropped, upper case); a bare number matches every order of that number, a letter only its
label. The same rule on the till (pos-android domain/KioskPickupSearch.kt) and in the
dashboard (client lib/kioskPickupSearch.ts).

Concurrency: on Postgres the counter row is created with `INSERT … ON CONFLICT DO NOTHING`
and then read `FOR UPDATE`, so two kiosks asking at once serialise on it and never get the
same number. SQLite (the tests) ignores the lock; its writes are serialised anyway. A
same-key race that still slips through hits the allocation's unique constraint, and the
caller (the router) retries, finding the first allocation.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy.orm import Session

from app.models.kiosk import KioskPickupAllocation, KioskPickupCounter


#: `pickup.labelFormat` (app/services/kiosk_config.py): "A-17" (today's) or the number alone.
LABEL_PREFIXED = "prefixed"
LABEL_NUMBER = "number"


def pickup_label(prefix: Optional[str], number: int, label_format: Optional[str] = LABEL_PREFIXED) -> str:
    """
    The printed pickup label: "A-17" with prefix "A", plain "17" without one — and plain "17"
    whatever the prefix with `label_format="number"` ("מספר בלבד"). The same function on every
    kiosk: pos-android domain/KioskOrders.kt `KioskPickup.label`, client lib/kioskConfig.ts
    `pickupLabel` / lib/kioskWebOrders.ts `pickupLabelOf`, kiosk-desktop core/kioskOrders.ts.
    """
    if label_format == LABEL_NUMBER:
        return str(number)
    prefix = (prefix or "").strip()
    return f"{prefix}-{number}" if prefix else str(number)


# ── Search: "17", "A17", "A-17", "a-17" all find order A-17 ───────────────────

#: What a search box may hold around a pickup label: spaces and dashes of every kind, a "#".
_NOISE = re.compile(r"[\s\-‐-―−־#]+")
#: A label once normalised: up to 4 letters or digits of the prefix (3, plus the offline "L")
#: then the number — "A17", "AL17", "17", "א17".
_LABEL_KEY = re.compile(r"^[A-Z0-9א-ת]{0,4}?([0-9]{1,4})$")


def label_key(text: Optional[str]) -> str:
    """A label or a typed search as compared: no spaces or dashes, upper case ("a-17" → "A17")."""
    return _NOISE.sub("", text or "").upper()


@dataclass(frozen=True)
class PickupQuery:
    """
    A search box read as a pickup number: `key` — the label as compared ("A17"), `number` — its
    trailing digits (17), `digits_only` — the box held nothing but the number, which then matches
    every order of that number, whatever its letter ("17" finds A-17 and B-17; "A17" only A-17).
    """

    key: str
    number: int
    digits_only: bool

    def matches(self, label: Optional[str], number: Optional[int]) -> bool:
        if label and label_key(label) == self.key:
            return True
        return self.digits_only and number is not None and int(number) == self.number


def parse_pickup_query(text: Optional[str]) -> Optional[PickupQuery]:
    """What the box asks as a pickup number, or None (a product name, a long document number)."""
    key = label_key(text)
    if key.isdigit():
        # A pickup number is 1..9999; a longer one is a document number ("20000057"), not this.
        return PickupQuery(key=key, number=int(key), digits_only=True) if len(key) <= 4 else None
    m = _LABEL_KEY.match(key)
    if not m:
        return None
    return PickupQuery(key=key, number=int(m.group(1)), digits_only=False)


#: The most kiosk orders one search follows to their documents (a busy tenant's month of "17"s).
SEARCH_ORDERS_MAX = 5000


def transaction_ids_for(
    db: Session,
    query: PickupQuery,
    *,
    tenant_id=None,
    shop_id=None,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> List[uuid.UUID]:
    """
    The documents of the kiosk orders a pickup query finds (the kiosk's own sale, or the
    till's that took a pay-at-till order), newest business day first. The dates are business
    dates, widened by a day each way: a document's UTC time may fall on the next date.
    """
    from datetime import timedelta

    from app.models.kiosk import KioskOrder

    rows = db.query(KioskOrder.transaction_id).filter(
        order_match_clause(query), KioskOrder.transaction_id.isnot(None)
    )
    if tenant_id is not None:
        rows = rows.filter(KioskOrder.tenant_id == tenant_id)
    if shop_id is not None:
        rows = rows.filter(KioskOrder.shop_id == shop_id)
    if from_date is not None:
        rows = rows.filter(KioskOrder.business_date >= from_date - timedelta(days=1))
    if to_date is not None:
        rows = rows.filter(KioskOrder.business_date <= to_date + timedelta(days=1))
    out: List[uuid.UUID] = []
    for (tx_id,) in rows.order_by(KioskOrder.business_date.desc()).limit(SEARCH_ORDERS_MAX).all():
        try:
            out.append(uuid.UUID(str(tx_id)))
        except ValueError:
            continue
    return out


def pickups_by_transaction(db: Session, transaction_ids: Iterable[Any]) -> Dict[str, Dict[str, Any]]:
    """
    Per document id (as text), the kiosk order it paid — `{label, number, businessDate}` — for a
    page of documents (one query). A document of no kiosk order is not in the map.
    """
    from app.models.kiosk import KioskOrder

    keys = sorted({str(t) for t in transaction_ids if t})
    if not keys:
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    rows = (
        db.query(KioskOrder.transaction_id, KioskOrder.pickup_label, KioskOrder.pickup_number, KioskOrder.business_date)
        .filter(KioskOrder.transaction_id.in_(keys))
        .all()
    )
    for tx_id, label, number, business_date in rows:
        out.setdefault(str(tx_id), {
            "label": label or str(number),
            "number": number,
            "businessDate": business_date.isoformat() if business_date else None,
        })
    return out


def search_matches(
    q: Optional[str], transaction_number: Optional[str], total_amount: Any, pickup: Optional[Dict[str, Any]]
) -> Optional[List[str]]:
    """
    Why a document search (`q`) found a document, for the list to say so: "document" — its
    number or amount (the search's own rule: a full `20000057`, else a substring of the number
    or the amount), "pickup" — the kiosk order it paid (`pickup`, from `pickups_by_transaction`).
    "17" may be both. None without a search.
    """
    from app.services.document_prefix import parse_document_query

    if not isinstance(q, str) or not q.strip():
        return None
    needle = q.strip()
    number = str(transaction_number or "")
    out: List[str] = []
    parsed = parse_document_query(needle)
    if parsed is not None and parsed.prefix is not None:
        by_document = number in {parsed.number, parsed.bare}
    else:
        by_document = needle.lower() in number.lower() or (total_amount is not None and needle in str(total_amount))
    if by_document:
        out.append("document")
    query = parse_pickup_query(needle)
    if pickup and query is not None and query.matches(pickup.get("label"), pickup.get("number")):
        out.append("pickup")
    return out


def label_key_sql(column):
    """`label_key` in SQL: the stored labels have no spaces, only ASCII dashes ("A-17", "AL-17")."""
    from sqlalchemy import func

    return func.upper(func.replace(column, "-", ""))


def order_match_clause(query: PickupQuery):
    """The `kiosk_orders` rows a pickup query finds (`PickupQuery.matches` in SQL)."""
    from sqlalchemy import or_

    from app.models.kiosk import KioskOrder

    by_label = label_key_sql(KioskOrder.pickup_label) == query.key
    if query.digits_only:
        return or_(by_label, KioskOrder.pickup_number == query.number)
    return by_label


def next_number(last_number: Optional[int], start: int, max_number: int) -> int:
    """The number after `last_number` in [start, max]: a fresh day starts at `start`, `max` wraps."""
    if last_number is None or last_number < start or last_number >= max_number:
        return start
    return last_number + 1


@dataclass
class Allocation:
    number: int
    label: str
    created: bool


def _existing(db: Session, shop_id, business_date: date, order_key: str) -> Optional[KioskPickupAllocation]:
    return (
        db.query(KioskPickupAllocation)
        .filter(
            KioskPickupAllocation.shop_id == shop_id,
            KioskPickupAllocation.business_date == business_date,
            KioskPickupAllocation.order_key == order_key,
        )
        .first()
    )


def counter_upsert_statement(shop_id, business_date: date):
    """Postgres: create the day's counter row if missing, never failing on a concurrent create."""
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    return (
        pg_insert(KioskPickupCounter.__table__)
        .values(shop_id=shop_id, business_date=business_date, last_number=0)
        .on_conflict_do_nothing(index_elements=["shop_id", "business_date"])
    )


def counter_lock_query(db: Session, shop_id, business_date: date):
    """The day's counter row, `SELECT … FOR UPDATE` (serialises concurrent allocations)."""
    return (
        db.query(KioskPickupCounter)
        .filter(KioskPickupCounter.shop_id == shop_id, KioskPickupCounter.business_date == business_date)
        .with_for_update()
        .populate_existing()
    )


def _locked_counter(db: Session, shop_id, business_date: date) -> KioskPickupCounter:
    if db.get_bind().dialect.name == "postgresql":
        db.execute(counter_upsert_statement(shop_id, business_date))
    counter = counter_lock_query(db, shop_id, business_date).first()
    if counter is None:
        counter = KioskPickupCounter(shop_id=shop_id, business_date=business_date, last_number=0)
        db.add(counter)
        db.flush()
    return counter


def allocate(
    db: Session,
    *,
    shop_id,
    business_date: date,
    order_key: str,
    start: int,
    max_number: int,
    prefix: str = "",
    machine_id=None,
    label_format: Optional[str] = LABEL_PREFIXED,
) -> Allocation:
    """
    The pickup number for this order key in the shop's sequence of that day. Idempotent
    per (shop, date, key): asking again returns the first answer, even if the kiosk's
    prefix, range or label format changed since. The caller commits.

    The number is unique among the shop's kiosks that day whatever their letters (one counter
    per shop and date) — which is what lets `label_format="number"` print the number alone.
    """
    found = _existing(db, shop_id, business_date, order_key)
    if found is not None:
        return Allocation(found.number, found.label, False)
    counter = _locked_counter(db, shop_id, business_date)
    # Another request with the same key may have allocated while we waited for the lock.
    found = _existing(db, shop_id, business_date, order_key)
    if found is not None:
        return Allocation(found.number, found.label, False)
    number = next_number(counter.last_number, start, max_number)
    counter.last_number = number
    label = pickup_label(prefix, number, label_format)
    db.add(
        KioskPickupAllocation(
            id=uuid.uuid4(),
            shop_id=shop_id,
            business_date=business_date,
            order_key=order_key,
            number=number,
            label=label,
            machine_id=machine_id,
        )
    )
    db.flush()
    return Allocation(number, label, True)
