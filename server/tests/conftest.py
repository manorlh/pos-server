"""Shared pytest fixtures."""
from __future__ import annotations

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
