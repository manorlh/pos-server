"""
Z runs: producing a shop's Z from the dashboard (shifts-plan §4.5, docs/SHIFTS_API.md §2).

An operator picks a shop and, per till, "up to which shift". A till that still has an
open shift is asked to close it (Ably now, the heartbeat on its next beat); its item
becomes ready only when that close is **accepted** — every document on the cloud. When
every item is ready or excluded the Z is built (`app.services.z_builder`). A till that
never answers can be left out (`proceed`), and an unfinished run expires after 36 h.

The till-facing half — acknowledgements, the heartbeat handover, completion on an
accepted close — is here too, behind `app.services.remote_close`.
"""
from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set

from fastapi import HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.models.z_run import (
    LIVE_ITEM_STATUSES,
    PENDING_ITEM_STATUSES,
    ZRun,
    ZRunItem,
    ZRunItemStatus,
    ZRunStatus,
)
from app.services.close_progress import documents_on_cloud, till_backlog
from app.services.machine_status import is_online
from app.services.shift_totals import compute_totals, till_totals_mismatch
from app.services.shifts import is_foreign_shift, shift_exists
from app.services.z_builder import (
    EMPTY_Z,
    EMPTY_Z_MESSAGE,
    Z_MODE_TILL,
    ZBuildRefused,
    build_z,
    shift_order_key,
    shifts_show_activity,
    unreported_shifts,
)

logger = logging.getLogger(__name__)

#: How long an unfinished run stays worth finishing — long enough for a till that is off
#: overnight, short enough that it cannot close a shift nobody expects a Z for any more.
Z_RUN_TTL_HOURS = 36

Z_SCOPE_SHOP = "shop"
Z_SCOPE_MACHINE = "machine"


def z_scope_of(tenant: Optional[Tenant]) -> str:
    """The tenant's `zScope` setting: one Z per shop (default) or one till per Z."""
    raw = ((tenant.settings or {}) if tenant is not None else {}).get("zScope")
    return Z_SCOPE_MACHINE if raw == Z_SCOPE_MACHINE else Z_SCOPE_SHOP


def per_till_ids(
    db: Session, machines: Sequence[POSMachine], tenant: Optional[Tenant] = None, shop: Optional[Shop] = None
) -> set:
    """
    The tills among these that produce their own Z (`zMode = till`, docs/SHIFTS_API.md
    §5): a shop Z neither takes them nor waits for them.
    """
    return {m.id for m in machines if getattr(m, "z_mode", None) == Z_MODE_TILL}


def tills_not_closed(db: Session, machines: Sequence[POSMachine]) -> List[dict]:
    """
    Of these tills, the ones a change of Z mode would cut through: an open shift, or
    closed shifts no Z has taken yet. The mode changes only over a clean break — every
    till closed and in a Z — so the first Z under the new mode starts from nothing
    (`app.services.till_z.set_z_mode`, the super admin's).
    """
    out = []
    for m in machines:
        if m.shop_id is None:
            continue
        cand = till_candidates(db, m, m.shop_id)
        if cand.open_shift is not None or cand.closed:
            out.append({
                "machineId": str(m.id),
                "posNumber": m.pos_number,
                "name": m.name,
                "openShift": cand.open_shift is not None,
                "awaitingZ": len(cand.closed),
            })
    return out


# ── Candidates ────────────────────────────────────────────────────────────────


def is_seated_in(machine: POSMachine, shop_id: uuid.UUID) -> bool:
    """An active till assigned to this shop right now — one that can be asked to close."""
    return (
        bool(machine.is_active)
        and machine.pairing_status == PairingStatus.ASSIGNED
        and str(machine.shop_id) == str(shop_id)
    )


def shop_tills(db: Session, shop_id: uuid.UUID) -> List[POSMachine]:
    """
    The tills a Z of this shop can take shifts from.

    Its active, assigned tills — and any other till, whatever its state, that still has
    closed shifts **of this shop** no Z has taken: one retired or unpaired, or moved to
    another shop, before that was refused while it had shifts awaiting a Z. Their shifts
    are fiscal data of this shop; left out, they could never reach a Z at all.
    """
    seated = (
        db.query(POSMachine)
        .filter(
            POSMachine.shop_id == shop_id,
            POSMachine.is_active.is_(True),
            POSMachine.pairing_status == PairingStatus.ASSIGNED,
        )
        .all()
    )
    seen = {m.id for m in seated}
    stranded_ids = [
        row[0]
        for row in db.query(Shift.machine_id)
        .filter(
            Shift.shop_id == shop_id,
            Shift.status == ShiftStatus.CLOSED,
            Shift.z_report_id.is_(None),
        )
        .distinct()
        .all()
        if row[0] not in seen
    ]
    stranded = (
        db.query(POSMachine).filter(POSMachine.id.in_(stranded_ids)).all() if stranded_ids else []
    )
    return sorted(
        seated + stranded,
        key=lambda m: (not is_seated_in(m, shop_id), m.pos_number or "", m.name or ""),
    )


def _live_items(db: Session, machine_ids: Sequence[uuid.UUID]) -> Dict[uuid.UUID, ZRunItem]:
    if not machine_ids:
        return {}
    rows = (
        db.query(ZRunItem)
        .join(ZRun, ZRun.id == ZRunItem.run_id)
        .filter(
            ZRunItem.machine_id.in_(list(machine_ids)),
            ZRunItem.status.in_(LIVE_ITEM_STATUSES),
            ZRun.status.in_([ZRunStatus.WAITING, ZRunStatus.BUILDING]),
        )
        .all()
    )
    return {item.machine_id: item for item in rows}


@dataclass
class TillCandidates:
    machine: POSMachine
    open_shift: Optional[Shift]
    closed: List[Shift]


def till_candidates(
    db: Session, machine: POSMachine, shop_id: Optional[uuid.UUID] = None
) -> TillCandidates:
    """This till's shifts awaiting a Z of `shop_id` (default: its current shop)."""
    shifts = unreported_shifts(db, machine.id, shop_id=shop_id or machine.shop_id)
    open_shift = next((s for s in shifts if s.status == ShiftStatus.OPEN), None)
    closed = [s for s in shifts if s.status == ShiftStatus.CLOSED]
    # Only closed shifts *before* any open one can be taken without closing it first.
    if open_shift is not None:
        closed = [s for s in closed if shift_order_key(s) < shift_order_key(open_shift)]
    return TillCandidates(machine=machine, open_shift=open_shift, closed=closed)


# ── Expiry ────────────────────────────────────────────────────────────────────


#: At expiry, what is left out of the Z so it can still be built with the ready tills.
LEFT_OUT_AT_EXPIRY = (ZRunItemStatus.EXCLUDED, ZRunItemStatus.EXPIRED, ZRunItemStatus.FAILED)


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=timezone.utc)


def expire_overdue_runs(db: Session, *, now: Optional[datetime] = None) -> int:
    """
    Finish what nobody finished within the TTL. Lazy — there is no scheduler here — and
    called from every read and write path, so an open dashboard sees it happen.

    The items still waiting for a till expire. If any till is ready, the Z is then built
    with the ready ones — the expired and failed tills are left out, their shifts wait
    for the next Z (no gap for them) — rather than leaving the run waiting forever for
    an operator to `proceed`. A run with nothing ready expires as a whole.

    Each run is locked and re-checked first: a till's close may be completing it at the
    same moment.
    """
    now = now or datetime.now(timezone.utc)
    runs = (
        db.query(ZRun)
        .filter(ZRun.status == ZRunStatus.WAITING, ZRun.expires_at < now)
        .all()
    )
    changed = 0
    for candidate in runs:
        run = lock_run(db, candidate)
        if run.status != ZRunStatus.WAITING or not (_aware(run.expires_at) < now):
            continue
        for item in run.items:
            if item.status in PENDING_ITEM_STATUSES:
                item.status = ZRunItemStatus.EXPIRED
                item.error_code = "expired"
                item.error_message = "The till did not close its shift in time"
                item.failed_at = now
                changed += 1
        if getattr(run, "strict_cloud_check", False) or _all_tills_required(db, run):
            # A shop Z from the master till never goes without a till the operator did not
            # defer: built now only if every till still checks out, else expired whole.
            # Nor does any shop Z in local mode (docs/SPEC_INDEPENDENT_TILL.md §8).
            db.flush()
            expired_any = any(i.status == ZRunItemStatus.EXPIRED for i in run.items)
            if not expired_any and finalise_if_ready(db, run, now=now):
                changed += 1
                continue
            run = lock_run(db, run)
            if run.status == ZRunStatus.WAITING:
                run.status = ZRunStatus.EXPIRED
                run.error_code = "expired"
                run.error_message = "The shop Z was not finished in time: not every till was confirmed by the cloud"
            changed += 1
            continue
        if any(i.status == ZRunItemStatus.READY for i in run.items):
            db.flush()
            finalise_if_ready(db, run, now=now, left_out=LEFT_OUT_AT_EXPIRY)
            changed += 1
        else:
            run.status = ZRunStatus.EXPIRED
            run.error_code = "expired"
            run.error_message = "The Z run was not finished in time"
            changed += 1
    # A run already stalled before `end_if_stalled` ran on its tills' answers.
    for candidate in db.query(ZRun).filter(ZRun.status == ZRunStatus.WAITING).all():
        if _stalled(candidate) and end_if_stalled(db, candidate):
            changed += 1
    if changed:
        db.flush()
    return changed


#: A till's refusal in words, for the run's message (the till's own codes, §close-shift).
_FAILED_REASONS = {
    "open_tables": "יש בה שולחנות פתוחים",
    "no_open_shift": "אין בה משמרת פתוחה",
    "unknown_shift": "המשמרת בה השתנתה",
    "shift_changed": "המשמרת בה השתנתה",
    "shift_belongs_to_another_machine": "המשמרת שייכת לקופה אחרת",
    "expired": "לא נסגרה בזמן",
}
#: The till's English detail before the list it names ("open tables: 3, מנור").
_OPEN_TABLES_PREFIX = "open tables:"
TILLS_FAILED = "tills_failed"


def _stalled(run: ZRun) -> bool:
    """No till is still closing and none is ready, and one failed: nothing can move it."""
    statuses = [i.status for i in run.items]
    if any(s in PENDING_ITEM_STATUSES or s == ZRunItemStatus.READY for s in statuses):
        return False
    return any(s in (ZRunItemStatus.FAILED, ZRunItemStatus.EXPIRED) for s in statuses)


def _failure_text(item: ZRunItem) -> str:
    machine = item.machine
    name = (machine.name or "").strip() if machine is not None else ""
    if machine is not None and (machine.pos_number or "").strip():
        name = f"{name} #{machine.pos_number.strip()}".strip()
    name = name or "קופה"
    reason = _FAILED_REASONS.get(item.error_code or "", "הסגירה נכשלה")
    detail = (item.error_message or "").strip()
    if item.error_code == "open_tables" and detail.lower().startswith(_OPEN_TABLES_PREFIX):
        reason += f" ({detail[len(_OPEN_TABLES_PREFIX):].strip()})"
    return f"{name}: {reason}"


def end_if_stalled(db: Session, run: ZRun) -> bool:
    """
    End a run that nothing can move any more: every till failed (open tables on it, no
    open shift, …) or was left out, so no close is on its way and nothing is ready to
    build. It would otherwise wait for its TTL behind a "producing the Z" screen with no
    way on, holding the shop's next Z. It fails now with the tills' reasons; their
    shifts stay as they are, and a new Z can start once the reason is fixed.

    A run with a ready till is not ended here: the operator may still build it without
    the failed ones (`proceed_without`).
    """
    run = lock_run(db, run)
    if run.status != ZRunStatus.WAITING or not _stalled(run):
        return False
    failed = [i for i in run.items if i.status in (ZRunItemStatus.FAILED, ZRunItemStatus.EXPIRED)]
    run.status = ZRunStatus.FAILED
    run.error_code = TILLS_FAILED
    run.error_message = "; ".join(_failure_text(i) for i in failed) + ". מתקנים ומתחילים שוב."
    db.flush()
    logger.info("Z run %s ended: %s", run.id, run.error_message)
    return True


# ── Create ────────────────────────────────────────────────────────────────────


@dataclass
class MachineSelection:
    machine_id: uuid.UUID
    through_shift_id: Optional[uuid.UUID] = None
    include_open_shift: Optional[bool] = None


def _reported_open_is_live(db: Session, machine: POSMachine) -> bool:
    """
    The till says it has a shift open that the cloud may not have heard of yet.

    Ignored when the cloud already holds that shift closed: the claim is only refreshed
    on the next heartbeat, and a close-shift instruction for a closed shift would never
    be answered. Ignored too when the shift is another till's.
    """
    claimed = machine.reported_open_shift_id
    if claimed is None:
        return False
    known = db.query(Shift.status, Shift.machine_id).filter(Shift.id == claimed).first()
    if known is not None and str(known[1]) != str(machine.id):
        # Another till's shift (the heartbeat drops such a claim; this covers one stored
        # before it did): this till could never close it — its close is 403.
        return False
    return known is None or known[0] == ShiftStatus.OPEN


def named_shift_id(item: ZRunItem) -> Optional[uuid.UUID]:
    """
    The shift this item asks the till to close: the cloud's row once it has one, else
    the id the till claimed (`claimed_shift_id`, no foreign key — the cloud may not
    have seen that shift yet).
    """
    return item.close_shift_id or item.claimed_shift_id


def _name_shift(db: Session, item: ZRunItem, shift_id: Optional[uuid.UUID]) -> None:
    """Name `shift_id` on the item: in the keyed column if the cloud holds it, else as a claim."""
    if shift_id is None:
        return
    if shift_exists(db, shift_id):
        item.close_shift_id = shift_id
    else:
        item.claimed_shift_id = shift_id


def _initiator(user: User) -> str:
    return user.username or user.email or str(user.id)


def _send_close(machine: POSMachine, item: ZRunItem, user: User, now: datetime) -> None:
    from app.services.ably_notify import is_enabled, publish_close_shift_notify

    if not machine.tenant_id or not is_online(machine.last_heartbeat_at, now=now):
        # Offline is a delay, not a failure: the till collects it on its next heartbeat.
        return
    publish_close_shift_notify(
        str(machine.tenant_id),
        str(machine.id),
        str(item.id),
        str(named_shift_id(item)) if named_shift_id(item) else None,
        _initiator(user),
        force=bool(getattr(item.run, "force_close", False)),
    )
    # "Sent" only when realtime really carried it: without Ably the publish is skipped, and
    # the heartbeat that hands the close over stamps it (`take_pending_close_shift`) — so a
    # run's timeline shows when the till actually got its command.
    if is_enabled():
        item.sent_at = now


# ── Tills a shop Z leaves out ─────────────────────────────────────────────────

#: The `error_code` of a marker item: a till this run was confirmed to go without
#: (`shopZOpenTills` = "allowed with the operator's confirmation"). Always EXCLUDED, never
#: sent to the till and never built from — it only carries the confirmation from the
#: request that started the run to the build, which may come hours later, and is shown
#: on the run (`openTillsLeftOut`) rather than among its items.
LEFT_OUT_CODE = "open_till_left_out"


@dataclass
class LeftOutTill:
    machine: POSMachine
    #: The open shift left open (the cloud's row, else the one the till claims); None
    #: when only closed shifts are left behind.
    open_shift_id: Optional[uuid.UUID]

    def to_json(self) -> dict:
        return {
            "id": str(self.machine.id),
            "posNumber": self.machine.pos_number,
            "name": self.machine.name,
            "openShiftId": str(self.open_shift_id) if self.open_shift_id else None,
        }


def _open_shift_of(db: Session, machine: POSMachine, cand: TillCandidates, shop_id) -> Optional[uuid.UUID]:
    """The till's open shift as a run would ask it to close, or None if it has none."""
    if not is_seated_in(machine, shop_id):
        return None
    if cand.open_shift is not None:
        return cand.open_shift.id
    if _reported_open_is_live(db, machine):
        return machine.reported_open_shift_id
    return None


def tills_left_out(
    db: Session,
    user: User,
    shop: Shop,
    tills: Dict[uuid.UUID, POSMachine],
    selections: Dict[uuid.UUID, MachineSelection],
    *,
    area=None,
    own_z: Optional[set] = None,
) -> List[LeftOutTill]:
    """
    The tills of the shop this Z would leave something behind on: a selected till whose
    open shift is not being closed into it, and an unselected till with an open shift or
    closed shifts awaiting a Z.

    Bounded the way the candidates are: an area's Z looks at that area's tills only, a
    distributor at their own terminals only. A till another run is already producing a
    Z for is that run's business, not this one's — and so is a till that produces its own
    Z (`own_z`, `zMode = till`): a shop Z never waits for it.
    """
    own_z = own_z or set()
    considered = [
        m for m in tills.values()
        if (area is None or (str(m.area_id) == str(area.id) and is_seated_in(m, shop.id)))
        and (m.id in selections or m.id not in own_z)
    ]
    if user.role == UserRole.DISTRIBUTOR:
        considered = [m for m in considered if str(m.distributor_id) == str(user.id)]
    busy = _live_items(db, [m.id for m in considered if m.id not in selections])

    left: List[LeftOutTill] = []
    for machine in considered:
        if machine.id in busy:
            continue
        cand = till_candidates(db, machine, shop.id)
        open_id = _open_shift_of(db, machine, cand, shop.id)
        sel = selections.get(machine.id)
        if sel is not None:
            leaves_open = open_id is not None and sel.include_open_shift is False
            if leaves_open:
                left.append(LeftOutTill(machine=machine, open_shift_id=open_id))
        elif open_id is not None or cand.closed:
            left.append(LeftOutTill(machine=machine, open_shift_id=open_id))
    return left


def open_tills_rule(db: Session, tenant: Optional[Tenant], shop: Shop) -> Optional[str]:
    """
    `shopZOpenTills` for this shop: "block" or "confirm"; None when it does not apply —
    one till per Z (the tenant's `zScope`), or the parameter missing or deactivated by a
    super admin.

    A value that is neither option (one renamed since) reads as "confirm": the rule
    still holds, the gentler way.
    """
    if z_scope_of(tenant) != Z_SCOPE_SHOP:
        return None
    from app.services import till_parameters as TP
    from app.services.local_shop_z import local_mode_of_shop

    if local_mode_of_shop(db, shop):
        # Local mode (a main till on the LAN, docs/SPEC_INDEPENDENT_TILL.md §8): every
        # participating till is in the shop Z — never left out on a confirmation.
        return "block"
    value = TP.resolve_for_shop(db, shop).get(TP.SHOP_Z_OPEN_TILLS_KEY)
    if value is None:
        return None
    return "block" if value == TP.SHOP_Z_OPEN_TILLS_BLOCK else "confirm"


def check_open_tills(
    db: Session,
    tenant: Optional[Tenant],
    shop: Shop,
    left_out: Sequence[LeftOutTill],
    *,
    confirmed: bool,
) -> bool:
    """
    Refuse a shop Z the rule does not allow (409); True when it goes ahead on the
    operator's confirmation, and so the tills it goes without are to be recorded.
    """
    if not left_out:
        return False
    rule = open_tills_rule(db, tenant, shop)
    if rule is None:
        return False
    tills = [t.to_json() for t in left_out]
    if rule == "block":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "open_tills_block_z", "tills": tills},
        )
    if not confirmed:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "open_tills_need_confirmation", "tills": tills},
        )
    return True


def _left_out_marker(run: ZRun, till: LeftOutTill) -> ZRunItem:
    return ZRunItem(
        id=uuid.uuid4(),
        run_id=run.id,
        machine_id=till.machine.id,
        include_open_shift=False,
        status=ZRunItemStatus.EXCLUDED,
        error_code=LEFT_OUT_CODE,
        error_message=json.dumps(till.to_json(), ensure_ascii=False),
    )


def is_left_out_marker(item: ZRunItem) -> bool:
    return item.error_code == LEFT_OUT_CODE and item.status == ZRunItemStatus.EXCLUDED


def open_tills_left_out(db: Session, run: ZRun) -> Optional[dict]:
    """
    The confirmation a run was started with: the tills it went without, and who
    confirmed it (the operator who started the run — the confirmation is part of that
    request) and when. None for a run that needed none.
    """
    markers = [i for i in run.items if is_left_out_marker(i)]
    if not markers:
        return None
    tills = []
    for item in markers:
        try:
            tills.append(json.loads(item.error_message or "{}"))
        except ValueError:
            tills.append({"id": str(item.machine_id), "posNumber": None, "name": None, "openShiftId": None})
    confirmer = db.query(User).filter(User.id == run.created_by_user_id).first()
    # Started from a master till: the till user who typed the confirmation, as stamped on
    # the markers (app/routers/till_shop_z.py) — not the user the run is filed under.
    stamped = next((t.get("confirmedBy") for t in tills if isinstance(t, dict) and t.get("confirmedBy")), None)
    # A till deferred with "סגור" while the run waited carries its own moment.
    stamped_at = next((t.get("confirmedAt") for t in tills if isinstance(t, dict) and t.get("confirmedAt")), None)
    return {
        "tills": tills,
        "confirmedByUserId": str(run.created_by_user_id) if run.created_by_user_id else None,
        "confirmedByName": stamped or (_initiator(confirmer) if confirmer is not None else None),
        "confirmedAt": stamped_at or (_aware(run.created_at).isoformat() if run.created_at else None),
    }


# ── No Z on nothing ───────────────────────────────────────────────────────────


def _reported_pending_documents(machine: Optional[POSMachine]) -> int:
    """The till's own last count of documents not yet sent (a reading, not live)."""
    if machine is None:
        return 0
    pending = machine.pending_documents
    if pending is None:
        pending = machine.pending_count
    try:
        return max(int(pending or 0), 0)
    except (TypeError, ValueError):
        return 0


def _item_shifts(db: Session, run: ZRun, item: ZRunItem) -> List[Shift]:
    """The shifts the Z would take for this item, as the cloud holds them now."""
    shifts = unreported_shifts(db, item.machine_id, shop_id=run.shop_id)
    if item.status == ZRunItemStatus.READY and item.through_shift_id is not None:
        ids = [s.id for s in shifts]
        if item.through_shift_id in ids:
            return shifts[: ids.index(item.through_shift_id) + 1]
    # A till asked to close: every un-Z'd shift of it here, the open one included.
    return shifts


def run_may_have_activity(
    db: Session, run: ZRun, machines: Optional[Dict[uuid.UUID, POSMachine]] = None
) -> bool:
    """
    Whether the Z this run would build can have anything in it: activity in the shifts
    it would take (`shifts_show_activity`), or a till it asks to close that says it has
    documents not yet on the cloud. False is a run that could only end in "nothing to
    report" — no Z on 0.
    """
    per_till: List[List[Shift]] = []
    for item in run.items:
        if item.status == ZRunItemStatus.EXCLUDED:
            continue
        if item.status in PENDING_ITEM_STATUSES:
            machine = (machines or {}).get(item.machine_id) or item.machine
            if _reported_pending_documents(machine) > 0:
                return True
        per_till.append(_item_shifts(db, run, item))
    return shifts_show_activity(db, per_till)


def shop_activity(db: Session, shop_id: uuid.UUID, machines: Sequence[POSMachine]) -> dict:
    """
    What a shop Z of these tills could report, as the cloud knows it now — what the
    master till asks before it offers to start one. Per till: the documents in its shifts
    no Z has taken (open ones too) and whether they show activity; and the documents the
    tills say they still have to send. `hasActivity` false: no Z on 0.
    """
    from app.services.shift_totals import compute_totals as _totals
    from app.services.z_builder import figures_show_activity, z_cash_summary

    tills: Dict[str, dict] = {}
    any_activity = False
    documents = 0
    pending = 0
    for machine in machines:
        shifts = unreported_shifts(db, machine.id, shop_id=shop_id)
        totals = _totals(db, [s.id for s in shifts]) if shifts else None
        count = (totals.transactions_count + totals.non_sale_count) if totals is not None else 0
        active = bool(shifts) and figures_show_activity(
            totals, z_cash_summary([shifts])["between_shifts"]
        )
        waiting = _reported_pending_documents(machine) if is_seated_in(machine, shop_id) else 0
        tills[str(machine.id)] = {"documents": count, "pendingDocuments": waiting, "active": active}
        any_activity = any_activity or active or waiting > 0
        documents += count
        pending += waiting
    return {
        "hasActivity": any_activity,
        "documents": documents,
        "pendingDocuments": pending,
        "message": None if any_activity else EMPTY_Z_MESSAGE,
        "tills": tills,
    }


def create_z_run(
    db: Session,
    user: User,
    tenant: Tenant,
    shop: Shop,
    selections: Sequence[MachineSelection],
    *,
    business_date: Optional[date] = None,
    area_id: Optional[uuid.UUID] = None,
    confirm_open_tills: bool = False,
    strict_cloud_check: bool = False,
    force: bool = False,
    now: Optional[datetime] = None,
) -> ZRun:
    """
    Start a run (and build at once when nothing needs closing). Raises HTTPException.

    `strict_cloud_check` (a shop Z from the master till): the Z is built only once the
    cloud has verified every till (`verify_item`), whenever that happens.

    A shop Z that leaves tills behind (`tills_left_out`) is subject to the shop's
    `shopZOpenTills` parameter: refused outright, or refused until the request carries
    `confirm_open_tills` — and then the tills it goes without are recorded on the run
    and frozen into the Z's header (`openTillsLeftOut`).

    With `area_id`, a Z for that area of the shop: the area must be a live one of this
    shop and every listed till must be in it now. Nothing else changes — the same shop
    number, the same through-shift rules, the same remote close. Each till's shifts are
    taken whatever area they are stamped with (a till moved mid-cycle): the Z is about
    the till, the area reports are about the stamp.
    """
    now = now or datetime.now(timezone.utc)
    expire_overdue_runs(db, now=now)

    area = None
    if area_id is not None:
        from app.services.areas import area_in_shop, refuse_archived

        area = area_in_shop(db, area_id, shop.id)
        refuse_archived(area)

    if not selections:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="no_machines")
    wanted = list(dict.fromkeys(sel.machine_id for sel in selections))
    if z_scope_of(tenant) == Z_SCOPE_MACHINE and len(wanted) > 1:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="z_scope_machine_one_till"
        )

    tills = {m.id: m for m in shop_tills(db, shop.id)}
    # A till in `zMode = till` makes its own Z: the shop's Z neither takes it (refused
    # below) nor waits for it.
    own_z = per_till_ids(db, list(tills.values()), tenant, shop)
    for machine_id in wanted:
        if machine_id not in tills:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=f"machine_not_in_shop:{machine_id}"
            )
    for machine_id in wanted:
        if getattr(tills[machine_id], "z_mode", None) == Z_MODE_TILL:
            # It produces its own Z (docs/SHIFTS_API.md §5): the shop's Z never takes it.
            from app.services.till_z import TillZRefused

            raise TillZRefused(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {"detail": "machine_issues_its_own_z", "machineId": str(machine_id)},
            )
    if area is not None:
        for machine_id in wanted:
            if str(tills[machine_id].area_id) != str(area.id):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"machine_not_in_area:{machine_id}",
                )

    live = _live_items(db, wanted)
    if live:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"z_run_in_progress:{next(iter(live.values())).run_id}",
        )

    # "חסימת סגירת יום עם שולחנות פתוחים": 409 `open_tables_block_z` with the tables.
    from app.services.tables import refuse_z_with_open_tables

    refuse_z_with_open_tables(db, shop, area.id if area is not None else None)

    by_id = {sel.machine_id: sel for sel in selections}
    left_out = tills_left_out(db, user, shop, tills, by_id, area=area, own_z=own_z)
    record_left_out = check_open_tills(db, tenant, shop, left_out, confirmed=confirm_open_tills)

    run = ZRun(
        id=uuid.uuid4(),
        tenant_id=tenant.id,
        shop_id=shop.id,
        area_id=area.id if area is not None else None,
        created_by_user_id=user.id,
        status=ZRunStatus.WAITING,
        business_date=business_date,
        expires_at=now + timedelta(hours=Z_RUN_TTL_HOURS),
        strict_cloud_check=bool(strict_cloud_check),
        # "כפה סגירה (גם באמצע מכירה)" (docs/SPEC_OFFLINE_TILL_Z.md §9).
        force_close=bool(force),
    )
    db.add(run)
    db.flush()

    to_notify: List[tuple] = []
    for machine_id in wanted:
        sel = by_id[machine_id]
        machine = tills[machine_id]
        cand = till_candidates(db, machine, shop.id)
        # Only a till seated in this shop can be asked to close a shift; one retired or
        # moved away is here for its closed shifts alone.
        reported_open = is_seated_in(machine, shop.id) and _reported_open_is_live(db, machine)
        has_open = is_seated_in(machine, shop.id) and (cand.open_shift is not None or reported_open)
        include_open = has_open if sel.include_open_shift is None else bool(sel.include_open_shift)
        include_open = include_open and has_open

        item = ZRunItem(id=uuid.uuid4(), run_id=run.id, machine_id=machine_id, include_open_shift=include_open)
        if include_open:
            if sel.through_shift_id is not None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST, detail="through_shift_with_open_shift"
                )
            item.status = ZRunItemStatus.WAITING_CLOSE
            _name_shift(
                db,
                item,
                cand.open_shift.id if cand.open_shift is not None else machine.reported_open_shift_id,
            )
            item.through_shift_id = cand.open_shift.id if cand.open_shift is not None else None
            to_notify.append((machine, item))
        elif sel.through_shift_id is not None:
            if sel.through_shift_id not in {s.id for s in cand.closed}:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"through_shift_not_candidate:{machine_id}",
                )
            item.status = ZRunItemStatus.READY
            item.through_shift_id = sel.through_shift_id
            item.ready_at = now
        elif cand.closed:
            item.status = ZRunItemStatus.READY
            item.through_shift_id = cand.closed[-1].id
            item.ready_at = now
        else:
            item.status = ZRunItemStatus.EXCLUDED
            item.error_code = "nothing_to_report"
            item.error_message = "No closed shift waiting for a Z"
        db.add(item)

    if record_left_out:
        for till in left_out:
            db.add(_left_out_marker(run, till))

    db.flush()
    db.refresh(run)
    if all(i.status == ZRunItemStatus.EXCLUDED for i in run.items):
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="nothing_to_report")
    # No Z on nothing ("אל תאפשר לסגור Z על 0"): when the cloud already knows that the
    # shifts this run would take have no activity, and no till it would close says it has
    # documents still to send, refuse now — before any till closes a shift for a Z that
    # could not be made. (The build refuses it too, whatever comes in meanwhile.)
    if not run_may_have_activity(db, run, tills):
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": EMPTY_Z, "message": EMPTY_Z_MESSAGE},
        )

    for machine, item in to_notify:
        _send_close(machine, item, user, now)
    finalise_if_ready(db, run, now=now)
    return run


# ── Strict cloud verification (a shop Z from the master till) ─────────────────
#
# "Don't close the Z until the cloud confirms every till is closed." A strict run builds
# only when, for every till it takes, each shift the Z would take is closed on the cloud,
# its close accepted, and the till's own figures at the close (its count of documents and
# its totals) agree with the documents the cloud holds — every sale is here. A till that
# does not check out keeps the run waiting (`waiting_transactions` on its item) and is
# looked at again on every poll and whenever a late document of its shifts arrives. The
# only way past it is the operator's typed "סגור", which defers the till to the next Z
# and records who decided (`proceed_without(..., deferred_by=...)`).

#: A ready till whose close disagrees with the cloud's documents: waiting for them.
WAITING_TRANSACTIONS = "waiting_transactions"
#: Everything the verification writes on an item, and clears once the till checks out.
VERIFY_CODES = (WAITING_TRANSACTIONS, "shift_not_closed", "close_not_accepted")
#: The marker of a till the operator deferred with "סגור" while the run waited for it.
DEFERRED_BY_OPERATOR = "excluded_by_operator"


@dataclass
class ItemCheck:
    """The cloud's own word on one ready till: may its shifts go into the Z now?"""

    ok: bool
    code: Optional[str] = None
    #: Σ the till's own `transactionsCount` at its closes (None: it sent no figures).
    till_documents: Optional[int] = None
    #: Σ the documents the cloud counts for the same shifts (sales and credit notes).
    cloud_documents: Optional[int] = None


def _int_or_none(value) -> Optional[int]:
    try:
        return None if value is None else int(float(value))
    except (TypeError, ValueError):
        return None


def verify_item(db: Session, run: ZRun, item: ZRunItem) -> ItemCheck:
    """
    Verify a ready item against the cloud: every shift the Z would take of this till
    (its un-Z'd shifts of the run's shop, oldest first, through the item's shift) is
    closed, its close accepted, and the figures the till filed with the close agree with
    the documents the cloud holds (`till_totals_mismatch`, the count included). A close
    that carried no figures claims nothing and is taken as the cloud holds it (an
    administrative close, an older till build).

    A through shift that is no longer waiting is not this check's business: the build
    refuses it (`through_shift_unavailable`) as before.
    """
    if item.status != ZRunItemStatus.READY or item.through_shift_id is None:
        return ItemCheck(ok=item.status == ZRunItemStatus.READY)
    shifts = unreported_shifts(db, item.machine_id, shop_id=run.shop_id)
    ids = [s.id for s in shifts]
    if item.through_shift_id not in ids:
        return ItemCheck(ok=True)
    till_documents: Optional[int] = None
    cloud_documents = 0
    mismatch = False
    for shift in shifts[: ids.index(item.through_shift_id) + 1]:
        if shift.status != ShiftStatus.CLOSED:
            return ItemCheck(ok=False, code="shift_not_closed")
        if shift.close_accepted_at is None:
            return ItemCheck(ok=False, code="close_not_accepted")
        totals = compute_totals(db, [shift.id])
        cloud_documents += totals.transactions_count
        claimed = shift.till_totals if isinstance(shift.till_totals, dict) else None
        if not claimed:
            continue
        count = _int_or_none(claimed.get("transactionsCount"))
        if count is not None:
            till_documents = (till_documents or 0) + count
        if till_totals_mismatch(claimed, totals):
            mismatch = True
    if mismatch:
        return ItemCheck(
            ok=False, code=WAITING_TRANSACTIONS,
            till_documents=till_documents, cloud_documents=cloud_documents,
        )
    return ItemCheck(ok=True, till_documents=till_documents, cloud_documents=cloud_documents)


def _check_message(check: ItemCheck) -> str:
    if check.code == WAITING_TRANSACTIONS:
        if check.till_documents is not None and check.cloud_documents is not None:
            return (
                f"Waiting for transactions: the till counted {check.till_documents}, "
                f"the cloud holds {check.cloud_documents}"
            )
        return "Waiting for transactions: the till's totals disagree with the cloud's documents"
    if check.code == "shift_not_closed":
        return "A shift of this till is not closed on the cloud yet"
    return "The till's close has not been accepted by the cloud yet"


def _strict_check(db: Session, run: ZRun) -> bool:
    """
    A strict run's last word before the build: True when every ready till checks out.
    A till that does not keeps its reason on its item (and loses it once it does).
    """
    ok = True
    for item in run.items:
        if item.status != ZRunItemStatus.READY:
            continue
        check = verify_item(db, run, item)
        if check.ok:
            if item.error_code in VERIFY_CODES:
                item.error_code = None
                item.error_message = None
            continue
        ok = False
        if item.error_code != check.code:
            logger.info("Z run %s waits for till %s: %s", run.id, item.machine_id, check.code)
        item.error_code = check.code
        item.error_message = _check_message(check)
    db.flush()
    return ok


def retry_strict_runs(db: Session, machine_ids: Iterable[uuid.UUID], *, now: Optional[datetime] = None) -> int:
    """
    Documents landed in closed shifts of these tills: a strict run that was waiting for
    them may build now. Never raises past a failed build (`finalise_if_ready`). Returns
    how many runs were built.
    """
    ids = list({m for m in machine_ids if m is not None})
    if not ids:
        return 0
    runs = (
        db.query(ZRun)
        .join(ZRunItem, ZRunItem.run_id == ZRun.id)
        .filter(
            ZRun.status == ZRunStatus.WAITING,
            ZRun.strict_cloud_check.is_(True),
            ZRunItem.machine_id.in_(ids),
            ZRunItem.status == ZRunItemStatus.READY,
        )
        .distinct()
        .all()
    )
    return sum(1 for run in runs if finalise_if_ready(db, run, now=now))


# ── The fast heartbeat while a shop Z is about ───────────────────────────────

#: The master till's "סגירת Z סניפי" screen polls every few seconds while it is open;
#: each poll keeps its shop on the fast beat this much longer.
SHOP_Z_SCREEN_TTL = timedelta(seconds=45)
#: A waiting run keeps its shop's tills on the fast beat for its first minutes.
FAST_BEAT_RUN_WINDOW = timedelta(minutes=10)


def note_shop_z_screen(machine: POSMachine, *, now: Optional[datetime] = None) -> None:
    """The master till has the shop Z screen open (it polled just now)."""
    machine.shop_z_screen_until = (now or datetime.now(timezone.utc)) + SHOP_Z_SCREEN_TTL


def shop_z_fast_beat(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> bool:
    """
    Should this till beat fast (every few seconds) now?

    While its shop's master till has the shop Z screen open, and for the first minutes of
    a run waiting in its shop. Without realtime the heartbeat is how a close reaches a
    till, and at its ordinary 30 s a shop Z would wait up to that long per till; the
    screen being open first means the tills are already beating fast when the operator
    presses the button. Cheap: two indexed lookups, on the shop.
    """
    if machine.shop_id is None:
        return False
    now = now or datetime.now(timezone.utc)
    screen = (
        db.query(POSMachine.id)
        .filter(POSMachine.shop_id == machine.shop_id, POSMachine.shop_z_screen_until > now)
        .first()
    )
    if screen is not None:
        return True
    run = (
        db.query(ZRun.id)
        .filter(
            ZRun.shop_id == machine.shop_id,
            ZRun.status == ZRunStatus.WAITING,
            ZRun.created_at > now - FAST_BEAT_RUN_WINDOW,
        )
        .first()
    )
    return run is not None


# ── Finalise / proceed / cancel ───────────────────────────────────────────────


def _selections(db: Session, run: ZRun):
    ready = [i for i in run.items if i.status == ZRunItemStatus.READY]
    machines = {
        m.id: m
        for m in db.query(POSMachine).filter(POSMachine.id.in_([i.machine_id for i in ready])).all()
    } if ready else {}
    return [(machines[i.machine_id], i.through_shift_id) for i in ready]


def lock_run(db: Session, run: ZRun) -> ZRun:
    """
    Re-read `run` and its items under a row lock on the run.

    Two tills whose closes complete a run at the same moment would otherwise each see the
    other's item still closing and neither would build; a dashboard poll and a till close
    could both build. Serialising on the run row, and reading the items fresh after the
    lock, makes exactly one of them see the whole picture.
    """
    db.flush()
    locked = (
        db.query(ZRun)
        .filter(ZRun.id == run.id)
        .populate_existing()
        .with_for_update()
        .one()
    )
    db.query(ZRunItem).filter(ZRunItem.run_id == locked.id).populate_existing().all()
    return locked


def finalise_if_ready(
    db: Session,
    run: ZRun,
    *,
    now: Optional[datetime] = None,
    left_out: Sequence[str] = (ZRunItemStatus.EXCLUDED,),
) -> bool:
    """
    Build the Z when every item is ready or excluded. Returns True if it was built.

    Never raises for a failed build — a refusal, or anything else (a database error,
    a bug): the run is marked failed with the reason, and the caller's own work (a till's
    accepted close, above all) still commits. The build runs in a savepoint so a failure
    leaves nothing of it behind. A till whose close raised here would retry it forever.

    A strict run (a shop Z from the master till) is first verified against the cloud
    (`_strict_check`): while any ready till does not check out it is not built — it
    waits, and is tried again on the next poll or late document.
    """
    run = lock_run(db, run)
    if run.status != ZRunStatus.WAITING:
        return False
    statuses = [i.status for i in run.items]
    if not statuses or any(s != ZRunItemStatus.READY and s not in left_out for s in statuses):
        return False
    if not any(s == ZRunItemStatus.READY for s in statuses):
        return False
    now = now or datetime.now(timezone.utc)
    if getattr(run, "strict_cloud_check", False):
        checkpoint = db.begin_nested()
        try:
            verified = _strict_check(db, run)
            checkpoint.commit()
        except Exception:  # noqa: BLE001 - the caller's close must still commit
            _rollback_savepoint(checkpoint)
            logger.exception("Z run %s: the cloud verification failed; the run waits", run.id)
            return False
        if not verified:
            return False
    savepoint = db.begin_nested()
    try:
        z = build_z(
            db,
            tenant_id=run.tenant_id,
            shop_id=run.shop_id,
            selections=_selections(db, run),
            created_by_user_id=run.created_by_user_id,
            z_run_id=run.id,
            business_date=run.business_date,
            area_id=run.area_id,
            open_tills_left_out=open_tills_left_out(db, run),
            now=now,
        )
        savepoint.commit()
    except ZBuildRefused as refused:
        savepoint.rollback()
        logger.warning("Z run %s refused: %s (%s)", run.id, refused.code, refused.message)
        # Nothing to report is an end of its own, not a failure: no Z, no number drawn, and
        # the shifts stay closed for whichever later Z has activity.
        run.status = ZRunStatus.EMPTY if refused.code == EMPTY_Z else ZRunStatus.FAILED
        run.error_code = refused.code
        run.error_message = refused.message
        db.flush()
        return False
    except Exception as exc:  # noqa: BLE001 - see the docstring
        _rollback_savepoint(savepoint)
        logger.exception("Z run %s build failed", run.id)
        run.status = ZRunStatus.FAILED
        run.error_code = "build_error"
        run.error_message = f"The Z could not be built: {type(exc).__name__}"
        db.flush()
        return False
    run.status = ZRunStatus.COMPLETED
    run.z_report_id = z.id
    run.completed_at = now
    db.flush()
    return True


def _rollback_savepoint(savepoint) -> None:
    """
    Roll a failed savepoint back even when SQLAlchemy has already deactivated it.

    `is_active` is False after a failed flush, yet the savepoint is not rolled back and
    the session stays unusable (PendingRollbackError) until it is — so checking
    `is_active` first, as looked natural, left the till's close to fail on commit.
    """
    from sqlalchemy.exc import ResourceClosedError

    try:
        savepoint.rollback()
    except ResourceClosedError:
        pass


def _require_waiting(run: ZRun) -> None:
    if run.status != ZRunStatus.WAITING:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="run_not_waiting")


def _deferred_marker(run: ZRun, item: ZRunItem, operator: str, now: datetime) -> ZRunItem:
    """
    A left-out marker (`LEFT_OUT_CODE`) for a till the operator deferred with "סגור"
    while the run waited for it: frozen into the Z's header (`openTillsLeftOut`) with who
    decided and when, exactly as a confirmation given at the start is.
    """
    machine = item.machine
    pending = item.status in PENDING_ITEM_STATUSES
    data = {
        "id": str(item.machine_id),
        "posNumber": machine.pos_number if machine is not None else None,
        "name": machine.name if machine is not None else None,
        "openShiftId": str(named_shift_id(item)) if pending and named_shift_id(item) else None,
        "reason": item.error_code if not pending else "not_closed",
        "deferred": True,
        "confirmedBy": operator,
        "confirmedAt": now.isoformat(),
    }
    return ZRunItem(
        id=uuid.uuid4(),
        run_id=run.id,
        machine_id=item.machine_id,
        include_open_shift=False,
        status=ZRunItemStatus.EXCLUDED,
        error_code=LEFT_OUT_CODE,
        error_message=json.dumps(data, ensure_ascii=False),
    )


def proceed_without(
    db: Session,
    run: ZRun,
    exclude_machine_ids: Iterable[uuid.UUID],
    *,
    now: Optional[datetime] = None,
    deferred_by: Optional[str] = None,
) -> ZRun:
    """
    Build now without the listed tills; their shifts wait for the next Z (no gap).

    Only a till that is **not** ready is left out: a ready till named in the list stays
    in (the list is "the tills I am giving up on waiting for", and a stale screen must
    not silently drop a till whose shifts were ready to go). On a strict run, a ready
    till the cloud has not verified (`verify_item`) is not ready in this sense.

    `deferred_by` (the master till's operator who typed "סגור"): each till left out here
    is recorded on the Z as left out, with who decided and when.
    """
    now = now or datetime.now(timezone.utc)
    expire_overdue_runs(db, now=now)
    run = lock_run(db, run)
    _require_waiting(run)
    strict = bool(getattr(run, "strict_cloud_check", False))
    excluded = set(exclude_machine_ids)
    required = _all_tills_required(db, run) if excluded else None
    if required:
        # "חובה לסגור את כל הקופות" (and always in local mode, docs/SPEC_INDEPENDENT_TILL.md §8):
        # neither "סגור" nor the dashboard's proceed leaves a till behind — its sales would
        # slip into the next Z.
        leaving = [
            str(i.machine_id) for i in run.items
            if i.machine_id in excluded and i.status not in (ZRunItemStatus.EXCLUDED, ZRunItemStatus.READY)
        ]
        if leaving:
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "local_mode_all_tills" if required == "local" else "all_tills_required",
                    "machineIds": leaving,
                    "message": (
                        "במצב רשת מקומית ה-Z הסניפי כולל את כל הקופות — אי אפשר להפיק אותו בלי קופה. סגרו אותה ונסו שוב."
                        if required == "local" else
                        "בסניף מוגדר \"חובה לסגור את כל הקופות\": אי אפשר להפיק את ה-Z בלי קופה. סגרו אותה ונסו שוב."
                    ),
                },
            )
    for item in list(run.items):
        if item.machine_id not in excluded or item.status == ZRunItemStatus.EXCLUDED:
            continue
        if item.status == ZRunItemStatus.READY and (not strict or verify_item(db, run, item).ok):
            continue
        if deferred_by:
            run.items.append(_deferred_marker(run, item, deferred_by, now))
        item.status = ZRunItemStatus.EXCLUDED
        if not item.error_code or item.error_code in VERIFY_CODES:
            item.error_code = DEFERRED_BY_OPERATOR
    not_ready = [
        str(i.machine_id)
        for i in run.items
        if i.status not in (ZRunItemStatus.READY, ZRunItemStatus.EXCLUDED)
        # A strict run's ready till the cloud has not verified is not ready either.
        or (strict and i.status == ZRunItemStatus.READY and not verify_item(db, run, i).ok)
    ]
    if not_ready:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "items_not_ready", "machineIds": not_ready},
        )
    if not any(i.status == ZRunItemStatus.READY for i in run.items):
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="nothing_to_report")
    finalise_if_ready(db, run, now=now)
    return run


def _all_tills_required(db: Session, run: ZRun) -> Optional[str]:
    """
    Whether this run's shop Z must include every till it covers — "local" (the shop is in
    local mode) or "block" (its `shopZOpenTills` is "חובה לסגור את כל הקופות"); None when a
    till may be left for the next Z. Then neither `proceed` nor the expiry builds without one.
    """
    if _local_mode_run(db, run):
        return "local"
    try:
        shop = db.get(Shop, run.shop_id)
        tenant = db.get(Tenant, run.tenant_id) if run.tenant_id else None
        return "block" if shop is not None and open_tills_rule(db, tenant, shop) == "block" else None
    except Exception:  # noqa: BLE001 - a rule read must never break an expiry sweep
        logger.exception("open-tills rule of shop %s unreadable", run.shop_id)
        return None


def _local_mode_run(db: Session, run: ZRun) -> bool:
    """A run of a shop in local mode (app/services/local_shop_z.py)."""
    from app.services.local_shop_z import local_mode_of_shop

    if run.area_id is not None:
        return False
    try:
        return local_mode_of_shop(db, db.get(Shop, run.shop_id))
    except Exception:  # noqa: BLE001 - a rule read must never break an expiry sweep
        logger.exception("local mode of shop %s unreadable", run.shop_id)
        return False


def cancel_run(db: Session, run: ZRun) -> ZRun:
    # Locked and re-checked: a till's close may be building this very run.
    run = lock_run(db, run)
    _require_waiting(run)
    for item in run.items:
        if item.status != ZRunItemStatus.EXCLUDED:
            item.status = ZRunItemStatus.EXCLUDED
            item.error_code = "cancelled"
    run.status = ZRunStatus.CANCELLED
    db.flush()
    return run


def get_run(db: Session, run_id: uuid.UUID, tenant_id: uuid.UUID) -> Optional[ZRun]:
    return (
        db.query(ZRun)
        .options(joinedload(ZRun.items).joinedload(ZRunItem.machine))
        .filter(ZRun.id == run_id, ZRun.tenant_id == tenant_id)
        .first()
    )


# ── Till side ─────────────────────────────────────────────────────────────────


def _item_for_till(db: Session, machine: POSMachine, item_id: uuid.UUID) -> Optional[ZRunItem]:
    return (
        db.query(ZRunItem)
        .join(ZRun, ZRun.id == ZRunItem.run_id)
        .filter(
            ZRunItem.id == item_id,
            ZRunItem.machine_id == machine.id,
            ZRun.tenant_id == machine.tenant_id,
        )
        .first()
    )


def apply_close_shift_ack(
    db: Session,
    machine: POSMachine,
    *,
    request_id: uuid.UUID,
    phase: str,
    shift_id: Optional[uuid.UUID] = None,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
    now: Optional[datetime] = None,
) -> ZRunItem:
    """A till's acknowledgement of a close-shift instruction (`request_id` = item id)."""
    now = now or datetime.now(timezone.utc)
    item = _item_for_till(db, machine, request_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="close_request_not_found")
    run = item.run
    if run.status != ZRunStatus.WAITING or item.status not in PENDING_ITEM_STATUSES:
        # Cancelled, expired, finished, or already ready: accepted and changes nothing.
        return item

    if phase in ("received", "deferred"):
        item.status = ZRunItemStatus.CLOSING
        item.received_at = item.received_at or now
        if phase == "deferred":
            item.error_code = error_code or "deferred"
            item.error_message = error_message
        else:
            item.error_code = None
            item.error_message = None
        if (
            shift_id is not None
            and named_shift_id(item) is None
            and not is_foreign_shift(db, machine, shift_id)
        ):
            _name_shift(db, item, shift_id)
    elif phase == "completed":
        # Informational. The item becomes ready when the close itself is accepted.
        pass
    elif phase == "failed":
        item.status = ZRunItemStatus.FAILED
        item.error_code = error_code or "failed"
        item.error_message = error_message
        item.failed_at = now
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid phase")
    db.flush()
    if phase == "failed":
        # The last till it waited for refused: the run ends now rather than at its TTL.
        end_if_stalled(db, run)
    return item


def on_shift_close_accepted(
    db: Session, machine: POSMachine, shift: Shift, *, now: Optional[datetime] = None
) -> Optional[ZRunItem]:
    """
    The cloud now holds every document of `shift` and has closed it.

    A run waiting for this till's close has its item made ready — through this shift —
    and is finalised if that was the last one. Matched by the instruction id the close
    carried, else by the shift the run asked to close, else by the till's only waiting
    item (the run may not have known the shift's id if its open had not synced).
    """
    now = now or datetime.now(timezone.utc)
    items = (
        db.query(ZRunItem)
        .join(ZRun, ZRun.id == ZRunItem.run_id)
        .filter(
            ZRunItem.machine_id == machine.id,
            ZRunItem.status.in_(PENDING_ITEM_STATUSES),
            ZRun.status == ZRunStatus.WAITING,
        )
        .all()
    )
    if not items:
        return None
    match = next((i for i in items if shift.close_request_item_id and i.id == shift.close_request_item_id), None)
    match = match or next((i for i in items if named_shift_id(i) == shift.id), None)
    match = match or next((i for i in items if named_shift_id(i) is None), None)
    if match is None:
        return None
    run = lock_run(db, match.run)
    if run.status != ZRunStatus.WAITING or match.status not in PENDING_ITEM_STATUSES:
        return None
    match.status = ZRunItemStatus.READY
    match.close_shift_id = shift.id
    match.through_shift_id = shift.id
    match.ready_at = now
    match.error_code = None
    match.error_message = None
    db.flush()
    finalise_if_ready(db, match.run, now=now)
    return match


def take_pending_close_shift(db: Session, machine: POSMachine, *, now: Optional[datetime] = None) -> Optional[dict]:
    """The instruction to hand this till on its heartbeat, as `{requestId, shiftId}`."""
    now = now or datetime.now(timezone.utc)
    expire_overdue_runs(db, now=now)
    item = (
        db.query(ZRunItem)
        .join(ZRun, ZRun.id == ZRunItem.run_id)
        .filter(
            ZRunItem.machine_id == machine.id,
            ZRunItem.status.in_(PENDING_ITEM_STATUSES),
            ZRun.status == ZRunStatus.WAITING,
        )
        .order_by(ZRunItem.created_at.asc())
        .first()
    )
    if item is None:
        return None
    if item.sent_at is None:
        item.sent_at = now
    out = {
        "requestId": str(item.id),
        "shiftId": str(named_shift_id(item)) if named_shift_id(item) else None,
    }
    if item.run is not None and item.run.force_close:
        # "Even mid-sale" (docs/SPEC_OFFLINE_TILL_Z.md §9); absent = as always.
        out["force"] = True
    return out


def close_shift_pending_runs(db: Session, machine_ids: List[uuid.UUID]) -> Dict[uuid.UUID, uuid.UUID]:
    """Per till with a Z run waiting for its close: that run's id (the oldest, if several)."""
    if not machine_ids:
        return {}
    rows = (
        db.query(ZRunItem.machine_id, ZRun.id)
        .join(ZRun, ZRun.id == ZRunItem.run_id)
        .filter(
            ZRunItem.machine_id.in_(machine_ids),
            ZRunItem.status.in_(PENDING_ITEM_STATUSES),
            ZRun.status == ZRunStatus.WAITING,
        )
        .order_by(ZRun.created_at.desc())
        .all()
    )
    return {machine_id: run_id for machine_id, run_id in rows}


def close_shift_pending_machine_ids(db: Session, machine_ids: List[uuid.UUID]) -> Set[uuid.UUID]:
    if not machine_ids:
        return set()
    rows = (
        db.query(ZRunItem.machine_id)
        .join(ZRun, ZRun.id == ZRunItem.run_id)
        .filter(
            ZRunItem.machine_id.in_(machine_ids),
            ZRunItem.status.in_(PENDING_ITEM_STATUSES),
            ZRun.status == ZRunStatus.WAITING,
        )
        .all()
    )
    return {r[0] for r in rows}


# ── Out ───────────────────────────────────────────────────────────────────────


def run_to_out(db: Session, run: ZRun, *, now: Optional[datetime] = None) -> dict:
    """
    The run as the wizard shows it. Each item carries its till's last reported backlog
    (`pendingDocuments`, `pendingAsOf`, `online`), and while the run still waits for the
    till to close, `documentsOnCloud`: how many documents of the closing shift the cloud
    already holds.
    """
    waiting = [i for i in run.items if i.status in PENDING_ITEM_STATUSES]
    held = documents_on_cloud(db, [named_shift_id(i) for i in waiting])
    strict = bool(getattr(run, "strict_cloud_check", False))
    # A strict run still waiting: the cloud's word on each ready till, as the master shows it.
    checks: Dict[uuid.UUID, ItemCheck] = {}
    if strict and run.status == ZRunStatus.WAITING:
        checks = {i.id: verify_item(db, run, i) for i in run.items if i.status == ZRunItemStatus.READY}
    # Who deferred which till with "סגור" (the markers `proceed_without` left).
    deferred_by: Dict[uuid.UUID, str] = {}
    for marker in run.items:
        if is_left_out_marker(marker):
            try:
                data = json.loads(marker.error_message or "{}")
            except ValueError:
                data = {}
            if isinstance(data, dict) and data.get("deferred") and data.get("confirmedBy"):
                deferred_by[marker.machine_id] = data["confirmedBy"]
    z_number = None
    z = None
    if run.z_report_id is not None:
        from app.models.z_report import ZReport

        z = db.query(ZReport).filter(ZReport.id == run.z_report_id).first()
        z_number = z.z_number if z is not None else None
    # Once built, the name the Z froze; until then, what the area is called now.
    area_name = None
    if run.area_id is not None:
        frozen = (z.header or {}) if z is not None else {}
        area_name = frozen.get("areaName") or (run.area.name if run.area is not None else None)
    return {
        "id": run.id,
        "shopId": run.shop_id,
        "areaId": run.area_id,
        "areaName": area_name,
        "status": run.status,
        "businessDate": run.business_date,
        "createdAt": run.created_at,
        "updatedAt": run.updated_at,
        "expiresAt": run.expires_at,
        "createdByUserId": run.created_by_user_id,
        "zReportId": run.z_report_id,
        "zNumber": z_number,
        "errorCode": run.error_code,
        "errorMessage": run.error_message,
        "openTillsLeftOut": open_tills_left_out(db, run),
        "strictCloudCheck": strict,
        "force": bool(getattr(run, "force_close", False)),
        # For a till's elapsed-seconds display: the cloud's clock, not the till's.
        "serverTime": now or datetime.now(timezone.utc),
        "items": [
            {
                "id": i.id,
                "machineId": i.machine_id,
                "machineName": i.machine.name if i.machine is not None else None,
                "posNumber": i.machine.pos_number if i.machine is not None else None,
                # Strict runs: the ready till checked out on the cloud (closed, accepted,
                # every sale it counted is here); null while it is not ready yet.
                "cloudVerified": (
                    (checks[i.id].ok if i.id in checks else run.status == ZRunStatus.COMPLETED)
                    if strict and i.status == ZRunItemStatus.READY
                    else None
                ),
                "tillDocuments": checks[i.id].till_documents if i.id in checks else None,
                "cloudDocuments": checks[i.id].cloud_documents if i.id in checks else None,
                "deferredBy": deferred_by.get(i.machine_id) if i.status == ZRunItemStatus.EXCLUDED else None,
                "throughShiftId": i.through_shift_id,
                "closeShiftId": named_shift_id(i),
                "status": i.status,
                "errorCode": i.error_code,
                "errorMessage": i.error_message,
                "sentAt": i.sent_at,
                "receivedAt": i.received_at,
                "readyAt": i.ready_at,
                "updatedAt": i.updated_at,
                **till_backlog(i.machine, now=now),
                "documentsOnCloud": (
                    held.get(named_shift_id(i))
                    if i.status in PENDING_ITEM_STATUSES and named_shift_id(i) is not None
                    else None
                ),
            }
            for i in run.items
            if not is_left_out_marker(i)
        ],
    }

