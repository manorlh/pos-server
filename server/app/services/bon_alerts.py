"""
"בון לא הודפס" on the dashboard (the owner, 09.10.2026: a busy restaurant where kitchen tickets
vanish). Every till keeps its own durable print queue; the tickets in it that need a person — not
printed after retries, cut short ("uncertain"), a table round in doubt ("unconfirmed"), a round the
KDS did not take — are reported here as one list (`POST /sync/{m}/kitchen/bon-alerts`, on every
change and on the till's heartbeat). Each becomes an entry of the exceptions log, kind
`bon_unprinted` — so it reaches the alerts page, the cockpit's attention feed and the phones (push
category `bon_unprinted`, app/services/exception_alerts/push.py) like every other alert:
"בון לא הודפס — בר, שולחן 12 (אין נייר)".

* One entry per ticket (dedupe `bon_unprinted:<machine>:<ticket id>`); a new one goes through the
  alert rules (push / SMS) once.
* The till's list is complete: an open entry of that till it no longer lists is resolved — it
  printed, or a person handled it there ("הודפס / טופל בקופה").
* "סמן כטופל" on the till (a manager's code) comes with who: the entry is acknowledged with
  "סומן כטופל בקופה — <name>", and kept for the log even if it was never reported open.
* A kiosk says its unprinted bons through its own alerts (app/services/kiosk_ops.py); those are
  bridged into the same kind (`bon_unprinted:kiosk:<alert id>`, `kiosk_alert_raised/cleared`).

Never raises over the alert engine: the till's report is answered whatever a rule does.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.exception_alerts import ExceptionLogEntry
from app.models.pos_machine import POSMachine
from app.services.exception_alerts import log as L

logger = logging.getLogger(__name__)

KIND = "bon_unprinted"
SOURCE = "kitchen_bon"
#: At most this many tickets in one report.
MAX_BONS = 100

#: The till's reason codes (hardware/kitchen/PrintQueueView.kt `BonReason`), in words.
REASON_LABELS: Dict[str, str] = {
    "no_paper": "אין נייר",
    "cover_open": "המכסה פתוח",
    "printer_error": "תקלת מדפסת",
    "offline": "המדפסת לא מגיבה",
    "uncertain": "נקטע באמצע הדפסה",
    "unconfirmed": "לא ידוע אם נשלח למטבח",
    "kds_not_taken": "מסך המטבח לא קיבל",
    "host_silent": "קופת ההדפסה לא עונה",
    "slow": "ממתין בקופת ההדפסה",
    "expired": "אף קופה לא לקחה את הבון",
    "refused": "אין לאן לשלוח",
    "error": "תקלה",
}

RESOLVED_NOTE = "הודפס / טופל בקופה"
KIOSK_RESOLVED_NOTE = "הודפס / טופל בקיוסק"


def _clip(value: Any, limit: int) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text[:limit] or None


def _int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


def _when(raw: Any, now: datetime) -> datetime:
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return now


def dedupe_key(machine_id: Any, bon_id: str) -> str:
    return f"{KIND}:{machine_id}:{bon_id}"


def summary_of(bon: Dict[str, Any]) -> str:
    """"בון לא הודפס — בר, שולחן 12 (אין נייר)"."""
    where = ", ".join(x for x in (bon.get("printerName"), bon.get("title")) if x)
    head = "בון לא הודפס" + (f" — {where}" if where else "")
    reason = REASON_LABELS.get(bon.get("reason") or "")
    if reason is None and bon.get("error"):
        reason = bon["error"][:80]
    return (head + (f" ({reason})" if reason else ""))[:300]


def clean_bon(raw: Any) -> Optional[Dict[str, Any]]:
    """One ticket as the till sent it, clamped; None when it has no id or state."""
    if hasattr(raw, "model_dump"):
        raw = raw.model_dump(by_alias=True)
    if not isinstance(raw, dict):
        return None
    bon_id = _clip(raw.get("id"), 100)
    state = _clip(raw.get("state"), 24)
    if not bon_id or not state:
        return None
    return {
        "id": bon_id,
        "state": state,
        "reason": _clip(raw.get("reason"), 40),
        "printerId": _clip(raw.get("printerId"), 64),
        "printerName": _clip(raw.get("printerName"), 80),
        "title": _clip(raw.get("title"), 80),
        "items": _int(raw.get("items")),
        "attempts": _int(raw.get("attempts")),
        "since": _clip(raw.get("since"), 40),
        "error": _clip(raw.get("error"), 200),
        "handledBy": _clip(raw.get("handledBy"), 80),
        "handledNote": _clip(raw.get("handledNote"), 200),
    }


def _scope(db: Session, machine: POSMachine) -> Dict[str, Any]:
    company_id = None
    if machine.shop_id is not None:
        from app.models.shop import Shop

        shop = db.get(Shop, machine.shop_id)
        company_id = shop.company_id if shop is not None else None
    return {
        "tenant_id": machine.tenant_id,
        "company_id": company_id,
        "shop_id": machine.shop_id,
        "area_id": getattr(machine, "area_id", None),
        "machine_id": machine.id,
    }


def _spec(key: str, source_id: str, bon: Dict[str, Any], scope: Dict[str, Any], occurred_at: datetime,
          summary: Optional[str] = None) -> L.EntrySpec:
    return L.EntrySpec(
        source=SOURCE,
        source_id=source_id,
        dedupe_key=key,
        kind=KIND,
        severity="high",
        occurred_at=occurred_at,
        summary=summary or summary_of(bon),
        details={k: v for k, v in bon.items() if v is not None},
        value=bon.get("attempts"),
        **scope,
    )


def _alert(db: Session, entry: ExceptionLogEntry, now: datetime) -> None:
    """A new entry through the alert rules (push / SMS), never failing the till's report."""
    try:
        from app.services.exception_alerts import engine as E

        E.process_entry(db, entry, now=now)
    except Exception:  # noqa: BLE001 - an alert rule never fails the report
        logger.exception("bon alert %s: alert rules failed", entry.dedupe_key)


def _resolve(entry: ExceptionLogEntry, note: str, now: datetime) -> None:
    entry.acknowledged_at = now
    entry.acknowledged_by_user_id = None
    entry.note = note[:500]


def _record_open(db: Session, key: str, source_id: str, bon: Dict[str, Any], scope: Dict[str, Any],
                 now: datetime, summary: Optional[str] = None) -> bool:
    """Write (or refresh, or re-open) the entry of one open ticket. True when it is new."""
    existing = L.find(db, key)
    if (
        existing is not None and existing.acknowledged_at is not None
        and existing.acknowledged_by_user_id is None and (existing.note or "").startswith("הודפס")
    ):
        # Resolved here before (printed), and not printed after all: open again. A manager's own
        # "טופל" on the dashboard is theirs — never undone by the till's next report.
        existing.acknowledged_at = None
        existing.note = None
    entry, created = L.record(db, _spec(key, source_id, bon, scope, _when(bon.get("since"), now), summary), now=now)
    if created:
        _alert(db, entry, now)
    return created


def report(db: Session, machine: POSMachine, body: Any, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """The till's list of tickets that need a person (and those a person handled). The caller commits."""
    now = now or datetime.now(timezone.utc)
    raw_bons = getattr(body, "bons", None)
    if raw_bons is None and isinstance(body, dict):
        raw_bons = body.get("bons")
    complete = getattr(body, "complete", None)
    if complete is None and isinstance(body, dict):
        complete = body.get("complete", True)
    bons = [b for b in (clean_bon(x) for x in list(raw_bons or [])[:MAX_BONS]) if b is not None]
    scope = _scope(db, machine)
    recorded = 0
    listed = set()
    for bon in bons:
        key = dedupe_key(machine.id, bon["id"])
        listed.add(key)
        source_id = f"{machine.id}:{bon['id']}"[:100]
        if bon["state"] == "handled":
            entry = L.find(db, key)
            if entry is None:
                entry, created = L.record(db, _spec(key, source_id, bon, scope, _when(bon.get("since"), now)), now=now)
            who = bon.get("handledBy") or "?"
            note = f"סומן כטופל בקופה — {who}" + (f" · {bon['handledNote']}" if bon.get("handledNote") else "")
            if entry.acknowledged_at is None or (entry.note or "").startswith("הודפס"):
                _resolve(entry, note, now)
            continue
        if _record_open(db, key, source_id, bon, scope, now):
            recorded += 1
    resolved = 0
    if complete:
        prefix = f"{KIND}:{machine.id}:"
        rows = (
            db.query(ExceptionLogEntry)
            .filter(
                ExceptionLogEntry.kind == KIND,
                ExceptionLogEntry.source == SOURCE,
                ExceptionLogEntry.machine_id == machine.id,
                ExceptionLogEntry.acknowledged_at.is_(None),
                ExceptionLogEntry.dedupe_key.like(prefix + "%"),
            )
            .all()
        )
        for row in rows:
            if row.dedupe_key not in listed:
                _resolve(row, RESOLVED_NOTE, now)
                resolved += 1
    db.flush()
    still_open = (
        db.query(ExceptionLogEntry)
        .filter(
            ExceptionLogEntry.kind == KIND,
            ExceptionLogEntry.machine_id == machine.id,
            ExceptionLogEntry.acknowledged_at.is_(None),
        )
        .count()
    )
    return {"open": still_open, "recorded": recorded, "resolved": resolved}


# ── A kiosk's unprinted bons (its own alerts, app/services/kiosk_ops.py) ─────────

#: The kiosk alert reasons that mean a bon did not print.
KIOSK_BON_REASONS = ("bon_unprinted", "bon_failed")


def kiosk_alert_key(alert_id: Any) -> str:
    return f"{KIND}:kiosk:{alert_id}"


def kiosk_alert_raised(db: Session, kiosk: POSMachine, alert: Any, *, now: Optional[datetime] = None) -> None:
    """A kiosk raised (or re-worded) a bon alert: the same "בון לא הודפס" entry the tills make."""
    try:
        if getattr(alert, "kind", None) != "printer" or getattr(alert, "reason", None) not in KIOSK_BON_REASONS:
            return
        now = now or datetime.now(timezone.utc)
        detail = alert.detail if isinstance(alert.detail, dict) else {}
        bon = {
            "id": str(alert.id),
            "state": "failed",
            "reason": "error",
            "printerName": _clip(detail.get("printer"), 80),
            "title": _clip(detail.get("orders"), 80),
            "items": _int(detail.get("count") or detail.get("failed")),
            "error": _clip(alert.text, 200),
            "kiosk": True,
        }
        key = kiosk_alert_key(alert.id)
        _record_open(db, key, f"kiosk:{alert.id}", bon, _scope(db, kiosk), now, summary=_clip(alert.text, 300))
    except Exception:  # noqa: BLE001 - the kiosk's own alert never fails over its dashboard twin
        logger.exception("kiosk bon alert %s: not recorded", getattr(alert, "id", None))


def kiosk_alert_cleared(db: Session, alert: Any, *, now: Optional[datetime] = None) -> None:
    """The kiosk's bon alert cleared (printed, handled): its entry is resolved."""
    try:
        if getattr(alert, "kind", None) != "printer":
            return
        entry = L.find(db, kiosk_alert_key(alert.id))
        if entry is not None and entry.acknowledged_at is None:
            _resolve(entry, KIOSK_RESOLVED_NOTE, now or datetime.now(timezone.utc))
    except Exception:  # noqa: BLE001
        logger.exception("kiosk bon alert %s: not resolved", getattr(alert, "id", None))
