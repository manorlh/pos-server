"""
"מצב סנכרון של מכשיר" — the cloud's current version of everything a till pulls
(P:/specs/device-sync-status.md §5.1, §5.2).

**Keys.** A key is one thing the till pulls and reports (`syncState`): `catalog`, `menu`,
`vouchers` (one catalog pull), `parameters`, `settings`, `settings.design`, `settings.display`
(the settings domain: three pulls), `users`, `tables`, `promotions`, `media`. A domain of the
spec's §1 is one key or several (`DOMAINS`).

**Versions.** Each pull answers `X-Sync-Version: <key>=<version>[, …]` — the version of all this
machine should hold after it, worked out *before* the body is built. The same function gives the
dashboard the current version to compare with what the till reported, so the two always agree:

* a timestamp (`stamp`) — the newest change of what the till is sent: `catalog`, `menu`,
  `vouchers`, `settings`, `users`;
* the endpoint's own ETag, bare — `parameters`, `settings.design`, `settings.display`; the
  promotions' `etag`;
* a hash — `tables` (the floor plan only: zones, tables, sketch, table types — never orders or
  locks), `media` (the customer display's file URLs, in order).

Opaque to the till: it stores and echoes. Equal (after `normalize`) is up to date.

**Cost.** `VersionContext` computes a key once per machine and request, and shares the tenant-
and shop-level reads of the catalog between the machines of one request. The tables' hash is
kept per process for the shop's tables version (`TABLES_CACHE_S`).
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

HEADER = "X-Sync-Version"

#: Every key, in the order the header lists them.
KEYS: Tuple[str, ...] = (
    "catalog", "menu", "vouchers", "parameters", "settings", "settings.design", "settings.display",
    "users", "tables", "promotions", "media",
)

#: The spec's domains (§1), in the dashboard's order: (domain, Hebrew, its keys).
DOMAINS: Tuple[Tuple[str, str, Tuple[str, ...]], ...] = (
    ("catalog", "קטלוג", ("catalog",)),
    ("parameters", "פרמטרים", ("parameters",)),
    ("settings", "הגדרות", ("settings", "settings.design", "settings.display")),
    ("users", "עובדים", ("users",)),
    ("tables", "שולחנות", ("tables",)),
    ("menu", "תוספות ושלבי הגשה", ("menu",)),
    ("promotions", "מבצעים", ("promotions",)),
    ("vouchers", "שוברים", ("vouchers",)),
    ("media", "מדיה למסך לקוח", ("media",)),
)
DOMAIN_OF_KEY: Dict[str, str] = {key: domain for domain, _, keys in DOMAINS for key in keys}
DOMAIN_LABELS: Dict[str, str] = {domain: label for domain, label, _ in DOMAINS}
KEY_LABELS: Dict[str, str] = {
    **{key: DOMAIN_LABELS[DOMAIN_OF_KEY[key]] for key in KEYS},
    "settings.design": "עיצוב קופה",
    "settings.display": "מסך לקוח",
}

#: The version of something a machine has none of (no shop, no tenant): stable, never a moment.
NONE = "none"


@dataclass(frozen=True)
class CloudVersion:
    """A key's current version, and when the cloud last changed it (None: not known)."""

    version: str
    changed_at: Optional[datetime] = None


# ── Formats ──────────────────────────────────────────────────────────────────


def utc(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def stamp(moment: Optional[datetime]) -> str:
    """A timestamp version: ISO-8601 in UTC, whatever zone the driver read it in; `NONE` for none."""
    moment = utc(moment)
    return moment.isoformat() if moment is not None else NONE


def latest(points: Iterable[Optional[datetime]]) -> Optional[datetime]:
    values = [utc(p) for p in points if isinstance(p, datetime)]
    return max(values) if values else None


def bare_etag(etag: Optional[str]) -> str:
    """An ETag without its quotes (or `W/`): what goes in the header and what is compared."""
    return normalize(etag) or NONE


def normalize(version: Any) -> str:
    """A version as compared: no surrounding spaces, quotes or weak prefix."""
    if version is None:
        return ""
    text = str(version).strip()
    if text.startswith("W/"):
        text = text[2:].strip()
    return text.strip('"').strip()


def header_value(versions: Mapping[str, Any]) -> str:
    """`catalog=…, menu=…` — keys in `KEYS` order, a `CloudVersion` or a plain string each."""
    parts = []
    for key in sorted(versions, key=lambda k: KEYS.index(k) if k in KEYS else len(KEYS)):
        value = versions[key]
        version = value.version if isinstance(value, CloudVersion) else value
        parts.append(f"{key}={normalize(version) or NONE}")
    return ", ".join(parts)


def parse_header(value: Optional[str]) -> Dict[str, str]:
    """The header read back (the till's side; the tests)."""
    out: Dict[str, str] = {}
    for part in (value or "").split(","):
        key, sep, version = part.strip().partition("=")
        if sep and key.strip():
            out[key.strip()] = version.strip()
    return out


def set_header(response: Any, versions: Mapping[str, Any]) -> None:
    """Put `X-Sync-Version` on `response` (a Starlette Response, or None when called directly)."""
    if response is None or not versions:
        return
    try:
        response.headers[HEADER] = header_value(versions)
    except Exception:  # noqa: BLE001 - a header never fails a pull
        logger.exception("X-Sync-Version not set")


def _hash(payload: Any, size: int = 24) -> str:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:size]


# ── Catalog, menu, vouchers (one pull: GET /sync/{m}/catalog) ────────────────


#: The catalog points the publication stands for in a shop that reviews menu changes before they
#: reach its tills (docs/SPEC_MENU_BROADCAST_REVIEW.md): the tills get its latest broadcast, not the
#: draft, so the draft's edits change nothing they hold. What stays live is the till's own.
_REVIEW_PUBLISHED_POINTS = ("products", "shop_overrides", "categories", "company_availability")


def _publication_stamp(db: Session, machine: Any, memo: Optional[Dict[Any, Any]]) -> Optional[datetime]:
    """The broadcast this till's shop serves, when it reviews menu changes; None for a live shop."""
    if machine.shop_id is None or machine.tenant_id is None:
        return None
    from app.services.sync import _memo

    def read() -> Optional[datetime]:
        from app.models.shop import Shop
        from app.services import menu_broadcast

        if not menu_broadcast.tables_ready(db):
            return None
        shop = db.query(Shop).filter(Shop.id == machine.shop_id).first()
        if shop is None or not menu_broadcast.review_state(db, shop).enabled:
            return None
        publication = menu_broadcast.latest_publication(db, shop.id)
        return utc(publication.published_at) if publication is not None else None

    return _memo(memo, ("publication", machine.shop_id), read)


def catalog_versions(db: Session, machine: Any, memo: Optional[Dict[Any, Any]] = None) -> Dict[str, CloudVersion]:
    """`catalog`, `menu` and `vouchers` — the catalog pull's three keys."""
    from app.services.sync import MENU_POINTS, VOUCHER_POINTS, catalog_change_points

    points = catalog_change_points(db, machine, memo)
    if not points:
        none = CloudVersion(NONE)
        return {"catalog": none, "menu": none, "vouchers": none}
    published = _publication_stamp(db, machine, memo)
    own = {k: v for k, v in points.items() if k not in MENU_POINTS and k not in VOUCHER_POINTS}
    if published is not None:
        own = {k: v for k, v in own.items() if k not in _REVIEW_PUBLISHED_POINTS}
        own["publication"] = published
        menu_at = published
    else:
        menu_at = latest(points.get(k) for k in MENU_POINTS)
    catalog_at = latest(own.values())
    vouchers_at = latest(points.get(k) for k in VOUCHER_POINTS)
    return {
        "catalog": CloudVersion(stamp(catalog_at), catalog_at),
        "menu": CloudVersion(stamp(menu_at), menu_at),
        "vouchers": CloudVersion(stamp(vouchers_at), vouchers_at),
    }


# ── Parameters (GET /sync/{m}/parameters) ────────────────────────────────────


def parameters_answer(
    db: Session, machine: Any, resolve: Optional[Callable[[Session, Any], Any]] = None,
) -> Tuple[Any, Dict[str, Any], str]:
    """
    The parameters pull's answer: (the response model, its JSON, its ETag with quotes). The ETag
    is a hash of the resolved map and the catalog view — a deleted value or a deactivated
    parameter changes it too, which a timestamp would miss. `resolve`: the till's parameters
    (the router passes its own `till_parameters_for_machine`).
    """
    from app.schemas.till_parameter import TillParametersSyncResponse
    from app.services import item_block_control
    from app.services.catalog_admin import view_for_machine

    if resolve is None:
        from app.services.till_parameters import till_parameters_for_machine as resolve

    resolved = resolve(db, machine)
    # "חסימות מהקופה" (P:/specs/item-block-control.md §6): the till's role and caps, worked out here —
    # the one object in the map (the till keeps it as JSON, as it keeps `catalogAdminView`).
    parameters = {
        **resolved.parameters,
        item_block_control.SETTINGS_KEY: item_block_control.till_out(db, machine, resolved.parameters),
    }
    body = TillParametersSyncResponse(
        parameters=parameters,
        updated_at=resolved.updated_at,
        # "ניהול קטלוג מהקופה": what the till's catalog screen shows (specs/till-catalog-management.md §6.1).
        catalog_admin_view=view_for_machine(db, machine, resolved.parameters),
    )
    payload = body.model_dump(mode="json", by_alias=True)
    # The catalog view too: a menu assigned or cleared changes it with no parameter changing.
    hashed = {"parameters": payload["parameters"], "catalogAdminView": payload.get("catalogAdminView")}
    etag = '"' + hashlib.sha1(
        json.dumps(hashed, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    ).hexdigest() + '"'
    return body, payload, etag


def parameters_version(db: Session, machine: Any) -> CloudVersion:
    body, _, etag = parameters_answer(db, machine)
    return CloudVersion(bare_etag(etag), utc(body.updated_at))


# ── Settings: the settings, the till's design, its customer display ──────────


def settings_version(db: Session, machine: Any) -> CloudVersion:
    """`settings`: the settings pull's watermark (`settingsUpdatedAt`)."""
    from app.routers.sync import settings_basis

    basis = settings_basis(db, machine, datetime.now(timezone.utc))
    if basis.shop is None:
        return CloudVersion(NONE)
    return CloudVersion(stamp(basis.watermark), utc(basis.watermark))


def design_version(db: Session, machine: Any, bundle: Optional[Dict[str, Any]] = None) -> CloudVersion:
    """`settings.design`: the till design's ETag."""
    from app.services import till_design as design

    bundle = bundle if bundle is not None else design.sync_bundle(db, machine)
    changed = None
    raw = bundle.get("updatedAt")
    if isinstance(raw, str):
        try:
            changed = utc(datetime.fromisoformat(raw.replace("Z", "+00:00")))
        except ValueError:
            changed = None
    return CloudVersion(bare_etag(design.bundle_etag(bundle)), changed)


def media_hash(payload: Dict[str, Any]) -> str:
    """`media`: the customer display's files, by URL, in order (each upload has a URL of its own)."""
    urls = [m.get("url") for m in (payload.get("media") or []) if isinstance(m, dict) and m.get("url")]
    return _hash(urls) if urls else NONE


def display_versions(db: Session, machine: Any, payload: Optional[Dict[str, Any]] = None) -> Dict[str, CloudVersion]:
    """`settings.display` (the customer display's ETag) and `media` — one pull."""
    from app.services import customer_display as CD

    payload = payload if payload is not None else CD.device_payload(db, machine)
    return {
        "settings.display": CloudVersion(bare_etag(CD.etag_of(payload))),
        "media": CloudVersion(media_hash(payload)),
    }


# ── Users (GET /sync/{m}/pos-users) ──────────────────────────────────────────


def users_version(db: Session, machine: Any) -> CloudVersion:
    """`users`: the newest change among the shop's till users (a role's change restamps its users)."""
    from app.models.pos_user import PosUser

    if machine.shop_id is None:
        return CloudVersion(NONE)
    changed = utc(db.query(func.max(PosUser.updated_at)).filter(PosUser.shop_id == machine.shop_id).scalar())
    return CloudVersion(stamp(changed), changed)


# ── Tables (GET /sync/{m}/tables) ────────────────────────────────────────────

#: How long a shop's floor-plan hash is kept for its tables version (a layout edit raises it).
TABLES_CACHE_S = 60.0
_TABLES_CACHE: "OrderedDict[Tuple[str, int], Tuple[float, CloudVersion]]" = OrderedDict()
_TABLES_LOCK = threading.Lock()
_TABLES_CACHE_MAX = 512


def _num(value: Any) -> Any:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return str(value)


def tables_layout(db: Session, shop_id: Any) -> CloudVersion:
    """The shop's floor plan, hashed: live zones (with their sketch), tables and table types."""
    from app.models.tables import DiningTable, TableType, TableZone

    zones = (
        db.query(TableZone)
        .filter(TableZone.shop_id == shop_id, TableZone.archived_at.is_(None))
        .order_by(TableZone.id)
        .all()
    )
    tables = (
        db.query(DiningTable)
        .filter(DiningTable.shop_id == shop_id, DiningTable.archived_at.is_(None))
        .order_by(DiningTable.id)
        .all()
    )
    types = (
        db.query(TableType)
        .filter(TableType.shop_id == shop_id, TableType.archived_at.is_(None))
        .order_by(TableType.id)
        .all()
    )
    if not zones and not tables and not types:
        return CloudVersion(NONE)
    plan = {
        "zones": [
            [str(z.id), str(z.area_id) if z.area_id else None, z.name, z.sort_order, z.layout, z.background_url,
             z.canvas_width, z.canvas_height, z.sketch]
            for z in zones
        ],
        "tables": [
            [str(t.id), str(t.zone_id), t.number, t.name, t.seats, t.shape, _num(t.x), _num(t.y), _num(t.width),
             _num(t.height), t.rotation, t.kind, _num(t.discount_percent), str(t.type_id) if t.type_id else None,
             bool(t.label_only)]
            for t in tables
        ],
        "types": [
            [str(t.id), t.name, t.kind, _num(t.discount_percent), bool(t.require_approval), bool(t.require_reason),
             t.staff_mode, _num(t.staff_allowance), t.sort_order]
            for t in types
        ],
    }
    changed = latest([z.updated_at for z in zones] + [t.updated_at for t in types] + [t.updated_at for t in tables])
    return CloudVersion(_hash(plan), changed)


def tables_version(db: Session, machine: Any, version: Optional[int] = None) -> CloudVersion:
    """`tables`: the floor plan's hash, kept per (shop, tables version) for `TABLES_CACHE_S`."""
    if machine.shop_id is None:
        return CloudVersion(NONE)
    if version is None:
        from app.services import tables_state as TS

        version = TS.current_version(db, machine.shop_id)
    key = (str(machine.shop_id), int(version or 0))
    now = time.monotonic()
    with _TABLES_LOCK:
        held = _TABLES_CACHE.get(key)
        if held is not None and now - held[0] < TABLES_CACHE_S:
            _TABLES_CACHE.move_to_end(key)
            return held[1]
    value = tables_layout(db, machine.shop_id)
    with _TABLES_LOCK:
        _TABLES_CACHE[key] = (now, value)
        _TABLES_CACHE.move_to_end(key)
        while len(_TABLES_CACHE) > _TABLES_CACHE_MAX:
            _TABLES_CACHE.popitem(last=False)
    return value


def clear_tables_cache() -> None:
    with _TABLES_LOCK:
        _TABLES_CACHE.clear()


# ── Promotions (GET /sync/{m}/promotions) ────────────────────────────────────


def promotions_version(db: Session, machine: Any) -> CloudVersion:
    """`promotions`: the pull's own `etag`."""
    from app.services import promotions as P

    return CloudVersion(P.payload_etag(P.promotions_for_machine(db, machine)))


# ── Per request ──────────────────────────────────────────────────────────────


class VersionContext:
    """
    The current versions for one request: each key computed at most once per machine, the
    catalog's tenant- and shop-level reads shared between machines. A key that cannot be worked
    out (an error) is None — "unknown", never a failure of the page asking.
    """

    def __init__(self, db: Session):
        self.db = db
        self.memo: Dict[Any, Any] = {}
        self._versions: Dict[Tuple[str, str], Optional[CloudVersion]] = {}

    def get(self, machine: Any, key: str) -> Optional[CloudVersion]:
        slot = (str(machine.id), key)
        if slot not in self._versions:
            for k, v in self._compute(machine, key).items():
                self._versions[(str(machine.id), k)] = v
            self._versions.setdefault(slot, None)
        return self._versions[slot]

    def _compute(self, machine: Any, key: str) -> Dict[str, Optional[CloudVersion]]:
        db = self.db
        readers: Dict[str, Callable[[], Dict[str, CloudVersion]]] = {
            "catalog": lambda: catalog_versions(db, machine, self.memo),
            "menu": lambda: catalog_versions(db, machine, self.memo),
            "vouchers": lambda: catalog_versions(db, machine, self.memo),
            "parameters": lambda: {"parameters": parameters_version(db, machine)},
            "settings": lambda: {"settings": settings_version(db, machine)},
            "settings.design": lambda: {"settings.design": design_version(db, machine)},
            "settings.display": lambda: display_versions(db, machine),
            "media": lambda: display_versions(db, machine),
            "users": lambda: {"users": users_version(db, machine)},
            "tables": lambda: {"tables": tables_version(db, machine)},
            "promotions": lambda: {"promotions": promotions_version(db, machine)},
        }
        read = readers.get(key)
        if read is None:
            return {key: None}
        try:
            with db.begin_nested():
                return dict(read())
        except Exception:  # noqa: BLE001 - one key that cannot be read is "unknown", never the page
            logger.exception("sync version %s failed for machine %s", key, getattr(machine, "id", None))
            return {key: None}

    def many(self, machine: Any, keys: Iterable[str]) -> Dict[str, Optional[CloudVersion]]:
        return {key: self.get(machine, key) for key in keys}


def all_versions(db: Session, machine: Any, keys: Optional[List[str]] = None) -> Dict[str, Optional[CloudVersion]]:
    """Every key's current version for one machine (the tests; a support read)."""
    return VersionContext(db).many(machine, keys or list(KEYS))
