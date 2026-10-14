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
* `reportColumns` — "עמודות" (P:/specs/reports-upgrade.md §4.4): per report key, the columns the
  user shows (`visible`) and their order (`order`). Merged per report on write: a report sent as
  null is removed, `reportColumns: null` removes all. Keys as the company's export defaults'
  (app/services/report_export_defaults.py); at most `MAX_REPORT_COLUMN_REPORTS` reports.
* `problemsHiddenGroups` — "בעיות" (P:/specs/manager-problems.md §3): the groups the user hid on
  that screen (`GET/PUT /problems/preferences`, app/services/problems.py `GROUPS`). Not part of
  `read_preferences` (the profile's): read and written by its own two functions below.

Reading is forgiving (an unknown key or value reads as the default, never a 500); writing
is strict (an unknown value is a 422), so nothing but known values is ever stored.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.user import User

HOME_PAGE_KEY = "homePage"
SIMPLE_MODE_KEY = "simpleMode"
REPORT_COLUMNS_KEY = "reportColumns"
#: "בקשות אישור גם בשעות שקטות": a remote approval request reaches the phone in quiet hours too.
APPROVALS_QUIET_KEY = "approvalsInQuietHours"
PROBLEMS_HIDDEN_KEY = "problemsHiddenGroups"
MAX_REPORT_COLUMN_REPORTS = 200
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
        REPORT_COLUMNS_KEY: _read_report_columns(stored.get(REPORT_COLUMNS_KEY)),
        APPROVALS_QUIET_KEY: stored.get(APPROVALS_QUIET_KEY) is True,
    }


def _read_report_columns(raw: Any) -> Dict[str, Dict[str, List[str]]]:
    """The stored choices; anything malformed reads as not chosen (never a 500)."""
    from app.services.report_export_defaults import COLUMN_KEY_RE, REPORT_KEY_RE

    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Dict[str, List[str]]] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not REPORT_KEY_RE.match(key) or not isinstance(value, dict):
            continue
        out[key] = {
            part: [c for c in value.get(part) or [] if isinstance(c, str) and COLUMN_KEY_RE.match(c)]
            for part in ("visible", "order")
        }
    return out


def _write_report_columns(current: Dict[str, Any], patch_value: Any) -> None:
    from app.services.report_export_defaults import validate_columns, validate_report_key

    if patch_value is None:
        current.pop(REPORT_COLUMNS_KEY, None)
        return
    if not isinstance(patch_value, dict):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="reportColumns must be an object")
    stored = _read_report_columns(current.get(REPORT_COLUMNS_KEY))
    for key, value in patch_value.items():
        validate_report_key(key)
        if value is None:
            stored.pop(key, None)
            continue
        if not isinstance(value, dict) or set(value) - {"visible", "order"}:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="reportColumns.<reportKey> must be {visible, order}",
            )
        stored[key] = {
            "visible": validate_columns(value.get("visible") or [], field=f"reportColumns.{key}.visible"),
            "order": validate_columns(value.get("order") or [], field=f"reportColumns.{key}.order"),
        }
    if len(stored) > MAX_REPORT_COLUMN_REPORTS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"reportColumns: at most {MAX_REPORT_COLUMN_REPORTS} reports",
        )
    if stored:
        current[REPORT_COLUMNS_KEY] = stored
    else:
        current.pop(REPORT_COLUMNS_KEY, None)


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
    if REPORT_COLUMNS_KEY in patch:
        _write_report_columns(current, patch[REPORT_COLUMNS_KEY])
    if APPROVALS_QUIET_KEY in patch:
        flag = patch[APPROVALS_QUIET_KEY]
        if flag is None or flag is False:
            current.pop(APPROVALS_QUIET_KEY, None)
        elif flag is True:
            current[APPROVALS_QUIET_KEY] = True
        else:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="approvalsInQuietHours must be true, false or null",
            )
    # A new dict, so the JSON column is seen as changed.
    user.preferences = current or None
    db.commit()
    db.refresh(user)
    return read_preferences(user, db)


def read_problems_hidden(user: User) -> List[str]:
    """"בעיות": the groups this user hid, known ones only, in the screen's order."""
    from app.services.problems import GROUPS

    raw = getattr(user, "preferences", None)
    stored = raw.get(PROBLEMS_HIDDEN_KEY) if isinstance(raw, dict) else None
    chosen = set(stored) if isinstance(stored, list) else set()
    return [g for g in GROUPS if g in chosen]


def write_problems_hidden(db: Session, user: User, groups: Any) -> List[str]:
    """Replace the hidden groups (a list of `GROUPS` keys; [] or null shows them all); 422 otherwise."""
    from app.services.problems import GROUPS

    if groups is None:
        groups = []
    if not isinstance(groups, list) or any(not isinstance(g, str) or g not in GROUPS for g in groups):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"hiddenGroups must be a list of: {', '.join(GROUPS)}",
        )
    current = dict(user.preferences) if isinstance(user.preferences, dict) else {}
    ordered = [g for g in GROUPS if g in set(groups)]
    if ordered:
        current[PROBLEMS_HIDDEN_KEY] = ordered
    else:
        current.pop(PROBLEMS_HIDDEN_KEY, None)
    # A new dict, so the JSON column is seen as changed.
    user.preferences = current or None
    db.commit()
    db.refresh(user)
    return read_problems_hidden(user)
