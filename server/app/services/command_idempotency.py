"""
"פקודות שנשלחו" — the dashboard sends every command to a device fire-and-forget: the request
only queues the command (the device takes it on its wake-up or heartbeat and answers later),
and returns at once with the command's id and status. Nothing on the server waits for a device.

Because the dashboard may retry a send (a dropped connection, a double click, "נסה שוב" after a
network error), every command endpoint takes an optional `Idempotency-Key` header (a client
uuid). The first request with a key runs; a retry with the same key — same tenant, same kind,
same user, same request — gets the very same answer back (the same command ids), and never makes
a second command. A key reused for another request is refused (422), another user's key too
(409). Keys are kept for a day.

Exactly once even when two retries race: the key row is written in the same transaction as the
command(s); the loser's insert fails on the unique key, its whole transaction (its command too)
is rolled back, and it answers with the winner's response.

Kinds: `device_command` (POST /device-commands), `card_command`
(POST /failed-payments/{id}/card-commands — the money rules of app/services/card_attempt_commands.py
untouched), `kiosk_command` (POST /kiosks/{m}/commands), `till_message` (POST /till-messages),
`printer_test` (POST /printers/{id}/test).
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.command_request_key import CommandRequestKey

logger = logging.getLogger(__name__)

#: The request header the dashboard sends.
KEY_HEADER = "Idempotency-Key"
#: The response header on an answer replayed from an earlier request with the same key.
REPLAY_HEADER = "Idempotent-Replayed"
#: A key answers its retries this long; older rows are pruned on the way.
KEEP_FOR = timedelta(hours=24)
KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{8,100}$")
KINDS = ("device_command", "card_command", "kiosk_command", "till_message", "printer_test")


def _now(now: Optional[datetime] = None) -> datetime:
    return now or datetime.now(timezone.utc)


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def normalize(key: Optional[str]) -> Optional[str]:
    """The key as sent, or None without one; `422 idempotency_key_invalid` for a malformed one."""
    if key is None or not isinstance(key, str):
        return None
    key = key.strip()
    if not key:
        return None
    if not KEY_RE.match(key):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "idempotency_key_invalid", "message": "מזהה הבקשה לא תקין"},
        )
    return key


def fingerprint(request: Any) -> str:
    """SHA-256 of the request (its target and body), canonical JSON."""
    raw = json.dumps(request, sort_keys=True, default=str, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def find(
    db: Session, *, tenant_id: Any, kind: str, key: str, user: Any, request_fp: str, now: Optional[datetime] = None,
) -> Optional[CommandRequestKey]:
    """The earlier answer to this key, or None (none, or older than a day — then it is forgotten)."""
    now = _now(now)
    q = db.query(CommandRequestKey).filter(CommandRequestKey.kind == kind, CommandRequestKey.key == key)
    tid = _uuid(tenant_id)
    q = q.filter(CommandRequestKey.tenant_id == tid) if tid is not None else q.filter(CommandRequestKey.tenant_id.is_(None))
    row = q.first()
    if row is None:
        return None
    created = _aware(row.created_at)
    if created is not None and created <= now - KEEP_FOR:
        db.delete(row)
        db.flush()
        return None
    if _uuid(row.user_id) != _uuid(getattr(user, "id", None)):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "idempotency_key_in_use", "message": "מזהה הבקשה כבר שימש משתמש אחר"},
        )
    if row.fingerprint != request_fp:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "idempotency_key_reused", "message": "מזהה הבקשה כבר שימש לבקשה אחרת"},
        )
    return row


def remember(
    db: Session, *, tenant_id: Any, kind: str, key: str, user: Any, request_fp: str, response: Any,
    status_code: int = 201, now: Optional[datetime] = None,
) -> CommandRequestKey:
    """The answer to this key, in the caller's transaction (flushed: a racing twin fails here)."""
    now = _now(now)
    row = CommandRequestKey(
        id=uuid.uuid4(),
        tenant_id=_uuid(tenant_id),
        kind=kind,
        key=key,
        user_id=_uuid(getattr(user, "id", None)),
        fingerprint=request_fp,
        response=response,
        status_code=int(status_code),
        created_at=now,
    )
    db.add(row)
    db.flush()
    return row


def prune(db: Session, *, now: Optional[datetime] = None) -> int:
    """Forget keys older than two days (the caller commits)."""
    now = _now(now)
    try:
        return (
            db.query(CommandRequestKey)
            .filter(CommandRequestKey.created_at < now - 2 * KEEP_FOR)
            .delete(synchronize_session=False)
        )
    except Exception:  # noqa: BLE001 - housekeeping only
        logger.warning("could not prune command request keys", exc_info=True)
        return 0


def once(
    db: Session,
    *,
    tenant_id: Any,
    kind: str,
    key: Optional[str],
    user: Any,
    request: Any,
    run: Callable[[], Any],
    after_commit: Optional[Callable[[Any], None]] = None,
    status_code: int = 201,
) -> Tuple[Any, bool]:
    """
    Runs [run] (it makes the command(s) and returns the JSON answer, without committing) once per
    key, commits, then [after_commit] (the device's wake-up). Returns (answer, replayed): a retry
    with the same key gets the first answer and `replayed` True — [run] is not called again.
    Without a key: as before (run, commit, wake).
    """
    if kind not in KINDS:
        raise ValueError(f"unknown kind {kind}")
    key = normalize(key)
    if key is None:
        out = run()
        db.commit()
        if after_commit is not None:
            after_commit(out)
        return out, False
    request_fp = fingerprint(request)
    prior = find(db, tenant_id=tenant_id, kind=kind, key=key, user=user, request_fp=request_fp)
    if prior is not None:
        db.commit()
        return prior.response, True
    out = run()
    try:
        remember(
            db, tenant_id=tenant_id, kind=kind, key=key, user=user, request_fp=request_fp,
            response=out, status_code=status_code,
        )
        prune(db)
        db.commit()
    except IntegrityError:
        # A twin with the same key committed first: drop ours (the command too), answer with its.
        db.rollback()
        prior = find(db, tenant_id=tenant_id, kind=kind, key=key, user=user, request_fp=request_fp)
        if prior is None:
            raise
        logger.info("%s key %s: a racing retry, answered with the first request's response", kind, key)
        return prior.response, True
    if after_commit is not None:
        after_commit(out)
    return out, False
