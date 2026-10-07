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


# ── Events and movements from the tills (spec §14) ────────────────────────────

EVENT_TYPES = (
    "CASH_SALE", "MANUAL", "CHANGE", "CASH_IN", "CASH_OUT", "DEPOSIT", "COUNT", "TEST", "REFUND",
    "AFTER_CLOSE", "PERMISSION",
)
#: Openings without a sale or a movement of their own: the ones counted as "manual".
MANUAL_TYPES = ("MANUAL", "CHANGE", "AFTER_CLOSE")
MOVEMENT_TYPES = ("cash_in", "cash_out", "deposit", "count")
RESULTS = ("approved", "denied", "failed")


def _money(value: Any):
    from decimal import Decimal, ROUND_HALF_UP

    if value is None:
        return None
    return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _scope_of(db, machine) -> Dict[str, Any]:
    from app.services.exceptions import company_of_shop

    return {
        "tenant_id": machine.tenant_id,
        "company_id": company_of_shop(db, machine.shop_id),
        "shop_id": machine.shop_id,
        "area_id": machine.area_id,
        "machine_id": machine.id,
    }


def record_event(db, machine, body) -> Tuple[Any, bool]:
    """Store one drawer event (idempotent by id). The caller commits."""
    from app.models.cash_drawer import CashDrawerEvent

    existing = db.get(CashDrawerEvent, body.id)
    if existing is not None:
        return existing, False
    row = CashDrawerEvent(
        id=body.id,
        **_scope_of(db, machine),
        category=body.category,
        event_type=body.event_type,
        permission=body.permission,
        decision=body.decision,
        result=body.result,
        result_reason=(body.result_reason or None) and body.result_reason[:300],
        drawer_id=body.drawer_id,
        drawer_name=body.drawer_name,
        device_id=body.device_id,
        shift_id=body.shift_id,
        employee_id=body.employee_id,
        employee_name=body.employee_name,
        employee_role=body.employee_role,
        approver_id=body.approver_id,
        approver_name=body.approver_name,
        approver_method=body.approver_method,
        table_id=body.table_id,
        sale_id=body.sale_id,
        payment_id=body.payment_id,
        original_sale_id=body.original_sale_id,
        reason=body.reason,
        reason_note=body.reason_note,
        movement_id=body.movement_id,
        cash_movement_type=body.cash_movement_type,
        amount=_money(body.amount),
        expected_balance=_money(body.expected_balance),
        offline=bool(body.offline),
        training=bool(body.training),
        details=body.details or None,
        occurred_at=_utc(body.occurred_at),
        received_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.flush()
    return row, True


def record_movement(db, machine, body) -> Tuple[Any, bool]:
    """Store one cash movement (idempotent by id). The caller commits."""
    from app.models.cash_drawer import CashMovement

    existing = db.get(CashMovement, body.id)
    if existing is not None:
        return existing, False
    row = CashMovement(
        id=body.id,
        **_scope_of(db, machine),
        movement_type=body.type,
        amount=_money(body.amount),
        expected_before=_money(body.expected_before),
        expected_after=_money(body.expected_after),
        variance=_money(body.variance),
        blind=bool(body.blind),
        reason=body.reason,
        note=body.note,
        source=body.source,
        shift_id=body.shift_id,
        employee_id=body.employee_id,
        employee_name=body.employee_name,
        approver_id=body.approver_id,
        approver_name=body.approver_name,
        drawer_event_id=body.drawer_event_id,
        offline=bool(body.offline),
        training=bool(body.training),
        occurred_at=_utc(body.occurred_at),
        received_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.flush()
    return row, True


# ── Exceptions (spec §10–§11) ─────────────────────────────────────────────────


def _params(db, machine) -> Dict[str, Any]:
    from app.services.till_parameters import till_parameters_for_machine

    return till_parameters_for_machine(db, machine).parameters


def _num(params: Dict[str, Any], key: str, default: float) -> float:
    value = params.get(key, default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _found(kind: str, key: str, occurred, **kw):
    from app.services.exceptions import Found

    details = dict(kw.pop("details", {}) or {})
    details.setdefault("source", "cash_drawer")
    return Found(type=kind, key=key[:200], occurred_at=occurred, details=details, **kw)


def detect_event(db, machine, event) -> List[Any]:
    """The exceptions one drawer event raises (written through the exceptions Detector)."""
    from app.models.cash_drawer import CashDrawerEvent
    from app.services.exceptions import Detector

    if event.category != "drawer" or event.training:
        return []
    detector = Detector(db)
    rules = detector.rules(machine)
    params = _params(db, machine)
    occurred = _utc(event.occurred_at)
    common = dict(
        pos_user_id=event.employee_id, shift_id=event.shift_id, till_event_id=event.id,
        transaction_id=event.sale_id,
    )
    base = {
        "eventType": event.event_type, "reason": event.reason, "reasonNote": event.reason_note,
        "approvedBy": event.approver_name, "approvedById": event.approver_id, "drawer": event.drawer_name,
        "employeeRole": event.employee_role,
    }
    out: List[Any] = []

    def on(kind: str) -> bool:
        rule = rules.get(kind)
        return bool(rule and rule.enabled)

    if event.result == "denied":
        if on("drawer_open_denied"):
            out.append(_found("drawer_open_denied", f"drawer_open_denied:{event.id}", occurred,
                              details={**base, "why": event.result_reason, "permission": event.permission},
                              **common))
    elif event.result == "approved":
        details = event.details if isinstance(event.details, dict) else {}
        manual = event.event_type in MANUAL_TYPES
        if (event.event_type == "AFTER_CLOSE" or details.get("afterClose")) and on("drawer_after_close"):
            out.append(_found("drawer_after_close", f"drawer_after_close:{event.id}", occurred,
                              amount=_money(event.amount), details=base, **common))
        if manual and on("drawer_open"):
            # The existing "פתיחת מגירה ללא מכירה" exception, now from the drawer audit.
            out.append(_found("drawer_open", f"drawer_open:{event.id}", occurred, details=base, **common))
        if manual and details.get("reasonRequired") and on("drawer_open_no_reason"):
            missing = not event.reason or event.reason == "NONE" or (
                event.reason == "OTHER" and details.get("noteRequired") and not (event.reason_note or "").strip()
            )
            if missing:
                out.append(_found("drawer_open_no_reason", f"drawer_open_no_reason:{event.id}", occurred,
                                  details=base, **common))
        if manual and event.employee_id:
            from datetime import timedelta

            q = db.query(CashDrawerEvent).filter(
                CashDrawerEvent.machine_id == event.machine_id,
                CashDrawerEvent.employee_id == event.employee_id,
                CashDrawerEvent.category == "drawer",
                CashDrawerEvent.result == "approved",
                CashDrawerEvent.event_type.in_(MANUAL_TYPES),
            )
            count_limit = int(_num(params, ALERT_OPENS_COUNT_KEY, 3))
            minutes = _num(params, ALERT_OPENS_MINUTES_KEY, 10)
            if count_limit > 0 and minutes > 0 and on("drawer_manual_burst"):
                since = occurred - timedelta(minutes=minutes)
                n = q.filter(CashDrawerEvent.occurred_at >= since, CashDrawerEvent.occurred_at <= occurred).count()
                if n >= count_limit:
                    out.append(_found("drawer_manual_burst", f"drawer_manual_burst:{event.id}", occurred,
                                      value=_money(n), threshold=_money(count_limit),
                                      details={**base, "opens": n, "withinMinutes": minutes}, **common))
            max_per_shift = int(_num(params, MAX_MANUAL_OPENS_KEY, 0))
            if max_per_shift > 0 and event.shift_id is not None and on("drawer_manual_over_max"):
                n = q.filter(CashDrawerEvent.shift_id == event.shift_id).count()
                if n > max_per_shift:
                    out.append(_found("drawer_manual_over_max", f"drawer_manual_over_max:{event.id}", occurred,
                                      value=_money(n), threshold=_money(max_per_shift),
                                      details={**base, "opens": n}, **common))
    for found in out:
        detector._record(machine, found)
    return out


def detect_movement(db, machine, movement) -> List[Any]:
    """Cash out over the alert amount; a count's variance, and manual openings near it."""
    from datetime import timedelta

    from app.models.cash_drawer import CashDrawerEvent
    from app.services.exceptions import Detector

    if movement.training:
        return []
    detector = Detector(db)
    rules = detector.rules(machine)
    params = _params(db, machine)
    occurred = _utc(movement.occurred_at)
    common = dict(pos_user_id=movement.employee_id, shift_id=movement.shift_id, till_event_id=movement.drawer_event_id)
    base = {"movementId": str(movement.id), "movementType": movement.movement_type, "reason": movement.reason,
            "approvedBy": movement.approver_name}
    out: List[Any] = []

    def on(kind: str) -> bool:
        rule = rules.get(kind)
        return bool(rule and rule.enabled)

    if movement.movement_type == "cash_out":
        limit = _num(params, CASH_OUT_ALERT_AMOUNT_KEY, 500)
        if limit > 0 and float(movement.amount or 0) > limit and on("cash_out_over_threshold"):
            out.append(_found("cash_out_over_threshold", f"cash_out_over_threshold:{movement.id}", occurred,
                              amount=_money(movement.amount), threshold=_money(limit), details=base, **common))
    if movement.movement_type == "count" and movement.variance is not None:
        limit = _num(params, VARIANCE_ALERT_AMOUNT_KEY, 50)
        variance = float(movement.variance)
        if limit > 0 and abs(variance) >= limit:
            if on("drawer_count_variance"):
                out.append(_found("drawer_count_variance", f"drawer_count_variance:{movement.id}", occurred,
                                  amount=_money(variance), value=_money(variance), threshold=_money(limit),
                                  details={**base, "counted": float(movement.amount),
                                           "expected": float(movement.expected_before or 0),
                                           "blind": bool(movement.blind)},
                                  severity="high" if variance < 0 else "medium", **common))
            minutes = _num(params, NEAR_VARIANCE_MINUTES_KEY, 60)
            if minutes > 0 and on("drawer_open_near_variance"):
                q = db.query(CashDrawerEvent).filter(
                    CashDrawerEvent.machine_id == movement.machine_id,
                    CashDrawerEvent.category == "drawer",
                    CashDrawerEvent.result == "approved",
                    CashDrawerEvent.event_type.in_(MANUAL_TYPES),
                    CashDrawerEvent.occurred_at >= occurred - timedelta(minutes=minutes),
                    CashDrawerEvent.occurred_at <= occurred,
                )
                if movement.shift_id is not None:
                    q = q.filter(CashDrawerEvent.shift_id == movement.shift_id)
                for opened in q.all():
                    out.append(_found(
                        "drawer_open_near_variance", f"drawer_open_near_variance:{opened.id}", _utc(opened.occurred_at),
                        value=_money(variance), threshold=_money(limit),
                        details={"source": "cash_drawer", "eventType": opened.event_type, "reason": opened.reason,
                                 "countMovementId": str(movement.id), "variance": variance,
                                 "minutesBeforeCount": round((occurred - _utc(opened.occurred_at)).total_seconds() / 60, 1)},
                        pos_user_id=opened.employee_id, shift_id=opened.shift_id, till_event_id=opened.id,
                    ))
    for found in out:
        detector._record(machine, found)
    return out


# ── Expected balance, KPIs, timeline (spec §8, §16) ───────────────────────────


def movement_sign(movement_type: str) -> int:
    """How a movement moves the expected balance: in +1, out / deposit −1, a count 0."""
    return {"cash_in": 1, "cash_out": -1, "deposit": -1}.get(movement_type, 0)


def expected_balance(opening, cash_sales, cash_refunds, cash_in, cash_out, deposits):
    """Spec §8: opening + cash sales + Cash In − cash refunds − Cash Out − deposits."""
    from decimal import Decimal

    d = lambda v: Decimal(str(v or 0))  # noqa: E731
    return d(opening) + d(cash_sales) + d(cash_in) - d(cash_refunds) - d(cash_out) - d(deposits)


def kpis(events: Sequence[Any], movements: Sequence[Any], exception_event_ids: Optional[set] = None) -> Dict[str, Any]:
    """The report's KPI tiles (spec §16) over the rows given."""
    from decimal import Decimal

    drawer = [e for e in events if e.category == "drawer"]
    approved = [e for e in drawer if e.result == "approved"]
    sums: Dict[str, Decimal] = {"cash_in": Decimal(0), "cash_out": Decimal(0), "deposit": Decimal(0)}
    counts: Dict[str, int] = {"cash_in": 0, "cash_out": 0, "deposit": 0, "count": 0}
    variance_total = Decimal(0)
    variances = 0
    for m in movements:
        counts[m.movement_type] = counts.get(m.movement_type, 0) + 1
        if m.movement_type in sums:
            sums[m.movement_type] += Decimal(str(m.amount or 0))
        if m.movement_type == "count" and m.variance is not None and Decimal(str(m.variance)) != 0:
            variances += 1
            variance_total += Decimal(str(m.variance))
    return {
        "openings": len(approved),
        "saleOpenings": sum(1 for e in approved if e.event_type == "CASH_SALE"),
        "manualOpenings": sum(1 for e in approved if e.event_type in MANUAL_TYPES),
        "cashInCount": counts["cash_in"],
        "cashIn": float(sums["cash_in"]),
        "cashOutCount": counts["cash_out"],
        "cashOut": float(sums["cash_out"]),
        "depositCount": counts["deposit"],
        "deposits": float(sums["deposit"]),
        "managerApprovals": sum(1 for e in events if e.approver_id and e.result == "approved"),
        "afterCloseOpenings": sum(1 for e in approved if e.event_type == "AFTER_CLOSE"),
        "blockedAttempts": sum(1 for e in drawer if e.result == "denied"),
        "failedOpenings": sum(1 for e in drawer if e.result == "failed"),
        "countVariances": variances,
        "countVarianceTotal": float(variance_total),
        "exceptions": len(exception_event_ids or ()),
    }


def event_out(e, labels: Optional[Dict[str, Any]] = None, exceptions: Optional[Dict[Any, List[str]]] = None) -> Dict[str, Any]:
    labels = labels or {}
    return {
        "id": str(e.id),
        "category": e.category,
        "eventType": e.event_type,
        "permission": e.permission,
        "decision": e.decision,
        "result": e.result,
        "resultReason": e.result_reason,
        "shopId": str(e.shop_id) if e.shop_id else None,
        "shopName": (labels.get("shops") or {}).get(e.shop_id),
        "machineId": str(e.machine_id),
        "machineName": getattr((labels.get("machines") or {}).get(e.machine_id), "name", None),
        "drawerName": e.drawer_name,
        "deviceId": e.device_id,
        "shiftId": str(e.shift_id) if e.shift_id else None,
        "employeeId": e.employee_id,
        "employeeName": e.employee_name,
        "employeeRole": e.employee_role,
        "approverId": e.approver_id,
        "approverName": e.approver_name,
        "tableId": e.table_id,
        "saleId": str(e.sale_id) if e.sale_id else None,
        "paymentId": e.payment_id,
        "originalSaleId": str(e.original_sale_id) if e.original_sale_id else None,
        "reason": e.reason,
        "reasonNote": e.reason_note,
        "movementId": str(e.movement_id) if e.movement_id else None,
        "cashMovementType": e.cash_movement_type,
        "amount": float(e.amount) if e.amount is not None else None,
        "expectedBalance": float(e.expected_balance) if e.expected_balance is not None else None,
        "offline": bool(e.offline),
        "occurredAt": _utc(e.occurred_at).isoformat() if e.occurred_at else None,
        "exceptions": (exceptions or {}).get(e.id, []),
    }


def movement_out(m, labels: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    labels = labels or {}
    return {
        "id": str(m.id),
        "type": m.movement_type,
        "amount": float(m.amount) if m.amount is not None else None,
        "expectedBefore": float(m.expected_before) if m.expected_before is not None else None,
        "expectedAfter": float(m.expected_after) if m.expected_after is not None else None,
        "variance": float(m.variance) if m.variance is not None else None,
        "blind": bool(m.blind),
        "reason": m.reason,
        "note": m.note,
        "source": m.source,
        "shopId": str(m.shop_id) if m.shop_id else None,
        "shopName": (labels.get("shops") or {}).get(m.shop_id),
        "machineId": str(m.machine_id),
        "machineName": getattr((labels.get("machines") or {}).get(m.machine_id), "name", None),
        "shiftId": str(m.shift_id) if m.shift_id else None,
        "employeeId": m.employee_id,
        "employeeName": m.employee_name,
        "approverId": m.approver_id,
        "approverName": m.approver_name,
        "drawerEventId": str(m.drawer_event_id) if m.drawer_event_id else None,
        "offline": bool(m.offline),
        "occurredAt": _utc(m.occurred_at).isoformat() if m.occurred_at else None,
    }