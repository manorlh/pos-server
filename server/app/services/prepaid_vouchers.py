"""
Prepaid vouchers ("שוברי הפקה"): a festival's production team is handed vouchers worth
goods ("1 נקניקייה + 1 שתייה") and redeems them at the tills by QR.

The rules, and why:

* **The cloud is the only ledger.** A voucher's balance lives here and nowhere else; a
  till must be online to redeem. Redemption locks the voucher's row (`FOR UPDATE`) and
  checks, subtracts and logs under that lock, so two tills scanning the same voucher at
  the same moment cannot both take the hot dog.
* **Idempotent per till.** The till sends a `clientRequestId`; the same id from the same
  till returns the first answer again, so a retry after a dropped response never takes
  the goods twice. The id is checked *under the lock*, so even two copies of the same
  request racing each other resolve to one redemption.
* **One-time or in parts, per batch.** `split_allowed=False` ("מימוש חד-פעמי"): one
  redemption uses the voucher up. Taking only part of it is refused unless the till
  says the cashier confirmed the rest is forfeited (`forfeitRest`), and what was given
  up is logged. `split_allowed=True` ("מימוש בחלקים"): whatever is not taken stays.
* **Where.** The batch's company (and its subsidiaries), narrowed to `shop_ids` when
  set. Another tenant's voucher is "not found" — a till learns nothing about it.
* **The QR carries only the code** ("PV:" + 16 characters of an unambiguous alphabet,
  80 bits of randomness), never a balance or a name: the paper proves nothing by itself.
  A batch may print a Code 128 line barcode instead (`barcode_type`), carrying the same
  "PV:" + code, and may print the code itself under it (`show_code`).
* **Production in groups** ("קבוצות", docs/SPEC_VOUCHER_PRODUCTION.md): a run of 1000 in
  groups of 10 gives every voucher a `group_no` (1..100) when it is issued — fixed, so an
  envelope keeps its number. The last group is smaller when the count does not divide.
  More vouchers later continue with the next group numbers. A whole group can be
  cancelled in one action (a lost envelope), and every such action is in the batch's
  audit trail (`prepaid_voucher_events`).
* **Kinds** (docs/SPEC_VOUCHER_PRODUCTION.md §7). `items` is all of the above: goods paid
  in advance, redeemed as a tender. `order_discount` / `item_discount` are a discount on
  the sale document — never a tender, never revenue moved: the till takes it off the sale
  (and so off its VAT base), prints it as a discount line, and the document carries it.
  A discount voucher is **reserved** for one open sale at one till (`reserve`: checked and
  held under the voucher's lock for `RESERVATION_TTL`, renewed by asking again), then
  **confirmed** by the sale's document (`confirm`, right after the sale, or the document
  itself when it reaches the cloud through the till's outbox — whichever comes first;
  both idempotent), or **released** (removed from the basket, the sale abandoned), or left
  to expire. A use is taken only when confirmed; a held one is not available to others.
* **The cloud is the authority on the rules** (app/services/prepaid_voucher_rules.py, the
  same rules as the till's): stacking, promotions and uses are checked at reserve (and a
  breach refused), and checked again at confirm — where the sale is already a fiscal
  document, so a breach is recorded and flagged (`flags`, the audit trail), never refused.
* **Clients that predate kinds** (the web and Windows kiosks today) do not say they can
  apply a discount (`supportedKinds`): to them a discount voucher is not redeemable
  (`prepaid_voucher_kind_unsupported`, with a Hebrew message), and a redemption of one is
  refused the same way.
"""
from __future__ import annotations

import secrets
import uuid
from collections import Counter, OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.category import Category
from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherBatchItem,
    PrepaidVoucherEvent,
    PrepaidVoucherRedemption,
    PrepaidVoucherReservation,
)
from app.models.product import CatalogLevel, Product
from app.models.shop import Shop
from app.models.shop_product_override import ShopProductOverride
from app.models.user import User, UserRole
from app.services import prepaid_voucher_rules as RULES
from app.services.company_hierarchy import (
    ancestor_company_ids,
    descendant_company_ids,
    user_covers_company,
)
from app.services.overview import _visible_shops_query
from app.services.permission_matrix import Action, Resource, roles_for

#: What the QR encodes before the code; also accepted when typed.
QR_PREFIX = "PV:"
#: No 0/O, 1/I/L: a code someone has to type off a crumpled voucher.
CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
CODE_LENGTH = 16

#: Who may make and manage batches: the catalog's writers (free goods are a catalog
#: decision), scoped by company / shop below.
MANAGE_ROLES = roles_for(Resource.CATALOG, Action.WRITE)

# ── 4xx details ───────────────────────────────────────────────────────────────
NOT_FOUND = "prepaid_voucher_not_found"
BATCH_NOT_FOUND = "prepaid_voucher_batch_not_found"
FORBIDDEN = "prepaid_voucher_forbidden"
COMPANY_NOT_FOUND = "prepaid_voucher_company_not_found"
SHOP_INVALID = "prepaid_voucher_shop_invalid"
PRODUCT_INVALID = "prepaid_voucher_product_invalid"
BATCH_CANCELLED = "prepaid_voucher_batch_cancelled"
# Redemption refusals (409), also the `reason` of a lookup that cannot be redeemed.
CANCELLED = "prepaid_voucher_cancelled"
USED = "prepaid_voucher_used"
EXPIRED = "prepaid_voucher_expired"
NOT_YET_VALID = "prepaid_voucher_not_yet_valid"
WRONG_SHOP = "prepaid_voucher_wrong_shop"
PARTIAL_NOT_ALLOWED = "prepaid_voucher_partial_not_allowed"
INSUFFICIENT = "prepaid_voucher_insufficient"
ITEM_NOT_ON_VOUCHER = "prepaid_voucher_item_not_on_voucher"
REQUEST_CONFLICT = "prepaid_voucher_request_conflict"
# Groups.
GROUP_NOT_FOUND = "prepaid_voucher_group_not_found"
ALREADY_GROUPED = "prepaid_voucher_already_grouped"
NOT_GROUPED = "prepaid_voucher_not_grouped"
# Kinds and discount vouchers (docs/SPEC_VOUCHER_PRODUCTION.md §7).
KIND_UNSUPPORTED = "prepaid_voucher_kind_unsupported"
TARGET_INVALID = "prepaid_voucher_target_invalid"
IN_USE = "prepaid_voucher_in_use"
DAILY_LIMIT = "prepaid_voucher_daily_limit"
RESERVATION_NOT_FOUND = "prepaid_voucher_reservation_not_found"
RESERVATION_RELEASED = "prepaid_voucher_reservation_released"
RESERVATION_CONFLICT = "prepaid_voucher_reservation_conflict"
# The shared rules' refusals, by their names here too.
ALREADY_APPLIED = RULES.ALREADY_APPLIED
NOT_STACKABLE = RULES.NOT_STACKABLE
OTHER_NOT_STACKABLE = RULES.OTHER_NOT_STACKABLE
SAME_BATCH = RULES.SAME_BATCH
MIN_PURCHASE = RULES.MIN_PURCHASE
NO_ELIGIBLE = RULES.NO_ELIGIBLE
PROMOTION_BETTER = RULES.PROMOTION_BETTER

#: Said to a client that cannot apply a discount voucher (it shows `message` as is).
KIND_UNSUPPORTED_MESSAGE = "זהו שובר הנחה — לא ניתן לממש אותו בעמדה זו. יש להציג אותו בקופה."
#: How long a discount voucher stays held for an open sale without the till asking again.
RESERVATION_TTL = timedelta(minutes=15)
#: Every kind a client may say it supports; one that says nothing supports goods only.
ALL_KINDS = RULES.KINDS

#: What a voucher's barcode can be: a QR (2D) or a Code 128 line barcode (1D).
BARCODE_TYPES = ("qr", "code128")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    """A naive stamp read as UTC (SQLite hands them back naive)."""
    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    moment = _utc(moment)
    return moment.isoformat() if moment else None


def _as_uuid(value) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def _http(code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


# ── Codes ─────────────────────────────────────────────────────────────────────


def generate_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def normalize_code(raw: Optional[str]) -> str:
    """The code as stored, from what was scanned or typed ("pv:abcd-efgh …")."""
    text = (raw or "").strip().upper()
    if text.startswith(QR_PREFIX):
        text = text[len(QR_PREFIX):]
    return "".join(ch for ch in text if ch.isalnum())


def format_code(code: str) -> str:
    """"ABCDEFGH…" → "ABCD-EFGH-…", as printed under the QR."""
    return "-".join(code[i:i + 4] for i in range(0, len(code), 4))


def qr_payload(code: str) -> str:
    return QR_PREFIX + code


def _unique_codes(db: Session, count: int) -> List[str]:
    """`count` new codes, none already in use (a collision is ~impossible; checked anyway)."""
    out: "OrderedDict[str, None]" = OrderedDict()
    while len(out) < count:
        wanted = count - len(out)
        fresh = {generate_code() for _ in range(wanted)} - set(out)
        if not fresh:
            continue
        taken = {
            c for (c,) in db.query(PrepaidVoucher.code).filter(PrepaidVoucher.code.in_(list(fresh)))
        }
        for code in fresh - taken:
            out[code] = None
    return list(out)[:count]


# ── Scope (dashboard) ─────────────────────────────────────────────────────────


def _require_role(user: User) -> None:
    if user.role not in MANAGE_ROLES:
        raise _http(status.HTTP_403_FORBIDDEN, "Insufficient permissions")


def _covers_company(db: Session, user: User, company_id) -> bool:
    if user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return True
    return user.role == UserRole.COMPANY_MANAGER and user_covers_company(db, user, company_id)


def _visible_shop_ids(db: Session, user: User, tenant_id) -> set:
    q = _visible_shops_query(db, user, tenant_id)
    return set() if q is None else {str(s) for (s,) in q.with_entities(Shop.id)}


def may_manage(db: Session, user: User, tenant_id, batch: PrepaidVoucherBatch) -> bool:
    """
    A company-wide batch: whoever covers its company. A batch for named shops: whoever
    sees every one of them (so a shop manager manages the batches of their own shop).
    """
    if str(batch.tenant_id) != str(tenant_id) or user.role not in MANAGE_ROLES:
        return False
    if _covers_company(db, user, batch.company_id):
        return True
    if not batch.shop_ids:
        return False
    return set(map(str, batch.shop_ids)) <= _visible_shop_ids(db, user, tenant_id)


def get_batch(db: Session, user: User, tenant_id, batch_id) -> PrepaidVoucherBatch:
    _require_role(user)
    wanted = _as_uuid(batch_id)
    batch = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == wanted).first() if wanted else None
    if batch is None or str(batch.tenant_id) != str(tenant_id):
        raise _http(status.HTTP_404_NOT_FOUND, BATCH_NOT_FOUND)
    if not may_manage(db, user, tenant_id, batch):
        raise _http(status.HTTP_403_FORBIDDEN, FORBIDDEN)
    return batch


def get_voucher(db: Session, user: User, tenant_id, voucher_id) -> PrepaidVoucher:
    _require_role(user)
    wanted = _as_uuid(voucher_id)
    voucher = db.query(PrepaidVoucher).filter(PrepaidVoucher.id == wanted).first() if wanted else None
    if voucher is None or str(voucher.tenant_id) != str(tenant_id):
        raise _http(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    if not may_manage(db, user, tenant_id, voucher.batch):
        raise _http(status.HTTP_403_FORBIDDEN, FORBIDDEN)
    return voucher


def _company_group(db: Session, company_id) -> set:
    return {str(c) for c in descendant_company_ids(db, company_id)}


def _validate_shops(db: Session, user: User, tenant_id, company_id, shop_ids) -> Optional[List[str]]:
    if not shop_ids:
        return None
    group = _company_group(db, company_id)
    visible = _visible_shop_ids(db, user, tenant_id)
    out: List[str] = []
    for sid in dict.fromkeys(str(s) for s in shop_ids):
        shop = db.query(Shop).filter(Shop.id == _as_uuid(sid)).first()
        if shop is None or str(shop.tenant_id) != str(tenant_id) or str(shop.company_id) not in group:
            raise _http(status.HTTP_400_BAD_REQUEST, SHOP_INVALID)
        if sid not in visible:
            raise _http(status.HTTP_403_FORBIDDEN, FORBIDDEN)
        out.append(sid)
    return out


def _related_companies(db: Session, company_id) -> set:
    """The batch's company with its parents and children: their catalog products may go on it."""
    return {str(c) for c in descendant_company_ids(db, company_id)} | {
        str(c) for c in ancestor_company_ids(db, company_id)
    }


def _eligible(p: Optional[Product], tenant_id, related: set) -> bool:
    """A product a voucher may carry: a plain catalog product of the batch's company group."""
    return (
        p is not None
        and str(p.tenant_id) == str(tenant_id)
        and p.catalog_level == CatalogLevel.GLOBAL
        and p.pos_machine_id is None
        and not bool(getattr(p, "is_general", False))
        and not bool(getattr(p, "is_weighed", False))
        and (p.company_id is None or str(p.company_id) in related)
    )


def _validate_products(db: Session, tenant_id, company_id, items) -> List[Product]:
    related = _related_companies(db, company_id)
    products: List[Product] = []
    for item in items:
        p = db.query(Product).filter(Product.id == item.product_id).first()
        if not _eligible(p, tenant_id, related):
            raise _http(status.HTTP_400_BAD_REQUEST, PRODUCT_INVALID)
        products.append(p)
    return products


def eligible_products(
    db: Session, user: User, tenant_id, company_id, search: Optional[str] = None, limit: int = 50
) -> List[Dict[str, Any]]:
    """
    The products a batch of [company_id] may carry — exactly what [_validate_products] accepts,
    so the dashboard's picker never offers one the save then refuses (the owner, 07.10.2026:
    a product of another company was offered and refused as "אינו מתאים").
    """
    _require_role(user)
    company = db.query(Company).filter(Company.id == _as_uuid(company_id)).first()
    if company is None or str(company.tenant_id) != str(tenant_id):
        raise _http(status.HTTP_404_NOT_FOUND, COMPANY_NOT_FOUND)
    if not _covers_company(db, user, company.id):
        raise _http(status.HTTP_403_FORBIDDEN, FORBIDDEN)
    related = _related_companies(db, company.id)
    q = db.query(Product).filter(
        Product.tenant_id == tenant_id,
        Product.catalog_level == CatalogLevel.GLOBAL,
        Product.pos_machine_id.is_(None),
        Product.is_general.is_(False),
        Product.is_weighed.is_(False),
        (Product.company_id.is_(None)) | (Product.company_id.in_([_as_uuid(c) for c in related])),
    )
    text = (search or "").strip()
    if text:
        like = f"%{text}%"
        q = q.filter(Product.name.ilike(like) | Product.sku.ilike(like))
    rows = q.order_by(Product.name).limit(max(1, min(int(limit), 200))).all()
    return [
        {"id": str(p.id), "name": p.name, "price": float(p.price or 0), "sku": p.sku}
        for p in rows
        if _eligible(p, tenant_id, related)
    ]

def _eligible_category(c: Optional[Category], tenant_id, related: set) -> bool:
    """
    A category an item discount may name: a catalog category of the batch's company group
    (its parents, its children) or of no company — the products' rule ([_eligible]) for
    categories. Never a till's own.
    """
    return (
        c is not None
        and str(c.tenant_id) == str(tenant_id)
        and c.pos_machine_id is None
        and c.catalog_level == CatalogLevel.GLOBAL
        and (c.company_id is None or str(c.company_id) in related)
    )


def eligible_categories(db: Session, user: User, tenant_id, company_id) -> List[Dict[str, Any]]:
    """
    The categories an item discount of [company_id] may name — exactly what [_validate_targets]
    accepts (as [eligible_products] for the products), so the picker never offers one the save
    then refuses. With their parent, for the picker's path ("שתייה › חמה").
    """
    _require_role(user)
    company = db.query(Company).filter(Company.id == _as_uuid(company_id)).first()
    if company is None or str(company.tenant_id) != str(tenant_id):
        raise _http(status.HTTP_404_NOT_FOUND, COMPANY_NOT_FOUND)
    if not _covers_company(db, user, company.id):
        raise _http(status.HTTP_403_FORBIDDEN, FORBIDDEN)
    related = _related_companies(db, company.id)
    rows = (
        db.query(Category)
        .filter(Category.tenant_id == tenant_id, Category.pos_machine_id.is_(None))
        .order_by(Category.name)
        .all()
    )
    return [
        {"id": str(c.id), "name": c.name, "parentId": str(c.parent_id) if c.parent_id else None}
        for c in rows
        if _eligible_category(c, tenant_id, related)
    ]


def _validate_targets(db: Session, tenant_id, company_id, targets) -> Dict[str, Any]:
    """
    An item discount's products and categories, by the pickers' own rules ([_eligible],
    [_eligible_category]), with their names as printed: `{productIds, categoryIds, names}`.
    """
    class _One:
        def __init__(self, pid):
            self.product_id = pid

    products = _validate_products(db, tenant_id, company_id, [_One(p) for p in targets.product_ids])
    related = _related_companies(db, company_id)
    categories: List[Category] = []
    for cid in targets.category_ids:
        c = db.query(Category).filter(Category.id == cid).first()
        if not _eligible_category(c, tenant_id, related):
            raise _http(status.HTTP_400_BAD_REQUEST, TARGET_INVALID)
        categories.append(c)
    return {
        "productIds": [str(p.id) for p in products],
        "categoryIds": [str(c.id) for c in categories],
        "names": [p.name for p in products] + [c.name for c in categories],
    }


def is_discount(batch: PrepaidVoucherBatch) -> bool:
    return (getattr(batch, "kind", None) or "items") in RULES.DISCOUNT_KINDS


# ── Dashboard writes ──────────────────────────────────────────────────────────


def group_plan(count: int, size: Optional[int], first_group: int = 1) -> List[Dict[str, int]]:
    """
    [count] vouchers in groups of [size]: `[{group, offset, count}]` in order, numbered from
    [first_group]; the last group holds what is left (1005 in tens: 100 of 10, then 1 of 5).
    Empty when not grouped (no size).
    """
    if not size or size < 1 or count < 1:
        return []
    return [
        {"group": first_group + n, "offset": off, "count": min(size, count - off)}
        for n, off in enumerate(range(0, count, size))
    ]


def _last_group(db: Session, batch_id) -> int:
    return int(
        db.query(func.max(PrepaidVoucher.group_no)).filter(PrepaidVoucher.batch_id == batch_id).scalar() or 0
    )


def _issue(
    db: Session, batch: PrepaidVoucherBatch, count: int, group_size: Optional[int] = None
) -> List[PrepaidVoucher]:
    discount = is_discount(batch)
    remaining = {} if discount else {str(i.product_id): int(i.quantity) for i in batch.items}
    uses = int(batch.uses_per_voucher or 1) if discount else None
    codes = _unique_codes(db, count)
    start = int(batch.next_serial or 1)
    # Each new run of a grouped batch starts a new group: an envelope already packed and
    # numbered never gets vouchers added to it.
    groups: List[Optional[int]] = [None] * count
    for g in group_plan(count, group_size, _last_group(db, batch.id) + 1 if group_size else 1):
        for i in range(g["offset"], g["offset"] + g["count"]):
            groups[i] = g["group"]
    vouchers = [
        PrepaidVoucher(
            id=uuid.uuid4(),
            tenant_id=batch.tenant_id,
            batch_id=batch.id,
            serial=start + n,
            group_no=groups[n],
            code=code,
            remaining=dict(remaining),
            uses_left=uses,
            status="active",
        )
        for n, code in enumerate(codes)
    ]
    batch.next_serial = start + count
    db.add_all(vouchers)
    return vouchers


def _user_name(user: Optional[User]) -> Optional[str]:
    if user is None:
        return None
    return getattr(user, "username", None) or getattr(user, "email", None)


def _event(
    db: Session,
    batch: PrepaidVoucherBatch,
    user: Optional[User],
    action: str,
    *,
    group_no: Optional[int] = None,
    voucher_id=None,
    count: Optional[int] = None,
    reason: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
) -> PrepaidVoucherEvent:
    """One line of the batch's audit trail. Never edited afterwards."""
    ev = PrepaidVoucherEvent(
        id=uuid.uuid4(),
        tenant_id=batch.tenant_id,
        batch_id=batch.id,
        action=action,
        group_no=group_no,
        voucher_id=voucher_id,
        count=count,
        reason=(reason or "").strip() or None,
        user_id=getattr(user, "id", None),
        user_name=_user_name(user),
        details=details or None,
        created_at=_now(),
    )
    db.add(ev)
    return ev


def _issued_details(vouchers: List[PrepaidVoucher], group_size: Optional[int]) -> Dict[str, Any]:
    if not vouchers:
        return {}
    groups = [v.group_no for v in vouchers if v.group_no is not None]
    out: Dict[str, Any] = {"fromSerial": vouchers[0].serial, "toSerial": vouchers[-1].serial}
    if groups:
        out.update({"groupSize": group_size, "fromGroup": min(groups), "toGroup": max(groups)})
    return out


def create_batch(db: Session, user: User, tenant_id, body) -> PrepaidVoucherBatch:
    _require_role(user)
    company = db.query(Company).filter(Company.id == body.company_id).first()
    if company is None or str(company.tenant_id) != str(tenant_id):
        raise _http(status.HTTP_404_NOT_FOUND, COMPANY_NOT_FOUND)
    shop_ids = _validate_shops(db, user, tenant_id, company.id, body.shop_ids)
    if not _covers_company(db, user, company.id) and not shop_ids:
        # A shop manager makes batches for their own shop only.
        raise _http(status.HTTP_403_FORBIDDEN, FORBIDDEN)
    products = _validate_products(db, tenant_id, company.id, body.items)
    kind = getattr(body, "kind", None) or "items"
    discount = kind in RULES.DISCOUNT_KINDS
    targets = (
        _validate_targets(db, tenant_id, company.id, body.targets)
        if kind == "item_discount" and getattr(body, "targets", None) is not None else None
    )
    from app.schemas.prepaid_voucher import agorot

    batch = PrepaidVoucherBatch(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        company_id=company.id,
        shop_ids=shop_ids,
        name=body.name,
        event_name=body.event_name,
        logo_url=body.logo_url,
        free_text=body.free_text,
        valid_from=body.valid_from,
        valid_until=body.valid_until,
        split_allowed=bool(body.split_allowed),
        status="active",
        next_serial=1,
        group_size=body.group_size or None,
        show_code=bool(body.show_code),
        barcode_type=body.barcode_type or "qr",
        customer_name=body.customer_name,
        order_ref=body.order_ref,
        kind=kind,
        # Agorot for a fixed discount, basis points for a percent (₪ / % × 100 both).
        discount_type=body.discount_type if discount else None,
        discount_value=agorot(body.discount_value) if discount else None,
        min_purchase=agorot(body.min_purchase) if discount else None,
        max_discount=agorot(body.max_discount) if discount else None,
        max_units=body.max_units if kind == "item_discount" else None,
        targets=targets,
        stacking=getattr(body, "stacking", None) or "single",
        promotion_policy=getattr(body, "promotion_policy", None) or "exclude",
        uses_per_voucher=int(getattr(body, "uses_per_voucher", 1) or 1) if discount else 1,
        max_uses_per_sale=int(getattr(body, "max_uses_per_sale", 1) or 1) if discount else 1,
        max_uses_per_day=getattr(body, "max_uses_per_day", None) if discount else None,
        created_by=user.id,
        created_at=_now(),
        updated_at=_now(),
    )
    batch.items = [
        PrepaidVoucherBatchItem(
            id=uuid.uuid4(),
            product_id=p.id,
            product_name=p.name,
            quantity=item.quantity,
            sort_order=n,
        )
        for n, (item, p) in enumerate(zip(body.items, products))
    ]
    db.add(batch)
    db.flush()
    issued = _issue(db, batch, body.count, batch.group_size)
    _event(db, batch, user, "create", count=body.count, details=_issued_details(issued, batch.group_size))
    db.flush()
    return batch


def add_vouchers(
    db: Session, user: User, tenant_id, batch_id, count: int, group_size: Optional[int] = None
) -> PrepaidVoucherBatch:
    """
    More vouchers, with the next serials. A grouped batch issues them in groups too — of
    [group_size] when given, else of the batch's own size — starting a new group.
    """
    batch = get_batch(db, user, tenant_id, batch_id)
    # Serials are drawn under the batch's lock, so two clicks cannot hand out one twice.
    batch = (
        db.query(PrepaidVoucherBatch)
        .filter(PrepaidVoucherBatch.id == batch.id)
        .with_for_update()
        .one()
    )
    if batch.status == "cancelled":
        raise _http(status.HTTP_409_CONFLICT, BATCH_CANCELLED)
    size = group_size or batch.group_size
    if size and not batch.group_size:
        batch.group_size = size
    issued = _issue(db, batch, count, size)
    _event(db, batch, user, "add", count=count, details=_issued_details(issued, size))
    db.flush()
    return batch


def assign_groups(db: Session, user: User, tenant_id, batch_id, group_size: int) -> PrepaidVoucherBatch:
    """
    Split the batch's vouchers that have no group yet (a batch made before groups, or
    without them) into groups of [group_size], by serial, after the last group there is.
    Groups already given are never changed: an envelope keeps its number.
    """
    batch = get_batch(db, user, tenant_id, batch_id)
    batch = (
        db.query(PrepaidVoucherBatch)
        .filter(PrepaidVoucherBatch.id == batch.id)
        .with_for_update()
        .one()
    )
    loose = (
        db.query(PrepaidVoucher)
        .filter(PrepaidVoucher.batch_id == batch.id, PrepaidVoucher.group_no.is_(None))
        .order_by(PrepaidVoucher.serial)
        .all()
    )
    if not loose:
        raise _http(status.HTTP_409_CONFLICT, ALREADY_GROUPED)
    for g in group_plan(len(loose), group_size, _last_group(db, batch.id) + 1):
        for v in loose[g["offset"]:g["offset"] + g["count"]]:
            v.group_no = g["group"]
            v.updated_at = _now()
    if not batch.group_size:
        batch.group_size = group_size
    batch.updated_at = _now()
    _event(db, batch, user, "assign_groups", count=len(loose), details=_issued_details(loose, group_size))
    db.flush()
    return batch


def update_batch(db: Session, user: User, tenant_id, batch_id, body) -> PrepaidVoucherBatch:
    batch = get_batch(db, user, tenant_id, batch_id)
    fields = body.model_dump(exclude_unset=True, by_alias=False)
    if "name" in fields and not fields["name"]:
        fields.pop("name")
    # Print settings are never cleared by a null: they always have a value. Nor are the
    # rules of use (a null daily limit clears it: no limit is a value of its own).
    for key in ("show_code", "barcode_type", "stacking", "promotion_policy", "max_uses_per_sale"):
        if key in fields and fields[key] is None:
            fields.pop(key)
    if not is_discount(batch):
        # A goods voucher has no promotions to weigh and no uses: only its stacking.
        for key in ("promotion_policy", "max_uses_per_sale", "max_uses_per_day"):
            fields.pop(key, None)
    changed = sorted(k for k, v in fields.items() if getattr(batch, k) != v)
    for key, value in fields.items():
        setattr(batch, key, value)
    if batch.valid_from and batch.valid_until and _utc(batch.valid_until) <= _utc(batch.valid_from):
        raise _http(status.HTTP_400_BAD_REQUEST, "validUntil must be after validFrom")
    if is_discount(batch) and int(batch.max_uses_per_sale or 1) > int(batch.uses_per_voucher or 1):
        batch.max_uses_per_sale = int(batch.uses_per_voucher or 1)
    batch.updated_at = _now()
    if changed:
        _event(db, batch, user, "update", details={"fields": changed})
    db.flush()
    return batch


def _cancel_open(vouchers: Iterable[PrepaidVoucher], now: datetime) -> List[PrepaidVoucher]:
    """Cancels the ones still open (unused or partly used); used ones stay as they are."""
    out = []
    for v in vouchers:
        if v.status in ("active", "partially_used"):
            v.status = "cancelled"
            v.cancelled_at = now
            v.updated_at = now
            out.append(v)
    return out


def cancel_batch(db: Session, user: User, tenant_id, batch_id, reason: Optional[str] = None) -> PrepaidVoucherBatch:
    batch = get_batch(db, user, tenant_id, batch_id)
    if batch.status != "cancelled":
        now = _now()
        batch.status = "cancelled"
        batch.cancelled_at = now
        batch.updated_at = now
        done = _cancel_open(db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == batch.id), now)
        _event(db, batch, user, "cancel_batch", count=len(done), reason=reason)
    db.flush()
    return batch


def cancel_group(
    db: Session, user: User, tenant_id, batch_id, group_no: int, reason: Optional[str] = None
) -> Dict[str, Any]:
    """
    Cancel a whole group in one action — the envelope of 10 that was lost. Its unused and
    partly used vouchers are cancelled (a till refuses them from now on); used ones stay
    used. Logged with who, when, why and the serials. Idempotent: a second call cancels
    nothing more and logs nothing.
    """
    batch = get_batch(db, user, tenant_id, batch_id)
    rows = (
        db.query(PrepaidVoucher)
        .filter(PrepaidVoucher.batch_id == batch.id, PrepaidVoucher.group_no == int(group_no))
        .order_by(PrepaidVoucher.serial)
        .with_for_update()
        .all()
    )
    if not rows:
        raise _http(status.HTTP_404_NOT_FOUND, GROUP_NOT_FOUND)
    now = _now()
    done = _cancel_open(rows, now)
    if done:
        batch.updated_at = now
        _event(
            db, batch, user, "cancel_group", group_no=int(group_no), count=len(done), reason=reason,
            details={"serials": [v.serial for v in done]},
        )
    db.flush()
    return {"group": int(group_no), "cancelled": len(done), "groupStats": group_stats(db, batch, int(group_no))}


def cancel_voucher(db: Session, user: User, tenant_id, voucher_id, reason: Optional[str] = None) -> PrepaidVoucher:
    voucher = get_voucher(db, user, tenant_id, voucher_id)
    if _cancel_open([voucher], _now()):
        _event(
            db, voucher.batch, user, "cancel_voucher", group_no=voucher.group_no, voucher_id=voucher.id,
            count=1, reason=reason, details={"serial": voucher.serial},
        )
    db.flush()
    return voucher


def set_voucher_note(db: Session, user: User, tenant_id, voucher_id, note: Optional[str]) -> PrepaidVoucher:
    """A voucher's free-text note, whatever its status (a used one may still need one)."""
    voucher = get_voucher(db, user, tenant_id, voucher_id)
    voucher.note = (note or "").strip() or None
    voucher.updated_at = _now()
    db.flush()
    return voucher


# ── Dashboard reads ───────────────────────────────────────────────────────────


def _batch_items_out(batch: PrepaidVoucherBatch) -> List[Dict[str, Any]]:
    return [
        {"productId": str(i.product_id), "name": i.product_name, "quantity": int(i.quantity)}
        for i in batch.items
    ]


def _stats(db: Session, batch_ids: List[uuid.UUID]) -> Dict[str, Dict[str, int]]:
    out: Dict[str, Dict[str, int]] = {}
    if not batch_ids:
        return out
    rows = (
        db.query(PrepaidVoucher.batch_id, PrepaidVoucher.status, func.count(PrepaidVoucher.id))
        .filter(PrepaidVoucher.batch_id.in_(batch_ids))
        .group_by(PrepaidVoucher.batch_id, PrepaidVoucher.status)
        .all()
    )
    for batch_id, st, n in rows:
        bucket = out.setdefault(
            str(batch_id), {"total": 0, "active": 0, "partiallyUsed": 0, "used": 0, "cancelled": 0}
        )
        key = {"partially_used": "partiallyUsed"}.get(st, st)
        bucket[key] = bucket.get(key, 0) + int(n)
        bucket["total"] += int(n)
    return out


def _empty_counts() -> Dict[str, int]:
    return {"total": 0, "active": 0, "partiallyUsed": 0, "used": 0, "cancelled": 0}


def groups_report(db: Session, batch: PrepaidVoucherBatch, only_group: Optional[int] = None) -> List[Dict[str, Any]]:
    """
    Per group: its serials, how many vouchers, and how many are unused / partly used / used
    (redeemed) / cancelled — "how much of envelope 7 came back". Vouchers with no group
    (issued before the batch was grouped) are one row with `group` null, last.
    """
    q = db.query(
        PrepaidVoucher.group_no,
        PrepaidVoucher.status,
        func.count(PrepaidVoucher.id),
        func.min(PrepaidVoucher.serial),
        func.max(PrepaidVoucher.serial),
    ).filter(PrepaidVoucher.batch_id == batch.id)
    if only_group is not None:
        q = q.filter(PrepaidVoucher.group_no == only_group)
    rows: Dict[Optional[int], Dict[str, Any]] = {}
    for group_no, st, n, lo, hi in q.group_by(PrepaidVoucher.group_no, PrepaidVoucher.status):
        row = rows.setdefault(
            group_no, {"group": group_no, "fromSerial": lo, "toSerial": hi, **_empty_counts()}
        )
        key = {"partially_used": "partiallyUsed"}.get(st, st)
        row[key] = row.get(key, 0) + int(n)
        row["total"] += int(n)
        row["fromSerial"] = min(row["fromSerial"], lo)
        row["toSerial"] = max(row["toSerial"], hi)
    out = sorted((r for g, r in rows.items() if g is not None), key=lambda r: r["group"])
    if None in rows:
        out.append(rows[None])
    for r in out:
        r["redeemed"] = r["used"] + r["partiallyUsed"]
    return out


def group_stats(db: Session, batch: PrepaidVoucherBatch, group_no: int) -> Optional[Dict[str, Any]]:
    rows = groups_report(db, batch, only_group=group_no)
    return rows[0] if rows else None


def batch_groups(db: Session, user: User, tenant_id, batch_id) -> Dict[str, Any]:
    batch = get_batch(db, user, tenant_id, batch_id)
    return {"batchId": str(batch.id), "groupSize": batch.group_size, "items": groups_report(db, batch)}


def _event_out(ev: PrepaidVoucherEvent) -> Dict[str, Any]:
    return {
        "id": str(ev.id),
        "action": ev.action,
        "group": ev.group_no,
        "voucherId": str(ev.voucher_id) if ev.voucher_id else None,
        "count": ev.count,
        "reason": ev.reason,
        "userName": ev.user_name,
        "details": ev.details or {},
        "createdAt": _iso(ev.created_at),
    }


def batch_events(db: Session, user: User, tenant_id, batch_id) -> Dict[str, Any]:
    """The batch's audit trail, newest first."""
    batch = get_batch(db, user, tenant_id, batch_id)
    rows = (
        db.query(PrepaidVoucherEvent)
        .filter(PrepaidVoucherEvent.batch_id == batch.id)
        .order_by(PrepaidVoucherEvent.created_at.desc())
        .limit(500)
        .all()
    )
    return {"items": [_event_out(e) for e in rows]}


def batch_out(db: Session, batch: PrepaidVoucherBatch, stats: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    if stats is None:
        stats = _stats(db, [batch.id]).get(str(batch.id))
    company = db.query(Company.name).filter(Company.id == batch.company_id).scalar()
    shop_names: Dict[str, str] = {}
    if batch.shop_ids:
        ids = [_as_uuid(s) for s in batch.shop_ids]
        shop_names = {str(i): n for i, n in db.query(Shop.id, Shop.name).filter(Shop.id.in_(ids))}
    return {
        "id": str(batch.id),
        "name": batch.name,
        "eventName": batch.event_name,
        "logoUrl": batch.logo_url,
        "freeText": batch.free_text,
        "validFrom": _iso(batch.valid_from),
        "validUntil": _iso(batch.valid_until),
        "splitAllowed": bool(batch.split_allowed),
        "status": batch.status,
        "companyId": str(batch.company_id),
        "companyName": company,
        "shopIds": list(batch.shop_ids) if batch.shop_ids else None,
        "shops": [{"id": s, "name": shop_names.get(s)} for s in (batch.shop_ids or [])],
        "items": _batch_items_out(batch),
        "stats": stats or _empty_counts(),
        "createdAt": _iso(batch.created_at),
        "cancelledAt": _iso(batch.cancelled_at),
        # Production (docs/SPEC_VOUCHER_PRODUCTION.md).
        "groupSize": batch.group_size,
        "groupCount": _last_group(db, batch.id),
        "showCode": bool(batch.show_code),
        "barcodeType": batch.barcode_type or "qr",
        "customerName": batch.customer_name,
        "orderRef": batch.order_ref,
        # Kind and terms (docs/SPEC_VOUCHER_PRODUCTION.md §7).
        **terms_out(batch),
    }


def _shekels_out(agorot_value: Optional[int]) -> Optional[float]:
    return None if agorot_value is None else round(int(agorot_value) / 100, 2)


def terms_out(batch: PrepaidVoucherBatch) -> Dict[str, Any]:
    """A batch's kind and terms as the dashboard reads them (₪ and %, not agorot)."""
    discount = is_discount(batch)
    targets = batch.targets or {}
    return {
        "kind": batch.kind or "items",
        "discountType": batch.discount_type if discount else None,
        # ₪ for fixed, % for percent: both are stored × 100.
        "discountValue": _shekels_out(batch.discount_value) if discount else None,
        "minPurchase": _shekels_out(batch.min_purchase),
        "maxDiscount": _shekels_out(batch.max_discount),
        "maxUnits": batch.max_units,
        "targets": (
            {
                "productIds": list(targets.get("productIds") or []),
                "categoryIds": list(targets.get("categoryIds") or []),
                "names": list(targets.get("names") or []),
            }
            if batch.kind == "item_discount" else None
        ),
        "stacking": batch.stacking or "single",
        "promotionPolicy": batch.promotion_policy or "exclude",
        "usesPerVoucher": int(batch.uses_per_voucher or 1),
        "maxUsesPerSale": int(batch.max_uses_per_sale or 1),
        "maxUsesPerDay": batch.max_uses_per_day,
        # "₪30 הנחה על כל ההזמנה" — what the paper says; null for goods.
        "benefitText": RULES.batch_benefit_text(batch),
    }


def list_batches(db: Session, user: User, tenant_id, *, include_cancelled: bool = True) -> List[Dict[str, Any]]:
    _require_role(user)
    q = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.tenant_id == tenant_id)
    if not include_cancelled:
        q = q.filter(PrepaidVoucherBatch.status == "active")
    batches = [b for b in q.order_by(PrepaidVoucherBatch.created_at.desc()).all() if may_manage(db, user, tenant_id, b)]
    stats = _stats(db, [b.id for b in batches])
    return [batch_out(db, b, stats.get(str(b.id))) for b in batches]


def _remaining_out(batch: PrepaidVoucherBatch, voucher: PrepaidVoucher) -> List[Dict[str, Any]]:
    rem = voucher.remaining or {}
    return [
        {
            "productId": str(i.product_id),
            "name": i.product_name,
            "quantity": int(i.quantity),
            "remaining": int(rem.get(str(i.product_id), 0)),
        }
        for i in batch.items
    ]


def _redemption_out(r: PrepaidVoucherRedemption, machine_names: Dict[str, str]) -> Dict[str, Any]:
    return {
        "id": str(r.id),
        "redeemedAt": _iso(r.redeemed_at),
        "machineId": str(r.machine_id) if r.machine_id else None,
        "machineName": machine_names.get(str(r.machine_id)) if r.machine_id else None,
        "shopId": str(r.shop_id) if r.shop_id else None,
        "posUserId": r.pos_user_id,
        "posUserName": r.pos_user_name,
        "transactionId": r.transaction_id,
        "items": r.items or [],
        "forfeited": r.forfeited or [],
        "reversedAt": _iso(getattr(r, "reversed_at", None)),
        # A discount voucher's use: how many uses, the ₪ it took off, what the re-check found.
        "uses": r.uses,
        "discountAmount": _shekels_out(r.discount_amount),
        "flags": list(r.flags or []),
    }


def voucher_out(
    db: Session,
    voucher: PrepaidVoucher,
    *,
    with_redemptions: bool = False,
) -> Dict[str, Any]:
    out = {
        "id": str(voucher.id),
        "batchId": str(voucher.batch_id),
        "serial": int(voucher.serial),
        "groupNo": voucher.group_no,
        "code": voucher.code,
        "displayCode": format_code(voucher.code),
        "qrPayload": qr_payload(voucher.code),
        "status": voucher.status,
        "note": voucher.note,
        "items": _remaining_out(voucher.batch, voucher),
        # A discount voucher: its uses left of the batch's per-voucher uses (null for goods).
        "usesLeft": voucher.uses_left,
        "usesPerVoucher": int(voucher.batch.uses_per_voucher or 1) if is_discount(voucher.batch) else None,
        "firstRedeemedAt": _iso(voucher.first_redeemed_at),
        "lastRedeemedAt": _iso(voucher.last_redeemed_at),
        "cancelledAt": _iso(voucher.cancelled_at),
    }
    if with_redemptions:
        ids = [r.machine_id for r in voucher.redemptions if r.machine_id]
        names = (
            {str(i): n for i, n in db.query(POSMachine.id, POSMachine.name).filter(POSMachine.id.in_(ids))}
            if ids
            else {}
        )
        out["redemptions"] = [_redemption_out(r, names) for r in voucher.redemptions]
    return out


def list_vouchers(
    db: Session,
    user: User,
    tenant_id,
    batch_id,
    *,
    status_filter: Optional[str] = None,
    serial: Optional[int] = None,
    limit: int = 100,
    offset: int = 0,
    group_no: Optional[int] = None,
    code: Optional[str] = None,
) -> Dict[str, Any]:
    batch = get_batch(db, user, tenant_id, batch_id)
    q = db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == batch.id)
    if status_filter:
        q = q.filter(PrepaidVoucher.status == status_filter)
    if serial is not None:
        q = q.filter(PrepaidVoucher.serial == serial)
    if group_no is not None:
        q = q.filter(PrepaidVoucher.group_no == group_no)
    if code:
        # The code as printed under the barcode, or part of it ("ABCD-EFGH…").
        wanted = normalize_code(code)
        if len(wanted) >= CODE_LENGTH:
            q = q.filter(PrepaidVoucher.code == wanted[:CODE_LENGTH])
        elif len(wanted) >= 4:
            q = q.filter(PrepaidVoucher.code.contains(wanted))
        else:
            q = q.filter(PrepaidVoucher.id.is_(None))
    total = q.count()
    rows = q.order_by(PrepaidVoucher.serial).offset(offset).limit(limit).all()
    return {"total": total, "items": [voucher_out(db, v) for v in rows]}


# ── Till ──────────────────────────────────────────────────────────────────────


def _locate(db: Session, machine: POSMachine, raw_code: str, *, lock: bool) -> PrepaidVoucher:
    code = normalize_code(raw_code)
    if len(code) != CODE_LENGTH:
        raise _http(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    q = db.query(PrepaidVoucher).filter(PrepaidVoucher.code == code)
    if lock:
        q = q.with_for_update()
    voucher = q.first()
    if voucher is None or str(voucher.tenant_id) != str(machine.tenant_id):
        raise _http(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    return voucher


def refusal_reason(db: Session, machine: POSMachine, voucher: PrepaidVoucher, now: Optional[datetime] = None) -> Optional[str]:
    """Why this till cannot redeem this voucher now, or None."""
    now = now or _now()
    batch = voucher.batch
    if batch.status == "cancelled" or voucher.status == "cancelled":
        return CANCELLED
    if is_discount(batch):
        if voucher.status == "used" or int(voucher.uses_left or 0) <= 0:
            return USED
    elif voucher.status == "used" or not any(int(q) > 0 for q in (voucher.remaining or {}).values()):
        return USED
    if batch.valid_from is not None and now < _utc(batch.valid_from):
        return NOT_YET_VALID
    if batch.valid_until is not None and now > _utc(batch.valid_until):
        return EXPIRED
    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first() if machine.shop_id else None
    if shop is None or str(shop.company_id) not in _company_group(db, batch.company_id):
        return WRONG_SHOP
    if batch.shop_ids and str(shop.id) not in set(map(str, batch.shop_ids)):
        return WRONG_SHOP
    return None


def _till_products(db: Session, machine: POSMachine, product_ids: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    """
    For each global product: the id the till knows it by (its own local copy's, when it
    has one, as the catalog sync sends it), whether its shop lists it, and its price there.
    """
    ids = [_as_uuid(p) for p in product_ids]
    ids = [i for i in ids if i is not None]
    out: Dict[str, Dict[str, Any]] = {}
    if not ids:
        return out
    globals_ = {str(p.id): p for p in db.query(Product).filter(Product.id.in_(ids))}
    locals_ = {
        str(p.global_product_id): p
        for p in db.query(Product).filter(
            Product.pos_machine_id == machine.id, Product.global_product_id.in_(ids)
        )
    }
    overrides = (
        {
            str(o.global_product_id): o
            for o in db.query(ShopProductOverride).filter(
                ShopProductOverride.shop_id == machine.shop_id,
                ShopProductOverride.global_product_id.in_(ids),
            )
        }
        if machine.shop_id
        else {}
    )
    for pid in map(str, ids):
        g = globals_.get(pid)
        loc = locals_.get(pid)
        ovr = overrides.get(pid)
        price = None
        if ovr is not None and ovr.price is not None:
            price = float(ovr.price)
        elif g is not None and g.price is not None:
            price = float(g.price)
        out[pid] = {
            "tillProductId": str(loc.id) if loc is not None else pid,
            "inAssortment": bool(ovr is not None and ovr.is_listed),
            "price": price,
        }
    return out


def _supports(kind: str, supported_kinds: Optional[Iterable[str]]) -> bool:
    """Whether a client that said [supported_kinds] (None: said nothing — goods only) can apply [kind]."""
    if kind not in RULES.DISCOUNT_KINDS:
        return True
    return kind in set(supported_kinds or ())


def _reservation_live(r: PrepaidVoucherReservation, now: datetime) -> bool:
    return r.status == "held" and _utc(r.expires_at) > now


def _held_uses(db: Session, voucher: PrepaidVoucher, now: datetime, exclude_id=None) -> int:
    """Uses held right now by open sales (unexpired reservations), [exclude_id] left out."""
    q = db.query(PrepaidVoucherReservation).filter(
        PrepaidVoucherReservation.voucher_id == voucher.id,
        PrepaidVoucherReservation.status == "held",
    )
    return sum(
        int(r.uses or 1) for r in q
        if _reservation_live(r, now) and (exclude_id is None or r.id != exclude_id)
    )


def _local_day_bounds(db: Session, tenant_id, now: datetime):
    """The tenant's local day around [now], as UTC bounds (what a daily limit counts in)."""
    from app.services.reports import _load_zoneinfo, resolve_report_timezone

    zone = _load_zoneinfo(resolve_report_timezone(db, tenant_id, None))
    local = now.astimezone(zone)
    start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.astimezone(timezone.utc), (start + timedelta(days=1)).astimezone(timezone.utc)


def _used_today(db: Session, voucher: PrepaidVoucher, now: datetime, exclude_redemption=None) -> int:
    start, end = _local_day_bounds(db, voucher.tenant_id, now)
    rows = db.query(PrepaidVoucherRedemption).filter(
        PrepaidVoucherRedemption.voucher_id == voucher.id,
        PrepaidVoucherRedemption.reversed_at.is_(None),
    )
    total = 0
    for r in rows:
        at = _utc(r.redeemed_at)
        if at is not None and start <= at < end and (exclude_redemption is None or r.id != exclude_redemption):
            total += int(r.uses or 1)
    return total


def uses_open(db: Session, voucher: PrepaidVoucher, now: Optional[datetime] = None, exclude_id=None) -> Dict[str, int]:
    """
    A discount voucher's uses as a sale may take them now: `available` (left, less those
    held by other open sales), `today` (what the daily limit still allows, held ones
    counted; the uses left when there is no limit) and `perSale`.
    """
    now = now or _now()
    batch = voucher.batch
    held = _held_uses(db, voucher, now, exclude_id)
    available = max(0, int(voucher.uses_left or 0) - held)
    today = available
    if batch.max_uses_per_day:
        today = max(0, int(batch.max_uses_per_day) - _used_today(db, voucher, now) - held)
    return {"available": available, "today": today, "perSale": int(batch.max_uses_per_sale or 1)}


def _expanded_categories(db: Session, tenant_id, ids: Iterable[str]) -> List[str]:
    """A category means it and every sub-category under it (as promotions do)."""
    from app.services.promotions import _category_tree, _with_descendants

    ids = [str(i) for i in ids]
    return _with_descendants(ids, _category_tree(db, tenant_id)) if ids else []


def benefit_for_till(db: Session, machine: POSMachine, batch: PrepaidVoucherBatch) -> Optional[Dict[str, Any]]:
    """A discount batch's terms as the till applies them (agorot / basis points, every id it may meet)."""
    if not is_discount(batch):
        return None
    targets = batch.targets or {}
    product_ids = [str(p) for p in targets.get("productIds") or []]
    till_ids = [v["tillProductId"] for v in _till_products(db, machine, product_ids).values()]
    return {
        "kind": batch.kind,
        "discountType": batch.discount_type,
        # Agorot for a fixed discount, basis points (2000 = 20%) for a percent.
        "value": int(batch.discount_value or 0),
        "minPurchaseAgorot": batch.min_purchase,
        "maxDiscountAgorot": batch.max_discount,
        "maxUnits": batch.max_units,
        "productIds": list(dict.fromkeys(product_ids + till_ids)),
        "categoryIds": _expanded_categories(db, batch.tenant_id, targets.get("categoryIds") or []),
        "names": list(targets.get("names") or []),
        "promotionPolicy": batch.promotion_policy or "exclude",
        "text": RULES.batch_benefit_text(batch),
    }


def _benefit_rules(db: Session, batch: PrepaidVoucherBatch) -> RULES.Benefit:
    """The batch's [RULES.Benefit] with its categories expanded, for the cloud's own check."""
    base = RULES.benefit_of(batch)
    cats = _expanded_categories(db, batch.tenant_id, (batch.targets or {}).get("categoryIds") or [])
    return RULES.Benefit(**{**base.__dict__, "category_ids": frozenset(cats)})


def till_view(
    db: Session,
    machine: POSMachine,
    voucher: PrepaidVoucher,
    supported_kinds: Optional[Iterable[str]] = ALL_KINDS,
    *,
    exclude_reservation=None,
) -> Dict[str, Any]:
    batch = voucher.batch
    reason = refusal_reason(db, machine, voucher)
    message = None
    if reason is None and not _supports(batch.kind or "items", supported_kinds):
        # A client that cannot apply a discount (the web / Windows kiosks today) never
        # treats one as goods: it is not redeemable there, and the customer is told why.
        reason, message = KIND_UNSUPPORTED, KIND_UNSUPPORTED_MESSAGE
    uses = (
        uses_open(db, voucher, exclude_id=exclude_reservation)
        if is_discount(batch) and reason is None else None
    )
    if uses is not None and uses["available"] <= 0:
        reason = IN_USE
    elif uses is not None and uses["today"] <= 0:
        reason = DAILY_LIMIT
    till = _till_products(db, machine, [str(i.product_id) for i in batch.items])
    items = []
    for row in _remaining_out(batch, voucher):
        extra = till.get(row["productId"], {})
        items.append({
            "productId": row["productId"],
            "tillProductId": extra.get("tillProductId", row["productId"]),
            "name": row["name"],
            "quantity": row["quantity"],
            "remaining": row["remaining"],
            "inAssortment": extra.get("inAssortment", False),
            "price": extra.get("price"),
        })
    return {
        "id": str(voucher.id),
        "serial": int(voucher.serial),
        "displayCode": format_code(voucher.code),
        "batchName": batch.name,
        "eventName": batch.event_name,
        "freeText": batch.free_text,
        "validFrom": _iso(batch.valid_from),
        "validUntil": _iso(batch.valid_until),
        "splitAllowed": bool(batch.split_allowed),
        "status": voucher.status,
        "redeemable": reason is None,
        "reason": reason,
        "items": items,
        "lastRedeemedAt": _iso(voucher.last_redeemed_at),
        # The dashboard's free-text note on this voucher, for the cashier to see.
        "note": voucher.note,
        # Kinds (docs/SPEC_VOUCHER_PRODUCTION.md §7). An older till reads none of these
        # and only ever gets a goods voucher as redeemable (see `supportedKinds`).
        "voucherId": str(voucher.id),
        "batchId": str(batch.id),
        "kind": batch.kind or "items",
        "stacking": batch.stacking or "single",
        "message": message,
        "benefit": benefit_for_till(db, machine, batch),
        "usesLeft": voucher.uses_left,
        "usesPerVoucher": int(batch.uses_per_voucher or 1) if is_discount(batch) else None,
        "usesAvailable": uses["available"] if uses else None,
        "usesToday": uses["today"] if uses else None,
        "maxUsesPerSale": int(batch.max_uses_per_sale or 1) if is_discount(batch) else None,
        "maxUsesPerDay": batch.max_uses_per_day if is_discount(batch) else None,
    }


def lookup(
    db: Session, machine: POSMachine, raw_code: str, supported_kinds: Optional[Iterable[str]] = None
) -> Dict[str, Any]:
    voucher = _locate(db, machine, raw_code, lock=False)
    return till_view(db, machine, voucher, supported_kinds)


def _requested(db: Session, machine: POSMachine, batch: PrepaidVoucherBatch, items) -> "Counter[str]":
    """The request's quantities per global product id; till ids are mapped back."""
    on_voucher = {str(i.product_id) for i in batch.items}
    till = _till_products(db, machine, on_voucher)
    by_any = {pid: pid for pid in on_voucher}
    by_any.update({v["tillProductId"]: pid for pid, v in till.items()})
    wanted: "Counter[str]" = Counter()
    for item in items:
        key = str(item.product_id).strip().lower()
        pid = by_any.get(key) or next((g for k, g in by_any.items() if k.lower() == key), None)
        if pid is None:
            raise _http(status.HTTP_400_BAD_REQUEST, ITEM_NOT_ON_VOUCHER)
        wanted[pid] += int(item.quantity)
    return wanted


def redeem(db: Session, machine: POSMachine, body) -> Dict[str, Any]:
    """
    Take goods off a voucher. The caller commits. See the module docstring for the rules;
    the order here matters: lock, then idempotency, then every check, then the write.
    """
    voucher = _locate(db, machine, body.code, lock=True)
    request_id = body.client_request_id.strip()

    prior = (
        db.query(PrepaidVoucherRedemption)
        .filter(
            PrepaidVoucherRedemption.machine_id == machine.id,
            PrepaidVoucherRedemption.client_request_id == request_id,
        )
        .first()
    )
    if prior is not None:
        if prior.voucher_id != voucher.id:
            raise _http(status.HTTP_409_CONFLICT, REQUEST_CONFLICT)
        return _redeem_out(db, machine, voucher, prior, replayed=True)

    reason = refusal_reason(db, machine, voucher)
    if reason is not None:
        raise _http(status.HTTP_409_CONFLICT, reason)

    batch = voucher.batch
    if is_discount(batch):
        # A discount is never taken as goods (nor as a tender): reserve → confirm.
        raise _http(status.HTTP_409_CONFLICT, KIND_UNSUPPORTED)
    sale_ref = (getattr(body, "sale_ref", None) or "").strip() or None
    if sale_ref:
        refusal = RULES.stacking_refusal(_vouchers_in_sale(db, machine, sale_ref), _in_sale(voucher))
        if refusal is not None:
            raise _http(status.HTTP_409_CONFLICT, refusal)
    remaining = {k: int(v) for k, v in (voucher.remaining or {}).items()}
    wanted = _requested(db, machine, batch, body.items)
    for pid, qty in wanted.items():
        if qty > remaining.get(pid, 0):
            raise _http(status.HTTP_409_CONFLICT, INSUFFICIENT)

    names = {str(i.product_id): i.product_name for i in batch.items}
    order = [str(i.product_id) for i in batch.items]
    left = {pid: remaining.get(pid, 0) - wanted.get(pid, 0) for pid in remaining}
    forfeited: List[Dict[str, Any]] = []
    if any(q > 0 for q in left.values()) and not batch.split_allowed:
        if not body.forfeit_rest:
            raise _http(status.HTTP_409_CONFLICT, PARTIAL_NOT_ALLOWED)
        forfeited = [
            {"productId": pid, "name": names.get(pid), "quantity": left[pid]}
            for pid in order
            if left.get(pid, 0) > 0
        ]
        left = {pid: 0 for pid in left}

    now = _now()
    redemption = PrepaidVoucherRedemption(
        id=uuid.uuid4(),
        tenant_id=voucher.tenant_id,
        voucher_id=voucher.id,
        batch_id=batch.id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        pos_user_id=(body.pos_user_id or None),
        pos_user_name=(body.pos_user_name or None),
        client_request_id=request_id,
        transaction_id=(body.transaction_id or None),
        sale_ref=sale_ref,
        items=[
            {"productId": pid, "name": names.get(pid), "quantity": wanted[pid]}
            for pid in order
            if wanted.get(pid)
        ],
        forfeited=forfeited or None,
        redeemed_at=now,
    )
    voucher.remaining = left  # a new dict: JSON columns only notice reassignment
    voucher.status = "used" if not any(q > 0 for q in left.values()) else "partially_used"
    voucher.first_redeemed_at = voucher.first_redeemed_at or now
    voucher.last_redeemed_at = now
    voucher.updated_at = now
    db.add(redemption)
    try:
        db.flush()
    except IntegrityError:
        # Only the (machine, request id) key can collide; the lock makes this a
        # backstop for a database without row locks.
        db.rollback()
        raise _http(status.HTTP_409_CONFLICT, REQUEST_CONFLICT)
    return _redeem_out(db, machine, voucher, redemption, replayed=False)


def reverse_redemption(db: Session, machine: POSMachine, redemption_id: str) -> Dict[str, Any]:
    """
    Undo a redemption this till took — the payment it was part of was abandoned. The goods
    (and anything forfeited with it) go back on the voucher; the row stays, marked
    reversed. Idempotent: reversing twice answers the same. The caller commits.
    """
    rid = _as_uuid(redemption_id)
    redemption = (
        db.query(PrepaidVoucherRedemption)
        .filter(PrepaidVoucherRedemption.id == rid, PrepaidVoucherRedemption.machine_id == machine.id)
        .first()
        if rid is not None
        else None
    )
    if redemption is None:
        raise _http(status.HTTP_404_NOT_FOUND, "prepaid_redemption_not_found")
    voucher = (
        db.query(PrepaidVoucher)
        .filter(PrepaidVoucher.id == redemption.voucher_id)
        .with_for_update()
        .first()
    )
    if redemption.reversed_at is None and voucher is not None:
        remaining = {k: int(v) for k, v in (voucher.remaining or {}).items()}
        for row in list(redemption.items or []) + list(redemption.forfeited or []):
            pid = str(row.get("productId"))
            remaining[pid] = remaining.get(pid, 0) + int(row.get("quantity") or 0)
        now = _now()
        voucher.remaining = remaining
        if redemption.uses:
            # A discount voucher's use comes back as a use.
            voucher.uses_left = int(voucher.uses_left or 0) + int(redemption.uses)
        if voucher.status != "cancelled":
            others = (
                db.query(PrepaidVoucherRedemption.id)
                .filter(
                    PrepaidVoucherRedemption.voucher_id == voucher.id,
                    PrepaidVoucherRedemption.id != redemption.id,
                    PrepaidVoucherRedemption.reversed_at.is_(None),
                )
                .first()
            )
            voucher.status = "partially_used" if others is not None else "active"
        voucher.updated_at = now
        redemption.reversed_at = now
        db.flush()
    return {"ok": True, "redemptionId": str(redemption.id), "reversedAt": _iso(redemption.reversed_at)}


def attach_transaction(db: Session, machine: POSMachine, redemption_id: str, transaction_id: str) -> None:
    """Name the sale document a redemption paid towards (set once). The caller commits."""
    rid = _as_uuid(redemption_id)
    redemption = (
        db.query(PrepaidVoucherRedemption)
        .filter(PrepaidVoucherRedemption.id == rid, PrepaidVoucherRedemption.machine_id == machine.id)
        .first()
        if rid is not None
        else None
    )
    if redemption is None:
        raise _http(status.HTTP_404_NOT_FOUND, "prepaid_redemption_not_found")
    if not redemption.transaction_id:
        redemption.transaction_id = str(transaction_id)[:100]
        db.flush()


def _redeem_out(
    db: Session,
    machine: POSMachine,
    voucher: PrepaidVoucher,
    redemption: PrepaidVoucherRedemption,
    *,
    replayed: bool,
) -> Dict[str, Any]:
    till = _till_products(db, machine, [str(i.product_id) for i in voucher.batch.items])

    def with_till(rows):
        return [
            {
                **r,
                "tillProductId": till.get(r["productId"], {}).get("tillProductId", r["productId"]),
                "price": till.get(r["productId"], {}).get("price"),
            }
            for r in (rows or [])
        ]

    return {
        "ok": True,
        "replayed": replayed,
        "redemptionId": str(redemption.id),
        "redeemedAt": _iso(redemption.redeemed_at),
        "redeemed": with_till(redemption.items),
        "forfeited": with_till(redemption.forfeited),
        "voucher": till_view(db, machine, voucher),
    }


# ── Till: discount vouchers — reserve → confirm / release ────────────────────


def _in_sale(voucher: PrepaidVoucher) -> RULES.VoucherInSale:
    batch = voucher.batch
    return RULES.VoucherInSale(
        voucher_id=str(voucher.id),
        batch_id=str(batch.id),
        kind=batch.kind or "items",
        stacking=batch.stacking or "single",
    )


def _vouchers_in_sale(
    db: Session,
    machine: POSMachine,
    sale_ref: Optional[str],
    *,
    transaction_id: Optional[str] = None,
    exclude_reservation=None,
    reported: Iterable = (),
) -> List[RULES.VoucherInSale]:
    """
    The other vouchers the cloud knows in one sale: discount vouchers held or confirmed for
    it, goods vouchers redeemed towards it (by the sale, or by its document once written),
    and what the till says it holds ([reported] — e.g. a kiosk order's vouchers).
    """
    now = _now()
    seen: Dict[str, RULES.VoucherInSale] = {}

    def add(v: Optional[PrepaidVoucher]) -> None:
        if v is not None and str(v.id) not in seen:
            seen[str(v.id)] = _in_sale(v)

    if sale_ref:
        for r in db.query(PrepaidVoucherReservation).filter(
            PrepaidVoucherReservation.machine_id == machine.id,
            PrepaidVoucherReservation.sale_ref == sale_ref,
        ):
            if r.id == exclude_reservation:
                continue
            if r.status == "confirmed" or _reservation_live(r, now):
                add(r.voucher)
    redemption_filters = []
    if sale_ref:
        redemption_filters.append(PrepaidVoucherRedemption.sale_ref == sale_ref)
    if transaction_id:
        redemption_filters.append(PrepaidVoucherRedemption.transaction_id == transaction_id)
    if redemption_filters:
        from sqlalchemy import or_

        for r in db.query(PrepaidVoucherRedemption).filter(
            PrepaidVoucherRedemption.machine_id == machine.id,
            PrepaidVoucherRedemption.reversed_at.is_(None),
            or_(*redemption_filters),
        ):
            if r.reservation_id is not None and r.reservation_id == exclude_reservation:
                continue
            add(r.voucher)
    for other in reported or ():
        vid = str(getattr(other, "voucher_id", "") or "")
        if vid and vid not in seen:
            seen[vid] = RULES.VoucherInSale(
                voucher_id=vid,
                batch_id=str(getattr(other, "batch_id", "") or ""),
                kind=getattr(other, "kind", None) or "items",
                stacking=getattr(other, "stacking", None) or "single",
            )
    return list(seen.values())


def _basket(lines) -> List[RULES.BasketLine]:
    return [
        RULES.BasketLine(
            id=str(line.id),
            product_ids=tuple(str(p) for p in line.product_ids),
            category_ids=tuple(str(c) for c in line.category_ids),
            quantity=float(line.quantity),
            gross=int(line.gross_agorot),
            line_discount=int(line.line_discount_agorot),
            promotion=int(line.promotion_agorot),
            voucher=int(line.voucher_agorot),
            discountable=bool(line.discountable),
        )
        for line in lines or []
    ]


def _reservation_out(
    db: Session,
    machine: POSMachine,
    voucher: PrepaidVoucher,
    r: PrepaidVoucherReservation,
    *,
    replayed: bool,
    result: Optional[RULES.DiscountResult] = None,
) -> Dict[str, Any]:
    out = {
        "ok": True,
        "replayed": replayed,
        "reservationId": str(r.id),
        "status": r.status if r.status != "held" or _reservation_live(r, _now()) else "expired",
        "expiresAt": _iso(r.expires_at),
        "uses": int(r.uses or 1),
        "amountAgorot": int(r.amount or 0),
        "amount": _shekels_out(r.amount or 0),
        "transactionId": r.transaction_id,
        # As this sale sees it: its own hold is not "in use elsewhere".
        "voucher": till_view(db, machine, voucher, exclude_reservation=r.id),
    }
    if result is not None:
        out["shares"] = dict(result.shares)
        out["dropPromotion"] = list(result.drop_promotion)
        out["skipped"] = [{"lineId": lid, "reason": why} for lid, why in result.skipped]
    return out


def reserve(db: Session, machine: POSMachine, body) -> Dict[str, Any]:
    """
    Hold a discount voucher for one open sale at this till, under the voucher's lock: the
    voucher's state and validity, the client's support of its kind, the uses (left, held by
    other sales, per sale, per day), stacking with the sale's other vouchers, and what it
    takes off the basket the till sent (the shared rules — promotions per line, minimum
    purchase, eligible items). The caller commits.

    The same `clientRequestId` again renews it (held for the full time again, the basket
    re-checked) — or answers a confirmed one as it stands; a released one is refused.
    """
    voucher = _locate(db, machine, body.code, lock=True)
    batch = voucher.batch
    now = _now()
    request_id = body.client_request_id.strip()
    sale_ref = body.sale_ref.strip()

    prior = (
        db.query(PrepaidVoucherReservation)
        .filter(
            PrepaidVoucherReservation.machine_id == machine.id,
            PrepaidVoucherReservation.client_request_id == request_id,
        )
        .first()
    )
    if prior is not None:
        if prior.voucher_id != voucher.id or prior.sale_ref != sale_ref:
            raise _http(status.HTTP_409_CONFLICT, REQUEST_CONFLICT)
        if prior.status == "confirmed":
            return _reservation_out(db, machine, voucher, prior, replayed=True)
        if prior.status == "released":
            raise _http(status.HTTP_409_CONFLICT, RESERVATION_RELEASED)

    if not is_discount(batch):
        # Goods are redeemed (a tender), never reserved.
        raise _http(status.HTTP_409_CONFLICT, KIND_UNSUPPORTED)
    if not _supports(batch.kind, body.supported_kinds or ALL_KINDS):
        raise _http(status.HTTP_409_CONFLICT, KIND_UNSUPPORTED)
    reason = refusal_reason(db, machine, voucher, now)
    if reason is not None:
        raise _http(status.HTTP_409_CONFLICT, reason)

    exclude = prior.id if prior is not None else None
    refusal = RULES.stacking_refusal(
        _vouchers_in_sale(db, machine, sale_ref, exclude_reservation=exclude, reported=body.other_vouchers),
        _in_sale(voucher),
    )
    if refusal is not None:
        raise _http(status.HTTP_409_CONFLICT, refusal)

    uses = uses_open(db, voucher, now, exclude_id=exclude)
    if uses["available"] <= 0:
        raise _http(status.HTTP_409_CONFLICT, IN_USE if int(voucher.uses_left or 0) > 0 else USED)
    if uses["today"] <= 0:
        raise _http(status.HTTP_409_CONFLICT, DAILY_LIMIT)
    granted = max(1, min(int(body.uses or 1), uses["perSale"], uses["available"], uses["today"]))

    result = RULES.discount_for(_benefit_rules(db, batch), _basket(body.lines), granted)
    if result.refusal is not None:
        raise _http(status.HTTP_409_CONFLICT, result.refusal)

    if prior is not None:
        # Renewed: held again for the full time, for what the basket comes to now.
        prior.uses = granted
        prior.amount = result.amount
        prior.expires_at = now + RESERVATION_TTL
        prior.updated_at = now
        db.flush()
        return _reservation_out(db, machine, voucher, prior, replayed=True, result=result)

    r = PrepaidVoucherReservation(
        id=uuid.uuid4(),
        tenant_id=voucher.tenant_id,
        voucher_id=voucher.id,
        batch_id=batch.id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        client_request_id=request_id,
        sale_ref=sale_ref,
        uses=granted,
        amount=result.amount,
        status="held",
        expires_at=now + RESERVATION_TTL,
        pos_user_id=(body.pos_user_id or None),
        pos_user_name=(body.pos_user_name or None),
        created_at=now,
        updated_at=now,
    )
    db.add(r)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise _http(status.HTTP_409_CONFLICT, REQUEST_CONFLICT)
    return _reservation_out(db, machine, voucher, r, replayed=False, result=result)


def _reservation(db: Session, machine: POSMachine, reservation_id, *, any_till: bool = False) -> PrepaidVoucherReservation:
    rid = _as_uuid(reservation_id)
    q = db.query(PrepaidVoucherReservation).filter(PrepaidVoucherReservation.id == rid) if rid else None
    r = q.first() if q is not None else None
    if r is None or str(r.tenant_id) != str(machine.tenant_id):
        raise _http(status.HTTP_404_NOT_FOUND, RESERVATION_NOT_FOUND)
    if not any_till and r.machine_id != machine.id:
        raise _http(status.HTTP_404_NOT_FOUND, RESERVATION_NOT_FOUND)
    return r


def release(db: Session, machine: POSMachine, reservation_id) -> Dict[str, Any]:
    """
    Give a held voucher back (removed from the basket, the sale abandoned). Idempotent; a
    confirmed one stays confirmed (its sale was written). The caller commits.
    """
    r = _reservation(db, machine, reservation_id)
    if r.status == "held":
        now = _now()
        r.status = "released"
        r.released_at = now
        r.updated_at = now
        db.flush()
    return {"ok": True, "reservationId": str(r.id), "status": r.status, "releasedAt": _iso(r.released_at)}


def _promotion_breaches(policy: str, lines: Iterable[Dict[str, Any]]) -> bool:
    """Whether the document's lines break the batch's promotion policy (lines: {share, promotion})."""
    for line in lines:
        share, promotion = int(line.get("share") or 0), int(line.get("promotion") or 0)
        if share <= 0 or promotion <= 0:
            continue
        if policy in ("exclude", "best"):
            return True
    return False


def confirm(
    db: Session,
    machine: POSMachine,
    reservation_id,
    transaction_id: str,
    amount_agorot: int,
    uses: Optional[int] = None,
    *,
    document_lines: Optional[List[Dict[str, Any]]] = None,
    any_till: bool = False,
) -> Dict[str, Any]:
    """
    The sale was written: take the voucher's uses and record the use (a redemption row with
    the ₪ it took off). Idempotent — the same reservation and document answer the same; a
    later call (the document itself, through the outbox) updates the amount to what the
    document says. A reservation that expired or was released meanwhile is still
    confirmed (the sale is a fiscal fact by now) and flagged `late`; uses, stacking and the
    promotion policy are checked again and a breach is flagged, never refused. The caller
    commits.
    """
    r = _reservation(db, machine, reservation_id, any_till=any_till)
    transaction_id = str(transaction_id).strip()[:100]
    voucher = db.query(PrepaidVoucher).filter(PrepaidVoucher.id == r.voucher_id).with_for_update().first()
    if voucher is None:
        raise _http(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    batch = voucher.batch
    now = _now()
    amount_agorot = max(0, int(amount_agorot))

    if r.status == "confirmed":
        if r.transaction_id and r.transaction_id != transaction_id:
            raise _http(status.HTTP_409_CONFLICT, RESERVATION_CONFLICT)
        redemption = (
            db.query(PrepaidVoucherRedemption).filter(PrepaidVoucherRedemption.id == r.redemption_id).first()
            if r.redemption_id else None
        )
        if redemption is not None:
            # The document is what was taken; a breach it shows is flagged on the use.
            redemption.discount_amount = amount_agorot
            if document_lines is not None and _promotion_breaches(batch.promotion_policy or "exclude", document_lines):
                _flag(db, batch, voucher, redemption, ["promotion"])
        db.flush()
        return _confirm_out(r, redemption, replayed=True)

    flags: List[str] = []
    if r.status != "held" or not _reservation_live(r, now):
        flags.append("late")
    take = max(1, int(uses or r.uses or 1))
    left = int(voucher.uses_left or 0)
    if take > left:
        flags.append("over_use")
    if take > int(batch.max_uses_per_sale or 1):
        flags.append("over_sale")
    if batch.max_uses_per_day and _used_today(db, voucher, now) + take > int(batch.max_uses_per_day):
        flags.append("over_daily")
    others = _vouchers_in_sale(db, machine, r.sale_ref, transaction_id=transaction_id, exclude_reservation=r.id)
    if RULES.stacking_refusal([o for o in others if o.voucher_id != str(voucher.id)], _in_sale(voucher)):
        flags.append("stacking")
    if document_lines is not None and _promotion_breaches(batch.promotion_policy or "exclude", document_lines):
        flags.append("promotion")

    redemption = PrepaidVoucherRedemption(
        id=uuid.uuid4(),
        tenant_id=voucher.tenant_id,
        voucher_id=voucher.id,
        batch_id=batch.id,
        machine_id=r.machine_id,
        shop_id=r.shop_id,
        pos_user_id=r.pos_user_id,
        pos_user_name=r.pos_user_name,
        client_request_id=f"reservation:{r.id}",
        transaction_id=transaction_id,
        sale_ref=r.sale_ref,
        items=[],
        uses=take,
        discount_amount=amount_agorot,
        reservation_id=r.id,
        flags=flags or None,
        redeemed_at=now,
    )
    voucher.uses_left = max(0, left - take)
    voucher.status = "used" if voucher.uses_left == 0 else "partially_used"
    voucher.first_redeemed_at = voucher.first_redeemed_at or now
    voucher.last_redeemed_at = now
    voucher.updated_at = now
    r.status = "confirmed"
    r.transaction_id = transaction_id
    r.confirmed_at = now
    r.updated_at = now
    r.uses = take
    r.redemption_id = redemption.id
    db.add(redemption)
    if flags:
        _event(
            db, batch, None, "use_flagged", group_no=voucher.group_no, voucher_id=voucher.id, count=take,
            details={"serial": voucher.serial, "flags": flags, "transactionId": transaction_id},
        )
    db.flush()
    return _confirm_out(r, redemption, replayed=False)


def _flag(db: Session, batch, voucher, redemption: PrepaidVoucherRedemption, more: List[str]) -> None:
    have = list(redemption.flags or [])
    new = [f for f in more if f not in have]
    if not new:
        return
    redemption.flags = have + new  # a new list: JSON columns only notice reassignment
    _event(
        db, batch, None, "use_flagged", group_no=voucher.group_no, voucher_id=voucher.id, count=redemption.uses,
        details={"serial": voucher.serial, "flags": new, "transactionId": redemption.transaction_id},
    )


def _confirm_out(r: PrepaidVoucherReservation, redemption: Optional[PrepaidVoucherRedemption], *, replayed: bool) -> Dict[str, Any]:
    return {
        "ok": True,
        "replayed": replayed,
        "reservationId": str(r.id),
        "status": r.status,
        "transactionId": r.transaction_id,
        "redemptionId": str(redemption.id) if redemption is not None else None,
        "uses": int(r.uses or 1),
        "amountAgorot": int(redemption.discount_amount or 0) if redemption is not None else None,
        "flags": list(redemption.flags or []) if redemption is not None else [],
    }


def confirm_from_document(db: Session, machine: POSMachine, transaction_id, entries, items) -> List[str]:
    """
    A sale document reached the cloud (the till's outbox) carrying its discount vouchers:
    each is confirmed against its reservation — the path that never fails, whatever happened
    to the till's own confirm call. Never refuses the document: what cannot be linked is
    returned as warnings. [items] are the document's lines (for the promotion re-check).
    """
    from decimal import Decimal

    warnings: List[str] = []
    promo_of = {str(it.id): getattr(it, "promotion_discount", None) for it in items or []}
    for n, entry in enumerate(entries or []):
        rid = getattr(entry, "reservation_id", None)
        if not rid:
            continue
        amount = int((Decimal(str(entry.amount or 0)).copy_abs() * 100).to_integral_value())
        lines = []
        for line in getattr(entry, "lines", None) or []:
            item_id = str(line.get("itemId") or "") if isinstance(line, dict) else ""
            share = Decimal(str((line.get("amount") if isinstance(line, dict) else 0) or 0)).copy_abs()
            promo = Decimal(str(promo_of.get(item_id) or 0)).copy_abs()
            lines.append({"share": int(share * 100), "promotion": int(promo * 100)})
        try:
            confirm(
                db, machine, rid, str(transaction_id), amount, getattr(entry, "uses", None),
                document_lines=lines, any_till=True,
            )
        except HTTPException as e:
            warnings.append(f"voucherDiscounts[{n}].reservationId: {e.detail}, not confirmed")
    return warnings
