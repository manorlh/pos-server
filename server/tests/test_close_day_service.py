"""Close-day orchestration unit tests."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.models.close_day import CloseDayItemStatus, CloseDayRequest, CloseDayRequestItem, CloseDayRequestStatus
from app.models.user import UserRole
from app.services.close_day import (
    apply_close_day_ack,
    get_pending_close_day_machine_ids,
    machine_is_mqtt_online,
    resolve_machines_for_close_day,
)


def _now() -> datetime:
    return datetime(2026, 6, 30, 12, 0, tzinfo=timezone.utc)


def test_machine_is_mqtt_online_within_window() -> None:
    machine = MagicMock()
    machine.last_heartbeat_at = _now()
    assert machine_is_mqtt_online(machine, _now()) is True


def test_machine_is_mqtt_offline_when_stale() -> None:
    machine = MagicMock()
    machine.last_heartbeat_at = datetime(2026, 6, 30, 11, 0, tzinfo=timezone.utc)
    assert machine_is_mqtt_online(machine, _now()) is False


def test_resolve_machines_requires_scope() -> None:
    db = MagicMock()
    user = MagicMock(role=UserRole.COMPANY_MANAGER, company_id=uuid.uuid4(), shop_id=None)
    with pytest.raises(HTTPException) as exc:
        resolve_machines_for_close_day(db, user, uuid.uuid4())
    assert exc.value.status_code == 400


def test_apply_close_day_ack_received() -> None:
    machine = MagicMock()
    machine.id = uuid.uuid4()
    machine.tenant_id = uuid.uuid4()

    item = CloseDayRequestItem(
        id=uuid.uuid4(),
        request_id=uuid.uuid4(),
        machine_id=machine.id,
        status=CloseDayItemStatus.SENT,
    )
    request = CloseDayRequest(
        id=item.request_id,
        tenant_id=machine.tenant_id,
        initiated_by_user_id=uuid.uuid4(),
        status=CloseDayRequestStatus.IN_PROGRESS,
    )
    request.items = [item]

    db = MagicMock()
    query = MagicMock()
    query.join.return_value = query
    query.filter.return_value = query
    query.first.side_effect = [item, request]
    db.query.return_value = query
    db.flush = MagicMock()
    db.commit = MagicMock()
    db.refresh = MagicMock()

    updated = apply_close_day_ack(
        db,
        machine,
        request_id=item.request_id,
        phase="received",
    )
    assert updated.status == CloseDayItemStatus.RECEIVED
    assert updated.received_at is not None


def test_get_pending_close_day_machine_ids_empty() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = []
    assert get_pending_close_day_machine_ids(db, [uuid.uuid4()]) == set()
