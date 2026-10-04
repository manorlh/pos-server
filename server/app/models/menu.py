"""
The restaurant menu layer ("תוספות ושינויים", docs/SPEC_MENU_MODIFIERS.md): what a dish can
be ordered with, how it is noted, what it contains, how meals are built and what the till
suggests. All of it is defined in the cloud, sent to the tills in the catalog sync as one
`menu` block and applied on the till, offline.

* `modifier_groups` / `modifier_options` — a reusable group ("מידת עשייה", "תוספות") of
  options, each with a price, allergens, a kitchen label, a default flag and an optional
  linked product for stock and reporting. Org-wide, or one company's (and the companies
  under it) when `company_id` is set.
* `modifier_links` — which groups a category or a product gets. A product with rows of its
  own ignores its category's; a category without rows inherits its parent's; a row with
  `group_id` NULL is an explicit "no modifiers" that stops the inheritance — the rule the
  kitchen printers' routes and the item tickets already follow.
* `prep_note_presets` — quick note chips per product / category (same rule), plus the ones
  every dish gets (`target_type = 'all'`).
* `meal_slots` / `meal_slot_options` — a meal product's slots (main / side / drink) and
  the products each may hold, with an upcharge and a default.
* `upsell_rules` / `upsell_stats` — "would you like fries with that": the rules, and the
  tills' daily counts of how often each was shown, taken and dismissed.
* `menu_courses` — the courses a table's lines are fired in ("ראשונות", "עיקריות").
* `menu_sync_state` — when the menu last changed, per organization: what decides whether a
  delta catalog pull carries the menu block.
* `transaction_item_parts` — a sold line taken apart for the reports: its modifiers, and a
  meal's components with the line's money allocated to them.

See app/services/menu.py for the rules.
"""
import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    Numeric,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: How a group's choices print: as they are ("מדיום"), as additions ("+ גבינה") or as
#: removals ("בלי עגבנייה", bold in the kitchen).
GROUP_KINDS = ("choice", "addon", "removal")
LINK_TARGET_TYPES = ("category", "product")
NOTE_TARGET_TYPES = ("all", "category", "product")
UPSELL_TRIGGER_TYPES = ("product", "category")
UPSELL_ACTIONS = ("add", "upgrade")

#: The allergens a product or an option can be tagged with: the eight main ones first,
#: then the rest of the EU's fourteen.
ALLERGENS_MAIN = ("gluten", "milk", "nuts", "eggs", "peanuts", "fish", "soy", "sesame")
ALLERGENS_OPTIONAL = ("celery", "mustard", "sulphites", "lupin", "molluscs", "crustaceans")
ALLERGENS = ALLERGENS_MAIN + ALLERGENS_OPTIONAL

#: Pre-modifiers a group may allow on its options: מעט / הרבה / בצד.
PRE_MODIFIERS = ("lite", "extra", "side")


class ModifierGroup(Base):
    __tablename__ = "modifier_groups"
    __table_args__ = (
        CheckConstraint("kind IN ('choice', 'addon', 'removal')", name="ck_modifier_groups_kind"),
        CheckConstraint("min_select >= 0", name="ck_modifier_groups_min"),
        Index("ix_modifier_groups_tenant", "tenant_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    #: Null: the whole organization. Set: that company and every company under it.
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(100), nullable=False)
    kind = Column(String(16), nullable=False, default="addon", server_default="addon")
    #: 1 or more: the group must be answered before the dish can be added ("חובה").
    min_select = Column(Integer, nullable=False, default=0, server_default="0")
    #: Null: no upper limit.
    max_select = Column(Integer, nullable=True)
    #: This many units of choice are free — the cheapest ones, whatever order they were
    #: picked in, so editing a line never changes its price.
    free_count = Column(Integer, nullable=False, default=0, server_default="0")
    #: An option can be taken more than once (×2), each unit counting towards the max.
    allow_quantity = Column(Boolean, nullable=False, default=False, server_default="false")
    #: Options can be ordered "מעט" / "הרבה" (twice the price) / "בצד".
    allow_pre = Column(Boolean, nullable=False, default=False, server_default="false")
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class ModifierOption(Base):
    __tablename__ = "modifier_options"
    __table_args__ = (Index("ix_modifier_options_group", "group_id"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    group_id = Column(UUID(as_uuid=True), ForeignKey("modifier_groups.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    #: Short label for the kitchen ticket; the name when empty.
    kitchen_name = Column(String(60), nullable=True)
    #: Added to the dish's price per unit chosen; 0 is free.
    price = Column(Numeric(10, 2), nullable=False, default=0, server_default="0")
    is_default = Column(Boolean, nullable=False, default=False, server_default="false")
    #: Allergen codes (`ALLERGENS`).
    allergens = Column(JSON, nullable=True)
    #: A product this option uses up (stock) and is reported as. Not a key: a deleted
    #: product leaves the option working.
    linked_product_id = Column(UUID(as_uuid=True), nullable=True)
    #: The most of this one option in one dish ("ביצים" up to 3), within the group's
    #: `max_select`. Null: no limit of its own.
    max_qty = Column(Integer, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")


class ModifierLink(Base):
    __tablename__ = "modifier_links"
    __table_args__ = (
        CheckConstraint("target_type IN ('category', 'product')", name="ck_modifier_links_target_type"),
        Index("ix_modifier_links_target", "tenant_id", "target_type", "target_id"),
        Index("ix_modifier_links_group", "group_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    target_type = Column(String(16), nullable=False)
    #: A category or product id. No key, like the printers' routes: a deleted target's
    #: rows are never reached.
    target_id = Column(UUID(as_uuid=True), nullable=False)
    #: Null: "no modifiers" for this target — stops the inheritance from its category.
    group_id = Column(UUID(as_uuid=True), ForeignKey("modifier_groups.id", ondelete="CASCADE"), nullable=True)
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")


class PrepNotePreset(Base):
    __tablename__ = "prep_note_presets"
    __table_args__ = (
        CheckConstraint(
            "target_type IN ('all', 'category', 'product')", name="ck_prep_note_presets_target_type"
        ),
        Index("ix_prep_note_presets_tenant", "tenant_id", "target_type", "target_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=True)
    target_type = Column(String(16), nullable=False)
    #: Null for `all`.
    target_id = Column(UUID(as_uuid=True), nullable=True)
    text = Column(String(60), nullable=False)
    #: Picking it marks the line's note important (printed inverted in the kitchen).
    is_important = Column(Boolean, nullable=False, default=False, server_default="false")
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class MealSlot(Base):
    __tablename__ = "meal_slots"
    __table_args__ = (Index("ix_meal_slots_product", "product_id"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    #: The meal product.
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(60), nullable=False)
    #: How many items of this slot one meal includes ("2 hot drinks").
    quantity = Column(Integer, nullable=False, default=1, server_default="1")
    #: How many must be chosen when the meal is ordered (0: the slot may wait or stay empty).
    min_select = Column(Integer, nullable=False, default=1, server_default="1")
    #: How many may be chosen when it is ordered; never more than `quantity`.
    max_select = Column(Integer, nullable=False, default=1, server_default="1")
    #: The same product may fill more than one of the slot's items (two colas).
    allow_repeat = Column(Boolean, nullable=False, default=False, server_default="false")
    #: What is not chosen at the order can be taken later ("להזמין אחר כך"), at no charge.
    deferred = Column(Boolean, nullable=False, default=False, server_default="false")
    #: Refills of the slot's item at no charge; `max_refills` per meal, null = unlimited.
    refillable = Column(Boolean, nullable=False, default=False, server_default="false")
    max_refills = Column(Integer, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")


class MealSlotOption(Base):
    __tablename__ = "meal_slot_options"
    __table_args__ = (Index("ix_meal_slot_options_slot", "slot_id"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    slot_id = Column(UUID(as_uuid=True), ForeignKey("meal_slots.id", ondelete="CASCADE"), nullable=False)
    #: The component product.
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    #: Added to the meal's price when picked ("צ'יפס גדול +3").
    upcharge = Column(Numeric(10, 2), nullable=False, default=0, server_default="0")
    is_default = Column(Boolean, nullable=False, default=False, server_default="false")
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")


class UpsellRule(Base):
    __tablename__ = "upsell_rules"
    __table_args__ = (
        CheckConstraint("trigger_type IN ('product', 'category')", name="ck_upsell_rules_trigger_type"),
        CheckConstraint("action IN ('add', 'upgrade')", name="ck_upsell_rules_action"),
        Index("ix_upsell_rules_tenant", "tenant_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(120), nullable=False)
    trigger_type = Column(String(16), nullable=False)
    #: Product or category ids (a category includes its sub-categories).
    trigger_ids = Column(JSON, nullable=False)
    action = Column(String(16), nullable=False, default="add", server_default="add")
    #: What is suggested: the product to add, or the one the line becomes.
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    #: Shown on the till's card; empty: the till's own wording.
    message = Column(String(200), nullable=True)
    show_price = Column(Boolean, nullable=False, default=True, server_default="true")
    #: "HH:MM" local, both or neither; may cross midnight. Weekdays 0 = Sunday.
    start_time = Column(String(5), nullable=True)
    end_time = Column(String(5), nullable=True)
    weekdays = Column(JSON, nullable=True)
    priority = Column(Integer, nullable=False, default=0, server_default="0")
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class UpsellStat(Base):
    """One till's counts for one rule on one local day, as the till last reported them."""

    __tablename__ = "upsell_stats"
    __table_args__ = (
        UniqueConstraint("machine_id", "rule_id", "day", name="uq_upsell_stats_machine_rule_day"),
        Index("ix_upsell_stats_tenant_day", "tenant_id", "day"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False)
    shop_id = Column(UUID(as_uuid=True), nullable=True)
    #: Not a key: the counts outlive a deleted rule.
    rule_id = Column(UUID(as_uuid=True), nullable=False)
    day = Column(Date, nullable=False)
    shown = Column(Integer, nullable=False, default=0, server_default="0")
    accepted = Column(Integer, nullable=False, default=0, server_default="0")
    dismissed = Column(Integer, nullable=False, default=0, server_default="0")
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class MenuCourse(Base):
    __tablename__ = "menu_courses"
    __table_args__ = (Index("ix_menu_courses_tenant", "tenant_id"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(60), nullable=False)
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class MenuSyncState(Base):
    """When anything in an organization's menu last changed — deletes included."""

    __tablename__ = "menu_sync_state"

    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True)
    changed_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class TransactionItemPart(Base):
    """
    One part of a sold line, for the reports: a modifier chosen on it, or — on a meal —
    one of its components, with the line's money allocated to it so the components of a
    line add up to the line to the agora. Rebuilt from `transaction_items.details` every
    time the document is pushed.
    """

    __tablename__ = "transaction_item_parts"
    __table_args__ = (
        CheckConstraint("kind IN ('component', 'modifier')", name="ck_transaction_item_parts_kind"),
        Index("ix_transaction_item_parts_transaction", "transaction_id"),
        Index("ix_transaction_item_parts_item", "item_id"),
        Index("ix_transaction_item_parts_product", "product_id"),
        Index("ix_transaction_item_parts_option", "option_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    transaction_id = Column(
        UUID(as_uuid=True), ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False
    )
    item_id = Column(UUID(as_uuid=True), nullable=False)
    kind = Column(String(16), nullable=False)
    #: For a modifier of a meal's component: which component (its position); else null.
    component_index = Column(Integer, nullable=True)
    #: The component, or the option's linked product.
    product_id = Column(UUID(as_uuid=True), nullable=True)
    #: The product the modifier was ordered on (the line's, or the component's).
    base_product_id = Column(UUID(as_uuid=True), nullable=True)
    group_id = Column(UUID(as_uuid=True), nullable=True)
    group_name = Column(String(100), nullable=True)
    option_id = Column(UUID(as_uuid=True), nullable=True)
    name = Column(String(255), nullable=True)
    #: The group's kind for a modifier (choice / addon / removal).
    modifier_kind = Column(String(16), nullable=True)
    pre = Column(String(16), nullable=True)
    #: Units over the whole line (per-unit quantity × the line's quantity).
    quantity = Column(Numeric(12, 3), nullable=False, default=0)
    #: A modifier: its price per unit; a component: its upcharge per unit.
    unit_price = Column(Numeric(12, 2), nullable=True)
    #: A modifier: what it was charged over the line. A component: its allocated share of
    #: the line's gross. Either way inside the line's `total_price`.
    gross = Column(Numeric(12, 2), nullable=False, default=0)
    #: A component's allocated share of the line's discounts; null for a modifier.
    discount = Column(Numeric(12, 2), nullable=True)
