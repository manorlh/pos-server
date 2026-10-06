"""Till app release payloads ("עדכון קופות"): the dashboard's, and the till's fixed contract."""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional
import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator

NOTES_MAX = 4000

AppReleaseLevel = Literal["tenant", "company", "shop", "area", "machine"]
#: The same set as `APP_UPDATE_STATUSES` (app/models/app_release.py).
AppUpdateStatus = Literal["downloading", "downloaded", "installing", "installed", "failed", "declined"]
#: The same set as `APP_RELEASE_PLATFORMS`.
AppPlatform = Literal["android", "windows"]


class InstallWindow(BaseModel):
    """"HH:MM"–"HH:MM", device-local time; may cross midnight (22:00–05:00)."""

    start: str
    end: str


class InstallWindowIn(BaseModel):
    """Both or neither (checked by the router: `422 install_window_invalid`)."""

    start: Optional[str] = None
    end: Optional[str] = None


def _clean_notes(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("notes must be text")
    value = value.strip()
    if len(value) > NOTES_MAX:
        raise ValueError(f"notes are at most {NOTES_MAX} characters")
    return value or None


# ── Dashboard ────────────────────────────────────────────────────────────────


class AppReleaseOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    platform: str = "android"
    version_code: int = Field(..., alias="versionCode")
    version_name: str = Field(..., alias="versionName")
    sha256: str
    size_bytes: int = Field(..., alias="sizeBytes")
    notes: Optional[str] = None
    is_active: bool = Field(..., alias="isActive")
    created_at: Optional[datetime] = Field(None, alias="createdAt")
    #: Live (not cancelled) assignments of this release.
    assignment_count: int = Field(0, alias="assignmentCount")


class AppReleaseUpdate(BaseModel):
    """`PATCH /app-releases/{id}`: either field, or both."""

    model_config = ConfigDict(populate_by_name=True)

    notes: Optional[str] = None
    is_active: Optional[bool] = Field(None, alias="isActive")

    @field_validator("notes", mode="before")
    @classmethod
    def _notes(cls, value):
        return _clean_notes(value)


class AppReleaseAssignmentIn(BaseModel):
    """
    `POST /app-releases/{id}/assignments`. `rolloutPercent` 1..100 (`422
    rollout_percent_invalid`), `allowDowngrade` Windows only (`422
    downgrade_not_supported_on_android`), `installWindow` both ends "HH:MM" or null
    (`422 install_window_invalid`).
    """

    model_config = ConfigDict(populate_by_name=True)

    level: AppReleaseLevel
    target_id: uuid.UUID = Field(..., alias="targetId")
    auto_install: bool = Field(False, alias="autoInstall")
    rollout_percent: int = Field(100, alias="rolloutPercent")
    allow_downgrade: bool = Field(False, alias="allowDowngrade")
    install_window: Optional[InstallWindowIn] = Field(None, alias="installWindow")


class AppReleaseAssignmentPatch(BaseModel):
    """`PATCH /app-release-assignments/{id}`: any of these; `installWindow: null` clears it."""

    model_config = ConfigDict(populate_by_name=True)

    rollout_percent: Optional[int] = Field(None, alias="rolloutPercent")
    auto_install: Optional[bool] = Field(None, alias="autoInstall")
    install_window: Optional[InstallWindowIn] = Field(None, alias="installWindow")


class AppReleaseAssignmentOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    release_id: uuid.UUID = Field(..., alias="releaseId")
    version_name: Optional[str] = Field(None, alias="versionName")
    #: The release's platform: the assignment reaches only devices of that platform.
    platform: str = "android"
    level: str
    target_id: uuid.UUID = Field(..., alias="targetId")
    #: The target's name; null when it no longer exists.
    target_name: Optional[str] = Field(None, alias="targetName")
    #: Where the target sits: the shop of an area or till, the company of a shop.
    target_context: Optional[str] = Field(None, alias="targetContext")
    tenant_id: uuid.UUID = Field(..., alias="tenantId")
    auto_install: bool = Field(..., alias="autoInstall")
    rollout_percent: int = Field(100, alias="rolloutPercent")
    allow_downgrade: bool = Field(False, alias="allowDowngrade")
    install_window: Optional[InstallWindow] = Field(None, alias="installWindow")
    created_at: Optional[datetime] = Field(None, alias="createdAt")
    cancelled_at: Optional[datetime] = Field(None, alias="cancelledAt")
    #: Active devices of the release's platform the assignment reaches (whether or not a
    #: more specific one wins there, and before the rollout stage is applied).
    machine_count: int = Field(0, alias="machineCount")


class RolloutRow(BaseModel):
    """One till in `GET /app-releases/rollout`."""

    model_config = ConfigDict(populate_by_name=True)

    machine_id: uuid.UUID = Field(..., alias="machineId")
    machine_name: str = Field(..., alias="machineName")
    pos_number: Optional[str] = Field(None, alias="posNumber")
    #: "android" | "windows" — `app_updates.machine_platform` (the device's pairing info).
    platform: str = "android"
    #: "till" | "kiosk" — `device_profile.effective_role`.
    device_role: Optional[str] = Field(None, alias="deviceRole")
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    company_name: Optional[str] = Field(None, alias="companyName")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    shop_name: Optional[str] = Field(None, alias="shopName")
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")
    area_name: Optional[str] = Field(None, alias="areaName")
    #: What the till last said it runs (its heartbeat's `appVersion`).
    current_version: Optional[str] = Field(None, alias="currentVersion")
    last_heartbeat_at: Optional[datetime] = Field(None, alias="lastHeartbeatAt")
    #: The release the till resolves to now, if any.
    release_id: Optional[uuid.UUID] = Field(None, alias="releaseId")
    target_version: Optional[str] = Field(None, alias="targetVersion")
    target_version_code: Optional[int] = Field(None, alias="targetVersionCode")
    assignment_id: Optional[uuid.UUID] = Field(None, alias="assignmentId")
    assignment_level: Optional[str] = Field(None, alias="assignmentLevel")
    auto_install: Optional[bool] = Field(None, alias="autoInstall")
    #: The till already runs the target (its `appVersion` is the release's versionName).
    up_to_date: bool = Field(False, alias="upToDate")
    #: A target is assigned and the device does not run it.
    behind: bool = False
    #: The newest active release of the device's platform (by versionCode), whether or not
    #: it is assigned to it.
    newest_version: Optional[str] = Field(None, alias="newestVersion")
    newest_version_code: Optional[int] = Field(None, alias="newestVersionCode")
    #: There is a newest release and the device does not run it.
    behind_newest: bool = Field(False, alias="behindNewest")
    #: The till's last report about the target release; null = it has said nothing yet.
    status: Optional[str] = None
    status_message: Optional[str] = Field(None, alias="statusMessage")
    status_at: Optional[datetime] = Field(None, alias="statusAt")


# ── Till (fixed contract, docs: the till is built against these) ─────────────


class AppUpdateOffer(BaseModel):
    """
    `GET /sync/{machine_id}/app-update`. Every key always present; nulls when nothing is
    offered. The first eight keys are the Android till's original contract; `platform`,
    `allowDowngrade`, `rolloutPercent` and `installWindow` were added for the Windows app
    (Moshi on the till ignores keys it does not know).
    """

    model_config = ConfigDict(populate_by_name=True)

    available: bool
    release_id: Optional[str] = Field(None, alias="releaseId")
    version_code: Optional[int] = Field(None, alias="versionCode")
    version_name: Optional[str] = Field(None, alias="versionName")
    sha256: Optional[str] = None
    size_bytes: Optional[int] = Field(None, alias="sizeBytes")
    notes: Optional[str] = None
    auto_install: bool = Field(False, alias="autoInstall")
    #: The offered release's platform, or the one asked for when nothing is offered.
    platform: str = "android"
    #: The offer is a rollback to a lower versionCode the device should accept (Windows).
    allow_downgrade: bool = Field(False, alias="allowDowngrade")
    #: The assignment's stage (the device is in it, or it would not be offered); null when
    #: nothing is offered.
    rollout_percent: Optional[int] = Field(None, alias="rolloutPercent")
    #: Auto-install only inside this device-local window; null = any time.
    install_window: Optional[InstallWindow] = Field(None, alias="installWindow")


class AppUpdateStatusIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    release_id: uuid.UUID = Field(..., alias="releaseId")
    status: AppUpdateStatus
    version_name: Optional[str] = Field(None, alias="versionName")
    message: Optional[str] = None

    @field_validator("version_name", "message", mode="before")
    @classmethod
    def _clip(cls, value, info):
        # Clipped to the column rather than refused: an installer's error can be long,
        # and a status report the till cannot get through is worse than a clipped one.
        if value is None:
            return None
        limit = 64 if info.field_name == "version_name" else 500
        return str(value)[:limit] or None


class AppUpdateStatusOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    release_id: uuid.UUID = Field(..., alias="releaseId")
    status: str
    updated_at: Optional[datetime] = Field(None, alias="updatedAt")
