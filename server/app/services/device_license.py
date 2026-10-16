"""
"סוג רישיון למכשיר" — what a till / kiosk device is licensed as (P:/specs/device-license-type.md).

The owner (16.10.2026): "זה מודול רישיוני — תבדוק שיש הקמת מכשיר ווינדוס קופה וקיוסק משולב, גם לאנדרואיד,
או רק קיוסק או רק קופה". Every fiscal device (a till or a kiosk, Android or Windows) carries one
`licenseProduct`:

* `till` — "קופה בלבד": only ever a till; no kiosk mode ("מצב עבודה" off whatever the gate says).
* `kiosk` — "קיוסק בלבד": only ever an enabled kiosk; never a till (not even a "disabled" kiosk, which
  works as a till), no till mode.
* `kiosk_till` — "משולב": a kiosk or a till, and the work-mode switch between them is on.

The other roles (KDS, the board, a customer display, a local server, a cash host) are not fiscal and
have no license product (`None`), exactly as they never count as a till license. The time license
("קבוע / זמני", app/services/licenses.py) is another axis and applies to every device as before.

* **Who sets it.** A super admin, or a distributor for their own devices — the same people as the gate
  `kioskTillModeEnabled` (`ADMIN_ROLES`): on the pairing code ("הוספת מכשיר", default by the role), then
  on the machine page. Every setting is kept in `pos_machines.license_product_history`.
* **Stored vs derived.** `license_product` NULL on a fiscal machine (a row the migration did not reach,
  or one made by a path that set none) is *derived* from today's state with the migration's own rule
  (`derive`) and is never enforced: only a stored product refuses anything, so such a machine behaves
  exactly as before.
* **Enforcement.** The role must fit the license (`fits`): every path that changes either checks it
  (`check_role`, `check_kiosk_disable`, `check_pairing`, `set_product`). The gate
  `kioskTillModeEnabled` a licensed device receives is the license's (`apply_to_parameters`), so even an
  app that does not know the field obeys.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import status
from sqlalchemy.orm import Session

from app.services.device_profile import DeviceProfileRefused

logger = logging.getLogger(__name__)

TILL = "till"
KIOSK = "kiosk"
KIOSK_TILL = "kiosk_till"
PRODUCTS = (TILL, KIOSK, KIOSK_TILL)

LABELS = {TILL: "קופה בלבד", KIOSK: "קיוסק בלבד", KIOSK_TILL: "משולב"}
SHORT_LABELS = {TILL: "קופה בלבד", KIOSK: "קיוסק בלבד", KIOSK_TILL: "משולב"}
ROLE_LABELS = {"till": "קופה", "kiosk": "קיוסק"}

#: The product a pairing code of each fiscal role gets when none was chosen.
DEFAULTS = {"till": TILL, "kiosk": KIOSK}
#: Which products each fiscal role fits.
FITS = {"till": (TILL, KIOSK_TILL), "kiosk": (KIOSK, KIOSK_TILL)}

#: Who may set it: the gate's people (app/services/kiosk_till_mode.py ADMIN_ROLES).
ADMIN_ROLES = ("super_admin", "distributor")

SOURCE_PAIRING = "pairing"
SOURCE_DASHBOARD = "dashboard"
#: The history kept per machine (oldest dropped first).
HISTORY_KEEP = 50

ADMIN_ONLY = "license_product_admin_only"
INVALID = "license_product_invalid"
NOT_APPLICABLE = "license_product_not_applicable"
ROLE_MISMATCH = "license_product_role_mismatch"
TILL_ONLY = "license_till_only"
KIOSK_ONLY = "license_kiosk_only"
KIOSK_ONLY_DISABLE = "license_kiosk_only_disable"
TILL_MODE_BY_LICENSE = "till_mode_by_license"

#: The device's refusal of a switch the license does not include (`tillMode.returnBlocked`).
BLOCKED_WIRE = "license"
BLOCKED_TEXT = "רישיון המכשיר אינו כולל מעבר בין קיוסק לקופה"

MESSAGES = {
    ADMIN_ONLY: "רק מנהל-על או מפיץ קובעים את סוג הרישיון של מכשיר.",
    INVALID: "סוג רישיון: till (קופה בלבד), kiosk (קיוסק בלבד) או kiosk_till (משולב).",
}

_UNSET = object()


class LicenseRefused(DeviceProfileRefused):
    """A refusal with a body (`detail`, Hebrew `message`, `licenseProduct`…), answered as is."""


# ── The values ────────────────────────────────────────────────────────────────


def parse(raw: Any) -> Optional[str]:
    """A product from the wire (trimmed, any case); None for anything else."""
    if not isinstance(raw, str):
        return None
    value = raw.strip().lower()
    return value if value in PRODUCTS else None


def label(product: Optional[str]) -> Optional[str]:
    return LABELS.get(product) if product else None


def short_label(product: Optional[str]) -> Optional[str]:
    return SHORT_LABELS.get(product) if product else None


def work_mode_allowed(product: Any, gate: bool) -> bool:
    """
    Whether "מצב עבודה: קיוסק / קופה" exists on the device (the devices' own rule, §7.2): `kiosk_till`
    yes, `till` / `kiosk` no — whatever the gate says; no product (or one not known) — the gate.
    """
    p = parse(product)
    if p == KIOSK_TILL:
        return True
    if p in (TILL, KIOSK):
        return False
    return bool(gate)


def gate_of(product: Optional[str]) -> Optional[bool]:
    """The gate `kioskTillModeEnabled` a device of this product gets; None: the parameter's own."""
    if product == KIOSK_TILL:
        return True
    if product in (TILL, KIOSK):
        return False
    return None


def derive(home: str, kiosk_enabled: Optional[bool], gate: bool) -> str:
    """
    The product today's state amounts to (the migration's rule, §6): a kiosk by role — `kiosk`, or
    `kiosk_till` when the gate is open or when it is disabled (a disabled kiosk works as a till); a till
    — `till`, or `kiosk_till` when the gate is open.
    """
    if home == "kiosk":
        if kiosk_enabled is False:
            return KIOSK_TILL
        return KIOSK_TILL if gate else KIOSK
    return KIOSK_TILL if gate else TILL


def fits(product: Optional[str], role: Optional[str], kiosk_enabled: Optional[bool] = True) -> bool:
    """Whether a device of `role` ("till" / "kiosk") may hold `product`. No product fits anything."""
    if product is None:
        return True
    allowed = FITS.get(role or "till")
    if allowed is None:
        return False
    if product not in allowed:
        return False
    if product == KIOSK and role == "kiosk" and kiosk_enabled is False:
        return False
    return True


def mismatch(product: Optional[str], role: Optional[str]) -> bool:
    """The devices' warning (§7.3): `kiosk` opened as a till, `till` opened as a kiosk."""
    return (product == KIOSK and role == "till") or (product == TILL and role == "kiosk")


# ── One machine ───────────────────────────────────────────────────────────────


def applies(machine: Any) -> bool:
    """A till or a kiosk (fiscal); never a display device, a local server or a cash host."""
    from app.services import display_devices as DD

    return machine is not None and DD.is_fiscal(machine)


def stored(machine: Any) -> Optional[str]:
    """The product set on the machine — the one enforced; None: none set (derived, never enforced)."""
    if not applies(machine):
        return None
    return parse(getattr(machine, "license_product", None))


def _kiosk_row(db: Optional[Session], machine: Any, device: Any = _UNSET) -> Any:
    if device is not _UNSET:
        return device
    if db is None:
        return None
    from app.models.kiosk import KioskDevice

    return db.get(KioskDevice, machine.id)


def role_facts(db: Optional[Session], machine: Any, device: Any = _UNSET) -> Tuple[str, Optional[bool]]:
    """("kiosk", enabled) for a kiosk by role, ("till", None) for a till (its kiosk-mode row included)."""
    row = _kiosk_row(db, machine, device)
    if row is not None and getattr(row, "home_role", None) is None:
        return "kiosk", bool(getattr(row, "enabled", True))
    return "till", None


def _gate_param(db: Session, machine: Any) -> bool:
    """`kioskTillModeEnabled` as the levels set it (a machine with no stored product: nothing overrides it)."""
    from app.services import kiosk_till_mode

    try:
        return bool(kiosk_till_mode.effective(db, machine)["enabled"])
    except Exception:  # noqa: BLE001 - a derived product never fails a page
        logger.exception("gate for %s failed", getattr(machine, "id", None))
        return False


def product_of(db: Optional[Session], machine: Any, device: Any = _UNSET) -> Optional[str]:
    """The machine's product: the stored one, else derived from today's state (§1); None for a non-fiscal one."""
    if not applies(machine):
        return None
    kept = stored(machine)
    if kept is not None:
        return kept
    home, enabled = role_facts(db, machine, device)
    gate = _gate_param(db, machine) if db is not None else False
    return derive(home, enabled, gate)


def history_of(machine: Any) -> List[Dict[str, Any]]:
    raw = getattr(machine, "license_product_history", None)
    return [e for e in raw if isinstance(e, dict)] if isinstance(raw, list) else []


def changed_at(machine: Any) -> Optional[datetime]:
    """When the stored product last changed (the parameters' watermark moves with it)."""
    entries = history_of(machine)
    if not entries:
        return None
    raw = entries[-1].get("at")
    if not isinstance(raw, str):
        return None
    try:
        at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


def machine_fields(db: Optional[Session], machine: Any, device: Any = _UNSET) -> Dict[str, Any]:
    """The machines list's and the machine page's license fields."""
    if not applies(machine):
        return {
            "licenseProduct": None, "licenseProductStored": None, "licenseProductLabel": None,
            "licenseProductHistory": [], "licenseMismatch": False,
        }
    row = _kiosk_row(db, machine, device)
    product = product_of(db, machine, row)
    role, enabled = role_facts(db, machine, row)
    kept = stored(machine)
    return {
        "licenseProduct": product,
        "licenseProductStored": kept,
        "licenseProductLabel": label(product),
        "licenseProductHistory": history_of(machine)[-10:],
        # A stored product the role no longer fits (e.g. a kiosk code whose conversion failed at pairing).
        "licenseMismatch": kept is not None and not fits(kept, role, enabled),
    }


# ── Refusals ──────────────────────────────────────────────────────────────────


def _name(machine: Any) -> str:
    from app.services.device_profile import _label

    return _label(machine) if machine is not None else "המכשיר"


def _refuse(code: str, machine: Any, message: str, status_code: int, product: Optional[str] = None) -> LicenseRefused:
    body: Dict[str, Any] = {"detail": code, "message": message}
    if machine is not None and getattr(machine, "id", None) is not None:
        body["machineId"] = str(machine.id)
    if product is not None:
        body["licenseProduct"] = product
    return LicenseRefused(status_code, body)


def mismatch_message(product: str, role: str, kiosk_enabled: Optional[bool] = True) -> str:
    if role == "till" and product == KIOSK:
        return (
            "רישיון \"קיוסק בלבד\" לא מתאים לקופה: המכשיר יוכל לעבוד רק כקיוסק. בחרו תפקיד קיוסק, "
            "או רישיון \"קופה בלבד\" / \"משולב\"."
        )
    if role == "kiosk" and product == TILL:
        return (
            "רישיון \"קופה בלבד\" לא מתאים לקיוסק: המכשיר יוכל לעבוד רק כקופה. בחרו תפקיד קופה, "
            "או רישיון \"קיוסק בלבד\" / \"משולב\"."
        )
    if role == "kiosk" and product == KIOSK and kiosk_enabled is False:
        return (
            "רישיון \"קיוסק בלבד\" לא מתאים לקיוסק כבוי: קיוסק כבוי עובד כקופה. הפעילו את הקיוסק קודם, "
            "או בחרו \"משולב\"."
        )
    return f"סוג הרישיון \"{LABELS.get(product, product)}\" לא מתאים לתפקיד המכשיר."


def not_applicable(role: Optional[str], machine: Any = None) -> LicenseRefused:
    from app.services import display_devices as DD

    labels = {
        DD.ROLE_KDS: "מסך מטבח (KDS)", DD.ROLE_ORDER_STATUS_BOARD: "מסך מוכן / לא מוכן",
        DD.ROLE_CUSTOMER_DISPLAY: "מסך לקוח", DD.ROLE_LOCAL_SERVER: "שרת מקומי", DD.ROLE_CASH_HOST: "שרת מזומן",
    }
    what = labels.get(role or "", "המכשיר")
    return _refuse(
        NOT_APPLICABLE, machine, f"סוג רישיון נקבע רק לקופה ולקיוסק — {what} אינו קופה.",
        status.HTTP_422_UNPROCESSABLE_ENTITY if machine is None else status.HTTP_409_CONFLICT,
    )


def may_set(user: Any, machine: Any = None) -> bool:
    """A super admin; a distributor for their own devices (any code they make is theirs)."""
    role = getattr(getattr(user, "role", None), "value", getattr(user, "role", None))
    if role == "super_admin":
        return True
    if role != "distributor":
        return False
    return machine is None or str(getattr(machine, "distributor_id", "")) == str(getattr(user, "id", ""))


def require_admin(user: Any, machine: Any = None) -> None:
    if not may_set(user, machine):
        raise _refuse(ADMIN_ONLY, machine, MESSAGES[ADMIN_ONLY], status.HTTP_403_FORBIDDEN)


def clean(raw: Any, machine: Any = None) -> str:
    """A product sent by the dashboard, or 422 `license_product_invalid`."""
    product = parse(raw)
    if product is None:
        raise _refuse(INVALID, machine, MESSAGES[INVALID], status.HTTP_422_UNPROCESSABLE_ENTITY)
    return product


def check_pairing(role: Optional[str], raw: Any) -> Optional[str]:
    """
    The product a pairing code of `role` stores: the one chosen, checked against the role (422), or the
    role's default; None for a role that is not a till / kiosk (422 if one was chosen for it).
    """
    from app.services import display_devices as DD

    fiscal_role = "kiosk" if role == "kiosk" else ("till" if DD.is_fiscal_role(role) else None)
    if fiscal_role is None:
        if raw is not None:
            raise not_applicable(role)
        return None
    if raw is None:
        return DEFAULTS[fiscal_role]
    product = clean(raw)
    if not fits(product, fiscal_role):
        raise _refuse(
            ROLE_MISMATCH, None, mismatch_message(product, fiscal_role),
            status.HTTP_422_UNPROCESSABLE_ENTITY, product,
        )
    return product


def for_code(pairing_code: Any) -> Optional[str]:
    """The product a device redeeming this code gets (a code from an older dashboard: the role's default)."""
    from app.services import display_devices as DD

    role = getattr(pairing_code, "device_role", None)
    if not DD.is_fiscal_role(role):
        return None
    fiscal_role = "kiosk" if role == "kiosk" else "till"
    product = parse(getattr(pairing_code, "license_product", None))
    if product is None or not fits(product, fiscal_role):
        return DEFAULTS[fiscal_role]
    return product


def check_role(machine: Any, role: str, *, product: Any = _UNSET, kiosk_enabled: Optional[bool] = True) -> None:
    """
    Refuse making the machine `role` ("till" / "kiosk") when its stored product does not include it
    (409 `license_till_only` / `license_kiosk_only`); with `product` — a product sent with the change —
    409 `license_product_role_mismatch` when the pair does not fit. A machine with no stored product: never.
    """
    explicit = product is not _UNSET
    target = product if explicit else stored(machine)
    if target is None or fits(target, role, kiosk_enabled):
        return
    if explicit:
        raise _refuse(ROLE_MISMATCH, machine, mismatch_message(target, role, kiosk_enabled), status.HTTP_409_CONFLICT, target)
    if role == "kiosk":
        raise _refuse(
            TILL_ONLY, machine,
            f"לא ניתן להפוך את {_name(machine)} לקיוסק: סוג הרישיון שלה \"{LABELS[TILL]}\". "
            "מנהל-על או מפיץ משנים את סוג הרישיון בעמוד המכשיר.",
            status.HTTP_409_CONFLICT, target,
        )
    raise _refuse(
        KIOSK_ONLY, machine,
        f"לא ניתן להחזיר את {_name(machine)} לקופה רגילה: סוג הרישיון שלו \"{LABELS[KIOSK]}\". "
        "מנהל-על או מפיץ משנים את סוג הרישיון בעמוד המכשיר.",
        status.HTTP_409_CONFLICT, target,
    )


def check_kiosk_disable(machine: Any, kiosk_name: Optional[str] = None) -> None:
    """A "קיוסק בלבד" kiosk is never switched off: a disabled kiosk works as a till (409)."""
    if stored(machine) != KIOSK:
        return
    name = (kiosk_name or "").strip() or _name(machine)
    raise _refuse(
        KIOSK_ONLY_DISABLE, machine,
        f"לא ניתן לכבות את הקיוסק {name}: קיוסק כבוי עובד כקופה, וסוג הרישיון שלו \"{LABELS[KIOSK]}\". "
        "כדי לעצור מכירות — \"נעילה למכירה\".",
        status.HTTP_409_CONFLICT, KIOSK,
    )


def check_gate_switch(machine: Any) -> None:
    """The kiosk page's gate switch: a licensed device's gate is its license's (409 `till_mode_by_license`)."""
    product = stored(machine)
    if product is None:
        return
    raise _refuse(
        TILL_MODE_BY_LICENSE, machine,
        f"מצב עבודה: קיוסק / קופה נקבע לפי סוג הרישיון של המכשיר (\"{LABELS[product]}\"). "
        f"כדי לאפשר מעבר בין קיוסק לקופה — רישיון \"{LABELS[KIOSK_TILL]}\", בעמוד המכשיר (מנהל-על או מפיץ).",
        status.HTTP_409_CONFLICT, product,
    )


def work_mode_refusal_message(machine: Any) -> Optional[str]:
    """The dashboard's `enter_till` / `return_kiosk` on a device whose license has no work mode."""
    product = stored(machine)
    if product in (TILL, KIOSK):
        return (
            f"מצב עבודה אינו זמין: סוג הרישיון של המכשיר \"{LABELS[product]}\". "
            f"מעבר בין קיוסק לקופה — ברישיון \"{LABELS[KIOSK_TILL]}\"."
        )
    return None


# ── Setting it ────────────────────────────────────────────────────────────────


def _now(now: Optional[datetime]) -> datetime:
    return now or datetime.now(timezone.utc)


def record(
    machine: Any, product: Optional[str], *, user: Any = None, source: str,
    now: Optional[datetime] = None, by_name: Optional[str] = None,
) -> bool:
    """
    Store `product` on the machine with a history entry `{at, from, to, by, byName, source}`. True when
    it changed (the same product again records nothing). The caller commits and notifies the device.
    """
    before = parse(getattr(machine, "license_product", None))
    if product == before:
        return False
    from app.services.kiosk_control import user_name

    entry = {
        "at": _now(now).isoformat(),
        "from": before,
        "to": product,
        "by": str(user.id) if getattr(user, "id", None) is not None else None,
        "byName": by_name or (user_name(user) if user is not None else None),
        "byRole": getattr(getattr(user, "role", None), "value", None) if user is not None else None,
        "source": source,
    }
    machine.license_product = product
    machine.license_product_history = (history_of(machine) + [entry])[-HISTORY_KEEP:]
    return True


def set_product(
    db: Session, machine: Any, raw: Any, user: Any, *, role: Optional[str] = None, now: Optional[datetime] = None,
) -> bool:
    """
    The machine page's "שינוי סוג רישיון": a super admin / the device's distributor (403), a till or a
    kiosk (409 `license_product_not_applicable`), a product its role fits — the role it has, or `role`
    when it changes in the same request (409 `license_product_role_mismatch`). True when it changed.
    The caller commits, then `notify(machine)`.
    """
    require_admin(user, machine)
    if not applies(machine):
        raise not_applicable(None, machine)
    product = clean(raw, machine)
    current, enabled = role_facts(db, machine)
    target = role or current
    if target != current:
        enabled = True  # a kiosk made now is enabled
    if not fits(product, target, enabled):
        raise _refuse(ROLE_MISMATCH, machine, mismatch_message(product, target, enabled), status.HTTP_409_CONFLICT, product)
    return record(machine, product, user=user, source=SOURCE_DASHBOARD, now=now)


def notify(machine: Any) -> None:
    """After the commit: the device's gate moved with its license — tell it to pull its parameters."""
    from app.services.kiosk_control import notify_device_lock

    notify_device_lock(machine)


def apply_to_parameters(machine: Any, parameters: Dict[str, Any]) -> None:
    """The gate `kioskTillModeEnabled` a licensed device receives is its license's (§3.2), in place."""
    from app.services.kiosk_till_mode import ENABLED_KEY

    gate = gate_of(stored(machine))
    if gate is not None:
        parameters[ENABLED_KEY] = gate


# ── The count, for billing (§8) ───────────────────────────────────────────────


def _zero() -> Dict[str, int]:
    return {TILL: 0, KIOSK: 0, KIOSK_TILL: 0, "total": 0}


def counts(db: Session, user: Any, tenant_id: Any, *, all_tenants: bool = False) -> Dict[str, Any]:
    """
    Active tills and kiosks per product, per organization, company and shop (and the ones in no shop):
    a super admin — the active organization, or every one with `all_tenants`; a distributor — their own
    devices in the active organization. Each machine counts by its product (stored, else derived).
    """
    from app.models.company import Company
    from app.models.kiosk import KioskDevice
    from app.models.pos_machine import POSMachine
    from app.models.shop import Shop
    from app.models.tenant import Tenant

    require_admin(user)
    query = db.query(POSMachine).filter(POSMachine.is_active.is_(True), POSMachine.is_fiscal.is_(True))
    role = getattr(getattr(user, "role", None), "value", None)
    if not (all_tenants and role == "super_admin"):
        query = query.filter(POSMachine.tenant_id == tenant_id)
    if role == "distributor":
        query = query.filter(POSMachine.distributor_id == user.id)
    machines = query.all()
    ids = [m.id for m in machines]
    rows = {d.machine_id: d for d in db.query(KioskDevice).filter(KioskDevice.machine_id.in_(ids)).all()} if ids else {}
    shop_ids = {m.shop_id for m in machines if m.shop_id is not None}
    shops = {s.id: s for s in db.query(Shop).filter(Shop.id.in_(shop_ids)).all()} if shop_ids else {}
    company_ids = {s.company_id for s in shops.values() if s.company_id is not None}
    companies = {c.id: c for c in db.query(Company).filter(Company.id.in_(company_ids)).all()} if company_ids else {}
    tenant_ids = {m.tenant_id for m in machines if m.tenant_id is not None}
    tenants = {t.id: t for t in db.query(Tenant).filter(Tenant.id.in_(tenant_ids)).all()} if tenant_ids else {}

    by_tenant: Dict[Any, Dict[str, int]] = {}
    by_company: Dict[Any, Dict[str, int]] = {}
    by_shop: Dict[Any, Dict[str, int]] = {}
    unassigned: Dict[Any, Dict[str, int]] = {}

    def add(bucket: Dict[Any, Dict[str, int]], key: Any, product: str) -> None:
        c = bucket.setdefault(key, _zero())
        c[product] += 1
        c["total"] += 1

    for m in machines:
        product = product_of(db, m, rows.get(m.id))
        if product is None:
            continue
        add(by_tenant, m.tenant_id, product)
        shop = shops.get(m.shop_id) if m.shop_id is not None else None
        if shop is None:
            add(unassigned, m.tenant_id, product)
            continue
        add(by_shop, shop.id, product)
        if shop.company_id is not None:
            add(by_company, shop.company_id, product)

    def name_of(entity: Any) -> Optional[str]:
        return getattr(entity, "name", None) if entity is not None else None

    def sid(value: Any) -> Optional[str]:
        return str(value) if value is not None else None

    return {
        "products": list(PRODUCTS),
        "labels": dict(LABELS),
        "tenants": sorted(
            ({"id": sid(t), "name": name_of(tenants.get(t)), "counts": c} for t, c in by_tenant.items()),
            key=lambda r: (r["name"] or "", r["id"] or ""),
        ),
        "companies": sorted(
            (
                {"id": sid(k), "name": name_of(companies.get(k)), "tenantId": sid(getattr(companies.get(k), "tenant_id", None)), "counts": c}
                for k, c in by_company.items()
            ),
            key=lambda r: (r["name"] or "", r["id"] or ""),
        ),
        "shops": sorted(
            (
                {
                    "id": sid(k), "name": name_of(shops.get(k)),
                    "companyId": sid(getattr(shops.get(k), "company_id", None)),
                    "tenantId": sid(getattr(shops.get(k), "tenant_id", None)),
                    "counts": c,
                }
                for k, c in by_shop.items()
            ),
            key=lambda r: (r["name"] or "", r["id"] or ""),
        ),
        "unassigned": [{"tenantId": sid(t), "counts": c} for t, c in unassigned.items()],
    }
