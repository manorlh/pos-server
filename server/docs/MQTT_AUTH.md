# MQTT authentication (EMQX HTTP external auth)

POS devices connect to the broker **read-only** and **scoped to their own machine**:

- **Username:** `mqttClientId` (per device)
- **Password:** the machine JWT (`type: machine`, `sub: <machineId>`)
- **Allowed:** subscribe to `pos/{tenant}/{machine}/#`
- **Denied:** all publish, and any other topic

The backend (`pos-server`) connects with the shared broker login
(`MQTT_BROKER_USERNAME` / `MQTT_BROKER_PASSWORD`) to publish `notify` messages.

Both are validated by the server endpoint **`POST /api/v1/mqtt/auth`**, which EMQX
calls as an HTTP Authenticator and Authorizer.

## Endpoint contract

EMQX sends JSON like:

```json
{ "username": "...", "password": "...", "action": "subscribe|publish", "topic": "..." }
```

The endpoint returns `{"result": "allow"}` or `{"result": "deny"}`.

Optional: set `MQTT_HTTP_AUTH_SECRET` on the server and configure EMQX to send it
as header `X-MQTT-Auth-Secret` so only EMQX can call the endpoint.

## EMQX Console setup (one-time)

Requires EMQX **Dedicated** (or self-hosted) — HTTP external auth is not available
on Serverless free tier.

Dashboard → **Access Control**.

### 1. Authentication → Create → HTTP Server

- Method: `POST`
- URL: `https://<your-api>/api/v1/mqtt/auth`
- Headers: `Content-Type: application/json` (+ `X-MQTT-Auth-Secret: <secret>` if set)
- Body:
  ```json
  {
    "username": "${username}",
    "password": "${password}",
    "action": "${action}",
    "topic": "${topic}"
  }
  ```

### 2. Authorization → Create → HTTP Server

- Same URL / method / headers / body as above.

Disable or remove built-in-database authentication for POS clients if it conflicts.
The HTTP endpoint also accepts the `pos-server` broker login for publish access.

## Rollout

1. Deploy `pos-server` with `MQTT_HTTP_AUTH_SECRET` (recommended).
2. Configure EMQX Authentication + Authorization (above).
3. POS devices refresh credentials from `GET /machines/me` on reconnect — no
   re-pairing required (`mqttPassword` becomes the machine JWT).

## Revoking a device

Deactivate or delete the machine — JWT validation fails → broker rejects.

No per-user provisioning in EMQX is required.

## Notes

- Heartbeat is **HTTP** (`POST /machines/me/heartbeat`), not MQTT.
- Legacy HMAC broker passwords are still accepted briefly during fleet migration.
