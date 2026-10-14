"""kitchen_ticket_designs + the kitchen printers' ticket design columns ("עיצוב בון")

P:/specs/kitchen-ticket-designs.md §3, §6ג, §8 (app/services/kitchen_ticket_style.py,
app/services/kitchen_ticket_designs.py):

- `kitchen_ticket_designs` — a company's named kitchen ticket look: a template (classic,
  classic_legacy, large, compact, courses, modern) and the elements it changes (JSON).
- `kitchen_printers` — `ticket_design` (a bare template) or `ticket_design_id` (a named design, SET
  NULL when it goes), and the printer's own `ticket_font_scale` (80–150), `ticket_header` (a list),
  `ticket_checkboxes`, `ticket_elapsed`, `ticket_fit` (fit / wrap), `ticket_min_text_size`,
  `ticket_max_text_size`, `ticket_header_size`, `ticket_inline_mods`, and the order of the lines
  (`ticket_order`, `ticket_order_list`, `ticket_group_headers`, `ticket_no_course`). All nullable:
  null inherits (the till parameters), so no printer changes until someone picks a design.

The till parameters (`kitchenTicketDesign`, `kitchenTicketInkSaver`, …) are built in at start-up
(`ensure_builtin_parameters`); no rows here. Add-only and idempotent (the auto-reloaded API may have
created the table from the models before this runs). On bb6205ba290c, the release 14.10b merge.

Revision ID: d8a3f1c6e2b7
Revises: bb6205ba290c
Create Date: 2026-10-14 16:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "d8a3f1c6e2b7"
down_revision: Union[str, Sequence[str], None] = "bb6205ba290c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DESIGNS = "kitchen_ticket_designs"
PRINTERS = "kitchen_printers"
TEMPLATES = "('classic', 'classic_legacy', 'large', 'compact', 'courses', 'modern')"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def upgrade() -> None:
    inspector = _inspector()
    if inspector is None or not inspector.has_table(DESIGNS):
        op.create_table(
            DESIGNS,
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column(
                "company_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("companies.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("name", sa.String(60), nullable=False),
            sa.Column("template", sa.String(24), nullable=False, server_default="classic"),
            sa.Column("overrides", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column(
                "updated_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.CheckConstraint(f"template IN {TEMPLATES}", name="ck_kitchen_ticket_designs_template"),
        )
        op.create_index("ix_kitchen_ticket_designs_tenant_id", DESIGNS, ["tenant_id"])
        op.create_index("uq_kitchen_ticket_designs_company_name", DESIGNS, ["company_id", "name"], unique=True)

    existing = set() if inspector is None else {c["name"] for c in inspector.get_columns(PRINTERS)}
    columns = (
        sa.Column("ticket_design", sa.String(24), nullable=True),
        sa.Column(
            "ticket_design_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey(f"{DESIGNS}.id", ondelete="SET NULL", name="fk_kitchen_printers_ticket_design_id"),
            nullable=True,
        ),
        sa.Column("ticket_font_scale", sa.Integer(), nullable=True),
        sa.Column("ticket_header", sa.JSON(), nullable=True),
        sa.Column("ticket_checkboxes", sa.Boolean(), nullable=True),
        sa.Column("ticket_elapsed", sa.Boolean(), nullable=True),
        sa.Column("ticket_fit", sa.String(8), nullable=True),
        sa.Column("ticket_min_text_size", sa.String(4), nullable=True),
        sa.Column("ticket_max_text_size", sa.String(4), nullable=True),
        sa.Column("ticket_header_size", sa.String(4), nullable=True),
        sa.Column("ticket_inline_mods", sa.Boolean(), nullable=True),
        sa.Column("ticket_order", sa.String(10), nullable=True),
        sa.Column("ticket_order_list", sa.JSON(), nullable=True),
        sa.Column("ticket_group_headers", sa.String(4), nullable=True),
        sa.Column("ticket_no_course", sa.String(6), nullable=True),
    )
    added = False
    for column in columns:
        if column.name not in existing:
            op.add_column(PRINTERS, column)
            added = True
    if added:
        op.create_check_constraint(
            "ck_kitchen_printers_ticket_design", PRINTERS, f"ticket_design IS NULL OR ticket_design IN {TEMPLATES}",
        )
        op.create_check_constraint(
            "ck_kitchen_printers_ticket_design_one", PRINTERS, "ticket_design IS NULL OR ticket_design_id IS NULL",
        )
        op.create_check_constraint(
            "ck_kitchen_printers_ticket_font_scale", PRINTERS,
            "ticket_font_scale IS NULL OR (ticket_font_scale >= 80 AND ticket_font_scale <= 150)",
        )
        op.create_check_constraint(
            "ck_kitchen_printers_ticket_text", PRINTERS,
            "(ticket_fit IS NULL OR ticket_fit IN ('fit', 'wrap'))"
            " AND (ticket_min_text_size IS NULL OR ticket_min_text_size IN ('xs', 's', 'm'))"
            " AND (ticket_max_text_size IS NULL OR ticket_max_text_size IN ('s', 'm', 'l'))"
            " AND (ticket_header_size IS NULL OR ticket_header_size IN ('s', 'm', 'l'))",
        )
        op.create_check_constraint(
            "ck_kitchen_printers_ticket_order", PRINTERS,
            "(ticket_order IS NULL OR ticket_order IN ('added', 'course', 'category', 'custom'))"
            " AND (ticket_group_headers IS NULL OR ticket_group_headers IN ('auto', 'on', 'off'))"
            " AND (ticket_no_course IS NULL OR ticket_no_course IN ('first', 'last'))",
        )


def downgrade() -> None:
    op.drop_constraint("ck_kitchen_printers_ticket_order", PRINTERS, type_="check")
    op.drop_constraint("ck_kitchen_printers_ticket_text", PRINTERS, type_="check")
    op.drop_constraint("ck_kitchen_printers_ticket_font_scale", PRINTERS, type_="check")
    op.drop_constraint("ck_kitchen_printers_ticket_design_one", PRINTERS, type_="check")
    op.drop_constraint("ck_kitchen_printers_ticket_design", PRINTERS, type_="check")
    for name in (
        "ticket_no_course", "ticket_group_headers", "ticket_order_list", "ticket_order", "ticket_inline_mods", "ticket_header_size", "ticket_max_text_size", "ticket_min_text_size", "ticket_fit",
        "ticket_elapsed", "ticket_checkboxes", "ticket_header", "ticket_font_scale", "ticket_design_id", "ticket_design",
    ):
        op.drop_column(PRINTERS, name)
    op.drop_table(DESIGNS)
