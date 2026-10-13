"""
"מימוש ידני מהענן" — the owner, 12.10.2026: "תאפשר דרך הענן לנצל ידני כי הסורק לא עבד". At an event
the scanner failed and customers were served anyway; a manager records those redemptions from the
dashboard.

* **The till's rules.** Validity at the moment it happened (`occurredAt`, default now — never in the
  future), the shop among the batch's (`validShops` / its company group), the status, an offline
  assignment, the controls (pauses, quotas, a staff test voucher), what is left per product / group /
  in all, uses and the daily limit, a one-time voucher taken in part. Refusals are 409s with the
  till's words (`{"code", "message"}`, Hebrew).
* **Test mode** ("מצב בדיקה"): refused — "הסדרה במצב בדיקה — מימוש ידני לא נרשם".
* **The till's write.** Goods (a fixed list or item groups — a punch card is one group) go through the
  goods reserve → confirm code (app/services/production_voucher_reserve.py): chosen, valued, the
  override applied (the dashboard user is the approving manager), a hold confirmed at once — the
  balance, the status, "כמה מתוך כמה", reports and settlement count it like any till's. A discount
  voucher's uses come off as the till's confirm takes them. The row is marked `source="dashboard"`,
  `manual`, with who and why; the redemption's time is when it happened.
* **Idempotent** by `clientRequestId` (or `Idempotency-Key`), per voucher in bulk.
* **One click** ("סמן כמומש"): everything left, the default reason; a super admin may force it past
  expiry, not-yet-valid and another shop (never a used / cancelled voucher, never test mode) — the
  forced rules are on the row (`manual_override`) and in the audit.
* **Undo**: a manual redemption only (a till's belongs to its sale document) — what it took goes
  back, the row stays, marked reversed with why.
* **Who**: the batch's managers (`may_manage`) with the `prepaid_voucher_redeem` section ("מימוש
  ידני של שוברים") or edit on `prepaid_vouchers`; a super admin always.
* **Audit**: every manual redemption and undo is a line of the batch's trail: "מימוש ידני מהענן ·
  {user} · {reason}".
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherRedemption,
    PrepaidVoucherReservation,
)
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services import prepaid_vouchers as PV
from app.services import production_voucher_groups as PG
from app.services import production_voucher_reserve as PVRG
from app.services import production_voucher_rules as PR

SOURCE = "dashboard"
#: The dashboard permission ("מימוש ידני של שוברים"); edit on `prepaid_vouchers` also allows it.
SECTION = "prepaid_voucher_redeem"
EDIT_SECTION = "prepaid_vouchers"
DEFAULT_REASON = "מימוש ידני"
EVENT_REDEEM = "manual_redeem"
EVENT_REVERSE = "manual_redeem_reversed"
#: Forgiven to the redemption's clock: a dashboard's and a server's time disagree a little.
FUTURE_SKEW = timedelta(minutes=5)

# ── 4xx details ───────────────────────────────────────────────────────────────
FORBIDDEN = "prepaid_voucher_manual_forbidden"
TEST_MODE = "prepaid_voucher_manual_test_mode"
FUTURE = "prepaid_voucher_manual_future"
REASON_INVALID = "prepaid_voucher_manual_reason"
SHOP_REQUIRED = "prepaid_voucher_manual_shop_required"
MACHINE_INVALID = "prepaid_voucher_manual_machine_invalid"
NOT_MANUAL = "prepaid_voucher_manual_not_manual"
NOTHING = PR.NOTHING_CHOSEN
BAD_REQUEST = "prepaid_voucher_manual_bad_request"

#: What a super admin may force past ("כפייה"). Never a used / cancelled voucher, never test mode.
OVERRIDABLE = (PV.EXPIRED, PV.NOT_YET_VALID, PV.WRONG_SHOP)

TEXT = {
    FORBIDDEN: "אין לך הרשאה למימוש ידני של שוברים",
    TEST_MODE: "הסדרה במצב בדיקה — מימוש ידני לא נרשם",
    FUTURE: "מועד המימוש לא יכול להיות בעתיד",
    REASON_INVALID: "יש לכתוב סיבה (3–200 תווים)",
    SHOP_REQUIRED: "יש לבחור נקודת מכירה",
    MACHINE_INVALID: "הקופה אינה שייכת לנקודת המכירה שנבחרה",
    NOT_MANUAL: "מהענן ניתן לבטל רק מימוש ידני — מימוש בקופה מבוטל בקופה",
    PV.SHOP_INVALID: "נקודת המכירה אינה מוכרת",
    PV.USED: "השובר מומש כבר במלואו",
    PV.CANCELLED: "השובר בוטל",
    PV.EXPIRED: "תוקף השובר הסתיים",
    PV.NOT_YET_VALID: "השובר עדיין לא בתוקף",
    PV.WRONG_SHOP: "השובר אינו תקף בנקודת המכירה הזאת",
    PV.INSUFFICIENT: "אין מספיק יתרה בשובר — {left}",
    PV.PARTIAL_NOT_ALLOWED: "השובר ממומש בעסקה אחת — יש לממש את כל היתרה (או לוותר על השאר)",
    PV.IN_USE: "השובר מוחזק כעת בעסקה פתוחה בקופה — נסו שוב בעוד כמה דקות",
    PV.DAILY_LIMIT: "הגעת למגבלת השימושים היומית של השובר ({n} ביום)",
    PV.ITEM_NOT_ON_VOUCHER: "הפריט אינו כלול בשובר זה",
    PV.QUANTITY_FRACTION: "כמות שבורה מותרת רק בפריט שנמכר במשקל",
    PV.ITEM_UNUSABLE: "אחד הפריטים כבר לא ניתן למימוש (הפך לפריט כללי או עבר לחברה אחרת)",
    PV.REQUEST_CONFLICT: "מזהה הבקשה כבר שימש לשובר אחר",
    PV.NOT_FOUND: "השובר לא נמצא",
    NOTHING: "לא נבחר מה לממש",
    BAD_REQUEST: "הבקשה אינה תקינה",
}
OVERRIDE_TEXT = {
    PV.EXPIRED: "תוקף השובר הסתיים",
    PV.NOT_YET_VALID: "השובר עדיין לא בתוקף",
    PV.WRONG_SHOP: "השובר אינו תקף בנקודת המכירה שנבחרה",
}


# ── Small helpers ─────────────────────────────────────────────────────────────


def _error(code_: int, code: str, message: Optional[str] = None, **extra) -> HTTPException:
    return HTTPException(status_code=code_, detail={"code": code, "message": message or TEXT.get(code) or code, **extra})


def _refuse(code: str, message: Optional[str] = None, **extra) -> HTTPException:
    return _error(status.HTTP_409_CONFLICT, code, message, **extra)


def _worded(db: Session, voucher: Optional[PrepaidVoucher], e: HTTPException, at: Optional[datetime] = None) -> HTTPException:
    """Any refusal of the till's code with its Hebrew: a bare code gets the till's / this module's words."""
    if isinstance(e.detail, dict):
        if not e.detail.get("message"):
            e.detail["message"] = TEXT.get(e.detail.get("code")) or e.detail.get("code")
        return e
    code = str(e.detail)
    message = None
    if voucher is not None:
        try:
            message = PV.refusal_message(db, voucher, code, at)
        except Exception:  # noqa: BLE001 — the words are a nicety; the refusal stands
            message = None
    if message is None and code == PV.INSUFFICIENT and voucher is not None:
        message = TEXT[PV.INSUFFICIENT].format(left=left_text(db, voucher))
    if message is None and code == PV.DAILY_LIMIT and voucher is not None:
        message = TEXT[PV.DAILY_LIMIT].format(n=voucher.batch.max_uses_per_day or 0)
    return HTTPException(status_code=e.status_code, detail={"code": code, "message": message or TEXT.get(code) or code})


def may_redeem(db: Session, user: Optional[User]) -> bool:
    """The `prepaid_voucher_redeem` section, or edit on `prepaid_vouchers` (a super admin: always)."""
    if user is None:
        return False
    if getattr(user, "role", None) == UserRole.SUPER_ADMIN:
        return True
    from app.services.dashboard_access import effective_access

    try:
        access = effective_access(db, user)
        return access.allows(SECTION, "edit") or access.allows(EDIT_SECTION, "edit")
    except Exception:  # noqa: BLE001 — fail closed
        return False


def _require(db: Session, user: User) -> None:
    PV._require_role(user)
    if not may_redeem(db, user):
        raise _error(status.HTTP_403_FORBIDDEN, FORBIDDEN)


def _reason(raw: Optional[str], one_click: bool) -> str:
    text = (raw or "").strip()
    if not text and one_click:
        return DEFAULT_REASON
    if len(text) < 3 or len(text) > 200:
        raise _error(status.HTTP_400_BAD_REQUEST, REASON_INVALID)
    return text


def _when(raw: Optional[datetime]) -> datetime:
    now = PV._now()
    if raw is None:
        return now
    at = PV._utc(raw)
    if at > now + FUTURE_SKEW:
        raise _error(status.HTTP_400_BAD_REQUEST, FUTURE)
    return min(at, now)


def _is_super(user: User) -> bool:
    return getattr(user, "role", None) == UserRole.SUPER_ADMIN


class _Place:
    """Where a manual redemption happened, as the till's code asks a machine: its tenant and shop."""

    def __init__(self, tenant_id, shop: Shop, machine: Optional[POSMachine]):
        self.tenant_id = tenant_id
        self.shop_id = shop.id
        self.shop = shop
        self.machine = machine
        # Never a real till's id when none was named: the till-only look-ups (its own product copies,
        # an offline assignment to "this" device) match nothing.
        self.id = machine.id if machine is not None else uuid.uuid4()
        self.name = machine.name if machine is not None else None

    @property
    def machine_id(self):
        return self.machine.id if self.machine is not None else None


# ── Finding the voucher, the shop ─────────────────────────────────────────────


def _voucher(db: Session, user: User, tenant_id, *, code: Optional[str], voucher_id: Optional[str], lock: bool) -> PrepaidVoucher:
    q = db.query(PrepaidVoucher)
    if voucher_id:
        wanted = PV._as_uuid(voucher_id)
        if wanted is None:
            raise _error(status.HTTP_404_NOT_FOUND, PV.NOT_FOUND)
        q = q.filter(PrepaidVoucher.id == wanted)
    elif code:
        normal = PV.normalize_code(code)
        if len(normal) != PV.CODE_LENGTH:
            raise _error(status.HTTP_404_NOT_FOUND, PV.NOT_FOUND)
        q = q.filter(PrepaidVoucher.code == normal)
    else:
        raise _error(status.HTTP_400_BAD_REQUEST, BAD_REQUEST, "יש לציין קוד שובר")
    q = q.filter(PrepaidVoucher.tenant_id == tenant_id)
    if lock:
        q = q.with_for_update()
    voucher = q.first()
    if voucher is None:
        raise _error(status.HTTP_404_NOT_FOUND, PV.NOT_FOUND)
    if not PV.may_manage(db, user, tenant_id, voucher.batch):
        raise _error(status.HTTP_403_FORBIDDEN, PV.FORBIDDEN, "אין לך הרשאה לסדרה של שובר זה")
    return voucher


def valid_shops(db: Session, user: User, tenant_id, voucher: PrepaidVoucher) -> List[Dict[str, str]]:
    """The shops the voucher may be redeemed in that [user] sees: its named shops, else its company group's."""
    batch = voucher.batch
    q = db.query(Shop.id, Shop.name).filter(Shop.tenant_id == tenant_id)
    if batch.shop_ids:
        ids = [i for i in (PV._as_uuid(s) for s in batch.shop_ids) if i is not None]
        q = q.filter(Shop.id.in_(ids))
    else:
        group = [i for i in (PV._as_uuid(c) for c in PV._company_group(db, batch.company_id)) if i is not None]
        q = q.filter(Shop.company_id.in_(group))
    rows = q.all()
    if not (_is_super(user) or PV._covers_company(db, user, batch.company_id)):
        seen = PV._visible_shop_ids(db, user, tenant_id)
        rows = [r for r in rows if str(r[0]) in seen]
    return [{"id": str(i), "name": n} for i, n in sorted(rows, key=lambda r: (r[1] or "", str(r[0])))]


def _place(db: Session, user: User, tenant_id, voucher: PrepaidVoucher, shop_id: Optional[str], machine_id: Optional[str]) -> _Place:
    if not shop_id:
        # The batch's one valid shop (as the user sees them); else the user picks.
        shops = valid_shops(db, user, tenant_id, voucher)
        if len(shops) != 1:
            raise _error(status.HTTP_400_BAD_REQUEST, SHOP_REQUIRED)
        shop_id = shops[0]["id"]
    sid = PV._as_uuid(shop_id)
    shop = db.query(Shop).filter(Shop.id == sid, Shop.tenant_id == tenant_id).first() if sid else None
    if shop is None:
        raise _error(status.HTTP_400_BAD_REQUEST, PV.SHOP_INVALID)
    if not (_is_super(user) or PV._covers_company(db, user, shop.company_id)
            or str(shop.id) in PV._visible_shop_ids(db, user, tenant_id)):
        raise _error(status.HTTP_403_FORBIDDEN, PV.FORBIDDEN, "אין לך הרשאה לנקודת מכירה זו")
    machine = None
    if machine_id:
        mid = PV._as_uuid(machine_id)
        machine = db.query(POSMachine).filter(POSMachine.id == mid).first() if mid else None
        if machine is None or str(machine.tenant_id) != str(tenant_id) or machine.shop_id != shop.id:
            raise _error(status.HTTP_400_BAD_REQUEST, MACHINE_INVALID)
    return _Place(tenant_id, shop, machine)


# ── The rules ─────────────────────────────────────────────────────────────────


def _used_up(voucher: PrepaidVoucher) -> bool:
    if PV.is_discount(voucher.batch):
        return voucher.status == "used" or int(voucher.uses_left or 0) <= 0
    rem = voucher.remaining or {}
    if voucher.status == "used":
        return True
    if (getattr(voucher.batch, "selection", None) or "items") == "groups" and PG.TOTAL in rem:
        return PV.qty(rem.get(PG.TOTAL)) <= 0
    return not any(PV.qty(q) > 0 for k, q in rem.items() if k != PG.TOTAL)


def refusals(db: Session, place: _Place, voucher: PrepaidVoucher, at: datetime) -> List[str]:
    """
    Every reason the till would refuse [voucher] at [place] at [at], in the till's order
    (`prepaid_vouchers.refusal_reason` stops at the first — here the later ones are wanted too,
    so that a forced rule never hides one that cannot be forced). Cancelled / used end the list.
    """
    batch = voucher.batch
    if batch.status == "cancelled" or voucher.status == "cancelled":
        return [PV.CANCELLED]
    if _used_up(voucher):
        return [PV.USED]
    out: List[str] = []
    if batch.valid_from is not None and at < PV._utc(batch.valid_from):
        out.append(PV.NOT_YET_VALID)
    if batch.valid_until is not None and at > PV._utc(batch.valid_until):
        out.append(PV.EXPIRED)
    from app.services import prepaid_voucher_offline as PVO

    if PVO.assigned_elsewhere(db, place, batch) is not None:
        out.append(PVO.ASSIGNED_OFFLINE)
    shop = place.shop
    if str(shop.company_id) not in PV._company_group(db, batch.company_id) or (
        batch.shop_ids and str(shop.id) not in set(map(str, batch.shop_ids))
    ):
        out.append(PV.WRONG_SHOP)
    from app.services.prepaid_voucher_controls import refusal_reason as controls_refusal

    extra = controls_refusal(db, place, voucher, at)
    if extra is not None:
        out.append(extra)
    return out


def _message(db: Session, place: _Place, voucher: PrepaidVoucher, code: str, at: datetime) -> str:
    from app.services import prepaid_voucher_offline as PVO

    if code == PVO.ASSIGNED_OFFLINE:
        return PVO.assigned_text(db, place, voucher.batch)
    try:
        said = PV.refusal_message(db, voucher, code, at)
    except Exception:  # noqa: BLE001
        said = None
    return said or TEXT.get(code) or code


def _check(db: Session, user: User, place: _Place, voucher: PrepaidVoucher, at: datetime, force: bool) -> List[str]:
    """Refuse as the till would; a super admin's `force` passes [OVERRIDABLE] — returned (the forced rules)."""
    from app.services import prepaid_voucher_test_mode as TM

    if TM.in_test_mode(voucher.batch):
        raise _refuse(TEST_MODE)
    forced: List[str] = []
    for code in refusals(db, place, voucher, at):
        if force and _is_super(user) and code in OVERRIDABLE:
            forced.append(code)
            continue
        raise _refuse(code, _message(db, place, voucher, code, at), overridable=(
            code in OVERRIDABLE and _is_super(user)))
    return forced


# ── What is left, in words ────────────────────────────────────────────────────


def left_text(db: Session, voucher: PrepaidVoucher) -> str:
    """"נותרו: מזון ×1, שתייה ×1" — per group, per product, or uses."""
    batch = voucher.batch
    if PV.is_discount(batch):
        return f"נותרו {int(voucher.uses_left or 0)} מתוך {int(batch.uses_per_voucher or 1)} שימושים"
    groups = list(getattr(batch, "groups", None) or [])
    if (getattr(batch, "selection", None) or "items") == "groups" and groups:
        left = PG.remaining_of(voucher, groups, batch.total_qty)
        parts = [f"{g.get('name') or 'פריטים'} ×{left[g['key']]}" for g in groups if left[g["key"]] > 0]
        if not parts or left[PG.TOTAL] <= 0:
            return "לא נותר דבר"
        text = "נותרו: " + ", ".join(parts)
        if left[PG.TOTAL] < sum(left[g["key"]] for g in groups):
            text += f" (עד {left[PG.TOTAL]} בסך הכול)"
        return text
    rem = voucher.remaining or {}
    parts = []
    for i in batch.items:
        q = PV.qty(rem.get(str(i.product_id), 0))
        if q > 0:
            parts.append(f"{i.product_name} ×{PV.qty_text(q)}")
    return ("נותרו: " + ", ".join(parts)) if parts else "לא נותר דבר"


def _groups_left(db: Session, place: _Place, voucher: PrepaidVoucher) -> List[Dict[str, Any]]:
    batch = voucher.batch
    groups = list(getattr(batch, "groups", None) or [])
    left = PG.remaining_of(voucher, groups, batch.total_qty)
    catalog = PG.catalog_of(db, batch.tenant_id, batch.company_id)
    out = []
    for g in groups:
        ids = PG.eligible(db, batch, g, catalog)
        names = {}
        uuids = [u for u in (PV._as_uuid(p) for p in ids[:200]) if u is not None]
        if uuids:
            from app.models.product import Product

            names = {str(i).lower(): n for i, n in db.query(Product.id, Product.name).filter(Product.id.in_(uuids))}
        out.append({
            "key": g["key"], "name": g.get("name"), "minQty": int(g.get("minQty") or 0), "maxQty": int(g.get("maxQty") or 1),
            "remaining": left[g["key"]],
            "products": [{"id": p, "name": names.get(p)} for p in ids[:200]],
        })
    return out


def voucher_state(db: Session, user: User, tenant_id, voucher: PrepaidVoucher, place: Optional[_Place], at: datetime) -> Dict[str, Any]:
    """The preview of one voucher: what is left, where it may be redeemed, and what would refuse it now."""
    from app.services import prepaid_voucher_test_mode as TM

    batch = voucher.batch
    shops = valid_shops(db, user, tenant_id, voucher)
    kind = batch.kind or "items"
    selection = "discount" if PV.is_discount(batch) else (getattr(batch, "selection", None) or "items")
    out: Dict[str, Any] = {
        "voucherId": str(voucher.id),
        "code": voucher.code,
        "displayCode": PV.format_code(voucher.code),
        "serial": int(voucher.serial),
        "batchId": str(batch.id),
        "batchName": batch.name,
        "kind": kind,
        "selection": selection,
        "status": voucher.status,
        "splitAllowed": bool(batch.split_allowed),
        "leftText": left_text(db, voucher),
        **PV.quota_of(voucher),
        "usesLeft": voucher.uses_left if PV.is_discount(batch) else None,
        "items": PV._remaining_out(batch, voucher) if selection == "items" else [],
        "groups": [],
        "validShops": shops,
        "defaultShopId": shops[0]["id"] if len(shops) == 1 else None,
        "validFrom": PV._iso(batch.valid_from),
        "validUntil": PV._iso(batch.valid_until),
        "testMode": TM.in_test_mode(batch),
        "refusal": None,
        "overridable": [],
        "canForce": _is_super(user),
        "tills": [],
    }
    if selection == "groups":
        where = place
        if where is None:
            shop = _any_shop(db, voucher)
            where = _Place(tenant_id, shop, None) if shop is not None else None
        out["groups"] = _groups_left(db, where, voucher) if where is not None else []
    if place is not None:
        # The chosen shop's tills, for "קופה (לא חובה)".
        out["tills"] = [
            {"id": str(i), "name": n}
            for i, n in db.query(POSMachine.id, POSMachine.name)
            .filter(POSMachine.shop_id == place.shop_id, POSMachine.tenant_id == tenant_id)
            .order_by(POSMachine.name)
        ]
    if out["testMode"]:
        out["refusal"] = {"code": TEST_MODE, "message": TEXT[TEST_MODE]}
        return out
    if place is None:
        return out
    for code in refusals(db, place, voucher, at):
        entry = {"code": code, "message": _message(db, place, voucher, code, at)}
        if code in OVERRIDABLE and _is_super(user):
            out["overridable"].append({**entry, "overrideText": OVERRIDE_TEXT[code]})
            continue
        out["refusal"] = entry
        break
    return out


def _any_shop(db: Session, voucher: PrepaidVoucher) -> Optional[Shop]:
    batch = voucher.batch
    if batch.shop_ids:
        sid = PV._as_uuid(batch.shop_ids[0])
        return db.query(Shop).filter(Shop.id == sid).first() if sid else None
    return db.query(Shop).filter(Shop.company_id == batch.company_id).first()


# ── What is taken ─────────────────────────────────────────────────────────────


def _price_agorot(price) -> int:
    from decimal import ROUND_HALF_UP

    if price is None:
        return 0
    return int((Decimal(str(price)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _unit(ref: str, pid: Optional[str], name: Optional[str], q: Decimal, price: int, group_key=None) -> Dict[str, Any]:
    line = int((Decimal(price) * q).to_integral_value()) if price else 0
    return {
        "ref": ref, "productId": (str(pid).lower() if pid else None), "productName": name, "groupKey": group_key,
        "quantity": q, "listPriceAgorot": int(price), "listValueAgorot": line, "categoryIds": [], "noDiscount": False,
    }


def _prices(db: Session, place: _Place, ids: List[str]) -> Dict[str, Dict[str, Any]]:
    return PV._till_products(db, place, ids) if ids else {}


def _goods_items(db: Session, place: _Place, voucher: PrepaidVoucher, body) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Decimal]:
    """A fixed list: everything left (`full`) or the lines asked for — through the till's own choice."""
    batch = voucher.batch
    names = {str(i.product_id): i.product_name for i in batch.items}
    rem = voucher.remaining or {}
    wanted: List[Tuple[str, Decimal]] = []
    if body.full:
        wanted = [(str(i.product_id), PV.qty(rem.get(str(i.product_id), 0))) for i in batch.items]
        wanted = [(p, q) for p, q in wanted if q > 0]
    else:
        for line in body.items or []:
            if not line.product_id:
                raise _refuse(PV.ITEM_NOT_ON_VOUCHER)
            wanted.append((str(line.product_id).strip(), PV.qty(line.quantity)))
    if not wanted:
        raise _refuse(NOTHING)
    prices = _prices(db, place, list(names))
    units = []
    for n, (pid, q) in enumerate(wanted):
        key = pid.lower()
        known = next((g for g in names if g.lower() == key), None)
        price = _price_agorot((prices.get(known) or {}).get("price")) if known else 0
        units.append(_unit(f"m{n + 1}", pid, names.get(known) if known else None, q, price))
    unusable = PV._goods_unusable(db, batch)
    chosen, forfeited, units_left = PVRG._choose_items(db, place, batch, voucher, units, bool(body.forfeit_rest))
    if any(unusable.get(u["productId"]) for u in chosen):
        raise _refuse(PV.ITEM_UNUSABLE)
    return chosen, forfeited, units_left


def _goods_groups(db: Session, place: _Place, voucher: PrepaidVoucher, body) -> Tuple[List[Dict[str, Any]], Decimal]:
    """
    Item groups (a punch card is one): everything left (`full`), N units (`units`, in the groups' order),
    or the lines asked for — a product (its group found as the till finds it) or a group's units with no
    product named (what the scanner did not see). Checked against what is left per group and in all.
    """
    batch = voucher.batch
    groups = list(batch.groups or [])
    left = PG.remaining_of(voucher, groups, batch.total_qty)
    by_key = {g["key"]: g for g in groups}
    catalog = PG.catalog_of(db, batch.tenant_id, batch.company_id)
    eligible = {g["key"]: PG.eligible(db, batch, g, catalog) for g in groups}

    def sole(key):
        ids = eligible.get(key) or []
        return ids[0] if len(ids) == 1 else None

    lines = list(body.items or [])
    by_product = [l for l in lines if l.product_id]
    if lines and len(by_product) == len(lines) and not any(l.group_key for l in lines):
        # Products only: the till's own assignment and selection rules.
        prices = _prices(db, place, sorted({str(l.product_id).lower() for l in lines}))
        units = []
        n = 0
        for l in lines:
            pid = str(l.product_id).strip().lower()
            q = PV.qty(l.quantity)
            pieces = int(q) if q == q.to_integral_value() else 1
            for _ in range(max(1, pieces)):
                n += 1
                units.append(_unit(f"m{n}", pid, None, Decimal(1), _price_agorot((prices.get(pid) or {}).get("price"))))
        names = _product_names(db, [u["productId"] for u in units])
        for u in units:
            u["productName"] = names.get(u["productId"])
        chosen, units_left = PVRG._choose_groups(db, place, batch, voucher, units, PV._type_name_of(db, batch))
        return chosen, units_left

    # Per group, no product needed.
    take: Dict[str, int] = {}
    products: Dict[str, List[str]] = {}
    if body.full or body.units:
        budget = left[PG.TOTAL] if body.full else int(body.units)
        if not body.full and budget > left[PG.TOTAL]:
            raise _refuse(PR.TOTAL_OVER, PR.TEXT[PR.TOTAL_OVER].format(n=left[PG.TOTAL]))
        for g in groups:
            n = min(left[g["key"]], budget)
            if n > 0:
                take[g["key"]] = n
                budget -= n
    else:
        for l in lines:
            key = l.group_key
            if key not in by_key:
                raise _refuse(PR.NOT_IN_GROUP, PR.TEXT[PR.NOT_IN_GROUP])
            q = PV.qty(l.quantity)
            if q != q.to_integral_value():
                raise _refuse(PV.QUANTITY_FRACTION)
            take[key] = take.get(key, 0) + int(q)
            if l.product_id:
                pid = str(l.product_id).strip().lower()
                if pid not in eligible.get(key, []):
                    raise _refuse(PR.NOT_IN_GROUP, PR.TEXT[PR.NOT_IN_GROUP])
                products.setdefault(key, []).extend([pid] * int(q))
    if not take or sum(take.values()) <= 0:
        raise _refuse(NOTHING)
    for key, n in take.items():
        if n > left[key]:
            g = by_key[key]
            raise _refuse(PR.GROUP_OVER, PR.TEXT["group_left"].format(group=g.get("name") or "", n=PR.units_text(left[key]))
                          if left[key] > 0 else PR.TEXT["group_used"].format(group=g.get("name") or ""))
    if sum(take.values()) > left[PG.TOTAL]:
        raise _refuse(PR.TOTAL_OVER, PR.TEXT[PR.TOTAL_OVER].format(n=left[PG.TOTAL]))
    if not batch.split_allowed and not body.forfeit_rest:
        # One-time: each group at least its minimum (as the till's `check_selection`), or the whole rest.
        for g in groups:
            need = min(int(g.get("minQty") or 0), left[g["key"]])
            if take.get(g["key"], 0) < need and sum(take.values()) < left[PG.TOTAL]:
                raise _refuse(PV.PARTIAL_NOT_ALLOWED)
    all_ids = sorted({p for ids in products.values() for p in ids} | {s for s in (sole(k) for k in take) if s})
    prices = _prices(db, place, all_ids)
    names = _product_names(db, all_ids)
    units = []
    n = 0
    for g in groups:
        key = g["key"]
        named = list(products.get(key, []))
        for _ in range(take.get(key, 0)):
            n += 1
            pid = named.pop(0) if named else sole(key)
            price = _price_agorot((prices.get(pid) or {}).get("price")) if pid else 0
            u = _unit(f"m{n}", pid, names.get(pid) if pid else (g.get("name") or "פריט"), Decimal(1), price, key)
            u["groupName"] = g.get("name")
            units.append(u)
    return units, Decimal(left[PG.TOTAL])


def _product_names(db: Session, ids: List[str]) -> Dict[str, str]:
    from app.models.product import Product

    uuids = [u for u in (PV._as_uuid(p) for p in ids if p) if u is not None]
    if not uuids:
        return {}
    return {str(i).lower(): n for i, n in db.query(Product.id, Product.name).filter(Product.id.in_(uuids))}


# ── The write ─────────────────────────────────────────────────────────────────


def _key(body, header_key: Optional[str]) -> str:
    raw = (body.client_request_id or header_key or "").strip()
    return raw[:64] if raw else str(uuid.uuid4())


def _prior(db: Session, tenant_id, request_key: str) -> Optional[PrepaidVoucherRedemption]:
    return (
        db.query(PrepaidVoucherRedemption)
        .filter(
            PrepaidVoucherRedemption.tenant_id == tenant_id,
            PrepaidVoucherRedemption.source == SOURCE,
            PrepaidVoucherRedemption.client_request_id == request_key,
        )
        .first()
    )


def _summary(user: User, reason: str) -> str:
    return f"מימוש ידני מהענן · {PV._user_name(user) or ''} · {reason}"


def _mark(redemption: PrepaidVoucherRedemption, user: User, place: _Place, request_key: str, reason: str,
          at: datetime, forced: List[str]) -> None:
    redemption.source = SOURCE
    redemption.manual = True
    redemption.manual_reason = reason[:200]
    redemption.manual_by_user_id = getattr(user, "id", None)
    redemption.manual_by_user_name = (PV._user_name(user) or None)
    redemption.manual_override = list(forced) or None
    redemption.client_request_id = request_key
    redemption.machine_id = place.machine_id
    redemption.shop_id = place.shop_id
    redemption.pos_user_id = None
    redemption.pos_user_name = PV._user_name(user)
    redemption.redeemed_at = at


def _dates(db: Session, voucher: PrepaidVoucher) -> None:
    """When it happened, not when it was typed in: first / last redemption from the live rows."""
    times = [
        PV._utc(t) for (t,) in db.query(PrepaidVoucherRedemption.redeemed_at).filter(
            PrepaidVoucherRedemption.voucher_id == voucher.id, PrepaidVoucherRedemption.reversed_at.is_(None),
        ) if t is not None
    ]
    voucher.first_redeemed_at = min(times) if times else None
    voucher.last_redeemed_at = max(times) if times else None


def _write_goods(db: Session, user: User, place: _Place, voucher: PrepaidVoucher, body, request_key: str) -> PrepaidVoucherRedemption:
    batch = voucher.batch
    now = PV._now()
    # Held by an open sale at a till: in use, as the till's reserve says.
    holds = db.query(PrepaidVoucherReservation).filter(
        PrepaidVoucherReservation.voucher_id == voucher.id, PrepaidVoucherReservation.status == "held",
    ).all()
    if any(PV._reservation_live(h, now) for h in holds):
        raise _refuse(PV.IN_USE)
    forfeited: List[Dict[str, Any]] = []
    if (getattr(batch, "selection", None) or "items") == "groups":
        units, units_left = _goods_groups(db, place, voucher, body)
    else:
        units, forfeited, units_left = _goods_items(db, place, voucher, body)
    PVRG.catalog_flags(db, batch.tenant_id, [u for u in units if u.get("productId")])
    # The dashboard user is the manager who approves a forced discount (§6).
    answer = PVRG.value_units(db, batch, voucher, units, units_left, approved=True)
    answer.update({
        "forfeited": forfeited,
        "serial": int(voucher.serial),
        "typeName": PV._type_name_of(db, batch),
        "productionName": getattr(batch, "customer_name", None),
        "batchName": batch.name,
        "approval": {"posUserId": None, "posUserName": PV._user_name(user), "method": "dashboard"},
    })
    hold = PrepaidVoucherReservation(
        id=uuid.uuid4(), tenant_id=voucher.tenant_id, voucher_id=voucher.id, batch_id=batch.id,
        machine_id=place.machine_id, shop_id=place.shop_id, client_request_id=f"manual:{request_key}"[:100],
        sale_ref=f"manual:{request_key}"[:100], uses=1, amount=answer["coveredAgorot"], status="held",
        expires_at=now + PV.RESERVATION_TTL, pos_user_id=None, pos_user_name=PV._user_name(user),
        goods=answer, created_at=now, updated_at=now,
    )
    db.add(hold)
    db.flush()
    done = PVRG.confirm_goods(db, place, hold, voucher, None)
    return db.query(PrepaidVoucherRedemption).filter(PrepaidVoucherRedemption.id == PV._as_uuid(done["redemptionId"])).one()


def _write_discount(db: Session, user: User, place: _Place, voucher: PrepaidVoucher, body, at: datetime) -> PrepaidVoucherRedemption:
    batch = voucher.batch
    left = int(voucher.uses_left or 0)
    take = left if body.full else int(body.uses or 1)
    if take <= 0:
        raise _refuse(PV.USED, _message(db, place, voucher, PV.USED, at))
    if take > left:
        raise _refuse(PV.INSUFFICIENT, TEXT[PV.INSUFFICIENT].format(left=left_text(db, voucher)))
    uses = PV.uses_open(db, voucher, at)
    if take > uses["available"]:
        raise _refuse(PV.IN_USE)
    if batch.max_uses_per_day and PV._used_today(db, voucher, at) + take > int(batch.max_uses_per_day):
        raise _refuse(PV.DAILY_LIMIT, TEXT[PV.DAILY_LIMIT].format(n=int(batch.max_uses_per_day)))
    from app.services.prepaid_voucher_controls import redemption_flags as controls_flags  # §18 hook (helper)

    flags = controls_flags(db, None, voucher, PV._now())
    redemption = PrepaidVoucherRedemption(
        id=uuid.uuid4(), tenant_id=voucher.tenant_id, voucher_id=voucher.id, batch_id=batch.id,
        machine_id=place.machine_id, shop_id=place.shop_id, client_request_id="manual", transaction_id=None,
        sale_ref=None, items=[], uses=take, discount_amount=None, flags=flags or None, redeemed_at=at,
        serial=int(voucher.serial), type_name=PV._type_name_of(db, batch),
        production_name=getattr(batch, "customer_name", None), batch_name=batch.name,
        redemption_accounting="discount",
    )
    voucher.uses_left = max(0, left - take)
    voucher.status = "used" if voucher.uses_left == 0 else "partially_used"
    voucher.updated_at = PV._now()
    db.add(redemption)
    return redemption


def _taken(redemption: PrepaidVoucherRedemption) -> Dict[str, Any]:
    if redemption.uses:
        return {"uses": int(redemption.uses)}
    return {"items": [
        {"productId": u.get("productId"), "name": u.get("name"), "quantity": u.get("quantity")}
        for u in (redemption.items or [])
    ]}


def _answer(db: Session, voucher: PrepaidVoucher, redemption: PrepaidVoucherRedemption, *, replayed: bool) -> Dict[str, Any]:
    db.refresh(voucher)
    return {
        "ok": True,
        "replayed": replayed,
        "redemptionId": str(redemption.id),
        "redeemedAt": PV._iso(redemption.redeemed_at),
        "override": list(redemption.manual_override or []),
        "leftText": left_text(db, voucher),
        "voucher": PV.voucher_out(db, voucher, with_redemptions=True),
    }


def _redeem_one(
    db: Session, user: User, tenant_id, body, request_key: str, *, code: Optional[str], voucher_id: Optional[str],
    reason: str, at: datetime,
) -> Tuple[PrepaidVoucher, PrepaidVoucherRedemption, bool]:
    """One voucher, under its lock: idempotency, the till's rules, the till's write, the mark, the audit."""
    voucher = _voucher(db, user, tenant_id, code=code, voucher_id=voucher_id, lock=True)
    prior = _prior(db, tenant_id, request_key)
    if prior is not None:
        if prior.voucher_id != voucher.id:
            raise _refuse(PV.REQUEST_CONFLICT)
        return voucher, prior, True
    place = _place(db, user, tenant_id, voucher, body.shop_id, body.machine_id)
    forced = _check(db, user, place, voucher, at, bool(body.force))
    batch = voucher.batch
    try:
        if PV.is_discount(batch):
            redemption = _write_discount(db, user, place, voucher, body, at)
        else:
            redemption = _write_goods(db, user, place, voucher, body, request_key)
    except HTTPException as e:
        raise _worded(db, voucher, e, at)
    _mark(redemption, user, place, request_key, reason, at, forced)
    db.flush()
    _dates(db, voucher)
    db.flush()
    taken = _taken(redemption)
    PV._event(
        db, batch, user, EVENT_REDEEM, group_no=voucher.group_no, voucher_id=voucher.id,
        count=int(redemption.uses or 0) or len(redemption.units or redemption.items or []),
        reason=reason,
        details={
            "serial": int(voucher.serial), "summary": _summary(user, reason), "redemptionId": str(redemption.id),
            "shopId": str(place.shop_id), "shopName": place.shop.name,
            "machineId": str(place.machine_id) if place.machine_id else None, "machineName": place.name,
            "occurredAt": PV._iso(at), **taken,
            "override": forced or None,
            "overrideText": [OVERRIDE_TEXT[c] for c in forced] or None,
        },
    )
    db.flush()
    return voucher, redemption, False


def manual_redeem(db: Session, user: User, tenant_id, body, header_key: Optional[str] = None) -> Dict[str, Any]:
    """POST /prepaid-vouchers/manual-redeem. The caller commits."""
    _require(db, user)
    if body.one_click:
        body.full = True
    reason = _reason(body.reason, body.one_click)
    at = _when(body.occurred_at)
    if not body.full and not body.items and not body.units and not body.uses:
        # A discount voucher: one use by default; goods need something chosen.
        body.uses = 1
    voucher, redemption, replayed = _redeem_one(
        db, user, tenant_id, body, _key(body, header_key), code=body.code, voucher_id=body.voucher_id, reason=reason, at=at,
    )
    return _answer(db, voucher, redemption, replayed=replayed)


def manual_redeem_bulk(db: Session, user: User, tenant_id, body, header_key: Optional[str] = None) -> Dict[str, Any]:
    """
    POST /prepaid-vouchers/manual-redeem/bulk: each voucher redeemed fully on its own (a savepoint each),
    refusals reported per voucher with the reason. Idempotent per voucher: `{clientRequestId}:{code}`.
    The caller commits.
    """
    from app.schemas.prepaid_voucher_manual import MAX_BULK

    _require(db, user)
    reason = _reason(body.reason, body.one_click)
    at = _when(body.occurred_at)
    base = _key(body, header_key)
    wanted: List[Tuple[str, str]] = []  # (kind, value)
    seen = set()
    for c in body.codes or []:
        normal = PV.normalize_code(c)
        key = normal or c
        if key not in seen:
            seen.add(key)
            wanted.append(("code", c))
    for v in body.voucher_ids or []:
        if v not in seen:
            seen.add(v)
            wanted.append(("id", v))
    if not wanted:
        raise _error(status.HTTP_400_BAD_REQUEST, NOTHING, "לא הוזנו קודים")
    if len(wanted) > MAX_BULK:
        raise _error(status.HTTP_400_BAD_REQUEST, BAD_REQUEST, f"עד {MAX_BULK} שוברים בבקשה אחת")
    results = []
    counts = {"redeemed": 0, "replayed": 0, "refused": 0}
    for kind, value in wanted:
        one = _BulkOne(body)
        label = value
        ident = PV.normalize_code(value) if kind == "code" else value
        try:
            with db.begin_nested():
                voucher, redemption, replayed = _redeem_one(
                    db, user, tenant_id, one, f"{base}:{ident}"[:100],
                    code=value if kind == "code" else None, voucher_id=value if kind == "id" else None,
                    reason=reason, at=at,
                )
            state = "replayed" if replayed else "redeemed"
            counts[state] += 1
            results.append({
                "input": label, "status": state, "voucherId": str(voucher.id), "code": voucher.code,
                "serial": int(voucher.serial), "redemptionId": str(redemption.id),
                "override": list(redemption.manual_override or []),
            })
        except HTTPException as e:
            detail = e.detail if isinstance(e.detail, dict) else {"code": str(e.detail), "message": TEXT.get(str(e.detail)) or str(e.detail)}
            counts["refused"] += 1
            results.append({"input": label, "status": "refused", "code": None, "reason": detail.get("code"),
                            "message": detail.get("message")})
    db.flush()
    return {"ok": True, "total": len(wanted), **counts, "results": results}


class _BulkOne:
    """One voucher of a bulk request, as `_redeem_one` reads a body: everything left."""

    def __init__(self, body):
        self.shop_id = body.shop_id
        self.machine_id = body.machine_id
        self.force = bool(body.force)
        self.full = True
        self.items = None
        self.units = None
        self.uses = None
        self.forfeit_rest = False


def preview(db: Session, user: User, tenant_id, body) -> Dict[str, Any]:
    """POST /prepaid-vouchers/manual-redeem/preview: per voucher what is left and what would refuse it. Read only."""
    _require(db, user)
    at = _when(body.occurred_at)
    out = []
    counts = {"ok": 0, "refused": 0, "notFound": 0, "forced": 0}
    wanted = [("code", c) for c in (body.codes or [])] + [("id", v) for v in (body.voucher_ids or [])]
    seen = set()
    for kind, value in wanted:
        ident = PV.normalize_code(value) if kind == "code" else value
        if ident in seen:
            continue
        seen.add(ident)
        try:
            voucher = _voucher(db, user, tenant_id, code=value if kind == "code" else None,
                               voucher_id=value if kind == "id" else None, lock=False)
        except HTTPException as e:
            detail = e.detail if isinstance(e.detail, dict) else {"code": str(e.detail), "message": str(e.detail)}
            counts["notFound"] += 1
            out.append({"input": value, "found": False, "refusal": detail})
            continue
        place = None
        try:
            place = _place(db, user, tenant_id, voucher, body.shop_id, None)
        except HTTPException as e:
            if not (isinstance(e.detail, dict) and e.detail.get("code") == SHOP_REQUIRED):
                raise
        state = voucher_state(db, user, tenant_id, voucher, place, at)
        state.update({"input": value, "found": True, "needsShop": place is None})
        if state["refusal"] is not None:
            counts["refused"] += 1
        else:
            counts["ok"] += 1
            if state["overridable"]:
                counts["forced"] += 1
        out.append(state)
    return {"total": len(out), **counts, "vouchers": out}


def reverse(db: Session, user: User, tenant_id, redemption_id: str, reason: str) -> Dict[str, Any]:
    """POST /prepaid-vouchers/redemptions/{id}/reverse: undo a manual redemption. Idempotent. The caller commits."""
    _require(db, user)
    reason = _reason(reason, False)
    rid = PV._as_uuid(redemption_id)
    redemption = (
        db.query(PrepaidVoucherRedemption).filter(PrepaidVoucherRedemption.id == rid).first() if rid else None
    )
    if redemption is None or str(redemption.tenant_id) != str(tenant_id):
        raise _error(status.HTTP_404_NOT_FOUND, "prepaid_redemption_not_found", "המימוש לא נמצא")
    voucher = db.query(PrepaidVoucher).filter(PrepaidVoucher.id == redemption.voucher_id).with_for_update().first()
    if voucher is None or not PV.may_manage(db, user, tenant_id, voucher.batch):
        raise _error(status.HTTP_403_FORBIDDEN, PV.FORBIDDEN, "אין לך הרשאה לסדרה של שובר זה")
    if not redemption.manual:
        raise _refuse(NOT_MANUAL)
    if redemption.reversed_at is None:
        now = PV._now()
        PV.give_back(voucher, redemption)
        PV._status_after_give_back(db, voucher, redemption)
        voucher.updated_at = now
        redemption.reversed_at = now
        redemption.reverse_reason = reason[:200]
        redemption.reversed_by_user_name = PV._user_name(user)
        db.flush()
        _dates(db, voucher)
        PV._event(
            db, voucher.batch, user, EVENT_REVERSE, group_no=voucher.group_no, voucher_id=voucher.id,
            count=int(redemption.uses or 0) or len(redemption.units or redemption.items or []), reason=reason,
            details={
                "serial": int(voucher.serial), "redemptionId": str(redemption.id),
                "summary": f"ביטול מימוש ידני · {PV._user_name(user) or ''} · {reason}",
                **_taken(redemption),
            },
        )
        db.flush()
    db.refresh(voucher)
    return {
        "ok": True, "redemptionId": str(redemption.id), "reversedAt": PV._iso(redemption.reversed_at),
        "leftText": left_text(db, voucher), "voucher": PV.voucher_out(db, voucher, with_redemptions=True),
    }
