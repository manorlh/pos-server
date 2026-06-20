import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import app.models  # noqa: F401 — register all ORM mappers

from app.models.tenant_membership import TenantMembershipRole
from app.models.user import User, UserRole
from app.services.clerk_profile import ClerkProfile
from app.services.clerk_provision import resolve_clerk_user


def _profile(**kwargs) -> ClerkProfile:
    defaults = {
        "clerk_user_id": "user_abc123",
        "email": "owner@example.com",
        "first_name": "Ada",
        "last_name": "Lovelace",
        "clerk_username": "ada",
    }
    defaults.update(kwargs)
    return ClerkProfile(**defaults)


def _query_chain(result):
    chain = MagicMock()
    chain.filter.return_value = chain
    chain.first.return_value = result
    return chain


def _is_user_model(model) -> bool:
    return getattr(model, "__tablename__", None) == "users"


def test_resolve_returns_existing_clerk_user() -> None:
    db = MagicMock()
    existing = SimpleNamespace(id=uuid.uuid4(), clerk_user_id="user_abc123", is_active=True)
    db.query.return_value = _query_chain(existing)

    user = resolve_clerk_user(db, "user_abc123", allow_self_service=True)

    assert user is existing
    db.commit.assert_not_called()


def test_resolve_links_unclaimed_super_admin() -> None:
    db = MagicMock()
    super_admin = SimpleNamespace(
        id=uuid.uuid4(),
        role=UserRole.SUPER_ADMIN,
        clerk_user_id=None,
        is_active=True,
    )
    user_queries = iter([None, super_admin])

    def query_side_effect(model):
        if _is_user_model(model):
            chain = MagicMock()
            chain.filter.return_value = chain
            chain.first.side_effect = lambda: next(user_queries)
            return chain
        chain = MagicMock()
        chain.filter.return_value = chain
        chain.first.return_value = None
        return chain

    db.query.side_effect = query_side_effect

    user = resolve_clerk_user(db, "user_new", allow_self_service=True)

    assert user is super_admin
    assert super_admin.clerk_user_id == "user_new"
    db.commit.assert_called_once()


@patch("app.services.clerk_provision.fetch_clerk_profile")
def test_resolve_links_invited_user_by_email(mock_fetch) -> None:
    db = MagicMock()
    invited = SimpleNamespace(
        id=uuid.uuid4(),
        email="staff@example.com",
        clerk_user_id=None,
        tenant_id=uuid.uuid4(),
        is_active=True,
    )
    mock_fetch.return_value = _profile(clerk_user_id="user_staff", email="staff@example.com")
    user_queries = iter([None, None, invited])

    def query_side_effect(model):
        if _is_user_model(model):
            chain = MagicMock()
            chain.filter.return_value = chain
            chain.first.side_effect = lambda: next(user_queries, None)
            return chain
        chain = MagicMock()
        chain.filter.return_value = chain
        chain.first.return_value = None
        return chain

    db.query.side_effect = query_side_effect

    user = resolve_clerk_user(db, "user_staff", allow_self_service=True)

    assert user is invited
    assert invited.clerk_user_id == "user_staff"
    db.commit.assert_called_once()
    mock_fetch.assert_called_once_with("user_staff")


@patch("app.services.clerk_provision.fetch_clerk_profile")
def test_resolve_provisions_self_service_user_and_tenant(mock_fetch) -> None:
    db = MagicMock()
    mock_fetch.return_value = _profile()

    def query_side_effect(model):
        chain = MagicMock()
        chain.filter.return_value = chain
        chain.first.return_value = None
        return chain

    db.query.side_effect = query_side_effect

    added = []
    db.add.side_effect = lambda obj: added.append(obj)

    def flush_side_effect():
        for obj in added:
            if getattr(obj, "id", None) is None:
                obj.id = uuid.uuid4()

    db.flush.side_effect = flush_side_effect

    user = resolve_clerk_user(db, "user_abc123", allow_self_service=True)

    assert user.clerk_user_id == "user_abc123"
    assert user.email == "owner@example.com"
    assert user.role == UserRole.DISTRIBUTOR
    assert user.tenant_id is not None

    tenant = added[0]
    membership = added[2]
    assert tenant.name == "Ada Lovelace"
    assert tenant.created_by_user_id == user.id
    assert membership.role == TenantMembershipRole.TENANT_OWNER
    assert membership.is_default is True
    db.commit.assert_called_once()


@patch("app.services.clerk_provision.fetch_clerk_profile")
def test_resolve_returns_none_when_self_service_disabled(mock_fetch) -> None:
    db = MagicMock()
    mock_fetch.return_value = _profile()
    user_queries = iter([None, None, None])

    def query_side_effect(model):
        if _is_user_model(model):
            chain = MagicMock()
            chain.filter.return_value = chain
            chain.first.side_effect = lambda: next(user_queries, None)
            return chain
        return MagicMock()

    db.query.side_effect = query_side_effect

    user = resolve_clerk_user(db, "user_abc123", allow_self_service=False)

    assert user is None
    db.commit.assert_not_called()


@patch("app.services.clerk_provision.fetch_clerk_profile")
def test_resolve_returns_none_without_clerk_profile(mock_fetch) -> None:
    db = MagicMock()
    mock_fetch.return_value = None

    def query_side_effect(model):
        if _is_user_model(model):
            return _query_chain(None)
        return MagicMock()

    db.query.side_effect = query_side_effect

    user = resolve_clerk_user(db, "user_abc123", allow_self_service=True)

    assert user is None
