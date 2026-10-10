"""
Marketing consent ("דיוור שיווקי", חוק התקשורת (בזק ושידורים) §30א) on the online-ordering checkout
and the business-card enquiry form.

* A separate, unticked box (client `MarketingConsent`), never bundled with the order or the terms.
  Leaving it unticked records nothing and withdraws nothing.
* Each grant / withdrawal is a row of `marketing_consent_records`: the contact only as a keyed hash,
  the channel, the exact text shown and its version, the source (checkout / enquiry) and its order
  or enquiry reference.
* Transactional messages ("ההזמנה התקבלה", "ההזמנה מוכנה") never read this table and never carry
  marketing content.

The checkout and enquiry routes call `consent_from_payload` + `record` in their own transaction.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.digital_legal import MarketingConsentRecord
from app.services.digital_legal.documents import LegalError
from app.services.notifications.crypto import keyed_hash
from app.services.notifications.phone import PhoneError, normalize_phone, phone_hash

CHANNELS = ("sms", "whatsapp", "email")
SOURCES = ("checkout", "enquiry", "dashboard", "unsubscribe")
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

#: The box's text per version and channel — the client's copy is client/src/lib/marketingConsent.ts
#: (tests/test_digital_legal.py keeps them equal). A new wording = a new version, never an edit.
CURRENT_TEXT_VERSION = "mk-he-1"
TEXTS: Dict[str, Dict[str, str]] = {
    "mk-he-1": {
        "sms": "אני מאשר/ת לקבל הודעות שיווקיות (מבצעים ועדכונים) מאת {business} ב-SMS. אפשר לבטל את ההסכמה בכל עת.",
        "whatsapp": "אני מאשר/ת לקבל הודעות שיווקיות (מבצעים ועדכונים) מאת {business} בוואטסאפ. אפשר לבטל את ההסכמה בכל עת.",
        "email": 'אני מאשר/ת לקבל הודעות שיווקיות (מבצעים ועדכונים) מאת {business} בדוא"ל. אפשר לבטל את ההסכמה בכל עת.',
    },
}


def consent_text(channel: str, business_name: str, version: str = CURRENT_TEXT_VERSION) -> str:
    try:
        template = TEXTS[version][channel]
    except KeyError:
        raise LegalError("marketing_text_unknown", 422) from None
    return template.replace("{business}", (business_name or "").strip())


def _subject(channel: str, contact: Any) -> tuple:
    if channel == "email":
        email = str(contact or "").strip().lower()
        if not EMAIL.match(email):
            raise LegalError("email_invalid", 422)
        return "email", keyed_hash(email, label="email")
    try:
        e164 = normalize_phone(str(contact or ""))
    except PhoneError:
        raise LegalError("phone_invalid", 422) from None
    return "phone", phone_hash(e164)


def consent_from_payload(raw: Any, *, business_name: str) -> Optional[Dict[str, Any]]:
    """
    The checkout / enquiry body's `marketingConsent` → `{channel, text, textVersion}` when the box was
    ticked; None when it was not (or absent). The text must be exactly the one this version shows —
    a client cannot record wording the business never displayed.
    """
    if not isinstance(raw, dict) or raw.get("granted") is not True:
        return None
    channel = raw.get("channel")
    if channel not in CHANNELS:
        raise LegalError("channel_invalid", 422)
    version = raw.get("textVersion") or CURRENT_TEXT_VERSION
    expected = consent_text(channel, business_name, version)
    if (raw.get("text") or "").strip() != expected:
        raise LegalError("marketing_text_mismatch", 422)
    return {"channel": channel, "text": expected, "textVersion": version}


def record(
    db: Session,
    *,
    company: Company,
    channel: str,
    contact: Any,
    granted: bool,
    text: str,
    text_version: str,
    source: str,
    shop_id: Any = None,
    source_ref: Optional[str] = None,
    ip: Optional[str] = None,
    actor_user_id: Any = None,
    now: Optional[datetime] = None,
) -> MarketingConsentRecord:
    if channel not in CHANNELS:
        raise LegalError("channel_invalid", 422)
    if source not in SOURCES:
        raise LegalError("source_invalid", 422)
    if not isinstance(granted, bool):
        raise LegalError("granted_invalid", 422)
    if not (text or "").strip() or not (text_version or "").strip():
        raise LegalError("marketing_text_required", 422)
    kind, subject = _subject(channel, contact)
    row = MarketingConsentRecord(
        id=uuid.uuid4(),
        tenant_id=company.tenant_id,
        company_id=company.id,
        shop_id=shop_id,
        channel=channel,
        subject_kind=kind,
        subject_hash=subject,
        granted=granted,
        text_snapshot=text.strip(),
        text_version=text_version.strip()[:20],
        source=source,
        source_ref=(str(source_ref)[:80] if source_ref else None),
        ip_hash=keyed_hash(ip, label="ip") if ip else None,
        actor_user_id=actor_user_id,
        occurred_at=now or datetime.now(timezone.utc),
    )
    db.add(row)
    db.flush()
    return row


def has_consent(db: Session, *, company_id: Any, channel: str, contact: Any) -> bool:
    """May this contact receive marketing on this channel? The latest grant / withdrawal decides."""
    try:
        _, subject = _subject(channel, contact)
    except LegalError:
        return False
    row = (
        db.query(MarketingConsentRecord)
        .filter(
            MarketingConsentRecord.company_id == company_id,
            MarketingConsentRecord.channel == channel,
            MarketingConsentRecord.subject_hash == subject,
        )
        .order_by(MarketingConsentRecord.occurred_at.desc())
        .first()
    )
    return bool(row is not None and row.granted)
