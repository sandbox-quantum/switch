from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import InboundMessage

# When a user tags the bridge bot itself ("Agent Switch") but the bot is not set
# as an alias for any agent in the room, the bridge posts guidance instead of
# letting the mention fall through silently. If the bot IS an alias, the normal
# routing delivers to the aliased agent, so no guidance is posted.


def _msg(
    *, self_mention_token: str | None, root_id: str | None = None
) -> InboundMessage:
    return InboundMessage(
        channel_id="C123",
        channel_type="channel_public",
        sender_id="U1",
        sender_name="alice",
        content="hey <@UBOT>",
        message_ref="C123:500.5",
        root_id=root_id,
        self_mention_token=self_mention_token,
    )


class _FakeSession:
    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False


def _fake_bridge(*, alias_agent: str | None, agents: dict[str, SimpleNamespace]):  # noqa: ANN202
    notices: list[tuple[str, str, str | None]] = []

    class _RoomStore:
        async def get_agent_id_by_alias(
            self, session: Any, room_id: str, token: str
        ) -> str | None:
            return alias_agent

        async def get_agent_ids(self, session: Any, room_id: str) -> list[str]:
            return list(agents.keys())

    class _AgentStore:
        async def get(self, session: Any, aid: str) -> SimpleNamespace | None:
            return agents.get(aid)

    class _Adapter:
        def render_app_mention(self, token: str) -> str:
            # Slack's form, which is what the base class renders and what these
            # assertions are written against. A platform that reads it
            # differently overrides it — that is the point of the hook.
            return f"<@{token}>"

        async def admin_message(
            self,
            channel_id: str,
            content: str,
            thread_root_id: str | None = None,
            *,
            message_type: str | None = None,
        ) -> str:
            notices.append((channel_id, content, thread_root_id))
            return "C123:999.9"

    return SimpleNamespace(
        _session_factory=_FakeSession,
        _room_store=_RoomStore(),
        _agent_store=_AgentStore(),
        _adapter=_Adapter(),
        notices=notices,
    )


def _agent(name: str) -> SimpleNamespace:
    return SimpleNamespace(name=name, description=f"{name} does things")


async def test_unaliased_self_mention_posts_guidance() -> None:
    bridge = _fake_bridge(
        alias_agent=None,
        agents={"a1": _agent("agent-a"), "a2": _agent("agent-b")},
    )

    await BridgeCore._maybe_guide_self_mention(
        bridge, _msg(self_mention_token="UBOT"), "room-uuid"
    )

    assert len(bridge.notices) == 1
    channel_id, content, thread_root_id = bridge.notices[0]
    assert channel_id == "C123"
    # Threads under the triggering message when it is top-level.
    assert thread_root_id == "C123:500.5"
    # Lists the room's agents with their descriptions, one per line.
    assert "• @agent-a — agent-a does things" in content
    assert "• @agent-b — agent-b does things" in content
    # Shows the full set-alias command on its own line (copy-paste friendly),
    # with the app mention as the target.
    assert "\n!set-alias @agent_name <@UBOT>" in content


async def test_aliased_self_mention_posts_nothing() -> None:
    bridge = _fake_bridge(
        alias_agent="a1",
        agents={"a1": _agent("agent-a")},
    )

    await BridgeCore._maybe_guide_self_mention(
        bridge, _msg(self_mention_token="UBOT"), "room-uuid"
    )

    assert bridge.notices == []


async def test_no_self_mention_posts_nothing() -> None:
    bridge = _fake_bridge(alias_agent=None, agents={"a1": _agent("agent-a")})

    await BridgeCore._maybe_guide_self_mention(
        bridge, _msg(self_mention_token=None), "room-uuid"
    )

    assert bridge.notices == []


async def test_self_mention_threads_under_existing_thread_root() -> None:
    bridge = _fake_bridge(alias_agent=None, agents={"a1": _agent("agent-a")})

    await BridgeCore._maybe_guide_self_mention(
        bridge, _msg(self_mention_token="UBOT", root_id="C123:100.1"), "room-uuid"
    )

    assert bridge.notices[0][2] == "C123:100.1"


async def test_guidance_omits_set_alias_for_non_alias_safe_token() -> None:
    # A Teams bot id ("28:<guid>") can't be an alias (aliases forbid ':'), so the
    # !set-alias shortcut is omitted — but the agent list (tag by name) stays.
    bridge = _fake_bridge(
        alias_agent=None,
        agents={"a1": _agent("agent-a"), "a2": _agent("agent-b")},
    )

    await BridgeCore._maybe_guide_self_mention(
        bridge, _msg(self_mention_token="28:app-123"), "room-uuid"
    )

    assert len(bridge.notices) == 1
    _, content, _ = bridge.notices[0]
    assert "!set-alias" not in content
    assert "• @agent-a — agent-a does things" in content


async def test_resolve_target_single_agent_unaliased() -> None:
    bridge = _fake_bridge(alias_agent=None, agents={"a1": _agent("agent-a")})

    target = await BridgeCore._resolve_self_mention_target(
        bridge, _msg(self_mention_token="28:app-123"), "room-uuid"
    )

    assert target == "agent-a"


async def test_resolve_target_uses_alias_even_with_many_agents() -> None:
    bridge = _fake_bridge(
        alias_agent="a2",
        agents={"a1": _agent("agent-a"), "a2": _agent("agent-b")},
    )

    target = await BridgeCore._resolve_self_mention_target(
        bridge, _msg(self_mention_token="UBOT"), "room-uuid"
    )

    assert target == "agent-b"


async def test_resolve_target_ambiguous_returns_none() -> None:
    bridge = _fake_bridge(
        alias_agent=None,
        agents={"a1": _agent("agent-a"), "a2": _agent("agent-b")},
    )

    target = await BridgeCore._resolve_self_mention_target(
        bridge, _msg(self_mention_token="28:app-123"), "room-uuid"
    )

    assert target is None


async def test_resolve_target_no_token_returns_none() -> None:
    bridge = _fake_bridge(alias_agent=None, agents={"a1": _agent("agent-a")})

    target = await BridgeCore._resolve_self_mention_target(
        bridge, _msg(self_mention_token=None), "room-uuid"
    )

    assert target is None
