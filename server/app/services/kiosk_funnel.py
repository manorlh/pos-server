"""
The kiosk's anonymous funnel ("ביצועי קיוסקים", docs/SPEC_KIOSK_INSIGHTS.md §1).

A kiosk (Android or Windows) records each customer session as small events and sends them
in batches through its outbox: `POST /sync/{machine_id}/kiosk/events`. Each event is
`{sessionId, seq, type, at, step?, elapsedMs?, data?}`; (machine, sessionId, seq) is its
identity, so a batch sent twice — the kiosk lost the answer, or the network dropped it —
changes nothing the second time. Events of one session may arrive over several batches and
out of order; the session row (`kiosk_sessions`) is folded from them as they come.

Nothing personal is ever stored: `data` keeps only the keys its type allows (product and
rule ids, quantities, amounts, reasons), short strings, numbers and booleans. A bad event is
dropped alone, never the batch.

Steps (`STEPS`) and their rank in the funnel (`STEP_RANK`): the checkout's own steps —
details, tip, "איך תרצו לשלם?" — share one rank, so the funnel does not depend on the order
the business set for them (`payment.checkoutSteps`).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.kiosk_insights import KioskEvent, KioskSession
from app.models.pos_machine import POSMachine

logger = logging.getLogger(__name__)

#: At most this many events in one batch (the kiosk sends ≤ 200).
BATCH_MAX = 500
#: An event this far in the future of the server's clock is the kiosk's clock gone wrong: kept at now.
CLOCK_SKEW_MAX = timedelta(hours=2)
#: Older than this, an event is not taken (the outbox should never hold it that long).
MAX_AGE = timedelta(days=45)

EVENT_TYPES = (
    "session_start",  # the first tap on the attract screen (or "לקחת" / "לשבת" there)
    "screen",  # a screen entered (step)
    "item_open",  # a product's sheet opened
    "item_add",  # a product went into the basket
    "upsell",  # an upsell window: shown / accepted / declined / dismissed
    "pay",  # a payment: started / approved / declined / cancelled / error / unknown
    "basket_check",  # the pre-payment check found a change (or the cloud could not be asked)
    "help",  # "בקשת עזרה"
    "session_end",  # paid / abandoned / timeout / cancelled / help / reset
)

STEPS = (
    "attract", "service", "catalog", "item", "cart", "confirm",
    "details", "tip", "pay_method", "pay", "success",
)
#: The funnel's ranks: a session counts at a stage when it reached that rank or beyond.
STEP_RANK = {
    "attract": 0, "service": 1, "catalog": 2, "item": 3, "cart": 5, "confirm": 5,
    "details": 6, "tip": 6, "pay_method": 6, "pay": 7, "success": 8,
}
RANK_ADDED = 4
RANK_PAID = 8
#: The funnel's stages, in order: (key, rank).
FUNNEL = (
    ("start", 0), ("catalog", 2), ("item", 3), ("added", RANK_ADDED),
    ("cart", 5), ("checkout", 6), ("pay", 7), ("paid", RANK_PAID),
)

END_REASONS = ("paid", "abandoned", "timeout", "cancelled", "help", "reset")
PAY_RESULTS = ("started", "approved", "declined", "cancelled", "error", "unknown")
PAY_FAILURES = ("declined", "cancelled", "error", "unknown")
UPSELL_ACTIONS = ("shown", "accepted", "declined", "dismissed")
#: When the window came up: after an item was added, at a step change before the basket, before payment.
UPSELL_MOMENTS = ("item", "steps", "checkout")
SERVICES = ("take_away", "eat_in")
PLATFORMS = ("android", "windows", "web")  # "web": the browser kiosk at /k

#: What `data` may hold, per type. Anything else is dropped (never a name, phone or card).
DATA_KEYS: Dict[str, Tuple[str, ...]] = {
    "session_start": ("platform", "service", "lang"),
    "screen": ("service",),
    "item_open": ("productId",),
    "item_add": ("productId", "qty", "upsell", "priceAgorot"),
    "upsell": ("ruleId", "action", "moment", "productId"),
    "pay": ("result", "reason", "amountAgorot", "method"),
    "basket_check": ("removed", "repriced", "fromAgorot", "toAgorot", "source", "outcome", "promotions"),
    "help": (),
    "session_end": ("reason", "durationMs", "basketAgorot", "items", "tipAgorot"),
}
STR_MAX = 64


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _parse_at(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value or len(value) > 40:
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return _utc(parsed)


def _int(value: Any, lo: int = 0, hi: int = 10**12) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = int(value)
    return number if lo <= number <= hi else None


def _str(value: Any, max_len: int = STR_MAX) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:max_len] if text else None


def _clean_data(kind: str, raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Any] = {}
    for key in DATA_KEYS.get(kind, ()):
        value = raw.get(key)
        if isinstance(value, bool):
            out[key] = value
        elif isinstance(value, (int, float)):
            number = _int(value, -10**12, 10**12)
            if number is not None:
                out[key] = number
        elif isinstance(value, str):
            text = _str(value)
            if text is not None:
                out[key] = text
    # Enums: an unknown value becomes "other" (an event is never refused for its detail).
    if kind == "pay":
        out["result"] = out.get("result") if out.get("result") in PAY_RESULTS else "unknown"
    elif kind == "upsell":
        if out.get("action") not in UPSELL_ACTIONS:
            out["action"] = "shown"
        if out.get("moment") not in UPSELL_MOMENTS:
            out.pop("moment", None)
    elif kind == "session_end":
        if out.get("reason") not in END_REASONS:
            out["reason"] = "abandoned"
    elif kind == "session_start":
        if out.get("platform") not in PLATFORMS:
            out.pop("platform", None)
        if out.get("service") not in SERVICES:
            out.pop("service", None)
    elif kind == "screen":
        if out.get("service") not in SERVICES:
            out.pop("service", None)
    return out


def clean_event(raw: Any, now: datetime) -> Optional[Dict[str, Any]]:
    """One event as stored, or None when it is not one (dropped alone)."""
    if not isinstance(raw, dict):
        return None
    session_id = _str(raw.get("sessionId"))
    seq = _int(raw.get("seq"), 0, 1_000_000)
    kind = raw.get("type")
    at = _parse_at(raw.get("at"))
    if session_id is None or seq is None or kind not in EVENT_TYPES or at is None:
        return None
    if at > now + CLOCK_SKEW_MAX:
        at = now
    if at < now - MAX_AGE:
        return None
    step = raw.get("step")
    step = step if step in STEPS else None
    if kind == "screen" and step is None:
        return None
    return {
        "sessionId": session_id,
        "seq": seq,
        "type": kind,
        "step": step,
        "at": at,
        "elapsedMs": _int(raw.get("elapsedMs"), 0, 7 * 24 * 3_600_000),
        "data": _clean_data(kind, raw.get("data")),
    }


# ── Folding a session ────────────────────────────────────────────────────────


def _rank_of(event: Dict[str, Any]) -> int:
    rank = STEP_RANK.get(event.get("step") or "", 0)
    kind, data = event["type"], event["data"]
    if kind == "item_open":
        rank = max(rank, STEP_RANK["item"])
    elif kind == "item_add":
        rank = max(rank, RANK_ADDED)
    elif kind == "pay":
        rank = max(rank, RANK_PAID if data.get("result") == "approved" else STEP_RANK["pay"])
    elif kind == "session_end" and data.get("reason") == "paid":
        rank = RANK_PAID
    return rank


def _step_list(row: KioskSession) -> List[str]:
    return [s for s in (row.steps or "").split(",") if s]


def fold(row: KioskSession, event: Dict[str, Any]) -> None:
    """One new event into its session row."""
    kind, data, at = event["type"], event["data"], event["at"]
    elapsed = event.get("elapsedMs")
    row.max_rank = max(row.max_rank or 0, _rank_of(event))
    step = event.get("step")
    if kind == "item_open":
        step = "item"
    if step is not None:
        steps = _step_list(row)
        if step not in steps and len(",".join(steps + [step])) <= 200:
            steps.append(step)
            row.steps = ",".join(steps)
        # The step the customer was on last: the latest event that has one decides.
        if event["seq"] >= (row.last_seq or 0) and kind != "session_end":
            row.last_step = step
    if event["seq"] >= (row.last_seq or 0):
        row.last_seq = event["seq"]
    if kind == "session_start":
        if _utc(row.started_at) is None or at < _utc(row.started_at):
            row.started_at = at
        row.platform = data.get("platform") or row.platform
        row.service = data.get("service") or row.service
    elif kind == "screen":
        row.service = data.get("service") or row.service
    elif kind == "upsell":
        action = data.get("action")
        if action == "shown":
            row.upsell_shown = (row.upsell_shown or 0) + 1
        elif action == "accepted":
            row.upsell_accepted = (row.upsell_accepted or 0) + 1
        else:
            row.upsell_declined = (row.upsell_declined or 0) + 1
    elif kind == "pay":
        result = data.get("result")
        if result == "started":
            row.pay_attempts = (row.pay_attempts or 0) + 1
        elif result == "approved":
            row.paid = True
            if elapsed is not None:
                row.order_ms = elapsed
            if isinstance(data.get("amountAgorot"), int) and row.basket_agorot is None:
                row.basket_agorot = data["amountAgorot"]
        elif result in PAY_FAILURES:
            row.pay_failures = (row.pay_failures or 0) + 1
    elif kind == "basket_check":
        if (data.get("removed") or 0) > 0 or (data.get("repriced") or 0) > 0 or data.get("fromAgorot") != data.get("toAgorot"):
            row.basket_changed = True
    elif kind == "help":
        row.help = True
    elif kind == "session_end":
        row.ended_at = at
        reason = data.get("reason")
        row.end_reason = "paid" if row.paid and reason != "paid" else reason
        if reason == "paid":
            row.paid = True
        if reason == "help":
            row.help = True
        # The step it ended on, when the kiosk names it.
        if event.get("step") is not None and not row.paid:
            row.last_step = event["step"]
        duration = data.get("durationMs") if isinstance(data.get("durationMs"), int) else elapsed
        if duration is not None and duration >= 0:
            row.duration_ms = duration
        for key, attr in (("basketAgorot", "basket_agorot"), ("items", "items"), ("tipAgorot", "tip_agorot")):
            value = data.get(key)
            if isinstance(value, int) and value >= 0:
                setattr(row, attr, value)


# ── Ingesting a batch ────────────────────────────────────────────────────────


def _existing_seqs(db: Session, machine_id, session_ids: Iterable[str]) -> Dict[str, set]:
    ids = list(set(session_ids))
    out: Dict[str, set] = {s: set() for s in ids}
    if not ids:
        return out
    for sid, seq in (
        db.query(KioskEvent.session_id, KioskEvent.seq)
        .filter(KioskEvent.machine_id == machine_id, KioskEvent.session_id.in_(ids))
        .all()
    ):
        out.setdefault(sid, set()).add(seq)
    return out


def _sessions(db: Session, machine_id, session_ids: Iterable[str]) -> Dict[str, KioskSession]:
    ids = list(set(session_ids))
    if not ids:
        return {}
    return {
        r.session_id: r
        for r in db.query(KioskSession).filter(KioskSession.machine_id == machine_id, KioskSession.session_id.in_(ids)).all()
    }


def _apply(db: Session, machine: POSMachine, events: List[Dict[str, Any]]) -> Tuple[int, int]:
    """Insert the new events and fold them into their sessions. Returns (accepted, duplicates)."""
    by_session: Dict[str, List[Dict[str, Any]]] = {}
    for e in events:
        by_session.setdefault(e["sessionId"], []).append(e)
    seen = _existing_seqs(db, machine.id, by_session.keys())
    rows = _sessions(db, machine.id, by_session.keys())
    accepted = duplicates = 0
    for sid, items in by_session.items():
        items.sort(key=lambda e: e["seq"])
        fresh = []
        known = seen.get(sid, set())
        for e in items:
            if e["seq"] in known:
                duplicates += 1
                continue
            known.add(e["seq"])
            fresh.append(e)
        if not fresh:
            continue
        row = rows.get(sid)
        if row is None:
            first = fresh[0]
            start = first["at"]
            if first["type"] != "session_start" and first.get("elapsedMs"):
                start = first["at"] - timedelta(milliseconds=first["elapsedMs"])
            row = KioskSession(
                id=uuid.uuid4(), tenant_id=machine.tenant_id, shop_id=machine.shop_id, machine_id=machine.id,
                session_id=sid, started_at=start, max_rank=0, last_seq=0,
                upsell_shown=0, upsell_accepted=0, upsell_declined=0, pay_attempts=0, pay_failures=0,
                paid=False, help=False, basket_changed=False,
            )
            db.add(row)
            rows[sid] = row
        for e in fresh:
            db.add(KioskEvent(
                id=uuid.uuid4(), tenant_id=machine.tenant_id, shop_id=machine.shop_id, machine_id=machine.id,
                session_id=sid, seq=e["seq"], type=e["type"], step=e.get("step"), at=e["at"],
                elapsed_ms=e.get("elapsedMs"), data=e["data"] or None,
            ))
            fold(row, e)
            accepted += 1
    db.flush()
    return accepted, duplicates


def ingest(db: Session, machine: POSMachine, raw_events: Any, *, now: Optional[datetime] = None) -> Dict[str, int]:
    """
    `POST /sync/{m}/kiosk/events`: the batch cleaned, de-duplicated, stored and folded. Answers
    `{accepted, duplicates, rejected}`; the caller commits. Two batches racing on one session
    meet the unique key: the loser is retried once against what the winner wrote.
    """
    now = _utc(now) or datetime.now(timezone.utc)
    items = raw_events if isinstance(raw_events, list) else []
    rejected = max(0, len(items) - BATCH_MAX)
    events: List[Dict[str, Any]] = []
    for raw in items[:BATCH_MAX]:
        e = clean_event(raw, now)
        if e is None:
            rejected += 1
        else:
            events.append(e)
    if not events:
        return {"accepted": 0, "duplicates": 0, "rejected": rejected}
    for attempt in (1, 2):
        try:
            with db.begin_nested():
                accepted, duplicates = _apply(db, machine, events)
            return {"accepted": accepted, "duplicates": duplicates, "rejected": rejected}
        except IntegrityError:
            if attempt == 2:
                raise
            logger.info("kiosk events of %s raced another batch: retried", machine.id)
            db.expire_all()
    return {"accepted": 0, "duplicates": 0, "rejected": rejected}  # pragma: no cover


def recent_sessions(db: Session, machine_id, limit: int = 10) -> List[Dict[str, Any]]:
    """The kiosk's last sessions, for the device-health drawer."""
    rows = (
        db.query(KioskSession)
        .filter(KioskSession.machine_id == machine_id)
        .order_by(KioskSession.started_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "sessionId": r.session_id,
            "startedAt": _iso(r.started_at),
            "endedAt": _iso(r.ended_at),
            "endReason": r.end_reason or ("paid" if r.paid else None),
            "lastStep": r.last_step,
            "paid": bool(r.paid),
            "orderSec": round(r.order_ms / 1000) if r.order_ms is not None else None,
            "basketAgorot": r.basket_agorot,
            "items": r.items,
            "payFailures": r.pay_failures or 0,
            "help": bool(r.help),
        }
        for r in rows
    ]


def _iso(value: Optional[datetime]) -> Optional[str]:
    value = _utc(value)
    return value.isoformat().replace("+00:00", "Z") if value is not None else None
