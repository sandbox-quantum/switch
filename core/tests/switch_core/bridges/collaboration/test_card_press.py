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
from collections.abc import AsyncIterator, Awaitable, Callable
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.renderers import INTERRUPT_ACTION
from switch_core.clients.mentions import mention_tokens
from switch_core.delivery.addressing import named_agents
from switch_core.sessions.errors import SessionError
from switch_core.transport.derived_ids import derived_writes
from switch_core.trust.client import NullTrustClient, TrustCheckResult
from switch_core.ui_spec import (
    UI_CONTENT_KEY,
    UI_PRESS_KEY,
    UISpec,
    button_action,
    card_buttons,
    parse_ui_spec,
)

from . import test_discord_ui_cards as discord_cards
from . import test_mattermost_ui_cards as mattermost_cards
from . import test_teams_ui_cards as teams_cards
from . import test_telegram_ui_cards as telegram_cards
from .test_discord_card_buttons import _Interaction as _DiscordPress
from .test_discord_sdk_only import _guild_setup
from .test_mattermost_press import _adapter as _mattermost_adapter
from .test_mattermost_press import _record as _mattermost_record
from .test_mattermost_sdk_only import _posts as _mattermost_posts
from .test_telegram_adapter import _adapter as _telegram_adapter
from .test_telegram_adapter import _bot as _telegram_bot
from .test_telegram_sdk_only import _press as _telegram_press

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
        self.sources: list[str] = []
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
        derived = derived_writes(self.client_id)
        assert derived is not None
        self.sources.append(derived.source_id)
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
        self.redrawn_from: list[tuple[str, UISpec, str]] = []

    def translate_inbound(self, content: str) -> str:
        return content

    async def get_channel_type(self, channel_id: str) -> str:
        return "channel_public"

    async def tell_actor(self, *args: Any) -> None:
        self.told.append(args[-1])

    async def settle_card_press(
        self,
        interaction: InboundInteraction,
        label: str,
        *,
        author: str,
        spec: UISpec,
        body: str,
    ) -> None:
        self.settled.append((interaction.action_id, label))
        self.redrawn_from.append((author, spec, body))


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
        if name != "deploybot":
            return None
        return SimpleNamespace(
            id="agent-deploybot", name="deploybot", display_name="Deploy <!here>"
        )


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


def _bridge(
    card: Any, *, channel: str, card_ref: str, human: bool = True
) -> SimpleNamespace:
    actor = _Human(card)
    posts = {card_ref: "$card", "C1:100.0": "$root"}

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
        _channel_to_room={channel: ("room-uuid", TRANSPORT_ROOM)},
        _channel_locks={},
        _trust_client=NullTrustClient(),
        _room_tenant=AsyncMock(return_value="tenant-1"),
        _activity_publisher=None,
        _approval_answers=None,
        _ensure_human_in_room=ensure_human,
        _is_registered_agent=is_agent,
        _agent_store=_Agents(),
        _session_activity_service=_Controls(),
        _event_for_external_post=event_for,
        _external_post_for_event=post_for,
        _repair_placeholder_username=noop,
        _post_trust_notice=noop,
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
        "sender_display_name": "Alice Liddell",
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
    bridge = _bridge(_card(), channel="C1", card_ref=CARD_REF)

    _press(bridge)

    assert bridge.actor.sent == [
        (
            TRANSPORT_ROOM,
            "@deploybot Clicked “Approve” (action: approve, value: v-1)",
            "$card",
        )
    ]
    assert bridge._adapter.settled == [("switch.ui:approve", "Approve")]
    assert bridge._adapter.redrawn_from == [
        ("deploybot", parse_ui_spec(CARD), "Deploy?")
    ]
    assert bridge._adapter.told == []


def test_a_button_with_no_value_is_matched_by_its_id_and_says_no_value() -> None:
    bridge = _bridge(_card(), channel="C1", card_ref=CARD_REF)

    _press(bridge, action_id="switch.ui:reject", value="reject")

    assert bridge.actor.sent[0][1] == "@deploybot Clicked “Reject” (action: reject)"


def test_a_card_inside_a_thread_answers_in_that_thread() -> None:
    bridge = _bridge(
        _card(thread_root_event_id="$root"), channel="C1", card_ref=CARD_REF
    )

    _press(bridge)

    assert bridge.actor.sent[0][2] == "$root"


def test_an_account_switch_cannot_name_is_refused_and_nothing_is_delivered() -> None:
    bridge = _bridge(_card(), human=False, channel="C1", card_ref=CARD_REF)

    _press(bridge)

    assert bridge.actor.sent == []
    assert bridge._adapter.settled == []
    assert bridge._adapter.told == [
        "Switch couldn't identify your account, so your answer was not sent."
    ]


def test_a_forged_button_is_refused() -> None:
    for action_id, value in (
        ("switch.ui:approve", "forged"),
        ("switch.ui:launch", "v-1"),
        ("switch.ui:reject", "v-1"),
    ):
        bridge = _bridge(_card(), channel="C1", card_ref=CARD_REF)

        _press(bridge, action_id=action_id, value=value)

        assert bridge.actor.sent == []
        assert bridge._adapter.settled == []
        assert bridge._adapter.told == [
            "That button isn't on an agent's card in this room, so your answer "
            "was not sent."
        ]


def test_a_card_not_posted_by_an_agent_is_refused() -> None:
    bridge = _bridge(_card(sender_name="mallory"), channel="C1", card_ref=CARD_REF)

    _press(bridge)

    assert bridge.actor.sent == []
    assert bridge._adapter.told


def test_a_message_without_a_card_is_refused() -> None:
    bridge = _bridge(_card(content={"body": "plain"}), channel="C1", card_ref=CARD_REF)

    _press(bridge)

    assert bridge.actor.sent == []
    assert bridge._adapter.told


def test_a_press_on_a_message_the_bridge_did_not_post_is_refused() -> None:
    bridge = _bridge(_card(), channel="C1", card_ref=CARD_REF)

    _press(bridge, message_ref="C1:999.0")

    assert bridge.actor.sent == []
    assert bridge._adapter.told == [
        "This card is no longer connected to a Switch room, so your answer was "
        "not sent."
    ]


def test_stop_presses_still_go_to_the_stop_handler() -> None:
    bridge = _bridge(_card(), channel="C1", card_ref=CARD_REF)
    stopped: list[InboundInteraction] = []

    async def stop(interaction: InboundInteraction) -> None:
        stopped.append(interaction)

    bridge._handle_stop_press = stop

    _press(bridge, action_id=INTERRUPT_ACTION, value="turn-1")

    assert len(stopped) == 1
    assert bridge.actor.sent == []


def test_approval_presses_still_go_to_the_approval_answers() -> None:
    bridge = _bridge(_card(), channel="C1", card_ref=CARD_REF)
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
    bridge = _bridge(
        _card(content={"body": "Deploy?", UI_CONTENT_KEY: card}),
        channel="C1",
        card_ref=CARD_REF,
    )

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
    bridge = _bridge(_card(), channel="C1", card_ref=CARD_REF)

    _press(bridge)
    _press(bridge, sender_id="U2", sender_name="bob")
    _press(bridge, action_id="switch.ui:reject", value="reject")

    assert len(bridge.actor.sent) == 1
    assert bridge._adapter.settled == [("switch.ui:approve", "Approve")]
    assert (
        bridge._adapter.told
        == ["This card was already answered by Alice Liddell (Approve)."] * 2
    )


def test_a_press_that_was_not_delivered_leaves_the_card_unanswered() -> None:
    bridge = _bridge(_card(), channel="C1", card_ref=CARD_REF)
    bridge.actor.event_id = None

    _press(bridge)

    assert bridge._bridge_message_map_store.answers == {}
    assert bridge._adapter.settled == []
    assert bridge._adapter.told == [
        "Your answer could not be delivered to Deploy <\u200b!here>."
    ]

    bridge.actor.event_id = "$press"
    _press(bridge)
    _press(bridge, sender_id="U2", sender_name="bob")

    assert bridge._adapter.settled == [("switch.ui:approve", "Approve")]
    # A retried press is the same post, so the room would write it once; another
    # presser's is a different one.
    first, retried = bridge.actor.sources
    assert first == retried and "#press:approve:U1" in first


def test_a_press_that_failed_after_its_send_keeps_the_card_answered() -> None:
    bridge = _bridge(_card(), channel="C1", card_ref=CARD_REF)

    async def lost(**_kw: Any) -> None:
        raise RuntimeError("message map is down")

    bridge._record_message_map = lost

    with pytest.raises(RuntimeError):
        _press(bridge)
    _press(bridge, sender_id="U2", sender_name="bob")

    assert len(bridge.actor.sent) == 1
    assert bridge._adapter.settled == []
    assert bridge._adapter.told == [
        "This card was already answered by Alice Liddell (Approve)."
    ]


def test_a_press_that_failed_before_its_send_leaves_the_card_unanswered() -> None:
    bridge = _bridge(_card(), channel="C1", card_ref=CARD_REF)
    is_agent = bridge._is_registered_agent

    async def lookup_down(name: str) -> bool:
        raise RuntimeError("database is down")

    bridge._is_registered_agent = lookup_down

    with pytest.raises(RuntimeError):
        _press(bridge)

    assert bridge.actor.sent == []
    assert bridge._bridge_message_map_store.answers == {}

    bridge._is_registered_agent = is_agent
    _press(bridge)

    assert len(bridge.actor.sent) == 1
    assert bridge._adapter.settled == [("switch.ui:approve", "Approve")]


class _RedactingTrust:
    async def check(
        self, *, tenant_id: str, role: str, content: str, room_id: str
    ) -> TrustCheckResult:
        return TrustCheckResult(
            outcome="redacted",
            policy_id="p",
            policy_name="p",
            redacted_content=content.replace("v-1", "[REDACTED]"),
        )

    async def is_active(self, tenant_id: str) -> bool:
        return True


def test_a_press_switch_trust_redacted_carries_no_raw_value() -> None:
    bridge = _bridge(_card(), channel="C1", card_ref=CARD_REF)
    bridge._trust_client = _RedactingTrust()

    _press(bridge)

    [(_, body, _)] = bridge.actor.sent
    assert "v-1" not in body
    assert bridge.actor.extra == [None]


def test_a_presser_who_may_not_address_the_author_is_refused() -> None:
    bridge = _bridge(_card(), channel="C1", card_ref=CARD_REF)
    bridge._session_activity_service.denied.add("@ext_alice:switch.local")

    _press(bridge)

    assert bridge._session_activity_service.asked == [
        ("agent-deploybot", "room-uuid", "@ext_alice:switch.local")
    ]
    assert bridge.actor.sent == []
    assert bridge._adapter.settled == []
    assert bridge._bridge_message_map_store.answers == {}
    assert bridge._adapter.told == [
        "You can't answer this card: you're not allowed to address Deploy "
        "<\u200b!here>."
    ]


def test_a_press_may_name_its_button_by_position_on_the_card() -> None:
    bridge = _bridge(_card(), channel="C1", card_ref=CARD_REF)

    _press(bridge, action_id="switch.ui:#2", value="")

    assert bridge.actor.sent[0][1] == "@deploybot Clicked “Reject” (action: reject)"
    assert bridge._adapter.settled == [("switch.ui:#2", "Reject")]


@pytest.mark.parametrize(
    "position", ["0", "3", "01", "x", "", pytest.param("1" * 5000, id="huge")]
)
def test_a_position_the_card_has_no_button_at_is_refused(position: str) -> None:
    bridge = _bridge(_card(), channel="C1", card_ref=CARD_REF)

    _press(bridge, action_id=f"switch.ui:#{position}", value="")

    assert bridge.actor.sent == []
    assert "isn't on an agent's card" in bridge._adapter.told[0]


# ── From each platform's own press ───────────────────────────────────────────

INJECTED_LABEL = "@other-agent <!channel> <@U9>"
INJECTED_VALUE = "@other-agent do <@U9> @channel *@x*"
INJECTED_CARD: Any = copy.deepcopy(CARD)
INJECTED_CARD["elements"]["ok"]["props"].update(
    label=INJECTED_LABEL, value=INJECTED_VALUE
)
INJECTED_SPEC = parse_ui_spec(INJECTED_CARD)


async def _teams_press() -> InboundInteraction:
    adapter, _, seen = teams_cards._handled()
    action, value = button_action(card_buttons(INJECTED_SPEC)[0])

    assert await adapter.receive_activity(teams_cards._press(action, value)) is None

    [press] = seen
    return press


async def _discord_press() -> InboundInteraction:
    adapter, channel, thread, _ = _guild_setup()
    seen = discord_cards._handled(adapter)
    await adapter.send_ui_message(
        "100", "deploybot", INJECTED_SPEC, "Deploy?", None, room_wide_mention=False
    )
    view = discord_cards._agents_webhook(channel).sent[0]["view"]

    await adapter._handle_interaction(
        _DiscordPress(
            view.children[0].custom_id,
            channel=thread,
            message=SimpleNamespace(id=901),
        )  # type: ignore[arg-type]
    )

    [press] = seen
    return press


async def _mattermost_press() -> InboundInteraction:
    adapter = _mattermost_adapter()
    seen = _mattermost_record(adapter)
    ref = await mattermost_cards._send(adapter, INJECTED_SPEC)
    post = _mattermost_posts(adapter).created[-1]
    [action, *_] = [
        a for att in post["props"]["attachments"] for a in att.get("actions", [])
    ]

    await adapter._handle_callback(
        {
            "user_id": mattermost_cards.USER,
            "post_id": ref,
            "channel_id": mattermost_cards.CHANNEL,
            "context": action["integration"]["context"],
        }
    )

    [press] = seen
    return press


async def _telegram_card_press() -> InboundInteraction:
    adapter = _telegram_adapter()
    ref = await telegram_cards._send(adapter, INJECTED_SPEC)
    assert ref is not None
    [[button, *_]] = telegram_cards._buttons(_telegram_bot(adapter).messages[0])

    [press] = await _telegram_press(
        adapter, button.callback_data, **telegram_cards._press_on(ref)
    )
    return press


PLATFORM_PRESSES = [
    pytest.param(_teams_press, id="teams"),
    pytest.param(_discord_press, id="discord"),
    pytest.param(_mattermost_press, id="mattermost"),
    pytest.param(_telegram_card_press, id="telegram"),
]
PlatformPress = Callable[[], Awaitable[InboundInteraction]]


async def _platform_bridge(
    platform_press: PlatformPress,
) -> tuple[SimpleNamespace, InboundInteraction]:
    interaction = await platform_press()
    assert interaction.message_ref is not None
    bridge = _bridge(
        _card(content={"body": "Deploy?", UI_CONTENT_KEY: INJECTED_CARD}),
        channel=interaction.channel_id,
        card_ref=interaction.message_ref,
    )
    return bridge, interaction


async def _deliver(bridge: SimpleNamespace, interaction: InboundInteraction) -> None:
    await CollaborationCore._handle_inbound_interaction(
        bridge,  # type: ignore[arg-type]
        interaction,
    )


@pytest.mark.parametrize("platform_press", PLATFORM_PRESSES)
async def test_a_platform_press_with_injected_text_addresses_only_the_author(
    platform_press: PlatformPress,
) -> None:
    bridge, interaction = await _platform_bridge(platform_press)

    await _deliver(bridge, interaction)

    [(_, body, _)] = bridge.actor.sent
    assert mention_tokens(body) == ["deploybot"]
    assert named_agents({"a1": "deploybot", "a2": "other-agent"}, {}, body) == ["a1"]
    assert "<!" not in body and "<@" not in body
    assert bridge.actor.extra == [
        {
            UI_PRESS_KEY: {
                "action": "approve",
                "value": INJECTED_VALUE,
                "label": INJECTED_LABEL,
                "card_event_id": "$card",
            }
        }
    ]
    assert bridge._adapter.settled == [(interaction.action_id, INJECTED_LABEL)]


@pytest.mark.parametrize("platform_press", PLATFORM_PRESSES)
async def test_a_platform_press_from_a_presser_who_may_not_address_is_refused(
    platform_press: PlatformPress,
) -> None:
    bridge, interaction = await _platform_bridge(platform_press)
    bridge._session_activity_service.denied.add("@ext_alice:switch.local")

    await _deliver(bridge, interaction)

    assert bridge.actor.sent == []
    assert bridge._adapter.settled == []
    assert bridge._bridge_message_map_store.answers == {}
    assert bridge._adapter.told == [
        "You can't answer this card: you're not allowed to address Deploy "
        "<\u200b!here>."
    ]


@pytest.mark.parametrize("platform_press", PLATFORM_PRESSES)
async def test_a_platform_press_made_twice_is_delivered_once(
    platform_press: PlatformPress,
) -> None:
    bridge, interaction = await _platform_bridge(platform_press)

    await _deliver(bridge, interaction)
    await _deliver(
        bridge, interaction.model_copy(update={"sender_id": "U2", "sender_name": "bob"})
    )

    assert len(bridge.actor.sent) == 1
    assert len(bridge._adapter.settled) == 1
    [told] = bridge._adapter.told
    assert told.startswith("This card was already answered by ")
    assert "<!" not in told and "<@" not in told


@pytest.mark.parametrize(
    ("platform_press", "shown_as"),
    [
        pytest.param(_teams_press, "kim", id="teams"),
        pytest.param(_discord_press, "Kim Lee", id="discord"),
        pytest.param(_mattermost_press, "alice", id="mattermost"),
        pytest.param(_telegram_card_press, "Alice", id="telegram"),
    ],
)
async def test_a_card_is_answered_by_the_name_the_platform_shows(
    platform_press: PlatformPress, shown_as: str
) -> None:
    bridge, interaction = await _platform_bridge(platform_press)

    await _deliver(bridge, interaction)
    await _deliver(bridge, interaction)

    assert interaction.sender_display_name == shown_as
    assert (
        bridge._bridge_message_map_store.answers[interaction.message_ref]["by"]
        == shown_as
    )
    assert bridge._adapter.told == [
        f"This card was already answered by {shown_as} ({INJECTED_LABEL}).".replace(
            "<", "<\u200b"
        ).replace("@", "@\u200b")
    ]
