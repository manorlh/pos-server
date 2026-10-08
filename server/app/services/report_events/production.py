"""
"עמדת מפיק" — which prepaid voucher batches are the event's production, and at what price
they settle. The hook for the vouchers' Production entity (P:\\specs\\production-vouchers-api.md
§13: a batch gains `report_event_id`; a `prepaid_productions` entity with the agreement and
`productionPrice` on types / batches — being built on fix/voucher-print).

Until that lands, from what exists now:

* **The batches** (`event_batches`): the ones the owner linked on the event's "עמדת מפיק"
  (`report_events.producer_settings.batchIds`), plus — automatically — the batches of the
  event's company whose `report_event_id` is the event (once the column exists) or whose
  printed event name (`event_name`) is the event's name. A Production module adds its own with
  `register_production_provider` (`(db, event) -> batch ids`).
* **The price** (`production_price`): the price typed on the event for that batch
  (`productionPrices`), else the batch's own production price once the vouchers branch stores
  one (`production_price` ₪, or `production_price_agorot`), else none — the settlement then
  shows quantities without money.

Only batches of the event's tenant and company are ever returned, whatever a setting says.
"""
from __future__ import annotations

import logging
import uuid
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Dict, List, Optional, Sequence

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.prepaid_voucher import PrepaidVoucherBatch
from app.models.report_event import ReportEvent

logger = logging.getLogger(__name__)

ProductionProvider = Callable[[Session, ReportEvent], Sequence[Any]]
_PROVIDERS: List[ProductionProvider] = []
MAX_BATCHES = 100


def register_production_provider(provider: ProductionProvider) -> None:
    if provider not in _PROVIDERS:
        _PROVIDERS.append(provider)


def unregister_production_provider(provider: ProductionProvider) -> None:
    if provider in _PROVIDERS:
        _PROVIDERS.remove(provider)


def settings_of(event: ReportEvent) -> Dict[str, Any]:
    raw = event.producer_settings if isinstance(getattr(event, "producer_settings", None), dict) else {}
    prices = raw.get("productionPrices") if isinstance(raw.get("productionPrices"), dict) else {}
    return {
        "settlementEnabled": raw.get("settlementEnabled") is True,
        "batchIds": [str(b) for b in (raw.get("batchIds") or []) if b],
        "productionPrices": {str(k): v for k, v in prices.items()},
    }


def _uuids(values) -> List[uuid.UUID]:
    out = []
    for v in values or []:
        try:
            out.append(v if isinstance(v, uuid.UUID) else uuid.UUID(str(v)))
        except (TypeError, ValueError):
            continue
    return out


def company_batches(db: Session, event: ReportEvent) -> List[PrepaidVoucherBatch]:
    """The batches the owner may link: the event's company's, newest first."""
    q = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.tenant_id == event.tenant_id)
    if event.company_id is not None:
        q = q.filter(PrepaidVoucherBatch.company_id == event.company_id)
    return q.order_by(PrepaidVoucherBatch.created_at.desc()).limit(500).all()


def auto_batch_ids(db: Session, event: ReportEvent) -> List[uuid.UUID]:
    """Linked without the owner: `report_event_id` (when the column exists) or the same event name."""
    q = db.query(PrepaidVoucherBatch.id).filter(PrepaidVoucherBatch.tenant_id == event.tenant_id)
    if event.company_id is not None:
        q = q.filter(PrepaidVoucherBatch.company_id == event.company_id)
    by_name = func.lower(func.trim(PrepaidVoucherBatch.event_name)) == (event.name or "").strip().lower()
    column = getattr(PrepaidVoucherBatch, "report_event_id", None)
    condition = by_name if column is None else (by_name | (column == event.id))
    return [r[0] for r in q.filter(condition).all()]


def event_batches(db: Session, event: ReportEvent) -> List[PrepaidVoucherBatch]:
    ids = set(_uuids(settings_of(event)["batchIds"])) | set(auto_batch_ids(db, event))
    for provider in list(_PROVIDERS):
        try:
            ids |= set(_uuids(provider(db, event)))
        except Exception:  # noqa: BLE001 - a broken provider never breaks the producer's view
            logger.exception("production provider %r failed", provider)
    if not ids:
        return []
    q = db.query(PrepaidVoucherBatch).filter(
        PrepaidVoucherBatch.id.in_(list(ids)[:MAX_BATCHES]), PrepaidVoucherBatch.tenant_id == event.tenant_id,
    )
    if event.company_id is not None:
        q = q.filter(PrepaidVoucherBatch.company_id == event.company_id)
    return q.order_by(PrepaidVoucherBatch.created_at).all()


def _money(value: Any) -> Optional[Decimal]:
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None
    if amount.is_nan() or amount < 0:
        return None
    return amount.quantize(Decimal("0.01"))


def production_price(event: ReportEvent, batch: PrepaidVoucherBatch) -> Optional[Decimal]:
    """₪ per voucher: the event's typed price, else the batch's own (once the vouchers branch stores it)."""
    typed = _money(settings_of(event)["productionPrices"].get(str(batch.id)))
    if typed is not None:
        return typed
    own = _money(getattr(batch, "production_price", None))
    if own is not None:
        return own
    agorot = getattr(batch, "production_price_agorot", None)
    if isinstance(agorot, int) and not isinstance(agorot, bool) and agorot >= 0:
        return (Decimal(agorot) / 100).quantize(Decimal("0.01"))
    return None


def clean_settings(event: ReportEvent, db: Session, body: Dict[str, Any]) -> Dict[str, Any]:
    """The owner's settings, validated: batches only of the event's company, prices ≥ 0. Raises ValueError(code)."""
    current = settings_of(event)
    enabled = body.get("settlementEnabled", current["settlementEnabled"])
    if not isinstance(enabled, bool):
        raise ValueError("settlement_invalid")
    raw_ids = body.get("batchIds", current["batchIds"])
    if not isinstance(raw_ids, list):
        raise ValueError("batches_invalid")
    allowed = {b.id for b in company_batches(db, event)}
    ids = []
    for b in _uuids(raw_ids):
        if b not in allowed:
            raise ValueError("batch_not_in_company")
        if str(b) not in ids:
            ids.append(str(b))
    raw_prices = body.get("productionPrices", current["productionPrices"])
    if not isinstance(raw_prices, dict):
        raise ValueError("prices_invalid")
    prices: Dict[str, float] = {}
    for key, value in raw_prices.items():
        if value is None or value == "":
            continue
        amount = _money(value)
        if amount is None or amount > Decimal("100000"):
            raise ValueError("price_invalid")
        bid = _uuids([key])
        if not bid or bid[0] not in allowed:
            raise ValueError("batch_not_in_company")
        prices[str(bid[0])] = float(amount)
    return {"settlementEnabled": enabled, "batchIds": ids, "productionPrices": prices}
