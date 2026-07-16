from __future__ import annotations

import asyncio
from typing import Any

import discord

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
        self.edit_raises_not_found = False

    async def send(self, **kwargs: Any) -> Any:
        self.sent.append(kwargs)
        thread = kwargs.get("thread")
        channel = thread if thread is not None else _FakeChannel()
        return _FakeMessage(channel, message_id=900 + len(self.sent))

    async def edit_message(self, message_id: int, **kwargs: Any) -> None:
        if self.edit_raises_not_found:
            raise discord.NotFound(_FakeResponse(), "unknown message")
        self.edits.append({"message_id": message_id, **kwargs})


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
    ) -> None:
        self.id = 1
        self.filename = filename
        self.content_type = content_type
        self._data = data
        self._fail = fail

    async def read(self) -> bytes:
        if self._fail:
            raise RuntimeError("boom")
        return self._data


def test_image_attachments_downloaded_others_skipped() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)
    files = [
        _FakeFile("shot.png", "image/png", b"png-bytes"),
        _FakeFile("notes.pdf", "application/pdf"),
        _FakeFile("broken.jpg", "image/jpeg", fail=True),
        _FakeFile("unknown.bin", None),
    ]

    _run(
        adapter._handle_message(
            _gateway_message(channel=_FakeChannel(), attachments=files)
        )
    )

    atts = captured[0].attachments
    assert len(atts) == 1
    assert atts[0].filename == "shot.png"
    assert atts[0].mimetype == "image/png"
    assert atts[0].data == b"png-bytes"


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


def test_delete_message_uses_partial_message_in_location_channel() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    thread = _FakeThread(parent=channel, thread_id=4000)
    thread.deleted_ids = []  # type: ignore[attr-defined]
    thread.get_partial_message = lambda mid: _FakePartialMessage(thread, mid)  # type: ignore[attr-defined]
    adapter._client = _FakeClient({CHANNEL_ID: channel, 4000: thread})

    _run(adapter.delete_message(str(CHANNEL_ID), "4000:901"))

    assert thread.deleted_ids == [901]  # type: ignore[attr-defined]


def test_send_typing_triggers_once_and_off_is_noop() -> None:
    adapter = _adapter()
    channel = _FakeChannel()
    adapter._client = _FakeClient({CHANNEL_ID: channel})

    _run(adapter.send_typing(str(CHANNEL_ID), "my-agent", True))
    _run(adapter.send_typing(str(CHANNEL_ID), "my-agent", False))

    assert channel.typing_count == 1


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
