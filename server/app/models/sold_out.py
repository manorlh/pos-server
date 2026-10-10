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

Two axes (specs/item-blocks-targets.md): the **level** — `scope` / `scope_id`: `company` · `shop` ·
`area` · `group` · `event` · `machine` (a till or a kiosk) — and the **target** — `all` ("קופות
וקיוסקים", the default) · `kiosks` ("קיוסקים בלבד") · `tills` ("קופות בלבד"). The two older scopes
stay readable: `kiosks` (every kiosk of the shop, `scope_id` = the shop) = `shop` + kiosks, `kiosk`
(that device while it is a kiosk) = `machine` + kiosks; new blocks are written as level + target.
An automatic block's scope is the stock location that reached 0 (target `all`).

**What**: a product (`product_id`, the global one) or a category (`category_id`: every product in
it or below it) — exactly one. `kiosk_display` is the kiosks' look for this block ("hide" /
"grey"; NULL = `general.soldOutMode`). `origin` says from where it was set (dashboard, a till, a
kiosk, a controlling till, a migrated "מוסתר בקיוסקים" row, the stock).
"""
import uuid

from sqlalchemy import JSON, CheckConstraint, Column, DateTime, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: The scopes, farthest first.
SOLD_OUT_SCOPES = ("company", "shop", "kiosks", "event", "group", "area", "kiosk", "machine")
SOLD_OUT_KINDS = ("sold_out", "blocked")
#: Who set it: a person, or the stock reaching 0.
SOLD_OUT_SOURCES = ("manual", "auto")
#: Whom at the level: "קופות וקיוסקים" / "קיוסקים בלבד" / "קופות בלבד".
SOLD_OUT_TARGETS = ("all", "kiosks", "tills")
#: The kiosks' look for one block: "הסתר" / "הצג כאזל" (NULL = `general.soldOutMode`).
SOLD_OUT_DISPLAYS = ("hide", "grey")
#: Where a block was set from.
SOLD_OUT_ORIGINS = ("dashboard", "till", "kiosk", "controller", "kiosk_hide", "stock")


class SoldOutMark(Base):
    __tablename__ = "sold_out_marks"
    __table_args__ = (
        Index("ix_sold_out_marks_shop_product", "shop_id", "product_id"),
        Index("ix_sold_out_marks_scope", "scope", "scope_id"),
        Index("ix_sold_out_marks_shop_category", "shop_id", "category_id"),
        # A product or a category — exactly one.
        CheckConstraint("(product_id IS NULL) <> (category_id IS NULL)", name="ck_sold_out_marks_item"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=True, index=True)
    #: The scope's shop; NULL for a company-wide block.
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=True)
    #: The global product — or NULL for a category block.
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), nullable=True)
    #: The category (every product in it or below it) — or NULL for a product block.
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id", ondelete="CASCADE"), nullable=True)
    scope = Column(String(16), nullable=False)
    scope_id = Column(UUID(as_uuid=True), nullable=False)
    #: "all" | "kiosks" | "tills" — whom at the level.
    target = Column(String(8), nullable=False, default="all", server_default="all")
    #: The kiosks' look: "hide" | "grey"; NULL = `general.soldOutMode`.
    kiosk_display = Column(String(8), nullable=True)
    #: Where it was set from (SOLD_OUT_ORIGINS); NULL before origins were kept.
    origin = Column(String(16), nullable=True)
    #: "מופיע ב" — the channels this block covers (pos / kiosk / online / menu,
    #: specs/digital-menu-ordering-cards-plan.md §4.3). NULL: as `target` always meant — the tills
    #: and / or the kiosks, no web channel (app/services/digital_effective_rules.py `block_channels`).
    #: `target` stays the devices' projection; a block without pos and kiosk reaches no device.
    channels = Column(JSON, nullable=True)
    #: Its look on the web channels: "hide" / "label"; NULL = the profile's default.
    web_display = Column(String(8), nullable=True)
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
