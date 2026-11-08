"""A press on a card button goes to the room as the presser's message to the
agent that posted the card, in the card's thread, through the path a typed
message takes. Which card, agent and thread come from the bridge's record of
the message; a press naming a button that card did not draw, or from an
account Switch cannot name, is refused visibly and delivers nothing. The
press addresses the card's author only, and a card takes one answer."""

from __future__ import annotations

import asyncio
import contextlib
import copy
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.renderers import INTERRUPT_ACTION
from switch_core.clients.mentions import mention_tokens
from switch_core.delivery.addressing import named_agents
from switch_core.sessions.errors import SessionError
from switch_core.trust.client import NullTrustClient
from switch_core.ui_spec import UI_CONTENT_KEY, UI_PRESS_KEY

TRANSPORT_ROOM = "!r:switch.local"
CARD_REF = "C1:200.0"
CARD = {
    "root": "c",
    "elements": {
        "c": {"type": "Card", "props": {"title": "Deploy"}, "children": ["a"]},
        "a": {"type": "Actions", "props": {}, "children": ["ok", "no"]},
        "ok": {
            "type": "Button",
            "props": {"id": "approve", "label": "Approve", "value": "v-1"},
            "children": [],
        },
        "no": {"type": "Button", "props": {"id": "reject", "label": "Reject"}},
    },
}


def _run(coro: Any) -> Any:
    return asyncio.new_event_loop().run_until_complete(coro)


class _Transport:
    def __init__(self, card: Any) -> None:
        self.card = card

    async def get_event(self, room_id: str, event_id: str) -> Any:
        assert room_id == TRANSPORT_ROOM
        return self.card if event_id == "$card" else None


class _Human:
    client_id = "alice-client"
    transport_user_id = "@ext_alice:switch.local"

    def __init__(self, card: Any) -> None:
        self.transport = _Transport(card)
        self.sent: list[tuple[str, str, str | None]] = []
        self.extra: list[dict[str, Any] | None] = []
        self.event_id: str | None = "$press"

    async def send_message(
        self,
        room_id: str,
        content: str,
        *,
        thread_root_id: str | None,
        extra_content: dict[str, Any] | None,
        **_: Any,
    ) -> str | None:
        self.sent.append((room_id, content, thread_root_id))
        self.extra.append(extra_content)
        return self.event_id


class _Answers:
    """The card-answer half of BridgeMessageMapStore, by post."""

    def __init__(self) -> None:
        self.answers: dict[str, dict[str, str]] = {}

    async def answer_card(
        self,
        session: Any,
        *,
        bridge_id: str,
        external_post_id: str,
        answer: dict[str, str],
    ) -> dict[str, str] | None:
        if external_post_id in self.answers:
            return self.answers[external_post_id]
        self.answers[external_post_id] = answer
        return None

    async def clear_card_answer(
        self, session: Any, *, bridge_id: str, external_post_id: str
    ) -> None:
        self.answers.pop(external_post_id, None)


@contextlib.asynccontextmanager
async def _session() -> AsyncIterator[Any]:
    async def commit() -> None:
        return None

    yield SimpleNamespace(commit=commit)


class _Adapter:
    platform_name = "Slack"
    private_notice_delivery = "ephemeral"

    def __init__(self) -> None:
        self.told: list[str] = []
        self.settled: list[tuple[str, str]] = []

    def translate_inbound(self, content: str) -> str:
        return content

    async def get_channel_type(self, channel_id: str) -> str:
        return "channel_public"

    async def tell_actor(self, *args: Any) -> None:
        self.told.append(args[-1])

    async def settle_card_press(
        self, interaction: InboundInteraction, label: str
    ) -> None:
        self.settled.append((interaction.action_id, label))


def _card(**overrides: Any) -> SimpleNamespace:
    fields: dict[str, Any] = {
        "sender_name": "deploybot",
        "content": {"body": "Deploy?", UI_CONTENT_KEY: CARD},
        "thread_root_event_id": None,
    }
    fields.update(overrides)
    return SimpleNamespace(**fields)


class _Agents:
    async def get_by_name(self, session: Any, name: str) -> Any:
        return SimpleNamespace(id="agent-deploybot") if name == "deploybot" else None


class _Controls:
    """The may-address check a stop press takes, refusing whoever is in `denied`."""

    def __init__(self) -> None:
        self.denied: set[str] = set()
        self.asked: list[tuple[str, str, str]] = []

    async def authorize_room_control(
        self, agent_id: str, room_id: str, person: Any, *, doing: str
    ) -> None:
        self.asked.append((agent_id, room_id, person.mxid))
        if person.mxid in self.denied:
            raise SessionError(
                "NOT_AUTHORIZED",
                f"You may not address this agent, so you may not {doing}.",
            )


def _bridge(card: Any, *, human: bool = True) -> SimpleNamespace:
    actor = _Human(card)
    posts = {CARD_REF: "$card", "C1:100.0": "$root"}

    async def ensure_human(**_kw: Any) -> _Human | None:
        return actor if human else None

    async def is_agent(name: str) -> bool:
        return name == "deploybot"

    async def event_for(ref: str) -> str | None:
        return posts.get(ref)

    async def post_for(event_id: str) -> str | None:
        return next((r for r, e in posts.items() if e == event_id), None)

    async def noop(*_a: Any, **_kw: Any) -> None:
        return None

    bridge = SimpleNamespace(
        _bridge_id="bridge-1",
        _adapter=_Adapter(),
        _channel_to_room={"C1": ("room-uuid", TRANSPORT_ROOM)},
        _channel_locks={},
        _trust_client=NullTrustClient(),
        _activity_publisher=None,
        _approval_answers=None,
        _ensure_human_in_room=ensure_human,
        _is_registered_agent=is_agent,
        _agent_store=_Agents(),
        _session_activity_service=_Controls(),
        _event_for_external_post=event_for,
        _external_post_for_event=post_for,
        _repair_placeholder_username=noop,
        _handle_text_answer=noop,
        _record_message_map=noop,
        _session_factory=_session,
        _bridge_message_map_store=_Answers(),
        actor=actor,
    )
    bridge._handle_inbound_message = lambda msg: (
        CollaborationCore._handle_inbound_message(bridge, msg)  # type: ignore[arg-type]
    )
    bridge._handle_card_press = lambda i: CollaborationCore._handle_card_press(
        bridge,  # type: ignore[arg-type]
        i,
    )
    return bridge


def _press(bridge: SimpleNamespace, **overrides: Any) -> None:
    fields: dict[str, Any] = {
        "channel_id": "C1",
        "sender_id": "U1",
        "sender_name": "alice",
        "action_id": "switch.ui:approve",
        "value": "v-1",
        "message_ref": CARD_REF,
    }
    fields.update(overrides)
    _run(
        CollaborationCore._handle_inbound_interaction(
            bridge,  # type: ignore[arg-type]
            InboundInteraction(**fields),
        )
    )


def test_a_press_is_delivered_as_the_pressers_message_to_the_poster() -> None:
    bridge = _bridge(_card())

    _press(bridge)

    assert bridge.actor.sent == [
        (
            TRANSPORT_ROOM,
            "@deploybot Clicked “Approve” (action: approve, value: v-1)",
            "$card",
        )
    ]
    assert bridge._adapter.settled == [("switch.ui:approve", "Approve")]
    assert bridge._adapter.told == []


def test_a_button_with_no_value_is_matched_by_its_id_and_says_no_value() -> None:
    bridge = _bridge(_card())

    _press(bridge, action_id="switch.ui:reject", value="reject")

    assert bridge.actor.sent[0][1] == "@deploybot Clicked “Reject” (action: reject)"


def test_a_card_inside_a_thread_answers_in_that_thread() -> None:
    bridge = _bridge(_card(thread_root_event_id="$root"))

    _press(bridge)

    assert bridge.actor.sent[0][2] == "$root"


def test_an_account_switch_cannot_name_is_refused_and_nothing_is_delivered() -> None:
    bridge = _bridge(_card(), human=False)

    _press(bridge)

    assert bridge.actor.sent == []
    assert bridge._adapter.settled == []
    assert "does not know who this account belongs to" in bridge._adapter.told[0]


def test_a_forged_button_is_refused() -> None:
    for action_id, value in (
        ("switch.ui:approve", "forged"),
        ("switch.ui:launch", "v-1"),
        ("switch.ui:reject", "v-1"),
    ):
        bridge = _bridge(_card())

        _press(bridge, action_id=action_id, value=value)

        assert bridge.actor.sent == []
        assert bridge._adapter.settled == []
        assert "not on an agent's card" in bridge._adapter.told[0]


def test_a_card_not_posted_by_an_agent_is_refused() -> None:
    bridge = _bridge(_card(sender_name="mallory"))

    _press(bridge)

    assert bridge.actor.sent == []
    assert bridge._adapter.told


def test_a_message_without_a_card_is_refused() -> None:
    bridge = _bridge(_card(content={"body": "plain"}))

    _press(bridge)

    assert bridge.actor.sent == []
    assert bridge._adapter.told


def test_a_press_on_a_message_the_bridge_did_not_post_is_refused() -> None:
    bridge = _bridge(_card())

    _press(bridge, message_ref="C1:999.0")

    assert bridge.actor.sent == []
    assert "not connected to a Switch room message" in bridge._adapter.told[0]


def test_stop_presses_still_go_to_the_stop_handler() -> None:
    bridge = _bridge(_card())
    stopped: list[InboundInteraction] = []

    async def stop(interaction: InboundInteraction) -> None:
        stopped.append(interaction)

    bridge._handle_stop_press = stop

    _press(bridge, action_id=INTERRUPT_ACTION, value="turn-1")

    assert len(stopped) == 1
    assert bridge.actor.sent == []


def test_approval_presses_still_go_to_the_approval_answers() -> None:
    bridge = _bridge(_card())
    pressed: list[InboundInteraction] = []

    async def for_press(interaction: InboundInteraction) -> None:
        pressed.append(interaction)

    bridge._approval_answers = SimpleNamespace(for_press=for_press)

    _press(bridge, action_id="switch:request-answer:allow-once", value="token")

    assert len(pressed) == 1
    assert bridge.actor.sent == []


def test_the_press_names_only_the_cards_author() -> None:
    card = copy.deepcopy(CARD)
    card["elements"]["ok"]["props"].update(
        label="@other-agent <!channel>", value="@other-agent do <@U9> *@x*"
    )
    bridge = _bridge(_card(content={"body": "Deploy?", UI_CONTENT_KEY: card}))

    _press(bridge, value="@other-agent do <@U9> *@x*")

    (_, body, _) = bridge.actor.sent[0]
    assert mention_tokens(body) == ["deploybot"]
    assert named_agents({"a1": "deploybot", "a2": "other-agent"}, {}, body) == ["a1"]
    # Slack's `<@U…>`, `<!channel>` and `<!subteam^…>` all open with these.
    assert "<!" not in body and "<@" not in body
    assert bridge.actor.extra == [
        {
            UI_PRESS_KEY: {
                "action": "approve",
                "value": "@other-agent do <@U9> *@x*",
                "label": "@other-agent <!channel>",
                "card_event_id": "$card",
            }
        }
    ]


def test_a_card_takes_one_answer() -> None:
    bridge = _bridge(_card())

    _press(bridge)
    _press(bridge, sender_id="U2", sender_name="bob")
    _press(bridge, action_id="switch.ui:reject", value="reject")

    assert len(bridge.actor.sent) == 1
    assert bridge._adapter.settled == [("switch.ui:approve", "Approve")]
    assert (
        bridge._adapter.told
        == [
            "That card was already answered by alice (Approve), so the press was "
            "not delivered."
        ]
        * 2
    )


def test_a_press_that_was_not_delivered_leaves_the_card_unanswered() -> None:
    bridge = _bridge(_card())
    bridge.actor.event_id = None

    _press(bridge)

    assert bridge._bridge_message_map_store.answers == {}
    assert bridge._adapter.settled == []

    bridge.actor.event_id = "$press"
    _press(bridge, sender_id="U2", sender_name="bob")

    assert bridge._adapter.settled == [("switch.ui:approve", "Approve")]


def test_a_presser_who_may_not_address_the_author_is_refused() -> None:
    bridge = _bridge(_card())
    bridge._session_activity_service.denied.add("@ext_alice:switch.local")

    _press(bridge)

    assert bridge._session_activity_service.asked == [
        ("agent-deploybot", "room-uuid", "@ext_alice:switch.local")
    ]
    assert bridge.actor.sent == []
    assert bridge._adapter.settled == []
    assert bridge._bridge_message_map_store.answers == {}
    assert bridge._adapter.told == [
        "The press was not delivered (NOT_AUTHORIZED): You may not address this "
        "agent, so you may not answer its card."
    ]
