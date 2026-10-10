"""
"התאמת אשראי מול Z-Credit" (docs/SPEC_ZCREDIT.md "חלק ג׳") — the dashboard's routes. Dashboard-only
(Clerk / user tokens), scoped to the user's tills; the terminal never leaves masked to its last
four digits, a card never beyond its last four.

GET  /zcredit-reconciliation/terminals            → the Z-Credit terminals of the user's tills
GET  /zcredit-reconciliation/runs                 → runs per day and terminal (the latest of each by default)
GET  /zcredit-reconciliation/runs/{run_id}        → one run: totals, deposits, items
POST /zcredit-reconciliation/run                  → "הרץ התאמה עכשיו"
POST /zcredit-reconciliation/items/{item_id}/handle → "טופל" with a note
POST /zcredit-reconciliation/items/{item_id}/reopen
GET  /zcredit-reconciliation/attention            → open ❌ per terminal and day (the cockpit's badge)

Read-only toward Z-Credit: no route here refunds, voids or deposits.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User
from app.models.zcredit_reconciliation import (
    HARD_CATEGORIES,
    RECON_CATEGORIES,
    ZCreditReconItem,
    ZCreditReconRun,
)
from app.services import zcredit_reconcile as svc
from app.services.zcredit_recon_match import STATUS_LABELS

router = APIRouter(prefix="/zcredit-reconciliation", tags=["zcredit-reconciliation"])

#: Days one listing reads.
RANGE_MAX_DAYS = 62


# ── Scope ─────────────────────────────────────────────────────────────────────


def _tenant(active_tenant_id) -> uuid.UUID:
    if active_tenant_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="בחרו ארגון")
    return active_tenant_id


def _scope(db: Session, user: User, tenant_id, shop_ids: Optional[List[uuid.UUID]] = None) -> Dict[str, POSMachine]:
    from app.services.all_in_one import machines_in_scope

    return {str(m.id): m for m in machines_in_scope(db, user, tenant_id, shop_ids or [], [])}


def _today(db: Session, tenant_id) -> date:
    """Today in the tenant's zone (Israel unless set)."""
    _, zone = svc._zone(db, tenant_id)
    return datetime.now(timezone.utc).astimezone(zone).date()


def _visible(run: ZCreditReconRun, scope: Dict[str, POSMachine]) -> bool:
    return bool(set(run.machine_ids or []) & set(scope))


def _run_or_404(db: Session, run_id: uuid.UUID, tenant_id, scope) -> ZCreditReconRun:
    run = db.get(ZCreditReconRun, run_id)
    if run is None or run.tenant_id != tenant_id or not _visible(run, scope):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="ההרצה לא נמצאה")
    return run


def _item_or_404(db: Session, item_id: uuid.UUID, tenant_id, scope) -> ZCreditReconItem:
    item = db.get(ZCreditReconItem, item_id)
    if item is None or item.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="השורה לא נמצאה")
    run = db.get(ZCreditReconRun, item.run_id)
    if run is None or not _visible(run, scope) or (item.machine_id is not None and str(item.machine_id) not in scope):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="השורה לא נמצאה")
    return item


# ── Shapes ────────────────────────────────────────────────────────────────────


def _iso(moment: Optional[datetime]) -> Optional[str]:
    if moment is None:
        return None
    m = moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)
    return m.isoformat()


def _names(db: Session, ids: List[str], model) -> List[Dict[str, Any]]:
    keys = [uuid.UUID(str(i)) for i in ids if i]
    if not keys:
        return []
    return [{"id": str(r.id), "name": r.name} for r in db.query(model).filter(model.id.in_(keys)).all()]


def run_out(db: Session, run: ZCreditReconRun, *, open_hard: Optional[int] = None) -> Dict[str, Any]:
    summary = run.summary or {}
    return {
        "id": str(run.id),
        "terminalKey": run.terminal_key,
        "terminalLast4": run.terminal_last4,
        "terminal": svc.masked(run.terminal_last4),
        "businessDate": run.business_date.isoformat(),
        "timezone": run.timezone,
        "trigger": run.trigger,
        "status": run.status,
        "errorCode": run.error_code,
        "errorMessage": run.error_message,
        "startedAt": _iso(run.started_at),
        "finishedAt": _iso(run.finished_at),
        "summary": {c: summary.get(c, {"count": 0, "zcredit": 0.0, "ours": 0.0}) for c in RECON_CATEGORIES},
        "zcreditRows": run.zcredit_rows,
        "ourLegs": run.our_legs,
        "lookups": run.lookups,
        "openHard": open_hard,
        "deposits": run.deposits or [],
        "shops": _names(db, list(run.shop_ids or []), Shop),
        "machines": _names(db, list(run.machine_ids or []), POSMachine),
    }


def item_out(item: ZCreditReconItem, names: Dict[str, str]) -> Dict[str, Any]:
    is_refund = (item.zc_deal_type or "") == "51"
    return {
        "id": str(item.id),
        "runId": str(item.run_id),
        "category": item.category,
        "categoryLabel": svc.CATEGORY_LABELS.get(item.category, item.category),
        "severity": svc.CATEGORY_SEVERITY.get(item.category, "warning"),
        "reason": item.reason,
        "zcredit": None if item.zc_source is None else {
            "reference": item.zc_reference,
            "amount": svc.shekels(item.zc_amount_agorot),
            "statusCode": item.zc_status_code,
            "statusLabel": STATUS_LABELS.get(item.zc_status_code) if item.zc_status_code else None,
            "dealType": item.zc_deal_type,
            "isRefund": is_refund,
            "depositId": item.zc_deposit_id,
            "cardLast4": item.zc_card_last4,
            "cardName": item.zc_card_name,
            "payments": item.zc_payments,
            "approval": item.zc_approval,
            "savedAt": item.zc_save_date.isoformat(timespec="seconds") if item.zc_save_date else None,
            "source": item.zc_source,
        },
        "ours": None if item.payment_id is None else {
            "transactionId": str(item.transaction_id) if item.transaction_id else None,
            "paymentId": str(item.payment_id),
            "machineId": str(item.machine_id) if item.machine_id else None,
            "machineName": names.get(str(item.machine_id)) if item.machine_id else None,
            "shopId": str(item.shop_id) if item.shop_id else None,
            "documentNumber": item.document_number,
            "documentType": item.document_type,
            "amount": svc.shekels(item.our_amount_agorot),
            "status": item.our_status,
            "cardLast4": item.our_card_last4,
            "createdAt": _iso(item.our_created_at),
            "transmitted": item.our_transmitted,
            "batch": item.our_batch,
        },
        "related": [
            {**r, "amount": svc.shekels(r.get("amountAgorot")) if isinstance(r.get("amountAgorot"), int) else None}
            for r in (item.related or []) if isinstance(r, dict)
        ],
        "handled": None if item.handled_at is None else {
            "at": _iso(item.handled_at),
            "by": item.handled_by_name,
            "note": item.handled_note,
        },
        # "צור זיכוי": a charge (not a refund) at Z-Credit with no document of ours.
        "canCredit": item.category == "zcredit_only" and not is_refund,
    }


def _open_hard(db: Session, run_ids: List[uuid.UUID]) -> Dict[uuid.UUID, int]:
    from sqlalchemy import func

    if not run_ids:
        return {}
    rows = (
        db.query(ZCreditReconItem.run_id, func.count(ZCreditReconItem.id))
        .filter(
            ZCreditReconItem.run_id.in_(run_ids),
            ZCreditReconItem.category.in_(HARD_CATEGORIES),
            ZCreditReconItem.handled_at.is_(None),
        )
        .group_by(ZCreditReconItem.run_id)
        .all()
    )
    return {r: n for r, n in rows}


def _latest(runs: List[ZCreditReconRun]) -> List[ZCreditReconRun]:
    """The latest run per terminal and day (a running one counts: it is the newest word)."""
    out: Dict[tuple, ZCreditReconRun] = {}
    for r in sorted(runs, key=lambda r: r.started_at):
        out[(r.terminal_key, r.business_date)] = r
    return sorted(out.values(), key=lambda r: (r.business_date, r.terminal_last4 or ""), reverse=True)


# ── Routes ────────────────────────────────────────────────────────────────────


@router.get("/terminals")
def get_terminals(
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    tenant_id = _tenant(active_tenant_id)
    scope = _scope(db, current_user, tenant_id, [shop_id] if shop_id else None)
    terminals, problems = svc.terminals_in_scope(db, tenant_id, scope.keys())
    out = []
    for t in terminals:
        enabled, at = svc.terminal_schedule(db, t)
        last = (
            db.query(ZCreditReconRun)
            .filter(ZCreditReconRun.tenant_id == tenant_id, ZCreditReconRun.terminal_key == t.key)
            .order_by(ZCreditReconRun.started_at.desc())
            .first()
        )
        out.append({
            "key": t.key,
            "last4": t.last4,
            "terminal": svc.masked(t.last4),
            "enabled": enabled,
            "runTime": at,
            "shops": _names(db, [str(i) for i in t.shop_ids], Shop),
            "machines": [{"id": str(m.id), "name": m.name, "active": bool(getattr(m, "is_active", True))} for m in t.machines if str(m.id) in scope],
            "lastRun": None if last is None else {
                "id": str(last.id), "businessDate": last.business_date.isoformat(), "status": last.status,
                "finishedAt": _iso(last.finished_at),
            },
        })
    return {
        "terminals": out,
        "problems": [
            {"machineId": str(p.machine.id), "machineName": p.machine.name, "code": p.code, "message": p.message}
            for p in problems
        ],
        "categories": [{"key": c, "label": svc.CATEGORY_LABELS[c], "severity": svc.CATEGORY_SEVERITY[c]} for c in RECON_CATEGORIES],
    }


@router.get("/runs")
def get_runs(
    from_date: Optional[date] = Query(None, alias="from"),
    to_date: Optional[date] = Query(None, alias="to"),
    terminal_key: Optional[str] = Query(None, alias="terminalKey"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    history: bool = Query(False, description="every run, not only the latest per terminal and day"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    tenant_id = _tenant(active_tenant_id)
    to_date = to_date or _today(db, tenant_id)
    from_date = from_date or (to_date - timedelta(days=6))
    if from_date > to_date:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="טווח תאריכים לא תקין")
    if (to_date - from_date).days > RANGE_MAX_DAYS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"עד {RANGE_MAX_DAYS} ימים בטווח")
    scope = _scope(db, current_user, tenant_id, [shop_id] if shop_id else None)
    q = db.query(ZCreditReconRun).filter(
        ZCreditReconRun.tenant_id == tenant_id,
        ZCreditReconRun.business_date >= from_date,
        ZCreditReconRun.business_date <= to_date,
    )
    if terminal_key:
        q = q.filter(ZCreditReconRun.terminal_key == terminal_key)
    runs = [r for r in q.all() if _visible(r, scope)]
    runs = sorted(runs, key=lambda r: r.started_at, reverse=True) if history else _latest(runs)
    hard = _open_hard(db, [r.id for r in runs])
    return {"runs": [run_out(db, r, open_hard=hard.get(r.id, 0)) for r in runs]}


@router.get("/runs/{run_id}")
def get_run(
    run_id: uuid.UUID,
    category: Optional[List[str]] = Query(None),
    open_only: bool = Query(False, alias="openOnly"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    tenant_id = _tenant(active_tenant_id)
    scope = _scope(db, current_user, tenant_id)
    run = _run_or_404(db, run_id, tenant_id, scope)
    q = db.query(ZCreditReconItem).filter(ZCreditReconItem.run_id == run.id)
    wanted = [c for raw in (category or []) for c in str(raw).split(",") if c.strip()]
    bad = [c for c in wanted if c not in RECON_CATEGORIES]
    if bad:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unknown categories: {', '.join(bad)}")
    if wanted:
        q = q.filter(ZCreditReconItem.category.in_(wanted))
    if open_only:
        q = q.filter(ZCreditReconItem.handled_at.is_(None))
    items = [i for i in q.all() if i.machine_id is None or str(i.machine_id) in scope]
    order = {c: n for n, c in enumerate(("zcredit_only", "ours_only", "amount_mismatch", "status_mismatch", "duplicate", "deposit_mismatch", "matched"))}
    items.sort(key=lambda i: (order.get(i.category, 9), i.zc_save_date or datetime.min, str(i.id)))
    names = {k: m.name for k, m in scope.items()}
    hard = _open_hard(db, [run.id])
    return {**run_out(db, run, open_hard=hard.get(run.id, 0)), "items": [item_out(i, names) for i in items]}


class RunIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    business_date: Optional[date] = Field(None, alias="date")
    terminalKey: Optional[str] = Field(None, max_length=32)
    shopId: Optional[uuid.UUID] = None


@router.post("/run")
def post_run(
    body: RunIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """"הרץ התאמה עכשיו" — reads Z-Credit (read-only) and stores the result; the day defaults to yesterday."""
    tenant_id = _tenant(active_tenant_id)
    scope = _scope(db, current_user, tenant_id, [body.shopId] if body.shopId else None)
    today = _today(db, tenant_id)
    day = body.business_date or (today - timedelta(days=1))
    if day > today:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="אי אפשר להריץ התאמה ליום עתידי")
    runs, problems = svc.run_now(db, current_user, tenant_id, scope.keys(), day, key=body.terminalKey)
    if not runs and not problems:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="אין בהרשאות שלך קופות שסולקות ב-Z-Credit")
    hard = _open_hard(db, [r.id for r in runs])
    return {
        "runs": [run_out(db, r, open_hard=hard.get(r.id, 0)) for r in runs],
        "problems": [
            {"machineId": str(p.machine.id), "machineName": p.machine.name, "code": p.code, "message": p.message}
            for p in problems
        ],
    }


class HandleIn(BaseModel):
    note: Optional[str] = Field(None, max_length=svc.NOTE_MAX)


@router.post("/items/{item_id}/handle")
def post_handle(
    item_id: uuid.UUID,
    body: HandleIn,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    tenant_id = _tenant(active_tenant_id)
    scope = _scope(db, current_user, tenant_id)
    item = _item_or_404(db, item_id, tenant_id, scope)
    svc.mark_handled(db, item, current_user, body.note)
    return item_out(item, {k: m.name for k, m in scope.items()})


@router.post("/items/{item_id}/reopen")
def post_reopen(
    item_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    tenant_id = _tenant(active_tenant_id)
    scope = _scope(db, current_user, tenant_id)
    item = _item_or_404(db, item_id, tenant_id, scope)
    svc.reopen(db, item)
    return item_out(item, {k: m.name for k, m in scope.items()})


@router.get("/attention")
def get_attention(
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    days: int = Query(14, ge=1, le=RANGE_MAX_DAYS),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The cockpit's badge: open ❌ (no document / no Z-Credit transaction) in the latest runs."""
    tenant_id = _tenant(active_tenant_id)
    scope = _scope(db, current_user, tenant_id, [shop_id] if shop_id else None)
    since = _today(db, tenant_id) - timedelta(days=days)
    runs = [
        r for r in db.query(ZCreditReconRun).filter(
            ZCreditReconRun.tenant_id == tenant_id, ZCreditReconRun.business_date >= since,
        ).all()
        if _visible(r, scope)
    ]
    latest = _latest(runs)
    out = []
    for r in latest:
        items = [
            i for i in db.query(ZCreditReconItem).filter(
                ZCreditReconItem.run_id == r.id,
                ZCreditReconItem.category.in_(HARD_CATEGORIES),
                ZCreditReconItem.handled_at.is_(None),
            ).all()
            if i.machine_id is None or str(i.machine_id) in scope
        ]
        if not items:
            continue
        out.append({
            "runId": str(r.id),
            "terminalKey": r.terminal_key,
            "terminal": svc.masked(r.terminal_last4),
            "businessDate": r.business_date.isoformat(),
            "finishedAt": _iso(r.finished_at),
            "zcreditOnly": sum(1 for i in items if i.category == "zcredit_only"),
            "oursOnly": sum(1 for i in items if i.category == "ours_only"),
        })
    failed = [
        {"runId": str(r.id), "terminal": svc.masked(r.terminal_last4), "businessDate": r.business_date.isoformat(),
         "errorMessage": r.error_message}
        for r in latest if r.status == "failed"
    ]
    return {"open": sum(o["zcreditOnly"] + o["oursOnly"] for o in out), "runs": out, "failed": failed}
