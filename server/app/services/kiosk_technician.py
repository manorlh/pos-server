"""
"בדיקות ומידע קיוסק" — the cloud's half of the kiosk technician screen
(docs/SPEC_KIOSK.md, "מסך טכנאי"; pos-android ui/kiosk/KioskTechnician.kt).

* **The code** — the till parameter `technicianCode` ("קוד טכנאי לקיוסק"), "1995" by default.
  Like every till parameter it is set only by a super admin (app/routers/till_parameters.py),
  per company, shop, point of sale or till. Its plain value never leaves the cloud: what a
  till pulls (`till_parameters_for_machine`) is `hash_for_machine` — PBKDF2-HMAC-SHA256,
  salted with the machine id — and the till compares the digits typed against that. A value
  is 4–8 digits (`clean_code`, on every write of a value).
* **Where the till stands** — `GET /sync/{m}/kiosk/technician` (app/routers/kiosk_technician.py):
  tenant, company, shop with its branch code, point of sale, the till's number, document
  prefix, role, its Z (independent / own / shop), and for a kiosk its name and the tills that
  control it. Read only, the machine's own token.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

#: The till parameter. Read by the kiosk only.
TECHNICIAN_CODE_KEY = "technicianCode"
DEFAULT_TECHNICIAN_CODE = "1995"

#: What the till gets instead of the code: "pbkdf2-sha256$<iterations>$<hex>". The salt is
#: `SALT_PREFIX + machine id` (the id as the till holds it: lower-case, with hyphens).
HASH_SCHEME = "pbkdf2-sha256"
HASH_ITERATIONS = 10_000
SALT_PREFIX = "r2m-kiosk-technician:"

_CODE_RE = re.compile(r"^[0-9]{4,8}$")
CODE_MESSAGE = "קוד טכנאי: ספרות בלבד, בין 4 ל-8."

TECHNICIAN_PARAMETER_SPECS = (
    dict(
        key=TECHNICIAN_CODE_KEY,
        label="קוד טכנאי לקיוסק",
        value_type="string",
        default_value=DEFAULT_TECHNICIAN_CODE,
        description=(
            "הקוד שפותח בקיוסק את מסך \"בדיקות ומידע קיוסק\" לטכנאי: 6 לחיצות מהירות בפינה השמאלית "
            "העליונה של מסך הלקוח, ואז הקוד. ספרות בלבד, 4–8 (ברירת מחדל 1995). אחרי 5 קודים "
            "שגויים המסך ננעל ל-5 דקות. הקוד לא נשלח לקיוסק כפי שהוא — רק גיבוב שלו (PBKDF2, "
            "מלוח במזהה הקופה). ניתן לקבוע לפי חברה, סניף, נקודת מכירה או קופה."
        ),
    ),
)


class TechnicianCodeError(ValueError):
    pass


def clean_code(value: Any) -> str:
    """A technician code as stored: digits only, 4–8 of them."""
    code = str(value).strip() if value is not None else ""
    if not _CODE_RE.match(code):
        raise TechnicianCodeError(CODE_MESSAGE)
    return code


@lru_cache(maxsize=4096)
def _derive(machine_id: str, code: str, iterations: int) -> str:
    salt = (SALT_PREFIX + machine_id).encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", code.encode("utf-8"), salt, iterations, dklen=32).hex()


def code_hash(machine_id: Any, code: Any, iterations: int = HASH_ITERATIONS) -> str:
    """`pbkdf2-sha256$10000$<hex>` for `code` on the till `machine_id` (pos-android KioskTechnicianCode)."""
    mid = str(machine_id).strip().lower()
    return f"{HASH_SCHEME}${iterations}${_derive(mid, str(code).strip(), iterations)}"


def hash_for_machine(machine: Any, parameters: Dict[str, Any]) -> Dict[str, Any]:
    """The till's parameters with its technician code replaced by the code's hash (in place)."""
    code = parameters.get(TECHNICIAN_CODE_KEY)
    if code is not None and getattr(machine, "id", None) is not None:
        parameters[TECHNICIAN_CODE_KEY] = code_hash(machine.id, code)
    return parameters


# ── Where the till stands ────────────────────────────────────────────────────


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _str(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def identity(db: Session, machine: Any, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Where `machine` stands, for the kiosk's technician screen. Read only; nothing secret."""
    from app.models.company import Company
    from app.models.pos_machine import POSMachine
    from app.models.shop import Shop
    from app.models.shop_area import ShopArea
    from app.models.tenant import Tenant
    from app.services import independent_till
    from app.services import kiosk_control

    tenant = db.get(Tenant, machine.tenant_id) if machine.tenant_id is not None else None
    shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
    company = db.get(Company, shop.company_id) if shop is not None and shop.company_id is not None else None
    area = db.get(ShopArea, machine.area_id) if getattr(machine, "area_id", None) is not None else None
    device = kiosk_control.get_device(db, machine.id)

    kiosk: Optional[Dict[str, Any]] = None
    if device is not None:
        wanted = [str(c) for c in (device.controller_machine_ids or [])]
        controllers: List[Dict[str, Any]] = []
        if wanted:
            rows = {
                str(m.id): m
                for m in db.query(POSMachine).filter(POSMachine.tenant_id == machine.tenant_id).all()
                if str(m.id) in wanted
            }
            for mid in wanted:
                m = rows.get(mid)
                if m is None:
                    continue
                controllers.append({
                    "id": str(m.id),
                    "name": _str(m.name),
                    "posNumber": _str(m.pos_number),
                    "active": bool(m.is_active),
                })
        kiosk = {"name": _str(device.name), "enabled": bool(device.enabled), "controllers": controllers}

    return {
        "serverTime": _iso(now or datetime.now(timezone.utc)),
        "tenant": {"id": str(tenant.id), "name": _str(tenant.name)} if tenant is not None else None,
        "company": (
            {"id": str(company.id), "name": _str(company.name), "number": company.company_number}
            if company is not None else None
        ),
        "shop": (
            {"id": str(shop.id), "name": _str(shop.name), "number": shop.shop_number, "branchCode": _str(shop.branch_id)}
            if shop is not None else None
        ),
        "area": {"id": str(area.id), "name": _str(area.name)} if area is not None else None,
        "machine": {
            "id": str(machine.id),
            "name": _str(machine.name),
            "posNumber": _str(machine.pos_number),
            "documentPrefix": _str(machine.effective_document_prefix),
            "role": "kiosk" if device is not None and device.enabled else "till",
            # "independent" | "own_z" | "shop_z" (app/services/independent_till.py).
            "zRole": independent_till.role_of(machine),
            "zMode": _str(getattr(machine, "z_mode", None)) or "cloud",
            "independentTill": independent_till.is_independent(machine),
        },
        "kiosk": kiosk,
    }
