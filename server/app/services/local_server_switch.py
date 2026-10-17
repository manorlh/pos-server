"""
"העברת שרת מקומי" — the shop's local server moves to another till from the cloud only, and the
fallen server's shift is closed from the cloud (P:/specs/local-server-switch.md, approved
13.10.2026; §7 the owner's decisions, §8 the contract with the till).

* **The switch** (`POST /shops/{id}/local-server/switch`): the same full move the till's own
  "העבר את השרת לקופה הזו" made (`main_till.take_over`: `mainTill`, `tablesHostTill`,
  `printHostTill`, `shopZMasterTill`), the notice "השרת הוחלף" on every till, and an audit
  record. The till's own take-over answers 410 `switch_from_cloud_only` — unless the till parameter
  `tillServerTakeover` is `manager` for it (§9): then it makes this same move, its protections
  included and nothing forced, recorded "from the till" with the approving manager's name
  (`switch_from_till`). Refused with 409
  `host_online` while the cloud still hears the old server ("כנראה בעיית רשת בין הקופות"),
  unless `force`. Options in the same step: close the old server's open shift from the cloud
  (`closeOldShift` + `countedCash`) and release the shop Z production at once (`releaseShopZ`,
  the existing "העבר את הפקת ה-Z עכשיו" — the super admin's, as that button is).
* **Who** (§7.1–2): the super admin always, and a dashboard user granted "העברת שרת מקומי"
  (`local_server_switch`, a pageless section of the access profile — the grantable
  permissions' mechanism, app/services/dashboard_sections.py). Unlike other sections it is
  never implied by "גישה מלאה" and only the super admin grants it (`SUPER_ADMIN_GRANTED`). The
  same permission forces.
* **"סגירת משמרת מהענן"** (`POST /machines/{id}/shifts/close-from-cloud`): a till the cloud
  has not heard for 5 minutes (else 409 `till_online` — the ordinary remote close is for a
  till that answers): its open shift is closed from the cloud's documents
  (`close_shift_administratively`, no Z), with a cash count typed by hand if someone counted
  the drawer, marked "נסגרה מהענן — הקופה לא הייתה זמינה" and recorded. Who: exactly the
  existing remote close's people (§7.3 — `get_current_machine_admin` + the till's shift
  admin scope + the Z section).
* **The till learns it** — `shiftClosedFromCloud: {shiftId, closedAt, closedBy}` on its
  heartbeat and `GET /machines/me` while it still reports that shift open; documents of the
  shift still upload, counted late (app/services/shifts.py) with an exception
  (`cloud_closed_shift_late_documents`).
* **Gap 1** — the old server comes back with table changes it never uploaded: its
  `POST /sync/{m}/tables/report` says `"formerHost": true`, and an order the cloud changed
  since the switch is not applied but kept as a conflict (`applied` / `conflict` per order);
  the shop page shows "X שינויים מהשרת הקודם" with the list (`former_host_changes`).

The switches and the old servers' changes are kept on the shop (`shop.settings`, as the local
shop Z keeps its producer and reports, app/services/local_shop_z.py), bounded.

**"שרת מקומי ייעודי"** (P:/specs/dedicated-local-server.md §10.2, §11.7): a dedicated local server
(app/services/local_server_device.py) takes part in every direction — till→till, till→server,
server→till, server→server. A server has no shift: `closeOldShift` with a server as the old host
is refused (409 `old_server_has_no_shift`). The automatic failover (app/services/
local_server_failover.py) makes this same move, `source: "auto_failover"`; the work profile's
"מכשיר ייעודי" makes it `source: "work_profile"`. **One at a time:** every move of a shop's server
— the dashboard's, a till's, the failover's — runs under `switch_lock` (the shop's lock: an
advisory transaction lock on Postgres, and a lock in the process), so two never cross.
"""
from __future__ import annotations

import hashlib
import logging
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, Iterator, List, Optional

from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.user import User, UserRole

logger = logging.getLogger(__name__)

#: The grantable permission ("העברת שרת מקומי"), a pageless section of the access profile.
SECTION = "local_server_switch"
#: How long the cloud must not have heard a till before its shift may be closed from the cloud
#: (§7.5). The same window as "online" (app/services/machine_status.py `ONLINE_WINDOW_SEC`).
CLOSE_FROM_CLOUD_AFTER = timedelta(minutes=5)
CLOUD_CLOSE_LABEL = "נסגרה מהענן — הקופה לא הייתה זמינה"

SWITCH_EXCEPTION = "local_server_switched"
CLOUD_CLOSE_EXCEPTION = "shift_closed_from_cloud"
LATE_EXCEPTION = "cloud_closed_shift_late_documents"

SWITCHES_KEY = "localServerSwitches"
CHANGES_KEY = "formerHostChanges"
SWITCHES_KEPT = 20
CHANGES_KEPT = 200

HOST_ONLINE_MESSAGE = (
    "הענן עדיין שומע את השרת המקומי הנוכחי ({till}) — כנראה בעיית רשת בין הקופות, ולא שרת שנפל. "
    "בדקו את הרשת בסניף. העברה בכפייה עלולה ליצור שני שרתים בסניף."
)
TILL_ONLINE_MESSAGE = (
    "הענן שמע את {till} לפני פחות מ-5 דקות. לקופה מחוברת משתמשים בסגירת משמרת מרחוק הרגילה."
)


def _now(now: Optional[datetime] = None) -> datetime:
    return now or datetime.now(timezone.utc)


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    m = _aware(moment)
    return m.isoformat() if m is not None else None


def _parse(raw: Any) -> Optional[datetime]:
    if not raw:
        return None
    try:
        return _aware(datetime.fromisoformat(str(raw)))
    except ValueError:
        return None


def _money(value: Any) -> Optional[str]:
    return None if value is None else str(Decimal(value).quantize(Decimal("0.01")))


def who(user: Any) -> str:
    return getattr(user, "username", None) or getattr(user, "email", None) or str(getattr(user, "id", "") or "")


def till_label(machine: Optional[POSMachine]) -> str:
    if machine is None:
        return "הקופה"
    number = (machine.pos_number or "").strip()
    return f"קופה {number}" if number else (machine.name or "הקופה")


def _refusal(status_code: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message, **extra})


def _ref(machine: Optional[POSMachine]) -> Optional[Dict[str, Any]]:
    """`till_ref`, saying `deviceRole: "local_server"` for a dedicated server."""
    from app.services.local_server_device import ref

    return ref(machine)


# ── One move at a time ────────────────────────────────────────────────────────

#: How long a move waits for another one of the same shop before it says so.
LOCK_WAIT_SECONDS = 30
_LOCKS: Dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()
SWITCH_IN_PROGRESS = "switch_in_progress"


def _lock_key(shop_id: Any) -> int:
    digest = hashlib.sha256(f"local-server-switch:{shop_id}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big", signed=True)


def _is_postgres(db: Session) -> bool:
    try:
        bind = db.get_bind()
    except Exception:  # noqa: BLE001
        return False
    return getattr(getattr(bind, "dialect", None), "name", None) == "postgresql"


@contextmanager
def switch_lock(db: Session, shop_id: Any, *, wait: bool = True) -> Iterator[bool]:
    """
    The shop's switch lock: held by every move of its local server — the dashboard's, a till's
    take-over, the automatic failover — from before its checks until its commit. On Postgres an
    advisory *transaction* lock (released by the caller's commit / rollback, across every API
    instance); in this process a lock as well (released when the block ends, after the commit).

    `wait` (a person's move): waits for one under way, then goes on — its checks then see what
    the other one did; 409 `switch_in_progress` after `LOCK_WAIT_SECONDS`. Not `wait` (the
    failover): yields False at once when another move holds it — the failover never fires while a
    switch is in progress, and never twice at once.
    """
    key = str(shop_id)
    with _LOCKS_GUARD:
        lock = _LOCKS.setdefault(key, threading.Lock())
    got = lock.acquire(timeout=LOCK_WAIT_SECONDS) if wait else lock.acquire(blocking=False)
    if not got:
        if wait:
            raise _refusal(
                status.HTTP_409_CONFLICT, SWITCH_IN_PROGRESS,
                "העברה אחרת של השרת המקומי של הסניף מתבצעת עכשיו. המתינו לסיומה ונסו שוב.",
            )
        yield False
        return
    try:
        if _is_postgres(db):
            k = {"k": _lock_key(shop_id)}
            if wait:
                db.execute(text("SELECT pg_advisory_xact_lock(:k)"), k)
            elif not db.execute(text("SELECT pg_try_advisory_xact_lock(:k)"), k).scalar():
                yield False
                return
        yield True
    finally:
        lock.release()


def is_switch_locked(shop_id: Any) -> bool:
    """A move of this shop's server is under way in this process."""
    with _LOCKS_GUARD:
        lock = _LOCKS.get(str(shop_id))
    return lock is not None and lock.locked()


# ── Who ───────────────────────────────────────────────────────────────────────


def is_super(user: Any) -> bool:
    return getattr(user, "role", None) == UserRole.SUPER_ADMIN


def may_switch(db: Session, user: Any) -> bool:
    """
    The super admin, or a user the super admin granted "העברת שרת מקומי" (edit) explicitly in
    their access profile — never by "גישה מלאה" alone, nor by a role (§7.1).
    """
    if user is None:
        return False
    if is_super(user):
        return True
    from app.services import dashboard_access as DA
    from app.services import dashboard_sections as DS

    try:
        profile = DA.load_profile(db, getattr(user, "id", None))
    except Exception:  # noqa: BLE001 - fail closed
        return False
    if profile is None:
        return False
    return DS.level_allows(DS.clean_sections(profile.sections).get(SECTION), DS.EDIT)


def require_switch(db: Session, user: Any) -> None:
    if not may_switch(db, user):
        raise _refusal(
            status.HTTP_403_FORBIDDEN,
            "local_server_switch_forbidden",
            "העברת שרת מקומי — למנהל-על ולמשתמש שקיבל את ההרשאה \"העברת שרת מקומי\" בלבד.",
        )


def may_release_shop_z(user: Any) -> bool:
    """"העבר את הפקת ה-Z עכשיו" stays the super admin's, as the shop page's button is (§3)."""
    return is_super(user)


# ── The till's state ─────────────────────────────────────────────────────────


def silent_seconds(machine: POSMachine, now: Optional[datetime] = None) -> Optional[int]:
    """Seconds since the cloud last heard the till; None — never heard."""
    last = _aware(machine.last_heartbeat_at)
    if last is None:
        return None
    return max(int((_now(now) - last).total_seconds()), 0)


def is_silent(machine: POSMachine, now: Optional[datetime] = None) -> bool:
    """Not heard for `CLOSE_FROM_CLOUD_AFTER` (or never): its shift may be closed from the cloud."""
    seconds = silent_seconds(machine, now)
    return seconds is None or seconds >= int(CLOSE_FROM_CLOUD_AFTER.total_seconds())


def open_shifts(db: Session, machine: POSMachine) -> List[Shift]:
    return (
        db.query(Shift)
        .filter(Shift.machine_id == machine.id, Shift.status == ShiftStatus.OPEN)
        .order_by(Shift.opened_at)
        .all()
    )


def _shift_ref(shift: Optional[Shift]) -> Optional[Dict[str, Any]]:
    if shift is None:
        return None
    return {
        "shiftId": str(shift.id),
        "sequenceNumber": shift.sequence_number,
        "openedAt": _iso(shift.opened_at),
        "businessDate": shift.business_date.isoformat() if shift.business_date else None,
    }


def till_state(db: Session, machine: POSMachine, now: Optional[datetime] = None) -> Dict[str, Any]:
    """What the dashboard shows of a till before acting on it (the wizard, the device page)."""
    from app.services.display_devices import platform_of
    from app.services.machine_status import is_online

    from app.services.local_server_device import is_local_server

    now = _now(now)
    server = is_local_server(machine)
    shifts = [] if server else open_shifts(db, machine)
    reported = None if server else getattr(machine, "reported_open_shift_id", None)
    sync = machine.lan_sync if isinstance(getattr(machine, "lan_sync", None), dict) else {}
    return {
        **(_ref(machine) or {}),
        # "שרת מקומי" (dedicated-local-server.md §11.7): no shift, nothing to close from the cloud.
        "deviceRole": "local_server" if server else "till",
        "hasShifts": not server,
        "platform": platform_of(machine),
        "online": is_online(machine.last_heartbeat_at, now=now),
        "lastHeartbeatAt": _iso(machine.last_heartbeat_at),
        "silentSeconds": silent_seconds(machine, now),
        "canCloseFromCloud": is_silent(machine, now) and bool(shifts),
        "openShift": _shift_ref(shifts[-1]) if shifts else None,
        # The till said a shift is open that the cloud has not received yet.
        "reportedOpenShiftId": str(reported) if reported else None,
        "reportedOpenShiftInCloud": bool(reported) and any(str(s.id) == str(reported) for s in shifts),
        # What it last said it still holds (the status light's reading).
        "pendingDocuments": (
            machine.pending_documents if machine.pending_documents is not None else machine.pending_count
        ),
        "pendingAt": _iso(machine.pending_count_at),
        # A local server's changes the cloud copy lacks (docs/SPEC_LAN_MODE.md §6).
        "lanPending": int(sync.get("pending") or 0) if sync else None,
        "lanReportedAt": _iso(getattr(machine, "lan_sync_reported_at", None)),
    }


def current_server(db: Session, shop: Shop) -> Optional[POSMachine]:
    """The shop's local server: the tables host, else the main till (as "סנכרון רשת מקומית" reads it)."""
    from app.services.main_till import main_till_of_shop
    from app.services.tables import tables_host_of_shop

    return tables_host_of_shop(db, shop.id) or main_till_of_shop(db, shop.id)


#: Why a till cannot become the shop's server, in the owner's words (the wizard lists only those
#: that can; the switch refuses the rest with 409 `target_not_eligible`).
INELIGIBLE = {
    "not_assigned": "המכשיר אינו מצומד לסניף",
    "independent": "קופה עצמאית אינה חלק מהרשת המקומית של הסניף",
    "remote": "קופה מרוחקת (לא מחוברת לשרת המקומי) אינה משמשת כשרת מקומי",
    "lan_excluded": "המכשיר מסומן \"לא משמש כשרת מקומי\"",
    "not_fiscal": "מסך מטבח או מסך מוכן / לא מוכן אינו קופה",
    "kiosk": "קיוסק לא משמש כשרת מקומי",
    "not_android": "רק קופת אנדרואיד יכולה לשמש כשרת מקומי",
    "offline": "הקופה לא מחוברת — רק קופה מחוברת יכולה לקבל את השרת",
}


def ineligible_reason(
    db: Session, machine: POSMachine, now: Optional[datetime] = None, *, require_online: bool = True,
) -> Optional[str]:
    """
    Why `machine` cannot become the shop's server, or None. `require_online=False`: the till is
    asking itself (its own take-over) — it is talking to the cloud right now, whatever its last
    heartbeat says.
    """
    from app.services import lan_server
    from app.services.display_devices import PLATFORM_ANDROID, platform_of
    from app.services.independent_till import is_independent
    from app.services.local_server_device import is_local_server
    from app.services.machine_status import is_online

    if not machine.is_active or machine.pairing_status != PairingStatus.ASSIGNED:
        return "not_assigned"
    # A dedicated local server is not a till, and may serve (dedicated-local-server.md §10.2).
    if getattr(machine, "is_fiscal", True) is False and not is_local_server(machine):
        return "not_fiscal"
    if is_independent(machine):
        return "independent"
    from app.services.local_shop_z import is_remote_participant

    if is_remote_participant(machine):
        # "מרוחקת בזד הסניפי" (docs/SPEC_INDEPENDENT_TILL.md §8.14): off the shop's local server, so
        # never it — as the main-till card and the take-over refuse it, and no election names it.
        return "remote"
    if lan_server.is_excluded(db, machine):
        return "lan_excluded"
    try:
        kiosk = bool(machine.is_kiosk)
    except Exception:  # noqa: BLE001 - a row without its kiosk link loaded reads as no kiosk
        kiosk = False
    if kiosk:
        return "kiosk"
    if platform_of(machine) != PLATFORM_ANDROID:
        return "not_android"
    if require_online and not is_online(machine.last_heartbeat_at, now=now):
        return "offline"
    return None


def candidates(db: Session, shop: Shop, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """The shop's tills, each with whether it may take the server and why not."""
    from app.services.local_server_device import host_order, is_local_server
    from app.services.printers import shop_machines

    out = []
    # A dedicated local server first: the preferred host.
    for m in sorted(shop_machines(db, shop.id), key=host_order):
        reason = ineligible_reason(db, m, now)
        if reason == "not_fiscal":
            continue  # a KDS / the board: no till at all, not listed
        out.append({
            **(_ref(m) or {}),
            "deviceRole": "local_server" if is_local_server(m) else "till",
            "online": _online(m, now),
            "lastHeartbeatAt": _iso(m.last_heartbeat_at),
            "eligible": reason is None,
            "reason": reason,
            "reasonText": INELIGIBLE.get(reason) if reason else None,
        })
    return out


def _online(machine: POSMachine, now: Optional[datetime]) -> bool:
    from app.services.machine_status import is_online

    return is_online(machine.last_heartbeat_at, now=now)


def state(db: Session, shop: Shop, user: Any, now: Optional[datetime] = None) -> Dict[str, Any]:
    """The wizard's first page: the server now, the tills that may take it, and what the user may do."""
    from app.services import local_server_device as LSD
    from app.services import local_server_failover as LSF
    from app.services import local_shop_z as LZ
    from app.services.tables import MODE_LAN, TABLES_MODE_KEY, mode_of
    from app.services.till_parameters import resolve_for_shop

    now = _now(now)
    server = current_server(db, shop)
    allowed = may_switch(db, user)
    producer = LZ.effective_producer(db, shop, now=now).to_json(db)
    shop_params = resolve_for_shop(db, shop)
    return {
        "shopId": str(shop.id),
        "server": till_state(db, server, now) if server is not None else None,
        "candidates": [c for c in candidates(db, shop, now) if server is None or c["machineId"] != str(server.id)],
        "tablesLan": mode_of(shop_params.get(TABLES_MODE_KEY)) == MODE_LAN,
        # "העברת שרת מקומי מהקופה" (§9) as the shop resolves it (a till may hold its own value).
        "tillTakeover": (
            TILL_TAKEOVER_MANAGER if shop_params.get(TILL_TAKEOVER_KEY) == TILL_TAKEOVER_MANAGER else TILL_TAKEOVER_OFF
        ),
        "localMode": LZ.local_mode_of_shop(db, shop),
        "shopZ": producer,
        "closeFromCloudAfterSeconds": int(CLOSE_FROM_CLOUD_AFTER.total_seconds()),
        "canSwitch": allowed,
        "canForce": allowed,
        "canReleaseShopZ": allowed and may_release_shop_z(user),
        "lastSwitch": (switches(shop) or [None])[-1],
        "switches": list(reversed(switches(shop)))[:10],
        "formerHostChanges": former_host_changes_out(shop),
        # "שרת מקומי ייעודי" (dedicated-local-server.md §11): the shop's servers and the automatic
        # failover's settings (off by default).
        "servers": LSD.shop_servers(db, shop, now=now),
        "failover": LSF.view(db, shop, user, now=now),
    }


# ── The switch ───────────────────────────────────────────────────────────────


def switches(shop: Shop) -> List[Dict[str, Any]]:
    rows = (shop.settings or {}).get(SWITCHES_KEY)
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def _put(shop: Shop, key: str, value: Any) -> None:
    settings = dict(shop.settings or {})
    settings[key] = value
    shop.settings = settings  # reassigned: a JSONB column sees only a new value


def switched_away_at(shop: Optional[Shop], machine: POSMachine) -> Optional[datetime]:
    """When the server last moved away from `machine` (gap 1's "since the switch"), or None."""
    if shop is None:
        return None
    for record in reversed(switches(shop)):
        if str((record.get("from") or {}).get("machineId") or "") == str(machine.id):
            return _parse(record.get("at"))
    return None


def switch(
    db: Session,
    user: User,
    shop: Shop,
    target_id: Any,
    *,
    close_old_shift: bool = False,
    counted_cash: Optional[Decimal] = None,
    force: bool = False,
    release_shop_z: bool = False,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    The confirmed switch. Everything is checked before anything is written; the caller commits
    (and then tells the tills). Refusals: 403 `local_server_switch_forbidden` /
    `release_shop_z_super_admin_only`; 422 `target_not_in_shop`; 409 `target_not_eligible`
    (`reason`), `already_local_server`, `host_online` (`canForce`), `till_online` (the old
    server's shift cannot be closed from the cloud while it is heard), `no_open_shift`.
    """
    from app.services import local_shop_z as LZ
    from app.services.machine_status import is_online

    now = _now(now)
    require_switch(db, user)
    if release_shop_z and not may_release_shop_z(user):
        raise _refusal(
            status.HTTP_403_FORBIDDEN,
            "release_shop_z_super_admin_only",
            "\"העבר את הפקת ה-Z עכשיו\" — למנהל-על בלבד. ההעברה עצמה אפשרית בלי לשחרר את ה-Z.",
        )
    try:
        tid = target_id if isinstance(target_id, uuid.UUID) else uuid.UUID(str(target_id))
    except (TypeError, ValueError):
        tid = None
    target = db.get(POSMachine, tid) if tid is not None else None
    if target is None or target.shop_id is None or str(target.shop_id) != str(shop.id):
        raise _refusal(status.HTTP_422_UNPROCESSABLE_ENTITY, "target_not_in_shop", "הקופה שנבחרה אינה בסניף הזה.")
    reason = ineligible_reason(db, target, now)
    if reason is not None:
        raise _refusal(
            status.HTTP_409_CONFLICT, "target_not_eligible", f"{till_label(target)}: {INELIGIBLE[reason]}.",
            reason=reason,
        )
    old = current_server(db, shop)
    if old is not None and old.id == target.id:
        raise _refusal(
            status.HTTP_409_CONFLICT, "already_local_server", f"{till_label(target)} היא כבר השרת המקומי של הסניף.",
        )
    host_online = old is not None and is_online(old.last_heartbeat_at, now=now)
    if host_online and not force:
        raise _refusal(
            status.HTTP_409_CONFLICT, "host_online", HOST_ONLINE_MESSAGE.format(till=till_label(old)),
            host=_ref(old), canForce=may_switch(db, user),
        )
    shift_to_close: List[Shift] = []
    from app.services.local_server_device import is_local_server

    if close_old_shift and old is not None and is_local_server(old):
        # A dedicated server has no shift (dedicated-local-server.md §10.2): nothing to close.
        raise _refusal(
            status.HTTP_409_CONFLICT, "old_server_has_no_shift",
            f"{till_label(old)} הוא שרת מקומי ייעודי — אין בו משמרת, ולכן אין מה לסגור מהענן. "
            "בטלו את \"סגירת המשמרת\" והעבירו את השרת.",
        )
    if close_old_shift and old is not None:
        if not is_silent(old, now):
            raise _till_online(old, now)
        shift_to_close = open_shifts(db, old)
        if not shift_to_close:
            raise _no_open_shift(old)

    return _move(
        db, shop, target, old,
        by=who(user), by_user_id=str(user.id) if getattr(user, "id", None) else None,
        source=SOURCE_CLOUD, approved_by=None, forced=host_online,
        close_old=(lambda: close_from_cloud(
            db, user, old, counted_cash=counted_cash, reason="העברת שרת מקומי", now=now, context="switch",
        )) if shift_to_close else None,
        release=(lambda: LZ.handover_now(db, user, shop, now=now)) if release_shop_z else None,
        now=now,
    )


SOURCE_CLOUD = "cloud"
SOURCE_TILL = "till"
#: The automatic failover ("גיבוי אוטומטי לשרת המקומי", app/services/local_server_failover.py).
SOURCE_FAILOVER = "auto_failover"
#: The work profile's "שרת מקומי: מכשיר ייעודי" (app/services/local_server_device.py `make_host`).
SOURCE_WORK_PROFILE = "work_profile"
FAILOVER_BY = "גיבוי אוטומטי"


def move_from_work_profile(
    db: Session, user: User, shop: Shop, server: POSMachine, old: Optional[POSMachine], *, now: datetime,
) -> Dict[str, Any]:
    """
    The work profile's "מכשיר ייעודי" moves the shop's server to its dedicated server: the full
    move, by the super admin who applied it — a till that held it (online or not) gives it up, the
    tills are told, recorded `source: "work_profile"`. The caller checked the server.
    """
    from app.services.machine_status import is_online

    return _move(
        db, shop, server, old,
        by=who(user), by_user_id=str(user.id) if getattr(user, "id", None) else None,
        source=SOURCE_WORK_PROFILE, approved_by=None,
        forced=old is not None and is_online(old.last_heartbeat_at, now=now),
        now=now,
    )


def move_by_failover(
    db: Session, shop: Shop, target: POSMachine, old: POSMachine, *, minutes: int, now: datetime,
) -> Dict[str, Any]:
    """
    The automatic failover's move (the caller checked every condition, under `switch_lock`): the
    same full move as the dashboard's — no shift closed, nothing forced — `source: "auto_failover"`.
    """
    from app.services.local_server_roles import move_roles

    # Only the roles the failed device held (app/services/local_server_roles.py): a print server
    # that fell gives up the printing, never the tables another device holds.
    return _move(
        db, shop, target, old,
        by=FAILOVER_BY, by_user_id=None, source=SOURCE_FAILOVER, approved_by=None, forced=False,
        now=now, extra={"failoverMinutes": int(minutes)},
        mover=lambda: move_roles(db, shop, old, target, now=now),
    )


def _move(
    db: Session,
    shop: Shop,
    target: POSMachine,
    old: Optional[POSMachine],
    *,
    by: str,
    by_user_id: Optional[str],
    source: str,
    approved_by: Optional[str],
    forced: bool,
    close_old=None,
    release=None,
    now: datetime,
    extra: Optional[Dict[str, Any]] = None,
    mover=None,
) -> Dict[str, Any]:
    """
    The move itself, after every check (the dashboard's switch, a till's own take-over where
    `tillServerTakeover` allows it, the automatic failover, the work profile's dedicated server):
    the full take-over, the old server's shift closed and the shop Z released when asked, the
    notice to every till, the record and its audit exception.
    """
    from app.services import local_shop_z as LZ
    from app.services import main_till as MT
    from app.services.local_server_device import forget_shop
    from app.services.till_messages import send_server_switch_notice

    # The full take-over of the old host's roles (`mover`: the failover's, only what it held).
    out = mover() if mover is not None else MT.take_over(db, target, by, force=True, require_lan=False, now=now)
    forget_shop(shop.id)
    # Relayed tickets no till took yet follow the print server (remote kiosks and tills, §11.9).
    from app.services.printers import retarget_relay_jobs

    retarget_relay_jobs(db, shop.id)
    previous = out.get("previous")
    closed = close_old() if close_old is not None else None
    if release is not None:
        release()
    producer = LZ.effective_producer(db, shop, now=now).to_json(db)
    if previous is not None:
        # "השרת הוחלף — יש לבדוק תקינות נתונים" on every till of the shop (the owner).
        send_server_switch_notice(db, shop.id, out.get("mainTill"), previous, by, now=now)
    record = {
        "id": str(uuid.uuid4()),
        "at": now.isoformat(),
        "by": by,
        "byUserId": by_user_id,
        # "cloud": the dashboard's wizard; "till": the till's own button (§9), a manager approving.
        "source": source,
        "approvedBy": approved_by,
        "from": previous if previous is not None else _ref(old),
        "to": out.get("mainTill"),
        "moved": list(out.get("moved") or []),
        "forced": bool(forced),
        "closedShift": (
            {k: closed.get(k) for k in ("shiftId", "closedAt", "countedCash", "documentsOnCloud")} if closed else None
        ),
        "releasedShopZ": release is not None,
        **({"roles": out["roles"]} if out.get("roles") is not None else {}),
        **(extra or {}),
    }
    _put(shop, SWITCHES_KEY, (switches(shop) + [record])[-SWITCHES_KEPT:])
    _record_switch(db, target, shop, record)
    logger.warning("shop %s: local server switched (%s): %s", shop.id, source, record)
    return {
        "switchId": record["id"],
        "switchedAt": record["at"],
        "switchedBy": record["by"],
        "source": source,
        "approvedBy": approved_by,
        "mainTill": out.get("mainTill"),
        "previous": record["from"],
        "moved": record["moved"],
        "forced": record["forced"],
        "closedShift": closed,
        "releasedShopZ": record["releasedShopZ"],
        "shopZ": producer,
        "shopZHandover": producer.get("handover"),
    }


# ── The till's own take-over, where the parameter allows it (§9) ─────────────

#: "העברת שרת מקומי מהקופה" (§9, the owner 13.10.2026): whether the till's "העבר את השרת לקופה
#: הזו" works — `off` (the default): the cloud only, the till's take-over answers 410; `manager`:
#: from the till with a manager's approval, the same full move as the dashboard's switch.
TILL_TAKEOVER_KEY = "tillServerTakeover"
TILL_TAKEOVER_OFF = "off"
TILL_TAKEOVER_MANAGER = "manager"
TILL_TAKEOVER_OPTIONS = (TILL_TAKEOVER_OFF, TILL_TAKEOVER_MANAGER)

#: The built-in till parameter (app/services/till_parameters.py adds it): set at every level,
#: audited and delivered like the others.
PARAMETER_SPECS = (
    dict(
        key=TILL_TAKEOVER_KEY,
        label="העברת שרת מקומי מהקופה",
        value_type="enum",
        enum_options=TILL_TAKEOVER_OPTIONS,
        default_value=TILL_TAKEOVER_OFF,
        description=(
            "האם אפשר להעביר את השרת המקומי (הקופה הראשית) לקופה אחרת מהקופה עצמה, כשהשרת לא עונה. "
            "«off» — רק מהענן (ברירת המחדל): הכפתור \"העבר את השרת לקופה הזו\" לא מופיע בקופה, וההעברה "
            "נעשית בדשבורד באשף \"העברת שרת מקומי\". "
            "«manager» — מהקופה, באישור מנהל: הכפתור מופיע כשהשרת לא עונה, וההעברה זהה לזו שמהענן — "
            "קופה ראשית, שרת שולחנות, שרת הדפסות ומפיק Z סניפי; נדחית כשהענן עדיין שומע את השרת הקודם "
            "(בלי כפייה מהקופה); הפקת ה-Z הסניפי מוקפאת עד שהשרת הקודם מדווח; כל הקופות מקבלות \"השרת "
            "הוחלף\"; ונרשמת ביומן \"מהקופה\" עם שם המנהל שאישר. המשמרת של השרת שנפל נסגרת רק מהענן. "
            "נקבע לפי הקופה שמבקשת לקחת את התפקיד: חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
)


def till_takeover_mode(db: Session, machine: POSMachine) -> str:
    """`tillServerTakeover` as resolved for `machine` (the till asking to take the role); off on doubt."""
    from app.services.till_parameters import till_parameters_for_machine

    try:
        value = till_parameters_for_machine(db, machine).parameters.get(TILL_TAKEOVER_KEY)
    except Exception:  # noqa: BLE001 - fail closed: the cloud only
        logger.exception("tillServerTakeover unreadable for %s", machine.id)
        return TILL_TAKEOVER_OFF
    return TILL_TAKEOVER_MANAGER if value == TILL_TAKEOVER_MANAGER else TILL_TAKEOVER_OFF


def switch_from_till(
    db: Session, machine: POSMachine, manager_name: Optional[str] = None, *, now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    "העבר את השרת לקופה הזו" where `tillServerTakeover` is `manager` (the caller checked it): the
    same full move as the dashboard's switch, with its protections — 409 `host_online` while the
    cloud still hears the old server (never forced from a till), 409 `target_not_eligible` for a
    till that cannot serve; the shop Z frozen as always; the old server's shift is not closed
    (the cloud does that). Recorded "from the till" with the approving manager's name. A till
    that already is the server: nothing moves (`previous` null), as the take-over always was.
    """
    from app.services import local_shop_z as LZ
    from app.services.machine_status import is_online

    now = _now(now)
    shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
    if shop is None:
        raise _refusal(status.HTTP_400_BAD_REQUEST, "machine_has_no_shop", "הקופה אינה משויכת לסניף.")
    reason = ineligible_reason(db, machine, now, require_online=False)
    if reason is not None:
        raise _refusal(
            status.HTTP_409_CONFLICT, "target_not_eligible", f"{till_label(machine)}: {INELIGIBLE[reason]}.",
            reason=reason,
        )
    old = current_server(db, shop)
    if old is not None and old.id == machine.id:
        producer = LZ.effective_producer(db, shop, now=now).to_json(db)
        return {
            "mainTill": _ref(machine), "previous": None, "moved": [], "source": SOURCE_TILL,
            "shopZHandover": producer.get("handover"),
        }
    if old is not None and is_online(old.last_heartbeat_at, now=now):
        raise _refusal(
            status.HTTP_409_CONFLICT, "host_online", HOST_ONLINE_MESSAGE.format(till=till_label(old)),
            host=_ref(old), canForce=False,
        )
    manager = (manager_name or "").strip()[:200] or None
    return _move(
        db, shop, machine, old,
        by=manager or till_label(machine), by_user_id=None,
        source=SOURCE_TILL, approved_by=manager, forced=False,
        now=now,
    )


def _summary(record: Dict[str, Any]) -> str:
    def name(ref: Optional[dict]) -> str:
        if not ref:
            return "—"
        number = ref.get("posNumber")
        return f"קופה {number}" if number else (ref.get("name") or "—")

    if record.get("source") == SOURCE_TILL:
        approved = record.get("approvedBy")
        parts = [
            f"השרת המקומי הועבר מ{name(record.get('from'))} ל{name(record.get('to'))} מהקופה"
            + (f", באישור המנהל {approved}" if approved else "")
        ]
    elif record.get("source") == SOURCE_FAILOVER:
        parts = [
            f"גיבוי אוטומטי: השרת המקומי הועבר מ{name(record.get('from'))} ל{name(record.get('to'))} — "
            f"הענן לא שמע את השרת {record.get('failoverMinutes') or '?'} דקות"
        ]
    elif record.get("source") == SOURCE_WORK_PROFILE:
        parts = [
            f"תצורת העבודה (שרת מקומי ייעודי): השרת המקומי הועבר מ{name(record.get('from'))} ל"
            f"{name(record.get('to'))} ע״י {record.get('by')}"
        ]
    else:
        parts = [f"השרת המקומי הועבר מ{name(record.get('from'))} ל{name(record.get('to'))} ע״י {record.get('by')}"]
    if record.get("forced") and record.get("source") != SOURCE_WORK_PROFILE:
        parts.append("בכפייה — הענן עוד שמע את השרת הקודם")
    if record.get("closedShift"):
        parts.append(f"המשמרת ב{name(record.get('from'))} נסגרה מהענן")
    if record.get("releasedShopZ"):
        parts.append("הפקת ה-Z הסניפי שוחררה מיד")
    return " · ".join(parts)


def _record_switch(db: Session, machine: POSMachine, shop: Shop, record: Dict[str, Any]) -> None:
    """The audit: every switch, always (a tenant's rules never switch it off)."""
    from app.services.exceptions import Detector, Found

    try:
        Detector(db)._record(machine, Found(
            type=SWITCH_EXCEPTION,
            key=f"{SWITCH_EXCEPTION}:{shop.id}:{record['at']}"[:200],
            occurred_at=_parse(record["at"]) or _now(),
            severity="high" if record.get("forced") or record.get("source") == SOURCE_FAILOVER else None,
            details={**record, "shopId": str(shop.id), "summary": _summary(record)},
        ))
    except Exception:  # noqa: BLE001 - the switch is what matters; the log keeps the rest
        logger.exception("could not record the local server switch of shop %s", shop.id)


# ── "סגירת משמרת מהענן" ──────────────────────────────────────────────────────


def _till_online(machine: POSMachine, now: Optional[datetime]) -> HTTPException:
    return _refusal(
        status.HTTP_409_CONFLICT, "till_online", TILL_ONLINE_MESSAGE.format(till=till_label(machine)),
        lastHeartbeatAt=_iso(machine.last_heartbeat_at),
        silentSeconds=silent_seconds(machine, now),
        closeFromCloudAfterSeconds=int(CLOSE_FROM_CLOUD_AFTER.total_seconds()),
    )


def _no_open_shift(machine: POSMachine) -> HTTPException:
    reported = getattr(machine, "reported_open_shift_id", None)
    if reported:
        return _refusal(
            status.HTTP_409_CONFLICT, "shift_not_in_cloud",
            f"{till_label(machine)} דיווחה על משמרת פתוחה שעוד לא הגיעה לענן — אין מה לסגור מהענן.",
            reportedOpenShiftId=str(reported),
        )
    return _refusal(status.HTTP_409_CONFLICT, "no_open_shift", f"אין ב{till_label(machine)} משמרת פתוחה בענן.")


def close_from_cloud(
    db: Session,
    user: User,
    machine: POSMachine,
    *,
    counted_cash: Optional[Decimal] = None,
    reason: Optional[str] = None,
    now: Optional[datetime] = None,
    context: str = "device",
) -> Dict[str, Any]:
    """
    Close the till's open shift from the cloud's documents (no Z). The caller checked who; the
    caller commits. 409 `till_online` (heard in the last 5 minutes), `no_open_shift`,
    `shift_not_in_cloud`, `device_not_fiscal`.
    """
    from app.services.administrative_close import close_shift_administratively

    from app.services.local_server_device import is_local_server

    now = _now(now)
    if is_local_server(machine):
        raise _refusal(
            status.HTTP_409_CONFLICT, "device_not_fiscal",
            f"{till_label(machine)} הוא שרת מקומי ייעודי — אין בו משמרת, ולכן אין מה לסגור מהענן.",
            deviceRole="local_server",
        )
    if getattr(machine, "is_fiscal", True) is False:
        raise _refusal(status.HTTP_409_CONFLICT, "device_not_fiscal", "מסך מטבח או מסך מוכן / לא מוכן אינו קופה.")
    if not is_silent(machine, now):
        raise _till_online(machine, now)
    shifts = open_shifts(db, machine)
    if not shifts:
        raise _no_open_shift(machine)
    by = who(user)
    note = (reason or "").strip() or None
    closed: Optional[Shift] = None
    for i, shift in enumerate(shifts):
        counted = counted_cash if i == len(shifts) - 1 else None
        closed, _created = close_shift_administratively(
            db, machine, shift, user,
            note=note,
            now=now,
            silent_before=CLOSE_FROM_CLOUD_AFTER,
            counted_cash=counted,
            extra_basis={
                "closedFromCloud": True,
                "label": CLOUD_CLOSE_LABEL,
                "context": context,
                "countedByHand": counted is not None,
            },
        )
        closed.closed_by = by
        _record_close(db, machine, closed, by, note, context)
    assert closed is not None
    basis = closed.reconstruction_basis or {}
    logger.warning("machine %s: shift %s closed from the cloud by %s (%s)", machine.id, closed.id, by, context)
    return {
        "shiftId": str(closed.id),
        "closedShiftIds": [str(s.id) for s in shifts],
        "closedAt": _iso(closed.closed_at),
        "closedBy": by,
        "label": CLOUD_CLOSE_LABEL,
        "documentsOnCloud": basis.get("documentsOnCloud"),
        "lastReportedPendingDocuments": basis.get("lastReportedPendingDocuments"),
        "expectedCash": _money(closed.expected_cash),
        "countedCash": _money(closed.counted_cash),
        "discrepancy": _money(closed.discrepancy),
        "totalSales": _money(closed.total_sales),
        "machine": _ref(machine),
    }


def _record_close(db: Session, machine: POSMachine, shift: Shift, by: str, note: Optional[str], context: str) -> None:
    from app.services.exceptions import Detector, Found

    basis = shift.reconstruction_basis or {}
    parts = [f"{CLOUD_CLOSE_LABEL} · נסגרה ע״י {by}"]
    if context == "switch":
        parts.append("במסגרת העברת שרת מקומי")
    parts.append(f"{basis.get('documentsOnCloud') or 0} מסמכים בענן")
    pending = basis.get("lastReportedPendingDocuments")
    if pending:
        parts.append(f"הקופה דיווחה לאחרונה על {pending} מסמכים שלא עלו")
    parts.append(
        f"מזומן נספר ידנית: ₪{_money(shift.counted_cash)}" if shift.counted_cash is not None else "המזומן לא נספר"
    )
    if note and context != "switch":
        parts.append(note)
    try:
        Detector(db)._record(machine, Found(
            type=CLOUD_CLOSE_EXCEPTION,
            key=f"{CLOUD_CLOSE_EXCEPTION}:{shift.id}"[:200],
            occurred_at=_aware(shift.closed_at) or _now(),
            shift_id=shift.id,
            amount=shift.discrepancy,
            details={
                "shiftId": str(shift.id),
                "closedBy": by,
                "context": context,
                "reason": note,
                "label": CLOUD_CLOSE_LABEL,
                "documentsOnCloud": basis.get("documentsOnCloud"),
                "lastHeartbeatAt": basis.get("lastHeartbeatAt"),
                "lastReportedPendingDocuments": pending,
                "countedCash": _money(shift.counted_cash),
                "expectedCash": _money(shift.expected_cash),
                "lateDocuments": 0,
                "summary": " · ".join(parts),
            },
        ))
    except Exception:  # noqa: BLE001
        logger.exception("could not record the cloud close of shift %s", shift.id)


def is_closed_from_cloud(shift: Optional[Shift]) -> bool:
    basis = getattr(shift, "reconstruction_basis", None) if shift is not None else None
    return isinstance(basis, dict) and bool(basis.get("closedFromCloud"))


def shift_closed_from_cloud(db: Session, machine: POSMachine, shift_id: Any) -> Optional[Dict[str, Any]]:
    """
    `shiftClosedFromCloud` (§8): the shift the till reports open is its own and was closed from
    the cloud — `{shiftId, closedAt, closedBy}`; None otherwise.
    """
    if not shift_id:
        return None
    try:
        sid = shift_id if isinstance(shift_id, uuid.UUID) else uuid.UUID(str(shift_id))
    except (TypeError, ValueError):
        return None
    shift = db.get(Shift, sid)
    if shift is None or str(shift.machine_id) != str(machine.id) or shift.status != ShiftStatus.CLOSED:
        return None
    if not is_closed_from_cloud(shift):
        return None
    return {"shiftId": str(shift.id), "closedAt": _iso(shift.closed_at), "closedBy": shift.closed_by}


def note_late_documents(db: Session, shift: Shift, count: int) -> None:
    """
    Documents of a shift closed from the cloud that arrived after the close: counted late on the
    shift already (app/services/shifts.py); here the dashboard's exception, one per shift.
    """
    from app.models.audit_exception import AuditException
    from app.services.exceptions import Detector, Found

    if not count or not is_closed_from_cloud(shift):
        return
    if shift.z_report_id is None:
        # The X was rebuilt with them (app/services/shifts.py): the drawer it expects too.
        opening = Decimal(shift.opening_cash or 0)
        shift.expected_cash = opening + Decimal(shift.total_cash or 0) + Decimal(shift.total_cash_tips or 0)
        if shift.counted_cash is not None:
            shift.discrepancy = Decimal(shift.counted_cash) - Decimal(shift.expected_cash)
    machine = db.get(POSMachine, shift.machine_id)
    if machine is None:
        return
    key = f"{LATE_EXCEPTION}:{shift.id}"[:200]
    row = db.query(AuditException).filter(AuditException.dedupe_key == key).first()
    previous = int(((row.details or {}) if row is not None else {}).get("lateDocuments") or 0)
    total = max(previous + int(count), int(shift.late_documents or 0))
    basis = shift.reconstruction_basis or {}
    Detector(db)._record(machine, Found(
        type=LATE_EXCEPTION,
        key=key,
        occurred_at=_now(),
        shift_id=shift.id,
        value=Decimal(total),
        details={
            "shiftId": str(shift.id),
            "lateDocuments": total,
            "closedAt": _iso(shift.closed_at),
            "closedBy": shift.closed_by or basis.get("reconstructedBy"),
            "inZ": shift.z_report_id is not None,
            "summary": (
                f"{total} מסמכים הגיעו מ{till_label(machine)} אחרי שהמשמרת נסגרה מהענן "
                f"({CLOUD_CLOSE_LABEL}). הם נקלטו כמסמכים מאוחרים"
                + (" ויעברו ל-Z הבא." if shift.z_report_id is not None else " ונכללים במשמרת.")
            ),
        },
    ))
    # The close's own record says it too.
    close_row = db.query(AuditException).filter(
        AuditException.dedupe_key == f"{CLOUD_CLOSE_EXCEPTION}:{shift.id}"[:200]
    ).first()
    if close_row is not None:
        details = dict(close_row.details or {})
        details["lateDocuments"] = total
        close_row.details = details


# ── Gap 1: the old server's changes ──────────────────────────────────────────


def changed_in_cloud_since(row: Any, machine: POSMachine, since: Optional[datetime]) -> bool:
    """
    Whether the cloud's copy of an order changed since the server moved away from `machine` —
    by another till (the new server) or the dashboard. Its own last write is never a change;
    a write the cloud took before the switch (its receive time, `cloud_updated_at`) is not one
    either. Without a recorded switch or receive time: any write not its own counts.
    """
    writer = getattr(row, "updated_machine_id", None)
    if writer is not None and str(writer) == str(machine.id):
        return False
    at = _aware(getattr(row, "cloud_updated_at", None))
    if since is not None and at is not None and at < since:
        return False
    return True


def changes(shop: Optional[Shop]) -> List[Dict[str, Any]]:
    rows = (shop.settings or {}).get(CHANGES_KEY) if shop is not None else None
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def record_former_host_change(
    shop: Shop, machine: POSMachine, item: Any, row: Any, *, since: Optional[datetime], now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """One order the old server changed and the cloud changed too: kept, not applied."""
    now = _now(now)
    order_id = str(item.id)
    entries = changes(shop)
    for entry in entries:
        if (
            entry.get("orderId") == order_id
            and (entry.get("machine") or {}).get("machineId") == str(machine.id)
            and (entry.get("till") or {}).get("version") == item.version
            and not entry.get("acknowledgedAt")
        ):
            return entry  # the till sent it again: once is enough

    def f(value: Any) -> Optional[float]:
        return None if value is None else float(Decimal(str(value)).quantize(Decimal("0.01")))

    entry = {
        "id": str(uuid.uuid4()),
        "at": now.isoformat(),
        "switchedAt": _iso(since),
        "machine": _ref(machine),
        "orderId": order_id,
        "tableId": str(getattr(row, "table_id", None) or item.table_id),
        "tableNumber": getattr(row, "table_number", None),
        "tableName": getattr(row, "table_name", None),
        "tableLabel": getattr(row, "table_label", None),
        "till": {
            "status": item.status,
            "version": item.version,
            "total": f(item.total),
            "itemCount": float(item.item_count or 0),
            "guests": item.guests,
            "updatedAt": _iso(item.updated_at),
            "closedAt": _iso(item.closed_at),
            "transactionNumber": item.transaction_number,
        },
        "cloud": {
            "status": getattr(row, "status", None),
            "version": getattr(row, "version", None),
            "total": f(getattr(row, "total", None)),
            "updatedAt": _iso(getattr(row, "cloud_updated_at", None) or getattr(row, "updated_at", None)),
            "byMachineId": str(row.updated_machine_id) if getattr(row, "updated_machine_id", None) else None,
            "transactionNumber": getattr(row, "transaction_number", None),
        },
        "acknowledgedAt": None,
        "acknowledgedBy": None,
    }
    _put(shop, CHANGES_KEY, (entries + [entry])[-CHANGES_KEPT:])
    logger.warning("shop %s: the former host %s changed order %s, changed in the cloud too: kept", shop.id, machine.id, order_id)
    return entry


def former_host_changes_out(shop: Shop) -> Dict[str, Any]:
    """"X שינויים מהשרת הקודם": those not marked checked yet, newest first, and the latest checked."""
    rows = changes(shop)
    open_rows = [r for r in rows if not r.get("acknowledgedAt")]
    return {
        "count": len(open_rows),
        "items": list(reversed(open_rows)),
        "checked": list(reversed([r for r in rows if r.get("acknowledgedAt")]))[:20],
    }


def acknowledge_changes(shop: Shop, user: Any, ids: Optional[List[str]] = None, *, now: Optional[datetime] = None) -> int:
    """Mark the old server's changes checked (all, or `ids`). Returns how many."""
    now = _now(now)
    wanted = {str(i) for i in ids} if ids else None
    out, n = [], 0
    for entry in changes(shop):
        if not entry.get("acknowledgedAt") and (wanted is None or entry.get("id") in wanted):
            entry = {**entry, "acknowledgedAt": now.isoformat(), "acknowledgedBy": who(user)}
            n += 1
        out.append(entry)
    if n:
        _put(shop, CHANGES_KEY, out)
    return n
