"""
WCAG 2.x contrast of a public theme — "a theme below AA is not published".

Pure. The dashboard's twin is client/src/lib/contrast.ts; both are pinned by the shared
tests/fixtures/contrast_golden.json (the client test reads the same file).

A theme is the kiosk-style token set (`backgroundColor`, `surfaceColor`, `textColor`,
`primaryColor`, `accentColor`, `buttonColor`, `buttonTextColor`, optional `mutedTextColor`,
`linkColor`, `focusColor`), plus optional extra `pairs` a template declares
(`{id, fg, bg, kind}`). Missing tokens take the defaults below. Minimums (AA):

* text — 4.5:1 (body text, button labels, links, muted text);
* large — 3:1 (text ≥ 24px, or ≥ 18.66px bold);
* ui — 3:1 (focus ring, icons, borders and other non-text indicators).
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Optional, Tuple

AA_MIN = {"text": 4.5, "large": 3.0, "ui": 3.0}

DEFAULTS = {
    "backgroundColor": "#FFFFFF",
    "textColor": "#111827",
    "primaryColor": "#1F6FEB",
    "buttonTextColor": "#FFFFFF",
}

_HEX = re.compile(r"^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_RGB = re.compile(r"^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)$")

RGBA = Tuple[float, float, float, float]


def parse_color(value: Any) -> Optional[RGBA]:
    """`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` → (r, g, b, a); else None."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    m = _HEX.match(text)
    if m:
        h = m.group(1)
        if len(h) in (3, 4):
            h = "".join(c * 2 for c in h)
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return (r, g, b, a)
    m = _RGB.match(text.lower())
    if m:
        r, g, b = (int(m.group(i)) for i in (1, 2, 3))
        if max(r, g, b) > 255:
            return None
        a = float(m.group(4)) if m.group(4) is not None else 1.0
        return (r, g, b, a)
    return None


def _over(fg: RGBA, bg: RGBA) -> RGBA:
    a = fg[3]
    return (fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1.0)


def _channel(c: float) -> float:
    s = c / 255
    return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4


def luminance(rgb: RGBA) -> float:
    return 0.2126 * _channel(rgb[0]) + 0.7152 * _channel(rgb[1]) + 0.0722 * _channel(rgb[2])


def contrast_ratio(fg: Any, bg: Any) -> Optional[float]:
    """The ratio of `fg` over `bg` (a translucent background sits on white; a translucent fg on bg)."""
    f, b = parse_color(fg), parse_color(bg)
    if f is None or b is None:
        return None
    b = _over(b, (255, 255, 255, 1.0))
    f = _over(f, b)
    l1, l2 = luminance(f), luminance(b)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


def _tokens(theme: Mapping[str, Any]) -> Dict[str, Any]:
    t = {k: v for k, v in (theme or {}).items() if isinstance(v, str) and v.strip()}
    for key, value in DEFAULTS.items():
        t.setdefault(key, value)
    t.setdefault("surfaceColor", t["backgroundColor"])
    t.setdefault("buttonColor", t["primaryColor"])
    t.setdefault("linkColor", t["primaryColor"])
    t.setdefault("focusColor", t["primaryColor"])
    return t


def theme_pairs(theme: Mapping[str, Any]) -> List[Dict[str, str]]:
    """The pairs a theme is judged by: the built-in ones, then the template's own."""
    t = _tokens(theme)
    pairs = [
        {"id": "text_on_background", "fg": t["textColor"], "bg": t["backgroundColor"], "kind": "text"},
        {"id": "text_on_surface", "fg": t["textColor"], "bg": t["surfaceColor"], "kind": "text"},
        {"id": "button_text", "fg": t["buttonTextColor"], "bg": t["buttonColor"], "kind": "text"},
        {"id": "link_on_background", "fg": t["linkColor"], "bg": t["backgroundColor"], "kind": "text"},
        {"id": "focus_on_background", "fg": t["focusColor"], "bg": t["backgroundColor"], "kind": "ui"},
    ]
    if t.get("mutedTextColor"):
        pairs.append({"id": "muted_text_on_background", "fg": t["mutedTextColor"], "bg": t["backgroundColor"], "kind": "text"})
    if t.get("accentColor"):
        pairs.append({"id": "accent_on_background", "fg": t["accentColor"], "bg": t["backgroundColor"], "kind": "ui"})
    for extra in (theme or {}).get("pairs") or []:
        if isinstance(extra, Mapping) and extra.get("id"):
            kind = extra.get("kind") if extra.get("kind") in AA_MIN else "text"
            pairs.append({"id": str(extra["id"])[:60], "fg": extra.get("fg"), "bg": extra.get("bg"), "kind": kind})
    return pairs


def check_theme(theme: Mapping[str, Any]) -> Dict[str, Any]:
    """`{ok, pairs: [{id, fg, bg, kind, ratio, min, ok}], failures: [ids]}` — any failure blocks."""
    out = []
    for p in theme_pairs(theme):
        ratio = contrast_ratio(p["fg"], p["bg"])
        minimum = AA_MIN[p["kind"]]
        ok = ratio is not None and ratio + 1e-9 >= minimum
        out.append({**p, "ratio": None if ratio is None else round(ratio, 2), "min": minimum, "ok": ok})
    failures = [p["id"] for p in out if not p["ok"]]
    return {"ok": not failures, "pairs": out, "failures": failures}
