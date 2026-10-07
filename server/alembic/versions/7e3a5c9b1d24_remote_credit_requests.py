"""Remote credit ("זיכוי מרחוק"): requests, their audit trail, and the no-money marking

* `remote_credit_requests` — the dashboard asks a chosen till (open shift, same business)
  to issue a credit for a document; the till issues it in its own series and reports back.
* `remote_credit_events` — who did what, when and why, per request.
* `transactions.remote_credit_request_id` — the request a credit answered (null otherwise).
* `transactions.no_money_movement` / `transaction_payments.no_money_movement` — a credit
  for a sale that never really happened ("ללא החזר כספי — עסקה שלא בוצעה"): its tender
  mirrors the original's but no money moved, so cash-up, card transmission and the
  reconciliation must not expect a refund.

Idempotent: the auto-reloading dev API's `create_all` may make the new tables before this
runs, so every table, column and index is looked at first. Never downgraded in place.

Revision ID: 7e3a5c9b1d24
Revises: b5e1c7a3d9f4
Create Date: 2026-10-07
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "7e3a5c9b1d24"
down_revision: Union[str, Sequence[str], None] = "b5e1c7a3d9f4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

REQUESTS = "remote_credit_requests"
EVENTS = "remote_credit_events"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _has_table(insp, name: str) -> bool:
    return insp is not None and insp.has_table(name)


def _columns(insp, table: str) -> set:
    return set() if insp is None else {c["name"] for c in insp.get_columns(table)}


def _indexes(insp, table: str) -> set:
    return set() if insp is None else {i["name"] for i in insp.get_indexes(table)}


def upgrade() -> None:
    insp = _inspector()

    if not _has_table(insp, REQUESTS):
        op.create_table(
            REQUESTS,
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("company_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("companies.id"), nullable=True),
            sa.Column("machine_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
            sa.Column("shop_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
            sa.Column("original_transaction_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("original_machine_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("original_document_number", sa.String(40), nullable=True),
            sa.Column("original_document_type", sa.Integer(), nullable=True),
            sa.Column("original_issued_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("mode", sa.String(16), nullable=False),
            sa.Column("full_credit", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("lines", postgresql.JSONB(), nullable=False),
            sa.Column("amount", sa.Numeric(12, 2), nullable=False),
            sa.Column("tenders", postgresql.JSONB(), nullable=True),
            sa.Column("reason_code", sa.String(32), nullable=True),
            sa.Column("reason", sa.Text(), nullable=False),
            sa.Column("status", sa.String(16), nullable=False),
            sa.Column("error_code", sa.String(64), nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("credit_transaction_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("credit_document_number", sa.String(40), nullable=True),
            sa.Column("credit_document_type", sa.Integer(), nullable=True),
            sa.Column("credit_amount", sa.Numeric(12, 2), nullable=True),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("initiated_by", sa.String(255), nullable=True),
            sa.Column("cancelled_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("cancel_reason", sa.Text(), nullable=True),
            sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("received_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        insp = _inspector()
    have = _indexes(insp, REQUESTS)
    for name, cols in (
        ("ix_remote_credit_requests_tenant_id", ["tenant_id"]),
        ("ix_remote_credit_requests_machine_status", ["machine_id", "status"]),
        ("ix_remote_credit_requests_original", ["original_transaction_id"]),
        ("ix_remote_credit_requests_credit_transaction_id", ["credit_transaction_id"]),
    ):
        if name not in have:
            op.create_index(name, REQUESTS, cols)

    if not _has_table(insp, EVENTS):
        op.create_table(
            EVENTS,
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "request_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey(f"{REQUESTS}.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("actor", sa.String(16), nullable=False),
            sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("machine_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("action", sa.String(24), nullable=False),
            sa.Column("detail", sa.Text(), nullable=True),
            sa.Column("data", postgresql.JSONB(), nullable=True),
        )
        insp = _inspector()
    if "ix_remote_credit_events_request" not in _indexes(insp, EVENTS):
        op.create_index("ix_remote_credit_events_request", EVENTS, ["request_id", "at"])

    tx_cols = _columns(insp, "transactions")
    if insp is None or "remote_credit_request_id" not in tx_cols:
        op.add_column("transactions", sa.Column("remote_credit_request_id", postgresql.UUID(as_uuid=True), nullable=True))
    if insp is None or "no_money_movement" not in tx_cols:
        op.add_column(
            "transactions",
            sa.Column("no_money_movement", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
    if "ix_transactions_remote_credit_request" not in _indexes(insp, "transactions"):
        op.create_index("ix_transactions_remote_credit_request", "transactions", ["remote_credit_request_id"])
    if insp is None or "no_money_movement" not in _columns(insp, "transaction_payments"):
        op.add_column(
            "transaction_payments",
            sa.Column("no_money_movement", sa.Boolean(), nullable=False, server_default=sa.false()),
        )


def downgrade() -> None:
    # Fix forward (a downgrade on a shared dev DB drops other work); kept for completeness.
    op.drop_column("transaction_payments", "no_money_movement")
    op.drop_index("ix_transactions_remote_credit_request", table_name="transactions")
    op.drop_column("transactions", "no_money_movement")
    op.drop_column("transactions", "remote_credit_request_id")
    op.drop_table(EVENTS)
    op.drop_table(REQUESTS)
