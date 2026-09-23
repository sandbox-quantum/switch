"""Database statements are timed, and the statement never becomes a label.

The pool gauges answer "are we holding too many connections". They cannot
answer "is anything slow", which is what a request taking two seconds actually
raises — and on this server a request is a handful of queries and very little
else, so a slow endpoint is nearly always a slow query. Until this existed
there was no query-duration signal of any kind: `grep '\\.observe('` over the
package returned two hits, neither of them the database.

The privacy half matters as much as the timing half. The statement text is the
most obviously useful attribute and the one that must never be one: it is
unbounded, and it carries literals on some paths.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from switch_core.observability.catalogue import DB_QUERY_DURATION
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.observability.query import _operation, instrument_queries


@pytest.fixture
def registry():
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _durations(registry: MetricsRegistry) -> dict[str, tuple[int, float]]:
    """`operation` → (count, total ms), for whatever was recorded."""
    for payload in registry.collect():
        if payload.name != DB_QUERY_DURATION.name:
            continue
        return {
            point.attributes["operation"]: (point.count, point.total)
            for point in payload.histograms
        }
    return {}


class TestTheOperationLabel:
    """A fixed table, so the series count is the size of that table however
    many distinct statements the server runs."""

    @pytest.mark.parametrize(
        ("statement", "expected"),
        [
            ("SELECT 1", "select"),
            ("  select 1", "select"),
            ("\n\tSELECT\n  1", "select"),
            ("INSERT INTO rooms (id) VALUES ('r')", "insert"),
            ("UPDATE rooms SET name = 'x'", "update"),
            ("DELETE FROM rooms", "delete"),
            ("BEGIN", "other"),
            ("SET LOCAL app.tenant_id = 'acme'", "other"),
            ("CREATE TABLE t (a int)", "other"),
            ("", "other"),
            ("   ", "other"),
        ],
    )
    def test_it_is_the_leading_keyword_or_other(
        self, statement: str, expected: str
    ) -> None:
        assert _operation(statement) == expected

    def test_a_statement_never_becomes_the_label(self) -> None:
        """The whole point. A room id or an email in a literal would otherwise
        become a metric series — unbounded, and on a dashboard read by people
        not entitled to that tenant's rows."""
        statement = "SELECT * FROM users WHERE email = 'someone@example.test'"

        assert _operation(statement) == "select"
        assert "example.test" not in _operation(statement)

    def test_every_label_it_can_produce_is_a_small_fixed_set(self) -> None:
        produced = {
            _operation(s)
            for s in [
                "SELECT",
                "INSERT",
                "UPDATE",
                "DELETE",
                "BEGIN",
                "COMMIT",
                "WITH x AS (SELECT 1) SELECT * FROM x",
                "EXPLAIN SELECT 1",
                "",
            ]
        }
        assert produced == {"select", "insert", "update", "delete", "other"}


@pytest.mark.asyncio
class TestTimingARealDatabase:
    async def test_it_times_the_round_trip(
        self, engine: AsyncEngine, registry: MetricsRegistry
    ) -> None:
        """`pg_sleep` is the only way to assert the measurement is the
        database's time rather than a constant: a bound below the sleep proves
        the clock is around the driver call, and one above it proves the
        reading is not the process uptime."""
        instrument_queries(engine)
        async with engine.connect() as conn:
            await conn.execute(text("SELECT pg_sleep(0.05)"))

        recorded = _durations(registry)
        count, total = recorded["select"]
        assert count == 1
        assert 50.0 <= total < 5_000.0

    async def test_each_operation_gets_its_own_series(
        self, engine: AsyncEngine, registry: MetricsRegistry
    ) -> None:
        instrument_queries(engine)
        async with engine.begin() as conn:
            await conn.execute(text("CREATE TEMP TABLE q (a int)"))
            await conn.execute(text("INSERT INTO q VALUES (1)"))
            await conn.execute(text("SELECT * FROM q"))
            await conn.execute(text("UPDATE q SET a = 2"))
            await conn.execute(text("DELETE FROM q"))

        recorded = _durations(registry)
        assert {"insert", "select", "update", "delete"} <= set(recorded)
        assert recorded["insert"][0] == 1

    async def test_a_failed_statement_is_not_timed(
        self, engine: AsyncEngine, registry: MetricsRegistry
    ) -> None:
        """A query that failed in four milliseconds is not evidence the
        database is fast. Mixing the two pulls the percentiles down exactly
        when something is wrong, which is when they are being read."""
        instrument_queries(engine)
        async with engine.connect() as conn:
            with pytest.raises(Exception):
                await conn.execute(text("SELECT * FROM a_table_that_is_not_there"))

        assert _durations(registry) == {}

    async def test_instrumenting_twice_does_not_double_count(
        self, engine: AsyncEngine, registry: MetricsRegistry
    ) -> None:
        """Both engines are built once, but a listener registered twice counts
        every query twice — invisible in a rate, and it doubles a p50.

        SQLAlchemy is what provides this: it refuses a `(target, identifier,
        fn)` it already holds, and both listeners are module-level functions so
        the identity matches. Pinned here rather than assumed, because it stops
        being true the moment either becomes a closure or a bound method — a
        refactor with no other visible effect."""
        instrument_queries(engine)
        instrument_queries(engine)

        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))

        assert _durations(registry)["select"][0] == 1

    async def test_it_records_nothing_when_no_registry_is_installed(
        self, engine: AsyncEngine
    ) -> None:
        """The listeners are wired unconditionally at startup, so on a server
        with no `OTLP_ENDPOINT` every query runs through them into the null
        registry. That must be a no-op rather than an error, or observability
        being off would break the database."""
        uninstall()
        instrument_queries(engine)

        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))


@pytest.fixture
async def engine(postgres_url: str):
    engine = create_async_engine(postgres_url)
    yield engine
    await engine.dispose()
