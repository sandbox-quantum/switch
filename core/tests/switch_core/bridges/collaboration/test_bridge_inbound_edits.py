"""A platform edit of a post becomes an edit row in the post's room.

`CollaborationCore._handle_inbound_edit` finds the room message the post was
relayed as and writes, as the person, a row naming it (`messages/edits.py`).
The new text passes Switch Trust as the post did, and the row's id is derived
from the post and the edit, so the platform delivering the edit again writes
nothing new.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundEdit
from switch_core.clients.admin_messages import AdminMessageType
from switch_core.messages.edits import Edit, edit_of
from switch_core.transport.derived_ids import derived_writes
from switch_core.trust.client import TrustCheckResult, TrustFinding

TRANSPORT_ROOM_ID = "!room:switch.local"
POSTED_AS = "$room-message-of-the-post"


class _HumanActor:
    def __init__(self) -> None:
        self.client_id = "alice-client"
        self.sent: list[dict[str, Any]] = []

    async def send_message(self, room_id: str, body: str, **kwargs: Any) -> str | None:
        derived = derived_writes(self.client_id)
        self.sent.append(
            {
                "room_id": room_id,
                "body": body,
                "source": derived.source_id if derived else None,
                **kwargs,
            }
        )
        return "$edit-row"


class _Adapter:
    def __init__(self) -> None:
        self.admin_messages: list[tuple[str, str, str | None, str]] = []

    def translate_inbound(self, content: str) -> str:
        return content.replace("<@U1>", "@helper")

    async def admin_message(
        self,
        channel_id: str,
        body: str,
        root_or_ref: str | None,
        *,
        message_type: str,
    ) -> None:
        self.admin_messages.append((channel_id, body, root_or_ref, message_type))


class _Trust:
    def __init__(self, result: TrustCheckResult) -> None:
        self.result = result
        self.checked: list[str] = []

    async def check(self, *, role: str, content: str, room_id: str) -> TrustCheckResult:
        self.checked.append(content)
        return self.result


_PASS = TrustCheckResult(outcome="ok", policy_id=None, policy_name=None)


def _bridge(
    *,
    mapped: dict[str, str] | None = None,
    trust: TrustCheckResult = _PASS,
    agents: frozenset[str] = frozenset(),
) -> SimpleNamespace:
    human = _HumanActor()
    posts = {"C1:100.1": POSTED_AS} if mapped is None else mapped

    async def _event_for_external_post(external_post_id: str) -> str | None:
        return posts.get(external_post_id)

    async def _ensure_human_in_room(**_kw: object) -> _HumanActor:
        return human

    async def _is_registered_agent(name: str) -> bool:
        return name in agents

    bridge = SimpleNamespace(
        _bridge_id="bridge-1",
        _channel_to_room={"C1": ("room-uuid", TRANSPORT_ROOM_ID)},
        _adapter=_Adapter(),
        _trust_client=_Trust(trust),
        _event_for_external_post=_event_for_external_post,
        _ensure_human_in_room=_ensure_human_in_room,
        _is_registered_agent=_is_registered_agent,
        human=human,
    )
    # The real notice, so what the sender is told is what production posts.
    bridge._post_trust_notice = lambda said, body, message_type: (
        CollaborationCore._post_trust_notice(bridge, said, body, message_type)
    )
    return bridge


def _edit(
    content: str = "fix the typo in <@U1>'s README", **fields: Any
) -> InboundEdit:
    return InboundEdit(
        **{
            "channel_id": "C1",
            "sender_id": "U9",
            "sender_name": "alice",
            "content": content,
            "message_ref": "C1:100.1",
            "root_id": None,
            "edited_at": 1_700_000_000_500,
            **fields,
        }
    )


async def test_an_edit_names_the_message_its_post_became() -> None:
    bridge = _bridge()

    await CollaborationCore._handle_inbound_edit(bridge, _edit())  # type: ignore[arg-type]

    [sent] = bridge.human.sent
    assert sent["room_id"] == TRANSPORT_ROOM_ID
    assert edit_of(sent["extra_content"]) == Edit(
        original_event_id=POSTED_AS,
        body="fix the typo in @helper's README",
        edited_at=1_700_000_000_500,
    )
    # What a reader that knows nothing of edits shows.
    assert sent["body"] == "* fix the typo in @helper's README"
    assert sent["format"] == "text"
    # The post was metered when it arrived; changing it is not a new message.
    assert sent["metered"] is False
    # Never in a thread of its own: it is about the message, wherever that is.
    assert "thread_root_id" not in sent


async def test_the_same_edit_delivered_again_is_written_under_the_same_id() -> None:
    bridge = _bridge()

    await CollaborationCore._handle_inbound_edit(bridge, _edit())  # type: ignore[arg-type]
    await CollaborationCore._handle_inbound_edit(bridge, _edit())  # type: ignore[arg-type]
    await CollaborationCore._handle_inbound_edit(
        bridge,  # type: ignore[arg-type]
        _edit(edited_at=1_700_000_009_000),
    )

    first, again, later = (sent["source"] for sent in bridge.human.sent)
    assert first == again
    assert later != first
    assert "C1:100.1" in first


async def test_an_edit_of_a_post_that_never_reached_a_room_writes_nothing() -> None:
    bridge = _bridge(mapped={})

    await CollaborationCore._handle_inbound_edit(bridge, _edit())  # type: ignore[arg-type]

    assert bridge.human.sent == []


async def test_an_edit_in_a_channel_with_no_room_writes_nothing() -> None:
    bridge = _bridge()

    await CollaborationCore._handle_inbound_edit(
        bridge,  # type: ignore[arg-type]
        _edit(channel_id="C-unlinked"),
    )

    assert bridge.human.sent == []


async def test_an_agents_own_post_edited_on_the_platform_is_not_relayed() -> None:
    bridge = _bridge(agents=frozenset({"helper"}))

    await CollaborationCore._handle_inbound_edit(
        bridge,  # type: ignore[arg-type]
        _edit(sender_name="helper"),
    )

    assert bridge.human.sent == []


async def test_an_edit_switch_trust_blocks_never_reaches_the_room() -> None:
    bridge = _bridge(
        trust=TrustCheckResult(outcome="blocked", policy_id="p1", policy_name="pii")
    )

    await CollaborationCore._handle_inbound_edit(
        bridge,  # type: ignore[arg-type]
        _edit(root_id="C1:99.0"),
    )

    assert bridge.human.sent == []
    [(channel, body, thread, kind)] = bridge._adapter.admin_messages
    assert (channel, thread, kind) == (
        "C1",
        "C1:99.0",
        AdminMessageType.TRUST_BLOCKED.value,
    )
    assert "edit was blocked" in body


async def test_an_edit_switch_trust_redacts_reaches_the_room_redacted() -> None:
    bridge = _bridge(
        trust=TrustCheckResult(
            outcome="redacted",
            policy_id="p1",
            policy_name="pii",
            findings=(
                TrustFinding(category="email", detector_name="email", severity=None),
            ),
            redacted_content="mail [EMAIL]",
        )
    )

    await CollaborationCore._handle_inbound_edit(bridge, _edit("mail someone"))  # type: ignore[arg-type]

    [sent] = bridge.human.sent
    assert sent["body"] == "* mail [EMAIL]"
    edit = edit_of(sent["extra_content"])
    assert edit is not None and edit.body == "mail [EMAIL]"
    [(_, _, _, kind)] = bridge._adapter.admin_messages
    assert kind == AdminMessageType.TRUST_REDACTED.value
