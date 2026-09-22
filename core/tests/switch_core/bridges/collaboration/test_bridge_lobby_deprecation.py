from __future__ import annotations

from types import SimpleNamespace

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import InboundMessage


async def _no_text_answer(_msg: object) -> None:
    """These tests exercise the relay, not the session half of a message."""
    return None


async def _no_session_demo(_msg: object, _room_id: str) -> None:
    """The demo harness is off in production and off here."""
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


def _adapter_fake() -> SimpleNamespace:
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

    return SimpleNamespace(admin_message=admin_message, notices=notices)


async def test_lobby_message_posts_deprecation_notice() -> None:
    adapter = _adapter_fake()
    bridge = SimpleNamespace(_adapter=adapter)

    await BridgeCore._handle_lobby_message(bridge, _msg("lobby"))

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


async def test_inbound_lobby_message_short_circuits_routing() -> None:
    handled: list[InboundMessage] = []
    ensure_calls: list[dict[str, str]] = []

    async def _is_registered_agent(name: str) -> bool:
        return False

    async def _handle_lobby_message(msg: InboundMessage) -> None:
        handled.append(msg)

    async def _ensure_user_in_matrix_room(**kwargs: str) -> None:
        ensure_calls.append(kwargs)
        return None

    bridge = SimpleNamespace(
        _is_registered_agent=_is_registered_agent,
        _handle_lobby_message=_handle_lobby_message,
        _ensure_user_in_matrix_room=_ensure_user_in_matrix_room,
        _handle_text_answer=_no_text_answer,
        _handle_session_demo=_no_session_demo,
        _channel_to_room={},
        _channel_locks={},
    )

    await BridgeCore._handle_inbound_message(bridge, _msg("lobby"))

    # Routed to the deprecation handler; never created a room / puppet.
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
        _handle_session_demo=_no_session_demo,
        _channel_to_room={},
        _channel_locks={},
    )

    await BridgeCore._handle_inbound_message(bridge, _msg("channel_public"))

    # A normal channel message does not hit the lobby deprecation handler.
    assert handled == []
