"""
The card resolver (app/services/business_card_resolve.py) against the golden fixture that the
dashboard's TypeScript twin (client/src/lib/businessCards.ts) is tested against too — so the
editor's live preview and the public page cannot drift apart.

Regenerate after a deliberate change to the rules (then run the client's `npm test`):

    UPDATE_BUSINESS_CARD_GOLDEN=1 pytest tests/test_business_card_resolve.py
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path

import pytest

import app.models  # noqa: F401 - every model before the services that import some
from app.services import business_card_resolve as R

FIXTURE = Path(__file__).parent / "fixtures" / "business_cards" / "resolve_golden.json"
TODAY = "2026-10-11"
LOGO = "https://res.cloudinary.com/demo/image/upload/pos/t/branding/logo.png"
COVER = "http://localhost:8001/media/pos/t/cards/cover.jpg"
PDF = "http://localhost:8001/media/pos/t/cards/menu.pdf"


def _field(value, mode="local", visibility="public"):
    return {"mode": mode, "visibility": visibility, "value": value}


def company_doc():
    doc = R.default_doc("company", "cover")
    doc["languages"] = ["he", "en"]
    f = doc["fields"]
    f["title"] = _field({"he": "קפה רויאל", "en": "Royal Cafe"})
    f["description"] = _field({"he": "קפה, מאפים וארוחות בוקר; גם במשלוח, גם בישיבה.", "en": "Coffee, pastries\nand breakfast"})
    f["cover"] = _field({"url": COVER, "alt": {"he": "חזית בית הקפה"}})
    f["phone"] = _field("03-123-4567")
    f["whatsapp"] = _field("+972 050 123 4567")
    f["email"] = _field(" hello@royal.example ")
    f["website"] = _field("https://royal.example/he?ref=card#top")
    f["hours"] = _field({"rows": [{"days": [4, 0, 1, 2, 3, 3, True, 9], "open": "08:00", "close": "22:00"},
                                  {"days": [5], "open": "08:00", "close": "14:30"},
                                  {"days": [6], "open": "25:00", "close": "26:00"}],
                         "note": {"he": "סגור בחגים"}})
    f["services"] = _field([{"title": {"he": "קייטרינג", "en": "Catering"}, "description": {"he": "לאירועים עד 200 איש"}},
                            {"title": {"he": "  "}}, {"title": {"he": "סדנאות קפה"}}])
    f["social"] = _field([{"platform": "instagram", "url": "https://www.instagram.com/royal"},
                          {"platform": "facebook", "url": "https://evil.example/royal"},
                          {"platform": "tiktok", "url": "javascript:alert(1)"},
                          {"platform": "other", "url": "https://linktr.ee/royal"}])
    f["files"] = _field([{"title": {"he": "תפריט מודפס"}, "url": PDF, "bytes": 120400},
                         {"title": {"he": "קובץ חשוד"}, "url": "ftp://x.example/a.pdf"}])
    f["announcement"] = _field({"title": {"he": "שעות חג"}, "body": {"he": "נפתח ב-10:00 בחול המועד"}, "until": "2026-10-20"})
    f["ctaText"] = _field({"he": "דברו איתנו", "en": "Talk to us"})
    f["accessibilityUrl"] = _field("https://royal.example/accessibility")
    doc["actions"].append({"id": "insta", "type": "link", "enabled": True, "style": "secondary",
                           "url": "https://instagram.com/royal", "platform": "instagram"})
    doc["actions"].append({"id": "menu_pdf", "type": "file", "enabled": True, "style": "secondary", "fileUrl": PDF})
    doc["actions"].append({"id": "bad_link", "type": "link", "enabled": True, "style": "secondary",
                           "url": "http://insecure.example", "platform": "other"})
    for a in doc["actions"]:
        if a["id"] == "whatsapp":
            a["message"] = {"he": "שלום, הגעתי מהכרטיס & רוצה פרטים"}
        if a["id"] == "navigate":
            a["navProvider"] = "waze"
        if a["id"] == "enquiry":
            a["enabled"] = True
    for s in doc["sections"]:
        if s["kind"] == "enquiry":
            s["enabled"] = True
    doc["enquiry"] = {"mode": "internal", "fields": {"name": "required", "phone": "optional", "email": "optional",
                                                     "topic": "required", "message": "optional"},
                      "topics": [{"he": "אירוע", "en": "Event"}, {"he": "משלוח"}], "intro": {"he": "נחזור אליכם תוך יום"},
                      "campaign": "autumn-2026"}
    return doc


def company_org():
    return {"title": "קפה רויאל בע״מ", "address": "הרצל 1, תל אביב", "logoUrl": LOGO,
            "privacyUrl": "https://royal.example/privacy",
            "sources": {"title": "org:company", "address": "org:company", "logoUrl": "org:brand", "privacyUrl": "org:club"}}


def branch_doc():
    doc = R.default_doc("branch", "location", has_parent=True)
    f = doc["fields"]
    f["phone"] = _field("09-765-4321")
    f["website"] = _field(None, mode="hidden")
    f["email"] = _field(None, mode="inherit", visibility="private")
    f["navigation"] = _field("32.1663, 34.8436")
    for a in doc["actions"]:
        if a["id"] in ("digital_menu", "order_online"):
            a["enabled"] = True
    return doc


def branch_org():
    return {"title": "סניף הרצליה", "orgLine": "קפה רויאל", "address": "סוקולוב 5, הרצליה",
            "sources": {"title": "org:shop", "orgLine": "org:company", "address": "org:shop"}}


def cases():
    company = {"meta": {"id": "c-company", "slug": "royal", "type": "company", "name": "Royal"},
               "doc": company_doc(), "org": company_org()}
    branch = {"meta": {"id": "c-branch", "slug": "royal-herzliya", "type": "branch", "name": "Herzliya"},
              "doc": branch_doc(), "org": branch_org()}
    out = []
    out.append({"name": "company_he", "input": {"card": company, "parents": [], "destinations": {}, "lang": "he", "today": TODAY}})
    out.append({"name": "company_en_fallback", "input": {"card": company, "parents": [], "destinations": {}, "lang": "en", "today": TODAY}})
    out.append({"name": "company_unknown_lang", "input": {"card": company, "parents": [], "destinations": {}, "lang": "fr", "today": "2026-10-21"}})
    out.append({"name": "branch_inherits", "input": {
        "card": branch, "parents": [company],
        "destinations": {"digital_menu": {"url": "https://menu.example/royal-herzliya", "label": {"he": "תפריט הסניף"}},
                         "order_online": {"url": "javascript:alert(1)"}},
        "lang": "he", "today": TODAY}})
    point_doc = R.default_doc("point", "minimal", has_parent=True)
    point_doc["fields"]["description"] = _field(None, mode="hidden")
    point = {"meta": {"id": "c-point", "slug": "royal-bar", "type": "point", "name": "Bar"}, "doc": point_doc,
             "org": {"title": "הבר", "orgLine": "סניף הרצליה · קפה רויאל", "address": "סוקולוב 5, הרצליה",
                     "sources": {"title": "org:area", "orgLine": "org:shop", "address": "org:shop"}}}
    unpublished_branch = {"meta": branch["meta"], "doc": {}, "org": branch_org()}
    out.append({"name": "point_through_unpublished_branch", "input": {
        "card": point, "parents": [company, unpublished_branch], "destinations": {}, "lang": "he", "today": TODAY}})
    personal_doc = R.default_doc("personal", "portrait", has_parent=True)
    pf = personal_doc["fields"]
    pf["title"] = _field({"he": "דנה כהן"})
    pf["role"] = _field({"he": "מנהלת אירועים", "en": "Events manager"})
    pf["phone"] = _field("050-111-2222", visibility="private")
    pf["whatsapp"] = _field("0507654321", visibility="public")
    pf["email"] = _field("dana@royal.example", visibility="public")
    personal = {"meta": {"id": "c-dana", "slug": "dana", "type": "personal", "name": "Dana"}, "doc": personal_doc,
                "org": {"orgLine": "קפה רויאל · סניף הרצליה", "address": "סוקולוב 5, הרצליה", "logoUrl": LOGO,
                        "phone": "09-555-0000", "email": "branch@royal.example",
                        "sources": {"orgLine": "org:shop", "address": "org:shop", "logoUrl": "org:brand", "phone": "org:shop"}}}
    out.append({"name": "personal_private_fields", "input": {
        "card": personal, "parents": [company], "destinations": {}, "lang": "he", "today": TODAY}})
    lone = R.default_doc("branch", "location")
    out.append({"name": "branch_org_public_profile", "input": {
        "card": {"meta": {"id": "c-lone", "slug": "lone", "type": "branch", "name": "Lone"}, "doc": lone,
                 "org": {"title": "סניף עצמאי", "address": "החרש 3, חולון", "phone": "03-5551234", "whatsapp": "+972 52-555-1234",
                         "email": " branch@royal.example ", "website": "https://royal.example/holon",
                         "accessibilityUrl": "https://royal.example/a11y", "privacyUrl": "http://insecure.example/privacy",
                         "sources": {"title": "org:shop", "address": "org:shop", "phone": "org:shop", "whatsapp": "org:shop",
                                     "email": "org:shop", "website": "org:company", "accessibilityUrl": "org:company"}}},
        "parents": [], "destinations": {}, "lang": "he", "today": TODAY}})
    bad = R.default_doc("company", "dark")
    bf = bad["fields"]
    bf["title"] = _field({"he": "   "})
    bf["phone"] = _field("12345")
    bf["email"] = _field("not-an-email")
    bf["website"] = _field("http://plain.example")
    bf["avatar"] = _field({"url": "data:image/png;base64,AAAA"})
    bf["event"] = _field({"title": {"he": "השקה"}, "startsAt": "2026-09-01T19:30", "expiresAt": "2026-09-02"})
    bf["offer"] = _field({"title": {"he": "1+1"}, "validUntil": "2026-12-31"})
    bad["design"]["palette"] = {"primary": "#FAFAFA", "accent": "nope", "background": "#ffffff", "surface": "#fefefe",
                                "text": "#999999", "muted": "#cccccc"}
    bad["design"]["buttons"]["columns"] = 7
    bad["expiresAt"] = "2026-10-01"
    bad["design"]["cover"]["focusX"] = 12.5
    bad["design"]["motion"] = {"mode": "wild", "durationMs": 99999}
    for s in bad["sections"]:
        s["enabled"] = True
    bad["enquiry"] = {"mode": "internal", "fields": {"name": "required", "phone": "off", "email": "off", "topic": "off", "message": "required"}}
    bad["actions"] = [{"id": "x", "type": "call", "enabled": True}, {"id": "x", "type": "email", "enabled": True},
                      {"id": "bad id!", "type": "share", "enabled": True}, {"id": "y", "type": "teleport", "enabled": True},
                      {"id": "ev", "type": "enquiry", "enabled": True}]
    out.append({"name": "invalid_values", "input": {
        "card": {"meta": {"id": "c-bad", "slug": "bad", "type": "company", "name": "Bad"}, "doc": bad, "org": {}},
        "parents": [], "destinations": {}, "lang": "he", "today": TODAY}})
    return out


def expected(case):
    inp = copy.deepcopy(case["input"])
    result = R.resolve_card(inp)
    return {**result, "issues": R.card_issues(inp, result)}


def _roundtrip(value):
    return json.loads(json.dumps(value, ensure_ascii=False))


def test_golden_fixture_matches_the_resolver():
    built = [{"name": c["name"], "input": c["input"], "expected": expected(c)} for c in cases()]
    if os.environ.get("UPDATE_BUSINESS_CARD_GOLDEN"):
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps(built, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    stored = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert [c["name"] for c in stored] == [c["name"] for c in built]
    for s, b in zip(stored, built):
        assert s["input"] == _roundtrip(b["input"]), s["name"]
        assert s["expected"] == _roundtrip(b["expected"]), s["name"]


@pytest.mark.parametrize("case", cases(), ids=lambda c: c["name"])
def test_private_values_never_reach_the_public_model(case):
    result = R.resolve_card(copy.deepcopy(case["input"]))
    text = json.dumps(result["model"], ensure_ascii=False)
    for key, f in result["fields"].items():
        if f["visibility"] == "private" and f["value"] is not None:
            needle = f["value"] if isinstance(f["value"], str) else json.dumps(f["value"], ensure_ascii=False)
            assert needle not in text, (case["name"], key)


def test_the_cases_cover_what_matters():
    by = {c["name"]: expected(c) for c in cases()}
    he = by["company_he"]["model"]
    # Hebrew card, waze with an encoded query, wa.me with the prefilled text encoded like encodeURIComponent.
    assert he["dir"] == "rtl" and he["header"]["title"] == {"text": "קפה רויאל", "lang": "he"}
    hrefs = {a["id"]: a["href"] for a in he["actions"]}
    assert hrefs["call"] == "tel:+97231234567"
    assert hrefs["whatsapp"].startswith("https://wa.me/972501234567?text=%D7%A9%D7%9C%D7%95%D7%9D")
    assert "%26" in hrefs["whatsapp"]
    assert hrefs["navigate"].startswith("https://waze.com/ul?q=")
    assert hrefs["email"] == "mailto:hello@royal.example"
    assert "bad_link" not in hrefs
    social = next(s for s in he["sections"] if s["kind"] == "social")
    assert [link["platform"] for link in social["links"]] == ["instagram", "other"]
    hours = next(s for s in he["sections"] if s["kind"] == "hours")
    assert hours["rows"][0]["days"] == [0, 1, 2, 3, 4]  # dedupe + sort, no bools, no 9
    assert len(hours["rows"]) == 2  # 25:00 is not a time
    en = by["company_en_fallback"]["model"]
    assert en["dir"] == "ltr" and en["header"]["title"] == {"text": "Royal Cafe", "lang": "en"}
    hours_en = next(s for s in en["sections"] if s["kind"] == "hours")
    assert hours_en["note"] == {"text": "סגור בחגים", "lang": "he"}  # controlled fallback, tagged Hebrew
    later = by["company_unknown_lang"]["model"]
    assert later["lang"] == "he" and not any(s["kind"] == "announcement" for s in later["sections"])
    branch = by["branch_inherits"]
    assert branch["fields"]["description"]["source"] == "card:c-company"
    assert branch["fields"]["avatar"]["source"] == "org:brand"
    assert branch["fields"]["title"]["source"] == "org:shop"
    assert branch["fields"]["email"]["isPublic"] is False and branch["model"]["contact"]["email"] is None
    assert branch["fields"]["website"]["source"] == "hidden"
    assert branch["brandSource"] == "card:c-company"
    acts = {a["type"]: a for a in branch["model"]["actions"]}
    assert acts["digital_menu"]["href"] == "https://menu.example/royal-herzliya"
    assert acts["digital_menu"]["label"]["text"] == "תפריט הסניף"
    assert "order_online" not in acts
    assert {"id": "order_online", "type": "order_online", "reason": "menu_unavailable"} in branch["unavailableActions"]
    point = by["point_through_unpublished_branch"]
    assert point["fields"]["phone"]["source"] == "card:c-company"  # the unpublished branch passes it through
    assert point["fields"]["description"]["source"] == "hidden"
    dana = by["personal_private_fields"]
    assert dana["model"]["contact"]["phone"] is None and dana["model"]["contact"]["whatsapp"]["e164"] == "+972507654321"
    assert dana["fields"]["email"]["source"] == "local"
    assert dana["fields"]["accessibilityUrl"]["source"] == "card:c-company"
    lone = by["branch_org_public_profile"]
    assert lone["fields"]["phone"] == {"value": "+97235551234", "source": "org:shop", "mode": "inherit", "visibility": "public", "isPublic": True}
    assert lone["fields"]["email"]["value"] == "branch@royal.example"
    assert lone["fields"]["website"]["source"] == "org:company"
    assert lone["fields"]["privacyUrl"]["isPublic"] is False  # an http:// policy is not a usable link
    assert "privacy_required" in {i["code"] for i in lone["issues"]}
    # A person never inherits the branch's phone or email (their own, or nothing).
    assert dana["fields"]["email"]["source"] == "local" and dana["fields"]["whatsapp"]["source"] == "local"
    codes = {i["code"] for i in by["invalid_values"]["issues"]}
    assert {"title_required", "invalid_phone", "invalid_email", "invalid_url", "invalid_image", "accessibility_required",
            "privacy_required", "enquiry_contact_field", "contrast_text", "contrast_muted", "contrast_primary",
            "event_expired", "card_expired"} <= codes
    assert not any(s["kind"] == "event" for s in by["invalid_values"]["model"]["sections"])
    assert [a["id"] for a in by["invalid_values"]["model"]["actions"]] == []


def test_slugs():
    assert R.is_valid_slug("royal-cafe")
    for bad in ("ab", "Royal", "-royal", "royal-", "ro--yal", "קפה", "admin", "a" * 61, "royal\n"):
        assert not R.is_valid_slug(bad), bad


def test_urls_are_https_only():
    assert R.is_safe_url("https://royal.example/a?b=c#d")
    for bad in ("http://royal.example", "javascript:alert(1)", "https://user:pw@royal.example", "https://royal",
                "https://royal.example/a b", "https://royal.example/\"onload", "data:text/html,x", "https://royal.example\n"):
        assert not R.is_safe_url(bad), bad
    assert R.is_safe_media_url("http://localhost:8001/media/pos/x.png")
    assert not R.is_safe_media_url("http://evil.example/media/x.png")
    assert R.is_platform_url("instagram", "https://www.instagram.com/x")
    assert not R.is_platform_url("instagram", "https://instagram.com.evil.example/x")
