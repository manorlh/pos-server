"""
"בקשת אישור ממנהל מהנייד" — the life of one request (P:/specs/manager-approval-mobile.md §2, §5, §7).

    till: POST /approvals ──► pending ──► approved ──► grant spent (use / X-Elevation-Token)
                                 │    └─► rejected
                                 ├─► expired   (timeoutSeconds, the sweep — or read past it)
                                 └─► cancelled (the till)

* **Create** (`create`): idempotent per till by `clientRequestId`; the policy must have the
  feature, the type and `remote` on for this till; the chosen approvers are re-checked against
  the rules (eligibility.py) and only those still eligible receive it; none → `422 no_approvers`.
* **Decide** (`decide`): the row is locked; the first decision wins (`409 already_decided`); the
  decider must be one it was sent to and still eligible now; a partial approval only when the
  type allows it and only below what was asked. An approval issues the grant.
* **The grant** — an `elevated_sessions` row held by the approver, bound to this request, its
  till and the approved figures, one use, `GRANT_TTL` long. Its token (`grantId`) is derived
  from the request id with the server's key, so it is never stored: a till re-reading the
  request gets the same one. The till spends it like a PIN grant — as `X-Elevation-Token` where
  the cloud already gates the action (tables, release, shift close), or with `use` for the rest.
* Every step is written to the exceptions log ("יומן חריגות", kinds `approval_*`) for the audit,
  answered to the till in real time (Ably `approval.decided`; the heartbeat's
  `pendingApprovals` for a till that missed it), and replaces the push on the other approvers'
  phones ("טופל על ידי X").
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import uuid
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.elevated_session import ElevatedSession
from app.models.pos_machine import POSMachine
from app.models.pos_user import PosUser
from app.models.remote_approval import ApprovalRequest
from app.models.shop import Shop
from app.models.user import User
from app.services.remote_approvals import catalog as C
from app.services.remote_approvals import policy as P
from app.services.remote_approvals.eligibility import Approver, Ask, approver_for, eligible_approvers, evaluate

logger = logging.getLogger(__name__)

#: How long an approval's grant may be spent after the decision.
GRANT_TTL = timedelta(minutes=15)
#: What the heartbeat repeats: pending requests, and the ones decided this recently.
HEARTBEAT_WINDOW = timedelta(minutes=15)
NOTE_MAX = 200
MESSAGE_MAX = 500
_CENT = Decimal("0.01")
_TOLERANCE = Decimal("0.005")

PENDING, APPROVED, REJECTED, EXPIRED, CANCELLED = "pending", "approved", "rejected", "expired", "cancelled"
ABLY_EVENT = "approval.decided"
AUDIT_SOURCE = "approval_request"
#: "שחרור עובד מחובר" — the cloud fills in its payload (app/services/user_sessions.py `approval_payload`).
USER_RELEASE_TYPE = "user_release"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _fail(code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _dec(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        return Decimal(str(value)).quantize(_CENT, rounding=ROUND_HALF_UP)
    except Exception:  # noqa: BLE001 - a figure that does not read is not one
        return None


def _num(value: Any) -> Optional[float]:
    return float(value) if value is not None else None


def _uuid(value: Any) -> Optional[uuid.UUID]:
    if value is None or value == "":
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def _clip(text: Any, limit: int) -> Optional[str]:
    if text is None:
        return None
    value = str(text).strip()
    return value[:limit] or None


# ── Reading a request ────────────────────────────────────────────────────────


def _count(payload: Any) -> Optional[float]:
    """installments_over: the number of payments, `payload.installments` (§9.13)."""
    if not isinstance(payload, dict) or payload.get("installments") is None:
        return None
    try:
        return float(payload["installments"])
    except (TypeError, ValueError):
        return None


def count_of(req: ApprovalRequest) -> Optional[float]:
    return _count(req.payload)


def ask_of(req: ApprovalRequest, *, amount: Any = None, percent: Any = None) -> Ask:
    return Ask(
        type_key=req.type,
        amount=_num(amount if amount is not None else req.amount),
        percent=_num(percent if percent is not None else req.percent),
        count=count_of(req),
        requester_pos_user_id=req.requester_pos_user_id,
    )


def sent_to_ids(req: ApprovalRequest) -> List[str]:
    return [str(item.get("userId")) for item in (req.sent_to or []) if isinstance(item, dict) and item.get("userId")]


def was_sent_to(req: ApprovalRequest, user_id: Any) -> bool:
    return str(user_id) in sent_to_ids(req)


def is_past(req: ApprovalRequest, now: datetime) -> bool:
    return req.status == PENDING and now >= aware(req.expires_at)


def shown_status(req: ApprovalRequest, now: Optional[datetime] = None) -> str:
    """A pending request whose time is up reads as expired, whether or not the sweep got to it."""
    return EXPIRED if is_past(req, now or utcnow()) else req.status


def table_label(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    table = payload.get("table")
    if isinstance(table, dict):
        for key in ("label", "name", "number", "tableNumber"):
            if table.get(key) not in (None, ""):
                return str(table[key])[:40]
        return None
    if table not in (None, ""):
        return str(table)[:40]
    return None


# ── The grant ────────────────────────────────────────────────────────────────


def grant_token(request_id: Any) -> str:
    """The request's grant token: derived from its id with the server's key, never stored."""
    key = (get_settings().jwt_secret_key or "").encode("utf-8")
    digest = hmac.new(key, f"remote-approval-grant:{request_id}".encode("utf-8"), hashlib.sha256).hexdigest()
    return f"apg_{digest[:48]}"


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


#: Stored on an approval's grant beside the type's elevation scopes, for whoever reads the row
#: ("what was this grant"); not an elevation scope — nothing asks for it by name.
GRANT_MARKER = "approval:remote"


def _issue_grant(db: Session, req: ApprovalRequest, user: User, now: datetime) -> ElevatedSession:
    scopes = [GRANT_MARKER] + [s for s in C.TYPES_BY_KEY[req.type].scopes]
    amount = _dec(req.approved_amount)
    session = ElevatedSession(
        id=uuid.uuid4(),
        token_hash=_hash(grant_token(req.id)),
        user_id=user.id,
        machine_id=req.machine_id,
        shop_id=req.shop_id,
        tenant_id=req.tenant_id,
        scopes=list(dict.fromkeys(scopes)),
        expires_at=now + GRANT_TTL,
        absolute_expires_at=now + GRANT_TTL,
        last_used_at=now,
        approval_request_id=req.id,
        max_amount=abs(amount) if amount is not None else None,
        max_percent=_dec(req.approved_percent),
    )
    db.add(session)
    db.flush()
    req.grant_session_id = session.id
    req.grant_expires_at = now + GRANT_TTL
    return session


def grant_spent(db: Session, req: ApprovalRequest) -> bool:
    if req.grant_used_at is not None:
        return True
    if req.grant_session_id is None:
        return False
    session = db.get(ElevatedSession, req.grant_session_id)
    return session is not None and session.per_action_consumed_at is not None


def use_grant(db: Session, machine: POSMachine, request_id: Any, grant_id: str, *,
              amount: Any = None, percent: Any = None, now: Optional[datetime] = None) -> ApprovalRequest:
    """
    Spend an approval's grant for the action it was given for — once, at its till, within its
    time, for no more than was approved. The caller commits.
    """
    now = now or utcnow()
    req = (
        db.query(ApprovalRequest)
        .filter(ApprovalRequest.id == _uuid(request_id))
        .populate_existing()
        .with_for_update()
        .first()
    )
    if req is None:
        raise _fail(status.HTTP_404_NOT_FOUND, "grant_unknown")
    if str(req.machine_id) != str(machine.id):
        raise _fail(status.HTTP_403_FORBIDDEN, "grant_wrong_machine")
    if req.status != APPROVED or req.grant_session_id is None or not hmac.compare_digest(
        str(grant_id or ""), grant_token(req.id)
    ):
        raise _fail(status.HTTP_404_NOT_FOUND, "grant_unknown")
    session = db.get(ElevatedSession, req.grant_session_id)
    if session is None:
        raise _fail(status.HTTP_404_NOT_FOUND, "grant_unknown")
    if req.grant_used_at is not None or session.per_action_consumed_at is not None:
        raise _fail(status.HTTP_409_CONFLICT, "grant_used")
    if session.revoked_at is not None or now >= aware(req.grant_expires_at or session.absolute_expires_at):
        raise _fail(status.HTTP_410_GONE, "grant_expired")
    want_amount, want_percent = _dec(amount), _dec(percent)
    got_amount, got_percent = _dec(req.approved_amount), _dec(req.approved_percent)
    if want_amount is not None and got_amount is not None and abs(want_amount) > abs(got_amount) + _TOLERANCE:
        raise _fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "grant_amount_mismatch")
    if want_percent is not None and got_percent is not None and want_percent > got_percent + _TOLERANCE:
        raise _fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "grant_amount_mismatch")
    # Spent under the grant row's own lock too, so the same grant presented as an elevation
    # token at the same moment (`consume_per_action_use`) cannot also go through.
    locked = (
        db.query(ElevatedSession)
        .filter(ElevatedSession.id == session.id)
        .populate_existing()
        .with_for_update()
        .first()
    )
    if locked is None or locked.per_action_consumed_at is not None:
        raise _fail(status.HTTP_409_CONFLICT, "grant_used")
    locked.per_action_consumed_at = now
    req.grant_used_at = now
    db.flush()
    return req


# ── Names, audit, realtime, push ─────────────────────────────────────────────


def _machine_name(machine: Optional[POSMachine]) -> Optional[str]:
    if machine is None:
        return None
    return getattr(machine, "name", None) or (f"קופה {machine.pos_number}" if getattr(machine, "pos_number", None) else None)


def _shop_name(db: Session, shop_id: Any) -> Optional[str]:
    if shop_id is None:
        return None
    row = db.query(Shop.name).filter(Shop.id == shop_id).first()
    return row[0] if row else None


def figure_text(amount: Any, percent: Any) -> str:
    parts = []
    if percent is not None:
        parts.append(f"{Decimal(str(percent)).normalize():f}%")
    if amount is not None:
        parts.append(f"₪{abs(Decimal(str(amount))):.2f}")
    return " · ".join(parts)


def _reason(req: ApprovalRequest) -> Optional[str]:
    return req.reason_text or req.reason_code


_KIND_OF = {
    PENDING: "approval_requested", APPROVED: "approval_approved", REJECTED: "approval_rejected",
    EXPIRED: "approval_expired", CANCELLED: "approval_cancelled",
}
_SEVERITY_OF = {PENDING: "low", APPROVED: "medium", REJECTED: "low", EXPIRED: "low", CANCELLED: "low"}


def _audit(db: Session, req: ApprovalRequest, state: str, now: datetime, *, extra: Optional[Dict[str, Any]] = None) -> None:
    """One exceptions-log entry per step (who asked, of whom, who decided, from where, why)."""
    try:
        from app.services.exception_alerts import log as L

        t = C.TYPES_BY_KEY.get(req.type)
        label = t.label if t else req.type
        summary_parts = [label, figure_text(req.amount, req.percent)]
        if state == APPROVED:
            summary_parts.append(f"אושר על ידי {req.decided_by_name or ''}".strip())
            if req.approved_amount != req.amount or req.approved_percent != req.percent:
                summary_parts.append(f"אושר {figure_text(req.approved_amount, req.approved_percent)}")
        elif state == REJECTED:
            summary_parts.append(f"נדחה על ידי {req.decided_by_name or ''}".strip())
        details = {
            "requestId": str(req.id),
            "clientRequestId": req.client_request_id,
            "type": req.type,
            "status": state,
            "reasonCode": req.reason_code,
            "reasonText": req.reason_text,
            "note": req.note,
            "sentTo": list(req.sent_to or []),
            "decidedBy": req.decided_by_name,
            "decidedByUserId": str(req.decided_by_user_id) if req.decided_by_user_id else None,
            "decidedFrom": req.decided_from,
            "approvedAmount": _num(req.approved_amount),
            "approvedPercent": _num(req.approved_percent),
            "message": req.message,
            **(extra or {}),
        }
        L.record(db, L.EntrySpec(
            source=AUDIT_SOURCE,
            source_id=str(req.id),
            dedupe_key=f"approval:{state}:{req.id}",
            kind=_KIND_OF[state],
            severity=_SEVERITY_OF[state],
            occurred_at=now,
            tenant_id=req.tenant_id,
            company_id=req.company_id,
            shop_id=req.shop_id,
            area_id=req.area_id,
            machine_id=req.machine_id,
            pos_user_id=str(req.requester_pos_user_id) if req.requester_pos_user_id else None,
            pos_user_name=req.requester_name,
            amount=req.amount,
            value=req.percent,
            summary=" · ".join(p for p in summary_parts if p),
            details={k: v for k, v in details.items() if v is not None},
        ))
    except Exception:  # noqa: BLE001 - the audit never fails the request itself
        logger.exception("approvals: audit entry failed for %s", req.id)


def ably_body(req: ApprovalRequest, now: Optional[datetime] = None) -> Dict[str, Any]:
    return {
        "serverTime": (now or utcnow()).isoformat(),
        "requestId": str(req.id),
        "clientRequestId": req.client_request_id,
        "status": shown_status(req, now),
        "decidedBy": req.decided_by_name,
        "approvedAmount": _num(req.approved_amount),
        "approvedPercent": _num(req.approved_percent),
        "message": req.message,
    }


def _tell_till(db: Session, req: ApprovalRequest, now: datetime) -> None:
    """`approval.decided` on the till's channel, once the decision is committed."""
    from app.services import after_commit, ably_notify

    tenant_id, machine_id, body = str(req.tenant_id), str(req.machine_id), ably_body(req, now)
    after_commit.run(db, lambda: ably_notify.publish_notify(tenant_id, machine_id, ABLY_EVENT, body))


def push_payload(db: Session, req: ApprovalRequest, type_policy: Dict[str, Any]) -> Dict[str, Any]:
    """What the approver's phone shows: type, figures, table, till, requester, reason — no customer."""
    t = C.TYPES_BY_KEY.get(req.type)
    machine = db.get(POSMachine, req.machine_id)
    title = " ".join(p for p in (f"בקשת {t.label if t else req.type}", figure_text(req.amount, req.percent)) if p)
    table = table_label(req.payload)
    reason = _reason(req)
    parts = [
        f"שולחן {table}" if table else None,
        _machine_name(machine),
        req.requester_name,
        f"״{reason}״" if reason else None,
    ]
    summary = req.payload.get("summary") if isinstance(req.payload, dict) else None
    if req.type == USER_RELEASE_TYPE and summary:
        # "דנה מנסה להתחבר בקופה 3, ומחובר/ת בקופה 1 מאז 14:05. לשחרר?" (exclusive login v2 §2): the
        # line already names the employee and both devices.
        parts = [f"{summary}. לשחרר?", f"״{reason}״" if reason else None]
    if type_policy.get("detailsInPush", True):
        if req.note:
            parts.append(req.note)
        lines = (req.payload or {}).get("lines") if isinstance(req.payload, dict) else None
        if isinstance(lines, list) and lines:
            names = []
            for line in lines[:4]:
                if isinstance(line, dict):
                    name = line.get("name") or line.get("productName")
                    qty = line.get("qty") or line.get("quantity")
                    if name:
                        names.append(f"{name}{f' ×{qty}' if qty not in (None, 1, '1') else ''}")
            if names:
                parts.append(", ".join(names) + ("…" if len(lines) > 4 else ""))
    url = f"/dashboard/approvals/{req.id}"
    if type_policy.get("quickApprove"):
        url += "?quick=approve"
    return {
        "title": title[:120],
        "body": " · ".join(str(p) for p in parts if p)[:240],
        "url": url,
        "tag": f"approval:{req.id}"[:64],
        "kind": "approval",
        "category": "approvals",
        "severity": "high",
        "requireInteraction": True,
        "approvalId": str(req.id),
        "at": aware(req.created_at or utcnow()).isoformat(),
    }


def _users(db: Session, ids: Iterable[Any]) -> List[User]:
    wanted = [_uuid(i) for i in ids if _uuid(i) is not None]
    if not wanted:
        return []
    return db.query(User).filter(User.id.in_(wanted)).all()


def _push(db: Session, req: ApprovalRequest, users: Sequence[Any], payload: Dict[str, Any], dedupe: str,
          now: datetime) -> None:
    try:
        from app.services.exception_alerts import push as PUSH

        for user in users:
            PUSH.deliver_to_user(
                db, tenant_id=req.tenant_id, user=user, payload=payload,
                dedupe=f"{dedupe}:{getattr(user, 'id', '')}", now=now,
            )
    except Exception:  # noqa: BLE001 - a phone that is not reached never fails the request
        logger.exception("approvals: push failed for %s", req.id)


def _push_outcome(db: Session, req: ApprovalRequest, now: datetime, *, skip_user_id: Any = None) -> None:
    """Replace the request's notice on the other approvers' phones (same tag, silent)."""
    t = C.TYPES_BY_KEY.get(req.type)
    what = " ".join(p for p in (t.label if t else req.type, figure_text(req.amount, req.percent)) if p)
    if req.status == APPROVED:
        title = f"טופל על ידי {req.decided_by_name or ''}".strip()
        approved = figure_text(req.approved_amount, req.approved_percent)
        body = f"{what} · אושר" + (f" {approved}" if approved and approved != figure_text(req.amount, req.percent) else "")
    elif req.status == REJECTED:
        title = f"טופל על ידי {req.decided_by_name or ''}".strip()
        body = f"{what} · נדחה"
    elif req.status == EXPIRED:
        title, body = "הבקשה פגה", what
    else:
        title, body = "הבקשה בוטלה בקופה", what
    payload = {
        "title": title[:120], "body": body[:240], "url": f"/dashboard/approvals/{req.id}",
        # No category: a "handled" notice is not a request — it never stays on screen by policy.
        "tag": f"approval:{req.id}"[:64], "kind": "approval_done",
        "renotify": False, "approvalId": str(req.id), "status": req.status,
    }
    others = [u for u in _users(db, sent_to_ids(req)) if str(u.id) != str(skip_user_id)]
    _push(db, req, others, payload, f"approval-done:{req.id}", now)


# ── Creating ─────────────────────────────────────────────────────────────────


def _requester(db: Session, machine: POSMachine, pos_user_id: Any) -> Optional[PosUser]:
    ident = _uuid(pos_user_id)
    if ident is None:
        return None
    pu = db.query(PosUser).filter(PosUser.id == ident, PosUser.shop_id == machine.shop_id).first()
    if pu is None:
        raise _fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_requester")
    return pu


def _pos_user_name(pu: Optional[PosUser]) -> Optional[str]:
    if pu is None:
        return None
    full = " ".join(p for p in (pu.first_name, pu.last_name) if p)
    return full or pu.username


def _recipient(a: Approver, now: datetime, via: str) -> Dict[str, Any]:
    return {"userId": str(a.user_id), "name": a.name, "role": a.role_label, "at": now.isoformat(), "via": via}


def find(db: Session, machine: POSMachine, client_request_id: str) -> Optional[ApprovalRequest]:
    return (
        db.query(ApprovalRequest)
        .filter(ApprovalRequest.machine_id == machine.id, ApprovalRequest.client_request_id == client_request_id)
        .first()
    )


def _require_open(effective: P.EffectivePolicy, type_key: str) -> Dict[str, Any]:
    if type_key not in C.TYPES_BY_KEY:
        raise _fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "unknown_type")
    if not effective.remote_open(type_key):
        raise _fail(status.HTTP_409_CONFLICT, "remote_disabled")
    return effective.type(type_key)


def approvers_for_till(db: Session, machine: POSMachine, type_key: str, *, amount: Any = None, percent: Any = None,
                       count: Any = None, requester_pos_user_id: Any = None) -> List[Approver]:
    """`GET /approvals/approvers`: who this till may ask for this, already filtered by the rules."""
    effective = P.for_machine(db, machine)
    type_policy = _require_open(effective, type_key)
    ask = Ask(type_key=type_key, amount=_num(amount), percent=_num(percent), count=_num(count),
              requester_pos_user_id=_uuid(requester_pos_user_id))
    return eligible_approvers(db, machine, ask, type_policy)


def create(db: Session, machine: POSMachine, body: Any, *, now: Optional[datetime] = None) -> Tuple[ApprovalRequest, bool]:
    """A till's request (§7). Returns (request, created); a repeated `clientRequestId` is the same one."""
    now = now or utcnow()
    client_id = str(body.client_request_id).strip()[:64]
    existing = find(db, machine, client_id)
    if existing is not None:
        return existing, False
    if machine.shop_id is None or machine.tenant_id is None:
        raise _fail(status.HTTP_400_BAD_REQUEST, "machine_unassigned")

    effective = P.for_machine(db, machine)
    type_policy = _require_open(effective, body.type)
    requester = _requester(db, machine, body.requester_pos_user_id)

    reason_code = _clip(body.reason_code, 100)
    reason_text = _clip(body.reason_text, 200)
    mode = type_policy.get("reasonMode") or "optional"
    if mode == "off":
        reason_code = reason_text = None
    elif mode == "required" and not (reason_code or reason_text):
        raise _fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "reason_required")
    note = _clip(body.note, NOTE_MAX) if type_policy.get("noteToManager", True) else None

    chosen = [str(i) for i in (body.approver_ids or [])]
    pick = type_policy.get("pickApprover") or "optional"
    if pick == "off":
        chosen = []
    elif pick == "required" and not chosen:
        raise _fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "approver_required")

    payload = body.payload if isinstance(body.payload, dict) else None
    if body.type == USER_RELEASE_TYPE:
        # Who is signed in where, and the approver's line — the cloud's word, not the till's.
        from app.services import user_sessions as US

        payload = US.approval_payload(db, machine, requester, payload, now=now)
    ask = Ask(
        type_key=body.type, amount=_num(body.amount), percent=_num(body.percent),
        count=_count(payload),
        requester_pos_user_id=requester.id if requester is not None else None,
    )
    eligible = eligible_approvers(db, machine, ask, type_policy)
    targets = [a for a in eligible if str(a.user_id) in chosen] if chosen else eligible
    if not targets:
        raise _fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "no_approvers")

    shop = machine.shop if getattr(machine, "shop", None) is not None else db.get(Shop, machine.shop_id)
    req = ApprovalRequest(
        id=uuid.uuid4(),
        client_request_id=client_id,
        type=body.type,
        tenant_id=machine.tenant_id,
        company_id=getattr(shop, "company_id", None),
        shop_id=machine.shop_id,
        area_id=getattr(machine, "area_id", None),
        machine_id=machine.id,
        requester_pos_user_id=requester.id if requester is not None else None,
        requester_name=_pos_user_name(requester),
        chosen_approver_ids=chosen or None,
        sent_to=[_recipient(a, now, "request") for a in targets],
        amount=_dec(body.amount),
        percent=_dec(body.percent),
        reason_code=reason_code,
        reason_text=reason_text,
        note=note,
        payload=payload,
        status=PENDING,
        expires_at=now + timedelta(seconds=int(type_policy.get("timeoutSeconds") or C.DEFAULT_TIMEOUT)),
        created_at=now,
        updated_at=now,
    )
    try:
        with db.begin_nested():
            db.add(req)
            db.flush()
    except IntegrityError:
        # The same request from a parallel retry: that row is the one.
        again = find(db, machine, client_id)
        if again is not None:
            return again, False
        raise
    _audit(db, req, PENDING, now)
    _push(db, req, [a.user for a in targets], push_payload(db, req, type_policy), f"approval:{req.id}", now)
    return req, True


def add_approvers(db: Session, machine: POSMachine, req: ApprovalRequest, approver_ids: Optional[Sequence[Any]],
                  *, now: Optional[datetime] = None) -> List[Approver]:
    """"שלח לעוד מאשר": more eligible approvers for a pending request (null = everyone not yet asked)."""
    now = now or utcnow()
    if req.status != PENDING or is_past(req, now):
        raise _fail(status.HTTP_409_CONFLICT, "not_pending")
    effective = P.for_machine(db, machine)
    type_policy = effective.type(req.type)
    already = set(sent_to_ids(req))
    eligible = eligible_approvers(db, machine, ask_of(req), type_policy)
    wanted = {str(i) for i in approver_ids} if approver_ids else None
    new = [a for a in eligible if str(a.user_id) not in already and (wanted is None or str(a.user_id) in wanted)]
    if not new:
        if wanted is not None and wanted <= already:
            return []
        raise _fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "no_approvers")
    req.sent_to = list(req.sent_to or []) + [_recipient(a, now, "add") for a in new]
    req.updated_at = now
    db.flush()
    _push(db, req, [a.user for a in new], push_payload(db, req, type_policy), f"approval:{req.id}", now)
    return new


# ── Ending ───────────────────────────────────────────────────────────────────


def _finish(db: Session, req: ApprovalRequest, state: str, now: datetime) -> None:
    req.status = state
    req.decided_at = now
    req.updated_at = now
    db.flush()
    _audit(db, req, state, now)
    _tell_till(db, req, now)
    _push_outcome(db, req, now)


def expire(db: Session, req: ApprovalRequest, now: Optional[datetime] = None) -> bool:
    """A pending request past its time: expired (audit, the till, the phones). False if not due."""
    now = now or utcnow()
    if not is_past(req, now):
        return False
    _finish(db, req, EXPIRED, now)
    return True


def cancel(db: Session, machine: POSMachine, request_id: Any, *, now: Optional[datetime] = None) -> ApprovalRequest:
    """The till withdraws it ("בטל"). Again: fine. Decided already: 409."""
    now = now or utcnow()
    req = _locked(db, request_id)
    if req is None or str(req.machine_id) != str(machine.id):
        raise _fail(status.HTTP_404_NOT_FOUND, "not_found")
    if req.status == CANCELLED:
        return req
    if req.status == PENDING and is_past(req, now):
        expire(db, req, now)
        return req
    if req.status != PENDING:
        raise _fail(status.HTTP_409_CONFLICT, "already_decided")
    _finish(db, req, CANCELLED, now)
    return req


def _locked(db: Session, request_id: Any, *, tenant_id: Any = None) -> Optional[ApprovalRequest]:
    q = db.query(ApprovalRequest).filter(ApprovalRequest.id == _uuid(request_id))
    if tenant_id is not None:
        q = q.filter(ApprovalRequest.tenant_id == tenant_id)
    return q.populate_existing().with_for_update().first()


def _figures(req: ApprovalRequest, type_policy: Dict[str, Any], approved_amount: Any,
             approved_percent: Any) -> Tuple[Optional[Decimal], Optional[Decimal]]:
    """What an approval approves: what was asked, or less when the type allows it (never more)."""
    asked_amount, asked_percent = _dec(req.amount), _dec(req.percent)
    out_amount, out_percent = asked_amount, asked_percent
    partial = False
    if approved_amount is not None:
        value = _dec(approved_amount)
        if value is None or asked_amount is None or value <= 0 or value > abs(asked_amount) + _TOLERANCE:
            raise _fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_amount")
        out_amount = value.copy_sign(asked_amount) if asked_amount < 0 else value
        partial = partial or abs(value - abs(asked_amount)) > _TOLERANCE
    if approved_percent is not None:
        value = _dec(approved_percent)
        if value is None or asked_percent is None or value <= 0 or value > asked_percent + _TOLERANCE:
            raise _fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_amount")
        out_percent = value
        partial = partial or abs(value - asked_percent) > _TOLERANCE
    if partial and not type_policy.get("allowPartial"):
        raise _fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "partial_not_allowed")
    return out_amount, out_percent


def decide(
    db: Session,
    request_id: Any,
    user: User,
    *,
    tenant_id: Any,
    decision: str,
    approved_amount: Any = None,
    approved_percent: Any = None,
    message: Optional[str] = None,
    device: Optional[str] = None,
    now: Optional[datetime] = None,
) -> ApprovalRequest:
    """
    An approver's answer. The row is locked first, so of two answers at once exactly one finds
    it pending (the first decision wins) and the other gets `409 already_decided`.
    """
    now = now or utcnow()
    if decision not in ("approve", "reject"):
        raise _fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_decision")
    req = _locked(db, request_id, tenant_id=tenant_id)
    if req is None:
        raise _fail(status.HTTP_404_NOT_FOUND, "not_found")
    if req.status != PENDING:
        raise _fail(status.HTTP_409_CONFLICT, "already_decided")
    if is_past(req, now):
        expire(db, req, now)
        db.commit()
        raise _fail(status.HTTP_409_CONFLICT, "expired")
    if not was_sent_to(req, user.id):
        raise _fail(status.HTTP_403_FORBIDDEN, "not_allowed")
    machine = db.get(POSMachine, req.machine_id)
    if machine is None:
        raise _fail(status.HTTP_404_NOT_FOUND, "not_found")
    type_policy = P.for_machine(db, machine).type(req.type)

    if decision == "approve":
        amount, percent = _figures(req, type_policy, approved_amount, approved_percent)
        ask = ask_of(req, amount=amount, percent=percent)
    else:
        amount = percent = None
        ask = ask_of(req)
    approver = approver_for(db, machine, ask, type_policy, user, escalated=req.escalated_at is not None)
    if approver is None:
        raise _fail(status.HTTP_403_FORBIDDEN, "not_allowed")

    req.decided_by_user_id = user.id
    req.decided_by_name = approver.name
    req.decided_by_pos_user_id = approver.pos_user_id
    req.decided_from = _clip(device, 200)
    req.message = _clip(message, MESSAGE_MAX)
    req.decided_at = now
    req.updated_at = now
    if decision == "approve":
        req.status = APPROVED
        req.approved_amount = amount
        req.approved_percent = percent
        _issue_grant(db, req, user, now)
    else:
        req.status = REJECTED
    db.flush()
    _audit(db, req, req.status, now)
    _tell_till(db, req, now)
    _push_outcome(db, req, now, skip_user_id=user.id)
    return req


# ── The sweep: expiry and escalation ─────────────────────────────────────────


def escalate(db: Session, req: ApprovalRequest, now: datetime) -> int:
    """After `escalateAfterSeconds` with no answer: also to `escalationRoles` (once). Returns how many."""
    if req.status != PENDING or req.escalated_at is not None or is_past(req, now):
        return 0
    machine = db.get(POSMachine, req.machine_id)
    if machine is None:
        return 0
    type_policy = P.for_machine(db, machine).type(req.type)
    after = type_policy.get("escalateAfterSeconds")
    roles = list(type_policy.get("escalationRoles") or [])
    if not after or not roles:
        return 0
    if now < aware(req.created_at) + timedelta(seconds=int(after)):
        return 0
    already = set(sent_to_ids(req))
    new = [a for a in evaluate(db, machine, ask_of(req), type_policy, roles=roles) if str(a.user_id) not in already]
    req.escalated_at = now
    req.updated_at = now
    if new:
        req.sent_to = list(req.sent_to or []) + [_recipient(a, now, "escalation") for a in new]
    db.flush()
    if new:
        _push(db, req, [a.user for a in new], push_payload(db, req, type_policy), f"approval:{req.id}", now)
    return len(new)


def sweep(db: Session, *, now: Optional[datetime] = None, limit: int = 500) -> Dict[str, int]:
    """Every pending request: expired when its time is up, escalated when due. The caller commits."""
    now = now or utcnow()
    expired = escalated = 0
    ids = [
        r[0] for r in db.query(ApprovalRequest.id)
        .filter(ApprovalRequest.status == PENDING)
        .order_by(ApprovalRequest.created_at)
        .limit(limit)
        .all()
    ]
    for ident in ids:
        req = (
            db.query(ApprovalRequest)
            .filter(ApprovalRequest.id == ident)
            .populate_existing()
            .with_for_update(skip_locked=True)
            .first()
        )
        if req is None or req.status != PENDING:
            continue  # being decided right now, or already decided
        if is_past(req, now):
            expire(db, req, now)
            expired += 1
        elif escalate(db, req, now):
            escalated += 1
    return {"expired": expired, "escalated": escalated}


# ── The till's view ──────────────────────────────────────────────────────────


def sent_to_out(req: ApprovalRequest) -> List[Dict[str, Any]]:
    return [
        {"approverId": item.get("userId"), "name": item.get("name")}
        for item in (req.sent_to or []) if isinstance(item, dict)
    ]


def created_out(req: ApprovalRequest, now: Optional[datetime] = None) -> Dict[str, Any]:
    return {
        "id": str(req.id),
        "clientRequestId": req.client_request_id,
        "status": shown_status(req, now),
        "sentTo": sent_to_out(req),
        "expiresAt": aware(req.expires_at).isoformat(),
    }


def till_out(db: Session, req: ApprovalRequest, now: Optional[datetime] = None) -> Dict[str, Any]:
    """`GET /approvals/{id}` for the till that asked (§7, §9.7) — the grant only to it."""
    now = now or utcnow()
    state = shown_status(req, now)
    grant = None
    if state == APPROVED and req.grant_session_id is not None:
        grant = grant_token(req.id)
    return {
        "id": str(req.id),
        "clientRequestId": req.client_request_id,
        "type": req.type,
        "status": state,
        "decidedBy": req.decided_by_name,
        "decidedByUserId": str(req.decided_by_user_id) if req.decided_by_user_id else None,
        "decidedByPosUserId": str(req.decided_by_pos_user_id) if req.decided_by_pos_user_id else None,
        "decidedAt": aware(req.decided_at).isoformat() if req.decided_at else None,
        "approvedAmount": _num(req.approved_amount),
        "approvedPercent": _num(req.approved_percent),
        "message": req.message,
        "grantId": grant,
        "grantExpiresAt": aware(req.grant_expires_at).isoformat() if grant and req.grant_expires_at else None,
        "grantUsed": grant_spent(db, req) if grant else False,
        "expiresAt": aware(req.expires_at).isoformat(),
        "sentTo": sent_to_out(req),
    }


def heartbeat_items(db: Session, machine: POSMachine, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """`pendingApprovals`: this till's requests still waiting, or answered in the last minutes."""
    now = now or utcnow()
    since = now - HEARTBEAT_WINDOW
    rows = (
        db.query(ApprovalRequest)
        .filter(
            ApprovalRequest.machine_id == machine.id,
            ApprovalRequest.created_at >= now - timedelta(days=1),
        )
        .filter((ApprovalRequest.status == PENDING) | (ApprovalRequest.decided_at >= since))
        .order_by(ApprovalRequest.created_at)
        .limit(50)
        .all()
    )
    out = []
    for req in rows:
        if req.status == APPROVED and grant_spent(db, req):
            continue
        out.append({"id": str(req.id), "clientRequestId": req.client_request_id, "status": shown_status(req, now)})
    return out


def on_capabilities(db: Session, machine: POSMachine, before: Optional[Sequence[str]]) -> None:
    """
    A till reporting `remote_approval_v1` for the first time: its settings watermark moves and it
    is told to pull, so `approvalRequests` reaches it now, not at the next settings change.
    """
    had = P.CAPABILITY in (before or [])
    if had or not P.capable(machine):
        return
    machine.settings_updated_at = utcnow()
    if machine.tenant_id is None:
        return
    from app.services import after_commit, ably_notify

    tenant_id, machine_id = str(machine.tenant_id), str(machine.id)
    after_commit.run(
        db, lambda: ably_notify.publish_settings_notify(tenant_id, machine_id, reason="approval_requests"),
    )
