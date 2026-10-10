"""
The event's sales target, for "מצב אירוע חי" (the live screen).

One source: "יעדים ותחרות" (app/services/sales_targets.py). Its event target — the shop's
target of `period = "event"` for the event — is registered here as the first provider
(`register_target_provider`); "הגדרת יעד" on the live screen writes that same target
(`sales_targets.set_event_target`), so it shows on the targets page too and its "יעד הושג" is
sales_targets' own: the one alert source for `target_reached` (the exceptions log's
`sales_target` source), never a second one from here.

Only when no provider answers does the screen fall back to the target typed on it before
targets existed (`report_events.live_target` — migration 7f2e55223360 moved every one of
them into an event target; nothing writes it any more). Such a target is shown, never alerted.

A provider is `(db, event) -> Decimal | None` (net ₪). It must be cheap — the live screen asks
on every refresh — and must never raise: a failing provider is skipped.
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
    #: "targets" (a registered provider — "יעדים ותחרות") | "event" (typed on the screen before targets).
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


def _sales_targets_provider(db: Session, event: ReportEvent) -> Optional[Decimal]:
    """"יעדים ותחרות": the event's shop target (app/services/sales_targets.py `event_target`)."""
    from app.services import sales_targets

    return sales_targets.event_target_amount(db, event)


# The single source of an event's target, first in line.
register_target_provider(_sales_targets_provider)
