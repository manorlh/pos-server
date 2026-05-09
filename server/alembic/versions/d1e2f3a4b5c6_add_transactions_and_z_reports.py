"""add transactions, transaction_items, trading_days, z_reports

Revision ID: d1e2f3a4b5c6
Revises: c9d8e7f6a5b4
Create Date: 2026-05-02 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


revision = "d1e2f3a4b5c6"
down_revision = "c9d8e7f6a5b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── trading_days ───────────────────────────────────────────────────────────
    op.create_table(
        "trading_days",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("merchant_id", UUID(as_uuid=True), sa.ForeignKey("merchants.id"), nullable=False),
        sa.Column("machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
        sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
        sa.Column("day_date", sa.Date(), nullable=False),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("opening_cash", sa.Numeric(12, 2), nullable=True),
        sa.Column("closing_cash", sa.Numeric(12, 2), nullable=True),
        sa.Column("expected_cash", sa.Numeric(12, 2), nullable=True),
        sa.Column("actual_cash", sa.Numeric(12, 2), nullable=True),
        sa.Column("discrepancy", sa.Numeric(12, 2), nullable=True),
        sa.Column("opened_by", sa.String(255), nullable=True),
        sa.Column("closed_by", sa.String(255), nullable=True),
        sa.Column(
            "status",
            sa.Enum("open", "closed", name="tradingdaystatus"),
            nullable=False,
            server_default="open",
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("machine_id", "day_date", name="uq_trading_day_machine_date"),
    )
    op.create_index("ix_trading_days_merchant_id", "trading_days", ["merchant_id"])
    op.create_index("ix_trading_days_machine_id", "trading_days", ["machine_id"])
    op.create_index("ix_trading_days_shop_id", "trading_days", ["shop_id"])
    op.create_index("ix_trading_days_machine_status", "trading_days", ["machine_id", "status"])

    # ── transactions ──────────────────────────────────────────────────────────
    op.create_table(
        "transactions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
        sa.Column("merchant_id", UUID(as_uuid=True), sa.ForeignKey("merchants.id"), nullable=False),
        sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
        sa.Column("trading_day_id", UUID(as_uuid=True), sa.ForeignKey("trading_days.id"), nullable=True),
        sa.Column("transaction_number", sa.String(100), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "pending", "completed", "cancelled", "refunded", "partial_refund",
                name="transactionstatus",
            ),
            nullable=False,
            server_default="completed",
        ),
        sa.Column("document_type", sa.Integer(), nullable=True),
        sa.Column("document_production_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("payment_method", sa.String(50), nullable=True),
        sa.Column("amount_tendered", sa.Numeric(12, 2), nullable=True),
        sa.Column("change_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("total_amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("total_discount", sa.Numeric(12, 2), nullable=True),
        sa.Column("document_discount", sa.Numeric(12, 2), nullable=True),
        sa.Column("wht_deduction", sa.Numeric(12, 2), nullable=True),
        sa.Column("customer_id", sa.String(100), nullable=True),
        sa.Column("cashier_id", sa.String(100), nullable=True),
        sa.Column("branch_id", sa.String(100), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("refund_of_transaction_id", UUID(as_uuid=True), sa.ForeignKey("transactions.id"), nullable=True),
        sa.Column("nayax_meta", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("server_received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("machine_id", "transaction_number", name="uq_tx_machine_number"),
    )
    op.create_index("ix_transactions_machine_id", "transactions", ["machine_id"])
    op.create_index("ix_transactions_merchant_id", "transactions", ["merchant_id"])
    op.create_index("ix_transactions_shop_id", "transactions", ["shop_id"])
    op.create_index("ix_transactions_machine_created_at", "transactions", ["machine_id", "created_at"])
    op.create_index("ix_transactions_trading_day", "transactions", ["trading_day_id"])

    # ── transaction_items ─────────────────────────────────────────────────────
    op.create_table(
        "transaction_items",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "transaction_id",
            UUID(as_uuid=True),
            sa.ForeignKey("transactions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("product_id", UUID(as_uuid=True), sa.ForeignKey("products.id"), nullable=True),
        sa.Column("product_name", sa.String(255), nullable=True),
        sa.Column("sku", sa.String(100), nullable=True),
        sa.Column("quantity", sa.Numeric(12, 3), nullable=False),
        sa.Column("unit_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("total_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("discount", sa.Numeric(12, 2), nullable=True),
        sa.Column("discount_type", sa.String(20), nullable=True),
        sa.Column("transaction_type", sa.Integer(), nullable=True),
        sa.Column("line_discount", sa.Numeric(12, 2), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
    )
    op.create_index("ix_transaction_items_transaction", "transaction_items", ["transaction_id"])

    # ── z_reports ─────────────────────────────────────────────────────────────
    op.create_table(
        "z_reports",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("trading_day_id", UUID(as_uuid=True), sa.ForeignKey("trading_days.id"), nullable=False),
        sa.Column("machine_id", UUID(as_uuid=True), sa.ForeignKey("pos_machines.id"), nullable=False),
        sa.Column("merchant_id", UUID(as_uuid=True), sa.ForeignKey("merchants.id"), nullable=False),
        sa.Column("shop_id", UUID(as_uuid=True), sa.ForeignKey("shops.id"), nullable=True),
        sa.Column("day_date", sa.Date(), nullable=False),
        sa.Column("total_sales", sa.Numeric(12, 2), nullable=True),
        sa.Column("total_refunds", sa.Numeric(12, 2), nullable=True),
        sa.Column("total_cash_sales", sa.Numeric(12, 2), nullable=True),
        sa.Column("total_card_sales", sa.Numeric(12, 2), nullable=True),
        sa.Column("transactions_count", sa.Integer(), nullable=True),
        sa.Column("opening_cash", sa.Numeric(12, 2), nullable=True),
        sa.Column("closing_cash", sa.Numeric(12, 2), nullable=True),
        sa.Column("expected_cash", sa.Numeric(12, 2), nullable=True),
        sa.Column("actual_cash", sa.Numeric(12, 2), nullable=True),
        sa.Column("discrepancy", sa.Numeric(12, 2), nullable=True),
        sa.Column("payload", JSONB(), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("trading_day_id", name="uq_zreport_trading_day"),
    )
    op.create_index("ix_z_reports_machine_id", "z_reports", ["machine_id"])
    op.create_index("ix_z_reports_merchant_id", "z_reports", ["merchant_id"])
    op.create_index("ix_z_reports_shop_id", "z_reports", ["shop_id"])
    op.create_index("ix_z_reports_machine_day", "z_reports", ["machine_id", "day_date"])


def downgrade() -> None:
    op.drop_index("ix_z_reports_machine_day", table_name="z_reports")
    op.drop_index("ix_z_reports_shop_id", table_name="z_reports")
    op.drop_index("ix_z_reports_merchant_id", table_name="z_reports")
    op.drop_index("ix_z_reports_machine_id", table_name="z_reports")
    op.drop_table("z_reports")

    op.drop_index("ix_transaction_items_transaction", table_name="transaction_items")
    op.drop_table("transaction_items")

    op.drop_index("ix_transactions_trading_day", table_name="transactions")
    op.drop_index("ix_transactions_machine_created_at", table_name="transactions")
    op.drop_index("ix_transactions_shop_id", table_name="transactions")
    op.drop_index("ix_transactions_merchant_id", table_name="transactions")
    op.drop_index("ix_transactions_machine_id", table_name="transactions")
    op.drop_table("transactions")

    op.drop_index("ix_trading_days_machine_status", table_name="trading_days")
    op.drop_index("ix_trading_days_shop_id", table_name="trading_days")
    op.drop_index("ix_trading_days_machine_id", table_name="trading_days")
    op.drop_index("ix_trading_days_merchant_id", table_name="trading_days")
    op.drop_table("trading_days")

    sa.Enum(name="transactionstatus").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="tradingdaystatus").drop(op.get_bind(), checkfirst=True)
