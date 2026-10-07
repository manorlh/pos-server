"""
"מגירת מזומן" — the cash drawer module's cloud side (docs/SPEC_ROLES_PERMISSIONS.md,
the owner's drawer spec §1–§20).

This file holds:

* the drawer's management parameters (spec §17) as built-in till parameters, which
  inherit company → shop → area (נקודת מכירה) → till like every till parameter, and the
  level editor the roles page uses for them (`level_view` / `save_values`);
* (see below) the drawer events and cash movements the tills upload, the expected
  balance, the exceptions of §11 and the reports of §16.

The till decides every opening itself, offline included (`CashDrawerService` on the
till); the cloud records, reports and flags.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

# ── Parameters (spec §17) ─────────────────────────────────────────────────────

#: The existing "פתיחת מגירה" parameter (printers page): whether a drawer is connected,
#: opens on a cash payment, and has the manual button. Spec §17's "פתיחה אוטומטית במכירת
#: מזומן" and "אפשר פתיחה ידנית" are its options, so it is reused rather than duplicated.
HARDWARE_KEY = "cashDrawer"

REQUIRE_REASON_KEY = "cashDrawer.requireReason"
REQUIRE_NOTE_FOR_OTHER_KEY = "cashDrawer.requireNoteForOther"
REQUIRE_MANAGER_KEY = "cashDrawer.requireManagerApproval"
MOVEMENTS_ENABLED_KEY = "cashDrawer.cashMovementsEnabled"
CASH_OUT_APPROVAL_AMOUNT_KEY = "cashDrawer.cashOutApprovalAmount"
ALLOW_AFTER_CLOSE_KEY = "cashDrawer.allowOpenAfterClose"
BLIND_COUNT_KEY = "cashDrawer.blindCount"
MAX_MANUAL_OPENS_KEY = "cashDrawer.maxManualOpensPerShift"
ALERT_OPENS_COUNT_KEY = "cashDrawer.alertOpensCount"
ALERT_OPENS_MINUTES_KEY = "cashDrawer.alertOpensWithinMinutes"
CASH_OUT_ALERT_AMOUNT_KEY = "cashDrawer.cashOutAlertAmount"
VARIANCE_ALERT_AMOUNT_KEY = "cashDrawer.varianceAlertAmount"
NEAR_VARIANCE_MINUTES_KEY = "cashDrawer.nearVarianceMinutes"
#: Not the drawer's only: how the till shows an action the user's role denies.
DENIED_UI_KEY = "permissionsDeniedUi"
DENIED_UI_HIDE = "הסתר"
DENIED_UI_DISABLE = "הצג מושבת עם הסבר"

CASH_DRAWER_PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=REQUIRE_REASON_KEY, label="מגירה — דרוש סיבה לפתיחה ידנית", value_type="boolean", default_value=True,
        description=(
            "REQUIRE_REASON_FOR_MANUAL_OPEN: \"פתח מגירה\" בלי עסקה מבקש לבחור סיבה (פריטת כסף, מתן עודף, "
            "הכנסת / הוצאת מזומן, הפקדה, ספירה, תיקון טעות, בדיקה, אחר). כבוי — הפתיחה נרשמת עם הסיבה \"לא צוינה\"."
        ),
    ),
    dict(
        key=REQUIRE_NOTE_FOR_OTHER_KEY, label="מגירה — בסיבה \"אחר\" חובה הערה", value_type="boolean",
        default_value=True, description="כשהסיבה לפתיחה ידנית היא \"אחר\", העובד חייב לכתוב הערה חופשית.",
    ),
    dict(
        key=REQUIRE_MANAGER_KEY, label="מגירה — כל פתיחה ידנית באישור מנהל", value_type="boolean",
        default_value=False,
        description=(
            "כשמופעל, כל פתיחה ידנית (כולל פריטה) דורשת אישור מנהל גם למי שהתפקיד שלו מתיר אותה — "
            "מלבד מי שמורשה לאשר פעולות מגירה (\"אישור פעולת מגירה לעובד אחר\")."
        ),
    ),
    dict(
        key=MOVEMENTS_ENABLED_KEY, label="מגירה — אפשר הכנסה / הוצאה / הפקדה", value_type="boolean",
        default_value=True,
        description="Cash In, Cash Out והפקדה מתפריט הקופה. כבוי — הפעולות לא מוצגות (ההרשאות עדיין חלות כשמופעל).",
    ),
    dict(
        key=CASH_OUT_APPROVAL_AMOUNT_KEY, label="מגירה — סף סכום המחייב אישור נוסף (₪)", value_type="decimal",
        default_value=0,
        description=(
            "הוצאת מזומן או הפקדה מעל הסכום הזה דורשת תמיד אישור של מי שמורשה לאשר פעולות מגירה ושהסף שלו "
            "מכסה את הסכום — גם כשהתפקיד מתיר לבצע לבד. 0 — ללא סף (רק לפי ההרשאות)."
        ),
    ),
    dict(
        key=ALLOW_AFTER_CLOSE_KEY, label="מגירה — אפשר פתיחה לאחר סגירה / Z", value_type="boolean",
        default_value=True,
        description=(
            "כשאין משמרת פתוחה (אחרי סגירה / Z) פתיחה מותרת רק למי שיש לו \"פתיחה לאחר סגירת קופה / Z\" "
            "(או באישור), ותמיד נרשמת כחריגה. כבוי — חסום לכולם."
        ),
    ),
    dict(
        key=BLIND_COUNT_KEY, label="מגירה — הפעל Blind Count", value_type="boolean", default_value=False,
        description=(
            "ספירה עיוורת: בספירת מגירה ובסגירת משמרת העובד לא רואה את היתרה הצפויה לפני שהוא מזין את הסכום "
            "שנספר. אחרי האישור מוצגים צפוי, נספר והפער. נשמר מי ספר, מי אישר, מתי והפער."
        ),
    ),
    dict(
        key=MAX_MANUAL_OPENS_KEY, label="מגירה — מקסימום פתיחות ידניות למשמרת", value_type="integer",
        default_value=0,
        description=(
            "MAX_MANUAL_OPENS_PER_SHIFT: מעבר למספר הזה, כל פתיחה ידנית נוספת של העובד במשמרת דורשת אישור מנהל "
            "ונרשמת כחריגה. 0 — ללא הגבלה."
        ),
    ),
    dict(
        key=ALERT_OPENS_COUNT_KEY, label="מגירה — התראה אחרי X פתיחות ידניות", value_type="integer",
        default_value=3,
        description="ריבוי פתיחות: X פתיחות ידניות בתוך מספר הדקות שבפרמטר הבא נרשמות כחריגה. 0 — כבוי.",
    ),
    dict(
        key=ALERT_OPENS_MINUTES_KEY, label="מגירה — בפרק זמן של (דקות)", value_type="integer", default_value=10,
        description="ALERT_OPENS_WITHIN_MINUTES: חלון הזמן לספירת פתיחות ידניות לצורך התראה.",
    ),
    dict(
        key=CASH_OUT_ALERT_AMOUNT_KEY, label="מגירה — התראה על Cash Out מעל (₪)", value_type="decimal",
        default_value=500,
        description="CASH_OUT_APPROVAL_THRESHOLD: הוצאת מזומן מעל הסכום נרשמת כחריגה. 0 — כבוי.",
    ),
    dict(
        key=VARIANCE_ALERT_AMOUNT_KEY, label="מגירה — התראה על פער מגירה מעל (₪)", value_type="decimal",
        default_value=50,
        description=(
            "DRAWER_VARIANCE_ALERT_THRESHOLD: פער ספירה (נספר מול צפוי) מעל הסכום נרשם כחריגה, וגם פתיחות "
            "ידניות בסמוך לו."
        ),
    ),
    dict(
        key=NEAR_VARIANCE_MINUTES_KEY, label="מגירה — \"בסמוך לפער\" (דקות)", value_type="integer",
        default_value=60,
        description="פתיחות ידניות בתוך מספר הדקות שלפני ספירה עם פער מעל הסף נרשמות כחריגה \"פתיחה בסמוך לפער\".",
    ),
    dict(
        key=DENIED_UI_KEY, label="פעולה אסורה לעובד — הסתר או הצג מושבת", value_type="enum",
        enum_options=(DENIED_UI_HIDE, DENIED_UI_DISABLE), default_value=DENIED_UI_HIDE,
        description=(
            "כשתפקיד העובד אוסר פעולה (\"אסור\"): «הסתר» — הכפתור לא מוצג; «הצג מושבת עם הסבר» — הכפתור מוצג "
            "אפור ולחיצה מסבירה שאין הרשאה. חל על כל ההרשאות בקופה."
        ),
    ),
)

#: The level editor's keys, in the order the roles page shows them.
LEVEL_KEYS: Tuple[str, ...] = (HARDWARE_KEY,) + tuple(spec["key"] for spec in CASH_DRAWER_PARAMETER_SPECS)
SCOPE_TYPES = ("company", "shop", "area", "machine")


def level_view(db, scope_type: str, scope_id: Any) -> Dict[str, Any]:
    """
    What a level sets itself, what it inherits from above, the definitions — the roles
    page's "פרמטרי מגירה" card for one level.
    """
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.kds_workflow import chain_for_scope
    from app.services.till_parameters import ensure_builtin_parameters, resolve_till_parameters

    ensure_builtin_parameters(db)
    params = db.query(TillParameter).filter(TillParameter.key.in_(LEVEL_KEYS)).all()
    by_key = {p.key: p for p in params}
    ident = scope_id if isinstance(scope_id, uuid.UUID) else uuid.UUID(str(scope_id))
    own_rows = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id.in_([p.id for p in params]),
            TillParameterValue.scope_type == scope_type,
            TillParameterValue.scope_id == ident,
        )
        .all()
    ) if params else []
    by_id = {p.id: p for p in params}
    own = {by_id[r.parameter_id].key: r.value for r in own_rows if r.parameter_id in by_id}
    above, _ = chain_for_scope(db, scope_type, ident, above_only=True)
    scopes = above.scopes()
    values = []
    if scopes:
        from sqlalchemy import and_, or_

        values = (
            db.query(TillParameterValue)
            .filter(
                TillParameterValue.parameter_id.in_([p.id for p in params]),
                or_(*[and_(TillParameterValue.scope_type == k, TillParameterValue.scope_id == i) for k, i in scopes]),
            )
            .all()
        )
    inherited = resolve_till_parameters(params, values, above).parameters
    return {
        "scopeType": scope_type,
        "scopeId": str(ident),
        "own": own,
        "inherited": inherited,
        "parameters": [
            {
                "key": key,
                "label": by_key[key].label,
                "description": by_key[key].description,
                "valueType": by_key[key].value_type,
                "enumOptions": by_key[key].enum_options,
                "defaultValue": by_key[key].default_value,
            }
            for key in LEVEL_KEYS
            if key in by_key and by_key[key].is_active
        ],
    }


def save_values(db, scope_type: str, scope_id: Any, values: Dict[str, Any], *, user: Any) -> List[Tuple[str, str]]:
    """
    Write `values` (key → value; None clears the level's own value) at one level, with an
    audit row each (till_parameter_changes). Returns the tills to notify. Raises
    `TillParameterValueError` on a value its definition refuses.
    """
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.till_parameter_audit import record_change
    from app.services.till_parameters import (
        TillParameterValueError,
        ensure_builtin_parameters,
        notify_targets_for_scope,
        validate_value,
    )

    unknown = [k for k in values if k not in LEVEL_KEYS]
    if unknown:
        raise TillParameterValueError(f"unknown parameter {unknown[0]}")
    ensure_builtin_parameters(db)
    params = {p.key: p for p in db.query(TillParameter).filter(TillParameter.key.in_(LEVEL_KEYS)).all()}
    ident = scope_id if isinstance(scope_id, uuid.UUID) else uuid.UUID(str(scope_id))
    now = datetime.now(timezone.utc)
    for key, value in values.items():
        parameter = params.get(key)
        if parameter is None:
            continue
        stored = None if value is None else validate_value(parameter.value_type, value, parameter.enum_options)
        row = (
            db.query(TillParameterValue)
            .filter(
                TillParameterValue.parameter_id == parameter.id,
                TillParameterValue.scope_type == scope_type,
                TillParameterValue.scope_id == ident,
            )
            .first()
        )
        old = row.value if row is not None else None
        if stored is None:
            if row is None:
                continue
            db.delete(row)
            record_change(db, parameter=parameter, scope_type=scope_type, scope_id=ident, action="clear",
                          old_value=old, new_value=None, user=user, now=now)
        else:
            if row is not None and row.value == stored:
                continue
            if row is None:
                db.add(TillParameterValue(
                    id=uuid.uuid4(), parameter_id=parameter.id, scope_type=scope_type, scope_id=ident, value=stored,
                ))
            else:
                row.value = stored
                row.updated_at = now
            record_change(db, parameter=parameter, scope_type=scope_type, scope_id=ident, action="set",
                          old_value=old, new_value=stored, user=user, now=now)
        parameter.updated_at = now
    db.flush()
    return notify_targets_for_scope(db, scope_type, ident)


def scope_company(db, scope_type: str, scope_id: Any) -> Tuple[Optional[uuid.UUID], Optional[uuid.UUID]]:
    """(company id, shop id) of a level — what the roles page checks access against."""
    from app.services.kds_workflow import chain_for_scope

    chain, shop = chain_for_scope(db, scope_type, scope_id)
    if scope_type == "company":
        return chain.company_id, None
    return (shop.company_id if shop is not None else None), (shop.id if shop is not None else None)
