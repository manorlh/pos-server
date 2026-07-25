# Ably realtime notify

POS devices receive **lightweight wake-ups** over Ably WebSockets. Catalog, users,
and settings data are always pulled via HTTP (`GET /sync/...`).

## Channel model

- **Channel:** `pos:{tenantId}:{machineId}`
- **Events:** `catalog`, `pos-users`, `settings`, `close-day`
- **Auth:** `GET /api/v1/machines/me/ably-auth` (machine JWT) → subscribe-only token

## Server setup

1. Create an app at [ably.com](https://ably.com)
2. Copy the **API key** (`appId.keySecret`) → `ABLY_API_KEY` on pos-server
3. In Ably dashboard → **Channel rules** → namespace `pos:*` → enable **Persist last message**

## POS desktop

Connects with Ably Realtime `authUrl` + machine JWT. Subscribes with `rewind=1`
so the last notify is replayed after reconnect.

## Revoking a device

Deactivate the machine — Ably token endpoint rejects inactive machines (JWT still
valid until expiry; deactivate machine in DB so sync fails). Re-pair if needed.

## Local dev without Ably

Leave `ABLY_API_KEY` empty. Notifies are skipped (logged). HTTP sync + heartbeat
still work; use manual catalog pull or restart to refresh.
