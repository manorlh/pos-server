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


def machine_mqtt_connection_info(
    *,
    machine: POSMachine,
    access_token: str,
    api_url_prefix: Optional[str] = None,
) -> Dict[str, Any]:
    """Credentials payload shared by legacy and mobile pairing flows."""
    prefix = api_url_prefix if api_url_prefix is not None else settings.api_v1_prefix
    return {
        "machineId": str(machine.id),
        "machineCode": machine.machine_code,
        "tenantId": str(machine.tenant_id) if machine.tenant_id else None,
        "shopId": str(machine.shop_id) if machine.shop_id else None,
        "accessToken": access_token,
        "mqttClientId": machine.mqtt_client_id,
        "mqttUsername": machine.mqtt_client_id,
        "mqttPassword": access_token,
        "apiUrl": prefix,
        "mqttBrokerUrl": mqtt_broker_url(),
        "mqttTls": settings.mqtt_tls_enabled,
    }


def machine_mqtt_refresh_info() -> Dict[str, Any]:
    """Broker endpoint for GET /machines/me so POS can refresh without re-pairing."""
    return {
        "mqttBrokerUrl": mqtt_broker_url(),
        "mqttTls": settings.mqtt_tls_enabled,
    }
