"""Ably realtime notify — lightweight wake-ups for POS (data via HTTP pull)."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, List, Optional

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


def shop_channel(tenant_id: str, shop_id: str) -> str:
    """
    The shop's channel: the coalesced "tables" signal, sent once for every till of the shop
    (app/services/tables_state.py). Subscribe-only on every till's token of that shop.
    """
    return f"pos:{tenant_id}:shop:{shop_id}"


def shop_channel_for(machine: POSMachine) -> Optional[str]:
    if not machine.tenant_id or not machine.shop_id:
        return None
    return shop_channel(str(machine.tenant_id), str(machine.shop_id))


#: Ably's batch publish takes up to 100 channels in one request.
BATCH_CHANNELS = 100


def _batch_failures(response: Any) -> int:
    """`failureCount` of a batch publish answer (protocol 2+), 0 when it cannot be read."""
    try:
        return sum(int((item or {}).get("failureCount") or 0) for item in (response.items or []))
    except Exception:  # noqa: BLE001 - the answer's shape is Ably's
        return 0


def publish_batch(channels: List[str], event: str, body: dict[str, Any]) -> None:
    """
    One message to many channels in ONE Ably request (REST batch publish, `POST /messages`)
    instead of a request per channel. Falls back to one publish per channel if the batch
    request itself fails. Best effort, like every notify.
    """
    client = _rest()
    if not client or not channels:
        if channels:
            logger.debug("Ably not configured — skip %s to %d channel(s)", event, len(channels))
        return
    import json

    from ably import api_version

    message = {"name": event, "data": json.dumps(body), "encoding": "json"}
    for start in range(0, len(channels), BATCH_CHANNELS):
        chunk = channels[start:start + BATCH_CHANNELS]
        try:
            response = client.request(
                "POST", "/messages", api_version, body={"channels": chunk, "messages": [message]},
            )
            if not response.success:
                raise RuntimeError(f"{response.status_code} {response.error_code} {response.error_message}")
            failed = _batch_failures(response)
            if failed:
                logger.warning("Ably batch event=%s: %d of %d channel(s) refused", event, failed, len(chunk))
            logger.debug("Ably batch → %d channel(s) event=%s", len(chunk), event)
        except Exception as exc:  # noqa: BLE001 - fall back to one publish per channel
            logger.warning("Ably batch publish failed (%s); publishing per channel", exc)
            for name in chunk:
                try:
                    client.channels.get(name).publish(event, body)
                except Exception as inner:  # noqa: BLE001
                    logger.error("Ably publish failed channel=%s event=%s: %s", name, event, inner)


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
    force: bool = False,
    wait_for_rest: bool = False,
    keep_held_sales: bool = False,
    cancel_held_sales: Optional[dict] = None,
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
    if force:
        # "Even mid-sale" (docs/SPEC_OFFLINE_TILL_Z.md §9); absent = as always.
        body["force"] = True
    if wait_for_rest:
        # Remote control: only once the till is at rest (no sale, no payment, no card).
        body["waitForRest"] = True
    if keep_held_sales:
        # "סגור בכל זאת — המכירות המושהות יישמרו" (app/services/held_sales_close.py).
        body["keepHeldSales"] = True
    if cancel_held_sales:
        # "בטל מכירות מושהות וסגור": exactly these ids, the reason, who (held_sales_close.py).
        body["cancelHeldSales"] = cancel_held_sales
    publish_notify(tenant_id, machine_id, "close-shift", body)


def publish_transmit_notify(
    tenant_id: str,
    machine_id: str,
    request_id: str,
    initiated_by: str,
) -> None:
    """
    Ask a till to transmit its card batch now (docs/SHIFTS_API.md §4.3).

    The fast path only, like `close-shift`: the heartbeat's `pendingTransmit` hands the same
    instruction to a till that missed this.
    """
    body = _notify_base()
    body["requestId"] = request_id
    body["initiatedBy"] = initiated_by
    publish_notify(tenant_id, machine_id, "transmit", body)


def publish_till_z_notify(
    tenant_id: str,
    machine_id: str,
    request_id: str,
    initiated_by: str,
    force: bool = False,
    wait_for_rest: bool = False,
    keep_held_sales: bool = False,
    cancel_held_sales: Optional[dict] = None,
) -> None:
    """
    Ask a till in `zMode = till` to produce its own Z now (docs/SHIFTS_API.md §5.3).

    The fast path only, like `close-shift`: the heartbeat's `pendingTillZ` hands the same
    instruction to a till that missed this. The till dedupes by `requestId`.
    """
    body = _notify_base()
    body["requestId"] = request_id
    body["initiatedBy"] = initiated_by
    if force:
        body["force"] = True
    if wait_for_rest:
        body["waitForRest"] = True
    if keep_held_sales:
        body["keepHeldSales"] = True
    if cancel_held_sales:
        body["cancelHeldSales"] = cancel_held_sales
    publish_notify(tenant_id, machine_id, "till-z", body)


def publish_remote_credit_notify(
    tenant_id: str,
    machine_id: str,
    request_id: str,
    initiated_by: str,
    cancelled: bool = False,
) -> None:
    """
    "זיכוי מרחוק" (docs/SPEC_REMOTE_CREDIT.md): a credit request for this till was made
    (or cancelled). A wake-up only: the till pulls `GET /sync/{m}/remote-credits`, and the
    heartbeat's `pendingRemoteCredits` hands the same to a till that missed this.
    """
    body = _notify_base()
    body["requestId"] = request_id
    body["initiatedBy"] = initiated_by
    if cancelled:
        body["cancelled"] = True
    publish_notify(tenant_id, machine_id, "remote-credit", body)


def publish_card_command_notify(tenant_id: str, machine_id: str, command: dict[str, Any]) -> None:
    """
    "תשלום לא מוכרע" (app/services/card_attempt_commands.py): a manager's command about an
    unknown card for this till — `{commandId, vuid, action, requestedBy, requestedAt}`, the
    same item the heartbeat's `pendingCardCommands` carries to a till that missed this.
    """
    body = _notify_base()
    body.update(command)
    publish_notify(tenant_id, machine_id, "card-command", body)


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

    # history too: the till attaches with rewind=1 to catch a close-shift
    # published while it was reconnecting, and rewind needs history.
    capability = {channel: ["subscribe", "history"]}
    shop = shop_channel_for(machine)
    if shop:
        # The shop's coalesced "tables" signal (app/services/tables_state.py).
        capability[shop] = ["subscribe", "history"]
    token_request = client.auth.create_token_request(
        {
            "client_id": client_id,
            "capability": capability,
            "ttl": 24 * 60 * 60 * 1000,
        }
    )
    return token_request.to_dict()
