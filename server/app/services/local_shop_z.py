"""
The shop Z in local mode — produced on the main till, over the LAN
(docs/SPEC_INDEPENDENT_TILL.md §8).

**Local mode.** A shop whose tills lean on a main till on the LAN — `tablesMode`
«רשת מקומית (קופה ראשית)», or a main till that is the shop's print server — works in local
mode (`local_mode_of_shop`). There the shop Z is the main till's:

* it closes every participating till's shift itself, over the LAN (the till app's
  `LanShopClose`), never through the cloud's remote close;
* every participating till is in the Z — none is left out with "סגור", and a till that
  cannot be reached blocks the Z (the main till says which, with "נסה שוב"); so the
  `shopZOpenTills` rule reads "חובה לסגור את כל הקופות" there (app/services/z_runs.py);
* the main till numbers the Z itself — the shop's next number, from the history it keeps
  (`history`) — prints it, and uploads it (`upload`), at once or when the internet is back.

**The cloud's part is the record.** `upload` takes the Z under the shop's counter lock with
exactly the next number (`claim_shop_z_number`). The figures are built here from the
documents with the same builder as any shop Z; every difference from the main till's paper
is kept and reported (`offline_z_gap`), never silently overwritten.

**A Z number is final** (the owner: "אין דבר כזה זד שממוספר מחדש"). Nothing renumbers a shop
Z, anywhere. Instead the shop's Z sequence has **exactly one producer at any time**
(`effective_producer`): the cloud, or one main till — pinned on the shop (`shopZProducer`)
and moved only when the one holding it has nothing the other could collide with (the cloud:
no Z run under way; a main till: it reported, online, that every shop Z it made is in the
cloud). The configuration may change at any moment (tables, main till, print server); the
production of Zs follows it only once the handover is clean — or a super admin forces it.
So a number that is not the next one cannot reach the cloud. If one still does (a forced
handover, a till restored from an old backup), it is **kept as printed** and recorded as a
conflict for support (`record_conflict`, the `offline_z_conflict` exception, an alert on the
dashboard and on the main till) — never renumbered, never filed into the shop's run with a
gap or a second holder of a number.

Independent tills ("קופה עצמאית", app/services/independent_till.py) are not participants:
not listed, not closed, not in the figures.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.z_report import ZOrigin, ZReport

logger = logging.getLogger(__name__)

#: How far back the main till keeps the shop's Zs (the owner: at least a month).
HISTORY_DAYS = 31

#: Refusals the main till waits out and uploads again; any other 409 is a conflict.
RETRY_DETAILS = ("shift_not_closed", "shift_unknown")
#: A number that is not exactly the shop's next, or one another Z holds — the same codes as a
#: till Z (docs/SPEC_OFFLINE_TILL_Z.md §4.2). Kept as printed and recorded for support.
OUT_OF_SEQUENCE = "offline_z_out_of_sequence"
NUMBER_TAKEN = "offline_z_number_taken"
#: A shop Z from a till that is not the shop's Z producer (after a forced handover).
NOT_PRODUCER = "not_shop_z_producer"
CONFLICT_DETAILS = (OUT_OF_SEQUENCE, NUMBER_TAKEN, NOT_PRODUCER)


# ── The upload body ───────────────────────────────────────────────────────────


class LocalShopZTill(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    machine_id: uuid.UUID = Field(..., alias="machineId")
    #: The till's shifts the Z takes (every closed one no Z named), oldest first.
    shift_ids: List[uuid.UUID] = Field(default_factory=list, alias="shiftIds")
    #: The till's sum of its closes' X (docs/SHIFTS_API.md §3.3 keys), as it sent it.
    till: Optional[Dict[str, Any]] = None
    #: The till's section as the main till printed it.
    report: Optional[Dict[str, Any]] = None
    first_document_number: Optional[str] = Field(None, alias="firstDocumentNumber")
    last_document_number: Optional[str] = Field(None, alias="lastDocumentNumber")


class LocalShopZIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The Z's id — the main till's, kept as the cloud's.
    id: uuid.UUID
    client_request_id: uuid.UUID = Field(..., alias="clientRequestId")
    #: The number on the paper — final: it is never changed, here or on the till.
    shop_sequence_number: int = Field(..., alias="shopSequenceNumber", ge=1)
    closed_at: datetime = Field(..., alias="closedAt")
    business_date: Optional[date] = Field(None, alias="businessDate")
    created_by_name: Optional[str] = Field(None, alias="createdByName", max_length=255)
    created_by_user_id: Optional[str] = Field(None, alias="createdByUserId", max_length=100)
    tills: List[LocalShopZTill] = Field(default_factory=list)
    #: The summary as printed (the shop's totals).
    report: Optional[Dict[str, Any]] = None
    #: The dashboard's request this Z answers (`pendingShopZ`), if it was asked for.
    shop_z_request_id: Optional[str] = Field(None, alias="shopZRequestId", max_length=64)


class LocalShopZRefused(Exception):
    """`keep`: the refusal recorded something worth keeping (a conflict) — commit, not roll back."""

    def __init__(self, status_code: int, body: dict, *, keep: bool = False):
        super().__init__(body.get("detail"))
        self.status_code = status_code
        self.body = body
        self.keep = keep


def _conflict(detail: str, **extra) -> LocalShopZRefused:
    return LocalShopZRefused(status.HTTP_409_CONFLICT, {"detail": detail, **extra})


# ── Local mode and the participants ───────────────────────────────────────────


def local_mode_of_shop(db: Session, shop: Shop) -> bool:
    """
    Does the shop work in local mode: a main till ("קופה ראשית") that the shop leans on over
    the LAN — `tablesMode` «רשת מקומית (קופה ראשית)» for the shop, or the main till being the
    shop's print server? Without a main till there is no local mode: exactly one till serves
    the LAN close, and it is the main till.
    """
    from app.services.main_till import main_till_of_shop
    from app.services.printers import print_host_of_shop
    from app.services.tables import MODE_LAN, TABLES_MODE_KEY, mode_of
    from app.services.till_parameters import resolve_for_shop

    if shop is None:
        return False
    main = main_till_of_shop(db, shop.id)
    if main is None:
        return False
    if mode_of(resolve_for_shop(db, shop).get(TABLES_MODE_KEY)) == MODE_LAN:
        return True
    host = print_host_of_shop(db, shop.id)
    return host is not None and host.id == main.id


def participants(db: Session, shop_id: uuid.UUID) -> List[POSMachine]:
    """The tills the shop Z is for: seated, in `zMode = cloud` (so never an independent one)."""
    from app.services import z_runs as ZR
    from app.services.main_till import till_order

    tills = [m for m in ZR.shop_tills(db, shop_id) if ZR.is_seated_in(m, shop_id)]
    own = ZR.per_till_ids(db, tills)
    return sorted((m for m in tills if m.id not in own), key=till_order)


def _ref(machine: POSMachine) -> dict:
    return {"machineId": str(machine.id), "posNumber": machine.pos_number, "name": machine.name}


def _participant(db: Session, machine: POSMachine) -> dict:
    """A participant of the shop Z, with its support-closed section if it has one."""
    from app.services.support_z import lan_section

    out = _ref(machine)
    section = lan_section(db, machine)
    if section is not None:
        out["supportClosed"] = section
    return out


def _money(value) -> Optional[str]:
    return None if value is None else str(Decimal(value).quantize(Decimal("0.01")))


def _z_row(z: ZReport) -> dict:
    sections = z.per_machine or []
    return {
        "id": str(z.id),
        "shopSequenceNumber": z.shop_sequence_number,
        "businessDate": z.business_date.isoformat() if z.business_date else None,
        "closedAt": z.closed_at.isoformat() if z.closed_at else None,
        "builtOffline": bool(z.built_offline),
        "uploadedAt": z.uploaded_at.isoformat() if z.uploaded_at else None,
        "machineCount": z.machine_count,
        "shiftCount": z.shift_count,
        "transactionsCount": z.transactions_count,
        "totalSales": _money(z.total_sales),
        "totalRefunds": _money(z.total_refunds),
        "netSales": _money(
            None if z.total_sales is None else Decimal(z.total_sales) - Decimal(z.total_refunds or 0)
        ),
        "totalCash": _money(z.total_cash_sales),
        "totalCard": _money(z.total_card_sales),
        "vatTotal": _money(z.vat_total),
        "tills": [s.get("posNumber") for s in sections if isinstance(s, dict)],
    }


def history(db: Session, machine: POSMachine, *, days: int = HISTORY_DAYS, now: Optional[datetime] = None) -> dict:
    """
    What the main till keeps to number and print the shop Z with no internet: the shop's
    last Z number, its Zs of the last `days` days (headers and totals), the participants,
    whether the shop is in local mode — and who produces the shop's Zs right now
    (`producer`), whether this till may number the next one for certain (`numberCertain`),
    a handover still waiting (`handover`), and the conflicts support has not settled.

    Answered to any till of the shop, never 403: a main till that stopped being the main
    must learn so (and stop producing), not keep the last history that said it was.
    """
    from app.services import main_till as MT
    from app.services.independent_till import is_independent
    from app.services.z_sequence import last_shop_z_number

    now = now or datetime.now(timezone.utc)
    shop = db.get(Shop, machine.shop_id)
    producer = effective_producer(db, shop, now=now)
    since = now - timedelta(days=max(1, min(days, 366)))
    zs = (
        db.query(ZReport)
        .filter(
            ZReport.shop_id == shop.id,
            ZReport.shop_sequence_number.isnot(None),
            ZReport.closed_at >= since,
        )
        .order_by(ZReport.shop_sequence_number.desc())
        .all()
    )
    from app.services import z_runs as ZR

    seated = [m for m in ZR.shop_tills(db, shop.id) if ZR.is_seated_in(m, shop.id)]
    return {
        "shopId": str(shop.id),
        "shopName": shop.name,
        # Printed on every shop Z the main till makes (SPEC_INDEPENDENT_TILL §11).
        "branchCode": (getattr(shop, "branch_id", None) or None),
        "localMode": local_mode_of_shop(db, shop),
        "mainTill": MT.till_ref(MT.main_till_of_shop(db, shop.id)),
        "lastShopZNumber": last_shop_z_number(db, shop.id),
        # A till support closed from the cloud carries its section (offline till Z §4.6):
        # the main till takes it as that till's "closed" answer instead of waiting for it.
        "participants": [_participant(db, m) for m in participants(db, shop.id)],
        "independentTills": [_ref(m) for m in sorted(seated, key=MT.till_order) if is_independent(m)],
        "days": days,
        "zs": [_z_row(z) for z in zs],
        **producer.to_json(db),
        # This till numbers the next shop Z for certain only while it is the shop's producer:
        # nobody else can take a number then, so its own records and this one agree.
        "numberCertain": producer.is_local_of(machine.id),
        "conflicts": [_conflict_out(c) for c in unresolved_conflicts(shop)],
        "resolvedConflictIds": [
            c["zId"] for c in _conflicts(shop)
            if c.get("resolvedAt") and str(c.get("machineId")) == str(machine.id)
        ],
        "serverTime": now.isoformat(),
    }


# ── The upload ────────────────────────────────────────────────────────────────

#: The till's §3.3 key and the section's key for the same quantity (as a till Z compares).
COMPARED = (
    ("totalSales", "grossSales"),
    ("totalDiscounts", "discountsTotal"),
    ("totalRefunds", "totalRefunds"),
    ("totalCash", "totalCash"),
    ("totalCard", "totalCard"),
    ("totalExchange", "totalExchange"),
    ("totalTips", "totalTips"),
    ("vatTotal", "vatTotal"),
    ("transactionsCount", "transactionsCount"),
)
_CENT = Decimal("0.01")


def _dec(value) -> Optional[Decimal]:
    if value is None or isinstance(value, bool):
        return None
    try:
        out = Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None
    return out if out.is_finite() else None


def _differs(till_value, cloud_value) -> bool:
    a, b = _dec(till_value), _dec(cloud_value)
    if a is None and b is None:
        return False
    if a is None or b is None:
        return True
    return abs(a - b) > _CENT


def discrepancies(
    *,
    tills: Sequence[LocalShopZTill],
    sections: Sequence[dict],
    cloud_shift_ids: Dict[str, List[str]],
    missing: Sequence[dict],
) -> List[dict]:
    """
    Where the main till's paper differs from what the cloud built (pure): per till its
    shifts, document range and §3.3 figures (keys prefixed with the till, "3:totalCash"),
    and participants with shifts the Z did not take. The number is never one of them: it
    is taken exactly as printed, or the Z is a conflict (`record_conflict`).
    """
    out: List[dict] = []
    by_machine = {str(s.get("machineId")): s for s in sections if isinstance(s, dict)}
    for t in tills:
        mid = str(t.machine_id)
        section = by_machine.get(mid, {})
        tag = section.get("posNumber") or mid[:8]
        till_ids = sorted(str(i) for i in t.shift_ids)
        cloud_ids = sorted(cloud_shift_ids.get(mid, []))
        if till_ids != cloud_ids:
            out.append({"key": f"{tag}:shiftIds", "till": till_ids, "cloud": cloud_ids})
        for key, value in (("firstDocumentNumber", t.first_document_number), ("lastDocumentNumber", t.last_document_number)):
            cloud = section.get(key)
            if value is not None and str(value) != (None if cloud is None else str(cloud)):
                out.append({"key": f"{tag}:{key}", "till": value, "cloud": cloud})
        for till_key, section_key in COMPARED:
            if not t.till or t.till.get(till_key) is None:
                continue
            if _differs(t.till[till_key], section.get(section_key)):
                out.append({"key": f"{tag}:{till_key}", "till": t.till[till_key], "cloud": section.get(section_key)})
    for m in missing:
        out.append({"key": f"{m.get('posNumber') or m.get('machineId')}:missing", "till": None, "cloud": m.get("shifts")})
    return out


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def upload(db: Session, machine: POSMachine, body: LocalShopZIn, *, now: Optional[datetime] = None) -> Tuple[ZReport, str]:
    """
    Take a shop Z the main till produced into the shop's run, in the caller's transaction.
    `(z, "created" | "duplicate")`; raises `LocalShopZRefused` with nothing written — but
    for a number that cannot be filed as printed (not the next one, taken, or from a till
    that is not the shop's producer): then the Z is recorded as a conflict for support,
    exactly as printed, and the refusal says to keep that (`keep`).
    """
    from app.services.shift_totals import compute_totals  # noqa: F401  (built inside build_z)
    from app.services.z_builder import ZBuildRefused, build_z, shift_order_key
    from app.services.z_sequence import (
        ZNumberOutOfSequence,
        claim_shop_z_number,
        ensure_shop_z_sequence,
        last_shop_z_number,
    )
    from app.models.shop_z_sequence import ShopZSequence

    now = now or datetime.now(timezone.utc)
    shop = db.get(Shop, machine.shop_id)
    # The shop's counter row first: two uploads (or an upload and a dashboard Z) take turns.
    ensure_shop_z_sequence(db, shop.id)
    db.query(ShopZSequence).filter(ShopZSequence.shop_id == shop.id).with_for_update().first()

    existing = (
        db.query(ZReport)
        .filter((ZReport.client_request_id == body.client_request_id) | (ZReport.id == body.id))
        .first()
    )
    if existing is not None:
        if str(existing.shop_id) != str(shop.id) or existing.origin != ZOrigin.CLOUD:
            raise _conflict("offline_z_id_conflict", zReportId=str(existing.id))
        complete_request(shop, body.shop_z_request_id, existing)
        _settle_conflict(shop, body.id, "uploaded", now)
        return existing, "duplicate"

    expected = last_shop_z_number(db, shop.id) + 1
    # Only the shop's producer files shop Zs (supposed to be the only one making them).
    producer = effective_producer(db, shop, now=now)
    if not producer.is_local_of(machine.id):
        raise record_conflict(db, shop, machine, body, detail=NOT_PRODUCER, expected=expected, now=now)
    if body.shop_sequence_number != expected:
        holder = (
            db.query(ZReport.id)
            .filter(ZReport.shop_id == shop.id, ZReport.shop_sequence_number == body.shop_sequence_number)
            .first()
        )
        raise record_conflict(
            db, shop, machine, body,
            detail=NUMBER_TAKEN if holder is not None else OUT_OF_SEQUENCE,
            expected=expected,
            taken_by=str(holder[0]) if holder is not None else None,
            now=now,
        )

    from app.services import z_runs as ZR

    tills = {m.id: m for m in ZR.shop_tills(db, shop.id)}
    selections = []
    cloud_ids: Dict[str, List[str]] = {}
    for t in body.tills:
        m = tills.get(t.machine_id)
        if m is None:
            raise _conflict("machine_not_in_shop", machineId=str(t.machine_id))
        if getattr(m, "z_mode", None) == "till":
            raise _conflict("machine_issues_its_own_z", machineId=str(m.id))
        if not t.shift_ids:
            continue
        rows = db.query(Shift).filter(Shift.id.in_(list(t.shift_ids))).all()
        found = {r.id: r for r in rows}
        for sid in t.shift_ids:
            shift = found.get(sid)
            if shift is None or str(shift.machine_id) != str(m.id):
                raise _conflict("shift_unknown", shiftId=str(sid), machineId=str(m.id))
            if shift.status != ShiftStatus.CLOSED or shift.close_accepted_at is None:
                raise _conflict("shift_not_closed", shiftId=str(sid), machineId=str(m.id))
            if shift.z_report_id is not None:
                raise _conflict("offline_z_shift_in_another_z", shiftId=str(sid), zReportId=str(shift.z_report_id))
        through = max(rows, key=shift_order_key)
        selections.append((m, through.id))
    if not selections:
        raise _conflict("nothing_to_report")

    closed_at = _aware(body.closed_at)
    try:
        claim_shop_z_number(db, shop.id, body.shop_sequence_number)
    except ZNumberOutOfSequence:  # pragma: no cover - checked above under the same lock
        raise _conflict(OUT_OF_SEQUENCE, zNumber=body.shop_sequence_number, expectedNumber=expected)
    try:
        z = build_z(
            db,
            tenant_id=machine.tenant_id,
            shop_id=shop.id,
            selections=selections,
            created_by_name=body.created_by_name,
            created_by_pos_user_id=body.created_by_user_id,
            client_request_id=body.client_request_id,
            origin=ZOrigin.CLOUD,
            now=closed_at,
            z_id=body.id,
            shop_sequence_number=body.shop_sequence_number,
            allow_empty=True,
        )
    except ZBuildRefused as refused:
        logger.warning("local shop Z %s of shop %s refused: %s", body.id, shop.id, refused.code)
        raise _conflict(refused.code)

    for section in z.per_machine or []:
        cloud_ids[str(section.get("machineId"))] = [str(i) for i in section.get("shiftIds") or []]
    # A participant with closed shifts the Z did not take — closed before it — would have
    # its sales slip into the next Z. The main till never lets that happen; if it did, say so.
    taken = {m.id for m, _t in selections}
    missing = []
    for p in participants(db, shop.id):
        if p.id in taken:
            continue
        left = [
            s for s in db.query(Shift).filter(
                Shift.machine_id == p.id, Shift.shop_id == shop.id, Shift.z_report_id.is_(None),
                Shift.status == ShiftStatus.CLOSED,
            ).all()
            if s.closed_at is None or _aware(s.closed_at) <= closed_at
        ]
        if left:
            missing.append({"machineId": str(p.id), "posNumber": p.pos_number, "shifts": len(left)})

    z.built_offline = True
    z.uploaded_at = now
    z.offline_report = {
        "kind": "local_shop_z",
        "shopSequenceNumber": body.shop_sequence_number,
        "closedAt": closed_at.isoformat(),
        "businessDate": body.business_date.isoformat() if body.business_date else None,
        "producedBy": _ref(machine),
        "tills": [t.model_dump(mode="json", by_alias=True) for t in body.tills],
        "report": body.report,
    }
    found = discrepancies(
        tills=body.tills,
        sections=z.per_machine or [],
        cloud_shift_ids=cloud_ids,
        missing=missing,
    )
    z.offline_discrepancies = found or None
    # A dashboard's request is answered by the main till's Z (named, or the one pending).
    complete_request(shop, body.shop_z_request_id, z)
    # A conflict it once was (support made room for it): settled by the Z itself.
    _settle_conflict(shop, body.id, "uploaded", now)
    if found:
        logger.warning("local shop Z %s (#%s) differs from the cloud: %s", z.id, z.shop_sequence_number, found)
        _record_safely(
            db, machine,
            exception_type="offline_z_gap",
            key=f"offline_z_gap:{z.id}",
            occurred_at=closed_at,
            details={
                "zReportId": str(z.id),
                "zNumber": z.shop_sequence_number,
                "shopZ": True,
                "closedAt": closed_at.isoformat(),
                "uploadedAt": now.isoformat(),
                "discrepancies": found,
                "summary": f"Z סניפי מס׳ {z.shop_sequence_number}: " + ", ".join(
                    f"{d['key']} — קופה ראשית {d['till']} / ענן {d['cloud']}" for d in found[:4]
                ),
            },
            pos_user_id=body.created_by_user_id,
        )
    db.flush()
    return z, "created"


def _record_safely(db: Session, machine: POSMachine, **kwargs) -> None:
    """An exception about the Z; a failure to record it never refuses the Z."""
    from app.services.exceptions import record_z_exception

    try:
        record_z_exception(db, machine, **kwargs)
    except Exception:  # noqa: BLE001 - the Z is what matters; the log keeps the rest
        logger.exception("could not record %s for machine %s", kwargs.get("exception_type"), machine.id)


def upload_out(z: ZReport, outcome: str) -> dict:
    return {
        "status": outcome,
        "zReportId": str(z.id),
        "shopSequenceNumber": z.shop_sequence_number,
        "businessDate": z.business_date.isoformat() if z.business_date else None,
        "discrepancies": z.offline_discrepancies or [],
        "shiftIds": {str(s.get("machineId")): s.get("shiftIds") or [] for s in (z.per_machine or []) if isinstance(s, dict)},
    }


# ── The dashboard asks the main till (local mode) ─────────────────────────────
#
# In local mode the dashboard never starts the shop Z itself (main_till.dashboard_z_refusal):
# the main till numbers the shop's Zs on the LAN, and a Z started in the cloud while it is
# offline would take a number it may be printing. The dashboard asks the main till instead.
# One request per shop at a time, kept on the shop (`shops.settings`), handed to the main
# till on its heartbeat (`pendingShopZ`); the main till runs the LAN close unattended and
# produces the Z, and the request completes when that Z comes up (`shopZRequestId`).

REQUEST_KEY = "localShopZRequest"
REQUEST_TTL_HOURS = 36
REQUEST_PENDING = ("waiting", "in_progress", "failed")


def _request_of(shop: Shop, now: datetime) -> Optional[dict]:
    req = (shop.settings or {}).get(REQUEST_KEY)
    if not isinstance(req, dict):
        return None
    if req.get("status") in REQUEST_PENDING:
        expires = req.get("expiresAt")
        try:
            if expires and datetime.fromisoformat(expires) < now:
                req = {**req, "status": "expired"}
                _put_request(shop, req)
        except ValueError:
            pass
    return req


def _put_request(shop: Shop, req: Optional[dict]) -> None:
    settings = dict(shop.settings or {})
    if req is None:
        settings.pop(REQUEST_KEY, None)
    else:
        settings[REQUEST_KEY] = req
    shop.settings = settings  # reassigned: a JSONB column sees only a new value


def request_state(db: Session, shop: Shop, *, now: Optional[datetime] = None) -> dict:
    from app.services import main_till as MT

    now = now or datetime.now(timezone.utc)
    producer = effective_producer(db, shop, now=now)
    return {
        "request": _request_of(shop, now),
        "localMode": producer.configured_kind == LOCAL or producer.kind == LOCAL,
        "mainTill": MT.till_ref(MT.main_till_of_shop(db, shop.id)),
        **producer.to_json(db),
        "conflicts": [_conflict_out(c) for c in unresolved_conflicts(shop)],
    }


def request_from_dashboard(db: Session, user, shop: Shop, *, now: Optional[datetime] = None) -> dict:
    """Ask the shop's main till for the shop Z; the pending one again if there is one."""
    from app.services import main_till as MT

    now = now or datetime.now(timezone.utc)
    producer = effective_producer(db, shop, now=now)
    if producer.kind != LOCAL and producer.configured_kind != LOCAL:
        raise LocalShopZRefused(status.HTTP_409_CONFLICT, {
            "detail": "not_local_mode",
            "message": "הסניף לא עובד ברשת מקומית — את ה-Z הסניפי מפיקים באשף ה-Z.",
        })
    held = _request_of(shop, now)
    if held is not None and held.get("status") in ("waiting", "in_progress"):
        return held
    main = MT.main_till_of_shop(db, shop.id)
    req = {
        "id": str(uuid.uuid4()),
        "status": "waiting",
        "mainTill": MT.till_ref(main),
        "createdAt": now.isoformat(),
        "expiresAt": (now + timedelta(hours=REQUEST_TTL_HOURS)).isoformat(),
        "createdBy": getattr(user, "username", None) or getattr(user, "email", None) or str(getattr(user, "id", "")),
        "createdByUserId": str(getattr(user, "id", "")) or None,
        "sentAt": None,
        "message": None,
        "zReportId": None,
        "shopSequenceNumber": None,
    }
    _put_request(shop, req)
    db.flush()
    return req


def cancel_request(db: Session, shop: Shop) -> Optional[dict]:
    req = _request_of(shop, datetime.now(timezone.utc))
    if req is None or req.get("status") not in REQUEST_PENDING:
        raise LocalShopZRefused(status.HTTP_409_CONFLICT, {"detail": "request_not_pending"})
    req = {**req, "status": "cancelled"}
    _put_request(shop, req)
    db.flush()
    return req


def take_pending_for_main(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> Optional[dict]:
    """`pendingShopZ` for the heartbeat: the shop's request, to its main till only."""
    if machine.shop_id is None:
        return None
    shop = db.get(Shop, machine.shop_id)
    if shop is None or not isinstance((shop.settings or {}).get(REQUEST_KEY), dict):
        return None  # the common case, answered without resolving anything
    now = now or datetime.now(timezone.utc)
    req = _request_of(shop, now)
    if req is None or req.get("status") not in REQUEST_PENDING:
        return None
    # To the shop's producer only (it decides, and says why when it cannot).
    if not effective_producer(db, shop, now=now).is_local_of(machine.id):
        return None
    if not req.get("sentAt"):
        _put_request(shop, {**req, "sentAt": now.isoformat()})
    return {"requestId": req["id"], "initiatedBy": req.get("createdBy"), "createdAt": req.get("createdAt")}


def ack_request(db: Session, machine: POSMachine, request_id: str, phase: str, message: Optional[str]) -> dict:
    """The main till's word on the request: `received`, or `failed` (a till blocks the Z — said why)."""
    shop = db.get(Shop, machine.shop_id) if machine.shop_id else None
    req = _request_of(shop, datetime.now(timezone.utc)) if shop is not None else None
    if req is None or req.get("id") != str(request_id):
        raise LocalShopZRefused(status.HTTP_404_NOT_FOUND, {"detail": "request_not_found"})
    if req.get("status") not in REQUEST_PENDING:
        return req
    if phase == "received":
        req = {**req, "status": "in_progress", "message": None}
    elif phase == "failed":
        req = {**req, "status": "failed", "message": (message or "")[:500] or None}
    _put_request(shop, req)
    db.flush()
    return req


def complete_request(shop: Shop, request_id: Optional[str], z: ZReport) -> None:
    """The main till's Z answered the request (named, or the one pending when it came up)."""
    req = _request_of(shop, datetime.now(timezone.utc))
    if req is None or req.get("status") not in REQUEST_PENDING:
        return
    if request_id is not None and req.get("id") != str(request_id):
        return
    _put_request(shop, {
        **req, "status": "completed", "message": None,
        "zReportId": str(z.id), "shopSequenceNumber": z.shop_sequence_number,
        "completedAt": datetime.now(timezone.utc).isoformat(),
    })


# ── Exactly one producer of the shop's Z sequence ─────────────────────────────
#
# The owner: a Z number, once produced and printed, is final — nothing renumbers it. So two
# producers must never hold the shop's sequence at once. The producer is pinned on the shop
# (`shops.settings.shopZProducer`: `{kind: cloud|local, machineId, since}`) and follows the
# configuration (`configured_producer`) only over a clean handover (`producer_busy`):
#
# * the cloud hands over when no Z run of the shop is under way;
# * a main till hands over when it reported — on its heartbeat (`localShopZ`), while online —
#   that every shop Z it made is in the cloud. Offline, nobody can know: it keeps the pin.
#
# Until then the configured producer may not number (the history says `numberCertain:
# false`, with the reason), the cloud refuses Z runs, and the explicit switches (the main-till
# card, the shop's card, the till parameters, the print server) refuse with the reason — a
# super admin may force it, recorded as a `shop_z_producer_forced` exception.

PRODUCER_KEY = "shopZProducer"
REPORTS_KEY = "localShopZReports"
CONFLICTS_KEY = "localShopZConflicts"
LOCAL = "local"
CLOUD = "cloud"
BUSY = "shop_z_producer_busy"
#: The till parameters that decide the producer (local mode and the main till).
PRODUCER_KEYS = ("tablesMode", "mainTill", "tablesHostTill", "printHostTill")
#: A shop Z the cloud cannot file as printed: the same exception as a till Z's
#: (docs/SPEC_OFFLINE_TILL_Z.md §4.5) — one support flow, "פנו לתמיכה".
CONFLICT_EXCEPTION = "offline_z_conflict"
#: The shop's Z production moved by force.
FORCED_EXCEPTION = "shop_z_producer_forced"
CONFLICTS_KEPT = 100


def _put(shop: Shop, key: str, value: Any) -> None:
    settings = dict(shop.settings or {})
    if value is None:
        settings.pop(key, None)
    else:
        settings[key] = value
    shop.settings = settings  # reassigned: a JSONB column sees only a new value


def _till_label(machine: Optional[POSMachine]) -> str:
    if machine is None:
        return "הקופה הראשית הקודמת"
    number = (machine.pos_number or "").strip()
    return f"קופה {number}" if number else (machine.name or "הקופה הראשית")


def configured_producer(db: Session, shop: Shop) -> Dict[str, Optional[str]]:
    """Who the configuration says produces the shop's Zs: the main till in local mode, else the cloud."""
    from app.services.main_till import main_till_of_shop

    if local_mode_of_shop(db, shop):
        main = main_till_of_shop(db, shop.id)
        return {"kind": LOCAL, "machineId": str(main.id)}
    return {"kind": CLOUD, "machineId": None}


def _pin(shop: Shop) -> Optional[Dict[str, Any]]:
    pin = (shop.settings or {}).get(PRODUCER_KEY)
    return pin if isinstance(pin, dict) and pin.get("kind") in (LOCAL, CLOUD) else None


def _same(a: Optional[dict], b: Optional[dict]) -> bool:
    return a is not None and b is not None and a.get("kind") == b.get("kind") and (
        (a.get("machineId") or None) == (b.get("machineId") or None)
    )


def ensure_pin(db: Session, shop: Shop, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """The pinned producer; the configured one, pinned now, when none was pinned yet."""
    pin = _pin(shop)
    if pin is None:
        now = now or datetime.now(timezone.utc)
        pin = {**configured_producer(db, shop), "since": now.isoformat()}
        _put(shop, PRODUCER_KEY, pin)
    return pin


def _reports(shop: Shop) -> Dict[str, dict]:
    reports = (shop.settings or {}).get(REPORTS_KEY)
    return reports if isinstance(reports, dict) else {}


def producer_busy(db: Session, shop: Shop, pin: dict, *, now: Optional[datetime] = None) -> Optional[dict]:
    """
    Why the pinned producer cannot hand the sequence over now — `{reason, message}` — or
    None when it can (nothing of it could collide with the next producer's numbers).
    """
    from app.models.z_run import ZRun, ZRunStatus
    from app.services.machine_status import is_online
    from app.services.z_sequence import last_shop_z_number

    now = now or datetime.now(timezone.utc)
    if pin.get("kind") == CLOUD:
        live = (
            db.query(ZRun.id)
            .filter(ZRun.shop_id == shop.id, ZRun.status.in_([ZRunStatus.WAITING, ZRunStatus.BUILDING]))
            .first()
        )
        if live is not None:
            return {
                "reason": "cloud_run_live",
                "message": "יש Z סניפי בתהליך בענן — המתינו לסיומו (או בטלו אותו), ואז נסו שוב.",
            }
        return None
    machine_id = pin.get("machineId")
    machine = None
    try:
        machine = db.get(POSMachine, uuid.UUID(str(machine_id))) if machine_id else None
    except ValueError:
        machine = None
    label = _till_label(machine)
    report = _reports(shop).get(str(machine_id))
    if report is None:
        # Never reported a shop Z of its own (an app that cannot make one, or never did).
        return None
    pending = int(report.get("pending") or 0)
    if pending > 0 or report.get("conflict"):
        return {
            "reason": "unsynced_shop_zs",
            "pending": pending,
            "message": (
                f"ב{label} (מפיקת ה-Z הסניפי) יש {pending} דוחות Z סניפיים שעוד לא סונכרנו לענן. "
                "הם חייבים לעלות לענן לפני שמעבירים את הפקת ה-Z לקופה אחרת או לענן."
            ),
        }
    if machine is None or not is_online(machine.last_heartbeat_at, now=now):
        return {
            "reason": "producer_offline",
            "message": (
                f"{label} (מפיקת ה-Z הסניפי) לא מחוברת לענן, ולכן לא ידוע אם יש בה Z סניפי שעוד "
                "לא סונכרן. חברו אותה לענן ונסו שוב."
            ),
        }
    last = report.get("lastNumber")
    try:
        if last is not None and int(last) > last_shop_z_number(db, shop.id):
            return {
                "reason": "unsynced_shop_zs",
                "pending": 1,
                "message": f"Z סניפי מס׳ {int(last)} של {label} עוד לא בענן — המתינו שיעלה ונסו שוב.",
            }
    except (TypeError, ValueError):
        pass
    return None


@dataclass
class Producer:
    """The shop's Z producer now, and a handover the configuration asks for that waits."""

    kind: str
    machine_id: Optional[str]
    since: Optional[str]
    configured_kind: str
    configured_machine_id: Optional[str]
    handover: Optional[dict] = None

    def is_local_of(self, machine_id: Any) -> bool:
        return self.kind == LOCAL and self.machine_id is not None and str(machine_id) == str(self.machine_id)

    def to_json(self, db: Session) -> dict:
        def ref(mid):
            if not mid:
                return None
            try:
                m = db.get(POSMachine, uuid.UUID(str(mid)))
            except ValueError:
                m = None
            return _ref(m) if m is not None else {"machineId": str(mid), "posNumber": None, "name": None}

        return {
            "producer": {"kind": self.kind, "machine": ref(self.machine_id), "since": self.since},
            "handover": None if self.handover is None else {
                **self.handover,
                "to": {"kind": self.configured_kind, "machine": ref(self.configured_machine_id)},
            },
        }


def _move_pin(shop: Shop, pin: dict, to: dict, now: datetime, *, forced_by: Optional[str] = None) -> dict:
    moved = {
        **to,
        "since": now.isoformat(),
        "from": {"kind": pin.get("kind"), "machineId": pin.get("machineId")},
    }
    if forced_by:
        moved["forcedBy"] = forced_by
    _put(shop, PRODUCER_KEY, moved)
    logger.info("shop %s: shop Z producer %s -> %s%s", shop.id, pin, to, f" (forced by {forced_by})" if forced_by else "")
    return moved


def effective_producer(db: Session, shop: Shop, *, now: Optional[datetime] = None) -> Producer:
    """
    Who produces the shop's Zs now: the pinned producer — moved to the configured one here
    when the handover is clean. The caller commits (the pin may have been written).
    """
    now = now or datetime.now(timezone.utc)
    configured = configured_producer(db, shop)
    pin = ensure_pin(db, shop, now=now)
    handover = None
    if not _same(pin, configured):
        busy = producer_busy(db, shop, pin, now=now)
        if busy is None:
            pin = _move_pin(shop, pin, configured, now)
        else:
            handover = busy
    return Producer(
        kind=pin["kind"],
        machine_id=pin.get("machineId"),
        since=pin.get("since"),
        configured_kind=configured["kind"],
        configured_machine_id=configured.get("machineId"),
        handover=handover,
    )


def shops_for_scope(db: Session, scope_type: str, scope_id: Any) -> List[Shop]:
    """The shops a till parameter value at this level speaks for."""
    from app.models.shop_area import ShopArea

    try:
        ident = scope_id if isinstance(scope_id, uuid.UUID) else uuid.UUID(str(scope_id))
    except ValueError:
        return []
    if scope_type == "shop":
        shop = db.get(Shop, ident)
        return [shop] if shop is not None else []
    if scope_type == "machine":
        machine = db.get(POSMachine, ident)
        shop = db.get(Shop, machine.shop_id) if machine is not None and machine.shop_id else None
        return [shop] if shop is not None else []
    if scope_type == "area":
        area = db.get(ShopArea, ident)
        shop = db.get(Shop, area.shop_id) if area is not None else None
        return [shop] if shop is not None else []
    if scope_type == "company":
        return db.query(Shop).filter(Shop.company_id == ident).all()
    return []


class ProducerGuard:
    """
    Around a change that may move a shop's Z producer (local mode, the main till):
    construct it before the change (the producers are pinned as they stand), call `check`
    after it (flushed, not committed). A move the pinned producer cannot hand over cleanly
    is refused (`409 shop_z_producer_busy`, Hebrew `message`) — the caller rolls back —
    unless a super admin forces it, which is recorded.
    """

    def __init__(self, db: Session, shops: Iterable[Optional[Shop]], *, now: Optional[datetime] = None):
        self.db = db
        self.now = now or datetime.now(timezone.utc)
        self.shops = []
        seen = set()
        for shop in shops:
            if shop is None or shop.id in seen:
                continue
            seen.add(shop.id)
            ensure_pin(db, shop, now=self.now)
            self.shops.append(shop)

    def check(self, *, force: bool = False, user=None) -> None:
        from app.models.user import UserRole

        self.db.flush()
        for shop in self.shops:
            pin = _pin(shop) or ensure_pin(self.db, shop, now=self.now)
            configured = configured_producer(self.db, shop)
            if _same(pin, configured):
                continue
            busy = producer_busy(self.db, shop, pin, now=self.now)
            if busy is None:
                _move_pin(shop, pin, configured, self.now)
                continue
            super_admin = user is not None and getattr(user, "role", None) == UserRole.SUPER_ADMIN
            if force and super_admin:
                who = getattr(user, "username", None) or getattr(user, "email", None) or str(getattr(user, "id", ""))
                _move_pin(shop, pin, configured, self.now, forced_by=who)
                _record_forced(self.db, shop, pin, configured, busy, who, self.now)
                continue
            raise LocalShopZRefused(status.HTTP_409_CONFLICT, {
                "detail": BUSY,
                "reason": busy.get("reason"),
                "message": "לא ניתן להעביר עכשיו את הפקת ה-Z הסניפי: " + busy["message"],
                "shopId": str(shop.id),
                "canForce": super_admin,
            })


def handover_now(db: Session, user, shop: Shop, *, now: Optional[datetime] = None) -> Producer:
    """
    "העבר את הפקת ה-Z עכשיו" — a super admin moves the pin to the configured producer at
    once, even though the one holding it may still have shop Zs the cloud does not (a main
    till that died). Recorded; any such Z that turns up later is a conflict for support.
    """
    guard = ProducerGuard(db, [shop], now=now)
    guard.check(force=True, user=user)
    return effective_producer(db, shop, now=now)


def _record_forced(db: Session, shop: Shop, pin: dict, to: dict, busy: dict, who: str, now: datetime) -> None:
    machine = None
    for mid in (pin.get("machineId"), to.get("machineId")):
        if mid:
            machine = db.get(POSMachine, uuid.UUID(str(mid)))
            if machine is not None:
                break
    if machine is None:
        machine = next(iter(participants(db, shop.id)), None)
    if machine is None:
        return
    _record_safely(
        db, machine,
        exception_type=FORCED_EXCEPTION,
        key=f"shop_z_producer_forced:{shop.id}:{now.isoformat()}",
        occurred_at=now,
        details={
            "kind": "forced_handover",
            "shopId": str(shop.id),
            "from": pin,
            "to": to,
            "reason": busy.get("reason"),
            "forcedBy": who,
            "summary": f"הפקת ה-Z הסניפי הועברה בכפייה ע״י {who}: {busy.get('message')}",
        },
    )


def note_heartbeat(db: Session, machine: POSMachine, block: Any, *, now: Optional[datetime] = None) -> None:
    """
    A till's `localShopZ` on its heartbeat: the shop Zs it made that the cloud does not have
    yet (`pending`, `conflict`) and the last number it made. Kept per till on the shop; a
    change may complete a handover waiting for it.
    """
    if block is None or machine.shop_id is None:
        return
    now = now or datetime.now(timezone.utc)
    shop = db.get(Shop, machine.shop_id)
    if shop is None:
        return
    new = {
        "pending": int(getattr(block, "pending", None) or 0),
        "conflict": bool(getattr(block, "conflict", None) or False),
        "lastNumber": getattr(block, "last_number", None),
    }
    reports = dict(_reports(shop))
    old = reports.get(str(machine.id))
    changed = old is None or any(old.get(k) != v for k, v in new.items())
    if changed:
        reports[str(machine.id)] = {**new, "at": now.isoformat()}
        _put(shop, REPORTS_KEY, reports)
    if changed or _pin(shop) is None:
        effective_producer(db, shop, now=now)


def producer_state(db: Session, shop: Shop, *, now: Optional[datetime] = None) -> dict:
    """For the dashboard: the producer, a handover waiting, and the conflicts for support."""
    producer = effective_producer(db, shop, now=now)
    return {**producer.to_json(db), "conflicts": [_conflict_out(c) for c in unresolved_conflicts(shop)]}


# ── A number that cannot be filed as printed: a conflict for support ──────────


def _conflicts(shop: Shop) -> List[dict]:
    rows = (shop.settings or {}).get(CONFLICTS_KEY)
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def unresolved_conflicts(shop: Shop) -> List[dict]:
    return [c for c in _conflicts(shop) if not c.get("resolvedAt")]


def _conflict_out(c: dict) -> dict:
    """A conflict as the screens show it — without the Z's full body."""
    return {k: v for k, v in c.items() if k != "z"}


def conflict_message(detail: str, number: Any, expected: Any) -> str:
    if detail == NUMBER_TAKEN:
        return (
            f"Z סניפי מס׳ {number} הודפס בקופה הראשית, אבל מספר זה כבר שייך ל-Z אחר בענן. "
            "ה-Z נשמר בדיוק כפי שהודפס, בלי מספור מחדש — לטיפול התמיכה."
        )
    if detail == NOT_PRODUCER:
        return (
            f"Z סניפי מס׳ {number} הגיע מקופה שאינה מפיקת ה-Z של הסניף בענן (הפקת ה-Z הועברה). "
            "ה-Z נשמר בדיוק כפי שהודפס, בלי מספור מחדש — לטיפול התמיכה."
        )
    return (
        f"Z סניפי מס׳ {number} הודפס בקופה הראשית, אבל הענן מצפה ל-Z מס׳ {expected}. "
        "ה-Z נשמר בדיוק כפי שהודפס, בלי מספור מחדש — לטיפול התמיכה."
    )


def record_conflict(
    db: Session,
    shop: Shop,
    machine: POSMachine,
    body: LocalShopZIn,
    *,
    detail: str,
    expected: int,
    taken_by: Optional[str] = None,
    now: Optional[datetime] = None,
) -> LocalShopZRefused:
    """
    Keep a shop Z the cloud cannot file as printed — its number, its id, all of it — for
    support, alert (dashboard, main till, the `offline_z_conflict` exception), and return the
    refusal (409, `keep`). Nothing is renumbered and nothing enters the shop's run.
    """
    now = now or datetime.now(timezone.utc)
    rows = _conflicts(shop)
    held = next((c for c in rows if c.get("zId") == str(body.id)), None)
    message = conflict_message(detail, body.shop_sequence_number, expected)
    entry = {
        "zId": str(body.id),
        "number": body.shop_sequence_number,
        "expectedNumber": expected,
        "detail": detail,
        "takenByZReportId": taken_by,
        "machineId": str(machine.id),
        "posNumber": machine.pos_number,
        "closedAt": _aware(body.closed_at).isoformat(),
        "firstAt": (held or {}).get("firstAt") or now.isoformat(),
        "lastAt": now.isoformat(),
        "attempts": int((held or {}).get("attempts") or 0) + 1,
        "resolvedAt": None,
        "message": message,
        # The Z exactly as the main till printed it, for support.
        "z": body.model_dump(mode="json", by_alias=True),
    }
    rows = [c for c in rows if c.get("zId") != str(body.id)] + [entry]
    # The newest kept; never one support has not settled.
    while len(rows) > CONFLICTS_KEPT:
        drop = next((i for i, c in enumerate(rows) if c.get("resolvedAt")), None)
        if drop is None:
            break
        rows.pop(drop)
    _put(shop, CONFLICTS_KEY, rows)
    logger.error(
        "shop %s: shop Z %s (#%s) from %s cannot be filed as printed: %s (expected #%s, taken by %s)",
        shop.id, body.id, body.shop_sequence_number, machine.id, detail, expected, taken_by,
    )
    _record_safely(
        db, machine,
        exception_type=CONFLICT_EXCEPTION,
        key=f"offline_z_conflict:{body.id}",
        occurred_at=_aware(body.closed_at),
        details={
            "kind": "conflict",
            "shopZ": True,
            "shopId": str(shop.id),
            "zId": str(body.id),
            "zNumber": body.shop_sequence_number,
            "expectedNumber": expected,
            "detail": detail,
            "takenByZReportId": taken_by,
            "summary": message,
        },
        pos_user_id=body.created_by_user_id,
    )
    db.flush()
    return LocalShopZRefused(
        status.HTTP_409_CONFLICT,
        {
            "detail": detail,
            "zNumber": body.shop_sequence_number,
            "expectedNumber": expected,
            "takenByZReportId": taken_by,
            "conflictRecorded": True,
            "message": message,
        },
        keep=True,
    )


def _settle_conflict(shop: Shop, z_id: Any, how: str, now: datetime, *, by: Optional[str] = None, note: Optional[str] = None) -> Optional[dict]:
    # New dicts, not the stored ones changed in place: a JSONB column sees only a new value.
    rows = [dict(c) for c in _conflicts(shop)]
    found = None
    for c in rows:
        if c.get("zId") == str(z_id) and not c.get("resolvedAt"):
            c["resolvedAt"] = now.isoformat()
            c["resolvedHow"] = how
            c["resolvedBy"] = by
            c["resolvedNote"] = note
            found = c
    if found is not None:
        _put(shop, CONFLICTS_KEY, rows)
    return found


def resolve_conflict(db: Session, user, shop: Shop, z_id: Any, *, note: Optional[str] = None,
                     now: Optional[datetime] = None) -> dict:
    """
    Support settled a conflict (the super admin's): it stops blocking the main till, which
    keeps the Z as printed (not sent again) — the number is never changed by this either.
    """
    now = now or datetime.now(timezone.utc)
    who = getattr(user, "username", None) or getattr(user, "email", None) or str(getattr(user, "id", ""))
    found = _settle_conflict(shop, z_id, "support", now, by=who, note=(note or "")[:500] or None)
    if found is None:
        raise LocalShopZRefused(status.HTTP_404_NOT_FOUND, {"detail": "conflict_not_found"})
    db.flush()
    return _conflict_out(found)
