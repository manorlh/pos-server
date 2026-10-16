"""
"ממסר הענן" — the cloud relay of the cash stations' LAN calls (P:/specs/cash-paylink.md §14.4; the route: §14.2).

The owner, 16.10: the kiosks reach the kiosk (or the box) the PayLink is plugged into "דרך הענן או מקומי — מה
שיוגדר". A client whose `cashRoute` is `cloud` (or `auto`, when its station does not answer on the LAN) sends each
§11.4 call here instead of to the host's LAN address; the host takes it, runs it exactly as a LAN call, and gives
the answer back. The cloud is a mailbox — nothing of the cash logic lives here:

* **The client** (`POST /sync/{client}/cash/relay`): the call as it would go on the LAN — method, path, the §11.3
  headers (`client`, `ts`, `nonce`, `sig`) and the exact JSON text signed. Checked here: the device is a client of
  that station (`cashEnabled` + `cashStation`, §11.2), its route is not `lan`, the station has an active host, the
  path is one of §11.4 under that station. Kept by the client's `requestId` (the same id again — the same call; other
  content — 409 `relay_conflict`), then the answer awaited a few seconds (`waitMs`); not yet — `pending`, asked again
  by `GET …/relay/{requestId}`.
* **The host** (`POST /sync/{host}/cash/relay/poll`): its answers to the calls it took last time, then the calls
  waiting for its stations — each handed over ONCE (`taken`) — or, none, a wait for one (`waitMs`, a long poll: the
  Windows app has no realtime channel). `relay: false` — none of its stations' clients routes through the cloud.
* **Lapses.** A call not taken within `PICKUP` — `expired`; taken and not answered within `ANSWER` — `lost`. Both are
  "no answer" to the client, like a LAN timeout. The host never runs a call older than `EXECUTE_MAX_AGE_MS` (it is
  told `ageMs`): a call of a route the kiosk gave up on cannot land after it did (§14.2 `auto`).
* **Security.** The signature is end to end: the host verifies it with the client's own secret, as on the LAN; the
  nonce once and the clock window there; the `requestId` once here. A host is handed only its own stations' calls.
  The bodies are never logged; the rows are deleted after `KEEP`.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.cash_station import CashRelayRequest
from app.models.pos_machine import POSMachine
from app.services import cash_params as CP
from app.services import cash_stations as CS
from app.services.cash_host import hosts_cash

logger = logging.getLogger(__name__)

API = 1
#: A call the host did not take in this long: `expired`.
PICKUP = timedelta(seconds=10)
#: A call taken and not answered in this long: `lost`.
ANSWER = timedelta(seconds=20)
#: The host never runs a call older than this (it is told `ageMs`).
EXECUTE_MAX_AGE_MS = 10_000
CLIENT_WAIT_DEFAULT_MS = 6_000
CLIENT_WAIT_MAX_MS = 10_000
HOST_WAIT_MAX_MS = 25_000
BODY_MAX = 16 * 1024
REPLY_MAX = 64 * 1024
#: Calls handed to a host in one answer; answers taken from it in one poll.
BATCH = 20
REPLIES_MAX = 100
KEEP = timedelta(hours=24)
#: How often a waiting host's poll looks for a call: while it had one lately, and at rest.
HOST_ACTIVE = timedelta(seconds=60)
HOST_CHECK_ACTIVE_S = 0.25
HOST_CHECK_IDLE_S = 0.75
CLIENT_CHECK_S = 0.2
PURGE_EVERY = timedelta(minutes=10)

METHODS = ("GET", "POST", "DELETE")
_CLIENT = re.compile(r"^[A-Za-z0-9-]{8,64}$")
_TS = re.compile(r"^\d{10,16}$")
_NONCE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_SIG = re.compile(r"^[A-Za-z0-9_-]{43}$")
_UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
#: The §11.4 calls (never `GET /cash/health`, never the WebSocket): METHOD → what follows `/cash/stations/{id}/`.
_CALLS = {
    "GET": (re.compile(r"^status$"), re.compile(rf"^tx/{_UUID}$")),
    "POST": (re.compile(r"^lease$"), re.compile(rf"^tx/{_UUID}/(start|cancel|ack|split|finish)$")),
    "DELETE": (re.compile(r"^lease/[A-Za-z0-9%._~-]{1,128}$"),),
}

_last_purge: Optional[datetime] = None


def _now(now: Optional[datetime] = None) -> datetime:
    return now if now is not None else datetime.now(timezone.utc)


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _refuse(status_code: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message, **extra})


def _bad(message: str) -> HTTPException:
    return _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "bad_request", message)


def is_station_call(method: str, path: str, station_id: str) -> bool:
    """A §11.4 call of this station: `/cash/stations/{station_id}/…` (no query) with a known method."""
    prefix = f"/cash/stations/{station_id}/"
    if method not in _CALLS or not isinstance(path, str) or "?" in path or not path.startswith(prefix):
        return False
    rest = path[len(prefix):]
    return any(rx.match(rest) for rx in _CALLS[method])


def _clean_call(raw: Dict[str, Any]) -> Dict[str, Any]:
    """The call as the client signed it, checked for its form (the host checks the signature)."""
    station_id = raw.get("stationId")
    if not isinstance(station_id, str) or CS._uuid(station_id) is None:
        raise _bad("stationId: מזהה עמדה.")
    method = raw.get("method")
    if not isinstance(method, str) or method.upper() not in METHODS:
        raise _bad("method: GET | POST | DELETE.")
    method = method.upper()
    path = raw.get("path")
    if not isinstance(path, str) or len(path) > 300 or not is_station_call(method, path, station_id):
        raise _bad("path: קריאה של §11.4 תחת /cash/stations/{stationId}/.")
    signed = {}
    for key, rx in (("client", _CLIENT), ("ts", _TS), ("nonce", _NONCE), ("sig", _SIG)):
        value = raw.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and key == "ts":
            value = str(value)
        if not isinstance(value, str) or not rx.match(value):
            raise _bad(f"{key}: לא תקין.")
        signed[key] = value
    body = raw.get("body")
    if body is None:
        body = ""
    if not isinstance(body, str):
        raise _bad("body: טקסט ה-JSON שנחתם.")
    if len(body.encode("utf-8")) > BODY_MAX:
        raise _bad(f"body: עד {BODY_MAX} בתים.")
    if method == "GET" and body:
        raise _bad("body: GET בלי גוף.")
    return {"stationId": station_id, "method": method, "path": path, "signed": signed, "body": body}


def _digest(call: Dict[str, Any]) -> str:
    text = json.dumps(call, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def wait_ms_of(value: Any, default: int, top: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return max(0, min(top, int(value)))


# ── The client ────────────────────────────────────────────────────────────────


def route_of_client(db: Session, client: POSMachine) -> str:
    return CP.route_of(CS.machine_params(db, client).get(CP.ROUTE_KEY)) if client.shop_id is not None else CP.ROUTE_LAN


def submit(db: Session, client: POSMachine, raw: Any, *, now: Optional[datetime] = None) -> CashRelayRequest:
    """
    A client's call for its station's host (§14.4): checked, kept by its `requestId` — the same id with the same
    content is the same row (a network retry), with another content 409 `relay_conflict`. The caller commits.
    """
    now = _now(now)
    if not isinstance(raw, dict):
        raise _bad("גוף הבקשה: אובייקט.")
    request_id = CS._uuid(raw.get("requestId"))
    if request_id is None:
        raise _bad("requestId: UUID.")
    call = _clean_call(raw)
    if call["signed"]["client"].lower() != str(client.id).lower():
        raise _bad("client: המכשיר עצמו.")
    digest = _digest(call)
    existing = db.get(CashRelayRequest, request_id)
    if existing is not None:
        if existing.client_machine_id != client.id or existing.digest != digest:
            raise _refuse(status.HTTP_409_CONFLICT, "relay_conflict", "מזהה הבקשה כבר בשימוש לבקשה אחרת.")
        return existing
    station = CS.get_station(db, call["stationId"])
    mine = CS.station_of_client(db, client)
    if station is None or mine is None or mine.id != station.id:
        raise _refuse(status.HTTP_403_FORBIDDEN, "not_assigned", "המכשיר אינו משויך לעמדת המזומן הזו.")
    if route_of_client(db, client) == CP.ROUTE_LAN:
        raise _refuse(status.HTTP_409_CONFLICT, "cloud_route_off",
                      "הנתיב לעמדת המזומן של המכשיר הוא הרשת המקומית (cashRoute = lan).")
    host = CS.host_of(db, station)
    if host is None:
        raise _refuse(status.HTTP_409_CONFLICT, "no_host", "לעמדת המזומן אין שרת מזומן פעיל.")
    row = CashRelayRequest(
        id=request_id, tenant_id=station.tenant_id, station_id=station.id, host_machine_id=host.id,
        client_machine_id=client.id, method=call["method"], path=call["path"], signed=call["signed"],
        body=call["body"], digest=digest, state="pending", created_at=now,
    )
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        # The same id at the same moment (a retry racing the first): the first one stands.
        again = db.get(CashRelayRequest, request_id)
        if again is None or again.client_machine_id != client.id or again.digest != digest:
            raise _refuse(status.HTTP_409_CONFLICT, "relay_conflict", "מזהה הבקשה כבר בשימוש לבקשה אחרת.") from None
        return again
    return row


def settle(row: CashRelayRequest, now: Optional[datetime] = None) -> bool:
    """A lapsed call marked: pending past `PICKUP` — expired; taken past `ANSWER` — lost. True when changed."""
    now = _now(now)
    if row.state == "pending" and now - _aware(row.created_at) >= PICKUP:
        row.state = "expired"
        return True
    if row.state == "taken" and now - (_aware(row.taken_at) or _aware(row.created_at)) >= ANSWER:
        row.state = "lost"
        return True
    return False


def out(row: CashRelayRequest) -> Dict[str, Any]:
    """The client's answer: its state, and the host's answer once there."""
    body: Dict[str, Any] = {"api": API, "requestId": str(row.id), "state": row.state}
    if row.state == "done":
        body["reply"] = row.reply or {"status": 502, "body": None, "hostTime": None}
    return body


def get_for_client(db: Session, client: POSMachine, request_id: Any) -> CashRelayRequest:
    ident = CS._uuid(request_id) if not isinstance(request_id, uuid.UUID) else request_id
    row = db.get(CashRelayRequest, ident) if ident is not None else None
    if row is None or row.client_machine_id != client.id:
        raise _refuse(status.HTTP_404_NOT_FOUND, "relay_not_found", "הבקשה לא נמצאה.")
    return row


# ── The host ──────────────────────────────────────────────────────────────────


def _clean_reply(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    code = item.get("status")
    if isinstance(code, bool) or not isinstance(code, int) or not 100 <= code <= 599:
        return None
    body = item.get("body")
    try:
        if len(json.dumps(body, ensure_ascii=False, default=str)) > REPLY_MAX:
            body = {"error": "too_large"}
    except (TypeError, ValueError):
        body = None
    host_time = item.get("hostTime")
    if isinstance(host_time, bool) or not isinstance(host_time, (int, float)):
        host_time = None
    return {"status": code, "body": body, "hostTime": int(host_time) if host_time is not None else None}


def store_replies(db: Session, host: POSMachine, replies: Sequence[Any], *, now: Optional[datetime] = None) -> int:
    """The host's answers to the calls it took: each once, only its own (`taken`); anything else ignored."""
    now = _now(now)
    stored = 0
    for item in list(replies or [])[:REPLIES_MAX]:
        if not isinstance(item, dict):
            continue
        ident = CS._uuid(item.get("requestId"))
        row = db.get(CashRelayRequest, ident) if ident is not None else None
        if row is None or row.host_machine_id != host.id or row.state != "taken":
            continue
        reply = _clean_reply(item)
        if reply is None:
            continue
        row.reply = reply
        row.state = "done"
        row.done_at = now
        stored += 1
    if stored:
        db.flush()
    return stored


def request_out(row: CashRelayRequest, now: datetime) -> Dict[str, Any]:
    """A call as the host receives it: exactly as signed, and how long ago it reached the cloud."""
    signed = row.signed or {}
    return {
        "requestId": str(row.id),
        "clientId": str(row.client_machine_id),
        "stationId": str(row.station_id),
        "method": row.method,
        "path": row.path,
        "client": signed.get("client"),
        "ts": signed.get("ts"),
        "nonce": signed.get("nonce"),
        "sig": signed.get("sig"),
        "body": row.body or "",
        "ageMs": max(0, int((now - _aware(row.created_at)).total_seconds() * 1000)),
    }


def take(db: Session, host: POSMachine, *, now: Optional[datetime] = None) -> List[CashRelayRequest]:
    """
    The calls waiting for this host's stations, oldest first, handed over ONCE (`taken`): rows locked while taken
    (two polls of one host never get the same call). The caller commits.
    """
    now = _now(now)
    rows = (
        db.query(CashRelayRequest)
        .filter(
            CashRelayRequest.host_machine_id == host.id,
            CashRelayRequest.state == "pending",
            CashRelayRequest.created_at > now - PICKUP,
        )
        .order_by(CashRelayRequest.created_at, CashRelayRequest.id)
        .limit(BATCH)
        .with_for_update(skip_locked=True)
        .all()
    )
    for row in rows:
        row.state = "taken"
        row.taken_at = now
    if rows:
        db.flush()
    return rows


def relay_wanted(db: Session, host: POSMachine) -> bool:
    """Some client of the host's stations (other than the host itself) is not on the LAN (§14.2)."""
    if not hosts_cash(host) or host.shop_id is None:
        return False
    stations = CS.stations_of_host(db, host.id)
    if not stations:
        return False
    clients = CS.client_routes(db, host.shop_id, CS.stations_of_shop(db, host.shop_id))
    return any(
        route != CP.ROUTE_LAN for station in stations for machine, route in clients.get(station.id, []) if machine.id != host.id
    )


def host_active(db: Session, host: POSMachine, *, now: Optional[datetime] = None) -> bool:
    """A call reached this host lately: its poll then looks for the next one more often."""
    now = _now(now)
    last = db.query(func.max(CashRelayRequest.created_at)).filter(CashRelayRequest.host_machine_id == host.id).scalar()
    return last is not None and now - _aware(last) < HOST_ACTIVE


def purge(db: Session, *, now: Optional[datetime] = None, force: bool = False) -> int:
    """Rows older than `KEEP` deleted — at most every `PURGE_EVERY` per process. The caller commits."""
    global _last_purge
    now = _now(now)
    if not force and _last_purge is not None and now - _last_purge < PURGE_EVERY:
        return 0
    _last_purge = now
    gone = (
        db.query(CashRelayRequest)
        .filter(CashRelayRequest.created_at < now - KEEP)
        .delete(synchronize_session=False)
    )
    return int(gone or 0)

