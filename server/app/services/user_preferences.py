"""
A dashboard user's own preferences (`users.preferences`), chosen in their profile.

Kept on the server, on the user, so a choice made on the phone is the choice on the
computer too — never only in one browser's storage.

Today one preference:

* `homePage` — "דף פתיחה": where a sign-in lands. `board` (לוח בקרה) by default; the
  dashboard maps each id to its page (client/src/lib/homePage.ts keeps the same ids) and
  falls back to the board for a page the user may not open — the board itself is open to
  everyone signed in and shows what they may see.

Reading is forgiving (an unknown key or value reads as the default, never a 500); writing
is strict (an unknown home page is a 422), so nothing but known values is ever stored.
"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.user import User

HOME_PAGE_KEY = "homePage"
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


def read_preferences(user: User) -> Dict[str, Any]:
    """The user's preferences with the defaults filled in; unknown values read as the default."""
    raw = getattr(user, "preferences", None)
    stored = raw if isinstance(raw, dict) else {}
    home = stored.get(HOME_PAGE_KEY)
    return {HOME_PAGE_KEY: home if home in HOME_PAGES else DEFAULT_HOME_PAGE}


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
    # A new dict, so the JSON column is seen as changed.
    user.preferences = current or None
    db.commit()
    db.refresh(user)
    return read_preferences(user)
