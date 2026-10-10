"""
A self-order kiosk among the shop's tills (docs/SPEC_KIOSK.md §16).

**Alerts to the tills ("התראות לקופות").** The kiosk reports, on every `kiosk/sync` (≈15 s,
and at once on a change), the alerts it has now — a printer problem, the card terminal, the
customer's help request — as `status.alerts`. The cloud keeps one OPEN row per kiosk and key
(`kiosk_alerts`): a new key raises an alert (and wakes its tills), a key the kiosk stops
reporting is cleared ("recovered" — the printer is back, the pinpad answers), a help
request is cleared when a till answers "בדרך" (the kiosk then shows "הצוות בדרך") or after
the kiosk's `alerts.help.clearAfterMin`. Which tills get it, and who on them, is the kiosk's
config `alerts.<kind>` — `main` (the shop's main till if it has one, else all its tills),
`all`, or `selected`; `everyone` signed in or `managers` only (the till filters by who is
signed in). The tills fetch theirs with `GET /sync/{m}/kiosk/alerts` on the heartbeat's
cadence and right after a realtime wake-up.

Offline: the kiosk keeps its alerts and sends them when the cloud answers again (the state,
not events — nothing is lost and nothing doubles). LAN: a kiosk on the shop's LAN also hands
them to the main till directly (the till's side); an independent kiosk has no LAN — cloud
only.

**"סגירה יחד עם ה-Z הסניפי".** When the shop's Z runs — the cloud's z run, or the main
till's local shop Z when it reaches the cloud — every kiosk of the shop set so
(`operations.closeWithShopZ`) and not closed by that Z itself (an independent or till-Z
kiosk) gets a close request: the kiosk closes its shift once idle, never over a payment,
makes its own Z (zMode = till), and reports back (`status.closeResult`).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kiosk import KioskDevice
from app.models.kiosk_ops import KIOSK_ALERT_KINDS, KioskAlert, KioskCloseRequest
from app.models.pos_machine import POSMachine

logger = logging.getLogger(__name__)

#: At most this many alerts a kiosk may report in one sync.
ALERTS_MAX = 12
#: A close request nobody answered for this long is dropped (the next Z asks again).
CLOSE_REQUEST_TTL = timedelta(hours=24)
#: How long the kiosk is told a help request was answered ("הצוות בדרך").
HELP_ACK_SHOWN = timedelta(minutes=10)

PRINTER_REASONS = {
    "no_paper": "אין נייר",
    "offline": "לא מחוברת",
    "unavailable": "לא זמינה",
    "error": "תקלה",
    "overheated": "התחממות",
    "usb_detached": "USB מנותקת",
    "usb_permission": "ממתינה לאישור USB",
    "usb_several": "כמה מדפסות USB — לא נקבעה אחת",
    "bon_failed": "בון לא הודפס",
}
#: The command actions a kiosk carries out for an unprinted bon (docs/SPEC_KIOSK.md §16.8).
BON_ACTIONS = ("bon_print", "bon_handled")
#: "הדפס שוב את הבון האחרון" / "הדפס עסקה אחרונה" from a controlling till: carried out with the bon commands.
REPRINT_ACTIONS = ("reprint_bon", "reprint_receipt")
BON_COMMAND_TTL = timedelta(hours=24)
TERMINAL_REASONS = {
    "unreachable": "אין תקשורת למסופון האשראי",
    "not_ready": "המסופון לא מוכן",
    "not_configured": "המסופון לא מוגדר",
    "card_unknown": "תשלום באשראי לא הוכרע — נדרש צוות",
    "offline": "אין חיבור לאינטרנט",
    # The kiosk found its own pinpad (the same terminal) at a new address and switched to it.
    "moved": "המסופון עבר לכתובת חדשה",
}
#: Informational alerts: listed on the tills, never a wake-up of their own (nothing to do).
QUIET_REASONS = ("moved",)
#: The card lock (docs/SPEC_KIOSK.md §20): the pinpad connected is not the one set for the kiosk.
IDENTITY_REASONS = ("terminal_mismatch", "terminal_not_configured", "terminal_unknown")


def _identity(number: Any, merchant: Any) -> Optional[str]:
    """"מספר 0882612 / מגנום בר" — a terminal as the alert names it."""
    num = _str(number, 20)
    name = _str(merchant, 60)
    parts = ([f"מספר {num}"] if num else []) + ([name] if name else [])
    return " / ".join(parts) or None


def identity_text(name: str, reason: str, detail: Dict[str, Any]) -> str:
    """"קיוסק רויאל — המסופון המחובר (מספר … / …) אינו תואם למסוף שהוגדר (…)"."""
    expected = _str(detail.get("expected"), 20)
    actual = _identity(detail.get("actual"), detail.get("merchant"))
    if reason == "terminal_mismatch":
        return f"{name} — המסופון המחובר ({actual or '—'}) אינו תואם למסוף שהוגדר ({expected or '—'})"[:300]
    if reason == "terminal_not_configured":
        return (f"{name} — לא הוגדר מסוף לקיוסק" + (f" (המסופון המחובר: {actual})" if actual else ""))[:300]
    return f"{name} — לא ניתן לקרוא את זהות המסופון (מסוף שהוגדר: {expected or '—'})"[:300]


SCREEN_LABELS = {
    "attract": "מסך הפתיחה",
    "service": "בחירת שירות",
    "catalog": "תפריט",
    "cart": "סל",
    "confirm": "אישור הזמנה",
    "details": "פרטים",
    "pay": "תשלום",
    "success": "סיום הזמנה",
    "paused": "מושהה",
    "closed": "סגור",
    "no_payment": "אין תשלום",
    "setup": "הכנה",
}


def _now(now: Optional[datetime] = None) -> datetime:
    return now or datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value


def _iso(value: Optional[datetime]) -> Optional[str]:
    value = _aware(value)
    return value.isoformat().replace("+00:00", "Z") if value is not None else None


def _str(value: Any, max_len: int) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text[:max_len] if text else None


def _shekels(agorot: Any) -> Optional[str]:
    if not isinstance(agorot, int) or isinstance(agorot, bool) or agorot <= 0:
        return None
    return f"₪{agorot // 100}.{agorot % 100:02d}" if agorot % 100 else f"₪{agorot // 100}"


# ── The alert's line ─────────────────────────────────────────────────────────


def host_down_text(detail: Dict[str, Any]) -> str:
    """
    " — קופה 2 לא עונה (כבויה או לא מחוברת)": the bon waits on a till's own printer and that
    till did not take it (docs/SPEC_KIOSK.md §16.9) — the staff know which till to look at.
    """
    host = _str(detail.get("hostTill"), 60)
    return f" — {host} לא עונה (כבויה או לא מחוברת)" if host else ""


def alert_text(kiosk_name: str, kind: str, reason: str, detail: Dict[str, Any], fallback: Optional[str] = None) -> str:
    """"קיוסק רויאל — מדפסת: אין נייר" — the line every till shows, composed here, once."""
    name = (kiosk_name or "קיוסק").strip()
    if kind == "printer" and reason == "bon_unprinted":
        # The printer is fine; an order's bon did not print ("בון של הזמנה A-1 לא הודפס").
        orders = _str(detail.get("orders"), 120)
        count = detail.get("count") if isinstance(detail.get("count"), int) else None
        if count is not None and count > 1:
            return (f"{name} — {count} בונים לא הודפסו" + (f" ({orders})" if orders else "") + host_down_text(detail))[:300]
        return (f"{name} — בון של הזמנה {orders or '—'} לא הודפס" + host_down_text(detail))[:300]
    if kind == "printer":
        label = PRINTER_REASONS.get(reason)
        if label is None:
            return f"{name} — {fallback or 'תקלה במדפסת'}"[:300]
        which = {"bon": "מדפסת בונים", "receipt": "מדפסת קבלות", "usb": "מדפסת USB"}.get(
            str(detail.get("target") or ""), "מדפסת"
        )
        printer = _str(detail.get("printer"), 60)
        head = f"{which} {printer}" if printer and which == "מדפסת" else which
        if printer and which != "מדפסת":
            head = f"{which} ({printer})"
        return (f"{name} — {head}: {label}" + host_down_text(detail))[:300]
    if kind == "terminal" and reason == "no_internet_sim":
        # "אין אינטרנט ברשת פרטנר (סים 1). לעבור לנתונים של סים 2 (סלקום)?" (device_identity).
        from app.services.device_identity import sim_prompt_text

        return f"{name} — {sim_prompt_text(detail)}"[:300]
    if kind == "terminal" and reason in IDENTITY_REASONS:
        return identity_text(name, reason, detail)
    if kind == "terminal":
        label = TERMINAL_REASONS.get(reason, fallback or "תקלה במסופון האשראי")
        address = _str(detail.get("address"), 60)
        amount = _shekels(detail.get("amountAgorot"))
        since = _str(detail.get("since"), 5)
        if reason == "offline":
            tail = f" מאז {since}" if since else ""
        elif address and reason != "card_unknown":
            tail = f" ({address})"
        else:
            tail = f" ({amount})" if amount else ""
        return f"{name} — {label}{tail}"[:300]
    # help
    parts = [f"{name} מבקש עזרה"]
    screen = SCREEN_LABELS.get(str(detail.get("screen") or ""))
    if screen:
        parts.append(screen)
    step = _str(detail.get("step"), 40)
    if step and step not in ("idle",):
        parts.append({"starting": "מתחיל תשלום", "charging": "באמצע תשלום", "declined": "תשלום נדחה",
                      "unknown": "תשלום לא הוכרע", "approved": "שולם"}.get(step, step))
    total = _shekels(detail.get("totalAgorot"))
    if total:
        parts.append(total)
    error = _str(detail.get("error"), 120)
    if error:
        parts.append(error)
    return " · ".join(parts)[:300]


# ── Routing ──────────────────────────────────────────────────────────────────


def _shop_tills(db: Session, shop_id: Any, tenant_id: Any) -> List[POSMachine]:
    if shop_id is None:
        return []
    rows = (
        db.query(POSMachine)
        .filter(POSMachine.shop_id == shop_id, POSMachine.is_active.is_(True))
        .all()
    )
    kiosks = {d.machine_id for d in db.query(KioskDevice.machine_id).filter(KioskDevice.home_role.is_(None)).filter(KioskDevice.shop_id == shop_id).all()}
    return [m for m in rows if m.id not in kiosks and (tenant_id is None or m.tenant_id == tenant_id)]


def route_of(cfg: Dict[str, Any], kind: str) -> Dict[str, Any]:
    route = ((cfg or {}).get("alerts") or {}).get(kind) or {}
    return {
        "tills": route.get("tills") if route.get("tills") in ("main", "all", "selected") else "main",
        "machineIds": [str(x) for x in route.get("machineIds") or []],
        "audience": route.get("audience") if route.get("audience") in ("everyone", "managers") else "everyone",
        "clearAfterMin": route.get("clearAfterMin") if isinstance(route.get("clearAfterMin"), int) else 10,
    }


def targets(db: Session, kiosk: POSMachine, cfg: Dict[str, Any], kind: str) -> List[POSMachine]:
    """The tills an alert of [kind] goes to, by the kiosk's `alerts.<kind>`. Never a kiosk."""
    route = route_of(cfg, kind)
    if route["tills"] == "selected":
        ids = []
        for raw in route["machineIds"]:
            try:
                ids.append(uuid.UUID(str(raw)))
            except ValueError:
                continue
        if ids:
            kiosks = {d.machine_id for d in db.query(KioskDevice.machine_id).filter(KioskDevice.home_role.is_(None)).filter(KioskDevice.machine_id.in_(ids)).all()}
            chosen = [
                m for m in db.query(POSMachine).filter(POSMachine.id.in_(ids), POSMachine.is_active.is_(True)).all()
                if m.tenant_id == kiosk.tenant_id and m.id not in kiosks and m.id != kiosk.id
            ]
            if chosen:
                return chosen
        # A list that names no till left: as `main`, never nobody.
    tills = [m for m in _shop_tills(db, kiosk.shop_id, kiosk.tenant_id) if m.id != kiosk.id]
    if route["tills"] == "main":
        try:
            from app.services.main_till import main_till_of_shop

            main = main_till_of_shop(db, kiosk.shop_id)
        except Exception:  # noqa: BLE001 - no main till known: all the shop's tills
            main = None
        if main is not None and main.id != kiosk.id and main.is_active:
            return [main]
    return tills


def check_alert_tills(db: Session, tenant_id: Any, layer: Dict[str, Any]) -> List[Any]:
    """The `alerts.<kind>.machineIds` of a layer must be active tills of the tenant, not kiosks."""
    from app.services.kiosk_config import Issue

    errors: List[Any] = []
    alerts = (layer or {}).get("alerts") or {}
    if not isinstance(alerts, dict):
        return errors
    for kind in KIOSK_ALERT_KINDS + ("battery",):
        route = alerts.get(kind)
        if not isinstance(route, dict):
            continue
        for i, raw in enumerate(route.get("machineIds") or []):
            try:
                mid = uuid.UUID(str(raw))
            except ValueError:
                continue  # the schema already said so
            machine = db.query(POSMachine).filter(POSMachine.id == mid).first()
            is_kiosk = db.query(KioskDevice.machine_id).filter(KioskDevice.home_role.is_(None)).filter(KioskDevice.machine_id == mid).first() is not None
            if machine is None or not machine.is_active or (tenant_id is not None and machine.tenant_id != tenant_id):
                errors.append(Issue(f"alerts.{kind}.machineIds[{i}]", "unknown_till", "not an active till of this business"))
            elif is_kiosk:
                errors.append(Issue(f"alerts.{kind}.machineIds[{i}]", "kiosk_not_a_till", "a kiosk cannot receive alerts"))
    return errors


#: The realtime event that wakes a till (fetch its kiosk alerts) or a kiosk (sync now).
WAKE_EVENT = "kiosk-alert"


def wake_machine(machine: POSMachine, reason: str) -> None:
    """`kiosk-alert` on the machine's channel: the till fetches its alerts, the kiosk syncs."""
    try:
        from app.services import ably_notify

        ably_notify.publish_notify(
            str(machine.tenant_id), str(machine.id), WAKE_EVENT,
            {"reason": reason, "serverTime": datetime.now(timezone.utc).isoformat()},
        )
    except Exception:  # noqa: BLE001 - the tills fetch on their beat anyway
        logger.exception("kiosk alert wake-up failed")


def _wake(tills: Iterable[POSMachine]) -> None:
    for m in tills:
        wake_machine(m, "kiosk_alert")


# ── The kiosk's report ───────────────────────────────────────────────────────


def _clean_reported(raw: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen = set()
    for item in (raw if isinstance(raw, list) else [])[:ALERTS_MAX]:
        if not isinstance(item, dict):
            continue
        kind = item.get("kind")
        key = _str(item.get("key"), 40)
        reason = _str(item.get("reason"), 40)
        if kind not in KIOSK_ALERT_KINDS or not key or not reason or key in seen:
            continue
        seen.add(key)
        detail = item.get("detail") if isinstance(item.get("detail"), dict) else {}
        clean_detail = {}
        for k, v in list(detail.items())[:12]:
            if isinstance(v, (str, int, float, bool)) or v is None:
                clean_detail[str(k)[:40]] = v[:200] if isinstance(v, str) else v
        pings = item.get("pings")
        out.append({
            "kind": kind, "key": key, "reason": reason, "detail": clean_detail,
            "text": _str(item.get("text"), 200),
            "requestId": _str(item.get("requestId"), 64),
            "pings": pings if isinstance(pings, int) and not isinstance(pings, bool) and 0 <= pings < 1000 else 0,
        })
    return out


def _open_alerts(db: Session, kiosk_id: Any) -> Dict[str, KioskAlert]:
    rows = db.query(KioskAlert).filter(KioskAlert.kiosk_machine_id == kiosk_id, KioskAlert.cleared_at.is_(None)).all()
    return {r.key: r for r in rows}


def _expire_help(db: Session, rows: Iterable[KioskAlert], cfg_of, now: datetime) -> None:
    for row in rows:
        if row.kind != "help" or row.cleared_at is not None:
            continue
        minutes = route_of(cfg_of(row), "help")["clearAfterMin"]
        since = _aware(row.pinged_at) or _aware(row.raised_at)
        if since is not None and now - since >= timedelta(minutes=minutes):
            row.cleared_at = now
            row.clear_reason = "expired"


def reconcile(
    db: Session, kiosk: POSMachine, device: KioskDevice, cfg: Dict[str, Any], raw_alerts: Any,
    *, now: Optional[datetime] = None,
) -> None:
    """The kiosk's alerts as it reports them now: raised, updated, re-pinged, cleared. The caller commits."""
    now = _now(now)
    reported = _clean_reported(raw_alerts)
    open_rows = _open_alerts(db, kiosk.id)
    _expire_help(db, open_rows.values(), lambda _r: cfg, now)
    open_rows = {k: r for k, r in open_rows.items() if r.cleared_at is None}
    keys = {a["key"] for a in reported}
    cleared: List[KioskAlert] = []
    raised: List[KioskAlert] = []
    for key, row in open_rows.items():
        if key not in keys:
            row.cleared_at = now
            row.clear_reason = "reset" if row.kind == "help" else "recovered"
            cleared.append(row)
    to_wake: Dict[str, List[POSMachine]] = {}
    for a in reported:
        row = open_rows.get(a["key"])
        text = alert_text(device.name, a["kind"], a["reason"], a["detail"], a["text"])
        if a["kind"] == "help" and a["requestId"]:
            # A request a till already answered (or that expired) is never raised again.
            done = (
                db.query(KioskAlert)
                .filter(
                    KioskAlert.kiosk_machine_id == kiosk.id, KioskAlert.key == a["key"],
                    KioskAlert.request_id == a["requestId"], KioskAlert.cleared_at.isnot(None),
                )
                .first()
            )
            if done is not None and (row is None or row.request_id != a["requestId"]):
                continue
            if row is not None and row.request_id != a["requestId"]:
                # Another request of the same kiosk: the old one is over.
                row.cleared_at = now
                row.clear_reason = "reset"
                row = None
        if row is None:
            row = KioskAlert(
                id=uuid.uuid4(), tenant_id=kiosk.tenant_id, shop_id=kiosk.shop_id, kiosk_machine_id=kiosk.id,
                kind=a["kind"], key=a["key"], reason=a["reason"], text=text, detail=a["detail"],
                request_id=a["requestId"], raised_at=now, last_reported_at=now,
                ping_count=a["pings"], pinged_at=now if a["kind"] == "help" else None,
            )
            db.add(row)
            raised.append(row)
            if a["reason"] not in QUIET_REASONS:
                to_wake[a["kind"]] = targets(db, kiosk, cfg, a["kind"])
            continue
        row.last_reported_at = now
        if row.reason != a["reason"] or row.text != text or row.detail != a["detail"]:
            changed_reason = row.reason != a["reason"]
            row.reason, row.text, row.detail = a["reason"], text, a["detail"]
            raised.append(row)
            if changed_reason and a["reason"] not in QUIET_REASONS:
                to_wake[a["kind"]] = targets(db, kiosk, cfg, a["kind"])
        if a["kind"] == "help" and a["pings"] > (row.ping_count or 0):
            # "a second tap just re-pings": the same request, shown again on the tills.
            row.ping_count = a["pings"]
            row.pinged_at = now
            to_wake["help"] = targets(db, kiosk, cfg, "help")
    db.flush()
    # "בון לא הודפס" of a kiosk on the dashboard's alerts too (app/services/bon_alerts.py).
    from app.services import bon_alerts

    for row in raised:
        bon_alerts.kiosk_alert_raised(db, kiosk, row, now=now)
    for row in cleared:
        bon_alerts.kiosk_alert_cleared(db, row, now=now)
    for tills in to_wake.values():
        _wake(tills)


def kiosk_view(db: Session, kiosk: POSMachine, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """What the kiosk is told back: its open alert keys and its help request's state."""
    now = _now(now)
    open_rows = _open_alerts(db, kiosk.id)
    help_row = (
        db.query(KioskAlert)
        .filter(KioskAlert.kiosk_machine_id == kiosk.id, KioskAlert.kind == "help")
        .order_by(KioskAlert.raised_at.desc())
        .first()
    )
    help_state = None
    if help_row is not None:
        if help_row.cleared_at is None:
            help_state = {"requestId": help_row.request_id, "state": "open", "pings": help_row.ping_count}
        elif help_row.clear_reason == "acknowledged" and now - _aware(help_row.cleared_at) < HELP_ACK_SHOWN:
            help_state = {
                "requestId": help_row.request_id, "state": "acknowledged",
                "by": help_row.acknowledged_by_name, "at": _iso(help_row.acknowledged_at),
            }
        elif help_row.clear_reason == "expired" and now - _aware(help_row.cleared_at) < HELP_ACK_SHOWN:
            help_state = {"requestId": help_row.request_id, "state": "expired"}
    return {"open": sorted(open_rows.keys()), "help": help_state}


# ── The tills' side ──────────────────────────────────────────────────────────


def alert_out(row: KioskAlert, kiosk_name: Optional[str], audience: str) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "kioskMachineId": str(row.kiosk_machine_id),
        "kioskName": kiosk_name,
        "kind": row.kind,
        "key": row.key,
        "reason": row.reason,
        "text": row.text,
        "detail": row.detail or {},
        "raisedAt": _iso(row.raised_at),
        "pingCount": row.ping_count or 0,
        "pingedAt": _iso(row.pinged_at),
        "acknowledgedAt": _iso(row.acknowledged_at),
        "acknowledgedBy": row.acknowledged_by_name,
        "audience": audience,
    }


def alerts_for_till(db: Session, till: POSMachine, *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """`GET /sync/{m}/kiosk/alerts`: the open alerts routed to this till. Commits nothing (the caller does)."""
    from app.services import kiosk_config as KC

    now = _now(now)
    if till.tenant_id is None:
        return []
    rows = (
        db.query(KioskAlert)
        .filter(KioskAlert.tenant_id == till.tenant_id, KioskAlert.cleared_at.is_(None))
        .order_by(KioskAlert.raised_at)
        .all()
    )
    if not rows:
        return offline_alerts_for_till(db, till, now=now)
    kiosk_ids = {r.kiosk_machine_id for r in rows}
    kiosks = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(list(kiosk_ids))).all()}
    devices = {d.machine_id: d for d in db.query(KioskDevice).filter(KioskDevice.machine_id.in_(list(kiosk_ids))).all()}
    cfgs: Dict[Any, Dict[str, Any]] = {}

    def cfg_of(row: KioskAlert) -> Dict[str, Any]:
        if row.kiosk_machine_id not in cfgs:
            machine = kiosks.get(row.kiosk_machine_id)
            try:
                cfgs[row.kiosk_machine_id] = KC.effective_config(db, machine) if machine is not None else {}
            except Exception:  # noqa: BLE001
                cfgs[row.kiosk_machine_id] = {}
        return cfgs[row.kiosk_machine_id]

    _expire_help(db, rows, cfg_of, now)
    out = offline_alerts_for_till(db, till, now=now)
    for row in rows:
        if row.cleared_at is not None:
            continue
        kiosk = kiosks.get(row.kiosk_machine_id)
        device = devices.get(row.kiosk_machine_id)
        if kiosk is None or device is None or not device.enabled:
            continue
        cfg = cfg_of(row)
        if till.id not in {m.id for m in targets(db, kiosk, cfg, row.kind)}:
            continue
        out.append(alert_out(row, device.name, route_of(cfg, row.kind)["audience"]))
    db.flush()
    return out


def offline_alerts_for_till(db: Session, till: POSMachine, *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """
    "אין חיבור לאינטרנט": a kiosk silent longer than the `kiosk_offline` rule's minutes while it
    should be trading — it cannot say so itself, so the cloud does, on the card terminal's route
    (card authorisation needs the internet). Gone the moment the kiosk syncs again. Not stored,
    nothing to answer; it never blocks the kiosk (docs/SPEC_KIOSK.md §17).
    """
    from app.services import kiosk_config as KC
    from app.services import kiosk_offline as KO

    now = _now(now)
    out: List[Dict[str, Any]] = []
    if till.tenant_id is None:
        return out
    devices = db.query(KioskDevice).filter(KioskDevice.tenant_id == till.tenant_id, KioskDevice.enabled.is_(True)).all()
    for device in devices:
        seen = _aware(device.last_kiosk_sync_at)
        if seen is None or device.machine_id == till.id:
            continue
        kiosk = db.query(POSMachine).filter(POSMachine.id == device.machine_id).first()
        if kiosk is None or not kiosk.is_active:
            continue
        try:
            minutes = KO.rule_of(db, kiosk)
            if minutes is None or now - seen < timedelta(minutes=minutes):
                continue
            cfg = KC.effective_config(db, kiosk)
            if not KO.trading(db, kiosk, device, cfg, seen):
                continue
            if till.id not in {m.id for m in targets(db, kiosk, cfg, "terminal")}:
                continue
            since = KO._local(db, kiosk, seen).strftime("%H:%M")
        except Exception:  # noqa: BLE001 - an alert never fails the till's fetch
            logger.exception("kiosk offline alert failed for %s", device.machine_id)
            continue
        out.append({
            "id": f"offline:{device.machine_id}:{int(seen.timestamp())}",
            "kioskMachineId": str(device.machine_id),
            "kioskName": device.name,
            "kind": "terminal",
            "key": "kiosk:offline",
            "reason": "offline",
            "text": alert_text(device.name, "terminal", "offline", {"since": since}),
            "detail": {"since": since},
            "raisedAt": _iso(seen),
            "pingCount": 0,
            "pingedAt": None,
            "acknowledgedAt": None,
            "acknowledgedBy": None,
            "audience": route_of(cfg, "terminal")["audience"],
        })
    # The cloud's other alerts on the same routes ("KDS לא מחובר", app/services/kiosk_health.py).
    try:
        from app.services.kiosk_health import cloud_alerts_for_till

        out.extend(cloud_alerts_for_till(db, till, now=now))
    except Exception:  # noqa: BLE001 - an alert never fails the till's fetch
        logger.exception("kiosk cloud alerts failed for till %s", till.id)
    # "סוללה חלשה" of any device of the shop (app/services/battery_alerts.py), on `alerts.battery`.
    try:
        from app.services import battery_alerts

        out.extend(battery_alerts.alerts_for_till(db, till, now=now))
    except Exception:  # noqa: BLE001 - an alert never fails the till's fetch
        logger.exception("battery alerts failed for till %s", till.id)
    return out


def acknowledge(
    db: Session, till: POSMachine, alert_id: str, *, pos_user_name: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    A till's "בדרך" on a help request (cleared: the kiosk shows "הצוות בדרך"), or its "הבנתי" on
    a printer / terminal alert (marked, still open until the kiosk recovers). Idempotent.
    Only a till the alert was routed to; 404 otherwise.
    """
    from app.services import kiosk_config as KC

    now = _now(now)
    if str(alert_id).startswith("battery:"):
        # "סוללה חלשה" (app/services/battery_alerts.py): "הבנתי" marks it; it clears when the device charges.
        from app.services import battery_alerts

        return battery_alerts.acknowledge(db, till, str(alert_id), pos_user_name=pos_user_name, now=now)
    try:
        aid = uuid.UUID(str(alert_id))
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="alert_not_found")
    row = db.query(KioskAlert).filter(KioskAlert.id == aid).first()
    if row is None or row.tenant_id != till.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="alert_not_found")
    kiosk = db.query(POSMachine).filter(POSMachine.id == row.kiosk_machine_id).first()
    device = db.query(KioskDevice).filter(KioskDevice.machine_id == row.kiosk_machine_id).first()
    if kiosk is None or device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="alert_not_found")
    # Another point of sale's kiosk, while this till is locked to its own (app/services/area_lock.py).
    from app.services import area_lock

    area_lock.require_shared_device(db, till, kiosk, "kiosk")
    cfg = KC.effective_config(db, kiosk)
    if till.id not in {m.id for m in targets(db, kiosk, cfg, row.kind)}:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="alert_not_found")
    name = _str(pos_user_name, 100)
    who = f"{name} · {till.name}" if name and till.name else (name or till.name or "קופה")
    if row.acknowledged_at is None:
        row.acknowledged_at = now
        row.acknowledged_by_machine_id = till.id
        row.acknowledged_by_name = who[:200]
    if row.kind == "help" and row.cleared_at is None:
        row.cleared_at = now
        row.clear_reason = "acknowledged"
        # The kiosk hears it on its next sync; wake it now.
        wake_machine(kiosk, "kiosk_alert_ack")
        # The other tills drop it on their next fetch; wake them too.
        _wake([m for m in targets(db, kiosk, cfg, "help") if m.id != till.id])
    db.flush()
    return alert_out(row, device.name, route_of(cfg, row.kind)["audience"])


def brief_by_kiosk(db: Session, kiosk_ids: Sequence[Any]) -> Dict[Any, List[Dict[str, Any]]]:
    """The open alerts per kiosk, short, for the kiosks list and the controlling till's screen."""
    if not kiosk_ids:
        return {}
    out: Dict[Any, List[Dict[str, Any]]] = {}
    for row in (
        db.query(KioskAlert)
        .filter(KioskAlert.kiosk_machine_id.in_(list(kiosk_ids)), KioskAlert.cleared_at.is_(None))
        .order_by(KioskAlert.raised_at)
        .all()
    ):
        out.setdefault(row.kiosk_machine_id, []).append({
            "kind": row.kind, "key": row.key, "reason": row.reason, "text": row.text,
            "raisedAt": _iso(row.raised_at), "acknowledgedBy": row.acknowledged_by_name,
        })
    return out


# ── "סגירה יחד עם ה-Z הסניפי" ────────────────────────────────────────────────


def request_shop_z_close(
    db: Session, shop_id: Any, *, source: str, ref: Optional[str] = None,
    skip_machine_ids: Iterable[Any] = (), now: Optional[datetime] = None,
) -> List[KioskCloseRequest]:
    """
    The shop's Z ran: each kiosk of [shop_id] set to close with it (and not already closed by
    it — [skip_machine_ids]) gets one close request. A kiosk with one still unanswered keeps
    that one. Never raises for the Z's sake (the caller wraps it). The caller commits.
    """
    from app.services import kiosk_config as KC

    now = _now(now)
    if shop_id is None:
        return []
    skip = {str(x) for x in skip_machine_ids}
    made: List[KioskCloseRequest] = []
    # Kiosks by role only: a till's kiosk-mode row is closed by the shop's Z as the till it is.
    devices = (
        db.query(KioskDevice)
        .filter(KioskDevice.shop_id == shop_id, KioskDevice.enabled.is_(True), KioskDevice.home_role.is_(None))
        .all()
    )
    for device in devices:
        if str(device.machine_id) in skip:
            continue
        machine = db.query(POSMachine).filter(POSMachine.id == device.machine_id).first()
        if machine is None or not machine.is_active:
            continue
        cfg = KC.effective_config(db, machine)
        if not ((cfg.get("operations") or {}).get("closeWithShopZ") is True):
            continue
        live = (
            db.query(KioskCloseRequest)
            .filter(KioskCloseRequest.kiosk_machine_id == machine.id, KioskCloseRequest.state.in_(("pending", "delivered")))
            .first()
        )
        if live is not None:
            continue
        row = KioskCloseRequest(
            id=uuid.uuid4(), tenant_id=machine.tenant_id, shop_id=machine.shop_id, kiosk_machine_id=machine.id,
            source=source, source_ref=(str(ref)[:64] if ref else None), state="pending", requested_at=now,
        )
        db.add(row)
        made.append(row)
        wake_machine(machine, "kiosk_close")
    db.flush()
    return made


def withdraw_shop_z_close(db: Session, *, source: str, ref: str, now: Optional[datetime] = None) -> int:
    """
    The shop's Z that asked the kiosks to close was cancelled: every request of it not yet done
    is withdrawn (`cancelled`) — never handed to a kiosk again, so no Z of theirs comes of it.
    The caller commits. How many were withdrawn.
    """
    now = _now(now)
    rows = (
        db.query(KioskCloseRequest)
        .filter(
            KioskCloseRequest.source == source,
            KioskCloseRequest.source_ref == str(ref)[:64],
            KioskCloseRequest.state.in_(("pending", "delivered")),
        )
        .all()
    )
    for row in rows:
        row.state = "cancelled"
        row.finished_at = now
    db.flush()
    return len(rows)


def on_cloud_z_run(db: Session, run: Any, *, now: Optional[datetime] = None) -> List[KioskCloseRequest]:
    """After a cloud z run started: kiosks it closes itself (a live item) are skipped."""
    try:
        from app.models.z_run import ZRunItemStatus

        excluded = getattr(ZRunItemStatus, "EXCLUDED", "excluded")
        inside = [i.machine_id for i in (getattr(run, "items", None) or []) if i.status != excluded]
    except Exception:  # noqa: BLE001
        inside = []
    return request_shop_z_close(
        db, getattr(run, "shop_id", None), source="cloud_shop_z", ref=str(getattr(run, "id", "")),
        skip_machine_ids=inside, now=now,
    )


def on_local_shop_z(db: Session, shop_id: Any, z: Any, *, now: Optional[datetime] = None) -> List[KioskCloseRequest]:
    """
    After the main till's local shop Z reached the cloud: the kiosks it closed — its
    participants, over the LAN or through the cloud (SPEC_INDEPENDENT_TILL §8.14), and any
    whose part it took — are skipped. Not every non-independent kiosk: one in "Z לכל קופה"
    is no participant and makes its own Z.
    """
    from app.services.local_shop_z import participants

    inside = [m.id for m in participants(db, shop_id)]
    for part in ((getattr(z, "offline_report", None) or {}).get("tills") or []):
        if isinstance(part, dict) and part.get("machineId"):
            inside.append(part["machineId"])
    return request_shop_z_close(db, shop_id, source="local_shop_z", ref=str(getattr(z, "id", "") or ""), skip_machine_ids=inside, now=now)


def apply_close_result(db: Session, kiosk: POSMachine, raw: Any, *, now: Optional[datetime] = None) -> None:
    """The kiosk's `status.closeResult`: `{id, state: done|failed, shiftId, zNumber, detail}`."""
    now = _now(now)
    if not isinstance(raw, dict):
        return
    try:
        rid = uuid.UUID(str(raw.get("id")))
    except ValueError:
        return
    row = db.query(KioskCloseRequest).filter(KioskCloseRequest.id == rid, KioskCloseRequest.kiosk_machine_id == kiosk.id).first()
    if row is None or row.state in ("done", "failed", "expired"):
        return
    state = raw.get("state")
    if state not in ("done", "failed"):
        return
    if row.state == "cancelled":
        # The shop's Z that asked was cancelled: the kiosk had it already. What it did is kept,
        # the cancellation too — "בוצע לאחר ביטול".
        row.result = {
            "shiftId": _str(raw.get("shiftId"), 64),
            "zNumber": raw.get("zNumber") if isinstance(raw.get("zNumber"), int) and not isinstance(raw.get("zNumber"), bool) else None,
            "detail": "בוצע לאחר ביטול" if state == "done" else _str(raw.get("detail"), 300),
            "afterCancel": True,
            "state": state,
        }
        row.finished_at = now
        db.flush()
        return
    row.state = state
    row.finished_at = now
    row.result = {
        "shiftId": _str(raw.get("shiftId"), 64),
        "zNumber": raw.get("zNumber") if isinstance(raw.get("zNumber"), int) and not isinstance(raw.get("zNumber"), bool) else None,
        "detail": _str(raw.get("detail"), 300),
    }
    db.flush()


def pending_close_for_kiosk(db: Session, kiosk: POSMachine, *, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """The close request the kiosk has still to carry out (marked delivered), or None."""
    now = _now(now)
    rows = (
        db.query(KioskCloseRequest)
        .filter(KioskCloseRequest.kiosk_machine_id == kiosk.id, KioskCloseRequest.state.in_(("pending", "delivered")))
        .order_by(KioskCloseRequest.requested_at)
        .all()
    )
    live = None
    for row in rows:
        if now - _aware(row.requested_at) > CLOSE_REQUEST_TTL:
            row.state = "expired"
            row.finished_at = now
            continue
        live = row
    if live is None:
        db.flush()
        return None
    if live.state == "pending":
        live.state = "delivered"
        live.delivered_at = now
    db.flush()
    return {"id": str(live.id), "source": live.source, "requestedAt": _iso(live.requested_at)}


def close_state_by_kiosk(db: Session, kiosk_ids: Sequence[Any], *, now: Optional[datetime] = None) -> Dict[Any, Dict[str, Any]]:
    """The latest close-with-the-shop-Z per kiosk (the last 36 h), for the till's and the dashboard's lists."""
    now = _now(now)
    if not kiosk_ids:
        return {}
    since = now - timedelta(hours=36)
    out: Dict[Any, Dict[str, Any]] = {}
    for row in (
        db.query(KioskCloseRequest)
        .filter(KioskCloseRequest.kiosk_machine_id.in_(list(kiosk_ids)), KioskCloseRequest.requested_at >= since)
        .order_by(KioskCloseRequest.requested_at)
        .all()
    ):
        result = row.result or {}
        out[row.kiosk_machine_id] = {
            "id": str(row.id),
            "state": row.state,
            "source": row.source,
            "requestedAt": _iso(row.requested_at),
            "finishedAt": _iso(row.finished_at),
            "zNumber": result.get("zNumber"),
            "detail": result.get("detail"),
        }
    return out


# ── "הדפס עכשיו" / "סמן כטופל" for an unprinted bon (§16.8) ──────────────────


def kiosk_order(db: Session, kiosk: POSMachine, local_id: Optional[str]):
    """The kiosk's order by its local id, or None."""
    from app.models.kiosk import KioskOrder

    if not local_id:
        return None
    return (
        db.query(KioskOrder)
        .filter(KioskOrder.machine_id == kiosk.id, KioskOrder.local_id == str(local_id).strip())
        .first()
    )


def pending_bon_commands(db: Session, kiosk: POSMachine, *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """The bon commands the kiosk has still to carry out (a day at most)."""
    from app.models.kiosk import KioskCommand

    now = _now(now)
    rows = (
        db.query(KioskCommand)
        .filter(
            KioskCommand.kiosk_machine_id == kiosk.id,
            KioskCommand.action.in_(BON_ACTIONS + REPRINT_ACTIONS),
            KioskCommand.status == "requested",
        )
        .order_by(KioskCommand.created_at)
        .all()
    )
    out = []
    for row in rows:
        if now - _aware(row.created_at) > BON_COMMAND_TTL:
            row.status = "refused"
            row.detail = ((row.detail or "") + " · expired")[:500]
            continue
        out.append({"id": str(row.id), "action": row.action, "localId": row.message, "by": row.requested_by_name})
    db.flush()
    return out


def apply_commands_done(db: Session, kiosk: POSMachine, raw: Any) -> None:
    """The kiosk's `status.commandsDone`: the bon commands it carried out."""
    from app.models.kiosk import KioskCommand

    if not isinstance(raw, list):
        return
    for value in raw[:50]:
        try:
            cid = uuid.UUID(str(value))
        except ValueError:
            continue
        row = db.query(KioskCommand).filter(KioskCommand.id == cid, KioskCommand.kiosk_machine_id == kiosk.id).first()
        if row is not None and row.status == "requested":
            row.status = "applied"
            row.detail = ((row.detail or "") + " · done by the kiosk")[:500]
    db.flush()


def unprinted_by_kiosk(db: Session, kiosk_ids: Sequence[Any], days: Dict[Any, Any]) -> Dict[Any, List[Dict[str, Any]]]:
    """Today's orders whose bon did not print and nobody handled, per kiosk, for the controlling till."""
    from app.models.kiosk import KioskOrder

    out: Dict[Any, List[Dict[str, Any]]] = {}
    if not kiosk_ids:
        return out
    rows = (
        db.query(KioskOrder)
        .filter(KioskOrder.machine_id.in_(list(kiosk_ids)), KioskOrder.status == "paid_print_failed")
        .order_by(KioskOrder.paid_at)
        .all()
    )
    for row in rows:
        day = days.get(row.machine_id)
        if day is not None and row.business_date != day:
            continue
        out.setdefault(row.machine_id, []).append({
            "localId": row.local_id,
            "label": row.pickup_label or row.transaction_number or row.local_id[:8],
            "paidAt": _iso(row.paid_at),
            "detail": row.bon_detail,
        })
    return out


# ── kiosk/sync glue ──────────────────────────────────────────────────────────


def on_kiosk_sync(
    db: Session, kiosk: POSMachine, device: KioskDevice, raw_status: Any, cfg: Dict[str, Any],
    *, now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    The kiosk's report (`status.alerts`, `status.closeResult`) applied, and what it is told
    back: `alerts` (its open keys and its help request) and `closeRequest`. An alert never
    fails the sync: errors are logged and the fields come back empty.
    """
    now = _now(now)
    out: Dict[str, Any] = {"alerts": {"open": [], "help": None}, "closeRequest": None, "bonCommands": [], "workMode": None}
    try:
        with db.begin_nested():
            if isinstance(raw_status, dict):
                if "alerts" in raw_status:
                    reconcile(db, kiosk, device, cfg, raw_status.get("alerts"), now=now)
                if raw_status.get("closeResult") is not None:
                    apply_close_result(db, kiosk, raw_status.get("closeResult"), now=now)
                if raw_status.get("commandsDone") is not None:
                    apply_commands_done(db, kiosk, raw_status.get("commandsDone"))
            out["alerts"] = kiosk_view(db, kiosk, now=now)
            out["closeRequest"] = pending_close_for_kiosk(db, kiosk, now=now)
            out["bonCommands"] = pending_bon_commands(db, kiosk, now=now)
            # "מצב עבודה" from the dashboard (kiosk_till_mode.py): the latest switch still to carry out.
            from app.services import kiosk_till_mode

            out["workMode"] = kiosk_till_mode.pending_work_mode(db, kiosk, now=now)
    except Exception:  # noqa: BLE001 - an alert never fails the kiosk's sync
        logger.exception("kiosk alerts / close request failed for %s", kiosk.id)
    return out
