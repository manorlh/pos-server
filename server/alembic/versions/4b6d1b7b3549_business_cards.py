"""Digital business cards: business_cards, revisions, slugs, card_enquiries, daily stats, audit

"כרטיסי ביקור דיגיטליים" (spec §25–28; app/services/business_cards.py, app/models/business_card.py).
Six new tables, nothing else touched. Idempotent: each table and index is looked at first (the
API's create_all may have made a table before this runs). Downgrade drops only these tables.

Revision ID: 4b6d1b7b3549, revises b8e2d4f6a1c3.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "4b6d1b7b3549"
down_revision: Union[str, Sequence[str], None] = "b8e2d4f6a1c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CARDS = "business_cards"
REVISIONS = "business_card_revisions"
SLUGS = "business_card_slugs"
ENQUIRIES = "card_enquiries"
STATS = "business_card_daily_stats"
AUDIT = "business_card_audit_events"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _has(insp, table: str) -> bool:
    return insp is not None and insp.has_table(table)


def _indexes(insp, table: str) -> set:
    if not _has(insp, table):
        return set()
    return {i["name"] for i in insp.get_indexes(table)} | {u["name"] for u in insp.get_unique_constraints(table)}


def upgrade() -> None:
    insp = _inspector()
    uuid = postgresql.UUID(as_uuid=True)
    jsonb = postgresql.JSONB()
    now = sa.text("now()")

    if not _has(insp, CARDS):
        op.create_table(
            CARDS,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("company_id", uuid, sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
            sa.Column("shop_id", uuid, sa.ForeignKey("shops.id", ondelete="CASCADE"), nullable=True),
            sa.Column("area_id", uuid, sa.ForeignKey("shop_areas.id", ondelete="SET NULL"), nullable=True),
            sa.Column("card_type", sa.String(16), nullable=False),
            sa.Column("name", sa.String(160), nullable=False),
            sa.Column("slug", sa.String(64), nullable=False),
            sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
            sa.Column("parent_card_id", uuid, sa.ForeignKey("business_cards.id", ondelete="SET NULL"), nullable=True),
            sa.Column("owner_user_id", uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("draft", jsonb, nullable=False, server_default="{}"),
            sa.Column("draft_version", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("draft_updated_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("draft_updated_by", uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("published_revision_id", uuid, nullable=True),
            sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("paused_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_by_user_id", uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
            sa.UniqueConstraint("slug", name="uq_business_cards_slug"),
        )
    have = _indexes(_inspector(), CARDS)
    for name, cols in (
        ("ix_business_cards_tenant_id", ["tenant_id"]),
        ("ix_business_cards_tenant_status", ["tenant_id", "status"]),
        ("ix_business_cards_shop", ["shop_id"]),
        ("ix_business_cards_company", ["company_id"]),
    ):
        if name not in have:
            op.create_index(name, CARDS, cols)

    if not _has(insp, REVISIONS):
        op.create_table(
            REVISIONS,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("card_id", uuid, sa.ForeignKey("business_cards.id", ondelete="CASCADE"), nullable=False),
            sa.Column("number", sa.Integer(), nullable=False),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("content", jsonb, nullable=False),
            sa.Column("content_hash", sa.String(64), nullable=False),
            sa.Column("note", sa.String(300), nullable=True),
            sa.Column("created_by_user_id", uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
            sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint("card_id", "number", name="uq_business_card_revisions_number"),
        )
    have = _indexes(_inspector(), REVISIONS)
    for name, cols in (
        ("ix_business_card_revisions_tenant_id", ["tenant_id"]),
        ("ix_business_card_revisions_card_id", ["card_id"]),
    ):
        if name not in have:
            op.create_index(name, REVISIONS, cols)

    if not _has(insp, SLUGS):
        op.create_table(
            SLUGS,
            sa.Column("slug", sa.String(64), primary_key=True),
            sa.Column("card_id", uuid, sa.ForeignKey("business_cards.id", ondelete="CASCADE"), nullable=False),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
            sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
        )
    if "ix_business_card_slugs_card_id" not in _indexes(_inspector(), SLUGS):
        op.create_index("ix_business_card_slugs_card_id", SLUGS, ["card_id"])

    if not _has(insp, ENQUIRIES):
        op.create_table(
            ENQUIRIES,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("card_id", uuid, sa.ForeignKey("business_cards.id", ondelete="CASCADE"), nullable=False),
            sa.Column("revision_id", uuid, sa.ForeignKey("business_card_revisions.id", ondelete="SET NULL"), nullable=True),
            sa.Column("company_id", uuid, nullable=True),
            sa.Column("shop_id", uuid, nullable=True),
            sa.Column("area_id", uuid, nullable=True),
            sa.Column("submission_id", sa.String(64), nullable=False),
            sa.Column("name", sa.String(120), nullable=True),
            sa.Column("phone", sa.String(20), nullable=True),
            sa.Column("email", sa.String(254), nullable=True),
            sa.Column("topic", sa.String(120), nullable=True),
            sa.Column("message", sa.Text(), nullable=True),
            sa.Column("lang", sa.String(8), nullable=True),
            sa.Column("source", sa.String(32), nullable=True),
            sa.Column("campaign", sa.String(60), nullable=True),
            sa.Column("consent_privacy_url", sa.String(500), nullable=True),
            sa.Column("consent_text", sa.String(300), nullable=True),
            sa.Column("consented_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
            sa.Column("dedupe_key", sa.String(64), nullable=False),
            sa.Column("ip_hash", sa.String(64), nullable=True),
            sa.Column("status", sa.String(16), nullable=False, server_default="new"),
            sa.Column("delivery", sa.String(16), nullable=False, server_default="internal"),
            sa.Column("handled_by_user_id", uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("handled_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
            sa.UniqueConstraint("card_id", "submission_id", name="uq_card_enquiries_submission"),
        )
    have = _indexes(_inspector(), ENQUIRIES)
    for name, cols in (
        ("ix_card_enquiries_tenant_id", ["tenant_id"]),
        ("ix_card_enquiries_card_created", ["card_id", "created_at"]),
        ("ix_card_enquiries_tenant_status", ["tenant_id", "status"]),
        ("ix_card_enquiries_dedupe", ["card_id", "dedupe_key", "created_at"]),
        ("ix_card_enquiries_ip", ["card_id", "ip_hash", "created_at"]),
    ):
        if name not in have:
            op.create_index(name, ENQUIRIES, cols)

    if not _has(insp, STATS):
        op.create_table(
            STATS,
            sa.Column("card_id", uuid, sa.ForeignKey("business_cards.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("day", sa.Date(), primary_key=True),
            sa.Column("metric", sa.String(24), primary_key=True),
            sa.Column("dimension", sa.String(32), primary_key=True, server_default=""),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("count", sa.Integer(), nullable=False, server_default="0"),
        )
    if "ix_business_card_daily_stats_tenant_id" not in _indexes(_inspector(), STATS):
        op.create_index("ix_business_card_daily_stats_tenant_id", STATS, ["tenant_id"])

    if not _has(insp, AUDIT):
        op.create_table(
            AUDIT,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
            sa.Column("card_id", uuid, sa.ForeignKey("business_cards.id", ondelete="CASCADE"), nullable=False),
            sa.Column("actor_user_id", uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("action", sa.String(24), nullable=False),
            sa.Column("revision_number", sa.Integer(), nullable=True),
            sa.Column("details", jsonb, nullable=False, server_default="{}"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
        )
    have = _indexes(_inspector(), AUDIT)
    for name, cols in (
        ("ix_business_card_audit_events_tenant_id", ["tenant_id"]),
        ("ix_business_card_audit_card", ["card_id", "created_at"]),
    ):
        if name not in have:
            op.create_index(name, AUDIT, cols)


def downgrade() -> None:
    insp = _inspector()
    for table in (AUDIT, STATS, ENQUIRIES, SLUGS, REVISIONS, CARDS):
        if insp is None or insp.has_table(table):
            op.drop_table(table)
