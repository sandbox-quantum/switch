"""Logging for the decision service, in the same shape as switch-core's.

The same settings select it (`LOG_FORMAT`, `LOG_LEVEL`, `SERVICE_NAME`,
`ENVIRONMENT`, `POD_NAME`), and the JSON layout matches switch-core's
`JsonFormatter` field for field, so one log pipeline reads both. The only
context field is `request_id`: switch-core sends its decision id as
`X-Request-Id`, and every line written while answering that request carries it.

A copy rather than an import: the image does not contain switch-core, and
importing it would pull in its whole dependency tree.
"""

import json
import logging
import os
import re
import secrets
import socket
import sys
import uuid
from contextvars import ContextVar, Token
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as distribution_version
from typing import Any

from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)

DISTRIBUTION_NAME = "switch-decision"
DEFAULT_SERVICE_NAME = "switch-decision"
REQUEST_ID_HEADER = "X-Request-Id"

_LEVELS = {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG", "NOTSET"}

# Libraries that log request bodies at DEBUG (the Anthropic SDK and botocore
# both do), and with them the room's messages. They stay at WARNING whatever
# LOG_LEVEL says, so DEBUG never writes message text.
_QUIET_LOGGERS = ("anthropic", "botocore", "boto3", "urllib3", "httpx", "httpcore")

_UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")

# What a request id from a caller may look like: switch-core sends a UUID, and
# anything outside this is replaced rather than written into a log line.
_REQUEST_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}")

_request_id: ContextVar[str | None] = ContextVar(
    "switch_decision_request_id", default=None
)


@dataclass(frozen=True)
class LogSettings:
    log_format: str
    log_level: str
    service_name: str
    environment: str | None
    pod_name: str | None


def load_log_settings() -> LogSettings:
    log_format = os.environ.get("LOG_FORMAT", "text")
    if log_format not in ("text", "json"):
        raise ValueError(f"LOG_FORMAT must be 'text' or 'json', got {log_format!r}.")
    log_level = os.environ.get("LOG_LEVEL", "INFO")
    if log_level.upper() not in _LEVELS:
        raise ValueError(
            f"LOG_LEVEL must be one of {sorted(_LEVELS)}, got {log_level!r}."
        )
    return LogSettings(
        log_format=log_format,
        log_level=log_level.upper(),
        service_name=os.environ.get("SERVICE_NAME") or DEFAULT_SERVICE_NAME,
        environment=os.environ.get("ENVIRONMENT") or None,
        pod_name=os.environ.get("POD_NAME") or None,
    )


def service_version() -> str | None:
    """The installed package's version, or None (and a warning) when unknown."""
    try:
        return distribution_version(DISTRIBUTION_NAME)
    except PackageNotFoundError:
        logger.warning(
            "No installed distribution metadata for %r, so log lines carry no version.",
            DISTRIBUTION_NAME,
        )
        return None


def new_process_id(pod_name: str | None) -> str:
    """This process's name: its pod or host, then a suffix drawn at each start,
    so two lives of one pod read apart (as switch-core's `process_identity`)."""
    return f"{pod_name or socket.gethostname()}-{secrets.token_hex(4)}"


def request_id_from_header(value: str | None) -> str:
    """The caller's id when it is well formed, otherwise a fresh one."""
    if value is not None and _REQUEST_ID.fullmatch(value):
        return value
    return uuid.uuid4().hex


def current_request_id() -> str | None:
    return _request_id.get()


def bind_request_id(value: str) -> Token[str | None]:
    return _request_id.set(value)


def unbind_request_id(token: Token[str | None]) -> None:
    _request_id.reset(token)


class RequestIdFilter(logging.Filter):
    """Stamps the bound request id onto every record a handler sees, including
    uvicorn's and the libraries'."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = _request_id.get()
        return True


class RequestIdMiddleware:
    """Binds `request_id` from `X-Request-Id`, or a generated id, for the whole
    request, and echoes it on the response.

    Pure ASGI rather than `BaseHTTPMiddleware`, and outermost, so uvicorn's
    access line (written when the response starts) carries the id too.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        given = None
        for name, value in scope["headers"]:
            if name == b"x-request-id":
                given = value.decode("latin-1")
                break
        request_id = request_id_from_header(given)

        async def send_with_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"x-request-id", request_id.encode()))
                message = {**message, "headers": headers}
            await send(message)

        token = bind_request_id(request_id)
        try:
            await self.app(scope, receive, send_with_id)
        finally:
            unbind_request_id(token)


def _context_fields(record: logging.LogRecord) -> dict[str, str]:
    value = getattr(record, "request_id", None)
    return {} if value is None else {"request_id": str(value)}


class TextFormatter(logging.Formatter):
    """One line for a terminal, with the process and request id in brackets."""

    def __init__(self, process_id: str) -> None:
        super().__init__(
            fmt="%(asctime)s %(levelname)-5.5s [%(name)s]%(switch_context)s %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
        self._process_id = process_id

    def format(self, record: logging.LogRecord) -> str:
        fields = {"process_id": self._process_id, **_context_fields(record)}
        rendered = " ".join(f"{name}={value}" for name, value in fields.items())
        record.switch_context = f" [{rendered}]"
        return super().format(record)


class JsonFormatter(logging.Formatter):
    """One JSON object per line, laid out as switch-core's `JsonFormatter`."""

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
            "process_id": self._process_id,
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

        return json.dumps(payload, default=str)


class AccessLogFilter(logging.Filter):
    """uvicorn's access log without the health probes, and with every query
    string cut off (as switch-core's `AccessQueryRedaction`)."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and len(record.args) == 5:
            client, method, target, version, status = record.args
            if isinstance(target, str):
                path = target.partition("?")[0]
                if method == "GET" and path == "/health":
                    return False
                record.args = (client, method, path, version, status)
        return True


def build_handler(
    settings: LogSettings, version: str | None, process_id: str
) -> logging.Handler:
    handler = logging.StreamHandler(sys.stderr)
    if settings.log_format == "json":
        handler.setFormatter(
            JsonFormatter(
                service=settings.service_name,
                environment=settings.environment,
                version=version,
                process_id=process_id,
            )
        )
    else:
        handler.setFormatter(TextFormatter(process_id))
    handler.addFilter(RequestIdFilter())
    return handler


def adopt_uvicorn_loggers() -> None:
    """Send uvicorn's records through the root handler.

    `uvicorn ... --port` installs its own handlers before it imports the app,
    and a programmatic `uvicorn.Config` installs them again whenever it is
    built, so this runs at import and again from the lifespan. Idempotent.
    """
    for name in _UVICORN_LOGGERS:
        uvicorn_logger = logging.getLogger(name)
        for existing in list(uvicorn_logger.handlers):
            uvicorn_logger.removeHandler(existing)
        uvicorn_logger.propagate = True
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, AccessLogFilter) for f in access.filters):
        access.addFilter(AccessLogFilter())


def configure_logging(
    settings: LogSettings, version: str | None, process_id: str
) -> logging.Handler:
    """Install the root handler and levels, and return the handler."""
    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    handler = build_handler(settings, version, process_id)
    root.addHandler(handler)
    root.setLevel(settings.log_level)
    for name in _QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
    adopt_uvicorn_loggers()
    return handler
