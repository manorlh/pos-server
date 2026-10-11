""""בירור יתרת שובר" — the till's menu item that reads a production voucher's balance (the owner, 11.10.2026).

One flat key, set or inherited per layer (tenant -> company -> shop -> point of sale -> till, the
deepest wins) like `voucherRedeemFlow` (app/services/voucher_redeem_settings.py):

    voucherBalanceCheck   "auto" — "אוטומטי": on while the till has an active production voucher
                                    batch it can redeem (the default: unset = "auto")
                          "on"   — "מופעל": always shown
                          "off"  — "כבוי": never shown

GET /sync/{id}/settings sends it resolved in `settings.voucherBalanceCheck` and, decided for that
till, `settings.voucherBalanceCheckEnabled` (bool): "on" -> true, "off" -> false, "auto" -> whether
at least one batch is active (not cancelled, its validity not ended; one not valid yet counts) and
redeemable at the till's shop by the rule the redemption itself applies (refusal_reason in
app/services/prepaid_vouchers.py): the batch's tenant is the till's, the till's shop's company is the
batch's company or under it, and a batch for named shops names the till's shop. Recomputed on every
settings pull (one small indexed query); the batches' own stamps move the settings watermark
(`batches_changed_at`), and a batch made / edited / cancelled wakes the tills it reaches
(`notify_tills_of_batch`), so the next pull sees it.

The menu item reads the voucher through the till's lookup (POST /sync/{id}/prepaid-vouchers/lookup,
read-only: nothing is held or taken), which carries the voucher's redemptions.

A change is written to the till parameters' change log like the redemption flow's keys
(voucher_redeem_settings.audit_patch).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

VOUCHER_BALANCE_CHECK_KEY = "voucherBalanceCheck"
#: Sent to the till only, decided for it: whether the menu item shows.
VOUCHER_BALANCE_CHECK_ENABLED_KEY = "voucherBalanceCheckEnabled"
#: The dashboard's inherited preview only: whether the level's tills have an active batch now
#: (what "auto" turns into there).
VOUCHER_BALANCE_CHECK_ACTIVE_KEY = "voucherBalanceCheckActiveVouchers"

AUTO = "auto"
ON = "on"
OFF = "off"
#: The values `voucherBalanceCheck` takes; the Android till reads the same three.
MODES: Tuple[str, ...] = (AUTO, ON, OFF)
#: Unset everywhere: on while there are active vouchers.
DEFAULT_MODE = AUTO

VOUCHER_BALANCE_SETTING_KEYS: Tuple[str, ...] = (VOUCHER_BALANCE_CHECK_KEY,)

NOTIFY_REASON = "prepaid_voucher_batches_changed"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(moment: Any) -> Optional[datetime]:
    if not isinstance(moment, datetime):
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def resolve_mode(merged: Mapping[str, Any]) -> str:
    """The mode in a merged settings dict; an unknown or missing value = "auto". A view only."""
    mode = merged.get(VOUCHER_BALANCE_CHECK_KEY)
    return mode if isinstance(mode, str) and mode in MODES else DEFAULT_MODE


def resolve_preview(merged: Mapping[str, Any]) -> Dict[str, Any]:
    """The key resolved, for the dashboard's inherited preview (like resolve_voucher_flow)."""
    return {VOUCHER_BALANCE_CHECK_KEY: resolve_mode(merged)}


def enabled_for(mode: str, has_active: bool) -> bool:
    if mode == ON:
        return True
    if mode == OFF:
        return False
    return bool(has_active)


# ── Which batches reach a till ───────────────────────────────────────────────


def _company_chain(db: Session, company_id) -> List[uuid.UUID]:
    """The company and the companies above it: a batch of any of them reaches its shops."""
    from app.services.company_hierarchy import ancestor_company_ids

    start = _uuid(company_id)
    if start is None:
        return []
    return [start, *ancestor_company_ids(db, start)]


def _active_batch_shop_lists(db: Session, tenant_id, company_ids: Iterable[uuid.UUID], now: datetime) -> List[Any]:
    """`shop_ids` of every active batch of [company_ids] whose validity has not ended."""
    from app.models.prepaid_voucher import PrepaidVoucherBatch as B

    ids = [c for c in company_ids if c is not None]
    tenant = _uuid(tenant_id)
    if not ids or tenant is None:
        return []
    # Entity first, columns after: the settings tests' mocked sessions route db.query by model.
    rows = (
        db.query(B)
        .filter(
            B.tenant_id == tenant,
            B.company_id.in_(ids),
            B.status == "active",
            or_(B.valid_until.is_(None), B.valid_until > now),
        )
        .with_entities(B.shop_ids)
        .all()
    )
    return [row[0] for row in rows]


def _reaches(shop_ids: Any, shops: Iterable[str]) -> bool:
    """A batch for every shop (no list), or one that names one of [shops]."""
    if not shop_ids:
        return True
    named = {str(s) for s in shop_ids} if isinstance(shop_ids, (list, tuple, set)) else set()
    return any(str(s) in named for s in shops)


def has_active_for_shop(db: Session, tenant_id, shop: Any, now: Optional[datetime] = None) -> bool:
    """Whether a till of [shop] can redeem a voucher of some active batch (the redemption's scoping)."""
    if shop is None or getattr(shop, "company_id", None) is None:
        return False
    now = now or _now()
    chain = _company_chain(db, shop.company_id)
    return any(_reaches(s, [str(shop.id)]) for s in _active_batch_shop_lists(db, tenant_id, chain, now))


def has_active_for_company(db: Session, company: Any, now: Optional[datetime] = None) -> bool:
    """Whether some shop of [company] has an active batch it can redeem (the company level's "auto")."""
    from app.models.shop import Shop

    if company is None:
        return False
    now = now or _now()
    lists = _active_batch_shop_lists(db, company.tenant_id, _company_chain(db, company.id), now)
    if not lists:
        return False
    if any(not s for s in lists):
        return True
    shops = [str(sid) for (sid,) in db.query(Shop).filter(Shop.company_id == company.id).with_entities(Shop.id).all()]
    return any(_reaches(s, shops) for s in lists)


def batches_changed_at(db: Session, tenant_id, company_id, now: Optional[datetime] = None) -> Optional[datetime]:
    """
    The latest moment the batches that may reach a shop of [company_id] changed in a way "auto"
    reads: made, edited or cancelled (`updated_at`), or their validity ended (`valid_until`, once
    past). For the settings watermark: a delta pull after it is answered in full.
    """
    from app.models.prepaid_voucher import PrepaidVoucherBatch as B

    tenant = _uuid(tenant_id)
    chain = _company_chain(db, company_id)
    if tenant is None or not chain:
        return None
    now = now or _now()
    scope = (B.tenant_id == tenant, B.company_id.in_(chain))
    changed = db.query(B).filter(*scope).with_entities(func.max(B.updated_at)).scalar()
    ended = db.query(B).filter(*scope, B.valid_until <= now).with_entities(func.max(B.valid_until)).scalar()
    stamps = [s for s in (_utc(changed), _utc(ended)) if s is not None]
    return max(stamps) if stamps else None


def till_settings(db: Session, machine: Any, shop: Any, merged: Mapping[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    """`voucherBalanceCheck` and `voucherBalanceCheckEnabled` for this till, always both."""
    mode = resolve_mode(merged)
    active = mode == AUTO and has_active_for_shop(db, getattr(machine, "tenant_id", None), shop, now)
    return {VOUCHER_BALANCE_CHECK_KEY: mode, VOUCHER_BALANCE_CHECK_ENABLED_KEY: enabled_for(mode, active)}


# ── Waking the tills ─────────────────────────────────────────────────────────


def tills_of_batch(db: Session, batch: Any) -> List[Any]:
    """The active tills a batch reaches: its company's shops and those under it, or the shops it names."""
    from app.models.pos_machine import POSMachine
    from app.models.shop import Shop
    from app.services.company_hierarchy import descendant_company_ids

    companies = list(descendant_company_ids(db, batch.company_id))
    if not companies:
        return []
    shops = [sid for (sid,) in db.query(Shop).filter(Shop.company_id.in_(companies)).with_entities(Shop.id).all()]
    if batch.shop_ids:
        named = {str(s) for s in batch.shop_ids}
        shops = [sid for sid in shops if str(sid) in named]
    if not shops:
        return []
    return (
        db.query(POSMachine)
        .filter(POSMachine.shop_id.in_(shops), POSMachine.is_active.is_(True))
        .all()
    )


def notify_tills_of_batch(db: Session, batch_or_id: Any, reason: str = NOTIFY_REASON) -> int:
    """
    After a batch was made, edited or cancelled (committed): the tills it reaches pull their settings
    again, so "auto" follows. Best effort — the pull's watermark carries it anyway. Returns how many.
    """
    from app.models.prepaid_voucher import PrepaidVoucherBatch
    from app.services.ably_notify import publish_settings_notify

    try:
        batch = batch_or_id
        if not isinstance(batch, PrepaidVoucherBatch):
            wanted = _uuid(batch_or_id)
            batch = db.get(PrepaidVoucherBatch, wanted) if wanted is not None else None
        if batch is None:
            return 0
        n = 0
        for m in tills_of_batch(db, batch):
            if m.tenant_id:
                publish_settings_notify(str(m.tenant_id), str(m.id), reason=reason)
                n += 1
        return n
    except Exception:  # never fail the dashboard's write over a notification
        import logging

        logging.getLogger(__name__).warning("voucher balance check: notifying tills failed", exc_info=True)
        return 0
