"""
The kitchen engine's golden scenarios — one behaviour in the cloud and on the main till
(docs/SPEC_LAN_MODE.md §7; the corpus and how it is made: tests/kds_golden.py).

`tests/fixtures/kds_engine_golden.json` is shared byte for byte with pos-android
(`app/src/test/resources/`); both suites pin its SHA-256 (line endings read as LF). This
suite replays every scenario against the Python engine and compares the normalised subset —
the screens branch's `device` / `display` / `scope` blocks left out. pos-android's
`KdsEngineGoldenTest` checks the same file's SHA today and replays it on the Kotlin engine
from P1. Change the corpus, both copies and both constants together.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest

import kds_golden as G

#: The corpus's SHA-256 (LF) — the same constant in pos-android's KdsEngineGoldenTest.
GOLDEN_SHA256 = "201aa59fa308ac72c93f646d2d3162a75a7b7b4ad75fb383df469424ebee8f10"
#: pos-android beside pos-server (the developers' layout), or this branch's worktree beside it.
SIBLINGS = [
    Path(__file__).resolve().parents[3] / name / "app" / "src" / "test" / "resources" / G.FIXTURE.name
    for name in ("pos-android", "lan-android")
]


def _text(path: Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def _corpus() -> dict:
    return json.loads(_text(G.FIXTURE)) if G.FIXTURE.exists() else {"scenarios": []}


def test_the_corpus_is_the_pinned_one():
    assert hashlib.sha256(_text(G.FIXTURE).encode("utf-8")).hexdigest() == GOLDEN_SHA256


def test_the_till_has_the_same_corpus():
    present = [p for p in SIBLINGS if p.exists()]
    if not present:
        pytest.skip("pos-android is not checked out beside pos-server")
    for path in present:
        assert _text(path) == _text(G.FIXTURE), path


def test_it_covers_the_engine_tests_and_time_passing():
    corpus = _corpus()
    assert corpus["format"] == G.FORMAT
    origins = {s["from"] for s in corpus["scenarios"]}
    assert sum(o.startswith("test_kds.py::") for o in origins) >= 40
    kinds = {step["do"] for s in corpus["scenarios"] for step in s["steps"]}
    assert {"release", "action", "advance", "configure", "outbox", "board"} <= kinds
    # Nothing of the screens branch is in what is compared.

    def keys(value):
        if isinstance(value, dict):
            for k, v in value.items():
                yield k
                yield from keys(v)
        elif isinstance(value, list):
            for v in value:
                yield from keys(v)

    found = {k for s in corpus["scenarios"] for step in s["steps"] for k in keys(step["expect"])}
    assert not found & set(G.DROPPED)


@pytest.mark.parametrize("scenario", _corpus()["scenarios"], ids=lambda s: s["name"][:70] if isinstance(s, dict) else "-")
def test_the_engine_reproduces_every_scenario(scenario, monkeypatch):
    built = G.build_world(G.fresh_world(monkeypatch))
    diffs = G.replay(scenario, built, monkeypatch)
    assert not diffs, "\n".join(
        f"step {i} ({scenario['steps'][i]['do']}) {view}:\n  expected {json.dumps(e, ensure_ascii=False)[:900]}"
        f"\n  actual   {json.dumps(a, ensure_ascii=False)[:900]}"
        for i, view, e, a in diffs[:5]
    )


@pytest.mark.skipif(os.environ.get("KDS_GOLDEN_WRITE") != "1", reason="KDS_GOLDEN_WRITE=1 regenerates the corpus")
def test_regenerate():
    """Writes the corpus (and the pos-android copy beside it) and prints its SHA-256."""
    worlds = []

    def builder():
        mp = pytest.MonkeyPatch()
        worlds.append(mp)
        return G.build_world(G.fresh_world(mp))

    try:
        corpus = G.generate(builder, pytest.MonkeyPatch)
    finally:
        for mp in worlds:
            mp.undo()
    text = G.dumps(corpus)
    G.FIXTURE.write_bytes(text.encode("utf-8"))
    for path in SIBLINGS:
        if path.parent.exists():
            path.write_bytes(text.encode("utf-8"))
    print("\nKDS golden SHA-256:", hashlib.sha256(text.encode("utf-8")).hexdigest())
