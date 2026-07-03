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
    # paho-mqtt 1.x tls_set() has no cadata=, so the PEM is written to a temp
    # file and passed via ca_certs=.
    client.tls_set.assert_called_once()
    kwargs = client.tls_set.call_args.kwargs
    assert kwargs["cert_reqs"] == ssl.CERT_REQUIRED
    assert kwargs["tls_version"] == ssl.PROTOCOL_TLS_CLIENT
    assert kwargs["ca_certs"].endswith(".crt")
    with open(kwargs["ca_certs"]) as fh:
        assert "BEGIN CERTIFICATE" in fh.read()


def test_resolve_ca_cert_path_relative_to_server_root() -> None:
    with patch("app.services.mqtt_broker.settings") as mock_settings:
        mock_settings.mqtt_tls_ca_cert_path = "./certs/emqxsl-ca.crt"
        resolved = _resolve_ca_cert_path()
    assert resolved == str((Path(__file__).resolve().parent.parent / "certs/emqxsl-ca.crt").resolve())


def _make_machine() -> MagicMock:
    machine = MagicMock()
    machine.id = "550e8400-e29b-41d4-a716-446655440000"
    machine.machine_code = "MACHINE-ABC12345"
    machine.tenant_id = None
    machine.shop_id = None
    machine.mqtt_client_id = "pos-abc123def456"
    return machine


def test_machine_mqtt_connection_info_uses_shared_broker_credentials() -> None:
    """EMQX authenticates against a single shared credential, so the POS must
    receive the shared broker login (with its own unique client id)."""
    machine = _make_machine()

    with patch("app.services.mqtt_broker.settings") as mock_settings:
        mock_settings.api_v1_prefix = "/api/v1"
        mock_settings.mqtt_broker_host = "broker.emqxsl.com"
        mock_settings.mqtt_broker_port = 8883
        mock_settings.mqtt_tls_enabled = True
        mock_settings.mqtt_broker_username = "pos-server"
        mock_settings.mqtt_broker_password = "broker-secret"
        payload = machine_mqtt_connection_info(machine=machine, access_token="jwt-token")

    assert payload["mqttBrokerUrl"] == "broker.emqxsl.com:8883"
    assert payload["mqttTls"] is True
    assert payload["mqttClientId"] == "pos-abc123def456"
    assert payload["mqttUsername"] == "pos-server"
    assert payload["mqttPassword"] == "broker-secret"
    # The machine JWT is still returned for HTTP sync auth.
    assert payload["accessToken"] == "jwt-token"


def test_machine_mqtt_connection_info_falls_back_to_per_machine_creds() -> None:
    """Anonymous local Mosquitto (no broker username) keeps per-machine creds."""
    machine = _make_machine()

    with patch("app.services.mqtt_broker.settings") as mock_settings:
        mock_settings.api_v1_prefix = "/api/v1"
        mock_settings.mqtt_broker_host = "localhost"
        mock_settings.mqtt_broker_port = 1883
        mock_settings.mqtt_tls_enabled = False
        mock_settings.mqtt_broker_username = ""
        mock_settings.mqtt_broker_password = ""
        payload = machine_mqtt_connection_info(machine=machine, access_token="jwt-token")

    assert payload["mqttUsername"] == "pos-abc123def456"
    assert payload["mqttPassword"] == "jwt-token"


def test_machine_mqtt_refresh_info_includes_shared_credentials() -> None:
    with patch("app.services.mqtt_broker.settings") as mock_settings:
        mock_settings.mqtt_broker_host = "broker.emqxsl.com"
        mock_settings.mqtt_broker_port = 8883
        mock_settings.mqtt_tls_enabled = True
        mock_settings.mqtt_broker_username = "pos-server"
        mock_settings.mqtt_broker_password = "broker-secret"
        info = machine_mqtt_refresh_info()

    assert info == {
        "mqttBrokerUrl": "broker.emqxsl.com:8883",
        "mqttTls": True,
        "mqttUsername": "pos-server",
        "mqttPassword": "broker-secret",
    }


def test_machine_mqtt_refresh_info_omits_credentials_when_anonymous() -> None:
    with patch("app.services.mqtt_broker.settings") as mock_settings:
        mock_settings.mqtt_broker_host = "localhost"
        mock_settings.mqtt_broker_port = 1883
        mock_settings.mqtt_tls_enabled = False
        mock_settings.mqtt_broker_username = ""
        mock_settings.mqtt_broker_password = ""
        info = machine_mqtt_refresh_info()

    assert info == {"mqttBrokerUrl": "localhost:1883", "mqttTls": False}
