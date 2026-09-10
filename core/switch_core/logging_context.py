"""Per-request context stamped onto every log record.

The fields live in a context variable rather than being passed to each logging
call, so every existing ``logger.info(...)`` in the codebase gains them without
being touched. :class:`LogContextFilter` copies whatever is bound onto the
record and the formatters in :mod:`switch_core.logging_config` render it.

``tenant_id`` is the point of the exercise: multi-tenancy needs "is this one
customer or everyone?" to be answerable from the logs alone, and that is far
cheaper to build before tenants exist than after. It was built before tenants
existed, and now that they do, ``gateway/auth.py`` and ``bridges/agent/auth.py``
bind the real one for every authenticated request.

Background work binds a tenant too, but through
:mod:`switch_core.tenant_context` rather than through this module — and that
binding is the one the database actually writes under, since
``db/tenant_session.py`` turns it into ``set_config('app.tenant_id')`` on every
transaction. Nothing taught the log about it, so a startup seed running inside
``tenant_scope(TENANT_ZERO_ID)`` wrote its rows into ``00000000-…`` and logged
``tenant_id=default``: a line naming a tenant that was not the one written.
:class:`LogContextFilter` reads that binding as its second choice for exactly
that reason.

Only when neither is bound does the deployment's configured placeholder apply;
see ``SwitchConfig.tenant_id``. Nothing scoped can be written in that state —
``db/models.require_tenant_id`` raises — so the placeholder cannot contradict a
row the way the two bindings could.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, replace

from switch_core.tenant_context import current_tenant_id

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
def _held(token: Token[LogContext]) -> Iterator[None]:
    """Hold `token` for the block and restore what it replaced on the way out.

    Not restored when the block is unwound by `GeneratorExit`. That is a frame
    being *finalised* rather than resumed — a coroutine dropped while
    suspended and later closed by the garbage collector — and the collector
    runs it in whatever context it happens to be in, not the one the token
    belongs to. `Token.reset` refuses to cross contexts, correctly: restoring
    there would stamp this scope's fields onto an unrelated one. There is also
    nothing left to restore, since the context the token belongs to is
    unreachable, which is why the frame is being finalised at all.
    """
    finalising = False
    try:
        yield
    except GeneratorExit:
        finalising = True
        raise
    finally:
        if not finalising:
            unbind_log_context(token)


@contextmanager
def log_context(**fields: str | None) -> Iterator[None]:
    with _held(bind_log_context(**fields)):
        yield


class LogContextFilter(logging.Filter):
    """Stamp the bound context onto every record passing through a handler.

    Installed on the handler rather than on a logger, so records from libraries
    (uvicorn, sqlalchemy, slack_sdk) carry the same fields as our own.

    ``tenant_id`` always has a value; the rest are ``None`` outside a request
    and are omitted by the formatters rather than rendered as empty.

    Three sources, in this order, and the order is the whole point:

    1. what a request bound here, which is the caller's tenant;
    2. what :mod:`switch_core.tenant_context` has bound, which is the tenant
       every statement on this task's sessions is being written under;
    3. the configured placeholder, which stands for "no tenant at all".

    Without (2) a background line reports (3) while its transaction writes a
    real tenant, and the two do not even use the same vocabulary — the
    placeholder is a slug, ``app.tenant_id`` is a uuid — so the line does not
    read as merely imprecise. It reads as a different tenant.
    """

    def __init__(self, default_tenant_id: str) -> None:
        super().__init__()
        self._default_tenant_id = default_tenant_id

    def filter(self, record: logging.LogRecord) -> bool:
        context = _current.get()
        record.tenant_id = (
            context.tenant_id or current_tenant_id() or self._default_tenant_id
        )
        record.request_id = context.request_id
        record.agent_id = context.agent_id
        record.user_id = context.user_id
        return True
