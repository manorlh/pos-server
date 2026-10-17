"""Shared pytest fixtures."""
from __future__ import annotations

import logging

import pytest
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.compiler import compiles


@compiles(UUID, "sqlite")
def _uuid_as_text_on_sqlite(type_, compiler, **kw):
    """
    SQLite gives a column declared "UUID" numeric affinity: a uuid4 whose hex happens to be
    all digits (or digits and one "e") is stored as a number and read back as a float, and
    the test dies in `uuid.UUID(float)` once in a few full runs. CHAR(32) has text affinity;
    the stored hex is the same. Postgres (production) is not affected.
    """
    return "CHAR(32)"


@pytest.fixture
def z_activity_unchecked(monkeypatch):
    """
    Lift the "no Z on 0" rule ("אל תאפשר לסגור Z על 0") for tests about something else.

    Many Z tests build runs over shifts with no documents, because what they test — the
    run's locks, its lifecycle, tenancy, which shifts a Z takes — does not need any. The
    rule itself is tested in tests/test_z_no_zero.py, which does not use this fixture.
    """
    from app.services import z_builder, z_runs

    monkeypatch.setattr(z_builder, "figures_show_activity", lambda *a, **k: True)
    monkeypatch.setattr(z_runs, "run_may_have_activity", lambda *a, **k: True)


def _undo_alembic_leftovers():
    """Re-enable the loggers alembic/env.py's `fileConfig()` disabled, and drop the `alembic.context` /
    `alembic.op` proxies an Alembic run left set (or None)."""
    import alembic.context
    import alembic.op

    for lg in list(logging.Logger.manager.loggerDict.values()):
        if isinstance(lg, logging.Logger) and lg.disabled:
            lg.disabled = False
    for module in (alembic.context, alembic.op):
        vars(module).pop("_proxy", None)


@pytest.fixture(autouse=True)
def _alembic_leaves_no_trace():
    """
    Tests that run Alembic (`command.upgrade(..., sql=True)`, also from class- or module-scoped
    fixtures) leave two things behind for every later test of the session, which made the suite
    order-dependent (green alone, red in the full run):

    - alembic/env.py's `fileConfig()` sets `.disabled = True` on every logger that exists, so a
      later `caplog` test sees an empty log;
    - the `alembic.context` / `alembic.op` proxies stay set (or None), so a later migration run by
      hand that asks `context.is_offline_mode()` gets AttributeError instead of the NameError it
      handles.

    Outside an Alembic run no logger of this code base is disabled and no proxy is set, so that
    state is put back before and after each test (before: a wider-scoped fixture may just have run
    Alembic). Nothing a test asserts on is touched.
    """
    _undo_alembic_leftovers()
    yield
    _undo_alembic_leftovers()
