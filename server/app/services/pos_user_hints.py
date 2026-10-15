"""
"אל תציג שוב" per employee (P:/specs/fire-restaurant-flow.md §5, the contract in §8.5): the "how it works" hints
an employee dismissed, kept on `pos_users.hints_dismissed` and shipped with the roster (`hintsDismissed`).
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List

from sqlalchemy.orm import Session

KEY_RE = re.compile(r"^[a-z0-9_.:-]{1,64}$")
#: The most hint keys one employee keeps.
MAX_KEYS = 50


class HintsError(Exception):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code = code
        self.status = status


def _keys(values: Iterable[Any]) -> List[str]:
    out: List[str] = []
    for v in values:
        key = str(v).strip() if isinstance(v, str) else ""
        if not KEY_RE.match(key):
            raise HintsError("invalid_hint_key", 422)
        if key not in out:
            out.append(key)
    return out


def apply(db: Session, machine: Any, pos_user_id: Any, dismiss: Iterable[Any], restore: Iterable[Any]) -> Dict[str, Any]:
    """Merge `dismiss` in and take `restore` out of the employee's list; the list as it stands."""
    from app.models.pos_user import PosUser

    add, remove = _keys(dismiss), _keys(restore)
    try:
        ident = uuid.UUID(str(pos_user_id))
    except (TypeError, ValueError):
        raise HintsError("pos_user_not_found", 404)
    user = db.get(PosUser, ident)
    if user is None or machine.shop_id is None or str(user.shop_id) != str(machine.shop_id):
        raise HintsError("pos_user_not_found", 404)
    before = [k for k in (user.hints_dismissed or []) if isinstance(k, str)]
    after = [k for k in before if k not in remove] + [k for k in add if k not in before and k not in remove]
    if len(after) > MAX_KEYS:
        raise HintsError("too_many_hints", 422)
    if after != before:
        user.hints_dismissed = after or None
        user.updated_at = datetime.now(timezone.utc)
        db.flush()
    return {"posUserId": str(user.id), "hintsDismissed": after}
