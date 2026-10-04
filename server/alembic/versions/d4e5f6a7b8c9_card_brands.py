"""card brand / acquirer / issuer on tender legs; accounting export level

* `transaction_payments.card_brand`, `card_acquirer`, `card_issuer` — what
  `app.services.card_brands` reads out of a card leg's reply (מותג, חברת סליקה, מנפיק).
  Existing card legs are backfilled from their stored reply (`mutag` / `solek` /
  `manpik`, else the BIN of the masked number).
* `accounting_export_batches.level` — "company" (one consolidated file) or "shop" (a
  file per shop); existing batches are "company" (that is how they were written).

Guarded: the app's `create_all` does not add columns to an existing table, but a fresh
database built from the models already has them.

Revision ID: d4e5f6a7b8c9
Revises: c3e4f5a6b7d8
Create Date: 2026-10-03 22:00:00.000000
"""

from __future__ import annotations

import json

from alembic import context, op
import sqlalchemy as sa


revision = "d4e5f6a7b8c9"
down_revision = "c3e4f5a6b7d8"
branch_labels = None
depends_on = None


def _columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    insp = sa.inspect(op.get_bind())
    if table not in insp.get_table_names():
        return set()
    return {c["name"] for c in insp.get_columns(table)}


def _backfill() -> None:
    """Every card leg with a reply and no brand yet. Batched; pure Python derivation."""
    if context.is_offline_mode():
        return
    try:
        from app.services.card_brands import derive
    except Exception:  # pragma: no cover — the app is not importable here; run the script
        return
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, nayax_meta FROM transaction_payments "
            "WHERE lower(method) = 'card' AND nayax_meta IS NOT NULL AND card_brand IS NULL "
            "AND card_acquirer IS NULL AND card_issuer IS NULL"
        )
    ).fetchall()
    update = sa.text(
        "UPDATE transaction_payments SET card_brand = :b, card_acquirer = :a, card_issuer = :i "
        "WHERE id = :id"
    )
    for row in rows:
        meta = row.nayax_meta
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except ValueError:
                continue
        brand, acquirer, issuer = derive(meta)
        if brand or acquirer or issuer:
            bind.execute(update, {"b": brand, "a": acquirer, "i": issuer, "id": row.id})


def upgrade() -> None:
    have = _columns("transaction_payments")
    for name in ("card_brand", "card_acquirer", "card_issuer"):
        if name not in have:
            op.add_column("transaction_payments", sa.Column(name, sa.String(16), nullable=True))
    _backfill()

    batch_cols = _columns("accounting_export_batches")
    if batch_cols and "level" not in batch_cols:
        op.add_column(
            "accounting_export_batches",
            sa.Column("level", sa.String(8), nullable=False, server_default="company"),
        )


def downgrade() -> None:
    if "level" in _columns("accounting_export_batches"):
        op.drop_column("accounting_export_batches", "level")
    have = _columns("transaction_payments")
    for name in ("card_issuer", "card_acquirer", "card_brand"):
        if name in have:
            op.drop_column("transaction_payments", name)
