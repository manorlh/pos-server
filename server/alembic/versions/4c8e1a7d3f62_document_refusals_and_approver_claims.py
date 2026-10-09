"""Every till document lands: approver claims kept as sent, ingest notes, and a refusal log

* `transactions.claimed_approver_user_id` / `claimed_approver_pos_user_id` — the approver
  exactly as the till sent it (not foreign keys: an id the cloud does not hold is kept).
* `transactions.ingest_notes` — quiet notes written at ingest (an approver this business
  does not know, tenders that do not add up, a refund link to another tenant's document).
* `document_refusals` — every document the cloud still refuses (only what is not a document
  at all), per till and document: reason, attempts, first / last seen, payload, landed_at.

Idempotent: the auto-reloading dev API's `create_all` may make the new table before this
runs, so every table, column and index is looked at first. Never downgraded in place.

Revision ID: 4c8e1a7d3f62
Revises: 7e3a5c9b1d24
Create Date: 2026-10-07
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "4c8e1a7d3f62"
down_revision: Union[str, Sequence[str], None] = "7e3a5c9b1d24"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

REFUSALS = "document_refusals"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _has_table(insp, name: str) -> bool:
    return insp is not None and insp.has_table(name)


def _columns(insp, table: str) -> set:
    return set() if insp is None else {c["name"] for c in insp.get_columns(table)}


def _indexes(insp, table: str) -> set:
    return set() if insp is None else {i["name"] for i in insp.get_indexes(table)}


def _uniques(insp, table: str) -> set:
    return set() if insp is None else {u["name"] for u in insp.get_unique_constraints(table)}


def upgrade() -> None:
    insp = _inspector()

    tx_cols = _columns(insp, "transactions")
    if "claimed_approver_user_id" not in tx_cols:
        op.add_column("transactions", sa.Column("claimed_approver_user_id", postgresql.UUID(as_uuid=True), nullable=True))
    if "claimed_approver_pos_user_id" not in tx_cols:
        op.add_column("transactions", sa.Column("claimed_approver_pos_user_id", postgresql.UUID(as_uuid=True), nullable=True))
    if "ingest_notes" not in tx_cols:
        op.add_column("transactions", sa.Column("ingest_notes", postgresql.JSONB(), nullable=True))

    if not _has_table(insp, REFUSALS):
        op.create_table(
            REFUSALS,
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=True),
            sa.Column("machine_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
            sa.Column("document_ref", sa.String(120), nullable=False),
            sa.Column("document_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("document_number", sa.String(100), nullable=True),
            sa.Column("document_type", sa.Integer(), nullable=True),
            sa.Column("issued_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("total_amount", sa.String(40), nullable=True),
            sa.Column("reason", sa.Text(), nullable=False),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("payload", postgresql.JSONB(), nullable=True),
            sa.Column("landed_at", sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint("machine_id", "document_ref", name="uq_document_refusals_machine_ref"),
        )
        insp = _inspector()
    elif "uq_document_refusals_machine_ref" not in _uniques(insp, REFUSALS):
        op.create_unique_constraint("uq_document_refusals_machine_ref", REFUSALS, ["machine_id", "document_ref"])

    have = _indexes(insp, REFUSALS)
    for name, cols in (
        ("ix_document_refusals_tenant_id", ["tenant_id"]),
        ("ix_document_refusals_machine_id", ["machine_id"]),
        ("ix_document_refusals_document_id", ["document_id"]),
        ("ix_document_refusals_tenant_open", ["tenant_id", "landed_at"]),
    ):
        if name not in have:
            op.create_index(name, REFUSALS, cols)


def downgrade() -> None:
    # Never run in place (shared dev DB); kept for completeness.
    op.drop_table(REFUSALS)
    op.drop_column("transactions", "ingest_notes")
    op.drop_column("transactions", "claimed_approver_pos_user_id")
    op.drop_column("transactions", "claimed_approver_user_id")
