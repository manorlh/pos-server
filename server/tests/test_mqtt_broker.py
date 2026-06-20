"""Tests for MQTT broker helpers (EMQX TLS, pairing payload)."""
import ssl
from pathlib import Path
from unittest.mock import MagicMock, patch

from app.services.mqtt_broker import (
    _resolve_ca_cert_path,
    apply_mqtt_tls,
    machine_mqtt_connection_info,
    machine_mqtt_refresh_info,
    mqtt_broker_url,
)


def test_mqtt_broker_url() -> None:
    with patch("app.services.mqtt_broker.settings") as mock_settings:
        mock_settings.mqtt_broker_host = "broker.emqxsl.com"
        mock_settings.mqtt_broker_port = 8883
        assert mqtt_broker_url() == "broker.emqxsl.com:8883"


def test_apply_mqtt_tls_skips_when_disabled() -> None:
    client = MagicMock()
    with patch("app.services.mqtt_broker.settings") as mock_settings:
        mock_settings.mqtt_tls_enabled = False
        apply_mqtt_tls(client)
    client.tls_set.assert_not_called()


def test_apply_mqtt_tls_uses_inline_ca() -> None:
    client = MagicMock()
    with patch("app.services.mqtt_broker.settings") as mock_settings:
        mock_settings.mqtt_tls_enabled = True
        mock_settings.mqtt_tls_ca_cert = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----"
        mock_settings.mqtt_tls_ca_cert_path = ""
        mock_settings.mqtt_broker_host = "broker.emqxsl.com"
        apply_mqtt_tls(client)
    client.tls_set.assert_called_once_with(
        cert_reqs=ssl.CERT_REQUIRED,
        tls_version=ssl.PROTOCOL_TLS_CLIENT,
        cadata="-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
    )


def test_resolve_ca_cert_path_relative_to_server_root() -> None:
    with patch("app.services.mqtt_broker.settings") as mock_settings:
        mock_settings.mqtt_tls_ca_cert_path = "./certs/emqxsl-ca.crt"
        resolved = _resolve_ca_cert_path()
    assert resolved == str((Path(__file__).resolve().parent.parent / "certs/emqxsl-ca.crt").resolve())


def test_machine_mqtt_connection_info_includes_tls_flag() -> None:
    machine = MagicMock()
    machine.id = "550e8400-e29b-41d4-a716-446655440000"
    machine.machine_code = "MACHINE-ABC12345"
    machine.tenant_id = None
    machine.shop_id = None
    machine.mqtt_client_id = "pos-abc123def456"

    with patch("app.services.mqtt_broker.settings") as mock_settings:
        mock_settings.api_v1_prefix = "/api/v1"
        mock_settings.mqtt_broker_host = "broker.emqxsl.com"
        mock_settings.mqtt_broker_port = 8883
        mock_settings.mqtt_tls_enabled = True
        payload = machine_mqtt_connection_info(machine=machine, access_token="jwt-token")

    assert payload["mqttBrokerUrl"] == "broker.emqxsl.com:8883"
    assert payload["mqttTls"] is True
    assert payload["mqttClientId"] == "pos-abc123def456"
    assert payload["mqttPassword"] == "jwt-token"
    assert payload["accessToken"] == "jwt-token"


def test_machine_mqtt_refresh_info() -> None:
    with patch("app.services.mqtt_broker.settings") as mock_settings:
        mock_settings.mqtt_broker_host = "broker.emqxsl.com"
        mock_settings.mqtt_broker_port = 8883
        mock_settings.mqtt_tls_enabled = True
        info = machine_mqtt_refresh_info()

    assert info == {"mqttBrokerUrl": "broker.emqxsl.com:8883", "mqttTls": True}
