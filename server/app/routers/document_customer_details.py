"""
"הדפס העתק עם פרטי לקוח" (docs/SPEC_CUSTOMER_INVOICE.md §3.5).

Till (machine token), idempotent by the annotation's client id:

    POST /sync/{machine_id}/document-customer-details    the customer's details a till added to a
                                                         COPY of an issued document

The document itself is never changed by it. The dashboard reads these rows through the document's
detail (`GET /transactions/{id}`), labelled as added after issue.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import FISCAL_MACHINE_TOKEN, get_pos_machine_from_sync_machine_token
from app.models.pos_machine import POSMachine
from app.models.transaction_customer_details import TransactionCustomerDetails
from app.schemas.document_customer_details import DocumentCustomerDetailsIn, DocumentCustomerDetailsIngestOut
from app.services import document_customer_details as svc

till_router = APIRouter(prefix="/sync", tags=["document-customer-details"])


@till_router.post(
    "/{machine_id}/document-customer-details",
    response_model=DocumentCustomerDetailsIngestOut,
    dependencies=FISCAL_MACHINE_TOKEN,
)
def post_document_customer_details(
    machine_id: str,
    body: DocumentCustomerDetailsIn,
    response: Response,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """201 the first time, 200 for a resend; 409 when the id is another till's or the document another business's."""
    existing = db.get(TransactionCustomerDetails, body.id)
    if existing is not None and existing.machine_id != machine.id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="annotation_id_conflict")
    try:
        row, created = svc.record(db, machine, body)
    except svc.DocumentNotYours:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="document_not_yours")
    db.commit()
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return DocumentCustomerDetailsIngestOut(id=row.id, status="accepted" if created else "duplicate")
