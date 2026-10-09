"""
The kitchen engine's golden scenarios (docs/SPEC_LAN_MODE.md §7, docs/SPEC_KDS.md §10).

`tests/fixtures/kds_engine_golden.json` — byte-identical in pos-android's
`app/src/test/resources/` — is a corpus of scenarios built from tests/test_kds.py (and a few
that let time pass): each step (a release, a screen action, time passing, a configuration
change) with what the cloud engine (`app/services/kds.py`) answers after it — the step's own
answer, the board of every screen role, the pickup board, the till's badges and the outbox
events. tests/test_kds_golden.py replays it against the Python engine; the Kotlin engine of
the main till (P1) will replay the same file. Two engines, one behaviour.

**Deterministic without touching the engine.** The harness substitutes the engine's clock
(`app.services.kds._now`) and `uuid.uuid4` while a scenario runs, and stamps the KDS rows'
`created_at` / `updated_at` from the same clock (an ORM hook — the columns' database
defaults would read the wall clock). Every step happens one second after the previous one,
plus what an `advance` step adds.

**Normalised.** What another engine cannot reproduce byte for byte is written so it can:

* times are `T+<seconds>s` from the scenario's start (`T0`), in steps and in answers;
* ids the engine makes are symbols by kind, numbered by first appearance in a walk of the
  step's answers in a fixed order — the step's answer, the boards (in `views` order), the
  pickup board, the badges, the events — each object's keys in sorted order: `order#1`,
  `task#2`, `change#1`, `group#1`, `event#1`; ids inside strings too (`ReadyForPickup:group#1`);
* the world's ids (stations, products, categories, the shop) are its symbols (`station:grill`);
* left out: the `device`, `display` and `scope` blocks of a board — they are changing in the
  KDS screens branch (the screen's look, the board's scope) and are not the engine;
* a view equal to the same view after the previous step is the string `"unchanged"`.

**Extending it** (after the screens branch merges, or whenever the engine learns something):
add scenarios to `SCENARIOS` below — steps refer to what earlier answers named with
selectors (`Task("steak")`, `Order("ref")`, `Change("cancel", on="grill_screen")`), which
the writer resolves to symbols — then regenerate both copies and the pinned SHA-256:

    cd server && PYTHONUTF8=1 PYTHONPATH=.;tests KDS_GOLDEN_WRITE=1 \
        python -m pytest tests/test_kds_golden.py -k regenerate -q -s

and copy the printed SHA-256 into `GOLDEN_SHA256` here and in pos-android's
`KdsEngineGoldenTest`. To cover the ready orders / board scope of the screens branch, drop the
block from `DROPPED` (or normalise it) and add scenarios that read it. A scenario that
changes today's behaviour is a decision, not a fixture update: say so in docs/SPEC_KDS.md.
"""
from __future__ import annotations

import copy
import itertools
import json
import re
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import event

FIXTURE = Path(__file__).parent / "fixtures" / "kds_engine_golden.json"
FORMAT = "kds-golden/1"
T0 = datetime(2026, 10, 7, 9, 0, tzinfo=timezone.utc)
#: Every step is this much after the previous one (plus an `advance`).
TICK = timedelta(seconds=1)
#: Board blocks the screens branch is changing: never compared.
DROPPED = ("device", "display", "scope")

UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)?$")
T_RE = re.compile(r"^T([+-])(\d+(?:\.\d+)?)s$")

# ── The world ────────────────────────────────────────────────────────────────

#: Fixed ids, so another engine sorts as this one does (a task's station is part of its order).
WORLD: Dict[str, Any] = {
    "timezone": "Asia/Jerusalem",
    "shops": {"shop": {"name": "Center"}, "other_shop": {"name": "North"}},
    "categories": {
        "food": {"id": "c0000000-0000-4000-8000-000000000001", "name": "Food", "parent": None},
        "drinks": {"id": "c0000000-0000-4000-8000-000000000002", "name": "Drinks", "parent": None},
        "mains": {"id": "c0000000-0000-4000-8000-000000000003", "name": "Mains", "parent": "food"},
    },
    "products": {
        "steak": {"id": "d0000000-0000-4000-8000-000000000001", "name": "steak", "category": "mains"},
        "cola": {"id": "d0000000-0000-4000-8000-000000000002", "name": "cola", "category": "drinks"},
        "salad": {"id": "d0000000-0000-4000-8000-000000000003", "name": "salad", "category": "food"},
    },
    "stations": {
        "grill": {"id": "e0000000-0000-4000-8000-000000000001", "name": "גריל"},
        "bar": {"id": "e0000000-0000-4000-8000-000000000002", "name": "בר"},
    },
    #: The kitchen printers' routing, shared with the KDS (category → station).
    "routes": [
        {"targetType": "category", "target": "mains", "station": "grill"},
        {"targetType": "category", "target": "drinks", "station": "bar"},
    ],
    #: The tills that release: the shop's till 1 (register 1, no document prefix of its own),
    #: and a till of another shop.
    "tills": {
        "waiter": {"shop": "shop", "posNumber": "1", "documentPrefix": None},
        "other_till": {"shop": "other_shop", "posNumber": "1", "documentPrefix": None},
    },
    #: The screens (`kds_devices`).
    "devices": {
        "grill_screen": {"shop": "shop", "role": "station", "stations": ["grill"],
                         "id": "f0000000-0000-4000-8000-000000000001"},
        "bar_screen": {"shop": "shop", "role": "station", "stations": ["bar"],
                       "id": "f0000000-0000-4000-8000-000000000002"},
        "expo_screen": {"shop": "shop", "role": "expo", "stations": [],
                        "id": "f0000000-0000-4000-8000-000000000003"},
        "pickup_screen": {"shop": "shop", "role": "pickup", "stations": [],
                          "id": "f0000000-0000-4000-8000-000000000004"},
        "north_screen": {"shop": "other_shop", "role": "expo", "stations": [],
                         "id": "f0000000-0000-4000-8000-000000000005"},
    },
    #: The shop's workflow (till parameters at the shop's level, docs/SPEC_KDS.md §1.1).
    "config": {
        "enabled": True, "defaultMode": "ORDER_PROCESS", "allowedModes": ["ORDER_PROCESS"],
        "targets": ["printer", "kds", "expo", "pickup_screen"], "readyNotification": True,
    },
}

DEFAULT_VIEWS = ["grill_screen", "bar_screen", "expo_screen"]


@dataclass
class Built:
    """The world in a test database: symbols ↔ rows."""

    w: Any
    machines: Dict[str, Any]
    ids: Dict[str, str] = field(default_factory=dict)  # real id → symbol


def build_world(w) -> Built:
    """`w`: tests/shift_world.py's world (tenant, the two shops, till 1, North 1, the admin)."""
    from app.models.category import Category
    from app.models.pos_machine import PairingStatus, POSMachine
    from app.models.printers import KitchenStation, KitchenStationTarget
    from app.models.product import Product
    from app.routers import kds as R
    from app.schemas.kds import KdsDeviceIn
    from test_shop_areas import _ctx

    db = w.db
    shops = {"shop": w.shop, "other_shop": w.other_shop}
    built = Built(w=w, machines={"waiter": w.tills[0], "other_till": w.other_till})
    built.ids[str(w.shop.id)] = "shop"
    built.ids[str(w.other_shop.id)] = "other_shop"
    for name, c in WORLD["categories"].items():
        parent = WORLD["categories"][c["parent"]]["id"] if c["parent"] else None
        db.add(Category(id=uuid.UUID(c["id"]), tenant_id=w.tenant.id, name=c["name"],
                        parent_id=uuid.UUID(parent) if parent else None))
        db.flush()
        built.ids[c["id"]] = f"category:{name}"
    for name, p in WORLD["products"].items():
        db.add(Product(
            id=uuid.UUID(p["id"]), tenant_id=w.tenant.id, company_id=w.company.id,
            category_id=uuid.UUID(WORLD["categories"][p["category"]]["id"]),
            name=p["name"], price=Decimal("10.00"), sku=f"sku-{name}",
        ))
        built.ids[p["id"]] = f"product:{name}"
    for i, (name, s) in enumerate(WORLD["stations"].items()):
        db.add(KitchenStation(id=uuid.UUID(s["id"]), tenant_id=w.tenant.id, name=s["name"], sort_order=i))
        built.ids[s["id"]] = f"station:{name}"
    db.flush()
    for r in WORLD["routes"]:
        _route(built, r["targetType"], r["target"], r["station"])
    for name, d in WORLD["devices"].items():
        shop = shops[d["shop"]]
        m = POSMachine(
            id=uuid.UUID(d["id"]), tenant_id=w.tenant.id, shop_id=shop.id, distributor_id=w.admin.id,
            name=name, machine_code=f"KDS-{d['id'][-4:]}", pos_number=str(90 + int(d["id"][-1])),
            is_active=True, pairing_status=PairingStatus.ASSIGNED,
        )
        db.add(m)
        db.flush()
        built.machines[name] = m
        built.ids[d["id"]] = f"machine:{name}"
        R.put_kds_device(
            shop.id, m.id,
            KdsDeviceIn(role=d["role"], stationIds=[uuid.UUID(WORLD["stations"][s]["id"]) for s in d["stations"]],
                        name=f"{d['role']} screen"),
            **_ctx(w),
        )
    built.ids[str(w.tills[0].id)] = "machine:waiter"
    built.ids[str(w.other_till.id)] = "machine:other_till"
    db.commit()
    _configure(built, WORLD["config"])
    return built


def _route(built: Built, target_type: str, target: str, station: str) -> None:
    from app.models.printers import KitchenStationTarget

    table = "categories" if target_type == "category" else "products"
    target_id = uuid.UUID(WORLD[table][target]["id"])
    db = built.w.db
    db.query(KitchenStationTarget).filter(
        KitchenStationTarget.target_type == target_type, KitchenStationTarget.target_id == target_id,
    ).delete(synchronize_session=False)
    db.add(KitchenStationTarget(
        target_type=target_type, target_id=target_id, tenant_id=built.w.tenant.id,
        station_id=uuid.UUID(WORLD["stations"][station]["id"]),
    ))
    db.commit()


def _configure(built: Built, values: Dict[str, Any]) -> None:
    from app.routers import kds as R
    from app.schemas.kds import WorkflowValuesIn
    from test_shop_areas import _ctx

    tasks = BackgroundTasks()
    R.put_workflow_config(WorkflowValuesIn(scopeType="shop", scopeId=built.w.shop.id, values=values), tasks,
                          **_ctx(built.w))
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


# ── Selectors: what a step names from earlier answers ─────────────────────────


@dataclass(frozen=True)
class Order:
    """The kitchen order of the release whose `sourceRef` is `ref`."""
    ref: str
    source: Optional[str] = None


@dataclass(frozen=True)
class Task:
    """A task by its name (the `nth` one, oldest first), optionally of a round."""
    name: str
    nth: int = 0
    round: Optional[int] = None


@dataclass(frozen=True)
class Change:
    """The first change of `kind` not acknowledged yet."""
    kind: str


@dataclass(frozen=True)
class Event:
    """An outbox event by type (the `nth`, oldest first)."""
    type: str
    nth: int = 0


# ── Normalising ───────────────────────────────────────────────────────────────


class Symbols:
    def __init__(self, world_ids: Dict[str, str]):
        self.of: Dict[str, str] = {k.lower(): v for k, v in world_ids.items()}
        self.real: Dict[str, str] = {v: k for k, v in self.of.items()}
        self.counts: Dict[str, int] = {}

    def symbol(self, raw: str, kind: str) -> str:
        key = raw.lower()
        if key not in self.of:
            n = self.counts.get(kind, 0) + 1
            self.counts[kind] = n
            sym = f"{kind}#{n}"
            self.of[key] = sym
            self.real[sym] = key
        return self.of[key]


#: A key's id is of this kind.
KEY_KINDS = {
    "orderId": "order", "taskId": "task", "linkedTaskId": "task", "changeId": "change",
    "groupId": "group", "readyEventId": "event", "aggregate": "group", "stationId": "station",
    "productId": "product", "shopId": "shop",
}


def _kind_of_object(obj: Dict[str, Any]) -> str:
    if "tasks" in obj and "groupState" in obj:
        return "order"
    if "lineKey" in obj and "orderedQty" in obj:
        return "task"
    if "requiresAck" in obj and "kind" in obj:
        return "change"
    return "id"


class Clock:
    def __init__(self) -> None:
        self.now = T0

    def t(self, moment: datetime) -> str:
        delta = (moment - T0).total_seconds()
        sign = "+" if delta >= 0 else "-"
        delta = abs(delta)
        text = str(int(delta)) if float(delta).is_integer() else f"{delta:.3f}".rstrip("0")
        return f"T{sign}{text}s"

    def parse(self, text: str) -> datetime:
        m = T_RE.match(text)
        if not m:
            raise ValueError(text)
        seconds = float(m.group(2)) * (1 if m.group(1) == "+" else -1)
        return T0 + timedelta(seconds=seconds)


def normalize(value: Any, symbols: Symbols, clock: Clock, key: Optional[str] = None,
              kind_hint: Optional[str] = None) -> Any:
    """The comparable form: symbols for ids, `T±s` for times, no screens-branch blocks."""
    if isinstance(value, dict):
        own = _kind_of_object(value)
        out = {}
        for k in sorted(value):
            if k in DROPPED:
                continue
            v = value[k]
            hint = own if k == "id" else KEY_KINDS.get(k)
            nk = k
            if UUID_RE.fullmatch(k or ""):
                nk = symbols.symbol(k, "station")  # stationSettings: by station
            out[nk] = normalize(v, symbols, clock, k, hint)
        return out
    if isinstance(value, list):
        return [normalize(v, symbols, clock, key, kind_hint) for v in value]
    if isinstance(value, float) and value.is_integer():
        return value
    if isinstance(value, str):
        if UUID_RE.fullmatch(value):
            return symbols.symbol(value, kind_hint or "id")
        if ISO_RE.match(value):
            moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if moment.tzinfo is None:
                moment = moment.replace(tzinfo=timezone.utc)
            return clock.t(moment)
        if UUID_RE.search(value):
            return UUID_RE.sub(lambda m: symbols.symbol(m.group(0), kind_hint or "group"), value)
    return value


def denormalize(value: Any, symbols: Symbols, clock: Clock) -> Any:
    """A step's body as the engine takes it: symbols back to ids, `T±s` back to times."""
    if isinstance(value, dict):
        return {k: denormalize(v, symbols, clock) for k, v in value.items()}
    if isinstance(value, list):
        return [denormalize(v, symbols, clock) for v in value]
    if isinstance(value, str):
        if value in symbols.real:
            return str(uuid.UUID(symbols.real[value]))
        if T_RE.match(value):
            return clock.parse(value).isoformat()
    return value


# ── Running a scenario ────────────────────────────────────────────────────────


@contextmanager
def engine_patched(clock: Clock, monkeypatch):
    """The engine's clock and ids are the harness's; the KDS rows' stamps follow the clock."""
    from app.models import kds as M
    from app.models.outbox import OutboxEvent
    from app.services import kds as KDS

    counter = itertools.count(1)
    monkeypatch.setattr(KDS, "_now", lambda: clock.now)
    monkeypatch.setattr(uuid, "uuid4", lambda: uuid.UUID(f"00000000-0000-4000-8000-{next(counter):012x}"))

    classes = (M.KitchenOrder, M.KitchenTask, M.KitchenChange, M.FulfillmentGroup, M.KitchenDispatch,
               M.KitchenAction, M.KdsShopState, M.KdsDevice, M.KdsStationSetting, OutboxEvent)

    def on_insert(_mapper, _conn, target):
        for col in ("created_at", "updated_at", "available_at"):
            if hasattr(target, col) and getattr(target, col, None) is None:
                setattr(target, col, clock.now)

    def on_update(_mapper, _conn, target):
        if hasattr(target, "updated_at"):
            target.updated_at = clock.now

    for cls in classes:
        event.listen(cls, "before_insert", on_insert)
        event.listen(cls, "before_update", on_update)
    try:
        yield
    finally:
        for cls in classes:
            event.remove(cls, "before_insert", on_insert)
            event.remove(cls, "before_update", on_update)


class Runner:
    def __init__(self, built: Built, views: List[str]):
        self.built = built
        self.db = built.w.db
        self.clock = Clock()
        self.symbols = Symbols(built.ids)
        self.views = views
        self.previous: Dict[str, Any] = {}
        self.refs: Dict[str, List[str]] = {}

    # The selectors, resolved against the database (writing only): their symbols.
    def resolve(self, value: Any) -> Any:
        from app.models.kds import KitchenChange, KitchenOrder, KitchenTask
        from app.models.outbox import OutboxEvent

        if isinstance(value, dict):
            return {k: self.resolve(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self.resolve(v) for v in value]
        if isinstance(value, Order):
            q = self.db.query(KitchenOrder).filter(KitchenOrder.source_ref == value.ref)
            if value.source:
                q = q.filter(KitchenOrder.source == value.source)
            return self.symbols.symbol(str(q.one().id), "order")
        if isinstance(value, Task):
            q = self.db.query(KitchenTask).filter(KitchenTask.name == value.name)
            if value.round is not None:
                q = q.filter(KitchenTask.round_no == value.round)
            rows = sorted(q.all(), key=lambda t: (t.created_at, t.round_no, t.id))
            return self.symbols.symbol(str(rows[value.nth].id), "task")
        if isinstance(value, Change):
            rows = (
                self.db.query(KitchenChange)
                .filter(KitchenChange.kind == value.kind, KitchenChange.acked_at.is_(None))
                .all()
            )
            rows.sort(key=lambda c: (c.created_at, c.id))
            return self.symbols.symbol(str(rows[0].id), "change")
        if isinstance(value, Event):
            rows = self.db.query(OutboxEvent).filter(OutboxEvent.event_type == value.type).all()
            rows.sort(key=lambda e: (e.created_at, e.id))
            return f"{value.type}:{self.symbols.symbol(rows[value.nth].aggregate_id, 'group')}"
        return value

    def body(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        return denormalize(raw, self.symbols, self.clock)

    def run_step(self, step: Dict[str, Any]) -> Dict[str, Any]:
        """Apply one (normalised) step; its expectations, normalised."""
        from app.models.outbox import OutboxEvent
        from app.routers import kds as R
        from app.schemas.kds import KdsActionIn, KdsReleaseIn, KdsRouteOverrideIn
        from test_shop_areas import _ctx

        kind = step["do"]
        if kind == "advance":
            self.clock.now += timedelta(seconds=step["seconds"])
        else:
            self.clock.now += TICK
        machines = self.built.machines
        result: Any = None
        try:
            if kind == "advance":
                pass  # only the clock moves: what the windows show after it
            elif kind == "release":
                till = machines[step["till"]]
                body = self.body(step["body"])
                self.refs.setdefault(body["source"], [])
                if body["sourceRef"] not in self.refs[body["source"]]:
                    self.refs[body["source"]].append(body["sourceRef"])
                result = R.post_kds_release(str(till.id), KdsReleaseIn.model_validate(body), machine=till, db=self.db)
            elif kind == "action":
                screen = machines[step["device"]]
                result = R.post_kds_action(str(screen.id), KdsActionIn.model_validate(self.body(step["body"])),
                                           machine=screen, db=self.db)
            elif kind == "board":
                screen = machines[step["device"]]
                result = R.get_kds_board(str(screen.id), since=step.get("since"), machine=screen, db=self.db)
            elif kind == "configure":
                _configure(self.built, step["values"])
            elif kind == "station_setting":
                R.put_kds_station(self.built.w.shop.id, uuid.UUID(WORLD["stations"][step["station"]]["id"]),
                                  R.KdsStationSettingIn(targetKind=step["targetKind"]), **_ctx(self.built.w))
            elif kind == "route":
                _route(self.built, step["targetType"], step["target"], step["station"])
            elif kind == "override":
                table = "categories" if step["targetType"] == "category" else "products"
                R.post_kds_override(self.built.w.shop.id, KdsRouteOverrideIn(
                    targetType=step["targetType"], targetId=uuid.UUID(WORLD[table][step["target"]]["id"]),
                    stationId=uuid.UUID(WORLD["stations"][step["station"]]["id"]),
                    serviceType=step.get("serviceType"),
                ), **_ctx(self.built.w))
            elif kind == "rename_product":
                from app.models.product import Product

                self.db.get(Product, uuid.UUID(WORLD["products"][step["product"]]["id"])).name = step["name"]
                self.db.commit()
            elif kind == "till_prefix":
                machines[step["till"]].document_prefix = step["prefix"]
                self.db.commit()
            elif kind == "outbox":
                # A consumer (the messages service) took the event: what follows depends on it.
                etype, sym = step["dedupeKey"].split(":", 1)
                aggregate = str(uuid.UUID(self.symbols.real[sym]))
                row = (
                    self.db.query(OutboxEvent)
                    .filter(OutboxEvent.event_type == etype, OutboxEvent.aggregate_id == aggregate)
                    .one()
                )
                row.state = step["state"]
                self.db.commit()
            else:  # pragma: no cover - a corpus this harness does not know
                raise AssertionError(f"unknown step {kind!r}")
        except HTTPException as e:
            self.db.rollback()
            detail = e.detail
            code = detail.get("code") if isinstance(detail, dict) else detail
            result = {"error": {"status": e.status_code, "code": code}}
        return self.expectations(result)

    def expectations(self, result: Any) -> Dict[str, Any]:
        from app.models.outbox import OutboxEvent
        from app.routers import kds as R
        from app.services import kds as KDS

        machines = self.built.machines
        out: Dict[str, Any] = {}
        out["result"] = normalize(result, self.symbols, self.clock) if result is not None else None
        views: Dict[str, Any] = {}
        boards = {}
        for name in self.views:
            try:
                b = R.get_kds_board(str(machines[name].id), since=None, machine=machines[name], db=self.db)
            except HTTPException as e:
                self.db.rollback()
                b = {"error": {"status": e.status_code, "code": e.detail.get("code") if isinstance(e.detail, dict) else e.detail}}
            boards[name] = normalize(b, self.symbols, self.clock)
        views["boards"] = boards
        views["pickup"] = normalize(KDS.pickup_board(self.db, self.built.w.shop.id), self.symbols, self.clock)
        waiter = machines["waiter"]
        badges = {}
        for source in sorted(self.refs):
            refs = sorted(self.refs[source])
            badges[source] = normalize(
                R.get_kds_order_states(str(waiter.id), source=source, refs=",".join(refs), machine=waiter, db=self.db),
                self.symbols, self.clock,
            )
        views["badges"] = badges
        events = []
        for e in sorted(self.db.query(OutboxEvent).all(), key=lambda e: (e.created_at, e.id)):
            events.append(normalize({
                "type": e.event_type, "aggregateType": e.aggregate_type, "aggregate": e.aggregate_id,
                "aggregateVersion": e.aggregate_version, "dedupeKey": e.dedupe_key, "state": e.state,
                "result": e.result, "occurredAt": e.occurred_at.isoformat() if e.occurred_at else None,
                "payload": e.payload,
            }, self.symbols, self.clock))
        views["events"] = events
        # The boards one by one, so a single screen's change shows as that screen alone.
        for name, b in boards.items():
            key = f"boards.{name}"
            if self.previous.get(key) == b:
                boards[name] = "unchanged"
            else:
                self.previous[key] = copy.deepcopy(b)
        for key in ("pickup", "badges", "events"):
            if self.previous.get(key) == views[key]:
                views[key] = "unchanged"
            else:
                self.previous[key] = copy.deepcopy(views[key])
        out.update(views)
        return out


def write_step(runner: Runner, step: Dict[str, Any]) -> Dict[str, Any]:
    """A scenario definition's step, its selectors resolved to symbols."""
    resolved = runner.resolve(step)
    return json.loads(json.dumps(resolved, ensure_ascii=False))


# ── The scenarios (from tests/test_kds.py; and time passing) ───────────────────


def item(line: str, product: str, qty: float = 1.0, **over) -> Dict[str, Any]:
    p = WORLD["products"][product]
    base = {
        "lineKey": line, "productId": f"product:{product}", "categoryId": f"category:{p['category']}",
        "name": p["name"], "quantity": qty,
    }
    base.update(over)
    return base


_ids = itertools.count(1)


def rel(ref="order-1", items=(), till="waiter", rid=None, source="table", **over) -> Dict[str, Any]:
    body = {
        "id": rid or f"dispatch-{next(_ids):04d}", "source": source, "sourceRef": ref, "trigger": "send",
        "displayRef": "שולחן 12", "items": list(items),
    }
    body.update(over)
    return {"do": "release", "till": till, "body": body}


def act(device: str, type_: str, aid=None, **fields) -> Dict[str, Any]:
    body = {"id": aid or f"action-{next(_ids):04d}", "type": type_}
    body.update(fields)
    return {"do": "action", "device": device, "body": body}


def configure(**values) -> Dict[str, Any]:
    return {"do": "configure", "values": values}


def advance(seconds: int) -> Dict[str, Any]:
    return {"do": "advance", "seconds": seconds}


def paid_quick(ref, items, **over):
    return rel(ref=ref, items=items, source="quick", paid=True, trigger="payment", **over)


def paid_kiosk(ref, items, **over):
    return rel(ref=ref, items=items, source="kiosk", paid=True, trigger="payment", **over)


T = "test_kds.py::"


def _scenarios() -> List[Dict[str, Any]]:
    s: List[Dict[str, Any]] = []

    def add(name, origin, steps, views=None):
        s.append({"name": name, "from": origin, "views": views or DEFAULT_VIEWS, "steps": steps})

    # §36.1 Idempotency and isolation
    add("a retried release creates no second task", T + "TestIdempotency::test_a_retried_release_creates_no_second_task", [
        rel(rid="dispatch-retry-1", items=[item("l1:0", "steak", 2), item("l2:0", "cola")]),
        rel(rid="dispatch-retry-1", items=[item("l1:0", "steak", 2), item("l2:0", "cola")]),
    ])
    add("a retried action is applied once", T + "TestIdempotency::test_a_retried_action_is_applied_once", [
        rel(items=[item("l1:0", "steak", 3)]),
        act("grill_screen", "item_ready", aid="action-retry-1", taskId=Task("steak"), qty=1),
        act("grill_screen", "item_ready", aid="action-retry-1", taskId=Task("steak"), qty=1),
    ])
    add("two screens marking the same unit prepare it once",
        T + "TestIdempotency::test_two_screens_marking_the_same_unit_prepare_it_once", [
            rel(items=[item("l1:0", "steak", 1)]),
            act("grill_screen", "item_ready", taskId=Task("steak")),
            act("expo_screen", "item_ready", taskId=Task("steak")),
        ])
    add("another shop's screen neither sees nor touches it, and its till cannot add to it",
        T + "TestIdempotency::test_another_shops_till_neither_sees_nor_touches_it", [
            rel(items=[item("l1:0", "steak")]),
            act("north_screen", "start", taskId=Task("steak")),
            rel(till="other_till", items=[item("x:0", "steak")]),
        ], views=DEFAULT_VIEWS + ["north_screen"])
    add("a till that is not a screen gets no board",
        T + "TestIdempotency::test_a_till_that_is_not_a_kds_screen_gets_no_board", [
            {"do": "board", "device": "waiter"},
        ])
    add("a station screen acts only on its station",
        T + "TestIdempotency::test_a_station_screen_acts_only_on_its_station", [
            rel(items=[item("l2:0", "cola")]),
            act("grill_screen", "start", taskId=Task("cola")),
            act("pickup_screen", "start", taskId=Task("cola")),
        ])
    # §36.2 Readiness
    add("one station ready is not the order ready", T + "TestReadiness::test_one_station_ready_is_not_the_order_ready", [
        rel(items=[item("l1:0", "steak"), item("l2:0", "cola")]),
        act("grill_screen", "station_ready", orderId=Order("order-1")),
        act("bar_screen", "station_ready", orderId=Order("order-1")),
    ])
    add("a view-only station never blocks", T + "TestReadiness::test_a_view_only_station_never_blocks", [
        {"do": "station_setting", "station": "bar", "targetKind": "view"},
        rel(items=[item("l1:0", "steak"), item("l2:0", "cola")]),
        act("grill_screen", "station_ready", orderId=Order("order-1")),
    ])
    add("with the Expo required only the Expo sets it ready",
        T + "TestReadiness::test_with_expo_required_only_the_expo_sets_it_ready", [
            configure(requireExpo=True),
            rel(ref="order-x", items=[item("l1:0", "steak"), item("l2:0", "cola")]),
            act("grill_screen", "station_ready", orderId=Order("order-x")),
            act("expo_screen", "ready_for_pickup", orderId=Order("order-x")),
            act("bar_screen", "station_ready", orderId=Order("order-x")),
            act("expo_screen", "ready_for_pickup", orderId=Order("order-x")),
            act("grill_screen", "ready_for_pickup", orderId=Order("order-x")),
        ])
    add("an override needs a reason and is recorded", T + "TestReadiness::test_an_override_needs_a_reason_and_is_recorded", [
        configure(requireExpo=True),
        rel(items=[item("l1:0", "steak"), item("l2:0", "cola")]),
        act("expo_screen", "ready_for_pickup", orderId=Order("order-1"), override=True),
        act("expo_screen", "ready_for_pickup", orderId=Order("order-1"), override=True, reason="לקוח ממהר"),
    ])
    add("require start refuses ready before start", T + "TestReadiness::test_require_start_refuses_ready_before_start", [
        configure(requireStartPreparation=True),
        rel(ref="o-s", items=[item("l1:0", "steak")]),
        act("grill_screen", "item_ready", taskId=Task("steak")),
        act("grill_screen", "start", taskId=Task("steak")),
        act("grill_screen", "item_ready", taskId=Task("steak")),
    ])
    # §36.3 / §36.4 The ready event
    ready = [
        paid_quick("o-1", [item("l1:0", "steak")], contactPhone="+972501234567", pickupName="דנה"),
        act("grill_screen", "item_ready", taskId=Task("steak")),
    ]
    add("one event with a minimal payload", T + "TestReadyEvent::test_one_event_with_a_minimal_payload", list(ready))
    add("undo then ready again re-arms the same event",
        T + "TestReadyEvent::test_undo_then_ready_again_re_arms_the_same_event", list(ready) + [
            act("grill_screen", "undo_ready", taskId=Task("steak")),
            act("grill_screen", "item_ready", taskId=Task("steak")),
        ])
    add("after a consumer took it, undo and ready make no second ready event",
        T + "TestReadyEvent::test_after_a_consumer_took_it_undo_and_ready_make_no_second_ready_event", list(ready) + [
            {"do": "outbox", "dedupeKey": Event("ReadyForPickup"), "state": "processing"},
            act("grill_screen", "undo_ready", taskId=Task("steak")),
            act("grill_screen", "item_ready", taskId=Task("steak")),
        ])
    add("a handover before the consumer suppresses it",
        T + "TestReadyEvent::test_handover_before_the_consumer_suppresses_it", list(ready) + [
            act("expo_screen", "handover", orderId=Order("o-1")),
        ])
    add("a handover after the consumer took it writes a follow-up",
        T + "TestReadyEvent::test_handover_after_the_consumer_took_it_writes_a_follow_up", list(ready) + [
            {"do": "outbox", "dedupeKey": Event("ReadyForPickup"), "state": "processed"},
            act("expo_screen", "handover", orderId=Order("o-1")),
        ])
    add("a cancellation before the consumer suppresses it",
        T + "TestReadyEvent::test_a_cancellation_before_the_consumer_suppresses_it", [
            paid_quick("o-c", [item("l1:0", "steak")], contactPhone="+972501234567", pickupName="דנה"),
            act("grill_screen", "item_ready", taskId=Task("steak")),
            rel(ref="o-c", source="quick", trigger="cancel", paid=True, items=[]),
        ])
    add("a double tap on ready for pickup is one event",
        T + "TestReadyEvent::test_a_double_tap_on_ready_for_pickup_is_one_event", [
            configure(requireExpo=True),
            rel(ref="dbl", items=[item("l1:0", "steak")]),
            act("grill_screen", "station_ready", orderId=Order("dbl")),
            act("expo_screen", "ready_for_pickup", orderId=Order("dbl")),
            act("expo_screen", "ready_for_pickup", orderId=Order("dbl")),
        ])
    # §36.8 Offline actions never revive a cancellation
    add("a late ready acts on the active quantity only",
        T + "TestOfflineActions::test_a_late_ready_acts_on_the_active_quantity_only", [
            rel(ref="o-2", items=[item("l1:0", "steak", 2)]),
            rel(ref="o-2", items=[item("l1:0", "steak", -1)]),
            act("grill_screen", "item_ready", taskId=Task("steak"), qty=2, occurredAt="T+8s"),
        ])
    add("a fully cancelled task stays cancelled", T + "TestOfflineActions::test_a_fully_cancelled_task_stays_cancelled", [
        rel(ref="o-3", items=[item("l1:0", "steak", 1)]),
        rel(ref="o-3", items=[item("l1:0", "steak", -1)]),
        act("grill_screen", "item_ready", taskId=Task("steak")),
    ])
    add("prepared before the cancellation is recorded, not revived",
        T + "TestOfflineActions::test_prepared_before_the_cancellation_is_recorded_not_revived", [
            rel(ref="o-4", items=[item("l1:0", "steak", 1)]),
            advance(60),
            rel(ref="o-4", items=[item("l1:0", "steak", -1)]),
            act("grill_screen", "item_ready", taskId=Task("steak"), qty=1, occurredAt="T+30s"),
        ])
    # §36.21 Fallback printer reconciliation
    add("a fallback round is reconciled, not prepared twice",
        T + "TestFallback::test_a_fallback_round_is_reconciled_not_prepared_twice", [
            rel(ref="fb", fallbackPrinted=True, items=[item("l1:0", "steak", 2)]),
            act("grill_screen", "resolve_fallback", taskId=Task("steak"), resolution="prepared"),
            act("grill_screen", "resolve_fallback", taskId=Task("steak"), resolution="prepared"),
        ])
    add("to prepare keeps it in the queue", T + "TestFallback::test_to_prepare_keeps_it_in_the_queue", [
        rel(ref="fb2", fallbackPrinted=True, items=[item("l1:0", "steak")]),
        act("grill_screen", "resolve_fallback", taskId=Task("steak"), resolution="prepare"),
    ])
    add("a retry after a lost answer and a fallback print flags the round",
        T + "TestFallback::test_a_retry_after_a_lost_answer_and_a_fallback_print_flags_the_round", [
            rel(rid="dispatch-fb3", ref="fb3", items=[item("l1:0", "steak")]),
            rel(rid="dispatch-fb3", ref="fb3", fallbackPrinted=True, items=[item("l1:0", "steak")]),
        ])
    # Rounds, changes, hold / fire
    add("more of a ready line is one new unit", T + "TestRoundsAndChanges::test_more_of_a_ready_line_is_one_new_unit", [
        rel(ref="r", items=[item("l1:0", "steak", 2)]),
        act("grill_screen", "station_ready", orderId=Order("r")),
        rel(ref="r", items=[item("l1:0", "steak", 1)]),
    ])
    add("a cancel waits for the station to see it", T + "TestRoundsAndChanges::test_a_cancel_waits_for_the_station_to_see_it", [
        rel(ref="c", items=[item("l1:0", "steak", 2)]),
        act("grill_screen", "start", taskId=Task("steak")),
        rel(ref="c", items=[item("l1:0", "steak", -2)]),
        act("grill_screen", "ack_change", changeId=Change("cancel")),
    ])
    add("a note change on a started dish needs a seen",
        T + "TestRoundsAndChanges::test_a_note_change_on_a_started_dish_needs_a_seen", [
            rel(ref="n", items=[item("l1:0", "steak")]),
            act("grill_screen", "start", taskId=Task("steak")),
            rel(ref="n", noteUpdates=[{"lineKey": "l1:0", "notes": "בלי מלח"}]),
            act("grill_screen", "ack_change", changeId=Change("note")),
        ])
    add("a held course shows apart and is released without duplicates",
        T + "TestRoundsAndChanges::test_held_course_shows_apart_and_is_released_without_duplicates", [
            rel(ref="h", items=[item("l1:0", "salad")], held=[item("l2:0", "steak", 2, course="עיקריות")]),
            rel(ref="h", items=[item("l2:0", "steak", 2, course="עיקריות")], held=[]),
        ])
    add("a held line does not block the order", T + "TestRoundsAndChanges::test_a_held_line_does_not_block_the_order", [
        rel(ref="h2", items=[item("l1:0", "cola")], held=[item("l2:0", "steak")]),
        act("bar_screen", "station_ready", orderId=Order("h2")),
    ])
    add("remake is a linked task with a reason", T + "TestRoundsAndChanges::test_remake_is_a_linked_task_with_a_reason", [
        rel(ref="rm", items=[item("l1:0", "steak")]),
        act("grill_screen", "station_ready", orderId=Order("rm")),
        act("grill_screen", "remake", taskId=Task("steak")),
        act("grill_screen", "remake", taskId=Task("steak"), reason="נשרף"),
    ])
    # Routing
    add("a product beats its category and unrouted is kept",
        T + "TestRouting::test_product_beats_category_and_unrouted_is_kept", [
            {"do": "route", "targetType": "product", "target": "steak", "station": "bar"},
            rel(ref="rt", items=[item("l1:0", "steak"), item("l3:0", "salad")]),
        ])
    add("an override by service type", T + "TestRouting::test_an_override_by_service_type", [
        {"do": "override", "targetType": "category", "target": "mains", "station": "bar", "serviceType": "take_away"},
        rel(ref="e", serviceType="eat_in", items=[item("l1:0", "steak")]),
        rel(ref="a", serviceType="take_away", items=[item("l1:0", "steak")]),
    ])
    add("names and modifiers are a snapshot", T + "TestRouting::test_names_and_modifiers_are_a_snapshot", [
        rel(ref="snap", items=[item("l1:0", "steak", mods=["מדיום"], removals=["בלי בצל"], allergies=["בוטנים"])]),
        {"do": "rename_product", "product": "steak", "name": "renamed"},
    ])
    # Release rules (§5)
    add("a quick sale waits for its payment by default",
        T + "TestReleaseRules::test_a_quick_sale_waits_for_its_payment_by_default", [
            rel(ref="q1", source="quick", items=[item("l1:0", "steak")]),
            paid_quick("q1", [item("l1:0", "steak")]),
        ])
    add("before payment when the policy says so", T + "TestReleaseRules::test_before_payment_when_the_policy_says_so", [
        configure(paymentPolicy="BEFORE_PAYMENT"),
        rel(ref="q2", source="quick", items=[item("l1:0", "steak")]),
        paid_quick("q2", []),
    ])
    add("a kiosk order only after payment and without acceptance",
        T + "TestReleaseRules::test_a_kiosk_order_only_after_payment_and_without_acceptance", [
            rel(ref="k1", source="kiosk", items=[item("l1:0", "steak")]),
            paid_kiosk("k1", [item("l1:0", "steak")]),
        ])
    add("cancelling an order the kitchen never had records nothing",
        T + "TestReleaseRules::test_cancelling_an_order_the_kitchen_never_had_records_nothing", [
            rel(ref="never", trigger="cancel", items=[]),
        ])
    add("the card shows the number as the till printed it",
        T + "TestReleaseRules::test_the_card_shows_the_number_as_the_till_printed_it", [
            {"do": "till_prefix", "till": "waiter", "prefix": "4"},
            paid_quick("d1", [item("l1:0", "steak")], displayRef=None, transactionNumber="57"),
            paid_quick("d2", [item("l1:0", "steak")], displayRef=None, transactionNumber="40000058"),
        ])
    add("pickup numbers count per shop", T + "TestReleaseRules::test_pickup_numbers_count_per_shop", [
        paid_kiosk("k1", [item("l1:0", "steak")]),
        paid_kiosk("k2", [item("l1:0", "steak")]),
    ])
    # The pickup screen
    add("the pickup screen shows numbers only", T + "TestPickupScreen::test_numbers_only", [
        paid_kiosk("p1", [item("l1:0", "steak")], pickupName="דנה", contactPhone="+972501111111", orderNote="אלרגיה"),
        rel(ref="t1", items=[item("l1:0", "steak")]),
        act("grill_screen", "station_ready", orderId=Order("p1")),
        act("expo_screen", "handover", orderId=Order("p1")),
        act("expo_screen", "undo_pickup", orderId=Order("p1")),
    ])
    add("unchanged since the screen's version", T + "TestPickupScreen::test_unchanged_since_the_screens_version", [
        {"do": "board", "device": "grill_screen", "since": 1},
        rel(ref="v", items=[item("l1:0", "steak")]),
        {"do": "board", "device": "grill_screen", "since": 1},
    ])
    add("the till's badges by source ref", "test_kds.py::TestTillBadges::test_order_states_by_source_ref", [
        rel(ref="tb", items=[item("l1:0", "steak"), item("l2:0", "cola")]),
        act("grill_screen", "station_ready", orderId=Order("tb")),
    ])
    # Time passing (the engine's windows, app/services/kds.py)
    add("a ready task stays on its station three minutes", "kds.py RECENT_READY", [
        rel(ref="w1", items=[item("l1:0", "steak"), item("l2:0", "cola")]),
        act("grill_screen", "item_ready", taskId=Task("steak")),
        advance(177),
        advance(4),
    ])
    add("a handed over order stays on the Expo five minutes", "kds.py RECENT_HANDOVER", [
        paid_kiosk("w2", [item("l1:0", "steak")]),
        act("grill_screen", "station_ready", orderId=Order("w2")),
        act("expo_screen", "handover", orderId=Order("w2")),
        advance(298),
        advance(3),
    ], views=["expo_screen"])
    add("without handover tracking a ready number leaves the pickup screen after 15 minutes",
        "kds.py PICKUP_READY_TTL", [
            configure(trackHandover=False),
            paid_kiosk("w3", [item("l1:0", "steak")]),
            act("grill_screen", "station_ready", orderId=Order("w3")),
            advance(899),
            advance(2),
        ], views=["expo_screen"])
    add("direct sale with a screen is view only and leaves after 30 minutes", "kds.py VIEW_TTL, SPEC_KDS §1.6", [
        configure(defaultMode="DIRECT_SALE", allowedModes=["DIRECT_SALE"], targets=["printer", "kds"],
                  readyNotification=False),
        paid_quick("w4", [item("l1:0", "steak")]),
        advance(1797),
        advance(4),
    ], views=["grill_screen", "expo_screen"])
    add("direct sale with the printer only records the snapshot and no task", "SPEC_KDS §1.6", [
        configure(defaultMode="DIRECT_SALE", allowedModes=["DIRECT_SALE"], targets=["printer"],
                  readyNotification=False),
        paid_quick("w5", [item("l1:0", "steak")]),
    ])
    add("the next business day starts the pickup numbers again and the old orders leave",
        "kds.py BOARD_WINDOW, next_pickup_number", [
            paid_kiosk("d-1", [item("l1:0", "steak")]),
            advance(25 * 3600),
            paid_kiosk("d-2", [item("l1:0", "steak")]),
        ])
    return s


SCENARIOS = _scenarios()


def generate(world_builder: Callable[[], Built], monkeypatch_factory: Callable[[], Any]) -> Dict[str, Any]:
    """The corpus: every scenario run in a fresh world, its steps and what followed each."""
    scenarios = []
    for scenario in SCENARIOS:
        built = world_builder()
        runner = Runner(built, scenario["views"])
        mp = monkeypatch_factory()
        steps = []
        try:
            with engine_patched(runner.clock, mp):
                for definition in scenario["steps"]:
                    step = write_step(runner, definition)
                    expect = runner.run_step(step)
                    steps.append({**step, "expect": expect})
        finally:
            mp.undo()
        scenarios.append({"name": scenario["name"], "from": scenario["from"], "views": scenario["views"],
                          "steps": steps})
    return {
        "format": FORMAT,
        "about": (
            "The cloud kitchen engine's behaviour (pos-server app/services/kds.py) as golden scenarios: "
            "steps and, after each, the answer, the boards per screen role, the pickup board, the till's "
            "badges and the outbox events. Shared byte for byte with pos-android; see server/tests/kds_golden.py."
        ),
        "t0": T0.isoformat(),
        "tickSeconds": int(TICK.total_seconds()),
        "dropped": list(DROPPED),
        "world": WORLD,
        "scenarios": scenarios,
    }


def dumps(corpus: Dict[str, Any]) -> str:
    return json.dumps(corpus, ensure_ascii=False, indent=1, sort_keys=False) + "\n"


def replay(corpus_scenario: Dict[str, Any], built: Built, monkeypatch) -> List[Tuple[int, str, Any, Any]]:
    """Run a stored scenario; every (step, view, expected, actual) that differs."""
    runner = Runner(built, corpus_scenario["views"])
    diffs = []
    with engine_patched(runner.clock, monkeypatch):
        for i, step in enumerate(corpus_scenario["steps"]):
            definition = {k: v for k, v in step.items() if k != "expect"}
            actual = runner.run_step(definition)
            expected = step["expect"]
            for view in sorted(set(expected) | set(actual)):
                if view == "boards":
                    for name in sorted(set(expected.get("boards") or {}) | set(actual.get("boards") or {})):
                        e = (expected.get("boards") or {}).get(name)
                        a = (actual.get("boards") or {}).get(name)
                        if e != a:
                            diffs.append((i, f"boards.{name}", e, a))
                elif expected.get(view) != actual.get(view):
                    diffs.append((i, view, expected.get(view), actual.get(view)))
    return diffs


def fresh_world(monkeypatch):
    """tests/test_shop_areas.py's world, as its `w` fixture makes it (no pytest needed)."""
    from app.models.shop_register_sequence import ShopRegisterSequence
    from app.services import ably_notify
    from shift_world import accept_str_uuids, freeze_z_run_clock, make_world

    accept_str_uuids(monkeypatch)
    freeze_z_run_clock(monkeypatch)
    world = make_world()
    for shop in (world.shop, world.other_shop):
        world.db.add(ShopRegisterSequence(shop_id=shop.id, next_value=10))
    for name in ("publish_settings_notify", "publish_notify", "publish_close_shift_notify"):
        monkeypatch.setattr(ably_notify, name, lambda *a, **k: None)
    world.db.commit()
    return world
