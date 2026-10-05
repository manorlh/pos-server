"""
Who sees what ("הרשאות"): the super admin narrows, per role, the dashboard entries a role
sees and the device actions it may take. It only ever narrows: the roles' own rules (the
dashboard's gates, the routers' role checks) stay, and a super admin is never narrowed.

Stored as the platform setting "access":
    {"hiddenNav": {role: [href, ...]}, "deniedFeatures": {role: [feature, ...]}}

The device actions ("features") are enforced here, server side, by the routes that take
them (`require_feature`); the hidden entries are the dashboard's to hide (and to refuse
when reached by address).
"""
from __future__ import annotations

from typing import Any, Dict, List

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.platform_setting import PlatformSetting
from app.models.user import User, UserRole

ACCESS_KEY = "access"

#: The roles the super admin can narrow (never the super admin itself).
ROLES = ("distributor", "company_manager", "shop_manager", "shift_supervisor", "cashier")

#: Device actions: add (pair) tills, move a till to another shop, remove a till.
PAIR_DEVICES = "pairDevices"
MOVE_DEVICES = "moveDevices"
REMOVE_DEVICES = "removeDevices"
FEATURES = (PAIR_DEVICES, MOVE_DEVICES, REMOVE_DEVICES)


def _role(user: Any) -> str:
    role = getattr(user, "role", None)
    return role.value if hasattr(role, "value") else str(role or "")


def get_access(db: Session) -> Dict[str, Dict[str, List[str]]]:
    # (A stand-in session without `get` — some tests' — has no settings: nothing narrowed.)
    row = db.get(PlatformSetting, ACCESS_KEY) if callable(getattr(db, "get", None)) else None
    value = row.value if isinstance(getattr(row, "value", None), dict) else {}

    def clean(raw: Any, allowed=None) -> Dict[str, List[str]]:
        out: Dict[str, List[str]] = {}
        if isinstance(raw, dict):
            for role, items in raw.items():
                if role in ROLES and isinstance(items, list):
                    kept = sorted({str(i) for i in items if isinstance(i, str) and (allowed is None or i in allowed)})
                    if kept:
                        out[role] = kept
        return out

    return {
        "hiddenNav": clean(value.get("hiddenNav")),
        "deniedFeatures": clean(value.get("deniedFeatures"), FEATURES),
    }


def set_access(db: Session, user: User, body: Dict[str, Any]) -> Dict[str, Dict[str, List[str]]]:
    row = db.get(PlatformSetting, ACCESS_KEY)
    if row is None:
        row = PlatformSetting(key=ACCESS_KEY, value={})
        db.add(row)
    row.value = {"hiddenNav": body.get("hiddenNav") or {}, "deniedFeatures": body.get("deniedFeatures") or {}}
    row.updated_by_user_id = getattr(user, "id", None)
    db.flush()
    # Stored as given, read back cleaned: an unknown role or feature is never kept.
    row.value = get_access(db)
    db.flush()
    return row.value


def feature_allowed(db: Session, user: Any, feature: str) -> bool:
    if getattr(user, "role", None) == UserRole.SUPER_ADMIN:
        return True
    return feature not in get_access(db)["deniedFeatures"].get(_role(user), [])


def require_feature(db: Session, user: Any, feature: str) -> None:
    """403 `feature_not_allowed` when the super admin took [feature] from the caller's role."""
    if not feature_allowed(db, user, feature):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "feature_not_allowed", "feature": feature},
        )
