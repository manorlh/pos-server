"""
"אזל" / "חסום" — a block on a product for a scope, from the dashboard in one tap, or by itself
when the stock it sells from reaches 0 (app/services/sold_out.py; the rule the till shares:
app/services/sold_out_rules.py).

Not the catalog lock ("זמינות למכירה", app/services/product_availability.py): a block is the floor
of the day — the product ran out, or the owner stops it for a while ("הגריל סגור"). Several blocks
may cover one product; any one in force covering a device stops it there. `kind`:

* `sold_out` ("אזל", the default) — the till shows "אזל" and a manager may approve a sale anyway
  with the manager code;
* `blocked` ("חסום", with an optional reason in `note`) — the till refuses it.

The kiosks grey it out or hide it (`general.soldOutMode`) either way. A block ends by itself at
`until`, when removed, or — an automatic one — when stock comes back or the daily reset runs.
Rows are never deleted: removing stamps `cleared_at` (and `updated_at`), so a till that pulls
deltas sees the product change, and the screen can say who did what.

`scope` / `scope_id`: `company` · `shop` · `kiosks` (every kiosk of the shop, `scope_id` = the shop)
· `area` · `group` · `event` · `machine` (a till or a kiosk) · `kiosk` (that device while it is a
kiosk). An automatic block's scope is the stock location that reached 0.
"""
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: The scopes, farthest first.
SOLD_OUT_SCOPES = ("company", "shop", "kiosks", "event", "group", "area", "kiosk", "machine")
SOLD_OUT_KINDS = ("sold_out", "blocked")
#: Who set it: a person, or the stock reaching 0.
SOLD_OUT_SOURCES = ("manual", "auto")


class SoldOutMark(Base):
    __tablename__ = "sold_out_marks"
    __table_args__ = (
        Index("ix_sold_out_marks_shop_product", "shop_id", "product_id"),
        Index("ix_sold_out_marks_scope", "scope", "scope_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=True, index=True)
    #: The scope's shop; NULL for a company-wide block.
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=True)
    #: The global product.
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    scope = Column(String(16), nullable=False)
    scope_id = Column(UUID(as_uuid=True), nullable=False)
    #: "sold_out" | "blocked".
    kind = Column(String(16), nullable=False, default="sold_out", server_default="sold_out")
    #: Ends by itself then; NULL = until removed.
    until = Column(DateTime(timezone=True), nullable=True)
    #: How the end was asked ("minutes" | "time" | "end_of_day" | "none"), for "עד סוף היום".
    until_mode = Column(String(16), nullable=True)
    source = Column(String(16), nullable=False, default="manual", server_default="manual")
    #: The reason of a "חסום" (or a note on an "אזל").
    note = Column(String(200), nullable=True)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    cleared_at = Column(DateTime(timezone=True), nullable=True)
    cleared_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    cleared_by_name = Column(String(200), nullable=True)
    #: The tills' delta watermark: a block, its removal and its end all move it.
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
