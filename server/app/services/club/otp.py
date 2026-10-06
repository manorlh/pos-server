"""
The club's OTP, managed locally (§24) — one source of verification, not two: 019's OTP
API is not used (its documented response hands the code back to the caller).

* A 6-digit code from `secrets` (CSPRNG). Stored only as an HMAC keyed by the server
  secret over (challenge id, code); never in clear, never logged, never in telemetry.
* Bound to: purpose ("club_signup"), tenant / company / club, the phone (hash), and the
  browser session (`clientSession`, a random token the page holds; stored hashed).
* 5 minutes, 5 attempts per challenge — counted atomically in the database
  (`UPDATE … WHERE attempts < max_attempts`), so parallel guesses cannot exceed it.
  A resend issues a NEW code (the old one dies) but never resets the attempts.
* Resend: not before 60 s, at most 3 codes per challenge.
* A new challenge in the same session (another phone) or for the same phone invalidates
  the previous pending ones ("phone swap").
* Verifying is single-use: pending → verified is a conditional update; the result is a
  one-time registration token (hashed), valid 15 minutes, consumed atomically.
* Throttles in the database (work across processes): per phone, per IP, per session,
  per club. The public answer never says whether the number is already a member.
"""
from __future__ import annotations

import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import update
from sqlalchemy.orm import Session

from app.models.club import (
    OTP_EXPIRED,
    OTP_INVALIDATED,
    OTP_LOCKED,
    OTP_PENDING,
    OTP_REGISTERED,
    OTP_VERIFIED,
    ClubOtpChallenge,
    ClubProgram,
    ClubSourceToken,
)
from app.services.notifications import service as NS
from app.services.notifications.crypto import constant_time_equal, encrypt_text, keyed_hash, random_token
from app.services.notifications.phone import PhoneError, normalize_mobile, phone_hash
from app.services.notifications.templates import TemplateError

PURPOSE_SIGNUP = "club_signup"
CODE_DIGITS = 6
CODE_TTL = timedelta(minutes=5)
MAX_ATTEMPTS = 5
RESEND_GAP = timedelta(seconds=60)
MAX_SENDS = 3
REGISTRATION_TTL = timedelta(minutes=15)

# Server throttles (per rolling window).
PER_PHONE_HOUR = 5
PER_PHONE_DAY = 10
PER_SESSION_HOUR = 5
PER_IP_HOUR = 20
PER_CLUB_HOUR = 300


class OtpError(Exception):
    def __init__(self, code: str, status: int = 400, *, retry_after: Optional[int] = None, **extra: Any):
        super().__init__(code)
        self.code = code
        self.status = status
        self.retry_after = retry_after
        self.extra = extra


def _aw(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def new_code() -> str:
    return f"{secrets.randbelow(10 ** CODE_DIGITS):0{CODE_DIGITS}d}"


def code_hash(challenge_id: Any, code: str) -> str:
    return keyed_hash(f"{challenge_id}:{code}", label="otp")


def session_hash(session: str) -> str:
    return keyed_hash(session, label="otp-session")


def ip_hash(ip: Optional[str]) -> Optional[str]:
    return keyed_hash(ip, label="ip") if ip else None


def _token_hash(token: str) -> str:
    return keyed_hash(token, label="otp-registration")


def _valid_session(value: Optional[str]) -> bool:
    return bool(value) and 20 <= len(value) <= 64 and value.replace("-", "").replace("_", "").isalnum()


@dataclass
class Started:
    challenge: ClubOtpChallenge
    client_session: str
    notification_id: Any


def _count(db: Session, *filters) -> int:
    return db.query(ClubOtpChallenge.id).filter(*filters).count()


def _throttle(db: Session, club: ClubProgram, hashed_phone: str, sess: str, ip: Optional[str], now: datetime) -> None:
    hour, day = now - timedelta(hours=1), now - timedelta(days=1)
    T = ClubOtpChallenge
    if _count(db, T.tenant_id == club.tenant_id, T.phone_hash == hashed_phone, T.created_at >= hour) >= PER_PHONE_HOUR:
        raise OtpError("too_many_requests", 429, retry_after=3600)
    if _count(db, T.tenant_id == club.tenant_id, T.phone_hash == hashed_phone, T.created_at >= day) >= PER_PHONE_DAY:
        raise OtpError("too_many_requests", 429, retry_after=86400)
    if _count(db, T.session_hash == sess, T.created_at >= hour) >= PER_SESSION_HOUR:
        raise OtpError("too_many_requests", 429, retry_after=3600)
    if ip and _count(db, T.ip_hash == ip, T.created_at >= hour) >= PER_IP_HOUR:
        raise OtpError("too_many_requests", 429, retry_after=3600)
    if _count(db, T.club_id == club.id, T.created_at >= hour) >= PER_CLUB_HOUR:
        raise OtpError("too_many_requests", 429, retry_after=600)


def _send_code(db: Session, club: ClubProgram, challenge: ClubOtpChallenge, phone: str, code: str, brand: str, now: datetime) -> Any:
    config = NS.get_config(db, club.tenant_id, club.company_id)
    if config is None or config.paused:
        raise OtpError("provider_unavailable", 503)
    try:
        result = NS.enqueue(
            db,
            tenant_id=club.tenant_id,
            company_id=club.company_id,
            event_type="OtpCode",
            recipient_e164=phone,
            variables={"code": code, "brand_name": brand},
            dedupe_key=f"otp:{challenge.id}:{challenge.send_count}",
            ttl=CODE_TTL,
            aggregate_ref=str(challenge.id),
            context_label="קוד הצטרפות למועדון",
            config=config,
            now=now,
        )
    except TemplateError:
        raise OtpError("provider_unavailable", 503) from None
    if result.notification.state not in ("queued",):
        # Suppressed at the provider level (blocked number) or no account.
        raise OtpError("provider_unavailable", 503)
    return result.notification.id


def start(
    db: Session,
    *,
    club: ClubProgram,
    source: Optional[ClubSourceToken],
    phone_raw: Any,
    client_session: Optional[str],
    ip: Optional[str],
    brand: str,
    now: Optional[datetime] = None,
) -> Started:
    now = now or datetime.now(timezone.utc)
    try:
        phone = normalize_mobile(phone_raw)
    except PhoneError as exc:
        raise OtpError(exc.code, 422) from None
    session = client_session if _valid_session(client_session) else random_token(24)
    sess = session_hash(session)
    hashed = phone_hash(phone)
    iph = ip_hash(ip)
    _throttle(db, club, hashed, sess, iph, now)

    # Only the newest code counts: this session's other challenges (a phone swap) and
    # this phone's other pending ones in this club die now.
    db.query(ClubOtpChallenge).filter(
        ClubOtpChallenge.status.in_((OTP_PENDING, OTP_VERIFIED)),
        (ClubOtpChallenge.session_hash == sess)
        | ((ClubOtpChallenge.club_id == club.id) & (ClubOtpChallenge.phone_hash == hashed)),
    ).update(
        {ClubOtpChallenge.status: OTP_INVALIDATED, ClubOtpChallenge.phone_ciphertext: None},
        synchronize_session=False,
    )

    code = new_code()
    challenge_id = uuid.uuid4()
    challenge = ClubOtpChallenge(
        id=challenge_id,
        tenant_id=club.tenant_id,
        company_id=club.company_id,
        club_id=club.id,
        source_token_id=source.id if source is not None else None,
        purpose=PURPOSE_SIGNUP,
        phone_hash=hashed,
        phone_ciphertext=encrypt_text(phone),
        session_hash=sess,
        code_hash=code_hash(challenge_id, code),
        status=OTP_PENDING,
        attempts=0,
        max_attempts=MAX_ATTEMPTS,
        send_count=1,
        expires_at=now + CODE_TTL,
        last_sent_at=now,
        ip_hash=iph,
        created_at=now,
    )
    db.add(challenge)
    db.flush()
    challenge.notification_id = _send_code(db, club, challenge, phone, code, brand, now)
    return Started(challenge, session, challenge.notification_id)


def _load(db: Session, club: ClubProgram, challenge_id: Any, client_session: Optional[str]) -> ClubOtpChallenge:
    try:
        cid = uuid.UUID(str(challenge_id))
    except (TypeError, ValueError):
        raise OtpError("challenge_invalid", 400) from None
    challenge = db.get(ClubOtpChallenge, cid)
    if (
        challenge is None
        or challenge.club_id != club.id
        or challenge.purpose != PURPOSE_SIGNUP
        or not client_session
        or not constant_time_equal(challenge.session_hash, session_hash(client_session))
    ):
        raise OtpError("challenge_invalid", 400)
    return challenge


def _state_error(challenge: ClubOtpChallenge, now: datetime) -> Optional[OtpError]:
    if challenge.status == OTP_PENDING and now >= _aw(challenge.expires_at):
        challenge.status = OTP_EXPIRED
        return OtpError("code_expired", 410)
    return {
        OTP_PENDING: None,
        OTP_EXPIRED: OtpError("code_expired", 410),
        OTP_LOCKED: OtpError("too_many_attempts", 429),
        OTP_VERIFIED: OtpError("challenge_used", 409),
        OTP_REGISTERED: OtpError("challenge_used", 409),
        OTP_INVALIDATED: OtpError("challenge_invalid", 400),
    }.get(challenge.status, OtpError("challenge_invalid", 400))


def resend(
    db: Session, *, club: ClubProgram, challenge_id: Any, client_session: Optional[str], brand: str,
    now: Optional[datetime] = None,
) -> ClubOtpChallenge:
    from app.services.notifications.crypto import decrypt_text

    now = now or datetime.now(timezone.utc)
    challenge = _load(db, club, challenge_id, client_session)
    if challenge.status == OTP_PENDING and now >= _aw(challenge.expires_at):
        # An expired code may be replaced by a resend; the attempts still carry over.
        pass
    elif challenge.status != OTP_PENDING:
        problem = _state_error(challenge, now)
        raise problem or OtpError("challenge_invalid", 400)
    wait = (_aw(challenge.last_sent_at) + RESEND_GAP) - now
    if wait.total_seconds() > 0:
        raise OtpError("resend_too_soon", 429, retry_after=int(wait.total_seconds()) + 1)
    if challenge.send_count >= MAX_SENDS:
        raise OtpError("too_many_sends", 429)
    if challenge.attempts >= challenge.max_attempts:
        challenge.status = OTP_LOCKED
        raise OtpError("too_many_attempts", 429)
    phone = decrypt_text(challenge.phone_ciphertext)
    if not phone:
        raise OtpError("challenge_invalid", 400)
    code = new_code()
    challenge.code_hash = code_hash(challenge.id, code)
    challenge.send_count += 1
    challenge.last_sent_at = now
    challenge.expires_at = now + CODE_TTL
    db.flush()
    challenge.notification_id = _send_code(db, club, challenge, phone, code, brand, now)
    return challenge


def verify(
    db: Session, *, club: ClubProgram, challenge_id: Any, client_session: Optional[str], code: Any,
    now: Optional[datetime] = None,
) -> str:
    """The one-time registration token, or OtpError (wrong_code carries attemptsLeft)."""
    now = now or datetime.now(timezone.utc)
    challenge = _load(db, club, challenge_id, client_session)
    problem = _state_error(challenge, now)
    if problem is not None:
        db.flush()
        raise problem
    text = str(code or "").strip()
    # Count the attempt first, atomically: a parallel burst cannot pass max_attempts.
    counted = db.execute(
        update(ClubOtpChallenge)
        .where(
            ClubOtpChallenge.id == challenge.id,
            ClubOtpChallenge.status == OTP_PENDING,
            ClubOtpChallenge.attempts < ClubOtpChallenge.max_attempts,
        )
        .values(attempts=ClubOtpChallenge.attempts + 1)
        .execution_options(synchronize_session=False)
    ).rowcount
    db.refresh(challenge)
    if counted != 1:
        if challenge.status == OTP_PENDING:
            challenge.status = OTP_LOCKED
            challenge.phone_ciphertext = None
            db.flush()
        raise _state_error(challenge, now) or OtpError("too_many_attempts", 429)
    good = len(text) == CODE_DIGITS and text.isdigit() and constant_time_equal(
        challenge.code_hash, code_hash(challenge.id, text)
    )
    if not good:
        left = max(0, challenge.max_attempts - challenge.attempts)
        if left == 0:
            challenge.status = OTP_LOCKED
            challenge.phone_ciphertext = None
            db.flush()
            raise OtpError("too_many_attempts", 429)
        db.flush()
        raise OtpError("wrong_code", 400, attemptsLeft=left)
    token = random_token(24)
    won = db.execute(
        update(ClubOtpChallenge)
        .where(ClubOtpChallenge.id == challenge.id, ClubOtpChallenge.status == OTP_PENDING)
        .values(
            status=OTP_VERIFIED,
            verified_at=now,
            registration_token_hash=_token_hash(token),
            registration_expires_at=now + REGISTRATION_TTL,
        )
        .execution_options(synchronize_session=False)
    ).rowcount
    if won != 1:
        raise OtpError("challenge_used", 409)
    db.refresh(challenge)
    return token


def consume_registration(
    db: Session, *, club: ClubProgram, challenge_id: Any, client_session: Optional[str], token: Any,
    now: Optional[datetime] = None,
) -> ClubOtpChallenge:
    """verified → registered, once, by the session that verified it, within 15 minutes."""
    now = now or datetime.now(timezone.utc)
    challenge = _load(db, club, challenge_id, client_session)
    if not token or not constant_time_equal(challenge.registration_token_hash, _token_hash(str(token))):
        raise OtpError("registration_invalid", 400)
    if challenge.registration_expires_at is None or now >= _aw(challenge.registration_expires_at):
        raise OtpError("registration_expired", 410)
    won = db.execute(
        update(ClubOtpChallenge)
        .where(ClubOtpChallenge.id == challenge.id, ClubOtpChallenge.status == OTP_VERIFIED)
        .values(status=OTP_REGISTERED, registered_at=now)
        .execution_options(synchronize_session=False)
    ).rowcount
    if won != 1:
        raise OtpError("challenge_used", 409)
    db.refresh(challenge)
    return challenge
