"""
Till app releases from the dashboard ("עדכון קופות").

POST   /app-releases                          → upload an APK (multipart), super admin
GET    /app-releases                          → every release, newest first, super admin
PATCH  /app-releases/{id}                     → notes / retire (isActive), super admin
POST   /app-releases/{id}/assignments         → send it to a tenant/company/shop/area/till
GET    /app-releases/{id}/assignments         → where it was sent, super admin
DELETE /app-release-assignments/{id}          → cancel one assignment, super admin
GET    /app-releases/rollout                  → per till: version, target, last status —
                                                also for the tenant's own machine admins

The tills' side is under `/sync/{machine_id}/app-update` (app/routers/sync.py). Every
change to who gets what tells the tills it reaches (Ably `settings` notify, reason
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
from typing import List, Optional

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
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.schemas.app_release import (
    AppReleaseAssignmentIn,
    AppReleaseAssignmentOut,
    AppReleaseOut,
    AppReleaseUpdate,
    RolloutRow,
)
from app.services import app_updates as AU
from app.services import till_parameters as TP
from app.services.apk_manifest import ApkManifestError, read_apk_version
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
        version_code=release.version_code,
        version_name=release.version_name,
        sha256=release.sha256,
        size_bytes=release.size_bytes,
        notes=release.notes,
        is_active=bool(release.is_active),
        created_at=release.created_at,
        assignment_count=assignment_count,
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


def _refuse_taken_version(db: Session, name: str) -> None:
    if db.query(AppRelease.id).filter(AppRelease.version_name == name).first() is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="app_release_version_taken")


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
):
    """
    Upload one APK. SHA-256 and size are computed here; versionCode / versionName are
    read from the APK's manifest, and the form's values are only needed when that fails
    (`422 apk_version_required`) — given both ways they must agree
    (`422 apk_version_mismatch`). `409 app_release_version_taken`, `413
    app_release_too_large` (`app_release_max_bytes`), `422 invalid_apk` for a non-zip.
    """
    typed_name = _clean_version_name(version_name)
    release_id = uuid.uuid4()
    directory = _releases_dir()
    partial = directory / f"{release_id}.apk.part"
    final = directory / f"{release_id}.apk"
    committed = False
    try:
        sha256, size = _store_upload(file, partial, get_settings().app_release_max_bytes)
        if size == 0 or not zipfile.is_zipfile(partial):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_apk")
        try:
            parsed = read_apk_version(str(partial))
        except ApkManifestError as exc:
            logger.warning("app release %s: manifest not read (%s)", release_id, exc)
            parsed = None
        name, code = _settle_version(typed_name, version_code, parsed)
        _refuse_taken_version(db, name)
        os.replace(partial, final)
        release = AppRelease(
            id=release_id,
            version_code=code,
            version_name=name,
            sha256=sha256,
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
):
    """Every release, newest first, each with its live assignment count."""
    counts = _live_counts(db)
    releases = db.query(AppRelease).order_by(AppRelease.created_at.desc()).all()
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
    return AppReleaseAssignmentOut(
        id=a.id,
        release_id=a.release_id,
        version_name=a.release.version_name if a.release is not None else None,
        level=a.level,
        target_id=a.target_id,
        target_name=label.name if label else None,
        target_context=label.context if label else None,
        tenant_id=a.tenant_id,
        auto_install=bool(a.auto_install),
        created_at=a.created_at,
        cancelled_at=a.cancelled_at,
        machine_count=len(AU.machines_under(db, a.level, a.target_id)) if a.cancelled_at is None else 0,
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
    Send the release to one target. The newest assignment at a level wins there, so
    sending again to the same target replaces what it had. `404 <level>_not_found`,
    `409 app_release_retired`.
    """
    release = _release(db, release_id)
    if not release.is_active:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="app_release_retired")
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
        created_by_user_id=getattr(admin, "id", None),
        created_at=_now(),
    )
    db.add(assignment)
    db.commit()
    db.refresh(assignment)
    background_tasks.add_task(
        AU.publish_update_notify, AU.notify_targets(AU.machines_under(db, assignment.level, assignment.target_id))
    )
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
):
    """
    Per active till: where it stands, what it runs, which release it resolves to now and
    what it last reported about that release. A super admin may name any tenant; anyone
    else sees their own tenant's tills, as far as the machines list shows them.
    """
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
    if not machines:
        return []

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

    out: List[RolloutRow] = []
    for m in machines:
        shop = shops.get(m.shop_id)
        company = companies.get(shop.company_id) if shop is not None else None
        area = areas.get(m.area_id)
        pair = resolved.get(m.id)
        assignment, release = pair if pair is not None else (None, None)
        report = statuses.get((m.id, release.id)) if release is not None else None
        out.append(
            RolloutRow(
                machine_id=m.id,
                machine_name=m.name,
                pos_number=m.pos_number,
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
                up_to_date=bool(release is not None and m.app_version == release.version_name),
                status=report.status if report else None,
                status_message=report.message if report else None,
                status_at=report.updated_at if report else None,
            )
        )
    out.sort(key=lambda r: (r.company_name or "", r.shop_name or "", r.area_name or "", r.machine_name))
    return out
