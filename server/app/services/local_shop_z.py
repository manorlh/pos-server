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
exactly the next number (`claim_shop_z_number`, the same contract as a till Z closed with no
connection, docs/SPEC_OFFLINE_TILL_Z.md §4): a jump or a used number is refused with the
expected one (`409 shop_z_number_out_of_sequence`), and the main till renumbers its
still-pending Z — the shop's run never has a gap. The figures are built here from the
documents with the same builder as any shop Z; every difference from the main till's paper
is kept and reported (`offline_z_gap`), never silently overwritten.

Independent tills ("קופה עצמאית", app/services/independent_till.py) are not participants:
not listed, not closed, not in the figures.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Sequence, Tuple

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
#: The offline till Z's own refusals (docs/SPEC_OFFLINE_TILL_Z.md §4.2), for the shop's run.
OUT_OF_SEQUENCE = "offline_z_out_of_sequence"
NUMBER_TAKEN = "offline_z_number_taken"


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
    shop_sequence_number: int = Field(..., alias="shopSequenceNumber", ge=1)
    #: The number on the paper, when the Z was renumbered after it printed.
    printed_number: Optional[int] = Field(None, alias="printedNumber", ge=1)
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
    def __init__(self, status_code: int, body: dict):
        super().__init__(body.get("detail"))
        self.status_code = status_code
        self.body = body


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
    and whether the shop is in local mode. 403 for a till that may not run the shop Z.
    """
    from app.services import main_till as MT
    from app.services.independent_till import is_independent
    from app.services.z_sequence import last_shop_z_number

    refusal = MT.till_shop_z_refusal(db, machine)
    if refusal is not None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=refusal)
    now = now or datetime.now(timezone.utc)
    shop = db.get(Shop, machine.shop_id)
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
        "localMode": local_mode_of_shop(db, shop),
        "mainTill": MT.till_ref(MT.main_till_of_shop(db, shop.id)),
        "lastShopZNumber": last_shop_z_number(db, shop.id),
        "participants": [_ref(m) for m in participants(db, shop.id)],
        "independentTills": [_ref(m) for m in sorted(seated, key=MT.till_order) if is_independent(m)],
        "days": days,
        "zs": [_z_row(z) for z in zs],
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
    number: int,
    printed_number: Optional[int],
    tills: Sequence[LocalShopZTill],
    sections: Sequence[dict],
    cloud_shift_ids: Dict[str, List[str]],
    missing: Sequence[dict],
) -> List[dict]:
    """
    Where the main till's paper differs from what the cloud built (pure): the number when
    renumbered, per till its shifts, document range and §3.3 figures (keys prefixed with
    the till, "3:totalCash"), and participants with shifts the Z did not take.
    """
    out: List[dict] = []
    if printed_number is not None and printed_number != number:
        out.append({"key": "shopSequenceNumber", "till": printed_number, "cloud": number})
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
    `(z, "created" | "duplicate")`; raises `LocalShopZRefused` (409 / 403 bodies) with
    nothing written.
    """
    from app.services import main_till as MT
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
    refusal = MT.till_shop_z_refusal(db, machine)
    if refusal is not None:
        raise LocalShopZRefused(status.HTTP_403_FORBIDDEN, {"detail": refusal})
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
        return existing, "duplicate"

    expected = last_shop_z_number(db, shop.id) + 1
    if body.shop_sequence_number != expected:
        holder = (
            db.query(ZReport.id)
            .filter(ZReport.shop_id == shop.id, ZReport.shop_sequence_number == body.shop_sequence_number)
            .first()
        )
        if holder is not None:
            raise _conflict(
                NUMBER_TAKEN, zNumber=body.shop_sequence_number, expectedNumber=expected,
                takenByZReportId=str(holder[0]),
            )
        raise _conflict(OUT_OF_SEQUENCE, zNumber=body.shop_sequence_number, expectedNumber=expected)

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

    renumbered = body.printed_number if body.printed_number not in (None, body.shop_sequence_number) else None
    z.built_offline = True
    z.uploaded_at = now
    z.offline_report = {
        "kind": "local_shop_z",
        "shopSequenceNumber": body.shop_sequence_number,
        "renumberedFrom": renumbered,
        "closedAt": closed_at.isoformat(),
        "businessDate": body.business_date.isoformat() if body.business_date else None,
        "producedBy": _ref(machine),
        "tills": [t.model_dump(mode="json", by_alias=True) for t in body.tills],
        "report": body.report,
    }
    found = discrepancies(
        number=body.shop_sequence_number,
        printed_number=body.printed_number,
        tills=body.tills,
        sections=z.per_machine or [],
        cloud_shift_ids=cloud_ids,
        missing=missing,
    )
    z.offline_discrepancies = found or None
    # A dashboard's request is answered by the main till's Z (named, or the one pending).
    complete_request(shop, body.shop_z_request_id, z)
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
    return {
        "request": _request_of(shop, now),
        "localMode": local_mode_of_shop(db, shop),
        "mainTill": MT.till_ref(MT.main_till_of_shop(db, shop.id)),
    }


def request_from_dashboard(db: Session, user, shop: Shop, *, now: Optional[datetime] = None) -> dict:
    """Ask the shop's main till for the shop Z; the pending one again if there is one."""
    from app.services import main_till as MT

    now = now or datetime.now(timezone.utc)
    if not local_mode_of_shop(db, shop):
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
    from app.services import main_till as MT

    main = MT.main_till_of_shop(db, shop.id)
    if main is None or main.id != machine.id:
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
