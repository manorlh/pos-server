"""
Message templates (§17): built-in bodies, the strict renderer, and the lifecycle
Draft → Approved → Active → Archived.

* **Only declared variables.** A body may contain `{name}` placeholders from its event's
  list and nothing else; anything else in braces is refused when the template is saved,
  never interpolated. Values are cleaned (no control characters, no braces, no line
  breaks, a length cap) before they go in — there is no free interpolation.
* **Optional values never leave holes.** When an optional variable used by `body` has
  no value (no first name), the template's `fallback_body` is used instead.
* **Secret variables** (an OTP `code`) are rendered into the text that goes to the
  provider only; the stored snapshot shows them as "••••••".
* **Segments** are an estimate from the encoding rules (GSM-7: 160/153, otherwise UCS-2:
  70/67 — Hebrew is UCS-2). 019's own counting and prices are NOT verified
  (docs/SPEC_NOTIFICATIONS_CLUB.md, open questions); the preview says so.
* A tenant template (company first, then tenant-wide) in status `active` wins over the
  built-in one. Only drafts are editable; activating archives the previous active one.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.notifications import (
    CATEGORY_AUTHENTICATION,
    CATEGORY_INTERNAL,
    CATEGORY_MARKETING,
    CATEGORY_SERVICE,
    CHANNEL_SMS,
    TEMPLATE_ACTIVE,
    TEMPLATE_APPROVED,
    TEMPLATE_ARCHIVED,
    TEMPLATE_DRAFT,
    NotificationTemplate,
)

#: 019's documented maximum message length (send-sms.html: "maximum 1005 characters").
MAX_MESSAGE_CHARS = 1005
SECRET_MASK = "••••••"
_PLACEHOLDER = re.compile(r"\{([a-z_][a-z0-9_]*)\}")
_ANY_BRACE = re.compile(r"[{}]")
_CONTROL = re.compile(r"[\x00-\x1f\x7f​-‏‪-‮⁦-⁩]")


class TemplateError(ValueError):
    def __init__(self, code: str, detail: Optional[str] = None):
        super().__init__(code)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class EventSpec:
    event_type: str
    category: str
    required: Tuple[str, ...]
    optional: Tuple[str, ...] = ()
    secret: Tuple[str, ...] = ()
    body: str = ""
    fallback: Optional[str] = None
    title: str = ""
    sample: Dict[str, str] = field(default_factory=dict)

    @property
    def variables(self) -> Tuple[str, ...]:
        return self.required + self.optional


#: Built-in templates (§15, §17). Service messages carry no marketing.
EVENTS: Dict[str, EventSpec] = {
    "OrderReady": EventSpec(
        event_type="OrderReady",
        category=CATEGORY_SERVICE,
        required=("pickup_number", "branch_name", "brand_name"),
        optional=("first_name",),
        body="היי {first_name}, הזמנה {pickup_number} בסניף {branch_name} מוכנה לאיסוף. מחכים לך בדלפק. {brand_name}",
        fallback="היי, הזמנה {pickup_number} בסניף {branch_name} מוכנה לאיסוף. מחכים לך בדלפק. {brand_name}",
        title="הזמנה מוכנה",
        sample={"first_name": "דנה", "pickup_number": "42", "branch_name": "מרכז", "brand_name": "Runner"},
    ),
    "OtpCode": EventSpec(
        event_type="OtpCode",
        category=CATEGORY_AUTHENTICATION,
        required=("code", "brand_name"),
        secret=("code",),
        body="קוד האימות שלך ל{brand_name}: {code}. הקוד בתוקף 5 דקות. אין למסור אותו לאיש.",
        title="קוד אימות (OTP)",
        sample={"code": "123456", "brand_name": "Runner"},
    ),
    "ClubWelcome": EventSpec(
        event_type="ClubWelcome",
        category=CATEGORY_SERVICE,
        required=("club_name", "member_number"),
        optional=("first_name",),
        body="{first_name}, נרשמת בהצלחה למועדון {club_name}. מספר החבר שלך: {member_number}.",
        fallback="נרשמת בהצלחה למועדון {club_name}. מספר החבר שלך: {member_number}.",
        title="אישור הצטרפות",
        sample={"first_name": "דנה", "club_name": "Runner", "member_number": "1001"},
    ),
    "EquipmentAlert": EventSpec(
        event_type="EquipmentAlert",
        category=CATEGORY_INTERNAL,
        required=("branch_name", "alert_text"),
        body="התראת ציוד בסניף {branch_name}: {alert_text}",
        title="התראת ציוד (פנימי)",
        sample={"branch_name": "מרכז", "alert_text": "מדפסת מטבח לא זמינה"},
    ),
    "Campaign": EventSpec(
        event_type="Campaign",
        category=CATEGORY_MARKETING,
        required=("brand_name",),
        optional=("first_name",),
        body="{brand_name}: ",
        title="קמפיין (P1)",
        sample={"first_name": "דנה", "brand_name": "Runner"},
    ),
}

#: Value caps per variable (characters); everything else 60.
_VALUE_CAPS = {"code": 10, "pickup_number": 12, "alert_text": 200, "member_number": 12}


def event_spec(event_type: str) -> EventSpec:
    spec = EVENTS.get(event_type)
    if spec is None:
        raise TemplateError("template_event_unknown", event_type)
    return spec


def clean_value(name: str, value: Any) -> str:
    """A variable's value as it may appear in a message: one line, no braces, capped."""
    if value is None:
        return ""
    text = _CONTROL.sub(" ", str(value))
    text = _ANY_BRACE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[: _VALUE_CAPS.get(name, 60)].strip()


def placeholders(body: str) -> List[str]:
    return _PLACEHOLDER.findall(body or "")


def validate_body(event_type: str, body: str, *, fallback: Optional[str] = None) -> None:
    """Refuse unknown placeholders, stray braces, missing required ones, oversize text."""
    spec = event_spec(event_type)
    for label, text, is_fallback in (("body", body, False), ("fallback", fallback, True)):
        if text is None:
            continue
        if not text.strip():
            raise TemplateError("template_body_empty", label)
        used = placeholders(text)
        unknown = sorted(set(used) - set(spec.variables))
        if unknown:
            raise TemplateError("template_variable_unknown", ",".join(unknown))
        stripped = _PLACEHOLDER.sub("", text)
        if _ANY_BRACE.search(stripped):
            raise TemplateError("template_braces_invalid", label)
        missing = [v for v in spec.required if v not in used]
        if missing and spec.category != CATEGORY_MARKETING:
            raise TemplateError("template_variable_missing", ",".join(missing))
        if is_fallback and any(v in spec.optional for v in used):
            raise TemplateError("template_fallback_uses_optional", label)
        if len(text) > MAX_MESSAGE_CHARS:
            raise TemplateError("template_too_long", label)


@dataclass
class Rendered:
    text: str            # what goes to the provider
    snapshot: str        # what is stored (secrets masked)
    used_fallback: bool


def render(
    event_type: str,
    body: str,
    variables: Dict[str, Any],
    *,
    fallback: Optional[str] = None,
) -> Rendered:
    spec = event_spec(event_type)
    values = {name: clean_value(name, variables.get(name)) for name in spec.variables}
    for name in spec.required:
        if not values.get(name):
            raise TemplateError("template_value_missing", name)
    chosen, used_fallback = body, False
    if any(not values.get(name) for name in placeholders(body) if name in spec.optional):
        if fallback:
            chosen, used_fallback = fallback, True

    def fill(secret_mask: bool) -> str:
        def sub(match: "re.Match[str]") -> str:
            name = match.group(1)
            if secret_mask and name in spec.secret:
                return SECRET_MASK
            return values.get(name, "")

        text = _PLACEHOLDER.sub(sub, chosen)
        return re.sub(r"[ \t]+", " ", text).strip()

    text = fill(False)
    if len(text) > MAX_MESSAGE_CHARS:
        raise TemplateError("template_too_long", "rendered")
    return Rendered(text=text, snapshot=fill(True), used_fallback=used_fallback)


# GSM 03.38 basic set (+ the escape extension counted as 2).
_GSM_BASIC = set(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
)
_GSM_EXT = set("^{}\\[~]|€")


def estimate_segments(text: str) -> Dict[str, Any]:
    """Length, encoding and segment count by the GSM/UCS-2 rules — an estimate only."""
    if all(c in _GSM_BASIC or c in _GSM_EXT for c in text):
        units = sum(2 if c in _GSM_EXT else 1 for c in text)
        single, multi, encoding = 160, 153, "GSM-7"
    else:
        # UTF-16 code units: a character outside the BMP (an emoji) counts twice.
        units = sum(2 if ord(c) > 0xFFFF else 1 for c in text)
        single, multi, encoding = 70, 67, "UCS-2"
    segments = 1 if units <= single else -(-units // multi)
    return {
        "length": len(text),
        "units": units,
        "encoding": encoding,
        "segments": segments,
        # Never a price: 019's counting and price list are not verified.
        "verified": False,
    }


# ── Stored templates ──────────────────────────────────────────────────────────


def scope_key(company_id: Any) -> str:
    return str(company_id) if company_id else "tenant"


def resolve_template(
    db: Session,
    tenant_id: Any,
    company_id: Any,
    event_type: str,
    *,
    channel: str = CHANNEL_SMS,
    language: str = "he",
) -> Tuple[Optional[NotificationTemplate], str, Optional[str], int, str]:
    """
    The body to use: `(row or None, body, fallback, version, key)`. Company-specific
    active template, then tenant-wide active, then the built-in one (version 0).
    """
    spec = event_spec(event_type)
    keys = [scope_key(company_id)] if company_id else []
    keys.append("tenant")
    for key in keys:
        row = (
            db.query(NotificationTemplate)
            .filter(
                NotificationTemplate.tenant_id == tenant_id,
                NotificationTemplate.scope_key == key,
                NotificationTemplate.event_type == event_type,
                NotificationTemplate.channel == channel,
                NotificationTemplate.language == language,
                NotificationTemplate.status == TEMPLATE_ACTIVE,
            )
            .order_by(NotificationTemplate.version.desc())
            .first()
        )
        if row is not None:
            return row, row.body, row.fallback_body, row.version, f"{event_type}:{key}:v{row.version}"
    return None, spec.body, spec.fallback, 0, f"{event_type}:builtin"


def create_draft(
    db: Session,
    *,
    tenant_id: Any,
    company_id: Any,
    event_type: str,
    body: str,
    fallback_body: Optional[str] = None,
    name: Optional[str] = None,
    language: str = "he",
    user_id: Any = None,
) -> NotificationTemplate:
    spec = event_spec(event_type)
    validate_body(event_type, body, fallback=fallback_body)
    key = scope_key(company_id)
    last = (
        db.query(NotificationTemplate.version)
        .filter(
            NotificationTemplate.tenant_id == tenant_id,
            NotificationTemplate.scope_key == key,
            NotificationTemplate.event_type == event_type,
            NotificationTemplate.channel == CHANNEL_SMS,
            NotificationTemplate.language == language,
        )
        .order_by(NotificationTemplate.version.desc())
        .first()
    )
    row = NotificationTemplate(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        company_id=company_id,
        scope_key=key,
        category=spec.category,
        channel=CHANNEL_SMS,
        language=language,
        event_type=event_type,
        version=(last[0] + 1) if last else 1,
        status=TEMPLATE_DRAFT,
        name=(name or spec.title)[:120],
        body=body,
        fallback_body=fallback_body,
        allowed_variables=list(spec.variables),
        created_by=user_id,
    )
    db.add(row)
    db.flush()
    return row


def update_draft(
    row: NotificationTemplate, *, body: Optional[str] = None, fallback_body: Any = ..., name: Optional[str] = None
) -> NotificationTemplate:
    if row.status != TEMPLATE_DRAFT:
        raise TemplateError("template_not_draft")
    new_body = body if body is not None else row.body
    new_fallback = row.fallback_body if fallback_body is ... else fallback_body
    validate_body(row.event_type, new_body, fallback=new_fallback)
    row.body = new_body
    row.fallback_body = new_fallback
    if name is not None:
        row.name = name[:120]
    return row


def approve(row: NotificationTemplate, user_id: Any) -> NotificationTemplate:
    if row.status != TEMPLATE_DRAFT:
        raise TemplateError("template_not_draft")
    validate_body(row.event_type, row.body, fallback=row.fallback_body)
    row.status = TEMPLATE_APPROVED
    row.approved_by = user_id
    row.approved_at = datetime.now(timezone.utc)
    return row


def activate(db: Session, row: NotificationTemplate) -> NotificationTemplate:
    if row.status != TEMPLATE_APPROVED:
        raise TemplateError("template_not_approved")
    now = datetime.now(timezone.utc)
    for other in (
        db.query(NotificationTemplate)
        .filter(
            NotificationTemplate.tenant_id == row.tenant_id,
            NotificationTemplate.scope_key == row.scope_key,
            NotificationTemplate.event_type == row.event_type,
            NotificationTemplate.channel == row.channel,
            NotificationTemplate.language == row.language,
            NotificationTemplate.status == TEMPLATE_ACTIVE,
            NotificationTemplate.id != row.id,
        )
        .all()
    ):
        other.status = TEMPLATE_ARCHIVED
        other.archived_at = now
    row.status = TEMPLATE_ACTIVE
    row.activated_at = now
    db.flush()
    return row


def archive(row: NotificationTemplate) -> NotificationTemplate:
    if row.status == TEMPLATE_ARCHIVED:
        return row
    row.status = TEMPLATE_ARCHIVED
    row.archived_at = datetime.now(timezone.utc)
    return row


def preview(event_type: str, body: str, fallback: Optional[str], sample: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Render with sample data (the event's own sample unless given) — never sends."""
    spec = event_spec(event_type)
    validate_body(event_type, body, fallback=fallback)
    values = dict(spec.sample)
    values.update({k: v for k, v in (sample or {}).items() if k in spec.variables})
    rendered = render(event_type, body, values, fallback=fallback)
    without_optional = None
    if spec.optional:
        bare = {k: v for k, v in values.items() if k not in spec.optional}
        without_optional = render(event_type, body, bare, fallback=fallback).snapshot
    return {
        "text": rendered.snapshot,
        "withoutOptional": without_optional,
        "usedFallback": rendered.used_fallback,
        "segments": estimate_segments(rendered.text),
    }
