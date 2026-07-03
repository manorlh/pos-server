"""MQTT broker connection helpers (local Mosquitto, EMQX Cloud, etc.)."""
from __future__ import annotations

import logging
import ssl
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

import paho.mqtt.client as mqtt

from app.config import get_settings
from app.models.pos_machine import POSMachine
from app.services.mqtt_auth import machine_mqtt_topic_prefix

logger = logging.getLogger(__name__)
settings = get_settings()

# server/ directory (parent of app/)
_SERVER_ROOT = Path(__file__).resolve().parent.parent.parent


def mqtt_broker_url() -> str:
    return f"{settings.mqtt_broker_host}:{settings.mqtt_broker_port}"


def _resolve_ca_cert_path() -> Optional[str]:
    raw = (settings.mqtt_tls_ca_cert_path or "").strip()
    if not raw:
        return None
    path = Path(raw)
    if not path.is_absolute():
        path = (_SERVER_ROOT / path).resolve()
    return str(path)


def apply_mqtt_tls(client: mqtt.Client) -> None:
    """Enable TLS when MQTT_TLS_ENABLED=true (required for EMQX Serverless on port 8883)."""
    if not settings.mqtt_tls_enabled:
        return

    tls_kwargs: dict = {
        "cert_reqs": ssl.CERT_REQUIRED,
        "tls_version": ssl.PROTOCOL_TLS_CLIENT,
    }
    if settings.mqtt_tls_ca_cert:
        # paho-mqtt 1.x tls_set() has no cadata= — write PEM to a temp file.
        with tempfile.NamedTemporaryFile(mode="w", suffix=".crt", delete=False) as ca_file:
            ca_file.write(settings.mqtt_tls_ca_cert.strip())
            ca_file.write("\n")
            tls_kwargs["ca_certs"] = ca_file.name
    else:
        ca_path = _resolve_ca_cert_path()
        if ca_path:
            tls_kwargs["ca_certs"] = ca_path
        else:
            logger.warning(
                "MQTT_TLS_ENABLED is true but no CA cert is configured; "
                "set MQTT_TLS_CA_CERT or MQTT_TLS_CA_CERT_PATH (download from EMQX Console → Overview)"
            )

    client.tls_set(**tls_kwargs)


def _pos_mqtt_credentials(
    *,
    machine: POSMachine,
    access_token: str,
) -> tuple[str, str]:
    """
    Credentials the POS desktop uses to connect to the broker.

    machine_jwt (default): username=mqtt_client_id, password=machine JWT.
      Requires EMQX HTTP auth pointing at POST /api/v1/mqtt/auth — subscribe-only,
      scoped to pos/{tenant}/{machine}/#.

    shared: legacy single broker login when mqtt_pos_auth_mode=shared and
      MQTT_BROKER_USERNAME is set (no per-device topic isolation).
    """
    mode = (settings.mqtt_pos_auth_mode or "machine_jwt").strip().lower()
    if mode == "shared" and settings.mqtt_broker_username:
        return settings.mqtt_broker_username, settings.mqtt_broker_password
    return machine.mqtt_client_id, access_token


def machine_mqtt_connection_info(
    *,
    machine: POSMachine,
    access_token: str,
    api_url_prefix: Optional[str] = None,
) -> Dict[str, Any]:
    """Credentials payload shared by legacy and mobile pairing flows."""
    prefix = api_url_prefix if api_url_prefix is not None else settings.api_v1_prefix
    mqtt_username, mqtt_password = _pos_mqtt_credentials(machine=machine, access_token=access_token)
    topic_prefix = machine_mqtt_topic_prefix(machine)

    return {
        "machineId": str(machine.id),
        "machineCode": machine.machine_code,
        "tenantId": str(machine.tenant_id) if machine.tenant_id else None,
        "shopId": str(machine.shop_id) if machine.shop_id else None,
        "accessToken": access_token,
        "mqttClientId": machine.mqtt_client_id,
        "mqttUsername": mqtt_username,
        "mqttPassword": mqtt_password,
        "mqttTopicPrefix": topic_prefix,
        "apiUrl": prefix,
        "mqttBrokerUrl": mqtt_broker_url(),
        "mqttTls": settings.mqtt_tls_enabled,
    }


def machine_mqtt_refresh_info(
    *,
    machine: Optional[POSMachine] = None,
    access_token: Optional[str] = None,
) -> Dict[str, Any]:
    """Broker endpoint for GET /machines/me so POS can refresh without re-pairing."""
    info: Dict[str, Any] = {
        "mqttBrokerUrl": mqtt_broker_url(),
        "mqttTls": settings.mqtt_tls_enabled,
    }
    if machine is not None and access_token:
        mqtt_username, mqtt_password = _pos_mqtt_credentials(
            machine=machine,
            access_token=access_token,
        )
        info["mqttUsername"] = mqtt_username
        info["mqttPassword"] = mqtt_password
        topic_prefix = machine_mqtt_topic_prefix(machine)
        if topic_prefix:
            info["mqttTopicPrefix"] = topic_prefix
    elif (settings.mqtt_pos_auth_mode or "").strip().lower() == "shared" and settings.mqtt_broker_username:
        info["mqttUsername"] = settings.mqtt_broker_username
        info["mqttPassword"] = settings.mqtt_broker_password
    return info
