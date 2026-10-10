"""
"קבוצות מכשירים" — named groups of tills across the shops of one company (app/models/machine_group.py),
a level a catalog menu ("תפריטים") can be assigned to: machine > group > area > shop > company.

**Who.** Like a menu placed on a company: a catalog writer who covers the group's company
(app/services/menu.py `check_company_write`); the list shows the groups of the companies the user
sees, each saying whether they may change it.

**Members.** Active tills of shops under the group's company (that company or one beneath it); a
till may be in several groups. When its groups assign menus active at the same moment, the higher
priority wins, and at the same priority the most recently updated assignment
(app/services/catalog_menu_rules.py).

**Effect on the tills.** Every change — a member added or removed, a group renamed or deleted — bumps
the organization's menus (`catalog_menus.bump`), so the next pull of every till carries its
`catalogMenus` block again: its group assignments, and its own groups (`groups: [{id, name}]`). The
router notifies the tills after the commit.
"""
from __future__ import annotations

import uuid
import weakref
from typing import Any, Dict, Iterable, List, Optional, Sequence

from fastapi import HTTPException, status
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.machine_group import MachineGroup, MachineGroupMember
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User

NOT_FOUND = "machine_group_not_found"
NAME_TAKEN = "machine_group_name_taken"
NAME_EMPTY = "machine_group_name_empty"
#: `machine_not_in_company:<id>` — a till that is not an active till of a shop under the group's company.
NOT_IN_COMPANY = "machine_not_in_company"

_READY: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


def ready(db: Session) -> bool:
    """The tables exist (a migrated database; a test world that builds only some tables has none)."""
    try:
        bind = db.get_bind()
    except Exception:  # pragma: no cover - an unbound session
        return False
    engine = getattr(bind, "engine", bind)
    try:
        if _READY.get(engine):
            return True
    except TypeError:  # pragma: no cover
        pass
    try:
        inspector = sa_inspect(db.connection())
        ok = inspector.has_table("machine_groups") and inspector.has_table("machine_group_members")
    except Exception:  # pragma: no cover
        return False
    if ok:
        try:
            _READY[engine] = True
        except TypeError:  # pragma: no cover
            pass
    return ok


def _bad(detail: str, code: int = status.HTTP_400_BAD_REQUEST) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _as_uuid(value) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


# ── A till's groups ───────────────────────────────────────────────────────────


def groups_of_machine(db: Session, machine: POSMachine) -> List[MachineGroup]:
    """
    The groups `machine` is in, of its own company or one above it (a till moved to another
    company's shop leaves its old company's groups behind) — by name, then id.
    """
    if machine is None or getattr(machine, "id", None) is None or not ready(db):
        return []
    from app.services.catalog_menus import company_chain

    shop = db.query(Shop).filter(Shop.id == machine.shop_id).first() if machine.shop_id else None
    reach = {str(c) for c in company_chain(db, shop.company_id)} if shop is not None else set()
    rows = (
        db.query(MachineGroup)
        .join(MachineGroupMember, MachineGroupMember.group_id == MachineGroup.id)
        .filter(MachineGroupMember.machine_id == machine.id)
        .all()
    )
    return sorted((g for g in rows if str(g.company_id) in reach), key=lambda g: (g.name or "", str(g.id)))


def groups_of_machines(db: Session, machine_ids: Sequence) -> Dict[str, List[MachineGroup]]:
    """`{machine id: [its groups]}` for many tills at once (by name, then id; no company check)."""
    ids = [i for i in {_as_uuid(x) for x in machine_ids} if i is not None]
    if not ids or not ready(db):
        return {}
    out: Dict[str, List[MachineGroup]] = {}
    for member, group in (
        db.query(MachineGroupMember, MachineGroup)
        .join(MachineGroup, MachineGroup.id == MachineGroupMember.group_id)
        .filter(MachineGroupMember.machine_id.in_(ids))
        .all()
    ):
        out.setdefault(str(member.machine_id), []).append(group)
    for groups in out.values():
        groups.sort(key=lambda g: (g.name or "", str(g.id)))
    return out


def wire(groups: Iterable[MachineGroup]) -> List[Dict[str, str]]:
    """What a till is told of its groups (`catalogMenus.groups`)."""
    return [{"id": str(g.id), "name": g.name} for g in groups]


# ── Dashboard ─────────────────────────────────────────────────────────────────


def _group(db: Session, tenant_id, group_id) -> MachineGroup:
    gid = _as_uuid(group_id)
    group = db.query(MachineGroup).filter(MachineGroup.id == gid).first() if gid is not None else None
    if group is None or str(group.tenant_id) != str(tenant_id):
        raise _bad(NOT_FOUND, status.HTTP_404_NOT_FOUND)
    return group


def _check_write(db: Session, user: User, tenant_id, company_id) -> None:
    from app.services.menu import check_company_write

    check_company_write(db, user, tenant_id, company_id)


def _clean_name(name: Optional[str]) -> str:
    clean = " ".join((name or "").split())
    if not clean:
        raise _bad(NAME_EMPTY)
    return clean[:80]


def _name_free(db: Session, company_id, name: str, except_id=None) -> None:
    q = db.query(MachineGroup).filter(MachineGroup.company_id == company_id)
    for g in q.all():
        if g.name.strip().lower() == name.lower() and (except_id is None or str(g.id) != str(except_id)):
            raise _bad(NAME_TAKEN, status.HTTP_409_CONFLICT)


def _members(db: Session, group_ids: Sequence) -> Dict[str, List[POSMachine]]:
    if not group_ids:
        return {}
    out: Dict[str, List[POSMachine]] = {}
    for member, machine in (
        db.query(MachineGroupMember, POSMachine)
        .join(POSMachine, POSMachine.id == MachineGroupMember.machine_id)
        .filter(MachineGroupMember.group_id.in_(list(group_ids)))
        .all()
    ):
        out.setdefault(str(member.group_id), []).append(machine)
    for machines in out.values():
        machines.sort(key=lambda m: (m.pos_number if m.pos_number is not None else 1 << 30, m.name or ""))
    return out


def group_out(db: Session, user: User, group: MachineGroup, members: List[POSMachine], companies: Dict[str, str],
              shops: Dict[str, str]) -> Dict[str, Any]:
    from app.services.menu import may_write_company

    return {
        "id": str(group.id),
        "companyId": str(group.company_id),
        "companyName": companies.get(str(group.company_id)),
        "name": group.name,
        "sortOrder": group.sort_order or 0,
        "machineIds": [str(m.id) for m in members],
        "machines": [
            {
                "id": str(m.id), "name": m.name, "posNumber": m.pos_number,
                "shopId": str(m.shop_id) if m.shop_id else None,
                "shopName": shops.get(str(m.shop_id)) if m.shop_id else None,
                "isActive": bool(m.is_active),
            }
            for m in members
        ],
        "canEdit": may_write_company(db, user, group.tenant_id, group.company_id),
        "updatedAt": group.updated_at.isoformat() if group.updated_at else None,
    }


def list_groups(db: Session, user: User, tenant_id, *, company_id=None) -> List[Dict[str, Any]]:
    """The groups of the companies the user sees (`company_id`: that company and those beneath it)."""
    from app.services.company_hierarchy import catalog_company_ids, descendant_company_ids

    if not ready(db):
        return []
    q = db.query(MachineGroup).filter(MachineGroup.tenant_id == tenant_id)
    visible = catalog_company_ids(db, user)
    if visible is not None:
        q = q.filter(MachineGroup.company_id.in_(list(visible) or [uuid.uuid4()]))
    if company_id is not None:
        q = q.filter(MachineGroup.company_id.in_(list(descendant_company_ids(db, company_id)) or [company_id]))
    groups = q.order_by(MachineGroup.sort_order, MachineGroup.name).all()
    members = _members(db, [g.id for g in groups])
    companies = {
        str(c.id): c.name for c in db.query(Company).filter(Company.id.in_([g.company_id for g in groups])).all()
    } if groups else {}
    shop_ids = {m.shop_id for ms in members.values() for m in ms if m.shop_id}
    shops = {str(s.id): s.name for s in db.query(Shop).filter(Shop.id.in_(list(shop_ids))).all()} if shop_ids else {}
    return [group_out(db, user, g, members.get(str(g.id), []), companies, shops) for g in groups]


def _validate_members(db: Session, tenant_id, company_id, machine_ids: Sequence) -> List[uuid.UUID]:
    from app.services.catalog_menus import company_chain

    wanted: List[uuid.UUID] = []
    for raw in machine_ids or []:
        mid = _as_uuid(raw)
        if mid is None:
            raise _bad(f"{NOT_IN_COMPANY}:{raw}")
        if mid not in wanted:
            wanted.append(mid)
    if not wanted:
        return []
    machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(wanted)).all()}
    shops = {
        s.id: s for s in db.query(Shop).filter(Shop.id.in_([m.shop_id for m in machines.values() if m.shop_id])).all()
    }
    for mid in wanted:
        m = machines.get(mid)
        shop = shops.get(m.shop_id) if m is not None and m.shop_id else None
        if (
            m is None or str(m.tenant_id) != str(tenant_id) or not m.is_active or shop is None
            or str(company_id) not in {str(c) for c in company_chain(db, shop.company_id)}
        ):
            raise _bad(f"{NOT_IN_COMPANY}:{mid}")
    return wanted


def _set_members(db: Session, group: MachineGroup, wanted: List[uuid.UUID]) -> bool:
    existing = {
        m.machine_id: m for m in db.query(MachineGroupMember).filter(MachineGroupMember.group_id == group.id).all()
    }
    changed = False
    for mid, row in existing.items():
        if mid not in wanted:
            db.delete(row)
            changed = True
    for mid in wanted:
        if mid not in existing:
            db.add(MachineGroupMember(group_id=group.id, machine_id=mid))
            changed = True
    return changed


def _bump(db: Session, tenant_id) -> None:
    from app.services.catalog_menus import bump, tables_ready

    db.flush()
    if tables_ready(db):
        bump(db, tenant_id)


def create(db: Session, user: User, tenant_id, *, company_id, name: str, machine_ids: Sequence = ()) -> MachineGroup:
    _check_write(db, user, tenant_id, company_id)
    clean = _clean_name(name)
    _name_free(db, company_id, clean)
    wanted = _validate_members(db, tenant_id, company_id, machine_ids)
    group = MachineGroup(
        id=uuid.uuid4(), tenant_id=tenant_id, company_id=company_id, name=clean, created_by=getattr(user, "id", None),
    )
    db.add(group)
    db.flush()
    _set_members(db, group, wanted)
    _bump(db, tenant_id)
    return group


def rename(db: Session, user: User, tenant_id, group_id, *, name: Optional[str] = None,
           sort_order: Optional[int] = None) -> MachineGroup:
    group = _group(db, tenant_id, group_id)
    _check_write(db, user, tenant_id, group.company_id)
    if name is not None:
        clean = _clean_name(name)
        _name_free(db, group.company_id, clean, except_id=group.id)
        group.name = clean
    if sort_order is not None:
        group.sort_order = sort_order
    _bump(db, tenant_id)
    return group


def set_members(db: Session, user: User, tenant_id, group_id, machine_ids: Sequence) -> MachineGroup:
    group = _group(db, tenant_id, group_id)
    _check_write(db, user, tenant_id, group.company_id)
    wanted = _validate_members(db, tenant_id, group.company_id, machine_ids)
    if _set_members(db, group, wanted):
        _bump(db, tenant_id)
    return group


def delete(db: Session, user: User, tenant_id, group_id) -> None:
    """The group, its members, and the menus assigned to it (with its fallback) — all gone."""
    from app.models.catalog_menu import CatalogMenuAssignment, CatalogMenuFallback

    from app.services.catalog_menus import tables_ready

    group = _group(db, tenant_id, group_id)
    _check_write(db, user, tenant_id, group.company_id)
    db.query(MachineGroupMember).filter(MachineGroupMember.group_id == group.id).delete(synchronize_session=False)
    if tables_ready(db):
        db.query(CatalogMenuAssignment).filter(
            CatalogMenuAssignment.level == "group", CatalogMenuAssignment.target_id == group.id,
        ).delete(synchronize_session=False)
        db.query(CatalogMenuFallback).filter(
            CatalogMenuFallback.level == "group", CatalogMenuFallback.target_id == group.id,
        ).delete(synchronize_session=False)
    db.delete(group)
    _bump(db, tenant_id)
