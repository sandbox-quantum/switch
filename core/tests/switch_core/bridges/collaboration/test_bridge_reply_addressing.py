"""A reply to one of the Switch app's messages reaches the agent that posted
it (Telegram).

In a Telegram group whose bot has Group Privacy on, the default, the bot is
handed commands and replies to its own messages, nothing else. A reply to an
agent's question was relayed but addressed nobody, so the agent never saw it.
It is now said to that agent as a mention would be, in the conversation it
answers. A reply that is an answer to a card stays the card's.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.trust.client import NullTrustClient

TRANSPORT_ROOM_ID = "!room:switch.local"
BUDDY = SimpleNamespace(id="a-buddy", name="switch-buddy", client_id="c-buddy")
SCOUT = SimpleNamespace(id="a-scout", name="scout", client_id="c-scout")


class _FakeSession:
    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False


class _HumanActor:
    client_id = "c-alice"
    transport_user_id = "@alice:switch.local"

    def __init__(self) -> None:
        self.sent: list[tuple[str, str | None]] = []

    async def send_message(
        self, room_id: str, content: str, *, thread_root_id: str | None, **_kw: Any
    ) -> str:
        self.sent.append((content, thread_root_id))
        return "$reply"


class _Adapter:
    platform_name = "Telegram"
    private_notice_delivery = "in_channel"

    def translate_inbound(self, content: str) -> str:
        return content


def _bridge(
    *,
    agents: list[SimpleNamespace],
    mapped: dict[str, str],
    posted_by: dict[str, str],
    answered_card: bool = False,
) -> SimpleNamespace:
    """A bridge whose room holds `agents`. `mapped` is the message map,
    external post to room event; `posted_by` each room event's sender client."""
    human = _HumanActor()

    class _RoomStore:
        async def get_agent_ids(self, _session: Any, _room_id: str) -> list[str]:
            return [agent.id for agent in agents]

    class _AgentStore:
        async def get(self, _session: Any, agent_id: str) -> SimpleNamespace | None:
            return next((a for a in agents if a.id == agent_id), None)

    class _MessageStore:
        async def get_by_transport_event_id(
            self, _session: Any, event_id: str
        ) -> SimpleNamespace | None:
            sender = posted_by.get(event_id)
            return None if sender is None else SimpleNamespace(sender_client_id=sender)

    async def _event_for_external_post(post: str) -> str | None:
        return mapped.get(post)

    async def _handle_text_answer(_msg: InboundMessage) -> bool:
        return answered_card

    async def _ensure_human_in_room(**_kw: Any) -> _HumanActor:
        return human

    async def _none(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def _not_an_agent(_name: str) -> bool:
        return False

    bridge = SimpleNamespace(
        _bridge_id="bridge-1",
        _adapter=_Adapter(),
        _session_factory=_FakeSession,
        _room_store=_RoomStore(),
        _agent_store=_AgentStore(),
        _message_store=_MessageStore(),
        _channel_to_room={"-100": ("room-1", TRANSPORT_ROOM_ID)},
        _channel_locks={},
        _trust_client=NullTrustClient(),
        _room_tenant=AsyncMock(return_value="tenant-1"),
        _event_for_external_post=_event_for_external_post,
        _handle_text_answer=_handle_text_answer,
        _ensure_human_in_room=_ensure_human_in_room,
        _repair_placeholder_username=_none,
        _record_message_map=_none,
        _is_registered_agent=_not_an_agent,
        human=human,
    )
    bridge._reply_target = lambda room_id, root, content: (
        CollaborationCore._reply_target(bridge, room_id, root, content)
    )
    return bridge


def _reply(
    content: str, *, to: str | None, replies_to_app: bool = True
) -> InboundMessage:
    return InboundMessage(
        channel_id="-100",
        channel_type="channel_private",
        sender_id="7",
        sender_name="alice",
        content=content,
        message_ref="-100:900",
        root_id=to,
        replies_to_app=replies_to_app,
    )


async def test_a_reply_to_an_agents_message_is_said_to_that_agent() -> None:
    bridge = _bridge(
        agents=[BUDDY, SCOUT],
        mapped={"-100:501": "$question"},
        posted_by={"$question": SCOUT.client_id},
    )

    await CollaborationCore._handle_inbound_message(
        bridge, _reply("Acme Corp", to="-100:501")
    )

    # Addressed to the agent that asked, in the conversation it asked in.
    assert bridge.human.sent == [("@scout Acme Corp", "$question")]


async def test_a_reply_to_any_part_of_a_long_answer_reaches_its_agent() -> None:
    # The message map resolves every part of a split message to its event.
    bridge = _bridge(
        agents=[BUDDY, SCOUT],
        mapped={"-100:501": "$answer", "-100:503": "$answer"},
        posted_by={"$answer": BUDDY.client_id},
    )

    await CollaborationCore._handle_inbound_message(
        bridge, _reply("and the third point?", to="-100:503")
    )

    assert bridge.human.sent == [("@switch-buddy and the third point?", "$answer")]


async def test_an_answer_to_a_card_is_the_cards_not_a_message_to_its_agent() -> None:
    bridge = _bridge(
        agents=[BUDDY],
        mapped={"-100:510": "$card"},
        posted_by={"$card": BUDDY.client_id},
        answered_card=True,
    )

    await CollaborationCore._handle_inbound_message(
        bridge, _reply("A1 1", to="-100:510")
    )

    assert bridge.human.sent == [("A1 1", "$card")]


async def test_a_reply_to_an_unmapped_bot_message_goes_to_the_rooms_one_agent() -> None:
    bridge = _bridge(agents=[BUDDY], mapped={}, posted_by={})

    await CollaborationCore._handle_inbound_message(
        bridge, _reply("hello there", to="-100:42")
    )

    assert bridge.human.sent == [("@switch-buddy hello there", None)]


async def test_with_several_agents_an_unmapped_reply_addresses_nobody() -> None:
    bridge = _bridge(agents=[BUDDY, SCOUT], mapped={}, posted_by={})

    await CollaborationCore._handle_inbound_message(
        bridge, _reply("hello there", to="-100:42")
    )

    assert bridge.human.sent == [("hello there", None)]


async def test_a_reply_that_names_an_agent_is_left_to_that_mention() -> None:
    bridge = _bridge(
        agents=[BUDDY, SCOUT],
        mapped={"-100:501": "$question"},
        posted_by={"$question": SCOUT.client_id},
    )

    await CollaborationCore._handle_inbound_message(
        bridge, _reply("@switch-buddy can you take this?", to="-100:501")
    )

    assert bridge.human.sent == [("@switch-buddy can you take this?", "$question")]


async def test_a_reply_to_a_persons_message_addresses_nobody() -> None:
    bridge = _bridge(
        agents=[BUDDY],
        mapped={"-100:600": "$person"},
        posted_by={"$person": "c-bob"},
    )

    await CollaborationCore._handle_inbound_message(
        bridge, _reply("agreed", to="-100:600", replies_to_app=False)
    )

    assert bridge.human.sent == [("agreed", "$person")]


async def test_settling_a_split_post_maps_every_part() -> None:
    """The bridge records the parts after the first that the platform reports,
    as the same room message."""
    filled: list[dict[str, Any]] = []

    class _Store:
        async def fill(self, _session: Any, **kwargs: Any) -> None:
            filled.append(kwargs)

    class _Session:
        async def __aenter__(self) -> _Session:
            return self

        async def __aexit__(self, *exc: Any) -> bool:
            return False

        async def commit(self) -> None:
            return None

        async def execute(self, *_args: Any, **_kwargs: Any) -> None:
            return None

    class _Split:
        def take_further_refs(self, ref: str) -> list[str]:
            return ["-100:502", "-100:503"] if ref == "-100:501" else []

    bridge = SimpleNamespace(
        _bridge_id="bridge-1",
        _bridge_tenant_id="tenant-1",
        _session_factory=_Session,
        _bridge_message_map_store=_Store(),
        _adapter=_Split(),
    )

    await CollaborationCore._settle_outbound(bridge, "$answer", "-100:501")

    assert filled == [
        {
            "bridge_id": "bridge-1",
            "transport_event_id": "$answer",
            "external_post_id": "-100:501",
            "further_post_ids": ["-100:502", "-100:503"],
        }
    ]
