from __future__ import annotations

from types import SimpleNamespace

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundCommand, InboundMessage


async def _no_text_answer(_msg: object) -> None:
    """These tests exercise the relay, not the session half of a message."""
    return None


# The Slack app's DM ("lobby") is deprecated as a place to talk to agents.
# A message there must NOT auto-create a room or route — the bridge replies with
# a generic pointer to use a channel instead and stops.


def _msg(channel_type: str) -> InboundMessage:
    return InboundMessage(
        channel_id="D123",
        channel_type=channel_type,  # type: ignore[arg-type]
        sender_id="U1",
        sender_name="alice",
        content="hello agents",
        message_ref="D123:500.5",
    )


def _adapter_fake(directory: bool = True) -> SimpleNamespace:
    notices: list[tuple[str, str, str | None]] = []

    async def admin_message(
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
    ) -> str:
        notices.append((channel_id, content, thread_root_id))
        return "D123:999.9"

    return SimpleNamespace(
        admin_message=admin_message,
        notices=notices,
        supports_directory_search=directory,
    )


async def test_lobby_message_posts_deprecation_notice() -> None:
    adapter = _adapter_fake()
    bridge = SimpleNamespace(_adapter=adapter)

    await CollaborationCore._handle_lobby_message(bridge, _msg("lobby"))

    assert len(adapter.notices) == 1
    channel_id, content, thread_root_id = adapter.notices[0]
    assert channel_id == "D123"
    # Threads under the triggering message.
    assert thread_root_id == "D123:500.5"
    # Tells the user this isn't where agents live and points them to a channel,
    # without leaking any internal onboarding-doc links.
    assert "isn't where you talk to agents" in content
    assert "channel" in content
    assert "atlassian.net" not in content


async def test_a_hello_where_there_is_no_directory_is_answered_as_one() -> None:
    """On Telegram a direct message is how Switch comes to know someone."""
    adapter = _adapter_fake(directory=False)
    await CollaborationCore._handle_lobby_message(
        SimpleNamespace(_adapter=adapter), _msg("lobby")
    )
    assert "Switch has seen your account" in adapter.notices[0][1]
    # A mention alone never reaches the bot in a group with Group Privacy
    # on (BotFather's default); a reply to an agent's message does.
    assert "reply to its messages" in adapter.notices[0][1]
    assert "mention" not in adapter.notices[0][1]


async def test_inbound_lobby_message_short_circuits_routing() -> None:
    handled: list[InboundMessage] = []
    ensure_calls: list[dict[str, str]] = []

    async def _is_registered_agent(name: str) -> bool:
        return False

    async def _handle_lobby_message(msg: InboundMessage) -> None:
        handled.append(msg)

    async def _ensure_human_in_room(**kwargs: str) -> None:
        ensure_calls.append(kwargs)
        return None

    async def _remember_lobby_sender(sender_id: str, sender_name: str) -> None:
        return None

    bridge = SimpleNamespace(
        _is_registered_agent=_is_registered_agent,
        _handle_lobby_message=_handle_lobby_message,
        _remember_lobby_sender=_remember_lobby_sender,
        _ensure_human_in_room=_ensure_human_in_room,
        _handle_text_answer=_no_text_answer,
        _channel_to_room={},
        _channel_locks={},
    )

    await CollaborationCore._handle_inbound_message(bridge, _msg("lobby"))

    # Routed to the deprecation handler; never created a room / human actor.
    assert len(handled) == 1
    assert ensure_calls == []


async def test_inbound_non_lobby_message_is_not_short_circuited() -> None:
    handled: list[InboundMessage] = []

    async def _is_registered_agent(name: str) -> bool:
        return False

    async def _handle_lobby_message(msg: InboundMessage) -> None:
        handled.append(msg)

    # No room mapping + a no-op creator that returns None stops the flow right
    # after the lobby check would have fired, without needing the full stack.
    async def _create_room_for_channel(**kwargs: object) -> None:
        return None

    bridge = SimpleNamespace(
        _is_registered_agent=_is_registered_agent,
        _handle_lobby_message=_handle_lobby_message,
        _create_room_for_channel=_create_room_for_channel,
        _handle_text_answer=_no_text_answer,
        _channel_to_room={},
        _channel_locks={},
    )

    await CollaborationCore._handle_inbound_message(bridge, _msg("channel_public"))

    # A normal channel message does not hit the lobby deprecation handler.
    assert handled == []


async def _remembering(*, directory: bool) -> list[dict[str, str]]:
    recorded: list[dict[str, str]] = []

    async def ensure_external_user(**kwargs: str) -> None:
        recorded.append(kwargs)

    bridge = SimpleNamespace(
        _adapter=SimpleNamespace(supports_directory_search=directory),
        ensure_external_user=ensure_external_user,
    )
    await CollaborationCore._remember_lobby_sender(bridge, "U1", "alice")
    return recorded


async def test_a_direct_message_makes_its_sender_known_where_there_is_no_directory() -> (
    None
):
    """Pressing Start on Telegram is how a new person first reaches the bot, and
    without a directory Switch can offer to link only people it has seen."""
    assert await _remembering(directory=False) == [
        {"external_user_id": "U1", "external_username": "alice"}
    ]


async def test_a_platform_with_a_directory_does_not_record_direct_messages() -> None:
    assert await _remembering(directory=True) == []


async def _lobby_command(
    command: str,
) -> tuple[list[tuple[str, str, str | None]], list]:
    adapter = _adapter_fake()
    created: list[object] = []

    async def _create_room_for_channel(**kwargs: object) -> None:
        created.append(kwargs)

    async def _remember_lobby_sender(sender_id: str, sender_name: str) -> None:
        return None

    bridge = SimpleNamespace(
        _adapter=adapter,
        _remember_lobby_sender=_remember_lobby_sender,
        _create_room_for_channel=_create_room_for_channel,
        _channel_to_room={},
        _channel_locks={},
    )
    await CollaborationCore._handle_inbound_command(
        bridge,
        InboundCommand(
            channel_id="D123",
            channel_type="lobby",
            sender_id="U1",
            sender_name="alice",
            command=command,
            args="",
            message_ref="D123:7",
        ),
    )
    return adapter.notices, created


async def test_start_in_a_direct_chat_says_hello_and_makes_no_room() -> None:
    """A room for the app's direct chat would hold every agent, and each would
    greet the person there."""
    notices, created = await _lobby_command("start")
    assert created == []
    assert len(notices) == 1
    assert "Switch has seen your account" in notices[0][1]


async def test_another_command_in_a_direct_chat_makes_no_room_either() -> None:
    notices, created = await _lobby_command("invite-agent")
    assert created == []
    assert "isn't where you talk to agents" in notices[0][1]
