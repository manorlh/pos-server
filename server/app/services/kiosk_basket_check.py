"""
The kiosk's pre-payment check against the cloud (docs/SPEC_KIOSK_INSIGHTS.md §5).

Before it charges, a kiosk re-checks its basket. Offline it has only its last synced catalog
and promotions (its own rules, unchanged); online it also asks here —
`POST /sync/{machine_id}/kiosk/basket-check` — what the cloud says now about each line:

* is the product still sold on this kiosk — in the shop's assortment, available at every
  level (company / shop / area / till), in stock, its category active here, not "קופה בלבד",
  not "מחייב אישור מנהל במכירה" (itself or a category above it), on this till's own list;
* its price now (the shop's price, in agorot, without any menu — `price` of the till's sync,
  the very value the kiosk's catalog holds as the base price);
* whether the promotions this kiosk runs changed (`promotionsEtag`: the ETag of
  `GET /sync/{m}/promotions` the kiosk last pulled) — then the kiosk pulls them and prices again.

The cloud never prices the basket here (promotions are computed on the device, offline-capable);
it answers with the authoritative facts and the kiosk applies its own rules to them, shows the
customer anything that changed (removed, repriced, the new total) and asks again — never
charging a total the customer did not see. Read-only: nothing is written.

`price_lines` is the cloud's own price of a basket the kiosk already sent (an order to pay at
the till, app/services/kiosk_open_orders.py): each line of the till's held sale priced again —
the base price (the catalog's, or a price a "תפריט" of this kiosk sets for it), every choice
by its group's rules (app/services/menu.py `price_picks`, pinned to the kiosks' rules by
tests/fixtures/kiosk_money_golden.json) and a meal's upcharges and its components' choices.
The promotions stay the device's: the till that takes the money runs its own on the basket.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, List, Optional, Set, Tuple

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


def _products_by_id(db: Session, machine: POSMachine) -> Dict[str, Dict[str, Any]]:
    """The kiosk's catalog rows (its till sync), by their id and by the global product's id."""
    from app.services import sync as SY

    tenant = str(machine.tenant_id) if machine.tenant_id else None
    products = SY.get_products_for_sync(db, tenant, str(machine.id))
    by_id: Dict[str, Dict[str, Any]] = {}
    for p in products:
        by_id.setdefault(str(p.get("id")), p)
    for p in products:
        gid = p.get("globalProductId")
        if gid:
            by_id.setdefault(str(gid), p)
    return by_id


def check(db: Session, machine: POSMachine, lines: List[Dict[str, Any]], promotions_etag: Optional[str],
          *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Each line's verdict and the promotions' ETag. `ok` when nothing differs from what the kiosk sent."""
    from app.services import machine_catalog
    from app.services import promotions as P
    from app.services import restricted_items as RI
    from app.services import sync as SY

    now = now or datetime.now(timezone.utc)
    tenant = str(machine.tenant_id) if machine.tenant_id else None
    by_id = _products_by_id(db, machine)
    categories = {str(c.get("id")): c for c in SY.get_categories_for_sync(db, tenant, str(machine.id))}
    # "מחייב אישור מנהל במכירה": never on a kiosk — its own flag, or its category's (or above).
    restricted = RI.restricted_ids_of_rows(categories.values())
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
            elif RI.is_restricted(p.get(RI.FIELD), p.get("categoryId"), restricted):
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

# ── The cloud's price of a basket the kiosk sent ─────────────────────────────


def _int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _json_object(value: Any) -> Optional[Dict[str, Any]]:
    """The held sale writes the product as a JSON string (HeldSaleCodec); an object is taken too."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            out = json.loads(value)
        except ValueError:
            return None
        return out if isinstance(out, dict) else None
    return None


def codec_lines(cart: Any) -> Optional[List[Dict[str, Any]]]:
    """The lines of an order's basket (`cart.codec`, the till's held sale), or None when it has none."""
    if not isinstance(cart, dict):
        return None
    held = _json_object(cart.get("codec"))
    lines = (held or {}).get("lines")
    if not isinstance(lines, list):
        return None
    return [line for line in lines if isinstance(line, dict)]


class _Menu:
    """What prices a line beyond its base: the groups' rules and the meals' slots (the till's menu block)."""

    def __init__(self, db: Session, machine: POSMachine):
        from app.services import menu as MENU

        block = MENU.menu_block(db, machine)
        self.groups: Dict[str, MENU.GroupRules] = {}
        for g in block.get("groups") or []:
            options = g.get("options") or []
            self.groups[str(g.get("id"))] = MENU.GroupRules(
                min_select=g.get("minSelect") or 0,
                max_select=g.get("maxSelect"),
                free_count=g.get("freeCount") or 0,
                allow_quantity=bool(g.get("allowQuantity")),
                allow_pre=bool(g.get("allowPre")),
                prices={str(o.get("id")): MENU._agorot(o.get("price")) for o in options},
                limits={str(o.get("id")): o["maxQty"] for o in options if o.get("maxQty")},
            )
        #: meal product id → slot id → chosen product id → its upcharge (agorot)
        self.meals: Dict[str, Dict[str, Dict[str, int]]] = {
            str(pid): {
                str(s.get("id")): {str(o.get("productId")): MENU._agorot(o.get("upcharge")) for o in s.get("options") or []}
                for s in slots
            }
            for pid, slots in (block.get("meals") or {}).items()
        }

    def choices(self, modifiers: Any) -> Optional[int]:
        """What the choices add to one unit (agorot), by each group's rules; None when one is no longer offered."""
        from app.services import menu as MENU

        if not modifiers:
            return 0
        if not isinstance(modifiers, list):
            return None
        by_group: Dict[str, List[Any]] = {}
        for m in modifiers:
            if not isinstance(m, dict):
                return None
            by_group.setdefault(str(m.get("groupId") or ""), []).append(m)
        total = 0
        for group_id, picked in by_group.items():
            rules = self.groups.get(group_id)
            if rules is None:
                return None
            picks = []
            for m in picked:
                option_id = str(m.get("optionId") or "")
                if option_id not in rules.prices:
                    return None
                qty = _int(m.get("qty"))
                pre = m.get("pre") if rules.allow_pre and m.get("pre") in ("lite", "extra", "side") else None
                picks.append(MENU.Pick(option_id=option_id, qty=max(1, qty if qty is not None else 1), pre=pre))
            total += sum(MENU.price_picks(rules, picks))
        return total


def _menu_prices(db: Session, machine: POSMachine) -> Dict[str, Set[int]]:
    """Every price a "תפריט" of this kiosk sets, by product id: a line added under a menu keeps its price."""
    from app.services import catalog_menus as CM
    from app.services import menu as MENU

    try:
        block = CM.block_for_machine(db, machine)
    except Exception:  # noqa: BLE001 - no menus to read: the catalog's prices only
        return {}
    out: Dict[str, Set[int]] = {}
    for m in block.get("menus") or []:
        for p in (m or {}).get("products") or []:
            if isinstance(p, dict) and p.get("id") and p.get("price") is not None:
                out.setdefault(str(p["id"]), set()).add(MENU._agorot(p.get("price")))
    return out


def price_lines(db: Session, machine: POSMachine, lines: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    The held sale's lines priced again by the cloud: `{"ok", "lines"}` — `lines` only those that
    differ, each `{"key", "productId", "name", "fromAgorot", "toAgorot", "reason"}` with the unit
    price the kiosk sent and the cloud's (`toAgorot` null: the line cannot be sold as it is —
    `not_in_catalog`, `choice_gone`, `meal_changed`). An open-price product is taken as sent.
    """
    by_id = _products_by_id(db, machine)
    menu: Optional[_Menu] = None
    menu_prices: Optional[Dict[str, Set[int]]] = None
    out: List[Dict[str, Any]] = []
    for line in lines[:LINES_MAX * 2]:
        product = _json_object(line.get("product")) or {}
        pid = str(product.get("cloudId") or product.get("id") or "")
        quantity = line.get("quantity")
        if not isinstance(quantity, (int, float)) or isinstance(quantity, bool) or quantity <= 0:
            continue
        sent = _int(line.get("unitPrice"))
        p = by_id.get(pid) or by_id.get(str(product.get("id") or ""))
        verdict = {"key": str(line.get("id") or ""), "productId": pid, "name": (p or product).get("name"), "fromAgorot": sent}
        if p is None:
            out.append({**verdict, "toAgorot": None, "reason": "not_in_catalog"})
            continue
        if p.get("isOpenPrice") or p.get("isWeighed"):
            continue
        if menu is None:
            menu = _Menu(db, machine)
            menu_prices = _menu_prices(db, machine)
        ids = {str(p.get("id")), str(p.get("globalProductId") or ""), pid}
        allowed = {_agorot(p.get("price"))} | {a for i in ids for a in (menu_prices or {}).get(i, ())}
        base_sent = _int(product.get("price"))
        base = base_sent if base_sent in allowed else _agorot(p.get("price"))
        details = line.get("details") if isinstance(line.get("details"), dict) else {}
        unit = menu.choices(details.get("modifiers"))
        reason = "choice_gone" if unit is None else None
        meal = details.get("meal") if isinstance(details.get("meal"), dict) else None
        if unit is not None and meal is not None:
            slots = menu.meals.get(str(p.get("id"))) or menu.meals.get(pid) or {}
            for c in meal.get("components") or []:
                choices = slots.get(str((c or {}).get("slotId") or "")) if isinstance(c, dict) else None
                upcharge = None if choices is None else choices.get(str(c.get("productId") or ""))
                extra = None if upcharge is None else menu.choices(c.get("modifiers"))
                if extra is None:
                    unit, reason = None, "meal_changed"
                    break
                unit += upcharge + extra
        if unit is None:
            out.append({**verdict, "toAgorot": None, "reason": reason})
            continue
        unit += base or 0
        if sent != unit:
            out.append({**verdict, "toAgorot": unit, "reason": "price"})
    return {"ok": not out, "lines": out}
