"""
Image upload endpoint — uploads product images to Cloudinary.
Returns a secure URL to store in product.image_url.
"""
import logging
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel

import cloudinary
import cloudinary.uploader

from app.config import get_settings
import uuid
from app.middleware.auth import get_current_user, get_active_tenant_id
from app.models.user import User, UserRole

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/images", tags=["images"])

_ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
_MAX_SIZE_BYTES = 5 * 1024 * 1024  # 5 MB


def _init_cloudinary():
    settings = get_settings()
    if not settings.cloudinary_cloud_name:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cloudinary is not configured",
        )
    cloudinary.config(
        cloud_name=settings.cloudinary_cloud_name,
        api_key=settings.cloudinary_api_key,
        api_secret=settings.cloudinary_api_secret,
        secure=True,
    )


class ImageUploadResponse(BaseModel):
    url: str
    public_id: str


@router.post("/upload", response_model=ImageUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_image(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id: uuid.UUID = Depends(get_active_tenant_id),
):
    if current_user.role not in (
        UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR,
        UserRole.MERCHANT_ADMIN, UserRole.COMPANY_MANAGER,
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

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

    _init_cloudinary()

    try:
        result = cloudinary.uploader.upload(
            contents,
            folder=f"pos/{active_tenant_id}/products",
            resource_type="image",
            overwrite=False,
        )
        return ImageUploadResponse(url=result["secure_url"], public_id=result["public_id"])
    except Exception as exc:
        logger.error("Cloudinary upload failed: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Image upload failed")
