"""
"כרטיסי ביקור דיגיטליים" — app/services/business_cards.py and app/routers/business_cards.py.

Lifecycle and revisions, slugs and their redirects, inheritance across published cards only,
private fields kept out of the page and the VCF, the VCF's escaping / Hebrew encoding / folding,
the enquiry form's validation, dedupe and rate limits, the cookie-free counters, and the scope
rules (tenant, branch, sales point).
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import app.models  # noqa: F401
from app.middleware import rate_limit as RL
from app.models.business_card import BusinessCard, BusinessCardDailyStat, BusinessCardEnquiry, BusinessCardRevision
from app.models.club import ClubDocumentVersion, ClubProgram
from app.models.company import Company
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.routers import business_cards as B
from app.services import business_card_resolve as R
from app.services import business_cards as svc
from shift_world import accept_str_uuids, make_world

A11Y = "https://acme.example/accessibility"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    RL._buckets.clear()
    world = make_world()
    db = world.db

    def user(role, name, **kw):
        u = User(id=uuid.uuid4(), role=role, tenant_id=world.tenant.id, email=f"{name}@x", username=name, **kw)
        db.add(u)
        return u

    world.manager = user(UserRole.SHOP_MANAGER, "manager", shop_id=world.shop.id)
    world.north_manager = user(UserRole.SHOP_MANAGER, "north", shop_id=world.other_shop.id)
    world.company_manager = user(UserRole.COMPANY_MANAGER, "cm", company_id=world.company.id)
    world.cashier = user(UserRole.CASHIER, "cashier", shop_id=world.shop.id)
    world.area = ShopArea(id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, name="בר")
    db.add(world.area)
    world.company.address, world.company.city = "הרצל 1", "תל אביב"
    world.shop.address, world.shop.city = "סוקולוב 5", "הרצליה"
    # The club's active privacy policy is the card's default privacy link.
    club = ClubProgram(id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id, name="Club")
    db.add(club)
    db.flush()
    db.add(ClubDocumentVersion(id=uuid.uuid4(), tenant_id=world.tenant.id, club_id=club.id, kind="privacy", version=1,
                               status="active", title="מדיניות פרטיות", body="...", url="https://acme.example/privacy"))
    tenant2 = Tenant(id=uuid.uuid4(), name="T2", slug="t2", timezone="Asia/Jerusalem")
    db.add(tenant2)
    db.flush()
    company2 = Company(id=uuid.uuid4(), tenant_id=tenant2.id, name="Other", vat_number="1")
    db.add(company2)
    db.flush()
    world.tenant2 = tenant2
    world.foreign_shop = Shop(id=uuid.uuid4(), tenant_id=tenant2.id, company_id=company2.id, name="Far", settings={})
    db.add(world.foreign_shop)
    db.commit()
    return world


def request(*, ip="10.1.2.3", ua="Mozilla/5.0 (iPhone) Safari/604.1", method="GET"):
    return Request({
        "type": "http", "method": method, "path": "/", "query_string": b"",
        "headers": [(b"user-agent", ua.encode())], "client": (ip, 1234),
    })


def create(w, user=None, **body):
    body.setdefault("type", "company")
    body.setdefault("companyId", str(w.company.id))
    body.setdefault("name", "Acme")
    return B.create_card(body, current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def put(w, card, mutate, user=None):
    draft = json.loads(json.dumps(card["draft"]))
    mutate(draft)
    out = B.put_draft(card["id"], {"draft": draft, "expectedVersion": card["draftVersion"]},
                      current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)
    card.update({"draft": out["draft"], "draftVersion": out["draftVersion"]})
    return card


def local(draft, key, value, visibility="public"):
    draft["fields"][key] = {"mode": "local", "visibility": visibility, "value": value}


def publish(w, card, user=None):
    return B.publish_card(card["id"], {"expectedVersion": card["draftVersion"]}, current_user=user or w.admin,
                          active_tenant_id=w.tenant.id, db=w.db)


def public(w, slug, lang=None):
    resp = B.public_card(slug, request(), lang=lang, db=w.db)
    return resp.status_code, json.loads(resp.body)


def ready_company(w, **kw):
    card = create(w, **kw)

    def m(d):
        local(d, "description", {"he": "קפה ומאפים"})
        local(d, "phone", "03-1234567")
        local(d, "accessibilityUrl", A11Y)

    return put(w, card, m)


# ── Lifecycle, revisions, publication ────────────────────────────────────────


def test_a_card_is_born_a_draft_with_a_stable_slug_and_org_defaults(w):
    card = create(w, name="Acme Cafe")
    assert card["status"] == "draft" and card["slug"] == "acme-cafe" and card["publicPath"] == "/c/acme-cafe"
    ctx = card["context"]["card"]["org"]
    assert ctx["title"] == "Acme" and ctx["sources"]["title"] == "org:company"
    assert ctx["address"] == "הרצל 1, תל אביב"
    assert ctx["privacyUrl"] == "https://acme.example/privacy" and ctx["sources"]["privacyUrl"] == "org:club"
    second = create(w, name="Acme Cafe")
    assert second["slug"].startswith("acme-cafe-") and second["slug"] != card["slug"]
    hebrew = create(w, name="קפה אקמה")
    assert hebrew["slug"].startswith("card-")


def test_publication_needs_the_legal_links_and_shows_the_published_revision_only(w):
    card = create(w)
    with pytest.raises(HTTPException) as blocked:
        publish(w, card)
    assert blocked.value.status_code == 422
    codes = {i["code"] for i in blocked.value.detail["issues"] if i["level"] == "error"}
    assert codes == {"accessibility_required"}  # the title and privacy link come from the org / club
    put(w, card, lambda d: local(d, "accessibilityUrl", A11Y))
    out = publish(w, card)
    assert out["revision"]["number"] == 1 and out["card"]["status"] == "published"
    code, body = public(w, card["slug"])
    assert code == 200 and body["kind"] == "card" and body["card"]["header"]["title"]["text"] == "Acme"
    assert body["card"]["revision"]["number"] == 1
    # A draft edit does not reach the public page until it is published.
    put(w, card, lambda d: local(d, "title", {"he": "אקמה החדשה"}))
    assert public(w, card["slug"])[1]["card"]["header"]["title"]["text"] == "Acme"
    detail = B.get_card(card["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert detail["hasUnpublishedChanges"] is True
    publish(w, card)
    assert public(w, card["slug"])[1]["card"]["header"]["title"]["text"] == "אקמה החדשה"
    revs = B.list_revisions(card["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert [r["number"] for r in revs] == [2, 1] and revs[0]["isLive"] is True


def test_rollback_publishes_an_older_revision_and_keeps_history_linear(w):
    card = ready_company(w)
    publish(w, card)
    put(w, card, lambda d: local(d, "title", {"he": "גרסה שנייה"}))
    publish(w, card)
    first = next(r for r in B.list_revisions(card["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db) if r["number"] == 1)
    out = B.publish_revision(card["id"], first["id"], {}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert out["revision"]["number"] == 3
    assert public(w, card["slug"])[1]["card"]["header"]["title"]["text"] == "Acme"
    # The draft keeps the newer work; restoring the old revision into it is a separate, explicit step.
    detail = B.get_card(card["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert detail["draft"]["fields"]["title"]["value"] == {"he": "גרסה שנייה"}
    restored = B.restore_revision(card["id"], first["id"], {"expectedVersion": detail["draftVersion"]},
                                  current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert restored["draft"]["fields"]["title"]["mode"] == "inherit"


def test_saving_is_a_checkpoint_and_a_stale_draft_write_is_refused(w):
    card = create(w)
    out = B.save_card(card["id"], {"expectedVersion": card["draftVersion"]}, current_user=w.admin,
                      active_tenant_id=w.tenant.id, db=w.db)
    assert out["card"]["status"] == "saved" and out["revision"]["kind"] == "saved"
    stale = card["draftVersion"]
    put(w, card, lambda d: local(d, "role", {"he": "x"}))
    with pytest.raises(HTTPException) as conflict:
        B.put_draft(card["id"], {"draft": card["draft"], "expectedVersion": stale}, current_user=w.admin,
                    active_tenant_id=w.tenant.id, db=w.db)
    assert conflict.value.status_code == 409 and conflict.value.detail["code"] == "draft_conflict"
    assert conflict.value.detail["currentVersion"] == card["draftVersion"]


def test_pause_archive_restore(w):
    card = ready_company(w)
    publish(w, card)
    B._state("pause")(card["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert public(w, card["slug"]) == (200, {"kind": "paused", "lang": "he", "dir": "rtl"})
    B._state("resume")(card["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert public(w, card["slug"])[1]["kind"] == "card"
    B._state("archive")(card["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert public(w, card["slug"])[0] == 404
    out = B._state("restore")(card["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert out["status"] == "paused"  # restoring never republishes by itself


def test_an_expired_event_card_answers_like_a_paused_one(w):
    card = ready_company(w)
    put(w, card, lambda d: d.update({"expiresAt": "2020-01-01"}))
    review = B.publish_review(card["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert "card_expired" in {i["code"] for i in review["issues"]} and not review["blocked"]
    publish(w, card)
    assert public(w, card["slug"])[1]["kind"] == "paused"
    put(w, card, lambda d: d.update({"expiresAt": "2999-12-31"}))
    publish(w, card)
    assert public(w, card["slug"])[1]["kind"] == "card"


def test_cards_inherit_the_public_business_profile_from_the_settings(w):
    w.company.settings = {"publicWebsite": "https://acme.example", "publicAccessibilityUrl": "https://acme.example/a11y"}
    w.shop.settings = {"publicWhatsapp": "052-1234567"}
    w.db.commit()
    branch = create(w, type="branch", shopId=str(w.shop.id), name="Center", parentCardId=None)
    org = branch["context"]["card"]["org"]
    assert org["whatsapp"] == "052-1234567" and org["sources"]["whatsapp"] == "org:shop"
    assert org["website"] == "https://acme.example" and org["sources"]["website"] == "org:company"
    publish(w, branch)  # the accessibility link comes from the company's settings
    body = public(w, branch["slug"])[1]["card"]
    assert body["contact"]["whatsapp"]["e164"] == "+972521234567"
    assert body["legal"]["accessibilityUrl"] == "https://acme.example/a11y"
    person = create(w, type="personal", shopId=str(w.shop.id), name="Dana", parentCardId=None)
    model = R.resolve_card(svc.resolve_input(w.db, w.db.get(BusinessCard, uuid.UUID(person["id"])), person["draft"], "he"))
    assert model["fields"]["whatsapp"]["value"] is None  # never the branch's number on a person's card


def test_the_draft_keeps_no_markup_and_no_unknown_keys(w):
    card = create(w)

    def m(d):
        d["evil"] = "<script>"
        d["fields"]["title"] = {"mode": "local", "visibility": "public", "value": {"he": "<b>שלום</b>\x00", "xx": "no"}}
        d["actions"].append({"id": "js", "type": "link", "enabled": True, "url": "javascript:alert(1)", "onclick": "x"})
        d["actions"].append({"id": "html", "type": "html", "enabled": True})

    put(w, card, m)
    assert "evil" not in card["draft"]
    assert card["draft"]["fields"]["title"]["value"] == {"he": "<b>שלום</b>"}  # stored as text, never rendered as HTML
    js = next(a for a in card["draft"]["actions"] if a["id"] == "js")
    assert "onclick" not in js and not any(a["id"] == "html" for a in card["draft"]["actions"])
    model = R.resolve_card(svc.resolve_input(w.db, w.db.get(BusinessCard, uuid.UUID(card["id"])), card["draft"], "he"))
    assert not any(a["id"] == "js" for a in model["model"]["actions"])


# ── Slugs ─────────────────────────────────────────────────────────────────────


def test_a_renamed_slug_redirects_and_is_never_given_to_another_card(w):
    card = ready_company(w, name="Acme")
    publish(w, card)
    old = card["slug"]
    B.rename_slug(card["id"], {"slug": "acme-new"}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert public(w, old) == (200, {"kind": "redirect", "slug": "acme-new"})
    assert public(w, "acme-new")[1]["kind"] == "card"
    other = create(w, name="Other")
    with pytest.raises(HTTPException) as taken:
        B.rename_slug(other["id"], {"slug": old}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert taken.value.status_code == 409 and taken.value.detail["code"] == "slug_taken"
    with pytest.raises(HTTPException) as bad:
        B.rename_slug(other["id"], {"slug": "Not Valid"}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert bad.value.status_code == 422
    # Back to its own old path: allowed, and the newer one now redirects.
    out = B.rename_slug(card["id"], {"slug": old}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert [s["slug"] for s in out["slugs"] if s["live"]] == [old]
    assert public(w, "acme-new") == (200, {"kind": "redirect", "slug": old})
    # The VCF and the enquiry form follow the redirect too.
    resp = B.public_vcard("acme-new", request(), lang=None, db=w.db)
    assert resp.status_code == 200


# ── Inheritance ───────────────────────────────────────────────────────────────


def test_a_branch_inherits_published_company_values_only(w):
    company = ready_company(w)
    publish(w, company)
    branch = create(w, type="branch", shopId=str(w.shop.id), name="Center")
    assert branch["parentCardId"] == company["id"]  # the nearest live card one level up
    put(w, branch, lambda d: None)
    publish(w, branch)
    body = public(w, branch["slug"])[1]["card"]
    assert body["header"]["title"]["text"] == "Center"  # the branch's own name (org:shop)
    assert body["header"]["orgLine"]["text"] == "Acme"
    assert body["contact"]["phone"]["e164"] == "+97231234567"  # from the company card
    assert body["contact"]["address"]["text"] == "סוקולוב 5, הרצליה"  # the branch's own address first
    # The company's unpublished edit does not leak into the branch.
    put(w, company, lambda d: local(d, "phone", "03-7777777"))
    assert public(w, branch["slug"])[1]["card"]["contact"]["phone"]["e164"] == "+97231234567"
    publish(w, company)
    assert public(w, branch["slug"])[1]["card"]["contact"]["phone"]["e164"] == "+97237777777"
    # Publishing the company card created no revision of the branch.
    assert w.db.query(BusinessCardRevision).filter(BusinessCardRevision.card_id == uuid.UUID(branch["id"])).count() == 1
    # A private field on the parent is not inherited.
    put(w, company, lambda d: d["fields"]["phone"].update({"visibility": "private"}))
    publish(w, company)
    assert public(w, branch["slug"])[1]["card"]["contact"]["phone"] is None


def test_point_cards_and_parents_follow_the_hierarchy(w):
    company = ready_company(w)
    branch = create(w, type="branch", shopId=str(w.shop.id), name="Center")
    point = create(w, type="point", areaId=str(w.area.id), name="Bar")
    assert point["shopId"] == str(w.shop.id) and point["parentCardId"] == branch["id"]
    assert point["context"]["card"]["org"]["title"] == "בר"
    with pytest.raises(HTTPException) as bad_parent:
        B.update_card(branch["id"], {"parentCardId": point["id"]}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert bad_parent.value.status_code == 422
    with pytest.raises(HTTPException) as wrong_target:
        create(w, type="branch", name="X")  # a branch card needs a branch
    assert wrong_target.value.status_code == 422
    assert company["parentCardId"] is None


# ── Scope ─────────────────────────────────────────────────────────────────────


def test_scope_by_tenant_branch_and_role(w):
    center = create(w, type="branch", shopId=str(w.shop.id), name="Center", user=w.manager)
    with pytest.raises(HTTPException) as company_card:
        create(w, user=w.manager)  # a shop manager does not own the company card
    assert company_card.value.status_code == 403
    with pytest.raises(HTTPException) as other_branch:
        B.get_card(center["id"], current_user=w.north_manager, active_tenant_id=w.tenant.id, db=w.db)
    assert other_branch.value.status_code == 403
    with pytest.raises(HTTPException) as cashier:
        B.list_cards(current_user=w.cashier, active_tenant_id=w.tenant.id, db=w.db, company_id=None, shop_id=None,
                     area_id=None, card_type=None, status_filter=None, template=None, q=None, include_archived=False)
    assert cashier.value.status_code == 403
    with pytest.raises(HTTPException) as foreign:
        create(w, type="branch", shopId=str(w.foreign_shop.id), name="Far")
    assert foreign.value.status_code == 422
    with pytest.raises(HTTPException) as other_tenant:
        B.get_card(center["id"], current_user=w.admin, active_tenant_id=w.tenant2.id, db=w.db)
    assert other_tenant.value.status_code == 404
    listed = B.list_cards(current_user=w.north_manager, active_tenant_id=w.tenant.id, db=w.db, company_id=None, shop_id=None,
                          area_id=None, card_type=None, status_filter=None, template=None, q=None, include_archived=False)
    assert listed == []
    mine = B.list_cards(current_user=w.company_manager, active_tenant_id=w.tenant.id, db=w.db, company_id=None, shop_id=None,
                        area_id=None, card_type=None, status_filter=None, template=None, q="cent", include_archived=False)
    assert [c["id"] for c in mine] == [center["id"]]


def test_the_section_rules_cover_every_card_route():
    from app.services.dashboard_sections import rule_for

    assert rule_for("GET", "/business-cards").sections == ("business_cards",)
    assert rule_for("POST", "/business-cards/{card_id}/publish").level is None
    assert rule_for("POST", "/business-cards/{card_id}/preview-vcard").level == "view"


# ── Private fields, the VCF ──────────────────────────────────────────────────


def test_private_fields_stay_out_of_the_page_and_the_vcf(w):
    company = ready_company(w)
    publish(w, company)
    person = create(w, type="personal", shopId=str(w.shop.id), name="Dana")

    def m(d):
        local(d, "title", {"he": "דנה כהן"})
        assert d["fields"]["phone"]["visibility"] == "private"  # private by default on a personal card
        d["fields"]["phone"].update({"mode": "local", "value": "050-111-2222"})
        local(d, "email", "dana.private@acme.example", visibility="private")
        local(d, "whatsapp", "052-333-4444", visibility="public")

    put(w, person, m)
    assert person["draft"]["fields"]["phone"]["visibility"] == "private"
    publish(w, person)
    body = public(w, person["slug"])[1]["card"]
    text = json.dumps(body, ensure_ascii=False)
    assert "+972501112222" not in text and "050-111-2222" not in text and "dana.private" not in text
    assert body["contact"]["whatsapp"]["e164"] == "+972523334444"
    vcf = B.public_vcard(person["slug"], request(), lang=None, db=w.db).body.decode("utf-8")
    assert "+972501112222" not in vcf and "dana.private" not in vcf
    assert "TEL;TYPE=CELL:+972523334444" in vcf
    assert "N;CHARSET=UTF-8:;דנה כהן;;;" in vcf
    # Each download is counted once (a download — not proof the contact was saved).
    stat = w.db.query(BusinessCardDailyStat).filter(BusinessCardDailyStat.metric == "vcf").one()
    assert stat.count == 1


def _unfold(text: str) -> str:
    return text.replace("\r\n ", "")


def test_vcf_escaping_encoding_and_folding():
    model = {
        "type": "company", "slug": "acme",
        "header": {"title": {"text": "קפה, מאפה; וגם \\ סלאש", "lang": "he"},
                   "orgLine": {"text": "רשת אקמה בע״מ", "lang": "he"}, "role": None},
        "contact": {"phone": {"e164": "+97231234567"}, "whatsapp": {"e164": "+97231234567"}, "email": "a@acme.example",
                    "website": "https://acme.example/a,b;c", "address": {"text": "הרצל 1, תל אביב", "lang": "he"}},
        "sections": [{"kind": "about", "text": {"text": "שורה ראשונה\nשורה שנייה ארוכה " + "מאוד " * 30, "lang": "he"}}],
        "publicUrl": "https://dash.example/c/acme",
    }
    vcf = svc.build_vcard(model)
    raw = vcf.encode("utf-8")
    assert raw.decode("utf-8") == vcf  # valid UTF-8 end to end
    assert vcf.startswith("BEGIN:VCARD\r\nVERSION:3.0\r\n") and vcf.endswith("END:VCARD\r\n")
    assert "\n" not in vcf.replace("\r\n", "")  # CRLF only
    for line in vcf.split("\r\n"):
        assert len(line.encode("utf-8")) <= 75, line  # folded by octets, never mid-character
    flat = _unfold(vcf)
    assert "FN;CHARSET=UTF-8:קפה\\, מאפה\\; וגם \\\\ סלאש" in flat
    assert "ORG;CHARSET=UTF-8:רשת אקמה בע״מ;קפה\\, מאפה\\; וגם \\\\ סלאש" in flat
    assert "ADR;CHARSET=UTF-8;TYPE=WORK:;;הרצל 1\\, תל אביב;;;;" in flat
    assert "NOTE;CHARSET=UTF-8:שורה ראשונה\\nשורה שנייה ארוכה" in flat
    assert "URL:https://acme.example/a\\,b\\;c" in flat
    assert flat.count("TEL") == 1  # the WhatsApp number is the same phone
    assert "X-ABShowAs:COMPANY" in flat
    ascii_name, utf8_name = svc.vcard_filename(model)
    assert ascii_name == "acme.vcf" and utf8_name.startswith("%D7%A7%D7%A4%D7%94")


def test_the_vcf_route_answers_text_vcard_with_a_utf8_filename(w):
    card = ready_company(w)
    put(w, card, lambda d: local(d, "title", {"he": "קפה אקמה"}))
    publish(w, card)
    resp = B.public_vcard(card["slug"], request(), lang="he", db=w.db)
    assert resp.media_type.startswith("text/vcard")
    assert "filename*=UTF-8''%D7%A7%D7%A4%D7%94" in resp.headers["content-disposition"]
    assert B.public_vcard("no-such-card", request(), lang=None, db=w.db).status_code == 404


# ── Enquiries ─────────────────────────────────────────────────────────────────


def enquiry_card(w):
    card = ready_company(w)

    def m(d):
        d["enquiry"] = {"mode": "internal", "fields": {"name": "required", "phone": "optional", "email": "optional",
                                                       "topic": "off", "message": "required"}, "topics": [], "campaign": "autumn"}
        for s in d["sections"]:
            if s["kind"] == "enquiry":
                s["enabled"] = True

    put(w, card, m)
    publish(w, card)
    return card


def send(w, slug, ip="10.9.9.9", **body):
    payload = {"submissionId": body.pop("submissionId", uuid.uuid4().hex), "name": "רון", "phone": "050-1234567",
               "message": "מבקש הצעת מחיר", "consent": True, "lang": "he", "source": "qr", **body}
    resp = B.public_enquiry(slug, request(ip=ip, method="POST"), body=payload, db=w.db)
    return resp.status_code, json.loads(resp.body)


def test_an_enquiry_is_saved_only_when_stored(w):
    card = enquiry_card(w)
    code, body = send(w, card["slug"])
    assert code == 201 and body == {"status": "saved", "enquiryId": body["enquiryId"], "duplicate": False, "delivery": "internal"}
    row = w.db.get(BusinessCardEnquiry, uuid.UUID(body["enquiryId"]))
    assert row.phone == "+972501234567" and row.source == "qr" and row.campaign == "autumn"
    assert row.consent_privacy_url == "https://acme.example/privacy" and row.ip_hash and row.ip_hash != "10.9.9.9"
    assert row.revision_id is not None
    inbox = B.list_enquiries(current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db, card_id=None, status_filter=None, q=None)
    assert inbox["counts"] == {"new": 1} and inbox["items"][0]["phoneDisplay"] == "050-123-4567"
    out = B.update_enquiry(body["enquiryId"], {"status": "handled"}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert out["status"] == "handled" and out["handledAt"]
    stats = B.card_stats(card["id"], days=30, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert stats["totals"]["enquiry"] == 1


def test_enquiry_validation_is_server_side(w):
    card = enquiry_card(w)
    for body, field in (
        ({"name": ""}, "name"),
        ({"phone": "12"}, "phone"),
        ({"phone": "", "email": "nope"}, "email"),
        ({"phone": "", "email": ""}, "contact"),
        ({"consent": False}, "consent"),
        ({"message": "  "}, "message"),
    ):
        with pytest.raises(HTTPException) as bad:
            send(w, card["slug"], **body)
        assert bad.value.status_code == 422 and field in bad.value.detail["fields"], body
    with pytest.raises(HTTPException) as bot:
        send(w, card["slug"], website="http://spam.example")
    assert bot.value.status_code == 422 and bot.value.detail["code"] == "rejected"
    assert w.db.query(BusinessCardEnquiry).count() == 0


def test_enquiries_are_deduplicated(w):
    card = enquiry_card(w)
    sid = uuid.uuid4().hex
    first = send(w, card["slug"], submissionId=sid)
    again = send(w, card["slug"], submissionId=sid)  # a double tap / a retry after a lost answer
    assert first[0] == 201 and again[0] == 200 and again[1]["duplicate"] is True
    assert again[1]["enquiryId"] == first[1]["enquiryId"]
    same_text = send(w, card["slug"], ip="10.8.8.8", message="  מבקש   הצעת מחיר ")  # same person, same words, new tab
    assert same_text[0] == 200 and same_text[1]["duplicate"] is True
    other = send(w, card["slug"], ip="10.8.8.8", message="שאלה אחרת")
    assert other[0] == 201
    assert w.db.query(BusinessCardEnquiry).count() == 2
    stat = w.db.query(BusinessCardDailyStat).filter(BusinessCardDailyStat.metric == "enquiry").one()
    assert stat.count == 2


def test_enquiries_are_rate_limited_per_ip_and_per_card(w, monkeypatch):
    card = enquiry_card(w)
    for i in range(svc.ENQUIRY_PER_IP_10MIN):
        assert send(w, card["slug"], ip="10.7.7.7", message=f"פנייה {i}")[0] == 201
    with pytest.raises(HTTPException) as limited:
        send(w, card["slug"], ip="10.7.7.7", message="עוד אחת")
    assert limited.value.status_code == 429 and limited.value.detail["code"] == "rate_limited"
    # Another visitor is not affected…
    assert send(w, card["slug"], ip="10.6.6.6", message="אחר")[0] == 201
    # …until the card's own hourly ceiling.
    monkeypatch.setattr(svc, "ENQUIRY_PER_CARD_HOUR", 4)
    with pytest.raises(HTTPException) as card_limit:
        send(w, card["slug"], ip="10.5.5.5", message="עוד")
    assert card_limit.value.status_code == 429
    # The in-process per-IP limit answers 429 before any database work.
    RL._buckets.clear()
    monkeypatch.setattr(svc, "ENQUIRY_PER_CARD_HOUR", 1000)
    for _ in range(10):
        try:
            send(w, card["slug"], ip="10.4.4.4", message=uuid.uuid4().hex)
        except HTTPException:
            pass
    with pytest.raises(HTTPException) as burst:
        send(w, card["slug"], ip="10.4.4.4", message="x")
    assert burst.value.status_code == 429


def test_no_form_no_enquiry(w):
    card = ready_company(w)
    publish(w, card)
    with pytest.raises(HTTPException) as off:
        send(w, card["slug"])
    assert off.value.status_code == 409


# ── Counters ──────────────────────────────────────────────────────────────────


def test_counters_are_first_party_and_ignore_bots(w):
    card = ready_company(w)
    publish(w, card)
    slug = card["slug"]
    B.public_event(slug, request(method="POST"), body={"type": "view"}, db=w.db)
    B.public_event(slug, request(method="POST"), body={"type": "action", "action": "call"}, db=w.db)
    B.public_event(slug, request(method="POST"), body={"type": "share"}, db=w.db)
    B.public_event(slug, request(method="POST", ua="WhatsApp/2.23 A"), body={"type": "view"}, db=w.db)
    with pytest.raises(HTTPException):
        B.public_event(slug, request(method="POST"), body={"type": "action", "action": "teleport"}, db=w.db)
    stats = B.card_stats(card["id"], days=7, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert stats["totals"]["view"] == 1 and stats["actions"] == {"call": 1} and stats["totals"]["share"] == 1
    assert stats["method"] == "first_party_cookieless"


def test_the_public_page_is_cacheable_per_revision(w):
    card = ready_company(w)
    publish(w, card)
    first = B.public_card(card["slug"], request(), lang="he", db=w.db)
    etag = first.headers["etag"]
    assert "public" in first.headers["cache-control"]
    put(w, card, lambda d: local(d, "role", {"he": "חדש"}))
    publish(w, card)
    second = B.public_card(card["slug"], request(), lang="he", db=w.db)
    assert second.headers["etag"] != etag
    missing = B.public_card("nope-nope", request(), lang=None, db=w.db)
    assert missing.status_code == 404 and missing.headers["cache-control"] == "no-store"


def test_duplicate_and_the_audit_trail(w):
    card = ready_company(w)
    publish(w, card)
    copy = B.duplicate_card(card["id"], {}, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert copy["status"] == "draft" and copy["slug"] != card["slug"] and copy["name"].endswith("(עותק)")
    actions = [e["action"] for e in B.card_audit(card["id"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)]
    assert actions[:2] == ["publish", "create"] or "publish" in actions


def test_the_migration_is_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = Path(__file__).absolute().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    heads = script.get_heads()
    assert len(heads) == 1
    # No longer the head itself since the digital foundations (701a25694d3c…) were chained on.
    assert "4b6d1b7b3549" in {r.revision for r in script.walk_revisions("base", heads[0])}
    # Re-chained at the integration (10.10.2026): written on b8e2d4f6a1c3, now the last of the release's chain.
    assert script.get_revision("4b6d1b7b3549").down_revision == "9b4e2f7a1c58"
