"""A platform's edit of a post becomes an edit of the room message the post
was relayed as.

`CollaborationCore._handle_inbound_edit` writes a row of its own, as the
post's author, with the new text and the message it replaces. Nothing is
written for an edit that has no message to be an edit of, changes nothing,
turns a message into a command, or comes from someone other than the message's
sender.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration import collaboration_core
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.clients.admin_messages import AdminMessageType
from switch_core.transport.derived_ids import derived_writes
from switch_core.trust.client import NullTrustClient, TrustCheckResult

ORIGINAL = "$original"
ROOM = "room-1"


class _FakeHumanActor:
    client_id = "alice-client"
    transport_user_id = "@alice:s"

    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    async def send_message(
        self,
        transport_room_id: str,
        content: str,
        *,
        metered: bool,
        format: str | None = None,  # noqa: A002
        thread_root_id: str | None = None,
        extra_content: dict[str, object] | None = None,
        replaces_event_id: str | None = None,
    ) -> str:
        derived = derived_writes(self.client_id)
        self.messages.append(
            {
                "room": transport_room_id,
                "content": content,
                "thread_root_id": thread_root_id,
                "replaces_event_id": replaces_event_id,
                "source": derived.source_id if derived is not None else None,
            }
        )
        return "$edit"


class _FakeAdapter:
    def __init__(self) -> None:
        self.admin_messages: list[tuple[str, str, str | None, str]] = []

    def translate_inbound(self, content: str) -> str:
        return content

    async def admin_message(
        self, channel_id: str, body: str, root_or_ref: str | None, *, message_type: str
    ) -> None:
        self.admin_messages.append((channel_id, body, root_or_ref, message_type))


class _FakeMessageStore:
    def __init__(self, rows: list[Any], latest: dict[str, Any] | None = None) -> None:
        self.rows = {row.transport_event_id: row for row in rows}
        self.latest = latest or {}

    async def get_by_transport_event_id(self, _session: object, event_id: str) -> Any:
        return self.rows.get(event_id)

    async def latest_replacements(
        self, _session: object, room_id: str, event_ids: list[str]
    ) -> dict[str, Any]:
        return {k: v for k, v in self.latest.items() if k in event_ids}


class _FixedTrustClient:
    def __init__(self, result: TrustCheckResult) -> None:
        self._result = result

    async def check(self, *, role: str, content: str, room_id: str) -> TrustCheckResult:
        return self._result


def _row(
    *,
    event_id: str = ORIGINAL,
    body: str = "look at teh file",
    sender_id: str = "@alice:s",
    event_type: str = "m.room.message",
    room_id: str = ROOM,
) -> SimpleNamespace:
    return SimpleNamespace(
        transport_event_id=event_id,
        room_id=room_id,
        event_type=event_type,
        sender_id=sender_id,
        body=body,
    )


@asynccontextmanager
async def _no_session():  # type: ignore[no-untyped-def]
    yield None


def _bridge(
    monkeypatch: pytest.MonkeyPatch,
    *,
    rows: list[Any] | None = None,
    latest: dict[str, Any] | None = None,
    mapped: dict[str, str] | None = None,
    trust: object | None = None,
) -> SimpleNamespace:
    monkeypatch.setattr(
        collaboration_core,
        "_MESSAGE_STORE",
        _FakeMessageStore(rows if rows is not None else [_row()], latest),
    )
    human_actor = _FakeHumanActor()
    mapping = mapped if mapped is not None else {"post-1": ORIGINAL}

    async def _is_registered_agent(name: str) -> bool:
        return name == "helper"

    async def _ensure_human_in_room(**_kwargs: Any) -> _FakeHumanActor:
        return human_actor

    async def _event_for_external_post(ref: str) -> str | None:
        return mapping.get(ref)

    async def _resolve_self_mention_target(_msg: object, _room: str) -> str | None:
        return "helper"

    return SimpleNamespace(
        _bridge_id="bridge-1",
        _adapter=_FakeAdapter(),
        _channel_to_room={"chan-1": (ROOM, "!room:s")},
        _is_registered_agent=_is_registered_agent,
        _ensure_human_in_room=_ensure_human_in_room,
        _event_for_external_post=_event_for_external_post,
        _resolve_self_mention_target=_resolve_self_mention_target,
        _session_factory=_no_session,
        _trust_client=trust if trust is not None else NullTrustClient(),
        human_actor=human_actor,
    )


def _edit(
    content: str = "look at the file",
    *,
    message_ref: str = "post-1",
    revision: str = "1700",
    sender_id: str = "U1",
    sender_name: str = "alice",
    channel_id: str = "chan-1",
    self_mention_token: str | None = None,
) -> InboundMessage:
    return InboundMessage(
        channel_id=channel_id,
        channel_type="channel_public",
        sender_id=sender_id,
        sender_name=sender_name,
        content=content,
        message_ref=message_ref,
        edit_revision=revision,
        self_mention_token=self_mention_token,
    )


async def _relay(bridge: SimpleNamespace, msg: InboundMessage) -> None:
    # `_post_trust_notice` posts through the bridge's adapter; bind it to this
    # bridge so a notice reaches the fake adapter.
    bridge._post_trust_notice = CollaborationCore._post_trust_notice.__get__(bridge)
    await CollaborationCore._handle_inbound_edit(bridge, msg)  # type: ignore[arg-type]


async def test_an_inbound_message_with_a_revision_is_handled_as_an_edit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _bridge(monkeypatch)
    edits: list[InboundMessage] = []

    async def _handle_inbound_edit(msg: InboundMessage) -> None:
        edits.append(msg)

    bridge._handle_inbound_edit = _handle_inbound_edit
    await CollaborationCore._handle_inbound_message(bridge, _edit())  # type: ignore[arg-type]

    assert [msg.edit_revision for msg in edits] == ["1700"]
    # Nothing of the ordinary path ran: no actor was asked for, nothing written.
    assert bridge.human_actor.messages == []


async def test_an_edit_is_written_as_the_authors_edit_of_their_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _bridge(monkeypatch)

    await _relay(bridge, _edit())

    [written] = bridge.human_actor.messages
    assert written["room"] == "!room:s"
    assert written["content"] == "look at the file"
    assert written["replaces_event_id"] == ORIGINAL
    # Not threaded itself: the thread is the original's.
    assert written["thread_root_id"] is None
    # Numbered from the post and this revision, so the same edit delivered
    # again writes nothing, and a later edit is a new row.
    assert written["source"] == "bridge-1\x1fchan-1\x1fpost-1\x1fedit\x1f1700"


async def test_a_later_edit_of_the_same_post_is_a_new_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _bridge(monkeypatch)

    await _relay(bridge, _edit("look at the file", revision="1700"))
    await _relay(bridge, _edit("look at the files", revision="1800"))

    sources = [written["source"] for written in bridge.human_actor.messages]
    assert sources == [
        "bridge-1\x1fchan-1\x1fpost-1\x1fedit\x1f1700",
        "bridge-1\x1fchan-1\x1fpost-1\x1fedit\x1f1800",
    ]


async def test_an_edit_of_a_post_that_never_reached_the_room_is_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _bridge(monkeypatch, mapped={})

    await _relay(bridge, _edit())

    assert bridge.human_actor.messages == []


async def test_an_edit_in_a_channel_with_no_room_is_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _bridge(monkeypatch)

    await _relay(bridge, _edit(channel_id="chan-unknown"))

    assert bridge.human_actor.messages == []


async def test_an_edit_that_leaves_the_text_as_it_stands_is_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _bridge(monkeypatch)

    await _relay(bridge, _edit("look at teh file"))

    assert bridge.human_actor.messages == []


async def test_unchanged_is_judged_against_the_latest_edit_not_the_original(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _bridge(
        monkeypatch,
        latest={ORIGINAL: _row(event_id="$edit-1", body="look at the file")},
    )

    await _relay(bridge, _edit("look at the file"))
    assert bridge.human_actor.messages == []

    await _relay(bridge, _edit("look at teh file", revision="1900"))
    assert [w["content"] for w in bridge.human_actor.messages] == ["look at teh file"]


async def test_an_edit_that_would_make_a_command_is_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _bridge(monkeypatch)

    await _relay(bridge, _edit("!reset @helper"))

    assert bridge.human_actor.messages == []


async def test_an_edit_of_a_command_runs_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _bridge(monkeypatch, rows=[_row(event_type="com.switch.command")])

    await _relay(bridge, _edit("!reset @reviewer"))
    await _relay(bridge, _edit("hello", revision="1800"))

    assert bridge.human_actor.messages == []


async def test_someone_elses_edit_of_a_message_is_not_relayed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _bridge(monkeypatch, rows=[_row(sender_id="@bob:s")])

    await _relay(bridge, _edit())

    assert bridge.human_actor.messages == []


async def test_a_message_mapped_to_another_room_is_not_edited_through_this_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _bridge(monkeypatch, rows=[_row(room_id="room-2")])

    await _relay(bridge, _edit())

    assert bridge.human_actor.messages == []


async def test_an_agents_own_echo_is_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    bridge = _bridge(monkeypatch)

    await _relay(bridge, _edit(sender_name="helper"))

    assert bridge.human_actor.messages == []


async def test_tagging_the_app_still_addresses_the_agent_after_an_edit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _bridge(monkeypatch)

    await _relay(bridge, _edit("look at the file", self_mention_token="BOT"))

    [written] = bridge.human_actor.messages
    assert written["content"] == "@helper look at the file"


async def test_a_blocked_edit_is_not_written_and_the_sender_is_told(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _bridge(
        monkeypatch,
        trust=_FixedTrustClient(
            TrustCheckResult(outcome="blocked", policy_id="p", policy_name="default")
        ),
    )

    await _relay(bridge, _edit("look at the secret"))

    assert bridge.human_actor.messages == []
    [(channel, body, ref, kind)] = bridge._adapter.admin_messages
    assert channel == "chan-1"
    assert "edit was blocked" in body
    assert ref == "post-1"
    assert kind == AdminMessageType.TRUST_BLOCKED.value
