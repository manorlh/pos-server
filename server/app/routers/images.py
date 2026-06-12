"""
Product image uploads via Cloudinary.

Primary flow: GET /upload-params → client signed direct upload to Cloudinary.
Legacy: POST /upload (server-side proxy, deprecated).
"""
import logging
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field

import cloudinary.uploader

from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User, UserRole
from app.services.cloudinary_service import ImageResource, build_upload_params, configure_cloudinary

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/images", tags=["images"])

_ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
_MAX_SIZE_BYTES = 5 * 1024 * 1024  # 5 MB
_IMAGE_ROLES = (
    UserRole.SUPER_ADMIN,
    UserRole.DISTRIBUTOR,
    UserRole.MERCHANT_ADMIN,
    UserRole.COMPANY_MANAGER,
)


def _check_image_role(current_user: User) -> None:
    if current_user.role not in _IMAGE_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


class ImageUploadParamsResponse(BaseModel):
    cloud_name: str = Field(..., alias="cloudName")
    api_key: str = Field(..., alias="apiKey")
    timestamp: int
    signature: str
    folder: str

    class Config:
        populate_by_name = True


class ImageUploadResponse(BaseModel):
    url: str
    public_id: str = Field(..., alias="publicId")

    class Config:
        populate_by_name = True


@router.get("/upload-params", response_model=ImageUploadParamsResponse, response_model_by_alias=True)
def get_upload_params(
    resource: ImageResource = Query("products", description="products or categories"),
    current_user: User = Depends(get_current_user),
    active_tenant_id: uuid.UUID = Depends(get_active_tenant_id),
):
    """Return signed Cloudinary upload params for direct browser upload."""
    _check_image_role(current_user)
    params = build_upload_params(active_tenant_id, resource=resource)
    return ImageUploadParamsResponse.model_validate(params.to_response())


@router.post("/upload", response_model=ImageUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_image(
    file: UploadFile = File(...),
    resource: Optional[Literal["products", "categories"]] = Query("products"),
    current_user: User = Depends(get_current_user),
    active_tenant_id: uuid.UUID = Depends(get_active_tenant_id),
):
    """Deprecated: server-side upload proxy. Prefer GET /upload-params + direct Cloudinary upload."""
    _check_image_role(current_user)

    if file.content_type not in _ALLOWED_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported file type. Allowed: {', '.join(_ALLOWED_TYPES)}",
        )

    contents = await file.read()
    if len(contents) > _MAX_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="File exceeds 5 MB limit",
        )

    settings = configure_cloudinary()
    folder = f"pos/{active_tenant_id}/{resource or 'products'}"

    try:
        result = cloudinary.uploader.upload(
            contents,
            folder=folder,
            resource_type="image",
            overwrite=False,
        )
        return ImageUploadResponse(url=result["secure_url"], public_id=result["public_id"])
    except Exception as exc:
        logger.error("Cloudinary upload failed: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Image upload failed") from exc
