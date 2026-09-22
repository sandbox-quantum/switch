"""How long the database takes, from this server's side of it.

The pool gauges answer "are we holding too many connections", not "is anything
slow". On this server a request is a handful of queries and little else, so a
slow endpoint is nearly always a slow query.

Timed with SQLAlchemy's cursor events rather than by wrapping call sites: they
fire around the driver call, so what is measured is the round trip rather than
the Python either side of it, and there is no call site to remember to wrap.

What that leaves out, so nobody reads the panel as "every statement": the
message listener, which takes the raw asyncpg connection and never executes
through SQLAlchemy; Alembic, which builds its own engine; `BEGIN`/`COMMIT`,
which the dialect issues directly; and pool pre-ping. An `executemany` is one
measurement for the whole batch, because it is one round trip.

**The statement text never leaves this module.** It is the obvious attribute
and the one that must not be a metric: unbounded, and it carries literals on
some paths. What goes on the wire is the leading keyword through a fixed table,
so the series count is the size of that table.
"""

from __future__ import annotations

import time
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine

from switch_core.observability.catalogue import DB_QUERY_DURATION
from switch_core.observability.metrics import metrics

# The verbs worth telling apart on a panel, and nothing else. `other` covers
# the rest — `SET`, a DDL statement, anything a later caller invents — which is
# not what anyone is looking for when a read is slow, and naming each one would
# put the shape of the schema on a dashboard.
_OPERATIONS = frozenset({"select", "insert", "update", "delete"})

# Every tenant-bound transaction opens with this, from `db/tenant_session.py`'s
# `after_begin`. It is a `SELECT`, it is always trivial, and it is roughly a
# third of all statements — so counted as one it drags the `select` percentiles
# toward bookkeeping and away from the queries the panel exists to show. Its
# own label rather than dropped: a transaction rate is worth having, and a
# `set_config` that started taking milliseconds would mean something.
_TENANT_BIND_MARKER = "set_config("
_TENANT_BIND = "tenant_bind"

_TIMER_KEY = "_switch_query_started"


def _operation(statement: str) -> str:
    """The leading keyword, or `other`.

    Deliberately crude. A statement whose first word is not one of the four is
    not worth a series of its own, and anything cleverer would have to parse
    SQL to find out — on the hot path, for a label.
    """
    stripped = statement.lstrip()
    head = stripped[:16].split(None, 1)
    if not head:
        return "other"
    keyword = head[0].lower()
    if keyword not in _OPERATIONS:
        return "other"
    if keyword == "select" and _TENANT_BIND_MARKER in stripped[:64]:
        return _TENANT_BIND
    return keyword


def _before(
    _conn: Any,
    _cursor: Any,
    _statement: str,
    _parameters: Any,
    context: Any,
    _executemany: bool,
) -> None:
    # On the execution context rather than in a module-level dict: a pool
    # serves many connections at once, and anything keyed by less than the
    # statement's own context would have one query's start time read by
    # another's finish.
    #
    # SQLAlchemy types the context optional on this event and one dialect does
    # pass None. A raise here lands *before* the driver call, so an
    # unguarded `setattr` would turn a metric into a failed query.
    if context is None:
        return
    setattr(context, _TIMER_KEY, time.perf_counter())


def _after(
    _conn: Any,
    _cursor: Any,
    statement: str,
    _parameters: Any,
    context: Any,
    _executemany: bool,
) -> None:
    started = getattr(context, _TIMER_KEY, None)
    if started is None:
        return
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    metrics().observe(
        DB_QUERY_DURATION, {"operation": _operation(statement)}, elapsed_ms
    )


def instrument_queries(engine: AsyncEngine) -> None:
    """Time every statement this engine runs.

    Idempotent, but not by anything here: SQLAlchemy already refuses a
    `(target, identifier, fn)` it is holding, and these are module-level
    functions, so the same pair registered twice fires once. That is worth
    knowing rather than guarding — a guard would be dead code claiming to
    prevent something — and it is worth *testing*, because it stops being true
    the moment either listener becomes a closure or a bound method, at which
    point every query is timed twice and the only symptom is a p50 nobody can
    reconcile.

    A statement that raises is not recorded. `after_cursor_execute` does not
    fire on a failure, and that is the right way round — a query that failed in
    four milliseconds is not evidence the database is fast, and mixing the two
    would pull the percentiles down exactly when something is wrong. Failures
    are already visible as errors on the routes that provoked them.
    """
    sync_engine = engine.sync_engine
    event.listen(sync_engine, "before_cursor_execute", _before)
    event.listen(sync_engine, "after_cursor_execute", _after)
