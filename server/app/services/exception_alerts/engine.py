"""
Matching a new log entry against the SMS alert rules, and sending (or holding back).

For each enabled rule of the entry's company (or one of its parent companies), narrowed
to its shop when it has one:

1. **Match** (`entry_matches`, pure) — the kinds (or every kind of at least the
   severity), "≥ ₪X" for kinds with an amount, "≥ X%" for kinds in percent.
2. **N in M minutes** — with a count, only the N-th matching entry within M minutes (per
   till / employee / shop) fires; the ones before it are not SMS attempts at all.
3. **Hold back**, in this order, recorded on the dispatch row as the status:
   * `suppressed_stale` — the exception happened more than STALE_AFTER ago (a till that
     was offline for hours, a rescan of history): logged, never texted;
   * `suppressed_quiet_hours` — inside the rule's quiet hours (local time);
   * `suppressed_rate_limit` — a message of this rule went out less than
     `rate_limit_minutes` ago ("לא יותר מהודעה אחת ב-10 דקות לאותו כלל").
4. **Send** through the provider (sms.py: dry run unless configured): `dry_run` /
   `queued` / `failed`.

`flush_digests` (the background pass, and tests) sums up what the limit or the quiet
hours held back in ONE message per recipient once the rule may send again — "אחר כך
סיכום" — and marks those rows with the digest's id. A digest counts as a message for
the limit. `send_test` sends the "שליחת הודעת בדיקה" message to the rule's recipients.

Every attempt is one `exception_alert_dispatches` row per recipient, unique per (entry,
rule, recipient): processing the same entry again never texts twice. The rule row is
locked while it decides (`FOR UPDATE`), so two API processes never both pass the limit.
"""
from __future__ import annotations

import logging
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.exception_alerts import (
    CHANNEL_PUSH,
    CHANNEL_SMS,
    DELIVERED_STATUSES,
    DISPATCH_ALERT,
    DISPATCH_DIGEST,
    DISPATCH_TEST,
    ST_SUPPRESSED_QUIET,
    ST_SUPPRESSED_RATE,
    ST_SUPPRESSED_STALE,
    SUPPRESSED_STATUSES,
    ExceptionAlertDispatch,
    ExceptionAlertRule,
    ExceptionLogEntry,
)
from app.services.exception_alerts import messages as M
from app.services.exception_alerts import sms as SMS
from app.services.exception_alerts.catalog import OPT_IN_KINDS, kind_spec, label_of, severity_rank
from app.services.exception_alerts.log import aware, utcnow
from app.services.exception_alerts.rules import minutes_of
from app.services.notifications.phone import mask_phone, phone_hash

logger = logging.getLogger(__name__)

#: An exception older than this when it reaches the cloud is logged but never texted.
STALE_AFTER = timedelta(hours=6)
#: "שליחת הודעת בדיקה" at most once a minute per rule (every test costs a real SMS once live).
TEST_MIN_GAP = timedelta(seconds=60)

#: The clock (tests replace it).
now_fn: Callable[[], datetime] = utcnow


class AlertError(ValueError):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code)
        self.code = code
        self.status = status


# ── Time ─────────────────────────────────────────────────────────────────────


def tz_for(db: Session, tenant_id: Any):
    from zoneinfo import ZoneInfo

    try:
        from app.services.reports import _load_zoneinfo, resolve_report_timezone

        return _load_zoneinfo(resolve_report_timezone(db, tenant_id, None))
    except Exception:  # noqa: BLE001 - an unknown zone falls back to Israel
        return ZoneInfo("Asia/Jerusalem")


def in_quiet_hours(rule: ExceptionAlertRule, local: datetime) -> bool:
    """Whether local time `local` falls in [quiet_from, quiet_to) (wrapping midnight)."""
    if not rule.quiet_from or not rule.quiet_to:
        return False
    start, end = minutes_of(rule.quiet_from), minutes_of(rule.quiet_to)
    now_min = local.hour * 60 + local.minute
    if start == end:
        return False
    if start < end:
        return start <= now_min < end
    return now_min >= start or now_min < end


# ── Matching ─────────────────────────────────────────────────────────────────


def entry_matches(rule: ExceptionAlertRule, entry: ExceptionLogEntry) -> bool:
    """Kinds / severity and the amount and percent thresholds. Pure."""
    kinds = list(rule.kinds or [])
    if kinds and entry.kind not in kinds:
        return False
    if not kinds and entry.kind in OPT_IN_KINDS:
        # "Every kind" rules were written before these existed: they never start texting them.
        return False
    if rule.min_severity and severity_rank(entry.severity) < severity_rank(rule.min_severity):
        return False
    spec = kind_spec(entry.kind)
    if rule.min_amount is not None and spec is not None and spec.amount:
        amount = abs(entry.amount) if entry.amount is not None else None
        if amount is None or amount < rule.min_amount:
            return False
    if rule.min_percent is not None and spec is not None and spec.percent:
        if entry.value is None or entry.value < rule.min_percent:
            return False
    return True


def rules_for(db: Session, entry: ExceptionLogEntry) -> List[ExceptionAlertRule]:
    """The enabled rules that watch the entry's company (or a parent of it) and shop."""
    if entry.tenant_id is None or entry.company_id is None:
        return []
    from app.services.company_hierarchy import ancestor_company_ids

    companies = [entry.company_id, *ancestor_company_ids(db, entry.company_id)]
    rows = (
        db.query(ExceptionAlertRule)
        .filter(
            ExceptionAlertRule.tenant_id == entry.tenant_id,
            ExceptionAlertRule.company_id.in_(companies),
            ExceptionAlertRule.channel == CHANNEL_SMS,
            ExceptionAlertRule.enabled.is_(True),
            ExceptionAlertRule.deleted_at.is_(None),
        )
        .order_by(ExceptionAlertRule.created_at, ExceptionAlertRule.id)
        .all()
    )
    return [r for r in rows if r.shop_id is None or r.shop_id == entry.shop_id]


def count_in_window(db: Session, rule: ExceptionAlertRule, entry: ExceptionLogEntry) -> Tuple[int, List[str]]:
    """How many entries the rule matches within its window up to this one (this one included)."""
    window = timedelta(minutes=int(rule.count_window_minutes or 0))
    end = aware(entry.occurred_at)
    q = db.query(ExceptionLogEntry).filter(
        ExceptionLogEntry.tenant_id == entry.tenant_id,
        ExceptionLogEntry.occurred_at >= end - window,
        ExceptionLogEntry.occurred_at <= end,
    )
    if rule.kinds:
        q = q.filter(ExceptionLogEntry.kind.in_(list(rule.kinds)))
    scope = rule.count_scope or "machine"
    key = {"machine": entry.machine_id, "employee": entry.pos_user_id, "shop": entry.shop_id}.get(scope)
    if key is None:
        return 1, [entry.kind]
    column = {"machine": ExceptionLogEntry.machine_id, "employee": ExceptionLogEntry.pos_user_id,
              "shop": ExceptionLogEntry.shop_id}[scope]
    rows = [r for r in q.filter(column == key).all() if entry_matches(rule, r)]
    if not any(r.id == entry.id for r in rows):
        rows.append(entry)
    return len(rows), [r.kind for r in rows]


def last_delivered_at(db: Session, rule_id: Any) -> Optional[datetime]:
    value = (
        db.query(func.max(ExceptionAlertDispatch.created_at))
        .filter(
            ExceptionAlertDispatch.rule_id == rule_id,
            ExceptionAlertDispatch.kind.in_((DISPATCH_ALERT, DISPATCH_DIGEST)),
            ExceptionAlertDispatch.status.in_(DELIVERED_STATUSES),
        )
        .scalar()
    )
    return aware(value)


def rate_limited(db: Session, rule: ExceptionAlertRule, now: datetime) -> bool:
    minutes = int(rule.rate_limit_minutes or 0)
    if minutes <= 0:
        return False
    last = last_delivered_at(db, rule.id)
    return last is not None and now - last < timedelta(minutes=minutes)


# ── Texts ────────────────────────────────────────────────────────────────────


def link_for(code: Optional[str]) -> Optional[str]:
    if not code:
        return None
    from app.config import get_settings

    settings = get_settings()
    base = (getattr(settings, "exception_alerts_link_base_url", "") or "").strip() or settings.pairing_mobile_app_base_url
    return f"{base.rstrip('/')}/x/{code}"


def _names(db: Session, entry: ExceptionLogEntry) -> Tuple[Optional[str], Optional[str]]:
    from app.models.pos_machine import POSMachine
    from app.models.shop import Shop

    shop = db.get(Shop, entry.shop_id) if entry.shop_id else None
    machine = db.get(POSMachine, entry.machine_id) if entry.machine_id else None
    till = None
    if machine is not None:
        number = machine.pos_number or None
        till = f"קופה {number}" if number else (machine.name or None)
    return (shop.name if shop is not None else None), till


def alert_text_for(db: Session, entry: ExceptionLogEntry, *, count: Optional[int] = None,
                   count_kinds: Sequence[str] = (), window: Optional[int] = None, tzinfo=None) -> str:
    spec = kind_spec(entry.kind)
    if count:
        kinds = set(count_kinds) or {entry.kind}
        label = label_of(entry.kind) if len(kinds) == 1 else "חריגות"
        what = M.what_of_count(label, count, int(window or 0))
    else:
        what = M.what_of(label_of(entry.kind), entry.kind, entry.amount, entry.value,
                         bool(spec is not None and spec.percent))
    tzinfo = tzinfo or tz_for(db, entry.tenant_id)
    local = aware(entry.occurred_at).astimezone(tzinfo)
    shop, till = _names(db, entry)
    return M.alert_text(M.AlertParts(
        what=what, time=local.strftime("%H:%M"), link=link_for(entry.short_code),
        shop=shop, till=till, who=entry.pos_user_name,
    ))


# ── Dispatch rows ────────────────────────────────────────────────────────────


def _recipients(rule: ExceptionAlertRule) -> List[Dict[str, Any]]:
    from app.services.notifications.phone import PhoneError, normalize_mobile

    out = []
    for r in rule.recipients or []:
        try:
            out.append({**r, "phone": normalize_mobile(r.get("phone"))})
        except PhoneError:
            logger.warning("exception alert rule %s: a recipient's number is not valid; skipped", rule.id)
    return out


def _deliver(
    db: Session,
    *,
    rule: ExceptionAlertRule,
    kind: str,
    recipients: Iterable[Dict[str, Any]],
    text: str,
    status: Optional[str],
    reason: Optional[str],
    dedupe_prefix: str,
    now: datetime,
    provider: SMS.SmsProvider,
    entry: Optional[ExceptionLogEntry] = None,
    digest_count: Optional[int] = None,
    user_id: Any = None,
) -> List[ExceptionAlertDispatch]:
    """
    One row per recipient, claimed (inserted) BEFORE the provider is asked, so the same
    dedupe key can never send twice. `status` given = held back (nothing is sent).
    """
    out: List[ExceptionAlertDispatch] = []
    for r in recipients:
        phone = r["phone"]
        hashed = phone_hash(phone)
        row = ExceptionAlertDispatch(
            id=uuid.uuid4(),
            tenant_id=rule.tenant_id,
            rule_id=rule.id,
            entry_id=entry.id if entry is not None else None,
            kind=kind,
            status=status or "sending",
            reason=reason,
            recipient_hash=hashed,
            recipient_masked=mask_phone(phone),
            recipient_label=(r.get("label") or None),
            text=text,
            dedupe_key=f"{dedupe_prefix}:{hashed[:16]}"[:200],
            digest_count=digest_count,
            created_by=user_id,
            created_at=now,
        )
        try:
            with db.begin_nested():
                db.add(row)
                db.flush()
        except IntegrityError:
            continue  # already attempted (a retry of the same entry, another process)
        if status is None:
            result = provider.send(
                db,
                tenant_id=rule.tenant_id,
                company_id=entry.company_id if entry is not None else rule.company_id,
                shop_id=entry.shop_id if entry is not None else rule.shop_id,
                to_e164=phone,
                text=text,
                dedupe_key=row.dedupe_key,
                context_label=(rule.name or "")[:120] or None,
                user_id=user_id,
                now=now,
            )
            row.status = result.status
            row.reason = result.reason
            row.provider = result.provider
            row.provider_mode = result.mode
            row.notification_id = result.notification_id
            if result.status in DELIVERED_STATUSES:
                row.sent_at = now
        out.append(row)
    db.flush()
    return out


# ── One entry ────────────────────────────────────────────────────────────────


def process_entry(
    db: Session,
    entry: ExceptionLogEntry,
    *,
    now: Optional[datetime] = None,
    provider: Optional[SMS.SmsProvider] = None,
    rules_cache: Optional[Dict[Tuple[Any, Any, Any], List[ExceptionAlertRule]]] = None,
) -> List[ExceptionAlertDispatch]:
    """
    Evaluate every rule for a NEW entry and send / hold back. The caller commits.
    `rules_cache`: one batch's rules per (tenant, company, shop) — a rescan logs thousands.
    """
    if entry.backfilled:
        return []
    now = now or now_fn()
    provider = provider or SMS.get_provider()
    out: List[ExceptionAlertDispatch] = []
    tzinfo = None
    if rules_cache is None:
        candidates = rules_for(db, entry)
    else:
        key = (entry.tenant_id, entry.company_id, entry.shop_id)
        if key not in rules_cache:
            rules_cache[key] = rules_for(db, entry)
        candidates = rules_cache[key]
    for candidate in candidates:
        if not entry_matches(candidate, entry):
            continue
        count, count_kinds = None, []
        if candidate.count_threshold and candidate.count_window_minutes:
            count, count_kinds = count_in_window(db, candidate, entry)
            if count < candidate.count_threshold:
                continue
        recipients = _recipients(candidate)
        if not recipients:
            continue
        # Serialise the decision per rule (Postgres row lock; a no-op on SQLite).
        rule = (
            db.query(ExceptionAlertRule)
            .filter(ExceptionAlertRule.id == candidate.id)
            .populate_existing()
            .with_for_update()
            .one_or_none()
        )
        if rule is None or not rule.enabled or rule.deleted_at is not None:
            continue  # switched off / removed meanwhile
        tzinfo = tzinfo or tz_for(db, entry.tenant_id)
        status, reason = None, None
        if now - aware(entry.occurred_at) > STALE_AFTER:
            status, reason = ST_SUPPRESSED_STALE, "occurred_long_ago"
        elif in_quiet_hours(rule, now.astimezone(tzinfo)):
            status, reason = ST_SUPPRESSED_QUIET, f"{rule.quiet_from}-{rule.quiet_to}"
        elif rate_limited(db, rule, now):
            status, reason = ST_SUPPRESSED_RATE, f"{rule.rate_limit_minutes}m"
        text = alert_text_for(db, entry, count=count, count_kinds=count_kinds,
                              window=rule.count_window_minutes, tzinfo=tzinfo)
        out.extend(_deliver(
            db, rule=rule, kind=DISPATCH_ALERT, recipients=recipients, text=text, status=status,
            reason=reason, dedupe_prefix=f"alert:{entry.id}:{rule.id}", now=now, provider=provider, entry=entry,
        ))
    # "התראות לטלפון": the users' push rules, same holds and dedupe (push.py). Never costs the SMS.
    from app.services.exception_alerts import push as PUSH

    queued = len(db.info.get(PUSH.PENDING_JOBS, []))
    try:
        with db.begin_nested():
            out.extend(PUSH.process_entry(db, entry, now=now, tzinfo=tzinfo))
    except Exception:  # noqa: BLE001 - the entry and its SMS stand; the push is logged
        # Nothing of the rolled-back savepoint is sent.
        if PUSH.PENDING_JOBS in db.info:
            del db.info[PUSH.PENDING_JOBS][queued:]
        logger.exception("push alerts: entry %s failed", entry.id)
    return out


# ── Digests ──────────────────────────────────────────────────────────────────


def _pending_rule_ids(db: Session) -> List[Any]:
    return [
        r[0]
        for r in db.query(ExceptionAlertDispatch.rule_id)
        .join(ExceptionAlertRule, ExceptionAlertRule.id == ExceptionAlertDispatch.rule_id)
        .filter(
            ExceptionAlertDispatch.kind == DISPATCH_ALERT,
            ExceptionAlertDispatch.status.in_(SUPPRESSED_STATUSES),
            ExceptionAlertDispatch.digest_id.is_(None),
            ExceptionAlertRule.enabled.is_(True),
            ExceptionAlertRule.deleted_at.is_(None),
            ExceptionAlertRule.digest_enabled.is_(True),
        )
        .distinct()
        .all()
    ]


def flush_digests(db: Session, *, now: Optional[datetime] = None, provider: Optional[SMS.SmsProvider] = None) -> int:
    """
    Send the digest of every rule that held messages back and may send again (outside
    its quiet hours, past its rate window). One message per recipient. Returns how many
    digest rows were written. Commits per rule.
    """
    now = now or now_fn()
    provider = provider or SMS.get_provider()
    written = 0
    for rule_id in _pending_rule_ids(db):
        try:
            written += _flush_rule(db, rule_id, now, provider)
            db.commit()
        except Exception:  # noqa: BLE001 - one rule's failure never stops the others
            db.rollback()
            logger.exception("exception alert digest failed for rule %s", rule_id)
    return written


def _flush_rule(db: Session, rule_id: Any, now: datetime, provider: SMS.SmsProvider) -> int:
    rule = (
        db.query(ExceptionAlertRule)
        .filter(ExceptionAlertRule.id == rule_id)
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    if rule is None or not rule.enabled or rule.deleted_at is not None or not rule.digest_enabled:
        return 0
    if (rule.channel or CHANNEL_SMS) == CHANNEL_PUSH:
        from app.services.exception_alerts import push as PUSH

        return PUSH.flush_rule(db, rule, now)
    tzinfo = tz_for(db, rule.tenant_id)
    if in_quiet_hours(rule, now.astimezone(tzinfo)) or rate_limited(db, rule, now):
        return 0
    pending = (
        db.query(ExceptionAlertDispatch)
        .filter(
            ExceptionAlertDispatch.rule_id == rule.id,
            ExceptionAlertDispatch.kind == DISPATCH_ALERT,
            ExceptionAlertDispatch.status.in_(SUPPRESSED_STATUSES),
            ExceptionAlertDispatch.digest_id.is_(None),
        )
        .order_by(ExceptionAlertDispatch.created_at, ExceptionAlertDispatch.id)
        .all()
    )
    if not pending:
        return 0
    by_recipient: Dict[str, List[ExceptionAlertDispatch]] = {}
    for d in pending:
        by_recipient.setdefault(d.recipient_hash, []).append(d)
    written = 0
    for r in _recipients(rule):
        hashed = phone_hash(r["phone"])
        rows = by_recipient.pop(hashed, None)
        if not rows:
            continue
        entry_ids = list(dict.fromkeys(d.entry_id for d in rows if d.entry_id is not None))
        entries = (
            db.query(ExceptionLogEntry).filter(ExceptionLogEntry.id.in_(entry_ids)).all() if entry_ids else []
        )
        entries.sort(key=lambda e: aware(e.occurred_at))
        if not entries:
            for d in rows:
                d.digest_id = d.id  # nothing left to sum up: closed on itself
            continue
        quiet = all(d.status == ST_SUPPRESSED_QUIET for d in rows)
        if len(entries) == 1:
            text = alert_text_for(db, entries[0], tzinfo=tzinfo)
        else:
            kinds = Counter(label_of(e.kind) for e in entries)
            shops = {e.shop_id for e in entries}
            shop_name = None
            if len(shops) == 1 and None not in shops:
                shop_name, _till = _names(db, entries[0])
            text = M.digest_text(
                rule_name=rule.name, count=len(entries),
                since=aware(entries[0].occurred_at).astimezone(tzinfo).strftime("%H:%M"),
                until=aware(entries[-1].occurred_at).astimezone(tzinfo).strftime("%H:%M"),
                kinds=list(kinds.items()), shop=shop_name, link=link_for(entries[-1].short_code), quiet=quiet,
            )
        made = _deliver(
            db, rule=rule, kind=DISPATCH_DIGEST, recipients=[r], text=text, status=None, reason=None,
            dedupe_prefix=f"digest:{rule.id}:{rows[0].id}", now=now, provider=provider,
            digest_count=len(entries),
        )
        for digest in made:
            for d in rows:
                d.digest_id = digest.id
            written += 1
    # Rows of numbers no longer on the rule: nobody to sum them up for.
    for rows in by_recipient.values():
        for d in rows:
            d.digest_id = d.id
    db.flush()
    return written


# ── Test message ─────────────────────────────────────────────────────────────


def send_test(
    db: Session,
    rule: ExceptionAlertRule,
    *,
    user: Any = None,
    now: Optional[datetime] = None,
    provider: Optional[SMS.SmsProvider] = None,
) -> List[ExceptionAlertDispatch]:
    """"שליחת הודעת בדיקה" to the rule's recipients, through the active provider."""
    now = now or now_fn()
    provider = provider or SMS.get_provider()
    recipients = _recipients(rule)
    if not recipients:
        raise AlertError("recipients_required", 422)
    last = (
        db.query(func.max(ExceptionAlertDispatch.created_at))
        .filter(ExceptionAlertDispatch.rule_id == rule.id, ExceptionAlertDispatch.kind == DISPATCH_TEST)
        .scalar()
    )
    if last is not None and now - aware(last) < TEST_MIN_GAP:
        raise AlertError("test_too_soon", 429)
    description = provider.describe(db, rule.tenant_id, rule.company_id)
    text = M.test_text(rule_name=rule.name, link=None, dry_run=bool(description.get("dryRun")))
    return _deliver(
        db, rule=rule, kind=DISPATCH_TEST, recipients=recipients, text=text, status=None, reason=None,
        dedupe_prefix=f"test:{uuid.uuid4().hex}", now=now, provider=provider, user_id=getattr(user, "id", None),
    )


__all__ = [
    "STALE_AFTER", "AlertError", "entry_matches", "rules_for", "count_in_window", "in_quiet_hours",
    "rate_limited", "process_entry", "flush_digests", "send_test", "alert_text_for", "link_for",
]
