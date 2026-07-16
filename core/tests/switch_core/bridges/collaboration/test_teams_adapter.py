from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.models import InboundCommand, InboundMessage
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.teams.cards import (
    ADAPTIVE_CARD_CONTENT_TYPE,
    agent_message_card,
)


def _config() -> TeamsConnectionConfig:
    return TeamsConnectionConfig(
        app_id="app-123",
        app_password="secret",
        tenant_id="tenant-1",
        team_id="team-1",
        public_base_url="https://switch.example",
    )


def _adapter() -> TeamsAdapter:
    return TeamsAdapter(config=_config())


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeConnector:
    """Records connector calls and returns canned ids."""

    def __init__(self, *, raise_on_send: bool = False) -> None:
        self.threads: list[dict[str, Any]] = []
        self.sends: list[dict[str, Any]] = []
        self.updates: list[dict[str, Any]] = []
        self.deletes: list[dict[str, Any]] = []
        self._raise_on_send = raise_on_send

    async def create_channel_thread(
        self, *, service_url: str, channel_id: str, activity: dict[str, Any]
    ) -> tuple[str, str]:
        self.threads.append(
            {"service_url": service_url, "channel_id": channel_id, "activity": activity}
        )
        return f"{channel_id};messageid=ROOT1", "ROOT1"

    async def send_to_conversation(
        self, *, service_url: str, conversation_id: str, activity: dict[str, Any]
    ) -> str:
        if self._raise_on_send:
            raise RuntimeError("boom")
        self.sends.append(
            {
                "service_url": service_url,
                "conversation_id": conversation_id,
                "activity": activity,
            }
        )
        return "MSG1"

    async def update_activity(
        self,
        *,
        service_url: str,
        conversation_id: str,
        activity_id: str,
        activity: dict[str, Any],
    ) -> None:
        self.updates.append(
            {"conversation_id": conversation_id, "activity_id": activity_id}
        )

    async def delete_activity(
        self, *, service_url: str, conversation_id: str, activity_id: str
    ) -> None:
        self.deletes.append(
            {"conversation_id": conversation_id, "activity_id": activity_id}
        )


def _capture_messages(adapter: TeamsAdapter) -> list[InboundMessage]:
    captured: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        captured.append(msg)

    adapter._on_message = on_message
    return captured


def _capture_commands(adapter: TeamsAdapter) -> list[InboundCommand]:
    captured: list[InboundCommand] = []

    async def on_command(cmd: InboundCommand) -> None:
        captured.append(cmd)

    adapter._on_command = on_command
    return captured


# ── Channel resolution from activity ─────────────────────────────────────────


def test_channel_from_channel_activity_uses_channel_data_id() -> None:
    activity = {
        "conversation": {
            "id": "19:abc@thread.tacv2;messageid=100",
            "conversationType": "channel",
        },
        "channelData": {"channel": {"id": "19:abc@thread.tacv2"}},
    }
    channel_id, channel_type = TeamsAdapter._channel_from_activity(activity)
    assert channel_id == "19:abc@thread.tacv2"
    assert channel_type == "channel_public"


def test_channel_from_personal_activity_is_direct() -> None:
    activity = {"conversation": {"id": "a:1xyz", "conversationType": "personal"}}
    channel_id, channel_type = TeamsAdapter._channel_from_activity(activity)
    assert channel_id == "a:1xyz"
    assert channel_type == "direct"


def test_channel_from_group_chat_activity_is_group() -> None:
    activity = {
        "conversation": {"id": "19:grp@thread.v2", "conversationType": "groupChat"}
    }
    channel_id, channel_type = TeamsAdapter._channel_from_activity(activity)
    assert channel_id == "19:grp@thread.v2"
    assert channel_type == "group"


# ── Text cleaning + self-mention ─────────────────────────────────────────────


def test_clean_text_strips_mention_markup() -> None:
    assert TeamsAdapter._clean_text("<at>Switch Bot</at> hello there") == "hello there"


def test_self_mention_token_set_when_bot_mentioned() -> None:
    adapter = _adapter()
    activity = {
        "recipient": {"id": "28:app-123"},
        "entities": [
            {"type": "mention", "mentioned": {"id": "28:app-123"}},
        ],
    }
    assert adapter._self_mention_token(activity) == "28:app-123"


def test_self_mention_token_none_when_not_mentioned() -> None:
    adapter = _adapter()
    activity = {
        "recipient": {"id": "28:app-123"},
        "entities": [{"type": "mention", "mentioned": {"id": "29:someone"}}],
    }
    assert adapter._self_mention_token(activity) is None


# ── Inbound dispatch ─────────────────────────────────────────────────────────


def test_inbound_channel_message_top_level_has_no_root() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)

    activity = {
        "type": "message",
        "id": "100",
        "serviceUrl": "https://smba.example/amer/",
        "text": "<at>Switch</at> hello",
        "from": {"aadObjectId": "aad-1", "name": "Alice"},
        "conversation": {
            "id": "19:abc@thread.tacv2;messageid=100",
            "conversationType": "channel",
        },
        "channelData": {"channel": {"id": "19:abc@thread.tacv2"}},
    }
    _run(adapter._dispatch_activity(activity))

    assert len(captured) == 1
    msg = captured[0]
    assert msg.channel_id == "19:abc@thread.tacv2"
    assert msg.channel_type == "channel_public"
    assert msg.sender_id == "aad-1"
    assert msg.sender_name == "Alice"
    assert msg.content == "hello"
    assert msg.message_ref == "100"
    assert msg.root_id is None
    # serviceUrl + type are learned for later outbound use.
    assert adapter._service_url["19:abc@thread.tacv2"] == "https://smba.example/amer/"


def test_inbound_channel_reply_sets_root_id() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)

    activity = {
        "type": "message",
        "id": "200",
        "serviceUrl": "https://smba.example/amer/",
        "text": "a reply",
        "from": {"aadObjectId": "aad-2", "name": "Bob"},
        "conversation": {
            "id": "19:abc@thread.tacv2;messageid=100",
            "conversationType": "channel",
        },
        "channelData": {"channel": {"id": "19:abc@thread.tacv2"}},
    }
    _run(adapter._dispatch_activity(activity))

    assert captured[0].root_id == "100"
    assert captured[0].message_ref == "200"


def test_inbound_command_routes_to_on_command() -> None:
    adapter = _adapter()
    commands = _capture_commands(adapter)

    activity = {
        "type": "message",
        "id": "300",
        "serviceUrl": "https://smba.example/amer/",
        "text": "!reset worker",
        "from": {"aadObjectId": "aad-3", "name": "Carol"},
        "conversation": {"id": "a:1chat", "conversationType": "personal"},
    }
    _run(adapter._dispatch_activity(activity))

    assert len(commands) == 1
    assert commands[0].command == "reset"
    assert commands[0].args == "worker"
    assert commands[0].channel_type == "direct"


def test_inbound_duplicate_activity_is_ignored() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)

    activity = {
        "type": "message",
        "id": "400",
        "serviceUrl": "https://smba.example/amer/",
        "text": "hi",
        "from": {"aadObjectId": "aad-4", "name": "Dan"},
        "conversation": {"id": "a:1chat", "conversationType": "personal"},
    }
    _run(adapter._dispatch_activity(activity))
    _run(adapter._dispatch_activity(activity))

    assert len(captured) == 1


def test_conversation_update_bot_added_fires_app_joined() -> None:
    from switch_core.bridges.collaboration.models import InboundAppJoin

    adapter = _adapter()
    joins: list[InboundAppJoin] = []

    async def on_app_joined(join: InboundAppJoin) -> None:
        joins.append(join)

    adapter._on_app_joined = on_app_joined

    activity = {
        "type": "conversationUpdate",
        "serviceUrl": "https://smba.example/amer/",
        "recipient": {"id": "28:app-123"},
        "membersAdded": [{"id": "28:app-123"}],
        "conversation": {
            "id": "19:abc@thread.tacv2",
            "conversationType": "channel",
        },
        "channelData": {
            "channel": {"id": "19:abc@thread.tacv2"},
            "team": {"name": "Engineering"},
        },
    }
    _run(adapter._dispatch_activity(activity))

    assert len(joins) == 1
    assert joins[0].channel_id == "19:abc@thread.tacv2"
    assert joins[0].channel_name == "Engineering"


def test_conversation_update_user_added_fires_user_joined() -> None:
    from switch_core.bridges.collaboration.models import InboundUserJoin

    adapter = _adapter()
    joins: list[InboundUserJoin] = []

    async def on_user_joined(join: InboundUserJoin) -> None:
        joins.append(join)

    adapter._on_user_joined = on_user_joined

    activity = {
        "type": "conversationUpdate",
        "serviceUrl": "https://smba.example/amer/",
        "recipient": {"id": "28:app-123"},
        "membersAdded": [{"id": "29:user", "aadObjectId": "aad-9", "name": "Erin"}],
        "conversation": {
            "id": "19:abc@thread.tacv2",
            "conversationType": "channel",
        },
        "channelData": {"channel": {"id": "19:abc@thread.tacv2"}},
    }
    _run(adapter._dispatch_activity(activity))

    assert len(joins) == 1
    assert joins[0].external_user_id == "aad-9"
    assert joins[0].external_username == "Erin"


# ── Outbound send ────────────────────────────────────────────────────────────


def _wire_outbound(adapter: TeamsAdapter, connector: _FakeConnector) -> None:
    adapter._connector = connector  # type: ignore[assignment]
    adapter._default_service_url = "https://smba.example/amer/"


def test_send_channel_top_level_creates_thread_with_card() -> None:
    adapter = _adapter()
    fake = _FakeConnector()
    _wire_outbound(adapter, fake)
    adapter._channel_type["19:abc@thread.tacv2"] = "channel_public"

    ref = _run(adapter.send_message("19:abc@thread.tacv2", "worker", "hi there"))

    assert ref == "ROOT1"
    assert len(fake.threads) == 1
    activity = fake.threads[0]["activity"]
    assert activity["attachments"][0]["contentType"] == ADAPTIVE_CARD_CONTENT_TYPE
    # The sent message is tracked for later edit/delete.
    assert adapter._sent["ROOT1"][1] == "19:abc@thread.tacv2;messageid=ROOT1"


def test_send_channel_reply_targets_thread_conversation() -> None:
    adapter = _adapter()
    fake = _FakeConnector()
    _wire_outbound(adapter, fake)
    adapter._channel_type["19:abc@thread.tacv2"] = "channel_public"

    ref = _run(
        adapter.send_message(
            "19:abc@thread.tacv2", "worker", "a reply", thread_root_id="100"
        )
    )

    assert ref == "MSG1"
    assert len(fake.sends) == 1
    assert fake.sends[0]["conversation_id"] == "19:abc@thread.tacv2;messageid=100"


def test_send_to_chat_is_flat() -> None:
    adapter = _adapter()
    fake = _FakeConnector()
    _wire_outbound(adapter, fake)
    adapter._channel_type["a:1chat"] = "direct"

    _run(adapter.send_message("a:1chat", "worker", "hello"))

    assert fake.threads == []
    assert len(fake.sends) == 1
    assert fake.sends[0]["conversation_id"] == "a:1chat"


def test_admin_message_is_plain_text_no_card() -> None:
    adapter = _adapter()
    fake = _FakeConnector()
    _wire_outbound(adapter, fake)
    adapter._channel_type["a:1chat"] = "direct"

    _run(adapter.admin_message("a:1chat", "system notice"))

    assert len(fake.sends) == 1
    activity = fake.sends[0]["activity"]
    assert activity["text"] == "system notice"
    assert "attachments" not in activity


def test_send_without_known_service_url_raises() -> None:
    adapter = _adapter()
    fake = _FakeConnector()
    adapter._connector = fake  # type: ignore[assignment]
    # No default service url learned yet.
    try:
        _run(adapter.send_message("19:abc@thread.tacv2", "worker", "hi"))
        raised = False
    except RuntimeError:
        raised = True
    assert raised


# ── Edit / delete ────────────────────────────────────────────────────────────


def test_delete_uses_tracked_conversation() -> None:
    adapter = _adapter()
    fake = _FakeConnector()
    _wire_outbound(adapter, fake)
    adapter._sent["MSG1"] = ("https://smba.example/amer/", "conv-xyz")

    _run(adapter.delete_message("19:abc@thread.tacv2", "MSG1"))

    assert fake.deletes == [{"conversation_id": "conv-xyz", "activity_id": "MSG1"}]
    assert "MSG1" not in adapter._sent


def test_update_reconstructs_conversation_when_untracked() -> None:
    adapter = _adapter()
    fake = _FakeConnector()
    _wire_outbound(adapter, fake)

    _run(adapter.update_message("19:abc@thread.tacv2", "OLD", "new text"))

    assert fake.updates == [
        {
            "conversation_id": "19:abc@thread.tacv2;messageid=OLD",
            "activity_id": "OLD",
        }
    ]


# ── Typing (best-effort) ─────────────────────────────────────────────────────


def test_typing_failure_is_swallowed() -> None:
    adapter = _adapter()
    fake = _FakeConnector(raise_on_send=True)
    _wire_outbound(adapter, fake)

    # Must not raise even though the connector errors.
    _run(adapter.send_typing("a:1chat", "worker", True))


def test_typing_false_is_noop() -> None:
    adapter = _adapter()
    fake = _FakeConnector()
    _wire_outbound(adapter, fake)

    _run(adapter.send_typing("a:1chat", "worker", False))

    assert fake.sends == []


# ── Adaptive card ────────────────────────────────────────────────────────────


def test_agent_card_carries_name_and_body() -> None:
    card = agent_message_card("worker", "the message body")
    # Name appears in the header column; body appears as its own TextBlock.
    header = card["body"][0]["columns"][1]["items"][0]
    assert header["text"] == "worker"
    assert card["body"][1]["text"] == "the message body"


# ── Runtime state ────────────────────────────────────────────────────────────


class _CountingConnector:
    """Connector fake that returns a distinct id per posted message."""

    def __init__(self) -> None:
        self.threads: list[dict[str, Any]] = []
        self.sends: list[dict[str, Any]] = []
        self.updates: list[dict[str, Any]] = []
        self.deletes: list[str] = []
        self._n = 0

    def _next(self) -> str:
        self._n += 1
        return f"M{self._n}"

    async def create_channel_thread(
        self, *, service_url: str, channel_id: str, activity: dict[str, Any]
    ) -> tuple[str, str]:
        self.threads.append(activity)
        mid = self._next()
        return f"{channel_id};messageid={mid}", mid

    async def send_to_conversation(
        self, *, service_url: str, conversation_id: str, activity: dict[str, Any]
    ) -> str:
        self.sends.append({"conversation_id": conversation_id, "activity": activity})
        return self._next()

    async def update_activity(
        self,
        *,
        service_url: str,
        conversation_id: str,
        activity_id: str,
        activity: dict[str, Any],
    ) -> None:
        self.updates.append({"activity_id": activity_id, "activity": activity})

    async def delete_activity(
        self, *, service_url: str, conversation_id: str, activity_id: str
    ) -> None:
        self.deletes.append(activity_id)


def _wire_counting(adapter: TeamsAdapter, connector: _CountingConnector) -> None:
    adapter._connector = connector  # type: ignore[assignment]
    adapter._default_service_url = "https://smba.example/amer/"
    adapter._channel_type["19:abc@thread.tacv2"] = "channel_public"


def test_working_posts_status_card() -> None:
    adapter = _adapter()
    fake = _CountingConnector()
    _wire_counting(adapter, fake)

    _run(
        adapter.apply_runtime_state(
            "19:abc@thread.tacv2",
            "worker",
            "working",
            notify_user=None,
            thread_root_id=None,
        )
    )

    assert len(fake.threads) == 1
    assert adapter._working_msg[("19:abc@thread.tacv2", "worker")] == "M1"


def test_working_detail_refreshes_in_place() -> None:
    adapter = _adapter()
    fake = _CountingConnector()
    _wire_counting(adapter, fake)

    _run(
        adapter.apply_runtime_state(
            "19:abc@thread.tacv2",
            "worker",
            "working",
            notify_user=None,
            thread_root_id=None,
        )
    )
    _run(
        adapter.apply_runtime_state(
            "19:abc@thread.tacv2",
            "worker",
            "working",
            notify_user=None,
            thread_root_id=None,
            detail="Editing adapter.py",
        )
    )

    # One post, one in-place edit; the tracked ref is unchanged.
    assert len(fake.threads) == 1
    assert len(fake.updates) == 1
    assert fake.updates[0]["activity_id"] == "M1"
    assert adapter._working_msg[("19:abc@thread.tacv2", "worker")] == "M1"


def test_idle_clears_working_message() -> None:
    adapter = _adapter()
    fake = _CountingConnector()
    _wire_counting(adapter, fake)

    _run(
        adapter.apply_runtime_state(
            "19:abc@thread.tacv2",
            "worker",
            "working",
            notify_user=None,
            thread_root_id=None,
        )
    )
    _run(
        adapter.apply_runtime_state(
            "19:abc@thread.tacv2",
            "worker",
            "idle",
            notify_user=None,
            thread_root_id=None,
        )
    )

    assert fake.deletes == ["M1"]
    assert ("19:abc@thread.tacv2", "worker") not in adapter._working_msg


def test_awaiting_input_keeps_working_and_pings() -> None:
    adapter = _adapter()
    fake = _CountingConnector()
    _wire_counting(adapter, fake)
    key = ("19:abc@thread.tacv2", "worker")

    _run(
        adapter.apply_runtime_state(
            "19:abc@thread.tacv2",
            "worker",
            "working",
            notify_user=None,
            thread_root_id=None,
        )
    )
    _run(
        adapter.apply_runtime_state(
            "19:abc@thread.tacv2",
            "worker",
            "awaiting-input",
            notify_user="louis",
            thread_root_id=None,
        )
    )

    # Working indicator stays up; a ping is tracked separately.
    assert adapter._working_msg[key] == "M1"
    assert adapter._input_pings[key] == ["M2"]

    _run(
        adapter.apply_runtime_state(
            "19:abc@thread.tacv2",
            "worker",
            "idle",
            notify_user=None,
            thread_root_id=None,
        )
    )
    # Both the working message and the ping are removed on idle.
    assert set(fake.deletes) == {"M1", "M2"}
    assert key not in adapter._working_msg
    assert key not in adapter._input_pings
