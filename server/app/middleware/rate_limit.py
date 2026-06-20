"""Simple in-process rate limiting for public pairing endpoints."""

from __future__ import annotations

import time
from collections import defaultdict
from threading import Lock
from typing import DefaultDict, Tuple

from fastapi import HTTPException, Request, status

_lock = Lock()
_buckets: DefaultDict[str, Tuple[int, float]] = defaultdict(lambda: (0, 0.0))


def check_rate_limit(request: Request, key: str, max_calls: int, window_seconds: int = 60) -> None:
    """Raise 429 if key exceeds max_calls within window_seconds."""
    client = request.client.host if request.client else "unknown"
    bucket_key = f"{key}:{client}"
    now = time.monotonic()
    with _lock:
        count, window_start = _buckets[bucket_key]
        if now - window_start >= window_seconds:
            _buckets[bucket_key] = (1, now)
            return
        if count >= max_calls:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests",
            )
        _buckets[bucket_key] = (count + 1, window_start)


def check_rate_limit_by_key(key: str, max_calls: int, window_seconds: int = 60) -> None:
    """Rate limit by arbitrary key (e.g. nonce or jti) without Request."""
    now = time.monotonic()
    with _lock:
        count, window_start = _buckets[key]
        if now - window_start >= window_seconds:
            _buckets[key] = (1, now)
            return
        if count >= max_calls:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests",
            )
        _buckets[key] = (count + 1, window_start)
