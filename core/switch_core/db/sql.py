"""SQL construction helpers shared by the stores.

Small enough to be obvious, kept here rather than in any one store because
the reason they exist is cross-cutting: what a query costs in Python, not
what it means.
"""

from __future__ import annotations

from collections.abc import Collection

from sqlalchemy import ColumnElement, SQLColumnExpression, Text, any_, literal
from sqlalchemy.dialects.postgresql import ARRAY


def any_of(
    column: SQLColumnExpression[str] | SQLColumnExpression[str | None],
    values: Collection[str],
) -> ColumnElement[bool]:
    """``column = ANY(:array)`` — the form of ``column.in_(values)`` that does
    no work per execution.

    Not a caching fix, though it is easy to assume so. `in_()` compiles to a
    single `__[POSTCOMPILE_x]` placeholder, so the *compiled statement* caches
    perfectly well however many values you pass. The cost is what the cache
    cannot cover: on **every execution** SQLAlchemy has to expand that
    placeholder back into one bind parameter per element and re-render that
    fragment of SQL — `_process_parameters_for_postcompile`,
    `_literal_execute_expanding_parameter`, `_render_bindtemplate`. The work
    is proportional to the length of the list and is paid again every single
    time, cache hit or not.

    Measured on this schema: ~14 µs per execution at 10 values, ~52 µs at 70,
    ~136 µs at 200. Passing the list as one Postgres array parameter instead
    takes it to ~0.5 µs flat, because there is no placeholder left to expand.
    Same plan, same rows; only the Python goes.

    A profile of the pilot during a reconnect burst put that machinery at ~12%
    of on-CPU time, against essentially nothing when idle — see
    `HANDOFF-pilot-stability.md`.

    Only worth reaching for where the list is long or the query is frequent —
    the saving scales with both. A two-element `in_(("answered", "expired"))`
    costs a few microseconds and is clearer left alone.

    Empty input is the caller's to handle: `= ANY('{}')` is valid and matches
    nothing, which is usually right, but a caller that can short-circuit
    should, to save the round trip entirely.

    Nullable columns are fine, and behave as `in_` does: a row whose value is
    NULL matches nothing, because `NULL = ANY(...)` is NULL rather than true.
    """
    return column == any_(literal(list(values), ARRAY(Text)))
