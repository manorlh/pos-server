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
  anywhere else `prepaid_voucher_test_only`, "שובר בדיקה — ניתן לממש רק בקופת בדיקה". The till must
  also say it is in training (`features: ["training"]`); a real voucher at a training till is refused
  (`prepaid_voucher_training_real`). A test batch is never offline (forced off, never assigned to a
  device of a shop not in training mode); a test voucher's sale that still arrives on the real path (a
  confirm, an offline sync) is recorded and flagged `test_real` — and no settlement ever counts it. A test batch
  is out of every settlement and the commercial reports; its type name says "שובר בדיקה" (receipt,
  paper, lookup). Which till users may redeem one is the till permission `VOUCHER_TEST_REDEEM`: the
  till asks for it; the cloud refuses (`prepaid_voucher_test_not_permitted`) when the user signed in
  at that till (`pos_user_sessions`) is denied it.

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
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Set

from fastapi import status
from sqlalchemy import func, inspect as sa_inspect, or_, text
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
TEST_NOT_PERMITTED = "prepaid_voucher_test_not_permitted"
#: A real voucher at a till in training mode: its sale would be quarantined, the voucher used up for nothing.
TRAINING_REAL = "prepaid_voucher_training_real"
#: What the core's `refusal_message` hands over to [refusal_message].
REFUSALS = (TEST_ONLY, TEST_NOT_PERMITTED, TRAINING_REAL, PAUSED, QUOTA_REACHED)
#: What a till in training mode says it is (`features`) — a test voucher needs it (review 09.10).
TRAINING_FEATURE = "training"
#: Flags on a redemption the cloud records but does not refuse (a fiscal fact by then): a test voucher
#: redeemed on the real path (`test_real`), redeemed while paused (`paused`), over a quota (`over_quota`).
FLAG_TEST_REAL = "test_real"
FLAG_PAUSED = "paused"
FLAG_OVER_QUOTA = "over_quota"
#: The till permission that redeems a test voucher (app/services/till_permissions.py).
TEST_PERMISSION = "VOUCHER_TEST_REDEEM"

TEST_LABEL = "שובר בדיקה"
TEXT = {
    PAUSED: "מימוש השוברים מושהה: {reason}",
    "paused_until": "מימוש השוברים מושהה עד {until}: {reason}",
    QUOTA_REACHED: "הגעת למכסת המימושים של {scope} ({n}{period})",
    TEST_ONLY: "שובר בדיקה — ניתן לממש רק בקופת בדיקה",
    TEST_NOT_PERMITTED: "שובר בדיקה — לעובד המחובר אין הרשאת \"מימוש שובר בדיקה\"",
    TRAINING_REAL: "הקופה במצב הדרכה — ניתן לממש בה רק שוברי בדיקה",
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
TEST_OFFLINE = "prepaid_voucher_test_assigned_offline"
#: "ערוך סדרה" turning offline redemption on for a test batch.
TEST_NEVER_OFFLINE = "prepaid_voucher_test_never_offline"
NOT_A_TEST_BATCH = "prepaid_voucher_not_a_test_batch"
ALREADY_TEST = "prepaid_voucher_already_test"

_TABLES = (
    PrepaidRedemptionPause.__tablename__,
    PrepaidRedemptionQuota.__tablename__,
    PrepaidVoucherTestBatch.__tablename__,
)
_READY: "weakref.WeakKeyDictionary[Any, bool]" = weakref.WeakKeyDictionary()
_WARNED: List[bool] = []
#: Far from its limit a quota is read without a lock (every lookup and reserve passes here); within
#: this many of it, under its lock — more tills than this racing for one quota's last places at the
#: same instant is not a festival.
LOCK_NEAR = 20
#: How long after its expiry a hold that never ended still takes a quota's place.
HOLD_GRACE = timedelta(hours=24)


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
        with db.begin_nested():  # never abort the caller's transaction (Postgres)
            insp = sa_inspect(db.connection())
            ok = all(insp.has_table(t) for t in _TABLES)
    except Exception:  # noqa: BLE001
        return False
    if ok:
        try:
            _READY[engine] = True
        except TypeError:
            pass
    elif not _WARNED:
        _WARNED.append(True)
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
        conds = [func.trim(B.customer_name) == value]
        if hasattr(B, "production_id") and ACC.as_uuid(value):
            conds.append(B.production_id == ACC.as_uuid(value))
        q = q.filter(or_(*conds))
    else:
        conds = [func.trim(B.event_name) == value]
        if hasattr(B, "report_event_id") and ACC.as_uuid(value):
            conds.append(B.report_event_id == ACC.as_uuid(value))
        q = q.filter(or_(*conds))
    tests = test_batch_ids(db, tenant_id)
    # A staff test redemption never takes a real production's / event's places.
    return [i for (i,) in q.all() if str(i) not in tests]


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


def _staff_denied(db: Session, machine: POSMachine) -> bool:
    """
    Whether the till user signed in at [machine] right now may not redeem a test voucher
    (`VOUCHER_TEST_REDEEM` denied). Known only when the cloud tracks who is signed in there
    (`pos_user_sessions`); otherwise the till's own permission check stands alone. "Approval"
    passes here — the till asks a manager for it.
    """
    try:
        from app.models.pos_user import PosUser
        from app.models.pos_user_session import PosUserSession
        from app.services import till_permissions as TP
        from app.services.till_roles import effective_for_pos_user

        # In a savepoint: a failed statement must not abort the redemption's own transaction (Postgres).
        with db.begin_nested():
            row = (
                db.query(PosUser)
                .join(PosUserSession, PosUserSession.pos_user_id == PosUser.id)
                .filter(PosUserSession.machine_id == machine.id, PosUserSession.released_at.is_(None))
                .order_by(PosUserSession.last_seen_at.desc())
                .first()
            )
        if row is None:
            return False
        return effective_for_pos_user(row).state(TEST_PERMISSION) == TP.DENY
    except Exception:  # noqa: BLE001 — never let this check break a redemption
        log.exception("prepaid voucher controls: the signed-in user's test permission could not be read")
        return False


# ── Pauses ────────────────────────────────────────────────────────────────────


def _pause_live(p: PrepaidRedemptionPause, now: datetime) -> bool:
    if p.resumed_at is not None:
        return False
    until = _utc(p.until)
    return until is None or now < until


def pause_at(db: Session, batch: PrepaidVoucherBatch, moment: datetime) -> Optional[PrepaidRedemptionPause]:
    """The pause that applied to [batch] at [moment] (created by then, not yet resumed nor past its end)."""
    moment = _utc(moment)
    keys = batch_keys(batch)
    for p in db.query(PrepaidRedemptionPause).filter(PrepaidRedemptionPause.tenant_id == batch.tenant_id).order_by(
            PrepaidRedemptionPause.created_at):
        start = _utc(p.created_at)
        stop = min([t for t in (_utc(p.resumed_at), _utc(p.until)) if t is not None], default=None)
        if start is not None and start <= moment and (stop is None or moment < stop) and _applies(p, batch, keys):
            return p
    return None


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
    # A hold neither confirmed nor released counts while live and for HOLD_GRACE after its expiry (its
    # document may still come — review 09.10); later it is an abandoned sale and frees its place.
    hq = db.query(H.id).filter(H.batch_id.in_(ids), H.status == "held", H.expires_at > now - HOLD_GRACE)
    if start is not None:
        hq = hq.filter(H.created_at >= start)
    if end is not None:
        hq = hq.filter(H.created_at < end)
    if exclude_voucher_id is not None:
        hq = hq.filter(H.voucher_id != exclude_voucher_id)
    return used + hq.count()


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
    exclude = getattr(voucher, "id", None)
    for q in sorted(quotas, key=lambda x: str(x.id)):
        used = quota_used(db, q, now, exclude_voucher_id=exclude)
        if used is None:
            continue
        if used < int(q.max_redemptions) - LOCK_NEAR or not lock:
            if used >= int(q.max_redemptions):
                return q
            continue
        # Near the limit: count again under the quota's lock (in id order), so the last one goes to one till.
        _lock(db, [q])
        used = quota_used(db, q, now, exclude_voucher_id=exclude)
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
    test = is_test(db, batch.id)
    if test:
        if not _training_till(db, machine):
            return TEST_ONLY
        if _staff_denied(db, machine):
            return TEST_NOT_PERMITTED
    # A real voucher at a till that *says* it is in training is refused where the client's features are
    # known (`till_view_hook`, `required_features`) — never by the shop's flag alone: a till that has not
    # picked up training mode still sells for real (the core's training rule).
    if active_pause(db, batch, now) is not None:
        return PAUSED
    if not test and reached_quota(db, batch, voucher, now) is not None:
        return QUOTA_REACHED
    return None


def _declares_training(features) -> bool:
    return TRAINING_FEATURE in {str(f).strip().lower() for f in (features or ())}


def required_features(db: Session, batch: PrepaidVoucherBatch, features=None) -> List[str]:
    """
    Hook (`prepaid_vouchers.missing_features` — lookup, redeem, both reserves): a test voucher needs the
    till to say it is in training (`features: ["training"]`); a real voucher at a till that says so is
    refused — 409 `prepaid_voucher_training_real` (its sale is a training document: quarantined, the
    voucher spent for nothing). Lookup never gets here for that (`till_view_hook` answers it first).
    """
    if batch is None or not tables_ready(db):
        return []
    if is_test(db, batch.id):
        return [TRAINING_FEATURE]
    if _declares_training(features):
        raise ACC.http(status.HTTP_409_CONFLICT, TRAINING_REAL)
    return []


def till_view_hook(db: Session, machine, voucher: PrepaidVoucher, features, reason: Optional[str],
                   message: Optional[str]):
    """
    Hook (`prepaid_vouchers.till_view` — lookup and the reserve answers' `voucher`): `isTest` on the
    voucher, and at lookup a real voucher at a till that says it is in training is not redeemable
    (`prepaid_voucher_training_real`, with its Hebrew).
    """
    if voucher is None or not tables_ready(db):
        return reason, message, {"isTest": False}
    test = is_test(db, voucher.batch_id)
    if reason is None and not test and _declares_training(features):
        reason, message = TRAINING_REAL, TEXT[TRAINING_REAL]
    return reason, message, {"isTest": test}


def replay_flags(db: Session, voucher: PrepaidVoucher, from_document: bool) -> List[str]:
    """
    Hook (a confirm answered again — the till confirmed first, its document comes after): a document that
    reaches the cloud's real tables is a real sale (training documents are diverted before), so a test
    voucher in it is flagged `test_real`.
    """
    if voucher is None or not from_document or not tables_ready(db):
        return []
    return [FLAG_TEST_REAL] if is_test(db, voucher.batch_id) else []


def offline_snapshot_fields(db: Session, batch: PrepaidVoucherBatch) -> Dict[str, Any]:
    """
    Hook (`prepaid_voucher_offline._snapshot`): what a device holding [batch] must know of the controls —
    `isTest` (never true in practice: a test batch is never assigned), `paused` ({reason, until, text} or
    null) and `quota` ({maxRedemptions, period, periodFrom, periodTo, used, remaining, text} of the
    quota with the fewest places left, or null). The device refuses while paused and stops at the remaining
    count; what it syncs anyway is flagged (`paused`, `over_quota`).
    """
    if batch is None or not tables_ready(db):
        return {"isTest": False, "paused": None, "quota": None}
    PV = _pv()
    now = _now()
    p = active_pause(db, batch, now)
    paused = {"reason": p.reason, "until": PV._iso(p.until), "text": pause_text(db, p, now)} if p is not None else None
    keys = batch_keys(batch)
    best = None
    for q in db.query(PrepaidRedemptionQuota).filter(PrepaidRedemptionQuota.tenant_id == batch.tenant_id,
                                                     PrepaidRedemptionQuota.active.is_(True)):
        if not _applies(q, batch, keys):
            continue
        used = quota_used(db, q, now)
        if used is None:
            continue
        left = max(0, int(q.max_redemptions) - used)
        if best is None or left < best["remaining"]:
            best = {"quotaId": str(q.id), "maxRedemptions": int(q.max_redemptions), "period": q.period,
                    "periodFrom": PV._iso(q.period_from), "periodTo": PV._iso(q.period_to), "used": used,
                    "remaining": left, "text": quota_text(db, q)}
    return {"isTest": is_test(db, batch.id), "paused": paused, "quota": best}


def redemption_flags(db: Session, machine, voucher: PrepaidVoucher, now: Optional[datetime] = None, *,
                     from_document: bool = False, at: Optional[datetime] = None) -> List[str]:
    """
    Hook (the confirms of reserve → confirm, the offline sync): what a redemption that is recorded
    anyway (the sale is a fiscal fact) did against the controls —
    * `test_real` — a test voucher's sale written at a till not in training mode (real revenue): flagged,
      and a test batch is out of every settlement whatever happens;
    * `paused` — a pause applies to it now (a hold taken before the pause, a device offline);
    * `over_quota` — its quota was already used up without it.
    [machine]: the till that redeemed (a machine or its id); [from_document]: the confirm came with the
    sale's document (always the real path); [at]: when the device redeemed (offline: the pause then).
    """
    if voucher is None or not tables_ready(db):
        return []
    now = _utc(now) or _now()  # a device's time may come without a zone: UTC, as the cloud stores it
    batch = voucher.batch
    if machine is not None and not isinstance(machine, POSMachine):
        machine = db.query(POSMachine).filter(POSMachine.id == ACC.as_uuid(machine)).first()
    flags: List[str] = []
    test = is_test(db, batch.id)
    # A document that reaches the real tables is a real sale (training documents are diverted before).
    if test and (from_document or machine is None or not _training_till(db, machine)):
        flags.append(FLAG_TEST_REAL)
    paused = pause_at(db, batch, _utc(at)) if at is not None else active_pause(db, batch, now)
    if paused is not None:
        flags.append(FLAG_PAUSED)
    if not test and reached_quota(db, batch, voucher, _utc(at) or now, lock=False) is not None:
        flags.append(FLAG_OVER_QUOTA)
    return flags


def offline_assign_check(db: Session, batch: PrepaidVoucherBatch, machine: POSMachine) -> None:
    """
    Hook (`prepaid_voucher_offline.assign`): a test batch is never assigned to a device — not even one of a
    shop in training mode, which may leave training while the device keeps the batch and sells for real
    (`prepaid_voucher_test_assigned_offline`); and no batch is assigned while it is paused.
    """
    if batch is None or not tables_ready(db):
        return
    if is_test(db, batch.id):
        raise ACC.http(status.HTTP_409_CONFLICT, TEST_OFFLINE)
    if active_pause(db, batch) is not None:
        raise ACC.http(status.HTTP_409_CONFLICT, PAUSED)


def edit_check(db: Session, batch: PrepaidVoucherBatch, columns: Dict[str, Any]) -> None:
    """Hook (the core's "ערוך סדרה", `prepaid_voucher_edit.plan_edit`): a test batch never goes offline."""
    if batch is None or not tables_ready(db):
        return
    if columns.get("offline_allowed") is True and is_test(db, batch.id):
        raise ACC.http(status.HTTP_409_CONFLICT, TEST_NEVER_OFFLINE)


def training_refusal(db: Session, voucher: PrepaidVoucher, features) -> Optional[tuple]:
    """
    Hook (the goods reserve, after the core's own checks): (code, Hebrew) when a real voucher is asked for by
    a till that says it is in training — `prepaid_voucher_training_real`; else None.
    """
    if voucher is None or not tables_ready(db) or is_test(db, voucher.batch_id) or not _declares_training(features):
        return None
    return TRAINING_REAL, TEXT[TRAINING_REAL]


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
    n = int(q.max_redemptions)
    count = "מימוש אחד" if n == 1 else f"{n} מימושים"
    return TEXT[QUOTA_REACHED].format(scope=scope, n=count, period=PERIOD_TEXT.get(q.period, ""))


def pause_text(db: Session, p: PrepaidRedemptionPause, now: Optional[datetime] = None) -> str:
    now = now or _now()
    if p.until is not None:
        return TEXT["paused_until"].format(until=_local_text(db, p.tenant_id, p.until, now), reason=p.reason)
    return TEXT[PAUSED].format(reason=p.reason)


def refusal_message(db: Session, voucher: PrepaidVoucher, reason: Optional[str], now: Optional[datetime] = None) -> Optional[str]:
    """The Hebrew for one of [REFUSALS] (`prepaid_vouchers.refusal_message` asks)."""
    now = now or _now()
    if reason in (TEST_ONLY, TEST_NOT_PERMITTED, TRAINING_REAL):
        return TEXT[reason]
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
    """
    The scope a pause / quota names, checked against what [user] manages:

    * a batch — one the user manages (its company is the pause's);
    * a type — of the tenant, of a company the user covers;
    * a production / an event (names) — of a company the user covers: the one given, else the user's
      own company; tenant-wide (no company) only for the super admin / a distributor. A shop manager
      pauses their own batches only.
    """
    from app.models.user import UserRole

    PV = _pv()
    if kind not in CONTROL_SCOPES:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_SCOPE)
    value = str(value).strip()
    if not value:
        raise ACC.http(status.HTTP_400_BAD_REQUEST, BAD_SCOPE)
    if kind == "batch":
        batch = PV.get_batch(db, user, tenant_id, value)
        return {"value": str(batch.id), "label": batch.name, "company_id": batch.company_id}
    company = ACC.as_uuid(company_id)
    label = value
    if kind == "type":
        t = db.query(PrepaidVoucherType).filter(
            PrepaidVoucherType.id == (ACC.as_uuid(value) or uuid.uuid4()), PrepaidVoucherType.tenant_id == tenant_id
        ).first()
        if t is None:
            raise ACC.http(status.HTTP_404_NOT_FOUND, BAD_SCOPE)
        label, value, company = t.name, str(t.id), t.company_id
    elif company is None and user.role not in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        company = getattr(user, "company_id", None)
    if company is None:
        if user.role not in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
            raise ACC.http(status.HTTP_403_FORBIDDEN, PV.FORBIDDEN)
    elif not PV._covers_company(db, user, company):
        raise ACC.http(status.HTTP_403_FORBIDDEN, PV.FORBIDDEN)
    return {"value": value, "label": label, "company_id": company}


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


def _visible(db: Session, user: User, row) -> bool:
    """A pause / quota the user may see: of a batch they manage, of a company they cover, or (no company)
    tenant-wide — which applies to every company, so every manager sees it."""
    PV = _pv()
    if row.scope_kind == "batch":
        b = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == (ACC.as_uuid(row.scope_value) or uuid.uuid4())).first()
        return b is not None and PV.may_manage(db, user, row.tenant_id, b)
    if row.company_id is None:
        return True
    if PV._covers_company(db, user, row.company_id):
        return True
    shop_id = getattr(user, "shop_id", None)
    if shop_id is None:
        return False
    return str(db.query(Shop.company_id).filter(Shop.id == shop_id).scalar()) == str(row.company_id)


def _may_change(db: Session, user: User, row) -> bool:
    """Resuming a pause or changing a quota: what the user could have made (the rules of `_check_scope`)."""
    from app.models.user import UserRole

    PV = _pv()
    if row.scope_kind == "batch":
        b = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == (ACC.as_uuid(row.scope_value) or uuid.uuid4())).first()
        return b is not None and PV.may_manage(db, user, row.tenant_id, b)
    if row.company_id is None:
        return user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR)
    return PV._covers_company(db, user, row.company_id)


def _with_editable(db: Session, user: User, out: Dict[str, Any], row) -> Dict[str, Any]:
    out["editable"] = ACC.allows(db, user, ACC.CONTROLS_SECTION, "edit") and _may_change(db, user, row)
    return out


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
    out = [_with_editable(db, user, pause_out(db, p, now), p) for p in rows if _visible(db, user, p)]
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
    if p is None or not _visible(db, user, p):
        raise ACC.http(status.HTTP_404_NOT_FOUND, PAUSE_NOT_FOUND)
    if not _may_change(db, user, p):
        raise ACC.http(status.HTTP_403_FORBIDDEN, PV.FORBIDDEN)
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
    return {"items": [_with_editable(db, user, quota_out(db, q, now), q) for q in rows if _visible(db, user, q)],
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
    if q is None or not _visible(db, user, q):
        raise ACC.http(status.HTTP_404_NOT_FOUND, QUOTA_NOT_FOUND)
    if not _may_change(db, user, q):
        raise ACC.http(status.HTTP_403_FORBIDDEN, PV.FORBIDDEN)
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
    # Ever assigned to a device offline: it may still sync sales made with it.
    from app.models.prepaid_voucher import PrepaidVoucherOfflineAssignment

    if db.query(PrepaidVoucherOfflineAssignment.id).filter(PrepaidVoucherOfflineAssignment.batch_id == batch.id).first():
        return True
    # A sale holding one of its vouchers (live, or expired and never ended): it may still be confirmed.
    if db.query(PrepaidVoucherReservation.id).filter(PrepaidVoucherReservation.batch_id == batch.id,
                                                     PrepaidVoucherReservation.status == "held").first():
        return True
    if db.query(PrepaidVoucherDelivery.id).filter(PrepaidVoucherDelivery.batch_id == batch.id,
                                                  PrepaidVoucherDelivery.voided_at.is_(None)).first():
        return True
    return db.query(PrepaidSettlementInvoiceLine.id).filter(PrepaidSettlementInvoiceLine.batch_id == batch.id).first() is not None


def _lock_batch_and_vouchers(db: Session, batch: PrepaidVoucherBatch) -> None:
    """Its vouchers' rows (in id order), then the batch's (FOR NO KEY UPDATE — a confirm's audit row takes KEY
    SHARE on it): the order a replacement and a confirm take them, so none of them waits on another in a cycle.
    A redemption under way holds its voucher and finishes first: it is seen as history."""
    db.query(PrepaidVoucher.id).filter(PrepaidVoucher.batch_id == batch.id).order_by(PrepaidVoucher.id).with_for_update().all()
    db.query(PrepaidVoucherBatch.id).filter(PrepaidVoucherBatch.id == batch.id).with_for_update(key_share=True).first()


def mark_test(db: Session, user: User, tenant_id, batch_id, note: Optional[str] = None, *, created: bool = False) -> PrepaidVoucherBatch:
    """
    A batch becomes staff test vouchers — only before anything real happened to it (no redemption,
    delivery or invoice: a real voucher never leaves a settlement this way). Its names say "שובר בדיקה".
    """
    PV = _pv()
    PV._require_role(user)
    ACC.require(db, user, ACC.CONTROLS_SECTION, "edit", ACC.CONTROLS_FORBIDDEN)
    batch = PV.get_batch(db, user, tenant_id, batch_id)
    _lock_batch_and_vouchers(db, batch)
    if is_test(db, batch.id):
        raise ACC.http(status.HTTP_409_CONFLICT, ALREADY_TEST)
    from app.services import prepaid_voucher_offline as PVO

    if PVO.active_of(db, batch.id) is not None:
        raise ACC.http(status.HTTP_409_CONFLICT, TEST_OFFLINE)
    if _has_history(db, batch):
        raise ACC.http(status.HTTP_409_CONFLICT, TEST_HAS_HISTORY)
    before = {"name": batch.name, "typeName": batch.type_name, "offlineAllowed": bool(batch.offline_allowed)}
    # Never offline: a device's sales are real documents whatever the voucher (review 09.10).
    batch.offline_allowed = False
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
    _lock_batch_and_vouchers(db, batch)
    row = db.get(PrepaidVoucherTestBatch, batch.id)
    if row is None:
        raise ACC.http(status.HTTP_409_CONFLICT, NOT_A_TEST_BATCH)
    from app.services import prepaid_voucher_offline as PVO

    if PVO.active_of(db, batch.id) is not None:
        raise ACC.http(status.HTTP_409_CONFLICT, TEST_OFFLINE)
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
    batch.offline_allowed = False  # never offline (review 09.10)
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
    ACC.require(db, user, ACC.CONTROLS_SECTION, "view", ACC.CONTROLS_FORBIDDEN)
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
    from app.models.user import UserRole

    q = db.query(E).filter(E.tenant_id == tenant_id)
    if batch_id:
        q = q.filter(E.batch_id == (ACC.as_uuid(batch_id) or uuid.uuid4()))
    if user.role not in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        # Someone narrower sees what happened to the batches they manage only.
        mine = [b.id for b in db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.tenant_id == tenant_id)
                if PV.may_manage(db, user, tenant_id, b)]
        q = q.filter(E.batch_id.in_(mine or [uuid.uuid4()]))
    rows = q.order_by(E.created_at.desc()).limit(max(1, min(int(limit), 1000))).all()
    prices = ACC.prices_visible(db, user)
    return {"items": [ACC.event_out(e, prices=prices) for e in rows]}
