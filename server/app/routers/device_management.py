"""
"עדכון שקט" — device owner provisioning and the cloud reboot (docs/SPEC_UPDATES.md §5,
app/services/device_management.py).

POST   /device-management/provisioning-qr         → the Android Enterprise QR for a factory-reset
                                                     device of a shop (or of one till), machine admins
GET    /device-management/provisioning/apk/{token} → the APK, by the QR's short-lived signed token —
                                                     no auth header: a device in setup has none
POST   /machines/{id}/reboot                      → "הפעל מחדש" for a device-owner till
DELETE /machines/{id}/reboot                      → withdraw it while it waits
POST   /sync/{id}/reboot/ack                      → the till: deferred / rebooting / refused

The device's status itself rides on the heartbeat (`deviceManagement`), and the request reaches
the till on the heartbeat too (`pendingReboot`).
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.middleware.auth import (
    ensure_same_tenant,
    get_active_tenant_id,
    get_current_machine_admin,
    get_pos_machine_from_sync_machine_token,
)
from app.models.app_release import AppRelease
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User
from app.services import app_updates as AU
from app.services import device_management as DM
from app.services.apk_signing import ApkSigningError, provisioning_checksum, signing_certificate

logger = logging.getLogger(__name__)
router = APIRouter(tags=["device-management"])


# ── QR provisioning ──────────────────────────────────────────────────────────


class ProvisioningQrIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The shop the new device will serve; or `machineId` (the till's own assignment then counts).
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    machine_id: Optional[uuid.UUID] = Field(None, alias="machineId")
    #: How long the APK link inside the QR works (1..72 h, default 24).
    valid_hours: Optional[int] = Field(None, alias="validHours")
    #: Android 7–9 may otherwise insist on encrypting the device first (slow on a till).
    skip_encryption: bool = Field(False, alias="skipEncryption")


def _shop_for(db: Session, body: ProvisioningQrIn, user: User, tenant_id):
    from app.routers.machines import check_shift_admin_access
    from app.routers.shops import _check_shop_access

    machine = None
    if body.machine_id is not None:
        machine = db.query(POSMachine).filter(POSMachine.id == body.machine_id).first()
        if machine is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Machine not found")
        check_shift_admin_access(db, machine, user, tenant_id)
        if machine.shop_id is None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="machine_has_no_shop")
    shop_id = machine.shop_id if machine is not None else body.shop_id
    if shop_id is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="shop_required")
    shop = db.query(Shop).filter(Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="shop_not_found")
    ensure_same_tenant(shop.tenant_id, tenant_id)
    _check_shop_access(user, shop, db)
    return shop, machine


def provisioning_release(db: Session, shop: Shop, machine: Optional[POSMachine] = None):
    """
    `(release, source)`: the Android release assigned to the till (its own chain) or to the shop,
    its company or tenant — "assigned" — else the newest active Android release — "newest".
    A staged (under 100%) assignment counts only for a till it covers; for a shop it does not.
    """
    if machine is not None:
        resolved = AU.resolved_for_machine(db, machine, platform=AU.PLATFORM_ANDROID)
    else:
        chain = AU.MachineChain(machine_id=None, shop_id=shop.id, company_id=shop.company_id, tenant_id=shop.tenant_id)
        resolved = AU.resolve_assignment(AU._rows_on_chains(db, [chain]), chain, platform=AU.PLATFORM_ANDROID)
    if resolved is not None:
        return resolved[1], "assigned"
    newest = AU.newest_releases(db).get(AU.PLATFORM_ANDROID)
    return newest, ("newest" if newest is not None else None)


@router.post("/device-management/provisioning-qr")
def create_provisioning_qr(
    body: ProvisioningQrIn,
    request: Request,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    The QR a factory-reset Android device (7+) scans on its welcome screen (six taps) to install
    the till app as its device owner. `payload` is the JSON to encode (`payloadJson` compact);
    Wi-Fi is added in the browser. `409 no_android_release` with nothing to install, `409
    apk_signature_unreadable` when the release's signing certificate cannot be read. `warnings`:
    "localhost" / "http" (the device cannot fetch the APK from there), "debug_key" (the APK is
    signed with a build PC's debug key — never provision with it), "not_assigned" (the newest
    release, not one assigned to this shop).
    """
    shop, machine = _shop_for(db, body, current_user, active_tenant_id)
    release, source = provisioning_release(db, shop, machine)
    if release is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="no_android_release")
    if not os.path.isfile(release.file_path):
        logger.error("provisioning: release %s file missing at %s", release.id, release.file_path)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="app_release_file_missing")
    try:
        cert = signing_certificate(release.file_path)
    except (ApkSigningError, OSError) as exc:
        logger.warning("provisioning: release %s signature unreadable (%s)", release.id, exc)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="apk_signature_unreadable")
    cert_sha256 = hashlib.sha256(cert).hexdigest()
    if release.signing_cert_sha256 != cert_sha256:
        release.signing_cert_sha256 = cert_sha256
        db.commit()
    expires_at = DM.apk_token_expiry(body.valid_hours)
    token = DM.make_apk_token(release.id, expires_at)
    base = DM.public_api_base(request)
    download_url = f"{base}{get_settings().api_v1_prefix}{DM.APK_PATH}/{token}"
    checksum = provisioning_checksum(cert_sha256)
    payload = DM.provisioning_payload(
        download_url=download_url,
        signature_checksum=checksum,
        server_url=base,
        shop_id=shop.id,
        shop_name=shop.name,
        skip_encryption=body.skip_encryption,
    )
    warnings = DM.download_url_warnings(download_url)
    if DM.is_debug_certificate(cert):
        warnings.append("debug_key")
    if source != "assigned":
        warnings.append("not_assigned")
    return {
        "payload": payload,
        "payloadJson": json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        "release": {
            "id": str(release.id),
            "versionName": release.version_name,
            "versionCode": release.version_code,
            "source": source,
        },
        "shopId": str(shop.id),
        "shopName": shop.name,
        "downloadUrl": download_url,
        "expiresAt": expires_at.isoformat().replace("+00:00", "Z"),
        "signatureChecksum": checksum,
        "signingCertSha256": cert_sha256,
        "componentName": DM.COMPONENT_NAME,
        "adbCommand": DM.ADB_COMMAND,
        "warnings": warnings,
    }


@router.api_route(DM.APK_PATH + "/{token}", methods=["GET", "HEAD"])
def provisioning_apk(token: str, db: Session = Depends(get_db)):
    """
    The APK for a device in setup, by the QR's token (no auth header is possible there). `404`
    for a forged / unknown token or a retired release, `410 provisioning_link_expired`.
    """
    try:
        release_id = DM.read_apk_token(token)
    except DM.ApkTokenExpired:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="provisioning_link_expired")
    except DM.ApkTokenInvalid:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    release = db.query(AppRelease).filter(AppRelease.id == release_id).first()
    if (
        release is None
        or not release.is_active
        or AU.release_platform(release) != AU.PLATFORM_ANDROID
        or not os.path.isfile(release.file_path)
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    logger.info("provisioning: APK %s (%s) downloaded by a device in setup", release.id, release.version_name)
    return FileResponse(
        release.file_path,
        media_type="application/vnd.android.package-archive",
        filename=f"R2M-POS-{release.version_name}.apk",
    )


# ── Reboot ───────────────────────────────────────────────────────────────────


def _refused(exc: DM.RebootRefused) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.post("/machines/{machine_id}/reboot")
def request_machine_reboot(
    machine_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    "הפעל מחדש" — a device-owner till restarts once it is free: never during a sale, a payment or a
    card operation (it answers `deferred` and is asked again on its next heartbeat). Lapses after 30
    minutes. The pending one again on a second click (`created` false). `409 machine_not_assigned`,
    `409 reboot_android_only`, `409 reboot_needs_device_owner`.
    """
    from app.routers.machines import machine_for_shift_admin

    machine = machine_for_shift_admin(db, machine_id, current_user, active_tenant_id)
    try:
        req, created = DM.request_reboot(machine, current_user)
    except DM.RebootRefused as exc:
        raise _refused(exc)
    db.commit()
    return {"created": created, "rebootRequest": DM.reboot_request_out(req)}


@router.delete("/machines/{machine_id}/reboot")
def cancel_machine_reboot(
    machine_id: uuid.UUID,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Withdraw a waiting "הפעל מחדש". `409 reboot_not_pending` once it has ended."""
    from app.routers.machines import machine_for_shift_admin

    machine = machine_for_shift_admin(db, machine_id, current_user, active_tenant_id)
    try:
        req = DM.cancel_reboot(machine)
    except DM.RebootRefused as exc:
        raise _refused(exc)
    db.commit()
    return {"rebootRequest": DM.reboot_request_out(req)}


class RebootAckIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    request_id: uuid.UUID = Field(..., alias="requestId")
    phase: Literal["deferred", "rebooting", "refused"]
    #: busy_sale / busy_payment / busy_card / busy_table / busy_kiosk / in_use / not_owner / failed:…
    reason: Optional[str] = Field(None, max_length=200)


@router.post("/sync/{machine_id}/reboot/ack")
def post_reboot_ack(
    machine_id: str,
    body: RebootAckIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """The till's answer to `pendingReboot`. `404 reboot_request_not_found` for another id."""
    try:
        req = DM.apply_reboot_ack(machine, body.request_id, body.phase, body.reason)
    except DM.RebootRefused as exc:
        raise _refused(exc)
    db.commit()
    return {"ok": True, "status": req.get("status")}
