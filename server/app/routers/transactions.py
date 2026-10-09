"""Dashboard read endpoints for transactions (Clerk-user JWT)."""
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import List, Literal, Optional, Union
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import String, cast, exists, func, or_, select
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.middleware.auth import get_current_user, get_active_tenant_id
from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.models.transaction_payment import TransactionPayment
from app.models.user import User
from app.services import print_documents
from app.services.document_prefix import document_number_from, prefixed_number_clause
from app.services.offline_authorizations import outcomes_by_transaction
from app.services.scoping import scope_transactions_by_user
from app.schemas.print_document import PrintDocumentListOut, PrintDocumentOut
from app.schemas.transaction import (
    BasketDocumentOut,
    TransactionListItem,
    TransactionListResponse,
    TransactionOut,
)


router = APIRouter(prefix="/transactions", tags=["transactions"])


#: The most documents one export takes; more is refused with a message, never cut short.
EXPORT_MAX_ROWS = 50_000


def _given(value):
    """A filter as given — None for a `Query(...)` default left in place by a direct call."""
    return None if value is None or type(value).__module__.startswith("fastapi") else value


def _filtered_query(
    db: Session,
    current_user: User,
    active_tenant_id,
    *,
    machine_id=None,
    machine_ids=None,
    shop_id=None,
    basket_id=None,
    from_date=None,
    to_date=None,
    q=None,
    card_last4=None,
    item=None,
    method=None,
    document_types=None,
    cashier_ids=None,
    statuses=None,
    amount_min=None,
    amount_max=None,
    document_number=None,
):
    """
    The transaction search, one definition for the list and its export (docs/SPEC_REPORTS.md
    §1): the reader's tenant and scope, then every filter given — tills (`machineIds`, any
    of them), shop, dates (with no date and no basket: the last 30 days), the free search,
    card last four, a product, the tender, document types, employees (`cashierIds`),
    statuses, an amount range and a document number. None when the role sees nothing.
    """
    query = db.query(Transaction).filter(Transaction.tenant_id == active_tenant_id)
    query = scope_transactions_by_user(query, current_user, db)
    if query is None:
        return None

    tills = list(_given(machine_ids) or [])
    if _given(machine_id):
        tills.append(machine_id)
    if tills:
        query = query.filter(Transaction.machine_id.in_(tills))
    if _given(shop_id):
        query = query.filter(Transaction.shop_id == shop_id)
    if _given(basket_id):
        query = query.filter(Transaction.basket_id == basket_id)
    query = _search_filters(query, q=q, card_last4=card_last4, item=item, method=method)

    types = [t for t in (_given(document_types) or []) if isinstance(t, int)]
    if types:
        query = query.filter(Transaction.document_type.in_(types))
    cashiers = [c.strip() for c in (_given(cashier_ids) or []) if isinstance(c, str) and c.strip()]
    if cashiers:
        query = query.filter(Transaction.cashier_id.in_(cashiers))
    wanted_statuses = [s.strip() for s in (_given(statuses) or []) if isinstance(s, str) and s.strip()]
    if wanted_statuses:
        query = query.filter(Transaction.status.in_(wanted_statuses))
    if _given(amount_min) is not None:
        query = query.filter(Transaction.total_amount >= amount_min)
    if _given(amount_max) is not None:
        query = query.filter(Transaction.total_amount <= amount_max)
    number = _given(document_number)
    if isinstance(number, str) and number.strip():
        prefixed = prefixed_number_clause(number.strip())
        query = query.filter(
            prefixed
            if prefixed is not None
            else Transaction.transaction_number.ilike(_like(number.strip()), escape="\\")
        )

    from_date, to_date = _given(from_date), _given(to_date)
    # A basket is shown whole, whenever it was committed: no default window for it.
    if from_date is None and to_date is None and not _given(basket_id):
        from_date = (datetime.now(timezone.utc) - timedelta(days=30)).date()

    if from_date is not None:
        query = query.filter(Transaction.created_at >= datetime.combine(from_date, time.min, tzinfo=timezone.utc))
    if to_date is not None:
        query = query.filter(Transaction.created_at < datetime.combine(to_date + timedelta(days=1), time.min, tzinfo=timezone.utc))
    return query


@router.get("", response_model=TransactionListResponse)
def list_transactions(
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    machine_ids: Optional[List[uuid.UUID]] = Query(None, alias="machineIds", description="Tills — any of them"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    basket_id: Optional[uuid.UUID] = Query(None, alias="basketId"),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200, alias="pageSize"),
    q: Optional[str] = Query(None, max_length=60, description="Document number or amount, as a substring"),
    card_last4: Optional[str] = Query(None, alias="cardLast4", pattern=r"^\d{4}$"),
    item: Optional[str] = Query(None, max_length=80, description="A product name on any line"),
    method: Optional[Literal["cash", "card", "voucher", "split", "refunds"]] = Query(None),
    document_types: Optional[List[int]] = Query(None, alias="documentTypes", description="320, 330, 400, -400 …"),
    cashier_ids: Optional[List[str]] = Query(None, alias="cashierIds", description="Employees (the till user's id)"),
    statuses: Optional[List[str]] = Query(None, description="completed, refunded, partial_refund, cancelled, pending"),
    amount_min: Optional[Decimal] = Query(None, alias="amountMin"),
    amount_max: Optional[Decimal] = Query(None, alias="amountMax"),
    document_number: Optional[str] = Query(None, alias="documentNumber", max_length=40),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    query = _filtered_query(
        db, current_user, active_tenant_id,
        machine_id=machine_id, machine_ids=machine_ids, shop_id=shop_id, basket_id=basket_id,
        from_date=from_date, to_date=to_date, q=q, card_last4=card_last4, item=item, method=method,
        document_types=document_types, cashier_ids=cashier_ids, statuses=statuses,
        amount_min=amount_min, amount_max=amount_max, document_number=document_number,
    )
    if query is None:
        return TransactionListResponse(page=page, page_size=page_size, total=0, items=[])

    total = query.count()
    rows = (
        query.order_by(Transaction.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    items = [TransactionListItem.model_validate(r) for r in rows]
    # One query for the page, not one per row.
    outcomes = outcomes_by_transaction(db, [r.id for r in rows])
    for item in items:
        item.offline_outcome = outcomes.get(item.id)
    brands = _card_brands_by_transaction(db, [r.id for r in rows])
    for item in items:
        item.card_brands = brands.get(item.id, [])
    return TransactionListResponse(
        page=page,
        page_size=page_size,
        total=total,
        items=items,
    )


@router.get("/export")
def export_transactions(
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    machine_ids: Optional[List[uuid.UUID]] = Query(None, alias="machineIds"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    basket_id: Optional[uuid.UUID] = Query(None, alias="basketId"),
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    q: Optional[str] = Query(None, max_length=60),
    card_last4: Optional[str] = Query(None, alias="cardLast4", pattern=r"^\d{4}$"),
    item: Optional[str] = Query(None, max_length=80),
    method: Optional[Literal["cash", "card", "voucher", "split", "refunds"]] = Query(None),
    document_types: Optional[List[int]] = Query(None, alias="documentTypes"),
    cashier_ids: Optional[List[str]] = Query(None, alias="cashierIds"),
    statuses: Optional[List[str]] = Query(None),
    amount_min: Optional[Decimal] = Query(None, alias="amountMin"),
    amount_max: Optional[Decimal] = Query(None, alias="amountMax"),
    document_number: Optional[str] = Query(None, alias="documentNumber", max_length=40),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Every document the same filters match — not a page — as flat rows for the Excel export
    (docs/SPEC_REPORTS.md §2): number, type, status, shop, till, employee, the money
    (total, discount, net, VAT, tip), the tender split, card brands and last four digits,
    the shift and its Z. Over EXPORT_MAX_ROWS is a 400 with a message, never a cut list.
    """
    from app.services.transactions_export import export_rows

    query = _filtered_query(
        db, current_user, active_tenant_id,
        machine_id=machine_id, machine_ids=machine_ids, shop_id=shop_id, basket_id=basket_id,
        from_date=from_date, to_date=to_date, q=q, card_last4=card_last4, item=item, method=method,
        document_types=document_types, cashier_ids=cashier_ids, statuses=statuses,
        amount_min=amount_min, amount_max=amount_max, document_number=document_number,
    )
    if query is None:
        return {"total": 0, "items": []}
    total = query.count()
    if total > EXPORT_MAX_ROWS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"יותר מ-{EXPORT_MAX_ROWS:,} מסמכים ({total:,}) — צמצמו את טווח התאריכים או את הסינון",
        )
    rows = query.order_by(Transaction.created_at.desc(), Transaction.id.asc()).all()
    return {"total": total, "items": export_rows(db, rows)}


def _like(text: str) -> str:
    """`%text%` with the user's own `%`, `_` and `\\` taken literally (escape `\\`)."""
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _search_filters(query, *, q=None, card_last4=None, item=None, method=None):
    """
    The transaction search: the document number or amount (`q`), the last four digits of
    a card (`card_last4` — the till's `cardLast4`, else the terminal's masked number, on
    the document or on any leg), a product name on any line (`item`), and the tender
    (`method`: a tender of the document or of any leg; `split` — more than one leg;
    `refunds` — credit notes). Each is optional; together they narrow.
    """
    # Called directly (not through FastAPI), an unset filter is its `Query(...)` default:
    # anything that is not text is "not given".
    q, card_last4, item, method = (v if isinstance(v, str) else None for v in (q, card_last4, item, method))
    if method == "refunds":
        # Credit notes, and an exempt dealer's receipt refunds (-400).
        query = query.filter(Transaction.document_type.in_((330, -400)))
    elif method == "split":
        legs = (
            select(func.count(TransactionPayment.id))
            .where(TransactionPayment.transaction_id == Transaction.id)
            .scalar_subquery()
        )
        query = query.filter(or_(func.lower(Transaction.payment_method) == "mixed", legs > 1))
    elif method:
        # "שובר" finds every production voucher leg, whichever code the till wrote.
        from app.services.tenders import PRODUCTION_VOUCHER_METHODS

        methods = sorted(PRODUCTION_VOUCHER_METHODS) if method == "voucher" else [method]
        query = query.filter(
            or_(
                func.lower(Transaction.payment_method).in_(methods),
                exists().where(
                    TransactionPayment.transaction_id == Transaction.id,
                    func.lower(TransactionPayment.method).in_(methods),
                ),
            )
        )
    if card_last4:
        def ends_in(meta):
            return or_(
                meta["cardLast4"].as_string() == card_last4,
                meta[("result", "cardNumber")].as_string().like("%" + card_last4),
            )

        query = query.filter(
            or_(
                ends_in(Transaction.nayax_meta),
                exists().where(
                    TransactionPayment.transaction_id == Transaction.id,
                    ends_in(TransactionPayment.nayax_meta),
                ),
            )
        )
    if item and item.strip():
        query = query.filter(
            exists().where(
                TransactionItem.transaction_id == Transaction.id,
                TransactionItem.product_name.ilike(_like(item.strip()), escape="\\"),
            )
        )
    if q and q.strip():
        # `20000057`: document 57 of the till that issued it under prefix 2
        # (docs/SPEC_DOCUMENT_PREFIX.md). Anything else — `57` too, which may be any
        # till's — stays the substring search on the number or the amount.
        prefixed = prefixed_number_clause(q)
        if prefixed is not None:
            return query.filter(prefixed)
        pattern = _like(q.strip())
        query = query.filter(
            or_(
                Transaction.transaction_number.ilike(pattern, escape="\\"),
                cast(Transaction.total_amount, String).like(pattern, escape="\\"),
            )
        )
    return query


def _card_brands_by_transaction(db: Session, ids) -> dict:
    """Per document, the brands of its card legs in leg order (one query for the page)."""
    if not ids:
        return {}
    out: dict = {}
    for tx_id, brand in (
        db.query(TransactionPayment.transaction_id, TransactionPayment.card_brand)
        .filter(
            TransactionPayment.transaction_id.in_(ids),
            func.lower(TransactionPayment.method) == "card",
            TransactionPayment.card_brand.isnot(None),
        )
        .order_by(TransactionPayment.transaction_id, TransactionPayment.sequence)
        .all()
    ):
        seen = out.setdefault(tx_id, [])
        if brand not in seen:
            seen.append(brand)
    return out


def _scoped_transaction(
    db: Session, transaction_id: uuid.UUID, current_user: User, active_tenant_id
) -> Transaction:
    """The document with its lines, tenders and vouchers, inside the reader's scope; 404 otherwise."""
    query = (
        db.query(Transaction)
        .options(
            joinedload(Transaction.items),
            # Eager: TransactionOut serialises the tender legs, and a lazy load here
            # would fire a query per document view.
            joinedload(Transaction.payments),
            joinedload(Transaction.issued_vouchers),
        )
        .filter(Transaction.id == transaction_id, Transaction.tenant_id == active_tenant_id)
    )
    query = scope_transactions_by_user(query, current_user, db)
    if query is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found")
    tx = query.first()
    if not tx:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found")
    return tx


@router.get("/{transaction_id}", response_model=TransactionOut)
def get_transaction(
    transaction_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    tx = _scoped_transaction(db, transaction_id, current_user, active_tenant_id)
    out = TransactionOut.model_validate(tx)
    out.offline_outcome = outcomes_by_transaction(db, [tx.id]).get(tx.id)
    # The links are not foreign keys (a credit note may arrive before its original), so
    # each is resolved here, inside the reader's tenant and scope.
    if tx.refund_of_transaction_id is not None:
        original = scope_transactions_by_user(
            db.query(
                Transaction.transaction_number, Transaction.document_prefix, Transaction.pos_number
            ).filter(
                Transaction.id == tx.refund_of_transaction_id,
                Transaction.tenant_id == active_tenant_id,
            ),
            current_user,
            db,
        )
        row = original.first() if original is not None else None
        # As printed on the original: "זיכוי למסמך 20000057".
        out.refund_of_transaction_number = document_number_from(*row) if row else None
    if tx.basket_id is not None:
        siblings = scope_transactions_by_user(
            db.query(Transaction).filter(
                Transaction.basket_id == tx.basket_id,
                Transaction.tenant_id == active_tenant_id,
                Transaction.id != tx.id,
            ),
            current_user,
            db,
        )
        if siblings is not None:
            out.basket_documents = [
                BasketDocumentOut.model_validate(s)
                for s in siblings.order_by(Transaction.created_at.asc(), Transaction.id.asc()).all()
            ]
    return out


@router.get(
    "/{transaction_id}/print-document",
    response_model=Union[PrintDocumentOut, PrintDocumentListOut],
)
def get_print_document(
    transaction_id: uuid.UUID,
    kind: Literal["invoice", "card_slip"] = Query(...),
    payment_id: Optional[uuid.UUID] = Query(None, alias="paymentId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id = Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    A reprint of the document, as data for the dashboard's 80 mm view, marked "העתק".

    `kind=invoice`: the tax document (whatever type it is). `kind=card_slip`: the credit
    card voucher — the one `paymentId` names, else every card payment's as
    `{"documents": [...]}`. 404 when the document has no (approved) card payment.
    """
    tx = _scoped_transaction(db, transaction_id, current_user, active_tenant_id)
    if kind == "invoice":
        return print_documents.build_invoice_copy(db, tx)
    try:
        slips = print_documents.build_card_slips(db, tx, payment_id)
    except print_documents.NoCardPayment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                "Card payment not found on this transaction"
                if payment_id is not None
                else "Transaction has no card payment to print a voucher for"
            ),
        )
    if payment_id is not None:
        return slips[0]
    return PrintDocumentListOut(documents=slips)
