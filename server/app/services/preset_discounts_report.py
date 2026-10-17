"""
"מעקב הנחות קבועות" — every use of a preset discount (P:/specs/preset-discounts.md §6).

One row per sale whose basket discount was a preset's (`basket_discount_kind` "preset"): the
preset (id and the name it was given under), its rate or amount, what it took off, the document
(number as printed, total), the till and its shop, the cashier, the approver, the time, and whom
it was for. Totals, by preset and by person ("for whom"; a use for nobody is under the empty name).

Over the same document set as every report (`build_scoped_transaction_query`: the window, the
caller's scope, sale statuses), sales only. Filters: shop, till, preset (id), cashier (the
till user's id) and person (a part of the "for whom" name, case-insensitive). The dashboard
exports what it shows, as every report page does.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.transaction import Transaction
from app.services.discounts_report import _Names, _dec, _money, _till_row
from app.services.preset_discounts import KIND_PRESET

#: The most rows one answer lists; the totals always count everything.
ROWS_MAX = 5000


def _local(moment: Optional[datetime], zone) -> Optional[str]:
    if moment is None:
        return None
    moment = moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(zone).isoformat()


def _bucket() -> Dict[str, Any]:
    return {"count": 0, "amount": Decimal("0")}


def _flat(b: Dict[str, Any]) -> Dict[str, Any]:
    return {"count": b["count"], "amount": _money(b["amount"])}


def build_preset_discount_tracking(
    db: Session,
    user,
    tenant_id,
    window,
    *,
    shop_id=None,
    machine_id=None,
    preset_id: Optional[str] = None,
    cashier_id: Optional[str] = None,
    person: Optional[str] = None,
) -> Dict[str, Any]:
    """`{window, generatedAt, totals, byPreset, byPerson, byCashier, rows, truncated}` — see the module."""
    from app.services.document_prefix import document_number_from
    from app.services.reports import _is_refund_condition, _load_zoneinfo, build_scoped_transaction_query

    out: Dict[str, Any] = {
        "window": window.to_schema().model_dump(by_alias=True, mode="json"),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "totals": {"count": 0, "amount": 0.0},
        "byPreset": [],
        "byPerson": [],
        "byCashier": [],
        "rows": [],
        "truncated": False,
    }
    tx_q = build_scoped_transaction_query(
        db, user, tenant_id, window, shop_id=shop_id, machine_id=machine_id, cashier_id=cashier_id or None,
    )
    if tx_q is None:
        return out
    q = tx_q.filter(
        ~_is_refund_condition(),
        Transaction.basket_discount_kind == KIND_PRESET,
        Transaction.basket_discount.isnot(None),
        Transaction.basket_discount > 0,
    )
    if preset_id:
        q = q.filter(Transaction.preset_discount_id == preset_id.strip())
    if person and person.strip():
        q = q.filter(func.lower(Transaction.preset_discount_for).contains(person.strip().lower()))
    rows = q.order_by(Transaction.created_at.desc()).all()
    zone = _load_zoneinfo(window.tz_name)
    names = _Names(db)
    tills: Dict[str, POSMachine] = names.tills({r.machine_id for r in rows})
    shops = names.shops({m.shop_id for m in tills.values() if m.shop_id})
    people = names.people(
        {r.cashier_id for r in rows if r.cashier_id}
        | {str(r.approved_by_user_id) for r in rows if r.approved_by_user_id}
        | {str(r.approved_by_pos_user_id) for r in rows if r.approved_by_pos_user_id}
    )

    totals = _bucket()
    by_preset: Dict[str, Dict[str, Any]] = {}
    preset_names: Dict[str, Optional[str]] = {}
    by_person: Dict[str, Dict[str, Any]] = {}
    by_cashier: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        amount = _dec(r.basket_discount)
        key = r.preset_discount_id or r.preset_discount_name or ""
        if r.preset_discount_name and key not in preset_names:
            preset_names[key] = r.preset_discount_name  # newest first: the name it goes by now
        for b in (totals, by_preset.setdefault(key, _bucket()),
                  by_person.setdefault(r.preset_discount_for or "", _bucket()),
                  by_cashier.setdefault(r.cashier_id or "", _bucket())):
            b["count"] += 1
            b["amount"] += amount
        if len(out["rows"]) >= ROWS_MAX:
            out["truncated"] = True
            continue
        till = _till_row(str(r.machine_id) if r.machine_id else None, tills, shops)
        approver = r.approved_by_pos_user_id or r.approved_by_user_id
        out["rows"].append({
            "transactionId": str(r.id),
            "documentNumber": document_number_from(r.transaction_number, r.document_prefix, r.pos_number),
            "documentType": r.document_type,
            "createdAt": _local(r.created_at, zone),
            "machineId": till["machineId"],
            "tillName": till["name"],
            "posNumber": till["posNumber"],
            "shopName": till["shopName"],
            "cashierId": r.cashier_id,
            "cashierName": people.get(r.cashier_id) if r.cashier_id else None,
            "approverName": people.get(str(approver)) if approver else None,
            "presetId": r.preset_discount_id,
            "presetName": r.preset_discount_name,
            "kind": "percent" if r.basket_discount_percent is not None else "amount",
            "percent": float(r.basket_discount_percent) if r.basket_discount_percent is not None else None,
            "amount": _money(amount),
            "total": _money(_dec(r.total_amount)),
            "for": r.preset_discount_for,
            "forKind": r.preset_discount_for_kind,
        })

    def sort(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return sorted(items, key=lambda x: -x["amount"])

    out["totals"] = _flat(totals)
    out["byPreset"] = sort([
        {"presetId": k or None, "name": preset_names.get(k), **_flat(b)} for k, b in by_preset.items()
    ])
    out["byPerson"] = sort([{"for": k or None, **_flat(b)} for k, b in by_person.items()])
    out["byCashier"] = sort([
        {"cashierId": k or None, "cashierName": people.get(k) if k else None, **_flat(b)}
        for k, b in by_cashier.items()
    ])
    return out

