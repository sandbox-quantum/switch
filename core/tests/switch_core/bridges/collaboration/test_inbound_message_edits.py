from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import discord
import pytest

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import InboundMessageEdit
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)
from switch_core.clients.actor import Actor
from switch_core.db.models import Message
from switch_core.db.stores.message_store import MessageStore
from switch_core.transport.room_cache import RoomDeliveryCache


class TestCollaborationCoreInboundEdits:
    @pytest.mark.asyncio
    async def test_inbound_edit_updates_message_when_mapped(self) -> None:
        core = object.__new__(CollaborationCore)
        core._channel_to_room = {"C123": ("room_1", "!room:switch.local")}
        core._event_for_external_post = AsyncMock(return_value="$evt_1")
        core._repair_placeholder_username = AsyncMock()

        human_actor = MagicMock()
        human_actor.edit_message = AsyncMock(return_value=True)
        core._ensure_human_in_room = AsyncMock(return_value=human_actor)

        core._adapter = MagicMock()
        core._adapter.translate_inbound = lambda text: text
        core._trust_client = None

        edit = InboundMessageEdit(
            channel_id="C123",
            channel_type="channel_public",
            sender_id="U456",
            sender_name="alice",
            content="clarified prompt",
            message_ref="C123:1234.56",
        )

        await core._handle_inbound_edit(edit)

        human_actor.edit_message.assert_awaited_once_with(
            "!room:switch.local",
            "$evt_1",
            "clarified prompt",
            format="markdown",
        )

    @pytest.mark.asyncio
    async def test_inbound_edit_prepends_mention_target_if_missing(self) -> None:
        core = object.__new__(CollaborationCore)
        core._channel_to_room = {"C123": ("room_1", "!room:switch.local")}
        core._event_for_external_post = AsyncMock(return_value="$evt_1")
        core._repair_placeholder_username = AsyncMock()
        core._resolve_self_mention_target = AsyncMock(return_value="agent_bot")

        human_actor = MagicMock()
        human_actor.edit_message = AsyncMock(return_value=True)
        core._ensure_human_in_room = AsyncMock(return_value=human_actor)

        core._adapter = MagicMock()
        core._adapter.translate_inbound = lambda text: text
        core._trust_client = None

        edit = InboundMessageEdit(
            channel_id="C123",
            channel_type="channel_public",
            sender_id="U456",
            sender_name="alice",
            content="do something else",
            message_ref="C123:1234.56",
            self_mention_token="BOT123",
        )

        await core._handle_inbound_edit(edit)

        human_actor.edit_message.assert_awaited_once_with(
            "!room:switch.local",
            "$evt_1",
            "@agent_bot do something else",
            format="markdown",
        )

    @pytest.mark.asyncio
    async def test_inbound_edit_leaves_mention_target_if_present(self) -> None:
        core = object.__new__(CollaborationCore)
        core._channel_to_room = {"C123": ("room_1", "!room:switch.local")}
        core._event_for_external_post = AsyncMock(return_value="$evt_1")
        core._repair_placeholder_username = AsyncMock()
        core._resolve_self_mention_target = AsyncMock(return_value="agent_bot")

        human_actor = MagicMock()
        human_actor.edit_message = AsyncMock(return_value=True)
        core._ensure_human_in_room = AsyncMock(return_value=human_actor)

        core._adapter = MagicMock()
        core._adapter.translate_inbound = lambda text: text
        core._trust_client = None

        edit = InboundMessageEdit(
            channel_id="C123",
            channel_type="channel_public",
            sender_id="U456",
            sender_name="alice",
            content="@agent_bot already mentioned",
            message_ref="C123:1234.56",
            self_mention_token="BOT123",
        )

        await core._handle_inbound_edit(edit)

        human_actor.edit_message.assert_awaited_once_with(
            "!room:switch.local",
            "$evt_1",
            "@agent_bot already mentioned",
            format="markdown",
        )

    @pytest.mark.asyncio
    async def test_inbound_edit_drops_if_unmapped_channel(self) -> None:
        core = object.__new__(CollaborationCore)
        core._channel_to_room = {}

        human_actor = MagicMock()
        human_actor.edit_message = AsyncMock()
        core._ensure_human_in_room = AsyncMock(return_value=human_actor)

        edit = InboundMessageEdit(
            channel_id="UNKNOWN",
            channel_type="channel_public",
            sender_id="U456",
            sender_name="alice",
            content="edit",
            message_ref="UNKNOWN:1",
        )

        await core._handle_inbound_edit(edit)
        human_actor.edit_message.assert_not_called()

    @pytest.mark.asyncio
    async def test_inbound_edit_drops_if_unmapped_external_post(self) -> None:
        core = object.__new__(CollaborationCore)
        core._channel_to_room = {"C123": ("room_1", "!room:switch.local")}
        core._event_for_external_post = AsyncMock(return_value=None)

        human_actor = MagicMock()
        human_actor.edit_message = AsyncMock()
        core._ensure_human_in_room = AsyncMock(return_value=human_actor)

        edit = InboundMessageEdit(
            channel_id="C123",
            channel_type="channel_public",
            sender_id="U456",
            sender_name="alice",
            content="edit",
            message_ref="C123:1",
        )

        await core._handle_inbound_edit(edit)
        human_actor.edit_message.assert_not_called()


class TestSlackAdapterInboundEdit:
    @pytest.mark.asyncio
    async def test_slack_message_changed_event_dispatches_edit(self) -> None:
        adapter = SlackAdapter(
            config=SlackConnectionConfig(
                bot_token="xoxb-test",
                app_token="xapp-test",
                workspace_id="T123",
            )
        )
        adapter.set_tenant_id("tenant_1")
        adapter._bot_user_id = "BOT_USER"
        adapter._channel_name_cache["C123"] = "general"

        captured: list[InboundMessageEdit] = []

        async def on_edit(edit: InboundMessageEdit) -> None:
            captured.append(edit)

        adapter.set_edit_handler(on_edit)

        event: dict[str, object] = {
            "channel": "C123",
            "subtype": "message_changed",
            "channel_type": "channel",
            "message": {
                "user": "U456",
                "ts": "1234.56",
                "text": "new slack text",
            },
        }

        await adapter._handle_message_changed_event(event)

        assert len(captured) == 1
        assert captured[0].channel_id == "C123"
        assert captured[0].sender_id == "U456"
        assert captured[0].content == "new slack text"
        assert captured[0].message_ref == "C123:1234.56"

    @pytest.mark.asyncio
    async def test_slack_message_changed_ignores_own_bot(self) -> None:
        adapter = SlackAdapter(
            config=SlackConnectionConfig(
                bot_token="xoxb-test",
                app_token="xapp-test",
                workspace_id="T123",
            )
        )
        adapter._bot_user_id = "BOT_USER"

        captured: list[InboundMessageEdit] = []

        async def on_edit(edit: InboundMessageEdit) -> None:
            captured.append(edit)

        adapter.set_edit_handler(on_edit)

        event: dict[str, object] = {
            "channel": "C123",
            "subtype": "message_changed",
            "message": {
                "user": "BOT_USER",
                "ts": "1234.56",
                "text": "bot text",
            },
        }

        await adapter._handle_message_changed_event(event)
        assert len(captured) == 0


class TestMattermostAdapterInboundEdit:
    @pytest.mark.asyncio
    async def test_mattermost_post_edited_dispatches_edit(self) -> None:
        adapter = MattermostAdapter(
            config=MattermostConnectionConfig(
                url="http://mm.example:8065",
                admin_user="admin",
                admin_password="password",
                team_name="team1",
            )
        )
        captured: list[InboundMessageEdit] = []

        async def on_edit(edit: InboundMessageEdit) -> None:
            captured.append(edit)

        adapter.set_edit_handler(on_edit)
        adapter._main_loop = asyncio.get_running_loop()
        adapter._admin_driver = MagicMock()
        adapter._admin_driver.users.get_user = MagicMock(
            return_value={"username": "alice"}
        )

        post = {
            "id": "post_123",
            "channel_id": "ch_456",
            "user_id": "u_789",
            "message": "new mm message",
        }
        event = {
            "event": "post_edited",
            "data": {
                "post": json.dumps(post),
                "channel_type": "O",
                "channel_display_name": "town-square",
            },
        }

        await adapter._handle_post_edited(event)
        await asyncio.sleep(0.01)

        assert len(captured) == 1
        assert captured[0].channel_id == "ch_456"
        assert captured[0].sender_id == "u_789"
        assert captured[0].sender_name == "alice"
        assert captured[0].content == "new mm message"
        assert captured[0].message_ref == "post_123"

    @pytest.mark.asyncio
    async def test_mattermost_post_edited_ignores_bridge_bot(self) -> None:
        adapter = MattermostAdapter(
            config=MattermostConnectionConfig(
                url="http://mm.example:8065",
                admin_user="admin",
                admin_password="password",
                team_name="team1",
            )
        )
        captured: list[InboundMessageEdit] = []
        adapter.set_edit_handler(lambda edit: captured.append(edit))  # type: ignore[arg-type]
        adapter._bridge_bot_ids = {"bot_1"}

        post = {
            "id": "post_123",
            "channel_id": "ch_456",
            "user_id": "bot_1",
            "message": "bot edit",
        }
        event = {
            "event": "post_edited",
            "data": {
                "post": json.dumps(post),
            },
        }

        await adapter._handle_post_edited(event)
        assert len(captured) == 0


class TestDiscordAdapterInboundEdit:
    @pytest.mark.asyncio
    async def test_discord_edit_dispatches_edit(self) -> None:
        adapter = DiscordAdapter(
            config=DiscordConnectionConfig(bot_token="token", guild_id="900")
        )
        adapter._connection._bot_user_id = 42

        captured: list[InboundMessageEdit] = []

        async def on_edit(edit: InboundMessageEdit) -> None:
            captured.append(edit)

        adapter.set_edit_handler(on_edit)

        author = SimpleNamespace(id=101, name="alice")
        channel = SimpleNamespace(
            id=202,
            parent_id=None,
            name="general",
            type=discord.ChannelType.text,
        )
        msg = SimpleNamespace(
            id=303,
            author=author,
            channel=channel,
            content="new discord text",
            webhook_id=None,
            type=discord.MessageType.default,
        )

        await adapter.dispatch_edit(msg)  # type: ignore[arg-type]

        assert len(captured) == 1
        assert captured[0].channel_id == "202"
        assert captured[0].sender_id == "101"
        assert captured[0].sender_name == "alice"
        assert captured[0].content == "new discord text"
        assert captured[0].message_ref == "202:303"

    @pytest.mark.asyncio
    async def test_discord_edit_ignores_bot_user(self) -> None:
        adapter = DiscordAdapter(
            config=DiscordConnectionConfig(bot_token="token", guild_id="900")
        )
        adapter._connection._bot_user_id = 42

        captured: list[InboundMessageEdit] = []
        adapter.set_edit_handler(lambda edit: captured.append(edit))  # type: ignore[arg-type]

        author = SimpleNamespace(id=42, name="bot")
        channel = SimpleNamespace(
            id=202,
            parent_id=None,
            name="general",
            type=discord.ChannelType.text,
        )
        msg = SimpleNamespace(
            id=303,
            author=author,
            channel=channel,
            content="bot edit",
            webhook_id=None,
            type=discord.MessageType.default,
        )

        await adapter.dispatch_edit(msg)  # type: ignore[arg-type]
        assert len(captured) == 0


class TestTelegramAdapterInboundEdit:
    @pytest.mark.asyncio
    async def test_telegram_edited_message_dispatches_edit(self) -> None:
        adapter = TelegramAdapter(
            config=TelegramConnectionConfig(
                bot_token="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
                bot_username="switch_bot",
            )
        )
        adapter._bot_user_id = 42

        captured: list[InboundMessageEdit] = []

        async def on_edit(edit: InboundMessageEdit) -> None:
            captured.append(edit)

        adapter.set_edit_handler(on_edit)

        author = SimpleNamespace(
            id=77,
            first_name="Bob",
            last_name="Smith",
            username="bobsmith",
        )
        chat = SimpleNamespace(
            id=-100123,
            type="supergroup",
            title="general chat",
            is_forum=False,
        )
        msg = SimpleNamespace(
            message_id=555,
            from_user=author,
            chat=chat,
            text="new telegram text",
            caption=None,
            message_thread_id=None,
        )

        await adapter._handle_edited_message(msg)

        assert len(captured) == 1
        assert captured[0].channel_id == "-100123"
        assert captured[0].sender_id == "77"
        assert captured[0].content == "new telegram text"
        assert captured[0].message_ref == "-100123:555"

    @pytest.mark.asyncio
    async def test_telegram_edited_message_ignores_bot(self) -> None:
        adapter = TelegramAdapter(
            config=TelegramConnectionConfig(
                bot_token="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
                bot_username="switch_bot",
            )
        )
        adapter._bot_user_id = 42

        captured: list[InboundMessageEdit] = []
        adapter.set_edit_handler(lambda edit: captured.append(edit))  # type: ignore[arg-type]

        author = SimpleNamespace(id=42, username="my_bot")
        chat = SimpleNamespace(id=-100123, type="supergroup", is_forum=False)
        msg = SimpleNamespace(
            message_id=555, from_user=author, chat=chat, text="bot text"
        )

        await adapter._handle_edited_message(msg)
        assert len(captured) == 0


class TestTeamsAdapterInboundEdit:
    @pytest.mark.asyncio
    async def test_teams_activity_message_update_dispatches_edit(self) -> None:
        adapter = TeamsAdapter(
            config=TeamsConnectionConfig(
                app_id="app-123",
                app_password="secret",
                tenant_id="tenant-1",
                team_id="team-1",
                public_base_url="https://switch.example",
                client_state="s3cr3t",
            )
        )
        captured: list[InboundMessageEdit] = []

        async def on_edit(edit: InboundMessageEdit) -> None:
            captured.append(edit)

        adapter.set_edit_handler(on_edit)

        activity: dict[str, Any] = {
            "id": "act_99",
            "text": "new teams text",
            "from": {"aadObjectId": "aad_user_1", "name": "Carol"},
            "conversation": {"id": "conv_ch1"},
        }

        await adapter._dispatch_message_update(activity, "conv_ch1", "channel_public")

        assert len(captured) == 1
        assert captured[0].channel_id == "conv_ch1"
        assert captured[0].sender_id == "aad_user_1"
        assert captured[0].content == "new teams text"
        assert captured[0].message_ref == "act_99"

    @pytest.mark.asyncio
    async def test_teams_graph_edit_dispatches_edit(self) -> None:
        adapter = TeamsAdapter(
            config=TeamsConnectionConfig(
                app_id="app-123",
                app_password="secret",
                tenant_id="tenant-1",
                team_id="team-1",
                public_base_url="https://switch.example",
                client_state="s3cr3t",
            )
        )
        captured: list[InboundMessageEdit] = []

        async def on_edit(edit: InboundMessageEdit) -> None:
            captured.append(edit)

        adapter.set_edit_handler(on_edit)

        chat_message: dict[str, Any] = {
            "id": "graph_msg_5",
            "messageType": "message",
            "from": {"user": {"id": "u_graph", "displayName": "Dave"}},
            "channelIdentity": {"channelId": "ch_teams_1"},
            "body": {"contentType": "text", "content": "graph edited text"},
        }

        await adapter._deliver_graph_edit(chat_message)

        assert len(captured) == 1
        assert captured[0].channel_id == "ch_teams_1"
        assert captured[0].sender_id == "u_graph"
        assert captured[0].content == "graph edited text"
        assert captured[0].message_ref == "graph_msg_5"


class TestStorageAndPlumbing:
    @pytest.mark.asyncio
    async def test_message_store_update_body_updates_fields(self) -> None:
        store = MessageStore()
        msg = Message(
            room_id="r1",
            transport_event_id="$evt1",
            sender_id="@user:test",
            event_type="m.room.message",
            msgtype="m.text",
            body="original",
            content={"msgtype": "m.text", "body": "original"},
        )
        session = MagicMock()
        session.flush = AsyncMock()
        store.get_by_transport_event_id = AsyncMock(return_value=msg)  # type: ignore[assignment]

        updated = await store.update_body(
            session,
            "$evt1",
            "edited body",
            new_formatted_body="<p>edited body</p>",
        )

        assert updated is msg
        assert msg.body == "edited body"
        assert msg.formatted_body == "<p>edited body</p>"
        assert msg.content["body"] == "edited body"
        assert msg.content["formatted_body"] == "<p>edited body</p>"
        session.flush.assert_awaited_once()

    def test_room_cache_invalidate(self) -> None:
        cache = object.__new__(RoomDeliveryCache)
        cache._drop = MagicMock()
        cache.invalidate("t1", "r1")
        cache._drop.assert_called_once_with(("t1", "r1"), "invalidated")

    @pytest.mark.asyncio
    async def test_actor_edit_message_delegates_to_transport(self) -> None:
        transport = MagicMock()
        transport.edit_message = AsyncMock(return_value=True)

        actor = object.__new__(Actor)
        actor.display_name = "Alice"
        actor.transport = transport

        success = await actor.edit_message(
            room_id="!room:test",
            transport_event_id="$evt1",
            body="new text",
            format="markdown",
        )

        assert success is True
        transport.edit_message.assert_awaited_once_with(
            "!room:test",
            "$evt1",
            "new text",
            sender_name="Alice",
            format="markdown",
        )
