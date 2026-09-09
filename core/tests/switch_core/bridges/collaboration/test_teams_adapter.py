from __future__ import annotations

import asyncio
from typing import Any

from switch_core.agent_icon import default_icon_url
from switch_core.bridges.collaboration.adapter import AgentPresentation, AgentRendering
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
        client_state="s3cr3t",
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


def test_clean_text_renders_mention_markup() -> None:
    # The mention display text is kept as an `@name` token (not deleted) so the
    # addressing layer can still see it downstream.
    assert (
        TeamsAdapter._clean_text("<at>Switch Bot</at> hello there")
        == "@Switch Bot hello there"
    )


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


def test_inbound_bot_mention_carries_self_mention_token() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)

    activity = {
        "type": "message",
        "id": "300",
        "serviceUrl": "https://smba.example/amer/",
        "text": "<at>Switch Bot</at> please help",
        "from": {"aadObjectId": "aad-1", "name": "Alice"},
        "recipient": {"id": "28:app-123"},
        "entities": [{"type": "mention", "mentioned": {"id": "28:app-123"}}],
        "conversation": {
            "id": "19:abc@thread.tacv2;messageid=300",
            "conversationType": "channel",
        },
        "channelData": {"channel": {"id": "19:abc@thread.tacv2"}},
    }
    _run(adapter._dispatch_activity(activity))

    assert len(captured) == 1
    assert captured[0].content == "@Switch Bot please help"
    assert captured[0].self_mention_token == "28:app-123"


# ── Inbound dispatch ─────────────────────────────────────────────────────────


def test_inbound_attachment_is_disclosed_not_dropped() -> None:
    # Inbound file/image relay is not implemented yet; the message text must
    # still bridge and the dropped attachment must be disclosed (fail-loud), and
    # the text/html body attachment must NOT be counted as a dropped file.
    adapter = _adapter()
    captured = _capture_messages(adapter)

    activity = {
        "type": "message",
        "id": "att-1",
        "serviceUrl": "https://smba.example/amer/",
        "text": "look at this",
        "from": {"aadObjectId": "aad-1", "name": "Alice"},
        "conversation": {
            "id": "19:abc@thread.tacv2;messageid=att-1",
            "conversationType": "channel",
        },
        "channelData": {"channel": {"id": "19:abc@thread.tacv2"}},
        "attachments": [
            {"contentType": "text/html", "content": "<p>look at this</p>"},
            {"contentType": "image/png", "name": "diagram.png"},
        ],
    }
    _run(adapter._dispatch_activity(activity))

    assert len(captured) == 1
    content = captured[0].content
    assert content.startswith("look at this")
    assert "diagram.png" in content
    assert "not relayed" in content


class _FakeHttpRequest:
    def __init__(
        self,
        *,
        headers: dict[str, str] | None = None,
        body: Any = None,
        json_error: bool = False,
    ) -> None:
        self.headers = headers or {}
        self._body = body
        self._json_error = json_error
        self.query: dict[str, str] = {}

    async def json(self) -> Any:
        if self._json_error:
            raise ValueError("bad json")
        return self._body


class _RaisingValidator:
    def validate(self, auth_header: str | None) -> None:
        raise PermissionError("forged")


class _PassValidator:
    def validate(self, auth_header: str | None) -> None:
        return None


def test_http_messages_rejects_unauthenticated_activity() -> None:
    adapter = _adapter()
    adapter._validator = _RaisingValidator()  # type: ignore[assignment]

    resp = _run(
        adapter._handle_http_messages(
            _FakeHttpRequest(  # type: ignore[arg-type]
                headers={"Authorization": "Bearer forged"},
                body={"type": "message"},
            )
        )
    )

    assert resp.status == 401


def test_http_messages_rejects_invalid_json() -> None:
    adapter = _adapter()
    adapter._validator = _PassValidator()  # type: ignore[assignment]

    resp = _run(
        adapter._handle_http_messages(
            _FakeHttpRequest(  # type: ignore[arg-type]
                headers={"Authorization": "Bearer ok"}, json_error=True
            )
        )
    )

    assert resp.status == 400


def test_http_messages_dispatches_authenticated_activity() -> None:
    adapter = _adapter()
    adapter._validator = _PassValidator()  # type: ignore[assignment]
    captured = _capture_messages(adapter)

    activity = {
        "type": "message",
        "id": "ok-1",
        "serviceUrl": "https://smba.example/amer/",
        "text": "hi",
        "from": {"aadObjectId": "aad-1", "name": "Alice"},
        "conversation": {
            "id": "19:abc@thread.tacv2;messageid=ok-1",
            "conversationType": "channel",
        },
        "channelData": {"channel": {"id": "19:abc@thread.tacv2"}},
    }
    resp = _run(
        adapter._handle_http_messages(
            _FakeHttpRequest(  # type: ignore[arg-type]
                headers={"Authorization": "Bearer ok"}, body=activity
            )
        )
    )

    assert resp.status == 200
    assert len(captured) == 1
    assert captured[0].content == "hi"


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
    assert msg.content == "@Switch hello"
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


def test_inbound_channel_learns_team_group_guid() -> None:
    # Graph channel subscriptions require the team's AAD group GUID; the adapter
    # must learn it from channelData.team.aadGroupId, not the non-GUID thread id.
    adapter = _adapter()
    _capture_messages(adapter)
    activity = {
        "type": "message",
        "id": "500",
        "serviceUrl": "https://smba.example/amer/",
        "text": "<at>Switch</at> hi",
        "from": {"aadObjectId": "aad-1", "name": "Alice"},
        "conversation": {
            "id": "19:chan@thread.tacv2;messageid=500",
            "conversationType": "channel",
        },
        "channelData": {
            "channel": {"id": "19:chan@thread.tacv2"},
            "team": {
                "id": "19:team@thread.tacv2",
                "aadGroupId": "40013d55-9d89-4e09-b993-4c56dbe8269f",
            },
        },
    }
    _run(adapter._dispatch_activity(activity))
    assert (
        adapter._team_of_channel["19:chan@thread.tacv2"]
        == "40013d55-9d89-4e09-b993-4c56dbe8269f"
    )


def test_inbound_channel_without_aad_group_falls_back_to_config_team_id() -> None:
    # No aadGroupId in the payload -> use the configured team_id (also a GUID),
    # never the non-GUID team thread id.
    adapter = _adapter()  # config team_id == "team-1"
    _capture_messages(adapter)
    activity = {
        "type": "message",
        "id": "501",
        "serviceUrl": "https://smba.example/amer/",
        "text": "hi",
        "from": {"aadObjectId": "aad-1", "name": "Alice"},
        "conversation": {
            "id": "19:chan2@thread.tacv2",
            "conversationType": "channel",
        },
        "channelData": {
            "channel": {"id": "19:chan2@thread.tacv2"},
            "team": {"id": "19:team@thread.tacv2"},
        },
    }
    _run(adapter._dispatch_activity(activity))
    assert adapter._team_of_channel["19:chan2@thread.tacv2"] == "team-1"


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


def test_inbound_channel_command_after_bot_mention_routes_to_on_command() -> None:
    # In a Teams channel the Bot Framework only delivers messages that @mention
    # the bot, so a channel command always arrives as "@Bot !cmd". The leading
    # bot mention must not hide the "!" command marker.
    adapter = _adapter()
    commands = _capture_commands(adapter)
    messages = _capture_messages(adapter)

    activity = {
        "type": "message",
        "id": "301",
        "serviceUrl": "https://smba.example/amer/",
        "text": "<at>Switch Bot</at> !reset worker",
        "from": {"aadObjectId": "aad-1", "name": "Alice"},
        "recipient": {"id": "28:app-123"},
        "entities": [{"type": "mention", "mentioned": {"id": "28:app-123"}}],
        "conversation": {
            "id": "19:abc@thread.tacv2;messageid=301",
            "conversationType": "channel",
        },
        "channelData": {"channel": {"id": "19:abc@thread.tacv2"}},
    }
    _run(adapter._dispatch_activity(activity))

    assert len(commands) == 1
    assert commands[0].command == "reset"
    assert commands[0].args == "worker"
    assert commands[0].channel_type == "channel_public"
    # The command must not also be bridged as a normal message.
    assert messages == []


def test_graph_channel_command_after_bot_mention_routes_to_on_command() -> None:
    # Same rule on the Graph capture path: strip the bot's leading <at> mention
    # (here wrapped in a <p>) before detecting the "!" command.
    adapter = _adapter()
    commands = _capture_commands(adapter)

    chat_message = {
        "id": "700",
        "messageType": "message",
        "from": {"user": {"id": "user-1", "displayName": "Dave"}},
        "channelIdentity": {"channelId": "19:abc@thread.tacv2"},
        "body": {
            "contentType": "html",
            "content": '<p><at id="0">Switch Bot</at> !help now</p>',
        },
        "mentions": [{"id": 0, "mentioned": {"application": {"id": "app-123"}}}],
    }
    _run(adapter._deliver_graph_message(chat_message))

    assert len(commands) == 1
    assert commands[0].command == "help"
    assert commands[0].args == "now"


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


def test_send_to_chat_with_thread_root_stays_flat() -> None:
    # Flat chats (1:1/group) have no channel-style threading: appending
    # ";messageid=" yields a conversation id Teams cannot decrypt (403), so a
    # thread root must be ignored for a flat chat.
    adapter = _adapter()
    fake = _FakeConnector()
    _wire_outbound(adapter, fake)
    adapter._channel_type["a:1chat"] = "direct"

    _run(adapter.send_message("a:1chat", "worker", "hi", thread_root_id="500"))

    assert len(fake.sends) == 1
    assert fake.sends[0]["conversation_id"] == "a:1chat"


def test_admin_message_to_chat_with_thread_root_stays_flat() -> None:
    # Same invariant for admin/system messages: a no-agents notice threaded under
    # the triggering message in a 1:1 chat must not become "a:1chat;messageid=…".
    adapter = _adapter()
    fake = _FakeConnector()
    _wire_outbound(adapter, fake)
    adapter._channel_type["a:1chat"] = "direct"

    _run(adapter.admin_message("a:1chat", "system notice", thread_root_id="500"))

    assert len(fake.sends) == 1
    assert fake.sends[0]["conversation_id"] == "a:1chat"


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


def test_configured_service_url_seeds_outbound_after_restart() -> None:
    # A serviceUrl persisted in config must let outbound work immediately, before
    # any inbound activity is received (the post-restart case).
    config = _config()
    config.service_url = "https://smba.example/amer/"
    adapter = TeamsAdapter(config=config)
    fake = _FakeConnector()
    adapter._connector = fake  # type: ignore[assignment]

    _run(adapter.send_message("19:abc@thread.tacv2", "worker", "hi"))

    assert fake.threads[0]["service_url"] == "https://smba.example/amer/"


def test_learned_service_url_is_persisted_once_per_change() -> None:
    # A newly-learned serviceUrl is persisted so it survives a restart; an
    # unchanged one is not re-persisted on every subsequent activity.
    adapter = _adapter()
    _capture_messages(adapter)
    persisted: list[str] = []

    async def _persist(url: str) -> None:
        persisted.append(url)

    adapter.set_service_url_persister(_persist)

    def _activity(msg_id: str, service_url: str) -> dict[str, Any]:
        return {
            "type": "message",
            "id": msg_id,
            "serviceUrl": service_url,
            "text": "hi",
            "from": {"aadObjectId": "aad-1", "name": "Alice"},
            "conversation": {
                "id": "19:abc@thread.tacv2;messageid=" + msg_id,
                "conversationType": "channel",
            },
            "channelData": {"channel": {"id": "19:abc@thread.tacv2"}},
        }

    _run(adapter._dispatch_activity(_activity("1", "https://smba.example/amer/")))
    _run(adapter._dispatch_activity(_activity("2", "https://smba.example/amer/")))
    _run(adapter._dispatch_activity(_activity("3", "https://smba.example/emea/")))

    assert persisted == ["https://smba.example/amer/", "https://smba.example/emea/"]
    assert adapter._default_service_url == "https://smba.example/emea/"


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


class _RecordThenRaiseConnector(_FakeConnector):
    """Records the attempted activity, then raises — so a test can assert the
    call was really attempted before its failure was swallowed."""

    async def send_to_conversation(
        self, *, service_url: str, conversation_id: str, activity: dict[str, Any]
    ) -> str:
        self.sends.append(
            {
                "service_url": service_url,
                "conversation_id": conversation_id,
                "activity": activity,
            }
        )
        raise RuntimeError("boom")


def test_typing_failure_is_swallowed() -> None:
    adapter = _adapter()
    fake = _RecordThenRaiseConnector()
    _wire_outbound(adapter, fake)

    # Must not raise even though the connector errors...
    _run(adapter.send_typing("a:1chat", "worker", True))

    # ...and the typing activity WAS attempted (not silently skipped).
    assert len(fake.sends) == 1
    assert fake.sends[0]["activity"]["type"] == "typing"


def test_typing_false_is_noop() -> None:
    adapter = _adapter()
    fake = _FakeConnector()
    _wire_outbound(adapter, fake)

    _run(adapter.send_typing("a:1chat", "worker", False))

    assert fake.sends == []


# ── Adaptive card ────────────────────────────────────────────────────────────


def _rendering(label: str, icon_url: str) -> AgentRendering:
    return AgentRendering(field_label=label, body_label=label, icon_url=icon_url)


def test_agent_card_carries_name_and_body() -> None:
    card = agent_message_card(
        _rendering("worker", "https://example.com/i.png"), "the message body", []
    )
    # Name appears in the header column; body appears as its own TextBlock.
    header = card["body"][0]["columns"][1]["items"][0]
    assert header["text"] == "worker"
    assert card["body"][1]["text"] == "the message body"


def test_agent_card_renders_the_supplied_icon() -> None:
    card = agent_message_card(
        _rendering("worker", "https://example.com/custom.png"), "body", []
    )
    image = card["body"][0]["columns"][0]["items"][0]
    assert image["url"] == "https://example.com/custom.png"


async def test_message_activity_carries_notification_summary_and_fallback() -> None:
    # Without a plain-text summary on the activity and a fallbackText on the card,
    # Teams renders a "cards.unsupported" placeholder in notifications, mobile, and
    # link/search previews.
    adapter = _adapter()
    activity = await adapter._message_activity("worker", "hello world")
    assert activity["summary"] == "worker: hello world"
    assert (
        activity["attachments"][0]["content"]["fallbackText"] == "worker: hello world"
    )


async def test_message_activity_uses_the_agents_own_icon_when_it_has_one() -> None:
    adapter = _adapter()

    async def _resolver(agent_name: str) -> AgentPresentation | None:
        icon = "https://example.com/worker.png" if agent_name == "worker" else None
        return AgentPresentation(display_name=None, icon_url=icon)

    adapter.set_agent_presentation_resolver(_resolver)
    activity = await adapter._message_activity("worker", "hello")

    image = activity["attachments"][0]["content"]["body"][0]["columns"][0]["items"][0]
    assert image["url"] == "https://example.com/worker.png"


async def test_message_activity_falls_back_to_the_default_icon() -> None:
    adapter = _adapter()

    async def _resolver(agent_name: str) -> AgentPresentation | None:
        return AgentPresentation(display_name=None, icon_url=None)

    adapter.set_agent_presentation_resolver(_resolver)
    activity = await adapter._message_activity("worker", "hello")

    image = activity["attachments"][0]["content"]["body"][0]["columns"][0]["items"][0]
    assert image["url"] == default_icon_url("worker")


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


def _card_text(activity: dict[str, Any]) -> str:
    """The body an agent card carries, whatever its shape."""
    card = activity["attachments"][0]["content"]
    return "\n".join(str(block.get("text", "")) for block in card["body"])


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
            mention_handle=None,
            thread_root_id=None,
        )
    )

    assert len(fake.threads) == 1
    assert adapter._working_msg[("19:abc@thread.tacv2", "worker")].message_ref == "M1"


def test_working_detail_refreshes_in_place() -> None:
    adapter = _adapter()
    fake = _CountingConnector()
    _wire_counting(adapter, fake)

    _run(
        adapter.apply_runtime_state(
            "19:abc@thread.tacv2",
            "worker",
            "working",
            mention_handle=None,
            thread_root_id=None,
        )
    )
    _run(
        adapter.apply_runtime_state(
            "19:abc@thread.tacv2",
            "worker",
            "working",
            mention_handle=None,
            thread_root_id=None,
            detail="Editing adapter.py",
        )
    )

    # One post, one in-place edit; the tracked ref is unchanged.
    assert len(fake.threads) == 1
    assert len(fake.updates) == 1
    assert fake.updates[0]["activity_id"] == "M1"
    assert adapter._working_msg[("19:abc@thread.tacv2", "worker")].message_ref == "M1"


def test_idle_retires_the_working_message_by_editing_it() -> None:
    adapter = _adapter()
    fake = _CountingConnector()
    _wire_counting(adapter, fake)

    _run(
        adapter.apply_runtime_state(
            "19:abc@thread.tacv2",
            "worker",
            "working",
            mention_handle=None,
            thread_root_id=None,
        )
    )
    _run(
        adapter.apply_runtime_state(
            "19:abc@thread.tacv2",
            "worker",
            "idle",
            mention_handle=None,
            thread_root_id=None,
        )
    )

    # A posts channel: Teams substitutes "This message has been deleted." for
    # anything removed and keeps it in the post, so the status is edited into a
    # terminal marker instead of being deleted.
    assert fake.deletes == []
    assert [u["activity_id"] for u in fake.updates] == ["M1"]
    assert "Done" in _card_text(fake.updates[-1]["activity"])
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
            mention_handle=None,
            thread_root_id=None,
        )
    )
    _run(
        adapter.apply_runtime_state(
            "19:abc@thread.tacv2",
            "worker",
            "awaiting-input",
            mention_handle="louis",
            thread_root_id=None,
        )
    )

    # Working indicator stays up; a ping is tracked separately.
    assert adapter._working_msg[key].message_ref == "M1"
    assert adapter._input_pings[key] == ["M2"]

    _run(
        adapter.apply_runtime_state(
            "19:abc@thread.tacv2",
            "worker",
            "idle",
            mention_handle=None,
            thread_root_id=None,
        )
    )
    # Both are retired on idle — edited, not deleted, in a posts channel.
    assert fake.deletes == []
    assert {u["activity_id"] for u in fake.updates} == {"M1", "M2"}
    assert key not in adapter._working_msg
    assert key not in adapter._input_pings
