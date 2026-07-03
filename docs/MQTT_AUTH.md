# MQTT authentication (EMQX)

POS devices connect to the broker **read-only** and **scoped to their own machine**:

- **Username:** `mqttClientId` (per device)
- **Password:** the machine JWT (`type: machine`, `sub: <machineId>`)
- **Allowed:** subscribe to `pos/{tenant}/{machine}/#`
- **Denied:** all publish, and any other topic

The backend (`pos-server`) still connects with the shared broker login
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

Dashboard → **Access Control**.

### 1. Authentication → Create → HTTP Server

- Method: `POST`
- URL: `https://pos-cloud-api.fly.dev/api/v1/mqtt/auth`
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

Keep (or add) the built-in credential for `pos-server` if you prefer the backend
to authenticate via EMQX's built-in DB instead of HTTP — the HTTP endpoint also
accepts it, so either works.

## Rollout

1. Configure EMQX Authentication + Authorization (above).
2. Deploy `pos-server` (already returns per-device creds).
3. POS devices refresh credentials from `GET /machines/me` on reconnect — no
   re-pairing required.

## Notes

- Heartbeat is **HTTP** (`POST /machines/me/heartbeat`), not MQTT, so dashboard
  online status works even if MQTT is down.
- Revoking a device = deactivating the machine (JWT check fails → broker rejects).
