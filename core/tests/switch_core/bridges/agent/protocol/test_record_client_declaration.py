"""Persisting what a client last said about itself (CHOO-1865).

Connections live in memory, so what is running right now dies with the process.
This is the durable half — and the reason it is in Part 1 at all: raising an
`accepts` floor is a decision made offline, and it can only be made safely
against a record of what is actually deployed.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.protocol.connections import ClientDeclaration
from switch_core.bridges.agent.protocol.service import ProtocolService

AGENT_ID = "agent-1"
CONNECTION_ID = "conn-1"


class _Session:
    def __init__(self) -> None:
        self.committed = False

    async def commit(self) -> None:
        self.committed = True


class _AgentStore:
    """Just enough of AgentStore to observe what would be written."""

    def __init__(
        self, metadata: dict[str, Any] | None, *, missing: bool = False
    ) -> None:
        self.agent = (
            None if missing else SimpleNamespace(id=AGENT_ID, metadata_=metadata)
        )
        self.updates: list[dict[str, Any]] = []

    async def get(self, session: Any, agent_id: str) -> Any:
        return self.agent

    async def update(self, session: Any, agent_id: str, **kwargs: Any) -> None:
        self.updates.append(kwargs)


def _service(store: _AgentStore) -> ProtocolService:
    """A ProtocolService with only the two collaborators this path touches.

    Constructed without __init__ on purpose: the real one wires two dozen
    dependencies, none of which this method uses, and threading them all
    through would test the fixture rather than the behaviour.
    """
    service = ProtocolService.__new__(ProtocolService)
    session = _Session()

    @asynccontextmanager
    async def factory():
        yield session

    service.session_factory = factory  # type: ignore[assignment]
    service.agent_store = store  # type: ignore[assignment]
    return service


async def test_a_declaration_is_written_to_agent_metadata() -> None:
    store = _AgentStore({})
    await _service(store).record_client_declaration(
        AGENT_ID,
        CONNECTION_ID,
        ClientDeclaration(
            speaks=1, accepts=1, artifact="agent-runtime", version="0.1.5"
        ),
    )

    (update,) = store.updates
    recorded = update["metadata_"]["client_declaration"]
    assert recorded["speaks"] == 1
    assert recorded["accepts"] == 1
    assert recorded["artifact"] == "agent-runtime"
    assert recorded["version"] == "0.1.5"


async def test_the_record_is_timestamped() -> None:
    """Otherwise a declaration from a year ago reads like one from today.

    Deciding whether a floor is safe to raise depends on whether anything is
    still on the old revision, which is a question about *when*.
    """
    store = _AgentStore({})
    await _service(store).record_client_declaration(
        AGENT_ID, CONNECTION_ID, ClientDeclaration(speaks=1, version="0.1.5")
    )

    (update,) = store.updates
    assert update["metadata_"]["client_declaration"]["recorded_at"]


async def test_existing_metadata_is_preserved() -> None:
    """Agent.metadata_ is shared with known_agent_options and others."""
    store = _AgentStore({"known_agent_options": {"repo_dir": "/w"}})
    await _service(store).record_client_declaration(
        AGENT_ID, CONNECTION_ID, ClientDeclaration(speaks=1, version="0.1.5")
    )

    (update,) = store.updates
    assert update["metadata_"]["known_agent_options"] == {"repo_dir": "/w"}


async def test_a_client_that_declared_nothing_writes_nothing() -> None:
    """Unknown is the absence of a record, not a record saying unknown.

    Writing one would make a silent client indistinguishable from one that
    connected and answered.
    """
    store = _AgentStore({})
    await _service(store).record_client_declaration(
        AGENT_ID, CONNECTION_ID, ClientDeclaration()
    )

    assert store.updates == []


async def test_a_client_declaring_only_its_version_is_still_recorded() -> None:
    """The artifact version is worth having even with no protocol range."""
    store = _AgentStore({})
    await _service(store).record_client_declaration(
        AGENT_ID, CONNECTION_ID, ClientDeclaration(version="0.1.5")
    )

    (update,) = store.updates
    assert update["metadata_"]["client_declaration"]["version"] == "0.1.5"


async def test_a_missing_agent_writes_nothing() -> None:
    store = _AgentStore(None, missing=True)
    await _service(store).record_client_declaration(
        AGENT_ID, CONNECTION_ID, ClientDeclaration(speaks=1, version="0.1.5")
    )

    assert store.updates == []


async def test_a_write_failure_is_warned_about_but_not_raised(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Losing a version record must never stop an agent connecting.

    Warned rather than swallowed silently: a persistently failing recorder
    leaves the same blind spot as a client that never declared, and that must
    not pass unnoticed.
    """
    store = _AgentStore({})

    async def _boom(session: Any, agent_id: str, **kwargs: Any) -> None:
        raise RuntimeError("database is on fire")

    store.update = _boom  # type: ignore[assignment]

    with caplog.at_level(logging.WARNING):
        await _service(store).record_client_declaration(
            AGENT_ID, CONNECTION_ID, ClientDeclaration(speaks=1, version="0.1.5")
        )

    assert any(record.levelno == logging.WARNING for record in caplog.records)


async def test_the_record_names_the_connection_it_came_from() -> None:
    """Found by running it against a real server (CHOO-1865).

    An agent may hold many connections at once, so without the connection id a
    second connection declaring less looks like the first client having
    forgotten what it is, rather than a different client answering.
    """
    store = _AgentStore({})
    await _service(store).record_client_declaration(
        AGENT_ID, "conn-xyz", ClientDeclaration(speaks=1, version="0.1.5")
    )

    (update,) = store.updates
    assert update["metadata_"]["client_declaration"]["connection_id"] == "conn-xyz"


async def test_the_latest_declaration_replaces_the_previous_one() -> None:
    """Last write wins: an upgraded client is not a second client."""
    store = _AgentStore({"client_declaration": {"version": "0.1.4", "speaks": 1}})
    await _service(store).record_client_declaration(
        AGENT_ID, CONNECTION_ID, ClientDeclaration(speaks=1, version="0.1.5")
    )

    (update,) = store.updates
    assert update["metadata_"]["client_declaration"]["version"] == "0.1.5"
