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

#: Which app a release is: the Android till APK, the Windows app's installer (.exe), or a
#: kiosk web bundle (.zip: the kiosk's screens as static files, shown by the Android kiosk).
APP_RELEASE_PLATFORMS = ("android", "windows", "kiosk_web")


class AppRelease(Base):
    """
    One build of the app a super admin uploaded ("עדכוני גרסה"): the Android till's APK
    (`platform` "android", every release before there were two) or the Windows app's
    NSIS installer (`platform` "windows").

    Global, not per tenant: every tenant's devices run the same app. Who gets it is decided
    by its assignments (`AppReleaseAssignment`); a device only ever resolves releases of its
    own platform. The file itself lives on local disk under `settings.app_releases_dir`
    (`{id}.apk` / `{id}.exe`); `sha256` and `size_bytes` are computed server-side on
    upload, and the device verifies the hash before installing.

    Retired (`is_active` false), never deleted: a till's status rows keep pointing at it,
    and a retired release is simply not offered to anyone any more.
    """

    __tablename__ = "app_releases"
    __table_args__ = (
        CheckConstraint("platform IN ('android', 'windows', 'kiosk_web')", name="ck_app_releases_platform"),
        # A version name is unique within its platform (Windows 0.2.0 and Android 0.2.0 may both exist).
        UniqueConstraint("platform", "version_name", name="uq_app_releases_platform_version_name"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    #: "android" | "windows" | "kiosk_web" (`APP_RELEASE_PLATFORMS`).
    platform = Column(String(16), nullable=False, default="android", server_default="android", index=True)
    #: Android `versionCode`; for Windows derived from the name ("a.b.c" → a·10⁶ + b·10³ + c).
    #: A device is never offered a lower one than it runs, unless the assignment allows a
    #: (Windows-only) rollback.
    version_code = Column(Integer, nullable=False)
    #: The app's own name for the build (Android `versionName`, Windows "a.b.c");
    #: unique per platform.
    version_name = Column(String(64), nullable=False)
    #: Lowercase hex SHA-256 of the file.
    sha256 = Column(String(64), nullable=False)
    size_bytes = Column(BigInteger, nullable=False)
    file_path = Column(String(1000), nullable=False)
    #: Android: lowercase hex SHA-256 of the APK's signing certificate (app/services/apk_signing.py),
    #: read on upload — the Android Enterprise QR's signature checksum. Null for Windows, or an APK
    #: whose signature block could not be read (computed again when a QR asks for it).
    signing_cert_sha256 = Column(String(64), nullable=True)
    #: Kiosk web bundles only: the bridge API the bundle needs from the kiosk's APK
    #: (`manifest.bridgeApi`); null for Android / Windows releases.
    bridge_api = Column(Integer, nullable=True)
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
        CheckConstraint(
            "rollout_percent BETWEEN 1 AND 100", name="ck_app_release_assignments_rollout_percent"
        ),
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
    #: Staged rollout: the share of the target's devices (1..100) this assignment covers —
    #: a fixed hash of (assignment, machine) decides (`app_updates.in_rollout_stage`), so
    #: raising it keeps every device already in. A device outside the stage resolves on as
    #: if the assignment were not there.
    rollout_percent = Column(Integer, nullable=False, default=100, server_default="100")
    #: Rollback (Windows only): the device may be offered this release although it runs a
    #: higher versionCode. Refused for Android, which cannot install a lower versionCode
    #: without uninstalling (= losing its data).
    allow_downgrade = Column(Boolean, nullable=False, default=False, server_default="false")
    #: "HH:MM" device-local time, both or neither: an auto-install runs only inside this
    #: window (it may cross midnight, 22:00–05:00). The Windows app honours it; the Android
    #: till ignores it today.
    install_window_start = Column(String(5), nullable=True)
    install_window_end = Column(String(5), nullable=True)
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
