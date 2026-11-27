"""An agent call reaches only its own workspace's running client.

The client registry holds every workspace's clients, so each lookup names the
workspace it is for. An agent id that belongs to another workspace is
answered exactly as one with no running client.
"""

from __future__ import annotations

from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.clients.actor import AgentActor
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.tenant_context import tenant_scope
from tests.ownership import NeverOwned

_AGENT = "agent-of-b"


class _RecordingAgent(AgentActor):
    """An agent's actor that records what it is asked to post."""

    def __init__(self, agent_id: str) -> None:
        self._agent = SimpleNamespace(id=agent_id)  # type: ignore[assignment]
        self.transport = None
        self.sent: list[tuple[str, str]] = []

    async def send_message(self, room_id: str, body: str, **_: Any) -> str:  # type: ignore[override]
        self.sent.append((room_id, body))
        return "$evt"


def _lifecycle(actor: AgentActor, tenant_id: str) -> ClientLifecycleService:
    service = ClientLifecycleService(
        provisioning=MagicMock(),
        client_store=MagicMock(),
        tenant_store=MagicMock(),
        client_factory=MagicMock(),
        session_factory=MagicMock(),
        config=MagicMock(),
        tenants_isolated=True,
        ownership=NeverOwned(),  # type: ignore[arg-type]
        cursor_writer=MagicMock(),
    )
    service._track("client-b", actor, "agent", tenant_id)
    return service


@pytest.fixture
def actor() -> _RecordingAgent:
    return _RecordingAgent(_AGENT)


@pytest.fixture
def core(actor: _RecordingAgent) -> AgentCore:
    async def member(agent_id: str, room_id: str) -> Any:
        return SimpleNamespace(
            id=room_id, transport_room_id="!room", bridge_id=None, frozen=False
        )

    svc = object.__new__(AgentCore)
    svc.client_lifecycle = _lifecycle(actor, "tenant-b")
    svc.require_room_member = member  # type: ignore[method-assign]
    svc.require_room_poster = member  # type: ignore[method-assign]
    return svc


@pytest.fixture
def in_tenant_a() -> Iterator[None]:
    with tenant_scope("tenant-a"):
        yield


@pytest.mark.usefixtures("in_tenant_a")
class TestAnotherWorkspacesAgent:
    async def test_cannot_send_a_message_through_its_client(
        self, core: AgentCore, actor: _RecordingAgent
    ) -> None:
        with pytest.raises(ValueError, match="Agent client not running"):
            await core.send_message(_AGENT, "room-1", "hello")
        assert actor.sent == []

    async def test_cannot_send_media_through_its_client(self, core: AgentCore) -> None:
        core.config = SimpleNamespace(agent_media_max_bytes=100)  # type: ignore[assignment]
        with pytest.raises(ValueError, match="Agent client not running"):
            await core.send_media(_AGENT, "room-1", [(b"x", "a.txt", "text/plain")])

    async def test_cannot_set_a_status_through_its_client(
        self, core: AgentCore
    ) -> None:
        with pytest.raises(ValueError, match="Agent client not running"):
            await core.update_status(_AGENT, "room-1", "working")

    async def test_cannot_download_through_its_client(self, core: AgentCore) -> None:
        with pytest.raises(ValueError, match="Agent client not running"):
            await core.download_media(_AGENT, "room-1", "mxc://s/file")

    async def test_cannot_report_events_through_its_client(
        self, core: AgentCore
    ) -> None:
        with pytest.raises(ValueError, match="Agent client not running"):
            await core.report_events(_AGENT, "room-1", [])

    async def test_its_client_announces_nothing(
        self, core: AgentCore, actor: _RecordingAgent
    ) -> None:
        await core._post_role_change_notice(_AGENT, "tenant-a", "!room", "assumed")
        await core._announce_document(_AGENT, "tenant-a", "!room", "created")
        await core._emit_runtime_state(
            agent_id=_AGENT,
            tenant_id="tenant-a",
            agent_name="b",
            transport_room_id="!room",
            room_id="room-1",
            state="idle",
            mention_handle=None,
            thread_id=None,
        )
        assert actor.sent == []


async def test_its_own_workspace_still_reaches_it(
    core: AgentCore, actor: _RecordingAgent
) -> None:
    with tenant_scope("tenant-b"):
        with pytest.raises(ValueError, match="Agent client not connected"):
            await core.download_media(_AGENT, "room-1", "mxc://s/file")
    await core._post_role_change_notice(_AGENT, "tenant-b", "!room", "assumed")
    assert actor.sent == [("!room", "🎭 assumed.")]
