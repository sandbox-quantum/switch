"""Matching a column against a list of ids of any length.

`column.in_(ids)` sends one bind parameter per id, and Postgres refuses a
statement with more than 32,767 of them. A list that grows with a deployment,
such as the rooms a client is in (Switch's own client is in every room of its
workspace, archived ones included), reaches that sooner or later, and the read
then fails every time. `any_of` sends the whole list as one array parameter.
"""

from __future__ import annotations

from collections.abc import Collection
from typing import Any

from sqlalchemy import ColumnElement, SQLColumnExpression, Text, any_, bindparam
from sqlalchemy.dialects.postgresql import ARRAY


def any_of(
    column: SQLColumnExpression[Any], ids: Collection[str]
) -> ColumnElement[bool]:
    """`column = ANY(:ids)`, with `ids` bound as one text array."""
    return column == any_(bindparam(None, list(ids), type_=ARRAY(Text)))
