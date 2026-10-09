"""
"תקינות מכשירים" — the kiosks' live health in the dashboard (docs/SPEC_KIOSK_INSIGHTS.md §3).

`GET /kiosks/health` (scoped like `GET /kiosks`): per kiosk of the shop(s), its parts each with
a level — `ok`, `info`, `warn`, `error`, `off` (not used here) or `unknown` (never reported) —
and a code the dashboard words:

* **app** — online (its `kiosk/sync` in the last 2 minutes) or offline since when; paused,
  closed, setting up, no payment; the config it runs vs the current one; its version;
* **terminal** — the card terminal: ready / not answering / not ready / not set; the card lock
  (the pinpad connected is not the one set, docs/SPEC_KIOSK.md §20); a card result left for staff;
* **printer** — ok / no paper / offline / error, and bons that did not print;
* **tillLink** — the kiosk's link to the till it prints on or hands orders to (LAN host / cloud);
* **kds** — in KDS mode: the shop's KDS screens seen lately and the kiosk's own link;
* **media** — the downloaded pictures and videos (missing ones);
* **uploads** — what waits on the kiosk to reach the cloud (orders, documents, funnel events).

The kiosk reports what only it can see as `status.health` on its `kiosk/sync` (cleaned here,
`clean_health`); the rest is the cloud's own (heartbeat, alerts, KDS screens, card lock).

**Alerts to staff.** The parts that need someone use the kiosk alerts to the tills (app/services/
kiosk_ops.py) with their routing settings (`alerts.<kind>`): what the kiosk reports itself
(printer, terminal, help) as before, the cloud's "kiosk offline for N minutes" (the
`kiosk_offline` rule, terminal route), and — added here — "KDS לא מחובר": a kiosk in KDS mode
whose shop has no KDS screen seen for `KDS_DOWN_MIN` minutes while it trades (printer route:
the kitchen does not see its orders). Like the offline alert it is not stored: it is there
while the condition holds and gone when it clears.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

from sqlalchemy.orm import Session

from app.models.kiosk import KioskDevice
from app.models.kiosk_ops import KioskAlert
from app.models.pos_machine import POSMachine

logger = logging.getLogger(__name__)

#: No kiosk/sync for this long: the kiosk app is offline (it syncs every ~15 s).
APP_OFFLINE_AFTER = timedelta(minutes=2)
#: A KDS screen not seen for this long is offline; all of a shop's → "KDS לא מחובר".
KDS_SCREEN_OFFLINE_AFTER = timedelta(minutes=3)
KDS_DOWN_MIN = 5
#: Uploads waiting this long while the kiosk is online are stuck.
UPLOADS_STUCK_AFTER = timedelta(minutes=15)

LEVELS = ("ok", "info", "warn", "error", "off", "unknown")
_WORST = {"error": 4, "warn": 3, "unknown": 2, "info": 1, "ok": 0, "off": 0}

TERMINAL_STATES = ("ready", "unreachable", "not_ready", "not_configured", "none", "busy", "unknown")
PRINTER_STATES = ("ok", "no_paper", "offline", "error", "unavailable", "overheated", "none", "unknown")
#: The kiosk's USB printer as Android sees it (pos-android UsbPrinterAuto.healthState): "needs_approval" —
#: attached, Android's approval missing (after a restart, above all: the owner, 08.10.2026).
USB_STATES = ("ready", "needs_approval", "several", "missing", "none", "unknown")
LINK_MODES = ("lan", "cloud", "none")
NETWORK_ROUTES = ("wifi", "ethernet", "cellular", "unknown")
PLATFORMS = ("android", "windows", "web")  # "web": the browser kiosk at /k (docs/SPEC_KIOSK.md §27)


def _now(now: Optional[datetime] = None) -> datetime:
    return now or datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    value = _aware(value)
    return value.isoformat().replace("+00:00", "Z") if value is not None else None


def _parse(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value or len(value) > 40:
        return None
    try:
        return _aware(datetime.fromisoformat(value.strip().replace("Z", "+00:00")))
    except ValueError:
        return None


def _str(value: Any, max_len: int) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:max_len] if text else None


def _int(value: Any, hi: int = 10**9) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = int(value)
    return number if 0 <= number <= hi else None


# ── The kiosk's own report (status.health) ───────────────────────────────────


def clean_health(raw: Any) -> Dict[str, Any]:
    """`status.health` as stored: known keys only, wrong types dropped, unknown enums "unknown"."""
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Any] = {}
    screen = _str(raw.get("screen"), 16)
    if screen:
        out["screen"] = screen
    if raw.get("platform") in PLATFORMS:
        out["platform"] = raw["platform"]

    def block(key: str, fields: Dict[str, Any]) -> None:
        src = raw.get(key)
        if not isinstance(src, dict):
            return
        clean: Dict[str, Any] = {}
        for name, kind in fields.items():
            value = src.get(name)
            if isinstance(kind, tuple):
                if value is not None:
                    clean[name] = value if value in kind else "unknown"
            elif kind == "bool":
                if isinstance(value, bool):
                    clean[name] = value
            elif kind == "int":
                number = _int(value)
                if number is not None:
                    clean[name] = number
            elif kind == "time":
                when = _parse(value)
                if when is not None:
                    clean[name] = _iso(when)
            else:
                text = _str(value, kind)
                if text is not None:
                    clean[name] = text
        if clean:
            out[key] = clean

    block("terminal", {"state": TERMINAL_STATES, "checkedAt": "time", "address": 60, "model": 40})
    block("printer", {"state": PRINTER_STATES, "name": 60, "checkedAt": "time", "usb": USB_STATES})
    block("tillLink", {"mode": LINK_MODES, "host": 60, "ok": "bool", "at": "time"})
    block("kds", {"ok": "bool", "at": "time", "pending": "int"})
    block("network", {"online": "bool", "since": "time", "route": NETWORK_ROUTES})
    block("pending", {"orders": "int", "documents": "int", "events": "int", "outbox": "int", "oldestAt": "time"})
    # "גשר לדפדפן" (docs/SPEC_KIOSK.md §28): the browser kiosk's Windows bridge, while it holds a pairing.
    block("bridge", {
        "paired": "bool", "present": "bool", "linked": "bool", "version": 24, "at": "time",
        "card": "bool", "print": "bool", "drawer": "bool",
    })
    return out


# ── The parts ────────────────────────────────────────────────────────────────


def _part(key: str, level: str, code: str, **detail: Any) -> Dict[str, Any]:
    return {"key": key, "level": level, "code": code, "detail": {k: v for k, v in detail.items() if v is not None}}


def _alerts_of(summary: Dict[str, Any], kind: str) -> List[Dict[str, Any]]:
    return [a for a in summary.get("alerts") or [] if a.get("kind") == kind]


def app_part(summary: Dict[str, Any], health: Dict[str, Any], online: bool, now: datetime) -> Dict[str, Any]:
    seen = summary.get("lastKioskSyncAt")
    flow = summary.get("flowState")
    if not summary.get("enabled", True):
        return _part("app", "off", "disabled")
    if not online:
        return _part("app", "error", "offline", since=seen)
    if summary.get("paused"):
        return _part("app", "warn", "paused", until=summary.get("pausedUntil"), message=summary.get("pauseMessage"))
    if flow == "closed":
        return _part("app", "info", "closed")
    if flow in ("setup", "no_payment"):
        return _part("app", "warn", flow)
    if summary.get("configUpToDate") is False:
        return _part("app", "warn", "config_pending", screen=health.get("screen"))
    return _part("app", "ok", "running", screen=health.get("screen") or flow)


def terminal_part(summary: Dict[str, Any], health: Dict[str, Any]) -> Dict[str, Any]:
    reported = health.get("terminal") or {}
    identity = summary.get("terminalIdentity") or {}
    lock = identity.get("cardLock")
    common = dict(checkedAt=reported.get("checkedAt"), address=reported.get("address"), model=reported.get("model"),
                  expected=identity.get("expected"), reported=identity.get("reportedNumber"),
                  # "בדיקת מספר מסוף מושבתת" (docs/SPEC_KIOSK.md §20.1): shown beside whatever the part says.
                  numberCheckBypass=True if identity.get("numberCheckBypass") else None)
    open_codes = {a.get("key"): a for a in _alerts_of(summary, "terminal")}
    if lock:
        return _part("terminal", "error", "card_lock", lock=lock, **common)
    if "terminal:card" in open_codes:
        return _part("terminal", "error", "card_unknown", **common)
    state = reported.get("state")
    if state == "ready":
        return _part("terminal", "ok", "ready", **common)
    if state == "busy":
        return _part("terminal", "ok", "busy", **common)
    if state == "unreachable":
        return _part("terminal", "error", "unreachable", **common)
    if state in ("not_ready", "not_configured", "none"):
        return _part("terminal", "warn", state, **common)
    alert = open_codes.get("terminal")
    if alert is not None:
        return _part("terminal", "error", str(alert.get("reason") or "unreachable"), **common)
    return _part("terminal", "unknown", "not_reported", **common)


def printer_part(summary: Dict[str, Any], health: Dict[str, Any], machine: POSMachine) -> Dict[str, Any]:
    reported = health.get("printer") or {}
    unprinted = summary.get("unprintedBons") or 0
    orders = summary.get("unprintedOrders") or []
    state = reported.get("state") or summary.get("printerStatus") or machine.printer_status
    common = dict(name=reported.get("name"), checkedAt=reported.get("checkedAt"), unprinted=unprinted or len(orders) or None,
                  usb=reported.get("usb"))
    alerts = _alerts_of(summary, "printer")
    hard = [a for a in alerts if a.get("reason") in ("no_paper", "offline", "unavailable", "error", "usb_detached", "overheated")]
    if hard:
        return _part("printer", "error", str(hard[0].get("reason")), text=hard[0].get("text"), **common)
    if state in ("no_paper", "offline", "unavailable", "error", "overheated"):
        return _part("printer", "error", state, **common)
    if orders or unprinted:
        return _part("printer", "warn", "unprinted", **common)
    # The USB printer attached and Android's approval missing ("אשר מדפסת" in the kiosk's manager corner).
    if reported.get("usb") == "needs_approval":
        return _part("printer", "warn", "usb_permission", **common)
    if alerts:
        return _part("printer", "warn", str(alerts[0].get("reason")), text=alerts[0].get("text"), **common)
    if state == "ok" or summary.get("bonPrinter") == "ok":
        return _part("printer", "ok", "ok", **common)
    if state == "none" or summary.get("bonPrinter") == "none":
        return _part("printer", "off", "none", **common)
    return _part("printer", "unknown", "not_reported", **common)


def till_link_part(health: Dict[str, Any]) -> Dict[str, Any]:
    link = health.get("tillLink")
    if not link:
        return _part("tillLink", "unknown", "not_reported")
    mode = link.get("mode")
    if mode == "none":
        return _part("tillLink", "off", "none")
    if link.get("ok") is False:
        return _part("tillLink", "error", "down", mode=mode, host=link.get("host"), at=link.get("at"))
    return _part("tillLink", "ok", mode or "ok", host=link.get("host"), at=link.get("at"))


def kds_part(summary: Dict[str, Any], health: Dict[str, Any], screens: List[Dict[str, Any]], now: datetime) -> Dict[str, Any]:
    if summary.get("fulfillmentMode") != "KDS":
        return _part("kds", "off", "bon")
    active = [s for s in screens if s.get("active")]
    online = [s for s in active if s.get("online")]
    own = health.get("kds") or {}
    if not active:
        return _part("kds", "error", "no_screens")
    if not online:
        last = max((s.get("lastSeenAt") or "" for s in active), default="") or None
        return _part("kds", "error", "screens_offline", lastSeenAt=last, screens=len(active))
    if own.get("ok") is False:
        return _part("kds", "error", "down", at=own.get("at"), pending=own.get("pending"))
    return _part("kds", "ok", "ok", screens=len(online), pending=own.get("pending"))


def bridge_part(health: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    "גשר Windows" (docs/SPEC_KIOSK.md §28) — only for a browser kiosk that reports one: paired and
    answering (with its version and what it does: card, printer), not answering (since its last
    answer), or not linked to this kiosk yet. None when the kiosk has no bridge (no part shown).
    """
    b = health.get("bridge")
    if not isinstance(b, dict) or not b:
        return None
    common = dict(version=b.get("version"), at=b.get("at"), card=b.get("card"), print=b.get("print"), drawer=b.get("drawer"))
    if b.get("present") is False:
        return _part("bridge", "error", "down", **common)
    if b.get("paired") is False:
        return _part("bridge", "warn", "not_paired", **common)
    if b.get("linked") is False:
        return _part("bridge", "warn", "not_linked", **common)
    return _part("bridge", "ok", "ok", **common)


def media_part(summary: Dict[str, Any]) -> Dict[str, Any]:
    ready, missing = summary.get("mediaReady"), summary.get("mediaMissing") or 0
    if ready is None and not missing:
        return _part("media", "unknown", "not_reported")
    if missing:
        return _part("media", "warn", "missing", missing=missing)
    return _part("media", "ok", "ready" if ready else "loading")


def uploads_part(summary: Dict[str, Any], health: Dict[str, Any], online: bool, now: datetime) -> Dict[str, Any]:
    pending = health.get("pending") or {}
    count = (summary.get("pendingOrders") or 0) + sum(pending.get(k) or 0 for k in ("documents", "events", "outbox"))
    if not pending and summary.get("pendingOrders") is None:
        return _part("uploads", "unknown", "not_reported")
    if count == 0:
        return _part("uploads", "ok", "none")
    oldest = _parse(pending.get("oldestAt"))
    if online and oldest is not None and now - oldest >= UPLOADS_STUCK_AFTER:
        return _part("uploads", "warn", "stuck", count=count, oldestAt=pending.get("oldestAt"))
    return _part("uploads", "info", "pending", count=count, oldestAt=pending.get("oldestAt"))


def battery_part(battery: Optional[Dict[str, Any]], alert: Any) -> Dict[str, Any]:
    """"סוללה" (app/services/battery_alerts.py): the open low-battery alert first, then the reading."""
    if alert is not None:
        critical = alert.severity == "critical"
        percent = alert.last_percent if alert.last_percent is not None else alert.percent
        return _part("battery", "error" if critical else "warn", "critical" if critical else "low",
                     percent=percent, threshold=alert.level, since=_iso(alert.raised_at), acknowledgedBy=alert.acknowledged_by_name)
    if not battery or battery.get("percent") is None:
        return _part("battery", "off", "none")
    if battery.get("charging"):
        return _part("battery", "ok", "charging", percent=battery.get("percent"), reportedAt=battery.get("reportedAt"))
    return _part("battery", "ok", "discharging", percent=battery.get("percent"), reportedAt=battery.get("reportedAt"))


def overall(parts: Iterable[Dict[str, Any]], online: bool) -> str:
    if not online:
        return "offline"
    worst = max((_WORST.get(p["level"], 0) for p in parts), default=0)
    return {4: "error", 3: "warn", 2: "ok", 1: "ok", 0: "ok"}[worst]


# ── KDS screens ──────────────────────────────────────────────────────────────


def kds_screens(db: Session, shop_ids: Sequence[Any], *, now: Optional[datetime] = None) -> Dict[Any, List[Dict[str, Any]]]:
    """The shops' KDS screens with when each was last seen."""
    from app.models.kds import KdsDevice

    now = _now(now)
    out: Dict[Any, List[Dict[str, Any]]] = {}
    ids = [s for s in shop_ids if s is not None]
    if not ids:
        return out
    for d in db.query(KdsDevice).filter(KdsDevice.shop_id.in_(ids)).order_by(KdsDevice.name).all():
        seen = _aware(d.last_seen_at)
        out.setdefault(d.shop_id, []).append({
            "id": str(d.id),
            "name": d.name,
            "role": d.role,
            "active": bool(d.is_active),
            "lastSeenAt": _iso(seen),
            "online": seen is not None and now - seen < KDS_SCREEN_OFFLINE_AFTER,
        })
    return out


# ── The view ─────────────────────────────────────────────────────────────────


def _row(db: Session, summary: Dict[str, Any], device: KioskDevice, machine: POSMachine,
         screens: List[Dict[str, Any]], now: datetime, battery_alert: Any = None) -> Dict[str, Any]:
    from app.services import battery_alerts

    battery = battery_alerts.battery_of(machine, now=now)
    status = device.status if isinstance(device.status, dict) else {}
    health = status.get("health") if isinstance(status.get("health"), dict) else {}
    seen = _aware(device.last_kiosk_sync_at)
    online = seen is not None and now - seen < APP_OFFLINE_AFTER
    parts = [
        app_part(summary, health, online, now),
        terminal_part(summary, health),
        printer_part(summary, health, machine),
        till_link_part(health),
        kds_part(summary, health, screens, now),
        media_part(summary),
        uploads_part(summary, health, online, now),
        battery_part(battery, battery_alert),
    ]
    bridge = bridge_part(health)
    if bridge is not None:
        parts.append(bridge)
    network = health.get("network") or {}
    return {
        "machineId": summary["machineId"],
        "name": summary["name"],
        "machineName": summary.get("machineName"),
        "posNumber": summary.get("posNumber"),
        "shopId": summary.get("shopId"),
        "shopName": summary.get("shopName"),
        "enabled": summary.get("enabled", True),
        "platform": health.get("platform") or ("windows" if (status.get("appVersion") or "").lower().startswith("win") else None),
        "appVersion": status.get("appVersion"),
        "online": online,
        "lastContactAt": _iso(seen),
        "lastHeartbeatAt": summary.get("lastSeenAt"),
        "network": network or None,
        "screen": health.get("screen"),
        "flowState": summary.get("flowState"),
        "paused": summary.get("paused"),
        "pauseMessage": summary.get("pauseMessage"),
        "pausedUntil": summary.get("pausedUntil"),
        "shiftOpen": summary.get("shiftOpen"),
        "fulfillmentMode": summary.get("fulfillmentMode"),
        "configUpToDate": summary.get("configUpToDate"),
        "overall": overall(parts, online) if summary.get("enabled", True) else "off",
        "parts": parts,
        "alerts": summary.get("alerts") or [],
        "unprintedOrders": summary.get("unprintedOrders") or [],
        "kdsScreens": screens if summary.get("fulfillmentMode") == "KDS" else [],
        "battery": battery,
        "ordersToday": summary.get("ordersToday"),
        "salesTodayAgorot": summary.get("salesTodayAgorot"),
        "lastOrderAt": summary.get("lastOrderAt"),
    }


def health_view(db: Session, user, tenant_id, *, company_id=None, shop_id=None, now: Optional[datetime] = None) -> Dict[str, Any]:
    """`GET /kiosks/health`: every kiosk in scope with its parts, the shops' KDS screens, the counts."""
    from app.services import kiosk_control as svc

    now = _now(now)
    summaries = svc.list_kiosks(db, user, tenant_id, company_id=company_id, shop_id=shop_id, now=now)
    ids = [s["machineId"] for s in summaries]
    devices = {str(d.machine_id): d for d in db.query(KioskDevice).filter(KioskDevice.machine_id.in_(ids)).all()} if ids else {}
    machines = {str(m.id): m for m in db.query(POSMachine).filter(POSMachine.id.in_(ids)).all()} if ids else {}
    shop_ids = {m.shop_id for m in machines.values() if m.shop_id is not None}
    screens = kds_screens(db, list(shop_ids), now=now)
    from app.services import battery_alerts

    open_battery = battery_alerts.open_by_machine(db, [m.id for m in machines.values()])
    # The cloud's own alerts ("offline for N minutes", "KDS לא מחובר") beside the stored ones.
    cloud = cloud_alerts_by_kiosk(db, [d for d in devices.values()], now=now)
    rows = []
    for s in summaries:
        device, machine = devices.get(s["machineId"]), machines.get(s["machineId"])
        if device is None or machine is None:
            continue
        s = {**s, "alerts": list(s.get("alerts") or []) + cloud.get(s["machineId"], [])}
        rows.append(_row(db, s, device, machine, screens.get(machine.shop_id, []), now, open_battery.get(machine.id)))
    counts = {k: 0 for k in ("ok", "warn", "error", "offline", "off")}
    for r in rows:
        counts[r["overall"]] = counts.get(r["overall"], 0) + 1
    shops = []
    for sid in sorted(shop_ids, key=str):
        shops.append({"shopId": str(sid), "kdsScreens": screens.get(sid, [])})
    devices = devices_view(db, user, tenant_id, company_id=company_id, shop_id=shop_id,
                           skip=[m.id for m in machines.values()], now=now)
    history = battery_alerts.history(db, [d["machineId"] for d in devices] + [r["machineId"] for r in rows], limit=50)
    return {
        "generatedAt": _iso(now), "kiosks": rows, "counts": counts, "shops": shops,
        # "סוללה חלשה": every other device of the scope (tills, handhelds, tablets) with its battery,
        # and the low-battery events of them all (app/services/battery_alerts.py).
        "devices": devices,
        "batteryHistory": history,
    }


def devices_view(db: Session, user, tenant_id, *, company_id=None, shop_id=None, skip: Sequence[Any] = (),
                 now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """The scope's other active devices (not kiosks): online, version, battery, the open low-battery alert."""
    from app.models.pos_machine import PairingStatus
    from app.models.shop import Shop
    from app.services import battery_alerts
    from app.services import kiosk_control as svc
    from app.services.machine_status import is_online

    now = _now(now)
    query = svc._scoped_machine_query(db, user, tenant_id).filter(
        POSMachine.is_active.is_(True), POSMachine.pairing_status == PairingStatus.ASSIGNED, POSMachine.shop_id.isnot(None),
    )
    if shop_id is not None:
        query = query.filter(POSMachine.shop_id == shop_id)
    if company_id is not None:
        query = query.filter(POSMachine.shop_id.in_(db.query(Shop.id).filter(Shop.company_id == company_id)))
    skipped = set(skip)
    machines = [m for m in query.all() if m.id not in skipped]
    shops = {s.id: s.name for s in db.query(Shop).filter(Shop.id.in_([m.shop_id for m in machines])).all()} if machines else {}
    open_battery = battery_alerts.open_by_machine(db, [m.id for m in machines])
    out = []
    for m in machines:
        online = is_online(m.last_heartbeat_at, now=now)
        alert = open_battery.get(m.id)
        part = battery_part(battery_alerts.battery_of(m, now=now), alert)
        out.append({
            "machineId": str(m.id),
            "name": m.name,
            "posNumber": m.pos_number,
            "shopId": str(m.shop_id) if m.shop_id else None,
            "shopName": shops.get(m.shop_id),
            "device": battery_alerts.device_label(db, m),
            "deviceModel": getattr(m, "device_model", None),
            "appVersion": getattr(m, "app_version", None),
            "online": online,
            "lastHeartbeatAt": _iso(m.last_heartbeat_at),
            "battery": battery_alerts.battery_of(m, now=now),
            "batteryPart": part,
            "overall": "offline" if not online else ("error" if part["level"] == "error" else "warn" if part["level"] == "warn" else "ok"),
        })
    out.sort(key=lambda d: (d["shopName"] or "", d["name"] or ""))
    return out


def kiosk_detail(db: Session, user, tenant_id, machine_id: Any, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """`GET /kiosks/{id}/health`: one kiosk's row and its last events (alerts, commands, sessions, outages)."""
    from app.services import battery_alerts
    from app.services import kiosk_control as svc
    from app.services import kiosk_funnel

    now = _now(now)
    svc.require_kiosk_role(user)
    machine, device = svc.kiosk_for_dashboard(db, user, machine_id, tenant_id)
    summary = svc.summary(db, device, now=now)
    screens = kds_screens(db, [machine.shop_id], now=now).get(machine.shop_id, [])
    cloud = cloud_alerts_by_kiosk(db, [device], now=now).get(str(machine.id), [])
    row = _row(
        db, {**summary, "alerts": list(summary.get("alerts") or []) + cloud}, device, machine, screens, now,
        battery_alerts.open_by_machine(db, [machine.id]).get(machine.id),
    )
    alerts = (
        db.query(KioskAlert)
        .filter(KioskAlert.kiosk_machine_id == machine.id)
        .order_by(KioskAlert.raised_at.desc())
        .limit(30)
        .all()
    )
    commands = svc.list_commands(db, machine.id, limit=20)
    outages: List[Dict[str, Any]] = []
    try:
        from app.models.audit_exception import AuditException

        for e in (
            db.query(AuditException)
            .filter(AuditException.machine_id == machine.id, AuditException.exception_type == "kiosk_offline")
            .order_by(AuditException.occurred_at.desc())
            .limit(10)
            .all()
        ):
            details = e.details if isinstance(e.details, dict) else {}
            outages.append({"since": _iso(e.occurred_at), "backAt": details.get("backAt"), "minutes": e.value})
    except Exception:  # noqa: BLE001 - an optional block
        outages = []
    events: List[Dict[str, Any]] = []
    for a in alerts:
        events.append({"at": _iso(a.raised_at), "type": "alert_raised", "kind": a.kind, "reason": a.reason, "text": a.text})
        if a.cleared_at is not None:
            events.append({
                "at": _iso(a.cleared_at), "type": "alert_cleared", "kind": a.kind, "reason": a.clear_reason,
                "text": a.text, "by": a.acknowledged_by_name,
            })
    for c in commands:
        events.append({"at": c.get("createdAt"), "type": "command", "action": c.get("action"), "status": c.get("status"), "by": c.get("requestedByName"), "text": c.get("detail")})
    for o in outages:
        events.append({"at": o["since"], "type": "offline", "backAt": o["backAt"], "minutes": o["minutes"]})
    events.sort(key=lambda e: e.get("at") or "", reverse=True)
    return {
        "generatedAt": _iso(now),
        "kiosk": row,
        "events": events[:60],
        "sessions": kiosk_funnel.recent_sessions(db, machine.id, limit=10),
        "batteryHistory": battery_alerts.history(db, [machine.id], limit=20),
        "terminalIdentity": summary.get("terminalIdentity"),
        "health": (device.status or {}).get("health") if isinstance(device.status, dict) else None,
    }


# ── The cloud's own alerts ───────────────────────────────────────────────────


def _kds_down(db: Session, kiosk: POSMachine, device: KioskDevice, cfg: Dict[str, Any], screens: List[Dict[str, Any]],
              now: datetime) -> Optional[Dict[str, Any]]:
    """"KDS לא מחובר": in KDS mode, while trading and online, no active KDS screen of the shop seen for KDS_DOWN_MIN."""
    from app.services import kiosk_config as KC
    from app.services import kiosk_offline as KO

    if (cfg.get("general") or {}).get("fulfillmentMode") != "KDS" or not KC.kds_available():
        return None
    seen = _aware(device.last_kiosk_sync_at)
    if seen is None or now - seen >= APP_OFFLINE_AFTER:
        return None  # offline: the offline alert says so
    active = [s for s in screens if s.get("active")]
    if not active:
        last = None
    else:
        stamps = [_parse(s.get("lastSeenAt")) for s in active]
        if any(t is None for t in stamps):
            last = None if all(t is None for t in stamps) else max(t for t in stamps if t is not None)
        else:
            last = max(stamps)
        if last is not None and now - last < timedelta(minutes=KDS_DOWN_MIN):
            return None
    if not KO.trading(db, kiosk, device, cfg, now):
        return None
    since = KO._local(db, kiosk, last).strftime("%H:%M") if last is not None else None
    name = (device.name or "קיוסק").strip()
    if not active:
        text = f"{name} — אין מסך KDS פעיל בסניף: הזמנות הקיוסק לא מוצגות במטבח"
    else:
        text = f"{name} — מסכי ה-KDS לא מחוברים" + (f" מאז {since}" if since else "") + ": הזמנות הקיוסק לא מוצגות במטבח"
    return {
        "id": f"kds:{device.machine_id}:{int(last.timestamp()) if last else 0}",
        "kioskMachineId": str(device.machine_id),
        "kioskName": device.name,
        "kind": "printer",
        "key": "kiosk:kds",
        "reason": "kds_down",
        "text": text[:300],
        "detail": {"since": since, "screens": len(active)},
        "raisedAt": _iso(last) if last else _iso(seen),
        "pingCount": 0,
        "pingedAt": None,
        "acknowledgedAt": None,
        "acknowledgedBy": None,
    }


def cloud_alerts_by_kiosk(db: Session, devices: Sequence[KioskDevice], *, now: Optional[datetime] = None) -> Dict[str, List[Dict[str, Any]]]:
    """The alerts only the cloud can raise, per kiosk (brief, as `alerts` in a summary)."""
    from app.services import kiosk_config as KC

    now = _now(now)
    out: Dict[str, List[Dict[str, Any]]] = {}
    devices = [d for d in devices if d is not None and d.enabled]
    if not devices:
        return out
    machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_([d.machine_id for d in devices])).all()}
    screens = kds_screens(db, list({m.shop_id for m in machines.values()}), now=now)
    for d in devices:
        kiosk = machines.get(d.machine_id)
        if kiosk is None or not kiosk.is_active:
            continue
        try:
            cfg = KC.effective_config(db, kiosk)
            alert = _kds_down(db, kiosk, d, cfg, screens.get(kiosk.shop_id, []), now)
        except Exception:  # noqa: BLE001 - an alert never fails a listing
            logger.exception("kiosk KDS alert failed for %s", d.machine_id)
            alert = None
        if alert is not None:
            out.setdefault(str(d.machine_id), []).append({
                "kind": alert["kind"], "key": alert["key"], "reason": alert["reason"], "text": alert["text"],
                "raisedAt": alert["raisedAt"], "acknowledgedBy": None, "cloud": True,
            })
    return out


def cloud_alerts_for_till(db: Session, till: POSMachine, *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """
    The cloud's own kiosk alerts routed to [till] by each kiosk's `alerts.<kind>` (kiosk_ops.targets):
    "KDS לא מחובר" on the printer route. Not stored; gone when the condition clears.
    """
    from app.services import kiosk_config as KC
    from app.services import kiosk_ops as OPS

    now = _now(now)
    if till.tenant_id is None:
        return []
    devices = db.query(KioskDevice).filter(KioskDevice.tenant_id == till.tenant_id, KioskDevice.enabled.is_(True)).all()
    devices = [d for d in devices if d.machine_id != till.id]
    if not devices:
        return []
    out: List[Dict[str, Any]] = []
    machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_([d.machine_id for d in devices])).all()}
    screens = kds_screens(db, list({m.shop_id for m in machines.values()}), now=now)
    for d in devices:
        kiosk = machines.get(d.machine_id)
        if kiosk is None or not kiosk.is_active:
            continue
        try:
            cfg = KC.effective_config(db, kiosk)
            alert = _kds_down(db, kiosk, d, cfg, screens.get(kiosk.shop_id, []), now)
            if alert is None:
                continue
            if till.id not in {m.id for m in OPS.targets(db, kiosk, cfg, alert["kind"])}:
                continue
            alert["audience"] = OPS.route_of(cfg, alert["kind"])["audience"]
        except Exception:  # noqa: BLE001 - an alert never fails the till's fetch
            logger.exception("kiosk cloud alert failed for %s", d.machine_id)
            continue
        out.append(alert)
    return out
