"""
"מופיע ב" — the four channels a product appears in (specs/digital-menu-ordering-cards-plan.md §4).

* ``pos`` — "קופה": the tills' sell screen (quick order on a tablet and the tables too);
* ``kiosk`` — "קיוסק": the self-order kiosk;
* ``online`` — "הזמנות אונליין": the online ordering site;
* ``menu`` — "תפריט דיגיטלי": the view-only digital menu.

**Where it is stored.** The tills' and the kiosks' pair is the product's existing
`sales_channel` code (app/services/sales_channel.py: all / kiosk_only / pos_only, and now
`none`); the two web channels are `channel_online` / `channel_menu` (off by default). So every
product that exists keeps exactly the pair it had — `all` → tills + kiosks, `kiosk_only` →
kiosks, `pos_only` → tills — and starts with both web channels off: new web exposure starts as
a draft and is published through a profile (app/services/presentation_profiles.py).

**Exceptions** (`product_channel_overrides`): a shop or a point of sale may differ for a channel;
the nearest level that says wins (point of sale → shop → the product). This is permission to
appear, not a restriction — blocks ("חסום" / "אזל", app/services/sold_out.py) are evaluated apart
and always win.

**What a device is sent** (`device_code`): exactly one of the three older codes, from the pair as
it stands for that device (its shop's and point of sale's exceptions applied). A pair the older
codes can express is sent as that code — the very value the device read before; the one pair they
cannot ("neither", new) is sent as the code that hides the product on that device: a till gets
`kiosk_only`, a kiosk `pos_only`. No device needs an update (`docs/SPEC_PRODUCT_CHANNELS.md` §1).
"""
from __future__ import annotations

import weakref
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from app.services import sales_channel as SC

POS, KIOSK, ONLINE, MENU = "pos", "kiosk", "online", "menu"
CHANNELS: Tuple[str, ...] = (POS, KIOSK, ONLINE, MENU)
DEVICE_CHANNELS: Tuple[str, ...] = (POS, KIOSK)
WEB_CHANNELS: Tuple[str, ...] = (ONLINE, MENU)

#: The dashboard's words (he.json `productChannels.*` carries the same).
LABELS_HE: Dict[str, str] = {
    POS: "קופה",
    KIOSK: "קיוסק",
    ONLINE: "הזמנות אונליין",
    MENU: "תפריט דיגיטלי",
}

#: Where an effective value comes from.
SOURCE_PRODUCT, SOURCE_SHOP, SOURCE_AREA = "product", "shop", "area"
OVERRIDE_LEVELS: Tuple[str, ...] = (SOURCE_SHOP, SOURCE_AREA)


# ── The product's own default ────────────────────────────────────────────────


def pair_of(code: Any) -> Tuple[bool, bool]:
    """`(tills, kiosks)` of a stored `sales_channel` code; a missing or unknown one is both (as read before)."""
    value = SC.out(code)
    return (value in (SC.ALL, SC.POS_ONLY), value in (SC.ALL, SC.KIOSK_ONLY))


def stored_code(product: Any) -> str:
    """The product's `sales_channel` as stored (all / kiosk_only / pos_only / none)."""
    return SC.out(getattr(product, "sales_channel", None))


def of(product: Any) -> Dict[str, bool]:
    """The organisation's default for the four channels."""
    pos, kiosk = pair_of(getattr(product, "sales_channel", None))
    return {
        POS: pos,
        KIOSK: kiosk,
        ONLINE: bool(getattr(product, "channel_online", False)),
        MENU: bool(getattr(product, "channel_menu", False)),
    }


def clean(raw: Any) -> Dict[str, bool]:
    """A request's channels: only the four known keys with a boolean value (anything else is dropped)."""
    out: Dict[str, bool] = {}
    if isinstance(raw, Mapping):
        for key in CHANNELS:
            value = raw.get(key)
            if isinstance(value, bool):
                out[key] = value
    return out


def apply(product: Any, patch: Mapping[str, bool]) -> List[str]:
    """
    Set the product's default for the channels in `patch` (the others are left as they are).
    Returns the channels that changed.
    """
    before = of(product)
    after = {**before, **clean(patch)}
    changed = [c for c in CHANNELS if before[c] != after[c]]
    if not changed:
        return []
    if POS in changed or KIOSK in changed:
        product.sales_channel = SC.code_of_pair(after[POS], after[KIOSK])
    if ONLINE in changed:
        product.channel_online = after[ONLINE]
    if MENU in changed:
        product.channel_menu = after[MENU]
    return changed


# ── Exceptions per shop / point of sale ──────────────────────────────────────


def _get(row: Any, key: str) -> Any:
    if isinstance(row, Mapping):
        return row.get(key)
    return getattr(row, {"targetId": "target_id"}.get(key, key), None)


@dataclass(frozen=True)
class Effective:
    allowed: bool
    #: "product" | "shop" | "area".
    source: str
    #: The exception that decided, when one did.
    override: Optional[Any] = None


def resolve(
    defaults: Mapping[str, bool],
    overrides: Iterable[Any],
    *,
    shop_id: Any = None,
    area_id: Any = None,
) -> Dict[str, Effective]:
    """
    Each channel as it stands at this shop / point of sale: the point of sale's exception, else
    the shop's, else the product's default. An exception with `allowed` None says nothing.
    `overrides` are rows (or mappings with `level`, `targetId`, `channel`, `allowed`).
    """
    nearest: Dict[str, Tuple[int, Any]] = {}
    rank = {SOURCE_SHOP: 1, SOURCE_AREA: 2}
    for row in overrides:
        level = _get(row, "level")
        channel = _get(row, "channel")
        allowed = _get(row, "allowed")
        if channel not in CHANNELS or level not in rank or allowed is None:
            continue
        target = str(_get(row, "targetId"))
        if level == SOURCE_SHOP and (shop_id is None or target != str(shop_id)):
            continue
        if level == SOURCE_AREA and (area_id is None or target != str(area_id)):
            continue
        held = nearest.get(channel)
        if held is None or rank[level] > held[0]:
            nearest[channel] = (rank[level], row)
    out: Dict[str, Effective] = {}
    for channel in CHANNELS:
        hit = nearest.get(channel)
        if hit is None:
            out[channel] = Effective(bool(defaults.get(channel, False)), SOURCE_PRODUCT)
        else:
            row = hit[1]
            out[channel] = Effective(bool(_get(row, "allowed")), _get(row, "level"), row)
    return out


def allowed_map(effective: Mapping[str, Effective]) -> Dict[str, bool]:
    return {c: e.allowed for c, e in effective.items()}


# ── What a device is sent ────────────────────────────────────────────────────


def device_code(code: Any, is_kiosk: bool, pair: Optional[Tuple[bool, bool]] = None) -> str:
    """
    The `salesChannel` a till or a kiosk is sent: the older code of the pair as it stands for
    that device (`pair`, its exceptions applied; default: the stored code's). The pair "neither"
    is sent as the code that hides the product on that device.
    """
    pos, kiosk = pair if pair is not None else pair_of(code)
    legacy = SC.code_of_pair(pos, kiosk)
    if legacy != SC.NONE:
        return legacy
    return SC.POS_ONLY if is_kiosk else SC.KIOSK_ONLY


_READY: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


def tables_ready(db: Any) -> bool:
    """Whether `product_channel_overrides` exists (the in-memory test worlds of other features lack it)."""
    from app.models.product_channel_override import ProductChannelOverride

    try:
        engine = db.get_bind()
        engine = getattr(engine, "engine", engine)
    except Exception:  # noqa: BLE001 - an unbound session reads nothing
        return False
    known = _READY.get(engine)
    if known is None:
        from sqlalchemy import inspect as sa_inspect

        try:
            known = bool(sa_inspect(db.connection()).has_table(ProductChannelOverride.__tablename__))
        except Exception:  # noqa: BLE001
            known = False
        if known:
            _READY[engine] = True
    return bool(known)


def overrides_for(
    db: Any, product_ids: Sequence[Any], *, shop_id: Any = None, area_id: Any = None,
) -> Dict[str, List[Any]]:
    """`{str(product id): [exception rows]}` of this shop and point of sale (rows with `allowed` None included)."""
    from sqlalchemy import and_, or_

    from app.models.product_channel_override import ProductChannelOverride as O

    ids = [p for p in product_ids if p is not None]
    if not ids or (shop_id is None and area_id is None) or not tables_ready(db):
        return {}
    places = []
    if shop_id is not None:
        places.append(and_(O.level == SOURCE_SHOP, O.target_id == shop_id))
    if area_id is not None:
        places.append(and_(O.level == SOURCE_AREA, O.target_id == area_id))
    out: Dict[str, List[Any]] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        for row in db.query(O).filter(O.product_id.in_(chunk), or_(*places)).all():
            out.setdefault(str(row.product_id), []).append(row)
    return out


def changed_at(rows: Iterable[Any]) -> Optional[datetime]:
    stamps = []
    for r in rows or []:
        stamp = getattr(r, "updated_at", None)
        if isinstance(stamp, datetime):
            stamps.append(stamp if stamp.tzinfo is not None else stamp.replace(tzinfo=timezone.utc))
    return max(stamps) if stamps else None


def device_pair(code: Any, rows: Iterable[Any], *, shop_id: Any, area_id: Any) -> Tuple[bool, bool]:
    """The (tills, kiosks) pair for a device of this shop / point of sale."""
    pos, kiosk = pair_of(code)
    eff = resolve({POS: pos, KIOSK: kiosk}, rows, shop_id=shop_id, area_id=area_id)
    return (eff[POS].allowed, eff[KIOSK].allowed)


def project_rows(
    db: Any,
    machine: Any,
    rows: List[Dict[str, Any]],
    *,
    is_kiosk: Optional[bool] = None,
    overrides: Optional[Dict[str, List[Any]]] = None,
) -> List[Dict[str, Any]]:
    """
    The catalog rows as this device gets them: each `salesChannel` (the stored code) replaced by
    `device_code` for this device. Returns new dicts (a publication's rows are never mutated).
    Whether the device is a kiosk is asked only when some row needs it (a "neither" pair).
    """
    shop_id = getattr(machine, "shop_id", None)
    area_id = getattr(machine, "area_id", None)
    if overrides is None:
        gids = [r.get("globalProductId") for r in rows if r.get("globalProductId")]
        overrides = overrides_for(db, gids, shop_id=shop_id, area_id=area_id) if gids else {}
    kiosk_flag = is_kiosk
    out: List[Dict[str, Any]] = []
    for row in rows:
        code = row.get("salesChannel")
        own = overrides.get(str(row.get("globalProductId"))) if row.get("globalProductId") else None
        pair = device_pair(code, own, shop_id=shop_id, area_id=area_id) if own else pair_of(code)
        legacy = SC.code_of_pair(*pair)
        if legacy == SC.NONE and kiosk_flag is None:
            kiosk_flag = machine_is_kiosk(db, machine)
        value = device_code(code, bool(kiosk_flag), pair)
        out.append(row if value == code else {**row, "salesChannel": value})
    return out


def machine_is_kiosk(db: Any, machine: Any) -> bool:
    """A device converted to a self-order kiosk (and enabled as one); False where kiosks do not exist."""
    from sqlalchemy import inspect as sa_inspect

    from app.models.kiosk import KioskDevice

    try:
        if not sa_inspect(db.connection()).has_table(KioskDevice.__tablename__):
            return False
    except Exception:  # noqa: BLE001
        return False
    device = db.get(KioskDevice, machine.id)
    return device is not None and bool(device.enabled)


# ── The dashboard's list filters ─────────────────────────────────────────────


def condition(model: Any, channel: str, on: bool):
    """SQL: the product's own default for `channel` is on (`on`) / off."""
    from sqlalchemy import not_

    if channel == ONLINE:
        cond = model.channel_online.is_(True)
    elif channel == MENU:
        cond = model.channel_menu.is_(True)
    elif channel == POS:
        cond = model.sales_channel.in_([SC.ALL, SC.POS_ONLY])
    elif channel == KIOSK:
        cond = model.sales_channel.in_([SC.ALL, SC.KIOSK_ONLY])
    else:
        raise ValueError(channel)
    return cond if on else not_(cond)


def summary(channels: Mapping[str, bool]) -> str:
    """"קופה, קיוסק" — the channels that are on, in order (for audit notes)."""
    on = [LABELS_HE[c] for c in CHANNELS if channels.get(c)]
    return ", ".join(on) if on else "—"
