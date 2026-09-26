"""
One till's whitelist: which of its shop's products it sells when it is in "selected" mode.

A till's catalog has two modes, on `pos_machines.catalog_mode`:

* ``all`` (the default, and every till's behaviour before this table existed) — the
  till sells its shop's whole catalog;
* ``selected`` — the till sells only the products that have a row here with
  ``is_included = true`` **and** are still in its shop's catalog.

The rule itself, and every write, live in `app/services/machine_catalog.py`.

`is_included` is a plain bool and removal writes ``false`` rather than deleting the row,
for the same reason `machine_product_overrides.is_available` is cleared to NULL instead
of deleted: the tills pull by delta on `updated_at`, and the catalog watermark reads
`max(updated_at)` — a deleted row leaves nothing for either to see, and the till would
keep selling a product that was taken off its list.

A row is independent of the mode. Switching a till back to "all" leaves its list alone,
so switching to "selected" again restores exactly what was chosen before.

`ON DELETE CASCADE` on both foreign keys: a whitelist entry means nothing once the till
or the product is gone, and must never be what blocks deleting either.
"""
import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class MachineCatalogItem(Base):
    __tablename__ = "machine_catalog_items"
    __table_args__ = (
        UniqueConstraint("machine_id", "product_id", name="uq_machine_catalog_item"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id = Column(
        UUID(as_uuid=True),
        ForeignKey("pos_machines.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    product_id = Column(
        UUID(as_uuid=True),
        ForeignKey("products.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    is_included = Column(Boolean, nullable=False, default=True, server_default="true")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
