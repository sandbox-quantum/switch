"""Per-request context stamped onto every log record.

The fields live in a context variable rather than being passed to each logging
call, so every existing ``logger.info(...)`` in the codebase gains them without
being touched. :class:`LogContextFilter` copies whatever is bound onto the
record and the formatters in :mod:`switch_core.logging_config` render it.

``tenant_id`` is the point of the exercise: multi-tenancy needs "is this one
customer or everyone?" to be answerable from the logs alone, and that is far
cheaper to build before tenants exist than after. Until the tenant model lands
nothing binds it per request, and the filter stamps the deployment's configured
tenant instead — see ``SwitchConfig.tenant_id``.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, replace

# The context fields, in the order they are rendered. Anything logged as
# context must be listed here, so that a typo in a bind call is an error rather
# than a field that silently never appears.
CONTEXT_FIELDS: tuple[str, ...] = ("tenant_id", "request_id", "agent_id", "user_id")


@dataclass(frozen=True)
class LogContext:
    tenant_id: str | None = None
    request_id: str | None = None
    agent_id: str | None = None
    user_id: str | None = None


_EMPTY = LogContext()

_current: ContextVar[LogContext] = ContextVar("switch_log_context", default=_EMPTY)


def current_log_context() -> LogContext:
    return _current.get()


def bind_log_context(**fields: str | None) -> Token[LogContext]:
    """Merge fields into the current context, returning a token to unbind with.

    Fields not named are inherited from the enclosing context, so an inner bind
    of ``agent_id`` keeps the request id its caller bound.
    """
    unknown = sorted(set(fields) - set(CONTEXT_FIELDS))
    if unknown:
        raise ValueError(
            f"Unknown log context field(s) {unknown}; "
            f"known fields are {list(CONTEXT_FIELDS)}."
        )
    return _current.set(replace(_current.get(), **fields))


def unbind_log_context(token: Token[LogContext]) -> None:
    _current.reset(token)


@contextmanager
def log_context(**fields: str | None) -> Iterator[None]:
    token = bind_log_context(**fields)
    try:
        yield
    finally:
        unbind_log_context(token)


class LogContextFilter(logging.Filter):
    """Stamp the bound context onto every record passing through a handler.

    Installed on the handler rather than on a logger, so records from libraries
    (uvicorn, sqlalchemy, slack_sdk) carry the same fields as our own.

    ``tenant_id`` always has a value; the rest are ``None`` outside a request
    and are omitted by the formatters rather than rendered as empty.
    """

    def __init__(self, default_tenant_id: str) -> None:
        super().__init__()
        self._default_tenant_id = default_tenant_id

    def filter(self, record: logging.LogRecord) -> bool:
        context = _current.get()
        record.tenant_id = context.tenant_id or self._default_tenant_id
        record.request_id = context.request_id
        record.agent_id = context.agent_id
        record.user_id = context.user_id
        return True
