"""
Prepaid voucher types ("סוגי שוברי הפקה", the spec's §2–3): the business template a batch is
issued from — what each voucher gives, its value at the till ("שווי בקופה") and its price to
the production ("מחיר מכירה להפקה"), how a redemption is priced (`fixed` / `cover`) and
booked (`redemption_accounting`: `discount` / `payment` / `zero`).

* **Every batch has a type** (§19.1). A batch issued from a type copies all of it, with the
  type's `version`; a later change of the type makes a new version and never touches vouchers
  already handed out. A batch made without naming a type gets one of its own (`origin`
  "batch"); a batch made before types got a `legacy` one when types arrived.
* **Who.** The catalog's writers who cover the type's company make and change types; a shop
  manager issues batches from the types of their shop's company. A type of a company may be
  used by its sub-companies.
* **The production price** is never printed and never reaches a till. The dashboard shows it —
  and lets it be set — only to a user with the `prepaid_voucher_prices` section (view / edit);
  the super admin and full access have it.
* **Audit.** Every change is in `prepaid_voucher_type_events` with who, when, and the fields
  before → after.
"""
from __future__ import annotations

import uuid
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, Dict, Iterable, List, Optional

from fastapi import status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.prepaid_voucher import (
    PrepaidVoucherBatch,
    PrepaidVoucherType,
    PrepaidVoucherTypeEvent,
    PrepaidVoucherTypeItem,
)
from app.models.user import User
from app.services import prepaid_voucher_rules as RULES

TYPE_NOT_FOUND = "prepaid_voucher_type_not_found"
TYPE_INACTIVE = "prepaid_voucher_type_inactive"
TYPE_CODE_TAKEN = "prepaid_voucher_type_code_taken"
TYPE_OTHER_COMPANY = "prepaid_voucher_type_other_company"
PRICES_FORBIDDEN = "prepaid_voucher_prices_forbidden"
OVERRIDE_FORBIDDEN = "prepaid_voucher_override_forbidden"
#: The dashboard section that shows (view) and sets (edit) the production price.
PRICES_SECTION = "prepaid_voucher_prices"
#: The dashboard section that sets a discount-block override policy (auto / manager) — the
#: till's approval is the till permission `VOUCHER_DISCOUNT_OVERRIDE` (app/services/till_permissions.py).
OVERRIDE_SECTION = "voucher_discount_override"

#: A type's terms — what a batch copies. A change of any of them is a new version.
TERM_FIELDS = (
    "kind", "till_value", "production_price", "pricing", "allow_top_up", "redemption_accounting",
    "show_validity",
    "split_allowed", "include_extras", "print_till_value", "discount_type", "discount_value",
    "min_purchase", "max_discount", "max_units", "targets", "stacking", "max_vouchers_per_sale", "promotion_policy",
    "uses_per_voucher", "max_uses_per_sale", "max_uses_per_day", "offline_allowed",
    # Groups (the production vouchers contract §1).
    "selection", "groups", "total_qty", "catalog_mode",
)
#: The discount-block policy's columns (from the schema's nested `discount_block_policy`).
POLICY_FIELDS = (
    "discount_block_policy", "override_max_amount", "override_max_percent", "override_max_total", "override_scope",
)
#: Money fields given in ₪ on the wire, stored in agorot.
_MONEY = ("till_value", "production_price", "min_purchase", "max_discount")


def _pv():
    from app.services import prepaid_vouchers as PV

    return PV


def _agorot(amount: Optional[Decimal]) -> Optional[int]:
    from app.schemas.prepaid_voucher import agorot

    return agorot(amount)


def _shekels_out(v: Optional[int]) -> Optional[float]:
    return None if v is None else round(int(v) / 100, 2)


# ── The production price: a section of its own ───────────────────────────────


def prices_visible(db: Session, user: User, level: str = "view") -> bool:
    """May [user] see (view) / set (edit) production prices — the `prepaid_voucher_prices` section."""
    from app.services.dashboard_access import effective_access

    try:
        return effective_access(db, user).allows(PRICES_SECTION, level)
    except Exception:  # noqa: BLE001 — no access model here: the role decides, as everywhere
        return True


def _require_prices(db: Session, user: User) -> None:
    if not prices_visible(db, user, "edit"):
        raise _pv()._http(status.HTTP_403_FORBIDDEN, PRICES_FORBIDDEN)


def override_editable(db: Session, user: User) -> bool:
    """May [user] set an override policy (auto / manager) — the `voucher_discount_override` section."""
    from app.services.dashboard_access import effective_access

    try:
        return effective_access(db, user).allows(OVERRIDE_SECTION, "edit")
    except Exception:  # noqa: BLE001
        return True


def policy_columns(db: Session, user: User, tenant_id, policy) -> Dict[str, Any]:
    """
    A `PrepaidOverridePolicyIn` (or None: honour) as the policy's columns — caps in agorot /
    basis points, the scope's ids checked to be the tenant's. Auto / manager need the
    `voucher_discount_override` section.
    """
    PV = _pv()
    if policy is None or policy.mode == "honour":
        return {"discount_block_policy": "honour", "override_max_amount": None, "override_max_percent": None,
                "override_max_total": None, "override_scope": None}
    if not override_editable(db, user):
        raise PV._http(status.HTTP_403_FORBIDDEN, OVERRIDE_FORBIDDEN)
    scope = None
    if policy.scope is not None:
        from app.models.category import Category
        from app.models.product import Product

        pids = [str(p) for p in policy.scope.product_ids]
        cids = [str(c) for c in policy.scope.category_ids]
        if pids:
            found = {str(i) for (i,) in db.query(Product.id).filter(
                Product.id.in_([PV._as_uuid(p) for p in pids]), Product.tenant_id == tenant_id)}
            if found != set(pids):
                raise PV._http(status.HTTP_400_BAD_REQUEST, PV.PRODUCT_INVALID)
        if cids:
            found = {str(i) for (i,) in db.query(Category.id).filter(
                Category.id.in_([PV._as_uuid(c) for c in cids]), Category.tenant_id == tenant_id)}
            if found != set(cids):
                raise PV._http(status.HTTP_400_BAD_REQUEST, PV.TARGET_INVALID)
        scope = {"productIds": pids, "categoryIds": cids}
    return {
        "discount_block_policy": policy.mode,
        "override_max_amount": _agorot(policy.max_amount),
        "override_max_percent": _agorot(policy.max_percent),  # % × 100 = basis points
        "override_max_total": _agorot(policy.max_total),
        "override_scope": scope,
    }


def policy_out(row, *, agorot: bool = False) -> Dict[str, Any]:
    """The policy as the dashboard (₪, %) or a till (agorot, basis points) reads it."""
    def money(v):
        return v if agorot else _shekels_out(v)

    mode = getattr(row, "discount_block_policy", None) or "honour"
    pct = getattr(row, "override_max_percent", None)
    scope = getattr(row, "override_scope", None)
    out = {
        "mode": mode,
        ("maxAmountAgorot" if agorot else "maxAmount"): money(getattr(row, "override_max_amount", None)),
        ("maxPercentBp" if agorot else "maxPercent"): pct if agorot else (None if pct is None else round(pct / 100, 2)),
        ("maxTotalAgorot" if agorot else "maxTotal"): money(getattr(row, "override_max_total", None)),
    }
    if agorot:
        out["scopeProductIds"] = None if scope is None else list(scope.get("productIds") or [])
        out["scopeCategoryIds"] = None if scope is None else list(scope.get("categoryIds") or [])
    else:
        out["scope"] = scope
    return out


# ── Scope ─────────────────────────────────────────────────────────────────────


def _company(db: Session, tenant_id, company_id) -> Company:
    PV = _pv()
    company = db.query(Company).filter(Company.id == PV._as_uuid(company_id)).first()
    if company is None or str(company.tenant_id) != str(tenant_id):
        raise PV._http(status.HTTP_404_NOT_FOUND, PV.COMPANY_NOT_FOUND)
    return company


def _may_read(db: Session, user: User, tenant_id, company_id) -> bool:
    """A type of a company: whoever covers it, or sees one of its shops (a shop manager)."""
    PV = _pv()
    if PV._covers_company(db, user, company_id):
        return True
    from app.models.shop import Shop

    visible = PV._visible_shop_ids(db, user, tenant_id)
    shops = {str(s) for (s,) in db.query(Shop.id).filter(Shop.company_id == PV._as_uuid(company_id))}
    return bool(visible & shops)


def get_type(db: Session, user: User, tenant_id, type_id) -> PrepaidVoucherType:
    PV = _pv()
    PV._require_role(user)
    wanted = PV._as_uuid(type_id)
    t = db.query(PrepaidVoucherType).filter(PrepaidVoucherType.id == wanted).first() if wanted else None
    if t is None or str(t.tenant_id) != str(tenant_id) or not _may_read(db, user, tenant_id, t.company_id):
        raise PV._http(status.HTTP_404_NOT_FOUND, TYPE_NOT_FOUND)
    return t


def _require_write(db: Session, user: User, company_id) -> None:
    PV = _pv()
    if not PV._covers_company(db, user, company_id):
        raise PV._http(status.HTTP_403_FORBIDDEN, PV.FORBIDDEN)


# ── Terms ─────────────────────────────────────────────────────────────────────


def stored_terms(body, *, fields: Iterable[str] = TERM_FIELDS) -> Dict[str, Any]:
    """A create body's terms (defaults included) in the stored units: agorot, basis points."""
    out: Dict[str, Any] = {}
    for f in fields:
        if not hasattr(body, f):
            continue
        v = getattr(body, f)
        if f in _MONEY or f == "discount_value":
            v = _agorot(v)  # ₪ → agorot; a percent → basis points (× 100 both)
        if f == "groups":
            from app.services import production_voucher_groups as PG

            v = PG.stored(v)
        out[f] = v
    return out


def _check_code(db: Session, t: PrepaidVoucherType, code: Optional[str]) -> None:
    if not code:
        return
    PV = _pv()
    clash = (
        db.query(PrepaidVoucherType.id)
        .filter(
            PrepaidVoucherType.tenant_id == t.tenant_id,
            PrepaidVoucherType.company_id == t.company_id,
            func.upper(PrepaidVoucherType.code) == code.upper(),
            PrepaidVoucherType.active.is_(True),
            PrepaidVoucherType.id != t.id,
        )
        .first()
    )
    if clash:
        raise PV._http(status.HTTP_409_CONFLICT, TYPE_CODE_TAKEN)


def _set_items(db: Session, tenant_id, t: PrepaidVoucherType, items, products) -> None:
    from app.services.prepaid_vouchers import DEFAULT_WEIGHT_UNIT, qty

    if t.items:
        # The old goods go first: a product may come back in the new list (one row per product).
        t.items.clear()
        db.flush()
    t.items = [
        PrepaidVoucherTypeItem(
            id=uuid.uuid4(),
            product_id=p.id,
            product_name=p.name,
            quantity=qty(item.quantity),
            weighed=bool(p.is_weighed),
            unit_label=((p.unit_label or DEFAULT_WEIGHT_UNIT) if p.is_weighed else None),
            sort_order=n,
        )
        for n, (item, p) in enumerate(zip(items, products))
    ]


def _event(db: Session, t: PrepaidVoucherType, user: Optional[User], action: str, details=None) -> None:
    PV = _pv()
    db.add(PrepaidVoucherTypeEvent(
        id=uuid.uuid4(), tenant_id=t.tenant_id, type_id=t.id, action=action,
        user_id=getattr(user, "id", None), user_name=PV._user_name(user), details=details or None,
        created_at=PV._now(),
    ))


def _snapshot(t: PrepaidVoucherType) -> Dict[str, Any]:
    out = {f: getattr(t, f) for f in TERM_FIELDS + POLICY_FIELDS}
    out["items"] = [[str(i.product_id), str(i.quantity)] for i in t.items]
    return out


# ── Create / update ───────────────────────────────────────────────────────────


def create_type(db: Session, user: User, tenant_id, body, *, origin: str = "manual") -> PrepaidVoucherType:
    PV = _pv()
    PV._require_role(user)
    company = _company(db, tenant_id, body.company_id)
    _require_write(db, user, company.id)
    if getattr(body, "production_price", None) is not None:
        _require_prices(db, user)
    terms = stored_terms(body)
    kind = terms.get("kind") or "items"
    from app.services import production_voucher_groups as PG

    PG.validate(db, tenant_id, company.id, terms.get("groups"))
    products = PV._validate_products(db, tenant_id, company.id, body.items or [])
    targets = (
        PV._validate_targets(db, tenant_id, company.id, body.targets)
        if kind == "item_discount" and body.targets is not None else None
    )
    t = PrepaidVoucherType(
        id=uuid.uuid4(), tenant_id=tenant_id, company_id=company.id, code=body.code, name=body.name,
        description=getattr(body, "description", None), origin=origin, active=bool(getattr(body, "active", True)),
        version=1, created_by=user.id, created_at=PV._now(), updated_at=PV._now(),
    )
    for f, v in terms.items():
        setattr(t, f, v)
    t.targets = targets
    if kind in RULES.DISCOUNT_KINDS:
        t.uses_per_voucher = int(body.uses_per_voucher or 1)
        t.max_uses_per_sale = int(body.max_uses_per_sale or 1)
        t.max_uses_per_day = body.max_uses_per_day
    for f, v in policy_columns(db, user, tenant_id, getattr(body, "discount_block_policy", None)).items():
        setattr(t, f, v)
    _check_code(db, t, t.code)
    _set_items(db, tenant_id, t, body.items or [], products)
    db.add(t)
    db.flush()
    _event(db, t, user, "create", {"version": 1, "after": _snapshot(t)})
    db.flush()
    return t


def update_type(db: Session, user: User, tenant_id, type_id, body) -> PrepaidVoucherType:
    """Name, code, description, active — in place; terms or goods — a new version (see the schema)."""
    from app.schemas.prepaid_voucher import _check_prices, _check_terms

    PV = _pv()
    t = get_type(db, user, tenant_id, type_id)
    _require_write(db, user, t.company_id)
    given = body.model_fields_set
    if "production_price" in given:
        _require_prices(db, user)
    before = _snapshot(t)
    plain = {f: getattr(body, f) for f in ("name", "code", "description", "active") if f in given}
    if "name" in plain and not plain["name"]:
        plain.pop("name")
    for f, v in plain.items():
        setattr(t, f, v)
    if "code" in plain:
        _check_code(db, t, t.code)

    # The terms, checked as a whole: what was sent over what the type says.
    merged = SimpleNamespace(**{f: getattr(t, f) for f in TERM_FIELDS})
    for f in ("till_value", "production_price", "min_purchase", "max_discount", "discount_value"):
        setattr(merged, f, None if getattr(merged, f) is None else Decimal(getattr(merged, f)) / 100)
    sent = {f: getattr(body, f) for f in TERM_FIELDS if f in given and f != "kind"}
    for f, v in sent.items():
        setattr(merged, f, v)
    merged.items = body.items if body.items is not None else [
        SimpleNamespace(product_id=i.product_id, quantity=i.quantity) for i in t.items
    ]
    merged.targets = body.targets if "targets" in given else (
        SimpleNamespace(product_ids=[uuid.UUID(p) for p in (t.targets or {}).get("productIds", [])],
                        category_ids=[uuid.UUID(c) for c in (t.targets or {}).get("categoryIds", [])])
        if t.targets else None
    )
    try:
        _check_terms(merged)
        _check_prices(merged, one_off=False)
    except ValueError as exc:
        raise PV._http(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
    products = PV._validate_products(db, tenant_id, t.company_id, merged.items) if t.kind not in RULES.DISCOUNT_KINDS else []
    targets = (
        PV._validate_targets(db, tenant_id, t.company_id, merged.targets)
        if t.kind == "item_discount" and merged.targets is not None else None
    )
    from app.services import production_voucher_groups as PG

    for f in TERM_FIELDS:
        if f in ("kind", "targets"):
            continue
        v = getattr(merged, f)
        if f in _MONEY or f == "discount_value":
            v = _agorot(v)
        if f == "groups":
            v = PG.stored(v)
            PG.validate(db, tenant_id, t.company_id, v)
        setattr(t, f, v)
    t.targets = targets
    if "discount_block_policy" in given:
        for f, v in policy_columns(db, user, tenant_id, body.discount_block_policy).items():
            setattr(t, f, v)
    if body.items is not None or t.kind in RULES.DISCOUNT_KINDS:
        _set_items(db, tenant_id, t, merged.items if t.kind not in RULES.DISCOUNT_KINDS else [], products)
    db.flush()
    after = _snapshot(t)
    changed_terms = sorted(k for k in after if before.get(k) != after.get(k))
    changed = sorted(set(changed_terms) | {k for k in plain if before.get(k, None) != plain[k]})
    if changed_terms:
        t.version = int(t.version or 1) + 1
    t.updated_at = PV._now()
    if changed or plain:
        action = "update"
        if "active" in plain and len(plain) == 1 and not changed_terms:
            action = "activate" if plain["active"] else "deactivate"
        _event(db, t, user, action, {
            "fields": sorted(set(changed_terms) | set(plain)), "version": t.version,
            "before": {k: before.get(k) for k in changed_terms}, "after": {k: after.get(k) for k in changed_terms},
        })
    db.flush()
    return t


# ── Batches from a type ───────────────────────────────────────────────────────


def type_for_batch(db: Session, user: User, tenant_id, type_id, company_id) -> PrepaidVoucherType:
    """The type a new batch of [company_id] names: active, of that company or a parent of it."""
    PV = _pv()
    t = get_type(db, user, tenant_id, type_id)
    if not t.active:
        raise PV._http(status.HTTP_409_CONFLICT, TYPE_INACTIVE)
    if str(company_id) not in PV._company_group(db, t.company_id):
        raise PV._http(status.HTTP_400_BAD_REQUEST, TYPE_OTHER_COMPANY)
    return t


def terms_from_type(t: PrepaidVoucherType) -> SimpleNamespace:
    """A type's terms as a batch's create body reads them (items as product / quantity)."""
    ns = SimpleNamespace(**{f: getattr(t, f) for f in TERM_FIELDS})
    ns.items = [SimpleNamespace(product_id=i.product_id, quantity=i.quantity) for i in t.items]
    return ns


def one_off_type(
    db: Session, user: User, tenant_id, company_id, name: str, terms: Dict[str, Any], items, products, targets,
) -> PrepaidVoucherType:
    """The type of a batch that named none: its own terms, `origin` batch (§19.1: no voucher without a type)."""
    PV = _pv()
    t = PrepaidVoucherType(
        id=uuid.uuid4(), tenant_id=tenant_id, company_id=company_id, code=None, name=name, origin="batch",
        active=True, version=1, created_by=getattr(user, "id", None), created_at=PV._now(), updated_at=PV._now(),
    )
    for f, v in terms.items():
        if f in TERM_FIELDS or f in POLICY_FIELDS:
            setattr(t, f, v)
    t.targets = targets
    _set_items(db, tenant_id, t, items, products)
    db.add(t)
    db.flush()
    _event(db, t, user, "create", {"version": 1, "origin": "batch", "after": _snapshot(t)})
    return t


def copy_into(batch: PrepaidVoucherBatch, t: PrepaidVoucherType) -> None:
    """The type's identity on the batch — what a later change of the type never touches."""
    for f in POLICY_FIELDS:
        setattr(batch, f, getattr(t, f))
    batch.type_id = t.id
    batch.type_version = int(t.version or 1)
    batch.type_code = t.code
    batch.type_name = t.name if t.origin == "manual" else None


# ── Out ───────────────────────────────────────────────────────────────────────


def _batch_counts(db: Session, type_ids: List[uuid.UUID]) -> Dict[str, int]:
    if not type_ids:
        return {}
    rows = (
        db.query(PrepaidVoucherBatch.type_id, func.count(PrepaidVoucherBatch.id))
        .filter(PrepaidVoucherBatch.type_id.in_(type_ids))
        .group_by(PrepaidVoucherBatch.type_id)
        .all()
    )
    return {str(k): int(n) for k, n in rows}


def type_out(db: Session, user: User, t: PrepaidVoucherType, batch_count: Optional[int] = None) -> Dict[str, Any]:
    PV = _pv()
    see = prices_visible(db, user)
    company = db.query(Company.name).filter(Company.id == t.company_id).scalar()
    terms = PV.terms_out(t)
    return {
        "id": str(t.id),
        "companyId": str(t.company_id),
        "companyName": company,
        "code": t.code,
        "name": t.name,
        "description": t.description,
        "origin": t.origin,
        "active": bool(t.active),
        "version": int(t.version or 1),
        "items": [
            {
                "productId": str(i.product_id), "name": i.product_name, "quantity": PV.qty_out(i.quantity),
                "weighed": bool(i.weighed), "unitLabel": i.unit_label,
                "text": PV.item_text(i.quantity, i.product_name, i.unit_label, bool(i.weighed)),
            }
            for i in t.items
        ],
        "tillValue": _shekels_out(t.till_value),
        # Only to whoever has the prices section (never on paper, never to a till).
        "productionPrice": _shekels_out(t.production_price) if see else None,
        "pricesVisible": see,
        "pricing": t.pricing,
        "allowTopUp": bool(t.allow_top_up),
        "redemptionAccounting": t.redemption_accounting or "discount",
        "showValidity": t.show_validity is not False,
        "discountBlockPolicy": policy_out(t),
        "offlineAllowed": bool(t.offline_allowed),
        "splitAllowed": bool(t.split_allowed),
        "includeExtras": bool(t.include_extras),
        "printTillValue": bool(t.print_till_value),
        "batchCount": batch_count if batch_count is not None else _batch_counts(db, [t.id]).get(str(t.id), 0),
        "createdAt": PV._iso(t.created_at),
        "updatedAt": PV._iso(t.updated_at),
        **terms,
    }


def list_types(
    db: Session, user: User, tenant_id, *, company_id=None, include_inactive: bool = True,
    origins: Iterable[str] = ("manual",),
) -> List[Dict[str, Any]]:
    PV = _pv()
    PV._require_role(user)
    q = db.query(PrepaidVoucherType).filter(PrepaidVoucherType.tenant_id == tenant_id)
    if company_id:
        # The company's own types and its parents' (a parent's type serves its sub-companies).
        from app.services.company_hierarchy import ancestor_company_ids

        ids = {PV._as_uuid(company_id)} | {PV._as_uuid(c) for c in ancestor_company_ids(db, company_id)}
        q = q.filter(PrepaidVoucherType.company_id.in_([i for i in ids if i is not None]))
    origins = tuple(origins)
    if origins:
        q = q.filter(PrepaidVoucherType.origin.in_(origins))
    if not include_inactive:
        q = q.filter(PrepaidVoucherType.active.is_(True))
    rows = [t for t in q.order_by(PrepaidVoucherType.name).all() if _may_read(db, user, tenant_id, t.company_id)]
    counts = _batch_counts(db, [t.id for t in rows])
    return [type_out(db, user, t, counts.get(str(t.id), 0)) for t in rows]


def type_events(db: Session, user: User, tenant_id, type_id) -> List[Dict[str, Any]]:
    PV = _pv()
    t = get_type(db, user, tenant_id, type_id)
    rows = (
        db.query(PrepaidVoucherTypeEvent)
        .filter(PrepaidVoucherTypeEvent.type_id == t.id)
        .order_by(PrepaidVoucherTypeEvent.created_at.desc())
        .all()
    )
    see = prices_visible(db, user)

    def hide(d):
        if see or not isinstance(d, dict):
            return d
        return {k: ({kk: vv for kk, vv in v.items() if kk != "production_price"} if isinstance(v, dict) else v)
                for k, v in d.items()}

    return [
        {
            "id": str(e.id), "action": e.action, "userName": e.user_name, "createdAt": PV._iso(e.created_at),
            "details": hide(e.details),
        }
        for e in rows
    ]
