"""
The till parameters' change log ("פרמטרים לקופות" — who changed what, when, at which level).

Written by the parameters page's routes (app/routers/till_parameters.py) in the same transaction
as the change itself, so a change is never made without its row and never logged without being
made. Rows are never updated or deleted (`till_parameter_changes`, app/models/till_parameter.py).
Read back by the dashboard: a parameter's history, and the machine page's "who turned it on"
for `terminalNumberCheckBypass` (app/services/terminal_check_bypass.py).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.till_parameter import TillParameterChange

logger = logging.getLogger(__name__)

SET, CLEAR, DEFAULT, ACTIVE, DELETED = "set", "clear", "default", "active", "deleted"
#: `scope_type` of a change to the definition itself (its default, activation or deletion).
DEFINITION_SCOPE = "default"


def _role(user: Any) -> Optional[str]:
    role = getattr(user, "role", None)
    value = getattr(role, "value", role)
    return str(value)[:32] if value is not None else None


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None:
        return None
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def record_change(
    db: Session,
    *,
    parameter: Any,
    scope_type: str,
    scope_id: Any,
    action: str,
    old_value: Any,
    new_value: Any,
    user: Any,
    now: Optional[datetime] = None,
) -> TillParameterChange:
    """Add one row (the caller commits). A sensitive key is also written to the log."""
    email = getattr(user, "email", None)
    row = TillParameterChange(
        id=uuid.uuid4(),
        parameter_id=_uuid(getattr(parameter, "id", None)),
        parameter_key=str(getattr(parameter, "key", ""))[:64],
        scope_type=scope_type,
        scope_id=_uuid(scope_id),
        action=action,
        old_value=old_value,
        new_value=new_value,
        user_id=_uuid(getattr(user, "id", None)),
        user_email=str(email)[:255] if isinstance(email, str) else None,
        user_role=_role(user),
        created_at=now or datetime.now(timezone.utc),
    )
    db.add(row)
    from app.services.terminal_check_bypass import RESTRICTED_KEYS

    if row.parameter_key in RESTRICTED_KEYS:
        logger.warning(
            "till parameter %s %s at %s %s: %r -> %r by %s (%s)",
            row.parameter_key, action, scope_type, row.scope_id, old_value, new_value,
            row.user_email or row.user_id, row.user_role,
        )
    return row


def as_json(row: TillParameterChange) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "parameterKey": row.parameter_key,
        "scopeType": row.scope_type,
        "scopeId": str(row.scope_id) if row.scope_id is not None else None,
        "action": row.action,
        "oldValue": row.old_value,
        "newValue": row.new_value,
        "userId": str(row.user_id) if row.user_id is not None else None,
        "userEmail": row.user_email,
        "userRole": row.user_role,
        "at": row.created_at.isoformat() if row.created_at is not None else None,
    }


def changes_for(db: Session, parameter_key: str, limit: int = 100) -> List[TillParameterChange]:
    """The newest first."""
    return (
        db.query(TillParameterChange)
        .filter(TillParameterChange.parameter_key == parameter_key)
        .order_by(TillParameterChange.created_at.desc())
        .limit(max(1, min(int(limit), 500)))
        .all()
    )


def latest_change(db: Session, parameter_key: str, scope_type: str, scope_id: Any) -> Optional[Dict[str, Any]]:
    """The newest change of one level's value; None when none is recorded. Never raises."""
    try:
        # A savepoint: a failed read (the table not migrated yet) never poisons the request.
        with db.begin_nested():
            row = (
                db.query(TillParameterChange)
                .filter(
                    TillParameterChange.parameter_key == parameter_key,
                    TillParameterChange.scope_type == scope_type,
                    TillParameterChange.scope_id == _uuid(scope_id),
                )
                .order_by(TillParameterChange.created_at.desc())
                .first()
            )
    except Exception:  # noqa: BLE001 - a view never fails for its history
        logger.exception("till parameter change log: not read")
        return None
    return as_json(row) if row is not None else None
