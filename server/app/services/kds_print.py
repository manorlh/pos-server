"""
"איך המסך מדפיס" — a kitchen screen (KDS) or the "מוכן / לא מוכן" board that prints with nothing
installed (owner, 17.10.2026): the browser screen (`/kds`, `/board` — an iPad, an Android tablet's
browser, Windows Chrome) hands its bon to the shop's cloud print relay (`kitchen_print_jobs`,
app/services/printers.py) and a till of the shop prints it, as it prints a kiosk's bon on a till's
own printer (§16.9 of docs/SPEC_KIOSK.md). Before this the web KDS printed only through the Windows
bridge (§28 of docs/SPEC_KIOSK.md).

* **The path** (`kdsPrintPath`, a till parameter — company → shop → point of sale → till, set for one
  screen from the KDS page's "הדפסה" card): `none` (ללא הדפסה), `relay` (דרך קופה בסניף — no
  install), `bridge` (the Windows bridge on that PC), `app` (the Android / Windows app's own printer),
  or `device` (the default: what the device did before — the bridge in a browser, the app's own
  printer in an app).
* **Where** (`kdsPrintHost`, `kdsPrintPrinter`; empty = automatic): a kitchen printer the relay
  serves (a cloud printer with its host till, or a network / Bluetooth printer the shop's print
  server prints), or a till's own printer (its built-in head, its USB / Bluetooth printer — the same
  "המדפסת המובנית — <קופה>" entry a kiosk's bon uses, made on first use). Automatic: a host of the
  screen's point of sale first (`area_id`, or the points of sale its orders come from), else of the
  shop — the shop's print server first, then a till heard from lately, its built-in head first.
* **The rules it keeps** — the screen's own `remotePrintEnabled` (off: 409 `remote_print_off`) and
  `remotePrintHosts` (a host outside it: 409 `host_not_allowed`; automatic skips it); a printer
  narrowed to another point of sale is not the screen's (409 `printer_out_of_scope`).
  `remotePrintTimeoutSec` is how long a bon waits for a till to take it (`expires_at`); a bon a till
  took and never answered for is given up after `TAKEN_TTL`.
* **The job** — an ordinary relayed `ticket` (a test: `test`), idempotent by the screen's id, sent from
  the screen (`source_machine_id`), the ticket as the KDS prints it (app/schemas `TicketIn`, its
  `sourceName` the screen). The hosts print it like any relayed ticket — nothing new for them; the
  pending job says `origin: "kds"`. The cloud keeps `_kds` beside the ticket (never handed out).
* **"לא הודפס"** — a bon that failed or expired is "בון לא הודפס" on "בעיות" (app/services/bon_alerts.py,
  kind `bon_unprinted`, key `bon_unprinted:kds:<job>`), resolved by itself when it prints after all.

Over the shop's LAN the browser cannot reach a till (an https page may not call a plain http address),
so the browser's path is the cloud only; the till takes it at once on its `print-job` push.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine

logger = logging.getLogger(__name__)

# ── The parameters ───────────────────────────────────────────────────────────

PATH_KEY = "kdsPrintPath"
HOST_KEY = "kdsPrintHost"
PRINTER_KEY = "kdsPrintPrinter"
KEYS: Tuple[str, ...] = (PATH_KEY, HOST_KEY, PRINTER_KEY)

PATH_DEVICE = "device"
PATH_NONE = "none"
PATH_RELAY = "relay"
PATH_BRIDGE = "bridge"
PATH_APP = "app"
PATH_OPTIONS = (PATH_DEVICE, PATH_NONE, PATH_RELAY, PATH_BRIDGE, PATH_APP)
PATH_LABELS = {
    PATH_DEVICE: "לפי סוג המכשיר (ברירת מחדל)",
    PATH_NONE: "ללא הדפסה",
    PATH_RELAY: "דרך קופה בסניף (ללא התקנה)",
    PATH_BRIDGE: "גשר Windows (מותקן)",
    PATH_APP: "אפליקציית אנדרואיד (מובנה)",
}

_LEVELS = "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה — ולמסך אחד בכרטיס \"הדפסה\" שלו בעמוד מסכי המטבח."

PARAMETER_SPECS: Tuple[Dict[str, Any], ...] = (
    dict(
        key=PATH_KEY,
        label="מסך מטבח — איך המסך מדפיס",
        value_type="enum",
        enum_options=PATH_OPTIONS,
        enum_labels=PATH_LABELS,
        default_value=PATH_DEVICE,
        description=(
            "איך מסך מטבח (KDS) או מסך מוכן / לא מוכן מדפיס בון. "
            f"«{PATH_LABELS[PATH_RELAY]}» — המסך שולח את הבון לקופה בסניף והיא מדפיסה במדפסת שלה, בלי להתקין "
            "דבר (אייפד, טאבלט אנדרואיד בדפדפן, Chrome ב-Windows). "
            f"«{PATH_LABELS[PATH_BRIDGE]}» — הגשר שמותקן במחשב ה-Windows של המסך. "
            f"«{PATH_LABELS[PATH_APP]}» — האפליקציה מדפיסה במדפסת שלה. "
            f"«{PATH_LABELS[PATH_DEVICE]}» — כמו עד היום: בדפדפן דרך הגשר אם יש, באפליקציה במדפסת שלה. {_LEVELS}"
        ),
    ),
    dict(
        key=HOST_KEY,
        label="מסך מטבח — הקופה שמדפיסה",
        value_type="string",
        default_value="",
        description=(
            "כשהמסך מדפיס דרך קופה בסניף: מזהה הקופה שמדפיסה את הבונים שלו. ריק — אוטומטי: קופה של אותה "
            "נקודת מכירה אם יש, אחרת של הסניף (שרת ההדפסות קודם, אחר כך קופה מחוברת עם מדפסת מובנית). "
            f"{_LEVELS}"
        ),
    ),
    dict(
        key=PRINTER_KEY,
        label="מסך מטבח — המדפסת",
        value_type="string",
        default_value="",
        description=(
            "כשהמסך מדפיס דרך קופה בסניף: מזהה מדפסת מטבח (מסוג ענן, או רשת / Bluetooth ששרת ההדפסות מדפיס). "
            f"ריק — המדפסת של הקופה שנבחרה (המובנית שלה). {_LEVELS}"
        ),
    ),
)

#: A bon a till took and never answered for is given up after this (a KDS waits for its word).
TAKEN_TTL = timedelta(minutes=10)
#: What the cloud keeps beside the ticket (never handed to a host).
META_KEY = "_kds"
#: The job's word to the host (`GET /sync/{m}/print-jobs/pending`).
ORIGIN = "kds"
TEST_NOTICE = "הדפסת בדיקה ממסך המטבח — לא להכנה"


class KdsPrintValueError(ValueError):
    pass


def clean_value(key: str, value: Any) -> Any:
    """`kdsPrintHost` / `kdsPrintPrinter`: empty, or an id (lower-case)."""
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return ""
    try:
        return str(uuid.UUID(text))
    except ValueError as exc:
        raise KdsPrintValueError(f"{key}: not an id") from exc


# ── The device ───────────────────────────────────────────────────────────────


def platform_of(machine: POSMachine) -> str:
    from app.services.display_devices import platform_of as _platform

    return _platform(machine)


def device_kind(machine: POSMachine) -> str:
    """For the how-to: `ipad` / `android_browser` / `windows_browser` / `browser`, or `android_app` / `windows_app`."""
    platform = platform_of(machine)
    if platform == "android":
        return "android_app"
    if platform == "windows":
        return "windows_app"
    info = getattr(machine, "device_info", None) or {}
    os_name = str(info.get("os") or "").lower() if isinstance(info, dict) else ""
    if os_name in ("ipados", "ios"):
        return "ipad"
    if os_name == "android":
        return "android_browser"
    if os_name == "windows":
        return "windows_browser"
    return "browser"


def device_path(machine: POSMachine) -> str:
    """What `device` means on this device: the bridge in a browser, the app's own printer in an app."""
    return PATH_BRIDGE if platform_of(machine) == "web" else PATH_APP


@dataclass
class Config:
    path: str = PATH_DEVICE
    host_id: Optional[str] = None
    printer_id: Optional[str] = None
    #: The path on this device (`device` resolved).
    effective: str = PATH_BRIDGE


def config_of(machine: POSMachine, params: Dict[str, Any]) -> Config:
    path = params.get(PATH_KEY)
    path = path if path in PATH_OPTIONS else PATH_DEVICE

    def an_id(key: str) -> Optional[str]:
        try:
            return clean_value(key, params.get(key)) or None
        except KdsPrintValueError:
            return None

    return Config(
        path=path, host_id=an_id(HOST_KEY), printer_id=an_id(PRINTER_KEY),
        effective=device_path(machine) if path == PATH_DEVICE else path,
    )


def config_for(db: Session, machine: POSMachine) -> Config:
    from app.services.till_parameters import till_parameters_for_machine

    return config_of(machine, till_parameters_for_machine(db, machine).parameters)


# ── Where it prints ──────────────────────────────────────────────────────────


@dataclass
class Target:
    """One place a screen's bon may print: a kitchen printer the relay serves, or a till's own printer."""

    key: str
    host: POSMachine
    connection: str
    name: str
    printer: Optional[Any] = None
    #: A till's own printer (no kitchen printer entry yet, or its "המדפסת המובנית — <קופה>" one).
    local: bool = False
    same_area: bool = False
    print_server: bool = False
    online: bool = False
    allowed: bool = True

    def out(self) -> Dict[str, Any]:
        from app.services import printers as K

        return {
            "key": self.key,
            "printerId": str(self.printer.id) if self.printer is not None else None,
            "printerName": self.printer.name if self.printer is not None else None,
            "name": self.name,
            "hostMachineId": str(self.host.id),
            "hostName": K.machine_label(self.host),
            "connection": self.connection,
            "local": self.local,
            "sameArea": self.same_area,
            "printServer": self.print_server,
            "online": self.online,
            "allowed": self.allowed,
        }


def screen_areas(db: Session, machine: POSMachine) -> List[str]:
    """The screen's points of sale: its own, and those its orders come from (SPEC_KDS §15)."""
    from app.services.display_devices import kds_device_of

    out: List[str] = []
    if getattr(machine, "area_id", None) is not None:
        out.append(str(machine.area_id))
    row = kds_device_of(db, machine)
    scope = getattr(row, "scope", None) if row is not None else None
    if isinstance(scope, dict):
        for area in scope.get("areaIds") or []:
            if str(area) not in out:
                out.append(str(area))
    return out


_CONNECTION_ORDER = {"till": 0, "usb": 1, "bluetooth": 2, "network": 3, "cloud": 4}


def targets(db: Session, machine: POSMachine) -> List[Target]:
    """Every place in the screen's shop a bon of it may print, the automatic choice's order first."""
    from app.models.shop import Shop
    from app.services import printers as K
    from app.services import remote_print as RP
    from app.services.printer_discovery import is_online

    if machine.shop_id is None:
        return []
    shop = db.get(Shop, machine.shop_id)
    if shop is None:
        return []
    settings = RP.settings_for(db, machine)
    areas = set(screen_areas(db, machine))
    # A browser prints nothing by itself (a screen / board / kiosk in a browser is never a host).
    machines = {str(m.id): m for m in K.shop_machines(db, shop.id) if platform_of(m) != "web"}
    server = K.print_host_of_shop(db, shop.id)
    found: Dict[str, Target] = {}

    def add(t: Target) -> None:
        t.same_area = bool(areas) and getattr(t.host, "area_id", None) is not None and str(t.host.area_id) in areas
        t.print_server = server is not None and str(server.id) == str(t.host.id)
        t.online = is_online(t.host)
        t.allowed = settings.may_reach(t.host.id)
        found.setdefault(t.key, t)

    printers = K.shop_printers(db, shop.id)
    by_id = {str(p.id): p for p in printers}
    for p in printers:
        if not p.is_active or not K.is_kitchen(p) or not in_scope(p, areas):
            continue
        host_id = K.relay_target(db, p)
        host = machines.get(str(host_id)) if host_id is not None else None
        if host is None or str(host.id) == str(machine.id):
            continue
        local = p.connection_type in K.HOSTED_TYPES and p.machine_id is not None and str(p.machine_id) == str(host.id)
        if p.machine_id is not None and not local:
            # Narrowed to one till: that till's printer, not the screen's.
            continue
        add(Target(
            key=f"printer:{p.id}", host=host, printer=p, local=local, name=p.name,
            connection=(p.host_connection or "till") if p.connection_type in K.HOSTED_TYPES else p.connection_type,
        ))
    for c in K.till_local_printers(db, shop):
        host = machines.get(c["machineId"])
        if host is None or str(host.id) == str(machine.id):
            continue
        if c.get("printerId") and f"printer:{c['printerId']}" in found:
            continue
        printer = by_id.get(c["printerId"]) if c.get("printerId") else None
        add(Target(
            key=f"local:{c['key']}", host=host, printer=printer, local=True, connection=c["connection"],
            name=f"{K.TILL_LOCAL_NAMES.get(c['connection'], c['connection'])} — {K.machine_label(host)}",
        ))

    def order(t: Target):
        return (
            not t.allowed, not t.same_area, not t.print_server, not t.online,
            _CONNECTION_ORDER.get(t.connection, 9), not t.local,
            int(t.host.pos_number) if str(t.host.pos_number or "").isdigit() else 10_000, t.name,
        )

    return sorted(found.values(), key=order)


def in_scope(printer: Any, areas: set) -> bool:
    """A printer narrowed to a point of sale is the screen's only when it is one of the screen's."""
    if printer.area_id is None:
        return True
    return str(printer.area_id) in areas


@dataclass
class Resolved:
    target: Optional[Target] = None
    #: Why nothing: `off` (another path), `remote_print_off`, `no_host`, `host_not_found`, `host_not_allowed`,
    #: `printer_not_found`, `printer_out_of_scope`.
    why: Optional[str] = None
    automatic: bool = True
    candidates: List[Target] = field(default_factory=list)


def resolve(db: Session, machine: POSMachine, config: Optional[Config] = None) -> Resolved:
    """Where the screen's next bon prints, or why nowhere."""
    from app.models.printers import KitchenPrinter
    from app.services import remote_print as RP

    config = config or config_for(db, machine)
    found = targets(db, machine)
    out = Resolved(candidates=found, automatic=config.host_id is None and config.printer_id is None)
    if config.effective != PATH_RELAY:
        out.why = "off"
        return out
    if not RP.settings_for(db, machine).enabled:
        out.why = "remote_print_off"
        return out
    if config.printer_id is not None:
        chosen = next((t for t in found if t.printer is not None and str(t.printer.id) == config.printer_id), None)
        if chosen is None:
            p = db.get(KitchenPrinter, uuid.UUID(config.printer_id))
            out.why = (
                "printer_out_of_scope"
                if p is not None and str(p.shop_id) == str(machine.shop_id) and p.is_active and not in_scope(p, set(screen_areas(db, machine)))
                else "printer_not_found"
            )
            return out
    elif config.host_id is not None:
        mine = [t for t in found if str(t.host.id) == config.host_id]
        if not mine:
            out.why = "host_not_found"
            return out
        # The host's own printer first (its head, then USB / Bluetooth), else a printer it hosts.
        chosen = sorted(mine, key=lambda t: (not t.local, _CONNECTION_ORDER.get(t.connection, 9)))[0]
    else:
        chosen = next((t for t in found if t.allowed), None)
        if chosen is None:
            out.why = "host_not_allowed" if found else "no_host"
            return out
    if not chosen.allowed:
        out.why = "host_not_allowed"
        out.target = chosen
        return out
    out.target = chosen
    return out


def ensure_printer(db: Session, machine: POSMachine, target: Target) -> Tuple[Any, bool]:
    """The kitchen printer entry behind `target` (a till's own printer gets one on first use). `(printer, made)`."""
    from app.models.shop import Shop
    from app.services import printers as K

    if target.printer is not None:
        if not target.printer.is_active:
            target.printer.is_active = True
            db.flush()
            return target.printer, True
        return target.printer, False
    shop = db.get(Shop, machine.shop_id)
    printer = K.ensure_till_local_printer(db, shop, target.host.id, target.connection)
    target.printer = printer
    return printer, True


# ── The status (the screen's and the dashboard's) ────────────────────────────


def status_of(db: Session, machine: POSMachine, config: Optional[Config] = None) -> Dict[str, Any]:
    """`GET /sync/{m}/kds/print`: the path, and for the relay where the next bon goes (or why nowhere)."""
    from app.services import printers as K
    from app.services import remote_print as RP

    config = config or config_for(db, machine)
    settings = RP.settings_for(db, machine)
    out: Dict[str, Any] = {
        "path": config.path,
        "effectivePath": config.effective,
        "devicePath": device_path(machine),
        "deviceKind": device_kind(machine),
        "platform": platform_of(machine),
        "timeoutSec": settings.timeout,
        "relay": None,
    }
    if config.effective != PATH_RELAY:
        return out
    r = resolve(db, machine, config)
    t = r.target
    out["relay"] = {
        "ready": r.why is None and t is not None,
        "why": r.why,
        "automatic": r.automatic,
        "hostMachineId": str(t.host.id) if t is not None else None,
        "hostName": K.machine_label(t.host) if t is not None else None,
        "hostOnline": t.online if t is not None else None,
        "printerId": str(t.printer.id) if t is not None and t.printer is not None else None,
        "printerName": t.name if t is not None else None,
        "connection": t.connection if t is not None else None,
    }
    return out


# ── The job ──────────────────────────────────────────────────────────────────


def _refused(code: str, status_code: int = status.HTTP_409_CONFLICT, **extra: Any) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, **extra})


def check_screen(db: Session, machine: POSMachine) -> Any:
    """A kitchen screen or a board (its `kds_devices` row), else 409 `not_a_screen`."""
    from app.services.display_devices import kds_device_of

    row = kds_device_of(db, machine)
    if row is None:
        raise _refused("not_a_screen")
    return row


def is_kds_job(job: Any) -> bool:
    payload = job.payload if isinstance(job.payload, dict) else {}
    return isinstance(payload.get(META_KEY), dict)


def ticket_out(payload: Any) -> Any:
    """The ticket as the host gets it: without what the cloud keeps beside it."""
    if isinstance(payload, dict) and META_KEY in payload:
        return {k: v for k, v in payload.items() if k != META_KEY}
    return payload


def test_ticket(machine: POSMachine, now: datetime, who: Optional[str] = None) -> Dict[str, Any]:
    from app.services import printers as K

    return {
        "source": "test",
        "tableName": None,
        "zoneName": None,
        "guests": None,
        "waiterName": who,
        "createdAt": now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "isAddition": False,
        "lines": [],
        "orderRef": None,
        "sourceName": K.machine_label(machine),
        "notice": TEST_NOTICE,
    }


def create_job(
    db: Session, machine: POSMachine, job_id: uuid.UUID, ticket: Optional[Dict[str, Any]], *,
    test: bool = False, user: Any = None,
) -> Tuple[Any, bool, bool]:
    """
    A bon (or a test) from the screen `machine`, by its path. Idempotent by `job_id`. `(job, created,
    printer_made)` — `printer_made`: a till's own printer got its entry now (its till must hear of it).
    409 `not_a_screen`, `kds_print_not_relay`, `remote_print_off`, `no_host`, `host_not_found`,
    `host_not_allowed`, `printer_not_found`, `printer_out_of_scope`; `print_job_id_taken`.
    """
    from app.models.printers import KitchenPrintJob
    from app.services import printers as K
    from app.services import remote_print as RP

    check_screen(db, machine)
    existing = db.query(KitchenPrintJob).filter(KitchenPrintJob.id == job_id).first()
    if existing is not None:
        if str(existing.source_machine_id) != str(machine.id) or not is_kds_job(existing):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="print_job_id_taken")
        return existing, False, False
    config = config_for(db, machine)
    if config.effective != PATH_RELAY:
        raise _refused("kds_print_not_relay", path=config.effective)
    r = resolve(db, machine, config)
    if r.why is not None or r.target is None:
        extra = {"host": K.machine_label(r.target.host)} if r.target is not None else {}
        raise _refused(r.why or "no_host", **extra)
    printer, made = ensure_printer(db, machine, r.target)
    now = K._now()
    who = None
    if user is not None:
        who = (getattr(user, "username", None) or getattr(user, "email", None) or "").strip() or None
    payload = dict(test_ticket(machine, now, who) if test else ticket)
    if payload.get("tableTerm") is None:
        payload.pop("tableTerm", None)
    if not payload.get("sourceName"):
        payload["sourceName"] = K.machine_label(machine)
    payload[META_KEY] = {
        "machineId": str(machine.id),
        "name": K.machine_label(machine),
        "hostName": K.machine_label(r.target.host),
        "automatic": r.automatic,
        "test": test,
    }
    settings = RP.settings_for(db, machine)
    job = KitchenPrintJob(
        id=job_id,
        tenant_id=printer.tenant_id,
        shop_id=printer.shop_id,
        printer_id=printer.id,
        printer_name=printer.name,
        kind="test" if test else "ticket",
        target_machine_id=r.target.host.id,
        source_machine_id=machine.id,
        created_by_user_id=getattr(user, "id", None),
        status="pending",
        payload=payload,
        created_at=now,
        expires_at=now + timedelta(seconds=settings.timeout),
    )
    db.add(job)
    db.flush()
    return job, True, made


def job_view(db: Session, job: Any) -> Dict[str, Any]:
    """The screen's view of its job: `job_out` and where it went."""
    from app.services import printers as K

    out = K.job_out(job, db=db)
    meta = (job.payload or {}).get(META_KEY) if isinstance(job.payload, dict) else None
    if out.get("targetMachineName") is None and isinstance(meta, dict):
        out["targetMachineName"] = meta.get("hostName")
    if out.get("targetMachineName") is None and job.target_machine_id is not None:
        out["targetMachineName"] = K.machine_label(db.get(POSMachine, job.target_machine_id))
    out["test"] = bool(isinstance(meta, dict) and meta.get("test"))
    return out


def recent_jobs(db: Session, machine: POSMachine, limit: int = 5) -> List[Dict[str, Any]]:
    from app.models.printers import KitchenPrintJob
    from app.services import printers as K

    rows = (
        db.query(KitchenPrintJob)
        .filter(KitchenPrintJob.source_machine_id == machine.id)
        .order_by(KitchenPrintJob.created_at.desc())
        .limit(limit)
        .all()
    )
    rows = [j for j in rows if is_kds_job(j)]
    K.expire_jobs(db, rows)
    db.flush()
    return [job_view(db, j) for j in rows]


# ── "לא הודפס" ───────────────────────────────────────────────────────────────


def unprinted(db: Session, job: Any, now: datetime) -> None:
    """A screen's bon failed or expired: "בון לא הודפס" (never for a test)."""
    if not is_kds_job(job) or job.kind != "ticket":
        return
    try:
        from app.services import bon_alerts

        bon_alerts.kds_unprinted(db, job, now)
    except Exception:  # noqa: BLE001 - an alert never fails the relay
        logger.exception("kds print: unprinted bon %s not recorded", job.id)


def printed(db: Session, job: Any, now: datetime) -> None:
    if not is_kds_job(job) or job.kind != "ticket":
        return
    try:
        from app.services import bon_alerts

        bon_alerts.kds_printed(db, job, now)
    except Exception:  # noqa: BLE001
        logger.exception("kds print: bon %s not resolved", job.id)


# ── The dashboard's card ─────────────────────────────────────────────────────


def own_values(db: Session, machine: POSMachine) -> Dict[str, Any]:
    """The values set for this screen itself (its till level); a key not set is absent."""
    from app.models.till_parameter import TillParameter, TillParameterValue

    rows = (
        db.query(TillParameter.key, TillParameterValue.value)
        .join(TillParameterValue, TillParameterValue.parameter_id == TillParameter.id)
        .filter(
            TillParameter.key.in_(list(KEYS)),
            TillParameterValue.scope_type == "machine",
            TillParameterValue.scope_id == machine.id,
        )
        .all()
    )
    return {key: value for key, value in rows}


def card(db: Session, machine: POSMachine) -> Dict[str, Any]:
    """`GET /kds/shops/{shop}/devices/{machine}/print`: the "הדפסה" card."""
    from app.services import printers as K
    from app.services import remote_print as RP

    config = config_for(db, machine)
    own = own_values(db, machine)
    settings = RP.settings_for(db, machine)
    r = resolve(db, machine, config)
    return {
        "machineId": str(machine.id),
        "machineName": K.machine_label(machine),
        "own": {
            "path": own.get(PATH_KEY),
            "hostMachineId": own.get(HOST_KEY) or None,
            "printerId": own.get(PRINTER_KEY) or None,
        },
        "effective": {"path": config.path, "hostMachineId": config.host_id, "printerId": config.printer_id},
        "status": status_of(db, machine, config),
        "targets": [t.out() for t in r.candidates],
        "remotePrint": {"enabled": settings.enabled, "timeoutSec": settings.timeout, "hostsLimited": bool(settings.hosts)},
        "recentJobs": recent_jobs(db, machine),
        "pathLabels": dict(PATH_LABELS),
    }


def save(db: Session, machine: POSMachine, path: Optional[str], host_id: Optional[str], printer_id: Optional[str]) -> None:
    """The screen's own values (its till level): null removes (inherits). 422 on a host / printer not of its shop."""
    from app.models.printers import KitchenPrinter
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services import printers as K
    from app.services.till_parameters import ensure_builtin_parameters

    if path is not None and path not in PATH_OPTIONS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_value:kdsPrintPath")
    try:
        host = clean_value(HOST_KEY, host_id)
        printer = clean_value(PRINTER_KEY, printer_id)
    except KdsPrintValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"invalid_value:{exc}") from exc
    if host:
        m = db.get(POSMachine, uuid.UUID(host))
        if m is None or str(m.shop_id) != str(machine.shop_id) or str(m.id) == str(machine.id):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="host_not_in_shop")
    if printer:
        p = db.get(KitchenPrinter, uuid.UUID(printer))
        if p is None or str(p.shop_id) != str(machine.shop_id) or not K.is_kitchen(p):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="printer_not_in_shop")
    ensure_builtin_parameters(db)
    params = {p.key: p for p in db.query(TillParameter).filter(TillParameter.key.in_(list(KEYS))).all()}
    now = datetime.now(timezone.utc)
    for key, value in ((PATH_KEY, path), (HOST_KEY, host or None), (PRINTER_KEY, printer or None)):
        parameter = params.get(key)
        if parameter is None:
            continue
        row = (
            db.query(TillParameterValue)
            .filter(
                TillParameterValue.parameter_id == parameter.id,
                TillParameterValue.scope_type == "machine",
                TillParameterValue.scope_id == machine.id,
            )
            .first()
        )
        if value is None:
            if row is not None:
                db.delete(row)
                parameter.updated_at = now
        elif row is None:
            db.add(TillParameterValue(id=uuid.uuid4(), parameter_id=parameter.id, scope_type="machine",
                                      scope_id=machine.id, value=value))
        else:
            row.value = value
            row.updated_at = now
    db.flush()


def screen_of_shop(db: Session, shop: Any, machine_id: Any) -> POSMachine:
    """A screen of the shop (its `kds_devices` row), else 404."""
    m = db.get(POSMachine, machine_id if isinstance(machine_id, uuid.UUID) else uuid.UUID(str(machine_id)))
    if m is None or str(m.shop_id) != str(shop.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    try:
        check_screen(db, m)
    except HTTPException:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not_a_screen")
    return m


def notify_hosts(db: Session, machine: POSMachine) -> List[Tuple[str, str]]:
    """The shop's tills, when a till's own printer got its entry: they pull the printers again."""
    from app.services import printers as K

    return K.shop_targets(db, machine.shop_id)
