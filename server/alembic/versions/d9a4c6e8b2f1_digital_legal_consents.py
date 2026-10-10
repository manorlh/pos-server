"""Legal pages and consent records of the public digital channels ("משפטי ונגישות")

* `legal_documents` — the versioned accessibility statement, privacy policy, terms and cookie
  policy of a company (a shop may override). Drafts carry version 0; publication numbers them.
* `cookie_consent_records` — the cookie banner's append-only log (anonymous id as a keyed hash).
* `marketing_consent_records` — marketing consent (§30A) from checkout / enquiry forms,
  separate from transactional messages (contact as a keyed hash).

Add-only. Idempotent: the auto-reloading dev API's `create_all` may make the tables before this
runs, so every table and index is looked at first. Never downgraded in place.

Revision ID: d9a4c6e8b2f1
Revises: b8e2d4f6a1c3
Create Date: 2026-10-10
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "d9a4c6e8b2f1"
down_revision: Union[str, Sequence[str], None] = "b8e2d4f6a1c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DOCS = "legal_documents"
COOKIES = "cookie_consent_records"
MARKETING = "marketing_consent_records"


def _inspector():
    return None if context.is_offline_mode() else sa.inspect(op.get_bind())


def _has_table(insp, name: str) -> bool:
    return insp is not None and insp.has_table(name)


def _indexes(insp, table: str) -> set:
    return set() if insp is None or not insp.has_table(table) else {i["name"] for i in insp.get_indexes(table)}


def _index(insp, name: str, table: str, columns, **kw) -> None:
    if name not in _indexes(insp, table):
        op.create_index(name, table, columns, **kw)


def upgrade() -> None:
    insp = _inspector()
    uuid = postgresql.UUID(as_uuid=True)
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    tz = sa.DateTime(timezone=True)

    if not _has_table(insp, DOCS):
        op.create_table(
            DOCS,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("company_id", uuid, sa.ForeignKey("companies.id"), nullable=False),
            sa.Column("shop_id", uuid, sa.ForeignKey("shops.id"), nullable=True),
            sa.Column("scope_key", sa.String(40), nullable=False),
            sa.Column("kind", sa.String(20), nullable=False),
            sa.Column("lang", sa.String(8), nullable=False, server_default="he"),
            sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("status", sa.String(12), nullable=False, server_default="draft"),
            sa.Column("title", sa.String(200), nullable=False),
            sa.Column("body", sa.Text(), nullable=False),
            sa.Column("fields", jsonb, nullable=False, server_default="{}"),
            sa.Column("template_key", sa.String(40), nullable=True),
            sa.Column("template_version", sa.Integer(), nullable=True),
            sa.Column("edit_seq", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("reviewed", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("reviewed_by", uuid, nullable=True),
            sa.Column("reviewed_at", tz, nullable=True),
            sa.Column("review_note", sa.String(300), nullable=True),
            sa.Column("published_by", uuid, nullable=True),
            sa.Column("published_at", tz, nullable=True),
            sa.Column("created_by", uuid, nullable=True),
            sa.Column("updated_by", uuid, nullable=True),
            sa.Column("created_at", tz, nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", tz, nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("company_id", "scope_key", "kind", "lang", "version", name="uq_legal_documents_version"),
        )
    _index(insp, "ix_legal_documents_tenant_id", DOCS, ["tenant_id"])
    _index(insp, "ix_legal_documents_lookup", DOCS, ["company_id", "kind", "lang", "status"])

    if not _has_table(insp, COOKIES):
        op.create_table(
            COOKIES,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, nullable=False),
            sa.Column("company_id", uuid, nullable=False),
            sa.Column("anon_hash", sa.String(64), nullable=False),
            sa.Column("policy_version", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("choices", jsonb, nullable=False, server_default="{}"),
            sa.Column("action", sa.String(10), nullable=False),
            sa.Column("surface", sa.String(12), nullable=False, server_default="other"),
            sa.Column("ip_hash", sa.String(64), nullable=True),
            sa.Column("created_at", tz, nullable=False, server_default=sa.func.now()),
        )
    _index(insp, "ix_cookie_consent_records_tenant_id", COOKIES, ["tenant_id"])
    _index(insp, "ix_cookie_consent_records_visitor", COOKIES, ["company_id", "anon_hash", "created_at"])

    if not _has_table(insp, MARKETING):
        op.create_table(
            MARKETING,
            sa.Column("id", uuid, primary_key=True),
            sa.Column("tenant_id", uuid, nullable=False),
            sa.Column("company_id", uuid, nullable=False),
            sa.Column("shop_id", uuid, nullable=True),
            sa.Column("channel", sa.String(10), nullable=False),
            sa.Column("subject_kind", sa.String(8), nullable=False),
            sa.Column("subject_hash", sa.String(64), nullable=False),
            sa.Column("granted", sa.Boolean(), nullable=False),
            sa.Column("text_snapshot", sa.Text(), nullable=False),
            sa.Column("text_version", sa.String(20), nullable=False),
            sa.Column("source", sa.String(12), nullable=False),
            sa.Column("source_ref", sa.String(80), nullable=True),
            sa.Column("ip_hash", sa.String(64), nullable=True),
            sa.Column("actor_user_id", uuid, nullable=True),
            sa.Column("occurred_at", tz, nullable=False, server_default=sa.func.now()),
        )
    _index(insp, "ix_marketing_consent_records_tenant_id", MARKETING, ["tenant_id"])
    _index(insp, "ix_marketing_consent_subject", MARKETING, ["company_id", "channel", "subject_hash", "occurred_at"])


def downgrade() -> None:
    # Add-only: these tables hold consent evidence and published legal text. Never dropped in place.
    pass
