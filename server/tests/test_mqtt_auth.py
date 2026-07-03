"""Tests for EMQX HTTP MQTT auth (POS read-only, per-machine scope)."""
import uuid
from datetime import timedelta
from unittest.mock import MagicMock

import pytest

from app.services.auth import create_machine_token
from app.services.mqtt_auth import evaluate_mqtt_http_auth, machine_mqtt_topic_prefix


def _machine(*, machine_id: uuid.UUID, tenant_id: uuid.UUID, client_id: str = "pos-test-client"):
    m = MagicMock()
    m.id = machine_id
    m.tenant_id = tenant_id
    m.mqtt_client_id = client_id
    m.is_active = True
    return m


def test_machine_mqtt_topic_prefix() -> None:
    tid = uuid.uuid4()
    mid = uuid.uuid4()
    m = _machine(machine_id=mid, tenant_id=tid)
    assert machine_mqtt_topic_prefix(m) == f"pos/{tid}/{mid}/"


def test_mqtt_auth_allows_connect_with_valid_machine_jwt() -> None:
    mid = uuid.uuid4()
    tid = uuid.uuid4()
    machine = _machine(machine_id=mid, tenant_id=tid)
    token = create_machine_token(str(mid))

    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = machine

    assert evaluate_mqtt_http_auth(
        db,
        {"username": "pos-test-client", "password": token, "action": ""},
    )


def test_mqtt_auth_denies_publish() -> None:
    mid = uuid.uuid4()
    tid = uuid.uuid4()
    machine = _machine(machine_id=mid, tenant_id=tid)
    token = create_machine_token(str(mid))
    topic = f"pos/{tid}/{mid}/catalog/notify"

    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = machine

    assert not evaluate_mqtt_http_auth(
        db,
        {"username": "pos-test-client", "password": token, "action": "publish", "topic": topic},
    )


def test_mqtt_auth_allows_subscribe_on_own_topic() -> None:
    mid = uuid.uuid4()
    tid = uuid.uuid4()
    machine = _machine(machine_id=mid, tenant_id=tid)
    token = create_machine_token(str(mid))
    topic = f"pos/{tid}/{mid}/catalog/notify"

    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = machine

    assert evaluate_mqtt_http_auth(
        db,
        {"username": "pos-test-client", "password": token, "action": "subscribe", "topic": topic},
    )


def test_mqtt_auth_denies_subscribe_on_other_machine_topic() -> None:
    mid = uuid.uuid4()
    tid = uuid.uuid4()
    other_mid = uuid.uuid4()
    machine = _machine(machine_id=mid, tenant_id=tid)
    token = create_machine_token(str(mid))
    topic = f"pos/{tid}/{other_mid}/catalog/notify"

    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = machine

    assert not evaluate_mqtt_http_auth(
        db,
        {"username": "pos-test-client", "password": token, "action": "subscribe", "topic": topic},
    )


def test_mqtt_auth_denies_wrong_username() -> None:
    mid = uuid.uuid4()
    tid = uuid.uuid4()
    machine = _machine(machine_id=mid, tenant_id=tid)
    token = create_machine_token(str(mid))

    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = machine

    assert not evaluate_mqtt_http_auth(
        db,
        {"username": "wrong-client", "password": token, "action": "subscribe", "topic": f"pos/{tid}/{mid}/x"},
    )
