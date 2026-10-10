""""התאמת אשראי מול Z-Credit": runs and their items

* `zcredit_recon_runs` — one run of one Z-Credit terminal for one business day (nightly or
  "הרץ התאמה עכשיו"): the outcome, the totals per category, the deposits compared.
* `zcredit_recon_items` — one row per transaction compared, both sides, the owner's "טופל".

Add-only and idempotent: the auto-reloading dev API's `create_all` may make the tables before this
runs, so each table and its indexes are looked at first. Never downgraded in place.

Revision ID: 5d2b8f1e7c39
Revises: b8e2d4f6a1c3
Create Date: 2026-10-09
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "5d2b8f1e7c39"
down_revision: Union[str, Sequence[str], None] = "d9b3f7a1c5e8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

RUNS = "zcredit_recon_runs"
ITEMS = "zcredit_recon_items"

RUN_INDEXES = {
    "ix_zcredit_recon_runs_terminal_day": ["tenant_id", "terminal_key", "business_date"],
    "ix_zcredit_recon_runs_tenant_day": ["tenant_id", "business_date"],
}
ITEM_INDEXES = {
    "ix_zcredit_recon_items_run": ["run_id"],
    "ix_zcredit_recon_items_open": ["tenant_id", "category", "handled_at"],
    "ix_zcredit_recon_items_fingerprint": ["tenant_id", "fingerprint"],
}


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _missing_indexes(insp, table: str, wanted: dict) -> None:
    have = {i["name"] for i in insp.get_indexes(table)} if insp is not None and insp.has_table(table) else set()
    for name, cols in wanted.items():
        if name not in have:
            op.create_index(name, table, cols)


def upgrade() -> None:
    insp = _inspector()
    uuid = postgresql.UUID(as_uuid=True)
    jsonb = postgresql.JSONB()
    if insp is None or not insp.has_table(RUNS):
        op.create_table(
            RUNS,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("terminal_number", sa.String(20), nullable=False),
            sa.Column("terminal_key", sa.String(32), nullable=False),
            sa.Column("terminal_last4", sa.String(4), nullable=True),
            sa.Column("credential_source", sa.String(16), nullable=True),
            sa.Column("machine_ids", jsonb, nullable=False, server_default=sa.text("'[]'::jsonb")),
            sa.Column("shop_ids", jsonb, nullable=False, server_default=sa.text("'[]'::jsonb")),
            sa.Column("business_date", sa.Date(), nullable=False),
            sa.Column("timezone", sa.String(64), nullable=False, server_default="Asia/Jerusalem"),
            sa.Column("trigger", sa.String(16), nullable=False, server_default="manual"),
            sa.Column("status", sa.String(16), nullable=False, server_default="running"),
            sa.Column("error_code", sa.String(64), nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("summary", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")),
            sa.Column("deposits", jsonb, nullable=False, server_default=sa.text("'[]'::jsonb")),
            sa.Column("zcredit_rows", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("our_legs", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("lookups", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_by_user_id", uuid, sa.ForeignKey("users.id"), nullable=True),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        )
    _missing_indexes(None if insp is None else sa.inspect(op.get_bind()), RUNS, RUN_INDEXES)

    if insp is None or not insp.has_table(ITEMS):
        op.create_table(
            ITEMS,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("run_id", uuid, sa.ForeignKey(f"{RUNS}.id", ondelete="CASCADE"), nullable=False),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("category", sa.String(24), nullable=False),
            sa.Column("fingerprint", sa.String(160), nullable=False),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("zc_reference", sa.String(64), nullable=True),
            sa.Column("zc_amount_agorot", sa.Integer(), nullable=True),
            sa.Column("zc_status_code", sa.Integer(), nullable=True),
            sa.Column("zc_deal_type", sa.String(4), nullable=True),
            sa.Column("zc_deposit_id", sa.String(64), nullable=True),
            sa.Column("zc_card_last4", sa.String(4), nullable=True),
            sa.Column("zc_card_name", sa.String(64), nullable=True),
            sa.Column("zc_payments", sa.Integer(), nullable=True),
            sa.Column("zc_approval", sa.String(32), nullable=True),
            sa.Column("zc_save_date", sa.DateTime(timezone=False), nullable=True),
            sa.Column("zc_source", sa.String(16), nullable=True),
            sa.Column("transaction_id", uuid, nullable=True),
            sa.Column("payment_id", uuid, nullable=True),
            sa.Column("machine_id", uuid, nullable=True),
            sa.Column("shop_id", uuid, nullable=True),
            sa.Column("document_number", sa.String(40), nullable=True),
            sa.Column("document_type", sa.Integer(), nullable=True),
            sa.Column("our_amount_agorot", sa.Integer(), nullable=True),
            sa.Column("our_status", sa.String(24), nullable=True),
            sa.Column("our_card_last4", sa.String(4), nullable=True),
            sa.Column("our_created_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("our_transmitted", sa.Boolean(), nullable=True),
            sa.Column("our_batch", sa.String(64), nullable=True),
            sa.Column("related", jsonb, nullable=False, server_default=sa.text("'[]'::jsonb")),
            sa.Column("handled_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("handled_by_user_id", uuid, sa.ForeignKey("users.id"), nullable=True),
            sa.Column("handled_by_name", sa.String(255), nullable=True),
            sa.Column("handled_note", sa.Text(), nullable=True),
            sa.Column("exception_id", uuid, nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
    _missing_indexes(None if insp is None else sa.inspect(op.get_bind()), ITEMS, ITEM_INDEXES)


def downgrade() -> None:
    for name in ITEM_INDEXES:
        op.drop_index(name, table_name=ITEMS)
    op.drop_table(ITEMS)
    for name in RUN_INDEXES:
        op.drop_index(name, table_name=RUNS)
    op.drop_table(RUNS)
