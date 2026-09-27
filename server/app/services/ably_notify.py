"""Ably realtime notify — lightweight wake-ups for POS (data via HTTP pull)."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from app.config import get_settings
from app.models.pos_machine import POSMachine

logger = logging.getLogger(__name__)
settings = get_settings()

_ably_rest = None


def is_enabled() -> bool:
    return bool((settings.ably_api_key or "").strip())


def _rest():
    global _ably_rest
    if not is_enabled():
        return None
    if _ably_rest is None:
        from ably.sync import AblyRestSync

        _ably_rest = AblyRestSync(settings.ably_api_key.strip())
    return _ably_rest


def machine_channel(tenant_id: str, machine_id: str) -> str:
    return f"pos:{tenant_id}:{machine_id}"


def machine_channel_for(machine: POSMachine) -> Optional[str]:
    if not machine.tenant_id:
        return None
    return machine_channel(str(machine.tenant_id), str(machine.id))


def _notify_base() -> dict[str, Any]:
    return {"serverTime": datetime.now(timezone.utc).isoformat()}


def publish_notify(
    tenant_id: str,
    machine_id: str,
    event: str,
    body: dict[str, Any],
) -> None:
    client = _rest()
    if not client:
        logger.warning("Ably not configured — skip notify %s for machine %s", event, machine_id)
        return
    channel_name = machine_channel(tenant_id, machine_id)
    try:
        client.channels.get(channel_name).publish(event, body)
        logger.debug("Ably → %s event=%s", channel_name, event)
    except Exception as exc:
        logger.error("Ably publish failed channel=%s event=%s: %s", channel_name, event, exc)


def publish_catalog_notify(
    tenant_id: str,
    machine_id: str,
    *,
    reason: str = "catalog_changed",
    hint: Optional[str] = None,
) -> None:
    body = _notify_base()
    body["reason"] = reason
    if hint:
        body["hint"] = hint
    publish_notify(tenant_id, machine_id, "catalog", body)


def publish_pos_users_notify(
    tenant_id: str,
    machine_id: str,
    *,
    reason: str = "pos_users_changed",
    hint: Optional[str] = None,
) -> None:
    body = _notify_base()
    body["reason"] = reason
    if hint:
        body["hint"] = hint
    publish_notify(tenant_id, machine_id, "pos-users", body)


def publish_settings_notify(
    tenant_id: str,
    machine_id: str,
    *,
    reason: str = "settings_changed",
    hint: Optional[str] = None,
) -> None:
    body = _notify_base()
    body["reason"] = reason
    if hint:
        body["hint"] = hint
    publish_notify(tenant_id, machine_id, "settings", body)


def publish_close_shift_notify(
    tenant_id: str,
    machine_id: str,
    request_id: str,
    shift_id: Optional[str],
    initiated_by: str,
) -> None:
    """
    Ask a till to close its open shift so a Z can include it (docs/SHIFTS_API.md §1.7).

    The fast path only. The same instruction is handed over by the heartbeat, so a till
    that misses this still closes on its next beat.
    """
    body = _notify_base()
    body["requestId"] = request_id
    body["shiftId"] = shift_id
    body["initiatedBy"] = initiated_by
    publish_notify(tenant_id, machine_id, "close-shift", body)


def publish_transactions_synced(tenant_id: str, machine_id: str, count: int) -> None:
    body = _notify_base()
    body["count"] = count
    publish_notify(tenant_id, machine_id, "transactions-synced", body)


def create_token_request_for_machine(machine: POSMachine) -> dict[str, Any]:
    """Scoped subscribe-only Ably token for one POS machine."""
    channel = machine_channel_for(machine)
    if not channel:
        raise ValueError("machine has no tenant")
    client_id = machine.mqtt_client_id or f"pos-{machine.id}"
    client = _rest()
    if not client:
        raise RuntimeError("Ably is not configured (set ABLY_API_KEY)")

    token_request = client.auth.create_token_request(
        {
            "client_id": client_id,
            "capability": {channel: ["subscribe"]},
            "ttl": 24 * 60 * 60 * 1000,
        }
    )
    return token_request.to_dict()
