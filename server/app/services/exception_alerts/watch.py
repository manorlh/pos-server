"""
The shared plumbing of the background watches ("זיהויים חדשים", P:/specs/push-more.md §C and
§B2): shop_watch.py, service_watch.py, till_activity.py and daily_summary.py.

* **Which tenants to look at** (`enabled_tenants`): every new kind is off by default
  (`RuleSpec.default_enabled = False`), so only a tenant with a level that switched it on can
  have it on anywhere — the watches never scan the others.
* **The rule at a place** (`shop_rule`, `machine_rule`): the exception rules' own resolution
  (app/services/exceptions.py — tenant → company → shop → area → till, field by field). A
  shop-level watch (the shop not opened, the sales pace, the daily summary) reads the tenant,
  company and shop levels; a till's or a table's / ticket's reads the till's whole chain.
* **One row per case** (`write`): an `audit_exceptions` row, unique on its dedupe key (a second
  API process loses the insert race quietly). The ORM hooks carry it to the exceptions log and
  the alerts (SMS rules that name it, the push categories) — the same path as "קופה לא מחוברת".
* **Closed by itself** (`resolve`): when the case is over (the shop opened, the table was paid,
  the ticket is ready, the till sells again) the row becomes `reviewed` with a note
  ("נסגר אוטומטית: …") and `details.resolvedAt`; its log entry follows ("טופל"). Nothing is sent
  for it. A row a manager already reviewed or dismissed is never touched.
* **Time**: the tenant's zone (the reports'), the business day of the whole system (04:00 to
  04:00, app/services/sales_targets.py).
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.audit_exception import AuditException, ExceptionRuleValue
from app.models.pos_machine import POSMachine
from app.models.shop import Shop

logger = logging.getLogger(__name__)

#: The note a row closed by itself carries (the log shows it as "טופל" with it).
AUTO_NOTE = "נסגר אוטומטית"


def utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def parse_iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        return utc(datetime.fromisoformat(value.replace("Z", "+00:00")))
    except ValueError:
        return None


# ── Which tenants, which rule ────────────────────────────────────────────────


def enabled_tenants(db: Session, exception_type: str) -> Set[uuid.UUID]:
    """The tenants where some level switched `exception_type` on (off by default everywhere else)."""
    from app.services.exceptions import RULES_BY_TYPE

    spec = RULES_BY_TYPE.get(exception_type)
    if spec is not None and spec.default_enabled:  # pragma: no cover - every watched kind is off by default
        from app.models.tenant import Tenant

        return {row[0] for row in db.query(Tenant.id).all()}
    rows = (
        db.query(ExceptionRuleValue.tenant_id)
        .filter(ExceptionRuleValue.exception_type == exception_type, ExceptionRuleValue.enabled.is_(True))
        .distinct()
        .all()
    )
    return {row[0] for row in rows if row[0] is not None}


def shop_rule(db: Session, shop: Shop, exception_type: str):
    """The rule at the shop (tenant → company → shop); None when it is off there."""
    from app.services import exceptions as X

    chain = X.chain_for(tenant_id=shop.tenant_id, company_id=shop.company_id, shop_id=shop.id)
    rule = X.resolve_rules(X.rules_on_chain(db, chain), chain).get(exception_type)
    return rule if rule is not None and rule.enabled else None


def machine_rule(db: Session, machine: POSMachine, exception_type: str):
    """The rule at the till (its whole chain); None when it is off there."""
    from app.services import exceptions as X

    rule = X.rules_for_machine(db, machine).get(exception_type)
    return rule if rule is not None and rule.enabled else None


def place_rule(db: Session, shop: Optional[Shop], machine: Optional[POSMachine], exception_type: str):
    """The till's rule when the till stands in the shop, else the shop's."""
    if machine is not None and shop is not None and machine.shop_id == shop.id:
        return machine_rule(db, machine, exception_type)
    return shop_rule(db, shop, exception_type) if shop is not None else None


def param(rule, key: str, default: float) -> float:
    value = (rule.params or {}).get(key) if rule is not None else None
    try:
        return float(value) if value is not None else float(default)
    except (TypeError, ValueError):
        return float(default)


# ── Time ─────────────────────────────────────────────────────────────────────


class Zones:
    """The tenants' zone names, once per pass."""

    def __init__(self, db: Session):
        self.db = db
        self._names: Dict[Any, str] = {}

    def name(self, tenant_id: Any) -> str:
        if tenant_id not in self._names:
            from app.services.block_durations import DEFAULT_ZONE
            from app.services.reports import resolve_report_timezone

            try:
                self._names[tenant_id] = resolve_report_timezone(self.db, tenant_id, None) or DEFAULT_ZONE
            except Exception:  # noqa: BLE001 - an unreadable zone is Israel's
                self._names[tenant_id] = DEFAULT_ZONE
        return self._names[tenant_id]


def zone(name: str):
    from app.services.block_durations import zone_of

    return zone_of(name)


def business_today(now: datetime, zone_name: str) -> date:
    from app.services.block_durations import business_today as today

    return today(now, zone_name)


def business_day_range(day: date, zone_name: str) -> Tuple[datetime, datetime]:
    from app.services.sales_targets import business_day_range as day_range

    return day_range(day, zone_name)


def day_start_time() -> time:
    from app.services.block_durations import business_day_start, parse_hhmm

    return parse_hhmm(business_day_start()) or time(4, 0)


def local_at(day: date, clock: time, zone_name: str) -> datetime:
    """`clock` on the business day `day` (a time before the day's start is the next calendar day), UTC."""
    from app.services.block_durations import _local_at

    calendar_day = day + timedelta(days=1) if clock < day_start_time() else day
    return _local_at(calendar_day, clock, zone(zone_name))


def same_clock_days_before(moment: datetime, days: int, zone_name: str) -> datetime:
    """The same local clock time `days` days earlier (DST-safe), UTC."""
    from app.services.block_durations import _local_at

    local = moment.astimezone(zone(zone_name))
    return _local_at(local.date() - timedelta(days=days), local.time().replace(tzinfo=None), zone(zone_name))


def hhmm(moment: Optional[datetime], zone_name: str) -> Optional[str]:
    return moment.astimezone(zone(zone_name)).strftime("%H:%M") if moment is not None else None


def weekday_digit(day: date) -> int:
    """1 = Sunday … 7 = Saturday (the Israeli week, as the rule's `days`)."""
    return (day.weekday() + 1) % 7 + 1


def minutes_text(minutes: float) -> str:
    """"45 דק׳" / "3:10 שע׳"."""
    m = int(round(max(minutes, 0)))
    if m < 60:
        return f"{m} דק׳"
    return f"{m // 60}:{m % 60:02d} שע׳"


def money(amount: Any) -> str:
    from app.services.exception_alerts.messages import money as fmt

    value = Decimal(str(amount or 0))
    text = fmt(value) or "₪0"
    return f"-{text}" if value < 0 else text


# ── Rows ─────────────────────────────────────────────────────────────────────


def find(db: Session, dedupe_key: str) -> Optional[AuditException]:
    return db.query(AuditException).filter(AuditException.dedupe_key == dedupe_key[:200]).first()


def write(
    db: Session,
    *,
    exception_type: str,
    dedupe_key: str,
    occurred_at: datetime,
    now: datetime,
    severity: str,
    tenant_id: Any,
    shop_id: Any = None,
    company_id: Any = None,
    area_id: Any = None,
    machine_id: Any = None,
    amount: Any = None,
    value: Any = None,
    threshold: Any = None,
    details: Optional[Dict[str, Any]] = None,
    pos_user_id: Optional[str] = None,
    pos_user_name: Optional[str] = None,
    transaction_id: Any = None,
    shift_id: Any = None,
) -> Optional[AuditException]:
    """One row per case; None when this case is already recorded. The caller commits."""
    if find(db, dedupe_key) is not None:
        return None
    if company_id is None and shop_id is not None:
        row = db.query(Shop.company_id).filter(Shop.id == shop_id).first()
        company_id = row[0] if row else None

    def dec(v: Any) -> Optional[Decimal]:
        if v is None:
            return None
        return Decimal(str(v)).quantize(Decimal("0.01"))

    row = AuditException(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        company_id=company_id,
        shop_id=shop_id,
        area_id=area_id,
        machine_id=machine_id,
        transaction_id=transaction_id,
        shift_id=shift_id,
        exception_type=exception_type,
        severity=severity,
        dedupe_key=dedupe_key[:200],
        pos_user_id=(pos_user_id or None) and str(pos_user_id)[:100],
        pos_user_name=(pos_user_name or None) and str(pos_user_name)[:200],
        amount=dec(amount),
        value=dec(value),
        threshold=dec(threshold),
        details=details or None,
        occurred_at=utc(occurred_at),
        detected_at=now,
        status="new",
    )
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        return None  # another process (or an earlier pass) recorded it first
    return row


def open_rows(db: Session, exception_type: str, *, now: datetime, days: int = 7) -> List[AuditException]:
    """This type's rows still open (new, not closed by themselves) of the last `days` days."""
    rows = (
        db.query(AuditException)
        .filter(
            AuditException.exception_type == exception_type,
            AuditException.status == "new",
            AuditException.occurred_at > now - timedelta(days=days),
        )
        .all()
    )
    return [r for r in rows if not (r.details or {}).get("resolvedAt")]


def resolve(row: AuditException, *, now: datetime, why: str, at: Optional[datetime] = None,
            extra: Optional[Dict[str, Any]] = None) -> bool:
    """
    Close a case that is over: `reviewed`, with the note "נסגר אוטומטית: <why>" and
    `details.resolvedAt` — its log entry turns "טופל" with it. Never one a manager handled.
    """
    if row.status != "new":
        return False
    details = dict(row.details or {})
    if details.get("resolvedAt"):
        return False
    details["resolvedAt"] = (utc(at) or now).isoformat()
    details["resolvedReason"] = why
    if extra:
        details.update(extra)
    row.details = details
    row.status = "reviewed"
    row.reviewed_at = now
    row.reviewed_by_user_id = None
    row.review_note = f"{AUTO_NOTE}: {why}"
    return True


def kiosk_ids(db: Session, machine_ids: Optional[Iterable[Any]] = None) -> Set[uuid.UUID]:
    from app.services.z_table import kiosk_machine_ids

    return kiosk_machine_ids(db, machine_ids)


def till_label(machine: Optional[POSMachine]) -> Optional[str]:
    if machine is None:
        return None
    return f"קופה {machine.pos_number}" if machine.pos_number else (machine.name or "קופה")
