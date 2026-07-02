"""Central JSON logging configuration with request context injection."""

from __future__ import annotations

import logging
import logging.config

from pythonjsonlogger.jsonlogger import JsonFormatter

from app.config import get_settings
from app.observability.context import get_log_context

_CONFIGURED = False


class ContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        for key, value in get_log_context().items():
            setattr(record, key, value)
        for key in (
            "method",
            "path",
            "status_code",
            "duration_ms",
            "request_body",
            "response_body",
            "response_bytes",
        ):
            if not hasattr(record, key):
                setattr(record, key, None)
        return True


def configure_logging() -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return

    settings = get_settings()
    level = settings.log_level.upper()

    logging.config.dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "filters": {
                "context": {"()": "app.observability.logging_config.ContextFilter"},
            },
            "formatters": {
                "json": {
                    "()": JsonFormatter,
                    "fmt": "%(asctime)s %(levelname)s %(name)s %(message)s %(request_id)s %(tenant_id)s %(machine_id)s %(user_id)s %(method)s %(path)s %(status_code)s %(duration_ms)s",
                    "rename_fields": {
                        "levelname": "level",
                        "name": "logger",
                        "asctime": "timestamp",
                    },
                },
            },
            "handlers": {
                "default": {
                    "class": "logging.StreamHandler",
                    "formatter": "json",
                    "filters": ["context"],
                },
            },
            "root": {
                "handlers": ["default"],
                "level": level,
            },
            "loggers": {
                "uvicorn": {
                    "handlers": ["default"],
                    "level": level,
                    "propagate": False,
                },
                "uvicorn.error": {
                    "handlers": ["default"],
                    "level": level,
                    "propagate": False,
                },
                "uvicorn.access": {
                    "handlers": ["default"],
                    "level": "WARNING",
                    "propagate": False,
                },
            },
        }
    )
    _CONFIGURED = True
