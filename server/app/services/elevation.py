"""
Granting, verifying and expiring a till operator's elevated access.

The shape of the thing, in one paragraph: a person at a till proves who they are
with an email and a till PIN, both checked *here* rather than on the device; the
server hands back an opaque token bound to that person, that machine and that
machine's shop; every later write presents the token and the server re-reads this
row to decide whether it is still good. The PIN is never stored on the device and
never travels again after the grant.

Three limits apply independently, so widening one cannot widen the others:

1. the machine's own shop is the ceiling — a distributor elevating at a Dizengoff
   till gets Dizengoff, nothing more;
2. the person's role decides which scopes they could ever hold (`permissions.py`);
3. the device asks for a subset, and only the intersection is granted.

Re-checked on *every* use, not just at grant time: that the session is unrevoked
and unexpired, that the user is still active, and that their role still permits the
scopes they are holding. A manager demoted or deactivated mid-session therefore
stops being able to act immediately, rather than at the end of their window.

A grant has two halves that live by different rules. Session scopes (`catalog:write`)
slide their idle window on every use, which is the whole point: a manager editing
twenty prices types one PIN. Per-action scopes (`PER_ACTION_SCOPES` — refund,
discount, day close) are spent by the first action that uses them and never answer
again; the rule is enforced *here*, on the server, because the alternative is
trusting whichever APK the device happens to be running.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Iterable, List, Optional, Set, Tuple

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.elevated_session import ElevatedSession
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.services.auth import get_password_hash, verify_password
from app.services.company_hierarchy import user_may_use_machine
from app.services.permissions import (
    Scope,
    requires_per_action_reauth,
    till_grantable_scopes,
)

settings = get_settings()


class PinPolicyError(ValueError):
    """The proposed PIN is not one we will store. Message is safe to show a user."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    """
    Treat a naive timestamp as UTC.

    SQLite (the test database) drops timezones on the way back out, so a column
    written as aware reads back naive. Comparing those raises TypeError, which
    would make expiry checks explode rather than fail closed.
    """
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


# ── The PIN ───────────────────────────────────────────────────────────────────


def validate_pin(pin: str) -> str:
    """
    Check a proposed PIN, returning it normalised, or raise `PinPolicyError`.

    Digits only, because the till's PIN pad has no letters. The weak-PIN rules are
    deliberately few — a long blocklist mostly teaches people to pick the shortest
    thing not on it — but `1234` is refused by name because it is the seeded
    default for `pos_users` and would otherwise be the first thing anyone tries.
    """
    pin = (pin or "").strip()
    if not pin.isdigit():
        raise PinPolicyError("PIN must be digits only")
    if not settings.till_pin_min_length <= len(pin) <= settings.till_pin_max_length:
        raise PinPolicyError(
            f"PIN must be {settings.till_pin_min_length}-{settings.till_pin_max_length} digits"
        )
    if len(set(pin)) == 1:
        raise PinPolicyError("PIN must not be the same digit repeated")
    ascending = all(int(b) - int(a) == 1 for a, b in zip(pin, pin[1:]))
    descending = all(int(a) - int(b) == 1 for a, b in zip(pin, pin[1:]))
    if ascending or descending:
        raise PinPolicyError("PIN must not be a run of consecutive digits")
    return pin


def set_till_pin(db: Session, user: User, pin: str) -> None:
    """
    Store a till PIN for `user`, clearing any lockout.

    Whatever is set in the cloud is what the person types at the till — there is no
    first-use change step. The trade that buys: whoever sets somebody else's PIN
    knows it, so an approval attributed to that person is only as strong as the
    handling of the PIN between setting it and their using it.
    """
    user.till_pin_hash = get_password_hash(validate_pin(pin))
    user.till_pin_set_at = _now()
    user.till_pin_failed_count = 0
    user.till_pin_locked_until = None
    db.add(user)


def clear_till_pin(db: Session, user: User) -> None:
    """Remove a user's till PIN. They can no longer authorise anything at a till."""
    user.till_pin_hash = None
    user.till_pin_set_at = None
    user.till_pin_failed_count = 0
    user.till_pin_locked_until = None
    db.add(user)


def pin_lockout_remaining(user: User) -> Optional[timedelta]:
    """How long until this user may try a PIN again, or None if not locked out."""
    until = _aware(user.till_pin_locked_until)
    if until is None:
        return None
    remaining = until - _now()
    return remaining if remaining.total_seconds() > 0 else None


def verify_till_pin(db: Session, user: User, pin: str) -> bool:
    """
    Check `pin` against the stored hash, recording the attempt.

    Callers must consult `pin_lockout_remaining` first: this function counts a
    failure but does not itself refuse a locked-out user, so that the lockout is
    reported as its own distinct outcome rather than as a wrong PIN.
    """
    if not user.till_pin_hash:
        return False
    if verify_password(pin or "", user.till_pin_hash):
        user.till_pin_failed_count = 0
        user.till_pin_locked_until = None
        db.add(user)
        return True

    user.till_pin_failed_count = int(user.till_pin_failed_count or 0) + 1
    if user.till_pin_failed_count >= settings.till_pin_max_attempts:
        user.till_pin_locked_until = _now() + timedelta(
            minutes=settings.till_pin_lockout_minutes
        )
        user.till_pin_failed_count = 0
    db.add(user)
    return False


# ── The grant ─────────────────────────────────────────────────────────────────


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def grantable_scopes(
    db: Session, user: User, machine: POSMachine, requested: Iterable[Scope]
) -> List[Scope]:
    """
    The scopes `user` may actually hold at `machine`: role ceiling ∩ what was asked.

    Returns empty when the user has no business at this machine at all, so callers
    get one answer to check rather than two.
    """
    if not user_may_use_machine(db, user, machine):
        return []
    allowed = till_grantable_scopes(user.role)
    return [scope for scope in requested if scope in allowed]


def create_session(
    db: Session, user: User, machine: POSMachine, scopes: Iterable[Scope]
) -> Tuple[str, ElevatedSession]:
    """
    Issue a grant, returning the raw token (shown once) and the stored row.

    The shop is copied from the machine rather than referenced through it, so a
    later reassignment of the machine to another shop cannot move a live grant.
    """
    raw = secrets.token_urlsafe(32)
    now = _now()
    session = ElevatedSession(
        token_hash=_hash_token(raw),
        user_id=user.id,
        machine_id=machine.id,
        shop_id=machine.shop_id,
        tenant_id=machine.tenant_id,
        scopes=[scope.value for scope in scopes],
        expires_at=now + timedelta(minutes=settings.elevated_session_idle_minutes),
        absolute_expires_at=now
        + timedelta(hours=settings.elevated_session_absolute_hours),
        last_used_at=now,
    )
    db.add(session)
    db.flush()
    return raw, session


def session_is_live(session: ElevatedSession, *, at: Optional[datetime] = None) -> bool:
    """Unrevoked, inside its idle window, and inside its absolute ceiling."""
    at = at or _now()
    if session.revoked_at is not None:
        return False
    expires = _aware(session.expires_at)
    absolute = _aware(session.absolute_expires_at)
    if expires is None or absolute is None:
        return False
    return at < expires and at < absolute


def resolve_session(db: Session, raw_token: str) -> Optional[ElevatedSession]:
    """
    Look up a live grant by its token and slide the idle window forward.

    Returns None for anything not currently usable — unknown, revoked, expired, or
    held by a user who has since been deactivated or lost the role that granted the
    scopes. Callers turn that single None into a 401; the reasons are deliberately
    not distinguished on the wire, since the till's only useful response to any of
    them is to ask for a PIN again.
    """
    if not raw_token:
        return None
    session = (
        db.query(ElevatedSession)
        .filter(ElevatedSession.token_hash == _hash_token(raw_token))
        .first()
    )
    if session is None:
        return None

    now = _now()
    if not session_is_live(session, at=now):
        return None

    user = session.user
    if user is None or not user.is_active:
        return None

    # A demotion must bite immediately, not at the end of the window.
    still_allowed = till_grantable_scopes(user.role)
    held = session_scopes(session)
    if not held or not held.issubset(still_allowed):
        return None

    # Slide, but never past the absolute ceiling.
    slid = now + timedelta(minutes=settings.elevated_session_idle_minutes)
    absolute = _aware(session.absolute_expires_at)
    session.expires_at = min(slid, absolute) if absolute else slid
    session.last_used_at = now
    db.add(session)
    return session


def session_scopes(session: ElevatedSession) -> Set[Scope]:
    """The scopes named on the row, as `Scope` values. Unknown strings are dropped."""
    return {scope for scope in Scope if scope.value in (session.scopes or [])}


def per_action_spent(session: ElevatedSession) -> bool:
    """True once this grant's single per-action use has been taken."""
    return session.per_action_consumed_at is not None


def session_has_scope(session: ElevatedSession, scope: Scope) -> bool:
    """
    Does this grant still authorise `scope`?

    A per-action scope stops answering the moment the grant is spent, so every caller
    inherits the one-PIN-one-action rule from here rather than each remembering to
    check it. A session scope is untouched: `catalog:write` on a grant whose refund
    has already been used keeps working until the idle window closes.
    """
    if scope.value not in (session.scopes or []):
        return False
    if requires_per_action_reauth(scope) and per_action_spent(session):
        return False
    return True


def usable_scopes(session: ElevatedSession) -> List[str]:
    """
    What this grant can still do, as wire strings, for reporting back to the till.

    Distinct from the `scopes` column, which records what was granted and never
    changes. A device shown a spent `refund` would offer the button and then be
    refused, so what it is told is what is left.
    """
    return [
        scope.value
        for scope in Scope
        if scope.value in (session.scopes or []) and session_has_scope(session, scope)
    ]


def consume_per_action_use(db: Session, session: ElevatedSession) -> bool:
    """
    Spend this grant's one per-action use. False means it was already spent.

    **Why the whole per-action half goes at once** rather than one scope at a time:
    the thing being spent is the PIN, not the scope. A supervisor who typed a PIN to
    approve a refund did not also approve a discount, so a grant holding both is
    finished after either. Session scopes on the same grant are untouched — that is
    `session_has_scope`'s job, and it reads the same column.

    **Why the row is re-read under `FOR UPDATE`** rather than trusting the `session`
    object the caller already holds: that object was loaded before this request
    decided to act, and a second request presenting the same token may have spent the
    grant in between. Locking and re-reading is what makes "exactly once" true under
    concurrency instead of merely usually true — the same reason
    `z_sequence.allocate_shop_z_number` locks its counter row. `populate_existing`
    matters as much as the lock: without it SQLAlchemy hands back the stale identity-map
    copy and the freshly locked row is read for nothing.

    Callers must consume *before* acting, and only once they are sure the action is
    really happening — a request rejected on a precondition must leave the grant
    unspent, or the till's retry finds the manager's PIN already burned.
    """
    if not any(
        requires_per_action_reauth(scope) for scope in session_scopes(session)
    ):
        # Nothing consumable here. Answering True keeps callers from having to know
        # which kind of grant they were handed.
        return True

    locked = (
        db.query(ElevatedSession)
        .filter(ElevatedSession.id == session.id)
        .populate_existing()
        .with_for_update()
        .first()
    )
    if locked is None or locked.per_action_consumed_at is not None:
        return False

    locked.per_action_consumed_at = _now()
    db.add(locked)
    db.flush()
    return True


def revoke_session(db: Session, session: ElevatedSession) -> None:
    session.revoked_at = _now()
    db.add(session)
