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
import re
import sys
from datetime import UTC, datetime
from typing import Any

from switch_core.config import SwitchConfig
from switch_core.logging_context import (
    CONTEXT_FIELDS,
    LogContextFilter,
    McpIdentityDiagnosticFilter,
    structured_fields,
)

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
    """Human-readable single line, with the process id and the context in
    brackets."""

    def __init__(self, process_id: str) -> None:
        super().__init__(
            fmt="%(asctime)s %(levelname)-5.5s [%(name)s]%(switch_context)s %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
        self._process_id = process_id

    def format(self, record: logging.LogRecord) -> str:
        # Which switch-core process wrote the line comes first, under the same
        # name as in the JSON format (`process_identity.py`).
        fields = {"process_id": self._process_id, **_context_fields(record)}
        rendered = " ".join(f"{name}={value}" for name, value in fields.items())
        record.switch_context = f" [{rendered}]"
        return super().format(record)


class JsonFormatter(logging.Formatter):
    """One JSON object per line."""

    def __init__(
        self,
        service: str,
        environment: str | None,
        version: str | None,
        process_id: str,
    ):
        super().__init__()
        self._service = service
        self._environment = environment
        self._version = version
        self._process_id = process_id

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(
                timespec="milliseconds"
            ),
            "status": record.levelname.lower(),
            "message": record.getMessage(),
            "logger": {"name": record.name, "thread_name": record.threadName},
            "service": self._service,
            # Which switch-core process wrote the line, under the name its
            # lease, its signals and its metrics carry (`process_identity.py`).
            "process_id": self._process_id,
        }
        if self._environment:
            payload["env"] = self._environment
        if self._version:
            payload["version"] = self._version
        payload.update(_context_fields(record))
        for group, fields in structured_fields(record).items():
            payload.setdefault(group, fields)

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


class AccessQueryRedaction(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if (
            record.name == "uvicorn.access"
            and isinstance(record.args, tuple)
            and len(record.args) == 5
        ):
            client, method, target, version, status = record.args
            if isinstance(target, str):
                record.args = (
                    client,
                    method,
                    target.partition("?")[0],
                    version,
                    status,
                )
        return True


# Successful answers to the requests clients repeat on a timer: Console and
# the agent controller polling, controllers reporting status, hosts beating,
# probes. On pilot these were most of the ~900k access lines a day and none of
# them said anything; a failure on the same route is still logged.
_ROUTINE_POLLS = (
    re.compile(r"^/health(/|$)"),
    re.compile(r"^/v1/management/controllers/[^/]+/(status|assignment|operations)$"),
    re.compile(r"^/gateway/management/(controllers|agents)$"),
    re.compile(r"^/gateway/hosted-controller/machines(/[^/]+/observation)?$"),
    re.compile(r"^/agent-sessions/[^/]+/activity$"),
    re.compile(r"^/agent-sessions/approvals/outcomes$"),
)
# Long-polls and per-agent traffic, quiet whatever they answer, as before.
_QUIET_ALWAYS = ("/events?timeout=", "/room-history?", "/agents/")


class RoutineAccessFilter(logging.Filter):
    """Drops access lines for routine polling that succeeded (2xx or 304).

    Installed on the `uvicorn.access` logger, so it sees the unredacted
    target; anything else, and any 4xx or 5xx, passes.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if not (isinstance(record.args, tuple) and len(record.args) == 5):
            return True
        _client, _method, target, _version, status = record.args
        if not isinstance(target, str) or not isinstance(status, int | str):
            return True
        try:
            code = int(status)
        except (TypeError, ValueError):
            return True
        if not (200 <= code < 300 or code == 304):
            return True
        if any(marker in target for marker in _QUIET_ALWAYS):
            return False
        path = target.partition("?")[0]
        return not any(pattern.match(path) for pattern in _ROUTINE_POLLS)


# uvicorn logs every WebSocket handshake and close at INFO on `uvicorn.error`:
# with agent controllers reconnecting, ~300k lines a day on pilot. Kept at
# DEBUG; the reconnect rate is the `switch.controllers.connections` metric.
_WEBSOCKET_CHATTER = re.compile(
    r'^(connection open|connection closed|.*"WebSocket [^"]*" \[accepted\])$'
)


class WebSocketChatterFilter(logging.Filter):
    """Lets uvicorn's per-connection WebSocket lines through only at DEBUG."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno != logging.INFO:
            return True
        if not _WEBSOCKET_CHATTER.match(record.getMessage()):
            return True
        return logging.getLogger(record.name).isEnabledFor(logging.DEBUG)


def build_handler(
    config: SwitchConfig, version: str | None, process_id: str
) -> logging.Handler:
    """The single stderr handler: format per config, context on every record."""
    handler = logging.StreamHandler(sys.stderr)
    if config.log_format == "json":
        handler.setFormatter(
            JsonFormatter(
                service=config.service_name,
                environment=config.environment,
                version=version,
                process_id=process_id,
            )
        )
    else:
        handler.setFormatter(TextFormatter(process_id))
    handler.addFilter(AccessQueryRedaction())
    # The MCP SDK also logs vendor messages on the root logger.
    handler.addFilter(McpIdentityDiagnosticFilter())
    handler.addFilter(LogContextFilter(config.tenant_id))
    return handler


def configure_logging(
    config: SwitchConfig, version: str | None, process_id: str
) -> None:
    """Install the root handler and levels. Call once, before anything logs."""
    global _configured

    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(build_handler(config, version, process_id))
    root.setLevel(config.log_level.upper())

    logging.getLogger("switch_core").setLevel(config.switch_log_level.upper())
    # Every outbound HTTP call is logged at INFO by httpx, which at our request
    # rate is noise rather than signal.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    _install_once(logging.getLogger("uvicorn.access"), RoutineAccessFilter)
    _install_once(logging.getLogger("uvicorn.error"), WebSocketChatterFilter)

    _configured = True


def _install_once(target: logging.Logger, kind: type[logging.Filter]) -> None:
    if not any(isinstance(existing, kind) for existing in target.filters):
        target.addFilter(kind())
