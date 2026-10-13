"""
"גיבוי אוטומטי לשרת המקומי" — the cloud moves a shop's local server by itself, only where the shop
switched it on (P:/specs/dedicated-local-server.md §10.2, §11.7; the owner, 13.10.2026: "פיצ'ר דינמי
שלא יבצע לבד אם לא הדלקתי").

**Off by default.** The shop's setting (`shop.settings["localServerFailover"]`):
`{enabled, targetMachineId, minutes}` — off, no target, 3 minutes until someone changes it. Only
the super admin and a holder of "העברת שרת מקומי" (`local_server_switch`) change it
(`local_server_switch.may_switch`); every change is audited (`local_server_failover_changed`).

**When the cloud acts** (`evaluate`) — only if *all* hold:

1. the switch is on, explicitly, at this shop;
2. a target is set, and it may still take the server (`local_server_switch.ineligible_reason`:
   the shop's, active, Android, in the LAN group, a till or a dedicated server);
3. the target is online;
4. the target was heard *after* the host had been silent N minutes — a server that fell, not the
   shop's internet (then the target is silent too);
5. the current host (the tables host, else the main till) has not been heard for N minutes;
6. the target is not the host already — so the cloud never moves the server back by itself;
7. no other move of the shop's server is under way (`local_server_switch.switch_lock`, not
   waited for: the failover never fires during a manual switch, and never twice at once).

**Per role** (§11.9): the hosts watched are the devices holding a host role — the tables host,
the main till (the shop Z producer in local mode) and the print server, which a shop may give to
different devices (app/services/local_server_roles.py). A silent one gives the target only the
roles it held (`local_server_roles.move_roles`); the others stay where they are.

**What it does** (`run_shop`): the manual switch's move — the notice to every till, the audit
(`local_server_switched`, `source: "auto_failover"`) — with no shift closed and nothing forced,
for the roles the failed device held; then a high-severity exception (`local_server_failover`),
which the alerts send to the managers. Re-checked under the lock with fresh rows, so a pass that lost a race finds the
target already the host and does nothing.

**The check** (`run_once`) runs every 30 s in a background thread of each API instance
(`start_background_worker`, `LOCAL_SERVER_FAILOVER_WORKER_ENABLED`); a pass takes a Postgres
advisory lock first, so one instance checks at a time.
"""
from __future__ import annotations

import logging
import os
import threading
import types
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shop import Shop

logger = logging.getLogger(__name__)

SETTINGS_KEY = "localServerFailover"
DEFAULT_MINUTES = 3
MIN_MINUTES = 2
MAX_MINUTES = 60
HISTORY_KEPT = 20

FAILOVER_EXCEPTION = "local_server_failover"
#: The host roles' holders a pass may move, at most one move each (tables, main till, printing).
ROLE_HOSTS = ("tables", "main", "print")
CHANGED_EXCEPTION = "local_server_failover_changed"

INTERVAL_SECONDS = 30.0
#: pg advisory lock key of the pass (any constant shared by every instance).
LOCK_KEY = 0x10CA15E7F0
ENV_SWITCH = "LOCAL_SERVER_FAILOVER_WORKER_ENABLED"

_thread: Optional[threading.Thread] = None
_stop = threading.Event()


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
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def _refusal(status_code: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message, **extra})


# ── The setting ───────────────────────────────────────────────────────────────


def _raw(shop: Optional[Shop]) -> Dict[str, Any]:
    raw = (getattr(shop, "settings", None) or {}).get(SETTINGS_KEY) if shop is not None else None
    return raw if isinstance(raw, dict) else {}


def settings_of(shop: Optional[Shop]) -> Dict[str, Any]:
    """The shop's setting as it stands: off, no target, 3 minutes unless someone changed it."""
    raw = _raw(shop)
    minutes = raw.get("minutes")
    if isinstance(minutes, bool) or not isinstance(minutes, int) or not MIN_MINUTES <= minutes <= MAX_MINUTES:
        minutes = DEFAULT_MINUTES
    target = _uuid(raw.get("targetMachineId"))
    return {
        # On only when it says so, explicitly: anything else is off.
        "enabled": raw.get("enabled") is True,
        "targetMachineId": str(target) if target is not None else None,
        "minutes": minutes,
    }


def _put(shop: Shop, value: Dict[str, Any]) -> None:
    settings = dict(shop.settings or {})
    settings[SETTINGS_KEY] = value
    shop.settings = settings  # reassigned: a JSONB column sees only a new value


def _target(db: Session, shop: Shop, target_id: Any) -> Optional[POSMachine]:
    tid = _uuid(target_id)
    if tid is None:
        return None
    machine = db.get(POSMachine, tid)
    if machine is None or machine.shop_id is None or str(machine.shop_id) != str(shop.id):
        return None
    return machine


def update(
    db: Session, user: Any, shop: Shop, *, enabled: bool, target_machine_id: Any, minutes: Optional[int],
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    Change the setting: the super admin, or a holder of "העברת שרת מקומי" (403
    `local_server_switch_forbidden`). On needs a target (422 `failover_target_required`) that may
    take the server — online or not now (422 `target_not_in_shop`, 409 `target_not_eligible`);
    minutes 2–60 (422 `failover_minutes_invalid`). Audited. The caller commits.
    """
    from app.services import local_server_switch as LSS

    now = _now(now)
    LSS.require_switch(db, user)
    if minutes is None:
        minutes = settings_of(shop)["minutes"]
    if isinstance(minutes, bool) or not isinstance(minutes, int) or not MIN_MINUTES <= minutes <= MAX_MINUTES:
        raise _refusal(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "failover_minutes_invalid",
            f"מספר הדקות בלי קשר לפני המעבר צריך להיות בין {MIN_MINUTES} ל-{MAX_MINUTES}.",
            minMinutes=MIN_MINUTES, maxMinutes=MAX_MINUTES,
        )
    target = None
    if target_machine_id is not None:
        target = _target(db, shop, target_machine_id)
        if target is None:
            raise _refusal(status.HTTP_422_UNPROCESSABLE_ENTITY, "target_not_in_shop", "המכשיר שנבחר אינו בסניף הזה.")
        reason = LSS.ineligible_reason(db, target, now, require_online=False)
        if reason is not None:
            raise _refusal(
                status.HTTP_409_CONFLICT, "target_not_eligible",
                f"{LSS.till_label(target)}: {LSS.INELIGIBLE[reason]}.", reason=reason,
            )
    if enabled and target is None:
        raise _refusal(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "failover_target_required",
            "כדי להדליק גיבוי אוטומטי צריך לבחור לאן עוברים: שרת גיבוי או קופה של הסניף.",
        )
    before = settings_of(shop)
    after = {"enabled": bool(enabled), "targetMachineId": str(target.id) if target is not None else None, "minutes": minutes}
    raw = dict(_raw(shop))
    if before == after:
        return view(db, shop, user, now=now)
    change = {
        "at": now.isoformat(),
        "by": LSS.who(user),
        "byUserId": str(user.id) if getattr(user, "id", None) else None,
        "before": before,
        "after": after,
        "target": LSS._ref(target),
    }
    history = [h for h in (raw.get("history") or []) if isinstance(h, dict)]
    _put(shop, {
        **raw,
        **after,
        "updatedAt": now.isoformat(),
        "updatedBy": change["by"],
        "history": (history + [change])[-HISTORY_KEPT:],
    })
    _record_change(db, shop, target, change)
    logger.warning("shop %s: local server failover set by %s: %s -> %s", shop.id, change["by"], before, after)
    return view(db, shop, user, now=now)


def _stand_in(shop: Shop, machine: Optional[POSMachine] = None) -> Any:
    """Where an audit row of the shop (not of a till) is filed: the target, else the shop itself."""
    if machine is not None:
        return machine
    return types.SimpleNamespace(id=None, tenant_id=shop.tenant_id, shop_id=shop.id, area_id=None)


def _change_summary(change: Dict[str, Any]) -> str:
    before, after = change.get("before") or {}, change.get("after") or {}
    target = change.get("target") or {}
    label = (f"קופה {target['posNumber']}" if target.get("posNumber") else target.get("name")) or "—"
    if after.get("enabled") and not before.get("enabled"):
        head = "גיבוי אוטומטי לשרת המקומי הודלק"
    elif before.get("enabled") and not after.get("enabled"):
        head = "גיבוי אוטומטי לשרת המקומי כובה"
    else:
        head = "הגדרות הגיבוי האוטומטי לשרת המקומי שונו"
    return f"{head} ע״י {change.get('by')} · יעד: {label} · אחרי {after.get('minutes')} דקות בלי קשר"


def _record_change(db: Session, shop: Shop, target: Optional[POSMachine], change: Dict[str, Any]) -> None:
    from app.services.exceptions import Detector, Found

    try:
        Detector(db)._record(_stand_in(shop, target), Found(
            type=CHANGED_EXCEPTION,
            key=f"{CHANGED_EXCEPTION}:{shop.id}:{change['at']}"[:200],
            occurred_at=_aware(datetime.fromisoformat(change["at"])) or _now(),
            details={**change, "shopId": str(shop.id), "summary": _change_summary(change)},
        ))
    except Exception:  # noqa: BLE001 - the setting is what matters; the log keeps the rest
        logger.exception("could not record the failover setting change of shop %s", shop.id)


# ── Should the cloud act now ──────────────────────────────────────────────────


@dataclass
class Decision:
    fire: bool
    reason: str
    message: str
    host: Optional[POSMachine] = None
    target: Optional[POSMachine] = None


#: Why the failover would not act now, in the owner's words (the card says it).
REASONS = {
    "off": "כבוי — כל העברה של השרת נעשית ידנית.",
    "no_target": "לא נבחר מכשיר יעד.",
    "target_not_eligible": "מכשיר היעד לא יכול לקבל את השרת כרגע.",
    "target_offline": "מכשיר היעד לא מחובר לענן — לא יעבירו אליו.",
    "no_host": "אין כרגע שרת מקומי בסניף — אין ממה לעבור.",
    "target_is_host": "מכשיר היעד הוא כבר השרת המקומי — הענן לא מחזיר שרת לבד.",
    "host_heard": "השרת המקומי מחובר. אם הענן לא ישמע אותו {minutes} דקות, השרת יעבור למכשיר היעד.",
    "target_not_heard_since": (
        "השרת המקומי שותק, אבל גם מכשיר היעד לא נשמע מאז — כנראה האינטרנט בסניף נפל, ולא השרת. "
        "לא מעבירים."
    ),
    "fire": "השרת המקומי לא נשמע {minutes} דקות ומכשיר היעד מחובר: מעבירים.",
}


def hosts_of(db: Session, shop: Shop) -> List[POSMachine]:
    """The devices holding a host role, each once: the tables host, the main till, the print server."""
    from app.services.local_server_roles import holders

    h = holders(db, shop)
    out: List[POSMachine] = []
    for key in ("tables", "main", "print"):
        m = h.get(key)
        if m is not None and all(m.id != o.id for o in out):
            out.append(m)
    return out


def evaluate(db: Session, shop: Shop, *, now: Optional[datetime] = None) -> Decision:
    """
    Every condition, in order, for each device holding a host role (the tables host first): the
    first one the cloud would move now, else why not — the first host's reason (pure reading).
    """
    from app.services import local_server_switch as LSS
    from app.services.machine_status import is_online

    now = _now(now)
    cfg = settings_of(shop)
    minutes = cfg["minutes"]

    def no(reason: str, **kw) -> Decision:
        return Decision(False, reason, REASONS[reason].format(minutes=minutes), **kw)

    if not cfg["enabled"]:
        return no("off")
    target = _target(db, shop, cfg["targetMachineId"])
    if target is None:
        return no("no_target")
    reason = LSS.ineligible_reason(db, target, now, require_online=False)
    if reason is not None:
        return no("target_not_eligible", target=target)
    hosts = hosts_of(db, shop)
    if not hosts:
        return no("no_host", target=target)
    others = [h for h in hosts if h.id != target.id]
    if not others:
        # The target holds every role already: the cloud never moves anything back by itself.
        return no("target_is_host", host=hosts[0], target=target)
    window = timedelta(minutes=minutes)
    target_last = _aware(target.last_heartbeat_at)
    first: Optional[Decision] = None
    for host in others:
        host_last = _aware(host.last_heartbeat_at)
        if host_last is not None and now - host_last < window:
            why = no("host_heard", host=host, target=target)
        elif target_last is None or not is_online(target_last, now=now):
            why = no("target_offline", host=host, target=target)
        elif host_last is not None and target_last < host_last + window:
            why = no("target_not_heard_since", host=host, target=target)
        else:
            return Decision(True, "fire", REASONS["fire"].format(minutes=minutes), host=host, target=target)
        first = first or why
    return first  # type: ignore[return-value]


def view(db: Session, shop: Shop, user: Any = None, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """The shop page's card: the setting, the target, who may change it, and what it would do now."""
    from app.services import local_server_switch as LSS
    from app.services.machine_status import is_online

    now = _now(now)
    cfg = settings_of(shop)
    raw = _raw(shop)
    target = _target(db, shop, cfg["targetMachineId"])
    decision = evaluate(db, shop, now=now)
    history = [h for h in (raw.get("history") or []) if isinstance(h, dict)]
    return {
        **cfg,
        "target": None if target is None else {
            **(LSS._ref(target) or {}),
            "deviceRole": "local_server" if getattr(target, "is_local_server", False) else "till",
            "online": is_online(target.last_heartbeat_at, now=now),
            "lastHeartbeatAt": _iso(target.last_heartbeat_at),
        },
        "defaultMinutes": DEFAULT_MINUTES,
        "minMinutes": MIN_MINUTES,
        "maxMinutes": MAX_MINUTES,
        "canEdit": LSS.may_switch(db, user) if user is not None else False,
        "armed": cfg["enabled"] and decision.reason not in ("off", "no_target", "target_not_eligible"),
        "status": {"code": decision.reason, "message": decision.message},
        "updatedAt": raw.get("updatedAt"),
        "updatedBy": raw.get("updatedBy"),
        "lastFired": raw.get("lastFired") if isinstance(raw.get("lastFired"), dict) else None,
        "history": list(reversed(history))[:10],
    }


# ── Acting ────────────────────────────────────────────────────────────────────


def _summary(host: POSMachine, target: POSMachine, minutes: int) -> str:
    from app.services import local_server_switch as LSS

    return (
        f"גיבוי אוטומטי: הענן לא שמע את השרת המקומי ({LSS.till_label(host)}) {minutes} דקות, "
        f"והעביר אותו ל{LSS.till_label(target)}. השרת הקודם לא יחזור להיות שרת לבד — מחזירים אותו ידנית."
    )


def run_shop(db: Session, shop_id: Any, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    One shop's check: under the shop's switch lock (not waited for), the shop and its devices read
    afresh, every condition checked, and — when they all hold — the move, recorded and committed.
    `{shopId, fired, reason}`; never raises (a failure rolls back and says so).
    """
    from app.services import local_server_switch as LSS
    from app.services.exceptions import Detector, Found

    now = _now(now)
    sid = _uuid(shop_id)
    out: Dict[str, Any] = {"shopId": str(shop_id), "fired": False, "reason": None}
    if sid is None:
        out["reason"] = "bad_shop"
        return out
    notify_shop = None
    try:
        with LSS.switch_lock(db, sid, wait=False) as got:
            if not got:
                # A manual switch (or another failover) holds the shop: never at the same time.
                out["reason"] = LSS.SWITCH_IN_PROGRESS
                db.rollback()
                return out
            # What another move committed meanwhile, never a stale copy.
            db.expire_all()
            shop = db.get(Shop, sid)
            if shop is None:
                out["reason"] = "no_shop"
                db.rollback()
                return out
            decision = evaluate(db, shop, now=now)
            out["reason"] = decision.reason
            if not decision.fire:
                db.rollback()
                return out
            minutes = settings_of(shop)["minutes"]
            all_fired: List[Dict[str, Any]] = []
            # Each silent device that held a role, once (a role holder moved holds none any more).
            for _ in range(len(ROLE_HOSTS)):
                if not decision.fire:
                    break
                host, target = decision.host, decision.target
                moved = LSS.move_by_failover(db, shop, target, host, minutes=minutes, now=now)
                fired = {
                    "at": now.isoformat(),
                    "switchId": moved.get("switchId"),
                    "from": moved.get("previous"),
                    "to": moved.get("mainTill"),
                    "roles": LSS.switches(shop)[-1].get("roles") if LSS.switches(shop) else None,
                    "minutes": minutes,
                    "hostLastHeartbeatAt": _iso(host.last_heartbeat_at),
                    "targetLastHeartbeatAt": _iso(target.last_heartbeat_at),
                }
                try:
                    Detector(db)._record(target, Found(
                        type=FAILOVER_EXCEPTION,
                        key=f"{FAILOVER_EXCEPTION}:{shop.id}:{host.id}:{fired['at']}"[:200],
                        occurred_at=now,
                        severity="high",
                        details={**fired, "shopId": str(shop.id), "summary": _summary(host, target, minutes)},
                    ))
                except Exception:  # noqa: BLE001 - the move is what matters; the log keeps the rest
                    logger.exception("could not record the failover of shop %s", shop.id)
                all_fired.append(fired)
                db.flush()
                decision = evaluate(db, shop, now=now)
            raw = dict(_raw(shop))
            raw["lastFired"] = all_fired[-1]
            _put(shop, raw)
            db.commit()
            notify_shop = shop
            out.update(fired=True, switch=all_fired[0], switches=all_fired, reason="fire")
            logger.warning("shop %s: local server failover %s", shop.id, all_fired)
    except Exception:  # noqa: BLE001 - one shop's failure never stops the pass
        db.rollback()
        logger.exception("local server failover check failed for shop %s", shop_id)
        out["reason"] = "error"
        return out
    if notify_shop is not None:
        from app.services.local_server_device import after_host_change

        after_host_change(db, notify_shop)
    return out


def enabled_shop_ids(db: Session) -> List[uuid.UUID]:
    """The shops whose failover is on (a JSON query on Postgres; read in Python elsewhere)."""
    bind = db.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", None) == "postgresql":
        rows = db.execute(text(
            "SELECT id FROM shops WHERE (settings::jsonb -> 'localServerFailover' ->> 'enabled') = 'true'"
        )).all()
        return [r[0] if isinstance(r[0], uuid.UUID) else uuid.UUID(str(r[0])) for r in rows]
    return [s.id for s in db.query(Shop).filter(Shop.settings.isnot(None)).all() if settings_of(s)["enabled"]]


def check_all(db: Session, *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """Every shop whose failover is on, each on its own (`run_shop`)."""
    return [run_shop(db, sid, now=now) for sid in enabled_shop_ids(db)]


# ── The background pass ───────────────────────────────────────────────────────


def worker_enabled() -> bool:
    return os.environ.get(ENV_SWITCH, "true").strip().lower() not in ("0", "false", "no", "off")


def run_once(session_factory: Callable[[], Session], *, now: Optional[datetime] = None) -> Optional[List[Dict[str, Any]]]:
    """One pass, or None when another instance holds it (a session advisory lock on Postgres)."""
    db = session_factory()
    lock_conn = None
    try:
        bind = db.get_bind()
        engine = getattr(bind, "engine", bind)
        if engine.dialect.name == "postgresql":
            lock_conn = engine.connect()
            if not bool(lock_conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": LOCK_KEY}).scalar()):
                return None
        return check_all(db, now=now)
    finally:
        db.close()
        if lock_conn is not None:
            try:
                lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})
            except Exception:  # noqa: BLE001 - closing the connection releases it anyway
                logger.exception("local server failover pass: unlock failed")
            lock_conn.close()


def start_background_worker(session_factory: Callable[[], Session], *, interval: float = INTERVAL_SECONDS) -> bool:
    """Start the pass (once per process). Returns whether it is running."""
    global _thread
    if not worker_enabled():
        return False
    if _thread is not None and _thread.is_alive():
        return True

    def loop() -> None:
        while not _stop.wait(interval):
            try:
                run_once(session_factory)
            except Exception:  # noqa: BLE001 - keep the loop alive
                logger.exception("local server failover pass failed")

    _stop.clear()
    _thread = threading.Thread(target=loop, name="local-server-failover", daemon=True)
    _thread.start()
    return True


def stop_background_worker() -> None:
    _stop.set()
