"""
Product image uploads via Cloudinary.

Primary flow: GET /upload-params → client signed direct upload to Cloudinary.
Legacy: POST /upload (server-side proxy, deprecated).
Branding: POST /branding (server-side proxy — the size/dimension limits below
have to be enforced somewhere the browser cannot skip, so white-label images do
not use the signed direct-upload path).
"""
import logging
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field

import cloudinary.uploader

from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User, UserRole
from app.services.permission_matrix import Action, Resource, roles_for
from app.services.cloudinary_service import build_upload_params, configure_cloudinary, upload_folder
from app.services.image_validation import ALLOWED_BRANDING_CONTENT_TYPES, read_image_dimensions

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/images", tags=["images"])

_ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
_MAX_SIZE_BYTES = 5 * 1024 * 1024  # 5 MB
_IMAGE_ROLES = roles_for(Resource.IMAGE, Action.WRITE)

BrandingKind = Literal["logo", "hero"]

# Only the roles that may *write* branding settings may upload branding images —
# see BRANDING_WRITE_ROLES in app/routers/settings.py. Kept in sync deliberately:
# an upload a caller could never save is just a way to fill someone's Cloudinary.
_BRANDING_ROLES = roles_for(Resource.BRANDING, Action.WRITE)

# A till is a ~1.9 GB Android device, often on cellular, that fetches these on
# startup. Limits are per kind: a logo is a small mark, a hero is a full screen.
_BRANDING_LIMITS: dict[str, dict[str, int]] = {
    "logo": {
        "max_bytes": 2 * 1024 * 1024,
        "min_width": 64,
        "min_height": 64,
        "max_width": 4000,
        "max_height": 4000,
        # Cloudinary incoming transformation: the *stored* asset is downscaled,
        # so the URL the till downloads is already small.
        "deliver_width": 512,
        "deliver_height": 512,
    },
    "hero": {
        "max_bytes": 5 * 1024 * 1024,
        "min_width": 480,
        "min_height": 320,
        "max_width": 6000,
        "max_height": 6000,
        "deliver_width": 1600,
        "deliver_height": 1600,
    },
}


def _check_image_role(current_user: User) -> None:
    if current_user.role not in _IMAGE_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def _check_branding_role(current_user: User) -> None:
    if current_user.role not in _BRANDING_ROLES:
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
    # Deliberately not "branding": a signed direct upload skips the server, and
    # branding images must pass the size/dimension checks in POST /images/branding.
    resource: Literal["products", "categories"] = Query(
        "products", description="products or categories"
    ),
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


class BrandingUploadResponse(BaseModel):
    """`url` is what goes into the `brandLogoUrl` / `brandHeroUrl` POS setting."""

    url: str
    public_id: str = Field(..., alias="publicId")
    width: int
    height: int
    bytes: int

    class Config:
        populate_by_name = True


@router.post(
    "/branding",
    response_model=BrandingUploadResponse,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def upload_branding_image(
    kind: BrandingKind = Query(..., description="logo (till UI) or hero (startup splash)"),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id: uuid.UUID = Depends(get_active_tenant_id),
):
    """Upload a white-label image and return the absolute URL to store in POS settings.

    Every upload lands on a brand-new Cloudinary public_id (`overwrite=False`,
    `unique_filename=True`), so replacing an image always produces a different
    URL. The till caches by URL and can do so forever without ever showing a
    stale brand — the one failure mode that makes this feature look broken.
    """
    _check_branding_role(current_user)
    limits = _BRANDING_LIMITS[kind]

    if file.content_type not in ALLOWED_BRANDING_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported file type. Allowed: {', '.join(ALLOWED_BRANDING_CONTENT_TYPES)}",
        )

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    if len(contents) > limits["max_bytes"]:
        mb = limits["max_bytes"] // (1024 * 1024)
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds the {mb} MB limit for a {kind} image",
        )

    size = read_image_dimensions(contents)
    if size is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not read image dimensions. Upload a valid PNG, JPEG or WebP.",
        )
    width, height = size
    if width < limits["min_width"] or height < limits["min_height"]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Image is too small ({width}x{height}). Minimum for a {kind} image is "
                f"{limits['min_width']}x{limits['min_height']} px."
            ),
        )
    if width > limits["max_width"] or height > limits["max_height"]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Image is too large ({width}x{height}). Maximum for a {kind} image is "
                f"{limits['max_width']}x{limits['max_height']} px."
            ),
        )

    configure_cloudinary()
    folder = f"{upload_folder(active_tenant_id, 'branding')}/{kind}"

    try:
        result = cloudinary.uploader.upload(
            contents,
            folder=folder,
            resource_type="image",
            # New public_id every time → new URL every time → no stale cache.
            overwrite=False,
            unique_filename=True,
            use_filename=False,
            invalidate=True,
            # Incoming transformation: cap what is actually stored and served, so
            # the till never downloads more than it can put on screen.
            transformation=[
                {
                    "width": limits["deliver_width"],
                    "height": limits["deliver_height"],
                    "crop": "limit",
                    "quality": "auto:good",
                }
            ],
        )
    except Exception as exc:
        logger.error("Cloudinary branding upload failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="Image upload failed"
        ) from exc

    return BrandingUploadResponse(
        url=result["secure_url"],
        public_id=result["public_id"],
        width=int(result.get("width") or width),
        height=int(result.get("height") or height),
        bytes=int(result.get("bytes") or len(contents)),
    )
