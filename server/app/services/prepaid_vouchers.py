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
"""
from __future__ import annotations

import secrets
import uuid
from collections import Counter, OrderedDict
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherBatchItem,
    PrepaidVoucherEvent,
    PrepaidVoucherRedemption,
)
from app.models.product import CatalogLevel, Product
from app.models.shop import Shop
from app.models.shop_product_override import ShopProductOverride
from app.models.user import User, UserRole
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


def _validate_products(db: Session, tenant_id, company_id, items) -> List[Product]:
    related = {str(c) for c in descendant_company_ids(db, company_id)} | {
        str(c) for c in ancestor_company_ids(db, company_id)
    }
    products: List[Product] = []
    for item in items:
        p = db.query(Product).filter(Product.id == item.product_id).first()
        ok = (
            p is not None
            and str(p.tenant_id) == str(tenant_id)
            and p.catalog_level == CatalogLevel.GLOBAL
            and p.pos_machine_id is None
            and not bool(getattr(p, "is_general", False))
            and not bool(getattr(p, "is_weighed", False))
            and (p.company_id is None or str(p.company_id) in related)
        )
        if not ok:
            raise _http(status.HTTP_400_BAD_REQUEST, PRODUCT_INVALID)
        products.append(p)
    return products


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
    remaining = {str(i.product_id): int(i.quantity) for i in batch.items}
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
    # Print settings are never cleared by a null: they always have a value.
    for key in ("show_code", "barcode_type"):
        if key in fields and fields[key] is None:
            fields.pop(key)
    changed = sorted(k for k, v in fields.items() if getattr(batch, k) != v)
    for key, value in fields.items():
        setattr(batch, key, value)
    if batch.valid_from and batch.valid_until and _utc(batch.valid_until) <= _utc(batch.valid_from):
        raise _http(status.HTTP_400_BAD_REQUEST, "validUntil must be after validFrom")
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
    if voucher.status == "used" or not any(int(q) > 0 for q in (voucher.remaining or {}).values()):
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


def till_view(db: Session, machine: POSMachine, voucher: PrepaidVoucher) -> Dict[str, Any]:
    batch = voucher.batch
    reason = refusal_reason(db, machine, voucher)
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
    }


def lookup(db: Session, machine: POSMachine, raw_code: str) -> Dict[str, Any]:
    voucher = _locate(db, machine, raw_code, lock=False)
    return till_view(db, machine, voucher)


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
