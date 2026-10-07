"""The Android kiosk's web renderer: what it shows now and which screens bundle it runs."""
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

#: What the kiosk shows (`renderer`) and what its config asks (`configured`, `general.renderer`).
KIOSK_WEB_RENDERERS = ("native", "web")


class KioskWebDeviceStatus(Base):
    """
    One row per machine, replaced by every `POST /sync/{id}/kiosk-web/status`.

    The bundles themselves are app releases of platform "kiosk_web" (app/models/app_release.py);
    this is the kiosk's own view: the screens it shows now ("native" built-in / "web"), what
    the cloud config asks, its active bundle (shipped inside the APK or downloaded), the one
    kept for rollback, one waiting for the kiosk to be idle, the bridge API its APK speaks,
    and why it fell back to the built-in screens.
    """

    __tablename__ = "kiosk_web_device_status"

    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), primary_key=True)
    #: "native" | "web" — what the kiosk shows now.
    renderer = Column(String(16), nullable=False)
    #: "native" | "web" — what the cloud config asks (`general.renderer`); null if not said.
    configured = Column(String(16), nullable=True)
    #: The active bundle's versionName / versionCode; null = no bundle.
    bundle_version = Column(String(64), nullable=True)
    bundle_version_code = Column(Integer, nullable=True)
    #: "bundled" (shipped inside the APK) | "downloaded" | null.
    bundle_source = Column(String(16), nullable=True)
    #: Kept for rollback.
    previous_version = Column(String(64), nullable=True)
    #: Downloaded, waiting for the kiosk to be idle.
    pending_version = Column(String(64), nullable=True)
    #: The bridge API the kiosk's APK speaks.
    apk_bridge_api = Column(Integer, nullable=True)
    #: Why it shows the built-in screens although web is configured (a short token:
    #: ready_timeout, render_gone, js_errors, no_bundle, bridge_api, load_error…).
    fallback_reason = Column(String(32), nullable=True)
    message = Column(String(500), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
