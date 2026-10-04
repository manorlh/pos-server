"""
Remote app updates for tills ("עדכון קופות"): which release a till gets, and who to tell.

A super admin uploads a release (`AppRelease`) and sends it to targets
(`AppReleaseAssignment`). A till takes the live assignment of the most specific level
that has one:

    the till itself → its area → its shop → the shop's company → its tenant

and within one level the newest. Cancelled assignments and retired releases do not
count. The till is then offered that release only if it is not what it already runs
and is not a downgrade (`offer_for`) — Android refuses to install a lower versionCode
over a higher one, and a till must never be sent round that loop.

`resolve_assignment` is a pure function over plain rows, so the order is tested without
a database; `resolved_for_machine` only gathers those rows for one till.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.app_release import AppRelease, AppReleaseAssignment
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.tenant import Tenant
from app.services.ably_notify import publish_settings_notify
from app.services.areas import as_utc
from app.services.till_parameters import as_uuid

#: The Ably `settings` notify reason after an assignment changes. Any `settings` event
#: makes the till sync now, and every sync asks `/sync/{id}/app-update`.
NOTIFY_REASON = "app_update_assigned"

#: Most specific first — the order a till resolves in.
_PRECEDENCE = ("machine", "area", "shop", "company", "tenant")


@dataclass(frozen=True)
class MachineChain:
    """The entities a till's assignment can come from. Any of them may be missing."""

    machine_id: Optional[uuid.UUID]
    area_id: Optional[uuid.UUID] = None
    shop_id: Optional[uuid.UUID] = None
    company_id: Optional[uuid.UUID] = None
    tenant_id: Optional[uuid.UUID] = None

    def levels(self) -> List[Tuple[str, uuid.UUID]]:
        """`(level, id)` most specific first, skipping the levels the till lacks."""
        ids = {
            "machine": self.machine_id,
            "area": self.area_id,
            "shop": self.shop_id,
            "company": self.company_id,
            "tenant": self.tenant_id,
        }
        return [(level, as_uuid(ids[level])) for level in _PRECEDENCE if ids[level] is not None]


Resolved = Tuple[AppReleaseAssignment, AppRelease]


def resolve_assignment(rows: Iterable[Resolved], chain: MachineChain) -> Optional[Resolved]:
    """
    The assignment (and its release) this till takes, or None.

    `rows` may hold assignments of any target; only those on `chain` count, and of those
    only the live ones (not cancelled) of active releases. Most specific level first,
    then the newest `created_at`.
    """
    rank = {key: i for i, key in enumerate(chain.levels())}
    best: Optional[Tuple[Tuple[int, float], Resolved]] = None
    for assignment, release in rows:
        if assignment.cancelled_at is not None or not release.is_active:
            continue
        position = rank.get((assignment.level, as_uuid(assignment.target_id)))
        if position is None:
            continue
        created = as_utc(assignment.created_at)
        # Lower is better: a more specific level, then a later stamp.
        key = (position, -(created.timestamp() if created is not None else 0.0))
        if best is None or key < best[0]:
            best = (key, (assignment, release))
    return best[1] if best is not None else None


def offer_for(release: AppRelease, version_code: Optional[int], version_name: Optional[str]) -> bool:
    """
    Whether a till running `version_code` / `version_name` should take `release`.

    Not when it already runs it (same versionName), and never a downgrade: a release
    with a lower versionCode than the till's is not offered even though it is assigned.
    """
    if version_name is not None and release.version_name == version_name:
        return False
    if version_code is not None and release.version_code < version_code:
        return False
    return True


def chain_for_machine(db: Session, machine: POSMachine) -> MachineChain:
    """The till, its area, its shop, that shop's company and the tenant — as they are now."""
    company_id = None
    tenant_id = machine.tenant_id
    if machine.shop_id is not None:
        row = db.query(Shop.company_id, Shop.tenant_id).filter(Shop.id == machine.shop_id).first()
        if row is not None:
            company_id = row[0]
            tenant_id = tenant_id or row[1]
    return MachineChain(
        machine_id=machine.id,
        area_id=machine.area_id,
        shop_id=machine.shop_id,
        company_id=company_id,
        tenant_id=tenant_id,
    )


def _rows_on_chains(db: Session, chains: Sequence[MachineChain]) -> List[Resolved]:
    on_chain = {(level, ident) for chain in chains for level, ident in chain.levels()}
    if not on_chain:
        return []
    predicates = [
        and_(AppReleaseAssignment.level == level, AppReleaseAssignment.target_id == ident)
        for level, ident in on_chain
    ]
    return (
        db.query(AppReleaseAssignment, AppRelease)
        .join(AppRelease, AppRelease.id == AppReleaseAssignment.release_id)
        .filter(
            AppReleaseAssignment.cancelled_at.is_(None),
            AppRelease.is_active.is_(True),
            or_(*predicates),
        )
        .all()
    )


def resolved_for_machine(db: Session, machine: POSMachine) -> Optional[Resolved]:
    chain = chain_for_machine(db, machine)
    return resolve_assignment(_rows_on_chains(db, [chain]), chain)


def resolved_for_machines(db: Session, machines: Sequence[POSMachine]) -> Dict[uuid.UUID, Optional[Resolved]]:
    """Per till, as `resolved_for_machine`, in one query for the assignments."""
    shop_ids = {m.shop_id for m in machines if m.shop_id is not None}
    shops = (
        {row[0]: (row[1], row[2]) for row in db.query(Shop.id, Shop.company_id, Shop.tenant_id)
         .filter(Shop.id.in_(list(shop_ids))).all()}
        if shop_ids
        else {}
    )
    chains = {}
    for m in machines:
        company_id, shop_tenant = shops.get(m.shop_id, (None, None))
        chains[m.id] = MachineChain(
            machine_id=m.id,
            area_id=m.area_id,
            shop_id=m.shop_id,
            company_id=company_id,
            tenant_id=m.tenant_id or shop_tenant,
        )
    rows = _rows_on_chains(db, list(chains.values()))
    return {mid: resolve_assignment(rows, chain) for mid, chain in chains.items()}


# ── Targets ──────────────────────────────────────────────────────────────────

_TARGET_MODELS = {
    "tenant": Tenant,
    "company": Company,
    "shop": Shop,
    "area": ShopArea,
    "machine": POSMachine,
}


def target_entity(db: Session, level: str, target_id: Any):
    """The tenant, company, shop, area or till an assignment names, or None."""
    model = _TARGET_MODELS[level]
    return db.query(model).filter(model.id == target_id).first()


def target_tenant_id(level: str, entity) -> Optional[uuid.UUID]:
    return entity.id if level == "tenant" else entity.tenant_id


def machines_under(db: Session, level: str, target_id: Any) -> List[POSMachine]:
    """The active tills an assignment at this level reaches (whether or not it wins there)."""
    query = db.query(POSMachine).filter(POSMachine.is_active.is_(True))
    if level == "machine":
        query = query.filter(POSMachine.id == target_id)
    elif level == "area":
        query = query.filter(POSMachine.area_id == target_id)
    elif level == "shop":
        query = query.filter(POSMachine.shop_id == target_id)
    elif level == "company":
        shop_ids = [row[0] for row in db.query(Shop.id).filter(Shop.company_id == target_id).all()]
        if not shop_ids:
            return []
        query = query.filter(POSMachine.shop_id.in_(shop_ids))
    elif level == "tenant":
        query = query.filter(POSMachine.tenant_id == target_id)
    else:
        return []
    return query.all()


NotifyTarget = Tuple[str, str]


def notify_targets(machines: Iterable[POSMachine]) -> List[NotifyTarget]:
    return [(str(m.tenant_id), str(m.id)) for m in machines if m.tenant_id]


def publish_update_notify(targets: Iterable[NotifyTarget]) -> None:
    """
    Best effort: one Ably `settings` notify per till, which makes it sync now and so ask
    for its update. Without Ably configured `publish_settings_notify` only logs; a till
    that misses it still asks on its next scheduled sync.
    """
    for tenant_id, machine_id in targets:
        publish_settings_notify(tenant_id, machine_id, reason=NOTIFY_REASON)
