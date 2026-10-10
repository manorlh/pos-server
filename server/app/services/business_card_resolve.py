"""
"כרטיסי ביקור דיגיטליים" (spec §25–28) — the one resolver that turns a card document into what
a visitor sees.

The dashboard's live preview runs the same computation in TypeScript
(client/src/lib/businessCards.ts `resolveCard`) on the unsaved draft; the public page `/c/<slug>`
gets this one's answer for the published revision. Both are pinned by one golden fixture
(tests/fixtures/business_cards/resolve_golden.json, read by both test suites), so the preview
cannot drift from the public page. Change both together.

Rules:
* Every field is explicitly public or private; a private value never reaches the public model,
  the VCF, or a child card that inherits from this one.
* Every field is inherit / local / hidden. A blank local value is blank, never "hidden".
* Inheritance reads the parent card's *published* public values, then the organisation's own
  records. Each effective value says where it came from.
* Actions are fixed, validated types; URLs are https only (media from this system's own store
  may be http://localhost in development). No markup is taken from the document.
"""
from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

CARD_LANGS = ("he", "en")
CARD_TYPES = ("company", "branch", "point", "personal")
CARD_TEMPLATES = ("minimal", "cover", "dark", "portrait", "location", "services", "event", "links")
CARD_STATUSES = ("draft", "saved", "published", "paused", "archived")
FIELD_MODES = ("inherit", "local", "hidden")
FIELD_VISIBILITIES = ("public", "private")

FIELD_KEYS = (
    "title", "role", "orgLine", "description", "avatar", "cover", "phone", "whatsapp", "email",
    "website", "address", "navigation", "hours", "services", "social", "files", "announcement",
    "ctaText", "event", "offer", "support", "accessibilityUrl", "privacyUrl",
)

# kind, max, inherit (nearest first), personal local only, personal private by default
FIELD_SPECS: Dict[str, Dict[str, Any]] = {
    "title": {"kind": "text", "max": 120, "inherit": ("org",)},
    "role": {"kind": "text", "max": 120, "inherit": ()},
    "orgLine": {"kind": "text", "max": 160, "inherit": ("org",)},
    "description": {"kind": "text", "max": 600, "inherit": ("parent",)},
    "avatar": {"kind": "image", "inherit": ("parent", "org")},
    "cover": {"kind": "image", "inherit": ("parent",)},
    "phone": {"kind": "phone", "inherit": ("parent", "org"), "personalLocalOnly": True, "personalPrivate": True},
    "whatsapp": {"kind": "phone", "inherit": ("parent", "org"), "personalLocalOnly": True, "personalPrivate": True},
    "email": {"kind": "email", "inherit": ("parent", "org"), "personalLocalOnly": True, "personalPrivate": True},
    "website": {"kind": "url", "inherit": ("parent", "org")},
    "address": {"kind": "text", "max": 200, "inherit": ("org", "parent"), "personalPrivate": True},
    "navigation": {"kind": "navigation", "max": 200, "inherit": ("parent",), "personalPrivate": True},
    "hours": {"kind": "hours", "inherit": ("parent",)},
    "services": {"kind": "services", "inherit": ("parent",)},
    "social": {"kind": "social", "inherit": ("parent",)},
    "files": {"kind": "files", "inherit": ("parent",)},
    "announcement": {"kind": "announcement", "inherit": ("parent",), "personalLocalOnly": True},
    "ctaText": {"kind": "text", "max": 80, "inherit": ()},
    "event": {"kind": "event", "inherit": ()},
    "offer": {"kind": "offer", "inherit": ()},
    "support": {"kind": "support", "inherit": ("parent",)},
    "accessibilityUrl": {"kind": "url", "inherit": ("parent", "org")},
    "privacyUrl": {"kind": "url", "inherit": ("parent", "org")},
}

SECTION_KINDS = (
    "actions", "announcement", "about", "event", "offer", "services", "hours", "location",
    "social", "files", "support", "enquiry",
)
ACTION_TYPES = (
    "call", "whatsapp", "email", "navigate", "save_contact", "share", "digital_menu",
    "order_online", "website", "link", "file", "enquiry",
)
SOCIAL_PLATFORMS = ("instagram", "facebook", "tiktok", "linkedin", "youtube", "x", "telegram", "other")
SOCIAL_HOSTS: Dict[str, Tuple[str, ...]] = {
    "instagram": ("instagram.com",),
    "facebook": ("facebook.com", "fb.com", "fb.me"),
    "tiktok": ("tiktok.com",),
    "linkedin": ("linkedin.com",),
    "youtube": ("youtube.com", "youtu.be"),
    "x": ("x.com", "twitter.com"),
    "telegram": ("t.me", "telegram.me"),
    "other": (),
}
ENQUIRY_FIELD_KEYS = ("name", "phone", "email", "topic", "message")
ENQUIRY_REQUIREMENTS = ("required", "optional", "off")
CARD_FONTS = ("heebo", "rubik", "assistant", "frank", "system")

_DEFAULT_ORDER = list(SECTION_KINDS)


def _preset(palette, font, spacing, radius, background, cover, avatar, buttons, sections=None):
    keys = ("primary", "accent", "background", "surface", "text", "muted")
    return {
        "palette": dict(zip(keys, palette)),
        "font": font,
        "spacing": spacing,
        "radius": radius,
        "background": background,
        "cover": {"height": cover[0], "fit": "cover", "focusX": 50, "focusY": 50, "overlay": cover[1]},
        "avatar": {"shape": avatar[0], "position": avatar[1], "size": avatar[2]},
        "buttons": {"style": buttons[0], "columns": buttons[1], "content": "icon_text"},
        "sections": list(sections or _DEFAULT_ORDER),
    }


TEMPLATE_PRESETS: Dict[str, Dict[str, Any]] = {
    "minimal": _preset(("#1f2937", "#2563eb", "#ffffff", "#f8fafc", "#0f172a", "#475569"), "heebo", "compact", "md",
                       "solid", ("none", 0), ("rounded", "start", "md"), ("outline", 1)),
    "cover": _preset(("#1d4ed8", "#0ea5e9", "#f1f5f9", "#ffffff", "#0f172a", "#475569"), "heebo", "normal", "lg",
                     "solid", ("lg", 0), ("circle", "overlap", "lg"), ("soft", 2)),
    "dark": _preset(("#f59e0b", "#22d3ee", "#0b1120", "#111827", "#f8fafc", "#cbd5e1"), "rubik", "normal", "lg",
                    "gradient", ("md", 40), ("circle", "overlap", "md"), ("filled", 2)),
    "portrait": _preset(("#6d28d9", "#db2777", "#faf5ff", "#ffffff", "#1e1b4b", "#4b5563"), "assistant", "airy", "xl",
                        "gradient", ("none", 0), ("circle", "center", "lg"), ("pill", 2)),
    "location": _preset(("#047857", "#b45309", "#f0fdf4", "#ffffff", "#052e16", "#374151"), "heebo", "normal", "md",
                        "solid", ("md", 0), ("rounded", "start", "md"), ("filled", 2),
                        ["actions", "location", "hours", "announcement", "about", "event", "offer", "services",
                         "social", "files", "support", "enquiry"]),
    "services": _preset(("#0f766e", "#4f46e5", "#f8fafc", "#ffffff", "#0f172a", "#475569"), "rubik", "normal", "lg",
                        "solid", ("sm", 0), ("rounded", "center", "md"), ("soft", 2),
                        ["about", "services", "offer", "actions", "enquiry", "announcement", "event", "hours",
                         "location", "social", "files", "support"]),
    "event": _preset(("#be123c", "#c2410c", "#fff7ed", "#ffffff", "#1c1917", "#57534e"), "rubik", "normal", "md",
                     "solid", ("lg", 30), ("rounded", "start", "sm"), ("filled", 1),
                     ["event", "actions", "announcement", "location", "about", "offer", "services", "hours",
                      "social", "files", "support", "enquiry"]),
    "links": _preset(("#111827", "#be185d", "#fdf2f8", "#ffffff", "#111827", "#4b5563"), "heebo", "normal", "xl",
                     "gradient", ("none", 0), ("circle", "center", "md"), ("pill", 1),
                     ["actions", "social", "files", "about", "announcement", "event", "offer", "services", "hours",
                      "location", "support", "enquiry"]),
}

_OFF_BY_DEFAULT = ("event", "offer", "support", "enquiry")

ACTION_LABELS: Dict[str, Dict[str, str]] = {
    "call": {"he": "חיוג", "en": "Call"},
    "whatsapp": {"he": "וואטסאפ", "en": "WhatsApp"},
    "email": {"he": "אימייל", "en": "Email"},
    "navigate": {"he": "ניווט", "en": "Directions"},
    "save_contact": {"he": "שמירת איש קשר", "en": "Save contact"},
    "share": {"he": "שיתוף", "en": "Share"},
    "digital_menu": {"he": "לתפריט", "en": "View menu"},
    "order_online": {"he": "הזמנה אונליין", "en": "Order online"},
    "website": {"he": "לאתר", "en": "Website"},
    "link": {"he": "קישור", "en": "Link"},
    "file": {"he": "הורדת קובץ", "en": "Download"},
    "enquiry": {"he": "השאירו פרטים", "en": "Get in touch"},
}
PLATFORM_LABELS: Dict[str, Dict[str, str]] = {
    "instagram": {"he": "אינסטגרם", "en": "Instagram"},
    "facebook": {"he": "פייסבוק", "en": "Facebook"},
    "tiktok": {"he": "טיקטוק", "en": "TikTok"},
    "linkedin": {"he": "לינקדאין", "en": "LinkedIn"},
    "youtube": {"he": "יוטיוב", "en": "YouTube"},
    "x": {"he": "X", "en": "X"},
    "telegram": {"he": "טלגרם", "en": "Telegram"},
    "other": {"he": "קישור", "en": "Link"},
}


# ── Defaults ──────────────────────────────────────────────────────────────────


def _default_actions(card_type: str) -> List[Dict[str, Any]]:
    def a(id_: str, type_: str, enabled: bool, style: str = "secondary") -> Dict[str, Any]:
        out = {"id": id_, "type": type_, "enabled": enabled, "style": style}
        if type_ == "navigate":
            out["navProvider"] = "google"
        return out

    if card_type == "personal":
        return [
            a("call", "call", True, "primary"), a("whatsapp", "whatsapp", True), a("email", "email", True),
            a("save_contact", "save_contact", True, "primary"), a("website", "website", True),
            a("share", "share", True), a("navigate", "navigate", False), a("enquiry", "enquiry", False),
        ]
    return [
        a("call", "call", True, "primary"), a("whatsapp", "whatsapp", True), a("navigate", "navigate", True),
        a("digital_menu", "digital_menu", False), a("order_online", "order_online", False),
        a("website", "website", True), a("email", "email", True), a("save_contact", "save_contact", True),
        a("share", "share", True), a("enquiry", "enquiry", False),
    ]


def design_from_template(template: str, base: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    p = TEMPLATE_PRESETS[template]
    base = base or {}
    motion = base.get("motion") if isinstance(base.get("motion"), dict) else None
    return {
        "brandMode": base.get("brandMode", "local"),
        "palette": dict(p["palette"]),
        "font": p["font"],
        "textScale": base.get("textScale", "md"),
        "spacing": p["spacing"],
        "radius": p["radius"],
        "background": p["background"],
        "cover": dict(p["cover"]),
        "avatar": dict(p["avatar"]),
        "buttons": dict(p["buttons"]),
        "motion": dict(motion) if motion else {"mode": "subtle", "durationMs": 450},
    }


def default_field(key: str, card_type: str) -> Dict[str, Any]:
    spec = FIELD_SPECS[key]
    private = card_type == "personal" and spec.get("personalPrivate")
    return {"mode": "inherit", "visibility": "private" if private else "public", "value": None}


def default_doc(card_type: str, template: str, has_parent: bool = False) -> Dict[str, Any]:
    preset = TEMPLATE_PRESETS[template]
    design = design_from_template(template)
    design["brandMode"] = "inherit" if has_parent else "local"
    return {
        "schema": 1,
        "languages": ["he"],
        "template": template,
        "fields": {key: default_field(key, card_type) for key in FIELD_KEYS},
        "sections": [{"kind": k, "enabled": k not in _OFF_BY_DEFAULT} for k in preset["sections"]],
        "actions": _default_actions(card_type),
        "design": design,
        "enquiry": {
            "mode": "disabled",
            "fields": {"name": "required", "phone": "required", "email": "optional", "topic": "off", "message": "optional"},
            "topics": [],
        },
        "seo": {"indexable": card_type != "personal"},
    }


# ── Validation helpers (the client's, rule for rule) ──────────────────────────

_HTTPS_URL = re.compile(
    r"^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(:[0-9]{1,5})?(/[^\s<>\"'`\\]*)?$", re.IGNORECASE
)
_DEV_MEDIA_URL = re.compile(r"^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?/media/[^\s<>\"'`\\]+$", re.IGNORECASE)
_EMAIL = re.compile(r"^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$")
_HHMM = re.compile(r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
_YMD = re.compile(r"^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$")
_YMDHM = re.compile(r"^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]$")
_HEX = re.compile(r"^#[0-9a-f]{6}$", re.IGNORECASE)
_HEBREW = re.compile(r"[\u0590-\u05ff]")
_COORDS = re.compile(r"^(-?[0-9]{1,2}(\.[0-9]+)?),\s*(-?[0-9]{1,3}(\.[0-9]+)?)$")
_ACTION_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
MAX_URL = 500


def _full(pattern: "re.Pattern[str]", value: Any) -> bool:
    # fullmatch: Python's `$` also matches before a trailing newline, JavaScript's does not.
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def is_safe_url(value: Any) -> bool:
    return isinstance(value, str) and len(value) <= MAX_URL and _full(_HTTPS_URL, value)


def is_safe_media_url(value: Any) -> bool:
    return isinstance(value, str) and len(value) <= MAX_URL and (_full(_HTTPS_URL, value) or _full(_DEV_MEDIA_URL, value))


def url_host(url: str) -> str:
    m = re.match(r"^https?://([^/:?#]+)", url, re.IGNORECASE)
    return m.group(1).lower() if m else ""


def is_platform_url(platform: str, url: Any) -> bool:
    if not is_safe_url(url):
        return False
    hosts = SOCIAL_HOSTS.get(platform, ())
    if not hosts:
        return True
    host = url_host(url)
    return any(host == h or host.endswith("." + h) for h in hosts)


def is_email(value: Any) -> bool:
    return isinstance(value, str) and len(value) <= 254 and _full(_EMAIL, value)


def is_hhmm(value: Any) -> bool:
    return _full(_HHMM, value)


def is_ymd(value: Any) -> bool:
    return _full(_YMD, value)


def is_ymdhm(value: Any) -> bool:
    return _full(_YMDHM, value)


def is_hex_color(value: Any) -> bool:
    return _full(_HEX, value)


def _js_trim(value: str) -> str:
    return value.strip()


def normalize_phone(raw: Any) -> Optional[str]:
    """The system's E.164 rule (app/services/notifications/phone.py), None instead of raising."""
    from app.services.notifications.phone import PhoneError, normalize_phone as _normalize

    if not isinstance(raw, str):
        return None
    try:
        return _normalize(raw)
    except PhoneError:
        return None


def display_phone(e164: str) -> str:
    if not e164.startswith("+972"):
        return e164
    n = e164[4:]
    if len(n) == 9:
        return f"0{n[:2]}-{n[2:5]}-{n[5:]}"
    if len(n) == 8:
        return f"0{n[:1]}-{n[1:4]}-{n[4:]}"
    return e164


def encode_component(value: str) -> str:
    """JavaScript's encodeURIComponent."""
    return quote(value, safe="-_.!~*'()")


def _channel(hex_: str, i: int) -> float:
    v = int(hex_[1 + i * 2: 3 + i * 2], 16) / 255
    return v / 12.92 if v <= 0.03928 else math.pow((v + 0.055) / 1.055, 2.4)


def luminance(hex_: str) -> float:
    return 0.2126 * _channel(hex_, 0) + 0.7152 * _channel(hex_, 1) + 0.0722 * _channel(hex_, 2)


def contrast_ratio(a: str, b: str) -> float:
    if not is_hex_color(a) or not is_hex_color(b):
        return 1.0
    la, lb = luminance(a), luminance(b)
    ratio = (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    return math.floor(ratio * 100) / 100


def readable_on(bg: str) -> str:
    return "#ffffff" if contrast_ratio("#ffffff", bg) >= contrast_ratio("#111111", bg) else "#111111"


# ── Effective fields ─────────────────────────────────────────────────────────


def _obj(v: Any) -> Optional[Dict[str, Any]]:
    return v if isinstance(v, dict) else None


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def clean_text(v: Any, max_len: int = 600) -> Optional[Dict[str, str]]:
    o = _obj(v)
    if o is None:
        return None
    out: Dict[str, str] = {}
    for lang in CARD_LANGS:
        s = o.get(lang)
        if isinstance(s, str) and _js_trim(s):
            out[lang] = _js_trim(s)[:max_len]
    return out or None


def _clean_str(v: Any, max_len: int) -> Optional[str]:
    return _js_trim(v)[:max_len] if isinstance(v, str) and _js_trim(v) else None


def org_text(value: Optional[str]) -> Optional[Dict[str, str]]:
    if not value or not _js_trim(value):
        return None
    v = _js_trim(value)
    return {"he": v} if _HEBREW.search(v) else {"en": v}


def _trimmed(raw: Any) -> Any:
    return _js_trim(raw) if isinstance(raw, str) else raw


def usable_value(key: str, raw: Any) -> Any:
    spec = FIELD_SPECS[key]
    kind = spec["kind"]
    if kind == "text":
        return clean_text(raw, spec.get("max", 600))
    if kind == "image":
        o = _obj(raw)
        if o is None or not is_safe_media_url(o.get("url")):
            return None
        alt = clean_text(o.get("alt"), 200)
        return {"url": o["url"], "alt": alt} if alt else {"url": o["url"]}
    if kind == "phone":
        return normalize_phone(raw)
    if kind == "email":
        return _trimmed(raw) if is_email(_trimmed(raw)) else None
    if kind == "url":
        return _trimmed(raw) if is_safe_url(_trimmed(raw)) else None
    if kind == "navigation":
        return _clean_str(raw, spec.get("max", 200))
    if kind == "hours":
        o = _obj(raw)
        if o is None or not isinstance(o.get("rows"), list):
            return None
        rows = []
        for r in o["rows"][:14]:
            ro = _obj(r)
            if ro is None or not is_hhmm(ro.get("open")) or not is_hhmm(ro.get("close")) or not isinstance(ro.get("days"), list):
                continue
            days = sorted({d for d in ro["days"] if _is_int(d) and 0 <= d <= 6})
            if days:
                rows.append({"days": days, "open": ro["open"], "close": ro["close"]})
        note = clean_text(o.get("note"), 200)
        if not rows and not note:
            return None
        return {"rows": rows, "note": note} if note else {"rows": rows}
    if kind == "services":
        if not isinstance(raw, list):
            return None
        items = []
        for it in raw[:24]:
            o = _obj(it)
            title = clean_text(o.get("title"), 120) if o is not None else None
            if not title:
                continue
            description = clean_text(o.get("description"), 300)
            items.append({"title": title, "description": description} if description else {"title": title})
        return items or None
    if kind == "social":
        if not isinstance(raw, list):
            return None
        links = []
        for it in raw[:12]:
            o = _obj(it)
            if o is None:
                continue
            platform = o.get("platform") if o.get("platform") in SOCIAL_PLATFORMS else None
            url = _js_trim(o["url"]) if isinstance(o.get("url"), str) else None
            if platform and is_platform_url(platform, url):
                links.append({"platform": platform, "url": url})
        return links or None
    if kind == "files":
        if not isinstance(raw, list):
            return None
        files = []
        for it in raw[:12]:
            o = _obj(it)
            if o is None or not is_safe_media_url(o.get("url")):
                continue
            title = clean_text(o.get("title"), 120)
            if not title:
                continue
            b = o.get("bytes")
            files.append({"title": title, "url": o["url"], "bytes": b if _is_int(b) and b >= 0 else None})
        return files or None
    if kind == "announcement":
        o = _obj(raw)
        if o is None:
            return None
        title, body = clean_text(o.get("title"), 120), clean_text(o.get("body"), 600)
        if not title and not body:
            return None
        return {"title": title, "body": body, "until": o.get("until") if is_ymd(o.get("until")) else None}
    if kind == "event":
        o = _obj(raw)
        if o is None:
            return None
        title, venue = clean_text(o.get("title"), 120), clean_text(o.get("venue"), 200)
        starts = o.get("startsAt") if is_ymdhm(o.get("startsAt")) else None
        if not title and not starts:
            return None
        return {
            "title": title,
            "venue": venue,
            "startsAt": starts,
            "endsAt": o.get("endsAt") if is_ymdhm(o.get("endsAt")) else None,
            "expiresAt": o.get("expiresAt") if is_ymd(o.get("expiresAt")) else None,
        }
    if kind == "offer":
        o = _obj(raw)
        if o is None:
            return None
        title, body = clean_text(o.get("title"), 120), clean_text(o.get("body"), 600)
        if not title and not body:
            return None
        return {"title": title, "body": body, "validUntil": o.get("validUntil") if is_ymd(o.get("validUntil")) else None}
    if kind == "support":
        o = _obj(raw)
        if o is None:
            return None
        phone = normalize_phone(o.get("phone"))
        hours, note = clean_text(o.get("hours"), 200), clean_text(o.get("note"), 300)
        url = _trimmed(o.get("url")) if is_safe_url(_trimmed(o.get("url")) if isinstance(o.get("url"), str) else None) else None
        if not phone and not hours and not note and not url:
            return None
        return {"phone": phone, "hours": hours, "note": note, "url": url}
    return None


def _org_value(key: str, org: Dict[str, Any]) -> Optional[Tuple[Any, str]]:
    src = org.get("sources") or {}
    if key in ("title", "orgLine", "address"):
        v = org_text(org.get(key))
        return (v, src.get(key, "org")) if v else None
    if key == "avatar":
        url = org.get("logoUrl")
        return ({"url": url}, src.get("logoUrl", "org")) if is_safe_media_url(url) else None
    if key == "privacyUrl":
        url = org.get("privacyUrl")
        return (url, src.get("privacyUrl", "org")) if is_safe_url(url) else None
    if key in ("phone", "whatsapp"):
        e164 = normalize_phone(org.get(key))
        return (e164, src.get(key, "org")) if e164 else None
    if key == "email":
        v = _trimmed(org.get("email")) if isinstance(org.get("email"), str) else None
        return (v, src.get("email", "org")) if is_email(v) else None
    if key in ("website", "accessibilityUrl"):
        v = _trimmed(org.get(key)) if isinstance(org.get(key), str) else None
        return (v, src.get(key, "org")) if is_safe_url(v) else None
    return None


def _field_of(doc: Dict[str, Any], key: str, card_type: str) -> Dict[str, Any]:
    fields = doc.get("fields") if isinstance(doc, dict) and isinstance(doc.get("fields"), dict) else {}
    f = _obj(fields.get(key))
    base = default_field(key, card_type)
    if f is None:
        return base
    return {
        "mode": f.get("mode") if f.get("mode") in FIELD_MODES else base["mode"],
        "visibility": f.get("visibility") if f.get("visibility") in FIELD_VISIBILITIES else base["visibility"],
        "value": f.get("value"),
    }


def effective_fields(link: Dict[str, Any], parent_public: Optional[Dict[str, Any]], parent_id: Optional[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    card_type = link["meta"]["type"]
    org = link.get("org") or {}
    for key in FIELD_KEYS:
        spec = FIELD_SPECS[key]
        f = _field_of(link.get("doc") or {}, key, card_type)
        value: Any = None
        source = "none"
        if f["mode"] == "hidden":
            source = "hidden"
        elif f["mode"] == "local":
            value = usable_value(key, f["value"])
            source = "local"
        else:
            sources = () if card_type == "personal" and spec.get("personalLocalOnly") else spec["inherit"]
            for frm in sources:
                if frm == "parent":
                    pf = (parent_public or {}).get(key)
                    if pf and pf["isPublic"]:
                        value = pf["value"]
                        source = pf["source"] if pf["source"].startswith(("card:", "org")) else f"card:{parent_id}"
                        break
                else:
                    ov = _org_value(key, org)
                    if ov:
                        value, source = ov
                        break
        is_public = f["mode"] != "hidden" and f["visibility"] == "public" and value is not None
        out[key] = {"value": value, "source": source, "mode": f["mode"], "visibility": f["visibility"], "isPublic": is_public}
    return out


def _pick(v: Any, allowed, dflt):
    return v if isinstance(v, str) and v in allowed else dflt


def _num(v: Any, lo: int, hi: int, dflt: int) -> int:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return dflt
    return int(min(hi, max(lo, math.floor(v + 0.5))))  # Math.round, not banker's rounding


def clean_design(raw: Any, template: str) -> Dict[str, Any]:
    base = design_from_template(template)
    d = _obj(raw)
    if d is None:
        return base
    pal = _obj(d.get("palette")) or {}
    palette = {}
    for k in ("primary", "accent", "background", "surface", "text", "muted"):
        palette[k] = pal[k].lower() if is_hex_color(pal.get(k)) else base["palette"][k]
    cover = _obj(d.get("cover")) or {}
    avatar = _obj(d.get("avatar")) or {}
    buttons = _obj(d.get("buttons")) or {}
    motion = _obj(d.get("motion")) or {}
    cols = buttons.get("columns")
    cols = cols if _is_int(cols) and cols in (1, 2, 3) else base["buttons"]["columns"]
    return {
        "brandMode": _pick(d.get("brandMode"), ("inherit", "local"), "local"),
        "palette": palette,
        "font": _pick(d.get("font"), CARD_FONTS, base["font"]),
        "textScale": _pick(d.get("textScale"), ("sm", "md", "lg"), "md"),
        "spacing": _pick(d.get("spacing"), ("compact", "normal", "airy"), base["spacing"]),
        "radius": _pick(d.get("radius"), ("none", "sm", "md", "lg", "xl"), base["radius"]),
        "background": _pick(d.get("background"), ("solid", "gradient"), base["background"]),
        "cover": {
            "height": _pick(cover.get("height"), ("none", "sm", "md", "lg"), base["cover"]["height"]),
            "fit": _pick(cover.get("fit"), ("cover", "contain"), base["cover"]["fit"]),
            "focusX": _num(cover.get("focusX"), 0, 100, 50),
            "focusY": _num(cover.get("focusY"), 0, 100, 50),
            "overlay": _num(cover.get("overlay"), 0, 60, base["cover"]["overlay"]),
        },
        "avatar": {
            "shape": _pick(avatar.get("shape"), ("circle", "rounded", "square"), base["avatar"]["shape"]),
            "position": _pick(avatar.get("position"), ("center", "start", "overlap"), base["avatar"]["position"]),
            "size": _pick(avatar.get("size"), ("sm", "md", "lg"), base["avatar"]["size"]),
        },
        "buttons": {
            "style": _pick(buttons.get("style"), ("filled", "outline", "soft", "pill"), base["buttons"]["style"]),
            "columns": cols,
            "content": _pick(buttons.get("content"), ("icon_text", "text", "icon"), base["buttons"]["content"]),
        },
        "motion": {
            "mode": _pick(motion.get("mode"), ("none", "subtle", "lively"), "subtle"),
            "durationMs": _num(motion.get("durationMs"), 0, 1500, 450),
        },
    }


def template_of(doc: Any) -> str:
    t = doc.get("template") if isinstance(doc, dict) else None
    return t if t in CARD_TEMPLATES else "cover"


def languages_of(doc: Any) -> List[str]:
    raw = doc.get("languages") if isinstance(doc, dict) else None
    out: List[str] = []
    for lang in raw if isinstance(raw, list) else []:
        if lang in CARD_LANGS and lang not in out:
            out.append(lang)
    return out or ["he"]


# ── The public model ─────────────────────────────────────────────────────────


def pick_text(lt: Any, lang: str, default_lang: str) -> Optional[Dict[str, str]]:
    o = _obj(lt)
    if o is None:
        return None
    for code in (lang, default_lang, *CARD_LANGS):
        s = o.get(code)
        if isinstance(s, str) and _js_trim(s):
            return {"text": _js_trim(s), "lang": code}
    return None


def _phone_out(e164: Any) -> Optional[Dict[str, str]]:
    return {"e164": e164, "display": display_phone(e164)} if isinstance(e164, str) and e164 else None


def navigation_href(query: str, provider: str) -> str:
    q = _js_trim(query)
    m = _COORDS.fullmatch(q)
    if provider == "waze":
        if m:
            return f"https://waze.com/ul?ll={m.group(1)},{m.group(3)}&navigate=yes"
        return f"https://waze.com/ul?q={encode_component(q)}&navigate=yes"
    return f"https://www.google.com/maps/search/?api=1&query={encode_component(f'{m.group(1)},{m.group(3)}' if m else q)}"


def _expired(until: Any, today: str) -> bool:
    return bool(until) and is_ymd(until) and is_ymd(today) and until < today


def sections_of(doc: Any, template: str) -> List[Dict[str, Any]]:
    seen: set = set()
    out: List[Dict[str, Any]] = []
    raw = doc.get("sections") if isinstance(doc, dict) else None
    for s in raw if isinstance(raw, list) else []:
        o = _obj(s)
        if o is None or o.get("kind") not in SECTION_KINDS or o["kind"] in seen:
            continue
        seen.add(o["kind"])
        out.append({"kind": o["kind"], "enabled": o.get("enabled") is True})
    for kind in TEMPLATE_PRESETS[template]["sections"]:
        if kind not in seen:
            out.append({"kind": kind, "enabled": False})
    return out


def actions_of(doc: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    ids: set = set()
    raw = doc.get("actions") if isinstance(doc, dict) else None
    if not isinstance(raw, list):
        return out
    for a in raw[:24]:
        o = _obj(a)
        if o is None or o.get("type") not in ACTION_TYPES:
            continue
        id_ = o.get("id") if _full(_ACTION_ID, o.get("id")) else None
        if not id_ or id_ in ids:
            continue
        ids.add(id_)
        out.append({
            "id": id_,
            "type": o["type"],
            "enabled": o.get("enabled") is True,
            "label": clean_text(o.get("label"), 40),
            "style": "primary" if o.get("style") == "primary" else "secondary",
            "url": _js_trim(o["url"]) if isinstance(o.get("url"), str) else None,
            "platform": o.get("platform") if o.get("platform") in SOCIAL_PLATFORMS else None,
            "fileUrl": _js_trim(o["fileUrl"]) if isinstance(o.get("fileUrl"), str) else None,
            "message": clean_text(o.get("message"), 300),
            "navProvider": "waze" if o.get("navProvider") == "waze" else "google",
        })
    return out


def enquiry_of(doc: Any) -> Dict[str, Any]:
    e = _obj(doc.get("enquiry") if isinstance(doc, dict) else None) or {}
    f = _obj(e.get("fields")) or {}
    dflt = {"name": "required", "phone": "required", "email": "optional", "topic": "off", "message": "optional"}
    fields = {k: (f.get(k) if f.get(k) in ENQUIRY_REQUIREMENTS else dflt[k]) for k in ENQUIRY_FIELD_KEYS}
    topics_raw = e.get("topics") if isinstance(e.get("topics"), list) else []
    topics = [t for t in (clean_text(x, 80) for x in topics_raw[:12]) if t]
    return {
        "mode": "internal" if e.get("mode") == "internal" else "disabled",
        "fields": fields,
        "topics": topics,
        "intro": clean_text(e.get("intro"), 300),
        "campaign": _clean_str(e.get("campaign"), 60),
    }


def enquiry_usable(cfg: Dict[str, Any]) -> bool:
    return cfg["mode"] == "internal" and (cfg["fields"]["phone"] != "off" or cfg["fields"]["email"] != "off")


def resolve_card(inp: Dict[str, Any]) -> Dict[str, Any]:
    """{model, fields, brandSource, unavailableActions} — see the module doc."""
    parent_fields: Optional[Dict[str, Any]] = None
    parent_id: Optional[str] = None
    parent_brand: Optional[Dict[str, Any]] = None
    for link in inp.get("parents") or []:
        parent_fields = effective_fields(link, parent_fields, parent_id)
        tpl = template_of(link.get("doc"))
        d = clean_design((link.get("doc") or {}).get("design"), tpl)
        if not (d["brandMode"] == "inherit" and parent_brand):
            parent_brand = {"palette": d["palette"], "font": d["font"], "source": f"card:{link['meta']['id']}"}
        parent_id = link["meta"]["id"]

    card = inp["card"]
    doc = card.get("doc") or {}
    fields = effective_fields(card, parent_fields, parent_id)
    template = template_of(doc)
    languages = languages_of(doc)
    default_lang = languages[0]
    lang = inp["lang"] if inp.get("lang") in languages else default_lang
    today = inp.get("today") or ""

    def txt(v: Any):
        return pick_text(v, lang, default_lang)

    def pub(k: str):
        return fields[k]["value"] if fields[k]["isPublic"] else None

    own = clean_design(doc.get("design"), template)
    brand_source = "local"
    design = dict(own)
    design["palette"] = dict(own["palette"])
    if own["brandMode"] == "inherit" and parent_brand:
        design["palette"] = dict(parent_brand["palette"])
        design["font"] = parent_brand["font"]
        brand_source = parent_brand["source"]
    public_design = dict(design)
    public_design["onPrimary"] = readable_on(design["palette"]["primary"])
    public_design["onAccent"] = readable_on(design["palette"]["accent"])

    def image(v: Any):
        o = _obj(v)
        return {"url": o["url"], "alt": txt(o.get("alt"))} if o is not None and isinstance(o.get("url"), str) else None

    title = txt(pub("title"))
    address = txt(pub("address"))
    nav_query = pub("navigation") or (address["text"] if address else None)
    files = pub("files") or []
    enquiry = enquiry_of(doc)
    sections = sections_of(doc, template)
    enquiry_section = next((s for s in sections if s["kind"] == "enquiry"), None)
    enquiry_on = enquiry_usable(enquiry) and bool(enquiry_section and enquiry_section["enabled"])
    privacy_url = pub("privacyUrl")

    actions: List[Dict[str, Any]] = []
    unavailable: List[Dict[str, Any]] = []
    for a in actions_of(doc):
        if not a["enabled"]:
            continue
        href: Optional[str] = None
        reason: Optional[str] = None
        external = False
        label = pick_text(a["label"], lang, default_lang)
        t = a["type"]
        if t == "call":
            p = pub("phone")
            if p:
                href = f"tel:{p}"
            else:
                reason = "missing_phone"
        elif t == "whatsapp":
            p = pub("whatsapp")
            if p:
                msg = txt(a["message"])
                href = f"https://wa.me/{p[1:]}" + (f"?text={encode_component(msg['text'])}" if msg else "")
                external = True
            else:
                reason = "missing_whatsapp"
        elif t == "email":
            e = pub("email")
            if e:
                href = f"mailto:{e}"
            else:
                reason = "missing_email"
        elif t == "navigate":
            if nav_query:
                href = navigation_href(nav_query, a["navProvider"])
                external = True
            else:
                reason = "missing_address"
        elif t == "website":
            w = pub("website")
            if w:
                href, external = w, True
            else:
                reason = "missing_website"
        elif t == "link":
            platform = a["platform"] or "other"
            if is_platform_url(platform, a["url"]):
                href, external = a["url"], True
                if not label:
                    label = {"text": PLATFORM_LABELS[platform][lang], "lang": lang}
            else:
                reason = "invalid_url"
        elif t == "file":
            f = next((x for x in files if x["url"] == a["fileUrl"]), None)
            if f:
                href, external = f["url"], True
                if not label:
                    label = txt(f["title"])
            else:
                reason = "missing_file"
        elif t in ("digital_menu", "order_online"):
            dest = (inp.get("destinations") or {}).get(t)
            if dest and is_safe_url(dest.get("url")):
                href = dest["url"]
                if not label:
                    label = txt(dest.get("label"))
            else:
                reason = "menu_unavailable"
        elif t == "enquiry":
            if not enquiry_on:
                reason = "enquiry_off"
        if reason:
            unavailable.append({"id": a["id"], "type": t, "reason": reason})
            continue
        actions.append({
            "id": a["id"],
            "type": t,
            "label": label or {"text": ACTION_LABELS[t][lang], "lang": lang},
            "href": href,
            "style": a["style"],
            "external": external,
            "platform": (a["platform"] or "other") if t == "link" else None,
        })

    out: List[Dict[str, Any]] = []
    for s in sections:
        if not s["enabled"]:
            continue
        kind = s["kind"]
        if kind == "actions":
            if actions:
                out.append({"kind": "actions", "intro": txt(pub("ctaText"))})
        elif kind == "announcement":
            v = pub("announcement")
            if v and not _expired(v.get("until"), today):
                out.append({"kind": "announcement", "title": txt(v.get("title")), "body": txt(v.get("body")), "until": v.get("until")})
        elif kind == "about":
            t = txt(pub("description"))
            if t:
                out.append({"kind": "about", "text": t})
        elif kind == "event":
            v = pub("event")
            if v and not _expired(v.get("expiresAt"), today):
                out.append({"kind": "event", "title": txt(v.get("title")), "venue": txt(v.get("venue")),
                            "startsAt": v.get("startsAt"), "endsAt": v.get("endsAt")})
        elif kind == "offer":
            v = pub("offer")
            if v and not _expired(v.get("validUntil"), today):
                out.append({"kind": "offer", "title": txt(v.get("title")), "body": txt(v.get("body")), "validUntil": v.get("validUntil")})
        elif kind == "services":
            v = pub("services")
            if v:
                items = [{"title": txt(it.get("title")), "description": txt(it.get("description"))} for it in v]
                items = [it for it in items if it["title"]]
                if items:
                    out.append({"kind": "services", "items": items})
        elif kind == "hours":
            v = pub("hours")
            if v:
                out.append({"kind": "hours", "rows": v["rows"], "note": txt(v.get("note"))})
        elif kind == "location":
            nav = next((a for a in actions if a["type"] == "navigate"), None)
            nav_href = (nav["href"] if nav else None) or (navigation_href(nav_query, "google") if nav_query else None)
            if address or nav_href:
                out.append({"kind": "location", "address": address, "navHref": nav_href})
        elif kind == "social":
            v = pub("social")
            if v:
                out.append({"kind": "social", "links": [
                    {"platform": link["platform"], "url": link["url"], "label": {"text": PLATFORM_LABELS[link["platform"]][lang], "lang": lang}}
                    for link in v
                ]})
        elif kind == "files":
            lst = [{"title": txt(f["title"]), "url": f["url"], "bytes": f.get("bytes")} for f in files]
            lst = [f for f in lst if f["title"]]
            if lst:
                out.append({"kind": "files", "files": lst})
        elif kind == "support":
            v = pub("support")
            if v:
                out.append({"kind": "support", "phone": _phone_out(v.get("phone")), "hours": txt(v.get("hours")),
                            "note": txt(v.get("note")), "url": v.get("url")})
        elif kind == "enquiry":
            if enquiry_on:
                out.append({"kind": "enquiry", "intro": txt(enquiry["intro"])})

    seo = _obj(doc.get("seo")) or {}
    model = {
        "v": 1,
        "cardId": card["meta"]["id"],
        "slug": card["meta"]["slug"],
        "type": card["meta"]["type"],
        "template": template,
        "lang": lang,
        "dir": "rtl" if lang == "he" else "ltr",
        "languages": languages,
        "design": public_design,
        "header": {
            "title": title,
            "role": txt(pub("role")),
            "orgLine": txt(pub("orgLine")),
            "avatar": image(pub("avatar")),
            "cover": image(pub("cover")),
        },
        "contact": {
            "phone": _phone_out(pub("phone")),
            "whatsapp": _phone_out(pub("whatsapp")),
            "email": pub("email"),
            "website": pub("website"),
            "address": address,
        },
        "sections": out,
        "actions": actions,
        "enquiry": {
            "fields": enquiry["fields"],
            "topics": [t for t in (txt(x) for x in enquiry["topics"]) if t],
            "intro": txt(enquiry["intro"]),
            "privacyUrl": privacy_url,
        } if enquiry_on else None,
        "legal": {"accessibilityUrl": pub("accessibilityUrl"), "privacyUrl": privacy_url},
        "indexable": seo.get("indexable") is True,
    }
    return {"model": model, "fields": fields, "brandSource": brand_source, "unavailableActions": unavailable}


def card_issues(inp: Dict[str, Any], result: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Errors block publication; warnings deserve a look. The editor shows the same list live."""
    r = result or resolve_card(inp)
    issues: List[Dict[str, Any]] = []
    doc = inp["card"].get("doc") or {}
    card_type = inp["card"]["meta"]["type"]
    if not r["fields"]["title"]["isPublic"]:
        issues.append({"level": "error", "code": "title_required", "field": "title"})
    for key in FIELD_KEYS:
        f = _field_of(doc, key, card_type)
        if f["mode"] != "local" or f["value"] is None or f["value"] == "":
            continue
        kind = FIELD_SPECS[key]["kind"]
        if kind in ("phone", "email", "url", "image") and usable_value(key, f["value"]) is None:
            issues.append({"level": "error", "code": f"invalid_{kind}", "field": key})
    model = r["model"]
    if not model["legal"]["accessibilityUrl"]:
        issues.append({"level": "error", "code": "accessibility_required", "field": "accessibilityUrl"})
    if not model["legal"]["privacyUrl"]:
        issues.append({"level": "error", "code": "privacy_required", "field": "privacyUrl"})
    enquiry = enquiry_of(doc)
    if enquiry["mode"] == "internal" and not enquiry_usable(enquiry):
        issues.append({"level": "error", "code": "enquiry_contact_field"})
    p = model["design"]["palette"]
    if contrast_ratio(p["text"], p["background"]) < 4.5 or contrast_ratio(p["text"], p["surface"]) < 4.5:
        issues.append({"level": "error", "code": "contrast_text"})
    if contrast_ratio(p["muted"], p["background"]) < 4.5 or contrast_ratio(p["muted"], p["surface"]) < 4.5:
        issues.append({"level": "error", "code": "contrast_muted"})
    if contrast_ratio(p["primary"], p["background"]) < 3:
        issues.append({"level": "warning", "code": "contrast_primary"})
    if not model["actions"]:
        issues.append({"level": "warning", "code": "no_actions"})
    for u in r["unavailableActions"]:
        issues.append({"level": "warning", "code": f"action_{u['reason']}", "actionId": u["id"]})
    ev = r["fields"]["event"]
    if ev["isPublic"] and _expired(ev["value"].get("expiresAt"), inp.get("today") or ""):
        issues.append({"level": "warning", "code": "event_expired", "field": "event"})
    if _expired(doc.get("expiresAt") if isinstance(doc, dict) else None, inp.get("today") or ""):
        issues.append({"level": "warning", "code": "card_expired"})
    return issues


# ── Slugs ─────────────────────────────────────────────────────────────────────

_SLUG = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$")
RESERVED_SLUGS = ("admin", "api", "new", "edit", "preview", "dashboard", "vcard", "qr", "www", "static", "assets", "c")


def is_valid_slug(value: Any) -> bool:
    return isinstance(value, str) and _full(_SLUG, value) and "--" not in value and value not in RESERVED_SLUGS
