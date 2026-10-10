"""
Promotions ("מבצעים", docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §1).

The cloud keeps the definitions and serves each till the ones that reach it; the till
computes them itself, offline, on every change to the basket (pos-android
`domain/Promotions.kt`). Nothing here prices a basket.

* **Where** — a promotion names companies, shops, areas and tills (`scopes`), the
  till parameters' levels; a company means its whole group. None: every till of the
  organization. A till gets the promotions whose scope holds its own id, its area's,
  its shop's, or its shop's company or any company above it.
* **When** — dates and weekdays and an hour window, evaluated by the till on its own
  clock; the cloud only leaves out what is paused or already over.
* **Who** — written by the catalog roles. Every scope entry must be one the writer may
  manage (`till_messages.resolve_target`), and only a super admin or distributor may
  write one for the whole organization. The list shows a promotion to anyone who can
  see a shop it reaches, with `canEdit` saying whether they may change it.
* **The till's pull** — `GET /sync/{machine_id}/promotions[?etag=…]`: the full set,
  with category ids already expanded to their sub-categories, and an ETag over exactly
  that payload; the same ETag back is `{"syncType": "unchanged"}`.
* **What the tills report** — each document carries its promotions
  (`transaction_promotions`) and each line its share (`promotion_discount`); the
  report below reads them.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.category import Category
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.promotion import Promotion, TransactionPromotion
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.transaction import Transaction
from app.models.user import User, UserRole
from app.schemas.promotion import (
    THRESHOLD_TYPES,
    PromotionIn,
    config_category_ids,
    config_groups,
    config_product_ids,
)
from app.services.company_hierarchy import ancestor_company_ids, descendant_company_ids
from app.services.permission_matrix import Action, Resource, roles_for
from app.services.till_parameters import scope_labels

#: `reason` on the Ably `settings` notify that makes a till pull its promotions now.
NOTIFY_REASON = "promotions_updated"

#: 4xx details.
NOT_FOUND = "promotion_not_found"
FORBIDDEN = "promotion_forbidden"
SCOPE_NOT_FOUND = "promotion_scope_not_found"
SCOPE_FORBIDDEN = "promotion_scope_forbidden"
WHOLE_ORG_FORBIDDEN = "promotion_whole_org_forbidden"
UNKNOWN_PRODUCT = "promotion_unknown_product"
UNKNOWN_CATEGORY = "promotion_unknown_category"

STATUSES = ("active", "scheduled", "ended", "paused")

#: Roles that may write promotions: the catalog's.
WRITE_ROLES = roles_for(Resource.CATALOG, Action.WRITE)
WHOLE_ORG_ROLES = (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR)

#: A promotion that ended is still sent for a day: the till's own date may lag the
#: cloud's, and a window that crosses midnight runs into the next day.
ENDED_GRACE = timedelta(days=1)

NotifyTarget = Tuple[str, str]


def _bad(detail: str, code: int = status.HTTP_400_BAD_REQUEST) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _as_uuid(value) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def tenant_today(db: Session, tenant_id) -> date:
    """Today in the tenant's zone — the dates a promotion is set in are the shops'."""
    from app.services.reports import _load_zoneinfo, resolve_report_timezone

    zone = _load_zoneinfo(resolve_report_timezone(db, tenant_id, None))
    return datetime.now(timezone.utc).astimezone(zone).date()


def promotion_status(promotion: Promotion, today: date) -> str:
    """paused / ended / scheduled / active, in that order. Hours are the till's business."""
    if promotion.is_paused:
        return "paused"
    if promotion.valid_to is not None and promotion.valid_to < today:
        return "ended"
    if promotion.valid_from is not None and promotion.valid_from > today:
        return "scheduled"
    return "active"


# ── Scope and permission ──────────────────────────────────────────────────────


def _require_writer(user: User) -> None:
    if user.role not in WRITE_ROLES:
        raise _bad(FORBIDDEN, status.HTTP_403_FORBIDDEN)


def _scope_entity(db: Session, user: User, tenant_id, level: str, target_id):
    """The entity a scope entry names when the user may manage it; 400/403 otherwise."""
    from app.services import till_messages as TM

    try:
        return TM.resolve_target(db, user, tenant_id, level, target_id)
    except HTTPException as refused:
        if refused.status_code == status.HTTP_404_NOT_FOUND:
            raise _bad(SCOPE_NOT_FOUND)
        raise _bad(SCOPE_FORBIDDEN, status.HTTP_403_FORBIDDEN)


def validate_scopes(db: Session, user: User, tenant_id, scopes) -> List[Dict[str, str]]:
    """The scope list as stored, every entry checked; [] (whole org) for admins only."""
    if not scopes:
        if user.role not in WHOLE_ORG_ROLES:
            raise _bad(WHOLE_ORG_FORBIDDEN, status.HTTP_403_FORBIDDEN)
        return []
    out = []
    for scope in scopes:
        _scope_entity(db, user, tenant_id, scope.type, scope.id)
        out.append({"type": scope.type, "id": str(scope.id)})
    return out


def _stored_scopes(promotion: Promotion) -> List[Dict[str, str]]:
    out = []
    for entry in promotion.scopes or []:
        if isinstance(entry, dict) and entry.get("type") and _as_uuid(entry.get("id")) is not None:
            out.append({"type": str(entry["type"]), "id": str(_as_uuid(entry["id"]))})
    return out


def may_edit(db: Session, user: User, tenant_id, promotion: Promotion) -> bool:
    if user.role not in WRITE_ROLES:
        return False
    scopes = _stored_scopes(promotion)
    if not scopes:
        return user.role in WHOLE_ORG_ROLES
    try:
        for entry in scopes:
            _scope_entity(db, user, tenant_id, entry["type"], entry["id"])
    except HTTPException:
        return False
    return True


@dataclass
class _Visibility:
    """What one user can see, read once for a whole list."""

    everything: bool
    shop_ids: Set[uuid.UUID] = field(default_factory=set)
    shop_companies: Set[uuid.UUID] = field(default_factory=set)


def _visibility(db: Session, user: User, tenant_id) -> _Visibility:
    from app.services.overview import _visible_shops_query

    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return _Visibility(everything=True)
    shops = _visible_shops_query(db, user, tenant_id)
    if shops is None:
        return _Visibility(everything=False)
    rows = shops.with_entities(Shop.id, Shop.company_id).all()
    return _Visibility(
        everything=False,
        shop_ids={r[0] for r in rows},
        shop_companies={r[1] for r in rows if r[1] is not None},
    )


def _reaches_visible(db: Session, vis: _Visibility, promotion: Promotion) -> bool:
    if vis.everything:
        return True
    scopes = _stored_scopes(promotion)
    if not scopes:
        return bool(vis.shop_ids)
    for entry in scopes:
        ident = _as_uuid(entry["id"])
        kind = entry["type"]
        if kind == "shop" and ident in vis.shop_ids:
            return True
        if kind == "area":
            row = db.query(ShopArea.shop_id).filter(ShopArea.id == ident).first()
            if row and row[0] in vis.shop_ids:
                return True
        if kind == "machine":
            row = db.query(POSMachine.shop_id).filter(POSMachine.id == ident).first()
            if row and row[0] in vis.shop_ids:
                return True
        if kind == "company" and vis.shop_companies & set(descendant_company_ids(db, ident)):
            return True
    return False


# ── References ────────────────────────────────────────────────────────────────


def _check_references(db: Session, tenant_id, config: Dict[str, Any]) -> None:
    """Every product and category a config names is this tenant's."""
    product_ids = [uuid.UUID(i) for i in config_product_ids(config)]
    if product_ids:
        found = {
            r[0]
            for r in db.query(Product.id)
            .filter(Product.id.in_(product_ids), Product.tenant_id == tenant_id)
            .all()
        }
        if len(found) != len(set(product_ids)):
            raise _bad(UNKNOWN_PRODUCT)
    category_ids = [uuid.UUID(i) for i in config_category_ids(config)]
    if category_ids:
        found = {
            r[0]
            for r in db.query(Category.id)
            .filter(Category.id.in_(category_ids), Category.tenant_id == tenant_id)
            .all()
        }
        if len(found) != len(set(category_ids)):
            raise _bad(UNKNOWN_CATEGORY)


# ── Writes ────────────────────────────────────────────────────────────────────


def get_promotion(db: Session, tenant_id, promotion_id) -> Promotion:
    ident = _as_uuid(promotion_id)
    row = (
        db.query(Promotion).filter(Promotion.id == ident, Promotion.tenant_id == tenant_id).first()
        if ident is not None
        else None
    )
    if row is None:
        raise _bad(NOT_FOUND, status.HTTP_404_NOT_FOUND)
    return row


def _apply(db: Session, user: User, tenant_id, promotion: Promotion, body: PromotionIn) -> None:
    _check_references(db, tenant_id, body.config)
    promotion.name = body.name
    promotion.description = body.description
    promotion.promo_type = body.type
    promotion.config = body.config
    promotion.scopes = validate_scopes(db, user, tenant_id, body.scopes)
    promotion.valid_from = body.valid_from
    promotion.valid_to = body.valid_to
    promotion.weekdays = body.weekdays
    promotion.start_time = body.start_time
    promotion.end_time = body.end_time
    promotion.max_applications = body.max_applications
    promotion.priority = body.priority
    promotion.is_paused = body.is_paused
    promotion.updated_at = datetime.now(timezone.utc)


def create_promotion(db: Session, user: User, tenant_id, body: PromotionIn) -> Promotion:
    _require_writer(user)
    promotion = Promotion(id=uuid.uuid4(), tenant_id=tenant_id, created_by=user.id)
    _apply(db, user, tenant_id, promotion, body)
    db.add(promotion)
    db.flush()
    return promotion


def _require_edit(db: Session, user: User, tenant_id, promotion: Promotion) -> None:
    _require_writer(user)
    if not may_edit(db, user, tenant_id, promotion):
        raise _bad(FORBIDDEN, status.HTTP_403_FORBIDDEN)


def update_promotion(db: Session, user: User, tenant_id, promotion: Promotion, body: PromotionIn) -> Promotion:
    _require_edit(db, user, tenant_id, promotion)
    _apply(db, user, tenant_id, promotion, body)
    db.flush()
    return promotion


def set_paused(db: Session, user: User, tenant_id, promotion: Promotion, paused: bool) -> Promotion:
    _require_edit(db, user, tenant_id, promotion)
    if promotion.is_paused != paused:
        promotion.is_paused = paused
        promotion.updated_at = datetime.now(timezone.utc)
        db.flush()
    return promotion


def duplicate_promotion(db: Session, user: User, tenant_id, promotion: Promotion, copy_suffix: str) -> Promotion:
    """A paused copy, named "<name> (עותק)", that the writer may then edit and start."""
    _require_edit(db, user, tenant_id, promotion)
    name = f"{promotion.name} {copy_suffix}".strip()[:120]
    copy = Promotion(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        created_by=user.id,
        name=name,
        description=promotion.description,
        promo_type=promotion.promo_type,
        config=json.loads(json.dumps(promotion.config)),
        scopes=_stored_scopes(promotion),
        valid_from=promotion.valid_from,
        valid_to=promotion.valid_to,
        weekdays=list(promotion.weekdays) if promotion.weekdays else None,
        start_time=promotion.start_time,
        end_time=promotion.end_time,
        max_applications=promotion.max_applications,
        priority=promotion.priority or 0,
        is_paused=True,
        # The announcement's settings, not its messages: a paused copy announces nothing.
        announcement={k: v for k, v in (promotion.announcement or {}).items() if k in ("enabled", "text", "endEnabled", "endText")} or None,
        updated_at=datetime.now(timezone.utc),
    )
    db.add(copy)
    db.flush()
    return copy


def delete_promotion(db: Session, user: User, tenant_id, promotion: Promotion) -> None:
    """The definition goes; documents keep its name and id (`transaction_promotions`)."""
    _require_edit(db, user, tenant_id, promotion)
    db.delete(promotion)
    db.flush()


# ── Reads ─────────────────────────────────────────────────────────────────────


def _labels(db: Session, promotions: Iterable[Promotion]):
    values = [
        SimpleNamespace(scope_type=entry["type"], scope_id=uuid.UUID(entry["id"]))
        for p in promotions
        for entry in _stored_scopes(p)
    ]
    return scope_labels(db, values) if values else {}


def _announcement_out(promotion: Promotion) -> Dict[str, Any]:
    from app.services.promotion_announcements import settings_out

    return settings_out(promotion)


def promotion_out(promotion: Promotion, today: date, labels, can_edit: bool) -> Dict[str, Any]:
    scopes = []
    for entry in _stored_scopes(promotion):
        label = labels.get((entry["type"], uuid.UUID(entry["id"])))
        scopes.append({
            "type": entry["type"],
            "id": entry["id"],
            "name": label.name if label else None,
            "context": label.context if label else None,
        })
    return {
        "id": str(promotion.id),
        "name": promotion.name,
        "description": promotion.description,
        "type": promotion.promo_type,
        "config": promotion.config,
        "scopes": scopes,
        "validFrom": promotion.valid_from.isoformat() if promotion.valid_from else None,
        "validTo": promotion.valid_to.isoformat() if promotion.valid_to else None,
        "weekdays": promotion.weekdays,
        "startTime": promotion.start_time,
        "endTime": promotion.end_time,
        "maxApplications": promotion.max_applications,
        "priority": promotion.priority or 0,
        "isPaused": bool(promotion.is_paused),
        "announcement": _announcement_out(promotion),
        "status": promotion_status(promotion, today),
        "canEdit": can_edit,
        "createdAt": promotion.created_at.isoformat() if promotion.created_at else None,
        "updatedAt": promotion.updated_at.isoformat() if promotion.updated_at else None,
    }


def one_out(db: Session, user: User, tenant_id, promotion: Promotion) -> Dict[str, Any]:
    return promotion_out(
        promotion, tenant_today(db, tenant_id), _labels(db, [promotion]),
        may_edit(db, user, tenant_id, promotion),
    )


def list_promotions(
    db: Session,
    user: User,
    tenant_id,
    *,
    search: Optional[str] = None,
    status_filter: Optional[str] = None,
) -> Dict[str, Any]:
    """Every promotion that reaches a shop the user can see, newest first."""
    vis = _visibility(db, user, tenant_id)
    query = db.query(Promotion).filter(Promotion.tenant_id == tenant_id)
    term = (search or "").strip()
    if term:
        query = query.filter(Promotion.name.ilike(f"%{term}%"))
    rows = [p for p in query.order_by(Promotion.created_at.desc()).all() if _reaches_visible(db, vis, p)]
    today = tenant_today(db, tenant_id)
    if status_filter in STATUSES:
        rows = [p for p in rows if promotion_status(p, today) == status_filter]
    labels = _labels(db, rows)
    items = [promotion_out(p, today, labels, may_edit(db, user, tenant_id, p)) for p in rows]
    counts = {s: 0 for s in STATUSES}
    for item in items:
        counts[item["status"]] += 1
    return {"items": items, "counts": counts, "canCreate": user.role in WRITE_ROLES}


# ── The till's pull ───────────────────────────────────────────────────────────


def _till_chain(db: Session, machine: POSMachine) -> Set[Tuple[str, str]]:
    chain: Set[Tuple[str, str]] = {("machine", str(machine.id))}
    if machine.area_id is not None:
        chain.add(("area", str(machine.area_id)))
    if machine.shop_id is not None:
        chain.add(("shop", str(machine.shop_id)))
        row = db.query(Shop.company_id).filter(Shop.id == machine.shop_id).first()
        company_id = row[0] if row else None
        if company_id is not None:
            chain.add(("company", str(company_id)))
            for ancestor in ancestor_company_ids(db, company_id):
                chain.add(("company", str(ancestor)))
    return chain


def reaches_till(promotion: Promotion, chain: Set[Tuple[str, str]]) -> bool:
    scopes = _stored_scopes(promotion)
    if not scopes:
        return True
    return any((entry["type"], entry["id"]) in chain for entry in scopes)


def _category_tree(db: Session, tenant_id) -> Dict[str, List[str]]:
    children: Dict[str, List[str]] = defaultdict(list)
    for cid, parent in db.query(Category.id, Category.parent_id).filter(Category.tenant_id == tenant_id).all():
        if parent is not None:
            children[str(parent)].append(str(cid))
    return children


def _with_descendants(ids: List[str], children: Dict[str, List[str]]) -> List[str]:
    out: List[str] = []
    stack = list(ids)
    while stack:
        current = stack.pop(0)
        if current in out:
            continue
        out.append(current)
        stack.extend(children.get(current, []))
    return out


def _expanded_config(config: Dict[str, Any], children: Dict[str, List[str]]) -> Dict[str, Any]:
    expanded = json.loads(json.dumps(config))
    for group in config_groups(expanded):
        group["categoryIds"] = _with_descendants(group.get("categoryIds", []), children)
        group["excludeCategoryIds"] = _with_descendants(group.get("excludeCategoryIds", []), children)
    return expanded


def till_promotion(promotion: Promotion, children: Dict[str, List[str]]) -> Dict[str, Any]:
    """One promotion as the till reads it (pos-android `PromotionDto`)."""
    max_apps = promotion.max_applications
    if max_apps is None and promotion.promo_type in THRESHOLD_TYPES:
        max_apps = 1
    return {
        "id": str(promotion.id),
        "name": promotion.name,
        "type": promotion.promo_type,
        "priority": promotion.priority or 0,
        "validFrom": promotion.valid_from.isoformat() if promotion.valid_from else None,
        "validTo": promotion.valid_to.isoformat() if promotion.valid_to else None,
        "weekdays": promotion.weekdays,
        "startTime": promotion.start_time,
        "endTime": promotion.end_time,
        "maxApplications": max_apps,
        "config": _expanded_config(promotion.config or {}, children),
    }


def promotions_for_machine(db: Session, machine: POSMachine) -> List[Dict[str, Any]]:
    """What this till runs: not paused, not over, and reaching it; priority first."""
    if machine.tenant_id is None:
        return []
    today = tenant_today(db, machine.tenant_id)
    rows = (
        db.query(Promotion)
        .filter(
            Promotion.tenant_id == machine.tenant_id,
            Promotion.is_paused.is_(False),
            or_(Promotion.valid_to.is_(None), Promotion.valid_to >= today - ENDED_GRACE),
        )
        .all()
    )
    chain = _till_chain(db, machine)
    children = _category_tree(db, machine.tenant_id)
    out = [till_promotion(p, children) for p in rows if reaches_till(p, chain)]
    out.sort(key=lambda p: (-p["priority"], p["name"], p["id"]))
    return out


def payload_etag(promotions: List[Dict[str, Any]]) -> str:
    raw = json.dumps(promotions, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def sync_response(db: Session, machine: POSMachine, etag: Optional[str]) -> Dict[str, Any]:
    promotions = promotions_for_machine(db, machine)
    current = payload_etag(promotions)
    now = datetime.now(timezone.utc).isoformat()
    if etag and etag == current:
        return {"syncType": "unchanged", "etag": current, "serverTime": now, "promotions": []}
    return {"syncType": "full", "etag": current, "serverTime": now, "promotions": promotions}


# ── Notify ────────────────────────────────────────────────────────────────────


def notify_targets(db: Session, tenant_id) -> List[NotifyTarget]:
    """Every active till of the tenant: a change can add or drop any of them."""
    return [
        (str(m.tenant_id), str(m.id))
        for m in db.query(POSMachine)
        .filter(POSMachine.tenant_id == tenant_id, POSMachine.is_active.is_(True))
        .all()
        if m.tenant_id
    ]


def publish_promotions_notify(targets: Iterable[NotifyTarget]) -> None:
    from app.services import ably_notify

    for tenant_id, machine_id in targets:
        try:
            ably_notify.publish_settings_notify(tenant_id, machine_id, reason=NOTIFY_REASON)
        except Exception:  # pragma: no cover - best effort, the till also pulls on sync
            pass


# ── Ingest ────────────────────────────────────────────────────────────────────


def replace_document_promotions(db: Session, transaction_id, promotions) -> None:
    """A re-push is the whole document: its promotions replace what was there."""
    db.query(TransactionPromotion).filter(
        TransactionPromotion.transaction_id == transaction_id
    ).delete(synchronize_session=False)
    rows = []
    for p in promotions or []:
        discount = Decimal(str(p.discount or 0))
        if discount < 0:
            discount = -discount
        rows.append(
            TransactionPromotion(
                id=uuid.uuid4(),
                transaction_id=transaction_id,
                promotion_id=_as_uuid(p.promotion_id),
                promotion_name=(p.name or None) and p.name[:120],
                promotion_type=(p.type or None) and p.type[:32],
                applications=max(1, int(p.applications or 1)),
                discount_amount=discount.quantize(Decimal("0.01")),
            )
        )
    if rows:
        db.bulk_save_objects(rows)


# ── Report ────────────────────────────────────────────────────────────────────


def _money(value: Decimal) -> float:
    return float(Decimal(value).quantize(Decimal("0.01")))


def build_promotions_report(
    db: Session,
    user: User,
    tenant_id,
    window,
    *,
    shop_id=None,
    machine_id=None,
    promotion_id=None,
) -> Dict[str, Any]:
    """
    How often each promotion applied and what it took off, over the window's sales,
    by promotion, shop, till and local day. Credit notes are left out: a return
    credits what was paid, and the promotion it was sold under stays given.
    """
    from app.services.reports import _is_refund_condition, _load_zoneinfo, build_scoped_transaction_query

    empty = {
        "window": window.to_schema().model_dump(by_alias=True, mode="json"),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "totals": {"applications": 0, "documents": 0, "discount": 0.0},
        "byPromotion": [], "byShop": [], "byTill": [], "byDay": [],
    }
    tx_q = build_scoped_transaction_query(
        db, user, tenant_id, window, shop_id=shop_id, machine_id=machine_id
    )
    if tx_q is None:
        return empty
    tx_ids = tx_q.filter(~_is_refund_condition()).with_entities(Transaction.id).subquery()
    query = (
        db.query(
            TransactionPromotion.promotion_id,
            TransactionPromotion.promotion_name,
            TransactionPromotion.promotion_type,
            TransactionPromotion.applications,
            TransactionPromotion.discount_amount,
            Transaction.id,
            Transaction.created_at,
            Transaction.shop_id,
            Transaction.machine_id,
        )
        .join(Transaction, Transaction.id == TransactionPromotion.transaction_id)
        .filter(TransactionPromotion.transaction_id.in_(db.query(tx_ids.c.id)))
    )
    wanted = _as_uuid(promotion_id)
    if wanted is not None:
        query = query.filter(TransactionPromotion.promotion_id == wanted)
    rows = query.all()

    zone = _load_zoneinfo(window.tz_name)

    def bucket():
        return {"applications": 0, "documents": set(), "discount": Decimal("0")}

    totals = bucket()
    by_promo: Dict[str, dict] = {}
    by_shop: Dict[Optional[str], dict] = {}
    by_till: Dict[Optional[str], dict] = {}
    by_day: Dict[str, dict] = {}
    names: Dict[str, Tuple[Optional[str], Optional[str]]] = {}

    for pid, name, ptype, apps, discount, tx_id, created_at, shop, till in rows:
        key = str(pid) if pid is not None else f"name:{name or ''}"
        names.setdefault(key, (name, ptype))
        if name:
            names[key] = (name, ptype or names[key][1])
        moment = created_at if created_at.tzinfo else created_at.replace(tzinfo=timezone.utc)
        # The window's day: its till's business day ("שעת סיום יום עסקי"), or the calendar's.
        day = (window.day_of(moment, till) if hasattr(window, "day_of") else moment.astimezone(zone).date()).isoformat()
        targets = [
            totals,
            by_promo.setdefault(key, bucket()),
            by_shop.setdefault(str(shop) if shop else None, bucket()),
            by_till.setdefault(str(till) if till else None, bucket()),
            by_day.setdefault(day, bucket()),
        ]
        for b in targets:
            b["applications"] += int(apps or 0)
            b["documents"].add(tx_id)
            b["discount"] += Decimal(str(discount or 0))

    def flat(b) -> Dict[str, Any]:
        return {"applications": b["applications"], "documents": len(b["documents"]), "discount": _money(b["discount"])}

    shop_ids = [uuid.UUID(k) for k in by_shop if k]
    shop_names = (
        {str(s.id): s.name for s in db.query(Shop).filter(Shop.id.in_(shop_ids)).all()} if shop_ids else {}
    )
    till_ids = [uuid.UUID(k) for k in by_till if k]
    tills = (
        {str(m.id): m for m in db.query(POSMachine).filter(POSMachine.id.in_(till_ids)).all()} if till_ids else {}
    )
    live = {}
    promo_ids = [uuid.UUID(k) for k in by_promo if not k.startswith("name:")]
    if promo_ids:
        live = {str(p.id): p for p in db.query(Promotion).filter(Promotion.id.in_(promo_ids)).all()}

    by_promotion_out = []
    for key, b in by_promo.items():
        name, ptype = names.get(key, (None, None))
        current = live.get(key)
        by_promotion_out.append({
            "promotionId": None if key.startswith("name:") else key,
            "name": (current.name if current else None) or name,
            "type": (current.promo_type if current else None) or ptype,
            **flat(b),
        })
    by_promotion_out.sort(key=lambda r: (-r["discount"], r["name"] or ""))

    by_shop_out = [
        {"shopId": k, "name": shop_names.get(k) if k else None, **flat(b)} for k, b in by_shop.items()
    ]
    by_shop_out.sort(key=lambda r: -r["discount"])
    by_till_out = []
    for k, b in by_till.items():
        till = tills.get(k) if k else None
        by_till_out.append({
            "machineId": k,
            "name": till.name if till else None,
            "posNumber": getattr(till, "pos_number", None) if till else None,
            "shopName": shop_names.get(str(till.shop_id)) if till and till.shop_id else None,
            **flat(b),
        })
    by_till_out.sort(key=lambda r: -r["discount"])
    by_day_out = [{"date": d, **flat(b)} for d, b in sorted(by_day.items())]

    return {
        "window": empty["window"],
        "generatedAt": empty["generatedAt"],
        "totals": flat(totals),
        "byPromotion": by_promotion_out,
        "byShop": by_shop_out,
        "byTill": by_till_out,
        "byDay": by_day_out,
    }
