"""card transmission to Shva (docs/SHIFTS_API.md §4)

* `card_transmissions` — one `doPeriodic` attempt of one till, as the till reported it
  (id is the till's, the idempotency key). `card_transmission_items` — the terminal uids
  each attempt carried, so a leg whose document lands later is still matched.
* `transmit_requests` — an operator asking a till to transmit now (heartbeat + Ably).
* `transaction_payments.terminal_uid` — the terminal's id of a card sale, read out of
  `nayax_meta` (`uid`, else `result.uid`); backfilled here for the card legs already
  stored. `transmission_id` / `transmitted_batch` — the successful batch that carried it.
* `pos_machines.transmission_*` — the till's last reported pending state, and when the
  cloud first heard about transmissions from it (legs from before are never flagged).
* `pairing_codes.untransmitted_acknowledged_*` — a replacement code created although the
  till held untransmitted card sales.

Parent is shop areas (c8d9e0f1a2b3). The mixed-basket branch also stacks d9e0f1a2b3c4 on
it; whichever merges second re-chains onto the other.

Revision ID: e0f1a2b3c4d5
Revises: c8d9e0f1a2b3
Create Date: 2026-09-30 12:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "e0f1a2b3c4d5"
down_revision = "c8d9e0f1a2b3"
branch_labels = None
depends_on = None


_MACHINE_COLUMNS = (
    ("transmission_pending_count", sa.Integer()),
    ("transmission_pending_amount", sa.Numeric(12, 2)),
    ("transmission_oldest_pending_at", sa.DateTime(timezone=True)),
    ("transmission_last_success_at", sa.DateTime(timezone=True)),
    ("transmission_last_attempt_at", sa.DateTime(timezone=True)),
    ("transmission_last_error", sa.String(500)),
    ("transmission_source", sa.String(32)),
    ("transmission_reported_at", sa.DateTime(timezone=True)),
    ("transmission_tracking_started_at", sa.DateTime(timezone=True)),
)


def upgrade() -> None:
    op.create_table(
        "card_transmissions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=True),
        sa.Column("machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
        sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
        sa.Column("trigger", sa.String(16), nullable=False),
        sa.Column("request_id", UUID(as_uuid=True), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("status_message", sa.String(500), nullable=True),
        sa.Column("batch_number", sa.String(64), nullable=True),
        sa.Column("transaction_count", sa.Integer(), nullable=True),
        sa.Column("amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("terminal_transaction_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("report_text", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_card_transmissions_tenant_id", "card_transmissions", ["tenant_id"])
    op.create_index("ix_card_transmissions_shop_id", "card_transmissions", ["shop_id"])
    op.create_index(
        "ix_card_transmissions_machine_started", "card_transmissions", ["machine_id", "started_at"]
    )

    op.create_table(
        "card_transmission_items",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "transmission_id",
            UUID(as_uuid=True),
            sa.ForeignKey("card_transmissions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
        sa.Column("terminal_uid", sa.String(64), nullable=False),
        sa.UniqueConstraint("transmission_id", "terminal_uid", name="uq_card_transmission_items_uid"),
    )
    op.create_index(
        "ix_card_transmission_items_machine_uid",
        "card_transmission_items",
        ["machine_id", "terminal_uid"],
    )

    op.create_table(
        "transmit_requests",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
        sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
        sa.Column("created_by_user_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("transmission_id", UUID(as_uuid=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_transmit_requests_tenant_id", "transmit_requests", ["tenant_id"])
    op.create_index(
        "ix_transmit_requests_machine_status", "transmit_requests", ["machine_id", "status"]
    )

    op.add_column("transaction_payments", sa.Column("terminal_uid", sa.String(64), nullable=True))
    op.add_column(
        "transaction_payments",
        sa.Column(
            "transmission_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "card_transmissions.id",
                name="fk_transaction_payments_transmission_id",
                ondelete="SET NULL",
            ),
            nullable=True,
        ),
    )
    op.add_column("transaction_payments", sa.Column("transmitted_batch", sa.String(64), nullable=True))
    op.create_index(
        "ix_transaction_payments_terminal_uid", "transaction_payments", ["terminal_uid"]
    )
    # The card legs already stored: their uid is in the acquirer reply the till sent. A
    # reply that is not an object (or has no uid) leaves the leg unmatched, as on ingest.
    op.execute(
        """
        UPDATE transaction_payments
           SET terminal_uid = LEFT(
                   COALESCE(
                       NULLIF(BTRIM(nayax_meta ->> 'uid'), ''),
                       NULLIF(BTRIM(nayax_meta -> 'result' ->> 'uid'), '')
                   ),
                   64
               )
         WHERE method = 'card'
           AND nayax_meta IS NOT NULL
           AND jsonb_typeof(nayax_meta) = 'object'
           AND (jsonb_typeof(nayax_meta -> 'result') IS NULL
                OR jsonb_typeof(nayax_meta -> 'result') = 'object')
        """
    )

    for name, type_ in _MACHINE_COLUMNS:
        op.add_column("pos_machines", sa.Column(name, type_, nullable=True))

    op.add_column(
        "pairing_codes",
        sa.Column(
            "untransmitted_acknowledged_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", name="fk_pairing_codes_untransmitted_ack_user"),
            nullable=True,
        ),
    )
    op.add_column(
        "pairing_codes",
        sa.Column("untransmitted_acknowledged_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("pairing_codes", "untransmitted_acknowledged_at")
    op.drop_constraint("fk_pairing_codes_untransmitted_ack_user", "pairing_codes", type_="foreignkey")
    op.drop_column("pairing_codes", "untransmitted_acknowledged_by_user_id")

    for name, _type in reversed(_MACHINE_COLUMNS):
        op.drop_column("pos_machines", name)

    op.drop_index("ix_transaction_payments_terminal_uid", table_name="transaction_payments")
    op.drop_column("transaction_payments", "transmitted_batch")
    op.drop_constraint(
        "fk_transaction_payments_transmission_id", "transaction_payments", type_="foreignkey"
    )
    op.drop_column("transaction_payments", "transmission_id")
    op.drop_column("transaction_payments", "terminal_uid")

    op.drop_index("ix_transmit_requests_machine_status", table_name="transmit_requests")
    op.drop_index("ix_transmit_requests_tenant_id", table_name="transmit_requests")
    op.drop_table("transmit_requests")
    op.drop_index("ix_card_transmission_items_machine_uid", table_name="card_transmission_items")
    op.drop_table("card_transmission_items")
    op.drop_index("ix_card_transmissions_machine_started", table_name="card_transmissions")
    op.drop_index("ix_card_transmissions_shop_id", table_name="card_transmissions")
    op.drop_index("ix_card_transmissions_tenant_id", table_name="card_transmissions")
    op.drop_table("card_transmissions")
