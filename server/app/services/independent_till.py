"""
"קופה עצמאית בתוך סניף" — an independent till inside a shop (docs/SPEC_INDEPENDENT_TILL.md).

A shop's tills can be split: most take part in the shop Z ("Z סניפי"), and the chosen
ones are independent. An independent till is `pos_machines.independent_till`, and always
`z_mode = "till"` (a check in the database says so), which gives it everything the
per-till Z already is (app/services/till_z.py, docs/SHIFTS_API.md §5):

* **Its own Z, its own numbers.** It asks for its Z itself (`POST /sync/{id}/till-z`),
  numbered in its own run (`machine_z_sequences`); the shop's counter never sees it.
* **Never part of the shop Z.** The shop Z neither lists nor waits for it (`per_till_ids`
  in app/services/z_runs.py), and the builder refuses its shifts in any shop Z — so its
  documents can never be in the shop Z's figures.

On top of the per-till Z, the flag takes the till out of the shop's LAN group:

* it is never the main till, the tables host or the print server, and is never chosen as
  one (`host_flags_off`: the host parameters read "off" on it whatever level set them;
  `lan_members` keeps it out of every host election);
* it never uses them: the cloud hands it no LAN tables host and no print server
  (`lan_host_block`, `print_host_block` answer None for it);
* its tables are off unless set at its own level ("for it alone"), and then only as
  «קופה אחת» — a shared mode would share the shop's tables (`independent_parameters`).

Why a flag beside `z_mode` and not a third `z_mode` value: `z_mode` already says, to every
till app ever shipped, who makes the till's Z. An older app reading an unknown third value
would fall back to "cloud" and think it is in the shop Z, while the cloud refuses to take
it — its shifts would be stranded. With the flag, an older app still behaves as a per-till
Z till (right for the fiscal part), and the LAN part is enforced by the cloud.

Switching (`check_switch` / `set_independent`): the super admin's alone, and only over a
clean break — no open shift, no closed shift waiting for a Z, no Z under way — so no shift
is ever stranded between the shop's run and the till's. The refusals carry a Hebrew
`message` the dashboard shows as is.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.shift import Shift, ShiftStatus
from app.models.user import User, UserRole

#: The till parameters that name a till for a job of the shop's LAN group. On an
#: independent till they always read "off" — it is never chosen as any of them.
HOST_KEYS = ("mainTill", "tablesHostTill", "printHostTill", "shopZMasterTill")

TABLES_MODE_KEY = "tablesMode"
#: What `tablesMode` may be on an independent till: off, or the till's own tables.
TABLES_OFF = "כבוי"
TABLES_SINGLE = "קופה אחת"

ROLE_SHOP_Z = "shop_z"
ROLE_INDEPENDENT = "independent"
#: `z_mode = till` but not independent: the whole-shop "Z לכל קופה", still in the LAN group.
ROLE_OWN_Z = "own_z"


class IndependentSwitchRefused(Exception):
    """A refusal with a body (`detail`, Hebrew `message`, the till), answered as is."""

    def __init__(self, status_code: int, body: dict):
        super().__init__(body.get("detail"))
        self.status_code = status_code
        self.body = body


def is_independent(machine: Optional[POSMachine]) -> bool:
    return bool(machine is not None and getattr(machine, "independent_till", False))


def role_of(machine: POSMachine) -> str:
    if is_independent(machine):
        return ROLE_INDEPENDENT
    return ROLE_OWN_Z if getattr(machine, "z_mode", None) == "till" else ROLE_SHOP_Z


def lan_members(machines: Iterable[POSMachine]) -> List[POSMachine]:
    """
    The tills of the shop's LAN group: every one but the independent tills — and never a
    display device (a KDS / the "מוכן / לא מוכן" board, app/services/display_devices.py),
    which is no till: never the main till, the tables host or the print server.
    """
    return [m for m in machines if not is_independent(m) and getattr(m, "is_fiscal", True) is not False]


def till_label(machine: POSMachine) -> str:
    number = (machine.pos_number or "").strip()
    return f"קופה {number}" if number else (machine.name or "הקופה")


# ── Its parameters ────────────────────────────────────────────────────────────


def independent_parameters(
    resolved: Dict[str, Any], own_tables_mode: Any = None, *, has_tables_mode: bool = True
) -> Dict[str, Any]:
    """
    The parameters as an independent till must read them (pure): every host flag off, and
    `tablesMode` from its own level only — off when that level is silent, and «קופה אחת»
    for any mode that turns tables on (a shared mode would share the shop's tables).
    """
    from app.services.tables import MODE_OFF, mode_of

    out = dict(resolved)
    for key in HOST_KEYS:
        if key in out:
            out[key] = False
    if has_tables_mode or TABLES_MODE_KEY in out or own_tables_mode is not None:
        own = mode_of(own_tables_mode) if own_tables_mode is not None else MODE_OFF
        out[TABLES_MODE_KEY] = TABLES_OFF if own == MODE_OFF else TABLES_SINGLE
    return out


def apply_to_resolved(machine: POSMachine, parameters: Sequence[Any], values: Sequence[Any], resolved):
    """
    `till_parameters_for_machine`'s answer for an independent till: `resolved`
    (a `ResolvedParameters`) with `independent_parameters` applied, the till's own
    `tablesMode` read from the values at its own level.
    """
    from app.services.till_parameters import as_uuid

    tables = next((p for p in parameters if p.key == TABLES_MODE_KEY and p.is_active), None)
    own = None
    if tables is not None:
        for row in values:
            if (
                row.scope_type == "machine"
                and as_uuid(row.scope_id) == as_uuid(machine.id)
                and as_uuid(row.parameter_id) == as_uuid(tables.id)
            ):
                own = row.value
                break
    resolved.parameters = independent_parameters(
        resolved.parameters, own, has_tables_mode=tables is not None
    )
    return resolved


# ── Switching ─────────────────────────────────────────────────────────────────


def _open_shift(db: Session, machine: POSMachine) -> Optional[uuid.UUID]:
    """The till's open shift: the cloud's row, else the one its heartbeat claims."""
    row = (
        db.query(Shift.id)
        .filter(Shift.machine_id == machine.id, Shift.status == ShiftStatus.OPEN)
        .first()
    )
    if row is not None:
        return row[0]
    from app.services.z_runs import _reported_open_is_live

    return machine.reported_open_shift_id if _reported_open_is_live(db, machine) else None


def _refuse(code: str, machine: POSMachine, message: str, status_code: int = status.HTTP_409_CONFLICT, **extra):
    return IndependentSwitchRefused(
        status_code,
        {
            "detail": code,
            "message": message,
            "machineId": str(machine.id),
            "posNumber": machine.pos_number,
            **extra,
        },
    )


def check_switch(db: Session, user: User, machine: POSMachine, independent: bool) -> None:
    """
    Refuse making `machine` independent (or making it a shop Z till again) unless the
    rules allow it now. The same state again passes.

    * the super admin alone (403 `super_admin_only`) — it decides how the shop reports;
    * no open shift (`independent_switch_open_shift`);
    * no closed shift waiting for a Z (`independent_switch_unreported_shifts`): each was
      closed expecting a Z of the other kind. One exception, as for `z_mode` (dead-till
      recovery): back into the shop Z with shifts the cloud closed administratively;
    * no Z under way for it (`independent_switch_z_in_progress`);
    * nothing it numbered that the cloud does not have yet: no till Z closed with no
      connection (`till_offline_zs_unsynced`, docs/SPEC_OFFLINE_TILL_Z.md §4.4) and no shop
      Z it made as a main till (`independent_switch_shop_zs_unsynced`, §8.10) — the switch
      starts or leaves a run, and a number of the old one must never arrive after it.
    """
    from app.services import till_z
    from app.services.z_builder import Z_MODE_CLOUD

    if independent == is_independent(machine) and (independent or machine.z_mode == Z_MODE_CLOUD):
        return
    if user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super_admin_only")
    label = till_label(machine)
    target = "לקופה עצמאית" if independent else "ל-Z הסניפי"
    till_z.expire_overdue(db)
    if till_z.live_z_run_item(db, machine.id) is not None or till_z._pending_query(db, machine.id).first() is not None:
        raise _refuse(
            "independent_switch_z_in_progress", machine,
            f"לא ניתן להעביר את {label} {target}: יש Z בתהליך שכולל אותה. המתינו לסיומו ונסו שוב.",
        )
    if _open_shift(db, machine) is not None:
        raise _refuse(
            "independent_switch_open_shift", machine,
            f"לא ניתן להעביר את {label} {target}: יש בה משמרת פתוחה. "
            "סגרו את המשמרת והפיקו את ה-Z שלה, ואז נסו שוב.",
        )
    # Nothing numbered that the cloud does not have (the owner: no Z number ever changes).
    till_z.refuse_while_producing_offline(db, machine)
    shop_zs = _unsynced_shop_zs(db, machine)
    if shop_zs:
        raise _refuse(
            "independent_switch_shop_zs_unsynced", machine,
            f"לא ניתן להעביר את {label} {target}: יש בה {shop_zs} דוחות Z סניפיים שהופקו בה כקופה ראשית "
            "ועוד לא סונכרנו לענן. חברו אותה לענן והמתינו לסנכרון, ואז נסו שוב.",
            count=shop_zs,
        )
    waiting = till_z.unreported_closed_count(db, machine.id)
    recovering = not independent and till_z._has_reconstructed_unreported(db, machine.id)
    if waiting and not recovering:
        which = "ה-Z של הקופה" if machine.z_mode == "till" else "ה-Z הסניפי"
        raise _refuse(
            "independent_switch_unreported_shifts", machine,
            f"לא ניתן להעביר את {label} {target}: יש בה {waiting} משמרות סגורות שעוד לא נכללו ב-Z. "
            f"הפיקו קודם את {which}, ואז נסו שוב.",
            count=waiting,
        )


def _unsynced_shop_zs(db: Session, machine: POSMachine) -> int:
    """Shop Zs this till made as a main till that the cloud does not have yet (its last report)."""
    from app.models.shop import Shop
    from app.services.local_shop_z import REPORTS_KEY

    shop = db.get(Shop, machine.shop_id) if machine.shop_id else None
    reports = ((shop.settings or {}).get(REPORTS_KEY) if shop is not None else None) or {}
    report = reports.get(str(machine.id)) if isinstance(reports, dict) else None
    if not isinstance(report, dict):
        return 0
    pending = int(report.get("pending") or 0)
    return pending if pending > 0 else (1 if report.get("conflict") else 0)


def _clear_host_flags(db: Session, machine: POSMachine, now: datetime) -> List[str]:
    """Remove the host parameters set at this till's own level; the keys removed."""
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.main_till import is_on

    removed = []
    for parameter in db.query(TillParameter).filter(TillParameter.key.in_(HOST_KEYS)).all():
        rows = (
            db.query(TillParameterValue)
            .filter(
                TillParameterValue.parameter_id == parameter.id,
                TillParameterValue.scope_type == "machine",
                TillParameterValue.scope_id == machine.id,
            )
            .all()
        )
        if not any(is_on(r.value) for r in rows):
            continue
        for row in rows:
            db.delete(row)
        parameter.updated_at = now
        removed.append(parameter.key)
    return removed


def set_independent(db: Session, machine: POSMachine, independent: bool, *, now: Optional[datetime] = None) -> bool:
    """
    Make the till independent (its own Z, outside the LAN group) or a shop Z till again.
    The caller ran `check_switch`. True when it changed.

    Through `till_z.set_z_mode`, which takes the till's Z counter lock and re-checks the
    shifts under it, so a switch and a till Z of the same till never interleave.
    """
    from app.services import till_z
    from app.services.z_builder import Z_MODE_CLOUD, Z_MODE_TILL

    now = now or datetime.now(timezone.utc)
    if independent:
        if is_independent(machine) and machine.z_mode == Z_MODE_TILL:
            return False
        till_z.set_z_mode(db, machine, Z_MODE_TILL, now=now)
        machine.independent_till = True
        _clear_host_flags(db, machine, now)
        # The owner: "מעבר בין קופה בסניפי לעצמאי מתחיל את הקופה מ-Z אחד" — a new run of
        # its own Zs, at 1 (SPEC_INDEPENDENT_TILL §3.1). The last number the device reported
        # was of the old run: forgotten with it.
        from app.services.z_sequence import start_new_machine_sequence

        start_new_machine_sequence(db, machine.id, now)
        if hasattr(machine, "offline_till_z_last_number"):
            machine.offline_till_z_last_number = None
    else:
        if not is_independent(machine) and machine.z_mode == Z_MODE_CLOUD:
            return False
        # The flag first: the check in the database allows no independent cloud-mode till.
        machine.independent_till = False
        till_z.set_z_mode(db, machine, Z_MODE_CLOUD, now=now)
    db.flush()
    return True


# ── The shop's card: "קופות בזד הסניפי" ─────────────────────────────────────────


def shop_state(db: Session, shop, user: User) -> dict:
    """Every seated till of the shop with its role, the main till, and the local mode."""
    from app.services import main_till as MT
    from app.services import z_runs as ZR
    from app.services.local_shop_z import lan_seen_hint, local_mode_of_shop, producer_state, remote_till_ids
    from app.services.machine_status import is_online

    main = MT.main_till_of_shop(db, shop.id)
    tills = [m for m in ZR.shop_tills(db, shop.id) if ZR.is_seated_in(m, shop.id)]
    remote = remote_till_ids(shop)
    seen_on_lan = lan_seen_hint(db, shop)
    out = []
    for m in sorted(tills, key=MT.till_order):
        cand = ZR.till_candidates(db, m, shop.id)
        out.append({
            "machineId": str(m.id),
            "posNumber": m.pos_number,
            "name": m.name,
            "areaId": str(m.area_id) if m.area_id else None,
            "zMode": "till" if m.z_mode == "till" else "cloud",
            "independent": is_independent(m),
            "role": role_of(m),
            "openShift": cand.open_shift is not None or _open_shift(db, m) is not None,
            "awaitingZ": len(cand.closed),
            "mainTill": main is not None and main.id == m.id,
            "online": is_online(m.last_heartbeat_at),
            "kiosk": bool(getattr(m, "is_kiosk", False)),
            # "מחובר ברשת המקומית" / "מרוחק (דרך הענן)" — the setting decides (§8.14) …
            "link": "remote" if str(m.id) in remote else "lan",
            # … and the main till's view of who it hears on the LAN is a hint (null: unknown).
            "seenOnLan": None if seen_on_lan is None else str(m.id) in seen_on_lan,
        })
    return {
        "shopId": str(shop.id),
        "tills": out,
        "mainTill": MT.till_ref(main),
        "localMode": local_mode_of_shop(db, shop),
        "canEdit": user.role == UserRole.SUPER_ADMIN,
        # Who produces the shop's Zs, a handover waiting, conflicts for support (§8.10–8.11).
        "shopZ": producer_state(db, shop),
    }


_MAIN_UNCHANGED = object()


def apply_shop(
    db: Session,
    user: User,
    shop,
    *,
    participants: Sequence[uuid.UUID] = (),
    independent: Sequence[uuid.UUID] = (),
    main_till_id: Any = _MAIN_UNCHANGED,
    force_producer_switch: bool = False,
    remote: Optional[Sequence[uuid.UUID]] = None,
    now: Optional[datetime] = None,
) -> List[POSMachine]:
    """
    The card's save: `participants` join the shop Z, `independent` become independent, a
    till in neither stays as it is; `main_till_id` (when given) becomes the shop's main
    till — which must be in the LAN group after the save. All or nothing: every refusal
    is raised before anything is written. The tills that changed.
    """
    from app.models.z_run import ZRun, ZRunStatus
    from app.services import main_till as MT
    from app.services import z_runs as ZR

    if user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super_admin_only")
    now = now or datetime.now(timezone.utc)
    seated = {str(m.id): m for m in ZR.shop_tills(db, shop.id) if ZR.is_seated_in(m, shop.id)}
    joining = [str(i) for i in participants]
    leaving = [str(i) for i in independent]
    both = set(joining) & set(leaving)
    if both:
        raise IndependentSwitchRefused(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"detail": "till_in_both_lists", "message": "קופה לא יכולה להיות גם בזד הסניפי וגם עצמאית.",
             "machineId": sorted(both)[0]},
        )
    for machine_id in joining + leaving + ([str(main_till_id)] if main_till_id not in (_MAIN_UNCHANGED, None) else []):
        if machine_id not in seated:
            raise IndependentSwitchRefused(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {"detail": "machine_not_in_shop", "message": "הקופה אינה משויכת לסניף הזה.", "machineId": machine_id},
            )

    # The main till after the save: named, or the present one.
    after_independent = {mid for mid, m in seated.items() if is_independent(m)} - set(joining) | set(leaving)
    if main_till_id is _MAIN_UNCHANGED:
        current = MT.main_till_of_shop(db, shop.id)
        main_after = str(current.id) if current is not None else None
    else:
        main_after = str(main_till_id) if main_till_id is not None else None
    if main_after is not None and main_after in after_independent:
        m = seated.get(main_after)
        raise IndependentSwitchRefused(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {
                "detail": "main_till_not_participating",
                "message": (
                    f"{till_label(m) if m else 'הקופה'} היא הקופה הראשית (השרת המקומי) של הסניף ולכן לא יכולה להיות עצמאית. "
                    "בחרו קופה ראשית מבין הקופות שבזד הסניפי."
                ),
                "machineId": main_after,
            },
        )
    # "מחובר ברשת המקומית / מרוחק (דרך הענן)" (§8.14): only a participant after the save, and
    # never the main till itself (it is the LAN).
    remote_after = None
    if remote is not None:
        remote_after = {str(i) for i in remote}
        for machine_id in sorted(remote_after):
            m = seated.get(machine_id)
            if m is None:
                raise IndependentSwitchRefused(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    {"detail": "machine_not_in_shop", "message": "הקופה אינה משויכת לסניף הזה.", "machineId": machine_id},
                )
            if machine_id in after_independent:
                raise IndependentSwitchRefused(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    {"detail": "remote_not_participant", "machineId": machine_id,
                     "message": f"{till_label(m)} עצמאית — היא לא בזד הסניפי, ולכן אין לה סגירה דרך הענן."},
                )
            if machine_id == main_after:
                raise IndependentSwitchRefused(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    {"detail": "remote_main_till", "machineId": machine_id,
                     "message": f"{till_label(m)} היא הקופה הראשית (השרת המקומי) — היא לא יכולה להיות מרוחקת."},
                )
    if main_till_id is not _MAIN_UNCHANGED:
        live = (
            db.query(ZRun.id)
            .filter(ZRun.shop_id == shop.id, ZRun.status.in_([ZRunStatus.WAITING, ZRunStatus.BUILDING]))
            .first()
        )
        if live is not None:
            raise IndependentSwitchRefused(
                status.HTTP_409_CONFLICT,
                {"detail": "z_run_in_progress", "message": "יש Z סניפי בתהליך — המתינו לסיומו ואז שנו את הקופה הראשית."},
            )

    for machine_id in joining:
        check_switch(db, user, seated[machine_id], False)
    for machine_id in leaving:
        check_switch(db, user, seated[machine_id], True)

    # Exactly one producer of the shop's Z sequence (SPEC_INDEPENDENT_TILL §8.10): pinned
    # before the save, checked after it — a move the producer cannot hand over is refused.
    from app.services.local_shop_z import ProducerGuard

    guard = ProducerGuard(db, [shop], now=now)
    changed = []
    for machine_id in joining:
        if set_independent(db, seated[machine_id], False, now=now):
            changed.append(seated[machine_id])
    for machine_id in leaving:
        if set_independent(db, seated[machine_id], True, now=now):
            changed.append(seated[machine_id])
    if main_till_id is not _MAIN_UNCHANGED:
        MT.set_main_till(db, shop, main_till_id, now=now)
    if remote_after is not None:
        from app.services.local_shop_z import set_remote_till_ids

        set_remote_till_ids(shop, remote_after)
    db.flush()
    guard.check(force=force_producer_switch, user=user)
    return changed
