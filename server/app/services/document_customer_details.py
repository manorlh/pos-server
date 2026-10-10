"""
"הדפס העתק עם פרטי לקוח" (docs/SPEC_CUSTOMER_INVOICE.md §3.5): the cloud's side of the details a till
added to a COPY of an issued document.

The recorded document is never touched here: no column of `transactions`, no line, no leg, no total
and no record of the uniform file reads or changes with this table. It is an append-only audit
(who added which details to which document, and when) that the document's detail and the copy
printed from the dashboard show, labelled as added after issue.
"""
from __future__ import annotations

import logging
import uuid
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.transaction import Transaction
from app.models.transaction_customer_details import TransactionCustomerDetails
from app.schemas.document_customer_details import DocumentCustomerDetailsIn

#: The till parameter that offers the option at the till (off by default). Off, a copy prints none of
#: what was added - at the till or from the dashboard - while the cloud keeps whatever was recorded.
PARAMETER_KEY = "invoiceCopyWithCustomerDetails"

_log = logging.getLogger(__name__)


class DocumentNotYours(Exception):
    """The document exists and is another business's: nothing is recorded against it."""


def record(db: Session, machine: POSMachine, body: DocumentCustomerDetailsIn) -> Tuple[TransactionCustomerDetails, bool]:
    """
    Store one annotation, idempotent by its client id: `(row, created)`. Raises [DocumentNotYours] when
    the document is another tenant's. A document that has not arrived yet is fine — the annotation may
    land first, it names the document by id only.
    """
    existing = db.get(TransactionCustomerDetails, body.id)
    if existing is not None:
        return existing, False
    document_tenant = (
        db.query(Transaction.tenant_id).filter(Transaction.id == body.transaction_id).scalar()
    )
    if document_tenant is not None and machine.tenant_id is not None and document_tenant != machine.tenant_id:
        raise DocumentNotYours()
    row = TransactionCustomerDetails(
        id=body.id,
        tenant_id=machine.tenant_id,
        shop_id=machine.shop_id,
        machine_id=machine.id,
        transaction_id=body.transaction_id,
        customer_name=body.customer_name,
        customer_vat_number=body.customer_vat_number,
        customer_address=body.customer_address,
        customer_phone=body.customer_phone,
        customer_email=body.customer_email,
        added_by_id=body.added_by_id,
        added_by_name=body.added_by_name,
        added_at=body.added_at,
    )
    db.add(row)
    db.flush()
    return row, True


def for_document(db: Session, tenant_id, transaction_id) -> List[TransactionCustomerDetails]:
    """Every time details were added to the document, oldest first (the audit)."""
    query = db.query(TransactionCustomerDetails).filter(TransactionCustomerDetails.transaction_id == transaction_id)
    if tenant_id is not None:
        query = query.filter(TransactionCustomerDetails.tenant_id == tenant_id)
    return query.order_by(TransactionCustomerDetails.added_at.asc(), TransactionCustomerDetails.received_at.asc()).all()


def latest_for_document(db: Session, tenant_id, transaction_id) -> Optional[TransactionCustomerDetails]:
    """The details a copy shows: the last ones added."""
    rows = for_document(db, tenant_id, transaction_id)
    return rows[-1] if rows else None


def parameter_on(db: Session, tx: Transaction) -> bool:
    """
    The parameter as the document's own till resolves it (company -> shop -> area -> till): what a copy
    printed from the dashboard follows, like the till's. Off when the till is gone or on any failure -
    the copy is then the original's words, which is never wrong.
    """
    try:
        machine = db.get(POSMachine, tx.machine_id)
        if machine is None:
            return False
        from app.services import till_parameters

        return till_parameters.till_parameters_for_machine(db, machine).parameters.get(PARAMETER_KEY) is True
    except Exception:  # pragma: no cover - the defensive side
        _log.warning("document_customer_details: could not resolve %s for %s", PARAMETER_KEY, tx.id, exc_info=True)
        return False
