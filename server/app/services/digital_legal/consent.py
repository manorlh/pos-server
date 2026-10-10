"""
The cookie banner's consent log (plan §17.3).

Categories: `essential` (always on), `analytics`, `marketing` — everything but essential is off
until the visitor turns it on. Each choice is logged: the visitor's random id only as a keyed hash,
the cookie policy version the banner showed, the choices, grant / update / revoke, and the time.
Append-only: a revocation is a new row, never an edit.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.digital_legal import KIND_COOKIES, CookieConsentRecord
from app.services.digital_legal import documents as D
from app.services.notifications.crypto import keyed_hash

CATEGORIES = ("essential", "analytics", "marketing")
OPTIONAL_CATEGORIES = ("analytics", "marketing")
ACTIONS = ("grant", "update", "revoke")
SURFACES = ("menu", "online", "card", "legal", "other")
ANON_ID = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
MAX_POLICY_VERSION = 1_000_000


def anon_hash(anon_id: str) -> str:
    return keyed_hash(anon_id, label="cookie-consent")


def clean_choices(raw: Any, *, action: str = "grant") -> Dict[str, bool]:
    """Essential is always true; an optional category is on only when it is literally `true`."""
    out = {"essential": True}
    for cat in OPTIONAL_CATEGORIES:
        out[cat] = action != "revoke" and isinstance(raw, dict) and raw.get(cat) is True
    return out


def policy_version(db: Session, *, company_id: Any, shop_id: Any = None, lang: str = "he") -> int:
    """The published cookie policy version a page shows (0 when none is published)."""
    doc, _ = D.effective(db, company_id=company_id, shop_id=shop_id, kind=KIND_COOKIES, lang=lang)
    return int(doc.version) if doc is not None else 0


def record(
    db: Session,
    *,
    company: Company,
    anon_id: Any,
    choices: Any,
    policy_version: Any,
    action: Any,
    surface: Any = "other",
    ip: Optional[str] = None,
    now: Optional[datetime] = None,
) -> CookieConsentRecord:
    if not isinstance(anon_id, str) or not ANON_ID.match(anon_id):
        raise D.LegalError("anon_id_invalid", 422)
    if action not in ACTIONS:
        raise D.LegalError("action_invalid", 422)
    try:
        version = int(policy_version or 0)
    except (TypeError, ValueError):
        raise D.LegalError("policy_version_invalid", 422) from None
    if version < 0 or version > MAX_POLICY_VERSION:
        raise D.LegalError("policy_version_invalid", 422)
    row = CookieConsentRecord(
        id=uuid.uuid4(),
        tenant_id=company.tenant_id,
        company_id=company.id,
        anon_hash=anon_hash(anon_id),
        policy_version=version,
        choices=clean_choices(choices, action=action),
        action=action,
        surface=surface if surface in SURFACES else "other",
        ip_hash=keyed_hash(ip, label="ip") if ip else None,
        created_at=now or datetime.now(timezone.utc),
    )
    db.add(row)
    db.flush()
    return row


def latest(db: Session, *, company_id: Any, anon_id: str) -> Optional[CookieConsentRecord]:
    """The visitor's latest choice (for proof of consent and support)."""
    return (
        db.query(CookieConsentRecord)
        .filter(CookieConsentRecord.company_id == company_id, CookieConsentRecord.anon_hash == anon_hash(anon_id))
        .order_by(CookieConsentRecord.created_at.desc())
        .first()
    )
