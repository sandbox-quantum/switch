"""A bridge told which agents changed reads only those.

Every process runs a copy of each bridge, and every copy is told when an
agent is registered, renamed or deleted anywhere in its tenant. Each used to
read every agent of the tenant then; with thousands of agents being created,
that kept every process busy for as long as the creation lasted. The copy now
keeps the tenant's agents as it last read them and reads again only the
agents a change names (`CollaborationCore._update_agent_identities`).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.adapter import AgentIdentity
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore

_TENANT = "tenant-a"


def _agent(name: str, *, description: str = "helps") -> SimpleNamespace:
    return SimpleNamespace(
        id=f"agent-{name}",
        client_id=f"client-{name}",
        name=name,
        description=description,
        display_name=None,
    )


class _Store:
    """The tenant's agent rows, and what was read of them."""

    def __init__(self, *agents: SimpleNamespace) -> None:
        self.rows = {agent.client_id: agent for agent in agents}
        self.full_reads = 0
        self.named_reads: list[list[str]] = []
        self.hold_full_read: asyncio.Event | None = None

    async def get_all(self, session: Any) -> list[SimpleNamespace]:
        self.full_reads += 1
        if self.hold_full_read is not None:
            await self.hold_full_read.wait()
        return list(self.rows.values())

    async def get_by_client_ids(
        self, session: Any, client_ids: list[str]
    ) -> list[SimpleNamespace]:
        self.named_reads.append(client_ids)
        return [self.rows[c] for c in client_ids if c in self.rows]


class _Adapter:
    """What the platform was asked to do."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.provisioned: list[list[str]] = []

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        self.calls.append(("remove", agent.name))

    async def rename_agent_identity(self, old_name: str, agent: AgentIdentity) -> None:
        self.calls.append(("rename", (old_name, agent.name)))

    async def update_agent_identity(self, agent: AgentIdentity) -> None:
        self.calls.append(("update", agent.name))

    async def sync_agent_identities(
        self, agents: Sequence[AgentIdentity]
    ) -> list[tuple[str, BaseException]]:
        self.provisioned.append(sorted(agent.name for agent in agents))
        return []


@asynccontextmanager
async def _session() -> AsyncIterator[object]:
    yield object()


def _core(store: _Store) -> tuple[CollaborationCore, _Adapter]:
    """A CollaborationCore with only what identity provisioning touches."""
    core = object.__new__(CollaborationCore)
    adapter = _Adapter()
    core._bridge_type = "slack"  # type: ignore[attr-defined]
    core._bridge_tenant_id = _TENANT  # type: ignore[attr-defined]
    core._session_factory = _session  # type: ignore[attr-defined]
    core._agent_store = store  # type: ignore[attr-defined]
    core._adapter = adapter  # type: ignore[attr-defined]
    core._identity_task = None  # type: ignore[attr-defined]
    core._provisioned_agents = {}  # type: ignore[attr-defined]
    core._agent_view = None  # type: ignore[attr-defined]
    core._agent_of_client = {}  # type: ignore[attr-defined]
    core._identities_stale = False  # type: ignore[attr-defined]
    core._identities_owed = set()  # type: ignore[attr-defined]
    return core, adapter


async def _settled(core: CollaborationCore) -> None:
    task = core._identity_task
    assert task is not None
    await asyncio.wait_for(task, timeout=1)


async def _started(store: _Store) -> tuple[CollaborationCore, _Adapter]:
    """A bridge copy that has read and provisioned every agent, as at start."""
    core, adapter = _core(store)
    core._provision_identities_on_attach()
    await _settled(core)
    adapter.calls.clear()
    adapter.provisioned.clear()
    return core, adapter


async def test_a_new_agent_is_read_alone_and_provisioned() -> None:
    store = _Store(_agent("scout"), _agent("scribe"))
    core, adapter = await _started(store)
    store.rows["client-tracker"] = _agent("tracker")

    core.agents_changed({"client-tracker"})
    await _settled(core)

    assert store.full_reads == 1
    assert store.named_reads == [["client-tracker"]]
    assert adapter.provisioned == [["scout", "scribe", "tracker"]]


async def test_an_agent_deleted_elsewhere_loses_its_identity_here() -> None:
    store = _Store(_agent("scout"), _agent("scribe"))
    core, adapter = await _started(store)
    del store.rows["client-scribe"]

    core.agents_changed({"client-scribe"})
    await _settled(core)

    assert adapter.calls == [("remove", "scribe")]
    assert adapter.provisioned == [["scout"]]
    assert "agent-scribe" not in core._provisioned_agents
    assert store.full_reads == 1


async def test_an_agent_renamed_elsewhere_is_renamed_here() -> None:
    store = _Store(_agent("scout"))
    core, adapter = await _started(store)
    renamed = _agent("scout")
    renamed.name = "pathfinder"
    store.rows["client-scout"] = renamed

    core.agents_changed({"client-scout"})
    await _settled(core)

    assert adapter.calls == [("rename", ("scout", "pathfinder"))]
    assert adapter.provisioned == [["pathfinder"]]


async def test_agents_not_named_are_left_as_last_read() -> None:
    """A description edited elsewhere sends no signal of its own; the client
    re-check finds it and reads every agent again (`None`)."""
    store = _Store(_agent("scout"), _agent("scribe"))
    core, adapter = await _started(store)
    store.rows["client-scribe"] = _agent("scribe", description="writes things")

    core.agents_changed({"client-scout"})
    await _settled(core)
    assert adapter.calls == []

    core.agents_changed(None)
    await _settled(core)
    assert adapter.calls == [("update", "scribe")]
    assert store.full_reads == 2


async def test_a_change_before_any_full_read_reads_every_agent() -> None:
    store = _Store(_agent("scout"))
    core, adapter = _core(store)

    core.agents_changed({"client-scout"})
    await _settled(core)

    assert store.full_reads == 1
    assert store.named_reads == []
    assert adapter.provisioned == [["scout"]]


async def test_a_change_during_a_full_read_is_read_after_it() -> None:
    """The full read may have seen the tenant before the change committed."""
    store = _Store(_agent("scout"))
    core, adapter = await _started(store)
    store.hold_full_read = asyncio.Event()
    core.agents_changed(None)
    await asyncio.sleep(0)
    assert store.full_reads == 2

    store.rows["client-tracker"] = _agent("tracker")
    core.agents_changed({"client-tracker"})
    store.hold_full_read.set()
    await _settled(core)

    assert store.named_reads == [["client-tracker"]]
    assert adapter.provisioned[-1] == ["scout", "tracker"]


async def test_a_change_during_the_first_read_reads_every_agent_again() -> None:
    """With nothing read yet there is nothing to read the named agents into."""
    store = _Store(_agent("scout"))
    core, adapter = _core(store)
    store.hold_full_read = asyncio.Event()
    core._provision_identities_on_attach()
    await asyncio.sleep(0)

    store.rows["client-tracker"] = _agent("tracker")
    core.agents_changed({"client-tracker"})
    store.hold_full_read.set()
    await _settled(core)

    assert store.full_reads == 2
    assert adapter.provisioned[-1] == ["scout", "tracker"]
