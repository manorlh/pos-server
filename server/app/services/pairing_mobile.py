"""Mobile QR bulk pairing: sessions, device register, claim, poll."""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.company import Company
from app.models.device_pairing_request import DevicePairingRequest, DevicePairingStatus
from app.models.pairing_session import PairingSession
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User
from app.services.auth import create_machine_token, create_pairing_session_token
from app.services.mqtt_broker import machine_mqtt_connection_info
from app.services.pairing import (
    PairingAssignmentError,
    assign_machine_to_shop,
    create_pos_machine,
    resolve_pairing_assignment,
)

settings = get_settings()


class PairingMobileError(ValueError):
    """Invalid mobile pairing operation."""


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _generate_jti() -> str:
    return secrets.token_urlsafe(32)


def _generate_device_nonce() -> str:
    return secrets.token_urlsafe(48)


def build_machine_credentials_payload(machine: POSMachine) -> Dict[str, Any]:
    """Same shape as POST /pairing/validate response."""
    machine_token = create_machine_token(str(machine.id))
    return machine_mqtt_connection_info(machine=machine, access_token=machine_token)


def build_mobile_url(session_token: str) -> str:
    base = settings.pairing_mobile_app_base_url.rstrip("/")
    return f"{base}/mobile/pair?t={session_token}"


def create_pairing_session(
    db: Session,
    distributor: User,
    tenant_id: uuid.UUID,
) -> Tuple[PairingSession, str]:
    jti = _generate_jti()
    expires_at = _utcnow() + timedelta(hours=settings.pairing_session_expire_hours)
    session = PairingSession(
        jti=jti,
        distributor_id=distributor.id,
        tenant_id=tenant_id,
        expires_at=expires_at,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    token = create_pairing_session_token(
        str(distributor.id),
        str(tenant_id),
        jti,
    )
    return session, token


def get_valid_pairing_session(db: Session, jti: str) -> Optional[PairingSession]:
    session = db.query(PairingSession).filter(PairingSession.jti == jti).first()
    if not session:
        return None
    if session.revoked_at is not None:
        return None
    if _utcnow() > session.expires_at:
        return None
    return session


def list_active_pairing_sessions(
    db: Session,
    distributor_id: uuid.UUID,
    tenant_id: uuid.UUID,
) -> List[PairingSession]:
    now = _utcnow()
    return (
        db.query(PairingSession)
        .filter(
            PairingSession.distributor_id == distributor_id,
            PairingSession.tenant_id == tenant_id,
            PairingSession.revoked_at.is_(None),
            PairingSession.expires_at > now,
        )
        .order_by(PairingSession.created_at.desc())
        .all()
    )


def revoke_pairing_session(
    db: Session,
    session_id: uuid.UUID,
    distributor_id: uuid.UUID,
    tenant_id: uuid.UUID,
) -> Optional[PairingSession]:
    session = (
        db.query(PairingSession)
        .filter(
            PairingSession.id == session_id,
            PairingSession.distributor_id == distributor_id,
            PairingSession.tenant_id == tenant_id,
        )
        .first()
    )
    if not session:
        return None
    if session.revoked_at is None:
        session.revoked_at = _utcnow()
        db.commit()
        db.refresh(session)
    return session


def update_pairing_session_defaults(
    db: Session,
    session: PairingSession,
    company_id: Optional[uuid.UUID],
    shop_id: Optional[uuid.UUID],
) -> PairingSession:
    if shop_id is not None and company_id is None:
        shop = db.query(Shop).filter(Shop.id == shop_id).first()
        if shop:
            company_id = shop.company_id
    if company_id is not None or shop_id is not None:
        resolve_pairing_assignment(
            db,
            session.tenant_id,
            company_id=company_id,
            shop_id=shop_id,
        )
    session.default_company_id = company_id
    session.default_shop_id = shop_id
    db.commit()
    db.refresh(session)
    return session


def register_device_pairing_request(
    db: Session,
    device_info: Optional[dict] = None,
    machine_name: Optional[str] = None,
) -> DevicePairingRequest:
    nonce = _generate_device_nonce()
    while db.query(DevicePairingRequest).filter(DevicePairingRequest.device_nonce == nonce).first():
        nonce = _generate_device_nonce()
    expires_at = _utcnow() + timedelta(minutes=settings.device_pairing_nonce_expire_minutes)
    row = DevicePairingRequest(
        device_nonce=nonce,
        status=DevicePairingStatus.WAITING,
        expires_at=expires_at,
        device_info=device_info,
        machine_name=machine_name,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _expire_if_needed(row: DevicePairingRequest) -> DevicePairingRequest:
    if row.status == DevicePairingStatus.WAITING and _utcnow() > row.expires_at:
        row.status = DevicePairingStatus.EXPIRED
    return row


def claim_device_pairing(
    db: Session,
    session: PairingSession,
    distributor: User,
    device_nonce: str,
    company_id: uuid.UUID,
    shop_id: uuid.UUID,
    machine_name: Optional[str] = None,
) -> Tuple[DevicePairingRequest, POSMachine, Company, Shop]:
    if shop_id is None:
        raise PairingMobileError("shopId is required")

    row = (
        db.query(DevicePairingRequest)
        .filter(DevicePairingRequest.device_nonce == device_nonce)
        .first()
    )
    if not row:
        raise PairingMobileError("Device not found")
    _expire_if_needed(row)
    if row.status != DevicePairingStatus.WAITING:
        raise PairingMobileError("Device is not available for pairing")
    if _utcnow() > row.expires_at:
        row.status = DevicePairingStatus.EXPIRED
        db.commit()
        raise PairingMobileError("Device pairing request expired")

    try:
        resolved_company_id, resolved_shop_id = resolve_pairing_assignment(
            db,
            session.tenant_id,
            company_id=company_id,
            shop_id=shop_id,
        )
    except PairingAssignmentError as exc:
        raise PairingMobileError(str(exc)) from exc

    if resolved_shop_id is None:
        raise PairingMobileError("shopId is required")

    company = db.query(Company).filter(Company.id == company_id).first()
    shop = db.query(Shop).filter(Shop.id == resolved_shop_id).first()
    if not company or not shop:
        raise PairingMobileError("Company or shop not found")
    if company.tenant_id != session.tenant_id:
        raise PairingMobileError("Access denied")

    resolved_machine_name = machine_name or row.machine_name
    pos_machine = create_pos_machine(
        db,
        distributor_id=distributor.id,
        tenant_id=session.tenant_id,
        device_info=row.device_info,
        machine_name=resolved_machine_name,
        pairing_session_id=session.id,
    )

    assigned = assign_machine_to_shop(db, pos_machine.id, resolved_shop_id)
    if not assigned:
        raise PairingMobileError("Failed to assign machine")

    credentials = build_machine_credentials_payload(assigned)
    row.status = DevicePairingStatus.CLAIMED
    row.pairing_session_id = session.id
    row.pos_machine_id = assigned.id
    row.credentials_payload = credentials
    row.claimed_at = _utcnow()
    session.machines_paired_count = (session.machines_paired_count or 0) + 1
    session.default_company_id = resolved_company_id or company_id
    session.default_shop_id = resolved_shop_id
    db.commit()
    db.refresh(row)
    db.refresh(session)
    return row, assigned, company, shop


def poll_device_credentials(
    db: Session,
    device_nonce: str,
) -> Tuple[str, Optional[Dict[str, Any]]]:
    """
    Returns (status, payload).
    status: waiting | credentials | gone | expired
    """
    row = (
        db.query(DevicePairingRequest)
        .filter(DevicePairingRequest.device_nonce == device_nonce)
        .first()
    )
    if not row:
        return "gone", None

    _expire_if_needed(row)
    if row.status == DevicePairingStatus.EXPIRED:
        db.commit()
        return "expired", None

    if row.status == DevicePairingStatus.DELIVERED:
        return "gone", None

    if row.status in (DevicePairingStatus.WAITING,):
        db.commit()
        return "waiting", None

    if row.status == DevicePairingStatus.CLAIMED and row.credentials_payload:
        payload = dict(row.credentials_payload)
        row.status = DevicePairingStatus.DELIVERED
        row.delivered_at = _utcnow()
        db.commit()
        return "credentials", payload

    return "waiting", None


def list_companies_for_pairing_session(
    db: Session,
    session: PairingSession,
    distributor: User,
) -> List[Company]:
    return (
        db.query(Company)
        .filter(Company.tenant_id == session.tenant_id)
        .order_by(Company.name.asc())
        .all()
    )


def list_shops_for_pairing_session(
    db: Session,
    session: PairingSession,
    distributor: User,
    company_id: Optional[uuid.UUID] = None,
) -> List[Shop]:
    q = db.query(Shop).filter(Shop.tenant_id == session.tenant_id)
    if company_id:
        q = q.filter(Shop.company_id == company_id)
    return q.order_by(Shop.name.asc()).all()
