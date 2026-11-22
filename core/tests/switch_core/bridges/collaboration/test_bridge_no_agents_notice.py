from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration import collaboration_core
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)

# When the Switch app is invited to (or addressed in) a bridged channel that has
# no room yet, a room is auto-created even if no agent can be associated with it
# (Slack is a single-app bridge). In that agentless case the bridge posts an
# admin notice into the channel explaining the room has no agents and how to
# invite one — posted after create_room returns, so it follows the bridge
# client's invite into the room.


def _fake_bridge(  # noqa: ANN202
    *, agent_ids: list[str], slash_hint: str | None = None, mention_only: bool = False
):
    notices: list[tuple[str, str, str | None]] = []
    room = SimpleNamespace(
        id="room-uuid", tenant_id="tenant-1", transport_room_id="!m:switch.local"
    )

    class _Adapter:
        def slash_invite_hint(self) -> str | None:
            return slash_hint

        async def sees_only_replies_and_commands(self, channel_id: str) -> bool:
            return mention_only

        async def admin_message(
            self,
            channel_id: str,
            content: str,
            thread_root_id: str | None = None,
            *,
            message_type: str | None = None,
        ) -> str:
            notices.append((channel_id, content, message_type))
            return "C123:999.9"

    class _RoomService:
        def __init__(self) -> None:
            self.configs: list[Any] = []

        async def create_room(self, config: Any) -> SimpleNamespace:
            self.configs.append(config)
            return SimpleNamespace(room=room)

    async def _resolve_agents_for_channel(
        channel_id: str, channel_type: str
    ) -> list[str]:
        return agent_ids

    def add_room_mapping(
        room_id: str, transport_room_id: str, channel_id: str, tenant_id: str
    ) -> None:
        pass

    async def _owner_from_platform_account(
        external_user_id: str | None, channel_id: str
    ) -> None:
        return None

    async def _adopt_existing_room(channel_id: str) -> tuple[str, str] | None:
        return None

    async def _judge_platform_join(agent_ids: list[str], **kwargs: Any) -> None:
        return None

    bridge = SimpleNamespace(
        _adapter=_Adapter(),
        _judge_platform_join=_judge_platform_join,
        _room_service=_RoomService(),
        _resolve_agents_for_channel=_resolve_agents_for_channel,
        _adopt_existing_room=_adopt_existing_room,
        _owner_from_platform_account=_owner_from_platform_account,
        add_room_mapping=add_room_mapping,
        _provisioning_channels=set(),
        _sync_members_soon=lambda channel_ids: None,
        _channel_to_room={},
        _room_tenants={},
        _bridge_display_name="Switch",
        _bridge_id="bridge-1",
        notices=notices,
        soon=[],
    )
    bridge._post_no_agents_notice = lambda channel_id: (
        CollaborationCore._post_no_agents_notice(bridge, channel_id)
    )
    bridge._no_agents_notice_soon = lambda room_id, channel_id: bridge.soon.append(
        (room_id, channel_id)
    )
    return bridge


async def test_agentless_auto_create_posts_notice() -> None:
    bridge = _fake_bridge(agent_ids=[])

    result = await CollaborationCore._create_room_for_channel(
        bridge,
        channel_id="C0BGC39BFSR",
        channel_type="channel_public",
        channel_name="general",
    )

    assert result == ("room-uuid", "!m:switch.local")
    # A room was still created despite having no agents (no hard failure).
    assert len(bridge._room_service.configs) == 1
    assert bridge._room_service.configs[0].agent_ids == []
    # The no-agents notice is posted to the originating channel.
    assert len(bridge.notices) == 1
    channel_id, content, message_type = bridge.notices[0]
    assert channel_id == "C0BGC39BFSR"
    assert message_type == "no_agents"
    assert "no agents" in content.lower()
    assert "!invite-agent" in content


async def test_notice_carries_this_bridge_s_own_slash_syntax() -> None:
    bridge = _fake_bridge(
        agent_ids=[],
        slash_hint="`/invite-agent agent:agent-name` — the Discord slash command",
    )

    await CollaborationCore._create_room_for_channel(
        bridge,
        channel_id="C1",
        channel_type="channel_public",
        channel_name="general",
    )

    content = bridge.notices[0][1]
    assert "• `/invite-agent agent:agent-name` — the Discord slash command." in content
    # The typed form is still offered alongside it.
    assert "• `!invite-agent @agent-name` — type it here in the channel, or" in content


async def test_a_mention_only_chat_is_offered_only_what_reaches_the_bot() -> None:
    """A Telegram group with Group Privacy on hands the bot replies and
    commands, nothing else: a typed `!invite-agent` or an @-mention of an
    agent never arrives, so neither is offered."""
    hint = "`/invite_agent @agent-name` — the Telegram slash command"
    bridge = _fake_bridge(agent_ids=[], slash_hint=hint, mention_only=True)

    await CollaborationCore._create_room_for_channel(
        bridge,
        channel_id="-100",
        channel_type="channel_private",
        channel_name="team",
    )

    content = bridge.notices[0][1]
    assert f"• {hint}." in content
    assert "from the menu" in content
    assert "!invite-agent" not in content
    assert "@-mention" not in content
    assert "reply to its messages" in content


async def test_notice_omits_the_slash_form_where_there_is_none() -> None:
    # Mattermost and Teams register no slash commands, so advertising one
    # would point the user at something that does not exist.
    bridge = _fake_bridge(agent_ids=[], slash_hint=None)

    await CollaborationCore._create_room_for_channel(
        bridge,
        channel_id="C1",
        channel_type="channel_public",
        channel_name="general",
    )

    content = bridge.notices[0][1]
    assert "/invite-agent" not in content
    # The remaining bullet closes the sentence rather than dangling on "or".
    assert "• `!invite-agent @agent-name` — type it here in the channel." in content
    assert ", or" not in content


def test_each_adapter_advertises_a_syntax_it_actually_accepts() -> None:
    discord_adapter = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="t", guild_id="1")
    )
    hint = discord_adapter.slash_invite_hint()
    # Discord names each argument, and the name has to be the one actually
    # registered — `agent:`, not the command's own name.
    assert hint is not None
    assert "agent:agent-name" in hint
    assert "Discord slash command" in hint
    assert "@agent-name" not in hint

    telegram_adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="t", bot_username="b")
    )
    telegram_hint = telegram_adapter.slash_invite_hint()
    # Telegram passes a command's whole tail through as text, so the argument is
    # spelled exactly as in the `!` form — no named fields.
    assert telegram_hint is not None
    assert "Telegram slash command" in telegram_hint
    # The underscore spelling leads, because it is the only one Telegram will
    # register and therefore the only one its menu offers. Advertising the
    # hyphenated form first sent people to the one spelling the client will not
    # autocomplete.
    assert "`/invite_agent @agent-name`" in telegram_hint
    assert telegram_hint.index("/invite_agent") < telegram_hint.index("/invite-agent")
    # Both are still named, since the hyphenated form is what every other
    # platform and the docs use, and Telegram does accept it when typed.
    assert "`/invite-agent`" in telegram_hint


async def test_auto_create_with_agents_posts_no_notice() -> None:
    bridge = _fake_bridge(agent_ids=["a1"])

    result = await CollaborationCore._create_room_for_channel(
        bridge,
        channel_id="C0BGC39BFSR",
        channel_type="channel_public",
        channel_name="general",
    )

    assert result == ("room-uuid", "!m:switch.local")
    assert bridge._room_service.configs[0].agent_ids == ["a1"]
    assert bridge.notices == []


async def test_a_room_made_by_an_invite_does_not_say_it_has_no_agents() -> None:
    """The agent the invite names is a moment away; "no agents in it yet" would
    be the first, and wrong, thing said in the new room."""
    bridge = _fake_bridge(agent_ids=[])

    await CollaborationCore._create_room_for_channel(
        bridge,
        channel_id="C0BGC39BFSR",
        channel_type="channel_public",
        channel_name="general",
        inviting_an_agent=True,
    )

    assert bridge.notices == []


async def test_a_channel_the_app_was_just_added_to_waits_before_saying_it_has_no_agents() -> (
    None
):
    """Telegram's one-tap add invites an agent with the add, and the join
    arrives first: the notice waits rather than greeting the group wrongly."""
    bridge = _fake_bridge(agent_ids=[])

    await CollaborationCore._create_room_for_channel(
        bridge,
        channel_id="C0BGC39BFSR",
        channel_type="channel_public",
        channel_name="general",
        app_joined=True,
    )

    assert bridge.notices == []
    assert bridge.soon == [("room-uuid", "C0BGC39BFSR")]


async def _waited(agent_ids: list[str]) -> list[tuple[str, str, str | None]]:
    bridge = _fake_bridge(agent_ids=[])

    class _Rooms:
        async def get_agent_ids(self, session: object, room_id: str) -> list[str]:
            return agent_ids

    class _Session:
        async def __aenter__(self) -> _Session:
            return self

        async def __aexit__(self, *exc: object) -> None:
            return None

    bridge._room_store = _Rooms()
    bridge._bridge_tenant_id = "tenant-1"
    bridge._session_factory = lambda: _Session()
    await CollaborationCore._run_no_agents_notice(bridge, "room-uuid", "C1")
    return bridge.notices


async def test_the_wait_ends_quietly_when_an_agent_arrived(monkeypatch) -> None:
    monkeypatch.setattr(collaboration_core, "NO_AGENTS_NOTICE_GRACE_SECONDS", 0)
    assert await _waited(["agent-1"]) == []


async def test_the_wait_ends_with_the_notice_when_none_did(monkeypatch) -> None:
    monkeypatch.setattr(collaboration_core, "NO_AGENTS_NOTICE_GRACE_SECONDS", 0)
    notices = await _waited([])
    assert len(notices) == 1 and notices[0][2] == "no_agents"
