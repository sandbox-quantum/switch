"""An edit on Slack or Mattermost becomes one generic edit row in the room.

Sample payloads, shaped as each platform sends them. Nothing here is a real
workspace, channel or person.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.collaboration_core import (
    CollaborationCore,
    _EditTarget,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import InboundEdit, InboundMessage
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.db.models import BridgeMessageMap, CollaborationBridge
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.bridge_message_map_store import BridgeMessageMapStore
from switch_core.messages.edits import (
    MESSAGE_EDIT_EVENT_TYPE,
    edit_source,
    parse_edit,
)
from switch_core.transport.derived_ids import _DERIVED
from switch_core.trust.client import TrustCheckResult
from tests.routing import add_member, make_agent, make_person, make_room, process_on


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ── Slack ─────────────────────────────────────────────────────────────────────


def _slack() -> tuple[SlackAdapter, list[InboundEdit], list[InboundMessage]]:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
        )
    )
    adapter.set_tenant_id("tenant-1")
    adapter._bot_user_id = "UBOT"
    adapter._bot_id = "BBOT"
    edits: list[InboundEdit] = []
    messages: list[InboundMessage] = []

    async def on_edit(edit: InboundEdit) -> None:
        edits.append(edit)

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    adapter.set_edit_handler(on_edit)
    adapter._on_message = on_message
    adapter._channel_name_cache["C123"] = "general"
    return adapter, edits, messages


def _message_changed(**message: Any) -> dict[str, Any]:
    new = {
        "type": "message",
        "user": "U1",
        "text": "Decline",
        "ts": "100.000100",
        "edited": {"user": "U1", "ts": "300.000200"},
        **message,
    }
    return {
        "type": "message",
        "subtype": "message_changed",
        "hidden": True,
        "channel": "C123",
        "channel_type": "channel",
        "ts": "300.000300",
        "event_ts": "300.000300",
        "message": new,
        "previous_message": {
            "type": "message",
            "user": "U1",
            "text": "Approve",
            "ts": "100.000100",
        },
    }


def test_slack_message_changed_becomes_an_edit() -> None:
    adapter, edits, messages = _slack()
    _run(adapter._handle_message_event(_message_changed()))
    assert messages == []
    assert edits == [
        InboundEdit(
            channel_id="C123",
            sender_id="U1",
            sender_name="U1",
            message_ref="C123:100.000100",
            content="Decline",
            revision=300_000_200,
            timestamp=300_000,
        )
    ]


@pytest.mark.parametrize(
    "changes",
    [
        pytest.param({"user": "UBOT"}, id="the bridge's own bot user"),
        pytest.param({"bot_id": "BBOT"}, id="the bridge's own bot id"),
        pytest.param({"bot_id": "BOTHER"}, id="another app"),
        pytest.param({"edited": None}, id="no edit, such as a link preview"),
        pytest.param({"text": "Approve"}, id="the words did not change"),
        pytest.param(
            {"edited": {"user": "UADMIN", "ts": "300.0"}}, id="edited by someone else"
        ),
    ],
)
def test_slack_changes_that_are_not_a_person_editing_their_message(
    changes: dict[str, Any],
) -> None:
    adapter, edits, messages = _slack()
    event = _message_changed(**changes)
    if changes.get("edited", {}) is None:
        del event["message"]["edited"]
    _run(adapter._handle_message_event(event))
    assert edits == [] and messages == []


def test_slack_other_subtypes_are_still_skipped() -> None:
    adapter, edits, messages = _slack()
    _run(
        adapter._handle_message_event(
            {"subtype": "message_deleted", "channel": "C123", "ts": "1.0"}
        )
    )
    assert edits == [] and messages == []


# ── Mattermost ────────────────────────────────────────────────────────────────


def _mattermost() -> tuple[MattermostAdapter, list[InboundEdit], list[Any]]:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm", admin_user="admin", admin_password="pw", team_name="team"
        )
    )
    adapter._bridge_bot_ids = {"bridge-bot"}
    adapter._admin_user_id = "admin-id"
    edits: list[InboundEdit] = []
    others: list[Any] = []

    async def on_edit(edit: InboundEdit) -> None:
        edits.append(edit)

    async def on_other(event: Any) -> None:
        others.append(event)

    adapter.set_edit_handler(on_edit)
    adapter._on_message = on_other
    adapter._on_command = on_other
    return adapter, edits, others


def _post_edited(adapter: MattermostAdapter, **post: Any) -> None:
    loop = asyncio.new_event_loop()
    dispatched: list[Any] = []
    adapter._main_loop = loop
    adapter._dispatch = lambda coro, _loop: dispatched.append(coro)  # type: ignore[method-assign]
    event = {
        "event": "post_edited",
        "data": {
            "post": json.dumps(
                {
                    "id": "post-1",
                    "user_id": "person",
                    "channel_id": "chan-1",
                    "message": "Decline",
                    "edit_at": 1_700_000_000_123,
                    "type": "",
                    "props": {},
                    **post,
                }
            )
        },
    }
    try:
        loop.run_until_complete(adapter._ws_handler(json.dumps(event), "some-agent"))
        for coro in dispatched:
            loop.run_until_complete(coro)
    finally:
        loop.close()


def test_mattermost_post_edited_becomes_the_same_edit() -> None:
    adapter, edits, others = _mattermost()
    _post_edited(adapter)
    assert others == []
    assert edits == [
        InboundEdit(
            channel_id="chan-1",
            sender_id="person",
            sender_name="person",
            message_ref="post-1",
            content="Decline",
            revision=1_700_000_000_123,
            timestamp=1_700_000_000_123,
        )
    ]


@pytest.mark.parametrize(
    "post",
    [
        pytest.param({"user_id": "bridge-bot"}, id="the bridge's own bot"),
        pytest.param({"user_id": "admin-id"}, id="the bridge's admin"),
        pytest.param({"type": "system_add_to_channel"}, id="a system post"),
        pytest.param({"edit_at": 0}, id="updated but not edited, such as a pin"),
        pytest.param({"props": {"from_webhook": "true"}}, id="an incoming webhook"),
        pytest.param({"props": {"from_bot": "true"}}, id="another bot"),
    ],
)
def test_mattermost_changes_that_are_not_a_person_editing_their_post(
    post: dict[str, Any],
) -> None:
    adapter, edits, others = _mattermost()
    _post_edited(adapter, **post)
    assert edits == [] and others == []


def test_mattermost_one_edit_heard_on_several_sockets_is_one_edit() -> None:
    adapter, edits, _ = _mattermost()
    _post_edited(adapter)
    _post_edited(adapter)
    _post_edited(adapter, edit_at=1_700_000_000_999, message="Hold")
    assert [edit.revision for edit in edits] == [
        1_700_000_000_123,
        1_700_000_000_999,
    ]


# ── The bridge ────────────────────────────────────────────────────────────────

_EDIT = InboundEdit(
    channel_id="chan-1",
    sender_id="ext-alice",
    message_ref="post-1",
    content="Decline",
    revision=7,
    timestamp=1234,
)
_SENT_BY_ALICE = _EditTarget(
    event_id="sw_original", sender_id="@alice:test", room_id="room-1"
)


class _Human:
    client_id = "alice-client"
    transport_user_id = "@alice:test"

    def __init__(self) -> None:
        self.sent: list[tuple[str, str, dict[str, object], str | None]] = []

    async def send_event(
        self, room_id: str, event_type: str, content: dict[str, object]
    ) -> str:
        derived = _DERIVED.get()
        self.sent.append(
            (room_id, event_type, content, derived.source_id if derived else None)
        )
        return "sw_edit"


class _Adapter:
    platform_name = "sample"
    private_notice_delivery = "in_channel"

    def __init__(self) -> None:
        self.notices: list[str] = []
        self.private: list[tuple[str, str]] = []

    def unlinkable_account_reason(self, _sender_id: str) -> str | None:
        return None

    async def notify_privately(
        self,
        *,
        channel_id: str,
        channel_name: str | None,
        user_id: str,
        content: str,
        thread_root_id: str | None,
    ) -> None:
        self.private.append((user_id, content))

    def translate_inbound(self, content: str) -> str:
        return content

    async def admin_message(
        self, channel_id: str, body: str, ref: str | None, *, message_type: str
    ) -> None:
        self.notices.append(body)


class _Trust:
    def __init__(self, outcome: str = "allowed", redacted: str | None = None) -> None:
        self.result = TrustCheckResult(
            outcome=outcome,  # type: ignore[arg-type]
            redacted_content=redacted,
            policy_id=None,
            policy_name=None,
        )
        self.checked: list[str] = []

    async def check(self, *, role: str, content: str, room_id: str) -> TrustCheckResult:
        self.checked.append(content)
        return self.result


def _bridge(
    *, target: _EditTarget | None = _SENT_BY_ALICE, trust: _Trust | None = None
) -> tuple[SimpleNamespace, _Human, _Adapter]:
    human = _Human()
    adapter = _Adapter()

    async def find_target(_edit: InboundEdit) -> _EditTarget | None:
        return target

    async def must_not_run(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("an edit is not a new message")

    bridge = SimpleNamespace(
        _bridge_id="bridge-1",
        _adapter=adapter,
        _trust_client=trust or _Trust(),
        _channel_to_room={"chan-1": ("room-1", "!room:test")},
        _human_actors={"ext-alice": "alice-client"},
        _client_lifecycle=SimpleNamespace(get=lambda _id: human),
        _find_edit_target=find_target,
        _ensure_human_in_room=must_not_run,
        _handle_text_answer=must_not_run,
        _record_message_map=must_not_run,
    )
    bridge._post_trust_notice = lambda *args: CollaborationCore._post_trust_notice(
        bridge, *args
    )
    return bridge, human, adapter


async def test_the_bridge_writes_one_generic_edit_row() -> None:
    bridge, human, _ = _bridge()
    await CollaborationCore._handle_inbound_edit(bridge, _EDIT)  # type: ignore[arg-type]
    assert len(human.sent) == 1
    room, event_type, content, source = human.sent[0]
    assert room == "!room:test"
    assert event_type == MESSAGE_EDIT_EVENT_TYPE
    assert source == edit_source("sw_original", 7)
    edit = parse_edit(content)
    assert edit is not None
    assert edit.original_event_id == "sw_original"
    assert edit.new_body == "Decline"
    assert edit.revision == 7
    assert edit.author == "@alice:test"
    assert edit.room == "room-1"
    assert edit.timestamp == 1234


async def test_an_edit_of_an_unknown_post_is_ignored() -> None:
    bridge, human, _ = _bridge(target=None)
    await CollaborationCore._handle_inbound_edit(bridge, _EDIT)  # type: ignore[arg-type]
    assert human.sent == []


async def test_an_edit_in_a_channel_with_no_room_is_ignored() -> None:
    bridge, human, _ = _bridge()
    bridge._channel_to_room = {}
    await CollaborationCore._handle_inbound_edit(bridge, _EDIT)  # type: ignore[arg-type]
    assert human.sent == []


async def test_an_edit_by_someone_unknown_is_ignored_without_creating_them() -> None:
    bridge, human, _ = _bridge()
    bridge._human_actors = {}
    await CollaborationCore._handle_inbound_edit(bridge, _EDIT)  # type: ignore[arg-type]
    assert human.sent == []


async def test_an_edit_of_another_persons_message_is_ignored() -> None:
    bridge, human, _ = _bridge(
        target=_EditTarget(event_id="e", sender_id="@bob:test", room_id="room-1")
    )
    await CollaborationCore._handle_inbound_edit(bridge, _EDIT)  # type: ignore[arg-type]
    assert human.sent == []


async def test_an_edit_of_a_message_in_another_room_is_ignored() -> None:
    bridge, human, _ = _bridge(
        target=_EditTarget(event_id="e", sender_id="@alice:test", room_id="room-2")
    )
    await CollaborationCore._handle_inbound_edit(bridge, _EDIT)  # type: ignore[arg-type]
    assert human.sent == []


async def test_switch_trust_still_blocks_what_an_edit_says() -> None:
    """Otherwise editing a message would be the way around the check."""
    trust = _Trust(outcome="blocked")
    bridge, human, adapter = _bridge(trust=trust)
    await CollaborationCore._handle_inbound_edit(bridge, _EDIT)  # type: ignore[arg-type]
    assert trust.checked == ["Decline"]
    assert human.sent == []
    assert len(adapter.notices) == 1


async def test_a_blocked_edit_is_told_to_its_sender_alone() -> None:
    """Where the platform can reach one person, the room does not hear of it."""
    bridge, human, adapter = _bridge(trust=_Trust(outcome="blocked"))
    adapter.private_notice_delivery = "ephemeral"  # type: ignore[assignment]
    await CollaborationCore._handle_inbound_edit(bridge, _EDIT)  # type: ignore[arg-type]
    assert human.sent == []
    assert adapter.notices == []
    assert [user for user, _ in adapter.private] == [_EDIT.sender_id]


async def test_switch_trust_redacts_what_an_edit_says() -> None:
    bridge, human, _ = _bridge(trust=_Trust(outcome="redacted", redacted="[hidden]"))
    await CollaborationCore._handle_inbound_edit(bridge, _EDIT)  # type: ignore[arg-type]
    edit = parse_edit(human.sent[0][2])
    assert edit is not None and edit.new_body == "[hidden]"


async def test_the_target_is_found_on_real_postgres(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Sent on this bridge, in this channel, and a message rather than a command."""
    process = process_on(session_factory)
    room = await make_room(session_factory)
    alice = await make_person(session_factory, "alice")
    await add_member(session_factory, room, alice)
    agent, client = await make_agent(session_factory, "helper")
    await add_member(session_factory, room, client, agent=agent)
    said = await process.say(room, "@helper Approve", sender=alice)
    command = await process.command(room, "reset", "", sender=alice)
    async with tenant_session(session_factory, room.tenant_id) as session:
        bridge_row = CollaborationBridge(
            type="mattermost",
            display_name="sample",
            client_id=client.id,
            status="active",
        )
        session.add(bridge_row)
        await session.flush()
        bridge_id = bridge_row.id
        for event_id, post in ((said, "post-1"), (command, "post-2")):
            session.add(
                BridgeMessageMap(
                    bridge_id=bridge_id,
                    external_channel_id="chan-1",
                    transport_event_id=event_id,
                    external_post_id=post,
                )
            )
        await session.commit()
    bridge = SimpleNamespace(
        _bridge_id=bridge_id,
        _session_factory=lambda: tenant_session(session_factory, room.tenant_id),
        _bridge_message_map_store=BridgeMessageMapStore(),
    )

    async def find(**changes: Any) -> _EditTarget | None:
        return await CollaborationCore._find_edit_target(
            bridge,  # type: ignore[arg-type]
            _EDIT.model_copy(update=changes),
        )

    found = await find()
    assert found == _EditTarget(
        event_id=said, sender_id=alice.transport_user_id, room_id=room.id
    )
    assert await find(message_ref="post-unknown") is None
    assert await find(channel_id="chan-other") is None
    assert await find(message_ref="post-2") is None
