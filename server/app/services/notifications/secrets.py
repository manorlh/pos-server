"""
The 019 API token — reusing the card-integration secrets store
(`payment_integration_secrets`, app/services/payment_secrets.py): Fernet-encrypted at
rest, write-only from the dashboard, never sent to a browser, a till, a KDS or a log.

Stored on the provider config's own layer: level "company" (entity = the company) or
"tenant" (entity = the tenant), key `sms019Token`. Only the worker / the adapter reads
the clear text (`resolve_token`); everything else gets `token_status`.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.notifications import NotificationProviderConfig
from app.models.payment_secret import PaymentIntegrationSecret
from app.services.payment_secrets import (
    PaymentSecretError,
    clean_secret,
    decrypt,
    encrypt,
    is_mask,
)

SMS019_TOKEN = "sms019Token"


def _layer(config: NotificationProviderConfig) -> tuple[str, uuid.UUID]:
    if config.company_id is not None:
        return "company", config.company_id
    return "tenant", config.tenant_id


def _row(db: Session, config: NotificationProviderConfig) -> Optional[PaymentIntegrationSecret]:
    level, entity = _layer(config)
    return (
        db.query(PaymentIntegrationSecret)
        .filter(
            PaymentIntegrationSecret.level == level,
            PaymentIntegrationSecret.entity_id == entity,
            PaymentIntegrationSecret.key == SMS019_TOKEN,
        )
        .first()
    )


def set_token(db: Session, config: NotificationProviderConfig, value: Any, *, user_id: Any = None) -> bool:
    """
    Store / replace / remove ("" or None) the token. A masked echo ("••••") keeps the
    stored one. True when something changed. Raises PaymentSecretError("secret_invalid").
    """
    if is_mask(value):
        return False
    cleaned = clean_secret(value)
    row = _row(db, config)
    if cleaned is None:
        if row is not None:
            db.delete(row)
            db.flush()
            return True
        return False
    if row is None:
        level, entity = _layer(config)
        row = PaymentIntegrationSecret(
            id=uuid.uuid4(), level=level, entity_id=entity, key=SMS019_TOKEN, tenant_id=config.tenant_id
        )
        db.add(row)
    elif decrypt(row.ciphertext) == cleaned:
        return False
    row.ciphertext = encrypt(cleaned)
    row.updated_by = user_id if isinstance(user_id, uuid.UUID) else None
    row.updated_at = datetime.now(timezone.utc)
    db.flush()
    return True


def token_status(db: Session, config: NotificationProviderConfig) -> Dict[str, Any]:
    """For the dashboard: whether a token is stored and when — never the value."""
    row = _row(db, config)
    return {"set": row is not None, "updatedAt": row.updated_at if row is not None else None}


def resolve_token(db: Session, config: NotificationProviderConfig) -> Optional[str]:
    """The clear text, for the adapter only. None when unset or unreadable."""
    row = _row(db, config)
    return decrypt(row.ciphertext) if row is not None else None


__all__ = ["SMS019_TOKEN", "PaymentSecretError", "set_token", "token_status", "resolve_token"]
