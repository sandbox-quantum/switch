"""Registering under a parent agent requires owning that parent."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from switch_core.bridges.agent.api.handlers import (
    register_known_agent_endpoint,
    register_known_agents_bulk_endpoint,
)
from switch_core.bridges.agent.api.schemas import (
    BulkSubagentSpec,
    RegisterKnownAgentBulkRequest,
    RegisterKnownAgentRequest,
)


def _protocol_with_parent(owner_id: str | None) -> AsyncMock:
    protocol = AsyncMock()
    parent = (
        None
        if owner_id is None
        else SimpleNamespace(
            id="parent-1", name="main", owner_id=owner_id, metadata_={}
        )
    )
    protocol.agent_store.get = AsyncMock(return_value=parent)
    return protocol


def _single_request() -> RegisterKnownAgentRequest:
    return RegisterKnownAgentRequest(
        agent_type="claude-code",
        name="main.reviewer",
        description="Reviews diffs",
        parent_agent_id="parent-1",
    )


def _bulk_request() -> RegisterKnownAgentBulkRequest:
    return RegisterKnownAgentBulkRequest(
        agent_type="claude-code",
        parent_agent_id="parent-1",
        subagents=[BulkSubagentSpec(subagent_name="reviewer", description="Reviews")],
    )


async def test_single_refuses_someone_elses_parent() -> None:
    protocol = _protocol_with_parent("alice")

    with pytest.raises(HTTPException) as exc:
        await register_known_agent_endpoint(
            _single_request(), "mallory", protocol, AsyncMock()
        )

    assert exc.value.status_code == 403
    protocol.register_agent.assert_not_awaited()


async def test_single_refuses_a_missing_parent() -> None:
    protocol = _protocol_with_parent(None)

    with pytest.raises(HTTPException) as exc:
        await register_known_agent_endpoint(
            _single_request(), "alice", protocol, AsyncMock()
        )

    assert exc.value.status_code == 404
    protocol.register_agent.assert_not_awaited()


async def test_bulk_refuses_someone_elses_parent() -> None:
    protocol = _protocol_with_parent("alice")

    with pytest.raises(HTTPException) as exc:
        await register_known_agents_bulk_endpoint(
            _bulk_request(), "mallory", protocol, AsyncMock()
        )

    assert exc.value.status_code == 403
    protocol.register_agent.assert_not_awaited()


async def test_bulk_registers_under_own_parent() -> None:
    protocol = _protocol_with_parent("alice")
    protocol.agent_store.get_by_name = AsyncMock(return_value=None)
    protocol.register_agent = AsyncMock(
        return_value=SimpleNamespace(agent_id="child-1", api_key="key")
    )

    response = await register_known_agents_bulk_endpoint(
        _bulk_request(), "alice", protocol, AsyncMock()
    )

    assert [r.name for r in response.results] == ["main.reviewer"]
    assert protocol.register_agent.await_args.kwargs["owner_id"] == "alice"
