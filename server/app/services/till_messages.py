"""
Messages to tills ("הודעות לקופות"): a manager writes, every targeted till shows it
full-screen until its signed-in employee taps "קראתי".

Four rules hold the feature up:

* **Reach is fixed when it goes out.** A receipt row is written for each active till in
  the target that the sender can see; that list is the delivery's audience for good. A
  till moved or added later neither gains nor loses it, so "who acknowledged" always
  has a finite, stable answer.
* **Scheduling is lazy.** There is no background scheduler: a scheduled message, and
  each occurrence of a recurring one, "goes out" (its receipts are written) the first
  time a till of the tenant fetches its messages — or the dashboard lists them — after
  the due moment (`materialize_due`). Until then no till sees it. A recurring message's
  audience is resolved afresh for every occurrence, so a till added since gets the next
  one; each occurrence has its own receipts and needs its own acknowledgement.
* **Scoped like the tills themselves.** The target must be one the sender may manage
  (the machines list's rule: a company manager their group, a shop manager their shop,
  a distributor the tills they placed), and the tills it expands to are only those the
  sender can see — a narrowing, never a widening. A lazy delivery applies the sender's
  rule as it stands then.
* **The till's contract is small and fixed** (`GET /sync/{id}/messages`,
  `POST /sync/{id}/messages/{id}/ack`): unacknowledged, unexpired, oldest first; the
  first fetch marks delivery; an ack is idempotent and 404s for a message not addressed
  to that till. A recurring occurrence is listed under its receipt's id, so each day's
  copy is a distinct message to the till.

**Banners** ("באנר מבצעים", `display = "banner"`) ride the same machinery — levels,
schedules, receipts — but are listed apart, under `banners` in the till's fetch, so a till
that predates them never shows one full-screen. A banner is listed while it is live,
acknowledged or not: the till hides it for the rest of the shift when the employee closes
it (and says who, through the same ack), and shows it again the next shift. It may name a
product (its chip adds it to the order) and a colour preset; while it shows, its text,
product, colour and end can still be changed.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.product import Product
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.till_message import TILL_MESSAGE_LEVELS, TillMessage, TillMessageReceipt
from app.models.user import User, UserRole
from app.services.company_hierarchy import (
    ancestor_company_ids,
    descendant_company_ids,
    user_covers_company,
)
from app.services.overview import _visible_shops_query

#: `reason` on the realtime notify that tells a till to fetch its messages now.
NOTIFY_REASON = "till_message"

DEFAULT_TIMEZONE = "Asia/Jerusalem"

#: 400/404/409 details.
TARGET_NOT_FOUND = "till_message_target_not_found"
TARGET_FORBIDDEN = "till_message_target_forbidden"
NO_TILLS = "till_message_no_tills"
EXPIRY_IN_PAST = "till_message_expiry_in_past"
MESSAGE_NOT_FOUND = "till_message_not_found"
MESSAGE_CLOSED = "till_message_closed"
SCHEDULE_IN_PAST = "till_message_schedule_in_past"
EXPIRY_BEFORE_SEND = "till_message_expiry_before_send"
NO_OCCURRENCE = "till_message_no_occurrence"
NOT_EDITABLE = "till_message_not_editable"
NOT_RECURRING = "till_message_not_recurring"
PRODUCT_NOT_FOUND = "till_message_product_not_found"
BANNER_ONLY = "till_message_banner_only"

NotifyTarget = Tuple[str, str]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    """A naive stamp read as UTC (SQLite hands them back naive)."""
    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=timezone.utc)


def _as_uuid(value) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def _bad(detail: str, code: int = status.HTTP_400_BAD_REQUEST) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def is_live(message: TillMessage, now: Optional[datetime] = None) -> bool:
    expires = _utc(message.expires_at)
    return expires is None or expires > (now or _now())


def _receipt_live(receipt: TillMessageReceipt, now: datetime) -> bool:
    expires = _utc(receipt.expires_at)
    return expires is None or expires > now


# ── Time and schedule ─────────────────────────────────────────────────────────


def _zone(name: Optional[str]):
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        return ZoneInfo(name or DEFAULT_TIMEZONE)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return ZoneInfo(DEFAULT_TIMEZONE)


def tenant_timezone(db: Session, tenant_id) -> str:
    """The tenant's zone, as the reports read it ("UTC" = unset → Israel)."""
    from app.services.reports import resolve_report_timezone

    return resolve_report_timezone(db, tenant_id, None)


def _to_utc(moment: Optional[datetime], tz_name: Optional[str]) -> Optional[datetime]:
    """A stamp without an offset is local time in `tz_name`."""
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=_zone(tz_name))
    return moment.astimezone(timezone.utc)


def _weekday(d: date) -> int:
    """0 = Sunday (א׳) … 6 = Saturday (ש׳)."""
    return (d.weekday() + 1) % 7


def recur_days(message: TillMessage) -> List[int]:
    return sorted({int(c) for c in (message.recur_days or "") if c.isdigit()})


def _on_schedule(message: TillMessage, d: date) -> bool:
    if _weekday(d) not in recur_days(message):
        return False
    if message.recur_start_date is not None and d < message.recur_start_date:
        return False
    if message.recur_end_date is not None and d > message.recur_end_date:
        return False
    return True


def occurrence_start(message: TillMessage, d: date) -> datetime:
    hour, minute = (int(x) for x in (message.recur_time or "00:00").split(":"))
    local = datetime.combine(d, dtime(hour, minute), tzinfo=_zone(message.timezone))
    return local.astimezone(timezone.utc)


def _next_date(message: TillMessage, d: date) -> Optional[date]:
    for i in range(1, 8):
        candidate = d + timedelta(days=i)
        if message.recur_end_date is not None and candidate > message.recur_end_date:
            return None
        if _on_schedule(message, candidate):
            return candidate
    return None


def occurrence_end(message: TillMessage, d: date) -> datetime:
    """
    When an occurrence stops being shown: after `occurrence_ttl_minutes`, else at the
    end of its local day — and never after the next occurrence begins.
    """
    start = occurrence_start(message, d)
    if message.occurrence_ttl_minutes:
        end = start + timedelta(minutes=int(message.occurrence_ttl_minutes))
    else:
        midnight = datetime.combine(d + timedelta(days=1), dtime(0, 0), tzinfo=_zone(message.timezone))
        end = midnight.astimezone(timezone.utc)
    following = _next_date(message, d)
    if following is not None:
        end = min(end, occurrence_start(message, following))
    return end


def current_occurrence(message: TillMessage, now: datetime) -> Optional[date]:
    """The local date of the latest occurrence that has begun by `now` (a week back)."""
    today = now.astimezone(_zone(message.timezone)).date()
    for back in range(0, 8):
        d = today - timedelta(days=back)
        if _on_schedule(message, d) and occurrence_start(message, d) <= now:
            return d
    return None


def next_occurrence_at(message: TillMessage, now: datetime) -> Optional[datetime]:
    """When the next occurrence begins; None once the schedule is over."""
    first = now.astimezone(_zone(message.timezone)).date()
    if message.recur_start_date is not None and message.recur_start_date > first:
        first = message.recur_start_date
    for i in range(0, 8):
        d = first + timedelta(days=i)
        if message.recur_end_date is not None and d > message.recur_end_date:
            return None
        if _on_schedule(message, d):
            start = occurrence_start(message, d)
            if start > now:
                return start
    return None


def _skip_started(message: TillMessage, now: datetime) -> None:
    """
    An occurrence already under way when the message is created, edited or resumed is
    not delivered late: the schedule takes effect from the next one.
    """
    d = current_occurrence(message, now)
    if d is not None and (message.last_occurrence_date is None or d > message.last_occurrence_date):
        message.last_occurrence_date = d


def _check_schedule(message: TillMessage, now: datetime) -> None:
    if message.schedule_kind == "scheduled":
        send_at = _utc(message.send_at)
        if send_at is None or send_at <= now:
            raise _bad(SCHEDULE_IN_PAST)
        if message.expires_at is not None and _utc(message.expires_at) <= send_at:
            raise _bad(EXPIRY_BEFORE_SEND)
    elif message.schedule_kind == "recurring":
        if not recur_days(message) or not message.recur_time:
            raise _bad(NO_OCCURRENCE)
        if (
            message.recur_start_date is not None
            and message.recur_end_date is not None
            and message.recur_end_date < message.recur_start_date
        ):
            raise _bad(NO_OCCURRENCE)
        if next_occurrence_at(message, now) is None:
            raise _bad(NO_OCCURRENCE)


# ── Scope ─────────────────────────────────────────────────────────────────────


def visible_machines_query(db: Session, user: User, tenant_id):
    """Active tills the user can see, by the machines list's rule; None for none."""
    shops_q = _visible_shops_query(db, user, tenant_id)
    if shops_q is None:
        return None
    shop_ids = shops_q.with_entities(Shop.id)
    return db.query(POSMachine).filter(
        POSMachine.tenant_id == tenant_id,
        POSMachine.is_active.is_(True),
        POSMachine.shop_id.in_(shop_ids),
        *(
            [POSMachine.distributor_id == user.id]
            if user.role == UserRole.DISTRIBUTOR
            else []
        ),
    )


def _shop_visible(db: Session, user: User, tenant_id, shop_id) -> bool:
    shops_q = _visible_shops_query(db, user, tenant_id)
    return shops_q is not None and shops_q.filter(Shop.id == shop_id).first() is not None


def resolve_target(db: Session, user: User, tenant_id, level: str, target_id):
    """
    The company, shop, area or till named, when the user may message it.

    404 for an unknown id or another tenant's (the caller learns nothing about it), 403
    for one of this tenant the user does not manage.
    """
    wanted = _as_uuid(target_id)
    if level not in TILL_MESSAGE_LEVELS or wanted is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=TARGET_NOT_FOUND)
    model = {"company": Company, "shop": Shop, "area": ShopArea, "machine": POSMachine}[level]
    entity = db.query(model).filter(model.id == wanted).first()
    if entity is None or str(entity.tenant_id) != str(tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=TARGET_NOT_FOUND)

    if level == "company":
        allowed = user.role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR) or (
            user.role == UserRole.COMPANY_MANAGER and user_covers_company(db, user, entity.id)
        )
    elif level == "shop":
        allowed = _shop_visible(db, user, tenant_id, entity.id)
    elif level == "area":
        allowed = entity.archived_at is None and _shop_visible(db, user, tenant_id, entity.shop_id)
    else:
        visible = visible_machines_query(db, user, tenant_id)
        allowed = visible is not None and visible.filter(POSMachine.id == entity.id).first() is not None
    if not allowed:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=TARGET_FORBIDDEN)
    return entity


def _in_target(db: Session, query, level: str, target_id):
    """Narrow a tills query to a target. A company means its group."""
    wanted = _as_uuid(target_id)
    if level == "machine":
        return query.filter(POSMachine.id == wanted)
    if level == "area":
        return query.filter(POSMachine.area_id == wanted)
    if level == "shop":
        return query.filter(POSMachine.shop_id == wanted)
    group = descendant_company_ids(db, wanted)
    return query.filter(POSMachine.shop_id.in_(db.query(Shop.id).filter(Shop.company_id.in_(group))))


def target_machines(db: Session, user: User, tenant_id, level: str, target_id) -> List[POSMachine]:
    """
    The active tills a message to this target reaches: the target's tills the user can
    see. A company means its group (its subsidiaries' shops too), as on the overview.
    """
    resolve_target(db, user, tenant_id, level, target_id)
    query = visible_machines_query(db, user, tenant_id)
    if query is None:
        return []
    return _in_target(db, query, level, target_id).all()


def _audience(db: Session, message: TillMessage) -> List[POSMachine]:
    """
    Who a lazy delivery reaches: the target's tills by the sender's rule as it stands
    now (none, if they may no longer message it). A deleted sender: every active till
    of the target.
    """
    sender = db.get(User, message.created_by) if message.created_by is not None else None
    if sender is not None:
        try:
            return target_machines(db, sender, message.tenant_id, message.target_level, message.target_id)
        except HTTPException:
            return []
    query = db.query(POSMachine).filter(
        POSMachine.tenant_id == message.tenant_id, POSMachine.is_active.is_(True)
    )
    return _in_target(db, query, message.target_level, message.target_id).all()


def may_manage(db: Session, user: User, tenant_id, message: TillMessage) -> bool:
    """Cancel / resend / edit: the sender's own rule, applied to the message's target now."""
    try:
        resolve_target(db, user, tenant_id, message.target_level, message.target_id)
    except HTTPException:
        return False
    return True


# ── Lazy delivery ─────────────────────────────────────────────────────────────


def _deliver(
    db: Session,
    message: TillMessage,
    now: datetime,
    *,
    occurrence: Optional[date] = None,
) -> None:
    """
    Write this delivery's receipts and mark it handled, in a savepoint: when two tills'
    fetches race, the second hits the unique index and leaves it to the first.
    """
    machines = _audience(db, message)
    try:
        with db.begin_nested():
            if occurrence is None:
                message.sent_at = now
                starts, ends = None, None
            else:
                message.last_occurrence_date = occurrence
                starts, ends = occurrence_start(message, occurrence), occurrence_end(message, occurrence)
            for machine in machines:
                db.add(
                    TillMessageReceipt(
                        id=uuid.uuid4(),
                        message_id=message.id,
                        machine_id=machine.id,
                        occurrence_date=occurrence,
                        occurs_at=starts,
                        expires_at=ends,
                    )
                )
            db.flush()
    except IntegrityError:
        db.refresh(message)


def materialize_due(db: Session, tenant_id, now: Optional[datetime] = None) -> None:
    """
    Send what has come due for the tenant: scheduled messages past `send_at`, and the
    current occurrence of each running recurring message, unless already handled.
    Cheap when nothing is due: one query and a little date arithmetic.
    """
    now = now or _now()
    horizon = (now - timedelta(days=2)).date()
    candidates = (
        db.query(TillMessage)
        .filter(
            TillMessage.tenant_id == tenant_id,
            TillMessage.cancelled_at.is_(None),
            or_(
                and_(TillMessage.schedule_kind == "scheduled", TillMessage.sent_at.is_(None)),
                and_(
                    TillMessage.schedule_kind == "recurring",
                    TillMessage.paused_at.is_(None),
                    or_(TillMessage.recur_end_date.is_(None), TillMessage.recur_end_date >= horizon),
                ),
            ),
        )
        .all()
    )
    for message in candidates:
        if message.schedule_kind == "scheduled":
            if _utc(message.send_at) is not None and _utc(message.send_at) <= now:
                _deliver(db, message, now)
            continue
        d = current_occurrence(message, now)
        if d is None or (message.last_occurrence_date is not None and d <= message.last_occurrence_date):
            continue
        if occurrence_end(message, d) <= now:
            message.last_occurrence_date = d  # missed entirely: nobody asked in time
            db.flush()
            continue
        _deliver(db, message, now, occurrence=d)


# ── Dashboard writes ──────────────────────────────────────────────────────────


def _check_product(db: Session, tenant_id, product_id) -> Optional[uuid.UUID]:
    """A banner's product: one of the tenant's (404 otherwise). None stays None."""
    if product_id is None:
        return None
    wanted = _as_uuid(product_id)
    row = db.query(Product.id, Product.tenant_id).filter(Product.id == wanted).first() if wanted else None
    if row is None or str(row[1]) != str(tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=PRODUCT_NOT_FOUND)
    return wanted


def send_message(
    db: Session,
    user: User,
    tenant_id,
    *,
    title: Optional[str],
    body: str,
    target_level: str,
    target_id,
    expires_at: Optional[datetime] = None,
    schedule_kind: str = "now",
    send_at: Optional[datetime] = None,
    recur_days: Optional[Sequence[int]] = None,
    recur_time: Optional[str] = None,
    recur_start_date: Optional[date] = None,
    recur_end_date: Optional[date] = None,
    occurrence_ttl_minutes: Optional[int] = None,
    display: str = "fullscreen",
    product_id=None,
    color: Optional[str] = None,
) -> TillMessage:
    now = _now()
    banner = display == "banner"
    if not banner and (product_id is not None or color is not None):
        raise _bad(BANNER_ONLY)
    product = _check_product(db, tenant_id, product_id) if banner else None
    tz_name = tenant_timezone(db, tenant_id)
    expires_at = _to_utc(expires_at, tz_name)
    if expires_at is not None and expires_at <= now:
        raise _bad(EXPIRY_IN_PAST)
    machines = target_machines(db, user, tenant_id, target_level, target_id)
    if not machines:
        raise _bad(NO_TILLS)
    message = TillMessage(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        created_by=user.id,
        created_at=now,
        title=title or None,
        body=body,
        target_level=target_level,
        target_id=_as_uuid(target_id),
        expires_at=expires_at,
        schedule_kind=schedule_kind or "now",
        timezone=tz_name,
        display="banner" if banner else "fullscreen",
        product_id=product,
        color=color if banner else None,
    )
    if message.schedule_kind == "scheduled":
        message.send_at = _to_utc(send_at, tz_name)
    elif message.schedule_kind == "recurring":
        message.expires_at = None
        message.recur_days = "".join(str(d) for d in sorted(set(recur_days or [])))
        message.recur_time = recur_time
        message.recur_start_date = recur_start_date
        message.recur_end_date = recur_end_date
        message.occurrence_ttl_minutes = occurrence_ttl_minutes
    else:
        message.sent_at = now
    _check_schedule(message, now)
    if message.schedule_kind == "recurring":
        _skip_started(message, now)
    db.add(message)
    db.flush()
    if message.schedule_kind == "now":
        for machine in machines:
            db.add(TillMessageReceipt(id=uuid.uuid4(), message_id=message.id, machine_id=machine.id))
        db.flush()
    return message


def get_message(db: Session, tenant_id, message_id) -> TillMessage:
    wanted = _as_uuid(message_id)
    message = (
        db.query(TillMessage)
        .filter(TillMessage.id == wanted, TillMessage.tenant_id == tenant_id)
        .first()
        if wanted is not None
        else None
    )
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=MESSAGE_NOT_FOUND)
    return message


def _require_manage(db: Session, user: User, tenant_id, message: TillMessage) -> None:
    if not may_manage(db, user, tenant_id, message):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=TARGET_FORBIDDEN)


def _require_open(db: Session, user: User, tenant_id, message: TillMessage) -> None:
    _require_manage(db, user, tenant_id, message)
    if message.cancelled_at is not None:
        raise _bad(MESSAGE_CLOSED, status.HTTP_409_CONFLICT)


def cancel_message(db: Session, user: User, tenant_id, message: TillMessage) -> TillMessage:
    """
    Stop showing it now; idempotent. The tills drop it on their next fetch. A scheduled
    or recurring message never goes out again.
    """
    _require_manage(db, user, tenant_id, message)
    now = _now()
    if message.cancelled_at is None:
        message.cancelled_at = now
    if is_live(message, now):
        message.expires_at = now
    db.flush()
    return message


def pause_message(db: Session, user: User, tenant_id, message: TillMessage) -> TillMessage:
    """A recurring message stops going out; an occurrence already showing stays. Idempotent."""
    _require_open(db, user, tenant_id, message)
    if message.schedule_kind != "recurring":
        raise _bad(NOT_RECURRING, status.HTTP_409_CONFLICT)
    if message.paused_at is None:
        message.paused_at = _now()
    db.flush()
    return message


def resume_message(db: Session, user: User, tenant_id, message: TillMessage) -> TillMessage:
    """Going out again from the next occurrence (one under way is not sent late)."""
    _require_open(db, user, tenant_id, message)
    if message.schedule_kind != "recurring":
        raise _bad(NOT_RECURRING, status.HTTP_409_CONFLICT)
    if message.paused_at is not None:
        message.paused_at = None
        _skip_started(message, _now())
    db.flush()
    return message


_SCHEDULE_FIELDS = (
    "recur_days",
    "recur_time",
    "recur_start_date",
    "recur_end_date",
    "occurrence_ttl_minutes",
)


def update_message(
    db: Session, user: User, tenant_id, message: TillMessage, changes: dict
) -> TillMessage:
    """
    Edit a scheduled message before it goes out, or a recurring one at any time (a
    schedule change takes effect from the next occurrence; text changes show at once on
    an occurrence still showing). `changes` holds only the fields the caller sent.

    A banner that has gone out can still change its text, product, colour and end (the
    tills pick it up on their next fetch) — never when or how it went out.
    """
    _require_open(db, user, tenant_id, message)
    sent = message.schedule_kind == "now" or (
        message.schedule_kind == "scheduled" and message.sent_at is not None
    )
    if sent and message.display != "banner":
        raise _bad(NOT_EDITABLE, status.HTTP_409_CONFLICT)
    if sent and (
        changes.get("display") not in (None, message.display)
        or any(changes.get(f) is not None for f in ("send_at", *_SCHEDULE_FIELDS))
    ):
        raise _bad(NOT_EDITABLE, status.HTTP_409_CONFLICT)
    now = _now()
    tz_name = message.timezone
    if changes.get("display"):
        message.display = changes["display"]
    if message.display == "banner":
        if "product_id" in changes:
            message.product_id = _check_product(db, tenant_id, changes["product_id"])
        if "color" in changes:
            message.color = changes["color"]
    else:
        if changes.get("product_id") is not None or changes.get("color") is not None:
            raise _bad(BANNER_ONLY)
        message.product_id = None
        message.color = None
    if "title" in changes:
        message.title = changes["title"] or None
    if changes.get("body"):
        message.body = changes["body"]
    if sent:
        if "expires_at" in changes:
            expires = _to_utc(changes["expires_at"], tz_name)
            if expires is not None and expires <= now:
                raise _bad(EXPIRY_IN_PAST)
            message.expires_at = expires
        db.flush()
        return message
    if message.schedule_kind == "scheduled":
        if changes.get("send_at") is not None:
            message.send_at = _to_utc(changes["send_at"], tz_name)
        if "expires_at" in changes:
            message.expires_at = _to_utc(changes["expires_at"], tz_name)
    else:
        for field in _SCHEDULE_FIELDS:
            if field not in changes:
                continue
            value = changes[field]
            if field == "recur_days":
                if value:
                    message.recur_days = "".join(str(d) for d in sorted(set(value)))
            elif field == "recur_time":
                if value:
                    message.recur_time = value
            else:
                setattr(message, field, value)
    _check_schedule(message, now)
    if message.schedule_kind == "recurring" and any(f in changes for f in _SCHEDULE_FIELDS):
        _skip_started(message, now)
    db.flush()
    return message


def unacknowledged_machines(db: Session, message: TillMessage) -> List[POSMachine]:
    """Tills with an unacknowledged copy still showing (a recurring message: today's)."""
    now = _now()
    return (
        db.query(POSMachine)
        .join(TillMessageReceipt, TillMessageReceipt.machine_id == POSMachine.id)
        .filter(
            TillMessageReceipt.message_id == message.id,
            TillMessageReceipt.acknowledged_at.is_(None),
            or_(TillMessageReceipt.expires_at.is_(None), TillMessageReceipt.expires_at > now),
            POSMachine.is_active.is_(True),
        )
        .distinct()
        .all()
    )


def resend_targets(db: Session, user: User, tenant_id, message: TillMessage) -> List[POSMachine]:
    """The tills to wake again: those that have not acknowledged. 409 once it is over."""
    _require_manage(db, user, tenant_id, message)
    if not is_live(message):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=MESSAGE_CLOSED)
    return unacknowledged_machines(db, message)


def notify_targets(machines: Iterable[POSMachine]) -> List[NotifyTarget]:
    return [(str(m.tenant_id), str(m.id)) for m in machines if m.tenant_id and m.is_active]


def publish_message_notify(targets: Iterable[NotifyTarget]) -> None:
    """
    Best effort, after the commit: one realtime wake-up per till, which makes it sync
    now and so fetch its messages. A till that misses it fetches on its heartbeat.
    """
    from app.services.ably_notify import publish_settings_notify

    for tenant_id, machine_id in targets:
        try:
            publish_settings_notify(tenant_id, machine_id, reason=NOTIFY_REASON)
        except Exception:  # pragma: no cover - a notify never fails the request
            pass


# ── Dashboard reads ───────────────────────────────────────────────────────────


def _receipt_status(receipt: TillMessageReceipt) -> str:
    if receipt.acknowledged_at is not None:
        return "acknowledged"
    if receipt.delivered_at is not None:
        return "delivered"
    return "sent"


def _recurring_over(message: TillMessage, now: datetime) -> bool:
    if next_occurrence_at(message, now) is not None:
        return False
    d = current_occurrence(message, now)
    return d is None or occurrence_end(message, d) <= now


def _message_status(message: TillMessage, now: datetime) -> str:
    """
    active | expired | cancelled, and for scheduling: scheduled (not gone out yet),
    paused, ended (a recurring schedule with nothing left to send or show).
    """
    if message.cancelled_at is not None:
        return "cancelled"
    if message.schedule_kind == "scheduled" and message.sent_at is None:
        return "scheduled"
    if message.schedule_kind == "recurring":
        if message.paused_at is not None:
            return "paused"
        return "ended" if _recurring_over(message, now) else "active"
    if not is_live(message, now):
        return "expired"
    return "active"


def _schedule_out(message: TillMessage, now: datetime, latest: Optional[date]) -> dict:
    kind = message.schedule_kind or "now"
    out = {
        "scheduleKind": kind,
        "sendAt": _utc(message.send_at),
        "sentAt": _utc(message.sent_at),
        "timezone": message.timezone,
        "pausedAt": _utc(message.paused_at),
        "recurrence": None,
        "nextOccurrenceAt": None,
        "occurrence": None,
    }
    if kind == "scheduled" and message.sent_at is None and message.cancelled_at is None:
        out["nextOccurrenceAt"] = _utc(message.send_at)
    if kind == "recurring":
        out["recurrence"] = {
            "days": recur_days(message),
            "time": message.recur_time,
            "startDate": message.recur_start_date,
            "endDate": message.recur_end_date,
            "occurrenceTtlMinutes": message.occurrence_ttl_minutes,
        }
        if message.cancelled_at is None and message.paused_at is None:
            out["nextOccurrenceAt"] = next_occurrence_at(message, now)
        if latest is not None:
            ends = occurrence_end(message, latest)
            out["occurrence"] = {
                "date": latest,
                "startsAt": occurrence_start(message, latest),
                "expiresAt": ends,
                "live": ends > now and message.cancelled_at is None,
            }
    return out


def _target_names(db: Session, messages: Sequence[TillMessage]) -> Dict[Tuple[str, str], str]:
    by_level: Dict[str, set] = {}
    for m in messages:
        by_level.setdefault(m.target_level, set()).add(m.target_id)
    names: Dict[Tuple[str, str], str] = {}
    models = {"company": Company, "shop": Shop, "area": ShopArea, "machine": POSMachine}
    for level, ids in by_level.items():
        model = models.get(level)
        if model is None or not ids:
            continue
        for row_id, name in db.query(model.id, model.name).filter(model.id.in_(list(ids))):
            names[(level, str(row_id))] = name
    return names


def _product_names(db: Session, ids: Iterable) -> Dict[uuid.UUID, str]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    return dict(db.query(Product.id, Product.name).filter(Product.id.in_(list(wanted))).all())


def _pending_schedule_filter(db: Session, visible):
    """
    Scheduled / recurring messages whose target holds a till the reader can see: they
    may have no receipts yet (not gone out, or no occurrence so far) but are listed.
    """
    rows = (
        visible.join(Shop, Shop.id == POSMachine.shop_id)
        .with_entities(POSMachine.id, POSMachine.area_id, POSMachine.shop_id, Shop.company_id)
        .all()
    )
    machine_ids = [r[0] for r in rows]
    area_ids = list({r[1] for r in rows if r[1] is not None})
    shop_ids = list({r[2] for r in rows})
    company_ids = set()
    for cid in {r[3] for r in rows if r[3] is not None}:
        company_ids.add(cid)
        company_ids.update(ancestor_company_ids(db, cid))
    return and_(
        TillMessage.schedule_kind != "now",
        or_(
            and_(TillMessage.target_level == "machine", TillMessage.target_id.in_(machine_ids)),
            and_(TillMessage.target_level == "area", TillMessage.target_id.in_(area_ids)),
            and_(TillMessage.target_level == "shop", TillMessage.target_id.in_(shop_ids)),
            and_(TillMessage.target_level == "company", TillMessage.target_id.in_(list(company_ids))),
        ),
    )


def list_messages(
    db: Session,
    user: User,
    tenant_id,
    *,
    limit: int = 50,
    offset: int = 0,
    message_id=None,
) -> dict:
    """
    Messages that reached at least one till the user can see — or, scheduled or
    recurring, are addressed to one — newest first, each with the status of those tills
    only (a recurring message: of its latest occurrence). Sends what has come due first.
    """
    now = _now()
    materialize_due(db, tenant_id, now)
    visible = visible_machines_query(db, user, tenant_id)
    if visible is None:
        return {"items": [], "total": 0}
    visible_ids = visible.with_entities(POSMachine.id)
    base = db.query(TillMessage).filter(
        TillMessage.tenant_id == tenant_id,
        or_(
            TillMessage.id.in_(
                db.query(TillMessageReceipt.message_id).filter(
                    TillMessageReceipt.machine_id.in_(visible_ids)
                )
            ),
            _pending_schedule_filter(db, visible),
        ),
    )
    if message_id is not None:
        base = base.filter(TillMessage.id == _as_uuid(message_id))
    total = base.with_entities(func.count(TillMessage.id)).scalar() or 0
    messages = (
        base.order_by(TillMessage.created_at.desc(), TillMessage.id)
        .offset(offset)
        .limit(limit)
        .all()
    )
    if not messages:
        return {"items": [], "total": int(total)}

    recurring_ids = [m.id for m in messages if m.schedule_kind == "recurring"]
    latest: Dict[uuid.UUID, date] = {}
    if recurring_ids:
        latest = dict(
            db.query(TillMessageReceipt.message_id, func.max(TillMessageReceipt.occurrence_date))
            .filter(TillMessageReceipt.message_id.in_(recurring_ids))
            .group_by(TillMessageReceipt.message_id)
            .all()
        )
    which = [TillMessageReceipt.message_id.in_([m.id for m in messages if m.id not in latest])]
    which += [
        and_(TillMessageReceipt.message_id == mid, TillMessageReceipt.occurrence_date == d)
        for mid, d in latest.items()
        if d is not None
    ]
    rows = (
        db.query(TillMessageReceipt, POSMachine, Shop.name, ShopArea.name)
        .join(POSMachine, POSMachine.id == TillMessageReceipt.machine_id)
        .outerjoin(Shop, Shop.id == POSMachine.shop_id)
        .outerjoin(ShopArea, ShopArea.id == POSMachine.area_id)
        .filter(
            or_(*which),
            TillMessageReceipt.machine_id.in_(visible_ids),
        )
        .all()
    )
    receipts: Dict[uuid.UUID, List[dict]] = {}
    for receipt, machine, shop_name, area_name in rows:
        receipts.setdefault(receipt.message_id, []).append(
            {
                "machineId": machine.id,
                "machineName": machine.name,
                "posNumber": machine.pos_number,
                "shopName": shop_name,
                "areaName": area_name,
                "status": _receipt_status(receipt),
                "deliveredAt": _utc(receipt.delivered_at),
                "acknowledgedAt": _utc(receipt.acknowledged_at),
                "acknowledgedByPosUserId": receipt.acknowledged_by_pos_user_id,
                "acknowledgedByName": receipt.acknowledged_by_pos_user_name,
            }
        )

    sender_ids = {m.created_by for m in messages if m.created_by is not None}
    senders = (
        dict(db.query(User.id, User.username).filter(User.id.in_(list(sender_ids))))
        if sender_ids
        else {}
    )
    names = _target_names(db, messages)
    product_names = _product_names(db, [m.product_id for m in messages])
    status_order = {"sent": 0, "delivered": 1, "acknowledged": 2}

    items = []
    for m in messages:
        tills = sorted(
            receipts.get(m.id, []),
            key=lambda r: (
                status_order[r["status"]],
                (r["shopName"] or "").lower(),
                (r["posNumber"] or ""),
                (r["machineName"] or "").lower(),
            ),
        )
        state = _message_status(m, now)
        manage = state in ("active", "scheduled", "paused") and may_manage(db, user, tenant_id, m)
        banner = (m.display or "fullscreen") == "banner"
        item = {
            "id": m.id,
            "title": m.title,
            "body": m.body,
            "targetLevel": m.target_level,
            "targetId": m.target_id,
            "targetName": names.get((m.target_level, str(m.target_id))),
            "createdAt": _utc(m.created_at),
            "senderName": senders.get(m.created_by),
            "expiresAt": _utc(m.expires_at),
            "cancelledAt": _utc(m.cancelled_at),
            "status": state,
            "counts": {
                "total": len(tills),
                "delivered": sum(1 for r in tills if r["status"] != "sent"),
                "acknowledged": sum(1 for r in tills if r["status"] == "acknowledged"),
            },
            "canManage": manage,
            "canEdit": manage and (m.schedule_kind == "recurring" or state == "scheduled" or banner),
            "tills": tills,
            "display": "banner" if banner else "fullscreen",
            "productId": m.product_id if banner else None,
            "productName": product_names.get(m.product_id) if banner else None,
            "color": m.color if banner else None,
        }
        item.update(_schedule_out(m, now, latest.get(m.id)))
        items.append(item)
    return {"items": items, "total": int(total)}


# ── The till's side ───────────────────────────────────────────────────────────


def _till_id(receipt: TillMessageReceipt, message: TillMessage) -> str:
    """A recurring occurrence is its own message to the till: its receipt's id."""
    return str(receipt.id) if receipt.occurrence_date is not None else str(message.id)


def _live_for_machine(db: Session, machine: POSMachine, now: datetime, *, banners: bool):
    """
    This till's live copies, oldest first: the full-screen messages it has not
    acknowledged, or ([banners]) its banners, acknowledged or not.
    """
    query = (
        db.query(TillMessageReceipt, TillMessage)
        .join(TillMessage, TillMessage.id == TillMessageReceipt.message_id)
        .filter(
            TillMessageReceipt.machine_id == machine.id,
            TillMessage.tenant_id == machine.tenant_id,
        )
    )
    if banners:
        query = query.filter(TillMessage.display == "banner")
    else:
        query = query.filter(
            TillMessageReceipt.acknowledged_at.is_(None),
            or_(TillMessage.display.is_(None), TillMessage.display != "banner"),
        )
    live = [
        (r, m)
        for r, m in query.all()
        if is_live(m, now)
        and _receipt_live(r, now)
        and (_utc(m.send_at) is None or _utc(m.send_at) <= now)
    ]
    live.sort(key=lambda pair: (_sent_at(pair), str(pair[1].id)))
    return live


def _sent_at(pair) -> datetime:
    r, m = pair
    return _utc(r.occurs_at) or _utc(m.send_at) or _utc(m.created_at)


def pending_for_machine(db: Session, machine: POSMachine) -> List[dict]:
    """
    This till's unacknowledged, unexpired full-screen messages, oldest first, after
    sending what has come due. The first fetch of each marks it delivered.
    """
    now = _now()
    materialize_due(db, machine.tenant_id, now)
    live = _live_for_machine(db, machine, now, banners=False)
    sent = _sent_at
    sender_ids = {m.created_by for _, m in live if m.created_by is not None}
    senders = (
        dict(db.query(User.id, User.username).filter(User.id.in_(list(sender_ids))))
        if sender_ids
        else {}
    )
    items = []
    for receipt, message in live:
        if receipt.delivered_at is None:
            receipt.delivered_at = now
        items.append(
            {
                "id": _till_id(receipt, message),
                "title": message.title,
                "body": message.body,
                "sentAt": sent((receipt, message)).isoformat(),
                "senderName": senders.get(message.created_by),
            }
        )
    db.flush()
    return items


def banners_for_machine(db: Session, machine: POSMachine, *, materialize: bool = True) -> List[dict]:
    """
    This till's live banners, oldest first — whether or not an employee closed them (the
    till hides a closed one for the rest of its shift). Marks each delivered on its first
    fetch. `productId` is the cloud's product id (the till's `cloudId`); `expiresAt` when
    it stops (null: until cancelled).
    """
    now = _now()
    if materialize:
        materialize_due(db, machine.tenant_id, now)
    live = _live_for_machine(db, machine, now, banners=True)
    senders_ids = {m.created_by for _, m in live if m.created_by is not None}
    senders = (
        dict(db.query(User.id, User.username).filter(User.id.in_(list(senders_ids))))
        if senders_ids
        else {}
    )
    names = _product_names(db, [m.product_id for _, m in live])
    items = []
    for receipt, message in live:
        if receipt.delivered_at is None:
            receipt.delivered_at = now
        ends = [e for e in (_utc(receipt.expires_at), _utc(message.expires_at)) if e is not None]
        items.append(
            {
                "id": _till_id(receipt, message),
                "title": message.title,
                "body": message.body,
                "sentAt": _sent_at((receipt, message)).isoformat(),
                "senderName": senders.get(message.created_by),
                "display": "banner",
                "color": message.color,
                "productId": str(message.product_id) if message.product_id else None,
                "productName": names.get(message.product_id),
                "expiresAt": min(ends).isoformat() if ends else None,
            }
        )
    db.flush()
    return items


def acknowledge(
    db: Session,
    machine: POSMachine,
    message_id,
    *,
    pos_user_id: Optional[str],
    pos_user_name: Optional[str],
) -> TillMessageReceipt:
    """
    Record "קראתי" for this till. Idempotent: the first acknowledgement stands and a
    repeat is a no-op. 404 when the message was not addressed to this till.

    `message_id` is what the till was given: a message's id, or a recurring
    occurrence's receipt id. A recurring message's own id acknowledges its latest
    occurrence on this till.
    """
    wanted = _as_uuid(message_id)
    receipt = None
    if wanted is not None:
        base = (
            db.query(TillMessageReceipt)
            .join(TillMessage, TillMessage.id == TillMessageReceipt.message_id)
            .filter(
                TillMessageReceipt.machine_id == machine.id,
                TillMessage.tenant_id == machine.tenant_id,
            )
        )
        receipt = base.filter(TillMessageReceipt.id == wanted).first()
        if receipt is None:
            mine = (
                base.filter(TillMessageReceipt.message_id == wanted)
                .order_by(TillMessageReceipt.occurrence_date.desc())
                .all()
            )
            receipt = next((r for r in mine if r.acknowledged_at is None), None) or (
                mine[0] if mine else None
            )
    if receipt is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=MESSAGE_NOT_FOUND)
    if receipt.acknowledged_at is None:
        now = _now()
        receipt.acknowledged_at = now
        if receipt.delivered_at is None:
            receipt.delivered_at = now
        receipt.acknowledged_by_pos_user_id = (pos_user_id or "").strip()[:100] or None
        receipt.acknowledged_by_pos_user_name = (pos_user_name or "").strip()[:200] or None
        db.flush()
    return receipt
