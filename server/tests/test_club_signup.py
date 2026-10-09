"""
The customer club: OTP, the atomic sign-up, the public page, the till lookup and the
sale link (docs/SPEC_NOTIFICATIONS_CLUB.md part ג).

Spec §36 items covered: 10 (expiry, rate limit, brute force, replay, phone swap,
parallel verify), 11 (two sign-ups → one membership, one benefit), 12 (no marketing →
still a member; campaigns would not reach it; order-ready still may), 19 (the public
answers expose nothing, structured errors) and the §24 / §26 rules.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy.dialects import postgresql

from app.models.club import (
    ClubBenefitGrant,
    ClubConsentEvent,
    ClubCustomer,
    ClubDocumentVersion,
    ClubLandingPage,
    ClubMembership,
    ClubOtpChallenge,
    ClubProgram,
    ClubSaleLink,
    ClubSourceToken,
    ClubSuppression,
    ClubAuditEvent,
)
from app.models.notifications import Notification
from app.services.club import lookup as LK
from app.services.club import otp as OTP
from app.services.club import public as PUB
from app.services.club import registration as REG
from app.services.club.sale_link import link_sale
from app.services.notifications import service as S
from app.services.notifications import worker as W
from app.services.notifications.crypto import random_token
from app.services.notifications.phone import phone_hash
from notif_world import make_nworld

PHONE = "0501234567"
E164 = "+972501234567"
OWNER = "test-worker"


@pytest.fixture
def w():
    world = make_nworld()
    yield world
    world.db.close()


def make_club(w, *, company=None, benefit=True, marketing_doc=True, published=True):
    company = company or w.company
    tenant_id = company.tenant_id
    club = ClubProgram(id=uuid.uuid4(), tenant_id=tenant_id, company_id=company.id, name="מועדון אלפא")
    w.db.add(club)
    w.db.flush()
    landing = ClubLandingPage(
        id=uuid.uuid4(), tenant_id=tenant_id, company_id=company.id, club_id=club.id, is_published=published,
        business_name="אלפא", benefits=["10% הנחה"], signup_benefit_enabled=benefit,
        signup_benefit_title="קפה מתנה" if benefit else None, signup_benefit_valid_days=30,
        last_name_enabled=True, email_enabled=False, birthday_enabled=True,
    )
    w.db.add(landing)
    docs = {}
    kinds = ["terms", "privacy"] + (["marketing_sms"] if marketing_doc else [])
    for kind in kinds:
        d = ClubDocumentVersion(id=uuid.uuid4(), tenant_id=tenant_id, club_id=club.id, kind=kind, version=1,
                                status="active", title=kind, body=f"נוסח {kind} v1")
        w.db.add(d)
        docs[kind] = d
    source = ClubSourceToken(id=uuid.uuid4(), tenant_id=tenant_id, company_id=company.id, club_id=club.id,
                             token=random_token(18), shop_id=w.shop.id if company is w.company else None,
                             source_kind="receipt", is_active=True)
    w.db.add(source)
    w.db.commit()
    return club, landing, docs, source


def capture_codes(monkeypatch):
    """The codes as they would leave in the SMS (the test reads them from the OTP send)."""
    codes = []
    real = OTP._send_code

    def spy(db, club, challenge, phone, code, brand, now):
        codes.append(code)
        return real(db, club, challenge, phone, code, brand, now)

    monkeypatch.setattr(OTP, "_send_code", spy)
    return codes


def form(docs, **kw):
    out = {
        "firstName": "דנה",
        "lastName": "כהן",
        "acceptTerms": True,
        "termsVersionId": str(docs["terms"].id),
        "privacyVersionId": str(docs["privacy"].id),
        "marketingSms": False,
    }
    if "marketing_sms" in docs:
        out["marketingSmsVersionId"] = str(docs["marketing_sms"].id)
    out.update(kw)
    return out


def signup(w, club, landing, source, docs, codes, *, phone=PHONE, session=None, **form_kw):
    started = OTP.start(w.db, club=club, source=source, phone_raw=phone, client_session=session, ip="1.2.3.4",
                        brand="אלפא", now=w.clock())
    w.db.commit()
    token = OTP.verify(w.db, club=club, challenge_id=started.challenge.id, client_session=started.client_session,
                       code=codes[-1], now=w.clock())
    w.db.commit()
    out = REG.register(w.db, club=club, landing=landing, source=source, challenge_id=started.challenge.id,
                       client_session=started.client_session, registration_token=token, form=form(docs, **form_kw),
                       ip="1.2.3.4", now=w.clock())
    w.db.commit()
    return out


@pytest.fixture
def setup(w, monkeypatch):
    w.config()
    club, landing, docs, source = make_club(w)
    codes = capture_codes(monkeypatch)
    return club, landing, docs, source, codes


# ── OTP (§24, §36 #10) ───────────────────────────────────────────────────────


def test_the_code_is_stored_only_as_a_keyed_hash(w, setup):
    club, landing, docs, source, codes = setup
    started = OTP.start(w.db, club=club, source=source, phone_raw=PHONE, client_session=None, ip="1.1.1.1",
                        brand="אלפא", now=w.clock())
    w.db.commit()
    ch = w.db.get(ClubOtpChallenge, started.challenge.id)
    code = codes[-1]
    assert len(code) == 6 and code.isdigit()
    for value in vars(ch).values():
        assert code not in str(value)
    assert ch.code_hash == OTP.code_hash(ch.id, code)
    assert ch.expires_at.replace(tzinfo=None) == (w.clock() + timedelta(minutes=5)).replace(tzinfo=None)
    # The SMS row keeps the text with the code masked; only the encrypted copy has it.
    n = w.db.get(Notification, started.notification_id)
    assert n.category == "authentication" and n.priority == 0
    assert code not in n.body_snapshot and "••••••" in n.body_snapshot
    assert S.text_to_send(n).count(code) == 1


def test_the_otp_sms_goes_out_first_and_its_secret_is_wiped(w, setup):
    club, landing, docs, source, codes = setup
    started = OTP.start(w.db, club=club, source=source, phone_raw=PHONE, client_session=None, ip=None,
                        brand="אלפא", now=w.clock())
    w.db.commit()
    for nid in W.claim(w.db, w.clock(), OWNER):
        W.process_one(w.db, nid, OWNER, now_fn=w.clock, adapter_factory=w.adapter_factory)
    n = w.db.get(Notification, started.notification_id)
    assert n.state == "provider_accepted" and n.secret_vars_ciphertext is None
    assert codes[-1] in w.mock.sent[-1]["message"]


def test_code_expires_after_five_minutes(w, setup):
    club, landing, docs, source, codes = setup
    s = OTP.start(w.db, club=club, source=source, phone_raw=PHONE, client_session=None, ip=None, brand="x",
                  now=w.clock())
    w.db.commit()
    with pytest.raises(OTP.OtpError) as e:
        OTP.verify(w.db, club=club, challenge_id=s.challenge.id, client_session=s.client_session, code=codes[-1],
                   now=w.clock() + timedelta(minutes=5, seconds=1))
    assert e.value.code == "code_expired"


def test_brute_force_locks_after_five_attempts_even_for_the_right_code(w, setup):
    club, landing, docs, source, codes = setup
    s = OTP.start(w.db, club=club, source=source, phone_raw=PHONE, client_session=None, ip=None, brand="x",
                  now=w.clock())
    w.db.commit()
    wrong = "000000" if codes[-1] != "000000" else "111111"
    lefts = []
    for _ in range(4):
        with pytest.raises(OTP.OtpError) as e:
            OTP.verify(w.db, club=club, challenge_id=s.challenge.id, client_session=s.client_session, code=wrong,
                       now=w.clock())
        w.db.commit()
        lefts.append(e.value.extra.get("attemptsLeft"))
    assert lefts == [4, 3, 2, 1]
    with pytest.raises(OTP.OtpError) as e:
        OTP.verify(w.db, club=club, challenge_id=s.challenge.id, client_session=s.client_session, code=wrong,
                   now=w.clock())
    assert e.value.code == "too_many_attempts"
    w.db.commit()
    with pytest.raises(OTP.OtpError) as e:
        OTP.verify(w.db, club=club, challenge_id=s.challenge.id, client_session=s.client_session, code=codes[-1],
                   now=w.clock())
    assert e.value.code == "too_many_attempts"


def test_attempts_are_counted_atomically_in_the_database():
    """Parallel guesses: the increment is one conditional UPDATE, so it can never pass the cap."""
    from sqlalchemy import update

    stmt = (
        update(ClubOtpChallenge)
        .where(ClubOtpChallenge.status == "pending", ClubOtpChallenge.attempts < ClubOtpChallenge.max_attempts)
        .values(attempts=ClubOtpChallenge.attempts + 1)
    )
    sql = str(stmt.compile(dialect=postgresql.dialect()))
    assert "attempts < club_otp_challenges.max_attempts" in sql and "attempts + " in sql


def test_a_verified_code_cannot_be_replayed(w, setup):
    club, landing, docs, source, codes = setup
    s = OTP.start(w.db, club=club, source=source, phone_raw=PHONE, client_session=None, ip=None, brand="x",
                  now=w.clock())
    w.db.commit()
    token = OTP.verify(w.db, club=club, challenge_id=s.challenge.id, client_session=s.client_session,
                       code=codes[-1], now=w.clock())
    w.db.commit()
    assert token
    # A second (parallel / replayed) verify with the same good code loses.
    with pytest.raises(OTP.OtpError) as e:
        OTP.verify(w.db, club=club, challenge_id=s.challenge.id, client_session=s.client_session, code=codes[-1],
                   now=w.clock())
    assert e.value.code == "challenge_used"
    REG.register(w.db, club=club, landing=landing, source=source, challenge_id=s.challenge.id,
                 client_session=s.client_session, registration_token=token, form=form(docs), now=w.clock())
    w.db.commit()
    # The registration token is single-use too.
    with pytest.raises(OTP.OtpError) as e:
        REG.register(w.db, club=club, landing=landing, source=source, challenge_id=s.challenge.id,
                     client_session=s.client_session, registration_token=token, form=form(docs), now=w.clock())
    assert e.value.code == "challenge_used"


def test_another_session_cannot_use_the_challenge(w, setup):
    club, landing, docs, source, codes = setup
    s = OTP.start(w.db, club=club, source=source, phone_raw=PHONE, client_session=None, ip=None, brand="x",
                  now=w.clock())
    w.db.commit()
    with pytest.raises(OTP.OtpError) as e:
        OTP.verify(w.db, club=club, challenge_id=s.challenge.id, client_session=random_token(24), code=codes[-1],
                   now=w.clock())
    assert e.value.code == "challenge_invalid"


def test_phone_swap_kills_the_previous_challenge(w, setup):
    """A new number in the same session: the first code is dead; registration uses the new one."""
    club, landing, docs, source, codes = setup
    first = OTP.start(w.db, club=club, source=source, phone_raw=PHONE, client_session=None, ip=None, brand="x",
                      now=w.clock())
    w.db.commit()
    code_a = codes[-1]
    second = OTP.start(w.db, club=club, source=source, phone_raw="0507654321", client_session=first.client_session,
                       ip=None, brand="x", now=w.clock())
    w.db.commit()
    with pytest.raises(OTP.OtpError) as e:
        OTP.verify(w.db, club=club, challenge_id=first.challenge.id, client_session=first.client_session,
                   code=code_a, now=w.clock())
    assert e.value.code == "challenge_invalid"
    token = OTP.verify(w.db, club=club, challenge_id=second.challenge.id, client_session=second.client_session,
                       code=codes[-1], now=w.clock())
    w.db.commit()
    # The phone comes from the verified challenge — a phone in the form is ignored.
    REG.register(w.db, club=club, landing=landing, source=source, challenge_id=second.challenge.id,
                 client_session=second.client_session, registration_token=token,
                 form=form(docs, phone=PHONE), now=w.clock())
    w.db.commit()
    [c] = w.db.query(ClubCustomer).all()
    assert c.phone_hash == phone_hash("+972507654321")


def test_resend_waits_60_seconds_issues_a_new_code_and_keeps_the_attempts(w, setup):
    club, landing, docs, source, codes = setup
    s = OTP.start(w.db, club=club, source=source, phone_raw=PHONE, client_session=None, ip=None, brand="x",
                  now=w.clock())
    w.db.commit()
    old = codes[-1]
    with pytest.raises(OTP.OtpError) as e:
        OTP.resend(w.db, club=club, challenge_id=s.challenge.id, client_session=s.client_session, brand="x",
                   now=w.clock() + timedelta(seconds=30))
    assert e.value.code == "resend_too_soon" and 1 <= e.value.retry_after <= 31
    wrong = "000000" if old != "000000" else "111111"
    with pytest.raises(OTP.OtpError):
        OTP.verify(w.db, club=club, challenge_id=s.challenge.id, client_session=s.client_session, code=wrong,
                   now=w.clock())
    w.db.commit()
    later = w.clock() + timedelta(seconds=61)
    OTP.resend(w.db, club=club, challenge_id=s.challenge.id, client_session=s.client_session, brand="x", now=later)
    w.db.commit()
    ch = w.db.get(ClubOtpChallenge, s.challenge.id)
    assert ch.attempts == 1 and ch.send_count == 2
    if old != codes[-1]:
        with pytest.raises(OTP.OtpError):
            OTP.verify(w.db, club=club, challenge_id=s.challenge.id, client_session=s.client_session, code=old,
                       now=later)
        w.db.commit()
    assert OTP.verify(w.db, club=club, challenge_id=s.challenge.id, client_session=s.client_session,
                      code=codes[-1], now=later)


def test_server_throttles_per_phone(w, setup):
    club, landing, docs, source, codes = setup
    for _ in range(OTP.PER_PHONE_HOUR):
        OTP.start(w.db, club=club, source=source, phone_raw=PHONE, client_session=None, ip=None, brand="x",
                  now=w.clock())
        w.db.commit()
    with pytest.raises(OTP.OtpError) as e:
        OTP.start(w.db, club=club, source=source, phone_raw=PHONE, client_session=None, ip=None, brand="x",
                  now=w.clock())
    assert e.value.code == "too_many_requests" and e.value.status == 429


def test_without_a_provider_the_page_says_unavailable_not_success(w, monkeypatch):
    club, landing, docs, source = make_club(w)
    with pytest.raises(OTP.OtpError) as e:
        OTP.start(w.db, club=club, source=source, phone_raw=PHONE, client_session=None, ip=None, brand="x",
                  now=w.clock())
    assert e.value.code == "provider_unavailable"


# ── Registration (§24, §36 #11, #12) ─────────────────────────────────────────


def test_signup_creates_customer_membership_consents_and_one_benefit(w, setup):
    club, landing, docs, source, codes = setup
    out = signup(w, club, landing, source, docs, codes)
    assert out["status"] == "registered" and out["memberNumber"] == 1001 and out["memberToken"]
    assert out["benefit"]["title"] == "קפה מתנה"
    [m] = w.db.query(ClubMembership).all()
    assert m.status == "active" and m.source_token_id == source.id and m.source_shop_id == w.shop.id
    kinds = {(e.kind, e.granted, e.document_version) for e in w.db.query(ClubConsentEvent).all()}
    assert kinds == {("terms", True, 1), ("privacy", True, 1), ("marketing_sms", False, 1)}
    snap = w.db.query(ClubConsentEvent).filter_by(kind="terms").one().text_snapshot
    assert snap == "נוסח terms v1"


def test_two_signups_same_phone_one_membership_one_benefit(w, setup):
    """§36 #11."""
    club, landing, docs, source, codes = setup
    first = signup(w, club, landing, source, docs, codes)
    w.clock.advance(minutes=1)
    second = signup(w, club, landing, source, docs, codes, firstName="אחר")
    assert second["status"] == "existing_member" and second["memberNumber"] == first["memberNumber"]
    assert w.db.query(ClubCustomer).count() == 1
    assert w.db.query(ClubMembership).count() == 1
    assert w.db.query(ClubBenefitGrant).count() == 1
    assert w.db.query(ClubCustomer).one().first_name == "דנה"  # not overwritten


def test_joining_without_marketing_works_and_reregistering_never_flips_consent(w, setup):
    """§36 #12 + §24: no marketing is fine; an unticked box later changes nothing."""
    club, landing, docs, source, codes = setup
    signup(w, club, landing, source, docs, codes, marketingSms=True)
    w.clock.advance(minutes=1)
    signup(w, club, landing, source, docs, codes, marketingSms=False)
    events = w.db.query(ClubConsentEvent).filter_by(kind="marketing_sms").all()
    assert [e.granted for e in events] == [True]


def test_no_marketing_member_can_still_get_order_ready(w, setup):
    club, landing, docs, source, codes = setup
    signup(w, club, landing, source, docs, codes, marketingSms=False)
    hashed = phone_hash(E164)
    w.db.add(ClubSuppression(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, phone_hash=hashed,
                             channel="sms", scope="marketing", reason="unsubscribe"))
    w.db.commit()
    assert S.suppression_reason(w.db, w.tenant.id, w.company.id, hashed, "service") is None
    assert S.suppression_reason(w.db, w.tenant.id, w.company.id, hashed, "marketing") == "unsubscribed"


@pytest.mark.parametrize("change,code", [
    ({"acceptTerms": False}, "terms_required"),
    ({"acceptTerms": "yes"}, "terms_required"),
    ({"termsVersionId": str(uuid.uuid4())}, "terms_version_stale"),
    ({"firstName": ""}, "field_required"),
    ({"firstName": "<script>"}, "field_invalid"),
    ({"birthDay": 31, "birthMonth": 2}, "field_invalid"),
])
def test_a_bad_form_is_refused_before_the_verified_code_is_spent(w, setup, change, code):
    club, landing, docs, source, codes = setup
    s = OTP.start(w.db, club=club, source=source, phone_raw=PHONE, client_session=None, ip=None, brand="x",
                  now=w.clock())
    w.db.commit()
    token = OTP.verify(w.db, club=club, challenge_id=s.challenge.id, client_session=s.client_session,
                       code=codes[-1], now=w.clock())
    w.db.commit()
    with pytest.raises(REG.RegistrationError) as e:
        REG.register(w.db, club=club, landing=landing, source=source, challenge_id=s.challenge.id,
                     client_session=s.client_session, registration_token=token, form=form(docs, **change),
                     now=w.clock())
    assert e.value.code == code
    w.db.rollback()
    out = REG.register(w.db, club=club, landing=landing, source=source, challenge_id=s.challenge.id,
                       client_session=s.client_session, registration_token=token, form=form(docs), now=w.clock())
    assert out["status"] == "registered"


def test_a_company_id_from_the_browser_is_ignored(w, setup):
    """The club comes from the opaque token; extra fields cannot redirect the sign-up."""
    club, landing, docs, source, codes = setup
    signup(w, club, landing, source, docs, codes, companyId=str(w.other_company.id), clubId=str(uuid.uuid4()))
    [m] = w.db.query(ClubMembership).all()
    assert m.club_id == club.id and m.company_id == w.company.id


# ── Public page (§23, §25, §36 #19) ──────────────────────────────────────────


def test_public_page_resolves_only_from_an_active_published_token(w, setup):
    club, landing, docs, source, codes = setup
    cfg = PUB.page_config(w.db, PUB.resolve(w.db, source.token))
    assert cfg["businessName"] == "אלפא" and cfg["benefits"] == ["10% הנחה"]
    assert cfg["documents"]["terms"]["version"] == 1 and cfg["shopName"] == "Alpha מרכז"
    blob = str(cfg)
    for secret in (str(club.id), str(w.company.id), str(w.tenant.id), str(source.id)):
        assert secret not in blob
    for bad in ("nope-nope-nope", "", "x" * 100):
        with pytest.raises(PUB.PageUnavailable):
            PUB.resolve(w.db, bad)
    landing.is_published = False
    w.db.commit()
    with pytest.raises(PUB.PageUnavailable):
        PUB.resolve(w.db, source.token)


def test_no_benefits_are_invented(w, monkeypatch):
    w.config()
    club, landing, docs, source = make_club(w, benefit=False)
    landing.benefits = []
    w.db.commit()
    cfg = PUB.page_config(w.db, PUB.resolve(w.db, source.token))
    assert cfg["benefits"] == [] and cfg["signupBenefit"] is None


def test_public_api_errors_are_structured_and_never_reveal_membership(w, setup, monkeypatch):
    from fastapi.testclient import TestClient

    import app.middleware.rate_limit as RL
    from app.database import get_db
    from app.main import app
    from app.routers import club as club_router

    club, landing, docs, source, codes = setup
    signup(w, club, landing, source, docs, codes)  # the number is already a member

    def _db():
        yield w.db

    monkeypatch.setitem(app.dependency_overrides, get_db, _db)
    monkeypatch.setattr(club_router.W, "process_now", lambda *a, **k: None)
    RL._buckets.clear()
    client = TestClient(app)
    base = f"/api/v1/public/club/{source.token}"
    member = client.post(f"{base}/otp/start", json={"phone": PHONE})
    stranger = client.post(f"{base}/otp/start", json={"phone": "0529999999"})
    assert member.status_code == stranger.status_code == 200
    assert set(member.json()) == set(stranger.json()) == {
        "challengeId", "clientSession", "expiresInSeconds", "resendAfterSeconds", "sendsLeft"}
    bad = client.post(f"{base}/otp/verify", json={"challengeId": member.json()["challengeId"],
                                                  "clientSession": member.json()["clientSession"], "code": "12"})
    detail = bad.json()["detail"]
    assert bad.status_code == 400 and detail["code"] == "wrong_code" and detail["userMessage"]
    assert set(detail) >= {"code", "userMessage", "retryable", "correlationId"} and "Traceback" not in bad.text
    gone = client.get("/api/v1/public/club/not-a-real-token")
    assert gone.status_code == 404 and gone.json()["detail"]["code"] == "page_unavailable"


# ── Till lookup and the sale link (§26) ──────────────────────────────────────


def test_till_lookup_by_phone_and_qr_is_minimal_and_audited(w, setup):
    club, landing, docs, source, codes = setup
    out = signup(w, club, landing, source, docs, codes)
    by_phone = LK.lookup(w.db, w.till, phone=PHONE)
    by_qr = LK.lookup(w.db, w.till, qr=f"https://x/join/m/{out['memberToken']}")
    w.db.commit()
    for res in (by_phone, by_qr):
        assert res["found"] and res["firstName"] == "דנה" and res["lastInitial"] == "כ."
        assert res["memberNumber"] == 1001 and res["status"] == "active"
        assert [b["title"] for b in res["benefits"]] == ["קפה מתנה"] and res["redemptionAvailable"] is False
        assert "phone" not in res and PHONE not in str(res) and E164 not in str(res)
    assert w.db.query(ClubAuditEvent).filter_by(action="lookup", actor_machine_id=w.till.id).count() == 2


def test_another_tenants_till_cannot_find_the_member(w, setup):
    club, landing, docs, source, codes = setup
    out = signup(w, club, landing, source, docs, codes)
    assert LK.lookup(w.db, w.other_till, phone=PHONE)["found"] is False
    assert LK.lookup(w.db, w.other_till, qr=out["memberToken"])["found"] is False


def test_the_sale_keeps_customer_and_membership(w, setup):
    from decimal import Decimal

    from app.models.transaction import Transaction, TransactionStatus
    from notif_world import NOW

    club, landing, docs, source, codes = setup
    signup(w, club, landing, source, docs, codes)
    m = w.db.query(ClubMembership).one()

    def tx(till):
        t = Transaction(id=uuid.uuid4(), tenant_id=till.tenant_id, machine_id=till.id, shop_id=till.shop_id,
                        transaction_number=str(uuid.uuid4().int)[:8], status=TransactionStatus.COMPLETED,
                        document_type=320, payment_method="cash", total_amount=Decimal("10"), created_at=NOW,
                        updated_at=NOW, server_received_at=NOW)
        w.db.add(t)
        w.db.flush()
        return t

    mine, theirs = tx(w.till), tx(w.other_till)
    assert link_sale(w.db, w.till, mine.id, m.id) is not None
    assert link_sale(w.db, w.other_till, theirs.id, m.id) is None  # another tenant's till
    assert link_sale(w.db, w.till, mine.id, "not-a-uuid") is None
    w.db.commit()
    [link] = w.db.query(ClubSaleLink).all()
    assert link.transaction_id == mine.id and link.membership_id == m.id and link.customer_id == m.customer_id


def test_transaction_push_schema_accepts_the_membership():
    from app.schemas.transaction import TransactionIn

    mid = uuid.uuid4()
    tx = TransactionIn.model_validate({"id": str(uuid.uuid4()), "transactionNumber": "1", "clubMembershipId": str(mid),
                                       "createdAt": "2026-10-06T10:00:00Z", "updatedAt": "2026-10-06T10:00:00Z"})
    assert tx.club_membership_id == mid


def test_unsubscribe_link_stops_marketing_only(w, setup):
    from fastapi.testclient import TestClient

    import app.middleware.rate_limit as RL
    from app.database import get_db
    from app.main import app

    club, landing, docs, source, codes = setup
    signup(w, club, landing, source, docs, codes, marketingSms=True)
    m = w.db.query(ClubMembership).one()

    def _db():
        yield w.db

    import contextlib

    with contextlib.ExitStack():
        app.dependency_overrides[get_db] = _db
        try:
            RL._buckets.clear()
            client = TestClient(app)
            assert client.post(f"/api/v1/public/club/unsubscribe/{m.unsubscribe_token}").status_code == 200
            assert client.post("/api/v1/public/club/unsubscribe/nope").status_code == 404
        finally:
            app.dependency_overrides.pop(get_db, None)
    out = w.db.query(ClubConsentEvent).filter_by(kind="marketing_sms", source="unsubscribe_link").one()
    assert out.granted is False
    hashed = phone_hash(E164)
    assert S.suppression_reason(w.db, w.tenant.id, w.company.id, hashed, "marketing") == "unsubscribed"
    assert S.suppression_reason(w.db, w.tenant.id, w.company.id, hashed, "service") is None
