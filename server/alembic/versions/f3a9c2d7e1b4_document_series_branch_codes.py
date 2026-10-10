"""document series per type, and mandatory branch codes — docs/SPEC_DOCUMENT_PREFIX.md

Revision ID: f3a9c2d7e1b4
Revises: e7b9d1f3a5c8
Create Date: 2026-10-06

The owner's decisions on document numbers:

* "רצף מספרים נפרד לכל מסמך": each till numbers 320, 330 and 400 on separate counters (an
  exempt dealer's refund, -400, shares the 400 series). `transactions.document_series` is a
  generated column — Postgres computes it from the type, for every existing row and every
  insert, so code that does not know about it (an API process not restarted yet) keeps
  writing documents. The uniqueness becomes
  (machine_id, document_series, transaction_number) instead of (machine_id,
  transaction_number). Existing rows were unique under the stricter old key, so they are
  unique under the new one — checked anyway before the swap, and the migration stops
  rather than guess if that ever fails.
* "חייב שלסניף יהיה קוד": every shop gets a branch code. A shop without one gets the
  lowest free code of its company, in creation order, flagged `branch_id_auto_assigned`
  so the dashboard asks for it to be checked with the accountant. Every assignment is
  logged. Existing codes are never changed (a duplicate or non-digit one is logged).
"""
import logging
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f3a9c2d7e1b4"
down_revision: Union[str, Sequence[str], None] = "e7b9d1f3a5c8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

log = logging.getLogger("alembic.runtime.migration")

#: The same as `app.models.transaction.DOCUMENT_SERIES_SQL` (copied: a migration does not
#: import the models).
SERIES_SQL = (
    "CASE WHEN document_type IN (400, -400) THEN 400 "
    "WHEN document_type = 330 THEN 330 "
    "WHEN document_type IS NULL AND refund_of_transaction_id IS NOT NULL THEN 330 "
    "WHEN document_type IS NULL OR document_type = 320 THEN 320 "
    "ELSE abs(document_type) END"
)


def _is_generated(bind, table, column) -> bool:
    if bind.dialect.name != "postgresql":
        return True
    return bool(bind.execute(sa.text(
        "SELECT is_generated = 'ALWAYS' FROM information_schema.columns "
        "WHERE table_name = :t AND column_name = :c"
    ), {"t": table, "c": column}).scalar())


def _columns(inspector, table):
    return {c["name"] for c in inspector.get_columns(table)}


def _unique_names(inspector, table):
    return {u["name"] for u in inspector.get_unique_constraints(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # ── transactions.document_series ─────────────────────────────────────────
    if inspector.has_table("transactions"):
        names = _unique_names(inspector, "transactions")
        columns = _columns(inspector, "transactions")
        if "document_series" in columns and not _is_generated(bind, "transactions", "document_series"):
            # A plain column from an earlier draft of this revision: replaced.
            if "uq_tx_machine_series_number" in names:
                op.drop_constraint("uq_tx_machine_series_number", "transactions", type_="unique")
            op.drop_column("transactions", "document_series")
            columns.discard("document_series")
        if "document_series" not in columns:
            bind.execute(sa.text(
                f"ALTER TABLE transactions ADD COLUMN document_series integer "
                f"GENERATED ALWAYS AS ({SERIES_SQL}) STORED NOT NULL"
            ))
        duplicates = bind.execute(sa.text(
            "SELECT count(*) FROM (SELECT 1 FROM transactions "
            "GROUP BY machine_id, document_series, transaction_number HAVING count(*) > 1) d"
        )).scalar()
        if duplicates:
            raise RuntimeError(
                f"{duplicates} (machine, series, number) groups are not unique; not swapping the constraint"
            )
        names = _unique_names(sa.inspect(bind), "transactions")
        if "uq_tx_machine_number" in names:
            op.drop_constraint("uq_tx_machine_number", "transactions", type_="unique")
        if "uq_tx_machine_series_number" not in names:
            op.create_unique_constraint(
                "uq_tx_machine_series_number",
                "transactions",
                ["machine_id", "document_series", "transaction_number"],
            )

    # ── shops: mandatory branch codes ───────────────────────────────────────
    if inspector.has_table("shops"):
        if "branch_id_auto_assigned" not in _columns(inspector, "shops"):
            op.add_column(
                "shops",
                sa.Column("branch_id_auto_assigned", sa.Boolean(), nullable=False, server_default=sa.false()),
            )
        rows = bind.execute(sa.text(
            "SELECT id, company_id, name, branch_id FROM shops ORDER BY company_id, created_at, id"
        )).fetchall()
        used = {}
        for shop_id, company_id, name, code in rows:
            text = (code or "").strip()
            if text:
                taken = used.setdefault(company_id, set())
                if text in taken:
                    log.warning("shop %s (%s): branch code %s is not unique in its company — left as it is", shop_id, name, text)
                if not text.isdigit() or len(text) > 7:
                    log.warning("shop %s (%s): branch code %r is not 1-7 digits — left as it is", shop_id, name, text)
                taken.add(text)
        for shop_id, company_id, name, code in rows:
            if (code or "").strip():
                continue
            taken = used.setdefault(company_id, set())
            n = 1
            while str(n) in taken:
                n += 1
            taken.add(str(n))
            bind.execute(
                sa.text("UPDATE shops SET branch_id = :code, branch_id_auto_assigned = true WHERE id = :id"),
                {"code": str(n), "id": shop_id},
            )
            log.info("shop %s (%s), company %s: no branch code — assigned %s", shop_id, name, company_id, n)


def downgrade() -> None:
    # Never run on a live database (fiscal numbering). Restores the old key only when the
    # data still fits it; the assigned branch codes stay.
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("transactions"):
        names = _unique_names(inspector, "transactions")
        if "uq_tx_machine_series_number" in names:
            op.drop_constraint("uq_tx_machine_series_number", "transactions", type_="unique")
        if "uq_tx_machine_number" not in names:
            op.create_unique_constraint("uq_tx_machine_number", "transactions", ["machine_id", "transaction_number"])
        if "document_series" in _columns(inspector, "transactions"):
            op.drop_column("transactions", "document_series")
    if inspector.has_table("shops") and "branch_id_auto_assigned" in _columns(inspector, "shops"):
        op.drop_column("shops", "branch_id_auto_assigned")
