"""Cloud card refund ("זיכוי באשראי מהענן (Z-Credit)"): the refunds, their audit trail, the note link

* `cloud_card_refunds` — the cloud refunds a Z-Credit card sale through Z-Credit's web API;
  one row per refund, its id the dashboard's request id. Written before the gateway is called.
* `cloud_card_refund_events` — who did what, when and why, per refund.
* `remote_credit_requests.card_refund_id` — a `card_refunded` request: the till issues the
  credit note of that refund (docs/SPEC_REMOTE_CREDIT.md §11).

Idempotent: the auto-reloading dev API's `create_all` may make the new tables (and column)
before this runs, so every table, column and index is looked at first. Never downgraded in place.

Revision ID: c4e8a2f6b1d3
Revises: e9a3c7f1b5d2
Create Date: 2026-10-08
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "c4e8a2f6b1d3"
down_revision: Union[str, Sequence[str], None] = "e9a3c7f1b5d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

REFUNDS = "cloud_card_refunds"
EVENTS = "cloud_card_refund_events"
REQUESTS = "remote_credit_requests"


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
    uuid_t = postgresql.UUID(as_uuid=True)

    if not _has_table(insp, REFUNDS):
        op.create_table(
            REFUNDS,
            sa.Column("id", uuid_t, primary_key=True),
            sa.Column("tenant_id", uuid_t, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("company_id", uuid_t, sa.ForeignKey("companies.id"), nullable=True),
            sa.Column("shop_id", uuid_t, nullable=True),
            sa.Column("original_machine_id", uuid_t, nullable=True),
            sa.Column("original_transaction_id", uuid_t, nullable=False),
            sa.Column("original_payment_id", uuid_t, nullable=False),
            sa.Column("original_document_number", sa.String(40), nullable=True),
            sa.Column("original_document_type", sa.Integer(), nullable=True),
            sa.Column("original_leg_amount", sa.Numeric(12, 2), nullable=False),
            sa.Column("card_last4", sa.String(4), nullable=True),
            sa.Column("card_brand", sa.String(16), nullable=True),
            sa.Column("card_acquirer", sa.String(16), nullable=True),
            sa.Column("card_issuer", sa.String(16), nullable=True),
            sa.Column("provider", sa.String(16), nullable=False),
            sa.Column("terminal_number", sa.String(20), nullable=True),
            sa.Column("credential_source", sa.String(16), nullable=True),
            sa.Column("original_reference", sa.String(64), nullable=False),
            sa.Column("full_credit", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("lines", postgresql.JSONB(), nullable=False),
            sa.Column("amount", sa.Numeric(12, 2), nullable=False),
            sa.Column("reason_code", sa.String(32), nullable=True),
            sa.Column("reason", sa.Text(), nullable=False),
            sa.Column("target_machine_id", uuid_t, nullable=False),
            sa.Column("status", sa.String(16), nullable=False),
            sa.Column("error_code", sa.String(64), nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("before_status_code", sa.Integer(), nullable=True),
            sa.Column("after_status_code", sa.Integer(), nullable=True),
            sa.Column("return_code", sa.Integer(), nullable=True),
            sa.Column("return_message", sa.Text(), nullable=True),
            sa.Column("refund_reference", sa.String(64), nullable=True),
            sa.Column("approval_number", sa.String(32), nullable=True),
            sa.Column("voucher_number", sa.String(32), nullable=True),
            sa.Column("voided", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("resolved_by", sa.String(16), nullable=True),
            sa.Column("resolved_by_user_id", uuid_t, sa.ForeignKey("users.id"), nullable=True),
            sa.Column("resolution_note", sa.Text(), nullable=True),
            sa.Column("attempt_started_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("refund_sent_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("attempt_finished_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("query_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("last_query_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("refunded_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("remote_credit_request_id", uuid_t, nullable=True),
            sa.Column("credit_transaction_id", uuid_t, nullable=True),
            sa.Column("credit_document_number", sa.String(40), nullable=True),
            sa.Column("credit_document_type", sa.Integer(), nullable=True),
            sa.Column("created_by_user_id", uuid_t, sa.ForeignKey("users.id"), nullable=False),
            sa.Column("initiated_by", sa.String(255), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        insp = _inspector()
    have = _indexes(insp, REFUNDS)
    for name, cols in (
        ("ix_cloud_card_refunds_original", ["original_transaction_id"]),
        ("ix_cloud_card_refunds_payment", ["original_payment_id"]),
        ("ix_cloud_card_refunds_tenant_created", ["tenant_id", "created_at"]),
        ("ix_cloud_card_refunds_status", ["status"]),
        ("ix_cloud_card_refunds_remote_credit_request_id", ["remote_credit_request_id"]),
        ("ix_cloud_card_refunds_credit_transaction_id", ["credit_transaction_id"]),
    ):
        if name not in have:
            op.create_index(name, REFUNDS, cols)

    if not _has_table(insp, EVENTS):
        op.create_table(
            EVENTS,
            sa.Column("id", uuid_t, primary_key=True),
            sa.Column("refund_id", uuid_t, sa.ForeignKey(f"{REFUNDS}.id", ondelete="CASCADE"), nullable=False),
            sa.Column("tenant_id", uuid_t, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("actor", sa.String(16), nullable=False),
            sa.Column("user_id", uuid_t, sa.ForeignKey("users.id"), nullable=True),
            sa.Column("action", sa.String(24), nullable=False),
            sa.Column("detail", sa.Text(), nullable=True),
            sa.Column("data", postgresql.JSONB(), nullable=True),
        )
        insp = _inspector()
    if "ix_cloud_card_refund_events_refund" not in _indexes(insp, EVENTS):
        op.create_index("ix_cloud_card_refund_events_refund", EVENTS, ["refund_id", "at"])

    if insp is None or "card_refund_id" not in _columns(insp, REQUESTS):
        op.add_column(REQUESTS, sa.Column("card_refund_id", uuid_t, nullable=True))
    if "ix_remote_credit_requests_card_refund_id" not in _indexes(insp, REQUESTS):
        op.create_index("ix_remote_credit_requests_card_refund_id", REQUESTS, ["card_refund_id"])


def downgrade() -> None:
    # Fix forward (a downgrade on a shared dev DB drops other work); kept for completeness.
    op.drop_index("ix_remote_credit_requests_card_refund_id", table_name=REQUESTS)
    op.drop_column(REQUESTS, "card_refund_id")
    op.drop_table(EVENTS)
    op.drop_table(REFUNDS)
