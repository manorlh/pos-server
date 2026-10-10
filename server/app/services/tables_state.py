"""
The tables' state version, its ETag, the per-shop snapshot cache and the coalesced realtime
signal ("סערת הערות", docs: P:/specs/performance-review-2026-10.md #3).

**Version.** `tables_state_versions.version` (app/models/tables_state.py) is raised once by
every write that changes what `GET /sync/{m}/tables` answers — the till writes and the
dashboard's layout edits (app/routers/tables.py `_changed`), the training mode's clean-up.
Read in one primary-key lookup.

**Tag.** A till's state is tagged `t<version>.<until>.<fingerprint>`:

* `version` — the shop's version the state was built at (read *before* it was built, so the
  state is never older than its tag);
* `until` — when the tag stops being honoured even though nothing was written: the first
  lock to run out (a lock ends by time alone) or `MAX_AGE` after the build, whichever is
  first. `MAX_AGE` also bounds what changes without a tables write (a parameter, a till
  renamed, a booking entering the window);
* `fingerprint` — the till itself (id, shop, point of sale, independence, LAN exclusion):
  another till's tag never matches.

A till that sends the tag back (`If-None-Match`, or `?since=`) while it is still good is
answered 304 / `{"syncType": "unchanged"}` without the state being built. A till that sends
nothing (every version before this) gets the full state as always.

**Snapshot.** The shop-wide part of the state (zones, tables, open orders, locks, bookings,
reasons) is kept per process for the shop's version, until the same `until`: after a write,
the tills that pull share one build instead of one each. The till's own part (its point of
sale, which lock is its own, its parameters, the LAN host) is composed per request
(app/services/tables.py `till_state`).

**Signal.** The writes of a shop within `NOTIFY_WINDOW` become one "tables" message carrying
the version, sent in ONE Ably request: the shop's channel (`pos:<tenant>:shop:<shop>`,
subscribe-only on every till's token) and — while `NOTIFY_DEVICE_CHANNELS` is on, for tills
that listen only on their own channel — each till's channel, in the same batch request. A
till that knows the version pulls only when it is behind.
"""
from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models.tables_state import TablesStateVersion

logger = logging.getLogger(__name__)


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default


def _env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw not in ("0", "false", "no", "off")


#: How long a tag (and the shop snapshot behind it) is honoured with no tables write.
MAX_AGE = timedelta(seconds=_env_float("TABLES_STATE_MAX_AGE_S", 30.0))
#: The writes of a shop within this window become one realtime signal. 0 = at once (tests).
NOTIFY_WINDOW_S = _env_float("TABLES_NOTIFY_WINDOW_MS", 300.0) / 1000.0
#: Also each till's own channel (in the same batch request), for tills that do not listen on
#: the shop channel yet. Switch off once every till runs a version that does.
NOTIFY_DEVICE_CHANNELS = _env_flag("TABLES_NOTIFY_DEVICE_CHANNELS", True)
#: Shops whose snapshot a process keeps (least recently used out).
SNAPSHOT_SHOPS = int(_env_float("TABLES_STATE_CACHE_SHOPS", 512))

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_BUILT_SLACK = timedelta(seconds=2)


def _utc(moment: datetime) -> datetime:
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _seconds(moment: datetime) -> int:
    return int((_utc(moment) - _EPOCH).total_seconds())


# ── The version ──────────────────────────────────────────────────────────────


def current_version(db: Session, shop_id: Any) -> int:
    """The shop's tables version (0 before its first write). One primary-key read."""
    if shop_id is None:
        return 0
    value = db.execute(
        select(TablesStateVersion.version).where(TablesStateVersion.shop_id == shop_id)
    ).scalar()
    return int(value or 0)


def bump(db: Session, shop_id: Any) -> int:
    """
    Raise the shop's version by one and return it (the caller commits). Written last in its
    transaction: the row lock is held only until the commit right after.
    """
    if shop_id is None:
        return 0
    now = datetime.now(timezone.utc)
    dialect = db.get_bind().dialect.name
    if dialect in ("postgresql", "sqlite"):
        if dialect == "postgresql":
            from sqlalchemy.dialects.postgresql import insert
        else:
            from sqlalchemy.dialects.sqlite import insert
        stmt = insert(TablesStateVersion).values(shop_id=shop_id, version=1, changed_at=now)
        stmt = stmt.on_conflict_do_update(
            index_elements=[TablesStateVersion.shop_id],
            set_={"version": TablesStateVersion.version + 1, "changed_at": now},
        )
        db.execute(stmt)
    else:  # pragma: no cover - any other database: update, else insert
        done = db.execute(
            update(TablesStateVersion)
            .where(TablesStateVersion.shop_id == shop_id)
            .values(version=TablesStateVersion.version + 1, changed_at=now)
            .execution_options(synchronize_session=False)
        )
        if not done.rowcount:
            db.add(TablesStateVersion(shop_id=shop_id, version=1, changed_at=now))
            db.flush()
    return current_version(db, shop_id)


def bump_tenant(db: Session, tenant_id: Any) -> None:
    """Every shop of a tenant (its cancellation reasons are tenant-wide)."""
    from app.models.shop import Shop

    if tenant_id is None:
        return
    for (shop_id,) in db.query(Shop.id).filter(Shop.tenant_id == tenant_id).all():
        bump(db, shop_id)


# ── The tag ──────────────────────────────────────────────────────────────────


def fingerprint(machine: Any) -> str:
    """What makes a till's state its own, from the machine row alone (no query)."""
    raw = "|".join(
        str(v)
        for v in (
            getattr(machine, "id", None),
            getattr(machine, "tenant_id", None),
            getattr(machine, "shop_id", None),
            getattr(machine, "area_id", None),
            bool(getattr(machine, "independent_till", False)),
            bool(getattr(machine, "lan_server_excluded", False)),
            getattr(machine, "is_active", None),
        )
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]


def make_tag(version: int, until: datetime, machine: Any) -> str:
    return f"t{int(version)}.{_seconds(until)}.{fingerprint(machine)}"


def parse_tags(header: Optional[str]) -> List[str]:
    """`If-None-Match` (one tag or several, quoted, weak or not) → the bare tags."""
    if not header:
        return []
    out = []
    for part in header.split(","):
        tag = part.strip()
        if tag.startswith("W/"):
            tag = tag[2:]
        tag = tag.strip().strip('"').strip()
        if tag and tag != "*":
            out.append(tag)
    return out


def tag_matches(tag: str, machine: Any, version: int, now: datetime) -> bool:
    """Whether the till's tag still describes the state it would be given now."""
    try:
        head, until, fp = tag.split(".")
        if not head.startswith("t"):
            return False
        tagged = int(head[1:])
        until_s = int(until)
    except (AttributeError, ValueError):
        return False
    return tagged == int(version) and fp == fingerprint(machine) and _seconds(now) < until_s


# ── The shop snapshot ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Snapshot:
    """The shop-wide part of the tills' state (app/services/tables.py builds and composes it)."""

    version: int
    built_at: datetime
    valid_until: datetime
    data: Any


class SnapshotCache:
    """Per process, per shop; thread-safe. One build per shop at a time (the others wait)."""

    def __init__(self, max_shops: int = SNAPSHOT_SHOPS):
        self._lock = threading.Lock()
        self._entries: "OrderedDict[Tuple[str, str], Snapshot]" = OrderedDict()
        self._building: Dict[Tuple[str, str], threading.Lock] = {}
        self.max_shops = max_shops
        self.builds = 0
        self.hits = 0

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._building.clear()

    def _fresh(self, key, version: int, now: datetime) -> Optional[Snapshot]:
        entry = self._entries.get(key)
        if entry is None or entry.version != version:
            return None
        # Only forward in time from its build (a request that began a moment before it was
        # built may share it), and never past its first lock's end.
        if not (_utc(entry.built_at) - _BUILT_SLACK <= _utc(now) < _utc(entry.valid_until)):
            return None
        self._entries.move_to_end(key)
        return entry

    def get(self, key: Tuple[str, str], version: int, now: datetime, build: Callable[[], Snapshot]) -> Snapshot:
        with self._lock:
            entry = self._fresh(key, version, now)
            if entry is not None:
                self.hits += 1
                return entry
            gate = self._building.setdefault(key, threading.Lock())
        with gate:
            with self._lock:
                entry = self._fresh(key, version, now)
                if entry is not None:
                    self.hits += 1
                    return entry
            entry = build()
            with self._lock:
                self.builds += 1
                current = self._entries.get(key)
                # Never replace a newer version another thread put meanwhile.
                if current is None or current.version <= entry.version:
                    self._entries[key] = entry
                    self._entries.move_to_end(key)
                while len(self._entries) > self.max_shops:
                    old, _ = self._entries.popitem(last=False)
                    self._building.pop(old, None)
            return entry


SNAPSHOTS = SnapshotCache()


# ── The coalesced signal ─────────────────────────────────────────────────────


NotifyTarget = Tuple[str, str]


@dataclass
class _Pending:
    tenant_id: str
    shop_id: str
    due: float
    version: Optional[int] = None
    table_ids: Set[Optional[str]] = field(default_factory=set)
    origins: Set[Optional[str]] = field(default_factory=set)
    targets: List[NotifyTarget] = field(default_factory=list)


def signal_body(version: Optional[int], shop_id: Optional[str], table_ids: Iterable[Optional[str]]) -> Dict[str, Any]:
    """
    The "tables" message: `serverTime` (as always), `tableId` when exactly one table changed
    (as always), and now `version` (the shop's, to compare with the till's), `shopId` and
    `tableIds`. A message without `version` (an older server) means: pull.
    """
    from app.services.ably_notify import _notify_base

    body = _notify_base()
    ids = sorted({t for t in table_ids if t})
    whole = any(t is None for t in table_ids)
    if len(ids) == 1 and not whole:
        body["tableId"] = ids[0]
    if ids:
        body["tableIds"] = ids
    if version is not None:
        body["version"] = int(version)
    if shop_id:
        body["shopId"] = str(shop_id)
    return body


def channels_for(
    tenant_id: str,
    shop_id: Optional[str],
    targets: Sequence[NotifyTarget],
    *,
    origins: Iterable[Optional[str]] = (),
    device_channels: Optional[bool] = None,
) -> List[str]:
    """The shop channel, and (legacy) every till's own — but the one till that made every change."""
    from app.services.ably_notify import machine_channel, shop_channel

    out: List[str] = []
    if shop_id and tenant_id:
        out.append(shop_channel(str(tenant_id), str(shop_id)))
    if NOTIFY_DEVICE_CHANNELS if device_channels is None else device_channels:
        sources = {str(o) for o in origins if o}
        sole = next(iter(sources)) if len(sources) == 1 and None not in set(origins) else None
        for t_tenant, machine_id in targets:
            if sole is not None and str(machine_id) == sole:
                continue
            out.append(machine_channel(str(t_tenant), str(machine_id)))
    return out


class TablesNotifier:
    """
    Collects a shop's changes for `NOTIFY_WINDOW_S` and sends them as one message, in one
    Ably request, from a background thread. Best effort, like every wake-up: a till that
    misses it sees the change at its next poll.
    """

    def __init__(self, publish: Optional[Callable[[List[str], Dict[str, Any]], None]] = None):
        self._cv = threading.Condition()
        self._pending: Dict[str, _Pending] = {}
        self._thread: Optional[threading.Thread] = None
        self._publish = publish
        self.sent = 0

    def changed(
        self,
        *,
        tenant_id: Any,
        shop_id: Any,
        version: Optional[int],
        table_id: Optional[str] = None,
        origin: Optional[str] = None,
        targets: Sequence[NotifyTarget] = (),
        window: Optional[float] = None,
    ) -> None:
        if shop_id is None or tenant_id is None:
            return
        window = NOTIFY_WINDOW_S if window is None else window
        key = str(shop_id)
        if window <= 0:
            self._send(_Pending(
                tenant_id=str(tenant_id), shop_id=key, due=0.0, version=version,
                table_ids={table_id}, origins={origin}, targets=list(targets),
            ))
            return
        with self._cv:
            pending = self._pending.get(key)
            if pending is None:
                pending = _Pending(tenant_id=str(tenant_id), shop_id=key, due=time.monotonic() + window)
                self._pending[key] = pending
            if version is not None:
                pending.version = max(pending.version or 0, int(version))
            pending.table_ids.add(table_id)
            pending.origins.add(origin)
            if targets:
                pending.targets = list(targets)
            self._ensure_thread()
            self._cv.notify()

    def flush(self) -> None:
        """Send everything pending now (tests, shutdown)."""
        with self._cv:
            due = list(self._pending.values())
            self._pending.clear()
        for pending in due:
            self._send(pending)

    def _ensure_thread(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="tables-notify", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while True:
            with self._cv:
                while not self._pending:
                    self._cv.wait()
                now = time.monotonic()
                first = min(p.due for p in self._pending.values())
                if first > now:
                    self._cv.wait(first - now)
                    continue
                ready = [p for p in self._pending.values() if p.due <= now]
                for p in ready:
                    self._pending.pop(p.shop_id, None)
            for pending in ready:
                self._send(pending)

    def _send(self, pending: _Pending) -> None:
        try:
            channels = channels_for(
                pending.tenant_id, pending.shop_id, pending.targets, origins=pending.origins,
            )
            body = signal_body(pending.version, pending.shop_id, pending.table_ids)
            if channels:
                (self._publish or _publish_batch)(channels, body)
                self.sent += 1
        except Exception:  # noqa: BLE001 - a wake-up is never worth failing anything
            logger.exception("tables signal failed for shop %s", pending.shop_id)


def _publish_batch(channels: List[str], body: Dict[str, Any]) -> None:
    from app.services import ably_notify
    from app.services.tables import NOTIFY_EVENT

    ably_notify.publish_batch(channels, NOTIFY_EVENT, body)


NOTIFIER = TablesNotifier()
