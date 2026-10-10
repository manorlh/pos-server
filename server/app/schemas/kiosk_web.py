"""`POST /sync/{machine_id}/kiosk-web/status`: the Android kiosk's web renderer, as it reports it."""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: The same set as `KIOSK_WEB_RENDERERS` (app/models/kiosk_web.py).
KioskWebRenderer = Literal["native", "web"]

_INT32_MAX = 2_147_483_647

#: Column widths: a text longer than its column is clipped, not refused (a status the
#: kiosk cannot get through is worse than a clipped one).
_CLIP = {
    "bundle_version": 64,
    "previous_version": 64,
    "pending_version": 64,
    "bundle_source": 16,
    "fallback_reason": 32,
    "message": 500,
}


class KioskWebStatusIn(BaseModel):
    """
    Everything optional but `renderer`. `renderer` / `configured` outside "native" | "web"
    are refused (422); the texts are clipped to their columns; a number out of range is
    taken as unknown (null).
    """

    model_config = ConfigDict(populate_by_name=True)

    #: What the kiosk shows NOW.
    renderer: KioskWebRenderer
    #: What the cloud config asks (`general.renderer`).
    configured: Optional[KioskWebRenderer] = None
    #: The active bundle's versionName; null = none.
    bundle_version: Optional[str] = Field(None, alias="bundleVersion")
    bundle_version_code: Optional[int] = Field(None, alias="bundleVersionCode")
    #: "bundled" (shipped inside the APK) | "downloaded" | null.
    bundle_source: Optional[str] = Field(None, alias="bundleSource")
    #: Kept for rollback.
    previous_version: Optional[str] = Field(None, alias="previousVersion")
    #: Downloaded, waiting for the kiosk to be idle.
    pending_version: Optional[str] = Field(None, alias="pendingVersion")
    #: The bridge API the APK speaks.
    apk_bridge_api: Optional[int] = Field(None, alias="apkBridgeApi")
    #: null, or a short token: ready_timeout | render_gone | js_errors | no_bundle | bridge_api | load_error …
    fallback_reason: Optional[str] = Field(None, alias="fallbackReason")
    message: Optional[str] = None

    @field_validator(*_CLIP, mode="before")
    @classmethod
    def _clip(cls, value, info):
        if value is None:
            return None
        text = str(value).strip()[: _CLIP[info.field_name]]
        return text or None

    @field_validator("bundle_version_code", "apk_bridge_api", mode="before")
    @classmethod
    def _int32(cls, value):
        if value is None or isinstance(value, bool):
            return None
        try:
            number = int(value)
        except (TypeError, ValueError):
            return None
        if isinstance(value, float) and value != number:
            return None
        return number if 0 <= number <= _INT32_MAX else None


class KioskWebStatusOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    ok: bool = True
    updated_at: Optional[datetime] = Field(None, alias="updatedAt")
