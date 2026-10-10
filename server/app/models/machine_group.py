"""
"קבוצות מכשירים" — named groups of tills ("קיוסקים", "בר", "עמדות אירוע"), across the shops of
one company, so a catalog menu ("תפריטים", app/models/catalog_menu.py) can be assigned to them
all at once: assignment level `group`, between the point of sale and the till
(machine > group > area > shop > company).

* `machine_groups` — the group: its company, its name (unique in the company).
* `machine_group_members` — its tills. A till may belong to several groups; when they assign
  menus active at the same moment, the higher priority wins, and at the same priority the most
  recently updated assignment (app/services/catalog_menu_rules.py `resolve`).

Deleting a group removes its members, and its menu assignments and fallback with it
(app/services/machine_groups.py); deleting a till removes its memberships.
"""
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class MachineGroup(Base):
    __tablename__ = "machine_groups"
    __table_args__ = (
        UniqueConstraint("company_id", "name", name="uq_machine_groups_company_name"),
        Index("ix_machine_groups_tenant", "tenant_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    #: Its tills stand in shops of this company.
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(80), nullable=False)
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class MachineGroupMember(Base):
    __tablename__ = "machine_group_members"
    __table_args__ = (Index("ix_machine_group_members_machine", "machine_id"),)

    group_id = Column(UUID(as_uuid=True), ForeignKey("machine_groups.id", ondelete="CASCADE"), primary_key=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), primary_key=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
