"""Which constraint an integrity error came from."""

from __future__ import annotations

from sqlalchemy.exc import IntegrityError


def violated_constraint(error: IntegrityError) -> str | None:
    """The name of the constraint Postgres refused on, if it named one.

    A table with several constraints raises one exception type for all of them
    and the caller cannot tell which rule it broke, so a store that has to
    answer them differently reads the name rather than guessing from what it
    tried to insert. `None` when the driver is not asyncpg or the error is not
    a constraint violation, in which case the caller re-raises.
    """
    cause = getattr(error.orig, "__cause__", None)
    return getattr(cause, "constraint_name", None)
