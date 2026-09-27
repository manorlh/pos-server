"""shifts replace trading days; the Z moves to the cloud

The till now manages shifts (many per day, one open at a time per till) and a Z is built
in the cloud over closed shifts of one shop. See pos-android docs/shifts-plan.md §4.2.

* `trading_days` → `shifts` (and its enum type, indexes and constraints), `day_date` →
  `business_date`, `actual_cash` → `counted_cash`; new columns for the server-recomputed
  X, the till's own X, who opened/closed it, the approver, the remote-close link,
  `reconstructed` (moved here from the Z) and `z_report_id`.
* `transactions.trading_day_id` → `shift_id`; `close_day_request_items.trading_day_id` →
  `shift_id` (that table is replaced by z_runs in the next revision).
* `z_reports`: `trading_day_id` and its unique constraint are dropped (a Z now spans
  shifts, linked from `shifts.z_report_id`); `machine_id` becomes nullable (legacy rows
  keep theirs); `day_date` → `business_date`; new columns for the period, counts, VAT,
  discounts, payment breakdown, per-till sections and author; and the missing unique
  index on `(shop_id, shop_sequence_number)`.
* `pos_machines`: the open shift the till reports on its heartbeat.

Backfill: every existing Z is linked to its one former trading day, and that shift gets
its X figures from the Z (the only figures there are for it); open days simply become
open shifts. Existing Zs get `shift_count = machine_count = 1` and their period.

The unique `(shop_id, shop_sequence_number)` index is created last and fails loudly if
two Zs share a number — that would be a real defect to look at, not something a
migration gets to renumber.

Revision ID: f9a0b1c2d3e4
Revises: f8a9b0c1d2e3
Create Date: 2026-09-27 22:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID


revision = "f9a0b1c2d3e4"
down_revision = "f8a9b0c1d2e3"
branch_labels = None
depends_on = None


def _rename_indexes(bind, table: str, old_prefix: str, new_prefix: str) -> None:
    rows = bind.execute(
        sa.text(
            "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() "
            "AND tablename = :t AND indexname LIKE :p"
        ),
        {"t": table, "p": old_prefix.replace("_", r"\_") + "%"},
    ).fetchall()
    for (name,) in rows:
        # Constraint-backed indexes (the pkey) are renamed with their constraint below.
        is_constraint = bind.execute(
            sa.text("SELECT 1 FROM pg_constraint WHERE conname = :n"), {"n": name}
        ).first()
        if is_constraint:
            continue
        op.execute(f'ALTER INDEX "{name}" RENAME TO "{new_prefix}{name[len(old_prefix):]}"')


def _rename_constraints(bind, table: str, old_prefix: str, new_prefix: str) -> None:
    rows = bind.execute(
        sa.text(
            "SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid "
            "WHERE t.relname = :t AND c.conname LIKE :p"
        ),
        {"t": table, "p": old_prefix.replace("_", r"\_") + "%"},
    ).fetchall()
    for (name,) in rows:
        op.execute(
            f'ALTER TABLE "{table}" RENAME CONSTRAINT "{name}" '
            f'TO "{new_prefix}{name[len(old_prefix):]}"'
        )


def _rename_constraint_if_exists(bind, table: str, old: str, new: str) -> None:
    exists = bind.execute(
        sa.text("SELECT 1 FROM pg_constraint WHERE conname = :n"), {"n": old}
    ).first()
    if exists:
        op.execute(f'ALTER TABLE "{table}" RENAME CONSTRAINT "{old}" TO "{new}"')


def _rename_index_if_exists(bind, old: str, new: str) -> None:
    exists = bind.execute(
        sa.text("SELECT 1 FROM pg_indexes WHERE indexname = :n"), {"n": old}
    ).first()
    if exists:
        op.execute(f'ALTER INDEX "{old}" RENAME TO "{new}"')


def upgrade() -> None:
    bind = op.get_bind()

    # ── trading_days → shifts ────────────────────────────────────────────────
    op.rename_table("trading_days", "shifts")
    op.execute("ALTER TYPE tradingdaystatus RENAME TO shiftstatus")
    _rename_indexes(bind, "shifts", "ix_trading_days_", "ix_shifts_")
    _rename_index_if_exists(bind, "uq_trading_day_one_open", "uq_shift_one_open")
    _rename_constraints(bind, "shifts", "trading_days_", "shifts_")
    _rename_constraint_if_exists(bind, "shifts", "fk_trading_days_tenant_id", "fk_shifts_tenant_id")
    op.alter_column("shifts", "day_date", new_column_name="business_date")
    op.alter_column("shifts", "actual_cash", new_column_name="counted_cash")

    new_columns = [
        sa.Column("close_accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("opened_by_pos_user_id", sa.String(100), nullable=True),
        sa.Column("closed_by_pos_user_id", sa.String(100), nullable=True),
        sa.Column("unattended", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("close_request_item_id", UUID(as_uuid=True), nullable=True),
        sa.Column("total_sales", sa.Numeric(12, 2), nullable=True),
        sa.Column("total_refunds", sa.Numeric(12, 2), nullable=True),
        sa.Column("total_cash", sa.Numeric(12, 2), nullable=True),
        sa.Column("total_card", sa.Numeric(12, 2), nullable=True),
        sa.Column("total_tips", sa.Numeric(12, 2), nullable=True),
        sa.Column("total_cash_tips", sa.Numeric(12, 2), nullable=True),
        sa.Column("total_card_tips", sa.Numeric(12, 2), nullable=True),
        sa.Column("vat_total", sa.Numeric(12, 2), nullable=True),
        sa.Column("transactions_count", sa.Integer(), nullable=True),
        sa.Column("first_transaction_number", sa.String(100), nullable=True),
        sa.Column("last_transaction_number", sa.String(100), nullable=True),
        sa.Column("till_totals", JSONB(), nullable=True),
        sa.Column("totals_mismatch", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("z_report_id", UUID(as_uuid=True), nullable=True),
        sa.Column("reconstructed", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("reconstructed_by", sa.String(255), nullable=True),
        sa.Column("reconstruction_basis", JSONB(), nullable=True),
        sa.Column("approved_by_user_id", UUID(as_uuid=True), nullable=True),
        sa.Column("approved_by_pos_user_id", UUID(as_uuid=True), nullable=True),
    ]
    for column in new_columns:
        op.add_column("shifts", column)
    op.create_foreign_key(
        "fk_shifts_z_report_id_z_reports", "shifts", "z_reports", ["z_report_id"], ["id"]
    )
    op.create_foreign_key(
        "fk_shifts_approved_by_user_id_users", "shifts", "users", ["approved_by_user_id"], ["id"]
    )
    op.create_foreign_key(
        "fk_shifts_approved_by_pos_user_id_pos_users",
        "shifts", "pos_users", ["approved_by_pos_user_id"], ["id"],
    )
    op.create_index("ix_shifts_z_report_id", "shifts", ["z_report_id"])

    # ── documents and the interim remote-close table follow the rename ──────
    op.alter_column("transactions", "trading_day_id", new_column_name="shift_id")
    _rename_index_if_exists(bind, "ix_transactions_trading_day", "ix_transactions_shift")
    _rename_constraint_if_exists(
        bind, "transactions", "transactions_trading_day_id_fkey", "transactions_shift_id_fkey"
    )
    op.alter_column("close_day_request_items", "trading_day_id", new_column_name="shift_id")
    _rename_constraint_if_exists(
        bind,
        "close_day_request_items",
        "close_day_request_items_trading_day_id_fkey",
        "close_day_request_items_shift_id_fkey",
    )

    # ── z_reports ────────────────────────────────────────────────────────────
    op.alter_column("z_reports", "day_date", new_column_name="business_date")
    for column in [
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=True),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=True),
        sa.Column("shift_count", sa.Integer(), nullable=True),
        sa.Column("machine_count", sa.Integer(), nullable=True),
        sa.Column("vat_total", sa.Numeric(12, 2), nullable=True),
        sa.Column("discounts_total", sa.Numeric(12, 2), nullable=True),
        sa.Column("payment_breakdown", JSONB(), nullable=True),
        sa.Column("per_machine", JSONB(), nullable=True),
        sa.Column("created_by_user_id", UUID(as_uuid=True), nullable=True),
    ]:
        op.add_column("z_reports", column)
    op.create_foreign_key(
        "fk_z_reports_created_by_user_id_users", "z_reports", "users", ["created_by_user_id"], ["id"]
    )

    # Backfill: each existing Z belongs to its one former trading day.
    bind.execute(sa.text(
        """
        UPDATE shifts s
           SET z_report_id = z.id,
               total_sales = z.total_sales,
               total_refunds = z.total_refunds,
               total_cash = z.total_cash_sales,
               total_card = z.total_card_sales,
               total_tips = z.total_tips,
               total_cash_tips = z.total_cash_tips,
               total_card_tips = z.total_card_tips,
               transactions_count = z.transactions_count,
               counted_cash = COALESCE(s.counted_cash, z.actual_cash),
               expected_cash = COALESCE(s.expected_cash, z.expected_cash),
               discrepancy = COALESCE(s.discrepancy, z.discrepancy),
               unattended = z.unattended,
               reconstructed = z.reconstructed,
               reconstructed_by = z.reconstructed_by,
               reconstruction_basis = z.reconstruction_basis,
               approved_by_user_id = z.approved_by_user_id,
               approved_by_pos_user_id = z.approved_by_pos_user_id,
               till_totals = z.payload,
               close_accepted_at = z.created_at,
               closed_at = COALESCE(s.closed_at, z.closed_at),
               status = 'closed'
          FROM z_reports z
         WHERE z.trading_day_id = s.id
        """
    ))
    bind.execute(sa.text(
        """
        UPDATE z_reports z
           SET shift_count = 1,
               machine_count = 1,
               period_start = s.opened_at,
               period_end = z.closed_at
          FROM shifts s
         WHERE z.trading_day_id = s.id
        """
    ))

    op.drop_constraint("uq_zreport_trading_day", "z_reports", type_="unique")
    op.drop_column("z_reports", "trading_day_id")
    op.alter_column("z_reports", "machine_id", existing_type=UUID(as_uuid=True), nullable=True)
    _drop_index_if_exists(bind, "ix_z_reports_machine_day")
    op.create_index("ix_z_reports_shop_business_date", "z_reports", ["shop_id", "business_date"])

    duplicates = bind.execute(sa.text(
        "SELECT shop_id, shop_sequence_number, count(*) FROM z_reports "
        "WHERE shop_id IS NOT NULL AND shop_sequence_number IS NOT NULL "
        "GROUP BY shop_id, shop_sequence_number HAVING count(*) > 1"
    )).fetchall()
    if duplicates:
        raise RuntimeError(
            "Cannot enforce one Z per shop number: "
            f"{[(str(r[0]), r[1], r[2]) for r in duplicates]} (shop, number, rows). "
            "Resolve these by hand; this migration will not renumber fiscal documents."
        )
    op.create_index(
        "uq_z_reports_shop_sequence",
        "z_reports",
        ["shop_id", "shop_sequence_number"],
        unique=True,
    )

    # ── pos_machines: the till's own account of its open shift ──────────────
    op.add_column("pos_machines", sa.Column("reported_open_shift_id", UUID(as_uuid=True), nullable=True))
    op.add_column(
        "pos_machines",
        sa.Column("reported_open_shift_opened_at", sa.DateTime(timezone=True), nullable=True),
    )


def _drop_index_if_exists(bind, name: str) -> None:
    if bind.execute(sa.text("SELECT 1 FROM pg_indexes WHERE indexname = :n"), {"n": name}).first():
        op.drop_index(name)


def downgrade() -> None:
    bind = op.get_bind()

    # A cloud-built Z spans shifts and tills; the old model has one Z per trading day and
    # a machine on every Z. Refuse rather than drop fiscal documents to make them fit.
    cloud_built = bind.execute(sa.text(
        "SELECT count(*) FROM z_reports WHERE machine_id IS NULL OR per_machine IS NOT NULL"
    )).scalar()
    multi = bind.execute(sa.text(
        "SELECT count(*) FROM (SELECT z_report_id FROM shifts WHERE z_report_id IS NOT NULL "
        "GROUP BY z_report_id HAVING count(*) > 1) x"
    )).scalar()
    if cloud_built or multi:
        raise RuntimeError(
            f"Cannot downgrade: {cloud_built} cloud-built Z report(s) and {multi} Z(s) over "
            "several shifts exist, which the trading-day model cannot represent."
        )

    op.drop_column("pos_machines", "reported_open_shift_opened_at")
    op.drop_column("pos_machines", "reported_open_shift_id")

    op.drop_index("uq_z_reports_shop_sequence", table_name="z_reports")
    op.drop_index("ix_z_reports_shop_business_date", table_name="z_reports")
    op.add_column("z_reports", sa.Column("trading_day_id", UUID(as_uuid=True), nullable=True))
    bind.execute(sa.text(
        "UPDATE z_reports z SET trading_day_id = s.id FROM shifts s WHERE s.z_report_id = z.id"
    ))
    orphans = bind.execute(sa.text("SELECT count(*) FROM z_reports WHERE trading_day_id IS NULL")).scalar()
    if orphans:
        raise RuntimeError(f"Cannot downgrade: {orphans} Z report(s) have no shift to point at.")
    op.alter_column("z_reports", "trading_day_id", nullable=False)
    op.alter_column("z_reports", "machine_id", existing_type=UUID(as_uuid=True), nullable=False)
    op.create_unique_constraint("uq_zreport_trading_day", "z_reports", ["trading_day_id"])
    op.drop_constraint("fk_z_reports_created_by_user_id_users", "z_reports", type_="foreignkey")
    for name in (
        "created_by_user_id", "per_machine", "payment_breakdown", "discounts_total",
        "vat_total", "machine_count", "shift_count", "period_end", "period_start",
    ):
        op.drop_column("z_reports", name)
    op.alter_column("z_reports", "business_date", new_column_name="day_date")

    op.alter_column("close_day_request_items", "shift_id", new_column_name="trading_day_id")
    _rename_constraint_if_exists(
        bind,
        "close_day_request_items",
        "close_day_request_items_shift_id_fkey",
        "close_day_request_items_trading_day_id_fkey",
    )
    op.alter_column("transactions", "shift_id", new_column_name="trading_day_id")
    _rename_index_if_exists(bind, "ix_transactions_shift", "ix_transactions_trading_day")
    _rename_constraint_if_exists(
        bind, "transactions", "transactions_shift_id_fkey", "transactions_trading_day_id_fkey"
    )

    op.drop_index("ix_shifts_z_report_id", table_name="shifts")
    for name in (
        "fk_shifts_approved_by_pos_user_id_pos_users",
        "fk_shifts_approved_by_user_id_users",
        "fk_shifts_z_report_id_z_reports",
    ):
        op.drop_constraint(name, "shifts", type_="foreignkey")
    for name in (
        "approved_by_pos_user_id", "approved_by_user_id", "reconstruction_basis",
        "reconstructed_by", "reconstructed", "z_report_id", "totals_mismatch", "till_totals",
        "last_transaction_number", "first_transaction_number", "transactions_count",
        "vat_total", "total_card_tips", "total_cash_tips", "total_tips", "total_card",
        "total_cash", "total_refunds", "total_sales", "close_request_item_id", "unattended",
        "closed_by_pos_user_id", "opened_by_pos_user_id", "close_accepted_at",
    ):
        op.drop_column("shifts", name)
    op.alter_column("shifts", "counted_cash", new_column_name="actual_cash")
    op.alter_column("shifts", "business_date", new_column_name="day_date")
    _rename_constraints(bind, "shifts", "shifts_", "trading_days_")
    _rename_constraint_if_exists(bind, "shifts", "fk_shifts_tenant_id", "fk_trading_days_tenant_id")
    _rename_index_if_exists(bind, "uq_shift_one_open", "uq_trading_day_one_open")
    _rename_indexes(bind, "shifts", "ix_shifts_", "ix_trading_days_")
    op.execute("ALTER TYPE shiftstatus RENAME TO tradingdaystatus")
    op.rename_table("shifts", "trading_days")
    op.create_foreign_key(
        "z_reports_trading_day_id_fkey", "z_reports", "trading_days", ["trading_day_id"], ["id"]
    )
    op.create_index("ix_z_reports_machine_day", "z_reports", ["machine_id", "day_date"])
