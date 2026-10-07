"""
App releases from the dashboard ("עדכוני גרסה" — Android tills and the Windows app).

POST   /app-releases                          → upload an APK or a Windows installer
                                                (multipart, `platform`), super admin
GET    /app-releases[?platform=]              → every release, newest first, super admin
PATCH  /app-releases/{id}                     → notes / retire (isActive), super admin
POST   /app-releases/{id}/assignments         → send it to a tenant/company/shop/area/device
                                                (rollout %, rollback, install window)
GET    /app-releases/{id}/assignments         → where it was sent, super admin
PATCH  /app-release-assignments/{id}          → rollout % / autoInstall / install window
DELETE /app-release-assignments/{id}          → cancel one assignment, super admin
GET    /app-releases/rollout[?platform=]      → per device: version, target, last status —
                                                also for the tenant's own machine admins

The devices' side is under `/sync/{machine_id}/app-update` (app/routers/sync.py). Every
change to who gets what tells the devices it reaches (Ably `settings` notify, reason
`app_update_assigned`) after the commit; they then sync and ask for their update.
"""
from __future__ import annotations

import hashlib
import logging
import os
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Annotated, List, Optional

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Response,
    UploadFile,
    status,
)
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.middleware.auth import (
    get_active_tenant_id,
    get_current_machine_admin,
    get_current_super_admin,
)
from app.models.app_release import AppRelease, AppReleaseAssignment, AppReleaseMachineStatus
from app.models.kiosk_web import KioskWebDeviceStatus
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.schemas.app_release import (
    AppReleaseAssignmentIn,
    AppReleaseAssignmentOut,
    AppReleaseAssignmentPatch,
    AppReleaseOut,
    AppReleaseUpdate,
    InstallWindow,
    InstallWindowIn,
    RolloutRow,
)
from app.services import app_updates as AU
from app.services import device_profile
from app.services import till_parameters as TP
from app.services.apk_manifest import ApkManifestError, read_apk_version
from app.services.kiosk_web_bundle import BundleError, read_bundle
from app.services import device_management as DM
from app.services.apk_signing import signing_cert_sha256_or_none
from app.services.company_hierarchy import visible_shop_ids
from app.services.permission_matrix import SHOP_SCOPED_ROLES

logger = logging.getLogger(__name__)
router = APIRouter(tags=["app-releases"])

VERSION_NAME_MAX = 64
_CHUNK = 1024 * 1024


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _release(db: Session, release_id: uuid.UUID) -> AppRelease:
    release = db.query(AppRelease).filter(AppRelease.id == release_id).first()
    if release is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App release not found")
    return release


def _live_counts(db: Session) -> dict:
    return dict(
        db.query(AppReleaseAssignment.release_id, func.count(AppReleaseAssignment.id))
        .filter(AppReleaseAssignment.cancelled_at.is_(None))
        .group_by(AppReleaseAssignment.release_id)
        .all()
    )


def _out(release: AppRelease, assignment_count: int = 0) -> AppReleaseOut:
    return AppReleaseOut(
        id=release.id,
        platform=AU.release_platform(release),
        version_code=release.version_code,
        version_name=release.version_name,
        sha256=release.sha256,
        size_bytes=release.size_bytes,
        notes=release.notes,
        is_active=bool(release.is_active),
        created_at=release.created_at,
        assignment_count=assignment_count,
        signing_cert_sha256=getattr(release, "signing_cert_sha256", None),
        bridge_api=getattr(release, "bridge_api", None),
    )


def _releases_dir() -> Path:
    path = Path(get_settings().app_releases_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _remove(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def _store_upload(upload: UploadFile, target: Path, limit: int):
    """Copy the upload to `target`, hashing as it goes. `(sha256 hex, size)`; 413 past `limit`."""
    digest = hashlib.sha256()
    size = 0
    with open(target, "wb") as out:
        while True:
            chunk = upload.file.read(_CHUNK)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="app_release_too_large"
                )
            digest.update(chunk)
            out.write(chunk)
    return digest.hexdigest(), size


def _clean_version_name(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    if len(value) > VERSION_NAME_MAX:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"versionName is at most {VERSION_NAME_MAX} characters",
        )
    return value


def _settle_version(typed_name, typed_code, parsed):
    """
    The release's version: what the APK says, checked against what the uploader typed.

    Either may be missing — the manifest reader can fail on an APK it does not
    understand, and the form fields are optional when it does not. Both present and
    different is refused: the file is not the build the uploader thinks it is.
    """
    parsed_name = parsed.version_name if parsed else None
    parsed_code = parsed.version_code if parsed else None
    if parsed_name and typed_name and parsed_name != typed_name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "apk_version_mismatch", "msg": f"The APK's versionName is {parsed_name}"},
        )
    if parsed_code is not None and typed_code is not None and parsed_code != typed_code:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "apk_version_mismatch", "msg": f"The APK's versionCode is {parsed_code}"},
        )
    name = parsed_name or typed_name
    code = parsed_code if parsed_code is not None else typed_code
    if not name or code is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "apk_version_required",
                "msg": "The APK's version could not be read; enter versionName and versionCode",
            },
        )
    if code < 1:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="versionCode must be positive")
    if len(name) > VERSION_NAME_MAX:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"versionName is at most {VERSION_NAME_MAX} characters",
        )
    return name, code


def _refuse_taken_version(db: Session, name: str, platform: str = AU.PLATFORM_ANDROID) -> None:
    """`409 app_release_version_taken` — only within the platform (both may have a 0.2.0)."""
    taken = (
        db.query(AppRelease.id)
        .filter(AppRelease.version_name == name, AppRelease.platform == platform)
        .first()
    )
    if taken is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="app_release_version_taken")


def _platform_or_422(value: Optional[str]) -> str:
    try:
        return AU.normalize_platform(value)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_platform")


def _settle_windows_version(typed_name: Optional[str], typed_code: Optional[int], filename: Optional[str]):
    """
    A Windows installer's version: the typed versionName, else the one in the file name
    (`R2M-Kiosk-0.2.0-setup.exe`), else `422 windows_version_required`. The versionCode is
    always computed from it (`AU.windows_version_code`, the app's own rule); a typed one
    that disagrees is `422 version_code_mismatch`, a name that is not "a.b.c" `422
    windows_version_invalid`.
    """
    name = typed_name or AU.version_from_installer_name(filename)
    if not name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "windows_version_required",
                "msg": "Enter versionName (a.b.c), or upload the file under its built name (…-a.b.c-setup.exe)",
            },
        )
    try:
        code = AU.windows_version_code(name)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "windows_version_invalid", "msg": f"{name}: {exc}"},
        )
    if typed_code is not None and typed_code != code:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "version_code_mismatch", "msg": f"versionCode of {name} is {code}"},
        )
    return name, code


def _starts_with_mz(path: Path) -> bool:
    with open(path, "rb") as f:
        return f.read(2) == b"MZ"


def _invalid_bundle(msg: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "invalid_bundle", "msg": msg}
    )


def _settle_bundle(path: Path, size: int, typed_name: Optional[str], typed_code: Optional[int]):
    """
    A kiosk web bundle's `(versionName, versionCode, bridgeApi)`: its manifest's, the zip
    checked against it (app/services/kiosk_web_bundle.py) — `422 invalid_bundle` with what
    is wrong. A typed versionName / versionCode that disagrees with the manifest is `422
    bundle_version_mismatch`.
    """
    if size == 0 or not zipfile.is_zipfile(path):
        raise _invalid_bundle("not a zip")
    try:
        manifest = read_bundle(str(path))
    except BundleError as exc:
        raise _invalid_bundle(str(exc))
    if typed_name and typed_name != manifest.version:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "bundle_version_mismatch", "msg": f"The bundle's version is {manifest.version}"},
        )
    if typed_code is not None and typed_code != manifest.version_code:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "bundle_version_mismatch", "msg": f"The bundle's versionCode is {manifest.version_code}"},
        )
    return manifest.version, manifest.version_code, manifest.bridge_api


# ── Releases ─────────────────────────────────────────────────────────────────


@router.post(
    "/app-releases",
    response_model=AppReleaseOut,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
def upload_app_release(
    file: UploadFile = File(...),
    version_name: Optional[str] = Form(None, alias="versionName"),
    version_code: Optional[int] = Form(None, alias="versionCode"),
    notes: Optional[str] = Form(None),
    admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
    # Annotated, so a direct call (the tests) that leaves it out gets a plain None.
    platform: Annotated[Optional[str], Form()] = None,
):
    """
    Upload one release; form field `platform` "android" (default), "windows" or "kiosk_web"
    (`422 invalid_platform` otherwise). SHA-256 and size are computed here.

    * Android — an APK: versionCode / versionName are read from its manifest, and the
      form's values are only needed when that fails (`422 apk_version_required`) — given
      both ways they must agree (`422 apk_version_mismatch`). `422 invalid_apk` for a
      non-zip. Stored as `{id}.apk`.
    * Windows — the NSIS installer: it must start with "MZ" (`422 invalid_installer`).
      versionName is the form's, else the file name's (`R2M-Kiosk-0.2.0-setup.exe`), else
      `422 windows_version_required`; versionCode is computed from it (a·10⁶ + b·10³ + c),
      a typed one that disagrees is `422 version_code_mismatch`. Stored as `{id}.exe`.
    * Kiosk web (`platform` "kiosk_web") — a zip of the kiosk's screens with `manifest.json`
      at its root: versionName / versionCode / bridgeApi come from the manifest, every file
      is checked against it (`422 {"code": "invalid_bundle", "msg": …}` for anything wrong);
      a typed version that disagrees is `422 bundle_version_mismatch`. Stored as `{id}.zip`.

    `409 app_release_version_taken` (within the platform), `413 app_release_too_large`
    (`app_release_max_bytes`).
    """
    platform = _platform_or_422(platform)
    typed_name = _clean_version_name(version_name)
    release_id = uuid.uuid4()
    directory = _releases_dir()
    ext = {AU.PLATFORM_WINDOWS: "exe", AU.PLATFORM_KIOSK_WEB: "zip"}.get(platform, "apk")
    partial = directory / f"{release_id}.{ext}.part"
    final = directory / f"{release_id}.{ext}"
    committed = False
    bridge_api = None
    try:
        sha256, size = _store_upload(file, partial, get_settings().app_release_max_bytes)
        if platform == AU.PLATFORM_KIOSK_WEB:
            name, code, bridge_api = _settle_bundle(partial, size, typed_name, version_code)
        elif platform == AU.PLATFORM_WINDOWS:
            if size == 0 or not _starts_with_mz(partial):
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_installer")
            name, code = _settle_windows_version(typed_name, version_code, getattr(file, "filename", None))
        else:
            if size == 0 or not zipfile.is_zipfile(partial):
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_apk")
            try:
                parsed = read_apk_version(str(partial))
            except ApkManifestError as exc:
                logger.warning("app release %s: manifest not read (%s)", release_id, exc)
                parsed = None
            name, code = _settle_version(typed_name, version_code, parsed)
        # The signing certificate's SHA-256 (the provisioning QR's checksum): best effort.
        cert_sha256 = signing_cert_sha256_or_none(str(partial)) if platform == AU.PLATFORM_ANDROID else None
        _refuse_taken_version(db, name, platform)
        os.replace(partial, final)
        release = AppRelease(
            id=release_id,
            platform=platform,
            version_code=code,
            version_name=name,
            sha256=sha256,
            signing_cert_sha256=cert_sha256,
            bridge_api=bridge_api,
            size_bytes=size,
            file_path=str(final),
            notes=(notes or "").strip() or None,
            uploaded_by_user_id=getattr(admin, "id", None),
            is_active=True,
            created_at=_now(),
        )
        db.add(release)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="app_release_version_taken")
        committed = True
    finally:
        # Nothing is left on disk for an upload that did not become a release.
        _remove(partial)
        if not committed:
            _remove(final)
    db.refresh(release)
    return _out(release)


@router.get(
    "/app-releases",
    response_model=List[AppReleaseOut],
    response_model_by_alias=True,
)
def list_app_releases(
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
    platform: Annotated[Optional[str], Query()] = None,
):
    """Every release (of `platform` when given), newest first, each with its live assignment count."""
    counts = _live_counts(db)
    query = db.query(AppRelease)
    if platform is not None and platform.strip():
        query = query.filter(AppRelease.platform == _platform_or_422(platform))
    releases = query.order_by(AppRelease.created_at.desc()).all()
    return [_out(r, counts.get(r.id, 0)) for r in releases]


@router.patch(
    "/app-releases/{release_id}",
    response_model=AppReleaseOut,
    response_model_by_alias=True,
)
def update_app_release(
    release_id: uuid.UUID,
    body: AppReleaseUpdate,
    background_tasks: BackgroundTasks,
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """
    Notes, and retiring (`isActive: false`) or reinstating. A retired release is offered
    to no till, so the tills it was assigned to fall back to what else applies to them.
    """
    release = _release(db, release_id)
    sent = body.model_fields_set
    retire_changed = "is_active" in sent and body.is_active is not None and body.is_active != release.is_active
    if "notes" in sent:
        release.notes = body.notes
    if "is_active" in sent and body.is_active is not None:
        release.is_active = body.is_active
    db.commit()
    db.refresh(release)
    if retire_changed:
        background_tasks.add_task(AU.publish_update_notify, _targets_of_release(db, release.id))
    return _out(release, _live_counts(db).get(release.id, 0))


def _targets_of_release(db: Session, release_id) -> List[AU.NotifyTarget]:
    machines = {}
    for a in (
        db.query(AppReleaseAssignment)
        .filter(AppReleaseAssignment.release_id == release_id, AppReleaseAssignment.cancelled_at.is_(None))
        .all()
    ):
        for m in AU.machines_under(db, a.level, a.target_id):
            machines[m.id] = m
    return AU.notify_targets(machines.values())


# ── Assignments ──────────────────────────────────────────────────────────────


def _labels(db: Session, assignments) -> dict:
    """`(level, id)` → `ScopeLabel`, reusing the till parameters' namer for the four
    entity levels; tenants are named here."""
    labels = TP.scope_labels(
        db,
        [
            SimpleNamespace(scope_type=a.level, scope_id=a.target_id)
            for a in assignments
            if a.level != "tenant"
        ],
    )
    tenant_ids = {a.target_id for a in assignments if a.level == "tenant"}
    if tenant_ids:
        for t in db.query(Tenant).filter(Tenant.id.in_(list(tenant_ids))).all():
            labels[("tenant", TP.as_uuid(t.id))] = TP.ScopeLabel(name=t.name)
    return labels


def _assignment_out(db: Session, a: AppReleaseAssignment, labels: dict) -> AppReleaseAssignmentOut:
    label = labels.get((a.level, TP.as_uuid(a.target_id)))
    platform = AU.release_platform(a.release) if a.release is not None else AU.PLATFORM_ANDROID
    window = AU.install_window_of(a)
    return AppReleaseAssignmentOut(
        id=a.id,
        release_id=a.release_id,
        version_name=a.release.version_name if a.release is not None else None,
        platform=platform,
        level=a.level,
        target_id=a.target_id,
        target_name=label.name if label else None,
        target_context=label.context if label else None,
        tenant_id=a.tenant_id,
        auto_install=bool(a.auto_install),
        rollout_percent=a.rollout_percent if a.rollout_percent is not None else 100,
        allow_downgrade=bool(a.allow_downgrade),
        install_window=InstallWindow(**window) if window else None,
        created_at=a.created_at,
        cancelled_at=a.cancelled_at,
        machine_count=(
            len(AU.machines_under(db, a.level, a.target_id, platform=platform)) if a.cancelled_at is None else 0
        ),
    )


def _rollout_percent_or_422(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 100:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="rollout_percent_invalid")
    return value


def _install_window_or_422(window: Optional[InstallWindowIn]):
    try:
        return AU.clean_install_window(window.start if window else None, window.end if window else None)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="install_window_invalid")


def _notify_assignment(background_tasks: BackgroundTasks, db: Session, assignment: AppReleaseAssignment) -> None:
    # Every device under the target, of either platform: a sync it did not need is harmless,
    # and a device whose platform the server reads wrong still hears of it.
    background_tasks.add_task(
        AU.publish_update_notify, AU.notify_targets(AU.machines_under(db, assignment.level, assignment.target_id))
    )


@router.post(
    "/app-releases/{release_id}/assignments",
    response_model=AppReleaseAssignmentOut,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
def create_app_release_assignment(
    release_id: uuid.UUID,
    body: AppReleaseAssignmentIn,
    background_tasks: BackgroundTasks,
    admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """
    Send the release to one target — it reaches only the devices of the release's
    platform. The newest assignment at a level wins there, so sending again to the same
    target replaces what it had. `404 <level>_not_found`, `409 app_release_retired`.

    * `rolloutPercent` (1..100, default 100; `422 rollout_percent_invalid`) — staged
      rollout: only that share of the target's devices (a fixed hash per device) takes
      it; the rest resolve on as if it were not there (an older shop-level release keeps
      them). Raising it later (PATCH) keeps the devices already in.
    * `allowDowngrade` — rollback: a Windows device (or a kiosk running a newer web bundle)
      with a higher versionCode is offered this lower one (never the version it already runs). `422
      downgrade_not_supported_on_android` for an APK: Android cannot install a lower
      versionCode without uninstalling the app, which wipes the till's local data — an
      Android rollback is the old code rebuilt with a higher versionCode, uploaded and
      sent as a new release.
    * `installWindow` {start, end} "HH:MM" device-local, both or neither (`422
      install_window_invalid`) — an auto-install runs only inside it (may cross
      midnight). The Windows app honours it; the Android till ignores it today.
    """
    release = _release(db, release_id)
    if not release.is_active:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="app_release_retired")
    rollout_percent = _rollout_percent_or_422(body.rollout_percent)
    window_start, window_end = _install_window_or_422(body.install_window)
    if body.allow_downgrade and AU.release_platform(release) not in AU.DOWNGRADE_PLATFORMS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="downgrade_not_supported_on_android"
        )
    target = AU.target_entity(db, body.level, body.target_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{body.level}_not_found")
    tenant_id = AU.target_tenant_id(body.level, target)
    if tenant_id is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="target_has_no_tenant")
    assignment = AppReleaseAssignment(
        id=uuid.uuid4(),
        release_id=release.id,
        level=body.level,
        target_id=body.target_id,
        tenant_id=tenant_id,
        auto_install=body.auto_install,
        rollout_percent=rollout_percent,
        allow_downgrade=bool(body.allow_downgrade),
        install_window_start=window_start,
        install_window_end=window_end,
        created_by_user_id=getattr(admin, "id", None),
        created_at=_now(),
    )
    db.add(assignment)
    db.commit()
    db.refresh(assignment)
    _notify_assignment(background_tasks, db, assignment)
    return _assignment_out(db, assignment, _labels(db, [assignment]))


@router.get(
    "/app-releases/{release_id}/assignments",
    response_model=List[AppReleaseAssignmentOut],
    response_model_by_alias=True,
)
def list_app_release_assignments(
    release_id: uuid.UUID,
    include_cancelled: bool = Query(False, alias="includeCancelled"),
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """Where the release was sent, newest first; live ones only unless asked."""
    release = _release(db, release_id)
    query = db.query(AppReleaseAssignment).filter(AppReleaseAssignment.release_id == release.id)
    if not include_cancelled:
        query = query.filter(AppReleaseAssignment.cancelled_at.is_(None))
    rows = query.order_by(AppReleaseAssignment.created_at.desc()).all()
    labels = _labels(db, rows)
    return [_assignment_out(db, a, labels) for a in rows]


@router.patch(
    "/app-release-assignments/{assignment_id}",
    response_model=AppReleaseAssignmentOut,
    response_model_by_alias=True,
)
def update_app_release_assignment(
    assignment_id: uuid.UUID,
    body: AppReleaseAssignmentPatch,
    background_tasks: BackgroundTasks,
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """
    Change a live assignment in place: `rolloutPercent` (widen or narrow the stage —
    raising it keeps every device already in), `autoInstall`, `installWindow` (null
    clears it). The same refusals as sending (`422 rollout_percent_invalid`, `422
    install_window_invalid`); `404` for an unknown assignment, `409
    app_release_assignment_cancelled` for a withdrawn one. Tells the devices it reaches.
    """
    assignment = (
        db.query(AppReleaseAssignment).filter(AppReleaseAssignment.id == assignment_id).first()
    )
    if assignment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Assignment not found")
    if assignment.cancelled_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="app_release_assignment_cancelled")
    sent = body.model_fields_set
    if "rollout_percent" in sent and body.rollout_percent is not None:
        assignment.rollout_percent = _rollout_percent_or_422(body.rollout_percent)
    if "auto_install" in sent and body.auto_install is not None:
        assignment.auto_install = bool(body.auto_install)
    if "install_window" in sent:
        assignment.install_window_start, assignment.install_window_end = _install_window_or_422(body.install_window)
    db.commit()
    db.refresh(assignment)
    _notify_assignment(background_tasks, db, assignment)
    return _assignment_out(db, assignment, _labels(db, [assignment]))


@router.delete("/app-release-assignments/{assignment_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_app_release_assignment(
    assignment_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    _admin: User = Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """
    Withdraw one assignment (idempotent). Its tills fall back to what else applies to
    them; one that already installed the release keeps it — nothing is rolled back.
    """
    assignment = (
        db.query(AppReleaseAssignment).filter(AppReleaseAssignment.id == assignment_id).first()
    )
    if assignment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Assignment not found")
    if assignment.cancelled_at is None:
        assignment.cancelled_at = _now()
        db.commit()
        background_tasks.add_task(
            AU.publish_update_notify,
            AU.notify_targets(AU.machines_under(db, assignment.level, assignment.target_id)),
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Rollout ──────────────────────────────────────────────────────────────────


def _rollout_machines(db: Session, user: User, tenant_id):
    """
    A query for the active tills of `tenant_id` this user may see — the machines list's
    own rule — or None for a role that sees none.
    """
    query = db.query(POSMachine).filter(
        POSMachine.is_active.is_(True), POSMachine.tenant_id == tenant_id
    )
    if user.role == UserRole.SUPER_ADMIN:
        pass
    elif user.role == UserRole.DISTRIBUTOR:
        query = query.filter(POSMachine.distributor_id == user.id)
    elif user.role == UserRole.COMPANY_MANAGER:
        query = query.filter(POSMachine.shop_id.in_(visible_shop_ids(db, user)))
    elif user.role in SHOP_SCOPED_ROLES:
        query = query.filter(POSMachine.shop_id == user.shop_id)
    else:
        return None
    return query


def _rollout_order(row: RolloutRow):
    return (row.company_name or "", row.shop_name or "", row.area_name or "", row.machine_name)


def _kiosk_web_rollout_rows(db: Session, machines) -> List[RolloutRow]:
    """
    One "kiosk_web" row per kiosk web device (`AU.kiosk_web_machines`): resolved among the
    kiosk web releases; `currentVersion` is the active bundle the kiosk last reported
    (`kiosk_web_device_status.bundle_version`, not its APK), and up-to-date / behind /
    behindNewest are measured against it; plus what it shows now, what its config asks,
    why it fell back and the bundle waiting for it to be idle.
    """
    if not machines:
        return []
    ids = [m.id for m in machines]
    shop_ids = {m.shop_id for m in machines if m.shop_id is not None}
    shops = {s.id: s for s in db.query(Shop).filter(Shop.id.in_(list(shop_ids))).all()} if shop_ids else {}
    company_ids = {s.company_id for s in shops.values() if s.company_id is not None}
    companies = (
        {c.id: c for c in db.query(Company).filter(Company.id.in_(list(company_ids))).all()}
        if company_ids
        else {}
    )
    area_ids = {m.area_id for m in machines if m.area_id is not None}
    areas = (
        {a.id: a for a in db.query(ShopArea).filter(ShopArea.id.in_(list(area_ids))).all()}
        if area_ids
        else {}
    )
    resolved = AU.resolved_for_machines(db, machines, platform=AU.PLATFORM_KIOSK_WEB)
    release_ids = {pair[1].id for pair in resolved.values() if pair is not None}
    statuses = {}
    if release_ids:
        for row in (
            db.query(AppReleaseMachineStatus)
            .filter(
                AppReleaseMachineStatus.machine_id.in_(ids),
                AppReleaseMachineStatus.release_id.in_(list(release_ids)),
            )
            .all()
        ):
            statuses[(row.machine_id, row.release_id)] = row
    web = {
        row.machine_id: row
        for row in db.query(KioskWebDeviceStatus).filter(KioskWebDeviceStatus.machine_id.in_(ids)).all()
    }
    latest = AU.newest_releases(db).get(AU.PLATFORM_KIOSK_WEB)

    out: List[RolloutRow] = []
    for m in machines:
        shop = shops.get(m.shop_id)
        company = companies.get(shop.company_id) if shop is not None else None
        area = areas.get(m.area_id)
        pair = resolved.get(m.id)
        assignment, release = pair if pair is not None else (None, None)
        report = statuses.get((m.id, release.id)) if release is not None else None
        ws = web.get(m.id)
        current = ws.bundle_version if ws is not None else None
        up_to_date = bool(release is not None and current == release.version_name)
        out.append(
            RolloutRow(
                machine_id=m.id,
                machine_name=m.name,
                pos_number=m.pos_number,
                platform=AU.PLATFORM_KIOSK_WEB,
                device_role=device_profile.effective_role(db, m),
                company_id=company.id if company else None,
                company_name=company.name if company else None,
                shop_id=shop.id if shop else None,
                shop_name=shop.name if shop else None,
                area_id=area.id if area else None,
                area_name=area.name if area else None,
                current_version=current,
                last_heartbeat_at=m.last_heartbeat_at,
                release_id=release.id if release else None,
                target_version=release.version_name if release else None,
                target_version_code=release.version_code if release else None,
                assignment_id=assignment.id if assignment else None,
                assignment_level=assignment.level if assignment else None,
                auto_install=bool(assignment.auto_install) if assignment else None,
                up_to_date=up_to_date,
                behind=release is not None and not up_to_date,
                newest_version=latest.version_name if latest else None,
                newest_version_code=latest.version_code if latest else None,
                behind_newest=latest is not None and current != latest.version_name,
                status=report.status if report else None,
                status_message=report.message if report else None,
                status_at=report.updated_at if report else None,
                renderer=ws.renderer if ws is not None else None,
                renderer_configured=ws.configured if ws is not None else None,
                fallback_reason=ws.fallback_reason if ws is not None else None,
                pending_version=ws.pending_version if ws is not None else None,
                bundle_source=ws.bundle_source if ws is not None else None,
                web_status_at=ws.updated_at if ws is not None else None,
                web_status_message=ws.message if ws is not None else None,
            )
        )
    return out


@router.get(
    "/app-releases/rollout",
    response_model=List[RolloutRow],
    response_model_by_alias=True,
)
def get_app_release_rollout(
    tenant_id: Optional[uuid.UUID] = Query(None, alias="tenantId"),
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
    platform: Annotated[Optional[str], Query()] = None,
):
    """
    Per active device (of `platform` when given): where it stands, its platform and role,
    what it runs, which release of its platform it resolves to now (rollout stage
    applied), what it last reported about that release, whether it is `behind` that
    target, and the platform's newest release (`behindNewest`). A super admin may name
    any tenant; anyone else sees their own tenant's devices, as far as the machines list
    shows them.
    """
    only_platform = _platform_or_422(platform) if platform is not None and platform.strip() else None
    scope_tenant = active_tenant_id
    if tenant_id is not None and tenant_id != active_tenant_id:
        if current_user.role != UserRole.SUPER_ADMIN:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant_forbidden")
        scope_tenant = tenant_id

    query = _rollout_machines(db, current_user, scope_tenant)
    if query is None:
        return []
    if shop_id is not None:
        query = query.filter(POSMachine.shop_id == shop_id)
    if company_id is not None:
        query = query.filter(
            POSMachine.shop_id.in_(db.query(Shop.id).filter(Shop.company_id == company_id))
        )
    machines = query.all()
    # Kiosk web bundles: each kiosk web device gets a "kiosk_web" row of its own — alone with
    # ?platform=kiosk_web, one extra row beside its Android row in the "all" view.
    web_rows = (
        _kiosk_web_rollout_rows(db, AU.kiosk_web_machines(db, machines))
        if only_platform in (None, AU.PLATFORM_KIOSK_WEB)
        else []
    )
    if only_platform is not None:
        machines = [m for m in machines if AU.machine_platform(m) == only_platform]
    if not machines:
        return sorted(web_rows, key=_rollout_order)

    shop_ids = {m.shop_id for m in machines if m.shop_id is not None}
    shops = {s.id: s for s in db.query(Shop).filter(Shop.id.in_(list(shop_ids))).all()} if shop_ids else {}
    company_ids = {s.company_id for s in shops.values() if s.company_id is not None}
    companies = (
        {c.id: c for c in db.query(Company).filter(Company.id.in_(list(company_ids))).all()}
        if company_ids
        else {}
    )
    area_ids = {m.area_id for m in machines if m.area_id is not None}
    areas = (
        {a.id: a for a in db.query(ShopArea).filter(ShopArea.id.in_(list(area_ids))).all()}
        if area_ids
        else {}
    )
    resolved = AU.resolved_for_machines(db, machines)
    release_ids = {pair[1].id for pair in resolved.values() if pair is not None}
    statuses = {}
    if release_ids:
        for row in (
            db.query(AppReleaseMachineStatus)
            .filter(
                AppReleaseMachineStatus.machine_id.in_([m.id for m in machines]),
                AppReleaseMachineStatus.release_id.in_(list(release_ids)),
            )
            .all()
        ):
            statuses[(row.machine_id, row.release_id)] = row
    newest = AU.newest_releases(db)

    out: List[RolloutRow] = []
    for m in machines:
        shop = shops.get(m.shop_id)
        company = companies.get(shop.company_id) if shop is not None else None
        area = areas.get(m.area_id)
        pair = resolved.get(m.id)
        assignment, release = pair if pair is not None else (None, None)
        report = statuses.get((m.id, release.id)) if release is not None else None
        platform_of = AU.machine_platform(m)
        latest = newest.get(platform_of)
        up_to_date = bool(release is not None and m.app_version == release.version_name)
        out.append(
            RolloutRow(
                machine_id=m.id,
                machine_name=m.name,
                pos_number=m.pos_number,
                platform=platform_of,
                device_role=device_profile.effective_role(db, m),
                company_id=company.id if company else None,
                company_name=company.name if company else None,
                shop_id=shop.id if shop else None,
                shop_name=shop.name if shop else None,
                area_id=area.id if area else None,
                area_name=area.name if area else None,
                current_version=m.app_version,
                last_heartbeat_at=m.last_heartbeat_at,
                release_id=release.id if release else None,
                target_version=release.version_name if release else None,
                target_version_code=release.version_code if release else None,
                assignment_id=assignment.id if assignment else None,
                assignment_level=assignment.level if assignment else None,
                auto_install=bool(assignment.auto_install) if assignment else None,
                up_to_date=up_to_date,
                behind=release is not None and not up_to_date,
                newest_version=latest.version_name if latest else None,
                newest_version_code=latest.version_code if latest else None,
                behind_newest=latest is not None and m.app_version != latest.version_name,
                status=report.status if report else None,
                status_message=report.message if report else None,
                status_at=report.updated_at if report else None,
                # "עדכון שקט" — device owner / silent path, as the device last said.
                **DM.rollout_fields(m),
            )
        )
    out.extend(web_rows)  # after the device's own row: the sort is stable
    out.sort(key=lambda r: (r.company_name or "", r.shop_name or "", r.area_name or "", r.machine_name))
    return out

