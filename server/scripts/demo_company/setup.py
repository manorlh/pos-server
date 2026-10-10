"""
The demo company, built the way the owner builds a customer in the dashboard: tenant,
company, branch, points of sale, menu, people, till parameters — and ten tills paired with
real pairing codes, each redeemed as a device redeems one.
"""
from __future__ import annotations

import secrets
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from . import plan as P
from .till import VirtualTill


def _israeli_check_digit(first8: str) -> str:
    from app.services.open_format.israeli_tax_id import israeli_9th_check_digit

    return str(israeli_9th_check_digit(first8))


def free_vat_number(db) -> str:
    """The first checksum-valid 51xxxxxxC not held by any company (as digits) nor named in any settings."""
    from sqlalchemy import text

    taken = set()
    for (raw,) in db.execute(text("select vat_number from companies where vat_number is not null")):
        digits = "".join(ch for ch in str(raw) if ch.isdigit())
        if digits:
            taken.add(digits.zfill(9))
    body = P.VAT_SEED_BODY
    for _ in range(1000):
        first8 = f"{P.VAT_PREFIX}{body:06d}"
        candidate = first8 + _israeli_check_digit(first8)
        in_settings = db.execute(
            text("select 1 from tenants where settings::text like :v union all "
                 "select 1 from companies where settings::text like :v union all "
                 "select 1 from shops where settings::text like :v limit 1"),
            {"v": f"%{candidate}%"},
        ).first()
        if candidate not in taken and in_settings is None:
            return candidate
        body += 1
    raise RuntimeError("no free ח.פ. candidate")


@dataclass
class World:
    tenant_id: str
    company_id: str
    shop_id: str
    vat_number: str
    areas: Dict[int, str] = field(default_factory=dict)         # bar index -> area id
    people: List[P.Person] = field(default_factory=list)
    tills: List[VirtualTill] = field(default_factory=list)
    default_user: Optional[dict] = None
    notes: List[str] = field(default_factory=list)

    def person(self, key: str) -> P.Person:
        return next(p for p in self.people if p.key == key)

    def bar_people(self, bar: int) -> List[P.Person]:
        return [p for p in self.people if p.bar == bar]

    def bar_tills(self, bar: int) -> List[VirtualTill]:
        return [t for t in self.tills if t.bar.index == bar]


def build(api, db_factory, vat_number: str, log) -> World:
    # 1. Tenant (the super admin's "לקוח חדש").
    tenant = api.admin("POST", "/tenants", {"name": P.TENANT_NAME, "slug": P.TENANT_SLUG, "timezone": P.TIMEZONE,
                                            "defaultCurrency": "ILS", "locale": "he-IL"})
    api.tenant_id = str(tenant["id"])
    log(f"tenant {tenant['id']} {tenant['name']}")
    api.admin("PATCH", f"/tenants/{api.tenant_id}/settings", {"globalTaxRate": P.GLOBAL_TAX_RATE})

    # 2. Company: עוסק מורשה with its ח.פ. and address.
    company = api.admin("POST", "/companies", {"name": P.COMPANY_NAME, "vatNumber": vat_number,
                                               "address": P.ADDRESS_STREET, "city": P.ADDRESS_CITY,
                                               "dealerType": P.DEALER_TYPE})
    company_id = str(company["id"])
    api.admin("PATCH", f"/companies/{company_id}/settings", {
        "globalTaxRate": P.GLOBAL_TAX_RATE,
        "businessInfo": {"companyAddressNumber": P.ADDRESS_NUMBER, "companyZip": P.ADDRESS_ZIP},
    })
    log(f"company {company_id} ח.פ. {vat_number} ({P.DEALER_TYPE})")

    # 3. Branch and its five points of sale.
    shop = api.admin("POST", "/shops", {"name": P.SHOP_NAME, "companyId": company_id, "branchId": P.BRANCH_CODE,
                                        "address": f"{P.ADDRESS_STREET} {P.ADDRESS_NUMBER}", "city": P.ADDRESS_CITY})
    shop_id = str(shop["id"])
    world = World(tenant_id=api.tenant_id, company_id=company_id, shop_id=shop_id, vat_number=vat_number)
    for bar in P.BARS:
        area = api.admin("POST", f"/shops/{shop_id}/areas", {"name": bar.name, "sortOrder": bar.index * 10})
        world.areas[bar.index] = str(area["id"])
    log(f"shop {shop_id} {P.SHOP_NAME}; areas {list(world.areas.values())}")

    # 4. Menu: the company's products, listed on its shops (shopScope company).
    n = 0
    for order, (key, cname, color, items) in enumerate(P.CATEGORIES, start=1):
        cat = api.admin("POST", "/categories", {"name": cname, "color": color, "sortOrder": order * 10,
                                                "companyId": company_id})
        for item in items:
            api.admin("POST", "/products", {"name": item.name, "price": str(item.price), "categoryId": str(cat["id"]),
                                            "companyId": company_id,
                                            "shopScope": {"mode": "company", "companyId": company_id}})
            n += 1
    log(f"menu: {len(P.CATEGORIES)} categories, {n} products")

    # 5. Roles: the till roles (permissions) and the attendance job titles (tip weights).
    till_roles = {r["builtinKey"]: r["id"] for r in api.admin("GET", f"/companies/{company_id}/till-roles")["roles"]
                  if r.get("builtinKey")}
    roles = api.admin("POST", "/attendance/roles/defaults")["roles"]
    att = {r["name"]: r["id"] for r in roles}
    if P.JOB_MANAGER not in att:
        created = api.admin("POST", "/attendance/roles", {"name": P.JOB_MANAGER, "tipWeight": 0})
        att[P.JOB_MANAGER] = created["id"]
    missing = [j for j in (P.JOB_BARTENDER, P.JOB_WAITER, P.JOB_SHIFT_MANAGER) if j not in att]
    if missing:
        raise RuntimeError(f"attendance roles missing: {missing} (have {list(att)})")

    # 6. People: each with a PIN of its own (hashed by the product; plaintext only in the codes file).
    used = {"1234"}
    world.people = P.people()
    for person in world.people:
        pin = None
        while pin is None or pin in used:
            pin = f"{secrets.randbelow(10**5):05d}"
        used.add(pin)
        person.pin = pin
        out = api.admin("POST", f"/shops/{shop_id}/pos-users", {
            "username": person.key, "firstName": person.first, "lastName": person.last,
            "workerNumber": person.worker_number, "role": person.pos_role,
            "tillRoleId": till_roles[P.TILL_ROLE_FOR_JOB[person.job]], "pin": pin})
        person.id = str(out["id"])
        api.admin("PUT", f"/attendance/employees/{person.id}/role", {"roleId": att[person.job]})
    log(f"people: {len(world.people)} (till roles {sorted(till_roles)}; attendance roles {sorted(att)})")

    # 7. Till parameters for the company: the card tip asked on the terminal, the receipt footer.
    params = {p["key"]: p for p in api.admin("GET", "/till-parameters")}
    for key, value in (("terminalTipPrompt", True), ("receipt.footer.line1", P.FOOTER_DEMO),
                       ("receipt.footer.line2", P.PHONE_TEXT)):
        if key not in params:
            raise RuntimeError(f"till parameter {key} is not defined on this server")
        api.admin("PUT", f"/till-parameters/{params[key]['id']}/values",
                  {"scopeType": "company", "scopeId": company_id, "value": value})

    # 8. Ten tills: a pairing code for the branch, redeemed as a device redeems it.
    for bar in P.BARS:
        ids = []
        for k in range(1, P.TILLS_PER_BAR + 1):
            code = api.admin("POST", "/pairing/generate", {"companyId": company_id, "shopId": shop_id,
                                                           "deviceRole": "till", "platform": "android"})
            name = f"{bar.name} · קופה {k}"
            paired = api.public("POST", "/pairing/validate", {
                "code": code["code"], "machine_name": name,
                "device_info": {"model": "VIRTUAL-DEMO", "manufacturer": "demo-seeder", "platform": "android",
                                "serial": f"DEMO-{api.tenant_id[:8]}-{bar.index}{k}",
                                "note": "virtual till of the demo company (no hardware)"}})
            till = VirtualTill(api, bar, k, str(paired["machineId"]), paired["accessToken"], name)
            world.tills.append(till)
            ids.append(till.id)
            # The card terminal: a Nayax pinpad on the LAN at an address no device answers on;
            # nothing on the server ever connects to it, and the virtual till simulates its replies.
            api.admin("PATCH", f"/machines/{till.id}/settings", {
                "paymentIntegration": "nayax_lan", "nayaxEnabled": True,
                "nayaxDeviceHost": P.pinpad_host(bar.index, k), "nayaxDevicePort": "8080",
                "expectedTerminalNumber": P.terminal_number(bar.index, k)})
        api.admin("PUT", f"/areas/{world.areas[bar.index]}/machines", {"machineIds": ids})
    for till in world.tills:
        till.learn()
        log(f"till {till.name}: id {till.id} pos {till.pos_number} prefix {till.prefix} vat {till.vat_rate} "
            f"products {len(till.products)}")

    # The product's own default user of every new shop (`default`, its documented PIN).
    db = db_factory()
    try:
        from app.models.pos_user import PosUser

        row = db.query(PosUser).filter(PosUser.shop_id == uuid.UUID(shop_id), PosUser.username == "default").first()
        world.default_user = {"id": str(row.id), "username": row.username} if row else None
    finally:
        db.close()
    return world
