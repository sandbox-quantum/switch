"""What a periodic re-check compares before reading a whole table again.

A re-check exists for the signal that never arrived, and on a quiet
deployment it finds nothing to repair. Reading every row to learn that costs
the same on every process every time, so a re-check first asks the database
for a fingerprint of the rows it would read: their count and the sum of a
60-bit hash of the columns it acts on. Equal fingerprints mean no row it acts
on was added, removed or changed since the read the stored one came from.
Computed by the database, so asking costs one row however many there are.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import (
    BigInteger,
    ColumnElement,
    SQLColumnExpression,
    cast,
    func,
    literal,
)
from sqlalchemy.dialects.postgresql import BIT

# A row count and the sum of the rows' hashes.
Fingerprint = tuple[int, int]

_FIELD_SEPARATOR = "\x1f"


def row_hash(*fields: SQLColumnExpression[Any]) -> ColumnElement[int]:
    """The first 15 hex digits of the md5 of `fields`, read as a 60-bit
    number. A NULL field hashes as the empty string; pass `coalesce` where
    NULL and empty must differ."""
    joined = func.concat_ws(_FIELD_SEPARATOR, *fields)
    return cast(
        cast(literal("x") + func.substr(func.md5(joined), 1, 15), BIT(60)),
        BigInteger,
    )
