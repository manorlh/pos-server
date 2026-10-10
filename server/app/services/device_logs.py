"""
"שליחת לוגים לענן" (the device-logs contract, specs/device-logs-api.md) — a till, kiosk or tablet
sends its logs to the cloud; support reads them without touching the device.

**Upload** (`POST /sync/{machine_id}/device-logs`, the machine token): the device's gzip of its
already-scrubbed log (§4 on the device), base64. Idempotent per machine by `upload_id` (a resend
answers with the same id and `duplicate: true`). Refused: `413 device_logs_too_large` — more than
3 MB compressed (the gzip bytes; the base64 text up to 4 MB) or more than 25 MB inflated (checked
by streaming gunzip with that cap, never inflated whole); `429 device_logs_rate_limited` — more
than 20 uploads of the machine in the last hour. The content is never inflated in storage; the
`note` is scrubbed again here (app/services/log_scrub.py). With a `command_id` the upload answers
its `upload_logs` command: the command's result is `{"log_id": …}` and it is done.

**Who reads** (§3): the content — a super admin ("תמיכה"), and a distributor with access to the
device's organization (a member of its tenant). An organization's manager with
`device_control` at edit may *request* logs and sees "נשלח / התקבל", never the content or the note.

**Request** ("בקש לוגים"): an `upload_logs` device command, `params` {"minutes": 15–1440, default
120}; fire-and-forget like every command (app/services/device_commands.py), any time — mid-sale
too. A device whose heartbeat never said `device_logs_v1` shows "גרסה ישנה — עדכן".

**Kept** `DEVICE_LOGS_RETENTION_DAYS` (default 30; 0 = kept): the nightly pass
(app/services/device_logs_retention.py) deletes older uploads.
"""
from __future__ import annotations

import base64
import binascii
import codecs
import logging
import math
import uuid
import zlib
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, defer

from app.models.device_command import DeviceCommand
from app.models.device_log_upload import REASONS, DeviceLogUpload
from app.models.pos_machine import POSMachine
from app.models.user import UserRole
from app.services import device_commands as cmd_svc
from app.services.log_scrub import scrub

logger = logging.getLogger(__name__)

MB = 1024 * 1024
#: The compressed (gzip) content, at most.
MAX_COMPRESSED_BYTES = 3 * MB
#: The content once inflated, at most (checked while streaming, never inflated whole).
MAX_INFLATED_BYTES = 25 * MB
#: Uploads per machine in any hour, at most.
MAX_UPLOADS_PER_HOUR = 20
RATE_WINDOW = timedelta(hours=1)
#: "בקש לוגים": the minutes the device collects.
MINUTES_MIN, MINUTES_MAX, MINUTES_DEFAULT = 15, 1440, 120
#: "צפה": the first lines shown (a search returns at most this many matching lines).
VIEW_LINES = 2000
#: The note, at most (§1).
NOTE_MAX = 500
#: What a heartbeat reports when its build can upload logs.
CAPABILITY = "device_logs_v1"
#: The action of a remote request.
ACTION = "upload_logs"
#: The zone of the dashboard's date filters and the nightly pass.
ZONE = "Asia/Jerusalem"

TOO_LARGE = "device_logs_too_large"
RATE_LIMITED = "device_logs_rate_limited"
BAD_CONTENT = "device_logs_bad_content"

_CHUNK = 64 * 1024
_B64_MAX_CHARS = 4 * math.ceil(MAX_COMPRESSED_BYTES / 3)
_WHITESPACE = str.maketrans("", "", " \t\r\n")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    value = _aware(value)
    return value.isoformat() if value is not None else None


def _error(status_code: int, code: str, message: str, headers: Optional[Dict[str, str]] = None) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message}, headers=headers)


def _too_large() -> HTTPException:
    return _error(
        status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, TOO_LARGE,
        "הלוג גדול מדי (עד 3MB דחוס, עד 25MB פרוס)",
    )


def _bad_content() -> HTTPException:
    return _error(status.HTTP_422_UNPROCESSABLE_ENTITY, BAD_CONTENT, "תוכן הלוג אינו gzip+base64 תקין")


# ── The request's parameters ─────────────────────────────────────────────────


def request_params(raw: Any) -> Dict[str, int]:
    """`upload_logs` params: {"minutes": 15–1440}, 120 when absent. ValueError (a 422) otherwise."""
    minutes: Any = None
    if raw is not None:
        if not isinstance(raw, dict):
            raise ValueError("params must be an object")
        minutes = raw.get("minutes")
    if minutes is None:
        return {"minutes": MINUTES_DEFAULT}
    if isinstance(minutes, bool) or not isinstance(minutes, (int, float)) or float(minutes) != int(minutes):
        raise ValueError("minutes must be a whole number")
    minutes = int(minutes)
    if not MINUTES_MIN <= minutes <= MINUTES_MAX:
        raise ValueError(f"minutes must be {MINUTES_MIN}–{MINUTES_MAX}")
    return {"minutes": minutes}


# ── The content ──────────────────────────────────────────────────────────────


def decode_content(content: str) -> bytes:
    """The gzip bytes of `content` (base64; line breaks tolerated). 413 over 3 MB, 422 unreadable."""
    text = content.translate(_WHITESPACE) if any(c in content for c in " \t\r\n") else content
    if len(text) > _B64_MAX_CHARS:
        raise _too_large()
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise _bad_content()
    if len(raw) > MAX_COMPRESSED_BYTES:
        raise _too_large()
    if not raw:
        raise _bad_content()
    return raw


def _inflate_chunks(gz: bytes, cap: int = MAX_INFLATED_BYTES) -> Iterator[bytes]:
    """
    The inflated bytes of [gz] (one or more gzip members), chunk by chunk, never more than [cap]
    in all (413 past it). Never holds more than one chunk: a gzip bomb stops at the cap.
    """
    total = 0
    data = gz
    while True:
        d = zlib.decompressobj(16 + zlib.MAX_WBITS)
        while True:
            try:
                chunk = d.decompress(data, _CHUNK)
            except zlib.error:
                raise _bad_content()
            if chunk:
                total += len(chunk)
                if total > cap:
                    raise _too_large()
                yield chunk
            data = d.unconsumed_tail
            if d.eof:
                break
            if not data and not chunk:
                raise _bad_content()  # cut short
        rest = d.unused_data
        if not rest.strip(b"\x00"):
            return
        data = rest  # another gzip member follows


def inflated_size(gz: bytes, cap: int = MAX_INFLATED_BYTES) -> int:
    """The inflated size, counted while streaming with [cap] (413 past it, 422 not gzip)."""
    return sum(len(chunk) for chunk in _inflate_chunks(gz, cap))


def iter_text(gz: bytes) -> Iterator[str]:
    """The log as UTF-8 text, chunk by chunk (an invalid byte reads as U+FFFD)."""
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    for chunk in _inflate_chunks(gz):
        text = decoder.decode(chunk)
        if text:
            yield text
    tail = decoder.decode(b"", final=True)
    if tail:
        yield tail


def iter_lines(gz: bytes) -> Iterator[str]:
    """The log's lines, without their line ends."""
    pending = ""
    for text in iter_text(gz):
        pending += text
        parts = pending.split("\n")
        pending = parts.pop()
        for line in parts:
            yield line[:-1] if line.endswith("\r") else line
    if pending:
        yield pending[:-1] if pending.endswith("\r") else pending


def view_lines(gz: bytes, *, query: Optional[str] = None, limit: int = VIEW_LINES) -> Dict[str, Any]:
    """
    "צפה": the first [limit] lines, numbered from 1; with [query] (case-insensitive), the first
    [limit] lines that contain it, anywhere in the log. `more`: lines were left out.
    """
    needle = (query or "").strip().casefold() or None
    out: List[Dict[str, Any]] = []
    more = False
    scanned = 0
    for number, line in enumerate(iter_lines(gz), start=1):
        scanned = number
        if needle is not None and needle not in line.casefold():
            continue
        if len(out) >= limit:
            more = True
            break
        out.append({"n": number, "text": line})
    return {"lines": out, "more": more, "query": query or None, "scannedLines": scanned}


# ── Capability ───────────────────────────────────────────────────────────────


def clean_capabilities(raw: Any) -> Optional[List[str]]:
    """The heartbeat's `capabilities`: short ASCII words, unique, sorted; None when not a list."""
    if not isinstance(raw, (list, tuple)):
        return None
    out = set()
    for item in list(raw)[:64]:
        if isinstance(item, str):
            word = item.strip()
            if 0 < len(word) <= 64 and word.isascii():
                out.add(word)
    return sorted(out)


def apply_heartbeat(machine: POSMachine, capabilities: Any, app_version: Optional[str], *, now: Optional[datetime] = None) -> None:
    """The beat's `capabilities` onto the machine. Absent (an older build): as it was. Never raises."""
    try:
        words = clean_capabilities(capabilities)
        if words is None:
            return
        machine.reported_capabilities = {
            "list": words,
            "appVersion": app_version or getattr(machine, "app_version", None),
            "at": _iso(now or utc_now()),
        }
    except Exception:  # noqa: BLE001 - a capability never fails a heartbeat
        logger.exception("capabilities not applied for %s", getattr(machine, "id", None))


def capable(machine: POSMachine) -> bool:
    """
    Whether the device's build uploads logs: its heartbeat said `device_logs_v1` — and said it
    with the version it runs now (a build put back to an older one says nothing, so it is old).
    """
    rc = getattr(machine, "reported_capabilities", None) or {}
    if CAPABILITY not in (rc.get("list") or []):
        return False
    said = rc.get("appVersion")
    current = getattr(machine, "app_version", None)
    return said is None or current is None or said == current


# ── Who ──────────────────────────────────────────────────────────────────────


def _user_name(user: Any) -> Optional[str]:
    who = getattr(user, "username", None) or getattr(user, "email", None)
    return who[:200] if who else None


def can_read(db: Session, user: Any, tenant_id: Any) -> bool:
    """The content: a super admin, or a distributor who is a member of that organization."""
    role = getattr(user, "role", None)
    if role == UserRole.SUPER_ADMIN:
        return True
    if role != UserRole.DISTRIBUTOR or tenant_id is None:
        return False
    from app.services.dashboard_access import user_tenant_ids

    return str(tenant_id) in {str(t) for t in user_tenant_ids(db, user)}


def readable_tenant_ids(db: Session, user: Any) -> Optional[List[uuid.UUID]]:
    """The tenants whose logs [user] may read: None = all (a super admin); [] = none."""
    role = getattr(user, "role", None)
    if role == UserRole.SUPER_ADMIN:
        return None
    if role != UserRole.DISTRIBUTOR:
        return []
    from app.services.dashboard_access import user_tenant_ids

    return list(user_tenant_ids(db, user))


def org_requester(db: Session, user: Any, machine: POSMachine) -> bool:
    """
    An organization's manager who may send this device commands ("שליטה מרחוק": `device_control`
    at edit, a machine admin's role, the device in their scope) — they may request logs.
    """
    from app.routers import device_commands as R
    from app.services import dashboard_access as DA
    from app.services import dashboard_sections as DS
    from app.services import kiosk_control

    if getattr(user, "role", None) not in kiosk_control.KIOSK_ROLES or machine.tenant_id is None:
        return False
    if not DA.effective_access(db, user).allows("device_control", DS.EDIT):
        return False
    if str(machine.tenant_id) not in {str(t) for t in DA.user_tenant_ids(db, user)}:
        return False
    try:
        return bool(R._devices(db, user, machine.tenant_id, machine_ids=[machine.id]))
    except HTTPException:
        return False


@dataclass(frozen=True)
class Access:
    read: bool
    request: bool


def access_to(db: Session, user: Any, machine: POSMachine) -> Access:
    read = can_read(db, user, machine.tenant_id)
    request = bool(machine.is_active) and (read or org_requester(db, user, machine))
    return Access(read=read, request=request)


def _forbidden() -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="device_logs_forbidden")


def machine_or_404(db: Session, machine_id: Any) -> POSMachine:
    machine = db.get(POSMachine, machine_id)
    if machine is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="machine_not_found")
    return machine


def readable_upload(db: Session, user: Any, upload_id: Any) -> DeviceLogUpload:
    """The upload, for someone who may read its content; 404 for anyone else (never names it)."""
    row = db.get(DeviceLogUpload, upload_id)
    if row is None or not can_read(db, user, row.tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="device_log_not_found")
    return row


def mark_opened(row: DeviceLogUpload, user: Any, *, now: Optional[datetime] = None) -> None:
    """Viewed or downloaded: no longer "חדש" (the first opening is kept)."""
    if row.opened_at is None:
        row.opened_at = now or utc_now()
        row.opened_by_name = _user_name(user)


# ── Upload ───────────────────────────────────────────────────────────────────


def _clip(value: Optional[str], limit: int) -> Optional[str]:
    if value is None:
        return None
    value = value.strip()
    return value[:limit] or None


def find_upload(db: Session, machine: POSMachine, upload_id: Any) -> Optional[DeviceLogUpload]:
    return (
        db.query(DeviceLogUpload)
        .options(defer(DeviceLogUpload.content))
        .filter(DeviceLogUpload.machine_id == machine.id, DeviceLogUpload.upload_id == upload_id)
        .first()
    )


def check_rate(db: Session, machine: POSMachine, now: datetime) -> None:
    """429 when the machine already uploaded MAX_UPLOADS_PER_HOUR in the last hour."""
    since = now - RATE_WINDOW
    q = db.query(func.count(DeviceLogUpload.id), func.min(DeviceLogUpload.received_at)).filter(
        DeviceLogUpload.machine_id == machine.id, DeviceLogUpload.received_at > since,
    )
    count, oldest = q.one()
    if (count or 0) >= MAX_UPLOADS_PER_HOUR:
        retry = 60
        if oldest is not None:
            retry = max(1, int((_aware(oldest) + RATE_WINDOW - now).total_seconds()) + 1)
        raise _error(
            status.HTTP_429_TOO_MANY_REQUESTS, RATE_LIMITED, "יותר מדי העלאות לוגים בשעה — ננסה שוב מאוחר יותר",
            headers={"Retry-After": str(retry)},
        )


def ingest(db: Session, machine: POSMachine, body: Any, *, now: Optional[datetime] = None) -> Tuple[DeviceLogUpload, bool]:
    """
    One upload: (the row, duplicate). The caller commits. Order: a resend first (its answer is
    the first one's, whatever the rate), then the rate, then the size.
    """
    now = now or utc_now()
    existing = find_upload(db, machine, body.upload_id)
    if existing is not None:
        return existing, True
    check_rate(db, machine, now)
    gz = decode_content(body.content)
    inflated = inflated_size(gz)
    command: Optional[DeviceCommand] = None
    if body.command_id is not None:
        candidate = db.get(DeviceCommand, body.command_id)
        if candidate is not None and candidate.machine_id == machine.id and candidate.action == ACTION:
            command = candidate
        else:
            logger.warning("machine %s sent logs for command %s, not its upload_logs; kept unlinked", machine.id, body.command_id)
    row = DeviceLogUpload(
        id=uuid.uuid4(),
        upload_id=body.upload_id,
        tenant_id=machine.tenant_id,
        branch_id=machine.shop_id,
        machine_id=machine.id,
        reason=body.reason,
        command_id=command.id if command is not None else None,
        requested_by_name=command.created_by_name if command is not None else None,
        note=scrub(_clip(body.note, NOTE_MAX)),
        app_version=_clip(body.app_version, 100),
        version_code=body.version_code,
        device_model=_clip(body.device_model, 100),
        os=_clip(body.os, 100),
        from_ms=body.from_ms,
        to_ms=body.to_ms,
        line_count=body.line_count,
        content_encoding=body.content_encoding,
        content=gz,
        size_bytes=len(gz),
        inflated_bytes=inflated,
        received_at=now,
    )
    db.add(row)
    db.flush()
    if command is not None:
        cmd_svc.answer_with_result(db, machine, command.id, ACTION, {"log_id": str(row.id)}, now=now)
    return row, False


def upload_answer(row: DeviceLogUpload, duplicate: bool) -> Dict[str, Any]:
    """The device's answer (§1): snake_case, as the contract writes it."""
    return {"id": str(row.id), "received_at": _iso(row.received_at), "duplicate": bool(duplicate)}


def ingest_once(db: Session, machine: POSMachine, body: Any) -> Dict[str, Any]:
    """`ingest` and its commit; a racing resend of the same upload answers with the first."""
    try:
        row, duplicate = ingest(db, machine, body)
        db.commit()
    except IntegrityError:
        db.rollback()
        row = find_upload(db, machine, body.upload_id)
        if row is None:
            raise
        duplicate = True
    return upload_answer(row, duplicate)


# ── The dashboard ────────────────────────────────────────────────────────────


def is_new(row: DeviceLogUpload) -> bool:
    """"חדש": a manual upload with a note, not opened yet."""
    return row.reason == "manual" and bool((row.note or "").strip()) and row.opened_at is None


def _names(db: Session, rows: Sequence[DeviceLogUpload]) -> Dict[str, Dict[Any, Any]]:
    from app.models.shop import Shop
    from app.models.tenant import Tenant

    machine_ids = {r.machine_id for r in rows}
    shop_ids = {r.branch_id for r in rows if r.branch_id is not None}
    tenant_ids = {r.tenant_id for r in rows if r.tenant_id is not None}
    machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_(machine_ids)).all()} if machine_ids else {}
    shops = {s.id: s.name for s in db.query(Shop.id, Shop.name).filter(Shop.id.in_(shop_ids)).all()} if shop_ids else {}
    tenants = {t.id: t.name for t in db.query(Tenant.id, Tenant.name).filter(Tenant.id.in_(tenant_ids)).all()} if tenant_ids else {}
    return {"machines": machines, "shops": shops, "tenants": tenants}


def upload_out(row: DeviceLogUpload, names: Optional[Dict[str, Dict[Any, Any]]] = None) -> Dict[str, Any]:
    """An upload on the dashboard (content readers only): its metadata, never its content."""
    names = names or {"machines": {}, "shops": {}, "tenants": {}}
    machine = names["machines"].get(row.machine_id)
    return {
        "id": str(row.id),
        "uploadId": str(row.upload_id),
        "machineId": str(row.machine_id),
        "machineName": getattr(machine, "name", None),
        "posNumber": getattr(machine, "pos_number", None),
        "tenantId": str(row.tenant_id) if row.tenant_id else None,
        "tenantName": names["tenants"].get(row.tenant_id),
        "branchId": str(row.branch_id) if row.branch_id else None,
        "branchName": names["shops"].get(row.branch_id),
        "reason": row.reason,
        "commandId": str(row.command_id) if row.command_id else None,
        "requestedBy": row.requested_by_name,
        "note": row.note,
        "appVersion": row.app_version,
        "versionCode": row.version_code,
        "deviceModel": row.device_model,
        "os": row.os,
        "fromMs": row.from_ms,
        "toMs": row.to_ms,
        "lineCount": row.line_count,
        "sizeBytes": row.size_bytes,
        "inflatedBytes": row.inflated_bytes,
        "receivedAt": _iso(row.received_at),
        "openedAt": _iso(row.opened_at),
        "openedBy": row.opened_by_name,
        "isNew": is_new(row),
    }


def _day_start(day: date) -> datetime:
    return datetime.combine(day, time.min, tzinfo=ZoneInfo(ZONE)).astimezone(timezone.utc)


def list_uploads(
    db: Session,
    user: Any,
    *,
    tenant_id: Any = None,
    company_id: Any = None,
    shop_id: Any = None,
    machine_id: Any = None,
    reason: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    only_new: bool = False,
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    """The uploads [user] may read, newest first, filtered; with how many are "חדש" among them."""
    from app.models.shop import Shop

    tenants = readable_tenant_ids(db, user)
    if tenants is not None and not tenants:
        raise _forbidden()
    q = db.query(DeviceLogUpload).options(defer(DeviceLogUpload.content))
    if tenants is not None:
        q = q.filter(DeviceLogUpload.tenant_id.in_(tenants))
    if tenant_id is not None:
        q = q.filter(DeviceLogUpload.tenant_id == tenant_id)
    if company_id is not None:
        q = q.filter(DeviceLogUpload.branch_id.in_(db.query(Shop.id).filter(Shop.company_id == company_id)))
    if shop_id is not None:
        q = q.filter(DeviceLogUpload.branch_id == shop_id)
    if machine_id is not None:
        q = q.filter(DeviceLogUpload.machine_id == machine_id)
    if reason:
        if reason not in REASONS:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_reason")
        q = q.filter(DeviceLogUpload.reason == reason)
    if date_from is not None:
        q = q.filter(DeviceLogUpload.received_at >= _day_start(date_from))
    if date_to is not None:
        q = q.filter(DeviceLogUpload.received_at < _day_start(date_to + timedelta(days=1)))
    new_filter = (
        (DeviceLogUpload.reason == "manual")
        & DeviceLogUpload.note.isnot(None)
        & (func.length(func.trim(DeviceLogUpload.note)) > 0)
        & DeviceLogUpload.opened_at.is_(None)
    )
    new_count = q.filter(new_filter).count()
    if only_new:
        q = q.filter(new_filter)
    total = q.count()
    rows = q.order_by(DeviceLogUpload.received_at.desc(), DeviceLogUpload.id.desc()).offset(offset).limit(limit).all()
    names = _names(db, rows)
    return {"items": [upload_out(r, names) for r in rows], "total": total, "newCount": new_count}


def request_out(row: DeviceCommand, now: Optional[datetime] = None) -> Dict[str, Any]:
    """A logs request as everyone who may request sees it: sent / received, never the content."""
    from app.routers.device_commands import _as_of

    out = _as_of(row, now or utc_now())
    result = row.result or {}
    return {
        "id": out["id"],
        "machineId": out["machineId"],
        "status": out["status"],
        "detail": out["detail"],
        "minutes": (row.params or {}).get("minutes"),
        "createdBy": out["createdBy"],
        "createdAt": out["createdAt"],
        "deliveredAt": out["deliveredAt"],
        "doneAt": out["doneAt"],
        "expiresAt": out["expiresAt"],
        "logId": result.get("log_id"),
        "received": bool(result.get("log_id")),
    }


def recent_requests(db: Session, machine: POSMachine, limit: int = 10) -> List[DeviceCommand]:
    return (
        db.query(DeviceCommand)
        .filter(DeviceCommand.machine_id == machine.id, DeviceCommand.action == ACTION)
        .order_by(DeviceCommand.created_at.desc(), DeviceCommand.id.desc())
        .limit(limit)
        .all()
    )


def machine_summary(db: Session, user: Any, machine: POSMachine, *, limit: int = 50) -> Dict[str, Any]:
    """The device's "לוגים": what [user] may do, its requests, and — for a reader — its uploads."""
    access = access_to(db, user, machine)
    if not access.read and not access.request:
        raise _forbidden()
    now = utc_now()
    uploads = list_uploads(db, user, machine_id=machine.id, limit=limit) if access.read else None
    return {
        "machineId": str(machine.id),
        "capable": capable(machine),
        "appVersion": getattr(machine, "app_version", None),
        "canRead": access.read,
        "canRequest": access.request,
        "minutes": {"min": MINUTES_MIN, "max": MINUTES_MAX, "default": MINUTES_DEFAULT},
        "requests": [request_out(r, now) for r in recent_requests(db, machine)],
        "uploads": uploads,
    }


def create_request(db: Session, user: Any, machine: POSMachine, minutes: Optional[int]) -> List[DeviceCommand]:
    """"בקש לוגים": one `upload_logs` command (the caller commits, then wakes the device)."""
    params = request_params({"minutes": minutes} if minutes is not None else None)
    return cmd_svc.create(db, [machine], ACTION, user=user, params=params)


def requests_status(db: Session, user: Any, ids: Iterable[Any]) -> List[Dict[str, Any]]:
    """The background read of "בקש לוגים": only requests on devices [user] may request for."""
    rows = db.query(DeviceCommand).filter(DeviceCommand.id.in_(list(ids)), DeviceCommand.action == ACTION).all()
    if not rows:
        return []
    machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_({r.machine_id for r in rows})).all()}
    now = utc_now()
    allowed: Dict[Any, bool] = {}
    out = []
    for row in rows:
        machine = machines.get(row.machine_id)
        if machine is None:
            continue
        if machine.id not in allowed:
            a = access_to(db, user, machine)
            allowed[machine.id] = a.read or a.request
        if allowed[machine.id]:
            out.append(request_out(row, now))
    return out


# ── Retention ────────────────────────────────────────────────────────────────


def retention_days() -> int:
    from app.config import get_settings

    try:
        return int(get_settings().device_logs_retention_days)
    except (TypeError, ValueError):
        return 30


def purge_expired(db: Session, *, days: Optional[int] = None, now: Optional[datetime] = None) -> int:
    """Delete uploads older than [days] (DEVICE_LOGS_RETENTION_DAYS; 0 = keep). The caller commits."""
    days = retention_days() if days is None else int(days)
    if days <= 0:
        return 0
    cutoff = (now or utc_now()) - timedelta(days=days)
    return (
        db.query(DeviceLogUpload)
        .filter(DeviceLogUpload.received_at < cutoff)
        .delete(synchronize_session=False)
    )


__all__ = [
    "ACTION", "CAPABILITY", "MAX_COMPRESSED_BYTES", "MAX_INFLATED_BYTES", "MAX_UPLOADS_PER_HOUR",
    "MINUTES_MIN", "MINUTES_MAX", "MINUTES_DEFAULT", "VIEW_LINES",
    "request_params", "decode_content", "inflated_size", "iter_text", "iter_lines", "view_lines",
    "apply_heartbeat", "capable", "can_read", "org_requester", "access_to", "ingest", "ingest_once",
    "list_uploads", "machine_summary", "create_request", "requests_status", "purge_expired",
]
