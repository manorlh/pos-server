"""
Till parameters from the dashboard ("פרמטרים לקופות") — super admin only.

GET    /till-parameters                          → every definition, with its value count
POST   /till-parameters                          → define one
PUT    /till-parameters/{id}                     → change one (partial)
DELETE /till-parameters/{id}                     → remove it and all its values
GET    /till-parameters/{id}/values              → its values per level, with names
PUT    /till-parameters/{id}/values              → set the value at one level (upsert)
DELETE /till-parameters/{id}/values/{value_id}   → remove one level's value

Every write tells the tills it may change what they get (Ably `settings` notify,
reason `till_parameters_updated`) after the commit: all active tills for a definition,
the tills under the level for a value. The tills then pull `/sync/{id}/parameters`.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_super_admin
from app.models.till_parameter import TillParameter, TillParameterValue
from app.models.user import User
from app.schemas.till_parameter import (
    TillParameterCreate,
    TillParameterOut,
    TillParameterUpdate,
    TillParameterValueIn,
    TillParameterValueOut,
)
from app.services import terminal_check_bypass as TCB
from app.services import till_parameter_audit as AUDIT
from app.services import till_parameters as TP

router = APIRouter(tags=["till-parameters"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _refuse_restricted(key: str, user: User) -> None:
    """
    "רק בעלים ומנהלים": a restricted parameter (`terminalNumberCheckBypass`) is changed by the
    owner and managers only — `403 till_parameter_restricted` for anyone else, whatever route
    lets them in (app/services/terminal_check_bypass.py).
    """
    if not TCB.may_change(key, user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="till_parameter_restricted")


def _parameter(db: Session, parameter_id: uuid.UUID) -> TillParameter:
    parameter = db.query(TillParameter).filter(TillParameter.id == parameter_id).first()
    if parameter is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Till parameter not found")
    return parameter


def _refuse_taken_key(db: Session, key: str, own_id=None) -> None:
    """One parameter per key, whatever its case — `vatRate` and `VATRate` would confuse."""
    query = db.query(TillParameter).filter(func.lower(TillParameter.key) == key.lower())
    if own_id is not None:
        query = query.filter(TillParameter.id != own_id)
    if query.first() is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="till_parameter_key_taken")


def _out(parameter: TillParameter, value_count: int = 0) -> TillParameterOut:
    return TillParameterOut(
        id=parameter.id,
        key=parameter.key,
        label=parameter.label,
        description=parameter.description,
        value_type=parameter.value_type,
        enum_options=parameter.enum_options,
        default_value=parameter.default_value,
        is_active=bool(parameter.is_active),
        value_count=value_count,
        widget=TP.parameter_widget(parameter.key, parameter.value_type),
        image_kind=TP.image_kind(parameter.key, parameter.value_type),
        managed_on=TP.managed_on(parameter.key),
        created_at=parameter.created_at,
        updated_at=parameter.updated_at,
    )


def _value_count(db: Session, parameter_id) -> int:
    return (
        db.query(func.count(TillParameterValue.id))
        .filter(TillParameterValue.parameter_id == parameter_id)
        .scalar()
        or 0
    )


# ── Definitions ──────────────────────────────────────────────────────────────


@router.get(
    "/till-parameters",
    response_model=List[TillParameterOut],
    response_model_by_alias=True,
)
def list_till_parameters(
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """Every parameter by key, each with how many levels set a value for it."""
    counts = dict(
        db.query(TillParameterValue.parameter_id, func.count(TillParameterValue.id))
        .group_by(TillParameterValue.parameter_id)
        .all()
    )
    parameters = db.query(TillParameter).order_by(TillParameter.key).all()
    return [_out(p, counts.get(p.id, 0)) for p in parameters]


@router.post(
    "/till-parameters",
    response_model=TillParameterOut,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
def create_till_parameter(
    body: TillParameterCreate,
    background_tasks: BackgroundTasks,
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """`409 till_parameter_key_taken` when the key exists in any case."""
    _refuse_taken_key(db, body.key)
    if body.default_value is not None and TP.image_kind(body.key, body.value_type):
        try:
            body.default_value = TP.validate_image_url(body.default_value)
        except TP.TillParameterValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"defaultValue: {exc}"
            ) from exc
    now = _now()
    parameter = TillParameter(
        id=uuid.uuid4(),
        key=body.key,
        label=body.label,
        description=body.description,
        value_type=body.value_type,
        enum_options=body.enum_options,
        default_value=body.default_value,
        is_active=body.is_active,
        created_at=now,
        updated_at=now,
    )
    db.add(parameter)
    db.commit()
    db.refresh(parameter)
    # A new parameter only reaches a till through its default; without one, and
    # inactive, nobody's parameters changed.
    if parameter.is_active and parameter.default_value is not None:
        background_tasks.add_task(TP.publish_parameters_notify, TP.notify_targets_for_all(db))
    return _out(parameter)


@router.put(
    "/till-parameters/{parameter_id}",
    response_model=TillParameterOut,
    response_model_by_alias=True,
)
def update_till_parameter(
    parameter_id: uuid.UUID,
    body: TillParameterUpdate,
    background_tasks: BackgroundTasks,
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """
    Partial update, validated as a whole: a new type or option list must still accept
    the default (`422`) and every value already set (`409 till_parameter_values_incompatible`
    — remove or change those first).
    """
    parameter = _parameter(db, parameter_id)
    _refuse_restricted(parameter.key, _admin)
    sent = body.model_fields_set

    key = body.key if "key" in sent and body.key is not None else parameter.key
    _refuse_restricted(key, _admin)
    label = body.label if "label" in sent and body.label is not None else parameter.label
    description = body.description if "description" in sent else parameter.description
    value_type = (
        body.value_type if "value_type" in sent and body.value_type is not None else parameter.value_type
    )
    is_active = (
        body.is_active if "is_active" in sent and body.is_active is not None else parameter.is_active
    )
    raw_options = body.enum_options if "enum_options" in sent else parameter.enum_options
    if value_type != "enum" and "enum_options" not in sent:
        # Switching away from an enum drops its options rather than refusing the change.
        raw_options = None
    default_value = body.default_value if "default_value" in sent else parameter.default_value

    try:
        enum_options = TP.clean_enum_options(value_type, raw_options)
        if default_value is not None:
            default_value = TP.validate_value(value_type, default_value, enum_options)
            if TP.image_kind(key, value_type):
                default_value = TP.validate_image_url(default_value)
            # "שעת סיום יום עסקי": its default too is a whole hour 0–12 (app/services/business_day.py).
            if key == "businessDayEndHour":
                default_value = TP.validate_keyed_value(key, default_value)
    except TP.TillParameterValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    if key.lower() != parameter.key.lower():
        _refuse_taken_key(db, key, own_id=parameter.id)

    values = db.query(TillParameterValue).filter(TillParameterValue.parameter_id == parameter.id).all()
    if value_type != parameter.value_type or enum_options != parameter.enum_options:
        if TP.incompatible_values(value_type, enum_options, values):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="till_parameter_values_incompatible"
            )

    # The change log: what reaches the tills — the default and the activation.
    if default_value != parameter.default_value:
        AUDIT.record_change(
            db, parameter=parameter, scope_type=AUDIT.DEFINITION_SCOPE, scope_id=None,
            action=AUDIT.DEFAULT, old_value=parameter.default_value, new_value=default_value, user=_admin,
        )
    if bool(is_active) != bool(parameter.is_active):
        AUDIT.record_change(
            db, parameter=parameter, scope_type=AUDIT.DEFINITION_SCOPE, scope_id=None,
            action=AUDIT.ACTIVE, old_value=bool(parameter.is_active), new_value=bool(is_active), user=_admin,
        )
    parameter.key = key
    parameter.label = label
    parameter.description = description
    parameter.value_type = value_type
    parameter.enum_options = enum_options
    parameter.default_value = default_value
    parameter.is_active = is_active
    parameter.updated_at = _now()
    db.commit()
    db.refresh(parameter)
    background_tasks.add_task(TP.publish_parameters_notify, TP.notify_targets_for_all(db))
    return _out(parameter, len(values))


@router.delete("/till-parameters/{parameter_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_till_parameter(
    parameter_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """Removes the parameter and every value set for it; the tills drop the key."""
    parameter = _parameter(db, parameter_id)
    _refuse_restricted(parameter.key, _admin)
    AUDIT.record_change(
        db, parameter=parameter, scope_type=AUDIT.DEFINITION_SCOPE, scope_id=None,
        action=AUDIT.DELETED, old_value=parameter.default_value, new_value=None, user=_admin,
    )
    # Explicit rather than trusting ON DELETE CASCADE alone, so the ORM session holds
    # no stale value rows either.
    db.query(TillParameterValue).filter(TillParameterValue.parameter_id == parameter.id).delete(
        synchronize_session=False
    )
    db.delete(parameter)
    db.commit()
    background_tasks.add_task(TP.publish_parameters_notify, TP.notify_targets_for_all(db))
    return None


# ── Values per level ─────────────────────────────────────────────────────────


def _value_out(value: TillParameterValue, label) -> TillParameterValueOut:
    return TillParameterValueOut(
        id=value.id,
        parameter_id=value.parameter_id,
        scope_type=value.scope_type,
        scope_id=value.scope_id,
        scope_name=label.name if label else None,
        scope_context=label.context if label else None,
        value=value.value,
        updated_at=value.updated_at,
    )


_SCOPE_ORDER = {"company": 0, "shop": 1, "area": 2, "machine": 3}


@router.get(
    "/till-parameters/{parameter_id}/values",
    response_model=List[TillParameterValueOut],
    response_model_by_alias=True,
)
def list_till_parameter_values(
    parameter_id: uuid.UUID,
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """
    Every level that sets this parameter, least specific first, with the entity's name.
    Across all tenants: definitions are global and so is the super admin's view.
    """
    parameter = _parameter(db, parameter_id)
    values = db.query(TillParameterValue).filter(TillParameterValue.parameter_id == parameter.id).all()
    labels = TP.scope_labels(db, values)
    rows = [_value_out(v, labels.get((v.scope_type, TP.as_uuid(v.scope_id)))) for v in values]
    rows.sort(key=lambda r: (_SCOPE_ORDER.get(r.scope_type, 9), r.scope_context or "", r.scope_name or ""))
    return rows


@router.get("/till-parameters/{parameter_id}/changes")
def list_till_parameter_changes(
    parameter_id: uuid.UUID,
    limit: int = 100,
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """
    The parameter's change log, newest first (app/services/till_parameter_audit.py): who, when,
    which level (with its name), the action and the values before and after.
    """
    parameter = _parameter(db, parameter_id)
    rows = AUDIT.changes_for(db, parameter.key, limit)
    on_levels = [r for r in rows if r.scope_id is not None and r.scope_type in _SCOPE_ORDER]
    labels = TP.scope_labels(db, on_levels) if on_levels else {}
    out = []
    for r in rows:
        item = AUDIT.as_json(r)
        label = labels.get((r.scope_type, TP.as_uuid(r.scope_id))) if r.scope_id is not None else None
        item["scopeName"] = label.name if label else None
        item["scopeContext"] = label.context if label else None
        out.append(item)
    return out


def _producer_guard(db: Session, parameter: TillParameter, scope_type: str, scope_id):
    """
    A value of a parameter that decides a shop's Z producer (local mode, the main till):
    the producers of the shops it speaks for, pinned before the change
    (docs/SPEC_INDEPENDENT_TILL.md §8.10). None for any other parameter.
    """
    from app.services import local_shop_z as LZ

    if parameter.key not in LZ.PRODUCER_KEYS:
        return None
    return LZ.ProducerGuard(db, LZ.shops_for_scope(db, scope_type, scope_id))


def _check_producer(db: Session, guard, user: User):
    """The 409 to answer (rolled back) when the change would move a producer that is busy."""
    from fastapi.responses import JSONResponse

    from app.services import local_shop_z as LZ

    if guard is None:
        return None
    try:
        guard.check(user=user)
    except LZ.LocalShopZRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    return None


@router.put(
    "/till-parameters/{parameter_id}/values",
    response_model=TillParameterValueOut,
    response_model_by_alias=True,
)
def set_till_parameter_value(
    parameter_id: uuid.UUID,
    body: TillParameterValueIn,
    background_tasks: BackgroundTasks,
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """Set (or replace) the value at one level. `404` when that entity does not exist."""
    parameter = _parameter(db, parameter_id)
    _refuse_restricted(parameter.key, _admin)
    try:
        value = TP.validate_value(parameter.value_type, body.value, parameter.enum_options)
        if TP.image_kind(parameter.key, parameter.value_type):
            value = TP.validate_image_url(value)
        # "קוד טכנאי לקיוסק": digits only, 4–8 (app/services/kiosk_technician.py).
        value = TP.validate_keyed_value(parameter.key, value)
    except TP.TillParameterValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    if TP.scope_entity(db, body.scope_type, body.scope_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"{body.scope_type}_not_found"
        )
    guard = _producer_guard(db, parameter, body.scope_type, body.scope_id)

    row = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id == parameter.id,
            TillParameterValue.scope_type == body.scope_type,
            TillParameterValue.scope_id == body.scope_id,
        )
        .first()
    )
    now = _now()
    previous = None if row is None else row.value
    if row is None or previous != value or type(previous) is not type(value):
        # The change log (who, when, which level, from what to what) — in this transaction.
        AUDIT.record_change(
            db, parameter=parameter, scope_type=body.scope_type, scope_id=body.scope_id,
            action=AUDIT.SET, old_value=previous, new_value=value, user=_admin, now=now,
        )
    if row is None:
        row = TillParameterValue(
            id=uuid.uuid4(),
            parameter_id=parameter.id,
            scope_type=body.scope_type,
            scope_id=body.scope_id,
            value=value,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
    else:
        row.value = value
        row.updated_at = now
    refused = _check_producer(db, guard, _admin)
    if refused is not None:
        return refused
    db.commit()
    db.refresh(row)
    if parameter.is_active:
        background_tasks.add_task(
            TP.publish_parameters_notify, TP.notify_targets_for_scope(db, row.scope_type, row.scope_id)
        )
    labels = TP.scope_labels(db, [row])
    return _value_out(row, labels.get((row.scope_type, TP.as_uuid(row.scope_id))))


@router.delete(
    "/till-parameters/{parameter_id}/values/{value_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_till_parameter_value(
    parameter_id: uuid.UUID,
    value_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """The level falls back to the next one up. Touches the parameter's watermark."""
    parameter = _parameter(db, parameter_id)
    _refuse_restricted(parameter.key, _admin)
    row = (
        db.query(TillParameterValue)
        .filter(TillParameterValue.id == value_id, TillParameterValue.parameter_id == parameter.id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Value not found")
    scope_type, scope_id = row.scope_type, row.scope_id
    guard = _producer_guard(db, parameter, scope_type, scope_id)
    AUDIT.record_change(
        db, parameter=parameter, scope_type=scope_type, scope_id=scope_id,
        action=AUDIT.CLEAR, old_value=row.value, new_value=None, user=_admin,
    )
    db.delete(row)
    # The row that carried the till's newest stamp may be the one going; moving the
    # parameter's own stamp keeps the tills' watermark from going backwards.
    parameter.updated_at = _now()
    refused = _check_producer(db, guard, _admin)
    if refused is not None:
        return refused
    db.commit()
    if parameter.is_active:
        background_tasks.add_task(
            TP.publish_parameters_notify, TP.notify_targets_for_scope(db, scope_type, scope_id)
        )
    return None
