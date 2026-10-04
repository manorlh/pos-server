import uuid

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base

#: Where a release can be sent, most specific last. A till takes the assignment of the
#: most specific level that has one: itself, its area, its shop, its company, its tenant.
APP_RELEASE_LEVELS = ("tenant", "company", "shop", "area", "machine")

#: What a till reports while it takes a release (`POST /sync/{id}/app-update/status`).
APP_UPDATE_STATUSES = ("downloading", "downloaded", "installing", "installed", "failed", "declined")


class AppRelease(Base):
    """
    One build of the till app (an Android APK) a super admin uploaded ("עדכון קופות").

    Global, not per tenant: every tenant's tills run the same app. Who gets it is decided
    by its assignments (`AppReleaseAssignment`). The file itself lives on local disk under
    `settings.app_releases_dir`; `sha256` and `size_bytes` are computed server-side on
    upload, and the till verifies the hash before installing.

    Retired (`is_active` false), never deleted: a till's status rows keep pointing at it,
    and a retired release is simply not offered to anyone any more.
    """

    __tablename__ = "app_releases"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    #: Android `versionCode`. A till is never offered a lower one than it runs.
    version_code = Column(Integer, nullable=False)
    #: Android `versionName`, the till's own name for the build; unique across releases.
    version_name = Column(String(64), nullable=False, unique=True)
    #: Lowercase hex SHA-256 of the file.
    sha256 = Column(String(64), nullable=False)
    size_bytes = Column(BigInteger, nullable=False)
    file_path = Column(String(1000), nullable=False)
    notes = Column(Text, nullable=True)
    uploaded_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AppReleaseAssignment(Base):
    """
    "Send this release to that target": a tenant, a company, a shop, an area or one till.

    `target_id` names a row of `tenants`, `companies`, `shops`, `shop_areas` or
    `pos_machines` by `level`, so it carries no foreign key (as till parameter values do).
    Cancelled, never deleted, so the dashboard can say what was sent and withdrawn.
    """

    __tablename__ = "app_release_assignments"
    __table_args__ = (
        CheckConstraint(
            "level IN ('tenant', 'company', 'shop', 'area', 'machine')",
            name="ck_app_release_assignments_level",
        ),
        # Resolution reads every live assignment on one till's five levels at once.
        Index("ix_app_release_assignments_target", "level", "target_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    release_id = Column(UUID(as_uuid=True), ForeignKey("app_releases.id"), nullable=False, index=True)
    level = Column(String(16), nullable=False)
    target_id = Column(UUID(as_uuid=True), nullable=False)
    #: The tenant the target belongs to (the target itself for level `tenant`).
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    #: The till installs without asking once it is idle (no open sale, no open shift
    #: screen); otherwise it offers the update and a person decides.
    auto_install = Column(Boolean, nullable=False, default=False, server_default="false")
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    cancelled_at = Column(DateTime(timezone=True), nullable=True)

    release = relationship("AppRelease")


class AppReleaseMachineStatus(Base):
    """What one till last reported about one release: one row per pair, replaced in place."""

    __tablename__ = "app_release_machine_status"
    __table_args__ = (
        UniqueConstraint("machine_id", "release_id", name="uq_app_release_machine_status"),
        CheckConstraint(
            "status IN ('downloading', 'downloaded', 'installing', 'installed', 'failed', 'declined')",
            name="ck_app_release_machine_status_status",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False, index=True)
    release_id = Column(UUID(as_uuid=True), ForeignKey("app_releases.id"), nullable=False, index=True)
    status = Column(String(16), nullable=False)
    message = Column(String(500), nullable=True)
    #: The version the till said it was running when it reported.
    version_name = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
