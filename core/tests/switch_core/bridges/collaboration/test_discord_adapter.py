from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import patch

import discord
import pytest

from switch_core.bridges.collaboration.discord import adapter as adapter_module
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.models import InboundCommand, InboundMessage

GUILD_ID = 900
CHANNEL_ID = 100
BOT_USER_ID = 42
BRIDGE_WEBHOOK_ID = 77


def _adapter() -> DiscordAdapter:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id=str(GUILD_ID))
    )
    adapter._bot_user_id = BOT_USER_ID
    return adapter


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeRole:
    pass


class _FakeGuild:
    def __init__(self, guild_id: int = GUILD_ID) -> None:
        self.id = guild_id
        self.default_role = _FakeRole()


class _FakeOverwrite:
    def __init__(self, view_channel: bool | None) -> None:
        self.view_channel = view_channel


class _FakeMessage:
    def __init__(self, channel: Any, message_id: int = 1) -> None:
        self.id = message_id
        self.channel = channel
        self.content = ""
        self.threads_created: list[str] = []

    async def edit(self, *, content: str) -> None:
        self.edited = content

    async def create_thread(self, *, name: str) -> Any:
        self.threads_created.append(name)
        return _FakeThread(parent=self.channel, thread_id=self.id)


class _FakePartialMessage:
    def __init__(self, channel: _FakeChannel, message_id: int) -> None:
        self.id = message_id
        self._channel = channel

    async def delete(self) -> None:
        self._channel.deleted_ids.append(self.id)

    async def create_thread(self, *, name: str) -> Any:
        return _FakeThread(parent=self._channel, thread_id=self.id)


class _FakeChannel:
    def __init__(
        self,
        channel_id: int = CHANNEL_ID,
        *,
        guild: Any | None = None,
        name: str | None = "general",
        everyone_can_view: bool | None = True,
    ) -> None:
        self.id = channel_id
        self.guild = guild if guild is not None else _FakeGuild()
        self.name = name
        self._everyone_can_view = everyone_can_view
        self.sent: list[dict[str, Any]] = []
        self.deleted_ids: list[int] = []
        self.typing_count = 0
        self.existing_webhooks: list[Any] = []
        self.created_webhooks: list[str] = []
        self.messages: dict[int, _FakeMessage] = {}

    def overwrites_for(self, role: Any) -> _FakeOverwrite:
        return _FakeOverwrite(self._everyone_can_view)

    async def send(self, content: str, **kwargs: Any) -> Any:
        self.sent.append({"content": content, **kwargs})
        msg = _FakeMessage(self, message_id=500 + len(self.sent))
        return msg

    async def typing(self) -> None:
        self.typing_count += 1

    async def webhooks(self) -> list[Any]:
        return self.existing_webhooks

    async def create_webhook(self, *, name: str) -> Any:
        self.created_webhooks.append(name)
        return _FakeWebhook(name=name)

    async def fetch_message(self, message_id: int) -> _FakeMessage:
        msg = self.messages.get(message_id)
        if msg is None:
            raise discord.NotFound(_FakeResponse(), "message not found")
        return msg

    def get_partial_message(self, message_id: int) -> _FakePartialMessage:
        return _FakePartialMessage(self, message_id)


class _FakeDMChannel(_FakeChannel):
    def __init__(self, channel_id: int = 555) -> None:
        super().__init__(channel_id, name=None)
        self.guild = None


class _FakeThread:
    def __init__(self, parent: _FakeChannel, thread_id: int) -> None:
        self.id = thread_id
        self.parent = parent
        self.parent_id = parent.id
        self.guild = parent.guild
        self.name = "a thread"
        self.sent: list[dict[str, Any]] = []

    async def send(self, content: str, **kwargs: Any) -> Any:
        self.sent.append({"content": content, **kwargs})
        return _FakeMessage(self, message_id=600 + len(self.sent))


class _FakeResponse:
    status = 404
    reason = "Not Found"


class _FakeWebhook:
    def __init__(
        self,
        name: str = "Switch Bridge",
        webhook_id: int = BRIDGE_WEBHOOK_ID,
        token: str | None = "tok",
    ) -> None:
        self.id = webhook_id
        self.name = name
        self.token = token
        self.sent: list[dict[str, Any]] = []
        self.edits: list[dict[str, Any]] = []
        self.deletes: list[dict[str, Any]] = []
        self.edit_raises_not_found = False
        self.delete_raises_not_found = False

    async def send(self, **kwargs: Any) -> Any:
        self.sent.append(kwargs)
        thread = kwargs.get("thread")
        channel = thread if thread is not None else _FakeChannel()
        return _FakeMessage(channel, message_id=900 + len(self.sent))

    async def edit_message(self, message_id: int, **kwargs: Any) -> None:
        if self.edit_raises_not_found:
            raise discord.NotFound(_FakeResponse(), "unknown message")
        self.edits.append({"message_id": message_id, **kwargs})

    async def delete_message(self, message_id: int, **kwargs: Any) -> None:
        if self.delete_raises_not_found:
            raise discord.NotFound(_FakeResponse(), "unknown message")
        self.deletes.append({"message_id": message_id, **kwargs})


class _FakeClient:
    def __init__(self, channels: dict[int, Any]) -> None:
        self._channels = channels

    def get_channel(self, channel_id: int) -> Any | None:
        return self._channels.get(channel_id)

    async def fetch_channel(self, channel_id: int) -> Any:
        channel = self._channels.get(channel_id)
        if channel is None:
            raise discord.NotFound(_FakeResponse(), "unknown channel")
        return channel


class _Author:
    def __init__(self, user_id: int, name: str) -> None:
        self.id = user_id
        self.name = name


def _gateway_message(
    *,
    channel: Any,
    content: str = "hello",
    author: _Author | None = None,
    message_id: int = 1000,
    webhook_id: int | None = None,
    message_type: discord.MessageType = discord.MessageType.default,
    attachments: list[Any] | None = None,
) -> Any:
    class _Msg:
        pass

    msg = _Msg()
    msg.id = message_id  # type: ignore[attr-defined]
    msg.channel = channel  # type: ignore[attr-defined]
    msg.guild = channel.guild  # type: ignore[attr-defined]
    msg.author = author or _Author(7, "louis")  # type: ignore[attr-defined]
    msg.content = content  # type: ignore[attr-defined]
    msg.webhook_id = webhook_id  # type: ignore[attr-defined]
    msg.type = message_type  # type: ignore[attr-defined]
    msg.attachments = attachments or []  # type: ignore[attr-defined]
    return msg


def _capture_messages(adapter: DiscordAdapter) -> list[InboundMessage]:
    captured: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        captured.append(msg)

    adapter._on_message = on_message
    return captured


def _capture_commands(adapter: DiscordAdapter) -> list[InboundCommand]:
    captured: list[InboundCommand] = []

    async def on_command(cmd: InboundCommand) -> None:
        captured.append(cmd)

    adapter._on_command = on_command
    return captured


# ── Inbound messages ─────────────────────────────────────────────────────────


def test_inbound_message_bridged() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)
    channel = _FakeChannel()

    _run(adapter._handle_message(_gateway_message(channel=channel, content="hi there")))

    assert len(captured) == 1
    msg = captured[0]
    assert msg.channel_id == str(CHANNEL_ID)
    assert msg.channel_type == "channel_public"
    assert msg.sender_id == "7"
    assert msg.sender_name == "louis"
    assert msg.content == "hi there"
    assert msg.message_ref == f"{CHANNEL_ID}:1000"
    assert msg.root_id is None
    assert msg.channel_name == "general"
    assert msg.self_mention_token is None


def test_own_bot_message_dropped() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)

    _run(
        adapter._handle_message(
            _gateway_message(
                channel=_FakeChannel(), author=_Author(BOT_USER_ID, "switch-bot")
            )
        )
    )

    assert captured == []


def test_own_webhook_message_dropped_but_foreign_webhook_bridged() -> None:
    adapter = _adapter()
    adapter._webhook_ids.add(BRIDGE_WEBHOOK_ID)
    captured = _capture_messages(adapter)
    channel = _FakeChannel()

    _run(
        adapter._handle_message(
            _gateway_message(
                channel=channel, webhook_id=BRIDGE_WEBHOOK_ID, message_id=1
            )
        )
    )
    _run(
        adapter._handle_message(
            _gateway_message(channel=channel, webhook_id=12345, message_id=2)
        )
    )

    assert len(captured) == 1
    assert captured[0].message_ref == f"{CHANNEL_ID}:2"


def test_other_guild_and_system_messages_skipped() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)

    other_guild_channel = _FakeChannel(guild=_FakeGuild(guild_id=999))
    _run(adapter._handle_message(_gateway_message(channel=other_guild_channel)))
    _run(
        adapter._handle_message(
            _gateway_message(
                channel=_FakeChannel(), message_type=discord.MessageType.pins_add
            )
        )
    )

    assert captured == []


def test_duplicate_message_ids_deduplicated() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)
    channel = _FakeChannel()

    _run(adapter._handle_message(_gateway_message(channel=channel, message_id=5)))
    _run(adapter._handle_message(_gateway_message(channel=channel, message_id=5)))

    assert len(captured) == 1


def test_thread_message_bridged_into_parent_channel() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)
    parent = _FakeChannel()
    thread = _FakeThread(parent=parent, thread_id=2000)

    _run(
        adapter._handle_message(
            _gateway_message(channel=thread, content="reply", message_id=2001)
        )
    )

    assert len(captured) == 1
    msg = captured[0]
    assert msg.channel_id == str(CHANNEL_ID)
    assert msg.root_id == f"{CHANNEL_ID}:2000"
    assert msg.message_ref == "2000:2001"
    assert msg.channel_name == "general"


def test_private_channel_and_dm_channel_types() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)

    private = _FakeChannel(channel_id=101, everyone_can_view=False)
    _run(adapter._handle_message(_gateway_message(channel=private, message_id=1)))

    dm = _FakeDMChannel()
    _run(adapter._handle_message(_gateway_message(channel=dm, message_id=2)))

    assert captured[0].channel_type == "channel_private"
    assert captured[1].channel_type == "lobby"
    assert captured[1].channel_name is None


def test_self_mention_token_set_when_bot_mentioned() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)

    _run(
        adapter._handle_message(
            _gateway_message(
                channel=_FakeChannel(), content=f"hey <@!{BOT_USER_ID}> help"
            )
        )
    )

    assert captured[0].self_mention_token == str(BOT_USER_ID)


def test_bang_command_routed_to_on_command() -> None:
    adapter = _adapter()
    messages = _capture_messages(adapter)
    commands = _capture_commands(adapter)
    parent = _FakeChannel()
    thread = _FakeThread(parent=parent, thread_id=3000)

    _run(
        adapter._handle_message(
            _gateway_message(
                channel=thread, content="!invite-agent @helper now", message_id=3001
            )
        )
    )

    assert messages == []
    assert len(commands) == 1
    cmd = commands[0]
    assert cmd.command == "invite-agent"
    assert cmd.args == "@helper now"
    assert cmd.channel_id == str(CHANNEL_ID)
    assert cmd.message_ref == "3000:3001"
    assert cmd.root_id == f"{CHANNEL_ID}:3000"


# ── Attachments ──────────────────────────────────────────────────────────────


class _FakeFile:
    def __init__(
        self,
        filename: str,
        content_type: str | None,
        data: bytes = b"x",
        fail: bool = False,
        size: int | None = None,
    ) -> None:
        self.id = 1
        self.filename = filename
        self.content_type = content_type
        self.size = size if size is not None else len(data)
        self._data = data
        self._fail = fail

    async def read(self) -> bytes:
        if self._fail:
            raise RuntimeError("boom")
        return self._data


def test_attachments_of_every_type_downloaded() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)
    files = [
        _FakeFile("shot.png", "image/png", b"png-bytes"),
        _FakeFile("notes.pdf", "application/pdf", b"%PDF"),
        _FakeFile("readme.md", "text/markdown", b"# hi"),
        _FakeFile("unknown.bin", None, b"raw"),
    ]

    _run(
        adapter._handle_message(
            _gateway_message(channel=_FakeChannel(), attachments=files)
        )
    )

    atts = captured[0].attachments
    assert [a.filename for a in atts] == [
        "shot.png",
        "notes.pdf",
        "readme.md",
        "unknown.bin",
    ]
    assert atts[0].data == b"png-bytes"
    assert atts[2].mimetype == "text/markdown"
    # A file Discord reports no content type for still comes through.
    assert atts[3].mimetype == "application/octet-stream"
    assert captured[0].attachment_failures == []


def test_failed_download_reported_as_failure_not_dropped() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)
    files = [
        _FakeFile("good.md", "text/markdown", b"# hi"),
        _FakeFile("broken.jpg", "image/jpeg", fail=True),
    ]

    _run(
        adapter._handle_message(
            _gateway_message(channel=_FakeChannel(), attachments=files)
        )
    )

    assert [a.filename for a in captured[0].attachments] == ["good.md"]
    failures = captured[0].attachment_failures
    assert [f.filename for f in failures] == ["broken.jpg"]
    assert failures[0].reason


def test_oversize_attachment_reported_as_failure() -> None:
    adapter = _adapter()
    adapter.set_max_attachment_bytes(10)
    captured = _capture_messages(adapter)
    files = [
        _FakeFile("small.md", "text/markdown", b"# hi"),
        _FakeFile("huge.bin", "application/octet-stream", b"x", size=100),
    ]

    _run(
        adapter._handle_message(
            _gateway_message(channel=_FakeChannel(), attachments=files)
        )
    )

    assert [a.filename for a in captured[0].attachments] == ["small.md"]
    failures = captured[0].attachment_failures
    assert [f.filename for f in failures] == ["huge.bin"]
    assert "exceeds" in failures[0].reason


# ── Outbound messaging ───────────────────────────────────────────────────────


def test_send_message_posts_via_webhook_with_agent_identity() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    adapter._client = _FakeClient({CHANNEL_ID: channel})
    webhook = _FakeWebhook()
    adapter._webhooks[CHANNEL_ID] = webhook

    ref = _run(adapter.send_message(str(CHANNEL_ID), "my-agent", "**hello**"))

    assert len(webhook.sent) == 1
    call = webhook.sent[0]
    assert call["content"] == "**hello**"
    assert call["username"] == "my-agent"
    assert "my-agent" in call["avatar_url"]
    assert call["suppress_embeds"] is True
    assert call["wait"] is True
    assert "thread" not in call
    assert ref == f"{CHANNEL_ID}:901"


def test_send_message_with_thread_root_posts_into_thread() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    root = _FakeMessage(channel, message_id=4000)
    root.content = "the root message"
    channel.messages[4000] = root
    adapter._client = _FakeClient({CHANNEL_ID: channel})
    webhook = _FakeWebhook()
    adapter._webhooks[CHANNEL_ID] = webhook

    ref = _run(
        adapter.send_message(
            str(CHANNEL_ID), "my-agent", "reply", thread_root_id=f"{CHANNEL_ID}:4000"
        )
    )

    assert root.threads_created == ["the root message"]
    thread = webhook.sent[0]["thread"]
    assert thread.id == 4000
    assert ref == "4000:901"


def test_send_message_reuses_existing_thread() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    thread = _FakeThread(parent=channel, thread_id=4000)
    adapter._client = _FakeClient({CHANNEL_ID: channel, 4000: thread})
    webhook = _FakeWebhook()
    adapter._webhooks[CHANNEL_ID] = webhook

    _run(
        adapter.send_message(
            str(CHANNEL_ID), "my-agent", "reply", thread_root_id=f"{CHANNEL_ID}:4000"
        )
    )

    assert webhook.sent[0]["thread"] is thread


def test_send_message_to_dm_falls_back_to_bot_post() -> None:
    adapter = _adapter()
    dm = _FakeDMChannel()
    adapter._client = _FakeClient({dm.id: dm})

    ref = _run(adapter.send_message(str(dm.id), "my-agent", "hi"))

    assert dm.sent[0]["content"] == "**my-agent**: hi"
    assert ref == f"{dm.id}:501"


# ── Outbound attachments ─────────────────────────────────────────────────────


def test_send_attachment_posts_via_webhook_with_agent_identity() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    adapter._client = _FakeClient({CHANNEL_ID: channel})
    webhook = _FakeWebhook()
    adapter._webhooks[CHANNEL_ID] = webhook

    ref = _run(
        adapter.send_attachment(
            str(CHANNEL_ID),
            "my-agent",
            "shot.png",
            "image/png",
            b"PNGDATA",
            caption="look **here**",
        )
    )

    assert len(webhook.sent) == 1
    call = webhook.sent[0]
    assert call["content"] == "look **here**"
    assert call["username"] == "my-agent"
    assert "my-agent" in call["avatar_url"]
    assert isinstance(call["file"], discord.File)
    assert call["file"].filename == "shot.png"
    # Image previews must render, so embeds are NOT suppressed for attachments.
    assert "suppress_embeds" not in call
    assert "thread" not in call
    assert ref == f"{CHANNEL_ID}:901"


def test_send_attachment_without_caption_sends_empty_content() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    adapter._client = _FakeClient({CHANNEL_ID: channel})
    webhook = _FakeWebhook()
    adapter._webhooks[CHANNEL_ID] = webhook

    _run(
        adapter.send_attachment(
            str(CHANNEL_ID), "my-agent", "shot.png", "image/png", b"PNGDATA"
        )
    )

    assert webhook.sent[0]["content"] == ""
    assert webhook.sent[0]["file"].filename == "shot.png"


def test_send_attachment_into_thread() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    thread = _FakeThread(parent=channel, thread_id=4000)
    adapter._client = _FakeClient({CHANNEL_ID: channel, 4000: thread})
    webhook = _FakeWebhook()
    adapter._webhooks[CHANNEL_ID] = webhook

    ref = _run(
        adapter.send_attachment(
            str(CHANNEL_ID),
            "my-agent",
            "shot.png",
            "image/png",
            b"PNGDATA",
            thread_root_id=f"{CHANNEL_ID}:4000",
        )
    )

    assert webhook.sent[0]["thread"] is thread
    assert ref == "4000:901"


def test_send_attachment_to_dm_posts_file_as_bot() -> None:
    adapter = _adapter()
    dm = _FakeDMChannel()
    adapter._client = _FakeClient({dm.id: dm})

    ref = _run(
        adapter.send_attachment(
            str(dm.id), "my-agent", "shot.png", "image/png", b"PNGDATA", caption="hi"
        )
    )

    assert dm.sent[0]["content"] == "**my-agent**: hi"
    assert dm.sent[0]["file"].filename == "shot.png"
    assert ref == f"{dm.id}:501"


def test_send_attachment_falls_back_to_text_note_on_http_error() -> None:
    class _FileRejectingWebhook(_FakeWebhook):
        async def send(self, **kwargs: Any) -> Any:
            if "file" in kwargs:
                raise discord.HTTPException(_FakeResponse(), "upload failed")
            return await super().send(**kwargs)

    adapter = _adapter()
    channel = _FakeChannel()
    adapter._client = _FakeClient({CHANNEL_ID: channel})
    webhook = _FileRejectingWebhook()
    adapter._webhooks[CHANNEL_ID] = webhook

    ref = _run(
        adapter.send_attachment(
            str(CHANNEL_ID),
            "my-agent",
            "shot.png",
            "image/png",
            b"PNGDATA",
            caption="a picture",
        )
    )

    # Base fallback posts a disclosed text note (no file) via send_message.
    text_posts = [c for c in webhook.sent if "file" not in c]
    assert len(text_posts) == 1
    assert "shot.png" in text_posts[0]["content"]
    assert "a picture" in text_posts[0]["content"]
    assert ref == f"{CHANNEL_ID}:901"


def test_admin_message_posts_as_bot_not_webhook() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    adapter._client = _FakeClient({CHANNEL_ID: channel})

    ref = _run(adapter.admin_message(str(CHANNEL_ID), "system notice"))

    assert channel.sent[0]["content"] == "system notice"
    assert channel.sent[0]["suppress_embeds"] is True
    assert ref == f"{CHANNEL_ID}:501"


def test_update_message_edits_via_webhook_with_thread() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    adapter._client = _FakeClient({CHANNEL_ID: channel})
    webhook = _FakeWebhook()
    adapter._webhooks[CHANNEL_ID] = webhook

    _run(adapter.update_message(str(CHANNEL_ID), "4000:901", "new text"))

    edit = webhook.edits[0]
    assert edit["message_id"] == 901
    assert edit["content"] == "new text"
    assert edit["thread"].id == 4000


def test_update_message_falls_back_to_bot_message_edit() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    bot_msg = _FakeMessage(channel, message_id=502)
    channel.messages[502] = bot_msg
    adapter._client = _FakeClient({CHANNEL_ID: channel})
    webhook = _FakeWebhook()
    webhook.edit_raises_not_found = True
    adapter._webhooks[CHANNEL_ID] = webhook

    _run(adapter.update_message(str(CHANNEL_ID), f"{CHANNEL_ID}:502", "edited"))

    assert bot_msg.edited == "edited"


def test_delete_message_goes_through_the_webhook_that_sent_it() -> None:
    # Agent posts are authored by the webhook, not the bot. Deleting them as the
    # bot needs Manage Messages and silently fails without it, which left every
    # runtime indicator stranded in the channel.
    adapter = _adapter()
    channel = _FakeChannel()
    webhook = _FakeWebhook()
    channel.existing_webhooks = [webhook]
    adapter._client = _FakeClient({CHANNEL_ID: channel})

    _run(adapter.delete_message(str(CHANNEL_ID), f"{CHANNEL_ID}:901"))

    assert [d["message_id"] for d in webhook.deletes] == [901]
    assert channel.deleted_ids == []


def test_delete_message_in_a_thread_passes_the_thread_through() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    webhook = _FakeWebhook()
    channel.existing_webhooks = [webhook]
    thread = _FakeThread(parent=channel, thread_id=4000)
    adapter._client = _FakeClient({CHANNEL_ID: channel, 4000: thread})

    _run(adapter.delete_message(str(CHANNEL_ID), "4000:901"))

    assert webhook.deletes[0]["message_id"] == 901
    assert webhook.deletes[0]["thread"].id == 4000


def test_delete_message_falls_back_to_the_bot_for_its_own_posts() -> None:
    # Admin notices and DM fallbacks are posted by the bot, so the webhook does
    # not own them and reports NotFound.
    adapter = _adapter()
    channel = _FakeChannel()
    webhook = _FakeWebhook()
    webhook.delete_raises_not_found = True
    channel.existing_webhooks = [webhook]
    thread = _FakeThread(parent=channel, thread_id=4000)
    thread.deleted_ids = []  # type: ignore[attr-defined]
    thread.get_partial_message = lambda mid: _FakePartialMessage(thread, mid)  # type: ignore[attr-defined]
    adapter._client = _FakeClient({CHANNEL_ID: channel, 4000: thread})

    _run(adapter.delete_message(str(CHANNEL_ID), "4000:901"))

    assert webhook.deletes == []
    assert thread.deleted_ids == [901]  # type: ignore[attr-defined]


def test_send_typing_triggers_once_and_off_is_noop() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    adapter._client = _FakeClient({CHANNEL_ID: channel})

    _run(adapter.send_typing(str(CHANNEL_ID), "my-agent", True))
    _run(adapter.send_typing(str(CHANNEL_ID), "my-agent", False))

    assert channel.typing_count == 1


# ── Runtime state (working-on-it activity) ──────────────────────────────────


def _runtime_setup() -> tuple[DiscordAdapter, _FakeChannel, _FakeWebhook]:
    adapter = _adapter()
    channel = _FakeChannel()
    adapter._client = _FakeClient({CHANNEL_ID: channel})
    webhook = _FakeWebhook()
    adapter._webhooks[CHANNEL_ID] = webhook
    return adapter, channel, webhook


def test_runtime_state_working_posts_persistent_indicator() -> None:
    adapter, _, webhook = _runtime_setup()

    _run(
        adapter.apply_runtime_state(
            str(CHANNEL_ID),
            "my-agent",
            "working",
            notify_user=None,
            thread_root_id=None,
        )
    )

    assert len(webhook.sent) == 1
    assert webhook.sent[0]["content"] == "⚙️ _Working on it…_"
    assert webhook.sent[0]["username"] == "my-agent"
    assert (
        adapter._working_msg[(str(CHANNEL_ID), "my-agent")].message_ref
        == f"{CHANNEL_ID}:901"
    )


def test_runtime_state_detail_edits_message_in_place() -> None:
    adapter, _, webhook = _runtime_setup()

    _run(
        adapter.apply_runtime_state(
            str(CHANNEL_ID),
            "my-agent",
            "working",
            notify_user=None,
            thread_root_id=None,
        )
    )
    _run(
        adapter.apply_runtime_state(
            str(CHANNEL_ID),
            "my-agent",
            "working",
            notify_user=None,
            thread_root_id=None,
            detail="Editing adapter.py",
        )
    )

    assert len(webhook.sent) == 1
    assert len(webhook.edits) == 1
    assert webhook.edits[0]["message_id"] == 901
    assert webhook.edits[0]["content"] == "⚙️ Editing adapter.py"
    assert (
        adapter._working_msg[(str(CHANNEL_ID), "my-agent")].message_ref
        == f"{CHANNEL_ID}:901"
    )


def test_runtime_state_idle_clears_working_message() -> None:
    adapter, channel, webhook = _runtime_setup()

    _run(
        adapter.apply_runtime_state(
            str(CHANNEL_ID),
            "my-agent",
            "working",
            notify_user=None,
            thread_root_id=None,
        )
    )
    _run(
        adapter.apply_runtime_state(
            str(CHANNEL_ID), "my-agent", "idle", notify_user=None, thread_root_id=None
        )
    )

    assert [d["message_id"] for d in webhook.deletes] == [901]
    assert channel.deleted_ids == []
    assert (str(CHANNEL_ID), "my-agent") not in adapter._working_msg


def test_runtime_state_awaiting_input_pings_and_resume_clears_pings() -> None:
    adapter, channel, webhook = _runtime_setup()

    _run(
        adapter.apply_runtime_state(
            str(CHANNEL_ID),
            "my-agent",
            "working",
            notify_user=None,
            thread_root_id=None,
        )
    )
    _run(
        adapter.apply_runtime_state(
            str(CHANNEL_ID),
            "my-agent",
            "awaiting-input",
            notify_user="louis",
            thread_root_id=None,
        )
    )

    # Working indicator stays up; a ping was posted and tracked.
    assert len(webhook.sent) == 2
    assert "@louis" in webhook.sent[1]["content"]
    assert "needs your input" in webhook.sent[1]["content"]
    assert adapter._input_pings[(str(CHANNEL_ID), "my-agent")] == [f"{CHANNEL_ID}:902"]

    # Resuming work means the input was provided — the ping is deleted, the
    # working indicator is refreshed in place.
    _run(
        adapter.apply_runtime_state(
            str(CHANNEL_ID),
            "my-agent",
            "working",
            notify_user=None,
            thread_root_id=None,
        )
    )
    assert [d["message_id"] for d in webhook.deletes] == [902]
    assert (str(CHANNEL_ID), "my-agent") not in adapter._input_pings


# ── Webhook management ───────────────────────────────────────────────────────


def test_get_webhook_adopts_existing_bridge_webhook() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    existing = _FakeWebhook(name="Switch Bridge", webhook_id=555)
    channel.existing_webhooks = [_FakeWebhook(name="other", webhook_id=1), existing]
    adapter._client = _FakeClient({CHANNEL_ID: channel})

    webhook = _run(adapter._get_webhook(CHANNEL_ID))

    assert webhook is existing
    assert channel.created_webhooks == []
    assert 555 in adapter._webhook_ids


def test_get_webhook_creates_when_missing() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    adapter._client = _FakeClient({CHANNEL_ID: channel})

    webhook = _run(adapter._get_webhook(CHANNEL_ID))

    assert channel.created_webhooks == ["Switch Bridge"]
    assert webhook.id in adapter._webhook_ids
    # Cached: second call does not re-create.
    again = _run(adapter._get_webhook(CHANNEL_ID))
    assert again is webhook
    assert channel.created_webhooks == ["Switch Bridge"]


# ── Translation ──────────────────────────────────────────────────────────────


def test_translate_inbound_converts_user_and_channel_mentions() -> None:
    adapter = _adapter()
    adapter._user_names[7] = "louis"
    adapter._client = _FakeClient({CHANNEL_ID: _FakeChannel(name="general")})

    out = adapter.translate_inbound(f"hi <@7> and <@!7>, see <#{CHANNEL_ID}> or <@99>")

    assert out == "hi @louis and @louis, see #general or <@99>"


def test_translate_outbound_rewrites_known_usernames() -> None:
    adapter = _adapter()
    adapter._username_to_id["louis"] = 7

    out = adapter.translate_outbound("ping @louis and @unknown-agent")

    assert out == "ping <@7> and @unknown-agent"


# ── Gateway lifecycle (start / stop) ──────────────────────────────────────────


class _BotUser:
    def __init__(self, user_id: int) -> None:
        self.id = user_id

    def __str__(self) -> str:
        return f"bot#{self.id}"


class _FakeGatewayClient:
    """Controllable stand-in for ``discord.Client`` used by ``start()``.

    ``connect_behavior`` selects how the gateway task behaves: ``"hang"`` keeps
    the connection alive (awaits an event that only ``close()`` sets), while
    ``"raise"`` fails the connection like a bad token. Readiness is gated on
    ``ready_event`` so a test decides whether ``wait_until_ready()`` resolves.
    """

    def __init__(self) -> None:
        self.user = _BotUser(BOT_USER_ID)
        self.logged_in = False
        self.closed = False
        self.registered_events: list[Any] = []
        self.connect_behavior = "hang"
        self.connect_exc: BaseException = RuntimeError("gateway boom")
        self._ready_event = asyncio.Event()
        self._closed_event = asyncio.Event()

    def event(self, coro: Any) -> Any:
        self.registered_events.append(coro)
        return coro

    async def login(self, token: str) -> None:
        self.logged_in = True

    async def connect(self) -> None:
        if self.connect_behavior == "raise":
            raise self.connect_exc
        await self._closed_event.wait()

    async def wait_until_ready(self) -> None:
        await self._ready_event.wait()

    async def close(self) -> None:
        self.closed = True
        self._closed_event.set()


def _noop_callbacks() -> tuple[Any, ...]:
    async def _cb(*args: Any, **kwargs: Any) -> None:
        return None

    return (_cb, _cb, _cb, _cb, _cb)


def test_start_becomes_ready_then_stop_closes_client() -> None:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id=str(GUILD_ID))
    )
    fake = _FakeGatewayClient()
    fake._ready_event.set()  # ready as soon as start() waits

    async def scenario() -> None:
        with patch.object(adapter_module.discord, "Client", lambda **kw: fake):
            await adapter.start(*_noop_callbacks())
            assert adapter._client is fake
            assert fake.logged_in
            assert fake.registered_events  # on_message handler registered
            assert adapter._bot_user_id == BOT_USER_ID

            await adapter.stop()
            assert fake.closed
            assert adapter._client is None

    _run(scenario())


def test_start_raises_when_gateway_connection_fails() -> None:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id=str(GUILD_ID))
    )
    fake = _FakeGatewayClient()
    fake.connect_behavior = "raise"
    fake.connect_exc = RuntimeError("login failed")
    # ready never fires, so the failing connect task is what completes first.

    async def scenario() -> None:
        with patch.object(adapter_module.discord, "Client", lambda **kw: fake):
            with pytest.raises(RuntimeError, match="gateway connection failed") as exc:
                await adapter.start(*_noop_callbacks())
            assert isinstance(exc.value.__cause__, RuntimeError)
            assert str(exc.value.__cause__) == "login failed"

    _run(scenario())


def test_start_times_out_when_never_ready_and_stops() -> None:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id=str(GUILD_ID))
    )
    fake = _FakeGatewayClient()  # hangs on connect, never becomes ready

    async def scenario() -> None:
        with (
            patch.object(adapter_module.discord, "Client", lambda **kw: fake),
            patch.object(adapter_module, "_READY_TIMEOUT", 0.05),
        ):
            with pytest.raises(RuntimeError, match="not ready"):
                await adapter.start(*_noop_callbacks())
            # Timeout path tears the half-open client down.
            assert fake.closed
            assert adapter._client is None

    _run(scenario())
