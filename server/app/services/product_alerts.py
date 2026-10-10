"""
"הודעות לעובד על פריט" and "פריטים נלווים" — two things a product can carry to the till.

* **Alerts** (`products.alerts`): an ordered list of messages the till shows the employee
  when the product is added, before it enters the order — "מכיל ביצים — תעדכן לקוח!".
  Each has a kind (מידע / אזהרה / אלרגן), whether it must be confirmed ("עדכנתי את
  הלקוח") and where it is shown (quick order / tables / both). On top of them,
  `allergen_alert` builds one more from the product's allergen codes
  (`allergen_alert_text`), confirmed by default. The till's acknowledgement — who and
  when — comes back on the sold line and is kept in `transaction_items.alerts_ack`.
* **Companions** (`products.companions`): products added automatically with this one, as
  lines of their own under it ("קולה" → "כוס קרח"): a quantity per unit of the parent, a
  price (the companion's own, free, or a set price) and whether the kitchen prints it.
  The till adds them, scales and removes them with the parent, and never adds the
  companions of a companion.

Both are stored as JSON on the product, in the wire's own keys, and sent as they are in
the catalog pull. A product that never set either behaves exactly as before. The till
parameter `productAlertsEnabled` (on by default) turns the alerts off on a till.
"""
from __future__ import annotations

import uuid
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, Iterable, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.menu import ALLERGENS

#: מידע / אזהרה / אלרגן.
ALERT_KINDS = ("info", "warning", "allergen")
#: הזמנה מהירה / שולחנות / שניהם.
ALERT_PLACES = ("quick", "tables", "both")
ALERT_TEXT_MAX = 200
ALERTS_MAX = 10

#: מחיר הפריט / חינם (₪0) / מחיר מותאם.
COMPANION_PRICE_MODES = ("item", "free", "custom")
COMPANIONS_MAX = 10
COMPANION_QTY_MAX = 99

#: The till parameter that turns the alerts on (the default) or off.
PARAM_KEY = "productAlertsEnabled"

#: The allergens in Hebrew, as the dashboard and the till name them.
ALLERGEN_HEBREW = {
    "gluten": "גלוטן",
    "milk": "חלב",
    "nuts": "אגוזים",
    "eggs": "ביצים",
    "peanuts": "בוטנים",
    "fish": "דגים",
    "soy": "סויה",
    "sesame": "שומשום",
    "celery": "סלרי",
    "mustard": "חרדל",
    "sulphites": "סולפיטים",
    "lupin": "תורמוס",
    "molluscs": "רכיכות",
    "crustaceans": "סרטנים",
}

#: Acknowledgements kept per sold line, and the alerts kept per acknowledgement.
ACKS_MAX = 20
ACK_ALERTS_MAX = ALERTS_MAX + 1
ACK_TEXT_MAX = 100


def allergen_alert_text(codes: Optional[Iterable[str]]) -> Optional[str]:
    """
    "מכיל: ביצים, גלוטן — עדכנו את הלקוח!" — the known codes in Hebrew, in the fixed order
    (the till's `ProductAlerts.allergenText` says the same). None when there are none.
    """
    wanted = {str(c).strip().lower() for c in (codes or []) if c}
    names = [ALLERGEN_HEBREW[c] for c in ALLERGENS if c in wanted]
    if not names:
        return None
    return f"מכיל: {', '.join(names)} — עדכנו את הלקוח!"


def _money(value: Any) -> float:
    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


# ── Writing them (the product form) ──────────────────────────────────────────


def stored_alerts(alerts: Optional[Iterable[Any]]) -> Optional[List[Dict[str, Any]]]:
    """The validated alerts (`ProductAlertIn`) as stored and sent; empty → None."""
    out: List[Dict[str, Any]] = []
    for a in alerts or []:
        out.append({
            "text": a.text.strip(),
            "kind": a.kind,
            "requireAck": bool(a.require_ack),
            "whereShown": a.where_shown,
        })
    return out or None


def stored_companions(
    db: Session, tenant_id, product_id, companions: Optional[Iterable[Any]]
) -> Optional[List[Dict[str, Any]]]:
    """
    The validated companions (`ProductCompanionIn`) as stored: each a product of the same
    organization, not the product itself and not the built-in general item, named as it
    is now (for the form; the till goes by the id). Empty → None.
    """
    from app.models.product import Product

    items = list(companions or [])
    if not items:
        return None
    ids = [c.product_id for c in items]
    rows = {
        str(p.id): p
        for p in db.query(Product).filter(Product.id.in_(ids)).all()
    }
    out: List[Dict[str, Any]] = []
    for c in items:
        key = str(c.product_id)
        if product_id is not None and key == str(product_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="companion_is_the_product",
            )
        row = rows.get(key)
        if row is None or str(row.tenant_id) != str(tenant_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="companion_product_not_found",
            )
        if getattr(row, "is_general", False):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="companion_is_general_item",
            )
        out.append({
            "productId": key,
            "name": row.name,
            "quantity": int(c.quantity),
            "priceMode": c.price_mode,
            "price": _money(c.price) if c.price_mode == "custom" else None,
            "kitchenPrint": c.kitchen_print,
        })
    return out


def apply(db: Session, product, data, tenant_id) -> None:
    """
    The alerts, the allergen alert and the companions a create / update asked for; what
    it did not send is left as it is.
    """
    sent = data.model_fields_set
    if "alerts" in sent:
        product.alerts = stored_alerts(data.alerts)
    if "allergen_alert" in sent and data.allergen_alert is not None:
        product.allergen_alert = bool(data.allergen_alert)
    if "allergen_alert_require_ack" in sent and data.allergen_alert_require_ack is not None:
        product.allergen_alert_require_ack = bool(data.allergen_alert_require_ack)
    if "companions" in sent:
        product.companions = stored_companions(db, tenant_id, getattr(product, "id", None), data.companions)


# ── Reading them (the API and the till) ──────────────────────────────────────


def alerts_out(value: Any) -> List[Dict[str, Any]]:
    """The stored alerts as sent, anything unreadable dropped."""
    out: List[Dict[str, Any]] = []
    for a in value if isinstance(value, list) else []:
        if not isinstance(a, dict):
            continue
        text = str(a.get("text") or "").strip()[:ALERT_TEXT_MAX]
        if not text:
            continue
        kind = a.get("kind") if a.get("kind") in ALERT_KINDS else "info"
        where = a.get("whereShown") if a.get("whereShown") in ALERT_PLACES else "both"
        out.append({"text": text, "kind": kind, "requireAck": bool(a.get("requireAck")), "whereShown": where})
    return out[:ALERTS_MAX]


def companions_out(value: Any) -> List[Dict[str, Any]]:
    """The stored companions as sent, anything unreadable dropped."""
    out: List[Dict[str, Any]] = []
    for c in value if isinstance(value, list) else []:
        if not isinstance(c, dict) or not c.get("productId"):
            continue
        try:
            uuid.UUID(str(c["productId"]))
        except ValueError:
            continue
        mode = c.get("priceMode") if c.get("priceMode") in COMPANION_PRICE_MODES else "item"
        try:
            qty = int(c.get("quantity") or 1)
        except (TypeError, ValueError):
            qty = 1
        price = c.get("price")
        kitchen = c.get("kitchenPrint")
        out.append({
            "productId": str(c["productId"]),
            "name": c.get("name"),
            "quantity": min(max(qty, 1), COMPANION_QTY_MAX),
            "priceMode": mode,
            "price": _money(price) if mode == "custom" and price is not None else (0.0 if mode == "custom" else None),
            "kitchenPrint": kitchen if isinstance(kitchen, bool) else None,
        })
    return out[:COMPANIONS_MAX]


def sync_fields(p) -> Dict[str, Any]:
    """What a catalog row carries to the till ("what the product is": the global row's)."""
    return {
        "alerts": alerts_out(getattr(p, "alerts", None)),
        "allergenAlert": bool(getattr(p, "allergen_alert", False)),
        "allergenAlertRequireAck": bool(
            True if getattr(p, "allergen_alert_require_ack", None) is None else p.allergen_alert_require_ack
        ),
        "companions": companions_out(getattr(p, "companions", None)),
    }


# ── The till's acknowledgement, on the sold line ─────────────────────────────


def _cut(value: Any, limit: int) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text[:limit] if text else None


def clean_ack(value: Any) -> Optional[List[Dict[str, Any]]]:
    """
    `alertsAck` as the till sent it — on the line, or inside its details — kept as a list
    of `{at, by, byName, alerts: [{text, kind}]}`: bounded, never a reason to refuse the
    document. Anything else → None.
    """
    if isinstance(value, dict):
        value = [value]
    if not isinstance(value, list):
        return None
    out: List[Dict[str, Any]] = []
    for entry in value[:ACKS_MAX]:
        if not isinstance(entry, dict):
            continue
        alerts = []
        for a in entry.get("alerts") if isinstance(entry.get("alerts"), list) else []:
            if isinstance(a, dict):
                text = _cut(a.get("text"), ALERT_TEXT_MAX)
                if text:
                    alerts.append({"text": text, "kind": a.get("kind") if a.get("kind") in ALERT_KINDS else "info"})
            elif isinstance(a, str) and a.strip():
                alerts.append({"text": a.strip()[:ALERT_TEXT_MAX], "kind": "info"})
        out.append({
            "at": _cut(entry.get("at"), 40),
            "by": _cut(entry.get("by"), ACK_TEXT_MAX),
            "byName": _cut(entry.get("byName"), ACK_TEXT_MAX),
            "alerts": alerts[:ACK_ALERTS_MAX],
        })
    return out or None


def item_ack(item) -> Optional[List[Dict[str, Any]]]:
    """A pushed line's acknowledgement: its own `alertsAck`, else the one in its details."""
    own = getattr(item, "alerts_ack", None)
    if own:
        return clean_ack(own)
    details = getattr(item, "details", None)
    if isinstance(details, dict):
        return clean_ack(details.get("alertsAck"))
    return None
