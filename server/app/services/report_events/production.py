"""
"עמדת מפיק" — which prepaid voucher batches are the event's production, and at what price
they settle. On the vouchers core (P:\\specs\\production-vouchers-api.md §13): a batch names
its event (`report_event_id`, the existing `report_events`) and its production
(`production_id` → `prepaid_productions`, whose name the batch carries as `customer_name`), and
holds its production price in agorot (`production_price`, by serial once "ערוך סדרה" changed
it: `production_price_history`, read through `prepaid_voucher_edit.production_price_of`).

* **The batches** (`event_batches`): the ones the owner linked on the event's "עמדת מפיק"
  (`report_events.producer_settings.batchIds`), plus — automatically — the batches whose
  `report_event_id` is the event. A production (`prepaid_productions`) names no event — a
  production's batches may serve several events — so it links nothing by itself. A batch whose
  printed event name (`event_name`) is the event's name is only *suggested* in the owner's tab
  (recurring events share names: linking by name would show one production another's
  vouchers). Another module may add its own with `register_production_provider`
  (`(db, event) -> batch ids`).
* **Which batches the owner may pick**: the event's company's batches valid at the event's
  shop (`shop_ids` empty = every shop of the company).
* **The price** (`production_price`, ₪ per voucher): the price typed on the event for that
  batch (`productionPrices`, ₪), else the batch's own — the core's agorot, ÷ 100. The
  producer's settlement (producer.py `settlement`) counts and prices through the production
  vouchers' settlement service: each chargeable voucher at the price it was issued at
  (`prepaid_voucher_settlement.price_at_issue`, by serial once "ערוך סדרה" changed it).
  The batch's own price is the `prepaid_voucher_prices` section's (the core's rule): the owner's tab shows it only to whoever has that section, and
  the producer's settlement uses it only while the owner who switched the settlement on
  (`settlementEnabledBy`) has that section — switching it on takes the section (producer.py
  `save_settings`): the producer never sees a production price that owner cannot.

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
    enabled = raw.get("settlementEnabled") is True
    by = raw.get("settlementEnabledBy")
    return {
        "settlementEnabled": enabled,
        "batchIds": [str(b) for b in (raw.get("batchIds") or []) if b],
        "productionPrices": {str(k): v for k, v in prices.items()},
        # Who switched the settlement on (a user id); None when off, or switched on before it was kept.
        "settlementEnabledBy": str(by) if enabled and by else None,
    }


def _uuids(values) -> List[uuid.UUID]:
    out = []
    for v in values or []:
        try:
            out.append(v if isinstance(v, uuid.UUID) else uuid.UUID(str(v)))
        except (TypeError, ValueError):
            continue
    return out


def _valid_at_shop(batch: PrepaidVoucherBatch, shop_id: Any) -> bool:
    shops = batch.shop_ids if isinstance(batch.shop_ids, list) else None
    return not shops or str(shop_id) in {str(s) for s in shops}


def _company_query(db: Session, event: ReportEvent):
    q = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.tenant_id == event.tenant_id)
    if event.company_id is not None:
        q = q.filter(PrepaidVoucherBatch.company_id == event.company_id)
    return q


def company_batches(db: Session, event: ReportEvent, *, limit: Optional[int] = 500) -> List[PrepaidVoucherBatch]:
    """The batches the owner may link: the event's company's, valid at the event's shop, newest first."""
    q = _company_query(db, event).order_by(PrepaidVoucherBatch.created_at.desc())
    rows = q.limit(limit).all() if limit else q.all()
    return [b for b in rows if _valid_at_shop(b, event.shop_id)]


def auto_batch_ids(db: Session, event: ReportEvent) -> List[uuid.UUID]:
    """Linked without the owner: the batches whose `report_event_id` is the event (once the column exists)."""
    column = getattr(PrepaidVoucherBatch, "report_event_id", None)
    if column is None:
        return []
    return [b.id for b in _company_query(db, event).filter(column == event.id).all() if _valid_at_shop(b, event.shop_id)]


def suggested_batch_ids(db: Session, event: ReportEvent) -> List[uuid.UUID]:
    """Suggested to the owner (never linked by itself): the same printed event name."""
    name = (event.name or "").strip().lower()
    if not name:
        return []
    rows = _company_query(db, event).filter(func.lower(func.trim(PrepaidVoucherBatch.event_name)) == name).all()
    return [b.id for b in rows if _valid_at_shop(b, event.shop_id)]


def event_batches(db: Session, event: ReportEvent) -> List[PrepaidVoucherBatch]:
    ids = set(_uuids(settings_of(event)["batchIds"])) | set(auto_batch_ids(db, event))
    for provider in list(_PROVIDERS):
        try:
            ids |= set(_uuids(provider(db, event)))
        except Exception:  # noqa: BLE001 - a broken provider never breaks the producer's view
            logger.exception("production provider %r failed", provider)
    if not ids:
        return []
    q = _company_query(db, event).filter(PrepaidVoucherBatch.id.in_(list(ids)[:MAX_BATCHES]))
    return [b for b in q.order_by(PrepaidVoucherBatch.created_at).all() if _valid_at_shop(b, event.shop_id)]


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


def typed_price(event: ReportEvent, batch: PrepaidVoucherBatch) -> Optional[Decimal]:
    """₪ per voucher, as the owner typed it on the event for [batch]; None when not typed."""
    return _money(settings_of(event)["productionPrices"].get(str(batch.id)))


def _shekels(agorot: Any) -> Optional[Decimal]:
    if isinstance(agorot, float) and agorot.is_integer():
        agorot = int(agorot)  # a JSON history entry read back as 2000.0
    if not isinstance(agorot, int) or isinstance(agorot, bool) or agorot < 0:
        return None
    return (Decimal(agorot) / 100).quantize(Decimal("0.01"))


def production_price(event: ReportEvent, batch: PrepaidVoucherBatch, *, include_own: bool = True) -> Optional[Decimal]:
    """₪ per voucher: the event's typed price, else (with [include_own]) the batch's current own price."""
    typed = typed_price(event, batch)
    if typed is not None or not include_own:
        return typed
    return _shekels(getattr(batch, "production_price", None))


def clean_settings(event: ReportEvent, db: Session, body: Dict[str, Any]) -> Dict[str, Any]:
    """The owner's settings, validated: batches only of the event's company, prices ≥ 0. Raises ValueError(code)."""
    current = settings_of(event)
    enabled = body.get("settlementEnabled", current["settlementEnabled"])
    if not isinstance(enabled, bool):
        raise ValueError("settlement_invalid")
    raw_ids = body.get("batchIds", current["batchIds"])
    if not isinstance(raw_ids, list):
        raise ValueError("batches_invalid")
    allowed = {b.id for b in company_batches(db, event, limit=None)}
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
