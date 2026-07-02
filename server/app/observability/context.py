"""Request-scoped context for structured logging."""

from __future__ import annotations

import contextvars
from typing import Any

request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
tenant_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("tenant_id", default=None)
machine_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("machine_id", default=None)
user_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("user_id", default=None)

_CONTEXT_VARS = {
    "request_id": request_id_var,
    "tenant_id": tenant_id_var,
    "machine_id": machine_id_var,
    "user_id": user_id_var,
}


def set_request_context(**kwargs: str | None) -> dict[str, contextvars.Token]:
    """Set one or more context fields; returns tokens for reset_request_context."""
    tokens: dict[str, contextvars.Token] = {}
    for key, value in kwargs.items():
        var = _CONTEXT_VARS.get(key)
        if var is not None:
            tokens[key] = var.set(value)
    return tokens


def reset_request_context(tokens: dict[str, contextvars.Token]) -> None:
    for key, token in tokens.items():
        var = _CONTEXT_VARS.get(key)
        if var is not None:
            var.reset(token)


def get_log_context() -> dict[str, str]:
    return {
        "request_id": request_id_var.get() or "-",
        "tenant_id": tenant_id_var.get() or "-",
        "machine_id": machine_id_var.get() or "-",
        "user_id": user_id_var.get() or "-",
    }
