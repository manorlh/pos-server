"""Realtime (Ably) connection metadata for pairing and GET /machines/me."""
from __future__ import annotations

from typing import Any, Dict, Optional

from app.config import get_settings
from app.models.pos_machine import POSMachine
from app.services.ably_notify import machine_channel_for, shop_channel_for

settings = get_settings()


def machine_realtime_connection_info(
    *,
    machine: POSMachine,
    access_token: str,
    api_url_prefix: Optional[str] = None,
) -> Dict[str, Any]:
    prefix = api_url_prefix if api_url_prefix is not None else settings.api_v1_prefix
    channel = machine_channel_for(machine)
    return {
        "machineId": str(machine.id),
        "machineCode": machine.machine_code,
        "tenantId": str(machine.tenant_id) if machine.tenant_id else None,
        "shopId": str(machine.shop_id) if machine.shop_id else None,
        "accessToken": access_token,
        "mqttClientId": machine.mqtt_client_id,
        "realtimeChannel": channel,
        # The shop's coalesced "tables" signal (app/services/tables_state.py); a till that
        # knows it subscribes to it beside its own channel.
        "realtimeShopChannel": shop_channel_for(machine),
        "ablyAuthUrl": f"{prefix}/machines/me/ably-auth",
    }


def machine_realtime_refresh_info(
    *,
    machine: Optional[POSMachine] = None,
) -> Dict[str, Any]:
    info: Dict[str, Any] = {
        "ablyAuthUrl": f"{settings.api_v1_prefix}/machines/me/ably-auth",
    }
    if machine is not None:
        channel = machine_channel_for(machine)
        if channel:
            info["realtimeChannel"] = channel
        shop = shop_channel_for(machine)
        if shop:
            info["realtimeShopChannel"] = shop
    return info
