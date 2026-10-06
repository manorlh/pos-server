"""
Device identity and cellular info, and the cloud's device search (the owner, 2026-10-06:
"אפשר בענן לבצע חיפוש מכשיר לפי סריאלי, קופה, סניף וכדומה").

* **Serial and its source** — the till reads its serial best effort (pos-android
  system/DeviceSerial.kt): the vendor SDK (Feitian ftpos on the F20 / 55F, SUNMI), else
  `Build.getSerial()`, else the `ro.serialno` property. It says which in `serial_source` at
  pairing (`device_info.serial_source`) and on every heartbeat (`serialSource`).
* **Cellular** — the heartbeat's `cellular` block (pos-android data/remote/CellularDtos.kt):
  the SIMs (carrier, MCC/MNC, network type, signal, data on, default data SIM, roaming, the
  phone number where the till may read it), the data path and the device's LAN address. Kept
  whole on the machine, with the carriers and phone numbers flattened into indexed columns.
* **IP** — the address the beat came from, as the cloud saw it (`Fly-Client-IP` at the edge,
  else the socket peer; X-Forwarded-For is spoofable and never read).
* **Search** — `GET /machines/search` (app/routers/machine_search.py): paginated, by serial,
  till number, name, shop / company / tenant, model, role, app version, last seen, IP, SIM
  carrier and phone number, scoped exactly like the machines list.
* **"אין אינטרנט — לעבור לסים 2?"** — a kiosk's staff alert (`terminal`, reason
  `no_internet_sim`): the line the tills show is composed here, the same as the till composes it
  (pos-android domain/Cellular.kt SimPromptText; shared fixture tests/fixtures/sim_prompt_texts.json).
* **`cellularFallback`** — the till parameter for the app's own cloud traffic over mobile data
  while the Wi-Fi has no internet (on by default).
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy import exists, false, func, or_
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.kiosk import KioskDevice
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.user import User, UserRole

#: Where a serial came from, as the till says it.
SERIAL_SOURCES = ("ftpos", "sunmi", "kozen", "build", "ro.serialno")

#: The till parameter (pos-android system/NetworkFallback.kt `PARAM_CELLULAR_FALLBACK`).
CELLULAR_FALLBACK_KEY = "cellularFallback"

CELLULAR_PARAMETER_SPECS = (
    dict(
        key=CELLULAR_FALLBACK_KEY,
        label="מעבר אוטומטי לנתונים ניידים כשאין אינטרנט ב-Wi-Fi",
        value_type="boolean",
        default_value=True,
        description=(
            "מופעל (ברירת מחדל): כשהקופה או הקיוסק מחוברים ל-Wi-Fi או לרשת קווית בלי אינטרנט ויש "
            "במכשיר סים עם נתונים ניידים, התקשורת של האפליקציה לענן עוברת אוטומטית לנתונים הניידים, "
            "ומוצג \"מחובר דרך נתונים ניידים\". הרשת המקומית — מסופון האשראי ברשת, הקופה הראשית "
            "והמדפסות — נשארת ב-Wi-Fi. כשהאינטרנט ב-Wi-Fi חוזר, התקשורת חוזרת אליו. האפליקציה לא "
            "משנה הגדרות מערכת ולא מחליפה את סים הנתונים בעצמה. כבוי — התקשורת לענן נשארת ב-Wi-Fi. "
            "ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
)

#: The kiosk alert for "אין אינטרנט — לעבור לסים 2?" (pos-android SimPromptRules).
SIM_PROMPT_KEY = "network:sim"
SIM_PROMPT_REASON = "no_internet_sim"

#: A machine is online within this long of its last beat (as the dashboard's light).
ONLINE_WINDOW = timedelta(minutes=5)

SEARCH_LIMIT_MAX = 100
#: The "last seen" filter's choices.
LAST_SEEN_CHOICES = ("online", "1h", "24h", "7d", "over7d", "never")
ROLE_CHOICES = ("till", "kiosk")

_SIMS_MAX = 4
_CARRIERS_MAX = 200
_PHONES_MAX = 200


def _str(value: Any, max_len: int) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:max_len] if text else None


def _bool(value: Any) -> Optional[bool]:
    return value if isinstance(value, bool) else None


def _int(value: Any, lo: int, hi: int) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if lo <= value <= hi else None


# ── Serial source ────────────────────────────────────────────────────────────


def normalize_serial_source(value: Any) -> Optional[str]:
    """One of `SERIAL_SOURCES`, or None (anything else is not a source the till names)."""
    text = _str(value, 32)
    if text is None:
        return None
    text = text.lower()
    return text if text in SERIAL_SOURCES else None


def serial_source_from_device_info(device_info: Any) -> Optional[str]:
    """`device_info.serial_source` at pairing — only beside a serial."""
    if not isinstance(device_info, dict) or not _str(device_info.get("serial"), 64):
        return None
    return normalize_serial_source(device_info.get("serial_source"))


# ── Phone numbers ────────────────────────────────────────────────────────────


def normalize_phone(value: Any) -> Optional[str]:
    """Digits, Israeli numbers in their local form: "+972 54-123-4567" → "0541234567"."""
    text = _str(value, 32)
    if text is None:
        return None
    digits = re.sub(r"\D", "", text)
    if digits.startswith("972") and len(digits) >= 11:
        digits = "0" + digits[3:]
    return digits[:20] if len(digits) >= 3 else None


# ── The heartbeat's cellular block ───────────────────────────────────────────


def clean_cellular(block: Any) -> Optional[Dict[str, Any]]:
    """
    The block as stored: known keys only, each typed and cut, SIMs at most four. Never raises:
    it rides on the heartbeat, which must never fail.
    """
    if hasattr(block, "model_dump"):
        block = block.model_dump(by_alias=True, exclude_none=True)
    if not isinstance(block, dict):
        return None
    sims: List[Dict[str, Any]] = []
    seen = set()
    for raw in (block.get("sims") if isinstance(block.get("sims"), list) else [])[:_SIMS_MAX]:
        if not isinstance(raw, dict):
            continue
        slot = _int(raw.get("slot"), 1, 8)
        if slot is None or slot in seen:
            continue
        seen.add(slot)
        sim = {
            "slot": slot,
            "carrier": _str(raw.get("carrier"), 40),
            "mccMnc": _str(raw.get("mccMnc"), 8),
            "network": _str(raw.get("network"), 40),
            "networkType": _str(raw.get("networkType"), 8),
            "signal": _int(raw.get("signal"), 0, 4),
            "inService": _bool(raw.get("inService")),
            "dataEnabled": _bool(raw.get("dataEnabled")),
            "defaultData": _bool(raw.get("defaultData")),
            "roaming": _bool(raw.get("roaming")),
            "phoneNumber": normalize_phone(raw.get("phoneNumber")),
        }
        sims.append({k: v for k, v in sim.items() if v is not None})
    out = {
        "sims": sims,
        "defaultDataSlot": _int(block.get("defaultDataSlot"), 1, 8),
        "transport": _str(block.get("transport"), 16),
        "validated": _bool(block.get("validated")),
        "viaCellular": _bool(block.get("viaCellular")),
        "lanIp": _str(block.get("lanIp"), 64),
        "phoneStatePermission": _bool(block.get("phoneStatePermission")),
        "phoneNumberPermission": _bool(block.get("phoneNumberPermission")),
    }
    return {k: v for k, v in out.items() if v is not None}


def carriers_of(cellular: Optional[Dict[str, Any]]) -> Optional[str]:
    """"פרטנר,סלקום" — the search column; null without a SIM."""
    names = []
    for sim in (cellular or {}).get("sims") or []:
        name = sim.get("carrier")
        if name and name not in names:
            names.append(name)
    return ",".join(names)[:_CARRIERS_MAX] or None


def phones_of(cellular: Optional[Dict[str, Any]]) -> Optional[str]:
    numbers = []
    for sim in (cellular or {}).get("sims") or []:
        number = sim.get("phoneNumber")
        if number and number not in numbers:
            numbers.append(number)
    return ",".join(numbers)[:_PHONES_MAX] or None


def client_ip(request: Any) -> Optional[str]:
    """The address a call came from: Fly's edge says so in Fly-Client-IP, else the socket peer."""
    if request is None:
        return None
    try:
        header = request.headers.get("fly-client-ip")
        peer = request.client.host if request.client else None
    except Exception:  # noqa: BLE001 - a stand-in request in a test, or none
        return None
    return _str(header or peer, 64)


def apply_heartbeat(machine: POSMachine, body: Any, request: Any = None, *, now: Optional[datetime] = None) -> None:
    """The beat's serial source, cellular block and address onto the machine. Never raises."""
    now = now or datetime.now(timezone.utc)
    ip = client_ip(request)
    if ip:
        machine.last_ip = ip
    if body is None:
        return
    source = normalize_serial_source(getattr(body, "serial_source", None))
    if source and getattr(body, "serial_number", None):
        machine.serial_source = source
    cellular = clean_cellular(getattr(body, "cellular", None))
    if cellular is not None:
        machine.cellular = cellular
        machine.cellular_reported_at = now
        machine.sim_carriers = carriers_of(cellular)
        machine.phone_numbers = phones_of(cellular)
        machine.lan_ip = cellular.get("lanIp")


def machine_fields(machine: POSMachine) -> Dict[str, Any]:
    """The machines list's and the machine page's identity fields."""
    return {
        "serialSource": getattr(machine, "serial_source", None),
        "cellular": getattr(machine, "cellular", None),
        "cellularReportedAt": getattr(machine, "cellular_reported_at", None),
        "lastIp": getattr(machine, "last_ip", None),
        "lanIp": getattr(machine, "lan_ip", None),
    }


# ── "אין אינטרנט — לעבור לסים 2?" ─────────────────────────────────────────────


def _sim(slot: Any, carrier: Any) -> str:
    name = _str(carrier, 40)
    return f"סים {slot}" + (f" ({name})" if name else "")


def sim_prompt_text(detail: Dict[str, Any]) -> str:
    """The line, from the kiosk alert's detail — the same as the till composes it."""
    d = detail if isinstance(detail, dict) else {}
    to = _int(d.get("toSlot"), 1, 8)
    if to is None:
        return "אין אינטרנט"
    to_carrier = d.get("toCarrier")
    if d.get("turnOnData") is True:
        return f"אין אינטרנט — הנתונים הניידים כבויים. להפעיל נתונים ב{_sim(to, to_carrier)}?"
    source = d.get("from")
    from_slot = _int(d.get("fromSlot"), 1, 8)
    from_carrier = _str(d.get("fromCarrier"), 40)
    if source == "sim":
        if from_slot is None:
            head = "אין אינטרנט בנתונים הניידים."
        elif from_carrier:
            head = f"אין אינטרנט ברשת {from_carrier} (סים {from_slot})."
        else:
            head = f"אין אינטרנט בסים {from_slot}."
    else:
        head = {
            "wifi": "אין אינטרנט ב-Wi-Fi.",
            "ethernet": "אין אינטרנט ברשת הקווית.",
            "other": "אין אינטרנט ברשת הנוכחית.",
        }.get(source, "אין אינטרנט.")
    if source == "sim" and from_slot is not None:
        ask = f"לעבור לנתונים של {_sim(to, to_carrier)}?"
    else:
        ask = f"לעבור לנתונים ניידים של {_sim(to, to_carrier)}?"
    return f"{head} {ask}"


# ── The search ───────────────────────────────────────────────────────────────


@dataclass
class SearchFilters:
    q: Optional[str] = None
    serial: Optional[str] = None
    pos_number: Optional[str] = None
    name: Optional[str] = None
    shop_id: Optional[uuid.UUID] = None
    company_id: Optional[uuid.UUID] = None
    tenant_id: Optional[uuid.UUID] = None
    model: Optional[str] = None
    role: Optional[str] = None
    app_version: Optional[str] = None
    last_seen: Optional[str] = None
    ip: Optional[str] = None
    carrier: Optional[str] = None
    phone: Optional[str] = None
    include_inactive: bool = False


def _like_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _contains(column, text: str):
    return func.lower(column).like(f"%{_like_escape(text.lower())}%", escape="\\")


def _prefix_upper(column, text: str):
    # upper(col) LIKE 'X%' — served by the `upper(serial_number) varchar_pattern_ops` index.
    return func.upper(column).like(f"{_like_escape(text.upper())}%", escape="\\")


def _scope(query, db: Session, user: User, active_tenant_id: Any, tenant_filter: Optional[uuid.UUID]):
    """Exactly the machines list's scope; a super admin may search every tenant."""
    from app.services.company_hierarchy import visible_shop_ids
    from app.services.permission_matrix import SHOP_SCOPED_ROLES

    if user.role == UserRole.SUPER_ADMIN:
        return query.filter(POSMachine.tenant_id == tenant_filter) if tenant_filter else query
    if tenant_filter is not None and active_tenant_id is not None and str(tenant_filter) != str(active_tenant_id):
        return None
    if user.role == UserRole.DISTRIBUTOR:
        return query.filter(
            POSMachine.distributor_id == user.id,
            or_(POSMachine.tenant_id == active_tenant_id, POSMachine.tenant_id.is_(None)),
        )
    query = query.filter(POSMachine.tenant_id == active_tenant_id)
    if user.role == UserRole.COMPANY_MANAGER:
        return query.filter(POSMachine.shop_id.in_(visible_shop_ids(db, user)))
    if user.role in SHOP_SCOPED_ROLES:
        return query.filter(POSMachine.shop_id == user.shop_id)
    return None


def _is_kiosk():
    return exists().where(KioskDevice.machine_id == POSMachine.id)


def search_query(db: Session, user: User, active_tenant_id: Any, f: SearchFilters, *, now: Optional[datetime] = None):
    """The search as a query of (machine, shop, company, tenant), or None when nothing is visible."""
    now = now or datetime.now(timezone.utc)
    query = (
        db.query(POSMachine, Shop, Company, Tenant)
        .outerjoin(Shop, Shop.id == POSMachine.shop_id)
        .outerjoin(Company, Company.id == Shop.company_id)
        .outerjoin(Tenant, Tenant.id == POSMachine.tenant_id)
    )
    query = _scope(query, db, user, active_tenant_id, f.tenant_id)
    if query is None:
        return None
    if not f.include_inactive:
        query = query.filter(POSMachine.is_active.is_(True))
    if f.serial:
        query = query.filter(_prefix_upper(POSMachine.serial_number, f.serial.strip()))
    if f.pos_number:
        query = query.filter(POSMachine.pos_number == f.pos_number.strip())
    if f.name:
        query = query.filter(_contains(POSMachine.name, f.name.strip()))
    if f.shop_id:
        query = query.filter(POSMachine.shop_id == f.shop_id)
    if f.company_id:
        query = query.filter(Shop.company_id == f.company_id)
    if f.model:
        query = query.filter(func.upper(POSMachine.device_model) == f.model.strip().upper())
    if f.role == "kiosk":
        query = query.filter(_is_kiosk())
    elif f.role == "till":
        query = query.filter(~_is_kiosk())
    if f.app_version:
        query = query.filter(POSMachine.app_version.like(f"{_like_escape(f.app_version.strip())}%", escape="\\"))
    if f.last_seen:
        seen = POSMachine.last_heartbeat_at
        windows = {"online": ONLINE_WINDOW, "1h": timedelta(hours=1), "24h": timedelta(hours=24), "7d": timedelta(days=7)}
        if f.last_seen in windows:
            query = query.filter(seen >= now - windows[f.last_seen])
        elif f.last_seen == "over7d":
            query = query.filter(seen < now - timedelta(days=7))
        elif f.last_seen == "never":
            query = query.filter(seen.is_(None))
    if f.ip:
        ip = _like_escape(f.ip.strip())
        query = query.filter(or_(POSMachine.last_ip.like(f"{ip}%", escape="\\"), POSMachine.lan_ip.like(f"{ip}%", escape="\\")))
    if f.carrier:
        query = query.filter(_contains(POSMachine.sim_carriers, f.carrier.strip()))
    if f.phone:
        phone = normalize_phone(f.phone)
        if phone is None:
            return query.filter(false())
        query = query.filter(POSMachine.phone_numbers.like(f"%{phone}%"))
    if f.q and f.q.strip():
        text = f.q.strip()
        terms = [
            _prefix_upper(POSMachine.serial_number, text),
            _contains(POSMachine.name, text),
            _contains(POSMachine.machine_code, text),
            POSMachine.pos_number == text,
            _contains(Shop.name, text),
            _contains(Company.name, text),
            _contains(Tenant.name, text),
            POSMachine.app_version.like(f"{_like_escape(text)}%", escape="\\"),
            POSMachine.last_ip.like(f"{_like_escape(text)}%", escape="\\"),
            POSMachine.lan_ip.like(f"{_like_escape(text)}%", escape="\\"),
            _contains(POSMachine.sim_carriers, text),
        ]
        phone = normalize_phone(text)
        if phone is not None and len(phone) >= 5:
            terms.append(POSMachine.phone_numbers.like(f"%{phone}%"))
        query = query.filter(or_(*terms))
    return query


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


def search_row(machine: POSMachine, shop: Optional[Shop], company: Optional[Company], tenant: Optional[Tenant],
               kiosk_ids: Iterable[Any], now: datetime) -> Dict[str, Any]:
    seen = machine.last_heartbeat_at
    if seen is not None and seen.tzinfo is None:
        seen = seen.replace(tzinfo=timezone.utc)
    cellular = machine.cellular or {}
    return {
        "id": str(machine.id),
        "name": machine.name,
        "machineCode": machine.machine_code,
        "posNumber": machine.pos_number,
        "tenantId": str(machine.tenant_id) if machine.tenant_id else None,
        "tenantName": tenant.name if tenant is not None else None,
        "companyId": str(company.id) if company is not None else None,
        "companyName": company.name if company is not None else None,
        "shopId": str(machine.shop_id) if machine.shop_id else None,
        "shopName": shop.name if shop is not None else None,
        "deviceModel": machine.device_model,
        "deviceRole": "kiosk" if machine.id in kiosk_ids else "till",
        "appVersion": machine.app_version,
        "lastHeartbeatAt": _iso(seen),
        "online": seen is not None and now - seen <= ONLINE_WINDOW,
        "isActive": bool(machine.is_active),
        "serialNumber": machine.serial_number,
        "serialSource": machine.serial_source,
        "lastIp": machine.last_ip,
        "lanIp": machine.lan_ip,
        "sims": [
            {k: s.get(k) for k in ("slot", "carrier", "networkType", "signal", "defaultData", "inService", "phoneNumber") if k in s}
            for s in cellular.get("sims") or []
        ],
        "viaCellular": bool(cellular.get("viaCellular")),
        "cellularReportedAt": _iso(machine.cellular_reported_at),
    }


def search(
    db: Session, user: User, active_tenant_id: Any, f: SearchFilters, *, skip: int = 0, limit: int = 50,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """`{items, total, skip, limit}` — newest seen first, then by name."""
    now = now or datetime.now(timezone.utc)
    limit = max(1, min(int(limit), SEARCH_LIMIT_MAX))
    skip = max(0, int(skip))
    query = search_query(db, user, active_tenant_id, f, now=now)
    if query is None:
        return {"items": [], "total": 0, "skip": skip, "limit": limit}
    total = query.count()
    rows = (
        query.order_by(POSMachine.last_heartbeat_at.desc().nullslast(), POSMachine.name.asc(), POSMachine.id.asc())
        .offset(skip)
        .limit(limit)
        .all()
    )
    ids = [m.id for m, *_ in rows]
    kiosk_ids = (
        {r[0] for r in db.query(KioskDevice.machine_id).filter(KioskDevice.machine_id.in_(ids)).all()} if ids else set()
    )
    return {
        "items": [search_row(m, s, c, t, kiosk_ids, now) for m, s, c, t in rows],
        "total": total,
        "skip": skip,
        "limit": limit,
    }
