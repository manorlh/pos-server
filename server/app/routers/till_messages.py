"""
Messages to tills ("הודעות לקופות").

Dashboard (Clerk/user JWT, machine admins — the roles that manage tills):

POST   /till-messages                 → send to a company / shop / area / till
GET    /till-messages                 → sent messages, newest first, per-till status
POST   /till-messages/{id}/cancel     → stop showing it now (expires it)
POST   /till-messages/{id}/resend     → wake the tills that have not acknowledged
PATCH  /till-messages/{id}            → edit a scheduled (not yet sent) or recurring one
POST   /till-messages/{id}/pause      → a recurring message stops going out
POST   /till-messages/{id}/resume     → … and starts again from its next occurrence

`scheduleKind` on POST: "now" (default), "scheduled" (`sendAt`) or "recurring"
(`recurDays`, `recurTime`, optional `recurStartDate`/`recurEndDate`,
`occurrenceTtlMinutes`); local times are the tenant's. Scheduled deliveries are lazy:
they go out on the first till fetch (or dashboard list) after they come due.

`display` on POST: "fullscreen" (default) or "banner" — the specials strip ("באנר
מבצעים") on the sell screen and the tables floor, with an optional `productId` (its chip
adds the product to the order) and `color` (amber / blue / green / red / purple / dark);
`expiresAt` is its end ("עד מתי"; none: until cancelled). A banner that went out can
still change its text, product, colour and end (PATCH).

Till (machine JWT only, like the till's other `/sync/{machine_id}/...` writes):

GET    /sync/{machine_id}/messages              → unacknowledged, unexpired, oldest first;
                                                  the first fetch marks delivery. Banners
                                                  under `banners` (live, acknowledged or
                                                  not), never in `items`
POST   /sync/{machine_id}/messages/{id}/ack     → "קראתי"; idempotent; 404 when the
                                                  message was not addressed to this till

Every send and resend wakes the tills it reaches after the commit (Ably `settings`
notify, reason `till_message`), best effort; tills also fetch on their heartbeat.
"""
from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, Query, Response, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import (
    get_active_tenant_id,
    get_current_machine_admin,
    get_pos_machine_from_sync_machine_token,
)
from app.models.pos_machine import POSMachine
from app.models.user import User
from app.schemas.till_message import TillMessageAckIn, TillMessageCreate, TillMessageUpdate
from app.services import till_messages as TM

router = APIRouter(tags=["till-messages"])


def _one(db: Session, user: User, tenant_id, message_id) -> dict:
    """The message as the list shows it, for the answer to a write."""
    out = TM.list_messages(db, user, tenant_id, limit=1, offset=0, message_id=message_id)
    return out["items"][0] if out["items"] else {"id": message_id}


@router.post("/till-messages", status_code=status.HTTP_201_CREATED)
def send_till_message(
    body: TillMessageCreate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
    response: Response = None,
    idempotency_key: Annotated[Optional[str], Header(alias="Idempotency-Key")] = None,
):
    """
    Send a message every active till in the target must acknowledge. The tills it
    reaches are fixed now: those of the target the sender can see (400
    `till_message_no_tills` when there are none). Fire-and-forget: the per-till status
    (sent → delivered → acknowledged) is read from the list. `Idempotency-Key`: a retry
    never sends the message twice.
    """
    from app.services import command_idempotency as idem

    made: dict = {}

    def run():
        message = TM.send_message(
            db, current_user, active_tenant_id,
            title=body.title, body=body.body,
            target_level=body.target_level, target_id=body.target_id,
            expires_at=body.expires_at,
            schedule_kind=body.schedule_kind,
            send_at=body.send_at,
            recur_days=body.recur_days,
            recur_time=body.recur_time,
            recur_start_date=body.recur_start_date,
            recur_end_date=body.recur_end_date,
            occurrence_ttl_minutes=body.occurrence_ttl_minutes,
            display=body.display,
            product_id=body.product_id,
            color=body.color,
        )
        made["targets"] = TM.notify_targets(TM.unacknowledged_machines(db, message))
        return {"id": str(message.id)}

    out, replayed = idem.once(
        db, tenant_id=active_tenant_id, kind="till_message", key=idempotency_key, user=current_user,
        request=body.model_dump(mode="json", by_alias=True), run=run,
        after_commit=lambda _out: background_tasks.add_task(TM.publish_message_notify, made["targets"]),
    )
    if replayed and response is not None:
        response.headers[idem.REPLAY_HEADER] = "true"
    return _one(db, current_user, active_tenant_id, out["id"])


@router.get("/till-messages")
def list_till_messages(
    limit: int = Query(30, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Messages that reached a till the caller can see, newest first, each with those
    tills' status: `sent`, `delivered` (the till fetched it) or `acknowledged` (by whom
    and when).
    """
    out = TM.list_messages(db, current_user, active_tenant_id, limit=limit, offset=offset)
    db.commit()  # listing sends what has come due (scheduled / recurring)
    return out


def _managed(db: Session, user: User, tenant_id, message_id, action) -> dict:
    message = TM.get_message(db, tenant_id, message_id)
    action(db, user, tenant_id, message)
    db.commit()
    return _one(db, user, tenant_id, message.id)


@router.patch("/till-messages/{message_id}")
def update_till_message(
    message_id: str,
    body: TillMessageUpdate,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """
    Edit a scheduled message before it goes out, or a recurring one (409
    `till_message_not_editable` otherwise). Only the fields sent change.
    """
    changes = {name: getattr(body, name) for name in body.model_fields_set}
    return _managed(
        db, current_user, active_tenant_id, message_id,
        lambda d, u, t, m: TM.update_message(d, u, t, m, changes),
    )


@router.post("/till-messages/{message_id}/pause")
def pause_till_message(
    message_id: str,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """A recurring message stops going out until resumed; idempotent."""
    return _managed(db, current_user, active_tenant_id, message_id, TM.pause_message)


@router.post("/till-messages/{message_id}/resume")
def resume_till_message(
    message_id: str,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Going out again from the next occurrence; idempotent."""
    return _managed(db, current_user, active_tenant_id, message_id, TM.resume_message)


@router.post("/till-messages/{message_id}/cancel")
def cancel_till_message(
    message_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Expire it now; idempotent. The tills still showing it drop it on their next fetch."""
    message = TM.get_message(db, active_tenant_id, message_id)
    TM.cancel_message(db, current_user, active_tenant_id, message)
    targets = TM.notify_targets(TM.unacknowledged_machines(db, message))
    db.commit()
    background_tasks.add_task(TM.publish_message_notify, targets)
    return _one(db, current_user, active_tenant_id, message.id)


@router.post("/till-messages/{message_id}/resend")
def resend_till_message(
    message_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_machine_admin),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """Wake again every till that has not acknowledged it. 409 once expired or cancelled."""
    message = TM.get_message(db, active_tenant_id, message_id)
    targets = TM.notify_targets(TM.resend_targets(db, current_user, active_tenant_id, message))
    background_tasks.add_task(TM.publish_message_notify, targets)
    out = _one(db, current_user, active_tenant_id, message.id)
    out["notified"] = len(targets)
    return out


# ── The till's side ───────────────────────────────────────────────────────────


@router.get("/sync/{machine_id}/messages")
def get_own_till_messages(
    machine_id: str,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """
    `{"items": [{"id", "title", "body", "sentAt", "senderName"}], "banners": [...]}`:
    this till's unacknowledged, unexpired full-screen messages, oldest first, and its
    live banners (`… "color", "productId", "productName", "expiresAt"`). Marks each
    delivered on its first fetch. A till that predates banners reads `items` only.
    """
    items = TM.pending_for_machine(db, machine)
    banners = TM.banners_for_machine(db, machine, materialize=False)
    db.commit()
    return {"items": items, "banners": banners}


@router.post("/sync/{machine_id}/messages/{message_id}/ack")
def ack_own_till_message(
    machine_id: str,
    message_id: str,
    body: Optional[TillMessageAckIn] = None,
    machine: POSMachine = Depends(get_pos_machine_from_sync_machine_token),
    db: Session = Depends(get_db),
):
    """The signed-in employee tapped "קראתי". Idempotent; 404 for another till's message."""
    TM.acknowledge(
        db, machine, message_id,
        pos_user_id=body.pos_user_id if body else None,
        pos_user_name=body.pos_user_name if body else None,
    )
    db.commit()
    return {"ok": True}
