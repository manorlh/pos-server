"""
Checking a claimed approver against the document that names them.

**Since 2026-10-07 the document path does not check at all** — the owner's rule: "כרגע
אין הרשאות, כולם יכולים לעשות הכל. כל מסמך שבוצע במכשירים חייב לעלות לענן". Ingest uses
`resolve_document_approver_claim`: the claim is stored exactly as sent, linked to the
person when they are of the till's business, and an unknown one gets a quiet note — never
a refusal. The strict checks below (and their rationale) are kept for whoever needs the
strict answer; `upsert_transactions` no longer calls them.

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
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import FrozenSet, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services.company_hierarchy import user_may_use_machine
from app.services.permissions import Scope, pos_user_till_scopes, till_grantable_scopes
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


def _user_in_tenant(db: Session, user: User, machine: POSMachine) -> bool:
    """
    Is `user` one of the till's tenant's people — the rule the /sync paths apply to a
    user token (`app.middleware.auth._check_sync_user_tenancy`)? A super admin is
    platform-wide; a distributor counts for their own terminals only; anyone else must be
    a member of the till's tenant (`tenant_memberships`, or `users.tenant_id` for rows from
    before memberships). Anyone else is, to this till, an unknown user: another tenant's
    manager cannot approve this tenant's documents.
    """
    if user.role == UserRole.SUPER_ADMIN:
        return True
    if user.role == UserRole.DISTRIBUTOR:
        return str(getattr(machine, "distributor_id", None)) == str(user.id)
    tenant_id = getattr(machine, "tenant_id", None)
    if tenant_id is None:
        return False
    if getattr(user, "tenant_id", None) is not None and str(user.tenant_id) == str(tenant_id):
        return True
    from app.models.tenant_membership import TenantMembership
    return (
        db.query(TenantMembership.id)
        .filter(TenantMembership.user_id == user.id, TenantMembership.tenant_id == tenant_id)
        .first()
        is not None
    )


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
    if user is None or not user.is_active or not _user_in_tenant(db, user, machine):
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


def verify_document_pos_approver(
    db: Session, machine: POSMachine, tx
) -> Optional[uuid.UUID]:
    """
    `verify_document_approver` for a **till user** approver (`approvedByPosUserId`).

    The same four questions, answered from the till user's side:

    1. exists and active, and of this till's tenant (by the tenant of their shop — a
       till user row may predate `pos_users.tenant_id`) → else `approver_unknown_or_inactive`;
    2. what the document needed (`scopes_required_by_document`);
    3. whether their role grants it (`pos_user_till_scopes`, the ceiling the live
       elevation path uses for a till user) → else `approver_lacks_scope:…`;
    4. whether they belong to this till: a till user answers for their one shop only
       (`elevation.pos_user_may_use_machine`) → else `approver_not_permitted_at_machine`.
    """
    claimed = getattr(tx, "approved_by_pos_user_id", None)
    if claimed is None:
        return None
    from app.services.elevation import pos_user_may_use_machine

    pos_user = db.query(PosUser).filter(PosUser.id == claimed).first()
    tenant_id = getattr(machine, "tenant_id", None)
    if pos_user is None or not pos_user.is_active or tenant_id is None:
        raise ApprovalRejected("approver_unknown_or_inactive")
    shop_tenant = db.query(Shop.tenant_id).filter(Shop.id == pos_user.shop_id).first()
    owner = pos_user.tenant_id or (shop_tenant[0] if shop_tenant else None)
    if owner is None or str(owner) != str(tenant_id):
        raise ApprovalRejected("approver_unknown_or_inactive")

    missing = scopes_required_by_document(tx) - pos_user_till_scopes(pos_user.role)
    if missing:
        raise ApprovalRejected(
            "approver_lacks_scope:" + ",".join(sorted(scope.value for scope in missing))
        )

    if not pos_user_may_use_machine(pos_user, machine):
        raise ApprovalRejected("approver_not_permitted_at_machine")

    return pos_user.id


#: The quiet note a document gets when its approver is not a person of the till's business.
APPROVER_NOT_KNOWN = "approver_not_known"
APPROVER_NOT_KNOWN_TEXT = "המאשר שנשלח מהקופה אינו משתמש מוכר בעסק — נשמר כפי שנשלח, לידיעה בלבד"
APPROVER_BOTH = "approver_both"
APPROVER_BOTH_TEXT = "הקופה שלחה גם משתמש ענן וגם משתמש קופה כמאשרים — שניהם נשמרו כפי שנשלחו"


@dataclass(frozen=True)
class ApproverClaim:
    """
    What to store for a document's approver — never a reason to refuse it.

    `user_id` / `pos_user_id` link the person when they are one of this till's business
    (the foreign keys the dashboard names them through); `claimed_*` are the ids exactly as
    the till sent them, always; `notes` are the quiet ingest notes (`{"code", "text"}`).
    """

    user_id: Optional[uuid.UUID] = None
    pos_user_id: Optional[uuid.UUID] = None
    claimed_user_id: Optional[uuid.UUID] = None
    claimed_pos_user_id: Optional[uuid.UUID] = None
    notes: Tuple[dict, ...] = ()


def _pos_user_of_tenant(db: Session, pos_user: PosUser, tenant_id) -> bool:
    if tenant_id is None:
        return False
    owner = pos_user.tenant_id
    if owner is None:
        row = db.query(Shop.tenant_id).filter(Shop.id == pos_user.shop_id).first()
        owner = row[0] if row else None
    return owner is not None and str(owner) == str(tenant_id)


def resolve_document_approver_claim(db: Session, machine: POSMachine, tx) -> ApproverClaim:
    """
    The approver to store for `tx` under the owner's rule (2026-10-07): "כרגע אין הרשאות,
    כולם יכולים לעשות הכל. כל מסמך שבוצע במכשירים חייב לעלות לענן".

    No approval check may block or delay a document. The claim is kept exactly as sent
    (`claimed_*`), and linked to the person (`user_id` / `pos_user_id`) when the id names
    someone of the till's business — active or not, whatever their role or shop: the
    document records who approved it then, and permissions are not in force. An id that
    names nobody of this business (unknown, or another tenant's — one answer for both, so
    the note does not confirm which accounts exist) is kept unlinked with one quiet note.

    The F20 case this was written for: a document issued while the till was paired to one
    business and approved by that business's till manager, reaching the cloud only after
    the till was re-paired to another business — refused hourly as
    `approver_unknown_or_inactive` although the approval was genuine when it was given.

    `verify_document_approvers` stays for code that wants the strict answer; nothing on
    the document path calls it any more.
    """
    claimed_user = getattr(tx, "approved_by_user_id", None)
    claimed_pos = getattr(tx, "approved_by_pos_user_id", None)
    if claimed_user is None and claimed_pos is None:
        return ApproverClaim()

    notes = []
    user_id = None
    if claimed_user is not None:
        user = db.query(User).filter(User.id == claimed_user).first()
        if user is not None and _user_in_tenant(db, user, machine):
            user_id = user.id
    pos_user_id = None
    if claimed_pos is not None:
        pos_user = db.query(PosUser).filter(PosUser.id == claimed_pos).first()
        if pos_user is not None and _pos_user_of_tenant(db, pos_user, getattr(machine, "tenant_id", None)):
            pos_user_id = pos_user.id
    if (claimed_user is not None and user_id is None) or (claimed_pos is not None and pos_user_id is None):
        notes.append({"code": APPROVER_NOT_KNOWN, "text": APPROVER_NOT_KNOWN_TEXT})
    if claimed_user is not None and claimed_pos is not None:
        notes.append({"code": APPROVER_BOTH, "text": APPROVER_BOTH_TEXT})
    return ApproverClaim(
        user_id=user_id,
        pos_user_id=pos_user_id,
        claimed_user_id=claimed_user,
        claimed_pos_user_id=claimed_pos,
        notes=tuple(notes),
    )


def verify_document_approvers(
    db: Session, machine: POSMachine, tx
) -> Tuple[Optional[uuid.UUID], Optional[uuid.UUID]]:
    """
    (cloud approver, till-user approver) to store for `tx`; at most one is set.

    A document naming both is refused (`approver_ambiguous`): "who approved this" must
    have one answer, the rule `elevated_sessions` enforces for the grant itself.
    """
    if (
        getattr(tx, "approved_by_user_id", None) is not None
        and getattr(tx, "approved_by_pos_user_id", None) is not None
    ):
        raise ApprovalRejected("approver_ambiguous")
    return verify_document_approver(db, machine, tx), verify_document_pos_approver(db, machine, tx)
