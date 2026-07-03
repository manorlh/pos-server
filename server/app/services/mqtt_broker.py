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

    # EMQX Serverless authenticates against a single shared broker credential,
    # not per-machine username/password. Hand the POS the shared broker login
    # (with a unique per-machine client id, which the broker requires) so it can
    # actually connect. Fall back to per-machine creds only when no broker
    # username is configured (e.g. anonymous local Mosquitto in dev).
    if settings.mqtt_broker_username:
        mqtt_username = settings.mqtt_broker_username
        mqtt_password = settings.mqtt_broker_password
    else:
        mqtt_username = machine.mqtt_client_id
        mqtt_password = access_token

    return {
        "machineId": str(machine.id),
        "machineCode": machine.machine_code,
        "tenantId": str(machine.tenant_id) if machine.tenant_id else None,
        "shopId": str(machine.shop_id) if machine.shop_id else None,
        "accessToken": access_token,
        "mqttClientId": machine.mqtt_client_id,
        "mqttUsername": mqtt_username,
        "mqttPassword": mqtt_password,
        "apiUrl": prefix,
        "mqttBrokerUrl": mqtt_broker_url(),
        "mqttTls": settings.mqtt_tls_enabled,
    }


def machine_mqtt_refresh_info() -> Dict[str, Any]:
    """Broker endpoint + shared credentials for GET /machines/me so POS can
    refresh connection details (incl. auth) without re-pairing."""
    info: Dict[str, Any] = {
        "mqttBrokerUrl": mqtt_broker_url(),
        "mqttTls": settings.mqtt_tls_enabled,
    }
    if settings.mqtt_broker_username:
        info["mqttUsername"] = settings.mqtt_broker_username
        info["mqttPassword"] = settings.mqtt_broker_password
    return info
