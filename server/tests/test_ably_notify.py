"""Tests for Ably notify helpers."""
import uuid
from unittest.mock import MagicMock, patch

from app.services.ably_notify import machine_channel, machine_channel_for, publish_catalog_notify
from app.services.realtime_info import machine_realtime_connection_info


def _machine():
    m = MagicMock()
    m.id = uuid.UUID("550e8400-e29b-41d4-a716-446655440000")
    m.machine_code = "MACHINE-ABC12345"
    m.tenant_id = uuid.UUID("9cdc666e-84d6-4bf4-84b6-b0c9b4f6534c")
    m.shop_id = None
    m.mqtt_client_id = "pos-abc123def456"
    return m


def test_machine_channel() -> None:
    tid = "9cdc666e-84d6-4bf4-84b6-b0c9b4f6534c"
    mid = "550e8400-e29b-41d4-a716-446655440000"
    assert machine_channel(tid, mid) == f"pos:{tid}:{mid}"


def test_machine_channel_for() -> None:
    m = _machine()
    assert machine_channel_for(m) == (
        f"pos:{m.tenant_id}:{m.id}"
    )


def test_machine_realtime_connection_info() -> None:
    m = _machine()
    with patch("app.services.realtime_info.settings") as s:
        s.api_v1_prefix = "/api/v1"
        payload = machine_realtime_connection_info(machine=m, access_token="jwt-token")

    assert payload["accessToken"] == "jwt-token"
    assert payload["realtimeChannel"] == f"pos:{m.tenant_id}:{m.id}"
    assert payload["ablyAuthUrl"] == "/api/v1/machines/me/ably-auth"
    assert payload["mqttClientId"] == "pos-abc123def456"


def test_publish_catalog_notify_noop_when_disabled() -> None:
    with patch("app.services.ably_notify.is_enabled", return_value=False):
        publish_catalog_notify("t", "m", reason="test")
