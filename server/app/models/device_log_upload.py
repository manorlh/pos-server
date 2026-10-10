"""
"שליחת לוגים לענן" (the device-logs contract, specs/device-logs-api.md) — a device's logs, uploaded for support.

One row per upload (`POST /sync/{machine_id}/device-logs`, app/services/device_logs.py): the
compressed log as the device sent it (gzip, already scrubbed on the device — §4), its metadata,
and where it came from. Idempotent per machine by the device's `upload_id`. A remote request
(`upload_logs` device command) is linked by `command_id`. Kept `DEVICE_LOGS_RETENTION_DAYS`
(default 30; 0 = kept) — the nightly pass deletes older rows.
"""
import uuid

from sqlalchemy import BigInteger, Column, DateTime, ForeignKey, Index, Integer, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: `reason`: "שלח לוגים לתמיכה" on the device / the dashboard's "בקש לוגים" / after a crash.
REASONS = ("manual", "remote", "crash")
#: `content_encoding`: UTF-8 text, gzip, then base64.
ENCODINGS = ("gzip+base64",)


class DeviceLogUpload(Base):
    __tablename__ = "device_log_uploads"
    __table_args__ = (
        UniqueConstraint("machine_id", "upload_id", name="uq_device_log_uploads_machine_upload"),
        Index("ix_device_log_uploads_machine_received", "machine_id", "received_at"),
        Index("ix_device_log_uploads_tenant_received", "tenant_id", "received_at"),
        Index("ix_device_log_uploads_received", "received_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    #: The device's own id for this upload: a resend answers with the same row.
    upload_id = Column(UUID(as_uuid=True), nullable=False)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True)
    #: The device's shop ("סניף") when it uploaded.
    branch_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="SET NULL"), nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False)
    reason = Column(String(16), nullable=False)
    #: The `upload_logs` command this upload answers (a remote request), if any.
    command_id = Column(UUID(as_uuid=True), ForeignKey("device_commands.id", ondelete="SET NULL"), nullable=True)
    #: Who asked for it from the dashboard (the command's sender), for "מי ביקש".
    requested_by_name = Column(String(200), nullable=True)
    #: The device's note, scrubbed again by the cloud (app/services/log_scrub.py).
    note = Column(Text, nullable=True)
    app_version = Column(String(100), nullable=True)
    version_code = Column(BigInteger, nullable=True)
    device_model = Column(String(100), nullable=True)
    os = Column(String(100), nullable=True)
    from_ms = Column(BigInteger, nullable=True)
    to_ms = Column(BigInteger, nullable=True)
    line_count = Column(Integer, nullable=True)
    content_encoding = Column(String(32), nullable=False)
    #: The gzip bytes as sent (never inflated in storage).
    content = Column(LargeBinary, nullable=False)
    #: Compressed and inflated sizes, in bytes (the inflated one from the size check).
    size_bytes = Column(Integer, nullable=False)
    inflated_bytes = Column(BigInteger, nullable=True)
    received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: First opened (viewed or downloaded) by someone who may read logs: the "חדש" badge's end.
    opened_at = Column(DateTime(timezone=True), nullable=True)
    opened_by_name = Column(String(200), nullable=True)
