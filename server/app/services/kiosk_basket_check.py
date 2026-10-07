"""
The kiosk's pre-payment check against the cloud (docs/SPEC_KIOSK_INSIGHTS.md §5).

Before it charges, a kiosk re-checks its basket. Offline it has only its last synced catalog
and promotions (its own rules, unchanged); online it also asks here —
`POST /sync/{machine_id}/kiosk/basket-check` — what the cloud says now about each line:

* is the product still sold on this kiosk — in the shop's assortment, available at every
  level (company / shop / area / till), in stock, its category active here, not "קופה בלבד",
  on this till's own list;
* its price now (the shop's price, in agorot, without any menu — `price` of the till's sync,
  the very value the kiosk's catalog holds as the base price);
* whether the promotions this kiosk runs changed (`promotionsEtag`: the ETag of
  `GET /sync/{m}/promotions` the kiosk last pulled) — then the kiosk pulls them and prices again.

The cloud never prices the basket (promotions are computed on the device, offline-capable);
it answers with the authoritative facts and the kiosk applies its own rules to them, shows the
customer anything that changed (removed, repriced, the new total) and asks again — never
charging a total the customer did not see. Read-only: nothing is written.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine

LINES_MAX = 100


def _agorot(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int((Decimal(str(value)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except Exception:  # noqa: BLE001
        return None


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def check(db: Session, machine: POSMachine, lines: List[Dict[str, Any]], promotions_etag: Optional[str],
          *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Each line's verdict and the promotions' ETag. `ok` when nothing differs from what the kiosk sent."""
    from app.services import machine_catalog
    from app.services import promotions as P
    from app.services import sync as SY

    now = now or datetime.now(timezone.utc)
    tenant = str(machine.tenant_id) if machine.tenant_id else None
    products = SY.get_products_for_sync(db, tenant, str(machine.id))
    by_id: Dict[str, Dict[str, Any]] = {}
    for p in products:
        by_id.setdefault(str(p.get("id")), p)
    for p in products:
        gid = p.get("globalProductId")
        if gid:
            by_id.setdefault(str(gid), p)
    categories = {str(c.get("id")): c for c in SY.get_categories_for_sync(db, tenant, str(machine.id))}
    mode = machine_catalog.mode_of(machine)

    out_lines: List[Dict[str, Any]] = []
    changed = False
    for line in lines[:LINES_MAX]:
        pid = str(line.get("productId") or "")
        sent = line.get("unitPriceAgorot")
        p = by_id.get(pid)
        reason = None
        price = None
        if p is None:
            reason = "not_in_catalog"
        else:
            price = _agorot(p.get("price"))
            cat = categories.get(str(p.get("categoryId")))
            channel = (p.get("salesChannel") or "all") if isinstance(p.get("salesChannel"), str) else "all"
            if not p.get("isAvailable", True):
                reason = "unavailable"
            elif not p.get("inStock", True):
                reason = "out_of_stock"
            elif cat is not None and cat.get("isActive") is False:
                reason = "category_off"
            elif channel == "pos_only":
                reason = "not_on_kiosk"
            elif p.get("shopListed") is False:
                reason = "unavailable"
            elif not machine_catalog.on_till(mode, bool(p.get("inMachineCatalog")), bool(p.get("isGeneral"))):
                reason = "not_on_kiosk"
        available = reason is None
        price_changed = (
            available and price is not None and isinstance(sent, int) and not isinstance(sent, bool) and sent != price
            and not (p or {}).get("isOpenPrice")
        )
        if not available or price_changed:
            changed = True
        out_lines.append({
            "productId": pid,
            "available": available,
            "reason": reason,
            "priceAgorot": price,
            "priceChanged": bool(price_changed),
            "name": (p or {}).get("name"),
        })
    etag = P.payload_etag(P.promotions_for_machine(db, machine))
    promotions_changed = bool(promotions_etag) and promotions_etag != etag
    return {
        "checkedAt": _iso(now),
        "ok": not changed and not promotions_changed,
        "lines": out_lines,
        "promotions": {"etag": etag, "changed": promotions_changed},
    }
