"""
The publication gate of the public digital channels: a digital menu, an online-ordering site or a
business card is published only when

1. the legal pages it needs are published for its company / shop (`REQUIRED_KINDS`);
2. its theme passes WCAG AA contrast (`contrast.check_theme`);
3. its images have alt text (or are marked decorative);
4. the editor's accessibility check of the rendered preview (client/src/lib/a11yRules.ts, run on the
   live preview with the real data) found no critical / serious violation.

Every publish route of those channels calls `assert_publishable` (or shows `check_publication` in
its review dialog). The dashboard reads the same answer from GET /digital-legal/publication-check.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional

from sqlalchemy.orm import Session

from app.models.digital_legal import KIND_ACCESSIBILITY, KIND_COOKIES, KIND_PRIVACY, KIND_TERMS
from app.services.digital_legal import contrast as C
from app.services.digital_legal import documents as D
from app.services.digital_legal import templates as T

PRODUCT_MENU = "menu"
PRODUCT_ONLINE = "online"
PRODUCT_CARD = "card"
PRODUCTS = (PRODUCT_MENU, PRODUCT_ONLINE, PRODUCT_CARD)

#: Plan §17.5: ordering needs all four; a view-only menu and a card need all but the terms.
REQUIRED_KINDS: Dict[str, tuple] = {
    PRODUCT_MENU: (KIND_ACCESSIBILITY, KIND_PRIVACY, KIND_COOKIES),
    PRODUCT_CARD: (KIND_ACCESSIBILITY, KIND_PRIVACY, KIND_COOKIES),
    PRODUCT_ONLINE: (KIND_ACCESSIBILITY, KIND_PRIVACY, KIND_COOKIES, KIND_TERMS),
}

#: Impacts of the a11y rule set that block publication; the others are shown as warnings.
BLOCKING_IMPACTS = ("critical", "serious")
IMPACTS = ("critical", "serious", "moderate", "minor")
A11Y_ENGINE = "runner-a11y"


def _clean_report(report: Any) -> Optional[List[Dict[str, Any]]]:
    """The violations of a client a11y report, or None when it is not one."""
    if not isinstance(report, Mapping) or report.get("engine") != A11Y_ENGINE:
        return None
    raw = report.get("violations")
    if not isinstance(raw, list):
        return None
    out = []
    for v in raw[:200]:
        if not isinstance(v, Mapping) or not isinstance(v.get("rule"), str):
            continue
        impact = v.get("impact") if v.get("impact") in IMPACTS else "serious"
        try:
            count = max(1, int(v.get("count") or 1))
        except (TypeError, ValueError):
            count = 1
        out.append({"rule": v["rule"][:60], "impact": impact, "count": count})
    return out


def check_images(images: Optional[Iterable[Any]]) -> List[Dict[str, Any]]:
    """Every image a public page shows needs alt text, unless it is marked decorative."""
    out = []
    for i, img in enumerate(images or []):
        if not isinstance(img, Mapping):
            continue
        if img.get("decorative") is True:
            continue
        alt = img.get("alt")
        if not isinstance(alt, str) or not alt.strip():
            out.append({"code": "image_alt_missing", "ref": str(img.get("ref") or img.get("url") or i)[:200]})
    return out


def check_publication(
    db: Session,
    *,
    company_id: Any,
    shop_id: Any = None,
    product: str,
    theme: Optional[Mapping[str, Any]] = None,
    images: Optional[Iterable[Any]] = None,
    a11y_report: Any = None,
    require_a11y_report: bool = False,
    lang: str = "he",
) -> Dict[str, Any]:
    """`{ok, product, blocking: [...], warnings: [...], legal: {kind: {...}}, contrast}`."""
    if product not in REQUIRED_KINDS:
        raise D.LegalError("product_invalid", 422)
    blocking: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []
    published = D.published_kinds(db, company_id=company_id, shop_id=shop_id, lang=lang)
    legal: Dict[str, Any] = {}
    for kind in REQUIRED_KINDS[product]:
        doc = published.get(kind)
        legal[kind] = {
            "required": True,
            "published": doc is not None,
            "version": doc.version if doc is not None else None,
            "title": T.kind_def(kind).title,
        }
        if doc is None:
            blocking.append({"code": "legal_missing", "kind": kind, "title": T.kind_def(kind).title})
    contrast = C.check_theme(theme or {})
    for pair in contrast["pairs"]:
        if not pair["ok"]:
            blocking.append({
                "code": "contrast_below_aa" if pair["ratio"] is not None else "color_invalid",
                "pair": pair["id"], "ratio": pair["ratio"], "min": pair["min"],
            })
    blocking.extend(check_images(images))
    violations = _clean_report(a11y_report)
    if violations is None:
        if require_a11y_report:
            blocking.append({"code": "a11y_report_missing"})
    else:
        for v in violations:
            entry = {"code": "a11y_violation", **v}
            (blocking if v["impact"] in BLOCKING_IMPACTS else warnings).append(entry)
    return {
        "ok": not blocking,
        "product": product,
        "blocking": blocking,
        "warnings": warnings,
        "legal": legal,
        "contrast": contrast,
    }


def assert_publishable(
    db: Session,
    *,
    company_id: Any,
    shop_id: Any = None,
    product: str,
    theme: Optional[Mapping[str, Any]],
    images: Optional[Iterable[Any]] = None,
    a11y_report: Any = None,
    require_a11y_report: bool = True,
    lang: str = "he",
) -> Dict[str, Any]:
    """
    For a publish route: raises `LegalError("publication_blocked", 409, check=…)` unless the target may
    go public. A theme of None is judged by the defaults; the a11y report is required by default.
    """
    result = check_publication(
        db, company_id=company_id, shop_id=shop_id, product=product, theme=theme, images=images,
        a11y_report=a11y_report, require_a11y_report=require_a11y_report, lang=lang,
    )
    if not result["ok"]:
        raise D.LegalError("publication_blocked", 409, check=result)
    return result


PUBLICATION_BLOCKED_MESSAGE = (
    "אי אפשר לפרסם עדיין: חסרים דפים משפטיים מפורסמים, או שהעיצוב לא עובר את בדיקות הנגישות. הפרטים ברשימה."
)


def raise_if_blocked(db: Session, **kwargs: Any) -> Dict[str, Any]:
    """
    `assert_publishable` for a route: a blocked target answers the structured API error
    `409 {code: "publication_blocked", userMessage, check: {...}}` (the review dialog lists `check`).
    """
    try:
        return assert_publishable(db, **kwargs)
    except D.LegalError as exc:
        from app.services.club.scope import error

        raise error(exc.code, exc.status, PUBLICATION_BLOCKED_MESSAGE, **exc.extra) from None
