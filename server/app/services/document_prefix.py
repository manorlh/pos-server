"""
"קידומת מסמכים" — every till prints and exports its document numbers under its own prefix.

Each till numbers its documents with its own counter (320 / 330 / 400 share it), and the
cloud keeps them unique per machine (`uq_tx_machine_number`). Two tills of one shop can
therefore both issue #57. The prefix tells them apart wherever a person or an inspector
reads a number: the till prints `2-57`, the cloud shows and reprints `2-57`, and the tax
export files `2-57`. docs/SPEC_DOCUMENT_PREFIX.md is the full rule; in short:

* **The rule.** Digits only, 1–3 characters (`PREFIX_RE`). The number is shown as
  `<prefix>-<number>` (`format_document_number`).
* **The default.** A till with no prefix of its own uses its register number
  (`pos_machines.pos_number`, "קופה 2" → `2`), so every existing till has a sensible
  prefix with no setup (`effective_prefix`).
* **Unique.** No two tills in one shop — or in shops of one tenant that file under the
  same non-empty branch code — may use the same prefix, and a prefix that already
  appears on another till's documents there is never handed out again
  (`check_prefix`, `settle_default`).
* **Frozen at issue.** The till stamps every document with the prefix it issued it
  under (`transactions.document_prefix`); a later change of the till's prefix never
  touches it. A document from before the prefix existed has none stored and reads as
  its `pos_number` — the register that issued it (`document_prefix_of`).
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

#: Digits only, 1–3 characters. Short because it is printed before every number and
#: filed inside the open-format document number (X(20), see `tax_report_generator`).
PREFIX_RE = re.compile(r"^[0-9]{1,3}$")
PREFIX_MAX_LEN = 3
#: Between the prefix and the number: `2-57`.
SEPARATOR = "-"

#: What a person types to find a document: `2-57` (also with an en dash / maqaf and
#: spaces around it), or `57` alone.
_QUERY_RE = re.compile(r"^\s*([0-9]{1,3})\s*[-\u2013\u2014\u05BE]\s*([0-9]{1,20})\s*$")
_NUMBER_RE = re.compile(r"^\s*([0-9]{1,20})\s*$")

INVALID_PREFIX_MESSAGE = "קידומת מסמכים: ספרות בלבד, בין 1 ל-3 תווים (למשל 2 או 12)."


def normalize_prefix(value: Any) -> Optional[str]:
    """The prefix as stored: trimmed text, or None for nothing / blank."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def is_valid_prefix(value: Any) -> bool:
    text = normalize_prefix(value)
    return text is not None and PREFIX_RE.match(text) is not None


def default_prefix(machine: Any) -> Optional[str]:
    """A till's default prefix: its register number, when that is 1–3 digits."""
    number = normalize_prefix(getattr(machine, "pos_number", None))
    return number if number is not None and PREFIX_RE.match(number) else None


def effective_prefix(machine: Any) -> Optional[str]:
    """The prefix a till issues documents under now: its own, else its register number."""
    if machine is None:
        return None
    own = normalize_prefix(getattr(machine, "document_prefix", None))
    return own if own is not None else default_prefix(machine)


def prefix_from(document_prefix: Any, pos_number: Any) -> Optional[str]:
    """
    The prefix a stored document reads under: the one frozen on it at issue, else (a
    document from before the prefix existed) the register number stamped on it when it
    arrived — the till that issued it. A register "number" that is not 1–3 digits (a
    shopless machine's `machine_code`) gives none: the bare number, as before.
    """
    frozen = normalize_prefix(document_prefix)
    if frozen is not None:
        return frozen
    number = normalize_prefix(pos_number)
    return number if number is not None and PREFIX_RE.match(number) else None


def document_prefix_of(tx: Any) -> Optional[str]:
    return prefix_from(getattr(tx, "document_prefix", None), getattr(tx, "pos_number", None))


def format_document_number(prefix: Optional[str], number: Any) -> str:
    """
    `2-57`; the bare number when there is no prefix. Only a plain counter takes a prefix:
    a number that is not all digits (a training document's `ה-12`, or one already shown
    as `2-57`) is returned as it is.
    """
    text = "" if number is None else str(number)
    p = normalize_prefix(prefix)
    return f"{p}{SEPARATOR}{text}" if p is not None and text.isdigit() else text


def document_number_of(tx: Any) -> str:
    """A stored document's number as printed and exported: `2-57`."""
    return format_document_number(document_prefix_of(tx), getattr(tx, "transaction_number", None))


def document_number_from(number: Any, document_prefix: Any, pos_number: Any) -> Optional[str]:
    """The same from loose columns (a column-tuple query); None when there is no number."""
    if number is None:
        return None
    return format_document_number(prefix_from(document_prefix, pos_number), number)


# ── Lookup ─────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DocumentQuery:
    """A document number as a person typed it: `2-57` → ("2", "57"); `57` → (None, "57")."""

    prefix: Optional[str]
    number: str


def parse_document_query(text: Any) -> Optional[DocumentQuery]:
    if not isinstance(text, str):
        return None
    m = _QUERY_RE.match(text)
    if m:
        return DocumentQuery(prefix=m.group(1), number=m.group(2))
    m = _NUMBER_RE.match(text)
    if m:
        return DocumentQuery(prefix=None, number=m.group(1))
    return None


def prefix_clause(prefix: str):
    """SQL: a document read under [prefix] — frozen on it, or (none frozen) its register."""
    from app.models.transaction import Transaction

    return or_(
        Transaction.document_prefix == prefix,
        and_(Transaction.document_prefix.is_(None), Transaction.pos_number == prefix),
    )


def prefixed_number_clause(text: Any):
    """
    SQL for `2-57`: number 57 issued under prefix 2. None when [text] is not of that
    shape — the caller keeps its own search (a plain `57`, a substring, an amount).
    """
    from app.models.transaction import Transaction

    query = parse_document_query(text)
    if query is None or query.prefix is None:
        return None
    return and_(Transaction.transaction_number == query.number, prefix_clause(query.prefix))


# ── Uniqueness ─────────────────────────────────────────────────────────────────────


class DocumentPrefixRefused(Exception):
    """A prefix this till may not take. `detail` is the Hebrew message for the dashboard."""

    def __init__(self, status_code: int, detail: str, code: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.code = code


def _branch_key(shop: Any) -> Optional[str]:
    """The branch code this shop's documents are filed under (field 1231), or None."""
    if shop is None:
        return None
    branch = None
    company = getattr(shop, "company", None)
    if company is not None:
        try:
            from app.services.settings_merge import build_business_info

            branch = build_business_info(company, shop).branch_id
        except Exception:  # noqa: BLE001 — a settings quirk must not block a till edit
            branch = None
    if not branch:
        branch = getattr(shop, "branch_id", None)
    text = normalize_prefix(branch)
    return text


def scope_shop_ids(db: Session, shop: Any) -> List[uuid.UUID]:
    """
    The shops whose tills must not share a prefix with a till of [shop]: the shop itself,
    and the other shops of its tenant filed under the same non-empty branch code (their
    documents carry the same branch in the tax export). An empty branch code joins no one:
    shops without one are told apart by the export being per shop (see the spec).
    """
    if shop is None:
        return []
    from app.models.shop import Shop

    ids = [shop.id]
    key = _branch_key(shop)
    if key is None or getattr(shop, "tenant_id", None) is None:
        return ids
    for other in (
        db.query(Shop).filter(Shop.tenant_id == shop.tenant_id, Shop.id != shop.id).all()
    ):
        if _branch_key(other) == key:
            ids.append(other.id)
    return ids


def _shop_of(db: Session, machine: Any) -> Any:
    """The machine's *current* shop, read by id: `machine.shop` may still be the old one
    right after `set_machine_shop` moved it."""
    shop_id = getattr(machine, "shop_id", None)
    if shop_id is None:
        return None
    from app.models.shop import Shop

    return db.query(Shop).filter(Shop.id == shop_id).first()


def _till_label(machine: Any) -> str:
    number = normalize_prefix(getattr(machine, "pos_number", None))
    name = normalize_prefix(getattr(machine, "name", None))
    head = f"קופה {number}" if number else "קופה"
    return f"{head} ({name})" if name else head


def _machine_scope(db: Session, machine: Any, shop_ids: List[uuid.UUID]):
    from app.models.pos_machine import POSMachine

    query = db.query(POSMachine).filter(POSMachine.shop_id.in_(shop_ids))
    if getattr(machine, "id", None) is not None:
        query = query.filter(POSMachine.id != machine.id)
    return query


def _document_scope(db: Session, machine: Any, shop_ids: List[uuid.UUID], columns: Iterable[Any]):
    from app.models.transaction import Transaction

    query = db.query(*columns).filter(Transaction.shop_id.in_(shop_ids))
    if getattr(machine, "id", None) is not None:
        query = query.filter(Transaction.machine_id != machine.id)
    return query


def holder_of(db: Session, machine: Any, prefix: str) -> Optional[str]:
    """
    Who already holds [prefix] in [machine]'s scope, as a Hebrew phrase, or None if free:
    another till that issues under it now, or another till's documents issued under it.
    """
    shop_ids = scope_shop_ids(db, _shop_of(db, machine))
    if not shop_ids:
        return None
    for other in _machine_scope(db, machine, shop_ids).all():
        if effective_prefix(other) == prefix:
            return f"ב{_till_label(other)}"
    from app.models.transaction import Transaction

    row = (
        _document_scope(db, machine, shop_ids, (Transaction.pos_number,))
        .filter(prefix_clause(prefix))
        .first()
    )
    if row is not None:
        number = normalize_prefix(row[0])
        return (
            f"על מסמכים שהופקו בקופה {number}" if number else "על מסמכים של קופה אחרת"
        )
    return None


def prefixes_in_use(db: Session, machine: Any) -> Dict[str, str]:
    """Every prefix held in [machine]'s scope (by a till or by documents), with its holder."""
    from app.models.transaction import Transaction

    shop_ids = scope_shop_ids(db, _shop_of(db, machine))
    used: Dict[str, str] = {}
    if not shop_ids:
        return used
    for other in _machine_scope(db, machine, shop_ids).all():
        p = effective_prefix(other)
        if p is not None:
            used.setdefault(p, f"ב{_till_label(other)}")
    for frozen, number in (
        _document_scope(db, machine, shop_ids, (Transaction.document_prefix, Transaction.pos_number))
        .distinct()
        .all()
    ):
        p = prefix_from(frozen, number)
        if p is not None:
            used.setdefault(p, "על מסמכים של קופה אחרת")
    return used


def check_prefix(db: Session, machine: Any, requested: Any) -> Optional[str]:
    """
    The prefix to store for [machine] (None: back to the default), or DocumentPrefixRefused.

    400 for a malformed prefix; 409 when the prefix — or, when clearing, the default it
    falls back to — is already held in the till's scope.
    """
    prefix = normalize_prefix(requested)
    if prefix is not None and not PREFIX_RE.match(prefix):
        raise DocumentPrefixRefused(400, INVALID_PREFIX_MESSAGE, "invalid_document_prefix")
    effective = prefix if prefix is not None else default_prefix(machine)
    if effective is None:
        return prefix
    holder = holder_of(db, machine, effective)
    if holder is not None:
        if prefix is None:
            detail = (
                f"ברירת המחדל של הקופה — מספר הקופה {effective} — כבר בשימוש {holder}. "
                "יש לבחור לקופה קידומת מסמכים אחרת."
            )
        else:
            detail = (
                f"קידומת המסמכים {effective} כבר בשימוש {holder}. לכל קופה בסניף "
                "חייבת להיות קידומת משלה, כדי ששתי קופות לא יפיקו אותו מספר מסמך."
            )
        raise DocumentPrefixRefused(409, detail, "document_prefix_in_use")
    return prefix


#: Where a prefix picked automatically (`settle_default`) starts: above any register
#: number a shop will realistically reach, so it never becomes another till's default.
AUTO_PREFIX_START = 101


def first_free_prefix(used: Iterable[str], *, start: int = 1) -> Optional[str]:
    taken = set(used)
    for n in range(max(start, 1), 1000):
        if str(n) not in taken:
            return str(n)
    return None


def settle_default(db: Session, machine: Any) -> Optional[str]:
    """
    After a till drew its register number: if it has no prefix of its own and its
    default (the register number) is already held in its scope — another till chose it,
    or it is on another till's documents — give it the lowest free prefix instead, so a
    new till never silently issues numbers another till already printed. Returns the
    prefix stored, or None when the default stands. Caller commits.
    """
    if getattr(machine, "shop_id", None) is None:
        return None
    if normalize_prefix(getattr(machine, "document_prefix", None)) is not None:
        return None
    default = default_prefix(machine)
    if default is None:
        return None
    if getattr(machine, "id", None) is None:
        db.flush()
    if holder_of(db, machine, default) is None:
        return None
    # From AUTO_PREFIX_START up, never the next free register number: that one is some
    # future till's default, and taking it would only move the clash onto that till.
    used = prefixes_in_use(db, machine)
    free = first_free_prefix(used, start=AUTO_PREFIX_START) or first_free_prefix(used)
    if free is not None:
        machine.document_prefix = free
    return free
