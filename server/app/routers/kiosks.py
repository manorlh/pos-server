"""
The R2M customer self-order KIOSK ("קיוסק הזמנה עצמית") — app/services/kiosk_control.py,
app/services/kiosk_config.py, app/services/kiosk_pickup.py.

Till (`get_pos_machine_for_sync_path`: the machine token, path machine = token machine):

POST /sync/{machine_id}/kiosk/sync                            every till; a kiosk gets its config,
                                                              state and media, every till the
                                                              kiosks it controls
POST /sync/{machine_id}/kiosk/orders                          paid kiosk orders (upsert by localId)
POST /sync/{machine_id}/kiosk/pickup-number                   the shop's daily pickup sequence
POST /sync/{machine_id}/kiosk/menu                            the kiosk admin's menu, for the shop
POST /sync/{machine_id}/kiosks/{kiosk_machine_id}/commands    a controlling till's pause / resume /
                                                              close_shift / till_z

Dashboard (Clerk; read: super admin, distributor (own tills), company manager (company
tree), shop manager (own shop) — never a cashier or a shift supervisor; write: the same
through `get_current_machine_admin`):

GET    /kiosks                        ?companyId=&shopId= → [KioskSummary]
GET    /kiosks/defaults               defaults, fonts, kdsAvailable, limits
GET    /kiosks/candidates             ?shopId= → tills that could become a kiosk
GET    /kiosks/settings               ?level=company|shop|machine&id=
PUT    /kiosks/settings               ?level=&id=  { overrides }
POST   /kiosks/media                  upload an image / video → {url, kind, bytes, sha256}
POST   /kiosks                        convert a till
PATCH  /kiosks/{machine_id}           name / enabled / controllers
DELETE /kiosks/{machine_id}           back to a regular till
GET    /kiosks/{machine_id}/effective
POST   /kiosks/{machine_id}/commands
GET    /kiosks/{machine_id}/commands  ?limit=
GET    /kiosks/{machine_id}/orders    ?date=
"""
from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import date
from typing import Literal, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.middleware.auth import (
    get_active_tenant_id,
    get_current_machine_admin,
    get_current_user,
    get_pos_machine_for_sync_path,
)
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.schemas.kiosk import (
    KioskCommandIn,
    KioskCreateIn,
    KioskMenuIn,
    KioskOrdersIn,
    KioskPatchIn,
    KioskSettingsIn,
    KioskSyncIn,
    PickupNumberIn,
)
from app.services import kiosk_config as cfgsvc
from app.services import kiosk_control as svc
from app.services import kiosk_menu
from app.services import kiosk_pickup
from app.services import kiosk_z

# Display devices are not tills (app/services/display_devices.py).
from app.middleware.auth import FISCAL_SYNC_PATH

till_router = APIRouter(prefix="/sync", tags=["kiosks"])
router = APIRouter(prefix="/kiosks", tags=["kiosks"])


def _command_answer(db: Session, result: svc.CommandResult, response: Optional[Response]):
    """Commit the audit, then answer: 201 with the command, or the refusal as it was."""
    from app.services.till_z import TillZRefused

    db.commit()
    error = result.error
    if isinstance(error, HTTPException):
        raise error
    if isinstance(error, (TillZRefused, svc.KioskCommandRefused)):
        return JSONResponse(status_code=error.status_code, content=error.body)
    if response is not None:
        response.status_code = status.HTTP_201_CREATED
    return svc.command_out(result.command)


# ── The till ─────────────────────────────────────────────────────────────────


@till_router.post("/{machine_id}/kiosk/sync")
def kiosk_sync(
    machine_id: str,
    body: Optional[KioskSyncIn] = None,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    Every till polls it (a kiosk every ~15 s, other tills every ~2 min). A kiosk reports its
    status and gets its effective config, version, font, media and pause state; every till
    gets the kiosks it may control (`controls`). A non-kiosk gets `kiosk: false`.
    """
    out = svc.kiosk_sync(db, machine, body.status if body is not None else None)
    db.commit()
    return out


@till_router.post("/{machine_id}/kiosk/orders", dependencies=FISCAL_SYNC_PATH)
def post_kiosk_orders(
    machine_id: str,
    body: KioskOrdersIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """Paid kiosk orders. Upsert by (machine, localId); the snapshot never changes. 403 `not_a_kiosk`."""
    svc.require_kiosk_device(db, machine)
    try:
        out = svc.upsert_orders(db, machine, body.orders)
        db.commit()
    except IntegrityError:
        # The same order posted twice at once: the other request inserted it; again as an update.
        db.rollback()
        out = svc.upsert_orders(db, machine, body.orders)
        db.commit()
    return out


@till_router.post("/{machine_id}/kiosk/pickup-number", dependencies=FISCAL_SYNC_PATH)
def post_pickup_number(
    machine_id: str,
    body: PickupNumberIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """The shop's daily pickup number for this order key (idempotent). 403 `not_a_kiosk`."""
    svc.require_kiosk_device(db, machine)
    if machine.shop_id is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="machine_not_assigned")
    pickup = cfgsvc.effective_config(db, machine)["pickup"]

    def allocate():
        return kiosk_pickup.allocate(
            db,
            shop_id=machine.shop_id,
            business_date=body.business_date,
            order_key=body.order_key,
            start=pickup["start"],
            max_number=pickup["max"],
            prefix=pickup["prefix"],
            machine_id=machine.id,
        )

    try:
        result = allocate()
        db.commit()
    except IntegrityError:
        db.rollback()
        result = allocate()
        db.commit()
    return {"number": result.number, "label": result.label}


@till_router.post("/{machine_id}/kiosk/menu")
def put_kiosk_menu(
    machine_id: str,
    body: KioskMenuIn,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    "עריכת תפריט הקיוסק": the kiosk's menu (order, hidden, featured) for every kiosk of its
    shop, approved by a shop manager's PIN on the kiosk. 403 `not_a_kiosk` /
    `kiosk_control_requires_manager`; 409 `kiosk_menu_changed` {menuVersion}; 422.
    """
    device = svc.require_kiosk_device(db, machine)
    try:
        out = kiosk_menu.save_from_kiosk(
            db, machine, device, approver_id=body.approver_id, base_version=body.base_version, menu=body.menu,
        )
    except kiosk_menu.MenuRefused as refused:
        db.rollback()
        return JSONResponse(status_code=refused.status_code, content=refused.body)
    db.commit()
    kiosk_menu.wake_kiosks(machine.tenant_id, out["kiosks"])
    return out


@till_router.get("/{machine_id}/kiosks/{kiosk_machine_id}/orders")
def get_till_kiosk_orders(
    machine_id: str,
    kiosk_machine_id: str,
    days: int = Query(1, ge=1, le=7),
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    "היסטוריית עסקאות" of a kiosk on its controlling till (P:/specs/kiosk-landscape-till-mode.md §5.12): today and
    the days before it (at most a week), newest first, the phone masked. 403 `not_kiosk_controller` unless
    this till is one of the kiosk's controllers; 404 `kiosk_not_found`. The reprints go as kiosk commands.
    """
    kiosk_machine, _device = svc.controller_target(db, machine, kiosk_machine_id)
    return svc.till_order_history(db, kiosk_machine, days)


@till_router.post("/{machine_id}/kiosks/{kiosk_machine_id}/commands", status_code=status.HTTP_201_CREATED, dependencies=FISCAL_SYNC_PATH)
def post_till_kiosk_command(
    machine_id: str,
    kiosk_machine_id: str,
    body: KioskCommandIn,
    response: Response,
    machine: POSMachine = Depends(get_pos_machine_for_sync_path),
    db: Session = Depends(get_db),
):
    """
    A controlling till's command to a kiosk. 403 `not_kiosk_controller` unless this till is
    in the kiosk's controllers; 404 `kiosk_not_found`. close_shift / till_z go through the
    existing channels and their refusals pass through.
    """
    kiosk_machine, device = svc.controller_target(db, machine, kiosk_machine_id)
    if body.action in ("pause", "resume", "schedule"):
        # "נעילה למכירה" / "פתיחה אוטומטית" from a till: a manager's approval (docs/SPEC_KIOSK.md §15).
        try:
            manager = svc.require_till_manager(db, machine, body.pos_user_id)
        except svc.KioskCommandRefused as refused:
            return JSONResponse(status_code=refused.status_code, content=refused.body)
        name = " ".join(p for p in (manager.first_name or "", manager.last_name or "") if p).strip() or manager.username
        actor = svc.till_actor(machine, kiosk_machine, name)
    elif kiosk_z.requires_manager(kiosk_machine, body.action):
        # "הפקת Z" for a kiosk with its own Z, from a till: a manager's approval too (kiosk_z.py).
        try:
            manager = kiosk_z.require_manager_for_z(db, machine, body.pos_user_id)
        except svc.KioskCommandRefused as refused:
            return JSONResponse(status_code=refused.status_code, content=refused.body)
        name = " ".join(p for p in (manager.first_name or "", manager.last_name or "") if p).strip() or manager.username
        actor = svc.till_actor(machine, kiosk_machine, name)
    else:
        actor = svc.till_actor(machine, kiosk_machine, body.pos_user_name)
    result = svc.run_command(
        db,
        kiosk_machine=kiosk_machine,
        device=device,
        action=body.action,
        message=body.message,
        force=body.force,
        source="till",
        actor=actor,
        requested_by_machine_id=machine.id,
        requested_by_name=actor.username,
        until_mode=body.until_mode,
        until_time=body.until_time,
        minutes=body.minutes,
        schedule=body.schedule,
    )
    return _command_answer(db, result, response)


# ── The dashboard: list, defaults, candidates, settings (before /{machine_id}) ─


@router.get("")
def list_kiosks(
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return svc.list_kiosks(db, current_user, active_tenant_id, company_id=company_id, shop_id=shop_id)


@router.get("/defaults")
def get_defaults(current_user: User = Depends(get_current_user)):
    svc.require_kiosk_role(current_user)
    return {
        "defaults": cfgsvc.default_config(),
        "fonts": cfgsvc.fonts_wire(),
        "kdsAvailable": cfgsvc.kds_available(),
        "limits": cfgsvc.limits(),
    }


@router.get("/candidates")
def get_candidates(
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return svc.candidates(db, current_user, active_tenant_id, shop_id=shop_id)


@router.get("/settings")
def get_settings(
    level: Literal["company", "shop", "machine"] = Query(...),
    scope_id: uuid.UUID = Query(..., alias="id"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    scope = svc.settings_scope(db, current_user, level, scope_id, active_tenant_id)
    return svc.settings_view(db, scope)


@router.put("/settings")
def put_settings(
    body: KioskSettingsIn,
    level: Literal["company", "shop", "machine"] = Query(...),
    scope_id: uuid.UUID = Query(..., alias="id"),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Replace this level's partial layer. 422 `{"detail": {"code": "invalid_kiosk_config",
    "errors": [{path, code, message}]}}`, validated on the parents ⊕ this layer.
    """
    scope = svc.settings_scope(db, current_user, level, scope_id, active_tenant_id)
    # "עריכת תפריט הקיוסק": the shop's menu changed on a kiosk since the dashboard loaded it.
    if scope.level == "shop" and body.menu_version is not None:
        stored = kiosk_menu.shop_layer(db, scope.shop_id)
        if kiosk_menu.menu_of(cfgsvc.validate_layer(body.overrides)[0]) != kiosk_menu.menu_of(stored):
            try:
                kiosk_menu.check_version(db, scope.shop_id, body.menu_version)
            except kiosk_menu.MenuRefused as refused:
                return JSONResponse(status_code=refused.status_code, content=refused.body)
    try:
        try:
            svc.save_settings(db, current_user, scope, body.overrides)
            db.commit()
        except IntegrityError:
            # Two first saves of one level at once: the other created the row; update it.
            db.rollback()
            svc.save_settings(db, current_user, scope, body.overrides)
            db.commit()
    except cfgsvc.KioskConfigInvalid as invalid:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=invalid.detail())
    return svc.settings_view(db, scope)


@router.post("/media", status_code=status.HTTP_201_CREATED)
async def upload_kiosk_media(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id: uuid.UUID = Depends(get_active_tenant_id),
):
    """
    Upload a kiosk image (PNG/JPEG/WebP) or video (MP4/WebM), up to 25 MB — the same types
    and limit as `POST /images/media`, which only a super admin or distributor may use; here
    any kiosk write role may. Stored the same way (Cloudinary when configured, else the
    server's media store) under the tenant's `kiosk` folder.

    Answers `{url, kind, bytes, sha256}` for the dashboard's MediaRef. `sha256` is over the
    bytes actually stored when they are known here — the stored file read back (local), the
    uploaded bytes (a video) — and null for a Cloudinary image, which Cloudinary re-encodes.
    """
    import cloudinary.uploader

    from app.routers.images import MEDIA_MAX_BYTES, MEDIA_VIDEO_TYPES
    from app.services import cloudinary_service, local_media
    from app.services.image_validation import ALLOWED_BRANDING_CONTENT_TYPES, read_image_dimensions

    svc.require_kiosk_role(current_user)
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

    folder = cloudinary_service.upload_folder(active_tenant_id, "kiosk")
    sha256: Optional[str] = hashlib.sha256(contents).hexdigest() if is_video else None
    size = len(contents)
    try:
        if cloudinary_service.cloudinary_configured():
            cloudinary_service.configure_cloudinary()
            result = await run_in_threadpool(
                cloudinary.uploader.upload,
                contents,
                folder=folder,
                resource_type="video" if is_video else "image",
                overwrite=False,
                unique_filename=True,
                use_filename=False,
            )
            url = result["secure_url"]
            if not is_video:
                size = int(result.get("bytes") or size)
        elif is_video:
            ext = {"video/mp4": "mp4", "video/webm": "webm"}[ctype]
            url = await run_in_threadpool(local_media.store_raw, contents, folder, ext)
        else:
            result = await run_in_threadpool(local_media.store, contents, folder, limit=(1920, 1920))
            url = result["secure_url"]
            # The store re-encodes: the checksum is of the file the kiosk will download.
            stored = local_media.MEDIA_DIR / url.split(f"{local_media.MEDIA_PREFIX}/", 1)[1]
            data = stored.read_bytes()
            sha256, size = hashlib.sha256(data).hexdigest(), len(data)
    except Exception as exc:  # noqa: BLE001 - the storage's own errors are not the caller's
        logging.getLogger(__name__).error("Kiosk media upload failed: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Upload failed") from exc
    return {"url": url, "kind": "video" if is_video else "image", "bytes": size, "sha256": sha256}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_kiosk(
    body: KioskCreateIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Convert a till into a self-order kiosk. 409 `already_kiosk`, 409 `machine_not_assigned`."""
    machine = db.get(POSMachine, body.machine_id)
    if machine is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
    svc.check_machine_scope(db, current_user, machine, active_tenant_id)
    device = svc.convert(
        db, current_user, machine,
        name=body.name, controller_ids=body.controller_machine_ids, lock_device=body.lock_device,
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="already_kiosk")
    if body.lock_device:
        svc.notify_device_lock(machine)
    return svc.summary(db, device)


# ── The dashboard: one kiosk ─────────────────────────────────────────────────


@router.patch("/{machine_id}")
def patch_kiosk(
    machine_id: uuid.UUID,
    body: KioskPatchIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Name, enabled, controllers (422 `invalid_controller:<id>`)."""
    machine, device = svc.kiosk_for_dashboard(db, current_user, machine_id, active_tenant_id)
    svc.update(
        db, machine, device,
        name=body.name, enabled=body.enabled, controller_ids=body.controller_machine_ids,
    )
    db.commit()
    return svc.summary(db, device)


@router.delete("/{machine_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_kiosk(
    machine_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Back to a regular till; its orders and the command audit stay."""
    _machine, device = svc.kiosk_for_dashboard(db, current_user, machine_id, active_tenant_id)
    svc.remove(db, device)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{machine_id}/effective")
def get_effective(
    machine_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """What this kiosk gets: `{configVersion, config, font, media}`."""
    machine, _device = svc.kiosk_for_dashboard(db, current_user, machine_id, active_tenant_id)
    return cfgsvc.effective_bundle(db, machine)


#: Who may send which kiosk command (the route admits `kiosks` or `device_control`): remote control
#: ("שליטה מרחוק") pauses and resumes only; a Z, closing a shift, the schedule and the bon desk stay
#: with the kiosks section (a Z also with the Z section), as before remote control existed.
KIOSK_ACTION_SECTIONS = {
    "pause": ("kiosks", "device_control"),
    "resume": ("kiosks", "device_control"),
    "till_z": ("kiosks", "z"),
    "close_shift": ("kiosks", "z"),
    "schedule": ("kiosks",),
    "bon_print": ("kiosks",),
    "bon_handled": ("kiosks",),
    # "מצב עבודה: קיוסק / קופה" — the business's own choice of the day, as the pause (kiosk_till_mode.py).
    "enter_till": ("kiosks", "device_control"),
    "return_kiosk": ("kiosks", "device_control"),
    "reprint_bon": ("kiosks",),
    "reprint_receipt": ("kiosks",),
}


def check_kiosk_action(db: Session, user, action: str) -> None:
    """A user admitted through remote control alone gets its actions only (app/services/dashboard_access.py)."""
    from app.services import dashboard_access as DA
    from app.services import dashboard_sections as DS

    access = DA.effective_access(db, user)
    sections = KIOSK_ACTION_SECTIONS.get(action, ("kiosks",))
    if any(access.allows(section, DS.EDIT) for section in sections):
        return
    # Admitted through remote control only: never past its own actions. (Neither section: the route's
    # own check — the kiosks section — answers, as before remote control existed.)
    if access.allows("device_control", DS.EDIT):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "section_forbidden", "section": sections[0], "level": DS.EDIT},
        )


@router.post("/{machine_id}/commands", status_code=status.HTTP_201_CREATED)
def post_kiosk_command(
    machine_id: uuid.UUID,
    body: KioskCommandIn,
    response: Response,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """pause / resume (applied at once), close_shift / till_z (the existing channels; refusals pass through)."""
    check_kiosk_action(db, current_user, body.action)
    # A manager of points of sale: one of their kiosks only (app/routers/kiosk_live.py).
    from app.routers.kiosk_live import _kiosk_checked

    if body.action == "return_kiosk" and svc.get_device(db, machine_id) is None:
        # "מצב עבודה" of a till (P:/specs/kiosk-landscape-till-mode.md §5.10): its first kiosk mode asked from the
        # dashboard makes its kiosk-mode row — a till in this user's scope, its owner's gate open; else as before.
        from app.services import kiosk_till_mode

        target = db.get(POSMachine, machine_id)
        if target is not None:
            svc.check_machine_scope(db, current_user, target, active_tenant_id)
            if kiosk_till_mode.ensure_home_till_row(db, target) is None:
                return JSONResponse(
                    status_code=status.HTTP_409_CONFLICT,
                    content={"detail": "till_mode_disabled", "message": "מצב קיוסק אינו מופעל לקופה הזו"},
                )

    machine, device = _kiosk_checked(db, current_user, machine_id, active_tenant_id)
    result = svc.run_command(
        db,
        kiosk_machine=machine,
        device=device,
        action=body.action,
        message=body.message,
        force=body.force,
        source="dashboard",
        actor=current_user,
        requested_by_user_id=current_user.id,
        requested_by_name=svc.user_name(current_user),
        until_mode=body.until_mode,
        until_time=body.until_time,
        minutes=body.minutes,
        schedule=body.schedule,
    )
    return _command_answer(db, result, response)


class TillModeGateIn(BaseModel):
    """`kioskTillModeEnabled` at the kiosk's own level: on, off, or null — back to what it inherits."""

    enabled: Optional[bool] = None


@router.put("/{machine_id}/till-mode")
def put_kiosk_till_mode_gate(
    machine_id: uuid.UUID,
    body: TillModeGateIn,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "קיוסק — מצב קופה" for this kiosk (app/services/kiosk_till_mode.py): the owner's gate, a super
    admin or a distributor only (403 `till_parameter_admin_only`). Recorded in the parameters' log;
    the kiosk hears it on its next parameters pull (notified at once).
    """
    from app.services import kiosk_till_mode

    machine, device = svc.kiosk_for_dashboard(db, current_user, machine_id, active_tenant_id)
    kiosk_till_mode.set_gate(db, machine, body.enabled, current_user)
    db.commit()
    svc.notify_device_lock(machine)
    return svc.summary(db, device)


@router.get("/{machine_id}/commands")
def get_kiosk_commands(
    machine_id: uuid.UUID,
    limit: int = Query(20, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    machine, _device = svc.kiosk_for_dashboard(db, current_user, machine_id, active_tenant_id)
    out = svc.list_commands(db, machine.id, limit=limit)
    # Commands whose request ended since were settled on the way (kiosk_z.settle_commands).
    db.commit()
    return out


@router.get("/{machine_id}/orders")
def get_kiosk_orders(
    machine_id: uuid.UUID,
    day: Optional[date] = Query(None, alias="date"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The kiosk's orders of a business date (default today); the phone masked but for a super admin / company manager."""
    machine, _device = svc.kiosk_for_dashboard(db, current_user, machine_id, active_tenant_id)
    return svc.list_orders(db, current_user, machine, day)
