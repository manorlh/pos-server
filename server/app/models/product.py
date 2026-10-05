import uuid
import enum

from sqlalchemy import (
    Column, String, Boolean, ForeignKey, Numeric, Integer,
    Enum as SQLEnum, DateTime, Index, UniqueConstraint, text, JSON,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class CatalogLevel(str, enum.Enum):
    GLOBAL = "global"   # Master product at tenant/company level
    LOCAL = "local"     # Shop/machine copy, may override global values


class Product(Base):
    __tablename__ = "products"
    __table_args__ = (
        UniqueConstraint("tenant_id", "sku", name="uq_product_sku_tenant"),
        # At most one built-in general item per company (see `is_general`). Partial, so
        # it constrains nothing else. Created by migration e7f8a9b0c1d2.
        Index(
            "uq_products_general_per_company",
            "company_id",
            unique=True,
            postgresql_where=text("is_general"),
            sqlite_where=text("is_general"),
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True, index=True)
    pos_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True)
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id"), nullable=False)
    global_product_id = Column(UUID(as_uuid=True), ForeignKey("products.id"), nullable=True)
    catalog_level = Column(SQLEnum(CatalogLevel, values_callable=lambda x: [e.value for e in x]), nullable=False, default=CatalogLevel.GLOBAL)
    is_local_override = Column(Boolean, default=False, nullable=False)

    name = Column(String(255), nullable=False)
    description = Column(String(1000), nullable=True)
    price = Column(Numeric(10, 2), nullable=False)
    sku = Column(String(100), nullable=False, index=True)
    global_sku = Column(String(100), nullable=True, index=True)
    sku_auto_assigned = Column(Boolean, default=False, nullable=False)
    image_url = Column(String(500), nullable=True)
    in_stock = Column(Boolean, default=True, nullable=False)
    is_available = Column(Boolean, default=True, nullable=False)
    stock_quantity = Column(Integer, default=0, nullable=False)
    barcode = Column(String(100), nullable=True)
    tax_rate = Column(Numeric(5, 2), nullable=True)
    voucher_id = Column(UUID(as_uuid=True), ForeignKey("vouchers.id"), nullable=True, index=True)
    # Item-ticket ("שובר") mode. NULL inherits the category's `ticket_mode`; any value
    # (including "off") wins over it. See app/services/item_ticket.py.
    ticket_mode = Column(String(16), nullable=True)
    # An entry ticket ("כרטיס כניסה"): how many entries one unit grants. More than 1 prints
    # that many separate tickets per unit ("כניסה 2/4"), whatever the ticket mode. NULL or 1
    # is an ordinary product.
    ticket_entries = Column(Integer, nullable=True)
    track_stock = Column(Boolean, default=False, nullable=False, server_default="false")
    # "General item": the cashier types the amount at the till. `price` is then only the
    # starting suggestion the till pre-fills, never the amount charged on its own.
    is_open_price = Column(Boolean, default=False, nullable=False, server_default="false")
    # Sold by weight or volume rather than by the piece: the till's cart quantity is a
    # decimal, so 0.734 ק"ג is a valid line and `price` is per unit of `unit_label`.
    #
    # Orthogonal to `is_open_price` and deliberately compatible with it — see the note
    # on `unit_label`. Shop stock copes with either: `stock_levels.quantity` and
    # `stock_movements.delta` are already Numeric(12,3). (The legacy per-product
    # `stock_quantity` counter above is still an Integer, but that column is not what
    # a shop's on-hand is read from.)
    is_weighed = Column(Boolean, default=False, nullable=False, server_default="false")
    # What one unit of `price` buys: ק"ג, ליטר, יח'. Free text, not an enum, because the
    # merchant's own label is what has to appear on the receipt and the shelf, and a
    # closed list would need a migration for the first shop that sells by the מטר.
    # Nullable: a product that has not been given one falls back to the till's default.
    unit_label = Column(String(16), nullable=True)

    # The company's built-in "פריט כללי": the product the till's calculator adds its
    # lines as. Every company has exactly one, created with the company and never
    # deleted; open price, standard VAT, sold in every shop of its company. Everything
    # about it lives in app/services/general_item.py.
    is_general = Column(Boolean, default=False, nullable=False, server_default="false")

    # "לא מקבל הנחות": the till gives this product no discount of any kind — the
    # cashier's line discount is refused, a basket discount is taken over the other
    # lines only, and promotions ("מבצעים") never discount it (it still counts towards
    # a spend threshold). Enforced on the till; the cloud only carries the flag.
    no_discount = Column(Boolean, default=False, nullable=False, server_default="false")

    # The menu layer (docs/SPEC_MENU_MODIFIERS.md): the allergen codes the dish contains
    # (app.models.menu.ALLERGENS), and the course its table lines are fired in by default
    # — null inherits the category's. Not a key, like the routes: a deleted course reads
    # as none.
    allergens = Column(JSON, nullable=True)
    course_id = Column(UUID(as_uuid=True), nullable=True)
    #: At most this many in one order (a promotional item limited to 1); null: no limit.
    max_per_order = Column(Integer, nullable=True)
    #: Refills at no charge ("כוס נוספת") — `max_refills` per line, null = unlimited.
    refillable = Column(Boolean, nullable=False, default=False, server_default="false")
    max_refills = Column(Integer, nullable=True)

    # "הודעות לעובד על פריט" (app/services/product_alerts.py): what the till shows the
    # employee on adding the product, before it enters the order —
    # `[{text, kind, requireAck, whereShown}]`, in order. Null: none, as before.
    alerts = Column(JSON, nullable=True)
    #: "הצג אזהרת אלרגנים": one more alert, built from `allergens` in Hebrew.
    allergen_alert = Column(Boolean, nullable=False, default=False, server_default="false")
    #: That alert must be confirmed ("עדכנתי את הלקוח") — on by default.
    allergen_alert_require_ack = Column(Boolean, nullable=False, default=True, server_default="true")
    # "פריטים נלווים": products the till adds with this one, as lines of their own under
    # it — `[{productId, name, quantity, priceMode, price, kitchenPrint}]`. Null: none.
    companions = Column(JSON, nullable=True)

    # Where a global product is sold. Null is every product that predates this: its
    # shops are whatever rows somebody added by hand on the assortment page. "company"
    # is a rule — every shop of `shop_scope_company_id` (and, if asked, of the
    # companies beneath it), including shops opened later. "shops" is an explicit list
    # and adds nothing on its own. All of it is applied in
    # app/services/product_shop_scope.py and nowhere else.
    shop_scope_mode = Column(String(16), nullable=True)
    shop_scope_company_id = Column(
        UUID(as_uuid=True), ForeignKey("companies.id", ondelete="SET NULL"), nullable=True, index=True
    )
    shop_scope_include_subcompanies = Column(
        Boolean, default=False, nullable=False, server_default="false"
    )

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    company = relationship("Company", back_populates="products", foreign_keys=[company_id])
    shop = relationship("Shop", back_populates="products")
    pos_machine = relationship("POSMachine", back_populates="products")
    category = relationship("Category", back_populates="products")
    global_product = relationship("Product", remote_side="Product.id")
    voucher = relationship("Voucher", back_populates="products")

    @property
    def shop_scope(self):
        """The scope as the API shows it, or None for a hand-managed product."""
        if not self.shop_scope_mode:
            return None
        return {
            "mode": self.shop_scope_mode,
            "company_id": self.shop_scope_company_id,
            "include_subcompanies": bool(self.shop_scope_include_subcompanies),
        }
