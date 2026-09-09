"""Logging setup for switch-core: one place installs the root handler.

Before this existed the only handler in the process was the one Alembic's
``fileConfig`` installed as a side effect of running migrations at startup,
which is why records carried no timestamp and no fields — and why skipping
migrations meant no logging at all.

Two formats. ``text`` is for a terminal. ``json`` emits one object per line
keyed for a log pipeline: Datadog's standard attributes (``status``,
``message``, ``service``, ``logger.name``, ``error.*``) are used where they
apply, so the fields are faceted without a remapper, and the context fields
from :mod:`switch_core.logging_context` ride alongside them.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

from switch_core.config import SwitchConfig
from switch_core.logging_context import CONTEXT_FIELDS, LogContextFilter

_configured = False


def logging_is_configured() -> bool:
    """Whether :func:`configure_logging` has run in this process.

    Alembic's ``env.py`` reads this: run from the CLI it must configure logging
    itself, but run in-process from the server it must not install a second
    root handler and double every line.
    """
    return _configured


def _context_fields(record: logging.LogRecord) -> dict[str, str]:
    """The context fields present on a record, in declaration order.

    A record that never passed through :class:`LogContextFilter` has none, so
    this yields nothing rather than raising — a formatter is the wrong place to
    discover a misconfigured handler.
    """
    fields = {}
    for name in CONTEXT_FIELDS:
        value = getattr(record, name, None)
        if value is not None:
            fields[name] = str(value)
    return fields


class TextFormatter(logging.Formatter):
    """Human-readable single line, with the context in brackets."""

    def __init__(self) -> None:
        super().__init__(
            fmt="%(asctime)s %(levelname)-5.5s [%(name)s]%(switch_context)s %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )

    def format(self, record: logging.LogRecord) -> str:
        fields = _context_fields(record)
        rendered = " ".join(f"{name}={value}" for name, value in fields.items())
        record.switch_context = f" [{rendered}]" if rendered else ""
        return super().format(record)


class JsonFormatter(logging.Formatter):
    """One JSON object per line."""

    def __init__(self, service: str, environment: str | None, version: str | None):
        super().__init__()
        self._service = service
        self._environment = environment
        self._version = version

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(
                timespec="milliseconds"
            ),
            "status": record.levelname.lower(),
            "message": record.getMessage(),
            "logger": {"name": record.name, "thread_name": record.threadName},
            "service": self._service,
        }
        if self._environment:
            payload["env"] = self._environment
        if self._version:
            payload["version"] = self._version
        payload.update(_context_fields(record))

        if record.exc_info:
            exc_type, exc_value, _ = record.exc_info
            payload["error"] = {
                "kind": exc_type.__name__ if exc_type is not None else "Exception",
                "message": str(exc_value),
                "stack": self.formatException(record.exc_info),
            }
        elif record.exc_text:
            payload["error"] = {"stack": record.exc_text}
        if record.stack_info:
            payload["stack_trace"] = self.formatStack(record.stack_info)

        # `default=str` keeps a record carrying an unserialisable value in the
        # log rather than raising inside the handler and losing the line.
        return json.dumps(payload, default=str)


def build_handler(config: SwitchConfig, version: str | None) -> logging.Handler:
    """The single stderr handler: format per config, context on every record."""
    handler = logging.StreamHandler(sys.stderr)
    if config.log_format == "json":
        handler.setFormatter(
            JsonFormatter(
                service=config.service_name,
                environment=config.environment,
                version=version,
            )
        )
    else:
        handler.setFormatter(TextFormatter())
    handler.addFilter(LogContextFilter(config.tenant_id))
    return handler


def configure_logging(config: SwitchConfig, version: str | None) -> None:
    """Install the root handler and levels. Call once, before anything logs."""
    global _configured

    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(build_handler(config, version))
    root.setLevel(config.log_level.upper())

    logging.getLogger("switch_core").setLevel(config.switch_log_level.upper())
    # Every outbound HTTP call is logged at INFO by httpx, which at our request
    # rate is noise rather than signal.
    logging.getLogger("httpx").setLevel(logging.WARNING)

    _configured = True
