"""The owner's managed agent and machine lists run a fixed number of statements.

Console reads both whenever its managed agents page is open, so neither may
read a row per agent or per machine: each is driven over one and over several,
and has to run exactly as many statements both times. See
`tests/switch_core/gateway/test_query_counts.py` for the gateway's own lists.
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import User
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    cookies_for,
    create_managed_agent,
    enroll_console,
    provider,
    report_status,
)
from tests.switch_core.statement_counts import StatementCounts


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _place(
    harness: Harness, client: httpx.AsyncClient, owner: User, count: int, start: int
) -> None:
    """`count` more machines, each running one more managed agent."""
    for i in range(start, start + count):
        controller = await enroll_console(harness, client, owner, name=f"machine-{i}")
        await report_status(client, controller, 1, providers=[provider("claude")])
        created = await create_managed_agent(
            client, owner, name=f"agent-{i}", controller_id=controller.controller_id
        )
        assert created.status_code == 201, created.text


async def _count(
    client: httpx.AsyncClient, counts: StatementCounts, owner: User, path: str
) -> tuple[int, list[dict[str, object]]]:
    response = await client.get(path, cookies=cookies_for(owner))
    assert response.status_code == 200, response.text
    return counts.last(f"GET {path}").count, response.json()


@pytest.mark.parametrize(
    "path", ["/gateway/management/agents", "/gateway/management/controllers"]
)
async def test_the_same_statements_for_one_and_many(
    harness: Harness, statement_counts: StatementCounts, path: str
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=statement_counts.wrap(harness.app)),
        base_url="http://test",
    ) as client:
        await _place(harness, client, owner, 1, 0)
        few, few_rows = await _count(client, statement_counts, owner, path)
        await _place(harness, client, owner, 4, 1)
        many, many_rows = await _count(client, statement_counts, owner, path)

    assert (len(few_rows), len(many_rows)) == (1, 5)
    assert few == many, statement_counts.last(f"GET {path}").statements
