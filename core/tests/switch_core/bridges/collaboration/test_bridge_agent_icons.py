"""An agent's own icon reaches the collaboration bridges (CHOO-2171).

The bridges are where an icon is actually seen by people, and the adapters hold
no database, so the bridge core supplies the lookup. These pin the two halves:
the core answering with the agent's icon (or nothing), and the adapter choosing
between that answer and the default it has always generated.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.agent_icon import default_icon_url
from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.bridge_core import BridgeCore

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


def _bridge(agents: dict[str, SimpleNamespace]) -> BridgeCore:
    bridge = BridgeCore.__new__(BridgeCore)
    bridge._agent_store = _AgentStore(agents)  # type: ignore[assignment]
    bridge._session_factory = _Session  # type: ignore[assignment]
    return bridge


def _agent(icon_url: str | None) -> SimpleNamespace:
    return SimpleNamespace(name="worker", icon_url=icon_url)


class _Adapter(CollaborationAdapter):
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
    def translate_outbound(self, *a: Any, **k: Any) -> Any: ...


class TestBridgeCoreResolver:
    async def test_returns_the_agents_own_icon(self) -> None:
        bridge = _bridge({"worker": _agent(_CUSTOM)})
        assert await bridge._agent_icon_url("worker") == _CUSTOM

    async def test_returns_none_when_the_agent_has_no_icon(self) -> None:
        """None, not a default — choosing the default is the adapter's job, so
        each platform keeps the one it has always produced."""
        bridge = _bridge({"worker": _agent(None)})
        assert await bridge._agent_icon_url("worker") is None

    async def test_returns_none_for_a_name_that_is_not_an_agent(self) -> None:
        """Bridges also render aliases and third-party bots. An unknown name is
        not an error here — the caller only wants to know whether to override."""
        bridge = _bridge({})
        assert await bridge._agent_icon_url("some-slack-bot") is None


class TestAdapterIconSelection:
    async def test_uses_the_default_when_no_resolver_is_installed(self) -> None:
        adapter = _Adapter()
        assert await adapter.agent_icon_url("worker") == default_icon_url("worker")

    async def test_prefers_the_agents_own_icon(self) -> None:
        adapter = _Adapter()

        async def resolver(name: str) -> str | None:
            return _CUSTOM

        adapter.set_agent_icon_resolver(resolver)
        assert await adapter.agent_icon_url("worker") == _CUSTOM

    async def test_falls_back_to_the_default_when_the_agent_has_none(self) -> None:
        adapter = _Adapter()

        async def resolver(name: str) -> str | None:
            return None

        adapter.set_agent_icon_resolver(resolver)
        assert await adapter.agent_icon_url("worker") == default_icon_url("worker")

    async def test_an_end_to_end_override_through_the_bridge_resolver(self) -> None:
        """The two halves wired together, which is the thing that actually has
        to work and which neither test above proves on its own."""
        bridge = _bridge({"worker": _agent(_CUSTOM), "plain": _agent(None)})
        adapter = _Adapter()
        adapter.set_agent_icon_resolver(bridge._agent_icon_url)

        assert await adapter.agent_icon_url("worker") == _CUSTOM
        assert await adapter.agent_icon_url("plain") == default_icon_url("plain")


class TestDefaultIcon:
    async def test_is_stable_for_a_given_name(self) -> None:
        assert default_icon_url("worker") == default_icon_url("worker")

    async def test_differs_between_agents(self) -> None:
        assert default_icon_url("worker") != default_icon_url("manager")

    async def test_underscores_become_word_separators(self) -> None:
        """The avatar draws initials, so `a_b` has to read as two words rather
        than one — this is the behaviour the bridges already relied on."""
        assert "a+b" in default_icon_url("a_b")

    async def test_format_override_is_appended_for_callers_that_need_bytes(
        self,
    ) -> None:
        assert default_icon_url("worker", image_format="png").endswith("&format=png")
