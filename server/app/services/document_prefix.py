"""
"קידומת מסמכים" and "רצף לכל סוג מסמך" — how a till's document numbers are told apart.

Each till numbers its documents with **one counter per document type** — 320 (חשבונית מס
קבלה), 330 (חשבונית זיכוי) and 400 (קבלה; an exempt dealer's refund, the internal -400,
shares the 400 series) — and the cloud keeps them unique per machine, series and number
(`uq_tx_machine_series_number`). Two tills of one shop can therefore both issue a 320 #57,
and one till a 320 #57 and a 330 #57. The prefix tells the tills apart and the document
type tells the series apart, wherever a person or an inspector reads a number.
docs/SPEC_DOCUMENT_PREFIX.md is the full rule; in short:

* **The format (owner: "ללא מקף").** The prefix immediately followed by the number padded
  to 7 digits: prefix 2, document 57 → `20000057`; prefix 101 → `1010000057`. The number
  is always exactly the last 7 digits, so the form is unambiguous (`format_document_number`).
  No prefix: the bare number, as before. A number above 9,999,999 cannot be padded to 7:
  it is written `<prefix>-<number>` — the only form with a dash, so it can never be
  mistaken for a padded one (`NUMBER_MAX`).
* **The series (owner: "רצף מספרים נפרד לכל מסמך").** `document_series_of`: 320, 330 or
  400 (-400 → 400). A number identifies a document only together with its type.
* **The default prefix.** A till with no prefix of its own uses its register number
  (`pos_machines.pos_number`, "קופה 2" → `2`), so every existing till has a sensible
  prefix with no setup (`effective_prefix`). When a till draws its register number and
  that number is already held in the business (branch 2's "קופה 1" while branch 1 has a
  "קופה 1"), it is given the lowest free prefix of the business instead (`settle_default`),
  stored as its own — so `effective_prefix` stays a plain reading of the till's row.
* **Unique in the business (owner, after the Tax Authority's simulator).** The open-format
  file is one per business — the עוסק, every branch of it — and the simulator refuses a
  file in which two documents of one type carry one number, whatever their branch codes
  ("נמצאה יותר מרשומה אחת עם אותו מס אסמכתא"). So no two tills of the business — every
  shop of the company, and of any company of the tenant filed under the same VAT number —
  may use the same prefix, and a prefix that already appears on another till's documents
  there is never handed out again (`business_shop_ids`, `check_prefix`, `settle_default`).
  Tills that already collide are listed (`prefix_conflicts`) and can be given a free
  prefix (`assign_free_prefix`) — for their future documents only.
* **Frozen at issue.** The till stamps every document with the prefix it issued it
  under (`transactions.document_prefix`); a later change of the till's prefix never
  touches it. A document from before the prefix existed has none stored and reads as
  its `pos_number` — the register that issued it (`document_prefix_of`).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

#: Digits only, 1–3 characters. Short because it is printed before every number and
#: filed inside the open-format document number (X(20), see `tax_report_generator`).
PREFIX_RE = re.compile(r"^[0-9]{1,3}$")
PREFIX_MAX_LEN = 3
#: The number part of a prefixed document number: always exactly this many digits.
NUMBER_WIDTH = 7
#: The highest number that fits [NUMBER_WIDTH]. Above it a prefixed number is written with
#: [OVERFLOW_SEPARATOR] instead — never padded into something another number could be.
NUMBER_MAX = 10**NUMBER_WIDTH - 1
#: Only in a number above [NUMBER_MAX]: `2-10000000`.
OVERFLOW_SEPARATOR = "-"
#: Kept for readers of the earlier form.
SEPARATOR = OVERFLOW_SEPARATOR

#: The document series a type is numbered in (`document_series_of`).
SERIES_INVOICE_RECEIPT = 320
SERIES_CREDIT_NOTE = 330
SERIES_RECEIPT = 400
SERIES = (SERIES_INVOICE_RECEIPT, SERIES_CREDIT_NOTE, SERIES_RECEIPT)

#: What a person types to find a document: the full form (`20000057`, 8–10 digits), a
#: short number (`57`), or the overflow form `2-10000000` (an en dash / maqaf too).
_DASHED_RE = re.compile(r"^\s*([0-9]{1,3})\s*[-–—־]\s*([0-9]{1,20})\s*$")
_NUMBER_RE = re.compile(r"^\s*([0-9]{1,20})\s*$")

INVALID_PREFIX_MESSAGE = "קידומת מסמכים: ספרות בלבד, בין 1 ל-3 תווים (למשל 2 או 12)."


def document_series_of(document_type: Any, refund_of_transaction_id: Any = None) -> int:
    """
    The series a document is numbered in: 320, 330 or 400. An exempt dealer's refund
    (-400, "קבלה במינוס") shares the 400 series, so a 400 and a -400 never carry the same
    number. A document with no type (an old one) is a 330 when it credits an original,
    else a 320 — the same reading as `tenders.is_refund_document`.
    """
    try:
        t = int(document_type) if document_type is not None else None
    except (TypeError, ValueError):
        t = None
    if t in (400, -400):
        return SERIES_RECEIPT
    if t == 330 or (t is None and refund_of_transaction_id is not None):
        return SERIES_CREDIT_NOTE
    if t is None or t == 320:
        return SERIES_INVOICE_RECEIPT
    return abs(t)


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
    The number as printed and exported: the prefix, then the number padded to 7 digits —
    `20000057`. The bare number when there is no prefix. Only a plain counter takes a
    prefix: a number that is not all digits (a training document's `ה-12`) is returned as
    it is. Above 9,999,999: `<prefix>-<number>` (`NUMBER_MAX`), never an ambiguous pad.
    """
    text = "" if number is None else str(number).strip()
    p = normalize_prefix(prefix)
    if p is None or not text or not (text.isascii() and text.isdigit()):
        return text
    value = int(text)
    if value > NUMBER_MAX:
        return f"{p}{OVERFLOW_SEPARATOR}{value}"
    return f"{p}{value:0{NUMBER_WIDTH}d}"


def document_number_of(tx: Any) -> str:
    """A stored document's number as printed and exported: `20000057`."""
    return format_document_number(document_prefix_of(tx), getattr(tx, "transaction_number", None))


def document_number_from(number: Any, document_prefix: Any, pos_number: Any) -> Optional[str]:
    """The same from loose columns (a column-tuple query); None when there is no number."""
    if number is None:
        return None
    return format_document_number(prefix_from(document_prefix, pos_number), number)


# ── Lookup ─────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DocumentQuery:
    """
    A document number as a person typed it. `20000057` → prefix "2", number "57" (the
    last 7 digits are the number), and `bare` "20000057" too, for a till with no prefix
    whose counter is that long. `57` → no prefix, number "57". `2-10000000` → "2",
    "10000000".
    """

    prefix: Optional[str]
    number: str
    bare: Optional[str] = None


def parse_document_query(text: Any) -> Optional[DocumentQuery]:
    if not isinstance(text, str):
        return None
    m = _DASHED_RE.match(text)
    if m:
        return DocumentQuery(prefix=m.group(1), number=str(int(m.group(2))))
    m = _NUMBER_RE.match(text)
    if not m:
        return None
    digits = m.group(1)
    if NUMBER_WIDTH < len(digits) <= NUMBER_WIDTH + PREFIX_MAX_LEN:
        return DocumentQuery(
            prefix=digits[:-NUMBER_WIDTH], number=str(int(digits[-NUMBER_WIDTH:])), bare=digits
        )
    return DocumentQuery(prefix=None, number=digits)


def prefix_clause(prefix: str):
    """SQL: a document read under [prefix] — frozen on it, or (none frozen) its register."""
    from app.models.transaction import Transaction

    return or_(
        Transaction.document_prefix == prefix,
        and_(Transaction.document_prefix.is_(None), Transaction.pos_number == prefix),
    )


def prefixed_number_clause(text: Any):
    """
    SQL for a full document number (`20000057`, or `2-10000000`): number 57 issued under
    prefix 2 — of any type, so a 320 and a 330 of that number both answer and the reader
    picks. A full-length number also matches a document of a till with no prefix whose
    counter is exactly that. None when [text] is not a full number: the caller keeps its
    own search (a short `57`, a substring, an amount).
    """
    from app.models.transaction import Transaction

    query = parse_document_query(text)
    if query is None or query.prefix is None:
        return None
    prefixed = and_(Transaction.transaction_number == query.number, prefix_clause(query.prefix))
    if query.bare is None:
        return prefixed
    return or_(
        prefixed,
        and_(Transaction.transaction_number == query.bare, Transaction.document_prefix.is_(None)),
    )


# ── Uniqueness ─────────────────────────────────────────────────────────────────────


class DocumentPrefixRefused(Exception):
    """A prefix this till may not take. `detail` is the Hebrew message for the dashboard."""

    def __init__(self, status_code: int, detail: str, code: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.code = code


#: Why a prefix must be unique in the whole business — said with every refusal.
WHY_BUSINESS_WIDE = (
    "לכל קופה בעסק — בכל הסניפים — חייבת להיות קידומת משלה: קובץ המבנה האחיד הוא אחד לכל "
    "העסק, ושני מסמכים מאותו סוג לא יכולים לשאת בו אותו מספר."
)


def _vat_key(company: Any) -> Optional[str]:
    """
    The business a company files under: its VAT number (ע"מ / ח"פ) as the export writes
    it (`build_business_info`: a `businessInfo.vatNumber` setting wins over the column),
    digits only, 9 wide. None when it has none (or only zeros): such a company is a
    business of its own.
    """
    if company is None:
        return None
    vat: Any = None
    try:
        from app.services.settings_merge import build_business_info

        vat = build_business_info(company).vat_number
    except Exception:  # noqa: BLE001 — a settings quirk must not block a till edit
        vat = getattr(company, "vat_number", None)
    digits = "".join(c for c in str(vat or "") if c.isascii() and c.isdigit())
    if not digits.strip("0"):
        return None
    return digits.zfill(9)


def business_company_ids(db: Session, company: Any) -> List[Any]:
    """
    The companies that file one open-format file together with [company]: itself, and any
    other company of its tenant under the same VAT number (one עוסק set up as two
    companies in the system). The export runs per company today; a second company under
    the same number still files with the same Tax Authority file number, so its tills
    must not repeat this one's numbers either.
    """
    if company is None:
        return []
    ids = [company.id]
    key = _vat_key(company)
    tenant_id = getattr(company, "tenant_id", None)
    if key is None or tenant_id is None:
        return ids
    from app.models.company import Company

    for other in db.query(Company).filter(Company.tenant_id == tenant_id, Company.id != company.id).all():
        if _vat_key(other) == key:
            ids.append(other.id)
    return ids


def business_shop_ids(db: Session, shop: Any) -> List[Any]:
    """
    The shops whose tills must not share a prefix with a till of [shop]: every shop of
    the business — all the shops of its company, and of the companies filed under the
    same VAT number (`business_company_ids`). [shop] itself first.

    It used to be the shop (and shops filed under the same branch code), on the reading
    that the branch code (field 1231) tells two branches' `10000057` apart. The Tax
    Authority's simulator does not: in one business's file it refuses two documents of
    one type with one number, whatever their branch ("נמצאה יותר מרשומה אחת עם אותו מס
    אסמכתא", C100 field 1204).
    """
    if shop is None:
        return []
    from app.models.company import Company
    from app.models.shop import Shop

    ids = [shop.id]
    company_id = getattr(shop, "company_id", None)
    company = db.query(Company).filter(Company.id == company_id).first() if company_id is not None else None
    if company is None:
        return ids
    for (sid,) in db.query(Shop.id).filter(Shop.company_id.in_(business_company_ids(db, company))).all():
        if str(sid) != str(shop.id):
            ids.append(sid)
    return ids


#: The earlier name. The scope is the whole business now (`business_shop_ids`).
scope_shop_ids = business_shop_ids


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


def _shop_names(db: Session, shop_ids: Iterable[Any]) -> Dict[str, str]:
    ids = [s for s in shop_ids if s is not None]
    if not ids:
        return {}
    from app.models.shop import Shop

    return {str(sid): name for sid, name in db.query(Shop.id, Shop.name).filter(Shop.id.in_(ids)).all()}


def _where(shop_id: Any, home_shop_id: Any, names: Dict[str, str]) -> str:
    """` בסניף "צפון"` for a holder in another shop than the till's own; nothing in its own."""
    if shop_id is None or str(shop_id) == str(home_shop_id):
        return ""
    name = names.get(str(shop_id))
    return f' בסניף "{name}"' if name else " בסניף אחר"


def _machine_scope(db: Session, machine: Any, shop_ids: List[Any]):
    from app.models.pos_machine import POSMachine

    query = db.query(POSMachine).filter(POSMachine.shop_id.in_(shop_ids))
    if getattr(machine, "id", None) is not None:
        query = query.filter(POSMachine.id != machine.id)
    return query


def _document_scope(db: Session, machine: Any, shop_ids: List[Any], columns: Iterable[Any]):
    from app.models.transaction import Transaction

    query = db.query(*columns).filter(Transaction.shop_id.in_(shop_ids))
    if getattr(machine, "id", None) is not None:
        query = query.filter(Transaction.machine_id != machine.id)
    return query


def holder_of(db: Session, machine: Any, prefix: str) -> Optional[str]:
    """
    Who already holds [prefix] in [machine]'s business, as a Hebrew phrase, or None if
    free: another till that issues under it now, or another till's documents issued under
    it — in any shop of the business (`business_shop_ids`).
    """
    home = getattr(machine, "shop_id", None)
    shop_ids = business_shop_ids(db, _shop_of(db, machine))
    if not shop_ids:
        return None
    names = _shop_names(db, shop_ids)
    for other in _machine_scope(db, machine, shop_ids).all():
        if effective_prefix(other) == prefix:
            return f"ב{_till_label(other)}{_where(other.shop_id, home, names)}"
    from app.models.transaction import Transaction

    row = (
        _document_scope(db, machine, shop_ids, (Transaction.pos_number, Transaction.shop_id))
        .filter(prefix_clause(prefix))
        .first()
    )
    if row is not None:
        number = normalize_prefix(row[0])
        where = _where(row[1], home, names)
        return (
            f"על מסמכים שהופקו בקופה {number}{where}" if number else f"על מסמכים של קופה אחרת{where}"
        )
    return None


def prefixes_in_use(db: Session, machine: Any) -> Dict[str, str]:
    """Every prefix held in [machine]'s business (by a till or by documents), with its holder."""
    from app.models.transaction import Transaction

    shop_ids = business_shop_ids(db, _shop_of(db, machine))
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
    falls back to — is already held anywhere in the till's business.
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
                f"יש לבחור לקופה קידומת מסמכים אחרת. {WHY_BUSINESS_WIDE}"
            )
        else:
            detail = f"קידומת המסמכים {effective} כבר בשימוש {holder}. {WHY_BUSINESS_WIDE}"
        raise DocumentPrefixRefused(409, detail, "document_prefix_in_use")
    return prefix


def first_free_prefix(used: Iterable[str], *, start: int = 1) -> Optional[str]:
    taken = set(used)
    for n in range(max(start, 1), 1000):
        if str(n) not in taken:
            return str(n)
    return None


def lowest_free_prefix(db: Session, machine: Any) -> Optional[str]:
    """The lowest prefix (1–999) no other till of [machine]'s business holds, and no other
    till's documents there carry. None when all 999 are taken."""
    return first_free_prefix(prefixes_in_use(db, machine))


def settle_default(db: Session, machine: Any) -> Optional[str]:
    """
    After a till drew its register number: if it has no prefix of its own and its
    default (the register number) is already held in its business — another till of any
    branch uses it, or it is on another till's documents — give it the lowest free prefix
    of the business instead (branch 2's "קופה 1" next to branch 1's tills 1–3 gets 4), so
    a new till never silently issues numbers another till already printed. Returns the
    prefix stored, or None when the default stands. Caller commits.

    Lowest free, not "from 101 up" as before: the prefix is printed on every document,
    and a later till whose register number was taken this way gets the next free one the
    same way.
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
    free = lowest_free_prefix(db, machine)
    if free is not None:
        machine.document_prefix = free
    return free


# ── Tills that already collide ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Holding:
    """One machine's documents under one prefix in one series: how many, the highest."""

    count: int
    highest: int


def _document_holdings(db: Session, shop_ids: List[Any]) -> Dict[tuple, _Holding]:
    """
    (machine id, prefix, series) → its documents' count and highest number, for every
    document of the business with a plain numeric number. One grouped query on Postgres;
    a scan elsewhere (the tests' SQLite).
    """
    from sqlalchemy import BigInteger, func

    from app.models.transaction import Transaction

    out: Dict[tuple, _Holding] = {}

    def add(machine_id: Any, frozen: Any, pos_number: Any, series: Any, count: int, highest: int) -> None:
        p = prefix_from(frozen, pos_number)
        if p is None or machine_id is None or series is None:
            return
        key = (str(machine_id), p, int(series))
        was = out.get(key)
        out[key] = _Holding(
            count=(was.count if was else 0) + int(count),
            highest=max(was.highest if was else 0, int(highest)),
        )

    if not shop_ids:
        return out
    if db.get_bind().dialect.name == "postgresql":
        rows = (
            db.query(
                Transaction.machine_id,
                Transaction.document_prefix,
                Transaction.pos_number,
                Transaction.document_series,
                func.count(),
                func.max(Transaction.transaction_number.cast(BigInteger)),
            )
            .filter(
                Transaction.shop_id.in_(shop_ids),
                Transaction.transaction_number.op("~")("^[0-9]{1,18}$"),
            )
            .group_by(
                Transaction.machine_id,
                Transaction.document_prefix,
                Transaction.pos_number,
                Transaction.document_series,
            )
            .all()
        )
        for machine_id, frozen, pos_number, series, count, highest in rows:
            add(machine_id, frozen, pos_number, series, count, highest or 0)
        return out
    for machine_id, frozen, pos_number, document_type, refund_of, number in db.query(
        Transaction.machine_id,
        Transaction.document_prefix,
        Transaction.pos_number,
        Transaction.document_type,
        Transaction.refund_of_transaction_id,
        Transaction.transaction_number,
    ).filter(Transaction.shop_id.in_(shop_ids)):
        text = str(number or "")
        if not (text.isascii() and text.isdigit() and len(text) <= 18):
            continue
        add(machine_id, frozen, pos_number, document_series_of(document_type, refund_of), 1, int(text))
    return out


def _counters(db: Session, machine: Any, holdings: Dict[tuple, _Holding]) -> Dict[int, int]:
    """Where [machine]'s own counters stand, per series: its highest number in the cloud
    under any prefix, raised to what the till last reported (it may hold unsent ones)."""
    mid = str(machine.id)
    per: Dict[int, int] = {}
    for (m, _p, series), h in holdings.items():
        if m == mid:
            per[series] = max(per.get(series, 0), h.highest)
    reported = getattr(machine, "reported_document_counters", None)
    if isinstance(reported, dict):
        for series, value in reported.items():
            try:
                s, n = int(series), int(value)
            except (TypeError, ValueError):
                continue
            per[s] = max(per.get(s, 0), n)
    return per


def conflicts_in_shops(db: Session, shop_ids: List[Any]) -> List[Dict[str, Any]]:
    """
    Every active till of the business (`shop_ids`) whose prefix in force collides — the
    rule of `prefix_conflicts`, as rows for the dashboard.
    """
    from app.models.pos_machine import POSMachine
    from app.models.shop import Shop

    if not shop_ids:
        return []
    tills = db.query(POSMachine).filter(POSMachine.shop_id.in_(shop_ids)).all()
    shops = {str(s.id): s for s in db.query(Shop).filter(Shop.id.in_(shop_ids)).all()}
    holdings = _document_holdings(db, shop_ids)
    by_id = {str(t.id): t for t in tills}
    prefix_of = {str(t.id): effective_prefix(t) for t in tills}
    doc_counts: Dict[tuple, int] = {}  # (machine id, prefix) → documents under it
    for (m, p, _s), h in holdings.items():
        doc_counts[(m, p)] = doc_counts.get((m, p), 0) + h.count
    # The register a machine's documents name, for one no longer among the business's tills.
    issuers: Dict[str, Optional[str]] = {}
    if any(m not in by_id for (m, _p, _s) in holdings):
        from app.models.transaction import Transaction

        for m, pos in (
            db.query(Transaction.machine_id, Transaction.pos_number)
            .filter(Transaction.shop_id.in_(shop_ids))
            .distinct()
            .all()
        ):
            issuers.setdefault(str(m), normalize_prefix(pos))

    def shop_name(shop_id: Any) -> Optional[str]:
        s = shops.get(str(shop_id))
        return s.name if s is not None else None

    used = {p for p in prefix_of.values() if p} | {p for (_m, p, _s) in holdings}
    out: List[Dict[str, Any]] = []
    for till in sorted(tills, key=lambda t: (shop_name(t.shop_id) or "", str(t.pos_number or ""), str(t.id))):
        if not getattr(till, "is_active", True):
            continue
        tid = str(till.id)
        p = prefix_of.get(tid)
        if p is None:
            continue
        holders: List[Dict[str, Any]] = []
        # 1. Another till of the business issues under the same prefix now. Of a group,
        # the one with the most documents under it keeps it; the others move.
        group = [t for t in tills if prefix_of.get(str(t.id)) == p]
        if len(group) > 1:
            keeper = sorted(
                group,
                key=lambda t: (-doc_counts.get((str(t.id), p), 0), str(getattr(t, "created_at", None) or ""), str(t.id)),
            )[0]
            if keeper is not till:
                for other in group:
                    if other is till:
                        continue
                    holders.append({
                        "kind": "till",
                        "machineId": str(other.id),
                        "posNumber": other.pos_number,
                        "machineName": other.name,
                        "shopId": str(other.shop_id) if other.shop_id else None,
                        "shopName": shop_name(other.shop_id),
                    })
        # 2. Another till's documents under this prefix reach past this till's counters:
        # its next numbers would repeat them.
        counters = _counters(db, till, holdings)
        seen = {h["machineId"] for h in holders}
        for (m, hp, series), h in sorted(holdings.items()):
            if hp != p or m == tid or m in seen:
                continue
            if h.highest > counters.get(series, 0):
                other = by_id.get(m)
                holders.append({
                    "kind": "documents",
                    "machineId": m,
                    "posNumber": (other.pos_number if other is not None else None) or issuers.get(m),
                    "machineName": other.name if other is not None else None,
                    "shopId": str(other.shop_id) if other is not None and other.shop_id else None,
                    "shopName": shop_name(other.shop_id) if other is not None else None,
                    "series": series,
                    "highest": h.highest,
                    "ownHighest": counters.get(series, 0),
                })
                seen.add(m)
        if not holders:
            continue
        suggested = first_free_prefix(used)
        if suggested is not None:
            used.add(suggested)
        shop = shops.get(str(till.shop_id))
        out.append({
            "machineId": tid,
            "machineName": till.name,
            "posNumber": till.pos_number,
            "shopId": str(till.shop_id),
            "shopName": shop.name if shop is not None else None,
            "branchId": getattr(shop, "branch_id", None) if shop is not None else None,
            "prefix": p,
            "ownPrefix": normalize_prefix(till.document_prefix) is not None,
            "heldBy": [{**h, "text": _holder_text(h, till.shop_id, shops)} for h in holders],
            "suggestedPrefix": suggested,
        })
    return out


def _holder_text(h: Dict[str, Any], home_shop_id: Any, shops: Dict[str, Any]) -> str:
    names = {k: s.name for k, s in shops.items()}
    where = _where(h.get("shopId"), home_shop_id, names)
    number = normalize_prefix(h.get("posNumber"))
    till = f"קופה {number}" if number else "קופה אחרת"
    name = normalize_prefix(h.get("machineName"))
    label = f"{till} ({name})" if name else till
    if h["kind"] == "till":
        return f"גם {label}{where} מנפיקה תחת הקידומת הזו"
    series = h.get("series")
    kind = {320: "חשבוניות מס קבלה", 330: "חשבוניות זיכוי", 400: "קבלות"}.get(series, f"מסמכים מסוג {series}")
    return (
        f"{kind} של {label}{where} תחת הקידומת הזו מגיעות עד מספר {h.get('highest')}, "
        f"והמונה של הקופה הזו רק ב-{h.get('ownHighest')} — המספרים הבאים שלה יחזרו עליהם"
    )


def prefix_conflicts(db: Session, shop: Any) -> List[Dict[str, Any]]:
    """
    The active tills of [shop]'s business whose prefix in force would give a document
    number another document of the business already has, or will have (docs/
    SPEC_DOCUMENT_PREFIX.md §5): the dashboard's warning, each with a free prefix to move to.

    A till collides when
    1. another till of the business issues under the same prefix now — of such a group
       the till with the most documents under the prefix keeps it and the others are
       listed (branch 2's "קופה 1" beside branch 1's, both on prefix 1); or
    2. another till's documents under the prefix reach a higher number, in some document
       type, than this till's own counter there — so its next numbers would repeat them.
       A till whose counters are past every such number keeps its prefix.

    Moving a till changes its future documents only; what it already issued keeps the
    prefix frozen on it (and two documents already issued under one number stay so — the
    export refuses a file holding both, `tax_reports.refuse_duplicate_document_numbers`).
    """
    return conflicts_in_shops(db, business_shop_ids(db, shop))


def company_business_shop_ids(db: Session, company: Any) -> List[Any]:
    """Every shop of [company]'s business (`business_company_ids`)."""
    if company is None:
        return []
    from app.models.shop import Shop

    return [sid for (sid,) in db.query(Shop.id).filter(Shop.company_id.in_(business_company_ids(db, company))).all()]


def company_prefix_conflicts(db: Session, company: Any) -> List[Dict[str, Any]]:
    """`prefix_conflicts` for a company: its business's colliding tills."""
    return conflicts_in_shops(db, company_business_shop_ids(db, company))


def prefix_status(db: Session, machine: Any) -> Dict[str, Any]:
    """
    One till's prefix against its business, for the till's page: the prefix in force,
    whether it is its own or the default, whether it is unique in the business (§5), and
    when not, who else holds it and the lowest free prefix.
    """
    shop = _shop_of(db, machine)
    shop_ids = business_shop_ids(db, shop)
    effective = effective_prefix(machine)
    row = next((r for r in conflicts_in_shops(db, shop_ids) if r["machineId"] == str(machine.id)), None)
    return {
        "machineId": str(machine.id),
        "prefix": effective,
        "ownPrefix": normalize_prefix(getattr(machine, "document_prefix", None)) is not None,
        "defaultPrefix": default_prefix(machine),
        "businessShopCount": len(shop_ids),
        "uniqueInBusiness": effective is not None and row is None,
        "heldBy": row["heldBy"] if row else [],
        "suggestedPrefix": lowest_free_prefix(db, machine) if row else None,
    }


def assign_free_prefix(db: Session, machine: Any) -> Optional[str]:
    """
    Give a colliding till the lowest free prefix of its business ("שיוך קידומת פנויה"),
    for its future documents; what it issued keeps its frozen prefix. A till whose prefix
    is already unique is left as it is (None). Caller commits; the till learns the new
    prefix on its next `GET /machines/me`.
    """
    if getattr(machine, "shop_id", None) is None:
        raise DocumentPrefixRefused(
            409, "לקופה שאינה משויכת לסניף אין קידומת מסמכים.", "machine_not_assigned"
        )
    status = prefix_status(db, machine)
    if status["uniqueInBusiness"]:
        return None
    free = lowest_free_prefix(db, machine)
    if free is None:
        raise DocumentPrefixRefused(
            409, "אין קידומת מסמכים פנויה בעסק (1–999).", "no_free_document_prefix"
        )
    machine.document_prefix = free
    return free
