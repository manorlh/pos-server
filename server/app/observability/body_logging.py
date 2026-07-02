"""Helpers for safe request/response body logging."""

from __future__ import annotations

import json
from typing import Any

SENSITIVE_KEYS = frozenset(
    {
        "password",
        "token",
        "access_token",
        "refresh_token",
        "secret",
        "api_secret",
        "signature",
        "jwt",
        "pairing_code",
        "authorization",
        "clerk_secret_key",
        "mqtt_broker_password",
    }
)

LOGGABLE_CONTENT_PREFIXES = ("application/json", "text/")


def is_loggable_content_type(content_type: str | None) -> bool:
    if not content_type:
        return True
    media_type = content_type.split(";", 1)[0].strip().lower()
    if media_type == "multipart/form-data":
        return False
    return any(media_type.startswith(prefix) for prefix in LOGGABLE_CONTENT_PREFIXES)


def should_log_request_body(method: str, content_type: str | None) -> bool:
    if method.upper() in {"GET", "HEAD", "OPTIONS"}:
        return False
    return is_loggable_content_type(content_type)


def _redact_value(key: str, value: Any) -> Any:
    if key.lower() in SENSITIVE_KEYS:
        return "***"
    return redact_json(value)


def redact_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _redact_value(k, v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_json(item) for item in value]
    return value


def prepare_body_for_log(
    body: bytes,
    content_type: str | None,
    *,
    max_bytes: int,
) -> dict[str, Any] | None:
    if not body:
        return None
    if not is_loggable_content_type(content_type):
        return {"skipped": True, "reason": "content_type", "bytes": len(body)}

    truncated = len(body) > max_bytes
    snippet = body[:max_bytes]
    text = snippet.decode("utf-8", errors="replace")

    media_type = (content_type or "").split(";", 1)[0].strip().lower()
    if media_type == "application/json":
        try:
            parsed = json.loads(snippet.decode("utf-8"))
            redacted = redact_json(parsed)
            result: dict[str, Any] = {"json": redacted, "bytes": len(body)}
            if truncated:
                result["truncated"] = True
            return result
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass

    result = {"text": text, "bytes": len(body)}
    if truncated:
        result["truncated"] = True
    return result


async def collect_response_body(response) -> tuple[bytes, int]:
    if not hasattr(response, "body_iterator"):
        return b"", 0
    chunks: list[bytes] = []
    async for chunk in response.body_iterator:
        chunks.append(chunk)
    body = b"".join(chunks)
    return body, len(body)
