"""EMQX HTTP authentication/authorization for POS machines (read-only, scoped)."""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.services.auth import decode_jwt_payload

logger = logging.getLogger(__name__)


def machine_mqtt_topic_prefix(machine: POSMachine) -> Optional[str]:
    """Topic prefix this machine may subscribe to: pos/{tenant}/{machine}/"""
    if not machine.tenant_id:
        return None
    return f"pos/{machine.tenant_id}/{machine.id}/"


def _machine_from_mqtt_credentials(
    db: Session,
    *,
    username: str,
    password: str,
) -> Optional[POSMachine]:
    """Validate machine JWT password and optional mqtt_client_id username."""
    payload = decode_jwt_payload(password)
    if not payload or payload.get("type") != "machine" or not payload.get("sub"):
        return None
    try:
        machine_id = uuid.UUID(str(payload["sub"]))
    except ValueError:
        return None
    machine = db.query(POSMachine).filter(POSMachine.id == machine_id).first()
    if not machine or not machine.is_active:
        return None
    if username and machine.mqtt_client_id and username != machine.mqtt_client_id:
        return None
    return machine


def evaluate_mqtt_http_auth(
    db: Session,
    body: Dict[str, Any],
) -> bool:
    """
    EMQX HTTP authenticator/authorizer callback.

    POS machines are read-only: deny all publish, allow subscribe only on their
  own topic prefix pos/{tenant}/{machine}/#.
    """
    username = str(body.get("username") or "")
    password = str(body.get("password") or "")
    action = str(body.get("action") or "").lower().strip()
    topic = str(body.get("topic") or "").strip()

    machine = _machine_from_mqtt_credentials(db, username=username, password=password)
    if not machine:
        logger.debug("MQTT auth denied: invalid credentials for username=%s", username)
        return False

    # Publish is never allowed for POS machine clients.
    if action in ("publish", "pub"):
        logger.debug("MQTT auth denied publish for machine %s topic=%s", machine.id, topic)
        return False

    if action in ("subscribe", "sub"):
        if not topic:
            return False
        prefix = machine_mqtt_topic_prefix(machine)
        if not prefix or not topic.startswith(prefix):
            logger.debug(
                "MQTT auth denied subscribe for machine %s topic=%s (prefix=%s)",
                machine.id,
                topic,
                prefix,
            )
            return False
        return True

    # Connect / authentication request (no action or unknown action without topic).
    if not action or action in ("all", "connect", "login"):
        return True

    # Unknown action with a topic — deny by default.
    if topic:
        return False

    return True
