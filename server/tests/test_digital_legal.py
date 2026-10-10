"""
"משפטי ונגישות" of the public digital channels (P:\\specs\\digital-menu-ordering-cards-plan.md §17,
app/services/digital_legal/, app/routers/digital_legal.py).

What is pinned, and how each could look fine while being wrong:

* **The templates** — every placeholder is a known field and every required section is in the
  template; a published page drops an empty optional line but never shows "[חסר: …]"; dates read
  DD.MM.YYYY; the business's own details prefill a draft (an exempt dealer gets the no-VAT note).
* **Publication** — only a draft is edited; any edit clears "נבדק"; publishing needs the checks AND
  "נבדק"; versions are numbered and the previous one archived; a stale save is a 409.
* **What the public sees** — only published versions: a shop's own, else its company's, else an
  ancestor's; a draft never leaks (nor through inheritance), nor internal fields.
* **The gate** — a menu / card needs accessibility + privacy + cookies, ordering also the terms; a
  theme below AA, an image without alt or a serious a11y violation blocks.
* **Contrast** — the Python rules equal the shared golden fixture the client test reads too.
* **Consent** — the visitor id is stored only as a keyed hash; revoke turns everything optional off.
* **Marketing (§30A)** — unticked records nothing; the text must be the version's exact wording;
  only a hash of the contact; the latest grant / withdrawal decides; the client's texts are the same.
* **The API** — role and scope per company / shop, the `digital_legal` section, public endpoints
  without login.
"""
from __future__ import annotations

import json
import pathlib
import re
import uuid
from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from shift_world import accept_str_uuids  # (and JSONB on SQLite)
from app.database import Base, get_db
from app.main import app
from app.middleware import auth as auth_mw
from app.models.company import Company
from app.models.dashboard_access import DashboardAccessProfile
from app.models.digital_legal import (
    CookieConsentRecord,
    LegalDocument,
    MarketingConsentRecord,
)
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.tenant_membership import TenantMembership, TenantMembershipRole
from app.models.user import User, UserRole
from app.services import dashboard_access as DA
from app.services import dashboard_sections as DS
from app.services.auth import create_access_token
from app.services.digital_legal import consent as CONSENT
from app.services.digital_legal import contrast as C
from app.services.digital_legal import documents as D
from app.services.digital_legal import gate as G
from app.services.digital_legal import marketing as M
from app.services.digital_legal import templates as T

ROOT = pathlib.Path(__file__).parents[1]  # not resolve(): the short P: path keeps alembic under MAX_PATH
GOLDEN = ROOT / "tests" / "fixtures" / "contrast_golden.json"
TODAY = date(2026, 10, 10)

FILLED = {
    "accessibility": {
        "coordinator.name": "דנה לוי",
        "coordinator.phone": "050-1234567",
        "coordinator.email": "access@example.com",
        "accessibility.limitations": "- חלק מתמונות המנות חסרות תיאור מפורט; אפשר לקבל פירוט בטלפון.",
        "accessibility.arrangements": "- כניסה נגישה לכיסא גלגלים מהרחוב",
        "accessibility.lastCheckDate": "2026-10-01",
    },
    "privacy": {"contact.email": "privacy@example.com", "business.address": "הרצל 1, תל אביב"},
    "terms": {"contact.phone": "03-5555555", "contact.email": "info@example.com", "business.address": "הרצל 1, תל אביב"},
    "cookies": {"contact.email": "info@example.com"},
}


# ── The world ────────────────────────────────────────────────────────────────


class World:
    pass


def _user(db, username, role, tenant, *, company=None, shop=None) -> User:
    u = User(
        id=uuid.uuid4(), username=username, email=f"{username}@example.com", role=role, tenant_id=tenant.id,
        company_id=company.id if company else None, shop_id=shop.id if shop else None, is_active=True,
    )
    db.add(u)
    db.flush()
    if role != UserRole.SUPER_ADMIN:
        db.add(TenantMembership(tenant_id=tenant.id, user_id=u.id, role=TenantMembershipRole.TENANT_MEMBER, is_default=True))
        db.add(DashboardAccessProfile(user_id=u.id, full_access=True, sections={}))
        db.flush()
    return u


def _make_world() -> World:
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    for table in Base.metadata.sorted_tables:
        table.create(engine)
    db = sessionmaker(bind=engine)()
    w = World()
    w.db = db
    w.tenant = Tenant(id=uuid.uuid4(), name="Royal", slug="royal", timezone="Asia/Jerusalem")
    w.other_tenant = Tenant(id=uuid.uuid4(), name="Other", slug="other", timezone="Asia/Jerusalem")
    db.add_all([w.tenant, w.other_tenant])
    db.flush()

    def company(name, tenant, parent=None, **kw):
        c = Company(id=uuid.uuid4(), tenant_id=tenant.id, name=name, parent_company_id=parent.id if parent else None, **kw)
        db.add(c)
        db.flush()
        return c

    def shop(name, c, **kw):
        s = Shop(id=uuid.uuid4(), tenant_id=c.tenant_id, company_id=c.id, name=name, settings={}, **kw)
        db.add(s)
        db.flush()
        return s

    w.a = company("רויאל בע\"מ", w.tenant, vat_number="515151515", address="הרצל 1", city="תל אביב")
    w.a_sub = company("רויאל צפון", w.tenant, parent=w.a)
    w.b = company("בטא", w.tenant, dealer_type="exempt")
    w.c = company("אחר", w.other_tenant)
    w.a_shop1 = shop("רויאל מרכז", w.a, address="דיזנגוף 50", city="תל אביב")
    w.a_shop2 = shop("רויאל ים", w.a)
    w.sub_shop = shop("רויאל חיפה", w.a_sub)
    w.c_shop = shop("אחר 1", w.c)
    w.admin = _user(db, "admin", UserRole.SUPER_ADMIN, w.tenant)
    w.cm = _user(db, "cm", UserRole.COMPANY_MANAGER, w.tenant, company=w.a)
    w.sm = _user(db, "sm", UserRole.SHOP_MANAGER, w.tenant, company=w.a, shop=w.a_shop1)
    w.cashier = _user(db, "cashier", UserRole.CASHIER, w.tenant, company=w.a, shop=w.a_shop1)
    db.commit()
    DA.forget(db)
    return w


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = _make_world()
    monkeypatch.setattr(auth_mw, "verify_clerk_token", lambda _token: None)

    def _db():
        yield world.db

    app.dependency_overrides[get_db] = _db
    world.client = TestClient(app, raise_server_exceptions=False)
    yield world
    app.dependency_overrides.pop(get_db, None)
    world.db.close()


def _h(user, tenant) -> dict:
    return {"Authorization": f"Bearer {create_access_token({'sub': user.username})}", "X-Tenant-Id": str(tenant.id)}


def _publish(w, kind, *, company=None, shop=None, extra=None):
    """A published version of [kind] for the company / shop (service level)."""
    company = company or w.a
    doc, _ = D.create_draft(w.db, company=company, shop=shop, kind=kind, user_id=w.admin.id, today=TODAY)
    fields = dict(doc.fields)
    fields.update(FILLED[kind])
    fields.update(extra or {})
    D.update_draft(w.db, doc, fields=fields, edit_seq=doc.edit_seq, user_id=w.admin.id)
    D.publish(w.db, doc, confirm_reviewed=True, edit_seq=doc.edit_seq, user_id=w.admin.id)
    w.db.commit()
    return doc


# ── Templates ────────────────────────────────────────────────────────────────


def test_every_template_placeholder_is_a_field_and_every_required_section_is_there():
    for spec in T.KINDS.values():
        used = set(T.placeholders(spec.body))
        assert used <= set(spec.field_by_key), (spec.kind, used - set(spec.field_by_key))
        assert set(spec.must_appear) <= used, spec.kind
        assert "<" not in spec.body and ">" not in spec.body, "templates are limited markdown, never HTML"
        # Hebrew, and no lawyer-only markers left in a starting text.
        assert re.search(r"[\u0590-\u05FF]", spec.body)
    assert {k["kind"] for k in T.catalogue()} == {"accessibility", "privacy", "terms", "cookies"}


def test_the_accessibility_statement_asks_for_what_the_regulations_list():
    spec = T.kind_def("accessibility")
    required = {f.key for f in spec.fields if f.required}
    assert {
        "coordinator.name", "coordinator.phone", "coordinator.email", "conformance.level",
        "accessibility.lastCheckDate", "accessibility.limitations", "accessibility.statementDate",
    } <= required


def test_prefill_takes_the_business_details_and_the_vat_rule():
    class Co:
        name, vat_number, company_number, address, city, dealer_type = "רויאל", "515151515", None, "הרצל 1", "תל אביב", "company"

    class Exempt(Co):
        dealer_type = "exempt"

    class ShopX:
        address, city = "דיזנגוף 50", "תל אביב"

    terms = T.prefill("terms", company=Co(), shop=ShopX())
    assert terms["business.name"] == "רויאל" and terms["business.id"] == "515151515"
    assert terms["business.address"] == "דיזנגוף 50, תל אביב"  # the shop's own address first
    assert 'כוללים מע"מ' in terms["terms.vatNote"]
    assert "עוסק פטור" in T.prefill("terms", company=Exempt())["terms.vatNote"]
    assert T.prefill("accessibility", today=TODAY)["accessibility.statementDate"] == "2026-10-10"


def test_render_drops_empty_optional_lines_formats_dates_and_previews_what_is_missing():
    body = "שם: {{coordinator.name}}\nבדיקה: {{accessibility.lastCheckDate}}\nאופציונלי: {{privacy.dpo}}\nסוף"
    out = T.render("accessibility", body, {"coordinator.name": "דנה", "accessibility.lastCheckDate": "2026-10-01"})
    assert "שם: דנה" in out and "בדיקה: 01.10.2026" in out
    assert "[חסר" not in out and "{{" not in out
    preview = T.render("accessibility", "שם: {{coordinator.name}}", {}, preview=True)
    assert "[חסר: רכז/ת הנגישות — שם]" in preview
    # An unknown field never prints its value through a template.
    assert T.clean_fields("privacy", {"privacy.dpo": "x", "hack": "<script>"}) == {"privacy.dpo": "x"}


def test_problems_name_what_blocks_publication():
    spec = T.kind_def("accessibility")
    fields = T.prefill("accessibility", today=TODAY)
    found = {(p["code"], p.get("field")) for p in T.problems("accessibility", spec.title, spec.body, fields, today=TODAY)}
    assert ("field_required", "coordinator.name") in found
    assert ("field_required", "accessibility.limitations") in found
    fields.update(FILLED["accessibility"], **{"business.name": "רויאל"})
    assert T.problems("accessibility", spec.title, spec.body, fields, today=TODAY) == []
    bad = dict(fields, **{"coordinator.email": "nope", "accessibility.lastCheckDate": "2027-01-01", "coordinator.phone": "12"})
    codes = {p["code"] for p in T.problems("accessibility", spec.title, spec.body, bad, today=TODAY)}
    assert {"email_invalid", "date_in_future", "phone_invalid"} <= codes
    # Removing the coordinator from the text is refused even with the field filled.
    cut = spec.body.replace("- שם: {{coordinator.name}}", "")
    assert ("section_missing", "coordinator.name") in {
        (p["code"], p.get("field")) for p in T.problems("accessibility", spec.title, cut, fields, today=TODAY)
    }
    assert any(p["code"] == "unknown_placeholder" for p in T.problems("accessibility", "x", spec.body + "{{secret.cost}}", fields, today=TODAY))


def test_terms_need_a_phone_or_an_email():
    spec = T.kind_def("terms")
    fields = T.prefill("terms")
    fields.update({"business.name": "x", "business.id": "1", "business.address": "y", "contact.phone": "", "contact.email": ""})
    codes = {p["code"] for p in T.problems("terms", spec.title, spec.body, fields)}
    assert "one_of_required" in codes


# ── Documents: drafts, "נבדק", publication ───────────────────────────────────


def test_a_draft_is_edited_reviewed_and_published_as_version_one(w):
    doc, created = D.create_draft(w.db, company=w.a, shop=None, kind="accessibility", user_id=w.cm.id, today=TODAY)
    assert created and doc.status == "draft" and doc.version == 0
    again, created2 = D.create_draft(w.db, company=w.a, shop=None, kind="accessibility")
    assert again.id == doc.id and not created2  # one draft per scope and kind
    assert doc.fields["business.name"] == w.a.name

    with pytest.raises(D.LegalError) as stale:
        D.update_draft(w.db, doc, title="x", edit_seq=doc.edit_seq + 5)
    assert stale.value.code == "edit_conflict" and stale.value.status == 409

    with pytest.raises(D.LegalError) as invalid:
        D.publish(w.db, doc, confirm_reviewed=True, edit_seq=doc.edit_seq)
    assert invalid.value.code == "publish_invalid"
    assert {p["field"] for p in invalid.value.extra["problems"] if p.get("field")} >= {"coordinator.name"}

    D.update_draft(w.db, doc, fields={**doc.fields, **FILLED["accessibility"]}, edit_seq=doc.edit_seq)
    with pytest.raises(D.LegalError) as review:
        D.publish(w.db, doc, confirm_reviewed=False, edit_seq=doc.edit_seq)
    assert review.value.code == "review_required"

    D.publish(w.db, doc, confirm_reviewed=True, edit_seq=doc.edit_seq, review_note="עו\"ד כהן", user_id=w.cm.id)
    w.db.commit()
    assert (doc.status, doc.version, doc.reviewed) == ("published", 1, True)
    assert doc.reviewed_by == w.cm.id and doc.published_at is not None and doc.review_note == 'עו"ד כהן'

    with pytest.raises(D.LegalError) as frozen:
        D.update_draft(w.db, doc, title="שינוי", edit_seq=doc.edit_seq)
    assert frozen.value.code == "not_a_draft"


def test_any_edit_clears_reviewed_and_the_next_version_archives_the_previous(w):
    v1 = _publish(w, "privacy")
    draft, _ = D.create_draft(w.db, company=w.a, shop=None, kind="privacy", start="published")
    assert draft.body == v1.body and draft.fields == v1.fields and draft.reviewed is False
    D.update_draft(w.db, draft, body=draft.body + "\nתוספת.", edit_seq=draft.edit_seq)
    assert draft.reviewed is False and draft.edit_seq == 1
    D.publish(w.db, draft, confirm_reviewed=True, edit_seq=draft.edit_seq)
    w.db.commit()
    assert draft.version == 2 and v1.status == "archived"
    assert D.published_of(w.db, w.a.id, None, "privacy").id == draft.id


def test_a_draft_can_be_discarded_a_published_version_cannot(w):
    doc, _ = D.create_draft(w.db, company=w.a, shop=None, kind="cookies")
    D.discard_draft(w.db, doc)
    assert D.draft_of(w.db, w.a.id, None, "cookies") is None
    pub = _publish(w, "cookies")
    with pytest.raises(D.LegalError):
        D.discard_draft(w.db, pub)


def test_the_public_sees_the_shops_own_else_the_company_else_a_parent(w):
    assert D.effective(w.db, company_id=w.a.id, shop_id=w.a_shop1.id, kind="privacy") == (None, None)
    company_doc = _publish(w, "privacy")
    assert D.effective(w.db, company_id=w.a.id, shop_id=w.a_shop1.id, kind="privacy") == (company_doc, "company")
    # A shop's draft never shows; its published override does — only for that shop.
    override, _ = D.create_draft(w.db, company=w.a, shop=w.a_shop1, kind="privacy", start="inherited")
    assert override.shop_id == w.a_shop1.id and override.body == company_doc.body
    assert D.effective(w.db, company_id=w.a.id, shop_id=w.a_shop1.id, kind="privacy")[0] == company_doc
    D.publish(w.db, override, confirm_reviewed=True, edit_seq=override.edit_seq)
    w.db.commit()
    assert D.effective(w.db, company_id=w.a.id, shop_id=w.a_shop1.id, kind="privacy") == (override, "shop")
    assert D.effective(w.db, company_id=w.a.id, shop_id=w.a_shop2.id, kind="privacy") == (company_doc, "company")
    # A subsidiary without its own inherits from the parent company.
    assert D.effective(w.db, company_id=w.a_sub.id, shop_id=w.sub_shop.id, kind="privacy") == (company_doc, "parent_company")
    # Never across companies.
    assert D.effective(w.db, company_id=w.b.id, kind="privacy") == (None, None)


def test_a_company_draft_does_not_leak_to_shops(w):
    D.create_draft(w.db, company=w.a, shop=None, kind="terms")
    w.db.commit()
    assert D.published_kinds(w.db, company_id=w.a.id, shop_id=w.a_shop1.id) == {}
    assert D.public_page(w.db, company=w.a, shop_id=w.a_shop1.id, kind="terms") is None


# ── The publication gate ─────────────────────────────────────────────────────


REPORT_OK = {"engine": "runner-a11y", "version": 1, "violations": []}


def test_a_menu_or_card_needs_three_legal_pages_ordering_needs_four(w):
    res = G.check_publication(w.db, company_id=w.a.id, product="menu")
    assert not res["ok"] and {b["kind"] for b in res["blocking"] if b["code"] == "legal_missing"} == {
        "accessibility", "privacy", "cookies"}
    for kind in ("accessibility", "privacy", "cookies"):
        _publish(w, kind)
    assert G.check_publication(w.db, company_id=w.a.id, shop_id=w.a_shop1.id, product="menu")["ok"]
    assert G.check_publication(w.db, company_id=w.a.id, product="card")["ok"]
    online = G.check_publication(w.db, company_id=w.a.id, product="online")
    assert [b["kind"] for b in online["blocking"]] == ["terms"]
    _publish(w, "terms")
    assert G.assert_publishable(w.db, company_id=w.a.id, product="online", theme={}, a11y_report=REPORT_OK)["ok"]


def test_contrast_images_and_a11y_violations_block_publication(w):
    for kind in ("accessibility", "privacy", "cookies", "terms"):
        _publish(w, kind)
    low = G.check_publication(w.db, company_id=w.a.id, product="online", theme={"textColor": "#9CA3AF"})
    assert {b["pair"] for b in low["blocking"] if b["code"] == "contrast_below_aa"} == {"text_on_background", "text_on_surface"}
    imgs = G.check_publication(w.db, company_id=w.a.id, product="menu", images=[
        {"url": "a.jpg", "alt": "שקשוקה"}, {"url": "b.jpg", "alt": " "}, {"url": "c.jpg", "decorative": True}])
    assert [b["ref"] for b in imgs["blocking"]] == ["b.jpg"]
    report = {"engine": "runner-a11y", "violations": [
        {"rule": "image-alt", "impact": "serious", "count": 2}, {"rule": "heading-order", "impact": "moderate", "count": 1}]}
    res = G.check_publication(w.db, company_id=w.a.id, product="menu", a11y_report=report)
    assert [b["rule"] for b in res["blocking"]] == ["image-alt"] and [x["rule"] for x in res["warnings"]] == ["heading-order"]
    with pytest.raises(D.LegalError) as blocked:
        G.assert_publishable(w.db, company_id=w.a.id, product="menu", theme=None)  # no a11y report
    assert blocked.value.code == "publication_blocked" and blocked.value.status == 409
    assert blocked.value.extra["check"]["blocking"] == [{"code": "a11y_report_missing"}]
    # For a publish route: the structured API error, with the check for the review dialog.
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as http:
        G.raise_if_blocked(w.db, company_id=w.a.id, product="menu", theme={"textColor": "#9CA3AF"}, a11y_report=REPORT_OK)
    assert http.value.status_code == 409 and http.value.detail["code"] == "publication_blocked"
    assert http.value.detail["userMessage"] and http.value.detail["check"]["blocking"][0]["code"] == "contrast_below_aa"
    assert G.raise_if_blocked(w.db, company_id=w.a.id, product="menu", theme={}, a11y_report=REPORT_OK)["ok"]


# ── Contrast ─────────────────────────────────────────────────────────────────


def test_contrast_matches_the_shared_golden_fixture():
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert len(golden["ratios"]) >= 15 and len(golden["themes"]) >= 8
    for case in golden["ratios"]:
        got = C.contrast_ratio(case["fg"], case["bg"])
        assert (None if got is None else round(got, 2)) == case["ratio"], case
    for case in golden["themes"]:
        res = C.check_theme(case["theme"])
        assert res["ok"] == case["ok"] and res["failures"] == case["failures"], case["name"]
        assert {p["id"]: p["ratio"] for p in res["pairs"]} == case["ratios"], case["name"]


def test_aa_thresholds_are_not_rounded_up():
    assert C.contrast_ratio("#777777", "#FFFFFF") < 4.5  # 4.48 — fails text
    assert not C.check_theme({"textColor": "#777777"})["ok"]
    assert C.check_theme({"textColor": "#767676"})["ok"]


# ── Cookie consent ───────────────────────────────────────────────────────────


ANON = "a1B2c3D4e5F6g7H8i9J0"


def test_the_visitor_id_is_kept_only_as_a_keyed_hash_and_revoke_turns_optional_off(w):
    row = CONSENT.record(w.db, company=w.a, anon_id=ANON, choices={"analytics": True, "marketing": "yes"},
                         policy_version=3, action="grant", surface="menu", ip="9.9.9.9")
    w.db.commit()
    assert row.choices == {"essential": True, "analytics": True, "marketing": False}  # only a literal true
    assert ANON not in json.dumps({c.name: str(getattr(row, c.name)) for c in row.__table__.columns})
    assert row.ip_hash and "9.9.9.9" not in row.ip_hash
    revoked = CONSENT.record(w.db, company=w.a, anon_id=ANON, choices={"analytics": True}, policy_version=3, action="revoke")
    w.db.commit()
    assert revoked.choices == {"essential": True, "analytics": False, "marketing": False}
    assert CONSENT.latest(w.db, company_id=w.a.id, anon_id=ANON).id == revoked.id
    assert w.db.query(CookieConsentRecord).count() == 2  # append-only
    for bad in ("short", "x" * 70, "bad id with spaces!!"):
        with pytest.raises(D.LegalError):
            CONSENT.record(w.db, company=w.a, anon_id=bad, choices={}, policy_version=1, action="grant")


def test_the_cookie_policy_version_is_the_published_one(w):
    assert CONSENT.policy_version(w.db, company_id=w.a.id) == 0
    _publish(w, "cookies")
    assert CONSENT.policy_version(w.db, company_id=w.a.id, shop_id=w.a_shop1.id) == 1


# ── Marketing consent (§30A) ─────────────────────────────────────────────────


def test_an_unticked_box_records_nothing_and_the_text_must_be_the_shown_one():
    assert M.consent_from_payload(None, business_name="רויאל") is None
    assert M.consent_from_payload({"granted": False, "channel": "sms"}, business_name="רויאל") is None
    text = M.consent_text("sms", "רויאל")
    got = M.consent_from_payload({"granted": True, "channel": "sms", "text": text, "textVersion": "mk-he-1"}, business_name="רויאל")
    assert got == {"channel": "sms", "text": text, "textVersion": "mk-he-1"}
    with pytest.raises(D.LegalError) as forged:
        M.consent_from_payload({"granted": True, "channel": "sms", "text": "הסכמה לכל דבר"}, business_name="רויאל")
    assert forged.value.code == "marketing_text_mismatch"


def test_marketing_consent_stores_a_hash_and_the_latest_choice_decides(w):
    text = M.consent_text("sms", w.a.name)
    row = M.record(w.db, company=w.a, channel="sms", contact="050-123-4567", granted=True, text=text,
                   text_version=M.CURRENT_TEXT_VERSION, source="checkout", source_ref="order-1", ip="1.1.1.1")
    w.db.commit()
    assert "0501234567" not in row.subject_hash and row.subject_kind == "phone"
    assert M.has_consent(w.db, company_id=w.a.id, channel="sms", contact="+972501234567")  # same number, other format
    assert not M.has_consent(w.db, company_id=w.a.id, channel="email", contact="a@b.co")
    assert not M.has_consent(w.db, company_id=w.b.id, channel="sms", contact="0501234567")  # per company
    M.record(w.db, company=w.a, channel="sms", contact="0501234567", granted=False, text=text,
             text_version=M.CURRENT_TEXT_VERSION, source="unsubscribe")
    w.db.commit()
    assert not M.has_consent(w.db, company_id=w.a.id, channel="sms", contact="0501234567")
    assert w.db.query(MarketingConsentRecord).count() == 2
    with pytest.raises(D.LegalError):
        M.record(w.db, company=w.a, channel="sms", contact="not a phone", granted=True, text=text,
                 text_version="mk-he-1", source="checkout")


def test_the_client_shows_the_same_marketing_texts():
    source = (ROOT.parent / "client" / "src" / "lib" / "marketingConsent.ts").read_text(encoding="utf-8")
    assert f"'{M.CURRENT_TEXT_VERSION}'" in source
    for channel, text in M.TEXTS[M.CURRENT_TEXT_VERSION].items():
        assert text in source, channel


# ── The API ──────────────────────────────────────────────────────────────────


def test_the_routes_are_the_digital_legal_section():
    assert "digital_legal" in DS.SECTION_IDS
    assert DS.rule_for("GET", "/digital-legal/documents").describe("GET") == "digital_legal:view"
    assert DS.rule_for("POST", "/digital-legal/documents/{}/publish").describe("POST") == "digital_legal:edit"
    assert DS.rule_for("POST", "/digital-legal/preview").describe("POST") == "digital_legal:view"


def test_dashboard_flow_draft_save_publish_then_public(w):
    h = _h(w.cm, w.tenant)
    q = f"companyId={w.a.id}"
    r = w.client.post(f"/api/v1/digital-legal/documents?{q}", json={"kind": "accessibility"}, headers=h)
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["created"] and doc["status"] == "draft" and doc["fields"]["business.name"] == w.a.name

    r = w.client.post(f"/api/v1/digital-legal/documents/{doc['id']}/publish", json={"confirmReviewed": True, "editSeq": 0}, headers=h)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "publish_invalid"

    fields = {**doc["fields"], **FILLED["accessibility"]}
    r = w.client.put(f"/api/v1/digital-legal/documents/{doc['id']}", json={"fields": fields, "editSeq": 0}, headers=h)
    assert r.status_code == 200 and r.json()["problems"] == [] and r.json()["editSeq"] == 1
    r = w.client.put(f"/api/v1/digital-legal/documents/{doc['id']}", json={"title": "x", "editSeq": 0}, headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "edit_conflict"

    # Not public yet.
    assert w.client.get(f"/api/v1/public/v1/legal/{w.a.id}/accessibility").status_code == 404
    r = w.client.post(f"/api/v1/digital-legal/documents/{doc['id']}/publish", json={"editSeq": 1}, headers=h)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "review_required"
    r = w.client.post(f"/api/v1/digital-legal/documents/{doc['id']}/publish", json={"confirmReviewed": True, "editSeq": 1}, headers=h)
    assert r.status_code == 200 and r.json()["version"] == 1

    page = w.client.get(f"/api/v1/public/v1/legal/{w.a.id}/accessibility?shopId={w.a_shop1.id}")
    assert page.status_code == 200
    body = page.json()
    assert "דנה לוי" in body["body"] and "01.10.2026" in body["body"] and "{{" not in body["body"]
    assert set(body) == {"kind", "slug", "lang", "title", "body", "version", "publishedAt", "source", "businessName"}
    index = w.client.get(f"/api/v1/public/v1/legal/{w.a.id}").json()
    assert list(index["documents"]) == ["accessibility"] and index["cookiePolicyVersion"] == 0

    overview = w.client.get(f"/api/v1/digital-legal/documents?{q}", headers=h).json()
    acc = overview["kinds"]["accessibility"]
    assert acc["published"]["version"] == 1 and acc["draft"] is None and len(acc["history"]) == 1
    assert overview["draftBanner"] == "טיוטה — יש לבדוק עם עורך דין"


def test_scope_shop_managers_edit_only_their_shop_and_tenants_stay_apart(w):
    sm = _h(w.sm, w.tenant)
    r = w.client.post(f"/api/v1/digital-legal/documents?companyId={w.a.id}", json={"kind": "privacy"}, headers=sm)
    assert r.status_code == 403
    r = w.client.post(f"/api/v1/digital-legal/documents?companyId={w.a.id}&shopId={w.a_shop2.id}", json={"kind": "privacy"}, headers=sm)
    assert r.status_code == 403
    r = w.client.post(f"/api/v1/digital-legal/documents?companyId={w.a.id}&shopId={w.a_shop1.id}", json={"kind": "privacy"}, headers=sm)
    assert r.status_code == 200 and r.json()["shopId"] == str(w.a_shop1.id)
    # A cashier never; another tenant's company is not found; a shop of another company neither.
    assert w.client.get(f"/api/v1/digital-legal/documents?companyId={w.a.id}", headers=_h(w.cashier, w.tenant)).status_code == 403
    assert w.client.get(f"/api/v1/digital-legal/documents?companyId={w.c.id}", headers=_h(w.admin, w.tenant)).status_code == 404
    assert w.client.get(f"/api/v1/digital-legal/documents?companyId={w.b.id}&shopId={w.a_shop1.id}",
                        headers=_h(w.admin, w.tenant)).status_code == 404
    # The company manager of A does not reach company B.
    assert w.client.get(f"/api/v1/digital-legal/documents?companyId={w.b.id}", headers=_h(w.cm, w.tenant)).status_code == 403


def test_publication_check_theme_check_preview_and_catalog(w):
    h = _h(w.cm, w.tenant)
    res = w.client.get(f"/api/v1/digital-legal/publication-check?companyId={w.a.id}&product=online", headers=h).json()
    assert not res["ok"] and len([b for b in res["blocking"] if b["code"] == "legal_missing"]) == 4
    assert w.client.get(f"/api/v1/digital-legal/publication-check?companyId={w.a.id}&product=x", headers=h).status_code == 422
    theme = w.client.post("/api/v1/digital-legal/theme-check", json={"theme": {"textColor": "#9CA3AF"}}, headers=h).json()
    assert theme["ok"] is False
    pv = w.client.post("/api/v1/digital-legal/preview", json={"kind": "cookies", "body": "{{contact.email}}", "fields": {}}, headers=h).json()
    assert "[חסר" in pv["preview"] and pv["published"].strip() == ""
    cat = w.client.get("/api/v1/digital-legal/catalog", headers=h).json()
    assert cat["requiredKinds"]["online"] == ["accessibility", "privacy", "cookies", "terms"]


def test_public_consent_endpoint_logs_and_refuses_bad_input(w):
    r = w.client.post("/api/v1/public/v1/consents", json={
        "companyId": str(w.a.id), "anonId": ANON, "choices": {"analytics": True}, "policyVersion": 0,
        "action": "grant", "surface": "menu"})
    assert r.status_code == 201 and r.json()["choices"] == {"essential": True, "analytics": True, "marketing": False}
    assert w.client.post("/api/v1/public/v1/consents", json={"companyId": str(w.a.id), "anonId": "x", "action": "grant"}).status_code == 422
    assert w.client.post("/api/v1/public/v1/consents", json={"companyId": str(uuid.uuid4()), "anonId": ANON, "action": "grant"}).status_code == 404
    assert w.client.get(f"/api/v1/public/v1/legal/{w.a.id}/nope").status_code == 404


# ── Migration ────────────────────────────────────────────────────────────────


def test_the_migration_is_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "alembic"))
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    assert len(heads) == 1
    assert "d9a4c6e8b2f1" in {r.revision for r in script.walk_revisions("base", heads[0])}
    rev = script.get_revision("d9a4c6e8b2f1")
    assert rev.down_revision == "b8e2d4f6a1c3"
