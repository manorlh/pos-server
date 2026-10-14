"""
"מסך לקוח" — the cloud relay of a till's customer screen (app/services/customer_display.py).

One row per till: the latest state it published for a paired customer display that cannot
reach it over the shop's LAN (a browser at `/display`, or an Android display on another
network). Replaced on every push, never a history; `seq` grows by one per push so a display
asks only for what is newer. Holds only what the customer sees on the screen anyway.
"""
import uuid

from sqlalchemy import BigInteger, Boolean, Column, DateTime, ForeignKey, Index, Integer, LargeBinary, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base


class CustomerDisplayState(Base):
    __tablename__ = "customer_display_states"

    till_machine_id = Column(
        UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), primary_key=True
    )
    seq = Column(BigInteger, nullable=False, default=0, server_default="0")
    state = Column(JSONB, nullable=False, default=dict, server_default="{}")
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class CustomerDisplayMedia(Base):
    """
    One file of a customer display's slideshow (P:/specs/customer-display-transitions.md §3א, §5;
    app/services/customer_display_media.py): uploaded from the dashboard, compressed in the
    background (an image to WebP 1920 px, a video to H.264 MP4 720p / 1080p, no sound), then
    stored (Cloudinary, or the server's own media store) and its URL and sha256 written into the
    playlists that name it (`mediaId`). `source` holds the original only while it is processed —
    the original is never kept. `status`: processing → ready (or failed); deleted once the
    retention of every playlist holding it allows (`mediaRetention`), the URL and hash kept.
    """

    __tablename__ = "customer_display_media"
    __table_args__ = (Index("ix_customer_display_media_status_lease", "status", "lease_until"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    kind = Column(String(8), nullable=False)
    status = Column(String(16), nullable=False, default="processing", server_default="processing")
    #: The original upload, only until it is processed (then NULL).
    source = Column(LargeBinary, nullable=True)
    source_type = Column(String(64), nullable=True)
    source_bytes = Column(Integer, nullable=True)
    video_quality = Column(String(8), nullable=True)
    url = Column(String(500), nullable=True)
    storage = Column(String(16), nullable=True)
    public_id = Column(String(300), nullable=True)
    sha256 = Column(String(64), nullable=True, index=True)
    bytes = Column(Integer, nullable=True)
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    #: Stored as uploaded, not compressed: "ffmpeg_missing" | "compress_failed".
    warning = Column(String(40), nullable=True)
    error = Column(String(200), nullable=True)
    attempts = Column(Integer, nullable=False, default=0, server_default="0")
    lease_until = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    ready_at = Column(DateTime(timezone=True), nullable=True)
    deleted_at = Column(DateTime(timezone=True), nullable=True)


class CustomerDisplayMediaPresence(Base):
    """
    What a device says it holds of the slideshow's files (§5.4: the heartbeat's
    `customerDisplayMedia`): the sha256s on its disk, and whether it shows a customer screen at
    all. One row per device, replaced by every report.
    """

    __tablename__ = "customer_display_media_presence"

    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), primary_key=True)
    tenant_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    screen = Column(Boolean, nullable=False, default=True, server_default="true")
    held = Column(JSONB, nullable=False, default=list, server_default="[]")
    reported_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
