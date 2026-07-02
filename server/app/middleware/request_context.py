"""HTTP middleware: request ID propagation and access logging."""

from __future__ import annotations

import logging
import re
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.config import get_settings
from app.observability.body_logging import (
    collect_response_body,
    prepare_body_for_log,
    should_log_request_body,
)
from app.observability.context import reset_request_context, set_request_context

logger = logging.getLogger(__name__)
settings = get_settings()

REQUEST_ID_HEADERS = ("X-Request-Id", "X-Correlation-Id", "fly-request-id")
_MACHINE_ID_PATH_RE = re.compile(
    r"/api/v1/(?:sync|machines)/([0-9a-fA-F-]{36})(?:/|$)"
)


def _extract_request_id(request: Request) -> str:
    for header in REQUEST_ID_HEADERS:
        value = request.headers.get(header)
        if value and value.strip():
            return value.strip()
    return str(uuid.uuid4())


def _extract_machine_id_from_path(path: str) -> str | None:
    match = _MACHINE_ID_PATH_RE.search(path)
    if match:
        return match.group(1)
    return None


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = _extract_request_id(request)
        tenant_id = request.headers.get("X-Tenant-Id")
        machine_id = _extract_machine_id_from_path(request.url.path)

        tokens = set_request_context(
            request_id=request_id,
            tenant_id=tenant_id,
            machine_id=machine_id,
        )
        start = time.perf_counter()
        status_code = 500
        log_bodies = settings.log_request_bodies
        max_bytes = settings.log_body_max_bytes

        request_body_log = None
        response_body_log = None
        response_bytes = None
        req_body_bytes = b""
        resp_body_bytes = b""

        if log_bodies and should_log_request_body(
            request.method,
            request.headers.get("content-type"),
        ):
            req_body_bytes = await request.body()

            async def receive():
                return {"type": "http.request", "body": req_body_bytes, "more_body": False}

            request._receive = receive
            request_body_log = prepare_body_for_log(
                req_body_bytes,
                request.headers.get("content-type"),
                max_bytes=max_bytes,
            )

        try:
            response = await call_next(request)
            status_code = response.status_code

            if log_bodies:
                resp_body_bytes, response_bytes = await collect_response_body(response)
                response_content_type = response.media_type or response.headers.get("content-type")
                response = Response(
                    content=resp_body_bytes,
                    status_code=response.status_code,
                    headers=dict(response.headers),
                    media_type=response.media_type,
                )
                if status_code >= 400:
                    response_body_log = prepare_body_for_log(
                        resp_body_bytes,
                        response_content_type,
                        max_bytes=max_bytes,
                    )

            response.headers["X-Request-Id"] = request_id
            return response
        finally:
            duration_ms = round((time.perf_counter() - start) * 1000, 2)
            extra: dict[str, object] = {
                "method": request.method,
                "path": request.url.path,
                "status_code": status_code,
                "duration_ms": duration_ms,
            }
            if log_bodies:
                extra["request_body"] = request_body_log
                extra["response_bytes"] = response_bytes
                extra["response_body"] = response_body_log
            logger.info("request completed", extra=extra)
            reset_request_context(tokens)
