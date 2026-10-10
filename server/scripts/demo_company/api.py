"""
The product's HTTP API, in process: the dashboard's calls (as the super admin, with the
demo tenant in `X-Tenant-Id`) and the tills' calls (each with its own machine token from
pairing). FastAPI's TestClient runs every request through the real routing, dependency
checks, validation and serialization — without a socket and without the app's startup
workers (the client is never entered as a context manager).
"""
from __future__ import annotations

import json
import uuid
from typing import Any, Dict, Iterable, Optional

PREFIX = "/api/v1"


class ApiError(RuntimeError):
    def __init__(self, method: str, path: str, status: int, body: Any):
        self.status = status
        self.body = body
        super().__init__(f"{method} {path} -> {status}: {json.dumps(body, ensure_ascii=False, default=str)[:1500]}")


class Api:
    def __init__(self, actor_user_id: uuid.UUID):
        from fastapi import Depends
        from fastapi.testclient import TestClient
        from sqlalchemy.orm import Session

        from app.database import get_db
        from app.main import app
        from app.middleware.auth import get_current_user
        from app.models.user import User

        def _actor(db: Session = Depends(get_db)) -> User:
            # The dashboard's signed-in user, read in the request's own session as the real
            # dependency would (Clerk itself is not called).
            return db.get(User, actor_user_id)

        app.dependency_overrides[get_current_user] = _actor
        self.client = TestClient(app, raise_server_exceptions=True)
        # One event loop for every request. Without it TestClient starts (and on Windows slowly
        # tears down) a loop per request; entering the client instead would also run the app's
        # startup workers, which the seeder must not start.
        from anyio.from_thread import start_blocking_portal

        self._portal_cm = start_blocking_portal(**self.client.async_backend)
        self.client.portal = self._portal_cm.__enter__()
        self.tenant_id: Optional[str] = None
        self.calls = 0

    def close(self) -> None:
        self.client.portal = None
        self._portal_cm.__exit__(None, None, None)

    # ── plumbing ──────────────────────────────────────────────────────────────

    def _call(self, method: str, path: str, *, headers: Dict[str, str], json_body=None, params=None,
              expect: Iterable[int] = (200, 201)) -> Any:
        self.calls += 1
        resp = self.client.request(method, PREFIX + path, json=json_body, params=params, headers=headers)
        try:
            body = resp.json()
        except ValueError:
            body = resp.content
        if resp.status_code not in tuple(expect):
            raise ApiError(method, path, resp.status_code, body)
        return body if not isinstance(body, bytes) else resp

    def admin(self, method: str, path: str, body=None, *, params=None, expect=(200, 201)) -> Any:
        headers = {"X-Tenant-Id": self.tenant_id} if self.tenant_id else {}
        return self._call(method, path, headers=headers, json_body=body, params=params, expect=expect)

    def till(self, token: str, method: str, path: str, body=None, *, params=None, expect=(200, 201),
             extra_headers: Optional[Dict[str, str]] = None) -> Any:
        headers = {"Authorization": f"Bearer {token}"}
        if extra_headers:
            headers.update(extra_headers)
        return self._call(method, path, headers=headers, json_body=body, params=params, expect=expect)

    def public(self, method: str, path: str, body=None, *, expect=(200, 201)) -> Any:
        return self._call(method, path, headers={}, json_body=body, expect=expect)
