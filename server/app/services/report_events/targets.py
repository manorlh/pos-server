"""
The event's sales target, for "מצב אירוע חי" (the live screen) and the "target reached" alert.

One hook, `target_for_event`: a targets module (another branch builds shop / event targets)
registers a provider with `register_target_provider`; the first provider that answers wins.
Until one does, the target is the one typed on the live screen and saved with the event
(`report_events.live_target`).

A provider is `(db, event) -> Decimal | None` (net ₪, the same money as the live total). It
must be cheap — the live screen asks on every refresh — and must never raise: a failing
provider is skipped.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, List, Optional

from sqlalchemy.orm import Session

from app.models.report_event import ReportEvent

logger = logging.getLogger(__name__)

TargetProvider = Callable[[Session, ReportEvent], Optional[Decimal]]

_PROVIDERS: List[TargetProvider] = []

#: The most a typed target may be (₪).
MAX_TARGET = Decimal("100000000")


@dataclass(frozen=True)
class EventTarget:
    amount: Decimal
    #: "targets" (a registered provider) | "event" (typed on the live screen).
    source: str


def register_target_provider(provider: TargetProvider) -> None:
    """Called by a targets module at import time. Registering the same function twice is a no-op."""
    if provider not in _PROVIDERS:
        _PROVIDERS.append(provider)


def unregister_target_provider(provider: TargetProvider) -> None:
    if provider in _PROVIDERS:
        _PROVIDERS.remove(provider)


def _positive(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        amount = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None
    if amount.is_nan() or amount <= 0:
        return None
    return amount.quantize(Decimal("0.01"))


def target_for_event(db: Session, event: ReportEvent) -> Optional[EventTarget]:
    """The event's net sales target: a targets module's, else the one typed on the live screen."""
    for provider in list(_PROVIDERS):
        try:
            amount = _positive(provider(db, event))
        except Exception:  # noqa: BLE001 - a broken provider never breaks the live screen
            logger.exception("event target provider %r failed", provider)
            continue
        if amount is not None:
            return EventTarget(amount, "targets")
    amount = _positive(getattr(event, "live_target", None))
    return EventTarget(amount, "event") if amount is not None else None


def clean_target(value: Any) -> Optional[Decimal]:
    """A typed target: a positive amount up to `MAX_TARGET`, or None to clear. Raises ValueError."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError("target_invalid")
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError("target_invalid") from None
    if amount.is_nan() or amount.is_infinite() or amount <= 0 or amount > MAX_TARGET:
        raise ValueError("target_invalid")
    return amount.quantize(Decimal("0.01"))
