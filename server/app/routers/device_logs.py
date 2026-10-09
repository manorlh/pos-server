"""
"שליחת לוגים לענן" — app/services/device_logs.py (the device-logs contract, specs/device-logs-api.md).

Device (machine token only, like the other `/sync` writes; a display device too — logs are not fiscal):

POST /sync/{machine_id}/device-logs            {upload_id, reason, command_id?, note?, …, content} →
                                               {id, received_at, duplicate} | 413 | 422 | 429

Dashboard (route rule: `devices` or `device_control`, at view; the real check is here — the content
for a super admin / a distributor of the organization, a request also for a `device_control` editor):

GET  /device-logs                              ?tenantId&companyId&shopId&machineId&reason&dateFrom&dateTo&onlyNew
                                               → {items, total, newCount} (readers; the super admin's page)
GET  /device-logs/machines/{machine_id}        → the device's "לוגים": canRead, canRequest, capable, requests, uploads?
POST /device-logs/requests                     {machineId, minutes?} → the `upload_logs` command
                                               (fire-and-forget; header Idempotency-Key)
GET  /device-logs/requests/status              ?ids= → {items} — the background read ("נשלח / התקבל")
GET  /device-logs/{id}                         → one upload's metadata (readers)
GET  /device-logs/{id}/lines                   ?q=&limit= → the first 2000 lines / matching lines (readers)
GET  /device-logs/{id}/download                ?format=txt|gz → the log (.txt inflated, or the .log.gz as sent)
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated, List, Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user, get_pos_machine_from_sync_machine_token
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.services import command_idempotency as idem
from app.services import device_commands as cmd_svc
from app.services import device_logs as svc

router = APIRouter(prefix="/device-logs", tags=["device-logs"])
till_router = APIRouter(prefix="/sync", tags=["device-logs"])


# ── The device ───────────────────────────────────────────────────────────────


class UploadIn(BaseModel):
    """§1's body, as the device sends it (snake_case). Metadata too long is cut, never refused."""

    model_config = ConfigDict(populate_by_name=True)

    upload_id: uuid.UUID
    reason: Literal["manual", "remote", "crash"]
    command_id: Optional[uuid.UUID] = None
    note: Optional[str] = None
    app_version: Optional[str] = None
    version_code: Optional[int] = Field(None, ge=0, le=2**62)
    device_model: Optional[str] = None
    os: Optional[str] = None
    from_ms: Optional[int] = Field(None, ge=0, le=2**62)
    to_ms: Optional[int] = Field(None, ge=0, le=2**62)
    line_count: Optional[int] = Field(None, ge=0, le=2**31 - 1)
    content_encoding: Literal["gzip+base64"]
    content: str = Field(..., min_length=1)

    @field_validator("note", "app_version", "device_model", "os", mode="before")
    @classmethod
    def _text(cls, value):
        if value is None:
            return None
        return value if isinstance(value, str) else str(value)


@till_router.post("/{machine_id}/device-logs")
def post_device_logs(
    machine_id: str,
    body: UploadIn,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """200 `{id, received_at, duplicate}`; the same `upload_id` again → the same id, duplicate."""
    return svc.ingest_once(db, machine, body)


# ── The dashboard ────────────────────────────────────────────────────────────


class RequestIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    machine_id: uuid.UUID = Field(..., alias="machineId")
    #: 15–1440; absent → 120.
    minutes: Optional[int] = Field(None, ge=svc.MINUTES_MIN, le=svc.MINUTES_MAX)


@router.get("")
def list_device_logs(
    tenant_id: Optional[uuid.UUID] = Query(None, alias="tenantId"),
    company_id: Optional[uuid.UUID] = Query(None, alias="companyId"),
    shop_id: Optional[uuid.UUID] = Query(None, alias="shopId"),
    machine_id: Optional[uuid.UUID] = Query(None, alias="machineId"),
    reason: Optional[Literal["manual", "remote", "crash"]] = Query(None),
    date_from: Optional[date] = Query(None, alias="dateFrom"),
    date_to: Optional[date] = Query(None, alias="dateTo"),
    only_new: bool = Query(False, alias="onlyNew"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Every upload the user may read (a super admin: all organizations), newest first."""
    return svc.list_uploads(
        db, current_user, tenant_id=tenant_id, company_id=company_id, shop_id=shop_id, machine_id=machine_id,
        reason=reason, date_from=date_from, date_to=date_to, only_new=only_new, limit=limit, offset=offset,
    )


@router.get("/machines/{machine_id}")
def get_machine_logs(
    machine_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    machine = svc.machine_or_404(db, machine_id)
    out = svc.machine_summary(db, current_user, machine)
    db.commit()  # requests expired on the way
    return out


@router.post("/requests", status_code=status.HTTP_201_CREATED)
def post_logs_request(
    body: RequestIn,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    response: Response = None,
    idempotency_key: Annotated[Optional[str], Header(alias=idem.KEY_HEADER)] = None,
):
    """
    "בקש לוגים": queues one `upload_logs` command and returns at once ("נשלח"); the device uploads
    in the background and the command turns "התקבל" with its log. A retry with the same
    `Idempotency-Key` gets the same command back, never a second one.
    """
    machine = svc.machine_or_404(db, body.machine_id)
    if not svc.access_to(db, current_user, machine).request:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="device_logs_forbidden")
    out, replayed = idem.once(
        db, tenant_id=machine.tenant_id, kind="device_logs_request", key=idempotency_key, user=current_user,
        request=body.model_dump(mode="json", by_alias=True),
        run=lambda: svc.request_out(svc.create_request(db, current_user, machine, body.minutes)[0]),
        after_commit=lambda _out: cmd_svc.wake([machine]),
        refresh=lambda first: _reread(db, first),
    )
    if replayed and response is not None:
        response.headers[idem.REPLAY_HEADER] = "true"
    return out


def _reread(db: Session, first):
    from app.models.device_command import DeviceCommand

    row = db.get(DeviceCommand, uuid.UUID(str((first or {}).get("id")))) if (first or {}).get("id") else None
    return svc.request_out(row) if row is not None else first


@router.get("/requests/status")
def get_requests_status(
    ids: List[uuid.UUID] = Query(..., max_length=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Read only (a poll never races the device's answer): requests the user may follow."""
    return {"items": svc.requests_status(db, current_user, ids)}


@router.get("/{upload_id}")
def get_device_log(
    upload_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    row = svc.readable_upload(db, current_user, upload_id)
    return svc.upload_out(row, svc._names(db, [row]))


@router.get("/{upload_id}/lines")
def get_device_log_lines(
    upload_id: uuid.UUID,
    q: Optional[str] = Query(None, max_length=200),
    limit: int = Query(svc.VIEW_LINES, ge=1, le=svc.VIEW_LINES),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """"צפה": the first 2000 lines; with `q`, the lines that contain it (the first 2000)."""
    row = svc.readable_upload(db, current_user, upload_id)
    out = svc.view_lines(row.content, query=q, limit=limit)
    svc.mark_opened(row, current_user)
    db.commit()
    return {"id": str(row.id), **out}


@router.get("/{upload_id}/download")
def download_device_log(
    upload_id: uuid.UUID,
    format: Literal["txt", "gz"] = Query("txt"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """"הורד": the log as text (inflated while streaming), or the `.log.gz` exactly as sent."""
    row = svc.readable_upload(db, current_user, upload_id)
    svc.mark_opened(row, current_user)
    db.commit()
    stamp = svc._aware(row.received_at).strftime("%Y%m%d-%H%M%S")
    base = f"device-logs-{str(row.machine_id)[:8]}-{stamp}"
    if format == "gz":
        gz = bytes(row.content)
        return Response(
            content=gz,
            media_type="application/gzip",
            headers={"Content-Disposition": f'attachment; filename="{base}.log.gz"'},
        )
    content = bytes(row.content)
    return StreamingResponse(
        (text.encode("utf-8") for text in svc.iter_text(content)),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{base}.txt"'},
    )


__all__ = ["router", "till_router"]
