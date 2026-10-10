"""
The public digital pages' cache (specs/digital-menu-ordering-cards-plan.md §9 "מטמון").

Keyed by everything that changes the answer: tenant · point (shop and point of sale) · profile ·
revision · language · service — so one point's products or prices never reach another's request.
Entries live a short while (`TTL_SECONDS`, the availability target ≤ 10 s: blocks, stock and locks act
live) and a publication, a rollback or a pause drops every entry of its profile at once
(`invalidate`). In-process, like the rate limits (app/middleware/rate_limit.py): each API process
keeps its own; nothing here is a source of truth.
"""
from __future__ import annotations

import hashlib
import json
import time
from threading import Lock
from typing import Any, Dict, Optional, Tuple

TTL_SECONDS = 10.0
MAX_ENTRIES = 2000

_lock = Lock()
_entries: Dict[Tuple, Tuple[float, str, Any]] = {}


def key_of(*, tenant_id: Any, shop_id: Any, area_id: Any, profile_id: Any, revision_id: Any, lang: Any,
           service: Any, kind: str) -> Tuple:
    return (str(tenant_id), str(shop_id or ""), str(area_id or ""), str(profile_id), str(revision_id or ""),
            str(lang or ""), str(service or ""), kind)


def etag_of(payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    return '"' + hashlib.sha256(raw).hexdigest()[:32] + '"'


def get(key: Tuple, now: Optional[float] = None) -> Optional[Tuple[str, Any]]:
    now = time.monotonic() if now is None else now
    with _lock:
        hit = _entries.get(key)
        if hit is None:
            return None
        expires, etag, payload = hit
        if expires <= now:
            _entries.pop(key, None)
            return None
        return etag, payload


def put(key: Tuple, payload: Any, now: Optional[float] = None) -> str:
    now = time.monotonic() if now is None else now
    etag = etag_of(payload)
    with _lock:
        if len(_entries) >= MAX_ENTRIES:
            for k in [k for k, v in _entries.items() if v[0] <= now] or list(_entries)[: MAX_ENTRIES // 10]:
                _entries.pop(k, None)
        _entries[key] = (now + TTL_SECONDS, etag, payload)
    return etag


def invalidate(profile_id: Any) -> int:
    """Drop every entry of this profile (a publication, a rollback, a pause). Returns how many."""
    pid = str(profile_id)
    with _lock:
        gone = [k for k in _entries if k[3] == pid]
        for k in gone:
            _entries.pop(k, None)
    return len(gone)


def clear() -> None:
    with _lock:
        _entries.clear()
