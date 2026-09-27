"""`any_of` must cost nothing per execution, and mean the same as `in_`.

The hot-path stores use it instead of `in_()` because an expanding `IN`
re-renders its parameter list on *every* execution — work the compiled-
statement cache cannot avoid, and work proportional to how many values were
passed. Under a reconnect burst that machinery was ~12% of the pilot's
on-CPU time.

So there are two things to hold: the statement must carry no post-compile
parameter at all (that is the property that makes it free), and it must still
select exactly the rows `in_()` would have (that is the property that makes
it safe). A rewrite that is fast and subtly wrong is worse than the original.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, ApiKey, Client, User
from switch_core.db.sql import any_of

_DIALECT = postgresql.dialect()


def _compile(stmt):
    return stmt.compile(dialect=_DIALECT, cache_key=stmt._generate_cache_key())


class TestNoPerExecutionRendering:
    def test_in_carries_a_postcompile_parameter(self) -> None:
        # The baseline this exists to move away from: the placeholder that has
        # to be expanded again on every execute.
        compiled = _compile(select(Agent.id).where(Agent.name.in_(["a", "b"])))
        assert compiled.post_compile_params

    def test_any_of_carries_none(self) -> None:
        compiled = _compile(select(Agent.id).where(any_of(Agent.name, ["a", "b"])))
        assert not compiled.post_compile_params, (
            "any_of has grown a post-compile parameter — the per-execution "
            "re-rendering it exists to remove is back"
        )

    @pytest.mark.parametrize("size", [1, 10, 200])
    def test_sql_text_does_not_grow_with_the_list(self, size: int) -> None:
        # Not a caching claim — `in_` caches too. This is that the *rendered*
        # statement stops depending on how many values there are, which is
        # what makes the expansion step disappear.
        values = [f"v{i}" for i in range(size)]
        text = str(_compile(select(Agent.id).where(any_of(Agent.name, values))))
        assert "ANY" in text
        assert text == str(_compile(select(Agent.id).where(any_of(Agent.name, ["x"]))))


class TestSameRowsAsIn:
    """Against real Postgres: `any_of` and `in_` must not disagree."""

    async def _three_agents(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> list[str]:
        async with session_factory() as session:
            user = User(name="o", email="o@example.com", role="user")
            session.add(user)
            await session.flush()
            key = ApiKey(
                user_id=user.id,
                key_hash="hash-any-of",
                encrypted_key="x",
                label="l",
                type="agent",
            )
            session.add(key)
            await session.flush()
            names = []
            for i in range(3):
                client = Client(
                    matrix_user_id=f"@any-of-{i}:test",
                    display_name=f"a{i}",
                    type="agent",
                )
                session.add(client)
                await session.flush()
                session.add(
                    Agent(
                        name=f"any-of-{i}",
                        description="d",
                        agent_type="claude-code",
                        connector_type="mcp",
                        integration_profile={},
                        client_id=client.id,
                        api_key_id=key.id,
                        owner_id=user.id,
                    )
                )
                names.append(f"any-of-{i}")
            await session.commit()
            return names

    @pytest.mark.parametrize("take", [0, 1, 2, 3])
    async def test_matches_in_for_every_subset(
        self, session_factory: async_sessionmaker[AsyncSession], take: int
    ) -> None:
        names = await self._three_agents(session_factory)
        wanted = names[:take]
        async with session_factory() as session:
            via_in = set(
                (
                    await session.execute(
                        select(Agent.name).where(Agent.name.in_(wanted))
                    )
                )
                .scalars()
                .all()
            )
            via_any = set(
                (
                    await session.execute(
                        select(Agent.name).where(any_of(Agent.name, wanted))
                    )
                )
                .scalars()
                .all()
            )
        assert via_any == via_in == set(wanted)

    async def test_empty_matches_nothing_rather_than_everything(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The failure mode worth naming: a predicate that quietly becomes
        # "true" on an empty list would widen every caller that forgot to
        # short-circuit, and the callers here delete and authorize.
        await self._three_agents(session_factory)
        async with session_factory() as session:
            rows = (
                (
                    await session.execute(
                        select(Agent.name).where(any_of(Agent.name, []))
                    )
                )
                .scalars()
                .all()
            )
        assert rows == []
