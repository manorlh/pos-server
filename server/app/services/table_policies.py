"""
Table policies ("סוגי שולחנות"): what a table is for, and what its orders get.

A table is **regular** (an ordinary table), **staff** ("שולחן עובדים": its orders are staff
meals) or **managers** ("שולחן מנהלים": manager meals — up to 100%, "הוצאת מנהלים"), and
any of them may carry a **discount %** — on a regular table that is a plain "הנחת שולחן"
(VIP -10%). The policy comes from the table's **type** (`table_types`, reusable across the
shop's tables) when it names one, else from the table's own `kind` / `discount_percent`.

The till (pos-android domain/TablePolicy.kt) reads the resolved policy on every table
(`policy` in `/sync/{machine}/tables`), and when a table is opened:

* staff — asks which employee eats (from the till's employees), and records them on the sale;
* managers — asks for the reason and a manager's PIN (the approver goes on the sale as
  `approved_by_*`, like every discount approval);
* a type with `require_approval` — a manager's PIN too;
* the discount — applied to the basket through the till's existing basket discount (the
  same path as a cashier's "הנחה לחשבון": no new money path, products marked "לא מקבל
  הנחות" keep their price), so the documents stay correct. A 100% managers' meal is a
  sale of 0 like any fully discounted basket.

The sale carries `basket_discount_kind` = `table` / `staff` / `managers`, and a meal
`meal_kind` = `staff` / `managers` with `meal_employee_*` and `meal_reason`; the meals
report below counts them.

`staff_mode` other than `percent` (a price list, or free up to an allowance per employee)
is stored for the design; the till applies the discount % today.
"""
from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, Iterable, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session, object_session

from app.models.shop import Shop
from app.models.tables import STAFF_MEAL_MODES, TABLE_KINDS, DiningTable, TableType
from app.models.transaction import Transaction
from app.services.tenders import is_credit_document_type

KIND_REGULAR = "regular"
KIND_STAFF = "staff"
KIND_MANAGERS = "managers"
MEAL_KINDS = (KIND_STAFF, KIND_MANAGERS)

#: The sale statuses a meal is counted in (a pending or cancelled document took no meal).
_COUNTED_STATUSES = ("completed", "refunded", "partial_refund")


def _money(value: Any) -> float:
    return float(Decimal(str(value or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _percent(value: Any) -> float:
    if value is None:
        return 0.0
    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _bad(code: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": code})


def _not_found(code: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": code})


# ── The policy of a table ────────────────────────────────────────────────────


def check_policy(kind: Optional[str], discount: Any) -> None:
    """A kind the till knows, a discount 0–100. 422 `{code}` otherwise."""
    if kind is not None and kind not in TABLE_KINDS:
        raise _bad("table_kind_invalid")
    if discount is not None:
        try:
            d = Decimal(str(discount))
        except Exception:  # noqa: BLE001 — anything not a number
            raise _bad("table_discount_invalid")
        if d < 0 or d > 100:
            raise _bad("table_discount_invalid")


def type_out(t: TableType) -> Dict[str, Any]:
    return {
        "id": str(t.id),
        "shopId": str(t.shop_id),
        "name": t.name,
        "kind": t.kind,
        "discountPercent": _percent(t.discount_percent),
        "requireApproval": bool(t.require_approval) or t.kind == KIND_MANAGERS,
        "requireReason": bool(t.require_reason),
        "staffMode": t.staff_mode or "percent",
        "staffAllowance": _money(t.staff_allowance) if t.staff_allowance is not None else None,
        "sortOrder": t.sort_order or 0,
    }


def _type_of(table: DiningTable, types: Optional[Dict[Any, TableType]]) -> Optional[TableType]:
    if table.type_id is None:
        return None
    if types is not None:
        t = types.get(table.type_id)
    else:
        session = object_session(table)
        t = session.get(TableType, table.type_id) if session is not None else None
    return t if t is not None and t.archived_at is None else None


def policy_of(table: DiningTable, types: Optional[Dict[Any, TableType]] = None) -> Dict[str, Any]:
    """
    What the till applies on [table]: its type's policy when it names a live one, else its
    own. A managers' table always asks for a manager's approval; its reason is asked
    unless its type says otherwise (a table of its own: always).
    """
    t = _type_of(table, types)
    if t is not None:
        kind = t.kind if t.kind in TABLE_KINDS else KIND_REGULAR
        discount = _percent(t.discount_percent)
        approval = bool(t.require_approval) or kind == KIND_MANAGERS
        reason = bool(t.require_reason)
        mode = t.staff_mode if t.staff_mode in STAFF_MEAL_MODES else "percent"
        allowance = _money(t.staff_allowance) if t.staff_allowance is not None else None
        type_id, type_name = str(t.id), t.name
    else:
        kind = table.kind if table.kind in TABLE_KINDS else KIND_REGULAR
        discount = _percent(table.discount_percent)
        approval = kind == KIND_MANAGERS
        reason = kind == KIND_MANAGERS
        mode, allowance = "percent", None
        type_id, type_name = None, None
    return {
        "kind": kind,
        "discountPercent": discount,
        "typeId": type_id,
        "typeName": type_name,
        "requireEmployee": kind == KIND_STAFF,
        "requireApproval": approval,
        "requireReason": reason,
        "staffMode": mode,
        "staffAllowance": allowance,
    }


def policy_fields(table: DiningTable, types: Optional[Dict[Any, TableType]] = None) -> Dict[str, Any]:
    """The table's own policy fields and the resolved one, for `table_out`."""
    return {
        "kind": table.kind or KIND_REGULAR,
        "discountPercent": _percent(table.discount_percent) if table.discount_percent is not None else None,
        "typeId": str(table.type_id) if table.type_id else None,
        "policy": policy_of(table, types),
    }


def types_of_shop(db: Session, shop_id: Any, *, include_archived: bool = False) -> List[TableType]:
    q = db.query(TableType).filter(TableType.shop_id == shop_id)
    if not include_archived:
        q = q.filter(TableType.archived_at.is_(None))
    return q.order_by(TableType.sort_order, TableType.name).all()


def types_by_id(db: Session, shop_id: Any) -> Dict[Any, TableType]:
    """Every type of the shop, archived too (a table naming an archived one falls back to its own)."""
    return {t.id: t for t in types_of_shop(db, shop_id, include_archived=True)}


def live_type(db: Session, shop_id: Any, type_id: Any) -> TableType:
    t = db.query(TableType).filter(TableType.id == type_id).first()
    if t is None or t.archived_at is not None or t.shop_id != shop_id:
        raise _not_found("table_type_not_found")
    return t


def apply_table_policy(db: Session, table: DiningTable, body, *, creating: bool) -> None:
    """
    The policy fields of a table create / update body: `kind`, `discountPercent` (null
    clears it), `typeId` (null: the table's own policy). Validated before anything is set.
    """
    fields = getattr(body, "model_fields_set", set())
    kind = getattr(body, "kind", None)
    discount = getattr(body, "discount_percent", None)
    check_policy(kind, discount)
    if kind is not None:
        table.kind = kind
    elif creating:
        table.kind = KIND_REGULAR
    if "discount_percent" in fields or (creating and discount is not None):
        table.discount_percent = Decimal(str(discount)) if discount is not None and Decimal(str(discount)) > 0 else None
    if "type_id" in fields:
        type_id = getattr(body, "type_id", None)
        table.type_id = live_type(db, table.shop_id, type_id).id if type_id is not None else None


# ── Types ("סוגי שולחנות") ────────────────────────────────────────────────────


def _apply_type(t: TableType, body, *, creating: bool) -> None:
    fields = getattr(body, "model_fields_set", set())
    kind = getattr(body, "kind", None)
    discount = getattr(body, "discount_percent", None)
    check_policy(kind, discount)
    if getattr(body, "name", None) is not None:
        t.name = body.name
    if kind is not None:
        t.kind = kind
    if discount is not None:
        t.discount_percent = Decimal(str(discount))
    mode = getattr(body, "staff_mode", None)
    if mode is not None:
        if mode not in STAFF_MEAL_MODES:
            raise _bad("staff_mode_invalid")
        t.staff_mode = mode
    if "staff_allowance" in fields:
        allowance = getattr(body, "staff_allowance", None)
        if allowance is not None and Decimal(str(allowance)) < 0:
            raise _bad("staff_allowance_invalid")
        t.staff_allowance = Decimal(str(allowance)) if allowance is not None else None
    for attr in ("require_approval", "require_reason", "sort_order"):
        value = getattr(body, attr, None)
        if value is not None:
            setattr(t, attr, value)
    if creating and t.kind == KIND_MANAGERS and getattr(body, "require_reason", None) is None:
        # A managers' meal says why, unless the type was made to say otherwise.
        t.require_reason = True
    if t.kind == KIND_MANAGERS:
        t.require_approval = True
    if not (t.name or "").strip():
        raise _bad("table_type_name_required")


def create_type(db: Session, shop: Shop, body) -> TableType:
    t = TableType(
        id=uuid.uuid4(), tenant_id=shop.tenant_id, shop_id=shop.id, name=(body.name or "").strip(),
        kind=KIND_REGULAR, discount_percent=Decimal("0"), require_approval=False, require_reason=False,
        staff_mode="percent", sort_order=0,
    )
    _apply_type(t, body, creating=True)
    db.add(t)
    db.flush()
    return t


def update_type(db: Session, t: TableType, body) -> TableType:
    _apply_type(t, body, creating=False)
    db.flush()
    return t


def archive_type(db: Session, t: TableType) -> None:
    """Archived; its tables fall back to their own policy (their `type_id` is cleared)."""
    from datetime import datetime, timezone

    t.archived_at = datetime.now(timezone.utc)
    db.query(DiningTable).filter(DiningTable.type_id == t.id).update(
        {DiningTable.type_id: None}, synchronize_session=False,
    )
    db.flush()


# ── The meals report ("ארוחות עובדים ומנהלים") ─────────────────────────────────


def meals_report(
    db: Session,
    shop: Shop,
    start,
    end,
    *,
    employee: Optional[str] = None,
) -> Dict[str, Any]:
    """
    The staff and managers' meals of [shop] whose documents were made in [start, end)
    (aware datetimes): per kind and per employee the count, the value before the discount
    (the lines' total), the discount and what was paid; and the meals themselves. With
    [employee] (an employee id or name): theirs only.

    "Before the discount" is the document's `total_amount` (its lines); the discount is
    everything taken off it (`document_discount` — the table's basket discount and any
    other); paid is the difference.
    """
    q = db.query(Transaction).filter(
        Transaction.shop_id == shop.id,
        Transaction.meal_kind.in_(MEAL_KINDS),
        Transaction.status.in_(_COUNTED_STATUSES),
        Transaction.created_at >= start,
        Transaction.created_at < end,
    )
    # A sale document; a credit note (330 / -400) is not a meal.
    rows = [tx for tx in q.order_by(Transaction.created_at).all() if not is_credit_document_type(tx.document_type)]
    if employee:
        needle = employee.strip()
        rows = [tx for tx in rows if needle in (tx.meal_employee_id or "", tx.meal_employee_name or "")]

    def bucket() -> Dict[str, Any]:
        return {"count": 0, "before": Decimal("0"), "discount": Decimal("0"), "paid": Decimal("0")}

    totals = {KIND_STAFF: bucket(), KIND_MANAGERS: bucket()}
    people: Dict[tuple, Dict[str, Any]] = {}
    meals: List[Dict[str, Any]] = []
    for tx in rows:
        before = Decimal(str(tx.total_amount or 0))
        discount = Decimal(str(tx.document_discount or 0))
        if discount > before:
            discount = before
        paid = before - discount
        who = tx.meal_employee_name or None
        key = (tx.meal_kind, tx.meal_employee_id or who or "")
        person = people.setdefault(key, {
            "kind": tx.meal_kind, "employeeId": tx.meal_employee_id, "employee": who, **bucket(),
        })
        for b in (totals[tx.meal_kind], person):
            b["count"] += 1
            b["before"] += before
            b["discount"] += discount
            b["paid"] += paid
        meals.append({
            "transactionId": str(tx.id),
            "transactionNumber": tx.transaction_number,
            "at": tx.created_at.isoformat() if tx.created_at else None,
            "kind": tx.meal_kind,
            "employeeId": tx.meal_employee_id,
            "employee": who,
            "reason": tx.meal_reason,
            "approvedByPosUserId": str(tx.approved_by_pos_user_id) if tx.approved_by_pos_user_id else None,
            "before": _money(before),
            "discount": _money(discount),
            "paid": _money(paid),
            "percent": _percent(tx.basket_discount_percent) if tx.basket_discount_percent is not None else None,
        })

    def flat(b: Dict[str, Any]) -> Dict[str, Any]:
        return {"count": b["count"], "before": _money(b["before"]), "discount": _money(b["discount"]), "paid": _money(b["paid"])}

    by_employee = sorted(
        ({**{k: v for k, v in p.items() if k in ("kind", "employeeId", "employee")}, **flat(p)} for p in people.values()),
        key=lambda r: (r["kind"], -r["discount"], r["employee"] or ""),
    )
    approvers = _approver_names(db, {m["approvedByPosUserId"] for m in meals if m["approvedByPosUserId"]})
    for m in meals:
        m["approvedBy"] = approvers.get(m.pop("approvedByPosUserId"))
    return {
        "staff": flat(totals[KIND_STAFF]),
        "managers": flat(totals[KIND_MANAGERS]),
        "byEmployee": by_employee,
        "meals": meals,
    }


def _approver_names(db: Session, ids: Iterable[str]) -> Dict[str, str]:
    from app.models.pos_user import PosUser

    wanted = []
    for raw in ids:
        try:
            wanted.append(uuid.UUID(str(raw)))
        except (TypeError, ValueError):
            continue
    if not wanted:
        return {}
    out = {}
    for u in db.query(PosUser).filter(PosUser.id.in_(wanted)).all():
        name = " ".join(x for x in (u.first_name, u.last_name) if x) or u.username
        out[str(u.id)] = name
    return out


def report_window(db: Session, shop: Shop, start: date, end: date):
    """The shop's local days [start, end] as an aware [from, to) — as the tables report reads them."""
    from app.services.tables import _day_bounds

    return _day_bounds(db, shop.tenant_id, start, end)
