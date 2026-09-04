from __future__ import annotations

from types import SimpleNamespace

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import (
    InboundAgentJoin,
    InboundMessage,
    InboundUserJoin,
)

# CHOO-551: a bridged Switch agent must map to a single agent participant and
# never spawn a duplicate "user" identity. The discriminator is "is this a
# registered Switch agent" (by name) — so third-party bots and humans keep
# bridging in normally, while an agent's own echo / bot-account join is routed
# away from the external-user path.


async def _noop_repair(*_args: object, **_kwargs: object) -> None:
    """Correcting a name recorded as a platform id — not what these tests turn on."""
    return None


def _msg(sender_name: str) -> InboundMessage:
    return InboundMessage(
        channel_id="chan-1",
        channel_type="channel_public",
        sender_id="ext-id",
        sender_name=sender_name,
        content="hello",
        message_ref="mm-post-1",
    )


def _join(external_username: str) -> InboundUserJoin:
    return InboundUserJoin(
        channel_id="chan-1",
        channel_type="channel_public",
        external_user_id="ext-id",
        external_username=external_username,
        channel_name="War Room",
    )


def _fake_bridge(*, agents: set[str]) -> SimpleNamespace:
    ensure_calls: list[dict[str, str]] = []
    agent_joins: list[InboundAgentJoin] = []

    async def _is_registered_agent(name: str) -> bool:
        return name in agents

    async def _ensure_user_in_matrix_room(**kwargs: str):  # noqa: ANN202
        ensure_calls.append(kwargs)
        return None  # short-circuits the message path after the puppet step

    async def _handle_agent_joined_channel(join: InboundAgentJoin) -> None:
        agent_joins.append(join)

    async def _maybe_guide_self_mention(msg: InboundMessage, room_id: str) -> None:
        return None

    return SimpleNamespace(
        _repair_placeholder_username=_noop_repair,
        _is_registered_agent=_is_registered_agent,
        _ensure_user_in_matrix_room=_ensure_user_in_matrix_room,
        _handle_agent_joined_channel=_handle_agent_joined_channel,
        _maybe_guide_self_mention=_maybe_guide_self_mention,
        _channel_to_room={"chan-1": ("room-uuid", "!matrix:switch.local")},
        _channel_locks={},
        ensure_calls=ensure_calls,
        agent_joins=agent_joins,
    )


# ── inbound message ─────────────────────────────────────────────────────────


async def test_inbound_message_from_agent_is_dropped() -> None:
    bridge = _fake_bridge(agents={"cc-marketing.chad"})

    await BridgeCore._handle_inbound_message(bridge, _msg("cc-marketing.chad"))

    # Agent's own echo: never re-imported, never puppeted as a user.
    assert bridge.ensure_calls == []


async def test_inbound_message_from_third_party_bot_is_bridged() -> None:
    # Not a registered agent (e.g. a GitHub/CI bot or a human) — must flow in.
    bridge = _fake_bridge(agents={"cc-marketing.chad"})

    await BridgeCore._handle_inbound_message(bridge, _msg("github-ci-bot"))

    assert len(bridge.ensure_calls) == 1
    assert bridge.ensure_calls[0]["external_username"] == "github-ci-bot"


# ── user_added / join ───────────────────────────────────────────────────────


async def test_user_join_from_agent_routes_to_agent_join() -> None:
    bridge = _fake_bridge(agents={"github.phil.conway"})

    await BridgeCore._handle_user_joined_channel(bridge, _join("github.phil.conway"))

    # Routed to the agent-join path; no external-user puppet created.
    assert [j.agent_name for j in bridge.agent_joins] == ["github.phil.conway"]
    assert bridge.ensure_calls == []


async def test_user_join_from_human_creates_puppet() -> None:
    bridge = _fake_bridge(agents={"github.phil.conway"})

    await BridgeCore._handle_user_joined_channel(bridge, _join("alice"))

    assert bridge.agent_joins == []
    assert len(bridge.ensure_calls) == 1
    assert bridge.ensure_calls[0]["external_username"] == "alice"
