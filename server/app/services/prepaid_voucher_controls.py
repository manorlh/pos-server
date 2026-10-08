"""
Production vouchers — the redemption controls of the spec's §18 (the contract's helper section):

* **Pause** ("השהיית מימושים", §18.4) — an event, a batch, a type or a production stops redeeming,
  with a reason and an optional end ("עד"). Every till is told at once — the next scan:
  `prepaid_voucher_paused`, "מימוש השוברים מושהה: {reason}". Resuming is logged; codes never change.
* **Quota** ("מכסת מימושים", §18.3) — at most N redemptions of a production, event, type or batch:
  overall, per local day, or within a range. Counted: redemptions not reversed, and sales holding a
  voucher right now (another voucher's), so two tills never both take the last one (a Postgres lock
  per quota, taken last). Refusal `prepaid_voucher_quota_reached`, "הגעת למכסת המימושים של …".
* **Staff test vouchers** ("שוברי בדיקה", §18.5) — a batch marked as test is redeemable only at a till
  whose shop is in training mode ("מצב הדרכה": its documents never reach revenue, Z or stock);
  anywhere else `prepaid_voucher_test_only`, "שובר בדיקה — ניתן לממש רק בקופת בדיקה". A test batch
  is out of every settlement and the commercial reports; its type name says "שובר בדיקה" (receipt,
  paper, lookup). Which till users may redeem one is the till permission `VOUCHER_TEST_REDEEM`.

**The hook.** The core's redemption check (`prepaid_vouchers.refusal_reason`) ends by calling
[refusal_reason] here, and `prepaid_vouchers.refusal_message` asks [refusal_message] for these
codes — so lookup, redeem and reserve all refuse alike. Nothing here runs before the core's own
checks (cancelled, used, validity, shop), and a database without these tables (the migration not
run yet) is never refused.
"""
from __future__ import annotations

import hashlib
import logging
import uuid
import weakref
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Set

from fastapi import status
from sqlalchemy import inspect as sa_inspect, or_, text
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.prepaid_voucher import (
    PrepaidVoucher,
    PrepaidVoucherBatch,
    PrepaidVoucherRedemption,
    PrepaidVoucherReservation,
    PrepaidVoucherType,
)
from app.models.prepaid_voucher_extras import (
    CONTROL_SCOPES,
    QUOTA_PERIODS,
    PrepaidRedemptionPause,
    PrepaidRedemptionQuota,
    PrepaidVoucherTestBatch,
)
from app.models.shop import Shop
from app.models.user import User
from app.services import prepaid_voucher_extras_access as ACC

log = logging.getLogger(__name__)

# ── Refusals (the contract's §8) ──────────────────────────────────────────────
PAUSED = "prepaid_voucher_paused"
QUOTA_REACHED = "prepaid_voucher_quota_reached"
TEST_ONLY = "prepaid_voucher_test_only"
#: What the core's `refusal_message` hands over to [refusal_message].
REFUSALS = (TEST_ONLY, PAUSED, QUOTA_REACHED)

TEST_LABEL = "שובר בדיקה"
TEXT = {
    PAUSED: "מימוש השוברים מושהה: {reason}",
    "paused_until": "מימוש השוברים מושהה עד {until}: {reason}",
    QUOTA_REACHED: "הגעת למכסת המימושים של {scope} ({n} מימושים{period})",
    TEST_ONLY: "שובר בדיקה — ניתן לממש רק בקופת בדיקה",
}
SCOPE_TEXT = {
    "production": "ההפקה \"{label}\"",
    "event": "האירוע \"{label}\"",
    "type": "סוג השובר \"{label}\"",
    "batch": "הסדרה \"{label}\"",
}
PERIOD_TEXT = {"overall": "", "day": " ביום", "range": " בתקופה"}

# ── 4xx details (dashboard) ───────────────────────────────────────────────────
BAD_SCOPE = "prepaid_voucher_control_bad_scope"
BAD_PERIOD = "prepaid_voucher_quota_bad_period"
UNTIL_PAST = "prepaid_voucher_pause_until_past"
PAUSE_NOT_FOUND = "prepaid_voucher_pause_not_found"
QUOTA_NOT_FOUND = "prepaid_voucher_quota_not_found"
TEST_HAS_HISTORY = "prepaid_voucher_test_has_history"
NOT_A_TEST_BATCH = "prepaid_voucher_not_a_test_batch"
ALREADY_TEST = "prepaid_voucher_already_test"

_TABLES = (
    PrepaidRedemptionPause.__tablename__,
    PrepaidRedemptionQuota.__tablename__,
    PrepaidVoucherTestBatch.__tablename__,
)
_READY: "weakref.WeakKeyDictionary[Any, bool]" = weakref.WeakKeyDictionary()


def _pv():
    from app.services import prepaid_vouchers as PV

    return PV


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment.replace(tzinfo=timezone.utc) if moment.tzinfo is None else moment.astimezone(timezone.utc)


def tables_ready(db: Session) -> bool:
    """Whether this database has the controls' tables (an API ahead of its migration has not)."""
    try:
        bind = db.get_bind()
    except Exception:  # noqa: BLE001
        return False
    engine = getattr(bind, "engine", bind)
    try:
        if _READY.get(engine):
            return True
    except TypeError:
        pass
    try:
        insp = sa_inspect(db.connection())
        ok = all(insp.has_table(t) for t in _TABLES)
    except Exception:  # noqa: BLE001
        return False
    if ok:
        try:
            _READY[engine] = True
        except TypeError:
            pass
    else:
        log.warning("prepaid voucher controls: tables missing (migration not run) — no pause / quota / test checks")
    return ok


# ── Which batches a scope takes ───────────────────────────────────────────────


def batch_keys(batch: PrepaidVoucherBatch) -> Dict[str, Set[str]]:
    """The values a pause / quota of each scope kind names this batch by."""
    keys: Dict[str, Set[str]] = {"batch": {str(batch.id)}, "type": set(), "production": set(), "event": set()}
    if getattr(batch, "type_id", None):
        keys["type"].add(str(batch.type_id))
    if (batch.customer_name or "").strip():
        keys["production"].add(batch.customer_name.strip())
    if (batch.event_name or "").strip():
        keys["event"].add(batch.event_name.strip())
    # The core's phase d links (a Production entity, a report event) — read when they exist.
    for attr, kind in (("production_id", "production"), ("report_event_id", "event")):
        value = getattr(batch, attr, None)
        if value:
            keys[kind].add(str(value))
    return keys


def _applies(row, batch: PrepaidVoucherBatch, keys: Dict[str, Set[str]]) -> bool:
    if str(row.tenant_id) != str(batch.tenant_id):
        return False
    if row.company_id is not None and str(row.company_id) != str(batch.company_id):
        return False
    return str(row.scope_value).strip() in keys.get(row.scope_kind, set())


def _scope_batch_ids(db: Session, tenant_id, company_id, kind: str, value: str) -> List[uuid.UUID]:
    B = PrepaidVoucherBatch
    q = db.query(B.id).filter(B.tenant_id == tenant_id)
    if company_id is not None:
        q = q.filter(B.company_id == company_id)
    value = str(value).strip()
    if kind == "batch":
        bid = ACC.as_uuid(value)
        q = q.filter(B.id == (bid or uuid.uuid4()))
    elif kind == "type":
        tid = ACC.as_uuid(value)
        q = q.filter(B.type_id == (tid or uuid.uuid4()))
    elif kind == "production":
        conds = [B.customer_name == value]
        if hasattr(B, "production_id") and ACC.as_uuid(value):
            conds.append(B.production_id == ACC.as_uuid(value))
        q = q.filter(or_(*conds))
    else:
        conds = [B.event_name == value]
        if hasattr(B, "report_event_id") and ACC.as_uuid(value):
            conds.append(B.report_event_id == ACC.as_uuid(value))
        q = q.filter(or_(*conds))
    return [i for (i,) in q.all()]


# ── Test batches ──────────────────────────────────────────────────────────────


def is_test(db: Session, batch_id) -> bool:
    bid = ACC.as_uuid(batch_id)
    return bid is not None and db.get(PrepaidVoucherTestBatch, bid) is not None


def test_batch_ids(db: Session, tenant_id) -> Set[str]:
    """Every test batch of the tenant — left out of settlement and the commercial reports."""
    if not tables_ready(db):
        return set()
    return {str(b) for (b,) in db.query(PrepaidVoucherTestBatch.batch_id).filter(PrepaidVoucherTestBatch.tenant_id == tenant_id)}


def _training_till(db: Session, machine: POSMachine) -> bool:
    if machine is None or machine.shop_id is None:
        return False
    return bool(db.query(Shop.training_mode).filter(Shop.id == machine.shop_id).scalar())


# ── Pauses ────────────────────────────────────────────────────────────────────


def _pause_live(p: PrepaidRedemptionPause, now: datetime) -> bool:
    if p.resumed_at is not None:
        return False
    until = _utc(p.until)
    return until is None or now < until


def active_pause(db: Session, batch: PrepaidVoucherBatch, now: Optional[datetime] = None) -> Optional[PrepaidRedemptionPause]:
    now = now or _now()
    keys = batch_keys(batch)
    rows = (
        db.query(PrepaidRedemptionPause)
        .filter(PrepaidRedemptionPause.tenant_id == batch.tenant_id, PrepaidRedemptionPause.resumed_at.is_(None))
        .order_by(PrepaidRedemptionPause.created_at)
        .all()
    )
    for p in rows:
        if _pause_live(p, now) and _applies(p, batch, keys):
            return p
    return None


# ── Quotas ────────────────────────────────────────────────────────────────────


def _quota_window(db: Session, q: PrepaidRedemptionQuota, now: datetime):
    """(start, end) the quota counts in now, or None when it does not apply now (a range not running)."""
    if q.period == "day":
        return _pv()._local_day_bounds(db, q.tenant_id, now)
    if q.period == "range":
        start, end = _utc(q.period_from), _utc(q.period_to)
        if (start is not None and now < start) or (end is not None and now >= end):
            return None
        return start, end
    return None, None


def quota_used(
    db: Session, q: PrepaidRedemptionQuota, now: Optional[datetime] = None, *, exclude_voucher_id=None, window=False,
) -> Optional[int]:
    """Redemptions the quota has counted now (None: a range quota not running now)."""
    now = now or _now()
    bounds = _quota_window(db, q, now)
    if bounds is None:
        return None
    start, end = bounds
    ids = _scope_batch_ids(db, q.tenant_id, q.company_id, q.scope_kind, q.scope_value)
    if not ids:
        return 0
    R = PrepaidVoucherRedemption
    rq = db.query(R.id).filter(R.batch_id.in_(ids), R.reversed_at.is_(None))
    if start is not None:
        rq = rq.filter(R.redeemed_at >= start)
    if end is not None:
        rq = rq.filter(R.redeemed_at < end)
    used = rq.count()
    H = PrepaidVoucherReservation
    hq = db.query(H).filter(H.batch_id.in_(ids), H.status == "held")
    if exclude_voucher_id is not None:
        hq = hq.filter(H.voucher_id != exclude_voucher_id)
    held = sum(1 for h in hq if _utc(h.expires_at) and _utc(h.expires_at) > now)
    return used + held


def _lock(db: Session, quotas: Iterable[PrepaidRedemptionQuota]) -> None:
    """One transaction lock per quota (Postgres), in a fixed order: two tills never both take the last one."""
    try:
        if db.get_bind().dialect.name != "postgresql":
            return
    except Exception:  # noqa: BLE001
        return
    for q in sorted(quotas, key=lambda x: str(x.id)):
        key = int.from_bytes(hashlib.sha256(f"pv-quota:{q.id}".encode()).digest()[:8], "big", signed=True)
        db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": key})


def reached_quota(db: Session, batch: PrepaidVoucherBatch, voucher: Optional[PrepaidVoucher] = None,
                  now: Optional[datetime] = None, *, lock: bool = True) -> Optional[PrepaidRedemptionQuota]:
    now = now or _now()
    keys = batch_keys(batch)
    quotas = [
        q for q in db.query(PrepaidRedemptionQuota).filter(
            PrepaidRedemptionQuota.tenant_id == batch.tenant_id, PrepaidRedemptionQuota.active.is_(True)
        )
        if _applies(q, batch, keys)
    ]
    if not quotas:
        return None
    if lock:
        _lock(db, quotas)
    for q in sorted(quotas, key=lambda x: str(x.id)):
        used = quota_used(db, q, now, exclude_voucher_id=getattr(voucher, "id", None))
        if used is not None and used >= int(q.max_redemptions):
            return q
    return None


# ── The hook ──────────────────────────────────────────────────────────────────


def refusal_reason(db: Session, machine: POSMachine, voucher: PrepaidVoucher, now: Optional[datetime] = None) -> Optional[str]:
    """
    Called last by `prepaid_vouchers.refusal_reason` (lookup, redeem, reserve): a test voucher at a
    till not in training mode, a paused event / batch / type / production, a quota reached — in
    that order. None: nothing of these stops it.
    """
    if voucher is None or not tables_ready(db):
        return None
    now = now or _now()
    batch = voucher.batch
    if is_test(db, batch.id) and not _training_till(db, machine):
        return TEST_ONLY
    if active_pause(db, batch, now) is not None:
        return PAUSED
    if reached_quota(db, batch, voucher, now) is not None:
        return QUOTA_REACHED
    return None


def _local_text(db: Session, tenant_id, moment: datetime, now: datetime) -> str:
    from app.services.prepaid_voucher_analytics import zone_of

    zone = zone_of(db, tenant_id)
    local = _utc(moment).astimezone(zone)
    if local.date() == now.astimezone(zone).date():
        return local.strftime("%H:%M")
    return local.strftime("%d/%m %H:%M")


def _scope_label(db: Session, kind: str, value: str, label: Optional[str]) -> str:
    if label:
        return label
    if kind == "type":
        name = db.query(PrepaidVoucherType.name).filter(PrepaidVoucherType.id == ACC.as_uuid(value)).scalar() if ACC.as_uuid(value) else None
        return name or value
    if kind == "batch":
        name = db.query(PrepaidVoucherBatch.name).filter(PrepaidVoucherBatch.id == ACC.as_uuid(value)).scalar() if ACC.as_uuid(value) else None
        return name or value
    return value


def quota_text(db: Session, q: PrepaidRedemptionQuota) -> str:
    scope = SCOPE_TEXT.get(q.scope_kind, "{label}").format(label=_scope_label(db, q.scope_kind, q.scope_value, q.scope_label))
    return TEXT[QUOTA_REACHED].format(scope=scope, n=int(q.max_redemptions), period=PERIOD_TEXT.get(q.period, ""))


def pause_text(db: Session, p: PrepaidRedemptionPause, now: Optional[datetime] = None) -> str:
    now = now or _now()
    if p.until is not None:
        return TEXT["paused_until"].format(until=_local_text(db, p.tenant_id, p.until, now), reason=p.reason)
    return TEXT[PAUSED].format(reason=p.reason)


def refusal_message(db: Session, voucher: PrepaidVoucher, reason: Optional[str], now: Optional[datetime] = None) -> Optional[str]:
    """The Hebrew for one of [REFUSALS] (`prepaid_vouchers.refusal_message` asks)."""
    now = now or _now()
    if reason == TEST_ONLY:
        return TEXT[TEST_ONLY]
    if not tables_ready(db) or voucher is None:
        return None
    batch = voucher.batch
    if reason == PAUSED:
        p = active_pause(db, batch, now)
        return pause_text(db, p, now) if p is not None else TEXT[PAUSED].format(reason="").rstrip(": ")
    if reason == QUOTA_REACHED:
        q = reached_quota(db, batch, voucher, now, lock=False)
        return quota_text(db, q) if q is not None else None
    return None


# ── Dashboard: pauses ─────────────────────────────────────────────────────────


def _check_scope(db: Session, user: User, tenant_id, kind: str, value: str, company_id) -> Dict[str, Any]:
    """The scope a pause / quota names, checked: a batch the user manages, a type of the tenant."""
    PV = _pv()
    if kind not in CONTROL_SCOPES:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_SCOPE)
    value = str(value).strip()
    if not value:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_SCOPE)
    label = value
    company = company_id
    if kind == "batch":
        batch = PV.get_batch(db, user, tenant_id, value)
        label, company, value = batch.name, batch.company_id, str(batch.id)
    elif kind == "type":
        t = db.query(PrepaidVoucherType).filter(
            PrepaidVoucherType.id == (ACC.as_uuid(value) or uuid.uuid4()), PrepaidVoucherType.tenant_id == tenant_id
        ).first()
        if t is None:
            raise ACC.http(status.HTTP_404_NOT_FOUND, BAD_SCOPE)
        label, value = t.name, str(t.id)
        company = company or t.company_id
    if company is not None and not PV._covers_company(db, user, company):
        if kind != "batch":
            raise ACC.http(status.HTTP_403_FORBIDDEN, PV.FORBIDDEN)
    return {"value": value, "label": label, "company_id": ACC.as_uuid(company)}


def _batch_names(db: Session, rows) -> Dict[str, str]:
    ids = [ACC.as_uuid(r.scope_value) for r in rows if r.scope_kind == "batch"]
    ids = [i for i in ids if i]
    if not ids:
        return {}
    return {str(i): n for i, n in db.query(PrepaidVoucherBatch.id, PrepaidVoucherBatch.name).filter(PrepaidVoucherBatch.id.in_(ids))}


def pause_out(db: Session, p: PrepaidRedemptionPause, now: Optional[datetime] = None) -> Dict[str, Any]:
    PV = _pv()
    now = now or _now()
    return {
        "id": str(p.id),
        "scopeKind": p.scope_kind,
        "scopeValue": p.scope_value,
        "scopeLabel": p.scope_label or p.scope_value,
        "companyId": str(p.company_id) if p.company_id else None,
        "reason": p.reason,
        "until": PV._iso(p.until),
        "active": _pause_live(p, now),
        "text": pause_text(db, p, now),
        "createdAt": PV._iso(p.created_at),
        "createdBy": p.created_by_name,
        "resumedAt": PV._iso(p.resumed_at),
        "resumedBy": p.resumed_by_name,
        "resumeNote": p.resume_note,
    }


def _visible(db: Session, user: User, company_id) -> bool:
    """A pause / quota of a company the user covers, or of no company (the scope's own batches decide)."""
    return company_id is None or _pv()._covers_company(db, user, company_id) or user.shop_id is not None


def list_pauses(db: Session, user: User, tenant_id, *, active_only: bool = False) -> Dict[str, Any]:
    PV = _pv()
    PV._require_role(user)
    ACC.require(db, user, ACC.CONTROLS_SECTION, "view", ACC.CONTROLS_FORBIDDEN)
    now = _now()
    rows = (
        db.query(PrepaidRedemptionPause)
        .filter(PrepaidRedemptionPause.tenant_id == tenant_id)
        .order_by(PrepaidRedemptionPause.created_at.desc())
        .limit(500)
        .all()
    )
    out = [pause_out(db, p, now) for p in rows if _visible(db, user, p.company_id)]
    if active_only:
        out = [p for p in out if p["active"]]
    return {"items": out, "editable": ACC.allows(db, user, ACC.CONTROLS_SECTION, "edit")}


def create_pause(db: Session, user: User, tenant_id, body) -> PrepaidRedemptionPause:
    PV = _pv()
    PV._require_role(user)
    ACC.require(db, user, ACC.CONTROLS_SECTION, "edit", ACC.CONTROLS_FORBIDDEN)
    scope = _check_scope(db, user, tenant_id, body.scope_kind, body.scope_value, body.company_id)
    now = _now()
    until = _utc(body.until)
    if until is not None and until <= now:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, UNTIL_PAST)
    p = PrepaidRedemptionPause(
        id=uuid.uuid4(), tenant_id=tenant_id, company_id=scope["company_id"], scope_kind=body.scope_kind,
        scope_value=scope["value"], scope_label=scope["label"], reason=body.reason.strip(), until=until,
        created_by=user.id, created_by_name=ACC.user_name(user), created_at=now,
    )
    db.add(p)
    ACC.audit(
        db, tenant_id, "pause", user, ref_id=p.id,
        batch_id=scope["value"] if body.scope_kind == "batch" else None, reason=p.reason,
        details={"scopeKind": p.scope_kind, "scopeValue": p.scope_value, "scopeLabel": p.scope_label,
                 "until": PV._iso(until)},
    )
    db.flush()
    return p


def resume_pause(db: Session, user: User, tenant_id, pause_id, note: Optional[str] = None) -> PrepaidRedemptionPause:
    PV = _pv()
    PV._require_role(user)
    ACC.require(db, user, ACC.CONTROLS_SECTION, "edit", ACC.CONTROLS_FORBIDDEN)
    p = db.query(PrepaidRedemptionPause).filter(
        PrepaidRedemptionPause.id == (ACC.as_uuid(pause_id) or uuid.uuid4()), PrepaidRedemptionPause.tenant_id == tenant_id
    ).first()
    if p is None:
        raise ACC.http(status.HTTP_404_NOT_FOUND, PAUSE_NOT_FOUND)
    if p.resumed_at is None:
        now = _now()
        p.resumed_at = now
        p.resumed_by_name = ACC.user_name(user)
        p.resume_note = (note or "").strip() or None
        ACC.audit(
            db, tenant_id, "resume", user, ref_id=p.id, reason=p.resume_note,
            batch_id=p.scope_value if p.scope_kind == "batch" else None,
            details={"scopeKind": p.scope_kind, "scopeValue": p.scope_value, "pausedAt": PV._iso(p.created_at)},
        )
        db.flush()
    return p


# ── Dashboard: quotas ─────────────────────────────────────────────────────────


def quota_out(db: Session, q: PrepaidRedemptionQuota, now: Optional[datetime] = None) -> Dict[str, Any]:
    PV = _pv()
    now = now or _now()
    used = quota_used(db, q, now) if q.active else None
    maximum = int(q.max_redemptions)
    percent = None if used is None or maximum <= 0 else round(100.0 * used / maximum, 1)
    return {
        "id": str(q.id),
        "scopeKind": q.scope_kind,
        "scopeValue": q.scope_value,
        "scopeLabel": q.scope_label or q.scope_value,
        "companyId": str(q.company_id) if q.company_id else None,
        "maxRedemptions": maximum,
        "period": q.period,
        "periodFrom": PV._iso(q.period_from),
        "periodTo": PV._iso(q.period_to),
        "warnPercent": int(q.warn_percent or 80),
        "active": bool(q.active),
        "note": q.note,
        "used": used,
        "percent": percent,
        "reached": used is not None and used >= maximum,
        "warning": used is not None and maximum > 0 and used * 100 >= maximum * int(q.warn_percent or 80),
        "text": quota_text(db, q),
        "createdAt": PV._iso(q.created_at),
        "createdBy": q.created_by_name,
    }


def list_quotas(db: Session, user: User, tenant_id) -> Dict[str, Any]:
    PV = _pv()
    PV._require_role(user)
    ACC.require(db, user, ACC.CONTROLS_SECTION, "view", ACC.CONTROLS_FORBIDDEN)
    now = _now()
    rows = (
        db.query(PrepaidRedemptionQuota)
        .filter(PrepaidRedemptionQuota.tenant_id == tenant_id)
        .order_by(PrepaidRedemptionQuota.active.desc(), PrepaidRedemptionQuota.created_at.desc())
        .limit(500)
        .all()
    )
    return {"items": [quota_out(db, q, now) for q in rows if _visible(db, user, q.company_id)],
            "editable": ACC.allows(db, user, ACC.CONTROLS_SECTION, "edit")}


def _check_period(period: str, start: Optional[datetime], end: Optional[datetime]) -> None:
    if period not in QUOTA_PERIODS:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_PERIOD)
    if period == "range" and start is None and end is None:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_PERIOD)
    if start is not None and end is not None and _utc(end) <= _utc(start):
        raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_PERIOD)


def _quota_state(q: PrepaidRedemptionQuota) -> Dict[str, Any]:
    PV = _pv()
    return {"maxRedemptions": q.max_redemptions, "warnPercent": q.warn_percent, "active": bool(q.active),
            "periodFrom": PV._iso(q.period_from), "periodTo": PV._iso(q.period_to), "note": q.note}


def create_quota(db: Session, user: User, tenant_id, body) -> PrepaidRedemptionQuota:
    PV = _pv()
    PV._require_role(user)
    ACC.require(db, user, ACC.CONTROLS_SECTION, "edit", ACC.CONTROLS_FORBIDDEN)
    scope = _check_scope(db, user, tenant_id, body.scope_kind, body.scope_value, body.company_id)
    _check_period(body.period, body.period_from, body.period_to)
    q = PrepaidRedemptionQuota(
        id=uuid.uuid4(), tenant_id=tenant_id, company_id=scope["company_id"], scope_kind=body.scope_kind,
        scope_value=scope["value"], scope_label=scope["label"], max_redemptions=int(body.max_redemptions),
        period=body.period,
        period_from=_utc(body.period_from) if body.period == "range" else None,
        period_to=_utc(body.period_to) if body.period == "range" else None,
        warn_percent=int(body.warn_percent or 80), active=True, note=(body.note or "").strip() or None,
        created_by=user.id, created_by_name=ACC.user_name(user),
    )
    db.add(q)
    db.flush()
    ACC.audit(
        db, tenant_id, "quota_create", user, ref_id=q.id,
        batch_id=q.scope_value if q.scope_kind == "batch" else None,
        details={"scopeKind": q.scope_kind, "scopeValue": q.scope_value, "period": q.period, "after": _quota_state(q)},
    )
    db.flush()
    return q


def update_quota(db: Session, user: User, tenant_id, quota_id, body) -> PrepaidRedemptionQuota:
    """Changing a quota (raising it once reached, too) needs the controls section's edit, and is logged."""
    PV = _pv()
    PV._require_role(user)
    ACC.require(db, user, ACC.CONTROLS_SECTION, "edit", ACC.CONTROLS_FORBIDDEN)
    q = db.query(PrepaidRedemptionQuota).filter(
        PrepaidRedemptionQuota.id == (ACC.as_uuid(quota_id) or uuid.uuid4()), PrepaidRedemptionQuota.tenant_id == tenant_id
    ).first()
    if q is None:
        raise ACC.http(status.HTTP_404_NOT_FOUND, QUOTA_NOT_FOUND)
    before = _quota_state(q)
    fields = body.model_fields_set
    if "max_redemptions" in fields and body.max_redemptions is not None:
        q.max_redemptions = int(body.max_redemptions)
    if "warn_percent" in fields and body.warn_percent is not None:
        q.warn_percent = int(body.warn_percent)
    if "active" in fields and body.active is not None:
        q.active = bool(body.active)
    if "note" in fields:
        q.note = (body.note or "").strip() or None
    if q.period == "range":
        start = _utc(body.period_from) if "period_from" in fields else _utc(q.period_from)
        end = _utc(body.period_to) if "period_to" in fields else _utc(q.period_to)
        _check_period("range", start, end)
        q.period_from, q.period_to = start, end
    after = _quota_state(q)
    if after != before:
        ACC.audit(
            db, tenant_id, "quota_update", user, ref_id=q.id, reason=(body.reason or "").strip() or None,
            batch_id=q.scope_value if q.scope_kind == "batch" else None,
            details={"before": before, "after": after},
        )
    db.flush()
    return q


# ── Dashboard: test batches ───────────────────────────────────────────────────


def _labelled(text_value: Optional[str]) -> Optional[str]:
    if not text_value:
        return TEST_LABEL
    if TEST_LABEL in text_value:
        return text_value
    return f"{TEST_LABEL} · {text_value}"[:200]


def _has_history(db: Session, batch: PrepaidVoucherBatch) -> bool:
    from app.models.prepaid_voucher_extras import PrepaidSettlementInvoiceLine, PrepaidVoucherDelivery

    if db.query(PrepaidVoucherRedemption.id).filter(PrepaidVoucherRedemption.batch_id == batch.id).first():
        return True
    if db.query(PrepaidVoucherDelivery.id).filter(PrepaidVoucherDelivery.batch_id == batch.id,
                                                  PrepaidVoucherDelivery.voided_at.is_(None)).first():
        return True
    return db.query(PrepaidSettlementInvoiceLine.id).filter(PrepaidSettlementInvoiceLine.batch_id == batch.id).first() is not None


def mark_test(db: Session, user: User, tenant_id, batch_id, note: Optional[str] = None, *, created: bool = False) -> PrepaidVoucherBatch:
    """
    A batch becomes staff test vouchers — only before anything real happened to it (no redemption,
    delivery or invoice: a real voucher never leaves a settlement this way). Its names say "שובר בדיקה".
    """
    PV = _pv()
    PV._require_role(user)
    ACC.require(db, user, ACC.CONTROLS_SECTION, "edit", ACC.CONTROLS_FORBIDDEN)
    batch = PV.get_batch(db, user, tenant_id, batch_id)
    if is_test(db, batch.id):
        raise ACC.http(status.HTTP_409_CONFLICT, ALREADY_TEST)
    if _has_history(db, batch):
        raise ACC.http(status.HTTP_409_CONFLICT, TEST_HAS_HISTORY)
    before = {"name": batch.name, "typeName": batch.type_name}
    db.add(PrepaidVoucherTestBatch(
        batch_id=batch.id, tenant_id=batch.tenant_id, note=(note or "").strip() or None,
        created_by=user.id, created_by_name=ACC.user_name(user),
    ))
    batch.name = _labelled(batch.name)
    batch.type_name = _labelled(batch.type_name)
    PV._event(db, batch, user, "test_mark", reason=note, details={"before": before})
    ACC.audit(db, tenant_id, "test_create" if created else "test_mark", user, ref_id=batch.id, batch_id=batch.id,
              reason=(note or "").strip() or None, details={"before": before,
                                                            "after": {"name": batch.name, "typeName": batch.type_name}})
    db.flush()
    return batch


def unmark_test(db: Session, user: User, tenant_id, batch_id, note: Optional[str] = None) -> PrepaidVoucherBatch:
    """A test batch nobody redeemed may become an ordinary batch again (its names lose the label)."""
    PV = _pv()
    PV._require_role(user)
    ACC.require(db, user, ACC.CONTROLS_SECTION, "edit", ACC.CONTROLS_FORBIDDEN)
    batch = PV.get_batch(db, user, tenant_id, batch_id)
    row = db.get(PrepaidVoucherTestBatch, batch.id)
    if row is None:
        raise ACC.http(status.HTTP_409_CONFLICT, NOT_A_TEST_BATCH)
    if _has_history(db, batch):
        raise ACC.http(status.HTTP_409_CONFLICT, TEST_HAS_HISTORY)
    before = {"name": batch.name, "typeName": batch.type_name}
    prefix = f"{TEST_LABEL} · "
    for attr in ("name", "type_name"):
        value = getattr(batch, attr)
        if value and value.startswith(prefix):
            setattr(batch, attr, value[len(prefix):])
        elif value == TEST_LABEL:
            setattr(batch, attr, None if attr == "type_name" else value)
    db.delete(row)
    PV._event(db, batch, user, "test_unmark", reason=note, details={"before": before})
    ACC.audit(db, tenant_id, "test_unmark", user, ref_id=batch.id, batch_id=batch.id, reason=(note or "").strip() or None,
              details={"before": before, "after": {"name": batch.name, "typeName": batch.type_name}})
    db.flush()
    return batch


def create_test_batch(db: Session, user: User, tenant_id, body) -> PrepaidVoucherBatch:
    """A new batch made by the core's form (`create_batch`), marked as test in the same transaction."""
    PV = _pv()
    ACC.require(db, user, ACC.CONTROLS_SECTION, "edit", ACC.CONTROLS_FORBIDDEN)
    batch = PV.create_batch(db, user, tenant_id, body)
    db.flush()
    return mark_test(db, user, tenant_id, batch.id, getattr(body, "test_note", None), created=True)


def list_test_batches(db: Session, user: User, tenant_id) -> Dict[str, Any]:
    PV = _pv()
    PV._require_role(user)
    ACC.require(db, user, ACC.CONTROLS_SECTION, "view", ACC.CONTROLS_FORBIDDEN)
    rows = db.query(PrepaidVoucherTestBatch).filter(PrepaidVoucherTestBatch.tenant_id == tenant_id).all()
    ids = [r.batch_id for r in rows]
    batches = {str(b.id): b for b in db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id.in_(ids or [uuid.uuid4()]))}
    stats = PV._stats(db, ids) if ids else {}
    out = []
    for r in sorted(rows, key=lambda x: x.created_at or _now(), reverse=True):
        b = batches.get(str(r.batch_id))
        if b is None or not PV.may_manage(db, user, tenant_id, b):
            continue
        s = stats.get(str(b.id)) or PV._empty_counts()
        out.append({
            "batchId": str(b.id),
            "name": b.name,
            "typeName": b.type_name,
            "status": b.status,
            "issued": int(s.get("total", 0)),
            "used": int(s.get("used", 0)) + int(s.get("partiallyUsed", 0)),
            "note": r.note,
            "createdAt": PV._iso(r.created_at),
            "createdBy": r.created_by_name,
            "redeemed": _has_history(db, b),
        })
    return {"items": out, "editable": ACC.allows(db, user, ACC.CONTROLS_SECTION, "edit"), "label": TEST_LABEL}


# ── A batch's controls at a glance (the batch screen's badges) ────────────────


def batch_status(db: Session, user: User, tenant_id, batch_id) -> Dict[str, Any]:
    PV = _pv()
    batch = PV.get_batch(db, user, tenant_id, batch_id)
    now = _now()
    if not tables_ready(db):
        return {"batchId": str(batch.id), "test": False, "pause": None, "quotas": []}
    p = active_pause(db, batch, now)
    keys = batch_keys(batch)
    quotas = [
        quota_out(db, q, now) for q in db.query(PrepaidRedemptionQuota).filter(
            PrepaidRedemptionQuota.tenant_id == batch.tenant_id, PrepaidRedemptionQuota.active.is_(True)
        ) if _applies(q, batch, keys)
    ]
    return {
        "batchId": str(batch.id),
        "test": is_test(db, batch.id),
        "pause": pause_out(db, p, now) if p is not None else None,
        "quotas": quotas,
    }


def events(db: Session, user: User, tenant_id, *, batch_id=None, limit: int = 200) -> Dict[str, Any]:
    from app.models.prepaid_voucher_extras import PrepaidVoucherExtraEvent as E

    PV = _pv()
    PV._require_role(user)
    ACC.require(db, user, ACC.CONTROLS_SECTION, "view", ACC.CONTROLS_FORBIDDEN)
    q = db.query(E).filter(E.tenant_id == tenant_id)
    if batch_id:
        q = q.filter(E.batch_id == (ACC.as_uuid(batch_id) or uuid.uuid4()))
    rows = q.order_by(E.created_at.desc()).limit(max(1, min(int(limit), 1000))).all()
    return {"items": [ACC.event_out(e) for e in rows]}
