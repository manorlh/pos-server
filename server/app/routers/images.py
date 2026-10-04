"""
Product image uploads via Cloudinary.

Products: POST /upload (server-side proxy) — the server cuts the background out
(app/services/product_image_processing.py) before storing, so it has to see the
bytes. The untouched upload is kept next to it as `<public_id>_orig`.
Categories: GET /upload-params → client signed direct upload to Cloudinary
(POST /upload also still accepts them, stored as uploaded).
Branding: POST /branding (server-side proxy — the size/dimension limits below
have to be enforced somewhere the browser cannot skip, so white-label images do
not use the signed direct-upload path). Never background-removed.
"""
import logging
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

import cloudinary.uploader

from app.config import get_settings
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.user import User, UserRole
from app.services.permission_matrix import Action, Resource, roles_for
from app.services.cloudinary_service import build_upload_params, cloudinary_configured, configure_cloudinary, upload_folder
from app.services import local_media
from app.services.image_validation import ALLOWED_BRANDING_CONTENT_TYPES, read_image_dimensions
from app.services.product_image_processing import process_product_image

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/images", tags=["images"])

_ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
_MAX_SIZE_BYTES = 5 * 1024 * 1024  # 5 MB
_IMAGE_ROLES = roles_for(Resource.IMAGE, Action.WRITE)

BrandingKind = Literal["logo", "hero", "receipt"]

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
    # Printed at the head of every receipt. The head is 384 dots wide (58 mm paper), so
    # anything wider is only bytes the till downloads and then throws away; and a tall
    # logo costs paper on every sale, so it is capped square.
    "receipt": {
        "max_bytes": 2 * 1024 * 1024,
        "min_width": 64,
        "min_height": 32,
        "max_width": 4000,
        "max_height": 4000,
        "deliver_width": 384,
        "deliver_height": 384,
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
    # Set only when the background was removed: the image as uploaded, so a bad
    # cut can be reverted by saving this URL on the product instead.
    original_url: Optional[str] = Field(None, alias="originalUrl")
    background_removed: bool = Field(False, alias="backgroundRemoved")

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


@router.post(
    "/upload",
    response_model=ImageUploadResponse,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def upload_image(
    file: UploadFile = File(...),
    resource: Optional[Literal["products", "categories"]] = Query("products"),
    keep_background: bool = Query(False, alias="keepBackground"),
    current_user: User = Depends(get_current_user),
    active_tenant_id: uuid.UUID = Depends(get_active_tenant_id),
):
    """Server-side upload. Product images get their background removed and are
    stored as a trimmed transparent PNG, unless `?keepBackground=true` or
    PRODUCT_IMAGE_BG_REMOVAL is off. Categories are stored as uploaded."""
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

    use_cloudinary = cloudinary_configured()
    if use_cloudinary:
        configure_cloudinary()
    resource = resource or "products"
    folder = upload_folder(active_tenant_id, resource)

    processed = None
    if (
        resource == "products"
        and get_settings().product_image_bg_removal
        and not keep_background
    ):
        # Seconds of CPU on a model — never on the event loop.
        processed = await run_in_threadpool(process_product_image, contents)

    try:
        if processed is None:
            if use_cloudinary:
                result = await run_in_threadpool(
                    cloudinary.uploader.upload,
                    contents,
                    folder=folder,
                    resource_type="image",
                    overwrite=False,
                )
            else:
                result = await run_in_threadpool(local_media.store, contents, folder)
            return ImageUploadResponse(url=result["secure_url"], public_id=result["public_id"])

        if use_cloudinary:
            result = await run_in_threadpool(
                cloudinary.uploader.upload,
                processed.png,
                folder=folder,
                resource_type="image",
                format="png",
                overwrite=False,
            )
        else:
            result = await run_in_threadpool(local_media.store, processed.png, folder, fmt="png")
    except Exception as exc:
        logger.error("Cloudinary upload failed: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Image upload failed") from exc

    # Keep the upload as it came in, next to the cut-out, so a bad cut can be undone.
    # Best effort: the cut-out is already stored and is what the caller asked for.
    original_url = None
    try:
        if use_cloudinary:
            original = await run_in_threadpool(
                cloudinary.uploader.upload,
                contents,
                public_id=f"{result['public_id']}_orig",
                resource_type="image",
                overwrite=False,
            )
        else:
            original = await run_in_threadpool(
                local_media.store, contents, folder, public_id=f"{result['public_id']}_orig",
            )
        original_url = original.get("secure_url")
    except Exception as exc:
        logger.warning("Keeping the original of %s failed: %s", result["public_id"], exc)

    return ImageUploadResponse(
        url=result["secure_url"],
        public_id=result["public_id"],
        original_url=original_url,
        background_removed=True,
    )


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
    kind: BrandingKind = Query(
        ..., description="logo (till UI), hero (startup splash) or receipt (printed on receipts)"
    ),
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

    use_cloudinary = cloudinary_configured()
    if use_cloudinary:
        configure_cloudinary()
    folder = f"{upload_folder(active_tenant_id, 'branding')}/{kind}"

    try:
        if not use_cloudinary:
            # No Cloudinary here: the server's own media store, capped the same way.
            result = local_media.store(
                contents, folder, limit=(limits["deliver_width"], limits["deliver_height"]),
            )
        else:
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


#: The screensaver ("שומר מסך"): an image, or a short muted video. A till downloads it
#: once and plays it from disk, so the cap is what a till on cellular can take.
MEDIA_MAX_BYTES = 25 * 1024 * 1024
MEDIA_VIDEO_TYPES = ("video/mp4", "video/webm")


class MediaUploadResponse(BaseModel):
    url: str
    kind: str  # "image" | "video"
    bytes: int


@router.post("/media", response_model=MediaUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_media(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id: uuid.UUID = Depends(get_active_tenant_id),
):
    """
    Upload an image or a short video (MP4/WebM, up to 25 MB) for the till's screensaver,
    and return its URL to store in the till parameter. Every upload gets a new URL.

    Also the branding hero's video ("תמונת פתיחה" on the dashboard's branding page): its
    URL is saved into the `brandHeroUrl` setting exactly like an image's.
    """
    _check_branding_role(current_user)
    ctype = (file.content_type or "").lower()
    is_video = ctype in MEDIA_VIDEO_TYPES
    if not is_video and ctype not in ALLOWED_BRANDING_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Upload a PNG, JPEG or WebP image, or an MP4/WebM video.",
        )
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    if len(contents) > MEDIA_MAX_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="File exceeds 25 MB")
    if not is_video and read_image_dimensions(contents) is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Not a readable image")

    folder = f"{upload_folder(active_tenant_id, 'branding')}/screensaver"
    try:
        if cloudinary_configured():
            configure_cloudinary()
            result = cloudinary.uploader.upload(
                contents,
                folder=folder,
                resource_type="video" if is_video else "image",
                overwrite=False,
                unique_filename=True,
                use_filename=False,
            )
            url = result["secure_url"]
        else:
            ext = {"video/mp4": "mp4", "video/webm": "webm"}.get(ctype)
            if is_video:
                url = await run_in_threadpool(local_media.store_raw, contents, folder, ext)
            else:
                url = (await run_in_threadpool(local_media.store, contents, folder, limit=(1920, 1920)))["secure_url"]
    except Exception as exc:
        logger.error("Media upload failed: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Upload failed") from exc
    return MediaUploadResponse(url=url, kind="video" if is_video else "image", bytes=len(contents))
