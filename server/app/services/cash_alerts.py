"""
"התראות מכשיר מזומן" — the cash stations' alerts (P:/specs/cash-paylink.md §5, §9א, §11.8, §11.9).

One exception kind, `cash_unit` ("מכשיר מזומן"), written as `audit_exceptions` rows — so, like every
exception, it reaches the exceptions log, the problems screen ("מכשירים") and the phone alerts (push
category `cash`, on by default) through the existing hooks. One row per (station, code, unit) while it
lasts (`dedupe_key` `cash_unit:<station>:<code>:<unit>:<opened ms>`), closed by itself
(`details.resolvedAt`) when it is over. The text always names the station:
"עמדת מזומן 2 (ליד קיוסק 3): עודף נמוך".

Where they come from (`details.source`):

* `heartbeat` — the codes the cash host reports per station (`cash.stations[].alerts`, §11.9): opened when
  reported, closed when a later beat no longer reports them (`reconcile_heartbeat`);
* `journal` — `change_owed` / `held_credit`, per transaction (unit `tx:<txId>`): opened with the owed item,
  closed when it is resolved (cash_stations.py `sync_owed` / `resolve_owed`). The host's own report of
  these two codes is not used: the journal is their source;
* `watch` — `offline`: a host with active stations not heard for 3 minutes (`scan_offline`, the exception
  alerts' minute pass); closed when it beats again.

The same routing as the owner set for every cash alert (§9א): the manager (the log, push) and the tills
of the station's `cashAlertTills` ('' = the main till) — in the kiosk alerts list they already fetch
(`GET /sync/{till}/kiosk/alerts`, ids `cash:<row>`, kind `cash`, `alerts_for_till`), woken when one opens;
"הבנתי" there marks it (`acknowledge`) — it stays open until the unit recovers.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Sequence

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.audit_exception import AuditException
from app.models.pos_machine import POSMachine

logger = logging.getLogger(__name__)

EXCEPTION_TYPE = "cash_unit"
LABEL = "מכשיר מזומן"
ID_PREFIX = "cash:"
ALERT_KIND = "cash"
OFFLINE = "offline"
OFFLINE_AFTER = timedelta(minutes=3)
#: A host silent longer than this when first noticed is a device problem, not news.
LOOKBACK = timedelta(days=1)
SOURCE_HEARTBEAT = "heartbeat"
SOURCE_JOURNAL = "journal"
SOURCE_WATCH = "watch"
#: A kiosk reported it (kiosk/sync `status.alerts` kind "cash"): one per (station, kiosk), closed when it stops.
SOURCE_KIOSK = "kiosk"
KIOSK_CODE = "unreachable"
#: Their source is the journal (one per transaction), never the host's own report.
JOURNAL_CODES = ("change_owed", "held_credit")

#: §11.9's codes, as the alerts say them.
CODE_LABELS: Dict[str, str] = {
    "offline": "שרת המזומן לא מחובר",
    "driver_missing": "דרייבר מזומן לא מותקן",
    "driver_down": "דרייבר המזומן נפל",
    "device_offline": "המכשיר לא מחובר",
    "consistency": "שגיאת עקביות",
    "jam": "תקיעה",
    "fraud": "ניסיון הונאה",
    "door_open": "דלת פתוחה",
    "stacker_full": "קופסת השטרות מלאה",
    "cashbox_removed": "הקופסה הוסרה",
    "cashbox_near_full": "הקופסה כמעט מלאה",
    "hopper_low": "עודף נמוך",
    "hopper_empty": "העודף אזל",
    "change_low": "עודף נמוך",
    "bills_pending": "שטרות ממתינים במכשיר",
    "des_lock": "המכשיר נעול (DES)",
    "held_credit": "זיכוי מוחזק",
    "change_owed": "עודף חייב ללקוח",
    "unacked": "עסקה ששולמה ולא אושרה",
    # A kiosk's own report (kiosk/sync `status.alerts`, kind "cash"): it cannot reach its station on the LAN.
    "unreachable": "הקיוסק לא מגיע לעמדת המזומן",
}
SEVERITIES: Dict[str, str] = {
    "offline": "high", "driver_missing": "high", "driver_down": "high", "device_offline": "high",
    "consistency": "high", "jam": "high", "fraud": "high", "stacker_full": "high", "cashbox_removed": "high",
    "hopper_empty": "high", "des_lock": "high", "held_credit": "high",
    "door_open": "medium", "change_owed": "medium", "unacked": "medium", "hopper_low": "medium",
    "change_low": "medium", "bills_pending": "medium", "cashbox_near_full": "low", "unreachable": "high",
}


def _now(now: Optional[datetime] = None) -> datetime:
    return now or datetime.now(timezone.utc)


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _iso(moment: Any) -> Optional[str]:
    if isinstance(moment, str):
        return moment
    m = _aware(moment)
    return m.isoformat() if m is not None else None


def label_of(code: str) -> str:
    """A code the cloud does not know reads as a fault (§11.11)."""
    return CODE_LABELS.get(code) or f"תקלה במכשיר המזומן ({code})"


def alert_text(station: Any, code: str, message: Optional[str] = None) -> str:
    from app.services.cash_stations import station_label

    return f"{station_label(station)}: {message or label_of(code)}"[:300]


def is_open(row: AuditException) -> bool:
    return not (row.details or {}).get("resolvedAt")


def _prefix(station_id: Any) -> str:
    return f"{EXCEPTION_TYPE}:{station_id}:"


#: An open alert a manager already marked (no longer `new`) is still looked at this far back.
OPEN_WINDOW = timedelta(days=60)


def _open_candidates(query, now: Optional[datetime] = None):
    """
    Narrowed in SQL to what may be open: every `new` row (a closed one never is — closing marks it handled),
    and any row of the last `OPEN_WINDOW` (one a manager marked while it lasts). `is_open` decides.
    """
    from sqlalchemy import or_

    return query.filter(or_(AuditException.status == "new", AuditException.occurred_at >= _now(now) - OPEN_WINDOW))


def rows_of_station(db: Session, station_id: Any, *, open_only: bool = True) -> List[AuditException]:
    query = db.query(AuditException).filter(
        AuditException.exception_type == EXCEPTION_TYPE, AuditException.dedupe_key.like(_prefix(station_id) + "%"),
    )
    if open_only:
        query = _open_candidates(query)
    rows = query.order_by(AuditException.occurred_at).all()
    return [r for r in rows if is_open(r)] if open_only else rows


def resolve(row: AuditException, now: datetime, why: str) -> None:
    from app.services.exception_alerts.status_watch import resolve as _resolve

    _resolve(row, now, why)


# ── Opening one ────────────────────────────────────────────────────────────────


def open_alert(
    db: Session, station: Any, *, code: str, unit: str = "", message: Optional[str] = None, source: str,
    now: Optional[datetime] = None, occurred_at: Optional[datetime] = None, host: Optional[POSMachine] = None,
    tx_id: Any = None, amount_agorot: Optional[int] = None, extra: Optional[Dict[str, Any]] = None,
) -> Optional[AuditException]:
    """
    One `cash_unit` alert for (station, code, unit) — none while one is open. Wakes the station's alert
    tills. The caller commits. None when it was open already (or another process wrote it first).
    """
    from app.models.shop import Shop
    from app.services.cash_stations import host_of

    now = _now(now)
    unit = unit or ""
    for row in rows_of_station(db, station.id):
        details = row.details or {}
        if details.get("code") == code and (details.get("unit") or "") == unit:
            return None
    host = host if host is not None else host_of(db, station)
    shop = db.get(Shop, station.shop_id)
    when = _aware(occurred_at) or now
    row = AuditException(
        id=uuid.uuid4(),
        tenant_id=station.tenant_id,
        company_id=station.company_id or (shop.company_id if shop is not None else None),
        shop_id=station.shop_id,
        area_id=getattr(host, "area_id", None),
        machine_id=host.id if host is not None else None,
        exception_type=EXCEPTION_TYPE,
        severity=SEVERITIES.get(code, "high"),
        dedupe_key=f"{_prefix(station.id)}{code}:{unit}:{int(now.timestamp() * 1000)}"[:200],
        amount=(Decimal(int(amount_agorot)) / 100).quantize(Decimal("0.01")) if amount_agorot else None,
        details={
            "summary": alert_text(station, code, message),
            "stationId": str(station.id),
            "stationName": station.name,
            "location": station.location,
            "hostId": str(host.id) if host is not None else None,
            "code": code,
            "unit": unit,
            "message": message,
            "source": source,
            "txId": str(tx_id) if tx_id else None,
            "resolvedAt": None,
            "tillAck": None,
            **(extra or {}),
        },
        occurred_at=when,
        detected_at=now,
        status="new",
    )
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        return None
    wake_tills(db, station)
    return row


def wake_tills(db: Session, station: Any) -> None:
    """A new cash alert: its tills fetch their alerts now (never fails the caller)."""
    try:
        from app.services.cash_stations import alert_tills, wake

        for till in alert_tills(db, station):
            wake(till, "cash_alert")
    except Exception:  # noqa: BLE001 - the tills fetch on their beat anyway
        logger.exception("cash alert wake-up failed for station %s", getattr(station, "id", None))


# ── Per transaction (the journal) ──────────────────────────────────────────────


def tx_message(tx: Any) -> str:
    """"עודף חייב ללקוח — הזמנה 57: 13 ₪ · C-K7Q3MX" / "זיכוי מוחזק: 20 ₪ · הזמנה 57"."""
    from app.services.cash_stations import money_text

    amount = money_text(tx.owed_agorot)
    order = f"הזמנה {tx.order_label}" if tx.order_label else None
    if tx.owed_kind == "change_owed":
        message = f"{label_of('change_owed')}" + (f" — {order}" if order else "") + f": {amount}"
    else:
        message = f"{label_of('held_credit')}: {amount}" + (f" · {order}" if order else "")
    if tx.slip_code:
        message += f" · {tx.slip_code}"
    return message


def refresh_tx_alert(db: Session, station: Any, tx: Any) -> None:
    """The open alert of an owed item, worded as its latest journal entry says (the amount, the order's number)."""
    if station is None:
        return
    message = tx_message(tx)
    for row in rows_of_station(db, station.id):
        details = row.details or {}
        if details.get("source") == SOURCE_JOURNAL and details.get("txId") == str(tx.tx_id) and details.get("message") != message:
            row.details = {**details, "message": message, "summary": alert_text(station, tx.owed_kind, message),
                           "orderLabel": tx.order_label, "slipCode": tx.slip_code}
            if tx.owed_agorot:
                row.amount = (Decimal(int(tx.owed_agorot)) / 100).quantize(Decimal("0.01"))


def open_tx_alert(db: Session, station: Any, tx: Any, *, now: Optional[datetime] = None) -> Optional[AuditException]:
    """"עודף חייב ללקוח — הזמנה 57: 13 ₪" / "זיכוי מוחזק: 20 ₪ · הזמנה 57", once per transaction."""
    if station is None or tx.owed_kind not in JOURNAL_CODES:
        return None
    message = tx_message(tx)
    return open_alert(
        db, station, code=tx.owed_kind, unit=f"tx:{tx.tx_id}", message=message, source=SOURCE_JOURNAL, now=now,
        tx_id=tx.tx_id, amount_agorot=tx.owed_agorot,
        extra={"heldReason": tx.held_reason, "orderLabel": tx.order_label, "slipCode": tx.slip_code},
    )


def resolve_tx_alerts(db: Session, tx: Any, *, now: Optional[datetime] = None, why: str = "") -> int:
    closed = 0
    for row in rows_of_station(db, tx.station_id):
        details = row.details or {}
        if details.get("source") == SOURCE_JOURNAL and details.get("txId") == str(tx.tx_id):
            resolve(row, _now(now), why or "החוב נסגר")
            closed += 1
    return closed


# ── The host's heartbeat ────────────────────────────────────────────────────────


def reconcile_heartbeat(db: Session, host: POSMachine, report: Dict[str, Any], *, now: Optional[datetime] = None) -> None:
    """
    Per station this host runs: an alert for each (code, unit) it reports and none is open for; an open one it no
    longer reports, closed. The host is heard: its stations' `offline` alerts close. A station the report does not
    mention is left as it is (the host may not have opened it yet).
    """
    from app.services.cash_stations import _uuid, stations_of_host

    now = _now(now)
    stations = {s.id: s for s in stations_of_host(db, host.id)}
    for station in stations.values():
        for row in rows_of_station(db, station.id):
            if (row.details or {}).get("code") == OFFLINE:
                resolve(row, now, "שרת המזומן חזר לדווח")
    for item in report.get("stations") or []:
        station = stations.get(_uuid(item.get("stationId")))
        if station is None:
            continue
        reported = {
            (a["code"], a.get("unit") or ""): a for a in item.get("alerts") or []
            if a["code"] not in JOURNAL_CODES and a["code"] != OFFLINE
        }
        open_rows = [r for r in rows_of_station(db, station.id) if (r.details or {}).get("source") == SOURCE_HEARTBEAT]
        held = {((r.details or {}).get("code"), (r.details or {}).get("unit") or ""): r for r in open_rows}
        for key, alert in reported.items():
            if key in held:
                continue
            since = alert.get("since")
            occurred = datetime.fromtimestamp(since / 1000, tz=timezone.utc) if since else None
            if occurred is not None and occurred > now:
                occurred = now
            open_alert(
                db, station, code=key[0], unit=key[1], message=alert.get("message"), source=SOURCE_HEARTBEAT,
                now=now, occurred_at=occurred, host=host,
            )
        for key, row in held.items():
            if key not in reported:
                resolve(row, now, "שרת המזומן דיווח שהתקלה עברה")


# ── A kiosk's own report ───────────────────────────────────────────────────────


def _kiosk_station(db: Session, kiosk: POSMachine, detail: Dict[str, Any]) -> Any:
    """The station the kiosk names (an active station of its shop), else the one it resolves to."""
    from app.services.cash_stations import _uuid, get_station, station_of_client

    station_id = _uuid(detail.get("stationId"))
    named = get_station(db, station_id) if station_id is not None else None
    if named is not None and named.is_active and named.shop_id == kiosk.shop_id:
        return named
    return station_of_client(db, kiosk)


def open_kiosk_alert(db: Session, kiosk: POSMachine, kiosk_name: str, alert: Any, *, now: Optional[datetime] = None) -> Optional[AuditException]:
    """
    A kiosk says it cannot reach its cash station (the Android / Windows kiosk's own alert, kind "cash"): a
    `cash_unit` alert of that station — the manager (push + problems) and the station's alert tills, as every
    cash alert (§9א). One per (station, kiosk) while it lasts. The caller commits.
    """
    detail = alert.detail if isinstance(getattr(alert, "detail", None), dict) else {}
    station = _kiosk_station(db, kiosk, detail)
    if station is None:
        return None
    # The kiosk's line as the tills read it ("קיוסק 3 — עמדת המזומן קופה ראשית לא עונה"), its name first.
    message = (getattr(alert, "text", None) or "").strip() or f"{kiosk_name or 'קיוסק'} — {label_of(KIOSK_CODE)}"
    return open_alert(
        db, station, code=KIOSK_CODE, unit=f"kiosk:{kiosk.id}", message=message, source=SOURCE_KIOSK, now=now,
        extra={"kioskMachineId": str(kiosk.id), "kioskName": kiosk_name, "kioskReason": getattr(alert, "reason", None)},
    )


def resolve_kiosk_alerts(db: Session, kiosk: POSMachine, *, now: Optional[datetime] = None) -> int:
    """The kiosk stopped reporting it: its stations' `unreachable` alerts for this kiosk close."""
    from app.services.cash_stations import stations_of_shop

    closed = 0
    unit = f"kiosk:{kiosk.id}"
    for station in stations_of_shop(db, kiosk.shop_id, active_only=False) if kiosk.shop_id is not None else []:
        for row in rows_of_station(db, station.id):
            details = row.details or {}
            if details.get("source") == SOURCE_KIOSK and details.get("unit") == unit:
                resolve(row, _now(now), "הקיוסק מגיע שוב לעמדת המזומן")
                closed += 1
    return closed


# ── The offline watch ─────────────────────────────────────────────────────────


def scan_offline(db: Session, *, now: Optional[datetime] = None) -> int:
    """
    One pass (every minute, app/services/exception_alerts/worker.py): a cash host with active stations not
    heard for 3 minutes — `offline` on each of its stations; heard again — closed. Returns rows written or
    closed. The caller commits.
    """
    from app.models.cash_station import CashStation
    from app.services.cash_stations import stations_of_host
    from app.services.machine_status import is_online

    now = _now(now)
    changed = 0
    from sqlalchemy import or_

    from app.services.cash_host import hosts_cash

    hosts = (
        db.query(POSMachine)
        .filter(
            # A dedicated cash host, or a host kiosk (P:/specs/cash-paylink.md §14.1).
            or_(POSMachine.is_cash_host.is_(True), POSMachine.cash_host_embedded.is_(True)),
            POSMachine.is_active.is_(True),
            POSMachine.last_heartbeat_at.isnot(None),
            POSMachine.id.in_(db.query(CashStation.host_machine_id).filter(CashStation.is_active.is_(True))),
        )
        .all()
    )
    for host in hosts:
        if not hosts_cash(host):
            continue
        beat = _aware(host.last_heartbeat_at)
        silent = beat is not None and now - beat >= OFFLINE_AFTER and now - beat <= LOOKBACK
        for station in stations_of_host(db, host.id):
            if silent:
                if open_alert(db, station, code=OFFLINE, source=SOURCE_WATCH, now=now, occurred_at=beat, host=host,
                              extra={"offlineSince": _iso(beat)}) is not None:
                    changed += 1
            elif is_online(beat, now=now):
                for row in rows_of_station(db, station.id):
                    if (row.details or {}).get("code") == OFFLINE:
                        resolve(row, now, "שרת המזומן חזר לדווח")
                        changed += 1
    db.flush()
    return changed


# ── The tills (§11.8) ─────────────────────────────────────────────────────────


def alert_out(row: AuditException, station: Any) -> Dict[str, Any]:
    """One cash alert in the kiosk alerts' shape (`kioskMachineId` = the station, as the host's LAN copy says)."""
    details = row.details or {}
    ack = details.get("tillAck") if isinstance(details.get("tillAck"), dict) else None
    return {
        "id": f"{ID_PREFIX}{row.id}",
        "kioskMachineId": details.get("stationId"),
        "kioskName": details.get("stationName") or getattr(station, "name", None),
        "kind": ALERT_KIND,
        "key": f"{details.get('code')}:{details.get('unit') or ''}",
        "reason": details.get("code"),
        "severity": row.severity,
        "text": details.get("summary") or alert_text(station, details.get("code") or ""),
        "detail": {
            "stationId": details.get("stationId"),
            "code": details.get("code"),
            "unit": details.get("unit") or "",
            "hostId": details.get("hostId"),
            "txId": details.get("txId"),
        },
        "raisedAt": _iso(row.occurred_at),
        "pingCount": 0,
        "pingedAt": None,
        "acknowledgedAt": ack.get("at") if ack else None,
        "acknowledgedBy": ack.get("by") if ack else None,
        "audience": "everyone",
    }


def alerts_for_till(db: Session, till: POSMachine, *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """The open cash alerts of the stations whose `cashAlertTills` name this till (or whose main till it is)."""
    from app.services.cash_stations import stations_alerting

    if till.shop_id is None:
        return []
    rows = [
        r for r in _open_candidates(
            db.query(AuditException).filter(
                AuditException.exception_type == EXCEPTION_TYPE, AuditException.shop_id == till.shop_id,
            ),
            now,
        ).order_by(AuditException.occurred_at).all()
        if is_open(r)
    ]
    if not rows:
        return []  # nothing open: which tills they would go to is not worked out
    stations = {str(s.id): s for s in stations_alerting(db, till)}
    return [alert_out(r, stations[(r.details or {}).get("stationId")]) for r in rows
            if (r.details or {}).get("stationId") in stations]


def acknowledge(db: Session, till: POSMachine, alert_id: str, *, pos_user_name: Optional[str] = None,
                now: Optional[datetime] = None) -> Dict[str, Any]:
    """"הבנתי" on a cash alert routed to [till]: marked, still open until the unit recovers. Idempotent."""
    from app.services.cash_stations import alert_tills, get_station

    try:
        rid = uuid.UUID(str(alert_id)[len(ID_PREFIX):])
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="alert_not_found")
    row = db.get(AuditException, rid)
    station = get_station(db, (row.details or {}).get("stationId")) if row is not None else None
    if row is None or row.exception_type != EXCEPTION_TYPE or station is None or station.shop_id != till.shop_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="alert_not_found")
    if till.id not in {m.id for m in alert_tills(db, station)}:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="alert_not_found")
    details = dict(row.details or {})
    if not isinstance(details.get("tillAck"), dict):
        name = (pos_user_name or "").strip()[:100]
        details["tillAck"] = {
            "at": _now(now).isoformat(),
            "by": (f"{name} · {till.name}" if name and till.name else (name or till.name or "קופה"))[:200],
            "machineId": str(till.id),
        }
        row.details = details
        db.flush()
    return alert_out(row, station)


def open_alerts_of(db: Session, station: Any) -> List[Dict[str, Any]]:
    """The station's open alerts, for the dashboard."""
    out = []
    for row in rows_of_station(db, station.id):
        details = row.details or {}
        out.append({
            "id": str(row.id),
            "code": details.get("code"),
            "unit": details.get("unit") or "",
            "text": details.get("summary"),
            "severity": row.severity,
            "source": details.get("source"),
            "since": _iso(row.occurred_at),
            "txId": details.get("txId"),
            "acknowledgedBy": (details.get("tillAck") or {}).get("by") if isinstance(details.get("tillAck"), dict) else None,
        })
    return out
