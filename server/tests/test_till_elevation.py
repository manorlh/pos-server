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
    # A cloud account's grant. Set explicitly: an unset MagicMock attribute is a
    # truthy mock, which would read as "held by a till user" and test the wrong branch.
    row.user_id = user.id if user is not None else None
    row.pos_user_id = None
    row.pos_user = None
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


def test_every_till_catalog_endpoint_still_requires_catalog_authority():
    """
    Structural guard. These six endpoints once took a machine token and nothing
    else, and could rewrite any product in the tenant. If a future edit drops the
    dependency they go back to exactly that, silently — so assert the signature
    rather than trusting review.

    Stricter than it used to be. The old check accepted *any* `Depends`, so swapping
    the gate for an unrelated dependency would have passed it. It now has to be the
    dependency `require_catalog_authority` builds — a grant, or a signed-in operator
    whose role the cloud itself confirms.
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
        assert "actor" in params, f"{handler.__name__} lost its authority parameter"
        dependency = getattr(params["actor"].default, "dependency", None)
        assert dependency is not None, f"{handler.__name__} no longer depends on anything"
        assert dependency.__qualname__.startswith("require_catalog_authority."), (
            f"{handler.__name__} is gated by {dependency.__qualname__}, "
            "not require_catalog_authority"
        )


def test_the_unguarded_batch_catalog_write_stays_retired():
    """
    `POST /sync/{id}/catalog` wrote with a machine token alone and looked rows up by id
    with no tenant check, so any paired till could rewrite any tenant's catalog. It is
    closed. Guard both halves: it answers 410, and the helpers it wrote through are gone
    so nothing can quietly wire them back in.
    """
    from app.routers import sync as sync_router

    with pytest.raises(HTTPException) as exc:
        sync_router.post_catalog_changes("m", machine=MagicMock())
    assert exc.value.status_code == 410

    params = inspect.signature(sync_router.post_catalog_changes).parameters
    assert "body" not in params, "the retired endpoint must not parse a change batch"
    assert not hasattr(sync_router, "_apply_product_change")
    assert not hasattr(sync_router, "_apply_category_change")


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


# ── Shift identity ────────────────────────────────────────────────────────────
#
# The bug these guard against: `trading_days` was keyed (machine_id, day_date) and
# resolution fell back to that pair with no status filter, so an evening shift on the
# same date resolved to the morning's already-closed day. Behaviour is covered in
# test_shift_identity.py; these pin the table shape.


def test_shift_resolution_is_by_id_only():
    """Structural backstop to the behavioural tests: no (machine, date) fallback."""
    import app.services.shifts as shifts

    source = inspect.getsource(shifts.resolve_shift_for_document)
    assert "Shift.id == shift_id" in source
    assert "business_date ==" not in source


def test_shift_table_does_not_key_on_calendar_date():
    from app.models.shift import Shift

    constraint_names = {c.name for c in Shift.__table__.constraints if c.name}
    assert "uq_trading_day_machine_date" not in constraint_names

    index_names = {i.name for i in Shift.__table__.indexes}
    assert "uq_shift_one_open" in index_names, "the one-open-shift rule must be enforced"


def test_one_open_shift_index_is_partial_and_unique():
    """A till may hold many shifts on one date; only one of them may be open."""
    from app.models.shift import Shift

    index = next(i for i in Shift.__table__.indexes if i.name == "uq_shift_one_open")
    assert index.unique is True
    assert [c.name for c in index.columns] == ["machine_id"]
    where = index.dialect_options["postgresql"]["where"]
    assert "open" in str(where)


def test_shift_carries_a_sequence_number():
    from app.models.shift import Shift

    column = Shift.__table__.columns["sequence_number"]
    # Nullable: shifts from before it have no number, and inventing one would fabricate
    # an ordering that never existed.
    assert column.nullable is True


# ── Per-action grants are single-use ──────────────────────────────────────────
#
# The gap these cover: `PER_ACTION_SCOPES` was declared and enforced nowhere on the
# server, so a grant for `refund` stayed good for the whole idle window and "one PIN,
# one refund" lived only in the Android client's in-memory bookkeeping. An older or
# modified APK honoured none of it — one PIN bought an afternoon of refunds.


class _Grant:
    """A stored grant. A real object, not a MagicMock: absent means absent."""

    def __init__(self, scopes, consumed_at=None, grant_id=None):
        self.id = grant_id or uuid.uuid4()
        self.scopes = list(scopes)
        self.per_action_consumed_at = consumed_at
        self.machine_id = uuid.uuid4()
        self.user_id = uuid.uuid4()


class _ConsumeSession(_Session):
    """Hands back one row under `FOR UPDATE`, and counts how it was asked for."""

    def __init__(self, locked_row):
        super().__init__()
        self.locked_row = locked_row
        self.locks = 0
        self.populate_existing_calls = 0
        self.flushes = 0

    def query(self, *_entities):
        outer = self

        class _Q:
            def filter(self, *_c):
                return self

            def populate_existing(self):
                outer.populate_existing_calls += 1
                return self

            def with_for_update(self):
                outer.locks += 1
                return self

            def first(self):
                return outer.locked_row

        return _Q()

    def flush(self):
        self.flushes += 1


def test_a_refund_grant_authorises_exactly_one_refund():
    grant = _Grant(["refund"])
    db = _ConsumeSession(grant)

    assert elevation.session_has_scope(grant, Scope.REFUND) is True
    assert elevation.consume_per_action_use(db, grant) is True

    assert elevation.session_has_scope(grant, Scope.REFUND) is False
    assert elevation.consume_per_action_use(db, grant) is False


def test_one_pin_buys_one_action_not_one_of_each_kind():
    """
    A supervisor who typed a PIN to approve a refund did not also approve a discount.
    The thing spent is the PIN, so the whole per-action half of the grant goes at once.
    """
    grant = _Grant(["refund", "discount", "day:close"])
    db = _ConsumeSession(grant)

    assert elevation.consume_per_action_use(db, grant) is True

    assert elevation.session_has_scope(grant, Scope.REFUND) is False
    assert elevation.session_has_scope(grant, Scope.DISCOUNT) is False
    assert elevation.session_has_scope(grant, Scope.DAY_CLOSE) is False


def test_a_session_scope_is_never_spent_and_never_locks_a_row():
    """
    `catalog:write` exists so a manager editing twenty prices types one PIN. If
    consuming touched it, the sliding window would be pointless.
    """
    grant = _Grant(["catalog:write"])
    db = _ConsumeSession(grant)

    for _ in range(3):
        assert elevation.consume_per_action_use(db, grant) is True

    assert grant.per_action_consumed_at is None
    assert elevation.session_has_scope(grant, Scope.CATALOG_WRITE) is True
    assert db.locks == 0


def test_spending_the_refund_half_leaves_catalog_write_working():
    """A mixed grant loses only the half that was spent."""
    grant = _Grant(["catalog:write", "refund"])
    db = _ConsumeSession(grant)

    assert elevation.consume_per_action_use(db, grant) is True

    assert elevation.session_has_scope(grant, Scope.REFUND) is False
    assert elevation.session_has_scope(grant, Scope.CATALOG_WRITE) is True


def test_a_spent_grant_still_slides_its_window_for_the_session_half():
    """
    Resolution is about liveness, not about what is left. A mixed grant whose refund
    has been used is still a live session for the catalog, and must keep sliding.
    """
    row = _live_row(_user(), scopes=("catalog:write", "refund"))
    row.per_action_consumed_at = _now()
    before = row.expires_at

    assert elevation.resolve_session(_LookupSession(row), "token") is row
    assert row.expires_at > before


def test_a_concurrent_request_that_already_spent_the_grant_wins():
    """
    The race. Two requests present the same token; each loaded the row before the
    other wrote to it, so both hold a copy saying "unspent". Trusting the copy in hand
    lets both refunds through, which is the entire failure this feature exists to stop.
    The locked re-read is what decides it.
    """
    shared_id = uuid.uuid4()
    in_hand = _Grant(["refund"], grant_id=shared_id)
    as_committed_by_the_other_request = _Grant(
        ["refund"], consumed_at=_now(), grant_id=shared_id
    )
    db = _ConsumeSession(as_committed_by_the_other_request)

    assert elevation.consume_per_action_use(db, in_hand) is False
    assert db.locks == 1


def test_the_grant_is_re_read_under_the_lock_rather_than_reused_from_the_session():
    """
    `populate_existing` is not decoration. Without it SQLAlchemy returns the stale
    identity-map copy and the freshly locked row is read for nothing — the lock is
    taken, the SQL is correct, and the stale value is still what gets checked. There
    is no way to observe that without a database, so the call is asserted directly.
    """
    grant = _Grant(["refund"])
    db = _ConsumeSession(grant)

    elevation.consume_per_action_use(db, grant)

    assert db.populate_existing_calls == 1


def test_the_consuming_lock_compiles_to_select_for_update():
    """The ORM call is only as good as the SQL it produces."""
    from sqlalchemy.dialects import postgresql
    from sqlalchemy.orm import sessionmaker

    from app.models.elevated_session import ElevatedSession

    session = sessionmaker()()
    sql = str(
        session.query(ElevatedSession)
        .filter(ElevatedSession.id == uuid.uuid4())
        .with_for_update()
        .statement.compile(dialect=postgresql.dialect())
    )

    assert "FOR UPDATE" in sql


def test_a_till_is_told_what_is_left_not_what_was_granted():
    """
    A device still shown a spent `refund` offers the button and is refused on press.
    What it is told is what it can still do.
    """
    grant = _Grant(["catalog:write", "refund"], consumed_at=_now())

    assert elevation.usable_scopes(grant) == ["catalog:write"]


# ── The gate spends what it authorised ────────────────────────────────────────


def _elevated_dependency_call(dependency, *, grant, db, token="token", machine=None):
    """Invoke a `require_elevated` / `elevation_if_offered` dependency directly."""
    target = machine or MagicMock()
    if machine is None:
        target.id = grant.machine_id if grant is not None else uuid.uuid4()
    return dependency(machine=target, elevation_token=token, db=db)


def test_a_per_action_endpoint_spends_the_grant_it_just_authorised(monkeypatch):
    """
    The server-side half of "one PIN, one refund". Without it the rule is whatever the
    APK in the shop chooses to enforce.
    """
    from app.middleware import auth as auth_module

    grant = _Grant(["refund"])
    db = _ConsumeSession(grant)
    monkeypatch.setattr(auth_module, "resolve_session", lambda *_a, **_k: grant)
    dependency = auth_module.require_elevated(Scope.REFUND)

    assert _elevated_dependency_call(dependency, grant=grant, db=db) is grant

    with pytest.raises(HTTPException) as exc:
        _elevated_dependency_call(dependency, grant=grant, db=db)
    assert exc.value.status_code == 401
    assert exc.value.detail == "elevation_already_used"


def test_a_catalog_endpoint_may_be_called_all_afternoon(monkeypatch):
    from app.middleware import auth as auth_module

    grant = _Grant(["catalog:write"])
    db = _ConsumeSession(grant)
    monkeypatch.setattr(auth_module, "resolve_session", lambda *_a, **_k: grant)
    dependency = auth_module.require_elevated(Scope.CATALOG_WRITE)

    for _ in range(3):
        assert _elevated_dependency_call(dependency, grant=grant, db=db) is grant


def test_a_scope_never_granted_is_a_different_answer_from_one_already_spent(monkeypatch):
    """
    403 means fetch a different person; 401 means the same person types their PIN
    again. Collapsing them sends the till to the wrong remedy.
    """
    from app.middleware import auth as auth_module

    never_granted = _Grant(["catalog:write"])
    monkeypatch.setattr(auth_module, "resolve_session", lambda *_a, **_k: never_granted)
    with pytest.raises(HTTPException) as exc:
        _elevated_dependency_call(
            auth_module.require_elevated(Scope.REFUND),
            grant=never_granted,
            db=_ConsumeSession(never_granted),
        )
    assert exc.value.status_code == 403

    spent = _Grant(["refund"], consumed_at=_now())
    monkeypatch.setattr(auth_module, "resolve_session", lambda *_a, **_k: spent)
    with pytest.raises(HTTPException) as exc:
        _elevated_dependency_call(
            auth_module.require_elevated(Scope.REFUND),
            grant=spent,
            db=_ConsumeSession(spent),
        )
    assert exc.value.status_code == 401


# ── Elevation that is offered, not demanded ───────────────────────────────────


def test_a_close_with_no_token_is_not_refused():
    """
    The till operator is a `pos_users` row — a different enum from the cloud roles
    grants come from — so a manager-operated till holds the authority already and
    elevates for nothing. Demanding a token would lock it out of closing its own day.
    """
    from app.middleware import auth as auth_module

    dependency = auth_module.elevation_if_offered(Scope.DAY_CLOSE)
    assert dependency(machine=MagicMock(), elevation_token=None, db=_Session()) is None


def test_an_offered_token_is_checked_as_strictly_as_a_demanded_one(monkeypatch):
    """A bad claim of approval fails the request rather than being quietly dropped."""
    from app.middleware import auth as auth_module

    monkeypatch.setattr(auth_module, "resolve_session", lambda *_a, **_k: None)
    with pytest.raises(HTTPException) as exc:
        auth_module.elevation_if_offered(Scope.DAY_CLOSE)(
            machine=MagicMock(), elevation_token="stale", db=_Session()
        )
    assert exc.value.status_code == 401


def test_offering_a_token_does_not_by_itself_spend_it(monkeypatch):
    """
    The Z upsert can still answer 409 and send the till away to flush its outbox.
    Spending on the way in would burn the manager's PIN on a close that did not
    happen, and the retry would arrive with nothing left to present.
    """
    from app.middleware import auth as auth_module

    grant = _Grant(["day:close"])
    db = _ConsumeSession(grant)
    monkeypatch.setattr(auth_module, "resolve_session", lambda *_a, **_k: grant)

    machine = MagicMock()
    machine.id = grant.machine_id
    resolved = auth_module.elevation_if_offered(Scope.DAY_CLOSE)(
        machine=machine, elevation_token="token", db=db
    )

    assert resolved is grant
    assert grant.per_action_consumed_at is None
    assert elevation.session_has_scope(grant, Scope.DAY_CLOSE) is True


def test_a_grant_cannot_be_carried_to_the_next_terminal(monkeypatch):
    """
    Untested until the gate's checks were pulled into one helper, and the easiest
    thing to lose there: a grant is bound to the till it was issued at, so a manager
    elevating at register 1 has not elevated register 2 beside it.
    """
    from app.middleware import auth as auth_module

    grant = _Grant(["catalog:write"])
    monkeypatch.setattr(auth_module, "resolve_session", lambda *_a, **_k: grant)
    other_terminal = MagicMock()
    other_terminal.id = uuid.uuid4()

    with pytest.raises(HTTPException) as exc:
        auth_module.require_elevated(Scope.CATALOG_WRITE)(
            machine=other_terminal, elevation_token="token", db=_ConsumeSession(grant)
        )
    assert exc.value.status_code == 403
    assert exc.value.detail == "elevation_wrong_machine"


def test_a_gated_endpoint_with_no_token_at_all_says_so(monkeypatch):
    from app.middleware import auth as auth_module

    with pytest.raises(HTTPException) as exc:
        auth_module.require_elevated(Scope.CATALOG_WRITE)(
            machine=MagicMock(), elevation_token=None, db=_Session()
        )
    assert exc.value.status_code == 401
    assert exc.value.detail == "elevation_required"


def test_a_dead_grant_is_reported_as_expired_whatever_killed_it(monkeypatch):
    """
    Revoked, expired, unknown, demoted and deactivated are one answer on the wire:
    the till's only useful response to any of them is to ask for a PIN again.
    """
    from app.middleware import auth as auth_module

    monkeypatch.setattr(auth_module, "resolve_session", lambda *_a, **_k: None)
    with pytest.raises(HTTPException) as exc:
        auth_module.require_elevated(Scope.CATALOG_WRITE)(
            machine=MagicMock(), elevation_token="dead", db=_Session()
        )
    assert exc.value.status_code == 401
    assert exc.value.detail == "elevation_expired"
