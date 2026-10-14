"""customer_display_media + customer_display_media_presence ("מסך לקוח": חיסכון במקום)

P:/specs/customer-display-transitions.md §3א, §5 (app/services/customer_display_media.py):

- `customer_display_media` — one file of a customer display's slideshow: uploaded from the
  dashboard, compressed in the background (the original held in `source` only until then), its
  URL and sha256, and whether the retention policy (`mediaRetention`) has deleted it from the
  server since.
- `customer_display_media_presence` — per device, the sha256s of the slideshow's files it says it
  holds (the heartbeat's `customerDisplayMedia`), and whether it shows a customer screen at all.

The settings themselves (`transition`, `videoQuality`, `mediaRetention`, …) need no migration:
they are keys of the `customerDisplay` object every layer's settings JSON already has.

Add-only and idempotent (the auto-reloaded API may have created the tables from the models
before this runs).

Revision ID: e4b7c2d9a6f1
Revises: ba584f6fb704
Create Date: 2026-10-14 12:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "e4b7c2d9a6f1"
down_revision: Union[str, Sequence[str], None] = "ba584f6fb704"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MEDIA = "customer_display_media"
PRESENCE = "customer_display_media_presence"


def _exists(table: str) -> bool:
    if context.is_offline_mode():
        return False
    return sa.inspect(op.get_bind()).has_table(table)


def upgrade() -> None:
    if not _exists(MEDIA):
        op.create_table(
            MEDIA,
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "tenant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
            ),
            sa.Column("kind", sa.String(8), nullable=False),
            sa.Column("status", sa.String(16), nullable=False, server_default="processing"),
            sa.Column("source", sa.LargeBinary(), nullable=True),
            sa.Column("source_type", sa.String(64), nullable=True),
            sa.Column("source_bytes", sa.Integer(), nullable=True),
            sa.Column("video_quality", sa.String(8), nullable=True),
            sa.Column("url", sa.String(500), nullable=True),
            sa.Column("storage", sa.String(16), nullable=True),
            sa.Column("public_id", sa.String(300), nullable=True),
            sa.Column("sha256", sa.String(64), nullable=True),
            sa.Column("bytes", sa.Integer(), nullable=True),
            sa.Column("width", sa.Integer(), nullable=True),
            sa.Column("height", sa.Integer(), nullable=True),
            sa.Column("warning", sa.String(40), nullable=True),
            sa.Column("error", sa.String(200), nullable=True),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_customer_display_media_tenant_id", MEDIA, ["tenant_id"])
        op.create_index("ix_customer_display_media_sha256", MEDIA, ["sha256"])
        op.create_index("ix_customer_display_media_status_lease", MEDIA, ["status", "lease_until"])
    if not _exists(PRESENCE):
        op.create_table(
            PRESENCE,
            sa.Column(
                "machine_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("pos_machines.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("screen", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("held", postgresql.JSONB(), nullable=False, server_default="[]"),
            sa.Column("reported_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("ix_customer_display_media_presence_tenant_id", PRESENCE, ["tenant_id"])


def downgrade() -> None:
    op.drop_table(PRESENCE)
    op.drop_table(MEDIA)
