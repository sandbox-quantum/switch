"""A platform post already in its room is not handed in a second time.

The bridge records each post it hands in (`bridge_message_map`, post id to
room event). A second copy of the same post, which a bridge can see when it
hears each post on several connections or fetches posts it missed, finds that
record and stops before it becomes a second message.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.trust.client import NullTrustClient

TRANSPORT_ROOM_ID = "!matrix:switch.local"


class _Session:
    async def __aenter__(self) -> _Session:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None


class _MapStore:
    """The bridge's post records, by (bridge, post id)."""

    def __init__(self, rows: dict[tuple[str, str], str]) -> None:
        self._rows = rows
        self.lookups: list[str] = []

    async def get_by_external_post_id(
        self, session: Any, bridge_id: str, external_post_id: str
    ) -> SimpleNamespace | None:
        self.lookups.append(external_post_id)
        channel = self._rows.get((bridge_id, external_post_id))
        if channel is None:
            return None
        return SimpleNamespace(
            external_channel_id=channel, transport_event_id="$already-there"
        )


def _message(*, ref: str = "post-1", channel: str = "chan-1") -> InboundMessage:
    return InboundMessage(
        channel_id=channel,
        channel_type="channel_public",
        sender_id="ext-alice",
        sender_name="alice",
        content="hello",
        message_ref=ref,
    )


def _checker(rows: dict[tuple[str, str], str]) -> SimpleNamespace:
    bridge = SimpleNamespace(
        _bridge_id="bridge-1",
        _session_factory=_Session,
        _bridge_message_map_store=_MapStore(rows),
    )
    bridge._already_handed_in = lambda msg: CollaborationCore._already_handed_in(
        bridge, msg
    )
    return bridge


class TestAlreadyHandedIn:
    async def test_a_post_with_a_record_in_its_channel_is_already_in(self) -> None:
        bridge = _checker({("bridge-1", "post-1"): "chan-1"})

        assert await bridge._already_handed_in(_message()) is True

    async def test_a_post_with_no_record_is_not(self) -> None:
        bridge = _checker({})

        assert await bridge._already_handed_in(_message()) is False

    async def test_the_same_id_in_another_channel_is_another_post(self) -> None:
        """Some platforms number messages per chat."""
        bridge = _checker({("bridge-1", "42"): "chat-a"})

        assert (
            await bridge._already_handed_in(_message(ref="42", channel="chat-b"))
            is False
        )

    async def test_another_bridges_record_does_not_count(self) -> None:
        bridge = _checker({("bridge-2", "post-1"): "chan-1"})

        assert await bridge._already_handed_in(_message()) is False

    async def test_a_post_with_no_id_is_never_taken_as_a_copy(self) -> None:
        bridge = _checker({("bridge-1", ""): "chan-1"})

        assert await bridge._already_handed_in(_message(ref="")) is False
        assert bridge._bridge_message_map_store.lookups == []


class _HumanActor:
    client_id = "alice-client"
    transport_user_id = "@ext_alice:switch.local"

    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    async def send_message(self, room_id: str, content: str, **_kw: object) -> str:
        self.sent.append((room_id, content))
        return f"$event-{len(self.sent)}"


class _Adapter:
    def translate_inbound(self, content: str) -> str:
        return content


def _bridge(rows: dict[tuple[str, str], str]) -> SimpleNamespace:
    human = _HumanActor()
    texts: list[str] = []

    async def _no(*_a: object, **_k: object) -> Any:
        return None

    async def _not_an_agent(_name: str) -> bool:
        return False

    async def _ensure_human_in_room(**_kw: object) -> _HumanActor:
        return human

    async def _text_answer(msg: InboundMessage) -> None:
        texts.append(msg.content)

    async def _record_message_map(**kwargs: str) -> None:
        rows[("bridge-1", kwargs["external_post_id"])] = kwargs["external_channel_id"]

    bridge = _checker(rows)
    vars(bridge).update(
        _repair_placeholder_username=_no,
        _is_registered_agent=_not_an_agent,
        _ensure_human_in_room=_ensure_human_in_room,
        _record_message_map=_record_message_map,
        _adapter=_Adapter(),
        _handle_text_answer=_text_answer,
        _channel_to_room={"chan-1": ("room-uuid", TRANSPORT_ROOM_ID)},
        _channel_locks={},
        _trust_client=NullTrustClient(),
    )
    bridge.human = human
    bridge.texts = texts
    return bridge


@pytest.mark.usefixtures("hosted_v2_on")
class TestHandInOnce:
    async def test_a_second_copy_of_a_post_is_not_a_second_message(self) -> None:
        rows: dict[tuple[str, str], str] = {}
        bridge = _bridge(rows)

        await CollaborationCore._handle_inbound_message(bridge, _message())
        await CollaborationCore._handle_inbound_message(bridge, _message())

        assert bridge.human.sent == [(TRANSPORT_ROOM_ID, "hello")]
        # Nor is it offered again as a typed answer to an approval card.
        assert bridge.texts == ["hello"]

    async def test_two_different_posts_are_both_handed_in(self) -> None:
        rows: dict[tuple[str, str], str] = {}
        bridge = _bridge(rows)

        await CollaborationCore._handle_inbound_message(bridge, _message(ref="post-1"))
        await CollaborationCore._handle_inbound_message(bridge, _message(ref="post-2"))

        assert len(bridge.human.sent) == 2


async def test_with_hosted_agents_v2_off_the_inbound_path_is_mains(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The once-only check came with hosted agents v2: with it off, a second
    copy of a post is handed in again, as main does, and nothing is looked up."""
    from switch_core import hosted_v2

    monkeypatch.setattr(hosted_v2, "_process_on", False)
    rows: dict[tuple[str, str], str] = {}
    bridge = _bridge(rows)

    await CollaborationCore._handle_inbound_message(bridge, _message())
    await CollaborationCore._handle_inbound_message(bridge, _message())

    assert bridge.human.sent == [
        (TRANSPORT_ROOM_ID, "hello"),
        (TRANSPORT_ROOM_ID, "hello"),
    ]
    assert bridge._bridge_message_map_store.lookups == []
