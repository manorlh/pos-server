"""
Reprints from the cloud: a copy of a document's tax document, and its card vouchers.

Both are built only from what the till synced. A field the till does not send is left
off the paper rather than guessed — a copy of a fiscal document that states something
the original did not is worse than one that says less.

Two things are read at print time rather than taken from the sale, because the cloud
holds no per-document snapshot of them: the business header (`snapshot_header`, the
same block a Z freezes) and the card terminal's number and merchant name (the machine's
last heartbeat). Everything else — lines, money, VAT, tenders, the acquirer's reply —
is the document's own.

Every page is marked "העתק": these are reprints, never originals.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_payment import TransactionPayment
from app.schemas.print_document import PrintDocumentOut, PrintRow, PrintSection
from app.services.reports import resolve_report_timezone
from app.services.dealer_types import reg_label
from app.services.document_prefix import document_number_from, document_number_of
from app.services.tenders import (
    CREDIT_NOTE_DOCUMENT_TYPE,
    RECEIPT_DOCUMENT_TYPES,
    is_refund_document,
    normalize_tender,
)
from app.services.transmissions import (
    _result_of,
    _text,
    approval_number_of,
    card_last4_of,
    terminal_uid_of,
)
from app.services.z_header import snapshot_header

COPY_MARK = "העתק"
SIGNATURE_LINE = "חתימת הלקוח: ____________________"

#: The document types the till issues, in the words its own receipt prints.
DOCUMENT_TITLES = {
    305: "חשבונית מס",
    320: "חשבונית מס/קבלה",
    330: "חשבונית זיכוי",
    400: "קבלה",
    # An exempt dealer's money back (internal -400, docs/SPEC_BUSINESS_TYPE.md).
    -400: "קבלה – החזר כספי",
}

TENDER_LABELS = {
    "cash": "מזומן",
    "card": "כרטיס אשראי",
    "exchange": "קיזוז החלפה",
    "voucher": "שובר הפקה",
    "vouchers": "שובר הפקה",
    "production_voucher": "שובר הפקה",
    "mixed": "משולב",
    "other": "אחר",
}

#: Agamento's `result.mutag` (card brand). Only the codes Shva and Pelecard agree on;
#: 0 and 3 mean different things on the two, so they are left unnamed.
CARD_BRANDS = {
    1: "מאסטרקארד",
    2: "ויזה",
    4: "אמריקן אקספרס",
    5: "ישראכרט",
    6: "JCB",
    7: "דיסקבר",
}

#: Agamento's `tranType` for a refund (`TRAN_TYPE_REFUND` on the till).
REFUND_TRAN_TYPE = 53

#: A tap that never completed (declined, abandoned) is stored as a document too; it
#: has no voucher to reprint.
_NO_VOUCHER_STATUSES = (TransactionStatus.PENDING, TransactionStatus.CANCELLED)

_STATUS_LABELS = {
    TransactionStatus.PENDING: "ממתין",
    TransactionStatus.CANCELLED: "מבוטל",
    TransactionStatus.REFUNDED: "זוכה",
    TransactionStatus.PARTIAL_REFUND: "זוכה חלקית",
}


class NoCardPayment(Exception):
    """The document has no card payment with a voucher to print."""


# ── Formatting ──────────────────────────────────────────────────────────────────────


def _dec(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    return value if isinstance(value, Decimal) else Decimal(str(value))


def money(value: Any) -> str:
    amount = _dec(value).quantize(Decimal("0.01"))
    sign = "-" if amount < 0 else ""
    return f"{sign}₪{abs(amount):,.2f}"


def _qty(value: Any) -> str:
    return f"{_dec(value).normalize():f}"


def _zone(db: Session, tenant_id: Optional[uuid.UUID]):
    try:
        return ZoneInfo(resolve_report_timezone(db, tenant_id, None))
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return ZoneInfo("Asia/Jerusalem")


def _stamp(moment: Optional[datetime], zone) -> str:
    if moment is None:
        return ""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(zone).strftime("%d/%m/%Y %H:%M")


def _row(label: str, value: Any = "", emphasis: bool = False) -> PrintRow:
    return PrintRow(label=label, value="" if value is None else str(value), emphasis=emphasis)


def document_title(document_type: Optional[int]) -> str:
    if document_type in DOCUMENT_TITLES:
        return DOCUMENT_TITLES[document_type]
    return f"מסמך {document_type}" if document_type is not None else "מסמך"


def _production_deductions(db: Session, tx) -> list:
    """A sale's production-voucher deductions ("קיזוז שוברי הפקה"), as the till printed them."""
    from app.models.prepaid_voucher import PRODUCTION_VOUCHER_DEDUCTION, TransactionVoucherDiscount

    return (
        db.query(TransactionVoucherDiscount)
        .filter(
            TransactionVoucherDiscount.transaction_id == tx.id,
            TransactionVoucherDiscount.kind == PRODUCTION_VOUCHER_DEDUCTION,
        )
        .order_by(TransactionVoucherDiscount.serial)
        .all()
    )


def tender_label(method: Optional[str]) -> str:
    key = (method or "").strip().lower()
    return TENDER_LABELS.get(key) or (method or TENDER_LABELS["other"])


# ── Shared pieces ───────────────────────────────────────────────────────────────────


def _header(db: Session, tx: Transaction) -> tuple[str, List[str]]:
    """The business name and the lines under it: VAT number, address, branch."""
    header = snapshot_header(db, tx.shop) or {}
    name = header.get("businessName") or header.get("shopName") or ""
    lines: List[str] = []
    if header.get("vatNumber"):
        # The document's own kind first: a receipt (400 / -400) was issued by an exempt
        # dealer whatever the company is today (docs/SPEC_BUSINESS_TYPE.md).
        if tx.document_type in RECEIPT_DOCUMENT_TYPES:
            label = "עוסק פטור"
        elif header.get("dealerType") == "licensed":
            label = reg_label("licensed")
        else:
            label = "עוסק מורשה / ח.פ."
        lines.append(f"{label} {header['vatNumber']}")
    if header.get("companyRegNumber"):
        lines.append(f"מס׳ חברה {header['companyRegNumber']}")
    street = " ".join(p for p in (header.get("address"), header.get("addressNumber")) if p)
    place = ", ".join(p for p in (street, header.get("city"), header.get("zip")) if p)
    if place:
        lines.append(place)
    # Where it was issued — the shop, the till's number and name — as the till printed it:
    # "סניף הרצליה · קופה 3 · קיוסק רויאל" (the owner, 07.10.2026), then the branch code.
    machine: Optional[POSMachine] = tx.machine
    issued = place_line(
        header.get("shopName"),
        tx.pos_number or (machine.pos_number if machine is not None else None),
        machine.name if machine is not None else None,
    )
    if issued or header.get("branchId"):
        parts = [issued] if issued else []
        if header.get("branchId"):
            parts.append(f"מס׳ סניף {header['branchId']}")
        lines.append(" · ".join(parts))
    return name, lines


PLACE_SHOP_WORD = "סניף"
PLACE_TILL_WORD = "קופה"


def place_line(shop_name: Optional[str], pos_number: Optional[str], device_name: Optional[str]) -> Optional[str]:
    """
    The place line every printed document carries under the business: "סניף הרצליה · קופה 3 ·
    קיוסק רויאל". A shop already named "סניף …" is not prefixed again; a till named as the shop or
    as its own number says it once; nothing known — None. The same rule as pos-android
    domain/Receipt.kt ReceiptPlace and kiosk-desktop core/printDocs.ts placeLine, pinned by
    tests/fixtures/receipt_place_cases.json (the same bytes in both repos).
    """
    shop_raw = (shop_name or "").strip() or None
    shop = None if shop_raw is None else (shop_raw if shop_raw.startswith(PLACE_SHOP_WORD) else f"{PLACE_SHOP_WORD} {shop_raw}")
    number = (str(pos_number) if pos_number is not None else "").strip()
    till = f"{PLACE_TILL_WORD} {number}" if number else None
    device = (device_name or "").strip() or None
    if device in (shop_raw, shop, till):
        device = None
    line = " · ".join(p for p in (shop, till, device) if p)
    return line or None


def _cashier_name(db: Session, tx: Transaction) -> Optional[str]:
    raw = (tx.cashier_id or "").strip()
    if not raw:
        return None
    try:
        pos_user_id = uuid.UUID(raw)
    except (ValueError, AttributeError, TypeError):
        return raw
    pu = (
        db.query(PosUser)
        .filter(PosUser.id == pos_user_id, PosUser.tenant_id == tx.tenant_id)
        .first()
    )
    if pu is None:
        return raw
    name = " ".join(p for p in (pu.first_name or "", pu.last_name or "") if p).strip()
    return name or pu.username


def _register(tx: Transaction) -> Optional[str]:
    machine: Optional[POSMachine] = tx.machine
    number = tx.pos_number or (machine.pos_number if machine is not None else None)
    if number and machine is not None and machine.name:
        return f"{number} ({machine.name})"
    return number or (machine.name if machine is not None else None)


def _printed_footer(zone) -> str:
    return f"הודפס מהענן: {_stamp(datetime.now(timezone.utc), zone)}"


def _meta(leg: TransactionPayment) -> dict:
    return leg.nayax_meta if isinstance(leg.nayax_meta, dict) else {}


def _installments(meta: dict) -> Optional[int]:
    for raw in (meta.get("creditPayments"), _result_of(meta).get("creditPayments")):
        if isinstance(raw, bool):
            continue
        try:
            n = int(raw)
        except (TypeError, ValueError):
            continue
        if n > 0:
            return n
    return None


def _first_payment(meta: dict) -> Optional[Decimal]:
    """`firstPaymentAmount` is in agorot, as the terminal answers it."""
    for raw in (meta.get("firstPaymentAmount"), _result_of(meta).get("firstPaymentAmount")):
        if raw is None or isinstance(raw, bool):
            continue
        try:
            return (Decimal(str(raw)) / 100).quantize(Decimal("0.01"))
        except (ArithmeticError, ValueError):
            continue
    return None


def _card_brand(meta: dict) -> Optional[str]:
    for key in ("cardBrand", "brand", "cardName"):
        text = _text(meta.get(key)) or _text(_result_of(meta).get(key))
        if text:
            return text
    raw = _result_of(meta).get("mutag")
    if isinstance(raw, bool):
        return None
    try:
        return CARD_BRANDS.get(int(raw))
    except (TypeError, ValueError):
        return None


def _card_text(meta: dict) -> Optional[str]:
    last4 = card_last4_of(meta)
    brand = _card_brand(meta)
    masked = f"****{last4}" if last4 else None
    parts = [p for p in (brand, masked) if p]
    return " ".join(parts) if parts else None


def _entry_mode(meta: dict) -> Optional[str]:
    explicit = _text(meta.get("entryMode")) or _text(_result_of(meta).get("entryMode"))
    if explicit:
        return explicit
    keyed = meta.get("keyed")
    if keyed is True:
        return "הקלדה ידנית (כרטיס לא נוכח)"
    if keyed is False:
        return "כרטיס נוכח"
    return None


def _is_refund_leg(tx: Transaction, meta: dict) -> bool:
    if is_refund_document(
        document_type=tx.document_type, refund_of_transaction_id=tx.refund_of_transaction_id
    ):
        return True
    raw = _result_of(meta).get("tranType")
    try:
        return int(raw) == REFUND_TRAN_TYPE
    except (TypeError, ValueError):
        return False


# ── The tax document ────────────────────────────────────────────────────────────────


def build_invoice_copy(db: Session, tx: Transaction) -> PrintDocumentOut:
    zone = _zone(db, tx.tenant_id)
    business, subtitle = _header(db, tx)
    credit = is_refund_document(
        document_type=tx.document_type, refund_of_transaction_id=tx.refund_of_transaction_id
    )
    title_type = tx.document_type if tx.document_type is not None else (
        CREDIT_NOTE_DOCUMENT_TYPE if credit else None
    )

    details: List[PrintRow] = [
        # As the till printed it: `20000057` (docs/SPEC_DOCUMENT_PREFIX.md).
        _row("מס׳ מסמך", document_number_of(tx), emphasis=True),
        _row("תאריך הנפקה", _stamp(tx.document_production_date or tx.created_at, zone)),
    ]
    register = _register(tx)
    if register:
        details.append(_row("קופה", register))
    cashier = _cashier_name(db, tx)
    if cashier:
        details.append(_row("קופאי/ת", cashier))
    if tx.refund_of_transaction_id is not None:
        original = (
            db.query(Transaction.transaction_number, Transaction.document_prefix, Transaction.pos_number)
            .filter(
                Transaction.id == tx.refund_of_transaction_id,
                Transaction.tenant_id == tx.tenant_id,
            )
            .first()
        )
        if original is not None:
            details.append(_row("זיכוי עבור מסמך", document_number_from(*original)))
    if tx.status in _STATUS_LABELS:
        details.append(_row("סטטוס", _STATUS_LABELS[tx.status], emphasis=True))
    customer_name = tx.customer_name or (tx.customer.name if tx.customer is not None else None)
    if customer_name:
        details.append(_row("שם הלקוח", customer_name))
    if tx.customer is not None and tx.customer.vat_number:
        details.append(_row("ח.פ. / ע.מ. לקוח", tx.customer.vat_number))
    if tx.customer_phone:
        details.append(_row("טלפון", tx.customer_phone))
    if tx.customer_address:
        details.append(_row("כתובת", tx.customer_address))

    lines: List[PrintRow] = []
    for item in tx.items:
        name = item.product_name or item.sku or "פריט"
        lines.append(_row(f"{name} ×{_qty(item.quantity)}", money(item.total_price)))
        # A sale line's total is gross with `discount` taken off it; a credit-note line
        # is already net (see app/services/reports.py), so its discount is not repeated.
        if not credit and _dec(item.discount) > 0:
            # A line given free ("על חשבון הבית") says so, with its reason.
            oth = getattr(item, "oth_reason", None)
            lines.append(_row(f"  OTH — {oth}" if oth else "  הנחה", money(-_dec(item.discount))))
    # Each promotion ("מבצעים") as the till printed it, under the items; part of the
    # document's discount below.
    if not credit:
        from app.models.promotion import TransactionPromotion

        for promo in (
            db.query(TransactionPromotion).filter(TransactionPromotion.transaction_id == tx.id).all()
        ):
            if _dec(promo.discount_amount) > 0:
                lines.append(
                    _row(f"הנחת מבצע: {promo.promotion_name or ''}".strip(), money(-_dec(promo.discount_amount)))
                )
        # Each discount voucher, as the till printed it: "שובר #12 — פסטיבל הקיץ". A production
        # voucher's deduction is no discount: it is printed with the totals ("קיזוז שוברי הפקה").
        from app.models.prepaid_voucher import PRODUCTION_VOUCHER_DEDUCTION, TransactionVoucherDiscount

        for v in (
            db.query(TransactionVoucherDiscount)
            .filter(TransactionVoucherDiscount.transaction_id == tx.id)
            .all()
        ):
            if v.kind == PRODUCTION_VOUCHER_DEDUCTION:
                continue
            if _dec(v.discount_amount) > 0:
                label = f"שובר #{v.serial}" if v.serial else "שובר"
                if v.batch_name:
                    label += f" — {v.batch_name}"
                lines.append(_row(label, money(-_dec(v.discount_amount))))
        # The club button's basket discount ("הנחת מועדון 10%"), as the till printed it.
        if getattr(tx, "basket_discount_kind", None) == "club" and _dec(tx.basket_discount) > 0:
            rate = f" {_dec(tx.basket_discount_percent).normalize():f}%" if tx.basket_discount_percent is not None else ""
            lines.append(_row(f"הנחת מועדון{rate}", money(-_dec(tx.basket_discount))))

    totals: List[PrintRow] = []
    discount = _dec(tx.document_discount)
    if credit:
        due = _dec(tx.total_amount)
    else:
        due = _dec(tx.total_amount) - discount
        deductions = [] if credit else _production_deductions(db, tx)
        deducted = sum((_dec(d.discount_amount) for d in deductions), Decimal(0))
        if discount > 0:
            totals.append(_row('סה"כ פריטים', money(tx.total_amount)))
            if discount - deducted > 0:
                totals.append(_row("הנחה", money(-(discount - deducted))))
        # The production vouchers contract §4.1: "קיזוז שוברי הפקה −₪40", then each voucher —
        # its number, its type, the units it covered.
        if deducted > 0:
            totals.append(_row("קיזוז שוברי הפקה", money(-deducted)))
            for d in deductions:
                head = f"  שובר מס׳ {int(d.serial):04d}" if d.serial else "  שובר הפקה"
                if d.type_name or d.batch_name:
                    head += f" · {d.type_name or d.batch_name}"
                totals.append(_row(head, ""))
                for u in d.units or []:
                    if isinstance(u, dict) and u.get("productName"):
                        totals.append(_row(f"    {_qty(u.get('quantity') or 1)}× {u['productName']}", ""))
    # An exempt dealer's receipt (400 / -400) states no VAT (docs/SPEC_BUSINESS_TYPE.md).
    receipt = tx.document_type in RECEIPT_DOCUMENT_TYPES
    if tx.net_amount is not None and not receipt:
        totals.append(_row('סה"כ לפני מע"מ', money(tx.net_amount)))
    if tx.vat_amount is not None and not receipt:
        rate = ""
        if tx.vat_rate is not None:
            pct = (_dec(tx.vat_rate) * 100).normalize()
            rate = f" {pct:f}%"
        totals.append(_row(f'מע"מ{rate}', money(tx.vat_amount)))
    totals.append(_row("סכום זיכוי" if credit else 'סה"כ לתשלום', money(due), emphasis=True))

    payments: List[PrintRow] = []
    for leg in tx.payments:
        label = tender_label(leg.method)
        meta = _meta(leg)
        if normalize_tender(leg.method) == "card":
            last4 = card_last4_of(meta)
            if last4:
                label = f"{label} ****{last4}"
            n = _installments(meta)
            if n and n > 1:
                label = f"{label} · {n} תשלומים"
        payments.append(_row(label, money(leg.amount)))
    if not tx.payments and tx.payment_method:
        payments.append(_row(tender_label(tx.payment_method), money(due)))
    tip = _dec(tx.tip_amount)
    if tip > 0:
        tip_label = "תשר"
        if tx.tip_payment_method:
            tip_label = f"תשר ({tender_label(tx.tip_payment_method)})"
        payments.append(_row(tip_label, money(tip)))
    if tx.amount_tendered is not None and _dec(tx.change_amount) > 0:
        payments.append(_row("התקבל", money(tx.amount_tendered)))
    if _dec(tx.change_amount) > 0:
        payments.append(_row("עודף", money(tx.change_amount)))

    sections = [PrintSection(title="", rows=details)]
    if lines:
        sections.append(PrintSection(title="פריטים", rows=lines))
    sections.append(PrintSection(title='סיכום', rows=totals))
    if payments:
        sections.append(PrintSection(title="אמצעי תשלום", rows=payments))

    return PrintDocumentOut(
        title=f"{document_title(title_type)} {document_number_of(tx)}",
        copy_mark=COPY_MARK,
        business_name=business,
        subtitle=subtitle,
        sections=sections,
        footer=["העתק נאמן למקור — אינו מהווה מסמך מקור", _printed_footer(zone)],
    )


# ── The card voucher ────────────────────────────────────────────────────────────────


def card_legs(tx: Transaction) -> List[TransactionPayment]:
    if tx.status in _NO_VOUCHER_STATUSES:
        return []
    return [leg for leg in tx.payments if normalize_tender(leg.method) == "card"]


def build_card_slips(
    db: Session, tx: Transaction, payment_id: Optional[uuid.UUID] = None
) -> List[PrintDocumentOut]:
    """One voucher per card payment, or the one `payment_id` names. Raises NoCardPayment."""
    legs = card_legs(tx)
    if payment_id is not None:
        legs = [leg for leg in legs if leg.id == payment_id]
    if not legs:
        raise NoCardPayment()
    zone = _zone(db, tx.tenant_id)
    business, subtitle = _header(db, tx)
    machine: Optional[POSMachine] = tx.machine
    all_card = card_legs(tx)
    return [
        _card_slip(tx, leg, zone, business, subtitle, machine, all_card.index(leg) + 1, len(all_card))
        for leg in legs
    ]


def _card_slip(
    tx: Transaction,
    leg: TransactionPayment,
    zone,
    business: str,
    subtitle: List[str],
    machine: Optional[POSMachine],
    position: int,
    of: int,
) -> PrintDocumentOut:
    meta = _meta(leg)
    refund = _is_refund_leg(tx, meta)
    merchant = (machine.terminal_merchant_name if machine is not None else None) or business
    lines = list(subtitle)
    if machine is not None and machine.terminal_supplier_number:
        lines.append(f"מס׳ ספק: {machine.terminal_supplier_number}")

    rows: List[PrintRow] = []
    if machine is not None and machine.terminal_number:
        rows.append(_row("מס׳ מסוף", machine.terminal_number))
    register = _register(tx)
    if register:
        rows.append(_row("קופה", register))
    rows.append(_row("תאריך ושעה", _stamp(tx.document_production_date or tx.created_at, zone)))
    card = _card_text(meta)
    if card:
        rows.append(_row("כרטיס", card))
    rows.append(_row("סוג עסקה", "זיכוי" if refund else "חיוב (מכירה)", emphasis=True))
    entry = _entry_mode(meta)
    if entry:
        rows.append(_row("אופן ביצוע", entry))
    rows.append(_row("סכום", money(leg.amount), emphasis=True))
    n = _installments(meta)
    if n:
        rows.append(_row("מס׳ תשלומים", n))
        first = _first_payment(meta)
        if n > 1 and first is not None:
            rows.append(_row("תשלום ראשון", money(first)))
    approval = approval_number_of(meta)
    if approval:
        rows.append(_row("מס׳ אישור", approval))
    uid = leg.terminal_uid or terminal_uid_of(meta)
    if uid:
        rows.append(_row("מס׳ שובר (UID)", uid))
    acquirer_tx = _text(_result_of(meta).get("transactionId"))
    if acquirer_tx:
        rows.append(_row("מס׳ עסקה", acquirer_tx))
    rows.append(_row("מסמך", f"{document_title(tx.document_type)} {document_number_of(tx)}"))
    if of > 1:
        rows.append(_row("תשלום", f"{position} מתוך {of}"))

    return PrintDocumentOut(
        title="שובר זיכוי אשראי" if refund else "שובר אשראי",
        copy_mark=COPY_MARK,
        business_name=merchant,
        subtitle=lines,
        sections=[PrintSection(title="", rows=rows)],
        footer=[SIGNATURE_LINE, "העתק — אינו מהווה שובר מקור", _printed_footer(zone)],
    )
