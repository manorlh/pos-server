"""
A dashboard user's own preferences (`users.preferences`), chosen in their profile.

Kept on the server, on the user, so a choice made on the phone is the choice on the
computer too — never only in one browser's storage.

* `homePage` — "דף פתיחה": where a sign-in lands. `board` (לוח בקרה, the cockpit) by default;
  the dashboard maps each id to its page (client/src/lib/homePage.ts keeps the same ids) and
  falls back to the board for a page the user may not open — the board itself is open to
  everyone signed in and shows what they may see.
* `simpleMode` — "תצוגת מנהל פשוטה": the menu collapsed to the manager's own (the cockpit, a
  short list of reports, the settings they may change). Unset, it is on only for a user given
  "מנהל סניף / אירוע" or "מנהל אזור" — never by role alone (a shop manager keeps the full menu
  unless they are on one of those) — and off for everyone else; `simpleModeDefault` says which.

Reading is forgiving (an unknown key or value reads as the default, never a 500); writing
is strict (an unknown value is a 422), so nothing but known values is ever stored.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.user import User

HOME_PAGE_KEY = "homePage"
SIMPLE_MODE_KEY = "simpleMode"
DEFAULT_HOME_PAGE = "board"
#: The opening pages offered in the profile, in the order offered.
HOME_PAGES = (
    "board",
    "compare",
    "live_items",
    "transactions",
    "shifts",
    "z_reports",
    "machines",
    "products",
)
def simple_mode_default(db: Optional[Session], user: User) -> bool:
    """On only for a user on a manager template ("מנהל סניף / אירוע", "מנהל אזור")."""
    if db is None or not callable(getattr(db, "get", None)):
        return False
    from app.models.dashboard_access import DashboardAccessProfile
    from app.services.dashboard_sections import MANAGER_TEMPLATES

    profile = db.get(DashboardAccessProfile, user.id) if getattr(user, "id", None) is not None else None
    return bool(profile is not None and not profile.full_access and profile.builtin_template in MANAGER_TEMPLATES)


def read_preferences(user: User, db: Optional[Session] = None) -> Dict[str, Any]:
    """The user's preferences with the defaults filled in; unknown values read as the default."""
    raw = getattr(user, "preferences", None)
    stored = raw if isinstance(raw, dict) else {}
    home = stored.get(HOME_PAGE_KEY)
    default_simple = simple_mode_default(db, user)
    simple = stored.get(SIMPLE_MODE_KEY)
    return {
        HOME_PAGE_KEY: home if home in HOME_PAGES else DEFAULT_HOME_PAGE,
        SIMPLE_MODE_KEY: simple if isinstance(simple, bool) else default_simple,
        "simpleModeDefault": default_simple,
    }


def update_preferences(db: Session, user: User, patch: Dict[str, Any]) -> Dict[str, Any]:
    """Apply the keys present in `patch` (None = back to the default); refuse unknown values."""
    current = dict(user.preferences) if isinstance(user.preferences, dict) else {}
    if HOME_PAGE_KEY in patch:
        home = patch[HOME_PAGE_KEY]
        if home is None or home == DEFAULT_HOME_PAGE:
            current.pop(HOME_PAGE_KEY, None)
        elif home in HOME_PAGES:
            current[HOME_PAGE_KEY] = home
        else:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"homePage must be one of: {', '.join(HOME_PAGES)}",
            )
    if SIMPLE_MODE_KEY in patch:
        simple = patch[SIMPLE_MODE_KEY]
        if simple is None:
            current.pop(SIMPLE_MODE_KEY, None)
        elif isinstance(simple, bool):
            current[SIMPLE_MODE_KEY] = simple
        else:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="simpleMode must be true, false or null")
    # A new dict, so the JSON column is seen as changed.
    user.preferences = current or None
    db.commit()
    db.refresh(user)
    return read_preferences(user, db)
