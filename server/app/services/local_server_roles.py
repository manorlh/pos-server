"""
"תפקידי השרת המקומי" — which host roles a shop's dedicated local server holds, chosen per shop
(P:/specs/dedicated-local-server.md §11.9; the owner, 13.10.2026: "אני יכול להגדיר שהשרת המקומי
(שאינו קופה) הוא רק להזמנות, אבל לא גם הדפסות?").

Three roles, each held by one device of the shop — the dedicated server or a till:

* **"הזמנות ושולחנות"** (`tables`) — the tables host: `tablesHostTill` on that device;
* **"הדפסות"** (`print`) — the print server: `printHostTill` on that device — or **"ללא שרת הדפסות"**
  (`none`): every till prints its network printers itself (the tills' routing with no print
  server, `KitchenRouting.routeOf` → DIRECT; a cloud printer still prints at its host till). Kept
  as `shop.settings["localServerRoles"]["printNone"]`, which `printers.print_host_of_shop` reads
  before its main-till fallback;
* **"Z סניפי"** (`shopZ`, only in local shop Z mode) — the shop Z producer: the main till
  (`mainTill`), as local mode makes it the producer. Out of local mode `mainTill` follows the
  tables role.

**Default** — a shop with a dedicated server: every role on it, as the work profile and the
switch leave it (`mainTill` on the server; tables and printing follow it).

**Changing them** (`update`): the super admin, or a holder of "העברת שרת מקומי"; under the shop's
switch lock (the router) like every move of the server; each new holder may serve (online,
Android, in the LAN group); the shop Z production waits for a clean handover as a switch's does
(`local_shop_z.ensure_pin`); recorded with the switches (`source: "roles"`) and audited
(`local_server_switched`); every till hears it ("השרת הוחלף", and its parameters / printers).

**Election respects it**: each role's holder is named by its own flag, so the server is preferred
only for the roles it was given. **The failover** moves only the roles the failed device held
(`move_roles`).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shop import Shop

logger = logging.getLogger(__name__)

SETTINGS_KEY = "localServerRoles"
ROLES = ("tables", "print", "shopZ")
NONE = "none"
SOURCE_ROLES = "roles"
TABLES_HOST_KEY = "tablesHostTill"
#: The tills route kitchen jobs straight to the printers when the shop has no print server
#: (pos-android KitchenRouting.routeOf: no printHost → DIRECT), so "none" is offered.
NO_PRINT_HOST_SUPPORTED = True

ROLE_LABELS = {"tables": "הזמנות ושולחנות", "print": "הדפסות", "shopZ": "Z סניפי"}
NONE_LABEL = "ללא שרת הדפסות — כל קופה מדפיסה בעצמה"


def _now(now: Optional[datetime] = None) -> datetime:
    return now or datetime.now(timezone.utc)


def _uuid(value: Any) -> Optional[uuid.UUID]:
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def _refusal(status_code: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message, **extra})


# ── The marker "ללא שרת הדפסות" ───────────────────────────────────────────────


def _raw(shop: Optional[Shop]) -> Dict[str, Any]:
    raw = (getattr(shop, "settings", None) or {}).get(SETTINGS_KEY) if shop is not None else None
    return raw if isinstance(raw, dict) else {}


def print_none(shop: Optional[Shop]) -> bool:
    """The shop chose "ללא שרת הדפסות": no print server, whatever the main till is."""
    return _raw(shop).get("printNone") is True


def set_print_none(shop: Shop, value: bool) -> None:
    raw = dict(_raw(shop))
    if bool(raw.get("printNone")) == bool(value):
        return
    if value:
        raw["printNone"] = True
    else:
        raw.pop("printNone", None)
    settings = dict(shop.settings or {})
    if raw:
        settings[SETTINGS_KEY] = raw
    else:
        settings.pop(SETTINGS_KEY, None)
    shop.settings = settings  # reassigned: a JSONB column sees only a new value


# ── Who holds what ────────────────────────────────────────────────────────────


def holders(db: Session, shop: Shop) -> Dict[str, Optional[POSMachine]]:
    """The device of each role now (`shopZ` only in local mode), and the main till."""
    from app.services import local_shop_z as LZ
    from app.services import main_till as MT
    from app.services.printers import print_host_of_shop
    from app.services.tables import tables_host_of_shop

    main = MT.main_till_of_shop(db, shop.id)
    return {
        "tables": tables_host_of_shop(db, shop.id),
        "print": print_host_of_shop(db, shop.id),
        "shopZ": main if LZ.local_mode_of_shop(db, shop) else None,
        "main": main,
    }


def _ref(machine: Optional[POSMachine]) -> Optional[Dict[str, Any]]:
    from app.services.local_server_device import ref

    return ref(machine)


def remote_devices(db: Session, shop: Shop) -> List[POSMachine]:
    """
    The shop's devices that reach its network printers through the cloud relay: those closed
    "מרוחק (דרך הענן)" (`local_shop_z.remote_till_ids`) and its own-Z kiosks (they may stand away
    from the LAN, docs/SPEC_KIOSK.md §16.7). Their relayed tickets need a print server.
    """
    from app.models.kiosk import KioskDevice
    from app.services import local_shop_z as LZ
    from app.services.printers import shop_machines

    machines = shop_machines(db, shop.id)
    remote = LZ.remote_till_ids(shop)
    kiosk_ids = {
        str(r[0]) for r in db.query(KioskDevice.machine_id)
        .filter(KioskDevice.home_role.is_(None), KioskDevice.machine_id.in_([m.id for m in machines] or [uuid.uuid4()]))
        .all()
    }
    return [
        m for m in machines
        if str(m.id) in remote or (str(m.id) in kiosk_ids and bool(getattr(m, "independent_till", False)))
    ]


def _snapshot(db: Session, shop: Shop) -> Dict[str, Any]:
    h = holders(db, shop)
    return {
        "tables": _ref(h["tables"]),
        "print": NONE if print_none(shop) else _ref(h["print"]),
        "shopZ": _ref(h["shopZ"]),
    }


def view(db: Session, shop: Shop, user: Any = None, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """`GET /shops/{id}/local-server/roles`: each role's holder, the choices, who may change it."""
    from app.services import local_server_device as LSD
    from app.services import local_server_switch as LSS
    from app.services import local_shop_z as LZ
    from app.services.machine_status import is_online
    from app.services.printers import shop_machines

    now = _now(now)
    servers = LSD.servers_of_shop(db, shop.id)
    h = holders(db, shop)
    local = LZ.local_mode_of_shop(db, shop)

    def on_server(m: Optional[POSMachine]) -> bool:
        return m is not None and LSD.is_local_server(m)

    remote = remote_devices(db, shop)
    choices = []
    for m in sorted(shop_machines(db, shop.id), key=LSD.host_order):
        reason = LSS.ineligible_reason(db, m, now)
        if reason == "not_fiscal":
            continue  # a KDS / the board
        choices.append({
            **(_ref(m) or {}),
            "deviceRole": "local_server" if LSD.is_local_server(m) else "till",
            "online": is_online(m.last_heartbeat_at, now=now),
            "eligible": reason is None,
            "reason": reason,
            "reasonText": LSS.INELIGIBLE.get(reason) if reason else None,
        })
    last = next((r for r in reversed(LSS.switches(shop)) if r.get("source") == SOURCE_ROLES), None)
    return {
        "shopId": str(shop.id),
        # The card is for a shop with a dedicated server.
        "applies": bool(servers),
        "server": _ref(servers[0]) if servers else None,
        "localMode": local,
        "roles": {
            "tables": {"holder": _ref(h["tables"]), "onServer": on_server(h["tables"])},
            "print": {
                "holder": None if print_none(shop) else _ref(h["print"]),
                "none": print_none(shop),
                "onServer": on_server(h["print"]),
            },
            "shopZ": {"holder": _ref(h["shopZ"]), "onServer": on_server(h["shopZ"]), "applies": local},
        },
        "choices": choices,
        "noPrintHostSupported": NO_PRINT_HOST_SUPPORTED,
        # "ללא שרת הדפסות" only when no device of the shop prints through the cloud relay: a remote
        # kiosk / till reaches the shop's network printers through the print server alone.
        "noPrintHostAllowed": NO_PRINT_HOST_SUPPORTED and not remote,
        "remoteDevices": [_ref(m) for m in remote],
        "canEdit": LSS.may_switch(db, user) if user is not None else False,
        "lastChange": last,
    }


# ── Writing the flags ─────────────────────────────────────────────────────────


def _parameter(db: Session, key: str):
    from app.models.till_parameter import TillParameter
    from app.services.till_parameters import ensure_builtin_parameters

    ensure_builtin_parameters(db)
    return db.query(TillParameter).filter(TillParameter.key == key).first()


def _set_only(db: Session, shop: Shop, key: str, machine_id: Any, now: datetime) -> None:
    """`key` on at `machine_id`'s own level alone (None: on nowhere at a device level)."""
    from app.models.till_parameter import TillParameterValue
    from app.services.printers import shop_machines

    parameter = _parameter(db, key)
    if parameter is None:  # pragma: no cover - built in
        return
    ids = [m.id for m in shop_machines(db, shop.id)]
    if ids:
        db.query(TillParameterValue).filter(
            TillParameterValue.parameter_id == parameter.id,
            TillParameterValue.scope_type == "machine",
            TillParameterValue.scope_id.in_(ids),
        ).delete(synchronize_session=False)
    if machine_id is not None:
        db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=parameter.id, scope_type="machine", scope_id=_uuid(machine_id), value=True,
        ))
    parameter.updated_at = now
    db.flush()


def _machine_of(db: Session, shop: Shop, value: Any, role: str) -> POSMachine:
    mid = _uuid(value)
    machine = db.get(POSMachine, mid) if mid is not None else None
    if machine is None or machine.shop_id is None or str(machine.shop_id) != str(shop.id):
        raise _refusal(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "target_not_in_shop",
            f"המכשיר שנבחר ל\"{ROLE_LABELS[role]}\" אינו בסניף הזה.", role=role,
        )
    return machine


def _check_eligible(db: Session, machine: POSMachine, role: str, current: Optional[POSMachine], now: datetime) -> None:
    from app.services import local_server_switch as LSS

    # A new holder must be able to serve now (online); the one that holds it already stays.
    keeps = current is not None and current.id == machine.id
    reason = LSS.ineligible_reason(db, machine, now, require_online=not keeps)
    if reason is not None:
        raise _refusal(
            status.HTTP_409_CONFLICT, "target_not_eligible",
            f"\"{ROLE_LABELS[role]}\" — {LSS.till_label(machine)}: {LSS.INELIGIBLE[reason]}.",
            reason=reason, role=role,
        )


def _role_summary(snapshot: Dict[str, Any]) -> str:
    def name(value: Any) -> str:
        if value == NONE:
            return "ללא שרת הדפסות"
        if not value:
            return "—"
        number = value.get("posNumber")
        return f"קופה {number}" if number else (value.get("name") or "—")

    return " · ".join(f"{ROLE_LABELS[r]}: {name(snapshot.get(r))}" for r in ROLES if r in snapshot)


def update(
    db: Session, user: Any, shop: Shop, *, tables: Any, print_: Any, shop_z: Any = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    Give each role to a device (`print_` may be "none"; `shop_z` only in local mode). Refusals:
    403 `local_server_switch_forbidden`; 409 `no_local_server` (no dedicated server in the shop);
    422 `target_not_in_shop`, `shop_z_role_not_local`, `print_none_not_supported`; 409
    `target_not_eligible` (with `role`, `reason`), `z_run_in_progress`. Flushed, not committed —
    the caller holds the shop's switch lock, commits, then tells the tills (`after_host_change`).
    """
    from app.models.z_run import ZRun, ZRunStatus
    from app.services import local_server_device as LSD
    from app.services import local_server_switch as LSS
    from app.services import local_shop_z as LZ
    from app.services import main_till as MT
    from app.services.printers import set_print_host
    from app.services.till_messages import send_server_switch_notice

    now = _now(now)
    LSS.require_switch(db, user)
    if not LSD.servers_of_shop(db, shop.id):
        raise _refusal(
            status.HTTP_409_CONFLICT, "no_local_server",
            "אין בסניף שרת מקומי ייעודי. מוסיפים אותו כ\"שרת מקומי\" בהוספת מכשיר.",
        )
    local = LZ.local_mode_of_shop(db, shop)
    if shop_z is not None and not local:
        raise _refusal(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "shop_z_role_not_local",
            "\"Z סניפי\" הוא תפקיד רק כשהסניף עובד ב-Z סניפי בשרת מקומי (רשת מקומית).",
        )
    current = holders(db, shop)
    tables_m = _machine_of(db, shop, tables, "tables")
    _check_eligible(db, tables_m, "tables", current["tables"], now)
    print_m: Optional[POSMachine] = None
    none = str(print_ or "").strip().lower() == NONE
    if none:
        if not NO_PRINT_HOST_SUPPORTED:  # pragma: no cover - supported
            raise _refusal(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "print_none_not_supported", "חייב להיות שרת הדפסות.",
            )
        remote = remote_devices(db, shop)
        if remote:
            from app.services import local_server_switch as LSS_

            names = ", ".join(LSS_.till_label(m) for m in remote)
            raise _refusal(
                status.HTTP_409_CONFLICT, "print_none_remote_devices",
                f"בסניף יש מכשירים מרוחקים שמדפיסים דרך הענן ({names}). הבונים שלהם מגיעים למדפסות הרשת רק דרך "
                "שרת הדפסות — בחרו שרת הדפסות (השרת המקומי או קופה).",
                machineIds=[str(m.id) for m in remote],
            )
    else:
        print_m = _machine_of(db, shop, print_, "print")
        _check_eligible(db, print_m, "print", None if print_none(shop) else current["print"], now)
    if local:
        if shop_z is None:
            # Not sent: the producer stays (the main till as it is).
            z_m = current["shopZ"] or current["main"]
            if z_m is None:
                raise _refusal(status.HTTP_422_UNPROCESSABLE_ENTITY, "target_not_in_shop", "בחרו מי מפיק את ה-Z הסניפי.")
        else:
            z_m = _machine_of(db, shop, shop_z, "shopZ")
            _check_eligible(db, z_m, "shopZ", current["shopZ"], now)
        main_m = z_m
    else:
        main_m = tables_m

    before = _snapshot(db, shop)
    main_changes = current["main"] is None or current["main"].id != main_m.id
    if main_changes:
        live = (
            db.query(ZRun.id)
            .filter(ZRun.shop_id == shop.id, ZRun.status.in_([ZRunStatus.WAITING, ZRunStatus.BUILDING]))
            .first()
        )
        if live is not None:
            raise _refusal(
                status.HTTP_409_CONFLICT, "z_run_in_progress",
                "יש Z סניפי בתהליך — המתינו לסיומו, ואז שנו את תפקידי השרת.",
            )
    # The shop Z production moves only once the one producing now can hand over (as a switch's).
    LZ.ensure_pin(db, shop, now=now)
    if main_changes:
        MT.set_main_till(db, shop, main_m.id, now=now)
    _set_only(db, shop, TABLES_HOST_KEY, tables_m.id, now)
    if none:
        _set_only(db, shop, "printHostTill", None, now)
        set_print_none(shop, True)
    else:
        set_print_host(db, shop, print_m.id)
        set_print_none(shop, False)
    db.flush()
    LSD.forget_shop(shop.id)
    # Relayed tickets no till took yet follow the print server now (remote kiosks and tills).
    from app.services.printers import retarget_relay_jobs

    retarget_relay_jobs(db, shop.id)
    # The shop Z production moves now if the one producing can hand over cleanly (else it waits).
    LZ.effective_producer(db, shop, now=now)
    after = _snapshot(db, shop)
    changed = [r for r in ROLES if before.get(r) != after.get(r)]
    out = view(db, shop, user, now=now)
    if not changed:
        return {**out, "changed": []}
    by = LSS.who(user)
    record = {
        "id": str(uuid.uuid4()),
        "at": now.isoformat(),
        "by": by,
        "byUserId": str(user.id) if getattr(user, "id", None) else None,
        "source": SOURCE_ROLES,
        "approvedBy": None,
        "from": before.get("tables") if isinstance(before.get("tables"), dict) else None,
        "to": after.get("tables") if isinstance(after.get("tables"), dict) else None,
        "moved": changed,
        "forced": False,
        "closedShift": None,
        "releasedShopZ": False,
        "roles": {"before": before, "after": after},
    }
    LSS._put(shop, LSS.SWITCHES_KEY, (LSS.switches(shop) + [record])[-LSS.SWITCHES_KEPT:])
    target = tables_m if "tables" in changed else (print_m or main_m)
    LSS._record_switch(db, target, shop, record)
    # Every till: "השרת הוחלף" with what holds which role now.
    send_server_switch_notice(
        db, shop.id, after.get("tables") if isinstance(after.get("tables"), dict) else None,
        before.get("tables") if isinstance(before.get("tables"), dict) else None, by, now=now,
        body=(
            f"תפקידי השרת המקומי שונו על ידי {by}: {_role_summary(after)}.\n"
            "יש לבדוק תקינות נתונים: שולחנות והזמנות פתוחים, בונים שלא הודפסו, "
            "ובדשבורד את כרטיס \"שרת מקומי\" בדף הסניף."
        ),
    )
    logger.warning("shop %s: local server roles by %s: %s -> %s", shop.id, by, before, after)
    return {**view(db, shop, user, now=now), "changed": changed}


# ── The failover: only what the failed device held ────────────────────────────


def move_roles(db: Session, shop: Shop, old: POSMachine, new: POSMachine, *, now: datetime) -> Dict[str, Any]:
    """
    The roles `old` holds — and only those — moved to `new`: every host flag it holds at its own
    level, and a role it held with no flag of its own (the lone server's tables) named on `new`.
    The shop Z production waits for a clean handover (`ensure_pin`). `take_over`'s answer shape.
    """
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services import local_server_device as LSD
    from app.services import local_shop_z as LZ
    from app.services import main_till as MT
    from app.services.printers import set_print_host

    held = LSD.hosting(db, old)
    LZ.ensure_pin(db, shop, now=now)
    by_key = {p.key: p for p in db.query(TillParameter).filter(TillParameter.key.in_(MT.HOST_KEYS)).all()}
    moved: List[str] = []
    for key in MT.HOST_KEYS:
        parameter = by_key.get(key)
        if parameter is None:
            continue
        rows = (
            db.query(TillParameterValue)
            .filter(
                TillParameterValue.parameter_id == parameter.id,
                TillParameterValue.scope_type == "machine",
                TillParameterValue.scope_id == old.id,
            )
            .all()
        )
        if not any(MT.is_on(r.value) for r in rows):
            continue
        db.query(TillParameterValue).filter(
            TillParameterValue.parameter_id == parameter.id,
            TillParameterValue.scope_type == "machine",
            TillParameterValue.scope_id.in_([old.id, new.id]),
        ).delete(synchronize_session=False)
        db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=parameter.id, scope_type="machine", scope_id=new.id, value=True,
        ))
        parameter.updated_at = now
        moved.append(key)
    db.flush()
    LSD.forget_shop(shop.id)
    after = LSD.hosting(db, new)
    if held["mainTill"] and not after["mainTill"]:
        MT.set_main_till(db, shop, new.id, now=now)
        moved.append(MT.MAIN_TILL_KEY)
    if held["tables"] and not LSD.hosting(db, new)["tables"]:
        _set_only(db, shop, TABLES_HOST_KEY, new.id, now)
        moved.append(TABLES_HOST_KEY)
    if held["print"] and not LSD.hosting(db, new)["print"]:
        set_print_host(db, shop, new.id)
        moved.append("printHostTill")
    db.flush()
    LSD.forget_shop(shop.id)
    producer = LZ.effective_producer(db, shop, now=now)
    # The roles as configured (the shop Z: the main till in local mode) — the producer itself may
    # still be on its way (a handover that waits for the old one's Zs).
    shop_z = held["mainTill"] and LZ.local_mode_of_shop(db, shop)
    return {
        "mainTill": _ref(new),
        "previous": _ref(old),
        "moved": list(dict.fromkeys(moved)),
        "roles": [r for r, on in (("tables", held["tables"]), ("print", held["print"]), ("shopZ", shop_z)) if on],
        "shopZHandover": producer.to_json(db)["handover"],
    }
