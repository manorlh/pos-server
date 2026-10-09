"""
The sign-up itself (§24), after the OTP: one atomic business operation.

1. The form is validated FIRST (so a bad form does not burn the verified challenge):
   first name required; last name / e-mail / birthday only when the page asks; terms
   accepted on the ACTIVE version the page showed; never a pre-ticked consent.
2. The verified challenge is consumed (once, by its session) — the phone comes from it,
   never from the browser.
3. Customer and membership are get-or-create on their unique keys (club + phone hash,
   club + customer); a parallel duplicate loses at the constraint and reads the winner.
4. Consent events are appended with the version and the exact text shown. A returning
   member's existing consent is never changed without an explicit choice (an unticked
   marketing box changes nothing; a ticked one is a new opt-in).
5. One sign-up benefit at most, by unique key `signup:<club>:<customer>`.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.club import (
    DOC_MARKETING_EMAIL,
    DOC_MARKETING_SMS,
    DOC_PRIVACY,
    DOC_TERMS,
    MEMBERSHIP_ACTIVE,
    MEMBERSHIP_PENDING,
    ClubBenefitGrant,
    ClubConsentEvent,
    ClubCustomer,
    ClubDocumentVersion,
    ClubLandingPage,
    ClubMembership,
    ClubProgram,
    ClubSourceToken,
    ClubSuppression,
)
from app.services.club import otp as OTP
from app.services.club.scope import audit
from app.services.notifications.crypto import decrypt_text, encrypt_text, random_token
from app.services.notifications.phone import mask_phone, phone_hash

_NAME = re.compile(r"^[\w֐-׿؀-ۿ' \-\.״׳]{1,60}$")
_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,24}$")


class RegistrationError(Exception):
    def __init__(self, code: str, status: int = 422, field: Optional[str] = None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.field = field


def active_documents(db: Session, club_id: Any) -> Dict[str, ClubDocumentVersion]:
    rows = (
        db.query(ClubDocumentVersion)
        .filter(ClubDocumentVersion.club_id == club_id, ClubDocumentVersion.status == "active")
        .all()
    )
    return {r.kind: r for r in rows}


def _clean_name(value: Any, field: str, required: bool) -> Optional[str]:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if not text:
        if required:
            raise RegistrationError("field_required", field=field)
        return None
    if not _NAME.match(text):
        raise RegistrationError("field_invalid", field=field)
    return text


def validate_form(landing: ClubLandingPage, docs: Dict[str, ClubDocumentVersion], form: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    out["first_name"] = _clean_name(form.get("firstName"), "firstName", True)
    out["last_name"] = _clean_name(form.get("lastName"), "lastName", False) if landing.last_name_enabled else None
    email = str(form.get("email") or "").strip()
    if email and landing.email_enabled:
        if not _EMAIL.match(email):
            raise RegistrationError("field_invalid", field="email")
        out["email"] = email.lower()
    else:
        out["email"] = None
    day, month = form.get("birthDay"), form.get("birthMonth")
    out["birth_day"] = out["birth_month"] = None
    if landing.birthday_enabled and (day or month):
        try:
            d, m = int(day), int(month)
        except (TypeError, ValueError):
            raise RegistrationError("field_invalid", field="birthday") from None
        if not (1 <= m <= 12 and 1 <= d <= 31) or (m == 2 and d > 29) or (m in (4, 6, 9, 11) and d > 30):
            raise RegistrationError("field_invalid", field="birthday")
        out["birth_day"], out["birth_month"] = d, m

    terms, privacy = docs.get(DOC_TERMS), docs.get(DOC_PRIVACY)
    if terms is None or privacy is None:
        raise RegistrationError("page_unavailable", 404)
    if form.get("acceptTerms") is not True:
        raise RegistrationError("terms_required", field="acceptTerms")
    if str(form.get("termsVersionId") or "") != str(terms.id) or str(form.get("privacyVersionId") or "") != str(privacy.id):
        # The page showed an older version: reload and accept the current one.
        raise RegistrationError("terms_version_stale", 409)
    out["terms"], out["privacy"] = terms, privacy

    sms_doc = docs.get(DOC_MARKETING_SMS)
    out["marketing_sms"] = form.get("marketingSms") is True and sms_doc is not None
    if out["marketing_sms"] and str(form.get("marketingSmsVersionId") or "") != str(sms_doc.id):
        raise RegistrationError("terms_version_stale", 409)
    out["marketing_sms_doc"] = sms_doc
    email_doc = docs.get(DOC_MARKETING_EMAIL) if landing.email_enabled else None
    out["marketing_email"] = form.get("marketingEmail") is True and email_doc is not None and bool(out["email"])
    out["marketing_email_doc"] = email_doc
    return out


def _latest_consent(db: Session, customer_id: Any, kind: str) -> Optional[ClubConsentEvent]:
    return (
        db.query(ClubConsentEvent)
        .filter(ClubConsentEvent.customer_id == customer_id, ClubConsentEvent.kind == kind)
        .order_by(ClubConsentEvent.occurred_at.desc())
        .first()
    )


def _get_or_create(db: Session, model, lookup: Dict[str, Any], create: Dict[str, Any]):
    row = db.query(model).filter_by(**lookup).first()
    if row is not None:
        return row, False
    obj = model(**lookup, **create)
    try:
        with db.begin_nested():
            db.add(obj)
            db.flush()
    except IntegrityError:
        row = db.query(model).filter_by(**lookup).first()
        if row is None:
            raise
        return row, False
    return obj, True


def _next_member_number(db: Session, club: ClubProgram) -> int:
    locked = db.query(ClubProgram).filter(ClubProgram.id == club.id).with_for_update().one()
    number = locked.next_member_number or 1001
    locked.next_member_number = number + 1
    db.flush()
    return number


def register(
    db: Session,
    *,
    club: ClubProgram,
    landing: ClubLandingPage,
    source: Optional[ClubSourceToken],
    challenge_id: Any,
    client_session: Optional[str],
    registration_token: Any,
    form: Dict[str, Any],
    ip: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    docs = active_documents(db, club.id)
    clean = validate_form(landing, docs, form)
    challenge = OTP.consume_registration(
        db, club=club, challenge_id=challenge_id, client_session=client_session, token=registration_token, now=now
    )
    phone = decrypt_text(challenge.phone_ciphertext)
    if not phone or phone_hash(phone) != challenge.phone_hash:
        raise RegistrationError("registration_invalid", 400)
    hashed = challenge.phone_hash
    shop_id = source.shop_id if source is not None else None

    customer, new_customer = _get_or_create(
        db,
        ClubCustomer,
        {"tenant_id": club.tenant_id, "company_id": club.company_id, "phone_hash": hashed},
        {
            "id": uuid.uuid4(),
            "first_name": clean["first_name"],
            "last_name": clean["last_name"],
            "phone_ciphertext": encrypt_text(phone),
            "phone_masked": mask_phone(phone),
            "phone_verified_at": now,
            "email": clean["email"],
            "birth_day": clean["birth_day"],
            "birth_month": clean["birth_month"],
            "source_shop_id": shop_id,
            "signup_source": source.source_kind if source is not None else "link",
            "created_at": now,
            "updated_at": now,
        },
    )
    if not new_customer:
        customer.phone_verified_at = now
        # Fill what is missing; never overwrite what the member already has.
        for attr in ("last_name", "email", "birth_day", "birth_month"):
            if getattr(customer, attr) in (None, "") and clean.get(attr) not in (None, ""):
                setattr(customer, attr, clean[attr])

    existing_membership = (
        db.query(ClubMembership)
        .filter(ClubMembership.club_id == club.id, ClubMembership.customer_id == customer.id)
        .first()
    )
    # A number is taken (under the club row's lock) only for a membership that does not
    # exist yet; losing a parallel race just leaves a gap in the numbering.
    number = existing_membership.member_number if existing_membership is not None else _next_member_number(db, club)
    membership, new_membership = _get_or_create(
        db,
        ClubMembership,
        {"club_id": club.id, "customer_id": customer.id},
        {
            "id": uuid.uuid4(),
            "tenant_id": club.tenant_id,
            "company_id": club.company_id,
            "member_number": number,
            "status": MEMBERSHIP_ACTIVE,
            "qr_token": random_token(18),
            "unsubscribe_token": random_token(18),
            "source_token_id": source.id if source is not None else None,
            "source_shop_id": shop_id,
            "joined_at": now,
            "status_changed_at": now,
            "created_at": now,
            "updated_at": now,
        },
    )
    if not new_membership and membership.status == MEMBERSHIP_PENDING:
        membership.status = MEMBERSHIP_ACTIVE
        membership.status_changed_at = now
        membership.joined_at = membership.joined_at or now

    def consent(kind: str, granted: bool, doc: Optional[ClubDocumentVersion]) -> None:
        db.add(
            ClubConsentEvent(
                id=uuid.uuid4(),
                tenant_id=club.tenant_id,
                company_id=club.company_id,
                customer_id=customer.id,
                membership_id=membership.id,
                kind=kind,
                granted=granted,
                document_version_id=doc.id if doc is not None else None,
                document_version=doc.version if doc is not None else None,
                text_snapshot=(doc.body if doc is not None else None),
                source="landing",
                source_token_id=source.id if source is not None else None,
                ip_hash=OTP.ip_hash(ip),
                idempotency_key=f"reg:{challenge.id}:{kind}",
                occurred_at=now,
            )
        )

    last_terms = _latest_consent(db, customer.id, DOC_TERMS)
    if new_membership or last_terms is None or str(last_terms.document_version_id) != str(clean["terms"].id):
        consent(DOC_TERMS, True, clean["terms"])
    last_privacy = _latest_consent(db, customer.id, DOC_PRIVACY)
    if new_membership or last_privacy is None or str(last_privacy.document_version_id) != str(clean["privacy"].id):
        consent(DOC_PRIVACY, True, clean["privacy"])
    for kind, chosen, doc in (
        (DOC_MARKETING_SMS, clean["marketing_sms"], clean["marketing_sms_doc"]),
        (DOC_MARKETING_EMAIL, clean["marketing_email"], clean["marketing_email_doc"]),
    ):
        if doc is None:
            continue
        current = _latest_consent(db, customer.id, kind)
        if chosen and (current is None or not current.granted):
            consent(kind, True, doc)
        elif not chosen and current is None and new_membership:
            # The new member's explicit "no" (the box left unticked) is recorded too.
            consent(kind, False, doc)
    if clean["marketing_sms"]:
        # An explicit opt-in lifts an earlier unsubscribe (never a provider block).
        for sup in (
            db.query(ClubSuppression)
            .filter(
                ClubSuppression.tenant_id == club.tenant_id,
                ClubSuppression.phone_hash == hashed,
                ClubSuppression.reason == "unsubscribe",
                ClubSuppression.lifted_at.is_(None),
            )
            .all()
        ):
            sup.lifted_at = now

    benefit = None
    if landing.signup_benefit_enabled and landing.signup_benefit_title:
        valid_until = now + timedelta(days=landing.signup_benefit_valid_days) if landing.signup_benefit_valid_days else None
        grant, _created = _get_or_create(
            db,
            ClubBenefitGrant,
            {"unique_key": f"signup:{club.id}:{customer.id}"},
            {
                "id": uuid.uuid4(),
                "tenant_id": club.tenant_id,
                "company_id": club.company_id,
                "club_id": club.id,
                "membership_id": membership.id,
                "customer_id": customer.id,
                "kind": "signup",
                "title": landing.signup_benefit_title[:120],
                "status": "available",
                "valid_until": valid_until,
                "created_at": now,
            },
        )
        benefit = {"title": grant.title, "validUntil": grant.valid_until.isoformat() if grant.valid_until else None,
                   "status": grant.status}

    challenge.phone_ciphertext = None
    audit(
        db,
        tenant_id=club.tenant_id,
        company_id=club.company_id,
        domain="club",
        subject_type="membership",
        subject_id=membership.id,
        action="registered" if new_membership else "reregistered",
        details={"source": source.source_kind if source is not None else "link", "marketingSms": clean["marketing_sms"]},
    )
    db.flush()
    return {
        "status": "registered" if new_membership else "existing_member",
        "firstName": customer.first_name,
        "memberNumber": membership.member_number,
        "membershipStatus": membership.status,
        "memberToken": membership.qr_token if membership.status == MEMBERSHIP_ACTIVE else None,
        "benefit": benefit,
    }
