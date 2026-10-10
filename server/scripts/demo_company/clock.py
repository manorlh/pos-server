"""
The simulation's clock — every place the product reads "now" reads this one.

Two kinds of "now" exist in the server, and both are moved here:

1. **Python.** Every service reads `datetime.now(timezone.utc)` through its own module's
   `datetime` name (the tests freeze a module by replacing that name with a subclass whose
   `now()` is the world's clock — tests/shift_world.py `freeze_z_run_clock`). `install()`
   does exactly that for every loaded `app.*` module at once (and `date.today()` likewise).
   The subclass's metaclass keeps `isinstance(x, datetime)` true for real datetimes, so a
   value read from the database still is a `datetime` to the code.

   Some product code reads `datetime` with a function-local import instead (`from datetime
   import datetime as _dt` inside the heartbeat handler, for `reported_open_shift_claimed_at`) —
   a name the module patch cannot reach. `install()` therefore also hooks `builtins.__import__`:
   an `import datetime` / `from datetime import …` statement executed by a module of `app` gets
   a copy of the `datetime` module whose `datetime` / `date` are the simulation's. Nothing outside
   `app` is touched, and `uninstall()` removes the hook.

2. **The database.** About 300 columns are filled by Postgres itself (`server_default=now()`)
   or stamped by SQLAlchemy as SQL (`onupdate=func.now()`): `transactions.server_received_at`,
   `z_reports.created_at`, `pos_machines.created_at`… Left alone they would read the real
   date while every document is dated September — and the product compares them (a document
   "issued before its till was paired", a document "received after its Z"). Two engine hooks
   give them the simulation's clock instead:
   * `before_execute`: an INSERT that leaves such a column to the database gets the clock's
     value for it (single-row `.values()`, and every row of an executemany);
   * `before_cursor_execute`: the SQL function `now()` in a statement (the `onupdate`
     stamps) becomes the clock's moment as a literal.

Nothing else is changed: no row is written here, no figure is computed here.
"""
from __future__ import annotations

import builtins
import datetime as _dt
import re
import sys
import types
from typing import Dict, List, Optional

_REAL_DATETIME = _dt.datetime
_REAL_DATE = _dt.date
UTC = _dt.timezone.utc


class SimClock:
    """A clock that only moves forward, set by the simulation."""

    def __init__(self, start: _dt.datetime):
        if start.tzinfo is None:
            raise ValueError("the clock is timezone-aware")
        self._now = start.astimezone(UTC)
        self.installed = False

    def now(self) -> _dt.datetime:
        return self._now

    def set(self, moment: _dt.datetime) -> None:
        """Move to `moment` (never backwards: the product's "now" never goes back)."""
        moment = moment.astimezone(UTC)
        if moment < self._now:
            raise RuntimeError(f"clock would go back: {self._now.isoformat()} -> {moment.isoformat()}")
        self._now = moment

    def advance(self, **delta) -> _dt.datetime:
        self.set(self._now + _dt.timedelta(**delta))
        return self._now


CLOCK: Optional[SimClock] = None


class _DatetimeMeta(type):
    def __instancecheck__(cls, obj):
        return isinstance(obj, _REAL_DATETIME)

    def __subclasscheck__(cls, sub):
        return issubclass(sub, _REAL_DATETIME)


class SimDatetime(_REAL_DATETIME, metaclass=_DatetimeMeta):
    """`datetime` whose `now()` / `utcnow()` / `today()` read the simulation clock."""

    @classmethod
    def now(cls, tz=None):
        moment = CLOCK.now() if CLOCK is not None else _REAL_DATETIME.now(UTC)
        if tz is None:
            # The process's local wall time, naive — what the real `now()` returns.
            return _REAL_DATETIME.fromtimestamp(moment.timestamp())
        return moment.astimezone(tz)

    @classmethod
    def utcnow(cls):
        return cls.now(UTC).replace(tzinfo=None)

    @classmethod
    def today(cls):
        return cls.now()


class _DateMeta(type):
    def __instancecheck__(cls, obj):
        return isinstance(obj, _REAL_DATE)

    def __subclasscheck__(cls, sub):
        return issubclass(sub, _REAL_DATE)


class SimDate(_REAL_DATE, metaclass=_DateMeta):
    @classmethod
    def today(cls):
        return SimDatetime.now().date()


_patched: List[tuple] = []

# ── Function-local `import datetime` in the product ───────────────────────────

_real_import = builtins.__import__
_proxy_module: Optional[types.ModuleType] = None
_import_hooked = False


def _simulated_datetime_module() -> types.ModuleType:
    """The stdlib `datetime` module, but with the simulation's `datetime` and `date`."""
    global _proxy_module
    if _proxy_module is None:
        proxy = types.ModuleType("datetime")
        proxy.__dict__.update({k: v for k, v in _dt.__dict__.items() if k not in ("__name__", "__spec__", "__loader__")})
        proxy.datetime = SimDatetime
        proxy.date = SimDate
        _proxy_module = proxy
    return _proxy_module


def _hooked_import(name, globals=None, locals=None, fromlist=(), level=0):
    if name == "datetime" and level == 0 and CLOCK is not None and globals is not None:
        importer = globals.get("__name__") or ""
        if importer == "app" or importer.startswith("app."):
            return _simulated_datetime_module()
    return _real_import(name, globals, locals, fromlist, level)


def _install_import_hook() -> None:
    global _import_hooked
    if not _import_hooked:
        builtins.__import__ = _hooked_import
        _import_hooked = True


def _remove_import_hook() -> None:
    global _import_hooked
    if _import_hooked:
        builtins.__import__ = _real_import
        _import_hooked = False


def _patch_modules() -> int:
    count = 0
    for name, module in list(sys.modules.items()):
        if not (name == "app" or name.startswith("app.")) or module is None:
            continue
        for attr, real, fake in (("datetime", _REAL_DATETIME, SimDatetime), ("date", _REAL_DATE, SimDate)):
            if getattr(module, attr, None) is real:
                setattr(module, attr, fake)
                _patched.append((module, attr, real))
                count += 1
    return count


# ── The database's "now" ──────────────────────────────────────────────────────

_NOW_SQL = re.compile(r"\bnow\(\)|\bCURRENT_TIMESTAMP\b|\bstatement_timestamp\(\)|\btransaction_timestamp\(\)",
                      re.IGNORECASE)


def _server_now_columns() -> Dict[str, List[str]]:
    """table name → the columns Postgres stamps with now() when an INSERT leaves them out."""
    from app.database import Base

    out: Dict[str, List[str]] = {}
    for table in Base.metadata.tables.values():
        cols = []
        for col in table.columns:
            default = col.server_default
            arg = getattr(default, "arg", None)
            text = str(getattr(arg, "text", arg) if arg is not None else "")
            name = getattr(arg, "name", None)
            if (name and str(name).lower() == "now") or _NOW_SQL.search(text or ""):
                cols.append(col.key)
        if cols:
            out[table.name] = cols
    return out


def _literal(moment: _dt.datetime) -> str:
    return "'" + moment.astimezone(UTC).isoformat() + "'::timestamptz"


def _install_db_hooks(engine) -> None:
    from sqlalchemy import event
    from sqlalchemy.sql.dml import Insert

    by_table = _server_now_columns()

    @event.listens_for(engine, "before_execute", retval=True)
    def _fill_server_now(conn, clauseelement, multiparams, params, execution_options):
        if CLOCK is None or not isinstance(clauseelement, Insert):
            return clauseelement, multiparams, params
        table = getattr(clauseelement, "table", None)
        cols = by_table.get(getattr(table, "name", None))
        if not cols or getattr(clauseelement, "select", None) is not None:
            return clauseelement, multiparams, params
        now = CLOCK.now()
        if getattr(clauseelement, "_multi_values", None):
            return clauseelement, multiparams, params  # a multi-row VALUES: left as it is
        embedded = getattr(clauseelement, "_values", None) or {}
        given = {getattr(k, "key", k) for k in embedded}
        if multiparams:
            rows = []
            for row in multiparams:
                if isinstance(row, dict):
                    row = dict(row)
                    for c in cols:
                        if c not in row and c not in given:
                            row[c] = now
                rows.append(row)
            return clauseelement, rows, params
        if params:
            row = dict(params)
            for c in cols:
                if c not in row and c not in given:
                    row[c] = now
            return clauseelement, multiparams, row
        missing = {c: now for c in cols if c not in given}
        if missing and embedded:
            clauseelement = clauseelement.values(**missing)
        elif missing:
            return clauseelement, [missing], params
        return clauseelement, multiparams, params

    @event.listens_for(engine, "before_cursor_execute", retval=True)
    def _sql_now(conn, cursor, statement, parameters, context, executemany):
        if CLOCK is None or "now()" not in statement.lower() and "current_timestamp" not in statement.lower():
            return statement, parameters
        return _NOW_SQL.sub(_literal(CLOCK.now()), statement), parameters


def install(start: _dt.datetime) -> SimClock:
    """Start the simulation clock at `start` and point every "now" of the product at it."""
    global CLOCK
    import app.main  # noqa: F401  (every router and service module loaded before patching)
    from app.database import engine

    CLOCK = SimClock(start)
    _patch_modules()
    _install_import_hook()
    if not getattr(engine, "_demo_clock_hooks", False):
        _install_db_hooks(engine)
        engine._demo_clock_hooks = True
    CLOCK.installed = True
    return CLOCK


def repatch() -> int:
    """Modules imported lazily since `install()` (function-level imports) get the clock too."""
    return _patch_modules() if CLOCK is not None else 0


def uninstall() -> None:
    """Back to the real clock (the verification and the export run on the real date)."""
    global CLOCK
    while _patched:
        module, attr, real = _patched.pop()
        setattr(module, attr, real)
    _remove_import_hook()
    CLOCK = None
