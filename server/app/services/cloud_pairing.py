"""
Unpairing, re-pairing and "צימוד מהענן" (P:/specs/foreign-records-upload.md §5, §6).

The owner (17.10.2026): "כשמתנתק אני לא יודע לאיזה קופה לצמד מחדש" · "האם יש אפשרות לצמד מחדש מהענן?"

* **§5.1 unpaired** — the device says it unpaired (`POST /sync/{m}/unpaired`): the machine shows
  "לא מצומד — ממתין לצימוד מחדש" with what the device last said, its token is revoked; the next
  pairing of that machine clears it (`clear_unpaired`).
* **§5.2 bound re-pair code** — "קוד צימוד מחדש לקופה הזו": the existing replacement code
  (`pairing_codes.target_machine_id`), made without the open-shift refusal of a replacement: the
  device it is redeemed by decides (`pairing.adopt_machine`): the same device it was bound to
  (`deviceInfo.previousMachineId` = the machine) is a re-pair, its own open shift does not block it;
  another device is a replacement, under the replacement's rules. `GET /pairing/code-preview` says
  what a code pairs to before the device redeems it.
* **§6.1/§6.2 pairing from the dashboard** — an unpaired device registers (`POST
  /pairing/device/register`) and shows a short `deviceCode`; the dashboard claims it by that code
  into an existing machine (a bound code made and redeemed for the device) or a new one in a shop
  (an ordinary code), and the credentials go to the device's own nonce poll only.
* **§6.3 moving a paired device** — device command `move_pairing` carrying a single-use bound code
  of the target machine.
"""
from __future__ import annotations

import logging
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.device_pairing_request import DevicePairingRequest, DevicePairingStatus
from app.models.pairing_code import PairingCode
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User, UserRole

logger = logging.getLogger(__name__)

#: "קוד מכשיר": A-Z and 2-9 without the look-alikes (I, L, O, 0, 1).
DEVICE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
DEVICE_CODE_LENGTH = 6
DEVICE_CODE_TTL = timedelta(minutes=10)
#: A `move_pairing` command's code lives as long as the command may wait for its device.
MOVE_CODE_TTL = timedelta(hours=24)
UNPAIR_REASONS = ("manual", "forced", "cloud_move")
MOVE_RESULTS = ("ok", "refused_pending", "failed")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    moment = _aware(moment)
    return moment.isoformat() if moment is not None else None


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value).strip())
    except (TypeError, ValueError, AttributeError):
        return None


def _refuse(code: str, message: str, status_code: int = status.HTTP_409_CONFLICT) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


# ── §5.1 unpaired ────────────────────────────────────────────────────────────


def mark_unpaired(
    db: Session, machine: POSMachine, *, by: Optional[str], reason: Optional[str],
    pending: Optional[Dict[str, Any]], device_info: Optional[Dict[str, Any]], now: Optional[datetime] = None,
) -> POSMachine:
    """The device unpaired: kept on the machine for the dashboard, and its token revoked. The caller commits."""
    now = now or _now()
    clean_pending: Dict[str, int] = {}
    for kind, count in (pending or {}).items():
        try:
            clean_pending[str(kind)[:40]] = max(0, int(count))
        except (TypeError, ValueError):
            continue
    machine.unpaired_at = now
    machine.unpaired_by = (by or "").strip()[:200] or None
    machine.unpaired_info = {
        "reason": (reason or "").strip()[:40] or None,
        "pending": clean_pending,
        "pendingTotal": sum(clean_pending.values()),
        "deviceInfo": device_info if isinstance(device_info, dict) else None,
        "at": now.isoformat(),
    }
    # The device clears its credentials next; whatever still holds this token is cut off now.
    machine.token_version = (machine.token_version or 1) + 1
    logger.warning("machine %s unpaired by its device (%s, by %s): %s", machine.id, reason, by, clean_pending)
    db.flush()
    return machine


def clear_unpaired(machine: POSMachine) -> None:
    """The machine is paired again: no longer "ממתין לצימוד מחדש"."""
    if getattr(machine, "unpaired_at", None) is not None or getattr(machine, "unpaired_info", None) is not None:
        machine.unpaired_at = None
        machine.unpaired_by = None
        machine.unpaired_info = None


def is_re_pair(device_info: Optional[dict], target_machine_id: Any) -> bool:
    """A bound code redeemed by the device it was bound to: `deviceInfo.previousMachineId` = the machine."""
    if not isinstance(device_info, dict) or target_machine_id is None:
        return False
    previous = device_info.get("previousMachineId") or last_pairing_of(device_info).get("machineId")
    return previous is not None and str(previous).strip().lower() == str(target_machine_id).lower()


# ── §5.2 bound re-pair code and the preview ──────────────────────────────────


def create_re_pair_code(db: Session, user: User, machine: POSMachine, *, ttl: Optional[timedelta] = None,
                        reason: str = "צימוד מחדש") -> PairingCode:
    """
    "קוד צימוד מחדש לקופה הזו": a code bound to this machine (`target_machine_id`) — same id, numbering,
    shift / Z linkage, settings, area, license. Not refused for an open shift here: the device that
    redeems it decides (its own → a re-pair; another → a replacement, refused while the shift is open).
    """
    from app.services import shop_active
    from app.services.pairing import create_pairing_code

    shop_active.refuse_pairing(machine.shop)
    code = create_pairing_code(
        db, user.id, tenant_id=machine.tenant_id, company_id=None, shop_id=None, target_machine_id=machine.id,
    )
    code.replacement_reason = reason[:500]
    if ttl is not None:
        code.expires_at = _now() + ttl
    db.commit()
    db.refresh(code)
    return code


def re_pair_code_out(db: Session, code: PairingCode, machine: POSMachine) -> Dict[str, Any]:
    shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
    return {
        "code": code.code,
        "expiresAt": _iso(code.expires_at),
        "machineId": str(machine.id),
        "machineName": machine.name,
        "posNumber": machine.pos_number,
        "shopName": getattr(shop, "name", None),
    }


def code_preview(db: Session, raw_code: str) -> Optional[Dict[str, Any]]:
    """What a pairing code pairs to — None for an unknown, used or expired one."""
    text = (raw_code or "").strip().upper()
    if not text:
        return None
    code = db.query(PairingCode).filter(PairingCode.code == text).first()
    if code is None or code.is_used or _now() > _aware(code.expires_at):
        return None
    if code.target_machine_id is not None:
        machine = db.get(POSMachine, code.target_machine_id)
        if machine is None:
            return None
        shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
        company = db.get(Company, shop.company_id) if shop is not None else None
        return {
            "bound": True,
            "machineId": str(machine.id),
            "machineName": machine.name,
            "posNumber": machine.pos_number,
            "shopName": getattr(shop, "name", None),
            "companyName": getattr(company, "name", None),
        }
    shop = db.get(Shop, code.shop_id) if code.shop_id is not None else None
    company = db.get(Company, code.company_id or (shop.company_id if shop is not None else None)) \
        if (code.company_id or shop is not None) else None
    return {"bound": False, "shopName": getattr(shop, "name", None), "companyName": getattr(company, "name", None)}


# ── §6.1 the device code ─────────────────────────────────────────────────────


def normalize_device_code(raw: Optional[str]) -> str:
    return re.sub(r"[^A-Z0-9]", "", (raw or "").upper())


def new_device_code(db: Session) -> str:
    now = _now()
    for _ in range(50):
        code = "".join(secrets.choice(DEVICE_CODE_ALPHABET) for _ in range(DEVICE_CODE_LENGTH))
        taken = (
            db.query(DevicePairingRequest.id)
            .filter(DevicePairingRequest.device_code == code, DevicePairingRequest.code_expires_at > now)
            .first()
        )
        if taken is None:
            return code
    raise RuntimeError("could not draw a free device code")


def last_pairing_of(device_info: Optional[dict]) -> Dict[str, Any]:
    """`deviceInfo.lastPairing` — an object, or (Android's `Map<String, String>`) a JSON string of one."""
    last = device_info.get("lastPairing") if isinstance(device_info, dict) else None
    if isinstance(last, str):
        try:
            import json

            last = json.loads(last)
        except ValueError:
            last = None
    return last if isinstance(last, dict) else {}


def stamp_request(db: Session, row: DevicePairingRequest, now: Optional[datetime] = None) -> DevicePairingRequest:
    """A new register: its device code (10 minutes) and the tenant of its last pairing. The caller commits."""
    now = now or _now()
    row.device_code = new_device_code(db)
    row.code_expires_at = now + DEVICE_CODE_TTL
    row.last_tenant_id = _uuid(last_pairing_of(row.device_info).get("tenantId"))
    return row


def format_device_code(code: Optional[str]) -> Optional[str]:
    return f"{code[:3]}-{code[3:]}" if code and len(code) == DEVICE_CODE_LENGTH else code


# ── §6.2 the dashboard ───────────────────────────────────────────────────────


def _waiting(db: Session):
    now = _now()
    return db.query(DevicePairingRequest).filter(
        DevicePairingRequest.status == DevicePairingStatus.WAITING,
        DevicePairingRequest.expires_at > now,
        DevicePairingRequest.device_code.isnot(None),
        DevicePairingRequest.code_expires_at > now,
    )


def request_out(row: DevicePairingRequest) -> Dict[str, Any]:
    info = row.device_info if isinstance(row.device_info, dict) else {}
    last = last_pairing_of(info)
    from app.services.display_devices import platform_of_device_info

    return {
        "id": str(row.id),
        "deviceCode": format_device_code(row.device_code),
        "codeExpiresAt": _iso(row.code_expires_at),
        "platform": info.get("platform") or platform_of_device_info(info),
        "model": info.get("model") or info.get("deviceModel"),
        "serial": info.get("serialNumber") or info.get("serial"),
        "machineName": row.machine_name,
        "lastPairing": {
            k: last.get(k) for k in (
                "machineId", "machineName", "posNumber", "shopName", "companyName", "tenantId", "unpairedAt", "unpairedBy",
            ) if last.get(k) is not None
        } or None,
        "registeredAt": _iso(row.created_at),
    }


def list_requests(db: Session, tenant_id: Any, *, shop_id: Any = None, code: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    "מכשירים שממתינים לצימוד": the waiting devices whose last pairing was in this tenant (narrowed to a
    shop's when `shop_id` is given), plus — any device — the one whose code is typed exactly.
    """
    rows = _waiting(db).filter(DevicePairingRequest.last_tenant_id == _uuid(tenant_id)).all() if tenant_id else []
    if shop_id is not None:
        shop_machines = {
            str(m[0]) for m in db.query(POSMachine.id).filter(POSMachine.shop_id == _uuid(shop_id)).all()
        }
        rows = [
            r for r in rows
            if str(last_pairing_of(r.device_info).get("shopId") or "") == str(shop_id)
            or str(last_pairing_of(r.device_info).get("machineId") or "") in shop_machines
        ]
    wanted = normalize_device_code(code)
    if wanted:
        exact = _waiting(db).filter(DevicePairingRequest.device_code == wanted).first()
        if exact is not None and exact.id not in {r.id for r in rows}:
            rows.append(exact)
    rows.sort(key=lambda r: _aware(r.created_at) or _now(), reverse=True)
    # One row per device code (a device re-registers every 10 minutes; the newest wins).
    return [request_out(r) for r in rows]


def find_request(db: Session, raw_code: str) -> DevicePairingRequest:
    code = normalize_device_code(raw_code)
    row = _waiting(db).filter(DevicePairingRequest.device_code == code).first() if code else None
    if row is None:
        raise _refuse("device_code_unknown", "קוד המכשיר לא נמצא או שפג תוקפו — בקשו מהמכשיר קוד חדש",
                      status.HTTP_404_NOT_FOUND)
    return row


def claim(
    db: Session, user: User, tenant_id: Any, *, device_code: str, machine_id: Any = None, company_id: Any = None,
    shop_id: Any = None, machine_name: Optional[str] = None,
) -> Tuple[DevicePairingRequest, POSMachine, Dict[str, Any]]:
    """
    Claim a waiting device by its code: into `machine_id` (a bound code, made and redeemed for it — the
    rules of §5.2) or, without it, a new machine in `shop_id` (an ordinary code). The credentials are put
    on the request for the device's nonce poll. Refusals: HTTPException with {code, message}.
    """
    from app.middleware.auth import ensure_same_tenant
    from app.services.pairing import (
        AdoptionRefused,
        PairingAssignmentError,
        create_pairing_code,
        resolve_pairing_assignment,
        validate_pairing_code,
    )
    from app.services.pairing_mobile import build_machine_credentials_payload

    row = find_request(db, device_code)
    target = None
    if machine_id is not None:
        target = db.get(POSMachine, _uuid(machine_id)) if _uuid(machine_id) else None
        if target is None:
            raise _refuse("machine_not_found", "הקופה לא נמצאה", status.HTTP_404_NOT_FOUND)
        ensure_same_tenant(target.tenant_id, tenant_id)
        _check_machine_scope(db, user, target, tenant_id)
        from app.services import shop_active

        shop_active.refuse_pairing(target.shop)
        code = create_pairing_code(
            db, user.id, tenant_id=target.tenant_id, company_id=None, shop_id=None, target_machine_id=target.id,
        )
        code.replacement_reason = "צימוד מהענן"
        db.commit()
    else:
        if shop_id is None:
            raise _refuse("shop_required", "יש לבחור סניף לקופה החדשה", status.HTTP_422_UNPROCESSABLE_ENTITY)
        try:
            resolved_company, resolved_shop = resolve_pairing_assignment(
                db, _uuid(tenant_id), company_id=_uuid(company_id), shop_id=_uuid(shop_id),
            )
        except PairingAssignmentError as exc:
            raise _refuse("invalid_assignment", str(exc), status.HTTP_400_BAD_REQUEST) from exc
        shop = db.get(Shop, resolved_shop)
        _check_shop_scope(db, user, shop, tenant_id)
        code = create_pairing_code(
            db, user.id, tenant_id=_uuid(tenant_id), company_id=resolved_company, shop_id=resolved_shop,
            machine_name=(machine_name or "").strip()[:255] or None,
        )
    try:
        machine = validate_pairing_code(db, code.code, row.device_info, machine_name or row.machine_name)
    except AdoptionRefused as exc:
        db.rollback()
        raise _refuse("adoption_refused", str(exc)) from exc
    if machine is None:
        raise _refuse("pairing_failed", "הצימוד נכשל")
    credentials = build_machine_credentials_payload(machine)
    try:
        from app.services import device_license, device_profile

        product = device_license.product_of(db, machine)
        credentials.update({
            "deviceRole": device_profile.effective_role(db, machine),
            "licenseProduct": product,
            "licenseProductLabel": device_license.label(product),
        })
    except Exception:  # noqa: BLE001 - the pairing stands
        pass
    row = db.get(DevicePairingRequest, row.id)
    row.status = DevicePairingStatus.CLAIMED
    row.pos_machine_id = machine.id
    row.credentials_payload = credentials
    row.claimed_at = _now()
    row.claimed_by_user_id = user.id
    db.commit()
    logger.warning(
        "device request %s (code %s) claimed by %s into machine %s (%s)",
        row.id, row.device_code, user.id, machine.id, "existing" if target is not None else "new",
    )
    shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
    company = db.get(Company, shop.company_id) if shop is not None else None
    return row, machine, {
        "ok": True,
        "machineId": str(machine.id),
        "machineName": machine.name,
        "posNumber": machine.pos_number,
        "shopName": getattr(shop, "name", None),
        "companyName": getattr(company, "name", None),
        "bound": target is not None,
    }


def _check_machine_scope(db: Session, user: User, machine: POSMachine, tenant_id: Any) -> None:
    from app.services.company_hierarchy import user_may_use_machine

    if user.role == UserRole.SUPER_ADMIN:
        return
    if user.role == UserRole.DISTRIBUTOR:
        return  # within the tenant (checked): a distributor manages the tenant's devices
    if not user_may_use_machine(db, user, machine):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def _check_shop_scope(db: Session, user: User, shop: Optional[Shop], tenant_id: Any) -> None:
    if shop is None:
        raise _refuse("shop_not_found", "הסניף לא נמצא", status.HTTP_404_NOT_FOUND)
    if str(shop.tenant_id) != str(tenant_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


# ── §6.3 move a paired device ────────────────────────────────────────────────


def move_pairing(
    db: Session, user: User, tenant_id: Any, source: POSMachine, target_id: Any, *, forced: bool = False,
) -> Dict[str, Any]:
    """
    "העבר מכשיר לקופה אחרת": a `move_pairing` command to the device of `source`, carrying a single-use code
    bound to the target machine. `forced` (the device unpairs with rows unsent, after its backup) — support
    only. The caller commits and wakes the device.
    """
    from app.middleware.auth import ensure_same_tenant
    from app.services import device_commands as DC

    if forced and user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"code": "super_admin_only",
                                                                           "message": "העברה בכפייה — לתמיכה בלבד"})
    target = db.get(POSMachine, _uuid(target_id)) if _uuid(target_id) else None
    if target is None:
        raise _refuse("machine_not_found", "קופת היעד לא נמצאה", status.HTTP_404_NOT_FOUND)
    ensure_same_tenant(target.tenant_id, tenant_id)
    _check_machine_scope(db, user, target, tenant_id)
    if str(target.id) == str(source.id):
        raise _refuse("same_machine", "המכשיר כבר מצומד לקופה הזו", status.HTTP_422_UNPROCESSABLE_ENTITY)
    code = create_re_pair_code(db, user, target, ttl=MOVE_CODE_TTL, reason="העברת מכשיר מקופה אחרת")
    shop = db.get(Shop, target.shop_id) if target.shop_id is not None else None
    rows = DC.create(
        db, [source], "move_pairing", user=user,
        params={
            "targetMachineId": str(target.id),
            "targetMachineName": target.name,
            "targetPosNumber": target.pos_number,
            "targetShopName": getattr(shop, "name", None),
            "forced": bool(forced),
            "pairingCode": code.code,
            "pairingCodeExpiresAt": _iso(code.expires_at),
        },
        expires_in=MOVE_CODE_TTL,
    )
    return DC.command_out(rows[0])


def clean_move_answer(ack_status: str, detail: Optional[str], raw: Optional[dict]) -> Tuple[Optional[str], Dict[str, Any]]:
    """`move_pairing`'s answer as {outcome: ok|refused_pending|failed, pending?}."""
    outcome = {"done": "ok", "refused": "refused_pending", "failed": "failed"}.get(ack_status, "failed")
    if ack_status == "refused" and detail and detail != "refused_pending":
        outcome = "failed"  # `offline_z_pending`, `bad_request`: refused for another reason (kept in `detail`)
    raw = raw if isinstance(raw, dict) else {}
    if raw.get("outcome") in MOVE_RESULTS:
        outcome = raw["outcome"]
    result: Dict[str, Any] = {"outcome": outcome}
    if isinstance(raw.get("pending"), dict):
        result["pending"] = {str(k)[:40]: v for k, v in raw["pending"].items() if isinstance(v, int)}
    if ack_status == "refused" and not detail:
        detail = "refused_pending"
    return detail, result
