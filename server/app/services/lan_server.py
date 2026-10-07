"""
The shop's local network (docs/SPEC_LAN_MODE.md): which devices may be its local server,
and the shop's switch "רשת מקומית".

**"לא משמש כשרת מקומי" (§3).** A device of the shop that is never its local server:

* never elected the main till, the tables host, the print server or the shop Z master —
  `server_candidates` is the LAN group (`independent_till.lan_members`) without it, and
  every host election reads from it (`main_till.main_till_of_shop`,
  `tables.tables_host_of_shop` with its one-till fallback, `printers.print_host_of_shop`,
  `main_till.take_over`, the main till pickers);
* its host parameters read "off" whatever level set them (`excluded_parameters`, the way
  `independent_till.independent_parameters` does) — but `tablesMode` is left as it is: it
  still works with the shop's tables, through the host;
* it stays in the LAN group and in the shop Z (unlike an independent till): the main till
  closes it with the others, and it uses the shop's tables host and print server;
* the till hears it on every heartbeat (`lanServerExcluded`) and then never starts a LAN
  host of its own, whatever its technician set (`tables.lanHostOverride = "self"`). A
  printer attached to it is still served to the others: that is a printer endpoint, not
  the shop's server (the owner's decision 2).

Who is excluded: the stored flag (`pos_machines.lan_server_excluded`), and — whatever it
says — a till showing a KDS screen (a `kds_devices` row on a fiscal till: it shows the
kitchen, not the till; display devices are outside the LAN group altogether). A kiosk and
a handheld are only *suggested* (`suggested`): the dashboard pre-ticks them until the flag
was set once (`lan_server_excluded_at`).

**"רשת מקומית" (§4).** `shops.local_network`: with a main till, the shop is in local mode
(`local_shop_z.local_mode_of_shop`) — the main till produces the shop Z on the LAN. The
switch needs a main till and moves the shop Z production through the producer's guard
(`ProducerGuard`, docs/SPEC_INDEPENDENT_TILL.md §8.10), like every other transition.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.user import User, UserRole

#: The till parameters that name a till for a job of the shop's LAN group — the same four
#: an independent till reads "off" (`independent_till.HOST_KEYS`).
HOST_KEYS = ("mainTill", "tablesHostTill", "printHostTill", "shopZMasterTill")

#: Why a device is excluded: the dashboard's flag, or a till showing a KDS screen.
REASON_SET = "set"
REASON_KDS_SCREEN = "kds_screen"

#: The handhelds the dashboard pre-ticks: the SUNMI handhelds and PDAs, the PAX A77 and the
#: Urovo i9100 (app/models/sunmi.py, app/models/vendor_devices.py). Not the F20 / Nova 55F:
#: it is often a shop's counter till.
HANDHELD_MODELS = frozenset({
    "SUNMI_V1", "SUNMI_V2", "SUNMI_V2_PRO", "SUNMI_V2S", "SUNMI_V2S_PLUS", "SUNMI_V3",
    "SUNMI_P1", "SUNMI_P2", "SUNMI_P3", "SUNMI_L2",
    "PAX_A77", "UROVO_I9100",
})
#: `workflowSource` of a waiter's handheld ("מסופון", app/services/kds_workflow.py).
HANDHELD_SOURCE = "HANDHELD"

#: The refusals, as `{detail: {code, message}}`.
MAIN_TILL_NOT_SERVER = "main_till_not_server"
EXCLUDED_IS_MAIN = "lan_server_excluded_main_till"
PRINT_HOST_NOT_SERVER = "print_host_not_server"
TAKE_OVER_NOT_SERVER = "lan_server_excluded"


def _label(machine: Optional[POSMachine]) -> str:
    if machine is None:
        return "המכשיר"
    number = (machine.pos_number or "").strip()
    return f"קופה {number}" if number else (machine.name or "המכשיר")


def _uuid(value: Any) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


# ── Who is excluded ────────────────────────────────────────────────────────────


def kds_screen_ids(db: Session, machine_ids: Iterable[Any]) -> Set[uuid.UUID]:
    """The machines among `machine_ids` that show a KDS screen (an active `kds_devices` row)."""
    from app.models.kds import KdsDevice

    ids = [_uuid(i) for i in machine_ids if i is not None]
    if not ids:
        return set()
    rows = (
        db.query(KdsDevice.machine_id)
        .filter(KdsDevice.machine_id.in_(ids), KdsDevice.is_active.is_(True))
        .all()
    )
    return {_uuid(r[0]) for r in rows if r[0] is not None}


def exclusion_of(machine: POSMachine, kds_ids: Set[uuid.UUID]) -> Optional[str]:
    """Why `machine` is never the shop's server (`set` / `kds_screen`), or None."""
    if bool(getattr(machine, "lan_server_excluded", False)):
        return REASON_SET
    if machine.id is not None and _uuid(machine.id) in kds_ids:
        return REASON_KDS_SCREEN
    return None


def exclusion(db: Session, machine: Optional[POSMachine]) -> Optional[str]:
    if machine is None:
        return None
    if bool(getattr(machine, "lan_server_excluded", False)):
        return REASON_SET
    return exclusion_of(machine, kds_screen_ids(db, [machine.id]))


def is_excluded(db: Session, machine: Optional[POSMachine]) -> bool:
    """"לא משמש כשרת מקומי": set on the dashboard, or a till showing a KDS screen."""
    return exclusion(db, machine) is not None


def server_candidates(db: Session, machines: Iterable[POSMachine]) -> List[POSMachine]:
    """
    The devices that may be the shop's local server: the LAN group
    (`independent_till.lan_members` — no independent till, no display device) without the
    excluded ones. Every host election reads from this, in the given order.
    """
    from app.services.independent_till import lan_members

    members = lan_members(machines)
    kds = kds_screen_ids(db, [m.id for m in members if not getattr(m, "lan_server_excluded", False)])
    return [m for m in members if exclusion_of(m, kds) is None]


def excluded_parameters(resolved: Dict[str, Any]) -> Dict[str, Any]:
    """
    The parameters as an excluded device reads them (pure): every host flag off. Unlike an
    independent till, `tablesMode` stays as resolved — it works with the shop's tables.
    """
    out = dict(resolved)
    for key in HOST_KEYS:
        if key in out:
            out[key] = False
    return out


def is_handheld(machine: POSMachine, params: Optional[Dict[str, Any]] = None) -> bool:
    if getattr(machine, "device_model", None) in HANDHELD_MODELS:
        return True
    return bool(params) and str(params.get("workflowSource") or "").upper() == HANDHELD_SOURCE


def suggested(machine: POSMachine, params: Optional[Dict[str, Any]] = None) -> bool:
    """The dashboard pre-ticks it ("מומלץ"): a kiosk or a handheld."""
    return bool(getattr(machine, "is_kiosk", False)) or is_handheld(machine, params)


def state_of(db: Session, machine: POSMachine, kds_ids: Optional[Set[uuid.UUID]] = None,
             params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The card's view of one device: `{excluded, reason, auto, suggested, chosen}`."""
    kds = kds_ids if kds_ids is not None else kds_screen_ids(db, [machine.id])
    reason = exclusion_of(machine, kds)
    return {
        "lanServerExcluded": reason is not None,
        "lanServerExcludedReason": reason,
        # A KDS screen is excluded by itself: the switch cannot take it back.
        "lanServerExcludedAuto": reason == REASON_KDS_SCREEN and not getattr(machine, "lan_server_excluded", False),
        "lanServerExcludedSuggested": suggested(machine, params),
        "lanServerExcludedChosen": getattr(machine, "lan_server_excluded_at", None) is not None,
    }


# ── The refusals of the elections ─────────────────────────────────────────────


def main_till_refusal(machine: POSMachine) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": MAIN_TILL_NOT_SERVER,
            "message": (
                f"{_label(machine)} מסומנת \"לא משמש כשרת מקומי\" ולכן לא יכולה להיות הקופה הראשית של הסניף. "
                "בחרו קופה אחרת, או בטלו את הסימון במכשיר."
            ),
            "machineId": str(machine.id),
        },
    )


def print_host_refusal(machine: POSMachine) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": PRINT_HOST_NOT_SERVER,
            "message": (
                f"{_label(machine)} מסומנת \"לא משמש כשרת מקומי\" ולכן לא יכולה להיות שרת ההדפסות של הסניף. "
                "המדפסות שמחוברות אליה עדיין מודפסות דרכה."
            ),
            "machineId": str(machine.id),
        },
    )


def take_over_refusal(machine: POSMachine) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": TAKE_OVER_NOT_SERVER,
            "message": f"{_label(machine)} מסומנת \"לא משמש כשרת מקומי\" ולכן לא יכולה לקבל את השרת. העבירו לקופה אחרת.",
        },
    )


# ── The switch on a device ─────────────────────────────────────────────────────


def _clear_host_flags(db: Session, machine: POSMachine, now: datetime) -> List[str]:
    from app.services.independent_till import _clear_host_flags as clear

    return clear(db, machine, now)


def excluded_main_refusal(machine: POSMachine) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": EXCLUDED_IS_MAIN,
            "message": (
                f"{_label(machine)} היא הקופה הראשית (השרת המקומי) של הסניף. "
                "בחרו קופה ראשית אחרת, ואז סמנו אותה \"לא משמש כשרת מקומי\"."
            ),
            "machineId": str(machine.id),
        },
    )


def apply_excluded(db: Session, machine: POSMachine, excluded: bool, now: datetime) -> bool:
    """
    Store the choice (pure write, no checks): the flag and when it was chosen; on, the host
    parameters set at the device's own level are removed. True when the flag changed.
    """
    was = bool(getattr(machine, "lan_server_excluded", False))
    machine.lan_server_excluded_at = now
    if excluded == was:
        return False
    machine.lan_server_excluded = excluded
    if excluded:
        _clear_host_flags(db, machine, now)
    return True


def set_excluded(db: Session, user: User, machine: POSMachine, excluded: bool, *,
                 force_producer_switch: bool = False, now: Optional[datetime] = None) -> bool:
    """
    "לא משמש כשרת מקומי" on (or off) for `machine` — the machine page's switch. The super
    admin's alone (it decides who may hold the shop's tables and its shop Z). Refused for
    the shop's main till — pick another main till first. True when it changed. Through the
    shop Z producer's guard, like every change of who serves the shop. The caller commits
    and tells the shop's tills.
    """
    from app.models.shop import Shop
    from app.services.local_shop_z import LocalShopZRefused, ProducerGuard
    from app.services.main_till import main_till_of_shop

    if user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super_admin_only")
    now = now or datetime.now(timezone.utc)
    if excluded and machine.shop_id is not None:
        main = main_till_of_shop(db, machine.shop_id)
        if main is not None and main.id == machine.id:
            raise excluded_main_refusal(machine)
    shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
    guard = ProducerGuard(db, [shop], now=now)
    changed = apply_excluded(db, machine, excluded, now)
    db.flush()
    try:
        guard.check(force=force_producer_switch, user=user)
    except LocalShopZRefused as refused:
        raise HTTPException(
            status_code=refused.status_code,
            detail={"code": refused.body.get("detail"), **{k: v for k, v in refused.body.items() if k != "detail"}},
        )
    return changed


def card_rows(db: Session, machines: Sequence[POSMachine]) -> Dict[str, Dict[str, Any]]:
    """`state_of` for many devices of one shop (one query for the KDS screens)."""
    from app.services.till_parameters import till_parameters_for_machine

    kds = kds_screen_ids(db, [m.id for m in machines])
    out: Dict[str, Dict[str, Any]] = {}
    for m in machines:
        params = None
        if getattr(m, "device_model", None) not in HANDHELD_MODELS and not getattr(m, "is_kiosk", False):
            params = till_parameters_for_machine(db, m).parameters
        out[str(m.id)] = state_of(db, m, kds, params)
    return out


# ── The shop's switch "רשת מקומית" (§4) ─────────────────────────────────────────

LOCAL_NETWORK_NEEDS_MAIN = "local_network_requires_main_till"

#: One row per system on the main till card: what works on the LAN through the main till
#: today. `state`: lan (through the main till), other_host (on the LAN, through another
#: till), cloud (through the cloud only), off (not in use), soon (not on the LAN yet),
#: partial (part of it on the LAN), none (no such device in the shop).
SYSTEMS = ("tables", "print", "shop_z", "kds", "kiosk")


def set_local_network(db: Session, user: User, shop, enabled: bool, *,
                      force_producer_switch: bool = False, now: Optional[datetime] = None) -> bool:
    """
    "רשת מקומית" on or off for the shop. The super admin's alone. On needs a main till (409
    `local_network_requires_main_till`). The shop Z production moves with it only through
    the producer's guard (docs/SPEC_INDEPENDENT_TILL.md §8.10): 409 `shop_z_producer_busy`
    unless the one producing now can hand over cleanly — or a super admin forces it.
    True when it changed. The caller commits and tells the shop's tills.
    """
    from app.services.local_shop_z import LocalShopZRefused, ProducerGuard
    from app.services.main_till import main_till_of_shop

    if user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super_admin_only")
    now = now or datetime.now(timezone.utc)
    if enabled and main_till_of_shop(db, shop.id) is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": LOCAL_NETWORK_NEEDS_MAIN,
                "message": "כדי להפעיל רשת מקומית צריך קופה ראשית. בחרו קופה ראשית לסניף, ואז הפעילו.",
            },
        )
    if bool(shop.local_network) == enabled:
        return False
    guard = ProducerGuard(db, [shop], now=now)
    shop.local_network = enabled
    shop.local_network_changed_at = now
    db.flush()
    try:
        guard.check(force=force_producer_switch, user=user)
    except LocalShopZRefused as refused:
        raise HTTPException(
            status_code=refused.status_code,
            detail={"code": refused.body.get("detail"), **{k: v for k, v in refused.body.items() if k != "detail"}},
        )
    return True


def _ref(machine: Optional[POSMachine]) -> Optional[Dict[str, Any]]:
    if machine is None:
        return None
    return {"machineId": str(machine.id), "posNumber": machine.pos_number, "name": machine.name}


def health(db: Session, shop) -> List[Dict[str, Any]]:
    """
    The card's rows, one per system (`SYSTEMS`): `{system, state, host}` — what is LAN-capable
    today and through which till. The texts are the dashboard's.
    """
    from app.models.kiosk import KioskDevice
    from app.services.local_shop_z import local_mode_of_shop
    from app.services.main_till import main_till_of_shop
    from app.services.printers import print_host_of_shop, shop_machines
    from app.services.tables import MODE_LAN, MODE_OFF, MODE_SINGLE, TABLES_MODE_KEY, mode_of, tables_host_of_shop
    from app.services.till_parameters import resolve_for_shop

    main = main_till_of_shop(db, shop.id)
    is_main = lambda m: m is not None and main is not None and m.id == main.id  # noqa: E731
    rows: List[Dict[str, Any]] = []

    tables_mode = mode_of(resolve_for_shop(db, shop).get(TABLES_MODE_KEY))
    if tables_mode == MODE_LAN:
        host = tables_host_of_shop(db, shop.id)
        rows.append({
            "system": "tables",
            "state": "lan" if is_main(host) else ("other_host" if host is not None else "no_host"),
            "host": _ref(host),
        })
    else:
        rows.append({
            "system": "tables",
            "state": "off" if tables_mode in (MODE_OFF, MODE_SINGLE) else "cloud",
            "host": None,
        })

    printer = print_host_of_shop(db, shop.id)
    rows.append({
        "system": "print",
        "state": "lan" if is_main(printer) else ("other_host" if printer is not None else "off"),
        "host": _ref(printer),
    })

    local = local_mode_of_shop(db, shop)
    rows.append({"system": "shop_z", "state": "lan" if local else "cloud", "host": _ref(main) if local else None})

    # The kitchen engine runs in the cloud only (P1–P2 bring it to the main till).
    rows.append({"system": "kds", "state": "soon", "host": None})

    machines = shop_machines(db, shop.id)
    kiosks = (
        db.query(KioskDevice.machine_id).filter(KioskDevice.machine_id.in_([m.id for m in machines])).count()
        if machines else 0
    )
    # A kiosk's tickets print on the LAN and its pay-at-till orders reach the main till with
    # no cloud; its open orders, alerts and remote commands still lean on the cloud (P4–P5).
    rows.append({"system": "kiosk", "state": "partial" if kiosks else "none", "host": _ref(main) if kiosks else None})
    return rows


# ── "השרת מעדכן את הענן בזמן אמת": the local server's sync lag (§6) ──────────────

#: The owner: while there is internet the cloud copy follows the local server in real time
#: (pushed on change, coalesced within 1–2 s). A change older than this, while the server
#: is online, means it does not: the card alerts.
SYNC_ALERT_SECONDS = 60
#: A report older than this says nothing any more (the device stopped serving, or is silent).
SYNC_REPORT_FRESH_SECONDS = 300


def _iso_minus(now: datetime, age_ms: Any) -> Optional[str]:
    try:
        age = int(age_ms)
    except (TypeError, ValueError):
        return None
    from datetime import timedelta

    return (now - timedelta(milliseconds=max(age, 0))).isoformat()


def _sync_entry(pending: Any, age_ms: Any, now: datetime, old: Optional[dict]) -> Dict[str, Any]:
    count = int(pending or 0)
    oldest = _iso_minus(now, age_ms) if count > 0 else None
    # Keep the moment stable across beats (the till's age and the network delay jitter):
    # the same oldest change, give or take two seconds, is the same change.
    if oldest and isinstance(old, dict) and old.get("oldestAt") and count > 0:
        try:
            before = datetime.fromisoformat(old["oldestAt"])
            if abs((datetime.fromisoformat(oldest) - before).total_seconds()) <= 2:
                oldest = old["oldestAt"]
        except ValueError:
            pass
    return {"pending": count, "oldestAt": oldest}


def note_sync(machine: POSMachine, block: Any, *, now: Optional[datetime] = None) -> None:
    """A local server's `lanSync` on its heartbeat: kept on the device, the oldest change as a moment."""
    now = now or datetime.now(timezone.utc)
    old = machine.lan_sync if isinstance(machine.lan_sync, dict) else {}
    new = _sync_entry(getattr(block, "pending", None), getattr(block, "oldest_age_ms", None), now, old)
    systems = getattr(block, "systems", None) or {}
    if systems:
        old_systems = old.get("systems") if isinstance(old.get("systems"), dict) else {}
        new["systems"] = {
            str(name)[:32]: _sync_entry(
                getattr(s, "pending", None), getattr(s, "oldest_age_ms", None), now, old_systems.get(str(name)[:32]),
            )
            for name, s in list(systems.items())[:10]
        }
    if new != old:
        machine.lan_sync = new
    machine.lan_sync_reported_at = now


def sync_state(db: Session, shop, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    The main till card's "סנכרון רשת מקומית": the device that serves the shop's LAN (the
    tables host, else the main till) and what its cloud copy still lacks. `state`:
    synced · syncing (changes on their way, the oldest under a minute) · lagging (online, and
    a change older than a minute — `alert`) · offline (it catches up when it is back; the
    others work on in the meantime) · unknown (no fresh report: an older app, or not
    serving) · none (no local server).
    """
    from app.services.machine_status import is_online
    from app.services.main_till import main_till_of_shop
    from app.services.tables import tables_host_of_shop

    now = now or datetime.now(timezone.utc)
    host = tables_host_of_shop(db, shop.id) or main_till_of_shop(db, shop.id)
    if host is None:
        return {"state": "none", "host": None, "pending": 0, "oldestAgeSeconds": None, "alert": False}
    report = host.lan_sync if isinstance(getattr(host, "lan_sync", None), dict) else None
    at = getattr(host, "lan_sync_reported_at", None)
    if at is not None and at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    base = {"host": _ref(host), "reportedAt": at.isoformat() if at else None}
    if report is None or at is None or (now - at).total_seconds() > SYNC_REPORT_FRESH_SECONDS:
        return {**base, "state": "unknown", "pending": 0, "oldestAgeSeconds": None, "alert": False}
    pending = int(report.get("pending") or 0)
    age = None
    if pending and report.get("oldestAt"):
        try:
            oldest = datetime.fromisoformat(report["oldestAt"])
            age = max(int((now - oldest).total_seconds()), 0)
        except ValueError:
            age = None
    online = is_online(host.last_heartbeat_at, now=now)
    systems = report.get("systems") if isinstance(report.get("systems"), dict) else {}
    out = {**base, "pending": pending, "oldestAgeSeconds": age, "systems": systems}
    if not online:
        return {**out, "state": "offline", "alert": False}
    if pending == 0:
        return {**out, "state": "synced", "alert": False}
    if age is not None and age > SYNC_ALERT_SECONDS:
        return {**out, "state": "lagging", "alert": True}
    return {**out, "state": "syncing", "alert": False}
