"""
The tables' state version per shop ("גרסת מצב השולחנות").

One row per shop, `version` raised by every write that changes what `GET /sync/{m}/tables`
answers (app/services/tables_state.py). A till that already holds that version is answered
304 / "unchanged" without the state being built, and the realtime "tables" signal carries
it, so a till pulls only when it is behind.

No foreign key to `shops`: a row is a counter, written last in its transaction, and must not
lock the shop row on every table write.
"""
from __future__ import annotations

from sqlalchemy import BigInteger, Column, DateTime, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class TablesStateVersion(Base):
    __tablename__ = "tables_state_versions"

    shop_id = Column(UUID(as_uuid=True), primary_key=True)
    version = Column(BigInteger, nullable=False, default=0, server_default="0")
    changed_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
