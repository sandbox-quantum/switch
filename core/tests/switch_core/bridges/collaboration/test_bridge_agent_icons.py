"""An agent's own icon reaches the collaboration bridges (CHOO-2171).

The bridges are where an icon is actually seen by people, and the adapters hold
no database, so the bridge core supplies the lookup. These pin the two halves:
the core answering with the agent's icon (or nothing), and the adapter choosing
between that answer and the icon the agent's name generates.
"""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.agent_icon import generated_icon_url, initials_icon_url
from switch_core.bridges.collaboration.adapter import (
    AgentPresentation,
    PlatformAdapter,
)
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)

_CUSTOM = "https://cdn.example.com/9.x/bottts/png?seed=chosen"


class _Session:
    async def __aenter__(self) -> _Session:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None


class _AgentStore:
    def __init__(self, agents: dict[str, SimpleNamespace]) -> None:
        self._agents = agents

    async def get_by_name(self, session: Any, name: str) -> SimpleNamespace | None:
        return self._agents.get(name)


def _bridge(agents: dict[str, SimpleNamespace]) -> CollaborationCore:
    bridge = CollaborationCore.__new__(CollaborationCore)
    bridge._bridge_tenant_id = "tenant-1"
    bridge._agent_store = _AgentStore(agents)  # type: ignore[assignment]
    bridge._session_factory = _Session  # type: ignore[assignment]
    return bridge


def _agent(icon_url: str | None) -> SimpleNamespace:
    return SimpleNamespace(name="worker", display_name=None, icon_url=icon_url)


class _Adapter(PlatformAdapter):
    """Concrete only so it can be instantiated — the icon plumbing under test
    lives entirely on the base class, and none of the platform methods are
    called here."""

    async def start(self, *a: Any, **k: Any) -> Any: ...
    async def stop(self, *a: Any, **k: Any) -> Any: ...
    async def send_message(self, *a: Any, **k: Any) -> Any: ...
    async def send_typing(self, *a: Any, **k: Any) -> Any: ...
    async def update_message(self, *a: Any, **k: Any) -> Any: ...
    async def delete_message(self, *a: Any, **k: Any) -> Any: ...
    async def create_channel(self, *a: Any, **k: Any) -> Any: ...
    async def get_channel_type(self, *a: Any, **k: Any) -> Any: ...
    async def get_channel_agent_names(self, *a: Any, **k: Any) -> Any: ...
    async def add_agents_to_channel(self, *a: Any, **k: Any) -> Any: ...
    async def add_users_to_channel(self, *a: Any, **k: Any) -> Any: ...
    async def create_agent_identity(self, *a: Any, **k: Any) -> Any: ...
    async def remove_agent_identity(self, *a: Any, **k: Any) -> Any: ...
    def translate_inbound(self, *a: Any, **k: Any) -> Any: ...
    def _render_outbound(self, *a: Any, **k: Any) -> Any: ...


class TestCollaborationCoreResolver:
    async def test_returns_the_agents_own_icon(self) -> None:
        bridge = _bridge({"worker": _agent(_CUSTOM)})
        found = await bridge._agent_presentation("worker")
        assert found is not None
        assert found.icon_url == _CUSTOM

    async def test_returns_none_when_the_agent_has_no_icon(self) -> None:
        """None, not a default — choosing the default is the adapter's job, so
        each platform keeps the one it has always produced."""
        bridge = _bridge({"worker": _agent(None)})
        found = await bridge._agent_presentation("worker")
        assert found is not None
        assert found.icon_url is None

    async def test_returns_none_for_a_name_that_is_not_an_agent(self) -> None:
        """Bridges also render aliases and third-party bots. An unknown name is
        not an error here — the caller only wants to know whether to override."""
        bridge = _bridge({})
        assert await bridge._agent_presentation("some-slack-bot") is None


def _with_third_party_avatars() -> _Adapter:
    """An adapter as the lifecycle starts it under the default config."""
    adapter = _Adapter()
    adapter.set_third_party_avatars(True)
    return adapter


class TestAdapterIconSelection:
    async def test_draws_an_agent_face_when_no_resolver_is_installed(self) -> None:
        # Nothing can say who is who, and the senders an adapter draws are
        # overwhelmingly agents: drawing them all as people would be the worse
        # mistake.
        adapter = _with_third_party_avatars()
        assert await adapter.agent_icon_url("worker") == generated_icon_url("worker")

    async def test_says_once_that_no_resolver_is_installed(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        adapter = _with_third_party_avatars()
        with caplog.at_level(logging.WARNING):
            await adapter.agent_icon_url("worker")
            await adapter.agent_icon_url("manager")
        reports = [
            r for r in caplog.records if "no agent presentation resolver" in r.message
        ]
        assert len(reports) == 1

    async def test_prefers_the_agents_own_icon(self) -> None:
        adapter = _with_third_party_avatars()

        async def resolver(name: str) -> AgentPresentation | None:
            return AgentPresentation(display_name=None, icon_url=_CUSTOM)

        adapter.set_agent_presentation_resolver(resolver)
        assert await adapter.agent_icon_url("worker") == _CUSTOM

    async def test_falls_back_to_the_default_when_the_agent_has_none(self) -> None:
        adapter = _with_third_party_avatars()

        async def resolver(name: str) -> AgentPresentation | None:
            return AgentPresentation(display_name=None, icon_url=None)

        adapter.set_agent_presentation_resolver(resolver)
        assert await adapter.agent_icon_url("worker") == generated_icon_url("worker")

    async def test_an_end_to_end_override_through_the_bridge_resolver(self) -> None:
        """The two halves wired together, which is the thing that actually has
        to work and which neither test above proves on its own."""
        bridge = _bridge({"worker": _agent(_CUSTOM), "plain": _agent(None)})
        adapter = _with_third_party_avatars()
        adapter.set_agent_presentation_resolver(bridge._agent_presentation)

        assert await adapter.agent_icon_url("worker") == _CUSTOM
        assert await adapter.agent_icon_url("plain") == generated_icon_url("plain")
        assert await adapter.agent_icon_url("alice") == initials_icon_url("alice")


class TestThirdPartyAvatarsOff:
    """With `THIRD_PARTY_AVATARS_ENABLED=false` no sender's name goes into a
    URL that a platform, or Switch itself, fetches from an avatar service."""

    @pytest.mark.parametrize(
        "presentation",
        [
            AgentPresentation(display_name=None, icon_url=None),
            AgentPresentation(display_name=None, icon_url=generated_icon_url("worker")),
            AgentPresentation(display_name=None, icon_url=initials_icon_url("worker")),
            AgentPresentation(
                display_name=None,
                icon_url="https://api.dicebear.com./10.x/gaze/png?seed=worker",
            ),
            AgentPresentation(
                display_name=None,
                icon_url="https://avatars.dicebear.com/api/bottts/worker.png",
            ),
            None,
        ],
        ids=[
            "agent-without-icon",
            "stored-generated",
            "stored-initials",
            "stored-trailing-dot-host",
            "stored-other-subdomain",
            "person",
        ],
    )
    async def test_sends_no_icon_rather_than_a_generated_one(
        self, presentation: AgentPresentation | None
    ) -> None:
        adapter = _Adapter()
        adapter.set_third_party_avatars(False)

        async def resolver(name: str) -> AgentPresentation | None:
            return presentation

        adapter.set_agent_presentation_resolver(resolver)
        assert await adapter.agent_icon_url("worker") is None

    async def test_an_adapter_nobody_configured_sends_none(self) -> None:
        """The lifecycle turns them on from config. An adapter it never told
        withholds them, so missed wiring shows platform defaults rather than
        sending names an operator kept in."""
        adapter = _Adapter()

        async def resolver(name: str) -> AgentPresentation | None:
            return AgentPresentation(display_name=None, icon_url=None)

        adapter.set_agent_presentation_resolver(resolver)
        assert await adapter.agent_icon_url("worker") is None

    async def test_sends_no_icon_without_a_resolver(self) -> None:
        adapter = _Adapter()
        adapter.set_third_party_avatars(False)
        assert await adapter.agent_icon_url("worker") is None

    async def test_an_agents_own_icon_still_goes_out(self) -> None:
        adapter = _Adapter()
        adapter.set_third_party_avatars(False)

        async def resolver(name: str) -> AgentPresentation | None:
            return AgentPresentation(display_name=None, icon_url=_CUSTOM)

        adapter.set_agent_presentation_resolver(resolver)
        assert await adapter.agent_icon_url("worker") == _CUSTOM

    async def test_mattermost_fetches_nothing_for_an_agent_without_an_icon(
        self,
    ) -> None:
        adapter = MattermostAdapter(
            config=MattermostConnectionConfig(
                url="http://mattermost.invalid",
                admin_user="admin",
                admin_password="pw",
                team_name="team",
            )
        )
        adapter.set_third_party_avatars(False)
        adapter._admin_driver = object()  # type: ignore[assignment]
        adapter._main_loop = asyncio.get_running_loop()
        fetched: list[str] = []

        async def fetch_icon(url: str) -> bytes | None:
            fetched.append(url)
            return None

        async def resolver(name: str) -> AgentPresentation | None:
            return AgentPresentation(display_name=None, icon_url=None)

        adapter._fetch_icon = fetch_icon  # type: ignore[method-assign]
        adapter.set_agent_presentation_resolver(resolver)
        await adapter._set_bot_icon("bot-1", "worker")
        assert fetched == []
