"""
Deleting old release files from the dashboard ("עדכוני גרסה" → "מחיקת קובץ" / "ניקוי גרסאות
ישנות") — super admin only. The release row stays; its stored file goes
(app/services/app_release_files.py has the rules).

GET    /app-releases/{id}/file-delete-check[?retire=]  → may its file be deleted, and how many
                                                         devices still run that version
DELETE /app-releases/{id}/file[?retire=true]           → delete it (retire in the same confirm)
GET    /app-releases/file-cleanup[?keep=3&platform=]   → the bulk preview: per platform what is
                                                         kept, deleted (with the size freed), skipped
POST   /app-releases/file-cleanup                      → run it: {keep, platform?, releaseIds,
                                                         confirm: "מחק"}
"""
from __future__ import annotations

import uuid
from typing import Annotated, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_super_admin
from app.models.app_release import AppRelease
from app.models.user import User
from app.routers.app_releases import _out, _platform_or_422, _release
from app.schemas.app_release import AppReleaseOut
from app.services import app_release_files as F

router = APIRouter(tags=["app-releases"])


class FileDeleteCheckOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    release_id: uuid.UUID = Field(..., alias="releaseId")
    allowed: bool
    #: Why not: app_release_has_assignments | app_release_latest | app_release_not_retired.
    reasons: List[str] = []
    #: Active — deleting retires it in the same confirm.
    needs_retire: bool = Field(..., alias="needsRetire")
    #: Active devices that last reported running this version (a warning, never a block).
    devices_on_version: int = Field(..., alias="devicesOnVersion")
    already_deleted: bool = Field(..., alias="alreadyDeleted")
    size_bytes: int = Field(..., alias="sizeBytes")
    version_name: str = Field(..., alias="versionName")
    platform: str


class FileDeleteOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    release: AppReleaseOut
    #: "deleted" | "already_missing" | null (it had been deleted before).
    storage_result: Optional[str] = Field(None, alias="storageResult")
    retired: bool
    devices_on_version: int = Field(..., alias="devicesOnVersion")
    freed_bytes: int = Field(..., alias="freedBytes")


class CleanupRow(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    release_id: uuid.UUID = Field(..., alias="releaseId")
    version_name: str = Field(..., alias="versionName")
    version_code: int = Field(..., alias="versionCode")
    size_bytes: int = Field(..., alias="sizeBytes")
    is_active: bool = Field(..., alias="isActive")
    devices_on_version: int = Field(0, alias="devicesOnVersion")
    reasons: List[str] = []


class CleanupPlatformOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    platform: str
    kept: List[CleanupRow]
    delete: List[CleanupRow]
    skipped: List[CleanupRow]
    total_bytes: int = Field(..., alias="totalBytes")


class CleanupPreviewOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    keep: int
    confirm_word: str = Field(F.CLEANUP_CONFIRM_WORD, alias="confirmWord")
    platforms: List[CleanupPlatformOut]
    total_bytes: int = Field(..., alias="totalBytes")
    total_count: int = Field(..., alias="totalCount")


class CleanupIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    keep: Optional[int] = None
    platform: Optional[str] = None
    #: The ids the preview listed; only those still allowed by the plan now are deleted.
    release_ids: List[uuid.UUID] = Field(..., alias="releaseIds")
    confirm: str


class CleanupFailure(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    release_id: uuid.UUID = Field(..., alias="releaseId")
    version_name: Optional[str] = Field(None, alias="versionName")
    reason: str


class CleanupOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    deleted: List[AppReleaseOut]
    #: Asked for, but no longer in the plan (or its storage delete failed).
    failed: List[CleanupFailure]
    freed_bytes: int = Field(..., alias="freedBytes")


def _check_out(v: F.FileDeleteCheck) -> FileDeleteCheckOut:
    r = v.release
    return FileDeleteCheckOut(
        release_id=r.id,
        allowed=v.allowed,
        reasons=v.reasons,
        needs_retire=v.needs_retire,
        devices_on_version=v.devices_on_version,
        already_deleted=v.already_deleted,
        size_bytes=r.size_bytes or 0,
        version_name=r.version_name,
        platform=F.AU.release_platform(r),
    )


def _row(release: AppRelease, verdict: Optional[F.FileDeleteCheck] = None) -> CleanupRow:
    return CleanupRow(
        release_id=release.id,
        version_name=release.version_name,
        version_code=release.version_code,
        size_bytes=release.size_bytes or 0,
        is_active=bool(release.is_active),
        devices_on_version=verdict.devices_on_version if verdict else 0,
        reasons=verdict.reasons if verdict else [],
    )


def _keep_or_422(keep: Optional[int]) -> int:
    try:
        return F.clamp_keep(keep)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="keep_invalid")


def _platform_filter(platform: Optional[str]) -> Optional[str]:
    return _platform_or_422(platform) if platform is not None and platform.strip() else None


def _refusal(reason: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=reason)


def _storage_failed() -> HTTPException:
    return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="app_release_file_delete_failed")


# ── One release ──────────────────────────────────────────────────────────────


@router.get(
    "/app-releases/{release_id}/file-delete-check",
    response_model=FileDeleteCheckOut,
    response_model_by_alias=True,
)
def check_app_release_file_delete(
    release_id: uuid.UUID,
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
    retire: Annotated[bool, Query()] = True,
):
    """What deleting this release's file would do: allowed or why not, whether it retires the
    release too, and how many devices still report running that version."""
    return _check_out(F.check(db, _release(db, release_id), retire=retire))


@router.delete(
    "/app-releases/{release_id}/file",
    response_model=FileDeleteOut,
    response_model_by_alias=True,
)
def delete_app_release_file(
    release_id: uuid.UUID,
    admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
    retire: Annotated[bool, Query()] = False,
):
    """
    Delete the release's stored file; the row stays, marked `fileDeletedAt`. Idempotent: a
    file already deleted answers 200 with `storageResult` null. `retire=true` retires an
    active release in the same confirm.

    `409 app_release_has_assignments` (cancel its live assignments first), `409
    app_release_latest` (the newest active release of its platform), `409
    app_release_not_retired` (active, `retire` not given), `502 app_release_file_delete_failed`
    (storage refused — nothing changed).
    """
    release = _release(db, release_id)
    verdict = F.check(db, release, retire=retire)
    if not verdict.already_deleted and not verdict.allowed:
        raise _refusal(verdict.reasons[0])
    try:
        result = F.delete_file(db, release, getattr(admin, "id", None), retire=retire, verdict=verdict)
    except F.StorageDeleteError:
        raise _storage_failed()
    return FileDeleteOut(
        release=_out(result.release, 0),
        storage_result=result.storage_result,
        retired=result.retired,
        devices_on_version=result.devices_on_version,
        freed_bytes=(result.release.size_bytes or 0) if result.deleted_now else 0,
    )


# ── Bulk cleanup ─────────────────────────────────────────────────────────────


@router.get(
    "/app-releases/file-cleanup",
    response_model=CleanupPreviewOut,
    response_model_by_alias=True,
)
def preview_app_release_file_cleanup(
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
    keep: Annotated[Optional[int], Query()] = None,
    platform: Annotated[Optional[str], Query()] = None,
):
    """
    "ניקוי גרסאות ישנות" preview: per platform, the newest `keep` (default 3, 1..50; `422
    keep_invalid`) releases that still have their file are kept, every older one is listed for
    deletion (active ones are retired with it) or skipped with its reasons. Nothing changes.
    """
    keep = _keep_or_422(keep)
    plans = F.cleanup_plan(db, keep, _platform_filter(platform))
    out = [
        CleanupPlatformOut(
            platform=p.platform,
            kept=[_row(r) for r in p.kept],
            delete=[_row(v.release, v) for v in p.candidates],
            skipped=[_row(v.release, v) for v in p.skipped],
            total_bytes=p.bytes,
        )
        for p in plans
    ]
    return CleanupPreviewOut(
        keep=keep,
        platforms=out,
        total_bytes=sum(p.total_bytes for p in out),
        total_count=sum(len(p.delete) for p in out),
    )


@router.post(
    "/app-releases/file-cleanup",
    response_model=CleanupOut,
    response_model_by_alias=True,
)
def run_app_release_file_cleanup(
    body: CleanupIn,
    admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """
    Run the cleanup: `confirm` must be "מחק" (`422 cleanup_confirm_required`). The plan is
    computed again; of `releaseIds` only those it still lists for deletion are deleted (one
    audit row each) — the rest come back in `failed` with the reason (`not_in_plan`, a guard's
    code, or `app_release_file_delete_failed`). One failure never stops the others.
    """
    if (body.confirm or "").strip() != F.CLEANUP_CONFIRM_WORD:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="cleanup_confirm_required")
    keep = _keep_or_422(body.keep)
    plans = F.cleanup_plan(db, keep, _platform_filter(body.platform))
    allowed = {v.release.id: v for p in plans for v in p.candidates}
    skipped = {v.release.id: v for p in plans for v in p.skipped}
    user_id = getattr(admin, "id", None)
    deleted: List[AppReleaseOut] = []
    failed: List[CleanupFailure] = []
    freed = 0
    for rid in dict.fromkeys(body.release_ids):  # each once, in the order sent
        verdict = allowed.get(rid)
        if verdict is None:
            other = skipped.get(rid)
            failed.append(
                CleanupFailure(
                    release_id=rid,
                    version_name=other.release.version_name if other else None,
                    reason=other.reasons[0] if other and other.reasons else "not_in_plan",
                )
            )
            continue
        release = verdict.release
        try:
            result = F.delete_file(db, release, user_id, retire=True, mode="cleanup", verdict=verdict)
        except F.StorageDeleteError:
            failed.append(
                CleanupFailure(
                    release_id=rid, version_name=release.version_name, reason="app_release_file_delete_failed"
                )
            )
            continue
        if result.deleted_now:
            freed += result.release.size_bytes or 0
        deleted.append(_out(result.release, 0))
    return CleanupOut(deleted=deleted, failed=failed, freed_bytes=freed)
