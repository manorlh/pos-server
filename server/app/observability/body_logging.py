"""Helpers for safe request/response body logging."""

from __future__ import annotations

import json
import re
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
        "ably_api_key",
        # The card integration's secrets in a settings PATCH (app/services/payment_secrets.py).
        "zcreditpassword",
        "zcreditkey",
        "synqpayapikey",
        # Notifications / club sign-up (docs/SPEC_NOTIFICATIONS_CLUB.md): the OTP code
        # (see `_redact_value`), the one-time tokens, the provider token and phone numbers
        # never reach a log.
        "otp",
        "registrationtoken",
        "clientsession",
        "membertoken",
        "phone",
        "recipient",
        "testnumbers",
    }
)

#: Any other key that names a password or a secret ("terminalPassword", "apiSecret"…).
_SENSITIVE_SUFFIXES = ("password", "secret")

LOGGABLE_CONTENT_PREFIXES = ("application/json", "text/")


def is_loggable_content_type(content_type: str | None) -> bool:
    if not content_type:
        return True
    media_type = content_type.split(";", 1)[0].strip().lower()
    if media_type == "multipart/form-data":
        return False
    return any(media_type.startswith(prefix) for prefix in LOGGABLE_CONTENT_PREFIXES)


#: Successful responses whose bodies are logged too (with `LOG_REQUEST_BODIES`): the
#: till's own write endpoints, whose answers only echo ids, statuses, reasons and
#: figures of what the till just sent — already in the logged request body. Every other
#: 2xx body is left out on purpose: catalog, users, settings and token responses carry
#: PIN hashes, tokens under camelCase keys the redaction list does not know, and bulk.
_LOGGED_SUCCESS_RESPONSES = re.compile(
    r"^/api/v1/sync/[0-9a-fA-F-]{36}/(?:transactions|shifts(?:/[0-9a-fA-F-]{36}/close)?|shift-close/ack)$"
)


def should_log_response_body(method: str, path: str, status_code: int) -> bool:
    if status_code >= 400:
        return True
    return method.upper() == "POST" and bool(_LOGGED_SUCCESS_RESPONSES.match(path))


def should_log_request_body(method: str, content_type: str | None) -> bool:
    if method.upper() in {"GET", "HEAD", "OPTIONS"}:
        return False
    return is_loggable_content_type(content_type)


def _redact_value(key: str, value: Any) -> Any:
    lowered = key.lower()
    if lowered in SENSITIVE_KEYS or lowered.endswith(_SENSITIVE_SUFFIXES):
        return "***"
    if lowered == "code" and isinstance(value, (str, int)) and str(value).strip().isdigit():
        # A numeric "code" is a one-time code (the club sign-up OTP); an error code
        # ("wrong_code") stays readable.
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
