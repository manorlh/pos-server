"""Integration tests for mobile QR pairing flow."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.models.device_pairing_request import DevicePairingRequest, DevicePairingStatus
from app.models.pairing_session import PairingSession
from app.models.pos_machine import PairingStatus
from app.models.user import UserRole
from app.services.auth import create_pairing_session_token, decode_jwt_payload
from app.services.pairing_mobile import (
    PairingMobileError,
    claim_device_pairing,
    create_pairing_session,
    get_valid_pairing_session,
    poll_device_credentials,
    register_device_pairing_request,
    revoke_pairing_session,
)


def _utcnow():
    return datetime.now(timezone.utc)


def _mock_distributor(distributor_id=None, role=UserRole.DISTRIBUTOR):
    user = MagicMock()
    user.id = distributor_id or uuid.uuid4()
    user.role = role
    user.is_active = True
    return user


def test_create_pairing_session_token_has_correct_type() -> None:
    distributor_id = uuid.uuid4()
    tenant_id = uuid.uuid4()
    jti = "test-jti-abc"
    token = create_pairing_session_token(str(distributor_id), str(tenant_id), jti, expires_hours=12)
    payload = decode_jwt_payload(token)
    assert payload is not None
    assert payload["type"] == "pairing_session"
    assert payload["jti"] == jti
    assert payload["sub"] == str(distributor_id)
    assert payload["tenant_id"] == str(tenant_id)


def test_get_valid_pairing_session_rejects_revoked() -> None:
    db = MagicMock()
    session = MagicMock(spec=PairingSession)
    session.revoked_at = _utcnow()
    session.expires_at = _utcnow() + timedelta(hours=1)
    db.query.return_value.filter.return_value.first.return_value = session
    assert get_valid_pairing_session(db, "jti") is None


def test_get_valid_pairing_session_rejects_expired() -> None:
    db = MagicMock()
    session = MagicMock(spec=PairingSession)
    session.revoked_at = None
    session.expires_at = _utcnow() - timedelta(minutes=1)
    db.query.return_value.filter.return_value.first.return_value = session
    assert get_valid_pairing_session(db, "jti") is None


def test_poll_device_credentials_one_time_delivery() -> None:
    db = MagicMock()
    row = MagicMock(spec=DevicePairingRequest)
    row.device_nonce = "nonce1"
    row.status = DevicePairingStatus.CLAIMED
    row.expires_at = _utcnow() + timedelta(minutes=10)
    row.credentials_payload = {"machineId": "abc", "accessToken": "tok"}

    db.query.return_value.filter.return_value.first.return_value = row

    status1, payload1 = poll_device_credentials(db, "nonce1")
    assert status1 == "credentials"
    assert payload1["machineId"] == "abc"
    assert row.status == DevicePairingStatus.DELIVERED

    row.status = DevicePairingStatus.DELIVERED
    status2, payload2 = poll_device_credentials(db, "nonce1")
    assert status2 == "gone"
    assert payload2 is None


def test_claim_requires_shop_id() -> None:
    db = MagicMock()
    session = MagicMock(spec=PairingSession)
    session.tenant_id = uuid.uuid4()
    session.id = uuid.uuid4()
    session.jti = "j"
    distributor = _mock_distributor()

    with pytest.raises(PairingMobileError, match="shopId is required"):
        claim_device_pairing(
            db,
            session,
            distributor,
            "missing-nonce",
            uuid.uuid4(),
            None,  # type: ignore[arg-type]
        )


def test_register_device_pairing_request_returns_nonce() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    db.commit.return_value = None

    fake_row = MagicMock(spec=DevicePairingRequest)
    fake_row.device_nonce = "fixed-nonce-xyz"
    fake_row.status = DevicePairingStatus.WAITING

    with patch("app.services.pairing_mobile._generate_device_nonce", return_value="fixed-nonce-xyz"):
        with patch("app.services.pairing_mobile.DevicePairingRequest", return_value=fake_row) as mock_cls:
            row = register_device_pairing_request(db, device_info={"app": "test"})
            mock_cls.assert_called_once()
            assert mock_cls.call_args.kwargs["device_nonce"] == "fixed-nonce-xyz"

    assert row.device_nonce == "fixed-nonce-xyz"
    assert row.status == DevicePairingStatus.WAITING
    db.add.assert_called_once_with(fake_row)


def test_revoke_pairing_session_sets_revoked_at() -> None:
    db = MagicMock()
    session = MagicMock(spec=PairingSession)
    session.revoked_at = None
    session.id = uuid.uuid4()
    db.query.return_value.filter.return_value.first.return_value = session

    distributor_id = uuid.uuid4()
    tenant_id = uuid.uuid4()
    result = revoke_pairing_session(db, session.id, distributor_id, tenant_id)
    assert result is session
    assert session.revoked_at is not None
    db.commit.assert_called()
