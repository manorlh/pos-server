"""
Checking a claimed approver against the document that names them.

A till uploads a document and may say "this one was approved by user X". The claim
arrives over a machine token, so it is a claim and nothing more — the same device
that could be running a modified build is the device making it. Recording it as
given would produce an audit trail that reads as evidence and is worth nothing: the
one thing a false name does that a missing name does not is mislead whoever reads it
later. So every claim is re-derived from the server's own data before it is stored,
and a claim that does not stand up takes the document down with it.

Four questions, all answered here, none of them answerable by the device:

1. **Does the user exist and are they still active?** A person deactivated between
   approving and the document reaching the cloud no longer approves anything.
2. **What did this document actually need?** Read off the document, not off the
   claim — a credit note needs `refund`, a discounted document needs `discount`. A
   till cannot lower the bar by understating what it is sending, because the bar is
   computed from the amounts it sent.
3. **Could their role authorise that?** The same `till_grantable_scopes` ceiling the
   live elevation path uses, so an approval recorded after the fact and an approval
   granted at the moment cannot disagree about who is allowed.
4. **Are they anything to do with this till?** `user_may_use_machine`, which exists
   precisely so the desk's answer and the till's answer are one answer.

Note what is *not* asked: whether an elevation grant was ever issued. It usually was,
but a till whose own operator already holds the authority never elevates, and a token
is in any case gone by the time the outbox drains. The claim is verified against the
person's standing permissions, which is the durable fact.
"""

from __future__ import annotations

import uuid
from decimal import Decimal, InvalidOperation
from typing import FrozenSet, Optional

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.user import User
from app.services.company_hierarchy import user_may_use_machine
from app.services.permissions import Scope, till_grantable_scopes
from app.services.tenders import is_refund_document


class ApprovalRejected(ValueError):
    """A claimed approver that does not stand up. The message is the stored reason."""


def _is_nonzero(value) -> bool:
    """True for a money field that is present and not zero. Unparseable reads as zero."""
    if value is None:
        return False
    try:
        return Decimal(str(value)) != 0
    except (InvalidOperation, TypeError, ValueError):
        return False


def _carries_a_discount(tx) -> bool:
    """
    Did anything come off this document's price?

    Every level is checked because a discount can be applied at any of them and the
    till sends whichever it used: a basket discount lands in `document_discount`, a
    till that totals its lines sends `total_discount`, and a single reduced line
    carries its own `discount` or `line_discount` with the document totals looking
    entirely ordinary. Missing one would make the cheapest way to dodge the check
    "discount one line instead of the basket".
    """
    if _is_nonzero(getattr(tx, "document_discount", None)) or _is_nonzero(
        getattr(tx, "total_discount", None)
    ):
        return True
    return any(
        _is_nonzero(getattr(item, "discount", None))
        or _is_nonzero(getattr(item, "line_discount", None))
        for item in (getattr(tx, "items", None) or [])
    )


def scopes_required_by_document(tx) -> FrozenSet[Scope]:
    """
    What a person would have had to be able to authorise, to authorise this document.

    Derived from the document's own contents so that the bar cannot be set by the
    claim. Empty for an ordinary sale, which is most of them.
    """
    required: set[Scope] = set()
    if is_refund_document(
        document_type=getattr(tx, "document_type", None),
        refund_of_transaction_id=getattr(tx, "refund_of_transaction_id", None),
    ):
        required.add(Scope.REFUND)
    if _carries_a_discount(tx):
        required.add(Scope.DISCOUNT)
    return frozenset(required)


def verify_document_approver(
    db: Session, machine: POSMachine, tx
) -> Optional[uuid.UUID]:
    """
    Return the approver id to store for `tx`, or None when none was claimed.

    Raises `ApprovalRejected` when a claim was made and fails any of the four checks.
    The caller rejects the whole document on that: a document that says it was
    approved by someone who could not have approved it is worse than the same
    document saying nothing, because only the first one gets believed.

    A claim on a document that needed no authority at all is kept rather than
    refused — the person is still verified as real, active and attached to this till,
    and "approved by" on an ordinary sale is a redundant note, not a false one.
    """
    claimed = getattr(tx, "approved_by_user_id", None)
    if claimed is None:
        return None

    user = db.query(User).filter(User.id == claimed).first()
    if user is None or not user.is_active:
        # One reason for both: a till cannot usefully act on the difference, and the
        # narrower message would confirm which cloud accounts exist.
        raise ApprovalRejected("approver_unknown_or_inactive")

    missing = scopes_required_by_document(tx) - till_grantable_scopes(user.role)
    if missing:
        raise ApprovalRejected(
            "approver_lacks_scope:" + ",".join(sorted(scope.value for scope in missing))
        )

    if not user_may_use_machine(db, user, machine):
        raise ApprovalRejected("approver_not_permitted_at_machine")

    return user.id
