"""
How every detection point reaches the exceptions log without being rewritten.

* `after_flush` (an ORM session event, installed by app/models/exception_alerts.py) —
  every row of a source model (sources.py) the flush wrote and the source `wants` is
  noted in `session.info` by (source, id). Cheap: a type lookup and an attribute test,
  no SQL.
* `note(db, source, id)` — the same, by hand, for writers that bypass the ORM (a Core
  upsert: the refused documents, a document stored as a numbering conflict).
* `after_commit` — once the work that wrote them is committed, the noted rows are read
  back in a session of their own, written to the log (idempotent per source event) and
  committed; then each NEW entry is matched against the SMS alert rules (engine.py) and
  committed on its own. Anything failing here is logged and swallowed: a detection, a
  sync, a dashboard action never fails because of its log or its SMS.
* `after_rollback` — what was noted in a transaction that did not commit is dropped.

Nothing is recorded for a session that set `info["exception_log_skip"]` (the log's own
sessions, and anyone who opts out).
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy.orm import Session, sessionmaker

from app.services.exception_alerts import sources as SRC

logger = logging.getLogger(__name__)

PENDING = "exception_log_pending"
SKIP = "exception_log_skip"

#: Process-wide switch (a test of something else may turn the log off).
enabled = True


def _pending(session: Session) -> Dict[Tuple[str, Any], bool]:
    return session.info.setdefault(PENDING, {})


def note(session: Session, source: str, ident: Any) -> None:
    """A source row written outside the ORM: record it after the commit."""
    if not enabled or session.info.get(SKIP) or ident is None:
        return
    _pending(session)[(source, ident)] = True


def after_flush(session: Session) -> None:
    if not enabled or session.info.get(SKIP):
        return
    try:
        types = SRC.by_type()
    except Exception:  # noqa: BLE001 - a model that does not import never breaks a flush
        logger.exception("exception log: sources not available")
        return
    for obj in list(session.new) + list(session.dirty):
        source = types.get(type(obj))
        if source is None:
            continue
        try:
            wanted = source.wants(obj)
        except Exception:  # noqa: BLE001 - an attribute not loaded is not worth a failed flush
            wanted = False
        ident = getattr(obj, "id", None)
        if wanted and ident is not None:
            _pending(session)[(source.name, ident)] = True


def after_rollback(session: Session) -> None:
    session.info.pop(PENDING, None)


def after_commit(session: Session) -> None:
    # A savepoint's RELEASE fires `after_commit` too: the outer transaction is still open
    # and its rows are not visible to another connection yet — wait for the real commit.
    if session.in_nested_transaction():
        return
    pending = session.info.pop(PENDING, None)
    if not pending or not enabled or session.info.get(SKIP):
        return
    try:
        bind = session.get_bind()
    except Exception:  # noqa: BLE001 - an unbound session has nothing to read back from
        logger.exception("exception log: session has no bind")
        return
    process(bind, list(pending.keys()))


def open_session(bind: Any) -> Session:
    db = sessionmaker(bind=bind, autoflush=False)()
    db.info[SKIP] = True
    return db


def record_rows(db: Session, keys: Iterable[Tuple[str, Any]], *, backfilled: bool = False) -> List[Any]:
    """Write the log entries of these source rows (the caller commits). Returns the NEW entries' ids."""
    from app.services.exception_alerts import log as L

    ctx = SRC.Ctx(db)
    created: List[Any] = []
    for name, ident in keys:
        source = SRC.by_name(name)
        if source is None:
            continue
        row = db.get(source.model(), ident)
        if row is None:
            continue  # rolled back in a savepoint, or deleted since
        for spec in source.build(ctx, row):
            entry, is_new = L.record(db, spec, backfilled=backfilled)
            if is_new:
                created.append(entry.id)
    return created


def process(bind: Any, keys: List[Tuple[str, Any]], *, provider: Optional[Any] = None) -> List[Any]:
    """Record, commit, then alert on each new entry. Never raises. Returns the new entry ids."""
    from app.models.exception_alerts import ExceptionLogEntry
    from app.services.exception_alerts import engine as E

    db = open_session(bind)
    try:
        try:
            created = record_rows(db, keys)
            db.commit()
        except Exception:  # noqa: BLE001 - see the module docstring
            db.rollback()
            logger.exception("exception log: recording %d source row(s) failed", len(keys))
            return []
        rules_cache: dict = {}
        for entry_id in created:
            try:
                entry = db.get(ExceptionLogEntry, entry_id)
                if entry is not None:
                    E.process_entry(db, entry, provider=provider, rules_cache=rules_cache)
                db.commit()
            except Exception:  # noqa: BLE001 - the entry stands; its SMS is lost, and logged
                db.rollback()
                logger.exception("exception alerts: evaluating entry %s failed", entry_id)
        return created
    finally:
        db.close()
