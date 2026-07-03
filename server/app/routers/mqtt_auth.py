"""EMQX HTTP authentication endpoint (called by the broker, not by POS clients)."""
from __future__ import annotations

import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.services.mqtt_auth import evaluate_mqtt_http_auth

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/mqtt", tags=["mqtt"])


def _verify_emqx_callback_secret(x_mqtt_auth_secret: str | None) -> None:
    expected = (settings.mqtt_http_auth_secret or "").strip()
    if not expected:
        return
    if x_mqtt_auth_secret != expected:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


@router.post("/auth")
async def mqtt_http_auth(
    request: Request,
    db: Session = Depends(get_db),
    x_mqtt_auth_secret: str | None = Header(None, alias="X-MQTT-Auth-Secret"),
) -> Dict[str, str]:
    """
    EMQX HTTP authenticator/authorizer.

    Configure in EMQX Console → Access Control → Authentication (HTTP) and
    Authorization (HTTP), both pointing to this URL.

    POS connects with username=mqttClientId, password=machine JWT.
    """
    _verify_emqx_callback_secret(x_mqtt_auth_secret)
    try:
        body: Dict[str, Any] = await request.json()
    except Exception:
        body = {}

    allowed = evaluate_mqtt_http_auth(db, body)
    if not allowed:
        logger.info(
            "MQTT HTTP auth deny action=%s topic=%s username=%s",
            body.get("action"),
            body.get("topic"),
            body.get("username"),
        )
    return {"result": "allow" if allowed else "deny"}
