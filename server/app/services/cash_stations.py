"""
"עמדות מזומן" — the cloud's side of the kiosk cash units (P:/specs/cash-paylink.md §11, §12; the role:
app/services/cash_host.py; the alerts: cash_alerts.py; the drawer and the Z: cash_station_drawer.py).

* **Stations.** A `cash_stations` row is one PayLink unit (its USB `serial`) run by a cash host of the
  same shop; a kiosk is assigned one with the till parameter `cashStation` ('' = the shop's only active
  station). Several kiosks may share one (they queue on the host).
* **What a device pulls** (`GET /sync/{m}/cash`, §11.2): a kiosk / a till — `role: "client"`: whether it
  takes cash, its station with the host's LAN address and port (from the host's last heartbeat) and
  ITS OWN secret, and the settings; the cash host — `role: "host"`: its secret, its stations (each with
  its settings and its assigned clients), the dashboard's pending commands, its own settings, and the
  shop's LAN servers it hands the alerts to when the cloud is away (`lanAlertTargets`, §11.12).
* **Secrets** (§11.3), derived, never stored (like the print host's): `hostSecret = hex(HMAC-SHA256(
  jwt_secret_key, "cash-host:" + hostId))`, `clientSecret = hex(HMAC-SHA256(utf8(hostSecret),
  "cash-client:" + clientId))`. A kiosk is given only its own; changing the server key changes all.
* **The journal** (`POST /sync/{host}/cash/journal`, §11.9): transactions upserted by `txId` only with a
  higher `seq`, movements inserted once by `id`. A paid transaction with change owed, or one held in
  the unit, opens an owed item ("עודף חייב" / "זיכוי מוחזק") and a `cash_unit` alert.
* **Owed items** (§11.8): listed to the station's alert tills (`cashAlertTills`, '' = the shop's main
  till), paid there ("שולם ללקוח", idempotent by `movementId`), or resolved on the dashboard. A held
  credit whose kiosk document arrives after all (`payments[].cashDevice.txId`) closes by itself.
* **Commands** (refill, count, collect, dump, deliver_pending, float) from the dashboard, delivered
  with the host's pull and acknowledged once.

Money in integer agorot throughout, as on the LAN.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.cash_station import (
    COMMAND_OPS,
    FINAL_STATES,
    MOVEMENT_KINDS,
    OUTCOMES,
    TX_STATES,
    CashHostCommand,
    CashStation,
    CashStationMovement,
    CashStationTx,
)
from app.models.pos_machine import PairingStatus, POSMachine
from app.services import cash_params as CP
from app.services.cash_host import is_cash_host

logger = logging.getLogger(__name__)

API = 1
#: The cash host's LAN port when it does not say (§11.4).
DEFAULT_PORT = 47630
JOURNAL_MAX = 500
STATIONS_MAX = 16
ALERTS_MAX = 50
LIST_MAX = 64
COMMANDS_MAX = 50
AGOROT_MAX = 100_000_000
#: A held credit's kiosk document is looked for this far around the transaction.
MATCH_WINDOW = timedelta(days=2)

_CODE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
_ADDRESS = re.compile(r"^[A-Za-z0-9.:\-\[\]%]{1,255}$")


# ── Small helpers ──────────────────────────────────────────────────────────────


def _now(now: Optional[datetime] = None) -> datetime:
    return now or datetime.now(timezone.utc)


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    m = _aware(moment)
    return m.isoformat() if m is not None else None


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if isinstance(value, uuid.UUID):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return uuid.UUID(value.strip())
    except ValueError:
        return None


def _int(value: Any, lo: int = 0, hi: int = AGOROT_MAX, default: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    try:
        n = int(value)
    except (OverflowError, ValueError):
        return default
    return min(hi, max(lo, n))


def _opt_int(value: Any, lo: int, hi: int) -> Optional[int]:
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return min(hi, max(lo, int(value)))
    except (OverflowError, ValueError):
        return None


def _str(value: Any, limit: int) -> Optional[str]:
    if value is None or isinstance(value, (dict, list)):
        return None
    text = " ".join(str(value).split())
    return text[:limit] or None


def _code(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and _CODE.match(value) else None


def _from_ms(value: Any) -> Optional[datetime]:
    ms = _opt_int(value, 0, 10**14)
    if not ms:
        return None
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _ms(moment: Optional[datetime]) -> Optional[int]:
    m = _aware(moment)
    return int(m.timestamp() * 1000) if m is not None else None


def money_text(agorot: Optional[int]) -> str:
    """13 ₪ / 13.50 ₪ — the way an alert says an amount."""
    value = int(agorot or 0)
    whole, cents = divmod(abs(value), 100)
    sign = "-" if value < 0 else ""
    return f"{sign}{whole} ₪" if cents == 0 else f"{sign}{whole}.{cents:02d} ₪"


# ── Stations ───────────────────────────────────────────────────────────────────


def get_station(db: Session, station_id: Any) -> Optional[CashStation]:
    ident = _uuid(station_id) if not isinstance(station_id, uuid.UUID) else station_id
    return db.get(CashStation, ident) if ident is not None else None


def stations_of_shop(db: Session, shop_id: Any, *, active_only: bool = True) -> List[CashStation]:
    if shop_id is None:
        return []
    q = db.query(CashStation).filter(CashStation.shop_id == shop_id)
    if active_only:
        q = q.filter(CashStation.is_active.is_(True))
    return q.order_by(CashStation.name, CashStation.id).all()


def stations_of_host(db: Session, host_id: Any, *, active_only: bool = True) -> List[CashStation]:
    q = db.query(CashStation).filter(CashStation.host_machine_id == host_id)
    if active_only:
        q = q.filter(CashStation.is_active.is_(True))
    return q.order_by(CashStation.name, CashStation.id).all()


def station_label(station: Any) -> str:
    """"עמדת מזומן 2 (ליד קיוסק 3)" — how every alert names the station (§12)."""
    name = (getattr(station, "name", None) or "עמדת מזומן").strip()
    location = (getattr(station, "location", None) or "").strip()
    return f"{name} ({location})" if location else name


def host_of(db: Session, station: CashStation) -> Optional[POSMachine]:
    host = db.get(POSMachine, station.host_machine_id) if station.host_machine_id else None
    if host is None or not host.is_active or not is_cash_host(host):
        return None
    return host


# ── Secrets (§11.3) ────────────────────────────────────────────────────────────


def host_secret(host_id: Any) -> str:
    """The host's secret: 64 lower-case hex; derived from the server key, never stored."""
    from app.config import get_settings

    key = (get_settings().jwt_secret_key or "").encode("utf-8")
    return hmac.new(key, f"cash-host:{host_id}".encode("utf-8"), hashlib.sha256).hexdigest()


def client_secret(secret_of_host: str, client_id: Any) -> str:
    """One client's secret, as the host derives it from its own: 64 lower-case hex."""
    return hmac.new(
        secret_of_host.encode("utf-8"), f"cash-client:{client_id}".encode("utf-8"), hashlib.sha256,
    ).hexdigest()


# ── Settings ───────────────────────────────────────────────────────────────────


def machine_params(db: Session, machine: POSMachine) -> Dict[str, Any]:
    from app.services.till_parameters import till_parameters_for_machine

    return till_parameters_for_machine(db, machine).parameters


def _base_params(db: Session, station: CashStation, host: Optional[POSMachine]) -> Dict[str, Any]:
    """The station's parameters before its own overrides: as they resolve on its host, else on its shop."""
    if host is not None:
        return machine_params(db, host)
    from app.models.shop import Shop
    from app.services.till_parameters import resolve_for_shop

    shop = db.get(Shop, station.shop_id)
    return resolve_for_shop(db, shop) if shop is not None else {}


def overrides_of(station: CashStation) -> Dict[str, Any]:
    raw = station.settings if isinstance(station.settings, dict) else {}
    return {k: v for k, v in raw.items() if k in CP.STATION_KEYS and v is not None}


def station_settings(
    db: Session, station: CashStation, host: Optional[POSMachine] = None, *, base: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Every §11.10 key as the station works with it: its host's resolved parameters, typed, under its overrides."""
    if base is None:
        base = _base_params(db, station, host if host is not None else host_of(db, station))
    out = CP.typed(base)
    out.update({k: CP.typed_value(k, v) for k, v in overrides_of(station).items()})
    return out


def client_settings(params: Dict[str, Any], station: Optional[CashStation], station_eff: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """
    A kiosk's settings: its own resolved parameters, typed — with the station's word on what the station
    decides (the coins and notes, the change, the rounding… — its effective values) and the station's own
    overrides of the timers both read.
    """
    out = CP.typed(params)
    if station is not None and station_eff is not None:
        for key in CP.STATION_ONLY_KEYS:
            out[key] = station_eff[key]
        for key, value in overrides_of(station).items():
            if key in CP.SHARED_KEYS:
                out[key] = CP.typed_value(key, value)
    return out


# ── The host's report ───────────────────────────────────────────────────────────


def host_status(host: Optional[POSMachine]) -> Optional[Dict[str, Any]]:
    raw = getattr(host, "cash_status", None) if host is not None else None
    return raw if isinstance(raw, dict) else None


def host_lan(host: Optional[POSMachine]) -> Tuple[Optional[str], int]:
    report = host_status(host) or {}
    return report.get("lanAddress"), report.get("port") or DEFAULT_PORT


def station_report(host: Optional[POSMachine], station_id: Any) -> Optional[Dict[str, Any]]:
    """What the host last said of this station (its `cash.stations[]` entry), or None."""
    for item in (host_status(host) or {}).get("stations") or []:
        if isinstance(item, dict) and item.get("stationId") == str(station_id):
            return item
    return None


def _clean_pieces(raw: Any, *, counts: bool = True) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for item in (raw if isinstance(raw, list) else [])[:LIST_MAX]:
        if not isinstance(item, dict):
            continue
        value = _opt_int(item.get("valueAgorot"), 1, 10_000_000)
        if value is None:
            continue
        piece: Dict[str, Any] = {"valueAgorot": value}
        kind = item.get("kind")
        if kind in ("coin", "note"):
            piece["kind"] = kind
        if counts:
            piece["count"] = _int(item.get("count"), 0, 1_000_000)
        out.append(piece)
    return out


def clean_status(raw: Any) -> Optional[Dict[str, Any]]:
    """
    The heartbeat's `cash` block (§11.9), field by field: what is unreadable is dropped, never a 422.
    None when it is not an object at all.
    """
    if not isinstance(raw, dict):
        return None
    address = raw.get("lanAddress")
    port = _opt_int(raw.get("port"), 0, 10**6)
    out: Dict[str, Any] = {
        "api": _int(raw.get("api"), 0, 1000, 1),
        "lanAddress": address.strip() if isinstance(address, str) and _ADDRESS.match(address.strip()) else None,
        "port": port if port is not None and 1 <= port <= 65535 else DEFAULT_PORT,
        "version": _str(raw.get("version"), 32),
        "stations": [],
    }
    seen = set()
    for item in (raw.get("stations") if isinstance(raw.get("stations"), list) else [])[:STATIONS_MAX]:
        if not isinstance(item, dict):
            continue
        sid = _uuid(item.get("stationId"))
        if sid is None or sid in seen:
            continue
        seen.add(sid)
        cashbox = item.get("cashbox") if isinstance(item.get("cashbox"), dict) else None
        denominations = []
        for d in (item.get("denominations") if isinstance(item.get("denominations"), list) else [])[:LIST_MAX]:
            if not isinstance(d, dict) or _opt_int(d.get("valueAgorot"), 1, 10_000_000) is None:
                continue
            denominations.append({
                "valueAgorot": _int(d.get("valueAgorot"), 1, 10_000_000),
                "kind": d.get("kind") if d.get("kind") in ("coin", "note") else None,
                "count": _int(d.get("count"), 0, 1_000_000),
                "accurate": d.get("accurate") is True,
                "level": _str(d.get("level"), 8),
                "isLow": d.get("isLow") is True,
            })
        alerts, keys = [], set()
        for a in (item.get("alerts") if isinstance(item.get("alerts"), list) else [])[:ALERTS_MAX]:
            if not isinstance(a, dict) or _code(a.get("code")) is None:
                continue
            unit = _str(a.get("unit"), 32) or ""
            if (a["code"], unit) in keys:
                continue
            keys.add((a["code"], unit))
            alerts.append({
                "code": a["code"], "unit": unit, "message": _str(a.get("message"), 200),
                "since": _opt_int(a.get("since"), 0, 10**14),
            })
        active = _uuid(item.get("activeTxId"))
        state = item.get("state")
        out["stations"].append({
            "stationId": str(sid),
            "serial": _str(item.get("serial"), 32) or "",
            "deviceSerial": _str(item.get("deviceSerial"), 64),
            "firmware": _str(item.get("firmware"), 32),
            # §11.11: a state the cloud does not know reads as a fault, never as ready.
            "state": state if state in ("ready", "busy", "maintenance", "fault", "starting") else "fault",
            "reason": _str(item.get("reason"), 200),
            "driver": _opt_int(item.get("driver"), -1000, 1000),
            "des": _opt_int(item.get("des"), -1000, 1000),
            "changeAvailableAgorot": _int(item.get("changeAvailableAgorot")),
            "exactOnly": item.get("exactOnly") is True,
            "denominations": denominations,
            "cashbox": None if cashbox is None else {
                "notes": _int(cashbox.get("notes"), 0, 1_000_000),
                "coins": _int(cashbox.get("coins"), 0, 1_000_000),
                "valueAgorot": _int(cashbox.get("valueAgorot")),
                "nearFull": cashbox.get("nearFull") is True,
                "full": cashbox.get("full") is True,
            },
            "queue": _int(item.get("queue"), 0, 1000),
            "activeTxId": str(active) if active is not None else None,
            "heldCount": _int(item.get("heldCount"), 0, 100_000),
            "alerts": alerts,
        })
    return out


def apply_heartbeat(db: Session, machine: POSMachine, raw: Any, *, now: Optional[datetime] = None) -> bool:
    """
    A cash host's `cash` block: kept on the machine (`cash_status`), and its stations' alerts reconciled
    (cash_alerts.py) — opened when reported, closed when no longer. Another device's block is ignored.
    The caller commits; never raises for a bad block (it is cleaned).
    """
    if not is_cash_host(machine):
        return False
    cleaned = clean_status(raw)
    if cleaned is None:
        return False
    now = _now(now)
    machine.cash_status = cleaned
    machine.cash_status_at = now
    from app.services import cash_alerts

    cash_alerts.reconcile_heartbeat(db, machine, cleaned, now=now)
    return True


# ── Clients ────────────────────────────────────────────────────────────────────


def _is_kiosk(db: Session, machine: POSMachine) -> bool:
    from app.services import kiosk_control

    return kiosk_control.is_kiosk(db, machine)


def kind_of(db: Session, machine: POSMachine) -> str:
    return "kiosk" if _is_kiosk(db, machine) else "till"


def resolve_station(
    stations: Sequence[CashStation], wanted: Any,
) -> Optional[CashStation]:
    """`cashStation` against the shop's active stations: that one, or — '' — the only one; else None."""
    active = [s for s in stations if s.is_active]
    ident = _uuid(wanted) if isinstance(wanted, str) and wanted.strip() else None
    if ident is not None:
        return next((s for s in active if s.id == ident), None)
    return active[0] if len(active) == 1 else None


def _shop_devices(db: Session, shop_id: Any) -> List[POSMachine]:
    return (
        db.query(POSMachine)
        .filter(
            POSMachine.shop_id == shop_id,
            POSMachine.is_active.is_(True),
            POSMachine.pairing_status == PairingStatus.ASSIGNED,
            POSMachine.is_fiscal.is_(True),
        )
        .order_by(POSMachine.pos_number, POSMachine.name, POSMachine.id)
        .all()
    )


def clients_by_station(db: Session, shop_id: Any, stations: Optional[Sequence[CashStation]] = None) -> Dict[Any, List[POSMachine]]:
    """The shop's kiosks and tills that take cash, by the station each is assigned (resolved)."""
    stations = list(stations) if stations is not None else stations_of_shop(db, shop_id)
    out: Dict[Any, List[POSMachine]] = {s.id: [] for s in stations}
    if not stations:
        return out
    for machine in _shop_devices(db, shop_id):
        try:
            params = machine_params(db, machine)
        except Exception:  # noqa: BLE001 - one device's parameters never hide the others
            logger.exception("cash: parameters of %s", machine.id)
            continue
        if params.get(CP.ENABLED_KEY) is not True:
            continue
        station = resolve_station(stations, params.get(CP.STATION_KEY))
        if station is not None:
            out.setdefault(station.id, []).append(machine)
    return out


def client_ref(db: Session, machine: POSMachine) -> Dict[str, Any]:
    return {"machineId": str(machine.id), "name": machine.name, "kind": kind_of(db, machine)}


# ── GET /sync/{m}/cash (§11.2) ─────────────────────────────────────────────────


def station_of_client(db: Session, machine: POSMachine) -> Optional[CashStation]:
    """The station a kiosk / till takes cash at (its resolved `cashEnabled` + `cashStation`), or None."""
    if machine.shop_id is None:
        return None
    params = machine_params(db, machine)
    if params.get(CP.ENABLED_KEY) is not True:
        return None
    return resolve_station(stations_of_shop(db, machine.shop_id), params.get(CP.STATION_KEY))


def client_view(db: Session, machine: POSMachine) -> Dict[str, Any]:
    """A kiosk's / a till's answer (`role: "client"`)."""
    params = machine_params(db, machine) if machine.shop_id is not None else {}
    enabled = params.get(CP.ENABLED_KEY) is True and getattr(machine, "is_fiscal", True) is not False
    stations = stations_of_shop(db, machine.shop_id) if enabled else []
    station = resolve_station(stations, params.get(CP.STATION_KEY)) if enabled else None
    host = host_of(db, station) if station is not None else None
    station_eff = station_settings(db, station, host) if station is not None else None
    out: Dict[str, Any] = {
        "api": API,
        "role": "client",
        "enabled": bool(enabled),
        "station": None,
        "settings": client_settings(params, station, station_eff),
    }
    if station is not None:
        address, port = host_lan(host)
        out["station"] = {
            "stationId": str(station.id),
            "name": station.name,
            "location": station.location,
            "hostId": str(host.id) if host is not None else None,
            "hostName": host.name if host is not None else None,
            # No host, or a host that never said where it listens: no address — no tile (§11.2).
            "lanAddress": address if host is not None else None,
            "port": port,
            "secret": client_secret(host_secret(host.id), machine.id) if host is not None else None,
        }
    return out


def lan_alert_targets(db: Session, host: POSMachine) -> List[Dict[str, Any]]:
    """
    §11.12: where the host hands its alerts with the cloud away — the shop's print server and its tables
    host (when another device), as a kiosk would: their LAN address, port and the shop's print secret.
    Never the host itself; none without an address; each address once.
    """
    from app.services.printers import print_host_block, print_secret
    from app.services.tables import lan_host_block

    out: List[Dict[str, Any]] = []
    seen = set()
    secret = print_secret(host.shop_id)
    for fn in (print_host_block, lan_host_block):
        try:
            block = fn(db, host)
        except Exception:  # noqa: BLE001 - a missing host is no target, never a failed pull
            logger.exception("cash: LAN alert target of %s", host.id)
            continue
        if not isinstance(block, dict) or block.get("isSelf") or not block.get("lanAddress"):
            continue
        if str(block.get("machineId")) == str(host.id):
            continue
        key = (block["lanAddress"], block.get("port"))
        if key in seen:
            continue
        seen.add(key)
        out.append({"lanAddress": block["lanAddress"], "port": block.get("port"), "secret": secret})
    return out


def host_view(db: Session, host: POSMachine) -> Dict[str, Any]:
    """The cash host's answer (`role: "host"`)."""
    base = machine_params(db, host)
    stations = stations_of_host(db, host.id)
    clients = clients_by_station(db, host.shop_id, stations_of_shop(db, host.shop_id)) if host.shop_id else {}
    host_settings = CP.typed(base, CP.HOST_KEYS)
    out_stations = []
    for station in stations:
        eff = station_settings(db, station, host, base=base)
        out_stations.append({
            "stationId": str(station.id),
            "name": station.name,
            "location": station.location,
            "serial": station.serial or "",
            "simulator": eff.get(CP.SIMULATOR_KEY) is True,
            "settings": eff,
            "clients": [client_ref(db, m) for m in clients.get(station.id, [])],
        })
    return {
        "api": API,
        "role": "host",
        "hostId": str(host.id),
        "hostSecret": host_secret(host.id),
        "stations": out_stations,
        "commands": [command_out(c) for c in pending_commands(db, host)],
        "settings": host_settings,
        "lanAlertTargets": lan_alert_targets(db, host) if host.shop_id is not None else [],
    }


def view_for(db: Session, machine: POSMachine) -> Dict[str, Any]:
    return host_view(db, machine) if is_cash_host(machine) else client_view(db, machine)


def etag_of(body: Dict[str, Any]) -> str:
    text = json.dumps(body, sort_keys=True, ensure_ascii=False, default=str, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


# ── The journal (§11.9) ────────────────────────────────────────────────────────

_TX_MONEY = (
    ("amountAgorot", "amount_agorot"), ("dueAgorot", "due_agorot"), ("insertedAgorot", "inserted_agorot"),
    ("changeDueAgorot", "change_due_agorot"), ("changePaidAgorot", "change_paid_agorot"),
    ("changeOwedAgorot", "change_owed_agorot"), ("refundDueAgorot", "refund_due_agorot"),
    ("refundPaidAgorot", "refund_paid_agorot"), ("heldAgorot", "held_agorot"),
)
#: What the row keeps of an entry beyond its columns.
_TX_DATA_KEYS = (
    "leaseId", "clientId", "hostId", "kind", "remainingAgorot", "escrowAgorot", "accepting", "exactOnly",
    "deadlineAt", "idleDeadlineAt", "message", "error", "owedId", "createdAt", "updatedAt", "doneAt",
)


class JournalRefused(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _tx_data(entry: Dict[str, Any]) -> Dict[str, Any]:
    data: Dict[str, Any] = {}
    for key in _TX_DATA_KEYS:
        value = entry.get(key)
        if value is None:
            continue
        if isinstance(value, str):
            data[key] = value[:300]
        elif isinstance(value, (bool, int, float)):
            data[key] = value
        elif isinstance(value, dict):
            text = json.dumps(value, default=str)[:2000]
            data[key] = value if len(text) < 2000 else {"raw": text}
    data["inserted"] = _clean_pieces(entry.get("inserted"))
    data["paidOut"] = _clean_pieces(entry.get("paidOut"))
    return data


def _apply_tx(db: Session, host: POSMachine, stations: Dict[Any, CashStation], entry: Dict[str, Any],
              now: datetime) -> Tuple[str, Optional[CashStationTx], bool]:
    tx_id = _uuid(entry.get("txId")) or _uuid(entry.get("id"))
    if tx_id is None:
        raise JournalRefused("missing_id")
    station = stations.get(_uuid(entry.get("stationId")))
    if station is None:
        raise JournalRefused("unknown_station")
    state = entry.get("state")
    if state not in TX_STATES:
        raise JournalRefused("invalid_state")
    outcome = entry.get("outcome") if entry.get("outcome") in OUTCOMES else None
    seq = _int(entry.get("seq"), 0, 2**62)
    row = db.get(CashStationTx, tx_id)
    if row is not None:
        if row.station_id != station.id:
            raise JournalRefused("station_mismatch")
        if seq <= (row.seq or 0):
            return str(tx_id), row, False  # an older or the same version: already have it
    else:
        row = CashStationTx(
            tx_id=tx_id, tenant_id=station.tenant_id, station_id=station.id, shop_id=station.shop_id,
            owed_status="none", created_at=_from_ms(entry.get("createdAt")) or now,
        )
        db.add(row)
    row.host_machine_id = host.id
    row.client_machine_id = _uuid(entry.get("clientId")) or row.client_machine_id
    row.state = state
    row.outcome = outcome
    for key, column in _TX_MONEY:
        setattr(row, column, _int(entry.get(key)))
    row.rounding_agorot = _int(entry.get("roundingAgorot"), -99, 99)
    row.held_reason = _str(entry.get("heldReason"), 32)
    row.cancel_reason = _str(entry.get("cancelReason"), 32)
    row.slip_code = _str(entry.get("slipCode"), 32) or row.slip_code
    row.order_ref = _str(entry.get("orderRef"), 100) or row.order_ref
    # The pickup number is known only after the document: a later entry (the kiosk's ack) may bring it.
    row.order_label = _str(entry.get("orderLabel"), 100) or row.order_label
    row.device_serial = _str(entry.get("deviceSerial"), 64)
    row.document_id = _str(entry.get("documentId"), 64) or row.document_id
    row.document_number = _str(entry.get("documentNumber"), 64) or row.document_number
    row.acked = entry.get("acked") is True
    row.seq = seq
    row.data = _tx_data(entry)
    if state in FINAL_STATES:
        row.done_at = _from_ms(entry.get("doneAt")) or _from_ms(entry.get("updatedAt")) or row.done_at or now
    row.received_at = now
    db.flush()
    return str(tx_id), row, True


def _apply_movement(db: Session, host: POSMachine, stations: Dict[Any, CashStation], entry: Dict[str, Any],
                    now: datetime) -> str:
    ident = _uuid(entry.get("id"))
    if ident is None:
        raise JournalRefused("missing_id")
    station = stations.get(_uuid(entry.get("stationId")))
    if station is None:
        raise JournalRefused("unknown_station")
    kind = entry.get("kind")
    if kind not in MOVEMENT_KINDS:
        raise JournalRefused("invalid_kind")
    existing = db.get(CashStationMovement, ident)
    if existing is not None:
        if existing.station_id != station.id:
            raise JournalRefused("station_mismatch")
        return str(ident)  # once by id
    by = entry.get("by") if isinstance(entry.get("by"), dict) else None
    db.add(CashStationMovement(
        id=ident, tenant_id=station.tenant_id, station_id=station.id, host_machine_id=host.id,
        shop_id=station.shop_id, kind=kind,
        amount_agorot=_int(entry.get("amountAgorot"), -AGOROT_MAX, AGOROT_MAX),
        expected_agorot=_opt_int(entry.get("expectedAgorot"), -AGOROT_MAX, AGOROT_MAX),
        counted_agorot=_opt_int(entry.get("countedAgorot"), 0, AGOROT_MAX),
        pieces=_clean_pieces(entry.get("pieces")),
        by=None if by is None else {"userId": _str(by.get("userId"), 64), "name": _str(by.get("name"), 100)},
        note=_str(entry.get("note"), 300),
        at=_from_ms(entry.get("at")) or now,
        received_at=now,
    ))
    db.flush()
    return str(ident)


def apply_journal(db: Session, host: POSMachine, entries: Sequence[Any], *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    The host's journal (§11.9): `{accepted: [id…], rejected: [{id, error}]}`. Idempotent by id; a
    transaction changes only with a higher `seq`; each entry on its own (one refused never stops the
    rest). The caller commits.
    """
    now = _now(now)
    stations = {s.id: s for s in stations_of_host(db, host.id, active_only=False)}
    accepted: List[str] = []
    rejected: List[Dict[str, Any]] = []
    changed: List[CashStationTx] = []
    for entry in list(entries)[:JOURNAL_MAX]:
        ident = None
        if isinstance(entry, dict):
            ident = _str(entry.get("txId") if entry.get("type") == "tx" else entry.get("id"), 64) or _str(entry.get("id"), 64)
        try:
            if not isinstance(entry, dict):
                raise JournalRefused("invalid_entry")
            with db.begin_nested():
                if entry.get("type") == "tx":
                    key, row, updated = _apply_tx(db, host, stations, entry, now)
                    if updated and row is not None:
                        changed.append(row)
                elif entry.get("type") == "movement":
                    key = _apply_movement(db, host, stations, entry, now)
                else:
                    raise JournalRefused("unknown_type")
            accepted.append(key)
        except JournalRefused as refused:
            rejected.append({"id": ident, "error": refused.code})
        except IntegrityError:
            rejected.append({"id": ident, "error": "conflict"})
    for row in changed:
        try:
            with db.begin_nested():
                sync_owed(db, row, stations.get(row.station_id), now=now)
        except Exception:  # noqa: BLE001 - the entry is stored; its owed item is retried with the next one
            logger.exception("cash: owed item of tx %s", row.tx_id)
    return {"api": API, "accepted": accepted, "rejected": rejected}


# ── Owed items (§11.8) ─────────────────────────────────────────────────────────


def owed_wanted(tx: CashStationTx) -> Optional[Tuple[str, int]]:
    """What the transaction leaves owed to the customer now: change owed (paid) or a held credit."""
    if tx.state == "DONE" and tx.outcome == "paid" and (tx.change_owed_agorot or 0) > 0:
        return "change_owed", int(tx.change_owed_agorot)
    if tx.state == "HELD" and (tx.held_agorot or 0) > 0:
        return "held_credit", int(tx.held_agorot)
    return None


def sync_owed(db: Session, tx: CashStationTx, station: Optional[CashStation], *, now: Optional[datetime] = None) -> None:
    """
    The owed item of a transaction as its last journal entry says: opened (with its `cash_unit` alert) when it
    leaves change owed or a held credit; closed `host_resolved` when a later entry no longer does; a resolved
    one is never reopened. A held credit whose kiosk document is already here closes at once.
    """
    from app.services import cash_alerts

    now = _now(now)
    if tx.owed_status == "resolved":
        return
    wanted = owed_wanted(tx)
    if wanted is None:
        if tx.owed_status == "open":
            resolve_owed(db, tx, resolution="host_resolved", now=now, note="שרת המזומן סגר את העסקה")
        return
    kind, amount = wanted
    if tx.owed_status == "open" and tx.owed_kind == kind:
        tx.owed_agorot = amount
        # Its alert says what the latest entry says (the order's number, given with the kiosk's ack).
        cash_alerts.refresh_tx_alert(db, station or db.get(CashStation, tx.station_id), tx)
        return
    if tx.owed_status == "open":
        cash_alerts.resolve_tx_alerts(db, tx, now=now, why="העסקה השתנתה")
    tx.owed_status = "open"
    tx.owed_kind = kind
    tx.owed_agorot = amount
    tx.owed_at = now
    db.flush()
    if station is None:
        station = db.get(CashStation, tx.station_id)
    if kind == "held_credit" and document_of_tx(db, tx) is not None:
        resolve_owed(db, tx, resolution="matched_document", now=now, note="מסמך הקיוסק של העסקה התקבל")
        return
    cash_alerts.open_tx_alert(db, station, tx, now=now)


def resolve_owed(
    db: Session, tx: CashStationTx, *, resolution: str, now: Optional[datetime] = None,
    machine_id: Any = None, user: Optional[Dict[str, Any]] = None, note: Optional[str] = None,
    movement_id: Any = None, shift_id: Any = None, paid_agorot: Optional[int] = None,
) -> None:
    """Close an open owed item (and its alert). The caller commits."""
    from app.services import cash_alerts

    now = _now(now)
    tx.owed_status = "resolved"
    tx.resolved_at = now
    tx.resolution = resolution
    tx.resolved_by_machine_id = machine_id
    tx.resolved_by_user = user
    tx.resolution_note = _str(note, 300)
    tx.movement_id = movement_id
    tx.paid_shift_id = shift_id
    tx.paid_agorot = paid_agorot
    db.flush()
    cash_alerts.resolve_tx_alerts(db, tx, now=now, why=RESOLUTION_LABELS.get(resolution, resolution))


RESOLUTION_LABELS = {
    "paid_out": "שולם ללקוח בקופה",
    "applied": "קוזז בהזמנה",
    "written_off": "נמחק",
    "matched_document": "מסמך הקיוסק התקבל",
    "host_resolved": "נסגר בשרת המזומן",
}


def default_alert_till(db: Session, shop_id: Any) -> Optional[POSMachine]:
    """'' in `cashAlertTills`: the shop's main till — a till; else the shop's first till (never a kiosk)."""
    from app.services.display_devices import is_fiscal
    from app.services.main_till import main_till_of_shop, till_order

    main = main_till_of_shop(db, shop_id)
    if main is not None and is_fiscal(main) and not _is_kiosk(db, main):
        return main
    tills = [m for m in _shop_devices(db, shop_id) if not _is_kiosk(db, m)]
    return sorted(tills, key=till_order)[0] if tills else None


def alert_tills(db: Session, station: CashStation, settings: Optional[Dict[str, Any]] = None) -> List[POSMachine]:
    """The tills of `cashAlertTills` for this station (active tills of its shop); none valid — the main till."""
    settings = settings if settings is not None else station_settings(db, station)
    wanted = [_uuid(x) for x in settings.get(CP.ALERT_TILLS_KEY) or []]
    wanted = [w for w in wanted if w is not None]
    if wanted:
        found = [m for m in _shop_devices(db, station.shop_id) if m.id in wanted and not _is_kiosk(db, m)]
        if found:
            return found
    default = default_alert_till(db, station.shop_id)
    return [default] if default is not None else []


def stations_alerting(db: Session, till: POSMachine) -> List[CashStation]:
    """The stations of the till's shop (active or not — what they owe is still owed) that alert this till."""
    if till.shop_id is None or getattr(till, "is_fiscal", True) is False:
        return []
    out = []
    for station in stations_of_shop(db, till.shop_id, active_only=False):
        if till.id in {m.id for m in alert_tills(db, station)}:
            out.append(station)
    return out


def _client_names(db: Session, ids: Iterable[Any]) -> Dict[Any, Optional[str]]:
    ids = [i for i in set(ids) if i is not None]
    if not ids:
        return {}
    return {m.id: m.name for m in db.query(POSMachine).filter(POSMachine.id.in_(ids)).all()}


def owed_item(tx: CashStationTx, station: Optional[CashStation], client_name: Optional[str] = None) -> Dict[str, Any]:
    out = {
        "id": str(tx.tx_id),
        "kind": tx.owed_kind,
        "stationId": str(tx.station_id),
        "stationName": station.name if station is not None else None,
        "txId": str(tx.tx_id),
        "slipCode": tx.slip_code,
        "amountAgorot": int(tx.owed_agorot or 0),
        "orderLabel": tx.order_label,
        "clientName": client_name,
        "createdAt": _iso(tx.owed_at or tx.created_at),
    }
    if tx.owed_status == "resolved":
        out.update({
            "resolvedAt": _iso(tx.resolved_at),
            "resolution": tx.resolution,
            "resolvedBy": resolved_by_text(tx),
            "movementId": str(tx.movement_id) if tx.movement_id else None,
        })
    return out


def resolved_by_text(tx: CashStationTx) -> Optional[str]:
    user = tx.resolved_by_user if isinstance(tx.resolved_by_user, dict) else {}
    name = user.get("name")
    if tx.resolution == "paid_out":
        till = user.get("tillName")
        return " · ".join(p for p in (name, till) if p) or "קופה"
    if tx.resolution in ("applied", "written_off"):
        return f"דשבורד: {name}" if name else "דשבורד"
    return RESOLUTION_LABELS.get(tx.resolution or "", tx.resolution)


def owed_items_for_till(db: Session, till: POSMachine) -> List[Dict[str, Any]]:
    """`GET /sync/{till}/cash/owed`: the open items of the stations that alert this till, oldest first."""
    stations = {s.id: s for s in stations_alerting(db, till)}
    if not stations:
        return []
    rows = (
        db.query(CashStationTx)
        .filter(CashStationTx.station_id.in_(list(stations)), CashStationTx.owed_status == "open")
        .order_by(CashStationTx.owed_at, CashStationTx.tx_id)
        .all()
    )
    names = _client_names(db, [r.client_machine_id for r in rows])
    return [owed_item(r, stations.get(r.station_id), names.get(r.client_machine_id)) for r in rows]


def owed_etag(items: Sequence[Dict[str, Any]]) -> str:
    text = "|".join(f"{i['id']}:{i['amountAgorot']}:{i['kind']}" for i in items)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def heartbeat_owed(db: Session, till: POSMachine) -> Optional[Dict[str, Any]]:
    """
    `cashOwed: {count, etag}` for a till some station alerts (§11.8); None for a device of a shop with no cash
    station, or one no station alerts. With nothing owed in the whole shop every till of it hears `count: 0`
    (cheap: which tills a station alerts is worked out only while something is owed).
    """
    if till.shop_id is None or getattr(till, "is_fiscal", True) is False:
        return None
    if not db.query(CashStation.id).filter(CashStation.shop_id == till.shop_id).first():
        return None
    if not db.query(CashStationTx.tx_id).filter(
        CashStationTx.shop_id == till.shop_id, CashStationTx.owed_status == "open",
    ).first():
        return {"count": 0, "etag": owed_etag([])}
    if not stations_alerting(db, till):
        return None
    items = owed_items_for_till(db, till)
    return {"count": len(items), "etag": owed_etag(items)}


def _refuse(status_code: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message, **extra})


def pay_owed(db: Session, till: POSMachine, owed_id: Any, body: Dict[str, Any], *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    "שולם ללקוח" (§11.8): the till pays the item out of its drawer. Idempotent by `movementId` (the same one
    again answers the same); paid or resolved otherwise — 409 `already_resolved {resolvedBy, resolvedAt}`.
    Only a till the item's station alerts. The caller commits.
    """
    from app.models.shift import Shift, ShiftStatus

    now = _now(now)
    tx = db.get(CashStationTx, _uuid(owed_id)) if _uuid(owed_id) is not None else None
    station = db.get(CashStation, tx.station_id) if tx is not None else None
    if tx is None or station is None or station.shop_id != till.shop_id or tx.owed_status == "none":
        raise _refuse(status.HTTP_404_NOT_FOUND, "owed_not_found", "החוב לא נמצא.")
    if till.id not in {m.id for m in alert_tills(db, station)}:
        raise _refuse(status.HTTP_403_FORBIDDEN, "not_alert_till", "הקופה הזו לא מקבלת את החובות של עמדת המזומן.")
    movement_id = _uuid(body.get("movementId"))
    if movement_id is None:
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "movement_id", "חסר מזהה תנועה (movementId).")
    if tx.owed_status == "resolved":
        if tx.movement_id == movement_id:
            return {"ok": True, "item": owed_item(tx, station, _client_names(db, [tx.client_machine_id]).get(tx.client_machine_id))}
        raise _refuse(
            status.HTTP_409_CONFLICT, "already_resolved", "החוב כבר נסגר.",
            resolvedBy=resolved_by_text(tx), resolvedAt=_iso(tx.resolved_at), resolution=tx.resolution,
        )
    other = db.query(CashStationTx.tx_id).filter(CashStationTx.movement_id == movement_id).first()
    if other is not None:
        raise _refuse(status.HTTP_409_CONFLICT, "movement_conflict", "מזהה התנועה כבר שימש לחוב אחר.")
    amount = body.get("amountAgorot")
    if amount is not None and _opt_int(amount, 0, AGOROT_MAX) != int(tx.owed_agorot or 0):
        raise _refuse(
            status.HTTP_409_CONFLICT, "amount_mismatch", "הסכום אינו סכום החוב.", amountAgorot=int(tx.owed_agorot or 0),
        )
    shift_id = _uuid(body.get("shiftId"))
    if shift_id is not None:
        shift = db.get(Shift, shift_id)
        if shift is not None and (shift.machine_id != till.id or shift.status != ShiftStatus.OPEN):
            raise _refuse(status.HTTP_409_CONFLICT, "shift_not_open", "המשמרת אינה פתוחה בקופה הזו.")
    resolve_owed(
        db, tx, resolution="paid_out", now=now, machine_id=till.id,
        user={"userId": _str(body.get("userId"), 64), "name": _str(body.get("userName"), 100), "tillName": till.name},
        movement_id=movement_id, shift_id=shift_id, paid_agorot=int(tx.owed_agorot or 0),
    )
    return {"ok": True, "item": owed_item(tx, station, _client_names(db, [tx.client_machine_id]).get(tx.client_machine_id))}


# ── Kiosk documents (§11.7) ────────────────────────────────────────────────────


def cash_device_of(leg: Any) -> Optional[Dict[str, Any]]:
    meta = getattr(leg, "nayax_meta", None)
    block = meta.get("cashDevice") if isinstance(meta, dict) else None
    return block if isinstance(block, dict) else None


def document_of_tx(db: Session, tx: CashStationTx) -> Optional[Any]:
    """The kiosk document paid by this transaction (`payments[].cashDevice.txId`), if it is here."""
    from app.models.transaction import Transaction
    from app.models.transaction_payment import TransactionPayment

    if tx.client_machine_id is None:
        return None
    since = (_aware(tx.created_at) or _now()) - MATCH_WINDOW
    legs = (
        db.query(TransactionPayment)
        .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
        .filter(
            Transaction.machine_id == tx.client_machine_id,
            Transaction.created_at >= since,
            TransactionPayment.method == "cash",
        )
        .all()
    )
    wanted = str(tx.tx_id)
    for leg in legs:
        block = cash_device_of(leg)
        if block is not None and str(block.get("txId") or "").lower() == wanted:
            return leg
    return None


def match_documents(db: Session, transaction_ids: Sequence[Any], *, now: Optional[datetime] = None) -> int:
    """
    Documents just stored: a cash leg that names a station transaction links it, and closes its held credit
    (`matched_document`). Returns how many items closed. The caller commits.
    """
    from app.models.transaction import Transaction
    from app.models.transaction_payment import TransactionPayment

    ids = [i for i in transaction_ids if i is not None]
    if not ids:
        return 0
    legs = (
        db.query(TransactionPayment, Transaction)
        .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
        .filter(TransactionPayment.transaction_id.in_(ids), TransactionPayment.method == "cash")
        .all()
    )
    by_tx: Dict[uuid.UUID, Any] = {}
    for leg, doc in legs:
        block = cash_device_of(leg)
        tx_id = _uuid(block.get("txId")) if block else None
        if tx_id is not None:
            by_tx[tx_id] = doc
    if not by_tx:
        return 0
    closed = 0
    for row in db.query(CashStationTx).filter(CashStationTx.tx_id.in_(list(by_tx))).all():
        doc = by_tx[row.tx_id]
        row.document_id = row.document_id or str(doc.id)
        row.document_number = row.document_number or doc.transaction_number
        if row.owed_status == "open" and row.owed_kind == "held_credit":
            resolve_owed(db, row, resolution="matched_document", now=now, note="מסמך הקיוסק של העסקה התקבל")
            closed += 1
    db.flush()
    return closed


def match_documents_safely(db: Session, transaction_ids: Sequence[Any]) -> None:
    """`match_documents` after a push committed; never fails it (a later journal entry finds it again)."""
    try:
        if not ids_with_cash(db, transaction_ids):
            return
        match_documents(db, transaction_ids)
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("cash: matching documents to station transactions failed")


def ids_with_cash(db: Session, transaction_ids: Sequence[Any]) -> bool:
    """Whether any of these documents has a cash leg from a station (cheap pre-check)."""
    from app.models.transaction_payment import TransactionPayment

    ids = [i for i in transaction_ids if i is not None]
    if not ids:
        return False
    for leg in db.query(TransactionPayment).filter(
        TransactionPayment.transaction_id.in_(ids), TransactionPayment.method == "cash",
    ).all():
        if cash_device_of(leg) is not None:
            return True
    return False


_ID = re.compile(r"^[A-Za-z0-9_.:\-]{1,64}$")


def _id_text(value: Any) -> Optional[str]:
    """An id as the leg keeps it: a UUID canonical (lower case), else a short id string as sent, else None."""
    ident = _uuid(value)
    if ident is not None:
        return str(ident)
    return value.strip() if isinstance(value, str) and _ID.match(value.strip()) else None


def clean_cash_device(raw: Any) -> Optional[Dict[str, Any]]:
    """A document leg's `cashDevice` (§11.7), field by field; nothing usable — None (never a refused document)."""
    if not isinstance(raw, dict):
        return None
    tx_id = _id_text(raw.get("txId"))
    if tx_id is None:
        return None
    return {
        "txId": tx_id,
        "stationId": _id_text(raw.get("stationId")),
        "hostId": _id_text(raw.get("hostId")),
        "receivedAgorot": _int(raw.get("receivedAgorot")),
        "changeAgorot": _int(raw.get("changeAgorot")),
        "changeOwedAgorot": _int(raw.get("changeOwedAgorot")),
        "roundingAgorot": _int(raw.get("roundingAgorot"), -99, 99),
        "slipCode": _str(raw.get("slipCode"), 32),
    }


# ── Commands ───────────────────────────────────────────────────────────────────


def command_out(row: CashHostCommand) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "stationId": str(row.station_id),
        "op": row.op,
        "args": row.args or {},
        "by": row.by,
        "createdAt": _iso(row.created_at),
        "status": row.status,
        "message": row.message,
        "movementId": str(row.movement_id) if row.movement_id else None,
        "ackedAt": _iso(row.acked_at),
    }


def pending_commands(db: Session, host: POSMachine) -> List[CashHostCommand]:
    return (
        db.query(CashHostCommand)
        .filter(CashHostCommand.host_machine_id == host.id, CashHostCommand.status == "pending")
        .order_by(CashHostCommand.created_at, CashHostCommand.id)
        .limit(COMMANDS_MAX)
        .all()
    )


def clean_command_args(op: str, raw: Any) -> Dict[str, Any]:
    from app.models.cash_station import NO_ARG_OPS

    if op in NO_ARG_OPS:
        return {}
    raw = raw if isinstance(raw, dict) else {}
    out: Dict[str, Any] = {}
    pieces = []
    for item in (raw.get("pieces") if isinstance(raw.get("pieces"), list) else [])[:LIST_MAX]:
        if not isinstance(item, dict):
            continue
        value = _opt_int(item.get("valueAgorot"), 1, 10_000_000)
        if value not in CP.ILS_COINS + CP.ILS_NOTES:
            raise ValueError("pieces: valueAgorot must be a coin or a note in agorot")
        pieces.append({"valueAgorot": value, "count": _int(item.get("count"), 0, 1_000_000)})
    if pieces:
        out["pieces"] = pieces
    if raw.get("countedAgorot") is not None:
        counted = _opt_int(raw.get("countedAgorot"), 0, AGOROT_MAX)
        if counted is None:
            raise ValueError("countedAgorot must be agorot")
        out["countedAgorot"] = counted
    note = _str(raw.get("note"), 300)
    if note:
        out["note"] = note
    if op == "dump":
        # One denomination's dispenser emptied into the cashbox (`valueAgorot`), all of it or `notes` of it.
        if raw.get("valueAgorot") is not None:
            value = _opt_int(raw.get("valueAgorot"), 1, 10_000_000)
            if isinstance(raw.get("valueAgorot"), bool) or value not in CP.ILS_COINS + CP.ILS_NOTES:
                raise ValueError("valueAgorot must be a coin or a note in agorot")
            out["valueAgorot"] = value
        if raw.get("notes") is not None:
            count = raw.get("notes")
            if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 100_000:
                raise ValueError("notes must be a whole number 1–100000")
            out["notes"] = count
    return out


def create_command(db: Session, user: Any, station: CashStation, op: str, args: Any) -> CashHostCommand:
    """A command for the station's host, delivered with its next pull (and woken now). The caller commits."""
    if op not in COMMAND_OPS:
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_op", f"פעולה לא מוכרת: {op}.")
    if not station.is_active:
        raise _refuse(status.HTTP_409_CONFLICT, "station_inactive", "העמדה לא פעילה.")
    host = host_of(db, station)
    if host is None:
        raise _refuse(status.HTTP_409_CONFLICT, "station_has_no_host", "לעמדה אין שרת מזומן — בחרו שרת לעמדה.")
    try:
        cleaned = clean_command_args(op, args)
    except ValueError as exc:
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_args", str(exc)) from None
    row = CashHostCommand(
        id=uuid.uuid4(), tenant_id=station.tenant_id, host_machine_id=host.id, station_id=station.id, op=op,
        args=cleaned,
        by={"userId": str(getattr(user, "id", "") or "") or None,
            "name": getattr(user, "username", None) or getattr(user, "email", None)},
        status="pending", created_at=_now(),
    )
    db.add(row)
    db.flush()
    wake(host, "cash_command")
    return row


def ack_command(db: Session, host: POSMachine, command_id: Any, body: Dict[str, Any], *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """`POST /sync/{host}/cash/commands/{id}/ack`: done / refused / failed, once (a repeat answers as it stands)."""
    row = db.get(CashHostCommand, _uuid(command_id)) if _uuid(command_id) is not None else None
    if row is None or row.host_machine_id != host.id:
        raise _refuse(status.HTTP_404_NOT_FOUND, "unknown_command", "הפקודה לא נמצאה.")
    wanted = body.get("status")
    if wanted not in ("done", "refused", "failed"):
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_status", "status: done | refused | failed.")
    if row.status == "pending":
        row.status = wanted
        row.message = _str(body.get("message"), 300)
        row.movement_id = _uuid(body.get("movementId"))
        row.acked_at = _now(now)
        db.flush()
    return {"api": API, "ok": True, "command": command_out(row)}


def wake(machine: Optional[POSMachine], reason: str) -> None:
    if machine is None:
        return
    from app.services.kiosk_ops import wake_machine

    wake_machine(machine, reason)
