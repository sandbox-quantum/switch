"""Discord deletes and edits reach the bridge core in the forms the inbound path
gave the post, through both the self-registered and the shared connection."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

import discord
import pytest

from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.discord.connection import DiscordConnection
from switch_core.bridges.collaboration.discord.gateway import DiscordGatewayClient
from switch_core.bridges.collaboration.install_service import (
    WebhookTarget,
    WebhookWorkspaceUnknown,
)
from switch_core.bridges.collaboration.models import (
    InboundChannelRemoved,
    InboundMessageDeleted,
    InboundMessageEdited,
)

GUILD_ID = 900
OTHER_GUILD_ID = 901
CHANNEL_ID = 100
THREAD_ID = 2000
BOT_USER_ID = 42
BRIDGE_WEBHOOK_ID = 77
EDITED_AT = datetime(2026, 1, 1, tzinfo=UTC)


class _Guild:
    def __init__(self, guild_id: int = GUILD_ID) -> None:
        self.id = guild_id


class _Channel:
    def __init__(self, channel_id: int = CHANNEL_ID, guild_id: int = GUILD_ID) -> None:
        self.id = channel_id
        self.guild = _Guild(guild_id)


class _Thread:
    def __init__(self, parent: _Channel, thread_id: int = THREAD_ID) -> None:
        self.id = thread_id
        self.parent_id = parent.id
        self.guild = parent.guild


class _Client:
    def __init__(self, channels: list[Any]) -> None:
        self._channels = {channel.id: channel for channel in channels}

    def get_channel(self, channel_id: int) -> Any | None:
        return self._channels.get(channel_id)

    async def fetch_channel(self, channel_id: int) -> Any:
        raise AssertionError(f"channel {channel_id} should have been cached")


class _Author:
    def __init__(self, user_id: int) -> None:
        self.id = user_id


class _Message:
    def __init__(
        self,
        channel: Any,
        *,
        message_id: int = 1000,
        content: str = "new words",
        author_id: int = 7,
        webhook_id: int | None = None,
        edited_at: datetime | None = EDITED_AT,
    ) -> None:
        self.id = message_id
        self.channel = channel
        self.guild = channel.guild
        self.content = content
        self.author = _Author(author_id)
        self.webhook_id = webhook_id
        self.edited_at = edited_at


class _Captured:
    def __init__(self) -> None:
        self.deleted: list[InboundMessageDeleted] = []
        self.edited: list[InboundMessageEdited] = []
        self.removed: list[InboundChannelRemoved] = []

    async def on_deleted(self, event: InboundMessageDeleted) -> None:
        self.deleted.append(event)

    async def on_edited(self, event: InboundMessageEdited) -> None:
        self.edited.append(event)

    async def on_removed(self, event: InboundChannelRemoved) -> None:
        self.removed.append(event)


def _adapter(channels: list[Any]) -> tuple[DiscordAdapter, _Captured]:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id=str(GUILD_ID))
    )
    connection = adapter._require_connection()
    connection._bot_user_id = BOT_USER_ID
    connection._client = _Client(channels)  # type: ignore[assignment]
    adapter._webhook_ids.add(BRIDGE_WEBHOOK_ID)
    captured = _Captured()
    adapter.set_takeback_handlers(
        on_message_deleted=captured.on_deleted,
        on_message_edited=captured.on_edited,
        on_channel_removed=captured.on_removed,
    )
    return adapter, captured


def _delete(
    message_id: int, channel_id: int = CHANNEL_ID, guild_id: int = GUILD_ID
) -> discord.RawMessageDeleteEvent:
    return discord.RawMessageDeleteEvent(
        {
            "id": str(message_id),
            "channel_id": str(channel_id),
            "guild_id": str(guild_id),
        }
    )


def _edit(
    message: _Message, *, cached_content: str | None = None
) -> discord.RawMessageUpdateEvent:
    payload = discord.RawMessageUpdateEvent({}, message)  # type: ignore[typeddict-item, arg-type]
    if cached_content is not None:
        payload.cached_message = _Message(  # type: ignore[assignment]
            message.channel, message_id=message.id, content=cached_content
        )
    return payload


def _thread_delete(guild_id: int = GUILD_ID) -> discord.RawThreadDeleteEvent:
    return discord.RawThreadDeleteEvent(
        {
            "id": str(THREAD_ID),
            "type": 11,
            "guild_id": str(guild_id),
            "parent_id": str(CHANNEL_ID),
        }
    )


# ── Deletes ──────────────────────────────────────────────────────────────────


async def test_a_deleted_message_is_reported_by_channel_and_ref() -> None:
    adapter, captured = _adapter([_Channel()])

    await adapter.dispatch_message_delete(_delete(1000))

    assert captured.deleted == [
        InboundMessageDeleted(
            channel_id=str(CHANNEL_ID), message_ref=f"{CHANNEL_ID}:1000"
        )
    ]


async def test_a_deleted_thread_message_is_reported_under_the_parent_channel() -> None:
    parent = _Channel()
    adapter, captured = _adapter([parent, _Thread(parent)])

    await adapter.dispatch_message_delete(_delete(2001, channel_id=THREAD_ID))

    assert captured.deleted == [
        InboundMessageDeleted(
            channel_id=str(CHANNEL_ID), message_ref=f"{THREAD_ID}:2001"
        )
    ]


async def test_a_deletion_in_another_guild_is_not_reported() -> None:
    adapter, captured = _adapter([_Channel()])

    await adapter.dispatch_message_delete(_delete(1000, guild_id=OTHER_GUILD_ID))

    assert captured.deleted == []


async def test_a_bulk_deletion_reports_every_message() -> None:
    adapter, captured = _adapter([_Channel()])

    await adapter.dispatch_bulk_message_delete(
        discord.RawBulkMessageDeleteEvent(
            {
                "ids": ["1002", "1001"],
                "channel_id": str(CHANNEL_ID),
                "guild_id": str(GUILD_ID),
            }
        )
    )

    assert [event.message_ref for event in captured.deleted] == [
        f"{CHANNEL_ID}:1001",
        f"{CHANNEL_ID}:1002",
    ]
    assert {event.channel_id for event in captured.deleted} == {str(CHANNEL_ID)}


async def test_one_failing_message_of_a_bulk_deletion_does_not_stop_the_rest(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, captured = _adapter([_Channel()])

    async def on_deleted(event: InboundMessageDeleted) -> None:
        if event.message_ref.endswith(":1001"):
            raise RuntimeError("database down")
        captured.deleted.append(event)

    adapter.set_takeback_handlers(
        on_message_deleted=on_deleted,
        on_message_edited=captured.on_edited,
        on_channel_removed=captured.on_removed,
    )

    with caplog.at_level(logging.ERROR):
        await adapter.dispatch_bulk_message_delete(
            discord.RawBulkMessageDeleteEvent(
                {
                    "ids": ["1001", "1002"],
                    "channel_id": str(CHANNEL_ID),
                    "guild_id": str(GUILD_ID),
                }
            )
        )

    assert [event.message_ref for event in captured.deleted] == [f"{CHANNEL_ID}:1002"]
    assert f"{CHANNEL_ID}:1001" in caplog.text


# ── Edits ────────────────────────────────────────────────────────────────────


async def test_an_edit_reports_the_new_words() -> None:
    adapter, captured = _adapter([_Channel()])

    await adapter.dispatch_message_edit(
        _edit(_Message(_Channel(), content="new words"), cached_content="old words")
    )

    assert captured.edited == [
        InboundMessageEdited(
            channel_id=str(CHANNEL_ID),
            message_ref=f"{CHANNEL_ID}:1000",
            content="new words",
        )
    ]


async def test_an_edit_in_a_thread_is_reported_under_the_parent_channel() -> None:
    parent = _Channel()
    thread = _Thread(parent)
    adapter, captured = _adapter([parent, thread])

    await adapter.dispatch_message_edit(_edit(_Message(thread, message_id=2001)))

    assert [(e.channel_id, e.message_ref) for e in captured.edited] == [
        (str(CHANNEL_ID), f"{THREAD_ID}:2001")
    ]


async def test_an_embed_arriving_on_an_unedited_message_is_not_an_edit() -> None:
    adapter, captured = _adapter([_Channel()])

    await adapter.dispatch_message_edit(_edit(_Message(_Channel(), edited_at=None)))

    assert captured.edited == []


async def test_an_update_with_the_same_words_is_not_an_edit() -> None:
    adapter, captured = _adapter([_Channel()])

    await adapter.dispatch_message_edit(
        _edit(_Message(_Channel(), content="same"), cached_content="same")
    )

    assert captured.edited == []


async def test_an_edit_with_its_words_withheld_is_not_reported() -> None:
    adapter, captured = _adapter([_Channel()])

    await adapter.dispatch_message_edit(_edit(_Message(_Channel(), content="")))

    assert captured.edited == []


async def test_the_bridges_own_edits_are_not_reported() -> None:
    adapter, captured = _adapter([_Channel()])

    await adapter.dispatch_message_edit(
        _edit(_Message(_Channel(), author_id=BOT_USER_ID))
    )
    await adapter.dispatch_message_edit(
        _edit(_Message(_Channel(), webhook_id=BRIDGE_WEBHOOK_ID))
    )

    assert captured.edited == []


# ── Channels and threads ─────────────────────────────────────────────────────


async def test_a_deleted_channel_is_reported_deleted() -> None:
    adapter, captured = _adapter([])

    await adapter.dispatch_channel_delete(_Channel())  # type: ignore[arg-type]
    await adapter.dispatch_channel_delete(_Channel(guild_id=OTHER_GUILD_ID))  # type: ignore[arg-type]

    assert captured.removed == [
        InboundChannelRemoved(channel_id=str(CHANNEL_ID), deleted=True)
    ]


async def test_a_deleted_thread_is_reported_as_its_own_channel_deleted() -> None:
    adapter, captured = _adapter([])

    await adapter.dispatch_thread_delete(_thread_delete())
    await adapter.dispatch_thread_delete(_thread_delete(guild_id=OTHER_GUILD_ID))

    assert captured.removed == [
        InboundChannelRemoved(channel_id=str(THREAD_ID), deleted=True)
    ]


# ── The connection's event loop ──────────────────────────────────────────────


def _events(connection: DiscordConnection) -> dict[str, Any]:
    return {event.__name__: event for event in connection._make_takeback_events()}


async def test_each_event_reaches_its_handler_through_the_connection() -> None:
    connection = DiscordConnection(
        bot_token="token", intents=discord.Intents.none(), command_guild_id=GUILD_ID
    )
    seen: list[tuple[str, Any]] = []

    def handler(name: str) -> Any:
        async def handle(payload: Any) -> None:
            seen.append((name, payload))

        return handle

    connection.set_takeback_handlers(
        on_message_delete=handler("delete"),
        on_bulk_message_delete=handler("bulk"),
        on_message_edit=handler("edit"),
        on_channel_delete=handler("channel"),
        on_thread_delete=handler("thread"),
    )
    events = _events(connection)

    await events["on_raw_message_delete"]("d")
    await events["on_raw_bulk_message_delete"]("b")
    await events["on_raw_message_edit"]("e")
    await events["on_guild_channel_delete"]("c")
    await events["on_raw_thread_delete"]("t")

    assert seen == [
        ("delete", "d"),
        ("bulk", "b"),
        ("edit", "e"),
        ("channel", "c"),
        ("thread", "t"),
    ]


async def test_a_raising_handler_is_logged_and_not_raised_out_of_the_event(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, _ = _adapter([_Channel()])

    async def on_deleted(event: InboundMessageDeleted) -> None:
        raise RuntimeError("database down")

    adapter.set_takeback_handlers(
        on_message_deleted=on_deleted,
        on_message_edited=on_deleted,  # type: ignore[arg-type]
        on_channel_removed=on_deleted,  # type: ignore[arg-type]
    )
    connection = adapter._require_connection()
    connection.set_takeback_handlers(
        on_message_delete=adapter.dispatch_message_delete,
        on_bulk_message_delete=adapter.dispatch_bulk_message_delete,
        on_message_edit=adapter.dispatch_message_edit,
        on_channel_delete=adapter.dispatch_channel_delete,
        on_thread_delete=adapter.dispatch_thread_delete,
    )

    with caplog.at_level(logging.ERROR):
        await _events(connection)["on_raw_message_delete"](_delete(1000))

    assert "Failed to handle a Discord message deletion" in caplog.text
    assert "database down" in caplog.text


async def test_events_with_no_handlers_set_are_dropped() -> None:
    connection = DiscordConnection(
        bot_token="token", intents=discord.Intents.none(), command_guild_id=GUILD_ID
    )

    await _events(connection)["on_raw_message_delete"](_delete(1000))


# ── The shared connection ────────────────────────────────────────────────────


class _InstallService:
    def __init__(self, adapter: DiscordAdapter | None) -> None:
        self._adapter = adapter
        self.calls: list[str] = []

    async def resolve_by_workspace(
        self, *, platform: str, workspace_id: str
    ) -> WebhookTarget:
        self.calls.append(workspace_id)
        if self._adapter is None:
            raise WebhookWorkspaceUnknown(f"no install for {workspace_id}")
        return WebhookTarget(
            tenant_id="tenant-a",
            platform=platform,
            bridge_id="bridge-1",
            adapter=self._adapter,
        )


def _gateway(service: _InstallService) -> DiscordGatewayClient:
    async def on_connected(connection: DiscordConnection) -> None: ...

    gateway = DiscordGatewayClient(
        bot_token="bot-token",
        message_content=False,
        members=False,
        install_service=service,  # type: ignore[arg-type]
        on_connected=on_connected,
    )
    gateway.connection._bot_user_id = BOT_USER_ID
    gateway.connection._client = _Client([_Channel()])  # type: ignore[assignment]
    return gateway


def _shared_adapter() -> tuple[DiscordAdapter, _Captured]:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(guild_id=str(GUILD_ID), event_delivery="shared")
    )
    captured = _Captured()
    adapter.set_takeback_handlers(
        on_message_deleted=captured.on_deleted,
        on_message_edited=captured.on_edited,
        on_channel_removed=captured.on_removed,
    )
    return adapter, captured


async def test_the_shared_connection_routes_takebacks_to_the_guilds_bridge() -> None:
    adapter, captured = _shared_adapter()
    service = _InstallService(adapter)
    gateway = _gateway(service)

    await gateway._on_message_delete(_delete(1000))
    await gateway._on_bulk_message_delete(
        discord.RawBulkMessageDeleteEvent(
            {"ids": ["1001"], "channel_id": str(CHANNEL_ID), "guild_id": str(GUILD_ID)}
        )
    )
    await gateway._on_message_edit(_edit(_Message(_Channel(), message_id=1002)))
    await gateway._on_channel_delete(_Channel())  # type: ignore[arg-type]
    await gateway._on_thread_delete(_thread_delete())

    assert adapter._connection is gateway.connection
    assert service.calls == [str(GUILD_ID)] * 5
    assert [e.message_ref for e in captured.deleted] == [
        f"{CHANNEL_ID}:1000",
        f"{CHANNEL_ID}:1001",
    ]
    assert [e.message_ref for e in captured.edited] == [f"{CHANNEL_ID}:1002"]
    assert captured.removed == [
        InboundChannelRemoved(channel_id=str(CHANNEL_ID), deleted=True),
        InboundChannelRemoved(channel_id=str(THREAD_ID), deleted=True),
    ]


async def test_the_shared_connection_drops_takebacks_from_an_uninstalled_guild() -> (
    None
):
    service = _InstallService(None)
    gateway = _gateway(service)

    await gateway._on_message_delete(_delete(1000))
    await gateway._on_channel_delete(_Channel())  # type: ignore[arg-type]

    assert service.calls == [str(GUILD_ID)] * 2


async def test_the_shared_connection_skips_the_bots_own_posts_unresolved() -> None:
    adapter, _ = _shared_adapter()
    service = _InstallService(adapter)
    gateway = _gateway(service)
    deleted = _delete(1000)
    deleted.cached_message = _Message(_Channel(), author_id=BOT_USER_ID)  # type: ignore[assignment]

    await gateway._on_message_delete(deleted)
    await gateway._on_message_edit(_edit(_Message(_Channel(), author_id=BOT_USER_ID)))

    assert service.calls == []
