"""
Who is signed in at which till — "עובד מחובר בקופה אחת בלבד" (docs/SPEC_EXCLUSIVE_LOGIN.md).

One row per sign-in of a till user at a till, kept after it ends (`released_at`) as a
small history: who released it and how (`released_by`):

* ``self``    — the employee signed out at that till (or switched user, or the idle lock);
* ``manager`` — a manager released it: at another till with their PIN (the employee
  moved there), or from the dashboard;
* ``stale``   — its till went silent for longer than `exclusiveUserLoginStaleMinutes`,
  and the next claim elsewhere took it over;
* ``unpair``  — its till was unpaired, deactivated, replaced or moved to another shop.

The rule itself — one live session per till user — is a partial unique index, so two
tills claiming the same employee at the same moment cannot both win.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, Index, String, event, inspect, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.sql import func

from app.database import Base

RELEASED_BY = ("self", "manager", "stale", "unpair")


class PosUserSession(Base):
    __tablename__ = "pos_user_sessions"
    __table_args__ = (
        Index(
            "uq_pos_user_sessions_active_user",
            "pos_user_id",
            unique=True,
            postgresql_where=text("released_at IS NULL"),
            sqlite_where=text("released_at IS NULL"),
        ),
        Index("ix_pos_user_sessions_machine", "machine_id", "released_at"),
        Index("ix_pos_user_sessions_shop", "shop_id", "released_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=True)
    pos_user_id = Column(UUID(as_uuid=True), ForeignKey("pos_users.id", ondelete="CASCADE"), nullable=False)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False)

    started_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: The till's last claim or heartbeat for this employee.
    last_seen_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    released_at = Column(DateTime(timezone=True), nullable=True)
    #: self | manager | stale | unpair (`RELEASED_BY`).
    released_by = Column(String(16), nullable=True)
    #: The manager who released it (a till user's or a cloud account's name).
    released_by_name = Column(String(200), nullable=True)
    #: A forced release at a till: the till the employee moved to. Null from the dashboard.
    released_by_machine_id = Column(UUID(as_uuid=True), nullable=True)


# ── A till that leaves releases its sessions ─────────────────────────────────


def _changed(state, key: str) -> bool:
    history = state.attrs[key].history
    if not history.has_changes():
        return False
    if history.deleted and history.added:
        return history.deleted[0] != history.added[0]
    return True


@event.listens_for(OrmSession, "before_flush")
def _release_sessions_of_departing_tills(session, _flush_context, _instances) -> None:
    """
    Unpairing, deactivating, replacing (a new token version) or moving a till to another
    shop ends whatever sign-ins it held — `released_by = "unpair"`. Here, in the flush,
    rather than at each of the places that do those things, so none of them can forget.
    A deleted till takes its rows with it (ON DELETE CASCADE).
    """
    from app.models.pos_machine import POSMachine

    departing = []
    for obj in session.dirty:
        if not isinstance(obj, POSMachine) or obj.id is None:
            continue
        state = inspect(obj)
        if (
            _changed(state, "token_version")
            or _changed(state, "shop_id")
            or (_changed(state, "is_active") and obj.is_active is False)
        ):
            departing.append(obj.id)
    if not departing:
        return
    with session.no_autoflush:
        # A database this model's migration has not reached yet (or a test that made only
        # some tables) has nothing to release.
        if not inspect(session.connection()).has_table(PosUserSession.__tablename__):
            return
        rows = (
            session.query(PosUserSession)
            .filter(PosUserSession.machine_id.in_(departing), PosUserSession.released_at.is_(None))
            .all()
        )
    now = datetime.now(timezone.utc)
    for row in rows:
        row.released_at = now
        row.released_by = "unpair"
