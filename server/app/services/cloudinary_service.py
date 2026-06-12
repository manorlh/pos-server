"""Cloudinary signed upload helpers — api_secret stays server-side only."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Literal

import cloudinary
import cloudinary.utils
from fastapi import HTTPException, status

from app.config import Settings, get_settings

ImageResource = Literal["products", "categories"]


@dataclass(frozen=True)
class UploadParams:
    cloud_name: str
    api_key: str
    timestamp: int
    signature: str
    folder: str

    def to_response(self) -> dict:
        return {
            "cloudName": self.cloud_name,
            "apiKey": self.api_key,
            "timestamp": self.timestamp,
            "signature": self.signature,
            "folder": self.folder,
        }


def _settings_or_raise(settings: Settings | None = None) -> Settings:
    s = settings or get_settings()
    if not s.cloudinary_cloud_name or not s.cloudinary_api_key or not s.cloudinary_api_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cloudinary is not configured",
        )
    return s


def configure_cloudinary(settings: Settings | None = None) -> Settings:
    s = _settings_or_raise(settings)
    cloudinary.config(
        cloud_name=s.cloudinary_cloud_name,
        api_key=s.cloudinary_api_key,
        api_secret=s.cloudinary_api_secret,
        secure=True,
    )
    return s


def upload_folder(tenant_id: uuid.UUID, resource: ImageResource = "products") -> str:
    return f"pos/{tenant_id}/{resource}"


def build_upload_params(
    tenant_id: uuid.UUID,
    *,
    resource: ImageResource = "products",
    settings: Settings | None = None,
) -> UploadParams:
    s = configure_cloudinary(settings)
    folder = upload_folder(tenant_id, resource)
    timestamp = int(time.time())
    params_to_sign = {"timestamp": timestamp, "folder": folder}
    signature = cloudinary.utils.api_sign_request(params_to_sign, s.cloudinary_api_secret)
    return UploadParams(
        cloud_name=s.cloudinary_cloud_name,
        api_key=s.cloudinary_api_key,
        timestamp=timestamp,
        signature=signature,
        folder=folder,
    )
