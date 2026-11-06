"""Statements run by asyncpg directly, for the reads every message costs.

Profiled under load, SQLAlchemy is about half of what switch-core spends its
CPU on, and most of that is per statement rather than per row: the execution
context, its events, the cursor adapter, the result and its rows. For a
statement every delivered message runs, that costs more than Postgres takes to
run it.

A `RawStatement` is still written in SQLAlchemy and compiled by it, once. It is
then run by asyncpg on the session's own connection, in the session's
transaction, so the tenant that transaction was opened with and row-level
security apply to it as to any other statement. What SQLAlchemy would do with
its parameters and columns is done here too: each goes through its type's
processor for the dialect, the connection's codecs are the ones SQLAlchemy set
up, the tenant binding is checked against the transaction's
(`refuse_drift`), and the statement is timed into `db.query.duration` as
`observability/query.py` times the others.

What is different: a row is a named tuple of the selected columns, not an ORM
object, and nothing is added to the session. A statement whose parameters
expand when it runs (`in_` over a list) cannot be compiled once, so it is
refused; `= any(:array)` is the form that can.
"""

from __future__ import annotations

import time
from collections import namedtuple
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any, cast

from sqlalchemy.engine import Dialect
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import ClauseElement
from sqlalchemy.sql.compiler import SQLCompiler
from sqlalchemy.sql.selectable import Select

from switch_core.db.tenant_session import refuse_drift
from switch_core.observability.catalogue import DB_QUERY_DURATION
from switch_core.observability.metrics import metrics
from switch_core.observability.query import query_operation
from switch_core.tenant_context import current_tenant_id

_Processor = Callable[[Any], Any]


@dataclass(frozen=True)
class _Compiled:
    sql: str
    operation: str
    # The parameters in the order the statement numbers them, each with its
    # type's bind processor, whether a value must be passed for it, and the
    # value it was given when built otherwise.
    parameters: tuple[tuple[str, _Processor | None, bool, Any], ...]
    # One per selected column, None for a statement that declares none.
    columns: tuple[_Processor | None, ...] | None
    row: Callable[[Iterable[Any]], tuple[Any, ...]] | None


class RawStatement:
    def __init__(self, statement: ClauseElement) -> None:
        self._statement = statement
        self._compiled: _Compiled | None = None

    @property
    def sql(self) -> str | None:
        """The SQL it runs, once it has run."""
        return self._compiled.sql if self._compiled is not None else None

    async def all(
        self, session: AsyncSession, parameters: Mapping[str, Any]
    ) -> list[Any]:
        """Every row the statement returns: a named tuple per row for a
        `select`, asyncpg's own record for a statement that names no columns."""
        connection = await session.connection()
        # The transaction was begun, and its tenant set, with the tenant bound
        # now; a raw statement is never run with none.
        refuse_drift(session.sync_session)
        if current_tenant_id() is None:
            raise RuntimeError("a raw statement runs with a tenant bound")
        compiled = self._compiled or self._compile(connection.dialect)
        arguments = []
        for name, process, required, default in compiled.parameters:
            if name in parameters:
                value = parameters[name]
            elif required:
                raise KeyError(f"no value for the statement's parameter {name!r}")
            else:
                value = default
            arguments.append(value if process is None else process(value))
        driver: Any = (await connection.get_raw_connection()).driver_connection
        if driver is None or not driver.is_in_transaction():
            raise RuntimeError("a raw statement runs in its session's transaction")
        started = time.perf_counter()
        records = await driver.fetch(compiled.sql, *arguments)
        metrics().observe(
            DB_QUERY_DURATION,
            {"operation": compiled.operation},
            (time.perf_counter() - started) * 1000.0,
        )
        if compiled.row is None or compiled.columns is None:
            return list(records)
        make = compiled.row
        columns = compiled.columns
        if not any(columns):
            return [make(record) for record in records]
        return [
            make(
                process(value) if process is not None else value
                for process, value in zip(columns, record, strict=True)
            )
            for record in records
        ]

    def _compile(self, dialect: Dialect) -> _Compiled:
        compiled = cast(SQLCompiler, self._statement.compile(dialect=dialect))
        for bind in compiled.binds.values():
            if bind.expanding:
                raise ValueError(
                    f"{bind.key!r} expands when the statement runs, so it cannot "
                    "be compiled once; compare with `= any(:array)` instead"
                )
        parameters = tuple(
            (
                name,
                compiled.binds[name].type.dialect_impl(dialect).bind_processor(dialect),
                compiled.binds[name].required,
                compiled.binds[name].value,
            )
            for name in compiled.positiontup or ()
        )
        columns: tuple[_Processor | None, ...] | None = None
        row: Callable[[Iterable[Any]], tuple[Any, ...]] | None = None
        if isinstance(self._statement, Select):
            selected = list(self._statement.selected_columns)
            columns = tuple(
                column.type.dialect_impl(dialect).result_processor(dialect, None)
                for column in selected
            )
            names = [column.key for column in selected]
            if None in names:
                raise ValueError("every column a raw statement selects is named")
            row = _row_type([name for name in names if name is not None])
        sql = str(compiled)
        self._compiled = _Compiled(
            sql=sql,
            operation=query_operation(sql),
            parameters=parameters,
            columns=columns,
            row=row,
        )
        return self._compiled


def _row_type(names: list[str]) -> Callable[[Iterable[Any]], tuple[Any, ...]]:
    """What makes a row of the selected columns, read by name or by position
    as SQLAlchemy's own rows are."""
    row = namedtuple("Row", names)  # type: ignore[misc]
    return row._make  # type: ignore[no-any-return]
