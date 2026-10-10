"""
"הפצה בוואטסאפ": prepaid vouchers ("שוברי הפקה") sent to the people the production names, each
with their own vouchers as a PDF behind a personal link.

The owner: "אפשר לשלוח דרך וואטסאפ ווב שוברים. הלקוח יעביר רשימת טלפונים לשוברים, ויהיה אפשר
לשלוח דרך וואטסאפ ווב עם הודעה והשוברים ב-PDF, בקבוצות שלו אם הוגדר כך."

The rules, and why:

* **No automation of WhatsApp Web.** Driving WhatsApp Web with a headless browser is unofficial,
  breaks WhatsApp's terms and gets the number banned. Sending is either *assisted* — the dashboard
  opens `https://wa.me/<phone>?text=…` (or the browser's share sheet with the PDF) and a person
  presses send — or the *official* WhatsApp Cloud API (app/services/whatsapp_cloud.py), optional
  and off by default.
* **The list.** Rows of name (optional), phone, and a group (envelope) number or a count. Israeli
  numbers in every usual shape become E.164 (050-123-4567 → +972501234567, a leading 0 that Excel
  dropped too); an international number must come in "+" form. A landline has no WhatsApp and is
  refused; a number twice is refused (or, when asked, kept with a warning).
* **Who gets what** (`mode`): `group` — a row takes every unused, unassigned voucher of its group
  (the envelope); `count` — N vouchers a row (the row's own count when it has one), in serial
  order from the unassigned ones; `one` — one voucher each. Only unused vouchers (`active`) are
  given out; a cancelled or (partly) used one never is. The preview is the very same computation
  as the import, so what was shown is what is stored.
* **A voucher belongs to one recipient at most** — a unique key on the voucher in
  `voucher_distribution_assignments`, and the import runs under the batch's row lock. Taking
  vouchers back ("unassign") deletes the rows and logs the serials, who and why.
* **The personal link** — 160 random bits (`random_token(20)`), looked up by its SHA-256; the token
  itself is kept only encrypted, so the dashboard can put it in a message again. Revocable,
  re-issuable (the old one dies), and expiring: by default the batch's validity end + 7 days
  (`LINK_GRACE`), or 60 days from issue for a batch with no end. The public page answers the same
  404 for an unknown, revoked or expired link (the reason is logged, not told), is rate-limited per
  address and per link, sends no-store / noindex headers, and returns only that recipient's PDF.
* **Opened is a person, not a robot.** WhatsApp fetches a link to draw its preview the moment the
  message is typed; preview robots (by user agent) and HEAD requests are logged as `link_preview`
  and never count as "opened".
* **Personal data.** The phone is encrypted at rest with a keyed hash for dedupe (as the
  notification service's recipients); only users who manage the batch see it (the routes need
  edit on "שוברי הפקה"). The audit trail never copies a phone or a name. Once the batch is over —
  cancelled, past its validity, or the recipient's vouchers all used — a recipient's name, phone
  and the addresses their opens were logged from can be erased; the row stays, anonymised, so the
  counts and the trail still add up.
"""
from __future__ import annotations

import csv
import hashlib
import html
import io
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch
from app.models.user import User
from app.models.voucher_distribution import (
    VoucherDistribution,
    VoucherDistributionAssignment,
    VoucherDistributionEvent,
    VoucherDistributionRecipient,
)
from app.services import prepaid_vouchers as PV
from app.services.notifications import crypto
from app.services.notifications import phone as phones

# ── Settings (env) ────────────────────────────────────────────────────────────


class DistributionSettings(BaseSettings):
    """
    This feature's own switches, read from the same env files as app/config.py:

    * `VOUCHER_LINK_BASE_URL` — the API's public origin the personal links point at
      (https://api.example.com). Empty: `PUBLIC_BASE_URL`, then http://localhost:8001.
    * `WHATSAPP_CLOUD_API_ENABLED` — the server's own switch for the Cloud API; off by default:
      with it off no request ever goes to Meta, whatever a company configured.
    * `WHATSAPP_GRAPH_BASE_URL` / `WHATSAPP_GRAPH_API_VERSION` — Meta's Graph API.
    * `WHATSAPP_WORKER_ENABLED` — the background pass that retries Cloud API sends.
    * `WHATSAPP_SECRETS_KEY` is not used: secrets are encrypted with the payment-secrets key
      (`PAYMENT_SECRETS_KEY`, else derived from `JWT_SECRET_KEY`), as every secret here is.
    """

    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"), env_file_encoding="utf-8", case_sensitive=False, extra="ignore"
    )

    voucher_link_base_url: str = ""
    public_base_url: str = ""
    whatsapp_cloud_api_enabled: bool = False
    whatsapp_graph_base_url: str = "https://graph.facebook.com"
    whatsapp_graph_api_version: str = "v23.0"
    whatsapp_worker_enabled: bool = True


@lru_cache()
def distribution_settings() -> DistributionSettings:
    return DistributionSettings()


# ── Constants ─────────────────────────────────────────────────────────────────

MODES = ("group", "count", "one")
KINDS = ("person", "group")
#: The personal link's randomness: 20 bytes = 160 bits (at least 128 asked).
TOKEN_BYTES = 20
#: A link lives until the batch's validity end + this.
LINK_GRACE = timedelta(days=7)
#: … or, for a batch with no validity end, this long from issue.
LINK_DEFAULT_LIFETIME = timedelta(days=60)
#: The PDF's page by default: one voucher a page, A6 reads well on a phone.
DEFAULT_LAYOUT = "a6"
LAYOUTS = ("a6", "card86x54", "card54x86", "ticket80x50", "ticket80x120", "a4grid")
MAX_ROWS = 5000
MAX_PER_RECIPIENT = 500
TEMPLATE_MAX = 2000
NAME_MAX = 200

#: The default messages. Placeholders: {שם} {אירוע} {כמות} {מספרים} {קישור} {תוקף} {קבוצה}.
DEFAULT_MESSAGE = (
    "שלום {שם},\n"
    "מצורפים השוברים שלך ל{אירוע} ({כמות} שוברים, מס׳ {מספרים}).\n"
    "להורדת הקובץ: {קישור}"
)
DEFAULT_GROUP_MESSAGE = (
    "שוברי {אירוע} — קבוצה {קבוצה} ({כמות} שוברים, מס׳ {מספרים}).\n"
    "להורדת הקובץ: {קישור}"
)
#: Placeholder (Hebrew, and its English alias) → value key.
PLACEHOLDERS = {
    "שם": "name", "name": "name",
    "אירוע": "event", "event": "event",
    "כמות": "count", "count": "count",
    "מספרים": "serials", "serials": "serials",
    "קישור": "link", "link": "link",
    "תוקף": "validUntil", "validUntil": "validUntil",
    "קבוצה": "group", "group": "group",
}

#: Display states, in the order they are reached (`opened` — the person opened the link — last).
STATES = ("pending", "sent", "delivered", "read", "opened", "failed")
#: Rank of a delivery status: a later report never moves a recipient back.
STATUS_RANK = {"pending": 0, "sent": 1, "delivered": 2, "read": 3}

# 4xx details.
DISTRIBUTION_CONFLICT = "distribution_conflict"
RECIPIENT_NOT_FOUND = "distribution_recipient_not_found"
BATCH_ACTIVE = "distribution_batch_active"
LAYOUT_INVALID = "distribution_layout_invalid"
EXPIRY_PAST = "distribution_expiry_past"
NO_VOUCHERS = "distribution_no_vouchers"
LINK_INACTIVE = "distribution_link_inactive"
RECIPIENT_REMOVED = "distribution_recipient_removed"

#: Link-preview robots: their fetch is logged, never counted as the recipient opening it.
PREVIEW_AGENTS = (
    "whatsapp", "facebookexternalhit", "facebot", "meta-externalagent", "telegrambot", "twitterbot",
    "slackbot", "discordbot", "linkedinbot", "skypeuripreview", "googlebot", "bingbot", "applebot",
    "embedly", "pinterest", "redditbot", "vkshare", "viber", "iframely", "bot/", "crawler", "spider",
    "preview",
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    moment = _utc(moment)
    return moment.isoformat() if moment else None


def _http(code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


# ── Phone numbers ─────────────────────────────────────────────────────────────

_EXCEL_FLOAT = re.compile(r"^\+?\d+\.0+$")
_SCIENTIFIC = re.compile(r"^[+\-]?\d+(\.\d+)?[eE][+\-]?\d+$")


def normalize_phone(raw: Any) -> Tuple[Optional[str], Optional[str]]:
    """
    A phone as typed or as a spreadsheet cell → (E.164 "+972501234567", None), or (None, why):

    * `phone_missing` — empty;
    * `phone_invalid` — not a number we can send to (a foreign number must be in "+" form);
    * `phone_not_mobile` — an Israeli landline (no WhatsApp);
    * `phone_scientific` — "9.72501E+11": a spreadsheet already lost its digits.

    The Israeli shapes are the notification service's (app/services/notifications/phone.py):
    05X…, 5X… (a leading zero Excel dropped), 972…, +972…, 00972…, and "+972 050…".
    """
    if raw is None:
        return None, "phone_missing"
    if isinstance(raw, float) and raw.is_integer():
        raw = int(raw)
    text = str(raw).strip()
    if not text:
        return None, "phone_missing"
    if _SCIENTIFIC.match(text):
        return None, "phone_scientific"
    if _EXCEL_FLOAT.match(text):
        text = text.split(".", 1)[0]
    try:
        e164 = phones.normalize_phone(text)
    except phones.PhoneError as exc:
        return None, ("phone_missing" if exc.code == "phone_empty" else "phone_invalid")
    if e164.startswith("+972") and not phones.is_israeli_mobile(e164):
        return None, "phone_not_mobile"
    return e164, None


def wa_digits(e164: Optional[str]) -> Optional[str]:
    """"+972501234567" → "972501234567" — what wa.me and the Cloud API take."""
    return e164[1:] if e164 and e164.startswith("+") else e164


def display_phone(e164: Optional[str]) -> str:
    """"+972501234567" → "050-123-4567"; a foreign number stays "+…"."""
    if not e164:
        return ""
    if phones.is_israeli_mobile(e164):
        local = "0" + e164[4:]
        return f"{local[:3]}-{local[3:6]}-{local[6:]}"
    return e164


def _phone_of(r: VoucherDistributionRecipient) -> Optional[str]:
    return crypto.decrypt_text(r.phone_ciphertext) if r.phone_ciphertext else None


# ── Links ─────────────────────────────────────────────────────────────────────


def new_token() -> str:
    return crypto.random_token(TOKEN_BYTES)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def link_base_url() -> str:
    s = distribution_settings()
    base = (s.voucher_link_base_url or s.public_base_url or "").strip()
    if not base:
        # Uploaded media's own base (PUBLIC_BASE_URL in the environment, else localhost).
        from app.services import local_media

        base = local_media._base_url()
    return (base or "http://localhost:8001").rstrip("/")


def _api_prefix() -> str:
    from app.config import get_settings

    return (get_settings().api_v1_prefix or "").rstrip("/")


def public_path(token: str) -> str:
    return f"{_api_prefix()}/public/vouchers/{token}"


def public_link(token: str) -> str:
    return link_base_url() + public_path(token)


def default_link_expiry(batch: PrepaidVoucherBatch, dist: Optional[VoucherDistribution], now: datetime) -> datetime:
    """The distribution's own date, else the batch's validity end + 7 days, else 60 days from now."""
    if dist is not None and dist.link_expires_at is not None:
        return _utc(dist.link_expires_at)
    if batch.valid_until is not None:
        return _utc(batch.valid_until) + LINK_GRACE
    return now + LINK_DEFAULT_LIFETIME


def _issue_token(r: VoucherDistributionRecipient, expires_at: datetime, now: datetime) -> str:
    token = new_token()
    r.token_hash = token_hash(token)
    r.token_ciphertext = crypto.encrypt_text(token)
    r.token_issued_at = now
    r.token_expires_at = expires_at
    r.token_revoked_at = None
    r.token_version = int(r.token_version or 0) + 1
    return token


def effective_expiry(
    r: VoucherDistributionRecipient, batch: Optional[PrepaidVoucherBatch], dist: Optional[VoucherDistribution],
) -> Optional[datetime]:
    """
    When the link stops working. Stored at issue; but with no date of the distribution's own, a
    link follows its batch: validity extended after sending → the links live on to its new end
    + 7 days (never earlier than issued — shortening the batch never cuts a link sent).
    """
    stored = _utc(r.token_expires_at)
    if batch is not None and batch.valid_until is not None and (dist is None or dist.link_expires_at is None):
        follow = _utc(batch.valid_until) + LINK_GRACE
        if stored is None or follow > stored:
            return follow
    return stored


def link_active(r: VoucherDistributionRecipient, now: datetime, expires_at: Optional[datetime] = None) -> bool:
    """Live: issued, not revoked, not removed or erased, not expired ([expires_at]: the effective expiry)."""
    expires = _utc(expires_at) if expires_at is not None else _utc(r.token_expires_at)
    return bool(
        r.token_hash and r.token_revoked_at is None and r.deleted_at is None and r.anonymized_at is None
        and (expires is None or expires > now)
    )


def link_of(r: VoucherDistributionRecipient) -> Optional[str]:
    """The recipient's link in the clear (dashboard only), or None (revoked / erased / key changed)."""
    if not r.token_ciphertext or r.token_revoked_at is not None:
        return None
    token = crypto.decrypt_text(r.token_ciphertext)
    return public_link(token) if token else None


# ── Messages ──────────────────────────────────────────────────────────────────

_PLACEHOLDER = re.compile(r"\{([^{}\n]{1,24})\}")


def render_message(template: Optional[str], values: Dict[str, Any]) -> str:
    """
    The template with its placeholders filled ({שם} or {name} …; an unknown one is left as is).
    An empty value leaves no stray space before punctuation ("שלום ," → "שלום,"). The link is
    always in the message: appended on a line of its own when the template has no {קישור}.
    The dashboard's copy is client/src/lib/voucherDistribution.ts (`renderMessage`).
    """
    def sub(m: "re.Match[str]") -> str:
        key = PLACEHOLDERS.get(m.group(1).strip())
        if key is None:
            return m.group(0)
        value = values.get(key)
        return "" if value is None else str(value)

    text = _PLACEHOLDER.sub(sub, template or "")
    text = re.sub(r"[ \t]+([,.!?:;])", r"\1", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = "\n".join(line.strip() for line in text.split("\n")).strip()
    link = values.get("link")
    if link and link not in text:
        text = (text + "\n" + link) if text else link
    return text


def serials_text(serials: Sequence[int], limit: int = 8) -> str:
    """[1, 2, 3, 5, 7, 8] → "0001-0003, 0005, 0007-0008" (the serial as printed, "מס׳ 0008")."""
    ranges: List[List[int]] = []
    for s in sorted(set(int(x) for x in serials)):
        if ranges and s == ranges[-1][1] + 1:
            ranges[-1][1] = s
        else:
            ranges.append([s, s])
    parts = [f"{a:04d}" if a == b else f"{a:04d}-{b:04d}" for a, b in ranges]
    if len(parts) > limit:
        parts = parts[:limit] + ["…"]
    return ", ".join(parts)


def _zone(db: Session, batch: PrepaidVoucherBatch):
    from app.services.reports import _load_zoneinfo, resolve_report_timezone

    try:
        return _load_zoneinfo(resolve_report_timezone(db, batch.tenant_id, None))
    except Exception:  # noqa: BLE001 — a date in UTC beats no message
        return None


def _local_day(moment: Optional[datetime], zone) -> Optional[str]:
    moment = _utc(moment)
    if moment is None:
        return None
    if zone is not None:
        moment = moment.astimezone(zone)
    return moment.strftime("%d/%m/%Y")


def message_values(
    batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient, serials: Sequence[int], link: Optional[str], zone,
) -> Dict[str, Any]:
    return {
        "name": (r.name or "").strip(),
        "event": batch.event_name or batch.name,
        "count": len(serials),
        "serials": serials_text(serials),
        "link": link,
        "validUntil": _local_day(batch.valid_until, zone) or "",
        "group": r.group_no if r.group_no is not None else "",
    }


def template_for(dist: Optional[VoucherDistribution], kind: str) -> str:
    if kind == "group":
        return (dist.group_message_template if dist is not None else None) or DEFAULT_GROUP_MESSAGE
    return (dist.message_template if dist is not None else None) or DEFAULT_MESSAGE


# ── The batch's distribution ──────────────────────────────────────────────────


def get_distribution(db: Session, batch: PrepaidVoucherBatch) -> Optional[VoucherDistribution]:
    return db.query(VoucherDistribution).filter(VoucherDistribution.batch_id == batch.id).first()


def ensure_distribution(db: Session, batch: PrepaidVoucherBatch, user: Optional[User]) -> VoucherDistribution:
    dist = get_distribution(db, batch)
    if dist is None:
        dist = VoucherDistribution(
            id=uuid.uuid4(), tenant_id=batch.tenant_id, batch_id=batch.id, layout=DEFAULT_LAYOUT,
            created_by=getattr(user, "id", None),
        )
        db.add(dist)
        db.flush()
    return dist


def _event(
    db: Session,
    batch: PrepaidVoucherBatch,
    action: str,
    *,
    user: Optional[User] = None,
    recipient: Optional[VoucherDistributionRecipient] = None,
    details: Optional[Dict[str, Any]] = None,
    ip: Optional[str] = None,
    user_agent: Optional[str] = None,
    now: Optional[datetime] = None,
) -> VoucherDistributionEvent:
    """One line of the audit trail. Never a phone or a name in it."""
    ev = VoucherDistributionEvent(
        id=uuid.uuid4(),
        tenant_id=batch.tenant_id,
        batch_id=batch.id,
        recipient_id=getattr(recipient, "id", None),
        action=action,
        user_id=getattr(user, "id", None),
        user_name=PV._user_name(user),
        details=details or None,
        ip=(ip or None) and ip[:64],
        user_agent=(user_agent or None) and user_agent[:200],
        created_at=now or _now(),
    )
    db.add(ev)
    return ev


def batch_over(batch: PrepaidVoucherBatch, now: datetime) -> bool:
    """Cancelled, or past its validity: the vouchers can no longer be used anywhere."""
    if batch.status == "cancelled":
        return True
    return batch.valid_until is not None and _utc(batch.valid_until) < now


def update_settings(db: Session, user: User, batch: PrepaidVoucherBatch, body) -> VoucherDistribution:
    """The messages, the layout and the links' expiry; a new expiry moves every live link."""
    dist = ensure_distribution(db, batch, user)
    sent = getattr(body, "model_fields_set", set())
    changed: Dict[str, Any] = {}
    now = _now()
    if "message_template" in sent:
        value = (body.message_template or "").strip() or None
        if value != dist.message_template:
            dist.message_template = value
            changed["messageTemplate"] = True
    if "group_message_template" in sent:
        value = (body.group_message_template or "").strip() or None
        if value != dist.group_message_template:
            dist.group_message_template = value
            changed["groupMessageTemplate"] = True
    if "layout" in sent and body.layout:
        if body.layout not in LAYOUTS:
            raise _http(status.HTTP_400_BAD_REQUEST, LAYOUT_INVALID)
        if body.layout != dist.layout:
            changed["layout"] = [dist.layout, body.layout]
            dist.layout = body.layout
    if "link_expires_at" in sent:
        value = _utc(body.link_expires_at)
        if value is not None and value <= now:
            # A date already past would kill every link sent at once — never by a typo.
            raise _http(status.HTTP_400_BAD_REQUEST, EXPIRY_PAST)
        if value != _utc(dist.link_expires_at):
            dist.link_expires_at = value
            changed["linkExpiresAt"] = _iso(value)
            expiry = default_link_expiry(batch, dist, now)
            live = (
                db.query(VoucherDistributionRecipient)
                .filter(
                    VoucherDistributionRecipient.batch_id == batch.id,
                    VoucherDistributionRecipient.token_hash.isnot(None),
                    VoucherDistributionRecipient.token_revoked_at.is_(None),
                    VoucherDistributionRecipient.deleted_at.is_(None),
                )
                .all()
            )
            for r in live:
                r.token_expires_at = expiry
            changed["linksMoved"] = len(live)
    if changed:
        dist.updated_by = getattr(user, "id", None)
        _event(db, batch, "settings", user=user, details=changed, now=now)
    db.flush()
    return dist


# ── Vouchers to give out ──────────────────────────────────────────────────────


def _assigned_ids(db: Session, batch: PrepaidVoucherBatch) -> set:
    return {
        vid for (vid,) in db.query(VoucherDistributionAssignment.voucher_id)
        .filter(VoucherDistributionAssignment.batch_id == batch.id)
    }


def free_vouchers(db: Session, batch: PrepaidVoucherBatch) -> List[PrepaidVoucher]:
    """Unused (`active`) vouchers no recipient holds yet, by serial — what an import gives out."""
    taken = _assigned_ids(db, batch)
    rows = (
        db.query(PrepaidVoucher)
        .filter(PrepaidVoucher.batch_id == batch.id, PrepaidVoucher.status == "active")
        .order_by(PrepaidVoucher.serial)
        .all()
    )
    return [v for v in rows if v.id not in taken]


def groups_overview(db: Session, batch: PrepaidVoucherBatch) -> List[Dict[str, Any]]:
    """Per group: its serials, how many vouchers, how many still free to send, and who holds the rest."""
    taken = _assigned_ids(db, batch)
    out: Dict[int, Dict[str, Any]] = {}
    for v in db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == batch.id).order_by(PrepaidVoucher.serial):
        if v.group_no is None:
            continue
        g = out.setdefault(v.group_no, {"group": v.group_no, "fromSerial": v.serial, "toSerial": v.serial,
                                        "total": 0, "free": 0, "assigned": 0})
        g["toSerial"] = v.serial
        g["total"] += 1
        if v.id in taken:
            g["assigned"] += 1
        elif v.status == "active":
            g["free"] += 1
    return [out[k] for k in sorted(out)]


# ── Import: preview and commit (one computation) ──────────────────────────────


@dataclass
class RowIn:
    name: Optional[str] = None
    phone: Any = None
    group: Optional[int] = None
    count: Optional[int] = None


@dataclass
class PlannedRow:
    index: int
    name: Optional[str]
    phone_raw: Optional[str]
    phone: Optional[str]
    group: Optional[int]
    count: Optional[int]
    vouchers: List[PrepaidVoucher] = field(default_factory=list)
    problems: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems


def _clean_name(value: Any) -> Optional[str]:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:NAME_MAX] or None


def plan_import(
    db: Session,
    batch: PrepaidVoucherBatch,
    rows: Sequence[RowIn],
    *,
    mode: str,
    per_recipient: int = 1,
    kind: str = "person",
    allow_duplicates: bool = False,
) -> List[PlannedRow]:
    """
    Who would get which vouchers — the preview, and (under the batch's lock) the import itself.
    A row with a problem gives nothing and takes nothing; the rows after it go on.
    """
    if mode not in MODES:
        raise _http(status.HTTP_400_BAD_REQUEST, "distribution_mode_invalid")
    if kind not in KINDS:
        raise _http(status.HTTP_400_BAD_REQUEST, "distribution_kind_invalid")
    if kind == "group" and mode != "group":
        raise _http(status.HTTP_400_BAD_REQUEST, "distribution_mode_invalid")
    free = free_vouchers(db, batch)
    by_group: Dict[Optional[int], List[PrepaidVoucher]] = {}
    for v in free:
        by_group.setdefault(v.group_no, []).append(v)
    groups = {
        g for (g,) in db.query(PrepaidVoucher.group_no).filter(PrepaidVoucher.batch_id == batch.id).distinct()
        if g is not None
    }
    known = {
        h for (h,) in db.query(VoucherDistributionRecipient.phone_hash).filter(
            VoucherDistributionRecipient.batch_id == batch.id,
            VoucherDistributionRecipient.kind == kind,
            VoucherDistributionRecipient.deleted_at.is_(None),
            VoucherDistributionRecipient.phone_hash.isnot(None),
        )
    }
    seen: set = set()
    claimed: set = set()
    pool = list(free)
    exhausted = False
    out: List[PlannedRow] = []
    for i, row in enumerate(rows):
        raw = None if row.phone is None else str(row.phone).strip()
        p = PlannedRow(index=i + 1, name=_clean_name(row.name), phone_raw=raw or None, phone=None,
                       group=row.group, count=row.count)
        e164, err = normalize_phone(row.phone)
        if err and not (err == "phone_missing" and kind == "group"):
            p.problems.append(err)
        hashed = phones.phone_hash(e164) if e164 else None
        if hashed and (hashed in seen or hashed in known):
            (p.warnings if (allow_duplicates or kind == "group") else p.problems).append("duplicate_phone")
        p.phone = e164
        if mode == "group":
            if row.group is None:
                p.problems.append("group_missing")
            elif row.group not in groups:
                p.problems.append("group_not_found")
            elif row.group in claimed:
                p.problems.append("group_duplicate")
            elif not by_group.get(row.group):
                p.problems.append("group_taken")
        else:
            n = 1 if mode == "one" else (row.count if row.count is not None else per_recipient)
            p.count = n
            if not isinstance(n, int) or n < 1 or n > MAX_PER_RECIPIENT:
                p.problems.append("count_invalid")
        if p.ok:
            if mode == "group":
                p.vouchers = list(by_group[row.group])
                claimed.add(row.group)
            elif exhausted or len(pool) < p.count:
                exhausted = True
                p.problems.append("not_enough")
            else:
                p.vouchers, pool = pool[:p.count], pool[p.count:]
        if p.ok and hashed:
            seen.add(hashed)
        out.append(p)
    return out


def planned_out(p: PlannedRow) -> Dict[str, Any]:
    serials = [v.serial for v in p.vouchers]
    return {
        "row": p.index,
        "name": p.name,
        "phoneRaw": p.phone_raw,
        "phone": wa_digits(p.phone),
        "phoneDisplay": display_phone(p.phone),
        "group": p.group,
        "count": p.count,
        "serials": serials,
        "serialsText": serials_text(serials, limit=12),
        "voucherCount": len(serials),
        "status": "error" if p.problems else ("warning" if p.warnings else "ok"),
        "problems": p.problems,
        "warnings": p.warnings,
    }


def plan_summary(db: Session, batch: PrepaidVoucherBatch, plan: Sequence[PlannedRow]) -> Dict[str, Any]:
    free = len(free_vouchers(db, batch))
    given = sum(len(p.vouchers) for p in plan if p.ok)
    return {
        "rows": len(plan),
        "ok": sum(1 for p in plan if p.ok),
        "errors": sum(1 for p in plan if not p.ok),
        "warnings": sum(1 for p in plan if p.ok and p.warnings),
        "vouchersFree": free,
        "vouchersAssigned": given,
        "vouchersLeft": free - given,
    }


def _rows_in(body) -> List[RowIn]:
    return [RowIn(name=r.name, phone=r.phone, group=r.group, count=r.count) for r in (body.rows or [])]


def preview(db: Session, batch: PrepaidVoucherBatch, body) -> Dict[str, Any]:
    plan = plan_import(
        db, batch, _rows_in(body), mode=body.mode, per_recipient=body.per_recipient, kind=body.kind,
        allow_duplicates=body.allow_duplicates,
    )
    return {"rows": [planned_out(p) for p in plan], "summary": plan_summary(db, batch, plan)}


def import_recipients(db: Session, user: User, batch: PrepaidVoucherBatch, body) -> Dict[str, Any]:
    """
    Store the rows that have no problem, give them their vouchers and their links — under the
    batch's row lock, so two imports cannot hand out the same voucher (the unique key on the
    voucher is the last guard). Rows with a problem are returned, not stored.
    """
    if batch.status == "cancelled":
        raise _http(status.HTTP_409_CONFLICT, PV.BATCH_CANCELLED)
    db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == batch.id).with_for_update().one()
    plan = plan_import(
        db, batch, _rows_in(body), mode=body.mode, per_recipient=body.per_recipient, kind=body.kind,
        allow_duplicates=body.allow_duplicates,
    )
    summary = plan_summary(db, batch, plan)
    now = _now()
    dist = ensure_distribution(db, batch, user)
    expiry = default_link_expiry(batch, dist, now)
    last = (
        db.query(VoucherDistributionRecipient.sort_order)
        .filter(VoucherDistributionRecipient.batch_id == batch.id)
        .order_by(VoucherDistributionRecipient.sort_order.desc())
        .first()
    )
    order = (last[0] if last else 0) + 1
    created: List[VoucherDistributionRecipient] = []
    for p in plan:
        if not p.ok:
            continue
        r = VoucherDistributionRecipient(
            id=uuid.uuid4(), tenant_id=batch.tenant_id, batch_id=batch.id, kind=body.kind, name=p.name,
            phone_ciphertext=crypto.encrypt_text(p.phone) if p.phone else None,
            phone_hash=phones.phone_hash(p.phone) if p.phone else None,
            group_no=p.group if body.mode == "group" else None, sort_order=order, status="pending",
            created_by=getattr(user, "id", None), created_at=now, updated_at=now,
        )
        order += 1
        _issue_token(r, expiry, now)
        db.add(r)
        db.flush()
        for v in p.vouchers:
            db.add(VoucherDistributionAssignment(
                id=uuid.uuid4(), tenant_id=batch.tenant_id, batch_id=batch.id, recipient_id=r.id,
                voucher_id=v.id, serial=v.serial, assigned_by=getattr(user, "id", None), assigned_at=now,
            ))
        _event(db, batch, "assign", user=user, recipient=r, now=now, details={
            "serials": [v.serial for v in p.vouchers], "group": r.group_no, "mode": body.mode,
        })
        created.append(r)
    _event(db, batch, "import", user=user, now=now, details={
        "mode": body.mode, "kind": body.kind, "rows": summary["rows"], "created": len(created),
        "skipped": summary["errors"], "vouchers": summary["vouchersAssigned"],
    })
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise _http(status.HTTP_409_CONFLICT, DISTRIBUTION_CONFLICT)
    return {
        "summary": {**summary, "created": len(created)},
        "skipped": [planned_out(p) for p in plan if not p.ok],
        "createdIds": [str(r.id) for r in created],
    }


# ── Recipients ────────────────────────────────────────────────────────────────


def get_recipient(db: Session, batch: PrepaidVoucherBatch, recipient_id) -> VoucherDistributionRecipient:
    wanted = PV._as_uuid(recipient_id)
    r = (
        db.query(VoucherDistributionRecipient)
        .filter(VoucherDistributionRecipient.id == wanted, VoucherDistributionRecipient.batch_id == batch.id)
        .first()
        if wanted else None
    )
    if r is None:
        raise _http(status.HTTP_404_NOT_FOUND, RECIPIENT_NOT_FOUND)
    return r


def _live(r: VoucherDistributionRecipient) -> None:
    if r.deleted_at is not None or r.anonymized_at is not None:
        raise _http(status.HTTP_409_CONFLICT, RECIPIENT_REMOVED)


def assignments_of(db: Session, recipient_ids: Iterable[uuid.UUID]) -> Dict[uuid.UUID, List[VoucherDistributionAssignment]]:
    ids = list(recipient_ids)
    out: Dict[uuid.UUID, List[VoucherDistributionAssignment]] = {i: [] for i in ids}
    if not ids:
        return out
    for a in (
        db.query(VoucherDistributionAssignment)
        .filter(VoucherDistributionAssignment.recipient_id.in_(ids))
        .order_by(VoucherDistributionAssignment.serial)
    ):
        out.setdefault(a.recipient_id, []).append(a)
    return out


def recipient_vouchers(db: Session, r: VoucherDistributionRecipient, *, sendable_only: bool = True) -> List[PrepaidVoucher]:
    """The recipient's vouchers by serial — only those still usable (not used, not cancelled) by default."""
    q = (
        db.query(PrepaidVoucher)
        .join(VoucherDistributionAssignment, VoucherDistributionAssignment.voucher_id == PrepaidVoucher.id)
        .filter(VoucherDistributionAssignment.recipient_id == r.id)
    )
    if sendable_only:
        q = q.filter(PrepaidVoucher.status.in_(("active", "partially_used")))
    return q.order_by(PrepaidVoucher.serial).all()


def recipient_state(r: VoucherDistributionRecipient) -> str:
    """pending / sent / delivered / read / opened (the person opened the link) / failed."""
    if r.opened_at is not None or r.downloaded_at is not None:
        return "opened"
    if r.status == "failed":
        return "failed"
    return r.status if r.status in STATUS_RANK else "pending"


def recipient_out(
    r: VoucherDistributionRecipient,
    *,
    batch: PrepaidVoucherBatch,
    dist: Optional[VoucherDistribution],
    serials: Sequence[int],
    zone,
    now: datetime,
) -> Dict[str, Any]:
    e164 = _phone_of(r)
    expires = effective_expiry(r, batch, dist)
    link = link_of(r) if link_active(r, now, expires) else None
    message = render_message(template_for(dist, r.kind), message_values(batch, r, serials, link, zone)) if link else None
    return {
        "id": str(r.id),
        "kind": r.kind,
        "name": r.name,
        "phone": wa_digits(e164),
        "phoneDisplay": display_phone(e164),
        "group": r.group_no,
        "serials": list(serials),
        "serialsText": serials_text(serials, limit=12),
        "voucherCount": len(serials),
        "state": recipient_state(r),
        "status": r.status,
        "sentAt": _iso(r.sent_at),
        "sentVia": r.sent_via,
        "sentByName": r.sent_by_name,
        "deliveredAt": _iso(r.delivered_at),
        "readAt": _iso(r.read_at),
        "failedAt": _iso(r.failed_at),
        "failureReason": r.failure_reason,
        "openedAt": _iso(r.opened_at),
        "lastOpenedAt": _iso(r.last_opened_at),
        "openCount": int(r.open_count or 0),
        "downloadedAt": _iso(r.downloaded_at),
        "downloadCount": int(r.download_count or 0),
        "link": link,
        "linkActive": link is not None,
        "linkExpiresAt": _iso(expires),
        "linkRevokedAt": _iso(r.token_revoked_at),
        "linkVersion": int(r.token_version or 0),
        "message": message,
        "api": {
            "status": r.api_status,
            "attempts": int(r.api_attempts or 0),
            "nextAttemptAt": _iso(r.api_next_attempt_at),
            "lastError": r.api_last_error,
        },
        "createdAt": _iso(r.created_at),
        "deletedAt": _iso(r.deleted_at),
        "anonymizedAt": _iso(r.anonymized_at),
    }


def _matches(r: VoucherDistributionRecipient, serials: Sequence[int], q: str) -> bool:
    q = q.strip()
    if not q:
        return True
    if q.isdigit() and int(q) in set(serials):
        return True
    digits = re.sub(r"\D", "", q)
    if len(digits) >= 3:
        e164 = _phone_of(r) or ""
        local = ("0" + e164[4:]) if e164.startswith("+972") else ""
        if digits in e164 or (local and digits in local):
            return True
    return bool(r.name) and q.casefold() in r.name.casefold()


def list_recipients(
    db: Session,
    batch: PrepaidVoucherBatch,
    *,
    state: Optional[str] = None,
    kind: Optional[str] = None,
    q: Optional[str] = None,
    include_removed: bool = False,
    limit: int = 500,
    offset: int = 0,
) -> Dict[str, Any]:
    now = _now()
    query = db.query(VoucherDistributionRecipient).filter(VoucherDistributionRecipient.batch_id == batch.id)
    if not include_removed:
        query = query.filter(VoucherDistributionRecipient.deleted_at.is_(None))
    rows = query.order_by(VoucherDistributionRecipient.sort_order, VoucherDistributionRecipient.created_at).all()
    held = assignments_of(db, [r.id for r in rows])
    serials = {r.id: [a.serial for a in held.get(r.id, [])] for r in rows}
    counts = {s: 0 for s in STATES}
    for r in rows:
        if r.deleted_at is None:
            counts[recipient_state(r)] += 1
    picked = [
        r for r in rows
        if (not state or recipient_state(r) == state)
        and (not kind or r.kind == kind)
        and (not q or _matches(r, serials[r.id], q))
    ]
    dist = get_distribution(db, batch)
    zone = _zone(db, batch)
    page = picked[offset:offset + limit]
    return {
        "items": [recipient_out(r, batch=batch, dist=dist, serials=serials[r.id], zone=zone, now=now) for r in page],
        "total": len(picked),
        "counts": counts,
        "recipients": sum(counts.values()),
    }


def one_out(db: Session, batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient) -> Dict[str, Any]:
    serials = [a.serial for a in assignments_of(db, [r.id])[r.id]]
    return recipient_out(r, batch=batch, dist=get_distribution(db, batch), serials=serials, zone=_zone(db, batch), now=_now())


# ── Sending: marks, links ─────────────────────────────────────────────────────


def mark_sent(db: Session, user: User, batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient, via: str) -> None:
    """Sent by hand (wa.me / the share sheet / a downloaded PDF / just marked). A resend is logged too."""
    _live(r)
    now = _now()
    resend = r.sent_at is not None
    r.status = "sent"
    r.sent_at = now
    r.sent_via = via
    r.sent_by = getattr(user, "id", None)
    r.sent_by_name = PV._user_name(user)
    r.failed_at = None
    r.failure_reason = None
    _event(db, batch, "sent", user=user, recipient=r, now=now, details={"via": via, "resend": resend})
    db.flush()


def mark_pending(db: Session, user: User, batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient) -> None:
    """Undo a "sent" mark (the operator did not press send in WhatsApp after all)."""
    _live(r)
    previous = {"via": r.sent_via, "sentAt": _iso(r.sent_at)}
    r.status = "pending"
    r.sent_at = None
    r.sent_via = None
    r.sent_by = None
    r.sent_by_name = None
    _event(db, batch, "unsent", user=user, recipient=r, details=previous)
    db.flush()


def revoke_link(db: Session, user: User, batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient,
                reason: Optional[str] = None) -> None:
    if r.token_revoked_at is None and r.token_hash:
        r.token_revoked_at = _now()
        _event(db, batch, "link_revoked", user=user, recipient=r,
               details={"version": r.token_version, "reason": (reason or "").strip() or None})
        db.flush()


def reissue_link(db: Session, user: User, batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient) -> None:
    """A new link; the one sent before stops working at once."""
    _live(r)
    now = _now()
    old = r.token_version
    _issue_token(r, default_link_expiry(batch, get_distribution(db, batch), now), now)
    _event(db, batch, "link_reissued", user=user, recipient=r, now=now,
           details={"from": old, "to": r.token_version, "expiresAt": _iso(r.token_expires_at)})
    db.flush()


def unassign(
    db: Session, user: User, batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient,
    voucher_ids: Optional[Sequence[Any]] = None, reason: Optional[str] = None,
) -> int:
    """Take vouchers back from a recipient (all, or the ones named); they are free to give again."""
    q = db.query(VoucherDistributionAssignment).filter(VoucherDistributionAssignment.recipient_id == r.id)
    if voucher_ids:
        wanted = [PV._as_uuid(v) for v in voucher_ids]
        q = q.filter(VoucherDistributionAssignment.voucher_id.in_([w for w in wanted if w is not None]))
    rows = q.order_by(VoucherDistributionAssignment.serial).all()
    if not rows:
        return 0
    serials = [a.serial for a in rows]
    for a in rows:
        db.delete(a)
    _event(db, batch, "unassign", user=user, recipient=r, details={
        "serials": serials, "reason": (reason or "").strip() or None, "wasSent": r.sent_at is not None,
    })
    db.flush()
    return len(rows)


def remove_recipient(db: Session, user: User, batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient,
                     reason: Optional[str] = None) -> None:
    """Off the list: the link revoked, the vouchers freed (logged). The phone stays until erased."""
    if r.deleted_at is not None:
        return
    revoke_link(db, user, batch, r, reason="removed")
    freed = unassign(db, user, batch, r, None, reason or "removed")
    r.deleted_at = _now()
    _event(db, batch, "removed", user=user, recipient=r, details={"freed": freed, "reason": (reason or "").strip() or None})
    db.flush()


def _nothing_left(db: Session, r: VoucherDistributionRecipient) -> bool:
    return not recipient_vouchers(db, r, sendable_only=True)


def erasable(db: Session, batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient, now: datetime) -> bool:
    """The batch is over, or nothing the recipient holds can still be used."""
    return batch_over(batch, now) or _nothing_left(db, r)


def _erase(db: Session, batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient, now: datetime) -> None:
    r.name = None
    r.phone_ciphertext = None
    r.phone_hash = None
    r.token_ciphertext = None
    if r.token_revoked_at is None:
        r.token_revoked_at = now
    r.anonymized_at = now
    # The addresses the link was opened from are the recipient's too.
    db.query(VoucherDistributionEvent).filter(VoucherDistributionEvent.recipient_id == r.id).update(
        {VoucherDistributionEvent.ip: None, VoucherDistributionEvent.user_agent: None}, synchronize_session=False,
    )


def erase_recipient(db: Session, user: User, batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient) -> None:
    """
    Erase a recipient's personal data — once the batch is over, or once nothing they hold can
    still be used. The row stays (anonymised): the counts and the trail still add up.
    """
    if r.anonymized_at is not None:
        return
    now = _now()
    if not erasable(db, batch, r, now):
        raise _http(status.HTTP_409_CONFLICT, BATCH_ACTIVE)
    _erase(db, batch, r, now)
    _event(db, batch, "erased", user=user, recipient=r, now=now)
    db.flush()


def erase_all(db: Session, user: User, batch: PrepaidVoucherBatch) -> int:
    """Every recipient of a batch that is over (cancelled or past its validity), removed ones too."""
    now = _now()
    if not batch_over(batch, now):
        raise _http(status.HTTP_409_CONFLICT, BATCH_ACTIVE)
    rows = (
        db.query(VoucherDistributionRecipient)
        .filter(VoucherDistributionRecipient.batch_id == batch.id, VoucherDistributionRecipient.anonymized_at.is_(None))
        .all()
    )
    for r in rows:
        _erase(db, batch, r, now)
    if rows:
        _event(db, batch, "erased", user=user, now=now, details={"count": len(rows), "all": True})
    db.flush()
    return len(rows)


# ── The PDF ───────────────────────────────────────────────────────────────────


def render_recipient_pdf(
    db: Session, batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient, layout: Optional[str] = None,
) -> Tuple[bytes, str, int]:
    """
    The recipient's own vouchers — only theirs, only those still usable — drawn by the batch's
    renderer (app/services/prepaid_voucher_pdf.render_pdf, which draws any subset it is given),
    one voucher a page in the distribution's layout. 404 `distribution_no_vouchers` when none is left.
    """
    from app.services import prepaid_voucher_pdf as PDF

    vouchers = recipient_vouchers(db, r, sendable_only=True)
    if not vouchers:
        raise _http(status.HTTP_404_NOT_FOUND, NO_VOUCHERS)
    dist = get_distribution(db, batch)
    preset = layout or (dist.layout if dist is not None else None) or DEFAULT_LAYOUT
    if preset not in LAYOUTS:
        preset = DEFAULT_LAYOUT
    zone = _zone(db, batch)
    data = PDF.render_pdf(
        batch, vouchers, PDF.geometry(preset), logo=PDF.load_logo(batch.logo_url), opts=PDF.options_for(batch, zone),
    )
    return data, pdf_file_name(batch, r, [v.serial for v in vouchers]), len(vouchers)


def pdf_file_name(batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient, serials: Sequence[int]) -> str:
    from app.services import prepaid_voucher_pdf as PDF

    base = PDF.safe_name(batch.event_name or batch.name)
    if r.kind == "group" and r.group_no is not None:
        return f"{base}_קבוצה-{r.group_no}.pdf"
    if not serials:
        return f"{base}.pdf"
    lo, hi = min(serials), max(serials)
    return f"{base}_{lo:04d}.pdf" if lo == hi else f"{base}_{lo:04d}-{hi:04d}.pdf"


# ── The public link ───────────────────────────────────────────────────────────

_TOKEN_SHAPE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


def is_preview_agent(user_agent: Optional[str]) -> bool:
    ua = (user_agent or "").lower()
    return any(marker in ua for marker in PREVIEW_AGENTS)


def resolve_link(db: Session, token: str, now: datetime) -> Tuple[Optional[VoucherDistributionRecipient], Optional[str]]:
    """(the recipient, None) for a live link; (the recipient or None, why) otherwise."""
    if not token or not _TOKEN_SHAPE.match(token):
        return None, "malformed"
    r = db.query(VoucherDistributionRecipient).filter(VoucherDistributionRecipient.token_hash == token_hash(token)).first()
    if r is None:
        return None, "unknown"
    if r.deleted_at is not None or r.anonymized_at is not None:
        return r, "removed"
    if r.token_revoked_at is not None:
        return r, "revoked"
    batch = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == r.batch_id).first()
    if batch is None or batch.status == "cancelled":
        return r, "batch_cancelled"
    expires = effective_expiry(r, batch, get_distribution(db, batch))
    if expires is not None and expires <= now:
        return r, "expired"
    return r, None


def record_public(
    db: Session, batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient, what: str, *,
    ip: Optional[str], user_agent: Optional[str], head: bool = False, now: Optional[datetime] = None,
) -> str:
    """
    Log a public request on the link: `page` (the landing page) or `pdf`. A preview robot or a
    HEAD request is `link_preview` and changes nothing; a person's is `link_opened` /
    `link_downloaded` and moves the recipient's first / last / count. Returns the action logged.
    """
    now = now or _now()
    if head or is_preview_agent(user_agent):
        action = "link_preview"
    elif what == "pdf":
        action = "link_downloaded"
        r.downloaded_at = r.downloaded_at or now
        r.download_count = int(r.download_count or 0) + 1
        r.opened_at = r.opened_at or now
        r.last_opened_at = now
    else:
        action = "link_opened"
        r.opened_at = r.opened_at or now
        r.last_opened_at = now
        r.open_count = int(r.open_count or 0) + 1
    _event(db, batch, action, recipient=r, ip=ip, user_agent=user_agent, now=now, details={"what": what})
    return action


def record_denied(db: Session, r: VoucherDistributionRecipient, reason: str, *, ip: Optional[str],
                  user_agent: Optional[str]) -> None:
    batch = db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == r.batch_id).first()
    if batch is not None:
        _event(db, batch, "link_denied", recipient=r, ip=ip, user_agent=user_agent, details={"reason": reason})


_PAGE_STYLE = (
    "body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Arial,sans-serif;background:#f4f4f5;color:#18181b}"
    "main{max-width:28rem;margin:2.5rem auto;padding:1.5rem;background:#fff;border-radius:1rem;"
    "box-shadow:0 1px 3px rgba(0,0,0,.08);text-align:center}"
    "h1{font-size:1.4rem;margin:.2rem 0 .6rem}p{line-height:1.5;margin:.4rem 0}"
    ".lead{font-size:1.05rem;font-weight:600}.muted{color:#52525b;font-size:.9rem}"
    "a.btn{display:block;margin:1.2rem 0 .6rem;padding:.9rem 1rem;border-radius:.75rem;background:#16a34a;"
    "color:#fff;font-weight:700;text-decoration:none;font-size:1.05rem}"
    "a.alt{color:#15803d;font-weight:600}"
    "@media (prefers-color-scheme:dark){body{background:#18181b;color:#f4f4f5}main{background:#27272a}"
    ".muted{color:#a1a1aa}a.alt{color:#4ade80}}"
)


def _page(title: str, body: str, *, og: Optional[Tuple[str, str]] = None) -> str:
    meta = ""
    if og:
        meta = (
            f'<meta property="og:title" content="{html.escape(og[0])}">'
            f'<meta property="og:description" content="{html.escape(og[1])}">'
            '<meta property="og:type" content="website">'
        )
    return (
        '<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">'
        f"<title>{html.escape(title)}</title>{meta}<style>{_PAGE_STYLE}</style></head>"
        f"<body><main>{body}</main></body></html>"
    )


def landing_page(db: Session, batch: PrepaidVoucherBatch, r: VoucherDistributionRecipient, token: str) -> str:
    """
    The page the link opens: the event, how many vouchers, their validity, and the PDF. Never the
    recipient's name or phone (a forwarded link, a shared screen); no image (WhatsApp would cache
    a picture of the QR in its preview).
    """
    vouchers = recipient_vouchers(db, r, sendable_only=True)
    event = batch.event_name or batch.name
    zone = _zone(db, batch)
    until = _local_day(batch.valid_until, zone)
    pdf = html.escape(public_path(token) + "/pdf")
    if not vouchers:
        body = (
            f"<h1>{html.escape(event)}</h1><p class='lead'>אין בקישור זה שוברים פעילים.</p>"
            "<p class='muted'>ייתכן שכבר מומשו, בוטלו או הועברו. לשאלות פנו להפקה.</p>"
        )
        return _page(event, body, og=(f"שוברים — {event}", "קישור אישי לשוברים"))
    count = len(vouchers)
    serials = serials_text([v.serial for v in vouchers])
    lines = [f"<h1>{html.escape(event)}</h1>",
             f"<p class='lead'>{'שובר אחד' if count == 1 else f'{count} שוברים'} · מס׳ {html.escape(serials)}</p>"]
    if until:
        lines.append(f"<p>בתוקף עד {html.escape(until)}</p>")
    lines.append(f"<a class='btn' href='{pdf}?download=1'>הורדת השוברים (PDF)</a>")
    lines.append(f"<p><a class='alt' href='{pdf}'>צפייה בשוברים</a></p>")
    lines.append("<p class='muted'>מציגים את השובר (הברקוד) בקופה. זהו קישור אישי — אין להעבירו.</p>")
    og_desc = f"{'שובר אחד' if count == 1 else f'{count} שוברים'}" + (f" · בתוקף עד {until}" if until else "")
    return _page(f"השוברים שלך — {event}", "".join(lines), og=(f"השוברים שלך — {event}", og_desc))


def invalid_page() -> str:
    return _page(
        "הקישור אינו תקף",
        "<h1>הקישור אינו תקף</h1><p>הקישור אינו תקף או שפג תוקפו.</p><p class='muted'>לקבלת קישור חדש פנו להפקה.</p>",
    )


# ── Overview, export, trail ───────────────────────────────────────────────────


def distribution_out(db: Session, batch: PrepaidVoucherBatch) -> Dict[str, Any]:
    from app.services import whatsapp_cloud as WA

    now = _now()
    dist = get_distribution(db, batch)
    listing = list_recipients(db, batch, limit=0)
    vouchers_total = db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == batch.id).count()
    assigned = len(_assigned_ids(db, batch))
    return {
        "batchId": str(batch.id),
        "messageTemplate": dist.message_template if dist and dist.message_template else None,
        "groupMessageTemplate": dist.group_message_template if dist and dist.group_message_template else None,
        "defaultMessageTemplate": DEFAULT_MESSAGE,
        "defaultGroupMessageTemplate": DEFAULT_GROUP_MESSAGE,
        "layout": (dist.layout if dist else None) or DEFAULT_LAYOUT,
        "layouts": list(LAYOUTS),
        "linkExpiresAt": _iso(dist.link_expires_at) if dist else None,
        "defaultLinkExpiresAt": _iso(default_link_expiry(batch, None, now)),
        "effectiveLinkExpiresAt": _iso(default_link_expiry(batch, dist, now)),
        "counts": listing["counts"],
        "recipients": listing["recipients"],
        "vouchers": {"total": vouchers_total, "assigned": assigned, "free": len(free_vouchers(db, batch))},
        "grouped": bool(batch.group_size) or db.query(PrepaidVoucher).filter(
            PrepaidVoucher.batch_id == batch.id, PrepaidVoucher.group_no.isnot(None)).first() is not None,
        "batchOver": batch_over(batch, now),
        "batchCancelled": batch.status == "cancelled",
        "linkBase": link_base_url(),
        "api": WA.capability(db, batch.company_id),
    }


_STATE_HE = {"pending": "ממתין", "sent": "נשלח", "delivered": "נמסר", "read": "נקרא", "opened": "הקישור נפתח", "failed": "נכשל"}
_VIA_HE = {"wa_link": "וואטסאפ (קישור)", "share": "שיתוף עם הקובץ", "manual": "סימון ידני", "download": "PDF שהורד",
           "api": "WhatsApp Business API"}


def export_csv(db: Session, batch: PrepaidVoucherBatch) -> bytes:
    """
    Every recipient with where their sending stands, for Excel (UTF-8 with a BOM). Never the
    links themselves: whoever holds the file must not be able to open everyone's vouchers.
    """
    zone = _zone(db, batch)
    rows = (
        db.query(VoucherDistributionRecipient)
        .filter(VoucherDistributionRecipient.batch_id == batch.id)
        .order_by(VoucherDistributionRecipient.sort_order)
        .all()
    )
    held = assignments_of(db, [r.id for r in rows])
    dist = get_distribution(db, batch)

    def when(moment: Optional[datetime]) -> str:
        moment = _utc(moment)
        if moment is None:
            return ""
        if zone is not None:
            moment = moment.astimezone(zone)
        return moment.strftime("%d/%m/%Y %H:%M")

    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow([
        "שם", "טלפון", "סוג", "קבוצה", "מספרי שוברים", "כמות", "מצב", "נשלח", "נשלח דרך", "נשלח על ידי",
        "נמסר", "נקרא", "נכשל", "סיבת כשל", "נפתח לראשונה", "פתיחות", "הורדות", "תוקף הקישור", "הקישור בוטל",
        "הוסר", "נמחקו פרטים",
    ])
    for r in rows:
        serials = [a.serial for a in held.get(r.id, [])]
        name = r.name or ""
        if name[:1] in "=+-@":
            name = "'" + name
        w.writerow([
            name, display_phone(_phone_of(r)), "קבוצה" if r.kind == "group" else "נמען",
            r.group_no if r.group_no is not None else "", serials_text(serials, limit=1000), len(serials),
            _STATE_HE.get(recipient_state(r), r.status), when(r.sent_at), _VIA_HE.get(r.sent_via or "", ""),
            r.sent_by_name or "", when(r.delivered_at), when(r.read_at), when(r.failed_at), r.failure_reason or "",
            when(r.opened_at), int(r.open_count or 0), int(r.download_count or 0), when(effective_expiry(r, batch, dist)),
            when(r.token_revoked_at), when(r.deleted_at), when(r.anonymized_at),
        ])
    return ("﻿" + buf.getvalue()).encode("utf-8")


def events_out(db: Session, batch: PrepaidVoucherBatch, *, recipient_id=None, limit: int = 300) -> Dict[str, Any]:
    q = db.query(VoucherDistributionEvent).filter(VoucherDistributionEvent.batch_id == batch.id)
    if recipient_id is not None:
        q = q.filter(VoucherDistributionEvent.recipient_id == PV._as_uuid(recipient_id))
    rows = q.order_by(VoucherDistributionEvent.created_at.desc()).limit(limit).all()
    return {"items": [{
        "id": str(e.id),
        "action": e.action,
        "recipientId": str(e.recipient_id) if e.recipient_id else None,
        "userName": e.user_name,
        "details": e.details or {},
        "fromPublic": bool(e.ip or e.user_agent),
        "createdAt": _iso(e.created_at),
    } for e in rows]}
