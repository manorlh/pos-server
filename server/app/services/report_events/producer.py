"""
"עמדת מפיק" — a read-only portal for an event's customer / producer.

**Who.** A dashboard user with the role PRODUCER_VIEW, invited from the event by its owner
(`invite`): the existing user system — a `users` row by e-mail that the producer's Clerk
sign-in claims (app/services/clerk_provision.py), a membership in the organization, and one
`producer_event_grants` row per event. Optionally Clerk's own invitation e-mail. Revoking keeps
the grant row; a producer left with no event is deactivated.

**What they see** — only through an active grant of an event of the active organization
(`granted_event`; anything else is "not found", whether it exists or not):

* `summary` — the event's sales: totals, by the hour, the items (the event report's money);
* `vouchers` — the prepaid vouchers of their production (production.py: the linked batches)
  redeemed on the event's tills during the event, reversed ones skipped — counts and units,
  never codes or staff;
* `settlement` — only when the owner switched it on for the event: per batch, the vouchers the
  production is charged for — by its `billing_basis` (redemption or delivery), as the production
  vouchers' settlement service counts them (prepaid_voucher_settlement) — at the production price.

**Nothing else.** app/services/dashboard_access.py lets a PRODUCER_VIEW user reach only the
`/producer/*` routes and a few GETs about themselves; every producer route goes through
`granted_event`.
"""
from __future__ import annotations

import logging
import re
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch, PrepaidVoucherRedemption
from app.models.report_event import ProducerEventGrant, ReportEvent
from app.models.shop import Shop
from app.models.tenant_membership import TenantMembership, TenantMembershipRole
from app.models.user import User, UserRole

from . import live as LIVE
from . import production as PROD
from .common import ZERO, iso, money, utc

logger = logging.getLogger(__name__)

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ITEMS_MAX = 100


class ProducerError(ValueError):
    def __init__(self, code: str, status: int = 422, message: Optional[str] = None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.message = message


# ── Access ───────────────────────────────────────────────────────────────────


def is_producer(user: Any) -> bool:
    return getattr(user, "role", None) == UserRole.PRODUCER_VIEW


def active_grants(db: Session, user_id: Any, tenant_id: Any) -> List[ProducerEventGrant]:
    return (
        db.query(ProducerEventGrant)
        .filter(
            ProducerEventGrant.user_id == user_id,
            ProducerEventGrant.tenant_id == tenant_id,
            ProducerEventGrant.revoked_at.is_(None),
        )
        .all()
    )


def granted_event(db: Session, user: User, tenant_id: Any, event_id: Any) -> ReportEvent:
    """
    The event, when this user may see it as its producer: a PRODUCER_VIEW user with an active
    grant (the super admin may look, to check what a producer sees). Everything else — another
    event, another organization, a revoked grant, any other role — is the same "not found".
    """
    try:
        ident = event_id if isinstance(event_id, uuid.UUID) else uuid.UUID(str(event_id))
    except (TypeError, ValueError):
        raise ProducerError("event_not_found", 404, "האירוע לא נמצא") from None
    event = db.get(ReportEvent, ident)
    if event is None or event.tenant_id != tenant_id:
        raise ProducerError("event_not_found", 404, "האירוע לא נמצא")
    if user.role == UserRole.SUPER_ADMIN:
        return event
    if not is_producer(user):
        raise ProducerError("event_not_found", 404, "האירוע לא נמצא")
    grant = (
        db.query(ProducerEventGrant.id)
        .filter(
            ProducerEventGrant.user_id == user.id,
            ProducerEventGrant.event_id == event.id,
            ProducerEventGrant.tenant_id == tenant_id,
            ProducerEventGrant.revoked_at.is_(None),
        )
        .first()
    )
    if grant is None:
        raise ProducerError("event_not_found", 404, "האירוע לא נמצא")
    return event


# ── The owner: invite, revoke, settings ──────────────────────────────────────


def _derive_username(db: Session, email: str) -> str:
    from app.routers.users import _derive_username as derive

    return derive(db, email)


def send_clerk_invitation(email: str, redirect_url: str) -> str:
    """Clerk's own invitation e-mail (best effort): "sent" | "not_configured" | "failed"."""
    from app.config import get_settings

    secret = (get_settings().clerk_secret_key or "").strip()
    if not secret:
        return "not_configured"
    try:
        import httpx

        response = httpx.post(
            "https://api.clerk.com/v1/invitations",
            headers={"Authorization": f"Bearer {secret}"},
            json={"email_address": email, "redirect_url": redirect_url, "notify": True, "ignore_existing": True},
            timeout=10,
        )
        return "sent" if response.status_code < 300 else "failed"
    except Exception:  # noqa: BLE001 - the grant stands; the owner shares the link instead
        logger.exception("clerk invitation failed")
        return "failed"


def invite(db: Session, owner: User, event: ReportEvent, *, email: str, name: Optional[str] = None
           ) -> Tuple[ProducerEventGrant, User, bool]:
    """Open the event to a producer by e-mail. Returns (grant, user, user_created). The caller commits."""
    email = (email or "").strip().lower()
    if not _EMAIL.match(email) or len(email) > 255:
        raise ProducerError("email_invalid", 422, "כתובת מייל לא תקינה")
    user = db.query(User).filter(func.lower(User.email) == email).first()
    created = False
    if user is not None and not is_producer(user):
        # A staff account is never turned into (or used as) a producer account.
        raise ProducerError("email_in_use", 409, "הכתובת שייכת למשתמש של המערכת — יש להזמין כתובת אחרת")
    if user is None:
        user = User(
            id=uuid.uuid4(), email=email, username=_derive_username(db, email), role=UserRole.PRODUCER_VIEW,
            tenant_id=event.tenant_id, company_id=None, shop_id=None, is_active=True,
        )
        db.add(user)
        db.flush()
        created = True
    user.is_active = True
    member = (
        db.query(TenantMembership)
        .filter(TenantMembership.user_id == user.id, TenantMembership.tenant_id == event.tenant_id)
        .first()
    )
    if member is None:
        has_default = db.query(TenantMembership.id).filter(TenantMembership.user_id == user.id).first() is not None
        db.add(TenantMembership(id=uuid.uuid4(), tenant_id=event.tenant_id, user_id=user.id,
                                role=TenantMembershipRole.TENANT_MEMBER, is_default=not has_default))
    grant = (
        db.query(ProducerEventGrant)
        .filter(ProducerEventGrant.user_id == user.id, ProducerEventGrant.event_id == event.id)
        .first()
    )
    if grant is None:
        grant = ProducerEventGrant(id=uuid.uuid4(), tenant_id=event.tenant_id, user_id=user.id, event_id=event.id,
                                   created_by_user_id=owner.id)
        db.add(grant)
    grant.revoked_at = None
    grant.revoked_by_user_id = None
    clean_name = " ".join((name or "").split())[:120] or None
    if clean_name:
        grant.display_name = clean_name
    db.flush()
    return grant, user, created


def revoke(db: Session, owner: User, event: ReportEvent, grant_id: Any) -> ProducerEventGrant:
    try:
        ident = grant_id if isinstance(grant_id, uuid.UUID) else uuid.UUID(str(grant_id))
    except (TypeError, ValueError):
        raise ProducerError("grant_not_found", 404) from None
    grant = db.get(ProducerEventGrant, ident)
    if grant is None or grant.event_id != event.id:
        raise ProducerError("grant_not_found", 404)
    if grant.revoked_at is None:
        grant.revoked_at = datetime.now(timezone.utc)
        grant.revoked_by_user_id = owner.id
    db.flush()
    left = (
        db.query(ProducerEventGrant.id)
        .filter(ProducerEventGrant.user_id == grant.user_id, ProducerEventGrant.revoked_at.is_(None))
        .first()
    )
    user = db.get(User, grant.user_id)
    if left is None and user is not None and is_producer(user):
        user.is_active = False  # no event left: the account opens nothing, and signs in to nothing
    db.flush()
    return grant


def grants_json(db: Session, event: ReportEvent) -> List[Dict[str, Any]]:
    rows = (
        db.query(ProducerEventGrant, User)
        .join(User, User.id == ProducerEventGrant.user_id)
        .filter(ProducerEventGrant.event_id == event.id)
        .order_by(ProducerEventGrant.created_at)
        .all()
    )
    return [
        {
            "id": str(g.id),
            "userId": str(u.id),
            "email": u.email,
            "name": g.display_name,
            "signedIn": bool(u.clerk_user_id),
            "active": g.revoked_at is None,
            "createdAt": iso(g.created_at),
            "revokedAt": iso(g.revoked_at),
        }
        for g, u in rows
    ]


def may_see_batches(db: Session, user: Any) -> bool:
    """The batches, their customers and production prices are the prepaid vouchers' section."""
    from app.services import dashboard_access

    return dashboard_access.effective_access(db, user).allows("prepaid_vouchers", "view")


def may_edit_batches(db: Session, user: Any) -> bool:
    from app.services import dashboard_access

    return dashboard_access.effective_access(db, user).allows("prepaid_vouchers", "edit")


def may_see_prices(db: Session, user: Any) -> bool:
    """A batch's own production price: the vouchers core's `prepaid_voucher_prices` section (fails closed)."""
    from app.services.prepaid_voucher_types import prices_visible

    return prices_visible(db, user, "view")


SETTLEMENT_NEEDS_PRICES = "settlement_requires_prices"


def save_settings(db: Session, event: ReportEvent, user: Any, body: Dict[str, Any]) -> Dict[str, Any]:
    """
    The owner's settings (production.clean_settings), and who switched the settlement on.
    Switching it on takes the `prepaid_voucher_prices` section: the settlement shows the producer
    the batches' production prices, and the producer never sees one the owner who opened it
    cannot. Kept on by someone else, it stays theirs; re-saved by a holder of the section when
    nobody is recorded, it becomes theirs. Raises ValueError(code) / ProducerError.
    """
    current = PROD.settings_of(event)
    settings = PROD.clean_settings(event, db, body)
    if not settings["settlementEnabled"]:
        return settings
    sees_prices = may_see_prices(db, user)
    if not current["settlementEnabled"]:
        if not sees_prices:
            raise ProducerError(SETTLEMENT_NEEDS_PRICES, 403, "פתיחת ההתחשבנות למפיק דורשת הרשאה למחירי ההפקה")
        settings["settlementEnabledBy"] = str(user.id)
    elif current["settlementEnabledBy"]:
        settings["settlementEnabledBy"] = current["settlementEnabledBy"]
    elif sees_prices:
        settings["settlementEnabledBy"] = str(user.id)
    return settings


def enabler_sees_prices(db: Session, event: ReportEvent) -> bool:
    """Whether the owner who switched [event]'s settlement on (still) sees production prices; no one recorded: no."""
    by = PROD.settings_of(event)["settlementEnabledBy"]
    if not by:
        return False
    try:
        ident = by if isinstance(by, uuid.UUID) else uuid.UUID(str(by))
    except (TypeError, ValueError):
        return False
    owner = db.get(User, ident)
    if owner is None or not owner.is_active:
        return False
    return may_see_prices(db, owner)


def owner_view(db: Session, event: ReportEvent, user: Any = None) -> Dict[str, Any]:
    """
    The event's "עמדת מפיק" tab: who is invited, the settings, and — for someone with the prepaid
    vouchers' section — the batches that may be linked (valid at the event's shop).
    """
    settings = PROD.settings_of(event)
    can_see = user is None or may_see_batches(db, user)
    if not can_see:
        return {
            "grants": grants_json(db, event),
            "settings": {**settings, "batchIds": [], "productionPrices": {}},
            "batches": [],
            "canSeeBatches": False,
            "canEditBatches": False,
            "canEnableSettlement": user is None or may_see_prices(db, user),
        }
    auto = set(PROD.auto_batch_ids(db, event))
    suggested = set(PROD.suggested_batch_ids(db, event))
    linked = {b.id for b in PROD.event_batches(db, event)}
    # The batch's own production price is the `prepaid_voucher_prices` section's (the vouchers
    # core's rule); a price typed on the event is the event's.
    own_prices = user is None or may_see_prices(db, user)
    batches = []
    for b in PROD.company_batches(db, event):
        price = PROD.production_price(event, b, include_own=own_prices)
        batches.append({
            "id": str(b.id),
            "name": b.name,
            "eventName": b.event_name,
            "customerName": b.customer_name,
            "linked": b.id in linked,
            "auto": b.id in auto,
            "suggested": b.id in suggested and b.id not in linked,
            "productionPrice": money(price) if price is not None else None,
            "createdAt": iso(b.created_at),
        })
    return {
        "grants": grants_json(db, event),
        "settings": settings,
        "batches": batches,
        "canSeeBatches": True,
        "canEditBatches": user is None or may_edit_batches(db, user),
        # Switching the settlement on takes the production prices' section (save_settings).
        "canEnableSettlement": own_prices,
    }


# ── What the producer sees ───────────────────────────────────────────────────


def _shop_name(db: Session, event: ReportEvent) -> Optional[str]:
    shop = db.get(Shop, event.shop_id)
    return shop.name if shop is not None else None


def event_card(db: Session, event: ReportEvent, now: datetime) -> Dict[str, Any]:
    from .report import zone

    tz = zone(event.timezone)
    starts, ends = utc(event.starts_at), utc(event.ends_at)
    return {
        "id": str(event.id),
        "name": event.name,
        "shopName": _shop_name(db, event),
        "producerName": event.producer_name,
        "startsAt": iso(starts),
        "endsAt": iso(ends),
        "startDate": starts.astimezone(tz).date().isoformat(),
        "startTime": starts.astimezone(tz).strftime("%H:%M"),
        "endDate": ends.astimezone(tz).date().isoformat(),
        "endTime": ends.astimezone(tz).strftime("%H:%M"),
        "timezone": event.timezone,
        "phase": LIVE.phase_of(starts, ends, now),
        "settlementEnabled": PROD.settings_of(event)["settlementEnabled"],
    }


def my_events(db: Session, user: User, tenant_id: Any, now: datetime) -> List[Dict[str, Any]]:
    grants = active_grants(db, user.id, tenant_id)
    events = db.query(ReportEvent).filter(ReportEvent.id.in_([g.event_id for g in grants])).all() if grants else []
    events.sort(key=lambda e: utc(e.starts_at), reverse=True)
    return [event_card(db, e, now) for e in events]


def summary(db: Session, event: ReportEvent, now: datetime) -> Dict[str, Any]:
    from .report import zone

    starts, ends = utc(event.starts_at), utc(event.ends_at)
    end = min(now, ends)
    machine_ids = [r.machine_id for r in event.machines or []]
    docs = LIVE.load_live_docs(db, event, machine_ids, starts, end) if now > starts else []
    totals = LIVE.totals_of(docs)
    tz = zone(event.timezone)
    hourly = []
    for point in LIVE.bucket_series(((d.at, d.net) for d in docs), start=starts, end=end if now > starts else starts, minutes=60):
        at = datetime.fromisoformat(point["at"])
        hourly.append({**point, "hour": at.astimezone(tz).strftime("%H:00"), "date": at.astimezone(tz).date().isoformat()})
    every_item = LIVE.item_rows(db, docs, limit=None)
    items = every_item[:ITEMS_MAX]
    return {
        "event": event_card(db, event, now),
        "now": now.isoformat(),
        "totals": {
            "net": money(totals["net"]),
            "sales": totals["sales"],
            "docs": totals["docs"],
            "refunds": totals["refunds"],
            "refundsAmount": money(totals["refundsAmount"]),
            "avgTicket": money(totals["avgTicket"]) if totals["avgTicket"] is not None else None,
            "itemsSold": round(sum(i["quantity"] for i in every_item), 3),
        },
        "hourly": hourly,
        "items": items,
    }


def _redemptions(db: Session, event: ReportEvent, batch_ids: List[Any]):
    """The batches' redemptions on the event's tills, inside its window; a reversed one nowhere."""
    machine_ids = [r.machine_id for r in event.machines or []]
    if not batch_ids or not machine_ids:
        return []
    return (
        db.query(PrepaidVoucherRedemption)
        .filter(
            PrepaidVoucherRedemption.batch_id.in_(batch_ids),
            PrepaidVoucherRedemption.tenant_id == event.tenant_id,
            PrepaidVoucherRedemption.machine_id.in_(machine_ids),
            PrepaidVoucherRedemption.redeemed_at >= utc(event.starts_at),
            PrepaidVoucherRedemption.redeemed_at < utc(event.ends_at),
            PrepaidVoucherRedemption.reversed_at.is_(None),
        )
        .order_by(PrepaidVoucherRedemption.redeemed_at)
        .all()
    )


def vouchers(db: Session, event: ReportEvent, now: datetime) -> Dict[str, Any]:
    from .report import zone

    batches = PROD.event_batches(db, event)
    ids = [b.id for b in batches]
    rows = _redemptions(db, event, ids)
    issued = dict(
        db.query(PrepaidVoucher.batch_id, func.count(PrepaidVoucher.id))
        .filter(PrepaidVoucher.batch_id.in_(ids))
        .group_by(PrepaidVoucher.batch_id)
        .all()
    ) if ids else {}
    per: Dict[Any, Dict[str, Any]] = defaultdict(lambda: {"redemptions": 0, "vouchers": set(), "units": 0.0, "last": None})
    tz = zone(event.timezone)
    by_hour: Dict[str, int] = defaultdict(int)
    for r in rows:
        p = per[r.batch_id]
        p["redemptions"] += 1
        p["vouchers"].add(r.voucher_id)
        p["units"] += LIVE.redemption_units(r.items, r.uses)
        p["last"] = utc(r.redeemed_at)
        by_hour[utc(r.redeemed_at).astimezone(tz).strftime("%Y-%m-%d %H:00")] += 1
    out = []
    for b in batches:
        p = per.get(b.id)
        out.append({
            "batchId": str(b.id),
            "name": b.name,
            "eventName": b.event_name,
            "issued": int(issued.get(b.id, 0)),
            "redeemedVouchers": len(p["vouchers"]) if p else 0,
            "redemptions": p["redemptions"] if p else 0,
            "units": round(p["units"], 3) if p else 0.0,
            "lastRedeemedAt": iso(p["last"]) if p else None,
        })
    return {
        "event": event_card(db, event, now),
        "batches": out,
        "totals": {
            "issued": sum(b["issued"] for b in out),
            "redeemedVouchers": sum(b["redeemedVouchers"] for b in out),
            "redemptions": sum(b["redemptions"] for b in out),
            "units": round(sum(b["units"] for b in out), 3),
        },
        "byHour": [{"hour": k, "redemptions": v} for k, v in sorted(by_hour.items())],
    }


def _local_day(moment: datetime, tz):
    return utc(moment).astimezone(tz).date()


def settlement_groups(db: Session, event: ReportEvent) -> List[Tuple[Any, List[PrepaidVoucherBatch], Dict[str, Any]]]:
    """
    The event's batches (test batches left out), each under the terms it is charged by — read
    through the production vouchers' settlement service (prepaid_voucher_settlement), never
    computed here:

    * an active settlement agreement written for this event (`report_event_id`) — its basis,
      period and policies, for the batches it covers;
    * else the batch's production's `billing_basis` ("redemption" — the default, also with no
      production — or "delivery"), with the agreements' default policies, over the event: by
      redemption, vouchers first redeemed on the event's days; by delivery, vouchers delivered
      (chargeable) up to the event's last day.

    Returns (terms, batches, meta) per group.
    """
    from types import SimpleNamespace

    from app.models.prepaid_voucher import PrepaidProduction
    from app.models.prepaid_voucher_extras import PrepaidSettlementAgreement
    from app.services import prepaid_voucher_settlement as PVS
    from app.services.prepaid_voucher_controls import test_batch_ids

    from .report import zone

    tests = test_batch_ids(db, event.tenant_id)
    batches = [b for b in PROD.event_batches(db, event) if str(b.id) not in tests]
    if not batches:
        return []
    groups: List[Tuple[Any, List[PrepaidVoucherBatch], Dict[str, Any]]] = []
    taken: set = set()
    agreements = (
        db.query(PrepaidSettlementAgreement)
        .filter(
            PrepaidSettlementAgreement.tenant_id == event.tenant_id,
            PrepaidSettlementAgreement.report_event_id == event.id,
            PrepaidSettlementAgreement.status == "active",
        )
        .order_by(PrepaidSettlementAgreement.created_at)
        .all()
    )
    for a in agreements:
        covered = {b.id for b in PVS.agreement_batches(db, a)}
        mine = [b for b in batches if b.id in covered and b.id not in taken]
        if mine:
            taken |= {b.id for b in mine}
            groups.append((a, mine, {"origin": "agreement", "agreementName": a.name}))
    rest = [b for b in batches if b.id not in taken]
    if rest:
        tz = zone(event.timezone)
        first_day = _local_day(event.starts_at, tz)
        last_day = _local_day(utc(event.ends_at) - timedelta(microseconds=1), tz)
        production_ids = {getattr(b, "production_id", None) for b in rest} - {None}
        productions = {
            p.id: p for p in db.query(PrepaidProduction).filter(PrepaidProduction.id.in_(list(production_ids))).all()
        } if production_ids else {}
        by_basis: Dict[str, List[PrepaidVoucherBatch]] = defaultdict(list)
        for b in rest:
            p = productions.get(getattr(b, "production_id", None))
            by_basis[(p.billing_basis if p is not None else None) or "redemption"].append(b)
        for basis in sorted(by_basis):
            terms = SimpleNamespace(
                id=None, tenant_id=event.tenant_id, company_id=event.company_id, billing_basis=basis,
                period_from=first_day if basis == "redemption" else None, period_to=last_day,
                cancelled_policy="exclude", replacement_policy="free",
            )
            groups.append((terms, by_basis[basis], {"origin": "production", "agreementName": None}))
    return groups


def settlement(db: Session, event: ReportEvent, now: datetime) -> Dict[str, Any]:
    """
    At production price, as the production vouchers' settlement charges the production
    (settlement_groups): per batch, the vouchers chargeable under its basis — by redemption or by
    delivery — at the production price. The price: one typed on the event for the batch, else each
    voucher at the price it was issued at, but only while the owner who opened the settlement holds
    `prepaid_voucher_prices` (else none: prices missing).
    """
    from app.services import prepaid_voucher_settlement as PVS

    if not PROD.settings_of(event)["settlementEnabled"]:
        raise ProducerError("settlement_closed", 403, "ההתחשבנות לא נפתחה לצפייה באירוע הזה")
    figures = vouchers(db, event, now)
    counts = {row["batchId"]: row for row in figures["batches"]}
    own = enabler_sees_prices(db, event)
    rows, total, missing, bases = [], ZERO, False, set()
    for terms, batches, meta in settlement_groups(db, event):
        basis = terms.billing_basis or "redemption"
        for f in PVS.batch_figures(db, terms, batches):
            b = f.batch
            typed = PROD.typed_price(event, b)
            if typed is not None:
                price, amount = typed, typed * f.chargeable
            elif own:
                agorot = PVS._sum_prices(f.items)
                one = PVS._one_price(f.items, b.production_price)
                price = (Decimal(one) / 100).quantize(Decimal("0.01")) if one is not None else None
                amount = (Decimal(agorot) / 100).quantize(Decimal("0.01")) if agorot is not None else None
            else:
                price, amount = None, None
            if amount is None and f.chargeable:
                missing = True
            elif amount is None:
                amount = Decimal("0.00")  # nothing chargeable: nothing owed, whatever the price
            if amount is not None:
                total += amount
            bases.add(basis)
            base_row = counts.get(str(b.id), {})
            rows.append({
                "batchId": str(b.id),
                "name": b.name,
                "eventName": b.event_name,
                "issued": base_row.get("issued", f.issued),
                "redeemedVouchers": base_row.get("redeemedVouchers", 0),
                "redemptions": base_row.get("redemptions", 0),
                "units": base_row.get("units", 0.0),
                "lastRedeemedAt": base_row.get("lastRedeemedAt"),
                "basis": basis,
                "origin": meta["origin"],
                "agreementName": meta["agreementName"],
                "chargeable": f.chargeable,
                "delivered": f.delivered,
                "redeemedInPeriod": f.redeemed,
                "cancelledCharged": f.cancelled_charged,
                "replacementsCharged": f.replacements_charged,
                "productionPrice": money(price) if price is not None else None,
                "amount": money(amount) if amount is not None else None,
            })
    basis = next(iter(bases)) if len(bases) == 1 else ("mixed" if bases else "redemption")
    return {
        "event": figures["event"],
        "basis": basis,
        "basisText": PVS.BASIS_TEXT.get(basis),
        "rows": rows,
        "totalAmount": money(total),
        "missingPrices": missing,
        "chargeableVouchers": sum(r["chargeable"] for r in rows),
        "redeemedVouchers": figures["totals"]["redeemedVouchers"],
    }
