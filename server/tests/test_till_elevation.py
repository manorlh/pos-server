"""Cover for till elevation: PIN policy, lockout, grants, and the gate on the endpoints.

What can actually go wrong here is narrow and worth naming, because each of these is
a way the feature would look like it worked while protecting nothing:

* a PIN policy that still accepts `1234` — the seeded default, so the gate would ship
  open in every shop;
* a wrong PIN and an unknown email failing differently, turning the till into an
  address oracle;
* a grant that outlives a demotion, or that can be carried to a second terminal;
* sliding the idle window past the absolute ceiling, so a session never dies;
* a till editing a product the whole chain sells;
* a "delete" that actually deletes a row invoices point at;
* and, most boringly, somebody removing `require_elevated` from an endpoint later.

Style matches the rest of tests/: no database, no client. Handlers and services are
called directly with scripted sessions.
"""
from __future__ import annotations

import inspect
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.models.user import UserRole
from app.services import elevation
from app.services.permissions import (
    Scope,
    parse_scopes,
    till_grantable_scopes,
)


def _now():
    return datetime.now(timezone.utc)


def _user(role=UserRole.SHOP_MANAGER, **kw):
    user = MagicMock()
    user.id = kw.get("id", uuid.uuid4())
    user.role = role
    user.is_active = kw.get("is_active", True)
    user.email = kw.get("email", "yossi@shop.co.il")
    user.username = kw.get("username", "yossi")
    user.company_id = kw.get("company_id")
    user.shop_id = kw.get("shop_id")
    user.till_pin_hash = kw.get("till_pin_hash")
    user.till_pin_failed_count = kw.get("till_pin_failed_count", 0)
    user.till_pin_locked_until = kw.get("till_pin_locked_until")
    return user


def _machine(shop_id=None, tenant_id=None):
    machine = MagicMock()
    machine.id = uuid.uuid4()
    machine.shop_id = shop_id or uuid.uuid4()
    machine.tenant_id = tenant_id or uuid.uuid4()
    machine.shop = MagicMock()
    machine.shop.company_id = uuid.uuid4()
    return machine


class _Session:
    """Enough of a Session for services that only add and flush."""

    def __init__(self):
        self.info: dict = {}
        self.added: list = []
        self.commits = 0

    def add(self, obj):
        self.added.append(obj)

    def flush(self):
        pass

    def commit(self):
        self.commits += 1


# ── PIN policy ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("bad", ["1234", "4321", "0000", "9999", "abcd", "12", "1" * 20, ""])
def test_pin_policy_rejects_weak_and_malformed(bad):
    with pytest.raises(elevation.PinPolicyError):
        elevation.validate_pin(bad)


def test_pin_policy_rejects_the_seeded_default_specifically():
    """`1234` is the PIN every new shop's POS user ships with. It must never be a
    valid till PIN, or the gate is open everywhere on day one."""
    with pytest.raises(elevation.PinPolicyError):
        elevation.validate_pin("1234")


@pytest.mark.parametrize("good", ["1357", "902134", "480915"])
def test_pin_policy_accepts_ordinary_pins(good):
    assert elevation.validate_pin(good) == good


def test_set_till_pin_stores_a_hash_not_the_pin():
    db, user = _Session(), _user()
    elevation.set_till_pin(db, user, "8317")
    assert user.till_pin_hash and user.till_pin_hash != "8317"


def test_the_pin_set_in_the_cloud_is_the_one_that_works():
    """
    There is no first-use change step: whatever an administrator sets is what the
    person types at the till. Guards against quietly reintroducing a forced change,
    which would strand anyone whose PIN was set for them.
    """
    db, user = _Session(), _user()
    elevation.set_till_pin(db, user, "8317")
    assert elevation.verify_till_pin(db, user, "8317") is True


def test_set_till_pin_clears_a_standing_lockout():
    db = _Session()
    user = _user(till_pin_failed_count=4, till_pin_locked_until=_now() + timedelta(minutes=5))
    elevation.set_till_pin(db, user, "8317")
    assert user.till_pin_failed_count == 0
    assert user.till_pin_locked_until is None


# ── Lockout ───────────────────────────────────────────────────────────────────


def test_wrong_pin_eventually_locks_out_and_lockout_is_reported():
    db = _Session()
    user = _user()
    elevation.set_till_pin(db, user, "8317")

    for _ in range(elevation.settings.till_pin_max_attempts):
        assert elevation.verify_till_pin(db, user, "0001") is False

    assert user.till_pin_locked_until is not None
    assert elevation.pin_lockout_remaining(user) is not None


def test_correct_pin_resets_the_failure_count():
    db, user = _Session(), _user()
    elevation.set_till_pin(db, user, "8317")
    elevation.verify_till_pin(db, user, "0001")
    assert user.till_pin_failed_count == 1

    assert elevation.verify_till_pin(db, user, "8317") is True
    assert user.till_pin_failed_count == 0
    assert user.till_pin_locked_until is None


def test_a_user_with_no_pin_never_verifies():
    assert elevation.verify_till_pin(_Session(), _user(till_pin_hash=None), "8317") is False


def test_expired_lockout_reports_nothing_remaining():
    user = _user(till_pin_locked_until=_now() - timedelta(seconds=1))
    assert elevation.pin_lockout_remaining(user) is None


# ── Scopes ────────────────────────────────────────────────────────────────────


def test_a_cashier_can_hold_no_till_scopes():
    assert till_grantable_scopes(UserRole.CASHIER) == frozenset()


def test_managers_can_hold_catalog_write():
    for role in (
        UserRole.SHOP_MANAGER,
        UserRole.COMPANY_MANAGER,
        UserRole.DISTRIBUTOR,
        UserRole.SUPER_ADMIN,
    ):
        assert Scope.CATALOG_WRITE in till_grantable_scopes(role)


def test_unknown_scope_names_are_dropped_not_fatal():
    """A newer till asking for something this server has not shipped still gets a
    session for the rest, rather than failing outright mid-rollout."""
    assert parse_scopes(["catalog:write", "refund:approve"]) == [Scope.CATALOG_WRITE]


def test_scope_request_is_intersected_with_the_role_ceiling(monkeypatch):
    monkeypatch.setattr(elevation, "user_may_use_machine", lambda *a, **k: True)
    granted = elevation.grantable_scopes(
        _Session(), _user(role=UserRole.CASHIER), _machine(), [Scope.CATALOG_WRITE]
    )
    assert granted == []


def test_no_scopes_when_the_user_has_no_business_at_this_machine(monkeypatch):
    monkeypatch.setattr(elevation, "user_may_use_machine", lambda *a, **k: False)
    granted = elevation.grantable_scopes(
        _Session(), _user(), _machine(), [Scope.CATALOG_WRITE]
    )
    assert granted == []


# ── The grant ─────────────────────────────────────────────────────────────────


def test_created_session_stores_only_a_hash_of_the_token():
    db, user, machine = _Session(), _user(), _machine()
    raw, session = elevation.create_session(db, user, machine, [Scope.CATALOG_WRITE])
    assert raw
    assert raw not in str(session.token_hash)
    assert len(session.token_hash) == 64


def test_created_session_copies_the_shop_rather_than_following_the_machine():
    """A machine reassigned to another shop must not drag a live grant with it."""
    db, user, machine = _Session(), _user(), _machine()
    _raw, session = elevation.create_session(db, user, machine, [Scope.CATALOG_WRITE])
    original_shop = machine.shop_id
    machine.shop_id = uuid.uuid4()
    assert session.shop_id == original_shop


def test_session_liveness_respects_revocation_and_both_deadlines():
    def _session(**kw):
        s = MagicMock()
        s.revoked_at = kw.get("revoked_at")
        s.expires_at = kw.get("expires_at", _now() + timedelta(minutes=5))
        s.absolute_expires_at = kw.get("absolute_expires_at", _now() + timedelta(hours=4))
        return s

    assert elevation.session_is_live(_session()) is True
    assert elevation.session_is_live(_session(revoked_at=_now())) is False
    assert elevation.session_is_live(_session(expires_at=_now() - timedelta(seconds=1))) is False
    assert (
        elevation.session_is_live(
            _session(absolute_expires_at=_now() - timedelta(seconds=1))
        )
        is False
    )


class _LookupSession(_Session):
    def __init__(self, session_row):
        super().__init__()
        self._row = session_row

    def query(self, *_entities):
        outer = self

        class _Q:
            def filter(self, *_c):
                return self

            def first(self):
                return outer._row

        return _Q()


def _live_row(user, *, scopes=("catalog:write",), **kw):
    row = MagicMock()
    row.revoked_at = kw.get("revoked_at")
    row.expires_at = kw.get("expires_at", _now() + timedelta(minutes=5))
    row.absolute_expires_at = kw.get("absolute_expires_at", _now() + timedelta(hours=4))
    row.scopes = list(scopes)
    row.user = user
    row.machine_id = kw.get("machine_id", uuid.uuid4())
    return row


def test_resolve_slides_the_idle_window_forward():
    row = _live_row(_user(), expires_at=_now() + timedelta(seconds=30))
    before = row.expires_at
    assert elevation.resolve_session(_LookupSession(row), "token") is row
    assert row.expires_at > before


def test_resolve_never_slides_past_the_absolute_ceiling():
    ceiling = _now() + timedelta(seconds=20)
    row = _live_row(_user(), expires_at=_now() + timedelta(seconds=10), absolute_expires_at=ceiling)
    elevation.resolve_session(_LookupSession(row), "token")
    assert row.expires_at == ceiling


def test_resolve_refuses_a_session_whose_user_was_deactivated():
    row = _live_row(_user(is_active=False))
    assert elevation.resolve_session(_LookupSession(row), "token") is None


def test_resolve_refuses_a_session_whose_user_lost_the_role(monkeypatch):
    """A manager demoted mid-window stops being able to act immediately, rather
    than at the end of their fifteen minutes."""
    row = _live_row(_user(role=UserRole.CASHIER))
    assert elevation.resolve_session(_LookupSession(row), "token") is None


def test_resolve_refuses_an_unknown_or_empty_token():
    assert elevation.resolve_session(_LookupSession(None), "nope") is None
    assert elevation.resolve_session(_LookupSession(_live_row(_user())), "") is None


# ── The endpoint gate ─────────────────────────────────────────────────────────


def test_every_till_catalog_endpoint_still_requires_elevation():
    """
    Structural guard. These six endpoints once took a machine token and nothing
    else, and could rewrite any product in the tenant. If a future edit drops the
    dependency they go back to exactly that, silently — so assert the signature
    rather than trusting review.
    """
    from app.routers import sync as sync_router

    gated = [
        sync_router.machine_create_cloud_product,
        sync_router.machine_update_cloud_product,
        sync_router.machine_delete_cloud_product,
        sync_router.machine_create_cloud_category,
        sync_router.machine_update_cloud_category,
        sync_router.machine_delete_cloud_category,
    ]
    for handler in gated:
        params = inspect.signature(handler).parameters
        assert "session" in params, f"{handler.__name__} lost its elevation parameter"
        default = params["session"].default
        assert getattr(default, "dependency", None) is not None, (
            f"{handler.__name__} no longer depends on require_elevated"
        )


def test_till_catalog_endpoints_never_read_scope_from_the_request_body():
    """
    `machine_create_cloud_product` used to take `company_id` and `shop_id` straight
    from the body, so a machine token could file a product under any company. Scope
    must come from the authenticated machine only.
    """
    from app.routers import sync as sync_router

    source = inspect.getsource(sync_router.machine_create_cloud_product)
    assert "data.company_id" not in source
    assert "data.shop_id" not in source
    assert "shop.company_id" in source


def test_till_delete_unlists_rather_than_deleting_the_master():
    """
    `transaction_items.product_id` is a foreign key with no ON DELETE, so deleting a
    product that has ever been sold raises IntegrityError. The till's delete must
    therefore unlist from the shop, never remove the row.
    """
    from app.routers import sync as sync_router

    source = inspect.getsource(sync_router.machine_delete_cloud_product)
    assert "is_listed = False" in source
    assert "db.delete(" not in source


# ── Machine tokens ────────────────────────────────────────────────────────────


def _machine_row(token_version=1, is_active=True):
    row = MagicMock()
    row.id = uuid.uuid4()
    row.is_active = is_active
    row.token_version = token_version
    return row


def test_machine_token_carries_no_expiry():
    """
    A till does not sign in each morning, so an expiry is not a control — it is a
    scheduled outage on a Sunday with nobody on site. The claim must be absent.
    """
    from jose import jwt

    from app.config import get_settings
    from app.services.auth import create_machine_token

    settings = get_settings()
    token = create_machine_token(str(uuid.uuid4()), 3)
    claims = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    assert "exp" not in claims
    assert claims["type"] == "machine"
    assert claims["tv"] == 3


def test_token_minted_before_the_last_unpair_is_refused():
    from app.middleware.auth import _require_current_token_version

    with pytest.raises(HTTPException) as exc:
        _require_current_token_version({"tv": 1}, _machine_row(token_version=2))
    assert exc.value.status_code == 401


def test_token_matching_the_current_version_is_accepted():
    from app.middleware.auth import _require_current_token_version

    _require_current_token_version({"tv": 2}, _machine_row(token_version=2))


def test_tokens_issued_before_versioning_keep_working():
    """
    Every till paired today holds a token with no `tv` claim. Reading a missing claim
    as version 1 — the column default — is what keeps them trading through this
    change instead of all going dark at once.
    """
    from app.middleware.auth import _require_current_token_version

    _require_current_token_version({}, _machine_row(token_version=1))


def test_a_garbled_version_claim_fails_closed():
    from app.middleware.auth import _require_current_token_version

    with pytest.raises(HTTPException):
        _require_current_token_version({"tv": "not-a-number"}, _machine_row(token_version=1))


def test_unpairing_bumps_the_version_so_revocation_survives_re_pairing():
    """
    Structural: without the bump, a terminal soft-deleted and later re-paired becomes
    active again and starts accepting the tokens it held before.
    """
    from app.routers import machines as machines_router

    source = inspect.getsource(machines_router.delete_machine)
    assert "token_version" in source


# ── Trading day identity ──────────────────────────────────────────────────────
#
# The bug these guard against: `trading_days` was keyed (machine_id, day_date) and
# resolution fell back to that pair with no status filter, so an evening shift on the
# same date resolved to the morning's already-closed day. Its Z then came back
# "duplicate" with HTTP 200, which the till read as success before purging the shift's
# documents.


def test_trading_day_resolution_is_by_id_only():
    """
    Structural. A fallback to (machine, date) is what merged two shifts; if it comes
    back, the merge comes back with it — silently, and only for shops that run two
    shifts on one date.
    """
    import app.services.transactions as tx

    source = inspect.getsource(tx.get_or_create_trading_day)
    assert "TradingDay.id == trading_day_id" in source
    assert "day_date == day_date" not in source
    assert "TradingDay.day_date" not in source


def test_trading_day_table_no_longer_keys_on_calendar_date():
    from app.models.trading_day import TradingDay

    constraint_names = {c.name for c in TradingDay.__table__.constraints if c.name}
    assert "uq_trading_day_machine_date" not in constraint_names

    index_names = {i.name for i in TradingDay.__table__.indexes}
    assert "uq_trading_day_one_open" in index_names, "the one-open-day rule must be enforced"


def test_one_open_day_index_is_partial_and_unique():
    """A till may hold many days on one date; only one of them may be open."""
    from app.models.trading_day import TradingDay

    index = next(i for i in TradingDay.__table__.indexes if i.name == "uq_trading_day_one_open")
    assert index.unique is True
    assert [c.name for c in index.columns] == ["machine_id"]
    where = index.dialect_options["postgresql"]["where"]
    assert "open" in str(where)


def test_trading_day_carries_a_sequence_number():
    from app.models.trading_day import TradingDay

    column = TradingDay.__table__.columns["sequence_number"]
    # Nullable: days opened before this have no number, and inventing one would
    # fabricate a fiscal ordering that never existed.
    assert column.nullable is True
