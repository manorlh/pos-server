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

**The cloud's part is the record — of the paper.** `upload` takes the Z under the shop's
counter lock with exactly the next number (`claim_shop_z_number`), and stores it **exactly as
the main till printed it** — its figures, its document ranges, its number (the owner: "הדף
שהקופה הראשית הדפיסה לא יכול להיות שונה מהענן"). There is no corrective Z, and the cloud
never puts figures of its own in place of the printed ones (`apply_printed`).

**A mismatch is impossible by construction** (the owner: "תוודא שלא יהיה מצב של אי התאמה
בנתונים — רק במצב שהקופה מתה", §8.12). Every till's part carries its manifest — its documents
by id, per type the count and the first and last numbers, the totals and a digest — built by
the till from its own committed documents with the same computation the cloud runs
(`app/services/shop_z_manifest.py`, golden fixtures shared with the till). The main till
builds the Z only from those parts. The cloud keeps the Z even before it has every shift and
document (a till that syncs late, or died after reporting), links the shifts as they arrive,
and compares only once every named document is here (`verify`): until then "ממתין למסמכים
מקופה N"; a till that never completes is "קופה N לא השלימה סנכרון", for support to close
(`close_part_by_support`) — never a mismatch. `local_shop_z_mismatch` ("אי-התאמה בין Z מקומי
לנתוני הענן — לבדיקת התמיכה", high) is only what is left: everything arrived and the same
computation disagrees — a bug.

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

#: Refusals the main till waits out and uploads again; any other 409 is a conflict. The cloud
#: no longer sends these for a local shop Z — it keeps the Z as printed and waits for the
#: tills' shifts and documents itself (§8.12) — but an older cloud did, so the till still
#: knows them.
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
    #: The part's manifest (docs/SPEC_INDEPENDENT_TILL.md §8.12): its documents by id, per
    #: type the count and the first and last numbers, the totals and a digest — built by the
    #: till from its own committed documents (`app/services/shop_z_manifest.py`, the same
    #: computation). Null: an older till, or a till support closed from the cloud.
    manifest: Optional[Dict[str, Any]] = None
    #: A till's late documents from an earlier period — the carry shifts the cloud handed the
    #: main till in the history (`participants[].lateDocuments`, SPEC_OFFLINE_TILL_Z §4.6.3),
    #: its own section: "מסמכים מאוחרים מתקופה קודמת (קופה N…)". A till may have both a
    #: regular part and a late part in one Z; parts are keyed by till and this flag.
    late: bool = False
    label: Optional[str] = Field(None, max_length=300)


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
    #: The summary as printed (the shop's totals): `{gross, discounts, refunds, net, cash,
    #: card, exchange, tips, vat, transactions}` — stored as is (`apply_printed`).
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
    Does the shop work in local mode: its switch "רשת מקומית" on (`shops.local_network`,
    docs/SPEC_LAN_MODE.md §4) and a main till ("קופה ראשית") to lean on over the LAN? Without
    a main till there is no local mode: exactly one till serves the LAN close, and it is the
    main till.

    Before the switch existed, local mode followed the configuration: `tablesMode` «רשת מקומית
    (קופה ראשית)» for the shop, or the main till being the shop's print server. The migration
    that added the switch (`c3e9f1a7b5d2`) set it on for exactly those shops, so no shop's Z
    production moved with it; from then on the switch alone decides.
    """
    from app.services.main_till import main_till_of_shop

    if shop is None or not bool(getattr(shop, "local_network", False)):
        return False
    return main_till_of_shop(db, shop.id) is not None


def participants(db: Session, shop_id: uuid.UUID) -> List[POSMachine]:
    """The tills the shop Z is for: seated, in `zMode = cloud` (so never an independent one)."""
    from app.services import z_runs as ZR
    from app.services.main_till import till_order

    tills = [m for m in ZR.shop_tills(db, shop_id) if ZR.is_seated_in(m, shop_id)]
    own = ZR.per_till_ids(db, tills)
    return sorted((m for m in tills if m.id not in own), key=till_order)


def _ref(machine: POSMachine) -> dict:
    return {"machineId": str(machine.id), "posNumber": machine.pos_number, "name": machine.name}


def _participant(db: Session, machine: POSMachine, remote: Optional[set] = None) -> dict:
    """
    A participant of the shop Z, with its support-closed section if it has one — and
    whether it is a kiosk (named so on the main till) and closes through the cloud (§8.14).
    """
    from app.services.late_documents import lan_part
    from app.services.support_z import lan_section

    out = _ref(machine)
    out["kiosk"] = bool(getattr(machine, "is_kiosk", False))
    out["remote"] = closes_through_cloud(machine, remote)
    section = lan_section(db, machine)
    if section is not None:
        out["supportClosed"] = section
    # Late documents of a support Z, carried into the next Z (SPEC_OFFLINE_TILL_Z §4.6.3):
    # the main till adds this part, as its own section, to its next shop Z.
    late = lan_part(db, machine) if section is None else None
    if late is not None:
        out["lateDocuments"] = late
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
        "participants": [_participant(db, m, remote_till_ids(shop)) for m in participants(db, shop.id)],
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

_CENT = Decimal("0.01")


def _dec(value) -> Optional[Decimal]:
    if value is None or isinstance(value, bool):
        return None
    try:
        out = Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None
    return out if out.is_finite() else None


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def upload(db: Session, machine: POSMachine, body: LocalShopZIn, *, now: Optional[datetime] = None) -> Tuple[ZReport, str]:
    """
    Take a shop Z the main till produced into the shop's run, in the caller's transaction.
    `(z, "created" | "duplicate")`; raises `LocalShopZRefused` with nothing written — but
    for a number that cannot be filed as printed (not the next one, taken, or from a till
    that is not the shop's producer): then the Z is recorded as a conflict for support,
    exactly as printed, and the refusal says to keep that (`keep`).

    The Z is kept exactly as printed even when the cloud does not yet have every shift and
    document it names (a till that syncs late, or died after reporting its part): those are
    linked and verified as they arrive (§8.12, `verify`).
    """
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
    part_machines: List[POSMachine] = []
    for t in body.tills:
        # A till removed since it reported its part (it died) is still this shop's (§8.12).
        m = tills.get(t.machine_id) or _former_till(db, shop, t.machine_id)
        if m is None:
            raise _conflict("machine_not_in_shop", machineId=str(t.machine_id))
        if getattr(m, "z_mode", None) == "till":
            raise _conflict("machine_issues_its_own_z", machineId=str(m.id))
        if not t.shift_ids:
            continue
        part_machines.append(m)
        # A shift the cloud has must be this till's and in no other Z. One it does not have
        # yet — a till that syncs late, or died after reporting its part — is waited for (§8.12).
        for shift in db.query(Shift).filter(Shift.id.in_(list(t.shift_ids))).all():
            if str(shift.machine_id) != str(m.id):
                raise _conflict("offline_z_shift_of_another_till", shiftId=str(shift.id), machineId=str(m.id))
            if shift.z_report_id is not None:
                raise _conflict("offline_z_shift_in_another_z", shiftId=str(shift.id), zReportId=str(shift.z_report_id))
    if not part_machines:
        raise _conflict("nothing_to_report")

    closed_at = _aware(body.closed_at)
    try:
        claim_shop_z_number(db, shop.id, body.shop_sequence_number)
    except ZNumberOutOfSequence:  # pragma: no cover - checked above under the same lock
        raise _conflict(OUT_OF_SEQUENCE, zNumber=body.shop_sequence_number, expectedNumber=expected)
    # The owner: the paper the main till printed IS the Z — stored as printed, built from it.
    z = _z_as_printed(db, shop, machine, body, part_machines, closed_at)
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
    apply_printed(z, body, machine)
    # Shifts of earlier local Zs that have arrived since are theirs first; then this Z's own.
    link_awaited(db, shop, now=now)
    link_shifts(db, z)
    # A participant with closed shifts the Z did not take — closed before it — would have
    # its sales slip into the next Z. The LAN close never lets that happen; if it did, say so.
    taken = {m.id for m in part_machines}
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
            missing.append({"key": f"{p.pos_number or p.id}:missing", "till": None, "cloud": len(left)})
    z.offline_discrepancies = missing or None
    # A dashboard's request is answered by the main till's Z (named, or the one pending).
    complete_request(shop, body.shop_z_request_id, z)
    # A conflict it once was (support made room for it): settled by the Z itself.
    _settle_conflict(shop, body.id, "uploaded", now)
    # Parts of tills closed through the cloud (§8.14) that this Z includes.
    take_remote_parts(db, shop, z)
    # Compared with the cloud's documents only once every one named has arrived (§8.12).
    verify(db, z, now=now)
    db.flush()
    # "פתיחת פריטים אוטומטית אחרי Z" (docs/SPEC_AVAILABILITY.md): own savepoint, never raises.
    from app.services.availability_reopen import after_z

    after_z(db, z, part_machines)
    return z, "created"


def _former_till(db: Session, shop: Shop, machine_id: Any) -> Optional[POSMachine]:
    """A till of this shop in any state — unpaired or retired after it reported its part."""
    machine = db.get(POSMachine, machine_id)
    if machine is None or str(machine.tenant_id) != str(shop.tenant_id):
        return None
    if str(machine.shop_id) == str(shop.id):
        return machine
    worked_here = db.query(Shift.id).filter(Shift.machine_id == machine.id, Shift.shop_id == shop.id).first()
    return machine if worked_here is not None else None


def _z_as_printed(
    db: Session, shop: Shop, producer: POSMachine, body: LocalShopZIn, machines: Sequence[POSMachine], closed_at: datetime,
) -> ZReport:
    """
    The Z row of a local shop Z — who, where, its number and what it includes; its figures
    are the paper's (`apply_printed`). Not built from the cloud's documents: the cloud may
    not have them all yet, and the paper is the Z (§8.7). Its shifts are linked as they
    arrive (`link_shifts`).
    """
    from app.services.till_replacement import note_on_z
    from app.services.z_builder import snapshot_header, z_scope

    z = ZReport(
        id=body.id,
        tenant_id=producer.tenant_id,
        machine_id=None,
        origin=ZOrigin.CLOUD,
        shop_id=shop.id,
        created_by_name=body.created_by_name,
        created_by_pos_user_id=body.created_by_user_id,
        client_request_id=body.client_request_id,
        business_date=body.business_date or closed_at.date(),
        period_start=closed_at,
        period_end=closed_at,
        shift_count=0,
        machine_count=len({m.id for m in machines}),
        total_sales=_ZERO,
        total_refunds=_ZERO,
        discounts_total=_ZERO,
        total_cash_sales=_ZERO,
        total_card_sales=_ZERO,
        total_exchange=_ZERO,
        total_tips=_ZERO,
        total_cash_tips=_ZERO,
        total_card_tips=_ZERO,
        transactions_count=0,
        closed_at=closed_at,
        header=snapshot_header(db, shop, now=closed_at),
        shop_sequence_number=body.shop_sequence_number,
    )
    unique = list({m.id: m for m in machines}.values())
    if z.header is not None:
        z.header = {**z.header, "scope": z_scope(db, shop.id, unique, False)}
    note_on_z(z, unique)
    db.add(z)
    db.flush()
    return z


# ── One computation, compared once everything has arrived (§8.12) ─────────────
#
# The owner: "תוודא שלא יהיה מצב של אי התאמה בנתונים — רק במצב שהקופה מתה ואולי חלק מהנתונים
# חסרים והמשמרת פתוחה". Every part of a local shop Z carries its manifest, built by its till
# from its own committed documents (`shop_z_manifest`). The cloud keeps the Z as printed and
# runs the same computation over the same documents — but only once every document the
# manifest names has arrived. Until then the till's part is waiting ("ממתין למסמכים מקופה N"),
# never a mismatch. A till that never completes (it died, was removed, support closed it, or a
# day went by) is "קופה N לא השלימה סנכרון" — for support, never a mismatch. A mismatch is what
# is left: everything arrived and the same computation disagrees — a bug, high severity.

VERIFY_KEY = "localShopZPending"
#: States a till's part (and the Z) can be in.
WAITING, INCOMPLETE, VERIFIED, MISMATCH, SUPPORT_CLOSED, UNVERIFIED = (
    "waiting", "incomplete", "verified", "mismatch", "closed_by_support", "unverified",
)
PENDING_STATES = (WAITING, INCOMPLETE)
#: Documents still missing this long after the Z reached the cloud: the till did not complete.
STALE_AFTER = timedelta(hours=24)
#: How often a heartbeat re-checks a shop's pending Zs.
RECHECK_EVERY = timedelta(seconds=20)
UNSYNCED_EXCEPTION = "local_shop_z_till_unsynced"
_LAST_CHECK: Dict[str, datetime] = {}


def _parts(z: ZReport) -> List[dict]:
    return [t for t in ((z.offline_report or {}).get("tills") or []) if isinstance(t, dict) and t.get("shiftIds")]


def part_key(part: dict) -> str:
    """A part's key: its till — and ":late" for the till's late documents (a part of its own)."""
    mid = str(part.get("machineId"))
    return f"{mid}:late" if part.get("late") else mid


def link_shifts(db: Session, z: ZReport) -> Dict[str, List[str]]:
    """
    Link to `z` the shifts it names that the cloud has, closed — the rest are awaited.
    `{part key: [awaited shift ids]}` (`part_key`: the till, ":late" for its late part); a
    named shift found in another Z is returned under "inAnotherZ:<part key>" (a fault: the
    LAN close names each shift once).
    """
    awaited: Dict[str, List[str]] = {}
    for part in _parts(z):
        mid = str(part.get("machineId"))
        key = part_key(part)
        ids = []
        for raw in part.get("shiftIds") or []:
            try:
                ids.append(uuid.UUID(str(raw)))
            except (ValueError, TypeError):
                continue
        rows = {str(r.id): r for r in db.query(Shift).filter(Shift.id.in_(ids)).all()} if ids else {}
        for sid in (str(i) for i in ids):
            shift = rows.get(sid)
            if (
                shift is None or str(shift.machine_id) != mid
                or shift.status != ShiftStatus.CLOSED or shift.close_accepted_at is None
            ):
                awaited.setdefault(key, []).append(sid)
                continue
            if shift.z_report_id is None:
                shift.z_report_id = z.id
                z.shift_count = (z.shift_count or 0) + 1
                opened = _aware(shift.opened_at) if shift.opened_at else None
                if opened is not None and (z.period_start is None or opened < _aware(z.period_start)):
                    z.period_start = opened
            elif str(shift.z_report_id) != str(z.id):
                awaited.setdefault(f"inAnotherZ:{key}", []).append(sid)
                continue
            carry_unnamed(db, z, part, shift)
    db.flush()
    return awaited


UNNAMED_KEY = "unnamedDocuments"


def carry_unnamed(db: Session, z: ZReport, part: dict, shift: Shift) -> int:
    """
    Documents in a shift this local shop Z took that the part's manifest does not name: the
    paper never had them, so the Z does not count them — on their own they would be in no Z.
    Carried into the till's next Z like any document that arrived after a Z (late documents,
    §4.6.3) and counted on the Z (`offline_report.unnamedDocuments`, shown by `verify`). A part
    with no manifest (an older till) names nothing, so nothing can be told — left as it is.
    """
    from app.models.transaction import Transaction
    from app.services import late_documents

    manifest = part.get("manifest")
    if not isinstance(manifest, dict) or not manifest.get("digest"):
        return 0
    named = {str(i).lower() for i in manifest.get("documentIds") or []}
    unnamed = [
        row[0] for row in db.query(Transaction.id).filter(Transaction.shift_id == shift.id).all()
        if str(row[0]).lower() not in named
    ]
    if not unnamed:
        return 0
    # Counted late first, as an arrival after the Z would be; `carry` then moves them out.
    shift.late_documents = int(shift.late_documents or 0) + len(unnamed)
    z.late_documents = int(z.late_documents or 0) + len(unnamed)
    moved = late_documents.carry(db, shift, z, doc_ids=unnamed)
    if moved:
        report = dict(z.offline_report or {})
        counts = dict(report.get(UNNAMED_KEY) or {})
        counts[part_key(part)] = int(counts.get(part_key(part)) or 0) + moved
        report[UNNAMED_KEY] = counts
        z.offline_report = report
        logger.warning(
            "local shop Z %s (#%s): %s document(s) of shift %s not in the manifest — carried into the next Z",
            z.id, z.shop_sequence_number, moved, shift.id,
        )
    return moved


def _pending_ids(shop: Shop) -> List[str]:
    rows = (shop.settings or {}).get(VERIFY_KEY)
    return [str(r) for r in rows] if isinstance(rows, list) else []


def _set_pending(shop: Shop, z_id: Any, pending: bool) -> None:
    ids = _pending_ids(shop)
    has = str(z_id) in ids
    if pending and not has:
        _put(shop, VERIFY_KEY, ids + [str(z_id)])
    elif not pending and has:
        _put(shop, VERIFY_KEY, [i for i in ids if i != str(z_id)] or None)


def link_awaited(db: Session, shop: Shop, *, now: Optional[datetime] = None) -> None:
    """The shifts the shop's pending local Zs wait for that have arrived: linked to them."""
    for zid in _pending_ids(shop):
        try:
            z = db.get(ZReport, uuid.UUID(zid))
        except (ValueError, TypeError):
            z = None
        if z is not None:
            link_shifts(db, z)


def _till_gone(db: Session, machine: Optional[POSMachine], z: ZReport, now: datetime) -> Optional[str]:
    """Why a till's part will not complete by itself (the only allowed gap), or None."""
    from app.models.pos_machine import PairingStatus

    if machine is None:
        return "removed"
    if not machine.is_active or machine.pairing_status == PairingStatus.UNPAIRED:
        return "removed"
    try:
        from app.services.support_z import lan_section

        if lan_section(db, machine) is not None:
            return "support_closed"
    except Exception:  # noqa: BLE001 - a lookup failure is not a verdict
        logger.exception("support close lookup failed for machine %s", machine.id)
    uploaded = _aware(z.uploaded_at) if z.uploaded_at else None
    if uploaded is not None and now - uploaded > STALE_AFTER:
        return "stale"
    return None


#: The section's key for each manifest total (the paper's per-till figures).
_SECTION_KEYS = (
    ("grossSales", "gross"),
    ("discountsTotal", "discounts"),
    ("totalRefunds", "refunds"),
    ("netSales", "net"),
    ("totalCash", "cash"),
    ("totalCard", "card"),
    ("totalExchange", "exchange"),
    ("totalTips", "tips"),
    ("vatTotal", "vat"),
    ("transactionsCount", "documents"),
)
#: The printed summary's key for each manifest total.
_SUMMARY_TO_MANIFEST = (
    ("gross", "gross"), ("discounts", "discounts"), ("refunds", "refunds"), ("cash", "cash"),
    ("card", "card"), ("exchange", "exchange"), ("tips", "tips"), ("vat", "vat"), ("transactions", "documents"),
)


def _same_money(a: Any, b: Any) -> bool:
    x, y = _dec(a), _dec(b)
    if x is None or y is None:
        return x is None and y is None
    return x == y


def _paper_vs_manifest(section: Optional[dict], manifest: dict) -> List[dict]:
    """Where the printed section is not its manifest — built from it on the till, so never."""
    if not isinstance(section, dict) or not section.get("manifestDigest"):
        return []
    totals = manifest.get("totals") or {}
    out = []
    for section_key, key in _SECTION_KEYS:
        if section_key in section and not _same_money(section.get(section_key), totals.get(key)):
            out.append({"key": f"paper.{section_key}", "printed": section.get(section_key), "cloud": totals.get(key)})
    if section.get("manifestDigest") != manifest.get("digest"):
        out.append({"key": "paper.manifestDigest", "printed": section.get("manifestDigest"), "cloud": manifest.get("digest")})
    return out


def _documents_arrived(db: Session, ids: Sequence[str]) -> int:
    """How many of the named documents the cloud has (a count — cheap while still waiting)."""
    from sqlalchemy import func

    from app.models.transaction import Transaction

    wanted = []
    for raw in ids:
        try:
            wanted.append(uuid.UUID(str(raw)))
        except (ValueError, TypeError):
            continue
    found = 0
    for start in range(0, len(wanted), 500):
        found += db.query(func.count(Transaction.id)).filter(Transaction.id.in_(wanted[start:start + 500])).scalar() or 0
    return found


def verify(db: Session, z: ZReport, *, now: Optional[datetime] = None) -> dict:
    """
    Verify a local shop Z against the cloud's documents (§8.12), in the caller's transaction:
    per till part — waiting, incomplete, verified, mismatch, closed by support, or unverified
    (no manifest) — and the Z's state from them. Stored on `offline_report.verification`; the
    Z itself, as printed, never changes. Records `local_shop_z_mismatch` (everything arrived
    and the same computation disagrees) and `local_shop_z_till_unsynced` (a till that did not
    complete) once each.
    """
    from app.services import shop_z_manifest as MF

    now = now or datetime.now(timezone.utc)
    report = dict(z.offline_report or {})
    if report.get("kind") != "local_shop_z":
        return {}
    previous = report.get("verification") or {}
    before = {str(t.get("key") or t.get("machineId")): t for t in previous.get("tills") or [] if isinstance(t, dict)}
    awaited = link_shifts(db, z)
    # Documents the manifests did not name, found as the shifts were linked (`carry_unnamed`).
    unnamed = dict((z.offline_report or {}).get(UNNAMED_KEY) or {})
    if unnamed:
        report[UNNAMED_KEY] = unnamed
    sections = {part_key(s): s for s in (z.per_machine or []) if isinstance(s, dict)}
    tills: List[dict] = []
    found: List[dict] = []
    manifests: List[dict] = []
    for part in _parts(z):
        mid = str(part.get("machineId"))
        key = part_key(part)
        late = bool(part.get("late"))
        try:
            machine = db.get(POSMachine, uuid.UUID(mid))
        except (ValueError, TypeError):
            machine = None
        label = _till_label(machine) if machine is not None else f"קופה {mid[:8]}"
        if late:
            label = f"מסמכים מאוחרים של {label}"
        tag = ((machine.pos_number if machine is not None else None) or mid[:8]) + (":late" if late else "")
        entry: Dict[str, Any] = {
            "key": key, "machineId": mid, "posNumber": machine.pos_number if machine is not None else None,
            **({"late": True, "label": part.get("label")} if late else {}),
            # Documents of its shifts the manifest did not name: carried into the next Z.
            **({"unnamedCarried": int(unnamed[key])} if unnamed.get(key) else {}),
        }
        old = before.get(key) or {}
        if old.get("state") == SUPPORT_CLOSED:
            tills.append(old)
            continue
        waiting_shifts = awaited.get(key, [])
        manifest = part.get("manifest")
        if not isinstance(manifest, dict) or not manifest.get("digest"):
            # An older till's part names no documents — nothing to compare; its shifts are
            # still linked as they arrive.
            entry.update(state=UNVERIFIED, message=f"{label}: ללא מניפסט (נסגרה ע״י התמיכה או גרסה ישנה) — לא נבדק מול המסמכים")
            if waiting_shifts:
                gone = _till_gone(db, machine, z, now)
                entry.update(
                    shiftsAwaited=len(waiting_shifts),
                    state=INCOMPLETE if gone else WAITING,
                    message=f"{label} לא השלימה סנכרון" if gone else f"ממתין לסגירת המשמרת מ{label}",
                    **({"reason": gone} if gone else {}),
                )
            tills.append(entry)
            continue
        manifests.append(manifest)
        named = [str(i).lower() for i in manifest.get("documentIds") or []]
        arrived = _documents_arrived(db, named)
        entry.update(named=len(named), arrived=arrived, missing=len(named) - arrived, shiftsAwaited=len(waiting_shifts))
        in_other = awaited.get(f"inAnotherZ:{key}", [])
        if arrived < len(named) or waiting_shifts:
            gone = _till_gone(db, machine, z, now)
            if gone:
                entry.update(state=INCOMPLETE, reason=gone, message=f"{label} לא השלימה סנכרון")
                if machine is not None and machine.last_heartbeat_at is not None:
                    entry["lastHeartbeatAt"] = _aware(machine.last_heartbeat_at).isoformat()
            else:
                entry.update(
                    state=WAITING,
                    message=f"ממתין למסמכים מ{label}" if arrived < len(named) else f"ממתין לסגירת המשמרת מ{label}",
                )
            tills.append(entry)
            continue
        # Everything named is here: the same computation over the same documents.
        docs = MF.cloud_documents(db, named)
        cloud = MF.manifest_of(docs.values())
        diffs = MF.compare(manifest, cloud)
        foreign = sorted({d.get("machineId") for d in docs.values() if d.get("machineId") != mid})
        if foreign:
            diffs.append({"key": "machineId", "printed": mid, "cloud": foreign})
        if in_other:
            diffs.append({"key": "shiftInAnotherZ", "printed": str(z.id), "cloud": in_other})
        diffs += _paper_vs_manifest(sections.get(key), manifest)
        if diffs:
            entry.update(
                state=MISMATCH,
                message=f"{label}: אי-התאמה בין Z מקומי לנתוני הענן",
                discrepancies=diffs,
                printed={"totals": manifest.get("totals"), "types": manifest.get("types"), "digest": manifest.get("digest")},
                cloud={"totals": cloud.get("totals"), "types": cloud.get("types"), "digest": cloud.get("digest")},
            )
            found += [{**d, "key": f"{tag}:{d['key']}"} for d in diffs]
        else:
            entry.update(state=VERIFIED, message=f"{label}: אומת מול מסמכי הענן")
        tills.append(entry)
    states = {t.get("state") for t in tills}
    # The printed summary is the parts' sum (on the till, by construction) — checked once
    # every part has a manifest and is in.
    if manifests and len(manifests) == len(tills) and states <= {VERIFIED, MISMATCH}:
        printed = report.get("report") if isinstance(report.get("report"), dict) else {}
        summed = MF.sum_totals(manifests)
        for printed_key, key in _SUMMARY_TO_MANIFEST:
            if printed_key not in printed:
                continue
            a, b = printed.get(printed_key), summed.get(key)
            same = (int(a or 0) == int(b or 0)) if key == "documents" else _same_money(a, b)
            if not same:
                found.append({"key": f"summary:{printed_key}", "printed": a, "cloud": b})
    if found:
        state = MISMATCH
        message = "אי-התאמה בין Z מקומי לנתוני הענן — לבדיקת התמיכה"
    elif INCOMPLETE in states:
        state = INCOMPLETE
        message = " · ".join(t["message"] for t in tills if t.get("state") == INCOMPLETE)
    elif WAITING in states:
        state = WAITING
        message = " · ".join(t["message"] for t in tills if t.get("state") == WAITING)
    elif SUPPORT_CLOSED in states:
        state = SUPPORT_CLOSED
        message = " · ".join(str(t.get("message")) for t in tills if t.get("state") == SUPPORT_CLOSED)
    elif UNVERIFIED in states and VERIFIED not in states:
        state = UNVERIFIED
        message = "לא נבדק מול המסמכים (ללא מניפסט)"
    else:
        state = VERIFIED
        message = "אומת מול מסמכי הענן — כל המסמכים הגיעו והחישוב זהה"
        if UNVERIFIED in states:
            message = " · ".join([message] + [str(t.get("message")) for t in tills if t.get("state") == UNVERIFIED])
    if unnamed:
        message = f"{message} · {sum(int(v) for v in unnamed.values())} מסמכים שהמניפסט לא כלל הועברו ל-Z הבא של הקופה"
    verification = {
        "state": state,
        "message": message,
        "unnamedDocuments": unnamed or None,
        "checkedAt": now.isoformat(),
        "tills": tills,
        "discrepancies": found or None,
    }
    report["verification"] = verification
    z.offline_report = report
    shop = db.get(Shop, z.shop_id) if z.shop_id else None
    if shop is not None:
        _set_pending(shop, z.id, state in PENDING_STATES)
    producer = None
    produced_by = (report.get("producedBy") or {}).get("machineId")
    if produced_by:
        try:
            producer = db.get(POSMachine, uuid.UUID(str(produced_by)))
        except (ValueError, TypeError):
            producer = None
    if state == MISMATCH and previous.get("state") != MISMATCH and producer is not None:
        logger.error("local shop Z %s (#%s) does not verify: %s", z.id, z.shop_sequence_number, found)
        _record_safely(
            db, producer,
            exception_type=MISMATCH_EXCEPTION,
            key=f"{MISMATCH_EXCEPTION}:{z.id}",
            occurred_at=_aware(z.closed_at),
            details={
                "zReportId": str(z.id),
                "zNumber": z.shop_sequence_number,
                "shopZ": True,
                "storedAsPrinted": True,
                # Only now: every named document arrived, and the same computation disagrees.
                "allDocumentsArrived": True,
                "severity": "high",
                "closedAt": _aware(z.closed_at).isoformat(),
                "uploadedAt": _aware(z.uploaded_at).isoformat() if z.uploaded_at else None,
                "discrepancies": found,
                "tills": [t for t in tills if t.get("state") == MISMATCH],
                "summary": (
                    f"אי-התאמה בין Z מקומי לנתוני הענן — לבדיקת התמיכה. Z סניפי מס׳ {z.shop_sequence_number} "
                    "נשמר כפי שהודפס; כל המסמכים הגיעו והחישוב אינו זהה (תקלה): "
                    + ", ".join(f"{d['key']} — הודפס {d['printed']} / ענן {d['cloud']}" for d in found[:4])
                ),
            },
        )
    for t in tills:
        if t.get("state") != INCOMPLETE or (before.get(t.get("key") or t["machineId"]) or {}).get("state") == INCOMPLETE:
            continue
        try:
            till = db.get(POSMachine, uuid.UUID(t["machineId"]))
        except (ValueError, TypeError):
            till = None
        target = till or producer
        if target is None:
            continue
        _record_safely(
            db, target,
            exception_type=UNSYNCED_EXCEPTION,
            key=f"{UNSYNCED_EXCEPTION}:{z.id}:{t.get('key') or t['machineId']}",
            occurred_at=now,
            details={
                "zReportId": str(z.id),
                "zNumber": z.shop_sequence_number,
                "shopZ": True,
                "machineId": t["machineId"],
                "posNumber": t.get("posNumber"),
                "named": t.get("named"),
                "arrived": t.get("arrived"),
                "missing": t.get("missing"),
                "shiftsAwaited": t.get("shiftsAwaited"),
                "reason": t.get("reason"),
                "summary": (
                    f"{t.get('message')} — Z סניפי מס׳ {z.shop_sequence_number} נשמר כפי שהודפס; "
                    f"{t.get('missing') or 0} מסמכים ו-{t.get('shiftsAwaited') or 0} משמרות לא הגיעו לענן. "
                    "לא אי-התאמה: לטיפול התמיכה (סגירה ורישום מה חסר)."
                ),
            },
        )
    db.flush()
    return verification


def verify_pending(db: Session, shop_id: Any, *, now: Optional[datetime] = None, force: bool = False) -> int:
    """
    A heartbeat's turn (any till of the shop): link the shifts that arrived and re-verify the
    shop's local Zs still waiting — at most every few seconds per shop. How many were checked.
    """
    now = now or datetime.now(timezone.utc)
    shop = db.get(Shop, shop_id) if shop_id is not None else None
    if shop is None or not _pending_ids(shop):
        return 0
    last = _LAST_CHECK.get(str(shop.id))
    if not force and last is not None and timedelta(0) <= now - last < RECHECK_EVERY:
        return 0
    _LAST_CHECK[str(shop.id)] = now
    checked = 0
    for zid in _pending_ids(shop):
        try:
            z = db.get(ZReport, uuid.UUID(zid))
        except (ValueError, TypeError):
            z = None
        if z is None:
            _set_pending(shop, zid, False)
            continue
        verify(db, z, now=now)
        checked += 1
    return checked


def close_part_by_support(
    db: Session, user, shop: Shop, z_id: Any, machine_id: Any, *, note: Optional[str] = None,
    late: bool = False, now: Optional[datetime] = None,
) -> dict:
    """
    Support closes a till's part that will not complete (§8.12): recorded with what is
    missing — the documents and shifts the paper names that never reached the cloud — and the
    Z's state recomputed. The Z, as printed, does not change. 404 / 409 as the API says.
    """
    from app.services import shop_z_manifest as MF

    now = now or datetime.now(timezone.utc)
    try:
        z = db.get(ZReport, uuid.UUID(str(z_id)))
    except (ValueError, TypeError):
        z = None
    if z is None or str(z.shop_id) != str(shop.id) or (z.offline_report or {}).get("kind") != "local_shop_z":
        raise HTTPException(status.HTTP_404_NOT_FOUND, {"detail": "local_shop_z_not_found"})
    verify(db, z, now=now)
    report = dict(z.offline_report or {})
    verification = dict(report.get("verification") or {})
    tills = [dict(t) for t in verification.get("tills") or []]
    key = f"{machine_id}:late" if late else str(machine_id)
    entry = next((t for t in tills if (t.get("key") or t.get("machineId")) == key), None)
    if entry is None or entry.get("state") not in PENDING_STATES:
        raise HTTPException(status.HTTP_409_CONFLICT, {
            "detail": "local_shop_z_part_not_pending",
            "message": "רק חלק של קופה שממתין או שלא השלים סנכרון נסגר ע״י התמיכה.",
        })
    part = next((p for p in _parts(z) if part_key(p) == key), {})
    manifest = part.get("manifest") or {}
    named = [str(i).lower() for i in manifest.get("documentIds") or []]
    have = set(MF.cloud_documents(db, named)) if named else set()
    missing_ids = [i for i in named if i not in have]
    awaited = link_shifts(db, z).get(key, [])
    by = getattr(user, "username", None) or getattr(user, "email", None) or str(getattr(user, "id", ""))
    label = f"קופה {entry.get('posNumber')}" if entry.get("posNumber") else "הקופה"
    entry.update(
        state=SUPPORT_CLOSED,
        message=f"{label} נסגרה ע״י התמיכה — חסרים {len(missing_ids)} מסמכים ו-{len(awaited)} משמרות",
        closedBySupport={
            "by": by,
            "at": now.isoformat(),
            "note": note,
            "missingDocumentIds": missing_ids[:500],
            "missingDocuments": len(missing_ids),
            "missingShiftIds": awaited,
            # What the paper says of the part — the figures the missing documents are in.
            "printedTotals": manifest.get("totals"),
            "printedTypes": manifest.get("types"),
        },
    )
    verification["tills"] = tills
    report["verification"] = verification
    z.offline_report = report
    return verify(db, z, now=now)


# ── The paper is the Z ─────────────────────────────────────────────────────────

#: A local shop Z whose printed figures differ from what the cloud builds from its documents.
MISMATCH_EXCEPTION = "local_shop_z_mismatch"

#: The printed summary's keys (`LocalShopZIn.report`) and the till's §3.3 key summed for each.
SUMMARY_KEYS = (
    ("gross", "totalSales"),
    ("discounts", "totalDiscounts"),
    ("refunds", "totalRefunds"),
    ("cash", "totalCash"),
    ("card", "totalCard"),
    ("exchange", "totalExchange"),
    ("tips", "totalTips"),
    ("vat", "vatTotal"),
    ("transactions", "transactionsCount"),
)

_ZERO = Decimal("0")


def _taken(body: LocalShopZIn) -> List[LocalShopZTill]:
    return [t for t in body.tills if t.shift_ids]


def printed_summary(body: LocalShopZIn) -> Dict[str, Any]:
    """
    The shop's totals as the main till printed them (pure): its `report` when it sent one,
    else the sum of its tills' §3.3 figures — the same sum the paper shows. VAT is null when
    any till's is (withheld, never partial), like on the paper.
    """
    out: Dict[str, Any] = {}
    tills = _taken(body)
    for key, till_key in SUMMARY_KEYS:
        values = [(t.till or {}).get(till_key) for t in tills]
        if key == "vat" and any(v is None for v in values):
            out[key] = None
        elif key == "transactions":
            out[key] = sum(int(v or 0) for v in values)
        else:
            out[key] = sum((_dec(v) or _ZERO for v in values), _ZERO)
    printed = body.report if isinstance(body.report, dict) else {}
    for key, _till_key in SUMMARY_KEYS:
        if key in printed:
            value = printed[key]
            out[key] = (None if value is None else int(value)) if key == "transactions" else (
                None if value is None else _dec(value)
            )
    return out


def printed_keys(body: LocalShopZIn) -> set:
    """
    The summary's figures the paper carries: those in its `report`, and those every till
    sent in its §3.3 figures. A figure no till sent (an older till) is not a claim.
    """
    printed = body.report if isinstance(body.report, dict) else {}
    tills = _taken(body)
    return {
        key for key, till_key in SUMMARY_KEYS
        if key in printed or (tills and all(till_key in (t.till or {}) for t in tills))
    }


def _section_as_printed(t: LocalShopZTill, machine: Optional[POSMachine]) -> dict:
    """One till's section as the main till printed it, named the way every section is."""
    section = dict(t.report or {})
    section["machineId"] = str(t.machine_id)
    section.setdefault("posNumber", machine.pos_number if machine is not None else None)
    section.setdefault("machineName", machine.name if machine is not None else None)
    section.setdefault("shiftIds", [str(i) for i in t.shift_ids])
    section.setdefault("shiftCount", len(t.shift_ids))
    if t.late:
        section["late"] = True
        section["label"] = t.label or section.get("label") or "מסמכים מאוחרים מתקופה קודמת"
    if t.first_document_number is not None:
        section["firstDocumentNumber"] = t.first_document_number
    if t.last_document_number is not None:
        section["lastDocumentNumber"] = t.last_document_number
    return section


def _sum_sections(sections: Sequence[dict], key: str, *, all_or_none: bool = False) -> Optional[Decimal]:
    values = [_dec(s.get(key)) for s in sections]
    if all_or_none and any(v is None for v in values):
        return None
    return sum((v or _ZERO for v in values), _ZERO)


def apply_printed(z: ZReport, body: LocalShopZIn, producer: POSMachine) -> None:
    """
    Make the stored Z the printed one (the owner: the main till's paper cannot differ from
    the cloud): the shop's totals, each till's section with its document range, the business
    date — as printed. Its header keeps who and where (the business, the scope, the branch
    code), never figures of the cloud's.
    """
    from sqlalchemy.orm import object_session

    printed = printed_summary(body)
    # A figure the paper does not carry (an older till sent none) is the only one left as built.
    claimed = printed_keys(body)
    session = object_session(z)
    machines = {
        t.machine_id: (session.get(POSMachine, t.machine_id) if session is not None else None) for t in _taken(body)
    }
    sections = [_section_as_printed(t, machines.get(t.machine_id)) for t in _taken(body)]
    def take(key, current):
        return printed[key] if key in claimed else current

    discounts = take("discounts", _dec(z.discounts_total))
    if "gross" in claimed:
        z.total_sales = (printed["gross"] or _ZERO) - (discounts or _ZERO)
    z.discounts_total = discounts
    z.total_refunds = take("refunds", z.total_refunds)
    z.total_cash_sales = take("cash", z.total_cash_sales)
    z.total_card_sales = take("card", z.total_card_sales)
    z.total_exchange = take("exchange", z.total_exchange)
    z.total_tips = take("tips", z.total_tips)
    if any("totalCashTips" in s for s in sections):
        z.total_cash_tips = _sum_sections(sections, "totalCashTips")
        z.total_card_tips = _sum_sections(sections, "totalCardTips")
    z.vat_total = take("vat", z.vat_total)
    z.transactions_count = int(take("transactions", z.transactions_count) or 0)
    breakdown: Dict[str, Decimal] = {}
    for s in sections:
        for method, amount in (s.get("paymentBreakdown") or {}).items():
            value = _dec(amount)
            if value is not None:
                breakdown[method] = breakdown.get(method, _ZERO) + value
    if breakdown:
        z.payment_breakdown = {k: str(v.quantize(_CENT)) for k, v in breakdown.items()}
    z.per_machine = sections
    # A till's regular and late parts are one till.
    z.machine_count = len({str(s.get("machineId")) for s in sections})
    z.shift_count = sum(len(t.shift_ids) for t in _taken(body))
    if any("openingCash" in s for s in sections):
        z.opening_cash = _sum_sections(sections, "openingCash")
        z.expected_cash = _sum_sections(sections, "expectedCash")
        z.actual_cash = _sum_sections(sections, "countedCash", all_or_none=True)
        z.discrepancy = _sum_sections(sections, "overShort", all_or_none=True)
    if body.business_date is not None:
        z.business_date = body.business_date
    z.totals_mismatch = False
    header = dict(z.header or {})
    for key in ("lineDiscountsTotal", "promotionDiscountsTotal", "byWaiter"):
        header.pop(key, None)
    header["asPrinted"] = {"producedBy": _ref(producer), "note": "נשמר כפי שהודפס בקופה הראשית"}
    z.header = header


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
        # Waiting for documents, verified, … (§8.12) — never a refusal.
        "verification": {
            k: v for k, v in ((z.offline_report or {}).get("verification") or {}).items() if k in ("state", "message")
        } or None,
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
    seen = getattr(block, "lan_seen", None)
    if isinstance(seen, list):
        # Who the main till hears on the LAN (§8.14): a hint for "מחובר ברשת / מרוחק".
        new["lanSeen"] = sorted({str(i) for i in seen})[:200]
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


# ── A participant off the LAN: closed through the cloud (§8.14) ────────────────
#
# In local mode the main till closes every participating till over the LAN (§8.3). A till
# or kiosk at another location — its own internet, set "מרוחק (דרך הענן)" in the card — cannot
# hear it there, and would block the Z forever. So the main till asks the cloud: the machine
# gets the request on its heartbeat (`pendingShopZPart`), closes its shift with the LAN
# close's own rules, builds its part (section + manifest, §8.12) and uploads it; the main till
# pulls it and includes it — the same answer it would have had over the LAN. No till is
# skipped: until the part is in, the Z waits ("קיוסק X — ממתין לסגירה דרך הענן"). The setting
# decides; the main till's view of who it hears on the LAN is a hint only (`lanSeen`).

REMOTE_TILLS_KEY = "shopZRemoteTills"
REMOTE_TTL_HOURS = 36
REMOTE_LIVE = ("requested", "delivered")
#: The LAN close's final outcomes (the till app's `LanCloseOutcome`); `waiting_card` is not.
REMOTE_FINAL_OUTCOMES = ("closed", "no_open_shift", "blocked_payment", "blocked_tables", "failed")
REMOTE_OUTCOMES = REMOTE_FINAL_OUTCOMES + ("waiting_card",)
#: A main till's word on who it heard on the LAN is a hint while the main till is heard from.
LAN_SEEN_FRESH = timedelta(minutes=15)


def closes_through_cloud(machine: POSMachine, remote: Optional[set] = None) -> bool:
    """
    Is this participant closed through the cloud rather than over the LAN: set "מרוחק (דרך
    הענן)", or a Windows device whatever the setting — the Windows kiosk has no LAN client to
    hear the main till (it answers `pendingShopZPart` only), so over the LAN it would block
    the Z as unreachable, forever (PARITY.md gap 5).
    """
    from app.services.display_devices import PLATFORM_WINDOWS, platform_of

    return str(machine.id) in (remote or set()) or platform_of(machine) == PLATFORM_WINDOWS


def remote_till_ids(shop: Optional[Shop]) -> set:
    """The participants set to close through the cloud ("מרוחק (דרך הענן)")."""
    rows = ((shop.settings or {}) if shop is not None else {}).get(REMOTE_TILLS_KEY)
    return {str(r) for r in rows} if isinstance(rows, list) else set()


def set_remote_till_ids(shop: Shop, ids: Iterable[Any]) -> None:
    _put(shop, REMOTE_TILLS_KEY, sorted({str(i) for i in ids}) or None)


def lan_seen_hint(db: Session, shop: Shop, *, now: Optional[datetime] = None) -> Optional[set]:
    """
    Who the main till hears on the LAN (its heartbeat's `localShopZ.lanSeen`), while it is
    heard from itself — else None (unknown). A hint for the card, never the decision.
    """
    from app.services import main_till as MT

    now = now or datetime.now(timezone.utc)
    main = MT.main_till_of_shop(db, shop.id)
    if main is None or main.last_heartbeat_at is None or now - _aware(main.last_heartbeat_at) > LAN_SEEN_FRESH:
        return None
    seen = (_reports(shop).get(str(main.id)) or {}).get("lanSeen")
    if not isinstance(seen, list):
        return None
    return {str(i) for i in seen} | {str(main.id)}


class RemotePartRefused(Exception):
    def __init__(self, status_code: int, body: dict):
        super().__init__(body.get("detail"))
        self.status_code = status_code
        self.body = body


def _remote_out(row) -> dict:
    return {
        "machineId": str(row.machine_id),
        "requestId": row.request_id,
        "roundId": row.round_id,
        "state": row.state,
        "outcome": row.outcome,
        "message": row.message,
        "requestedAt": _aware(row.requested_at).isoformat() if row.requested_at else None,
        "deliveredAt": _aware(row.delivered_at).isoformat() if row.delivered_at else None,
        "reportedAt": _aware(row.reported_at).isoformat() if row.reported_at else None,
        # The machine's report as sent — what the main till's board takes as its answer.
        "report": row.report,
    }


def _expire_remote(db: Session, rows: Sequence[Any], now: datetime) -> None:
    for row in rows:
        if row.state in REMOTE_LIVE and row.expires_at is not None and _aware(row.expires_at) <= now:
            row.state = "expired"


def request_remote_parts(
    db: Session, main: POSMachine, round_id: str, requests: Sequence[dict], *, now: Optional[datetime] = None,
) -> dict:
    """
    The main till asks the cloud to close its remote participants for a round:
    `requests = [{machineId, requestId, force}]`. Only the shop's main till, in local mode;
    only participants. A new request for a machine supersedes its earlier live one
    ("נסה שוב"); the same request again changes nothing. The round's parts.
    """
    from app.models.shop_z_remote_part import ShopZRemotePart
    from app.services import main_till as MT

    now = now or datetime.now(timezone.utc)
    shop = db.get(Shop, main.shop_id) if main.shop_id else None
    if shop is None:
        raise RemotePartRefused(status.HTTP_404_NOT_FOUND, {"detail": "shop_not_found"})
    current_main = MT.main_till_of_shop(db, shop.id)
    if current_main is None or current_main.id != main.id or not local_mode_of_shop(db, shop):
        raise RemotePartRefused(status.HTTP_409_CONFLICT, {
            "detail": "not_main_till",
            "message": "רק הקופה הראשית של הסניף, במצב רשת מקומית, מבקשת סגירה דרך הענן.",
        })
    members = {str(m.id): m for m in participants(db, shop.id)}
    refused = []
    for r in requests:
        mid, rid = str(r.get("machineId") or ""), str(r.get("requestId") or "")[:64]
        if mid not in members or mid == str(main.id) or not rid:
            refused.append({"machineId": mid, "detail": "not_a_participant"})
            continue
        if db.query(ShopZRemotePart.id).filter(ShopZRemotePart.request_id == rid).first() is not None:
            continue
        for old in (
            db.query(ShopZRemotePart)
            .filter(ShopZRemotePart.machine_id == members[mid].id, ShopZRemotePart.state.in_(REMOTE_LIVE))
            .all()
        ):
            old.state = "superseded"
        db.add(ShopZRemotePart(
            id=uuid.uuid4(), tenant_id=shop.tenant_id, shop_id=shop.id, machine_id=members[mid].id,
            main_machine_id=main.id, round_id=str(round_id)[:64], request_id=rid,
            force=bool(r.get("force", True)), state="requested", requested_at=now,
            expires_at=now + timedelta(hours=REMOTE_TTL_HOURS),
        ))
    db.flush()
    return {**remote_parts(db, main, round_id, now=now), "refused": refused}


def remote_parts(db: Session, main: POSMachine, round_id: str, *, now: Optional[datetime] = None) -> dict:
    """The main till's view of a round's remote parts: the latest request per machine."""
    from app.models.shop_z_remote_part import ShopZRemotePart

    now = now or datetime.now(timezone.utc)
    rows = (
        db.query(ShopZRemotePart)
        .filter(ShopZRemotePart.shop_id == main.shop_id, ShopZRemotePart.round_id == str(round_id)[:64])
        .order_by(ShopZRemotePart.requested_at)
        .all()
    )
    _expire_remote(db, rows, now)
    latest: Dict[str, Any] = {}
    for row in rows:
        if row.state != "superseded":
            latest[str(row.machine_id)] = row
    return {"roundId": round_id, "parts": [_remote_out(r) for r in latest.values()], "serverTime": now.isoformat()}


def take_pending_remote_part(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> Optional[dict]:
    """The heartbeat's `pendingShopZPart`: a close the main till asked of this machine, until it answers."""
    from app.models.shop_z_remote_part import ShopZRemotePart

    now = now or datetime.now(timezone.utc)
    rows = (
        db.query(ShopZRemotePart)
        .filter(ShopZRemotePart.machine_id == machine.id, ShopZRemotePart.state.in_(REMOTE_LIVE))
        .order_by(ShopZRemotePart.requested_at.desc())
        .all()
    )
    _expire_remote(db, rows, now)
    row = next((r for r in rows if r.state in REMOTE_LIVE), None)
    if row is None:
        return None
    if row.state == "requested":
        row.state = "delivered"
        row.delivered_at = now
    return {"requestId": row.request_id, "roundId": row.round_id, "force": bool(row.force)}


def report_remote_part(db: Session, machine: POSMachine, body: dict, *, now: Optional[datetime] = None) -> dict:
    """
    The remote machine's answer — the LAN close's report, sent to the cloud: `{requestId,
    roundId, machineId, outcome, shiftId, message, section}`. Taken only for its live
    request; a repeat is harmless; an interim answer ("waiting_card") never undoes a final one.
    """
    from app.models.shop_z_remote_part import ShopZRemotePart

    now = now or datetime.now(timezone.utc)
    rid = str(body.get("requestId") or "")[:64]
    outcome = str(body.get("outcome") or "")
    row = (
        db.query(ShopZRemotePart)
        .filter(ShopZRemotePart.request_id == rid, ShopZRemotePart.machine_id == machine.id)
        .first()
    )
    if row is None or row.state in ("superseded", "cancelled", "expired"):
        raise RemotePartRefused(status.HTTP_409_CONFLICT, {"detail": "unknown_request"})
    if outcome not in REMOTE_OUTCOMES:
        raise RemotePartRefused(status.HTTP_400_BAD_REQUEST, {"detail": "bad_outcome"})
    final = outcome in REMOTE_FINAL_OUTCOMES
    if row.state in ("reported", "taken") and not final:
        return _remote_out(row)
    if row.state == "taken":
        return _remote_out(row)
    row.outcome = outcome
    row.message = (str(body.get("message")) if body.get("message") is not None else None)
    row.report = {**body, "machineId": str(machine.id)}
    if final:
        row.state = "reported"
        row.reported_at = now
    elif row.state == "requested":
        row.state = "delivered"
        row.delivered_at = now
    db.flush()
    return _remote_out(row)


def take_remote_parts(db: Session, shop: Shop, z: ZReport) -> None:
    """The local shop Z took these remote parts (their shifts are on its paper)."""
    from app.models.shop_z_remote_part import ShopZRemotePart

    named: Dict[str, set] = {}
    for p in ((z.offline_report or {}).get("tills") or []):
        if isinstance(p, dict):
            named.setdefault(str(p.get("machineId")), set()).update(str(s) for s in p.get("shiftIds") or [])
    if not named:
        return
    for row in (
        db.query(ShopZRemotePart)
        .filter(ShopZRemotePart.shop_id == shop.id, ShopZRemotePart.state == "reported")
        .all()
    ):
        mid = str(row.machine_id)
        if mid not in named:
            continue
        section = (row.report or {}).get("section") or {}
        shifts = {str(s) for s in section.get("shiftIds") or []}
        if not shifts or shifts & named[mid]:
            row.state = "taken"
            row.z_report_id = z.id
    db.flush()
