"""
A short-lived grant that lets one named person do one narrow thing at one till.

The shape follows `PairingSession`: a row the server re-reads on every request, so
a grant can be revoked the moment it needs to be rather than lingering until an
expiry baked into a token.

Why the token is opaque rather than a JWT: every authorised call has to read this
row anyway, to check revocation and to slide the idle window. A JWT's one advantage
— verifying without touching the database — is therefore unavailable, and paying
for it would mean an `exp` claim that can disagree with `expires_at`. An opaque
random string with the state in one place cannot drift.

Why the token is SHA-256 and not bcrypt: it is 32 bytes from `secrets`, not a human
secret, so there is nothing to slow an attacker down about — brute force is off the
table at that entropy. bcrypt here would only add its work factor to every single
request. Human secrets (`users.till_pin_hash`) still get bcrypt.
"""

import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class ElevatedSession(Base):
    """One person's elevated access at one machine, for a bounded time."""

    __tablename__ = "elevated_sessions"
    __table_args__ = (
        # Every authorised request looks the session up by token and then wants the
        # live ones only, so the lookup and the liveness test share an index.
        Index("ix_elevated_sessions_token", "token_hash"),
        Index("ix_elevated_sessions_user_created", "user_id", "created_at"),
        Index("ix_elevated_sessions_machine_created", "machine_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    #: SHA-256 hex of the bearer token. The token itself is returned once, at grant
    #: time, and never stored anywhere on the server or on the device's disk.
    token_hash = Column(String(64), nullable=False, unique=True)

    #: The dashboard user who authenticated. Not a `pos_users` row: authorisation
    #: (roles, company descent) lives on `users`, and building elevation on
    #: `PosUserRole` would mean a second permission model beside the real one.
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)

    #: The till that asked. Its shop is the ceiling: even a distributor's grant
    #: reaches no further than the machine standing in front of them.
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=False)

    #: Denormalised from the machine at grant time so a later machine reassignment
    #: cannot silently move a live grant to a different shop.
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=False, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)

    #: Granted scope strings, as a JSON array. Stored on the row rather than only
    #: in the token so that revoking, auditing and answering "what could this
    #: session do" all read the same source.
    scopes = Column(JSONB, nullable=False)

    #: Idle deadline. Slides forward on every authorised call, so someone actively
    #: working never expires mid-task.
    expires_at = Column(DateTime(timezone=True), nullable=False)

    #: Hard ceiling that sliding cannot pass, so a grant can never outlive a shift.
    absolute_expires_at = Column(DateTime(timezone=True), nullable=False)

    #: When this grant's one per-action use was spent, or NULL while it is unspent.
    #:
    #: A timestamp rather than a boolean because the question an audit asks is *when*
    #: a refund was authorised, and a flag would answer only *whether*. Set once and
    #: never cleared: re-authorising means a new PIN and therefore a new row.
    #:
    #: Meaningless on a grant that holds no per-action scope, which is why a
    #: `catalog:write` session never reads it — see `session_has_scope`.
    per_action_consumed_at = Column(DateTime(timezone=True), nullable=True)

    revoked_at = Column(DateTime(timezone=True), nullable=True)
    last_used_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    user = relationship("User")
    machine = relationship("POSMachine")
    shop = relationship("Shop")
