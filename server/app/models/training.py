"""
"מצב הדרכה" (shop training mode, docs/SPEC_TRAINING_MODE.md) and the demo menu.

Three tables:

* `training_documents` — the quarantine. Every document a till sends while its shop is
  in training mode (a sale, a shift open or close, a Z, an X, a till event…) lands here,
  as it was sent, and NEVER in `transactions` / `shifts` / `z_reports`. So no report,
  export, Z or transmission ever sees it. Idempotent by (till, kind, the till's own id).
  Purged when the shop leaves training mode (app/services/training_mode.py).
* `training_audit_log` — who turned training mode on or off, when, and what was deleted;
  also the training documents dropped because they arrived after the shop left it.
* `demo_menu_items` — everything one demo-menu load created (app/services/demo_menu.py),
  so that "הסר תפריט דמה" removes exactly that and nothing a person added.

The shop's own flag and its started/ended stamps are columns of `shops`.
"""
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

#: What a quarantined document is.
TRAINING_KINDS = ("transaction", "shift", "z", "x", "other")

#: `training_audit_log.action`.
AUDIT_ENABLED = "enabled"
AUDIT_DISABLED = "disabled"
AUDIT_DROPPED = "dropped"


class TrainingDocument(Base):
    __tablename__ = "training_documents"
    __table_args__ = (
        UniqueConstraint("machine_id", "kind", "local_id", name="uq_training_documents_machine_kind_local"),
        Index("ix_training_documents_shop_kind", "shop_id", "kind"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False)
    #: transaction | shift | z | x | other (`TRAINING_KINDS`).
    kind = Column(String(16), nullable=False)
    #: The till's own id of the document (a sale's id, a shift's id, a Z's request id…).
    local_id = Column(String(100), nullable=False)
    #: Its number as printed ("ה-12"), when it has one.
    number = Column(String(100), nullable=True)
    #: The document exactly as the till sent it. A shift's close is merged into its open.
    payload = Column(JSONB, nullable=False, server_default="{}")
    received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=True)


class TrainingAuditLog(Base):
    __tablename__ = "training_audit_log"
    __table_args__ = (Index("ix_training_audit_log_shop_created", "shop_id", "created_at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    #: enabled | disabled | dropped
    action = Column(String(16), nullable=False)
    #: The dashboard user (enabled / disabled); null for a till's dropped documents.
    user_id = Column(UUID(as_uuid=True), nullable=True)
    #: The till (dropped documents).
    machine_id = Column(UUID(as_uuid=True), nullable=True)
    #: What was deleted (disabled), what was dropped (dropped)…
    details = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class DemoMenuItem(Base):
    __tablename__ = "demo_menu_items"
    __table_args__ = (
        Index("ix_demo_menu_items_company_shop", "company_id", "shop_id"),
        Index("ix_demo_menu_items_load", "load_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    #: The shop the load was for (its products are sold there only); null: the whole company.
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=True)
    #: One load: everything it created shares this id.
    load_id = Column(UUID(as_uuid=True), nullable=False)
    #: restaurant | bar | cafe | restaurant_bar (app/services/demo_menu_templates.py)
    template = Column(String(32), nullable=False)
    #: category | product | modifier_group | upsell | course | prep_note
    entity_type = Column(String(32), nullable=False)
    #: Not a key: the row may have been deleted by hand since; removal skips it then.
    entity_id = Column(UUID(as_uuid=True), nullable=False)
    created_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
