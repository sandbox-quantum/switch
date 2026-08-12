from __future__ import annotations

import asyncio
import logging
from typing import Any
from unittest.mock import patch

import pytest
from telegram.error import BadRequest, Conflict, TelegramError

from switch_core.bridges.collaboration.models import (
    InboundCommand,
    InboundMessage,
    OutboundAttachment,
)
from switch_core.bridges.collaboration.telegram import adapter as adapter_module
from switch_core.bridges.collaboration.telegram.adapter import (
    _INSTALL_PAYLOAD,
    TelegramAdapter,
    TelegramConnectionConfig,
)

CHAT_ID = -1001234567890
BOT_USER_ID = 42
BOT_USERNAME = "acme_switch_bot"


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeChat:
    def __init__(
        self,
        chat_id: int = CHAT_ID,
        *,
        chat_type: str = "supergroup",
        title: str | None = "general",
        username: str | None = None,
    ) -> None:
        self.id = chat_id
        self.type = chat_type
        self.title = title
        self.username = username


class _FakeUser:
    def __init__(
        self,
        user_id: int = 7,
        *,
        username: str | None = "alice",
        first_name: str = "Alice",
        last_name: str = "",
    ) -> None:
        self.id = user_id
        self.username = username
        self.first_name = first_name
        self.last_name = last_name


class _FakeSentMessage:
    def __init__(self, chat: _FakeChat, message_id: int) -> None:
        self.chat = chat
        self.message_id = message_id


class _FakeFileHandle:
    def __init__(self, data: bytes, *, fail: bool = False) -> None:
        self._data = data
        self._fail = fail

    async def download_as_bytearray(self) -> bytearray:
        if self._fail:
            raise TelegramError("file is gone")
        return bytearray(self._data)


class _FakePhotoSize:
    def __init__(self, file_id: str, unique: str, size: int) -> None:
        self.file_id = file_id
        self.file_unique_id = unique
        self.file_size = size


class _FakeDocument:
    def __init__(
        self, file_id: str, name: str, mime: str | None, size: int | None
    ) -> None:
        self.file_id = file_id
        self.file_name = name
        self.mime_type = mime
        self.file_size = size


class _FakeInbound:
    """An inbound Telegram message. Only the fields the adapter reads."""

    def __init__(
        self,
        *,
        chat: _FakeChat | None = None,
        message_id: int = 11,
        text: str | None = "hello",
        caption: str | None = None,
        from_user: Any = "default",
        reply_to_message: Any = None,
        message_thread_id: int | None = None,
        new_chat_members: list[Any] | None = None,
        photo: list[Any] | None = None,
        document: Any = None,
        **service: Any,
    ) -> None:
        self.chat = chat if chat is not None else _FakeChat()
        self.message_id = message_id
        self.text = text
        self.caption = caption
        self.from_user = _FakeUser() if from_user == "default" else from_user
        self.reply_to_message = reply_to_message
        self.message_thread_id = message_thread_id
        self.new_chat_members = new_chat_members
        self.photo = photo
        self.document = document
        # Service-message and other-media fields, set only when a test needs one.
        for field, value in service.items():
            setattr(self, field, value)


class _FakeMember:
    def __init__(self, status: str) -> None:
        self.status = status


class _FakeBot:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self.photos: list[dict[str, Any]] = []
        self.documents: list[dict[str, Any]] = []
        self.albums: list[dict[str, Any]] = []
        self.edits: list[dict[str, Any]] = []
        self.deletes: list[dict[str, Any]] = []
        self.actions: list[dict[str, Any]] = []
        self.files: dict[str, _FakeFileHandle] = {}
        self.published_commands: list[Any] = []
        self.chat: _FakeChat = _FakeChat()
        # What getChatMember reports for the bot itself in `chat`.
        self.member_status = "administrator"
        self.get_chat_member_error: Exception | None = None
        self._next_id = 500
        # Set to an exception to make the next send_message raise it once.
        self.send_message_error: Exception | None = None
        self.send_photo_error: Exception | None = None
        self.send_album_error: Exception | None = None

    def _mint(self, chat_id: Any) -> _FakeSentMessage:
        self._next_id += 1
        return _FakeSentMessage(_FakeChat(int(chat_id)), self._next_id)

    async def send_message(self, **kwargs: Any) -> _FakeSentMessage:
        if self.send_message_error is not None:
            error = self.send_message_error
            self.send_message_error = None
            raise error
        self.messages.append(kwargs)
        return self._mint(kwargs["chat_id"])

    async def send_photo(self, **kwargs: Any) -> _FakeSentMessage:
        if self.send_photo_error is not None:
            error = self.send_photo_error
            self.send_photo_error = None
            raise error
        self.photos.append(kwargs)
        return self._mint(kwargs["chat_id"])

    async def send_document(self, **kwargs: Any) -> _FakeSentMessage:
        self.documents.append(kwargs)
        return self._mint(kwargs["chat_id"])

    async def send_media_group(self, **kwargs: Any) -> list[_FakeSentMessage]:
        if self.send_album_error is not None:
            error = self.send_album_error
            self.send_album_error = None
            raise error
        self.albums.append(kwargs)
        return [self._mint(kwargs["chat_id"]) for _ in kwargs["media"]]

    async def edit_message_text(self, **kwargs: Any) -> None:
        self.edits.append(kwargs)

    async def delete_message(self, **kwargs: Any) -> None:
        self.deletes.append(kwargs)

    async def send_chat_action(self, **kwargs: Any) -> None:
        self.actions.append(kwargs)

    async def set_my_commands(self, commands: Any) -> None:
        self.published_commands = list(commands)

    async def get_chat(self, chat_id: Any) -> _FakeChat:
        return self.chat

    async def get_chat_member(self, **kwargs: Any) -> _FakeMember:
        if self.get_chat_member_error is not None:
            raise self.get_chat_member_error
        return _FakeMember(self.member_status)

    async def get_file(self, file_id: str) -> _FakeFileHandle:
        handle = self.files.get(file_id)
        if handle is None:
            raise TelegramError(f"no such file {file_id}")
        return handle


def _adapter() -> TelegramAdapter:
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username=BOT_USERNAME)
    )
    adapter._bot_user_id = BOT_USER_ID
    adapter._bot = _FakeBot()
    return adapter


def _bot(adapter: TelegramAdapter) -> _FakeBot:
    return adapter._bot  # type: ignore[no-any-return]


# ── Inbound bridging ─────────────────────────────────────────────────────────


async def _collect(sink: list[Any], value: Any) -> None:
    sink.append(value)


def test_inbound_message_is_bridged_with_chat_and_sender() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(adapter._handle_message(_FakeInbound(text="hello team")))

    assert len(seen) == 1
    assert seen[0].channel_id == str(CHAT_ID)
    assert seen[0].channel_type == "channel_private"
    assert seen[0].sender_name == "alice"
    assert seen[0].content == "hello team"
    assert seen[0].message_ref == f"{CHAT_ID}:11"
    assert seen[0].channel_name == "general"


def test_the_bots_own_messages_are_dropped() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(
        adapter._handle_message(
            _FakeInbound(from_user=_FakeUser(user_id=BOT_USER_ID, username="the_bot"))
        )
    )

    assert seen == []


def test_a_repeated_message_id_is_only_bridged_once() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(adapter._handle_message(_FakeInbound(message_id=11)))
    _run(adapter._handle_message(_FakeInbound(message_id=11)))

    assert len(seen) == 1


def test_the_same_message_id_in_another_chat_is_not_a_duplicate() -> None:
    # Telegram numbers messages per chat, so the id alone cannot dedupe.
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(adapter._handle_message(_FakeInbound(message_id=11)))
    _run(
        adapter._handle_message(
            _FakeInbound(message_id=11, chat=_FakeChat(chat_id=-100999))
        )
    )

    assert len(seen) == 2


def test_a_caption_stands_in_for_text_on_a_media_message() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)
    photo = _FakePhotoSize("small", "u1", 10)
    _bot(adapter).files["small"] = _FakeFileHandle(b"img")

    _run(
        adapter._handle_message(
            _FakeInbound(text=None, caption="look at this", photo=[photo])
        )
    )

    assert seen[0].content == "look at this"


def test_a_bang_prefixed_message_routes_as_a_command() -> None:
    adapter = _adapter()
    commands: list[InboundCommand] = []
    messages: list[InboundMessage] = []
    adapter._on_command = lambda c: _collect(commands, c)
    adapter._on_message = lambda m: _collect(messages, m)

    _run(adapter._handle_message(_FakeInbound(text="!invite-agent @scout")))

    assert messages == []
    assert commands[0].command == "invite-agent"
    assert commands[0].args == "@scout"
    assert commands[0].message_ref == f"{CHAT_ID}:11"


def test_a_slash_prefixed_message_routes_as_a_command() -> None:
    # `/name` is Telegram's native command convention — the client renders it
    # as a tappable link — and with privacy mode left on it is the only text a
    # bot reliably receives in a group. It has to reach the same dispatcher as
    # `!name` or the documented commands simply do nothing (CHOO-1686).
    adapter = _adapter()
    commands: list[InboundCommand] = []
    messages: list[InboundMessage] = []
    adapter._on_command = lambda c: _collect(commands, c)
    adapter._on_message = lambda m: _collect(messages, m)

    _run(adapter._handle_message(_FakeInbound(text="/invite-agent @scout")))

    assert messages == []
    assert commands[0].command == "invite-agent"
    assert commands[0].args == "@scout"


def test_a_command_addressed_to_the_bot_drops_the_bot_name() -> None:
    # Telegram appends @botname when the command is picked from autocomplete
    # in a group; the dispatcher must still see the bare command.
    adapter = _adapter()
    commands: list[InboundCommand] = []
    adapter._on_command = lambda c: _collect(commands, c)

    _run(
        adapter._handle_message(
            _FakeInbound(text=f"/invite-agent@{BOT_USERNAME} @scout")
        )
    )

    assert commands[0].command == "invite-agent"
    assert commands[0].args == "@scout"


def test_a_bare_command_has_no_arguments() -> None:
    adapter = _adapter()
    commands: list[InboundCommand] = []
    adapter._on_command = lambda c: _collect(commands, c)

    _run(adapter._handle_message(_FakeInbound(text="/list-agents")))

    assert commands[0].command == "list-agents"
    assert commands[0].args == ""


@pytest.mark.parametrize("text", ["/", "!", "/ spaced", "hello /not-a-command"])
def test_text_that_only_looks_like_a_command_is_bridged_as_a_message(text: str) -> None:
    adapter = _adapter()
    commands: list[InboundCommand] = []
    messages: list[InboundMessage] = []
    adapter._on_command = lambda c: _collect(commands, c)
    adapter._on_message = lambda m: _collect(messages, m)

    _run(adapter._handle_message(_FakeInbound(text=text)))

    assert commands == []
    assert len(messages) == 1


def test_tagging_the_bot_itself_is_reported() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(adapter._handle_message(_FakeInbound(text=f"hey @{BOT_USERNAME} help")))

    assert seen[0].self_mention_token == BOT_USERNAME


def test_a_message_naming_no_one_has_no_self_mention() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(adapter._handle_message(_FakeInbound(text="hey @someone_else")))

    assert seen[0].self_mention_token is None


def test_a_channel_post_with_no_author_is_skipped() -> None:
    # Broadcast channel posts are authored by the channel, so there is no
    # sender to attribute them to.
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(adapter._handle_message(_FakeInbound(from_user=None)))

    assert seen == []


# ── Threading ────────────────────────────────────────────────────────────────


def test_a_forum_topic_id_is_the_thread_root() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(adapter._handle_message(_FakeInbound(message_thread_id=88)))

    assert seen[0].root_id == "88"


def test_outside_a_forum_the_replied_to_message_is_the_root() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(
        adapter._handle_message(
            _FakeInbound(reply_to_message=_FakeInbound(message_id=5))
        )
    )

    assert seen[0].root_id == "5"


def test_a_top_level_message_has_no_root() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(adapter._handle_message(_FakeInbound()))

    assert seen[0].root_id is None


# ── Joins ────────────────────────────────────────────────────────────────────


def test_a_group_becoming_a_supergroup_re_points_the_room() -> None:
    # Telegram reissues the chat id on upgrade. Left alone, the room stays bound
    # to the old one and inbound silently stops matching while outbound keeps
    # working — Telegram forwards sends to the old id. So the room follows.
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)
    moves: list[tuple[str, str]] = []
    adapter.set_channel_migration_handler(lambda old, new: _collect(moves, (old, new)))
    notice = _FakeInbound(text=None)
    notice.migrate_to_chat_id = -1009876543210  # type: ignore[attr-defined]

    _run(adapter._handle_message(notice))

    assert moves == [(str(CHAT_ID), "-1009876543210")]
    # The notice itself is not conversation.
    assert seen == []


def test_the_replacement_supergroup_re_points_the_room_it_replaced() -> None:
    # The same change announced from the other side: Telegram puts
    # migrate_from_chat_id on the first message of the new chat. Either is
    # enough, and whichever arrives first does the work.
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)
    moves: list[tuple[str, str]] = []
    adapter.set_channel_migration_handler(lambda old, new: _collect(moves, (old, new)))
    notice = _FakeInbound(text=None)
    notice.migrate_from_chat_id = -4912345678  # type: ignore[attr-defined]

    _run(adapter._handle_message(notice))

    assert moves == [("-4912345678", str(CHAT_ID))]
    assert seen == []


def test_a_migration_with_nothing_installed_to_follow_it_is_reported(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Degraded, not silent: without a handler the room cannot be moved, so the
    # log has to carry the id to re-point it at by hand.
    adapter = _adapter()
    notice = _FakeInbound(text=None)
    notice.migrate_to_chat_id = -1009876543210  # type: ignore[attr-defined]

    with caplog.at_level(logging.ERROR):
        _run(adapter._handle_message(notice))

    assert "-1009876543210" in caplog.text
    assert "re-point" in caplog.text.lower()


def test_an_ordinary_message_is_not_mistaken_for_a_migration() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(adapter._handle_message(_FakeInbound(text="just talking")))

    assert len(seen) == 1


def test_a_person_joining_is_reported_as_a_user_join() -> None:
    adapter = _adapter()
    joins: list[Any] = []
    adapter._on_user_joined = lambda j: _collect(joins, j)

    _run(
        adapter._handle_message(
            _FakeInbound(new_chat_members=[_FakeUser(user_id=9, username="bob")])
        )
    )

    assert joins[0].external_user_id == "9"
    assert joins[0].external_username == "bob"
    assert joins[0].channel_id == str(CHAT_ID)


def test_the_bot_being_added_provisions_the_room() -> None:
    # Telegram gives the "app added to channel" signal Discord lacks, so the
    # room can be created on join rather than waiting for a message.
    adapter = _adapter()
    app_joins: list[Any] = []
    adapter._on_app_joined = lambda j: _collect(app_joins, j)

    _run(
        adapter._handle_message(
            _FakeInbound(new_chat_members=[_FakeUser(user_id=BOT_USER_ID)])
        )
    )

    assert app_joins[0].channel_id == str(CHAT_ID)
    assert app_joins[0].channel_name == "general"


def test_a_membership_update_for_the_bot_provisions_the_room() -> None:
    adapter = _adapter()
    app_joins: list[Any] = []
    adapter._on_app_joined = lambda j: _collect(app_joins, j)

    _run(
        adapter._handle_update(
            _FakeUpdate(
                my_chat_member=_FakeChatMemberUpdate(
                    _FakeChat(), status="administrator"
                )
            )
        )
    )

    assert app_joins[0].channel_id == str(CHAT_ID)


def test_the_bot_being_removed_provisions_nothing() -> None:
    adapter = _adapter()
    app_joins: list[Any] = []
    adapter._on_app_joined = lambda j: _collect(app_joins, j)

    _run(
        adapter._handle_update(
            _FakeUpdate(
                my_chat_member=_FakeChatMemberUpdate(_FakeChat(), status="left")
            )
        )
    )

    assert app_joins == []


def test_a_one_to_one_chat_does_not_provision_a_room_on_join() -> None:
    adapter = _adapter()
    app_joins: list[Any] = []
    adapter._on_app_joined = lambda j: _collect(app_joins, j)

    _run(
        adapter._handle_update(
            _FakeUpdate(
                my_chat_member=_FakeChatMemberUpdate(
                    _FakeChat(chat_type="private"), status="member"
                )
            )
        )
    )

    assert app_joins == []


class _FakeChatMemberUpdate:
    def __init__(self, chat: _FakeChat, *, status: str) -> None:
        self.chat = chat
        self.new_chat_member = type("_M", (), {"status": status})()


class _FakeUpdate:
    def __init__(self, *, message: Any = None, my_chat_member: Any = None) -> None:
        self.message = message
        self.channel_post = None
        self.my_chat_member = my_chat_member


# ── Sender names ─────────────────────────────────────────────────────────────


def test_a_person_without_a_username_is_named_from_their_display_name() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(
        adapter._handle_message(
            _FakeInbound(
                from_user=_FakeUser(
                    user_id=9, username=None, first_name="Ada", last_name="Lovelace"
                )
            )
        )
    )

    # It has to survive being written as @name in a room, so no spaces — and it
    # carries the numeric id, because display names are not unique and two
    # people sharing a handle would share a room identity.
    assert seen[0].sender_name == "AdaLovelace_9"


def test_a_person_with_no_name_at_all_falls_back_to_their_id() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(
        adapter._handle_message(
            _FakeInbound(
                from_user=_FakeUser(
                    user_id=9, username=None, first_name="", last_name=""
                )
            )
        )
    )

    assert seen[0].sender_name == "user9"


# ── Inbound attachments ──────────────────────────────────────────────────────


def test_the_largest_size_of_a_photo_is_the_one_relayed() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)
    bot = _bot(adapter)
    bot.files["big"] = _FakeFileHandle(b"full-size")

    _run(
        adapter._handle_message(
            _FakeInbound(
                text=None,
                photo=[
                    _FakePhotoSize("small", "u1", 10),
                    _FakePhotoSize("big", "u2", 900),
                ],
            )
        )
    )

    assert [a.filename for a in seen[0].attachments] == ["photo_u2.jpg"]
    assert seen[0].attachments[0].mimetype == "image/jpeg"
    assert seen[0].attachments[0].data == b"full-size"


def test_a_document_keeps_its_name_and_type() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)
    _bot(adapter).files["d1"] = _FakeFileHandle(b"col1,col2")

    _run(
        adapter._handle_message(
            _FakeInbound(
                text=None, document=_FakeDocument("d1", "report.csv", "text/csv", 9)
            )
        )
    )

    assert seen[0].attachments[0].filename == "report.csv"
    assert seen[0].attachments[0].mimetype == "text/csv"


def test_an_oversize_attachment_is_disclosed_not_dropped() -> None:
    adapter = _adapter()
    adapter.set_max_attachment_bytes(100)
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(
        adapter._handle_message(
            _FakeInbound(
                text=None,
                document=_FakeDocument(
                    "d1", "huge.bin", "application/octet-stream", 5000
                ),
            )
        )
    )

    assert seen[0].attachments == []
    assert seen[0].attachment_failures[0].filename == "huge.bin"
    assert "exceeds" in seen[0].attachment_failures[0].reason


def test_the_bot_api_download_ceiling_applies_even_when_the_bridge_allows_more() -> (
    None
):
    adapter = _adapter()
    adapter.set_max_attachment_bytes(200 * 1024 * 1024)
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(
        adapter._handle_message(
            _FakeInbound(
                text=None,
                document=_FakeDocument("d1", "huge.bin", None, 50 * 1024 * 1024),
            )
        )
    )

    assert seen[0].attachments == []
    assert seen[0].attachment_failures[0].filename == "huge.bin"


def test_a_failed_download_is_disclosed_not_dropped() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)
    _bot(adapter).files["d1"] = _FakeFileHandle(b"", fail=True)

    _run(
        adapter._handle_message(
            _FakeInbound(text=None, document=_FakeDocument("d1", "x.bin", None, 4))
        )
    )

    assert seen[0].attachments == []
    assert "download failed" in seen[0].attachment_failures[0].reason


# ── Outbound messaging ───────────────────────────────────────────────────────


def test_an_agents_name_leads_a_single_line_message() -> None:
    adapter = _adapter()

    ref = _run(adapter.send_message(str(CHAT_ID), "scout", "on it"))

    sent = _bot(adapter).messages[0]
    assert sent["text"] == "<b>scout</b>: on it"
    assert sent["chat_id"] == CHAT_ID
    assert ref == f"{CHAT_ID}:501"


def test_an_agents_name_sits_above_a_multi_line_message() -> None:
    adapter = _adapter()

    _run(adapter.send_message(str(CHAT_ID), "scout", "line one\nline two"))

    assert _bot(adapter).messages[0]["text"] == "<b>scout</b>\nline one\nline two"


def test_a_threaded_reply_is_anchored_to_its_root() -> None:
    adapter = _adapter()

    _run(adapter.send_message(str(CHAT_ID), "scout", "in thread", "88"))

    params = _bot(adapter).messages[0]["reply_parameters"]
    assert params.message_id == 88
    # A root that has since been deleted must not take the message down with it.
    assert params.allow_sending_without_reply is True


def test_a_body_over_the_cap_is_split_rather_than_rejected() -> None:
    adapter = _adapter()
    body = "\n".join(["x" * 200] * 60)

    ref = _run(adapter.send_message(str(CHAT_ID), "scout", body))

    sent = _bot(adapter).messages
    assert len(sent) > 1
    assert all(len(m["text"]) <= 4096 for m in sent)
    # The ref names the head of the run, so an edit or delete finds it.
    assert ref == f"{CHAT_ID}:501"


def test_only_the_first_chunk_replies_into_the_thread() -> None:
    # Every chunk carrying reply_parameters would make Telegram render the
    # quoted root once per message.
    adapter = _adapter()
    body = "\n".join(["x" * 200] * 60)

    _run(adapter.send_message(str(CHAT_ID), "scout", body, "88"))

    sent = _bot(adapter).messages
    assert "reply_parameters" in sent[0]
    assert all("reply_parameters" not in m for m in sent[1:])


def test_markup_telegram_rejects_is_resent_as_plain_text() -> None:
    # Losing the message is the one outcome that is not acceptable.
    adapter = _adapter()
    _bot(adapter).send_message_error = BadRequest("Can't parse entities: bad tag")

    ref = _run(adapter.send_message(str(CHAT_ID), "scout", "<b>oops</unclosed>"))

    sent = _bot(adapter).messages
    assert len(sent) == 1
    assert "parse_mode" not in sent[0]
    assert "<" not in sent[0]["text"]
    assert ref is not None


def test_a_non_formatting_failure_is_not_retried() -> None:
    adapter = _adapter()
    _bot(adapter).send_message_error = BadRequest("chat not found")

    ref = _run(adapter.send_message(str(CHAT_ID), "scout", "hello"))

    assert ref is None
    assert _bot(adapter).messages == []


def test_an_admin_notice_carries_no_agent_name() -> None:
    adapter = _adapter()

    _run(adapter.admin_message(str(CHAT_ID), "scout is not in this room"))

    assert _bot(adapter).messages[0]["text"] == "scout is not in this room"


def test_editing_a_message_targets_its_chat_and_id() -> None:
    adapter = _adapter()

    _run(adapter.update_message(str(CHAT_ID), f"{CHAT_ID}:501", "new text"))

    edit = _bot(adapter).edits[0]
    assert edit["chat_id"] == CHAT_ID
    assert edit["message_id"] == 501
    assert edit["text"] == "new text"


def test_an_edit_that_changes_nothing_is_not_an_error() -> None:
    adapter = _adapter()

    async def _raise(**_kwargs: Any) -> None:
        raise BadRequest("Message is not modified")

    _bot(adapter).edit_message_text = _raise  # type: ignore[method-assign]

    # Must not raise.
    _run(adapter.update_message(str(CHAT_ID), f"{CHAT_ID}:501", "same"))


def test_deleting_a_message_targets_its_chat_and_id() -> None:
    adapter = _adapter()

    _run(adapter.delete_message(str(CHAT_ID), f"{CHAT_ID}:501"))

    assert _bot(adapter).deletes[0] == {"chat_id": CHAT_ID, "message_id": 501}


def test_a_malformed_message_ref_is_refused_rather_than_guessed() -> None:
    adapter = _adapter()

    _run(adapter.delete_message(str(CHAT_ID), "nonsense"))

    assert _bot(adapter).deletes == []


# ── Typing ───────────────────────────────────────────────────────────────────


def test_typing_on_sends_a_chat_action() -> None:
    adapter = _adapter()

    _run(adapter.send_typing(str(CHAT_ID), "scout", True))

    assert _bot(adapter).actions[0]["chat_id"] == CHAT_ID


def test_typing_off_sends_nothing() -> None:
    # Telegram's chat action expires on its own; there is no cancel call.
    adapter = _adapter()

    _run(adapter.send_typing(str(CHAT_ID), "scout", False))

    assert _bot(adapter).actions == []


# ── Outbound attachments ─────────────────────────────────────────────────────


def test_an_image_is_sent_as_a_photo_so_it_previews() -> None:
    adapter = _adapter()

    _run(
        adapter.send_attachment(
            str(CHAT_ID), "scout", "chart.png", "image/png", b"bytes", "the chart"
        )
    )

    assert _bot(adapter).documents == []
    assert _bot(adapter).photos[0]["caption"] == "<b>scout</b>: the chart"


def test_a_non_image_is_sent_as_a_document_so_its_bytes_survive() -> None:
    adapter = _adapter()

    _run(
        adapter.send_attachment(
            str(CHAT_ID), "scout", "report.csv", "text/csv", b"a,b", None
        )
    )

    doc = _bot(adapter).documents[0]
    assert doc["filename"] == "report.csv"
    assert doc["caption"] == "<b>scout</b>"


def test_an_image_too_big_to_preview_is_sent_as_a_document() -> None:
    adapter = _adapter()

    _run(
        adapter.send_attachment(
            str(CHAT_ID), "scout", "huge.png", "image/png", b"x" * (11 * 1024 * 1024)
        )
    )

    assert _bot(adapter).photos == []
    assert _bot(adapter).documents[0]["filename"] == "huge.png"


def test_a_caption_too_long_for_a_file_posts_ahead_of_it() -> None:
    adapter = _adapter()

    _run(
        adapter.send_attachment(
            str(CHAT_ID), "scout", "x.bin", "application/octet-stream", b"x", "c" * 2000
        )
    )

    assert len(_bot(adapter).messages) == 1
    assert _bot(adapter).documents[0]["caption"] is None


def test_a_failed_upload_falls_back_to_a_disclosed_notice() -> None:
    adapter = _adapter()
    _bot(adapter).send_photo_error = TelegramError("upload rejected")

    _run(adapter.send_attachment(str(CHAT_ID), "scout", "c.png", "image/png", b"bytes"))

    assert "couldn't be relayed" in _bot(adapter).messages[0]["text"]
    assert "c.png" in _bot(adapter).messages[0]["text"]


def test_an_overflowing_caption_is_not_posted_twice_when_the_upload_fails() -> None:
    # The caption has already gone out on its own; handing it to the fallback
    # notice as well would say the same thing twice.
    adapter = _adapter()
    _bot(adapter).send_photo_error = TelegramError("upload rejected")

    _run(
        adapter.send_attachment(
            str(CHAT_ID), "scout", "c.png", "image/png", b"bytes", "c" * 2000
        )
    )

    posted = _bot(adapter).messages
    assert len(posted) == 2
    assert "c" * 2000 in posted[0]["text"]
    assert "c" * 100 not in posted[1]["text"]
    assert "couldn't be relayed" in posted[1]["text"]


def test_several_images_arrive_as_one_album() -> None:
    adapter = _adapter()
    files = [
        OutboundAttachment(filename="a.png", mimetype="image/png", data=b"a"),
        OutboundAttachment(filename="b.png", mimetype="image/png", data=b"b"),
    ]

    _run(adapter.send_attachments(str(CHAT_ID), "scout", files, "two charts"))

    album = _bot(adapter).albums[0]
    assert len(album["media"]) == 2
    # Only the first item's caption shows for the album as a whole.
    assert album["media"][0].caption == "<b>scout</b>: two charts"
    assert album["media"][1].caption is None
    assert _bot(adapter).photos == []


def test_a_mixed_batch_falls_back_to_one_message_per_file() -> None:
    # sendMediaGroup will not mix photos with documents.
    adapter = _adapter()
    files = [
        OutboundAttachment(filename="a.png", mimetype="image/png", data=b"a"),
        OutboundAttachment(filename="b.csv", mimetype="text/csv", data=b"b"),
    ]

    _run(adapter.send_attachments(str(CHAT_ID), "scout", files))

    assert _bot(adapter).albums == []
    assert len(_bot(adapter).photos) == 1
    assert len(_bot(adapter).documents) == 1


def test_a_batch_over_the_album_limit_falls_back_to_one_message_per_file() -> None:
    adapter = _adapter()
    files = [
        OutboundAttachment(filename=f"{i}.png", mimetype="image/png", data=b"x")
        for i in range(11)
    ]

    _run(adapter.send_attachments(str(CHAT_ID), "scout", files))

    assert _bot(adapter).albums == []
    assert len(_bot(adapter).photos) == 11


def test_a_single_file_batch_is_just_an_attachment() -> None:
    adapter = _adapter()
    files = [OutboundAttachment(filename="a.png", mimetype="image/png", data=b"a")]

    _run(adapter.send_attachments(str(CHAT_ID), "scout", files, "one"))

    assert _bot(adapter).albums == []
    assert _bot(adapter).photos[0]["caption"] == "<b>scout</b>: one"


def test_a_rejected_album_still_delivers_the_files() -> None:
    adapter = _adapter()
    _bot(adapter).send_album_error = TelegramError("album rejected")
    files = [
        OutboundAttachment(filename="a.png", mimetype="image/png", data=b"a"),
        OutboundAttachment(filename="b.png", mimetype="image/png", data=b"b"),
    ]

    _run(adapter.send_attachments(str(CHAT_ID), "scout", files))

    assert len(_bot(adapter).photos) == 2


# ── Runtime state ────────────────────────────────────────────────────────────


def test_working_posts_a_status_message() -> None:
    adapter = _adapter()

    _run(
        adapter.apply_runtime_state(
            str(CHAT_ID), "scout", "working", notify_user=None, thread_root_id=None
        )
    )

    assert "Working on it" in _bot(adapter).messages[0]["text"]
    assert (str(CHAT_ID), "scout") in adapter._working_msg


def test_working_again_edits_the_status_rather_than_reposting() -> None:
    adapter = _adapter()
    _run(
        adapter.apply_runtime_state(
            str(CHAT_ID), "scout", "working", notify_user=None, thread_root_id=None
        )
    )

    _run(
        adapter.apply_runtime_state(
            str(CHAT_ID),
            "scout",
            "working",
            notify_user=None,
            thread_root_id=None,
            detail="Editing adapter.py",
        )
    )

    assert len(_bot(adapter).messages) == 1
    assert "Editing adapter.py" in _bot(adapter).edits[0]["text"]


def test_awaiting_input_pings_the_operator() -> None:
    adapter = _adapter()

    _run(
        adapter.apply_runtime_state(
            str(CHAT_ID),
            "scout",
            "awaiting-input",
            notify_user="alice",
            thread_root_id=None,
        )
    )

    assert "needs your input" in _bot(adapter).messages[0]["text"]
    assert adapter._input_pings[(str(CHAT_ID), "scout")]


def test_going_idle_removes_the_status_and_the_pings() -> None:
    adapter = _adapter()
    _run(
        adapter.apply_runtime_state(
            str(CHAT_ID), "scout", "working", notify_user=None, thread_root_id=None
        )
    )
    _run(
        adapter.apply_runtime_state(
            str(CHAT_ID),
            "scout",
            "awaiting-input",
            notify_user="alice",
            thread_root_id=None,
        )
    )

    _run(
        adapter.apply_runtime_state(
            str(CHAT_ID), "scout", "idle", notify_user=None, thread_root_id=None
        )
    )

    assert adapter._working_msg == {}
    assert adapter._input_pings == {}
    assert len(_bot(adapter).deletes) == 2


def test_the_status_message_follows_the_conversation() -> None:
    # Repositioning comes from the base class, but only for adapters that track
    # the indicator — this asserts Telegram does.
    adapter = _adapter()
    _run(
        adapter.apply_runtime_state(
            str(CHAT_ID), "scout", "working", notify_user=None, thread_root_id=None
        )
    )
    original = adapter._working_msg[(str(CHAT_ID), "scout")].message_ref

    _run(adapter.reposition_runtime_state(str(CHAT_ID), "scout", "88"))

    moved = adapter._working_msg[(str(CHAT_ID), "scout")]
    assert moved.message_ref != original
    assert moved.thread_root_id == "88"
    # The replacement goes up before the original comes down.
    assert _bot(adapter).deletes[0]["message_id"] == int(original.split(":")[1])


# ── Translation ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("markdown", "expected"),
    [
        ("**bold**", "<b>bold</b>"),
        ("*italic*", "<i>italic</i>"),
        ("_italic_", "<i>italic</i>"),
        ("~~gone~~", "<s>gone</s>"),
        ("`code`", "<code>code</code>"),
        ("## Heading", "<b>Heading</b>"),
        ("- item", "• item"),
        ("[label](https://e.com)", '<a href="https://e.com">label</a>'),
    ],
)
def test_markdown_becomes_telegram_html(markdown: str, expected: str) -> None:
    assert _adapter().translate_outbound(markdown) == expected


def test_html_characters_in_the_body_are_escaped() -> None:
    # Otherwise Telegram reads them as markup and rejects the whole message.
    assert _adapter().translate_outbound("a < b & c") == "a &lt; b &amp; c"


def test_code_contents_are_never_treated_as_markup() -> None:
    adapter = _adapter()

    rendered = adapter.translate_outbound("```py\nif a < b and *x*:\n```")

    assert rendered == "<pre>if a &lt; b and *x*:</pre>"


def test_a_url_is_escaped_once_not_twice() -> None:
    adapter = _adapter()

    rendered = adapter.translate_outbound("[x](https://e.com?a=1&b=2)")

    assert rendered == '<a href="https://e.com?a=1&amp;b=2">x</a>'


def test_a_table_is_left_as_written() -> None:
    # Telegram cannot render tables; mangling one helps nobody.
    adapter = _adapter()
    table = "| a | b |\n| - | - |"

    assert adapter.translate_outbound(table) == table


def test_a_known_person_is_mentioned_by_id() -> None:
    adapter = _adapter()
    adapter.prime_mention_targets({"alice": "12345"})

    rendered = adapter.translate_outbound("ping @alice")

    assert rendered == 'ping <a href="tg://user?id=12345">@alice</a>'


def test_an_unknown_name_stays_plain_so_the_client_can_link_it() -> None:
    adapter = _adapter()

    assert adapter.translate_outbound("ping @bob") == "ping @bob"


def test_an_agent_name_is_not_turned_into_a_mention() -> None:
    # Agents are not Telegram users; linking them would go nowhere.
    adapter = _adapter()
    adapter.prime_mention_targets({"alice": "12345"})

    assert adapter.translate_outbound("@switch.cmcdermott") == "@switch.cmcdermott"


def test_priming_ignores_entries_that_are_not_numeric_ids() -> None:
    adapter = _adapter()

    adapter.prime_mention_targets({"alice": "not-an-id", "": "5"})

    assert adapter.translate_outbound("@alice") == "@alice"


def test_inbound_text_needs_no_rewriting() -> None:
    # Telegram already delivers @handle the way Switch expects.
    adapter = _adapter()

    assert adapter.translate_inbound("hi @alice") == "hi @alice"


# ── Lifecycle ────────────────────────────────────────────────────────────────


class _FakeUpdater:
    def __init__(self) -> None:
        self.polling_kwargs: dict[str, Any] | None = None
        self.stopped = False

    async def start_polling(self, **kwargs: Any) -> None:
        self.polling_kwargs = kwargs

    async def stop(self) -> None:
        self.stopped = True


class _FakeApplication:
    def __init__(
        self,
        *,
        can_read_all_group_messages: bool = True,
        can_join_groups: bool | None = None,
    ) -> None:
        self.bot = _FakeBot()
        self.updater = _FakeUpdater()
        self.handlers: list[Any] = []
        self.started = False
        self.shut_down = False
        self._can_read_all = can_read_all_group_messages
        # None leaves the field off getMe entirely, as an older Bot API would.
        self._can_join_groups = can_join_groups
        self.bot.get_me = self._get_me  # type: ignore[attr-defined]

    async def _get_me(self) -> Any:
        fields: dict[str, Any] = {
            "id": BOT_USER_ID,
            "username": BOT_USERNAME,
            "can_read_all_group_messages": self._can_read_all,
        }
        if self._can_join_groups is not None:
            fields["can_join_groups"] = self._can_join_groups
        return type("_Me", (), fields)()

    def add_handler(self, handler: Any) -> None:
        self.handlers.append(handler)

    async def initialize(self) -> None:
        self.initialized = True

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.started = False

    async def shutdown(self) -> None:
        self.shut_down = True


class _FakeBuilder:
    def __init__(self, app: _FakeApplication) -> None:
        self._app = app

    def token(self, _token: str) -> _FakeBuilder:
        return self

    def build(self) -> _FakeApplication:
        return self._app


async def _noop(_value: Any) -> None:
    return None


def test_starting_begins_polling_and_learns_the_bot_id() -> None:
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username=BOT_USERNAME)
    )
    app = _FakeApplication()

    with patch.object(adapter_module, "ApplicationBuilder", lambda: _FakeBuilder(app)):
        _run(adapter.start(_noop, _noop, _noop, _noop, _noop))

    assert app.started is True
    assert adapter._bot_user_id == BOT_USER_ID
    assert app.updater.polling_kwargs is not None
    assert app.updater.polling_kwargs["allowed_updates"] == [
        "message",
        "channel_post",
        "my_chat_member",
    ]


def test_a_second_poller_on_the_same_token_is_named(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Telegram hands each update to one getUpdates caller, so a leftover
    # deployment or a second replica quietly takes a share of the traffic:
    # outbound still works, inbound goes dead, and nothing says why unless the
    # Conflict is surfaced (CHOO-1686).
    with caplog.at_level(logging.ERROR):
        TelegramAdapter._on_polling_error(Conflict("terminated by other getUpdates"))

    assert "Another process is polling Telegram with this bot token" in caplog.text
    assert "missing inbound messages" in caplog.text


def test_other_polling_errors_are_reported_but_not_misdiagnosed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING):
        TelegramAdapter._on_polling_error(TelegramError("temporary network blip"))

    assert "temporary network blip" in caplog.text
    assert "Another process" not in caplog.text


def test_polling_installs_the_error_callback() -> None:
    # Without it the Conflict never reaches the log at all.
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username=BOT_USERNAME)
    )
    app = _FakeApplication()

    with patch.object(adapter_module, "ApplicationBuilder", lambda: _FakeBuilder(app)):
        _run(adapter.start(_noop, _noop, _noop, _noop, _noop))

    assert app.updater.polling_kwargs is not None
    assert "error_callback" in app.updater.polling_kwargs


def test_privacy_mode_on_is_not_reported_as_a_fault(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # BotFather enables it by default and it used to be logged as a warning,
    # but on its own it is not a fault: Telegram exempts a bot that is an
    # administrator of a chat, which is what the dashboard's install link
    # grants. Whether any one chat is readable is a per-chat question.
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username=BOT_USERNAME)
    )
    app = _FakeApplication(can_read_all_group_messages=False)

    with patch.object(adapter_module, "ApplicationBuilder", lambda: _FakeBuilder(app)):
        with caplog.at_level(logging.INFO):
            _run(adapter.start(_noop, _noop, _noop, _noop, _noop))

    assert "administrator" in caplog.text
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []
    # Still starts, and knows what it read.
    assert adapter._privacy_mode_disabled is False
    assert app.updater.polling_kwargs is not None


def test_privacy_mode_off_is_recorded_as_seeing_everything(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username=BOT_USERNAME)
    )
    app = _FakeApplication(can_read_all_group_messages=True)

    with patch.object(adapter_module, "ApplicationBuilder", lambda: _FakeBuilder(app)):
        with caplog.at_level(logging.INFO):
            _run(adapter.start(_noop, _noop, _noop, _noop, _noop))

    assert adapter._privacy_mode_disabled is True
    assert "sees all messages" in caplog.text


def test_stopping_shuts_the_application_down() -> None:
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username=BOT_USERNAME)
    )
    app = _FakeApplication()

    with patch.object(adapter_module, "ApplicationBuilder", lambda: _FakeBuilder(app)):
        _run(adapter.start(_noop, _noop, _noop, _noop, _noop))
    _run(adapter.stop())

    assert app.updater.stopped is True
    assert app.shut_down is True
    assert adapter._bot is None


def test_sending_before_the_bridge_is_connected_fails_loudly() -> None:
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username=BOT_USERNAME)
    )

    with pytest.raises(RuntimeError, match="not connected"):
        _run(adapter.send_message(str(CHAT_ID), "scout", "hello"))


class _FakeMedia:
    def __init__(
        self, file_id: str, *, name: str | None = None, mime: str | None = None
    ) -> None:
        self.file_id = file_id
        self.file_name = name
        self.mime_type = mime
        self.file_size = 4


@pytest.mark.parametrize(
    ("field", "filename", "mimetype"),
    [
        ("video", "video.mp4", "video/mp4"),
        ("animation", "animation.mp4", "video/mp4"),
        ("audio", "audio.mp3", "audio/mpeg"),
        ("voice", "voice.ogg", "audio/ogg"),
        ("video_note", "video_note.mp4", "video/mp4"),
    ],
)
def test_every_media_kind_is_relayed(field: str, filename: str, mimetype: str) -> None:
    # Telegram models each kind as its own field rather than one attachments
    # list, so a kind missing from the loop is simply never relayed.
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)
    _bot(adapter).files["m1"] = _FakeFileHandle(b"media")

    _run(
        adapter._handle_message(
            _FakeInbound(text=None, caption="look", **{field: _FakeMedia("m1")})
        )
    )

    assert [a.filename for a in seen[0].attachments] == [filename]
    assert seen[0].attachments[0].mimetype == mimetype


def test_media_keeps_its_own_name_and_type_when_telegram_supplies_them() -> None:
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)
    _bot(adapter).files["m1"] = _FakeFileHandle(b"media")

    _run(
        adapter._handle_message(
            _FakeInbound(
                text=None,
                caption="clip",
                video=_FakeMedia("m1", name="demo.mov", mime="video/quicktime"),
            )
        )
    )

    assert seen[0].attachments[0].filename == "demo.mov"
    assert seen[0].attachments[0].mimetype == "video/quicktime"


@pytest.mark.parametrize(
    "field",
    ["left_chat_member", "new_chat_title", "pinned_message", "group_chat_created"],
)
def test_service_messages_are_not_bridged_as_empty_messages(field: str) -> None:
    # A service message has a real sender and no body. Telegram has no empty
    # user message, so relaying one puts a blank line in the room (CHOO-1686).
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(adapter._handle_message(_FakeInbound(text=None, **{field: object()})))

    assert seen == []


def test_a_photo_with_no_caption_is_still_bridged() -> None:
    # The service-message guard keys on there being nothing at all to relay, so
    # it must not swallow a wordless image.
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)
    _bot(adapter).files["p1"] = _FakeFileHandle(b"img")

    _run(
        adapter._handle_message(
            _FakeInbound(text=None, photo=[_FakePhotoSize("p1", "u1", 4)])
        )
    )

    assert len(seen) == 1
    assert seen[0].content == ""
    assert len(seen[0].attachments) == 1


def test_an_undownloadable_attachment_is_still_bridged_as_a_failure() -> None:
    # Disclosure beats silence: the guard must not treat "only failures" as a
    # service message and drop the disclosure with it.
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)
    _bot(adapter).files["d1"] = _FakeFileHandle(b"", fail=True)

    _run(
        adapter._handle_message(
            _FakeInbound(text=None, document=_FakeDocument("d1", "x.bin", None, 4))
        )
    )

    assert len(seen) == 1
    assert seen[0].attachment_failures[0].filename == "x.bin"


def test_a_forum_topic_message_belongs_to_the_chat_not_the_topic() -> None:
    # The topic id is the thread root; the room is still keyed on the chat.
    adapter = _adapter()
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    _run(adapter._handle_message(_FakeInbound(message_thread_id=88)))

    assert seen[0].channel_id == str(CHAT_ID)
    assert seen[0].root_id == "88"


def test_the_dedupe_cache_evicts_oldest_first() -> None:
    # Unbounded growth would be a slow leak on a busy bridge; eviction is what
    # bounds it, and an evicted id must be able to bridge again.
    adapter = _adapter()
    adapter._seen_ids_max = 3
    seen: list[InboundMessage] = []
    adapter._on_message = lambda m: _collect(seen, m)

    for message_id in (1, 2, 3, 4):
        _run(adapter._handle_message(_FakeInbound(message_id=message_id)))

    assert len(adapter._seen_ids) == 3
    assert (str(CHAT_ID), 1) not in adapter._seen_ids

    _run(adapter._handle_message(_FakeInbound(message_id=1)))

    assert len(seen) == 5


def test_a_command_published_under_its_underscore_name_still_resolves() -> None:
    # Telegram will not register a hyphen, so the menu offers `/invite_agent`.
    adapter = _adapter()
    commands: list[InboundCommand] = []
    adapter._on_command = lambda c: _collect(commands, c)

    _run(adapter._handle_message(_FakeInbound(text="/invite_agent @scout")))

    assert commands[0].command == "invite-agent"
    assert commands[0].args == "@scout"


def test_the_bots_own_username_wins_over_a_configured_one(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Every t.me link is built from this name, and a name that is not the
    # bot's resolves to whatever account does own it — so the link opens a
    # chat with a stranger and reads as a link that did nothing. The token
    # says which bot this is; the configured name is a label someone typed.
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username="wrong_name")
    )
    app = _FakeApplication()

    with patch.object(adapter_module, "ApplicationBuilder", lambda: _FakeBuilder(app)):
        with caplog.at_level(logging.WARNING):
            _run(adapter.start(_noop, _noop, _noop, _noop, _noop))

    assert "wrong_name" in caplog.text
    assert BOT_USERNAME in caplog.text
    # Corrected everywhere a link is built from it, not just complained about.
    assert adapter._bot_username == BOT_USERNAME
    for link in _run(adapter.install_links()):
        assert f"t.me/{BOT_USERNAME}" in link.url
    assert _run(adapter.home_deeplink()) == f"https://t.me/{BOT_USERNAME}"


def test_groups_disabled_in_botfather_withholds_the_group_link(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Telegram answers an add-to-group link for such a bot by opening a chat
    # with it, which is indistinguishable from a broken link. Better to not
    # offer it and say why.
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username=BOT_USERNAME)
    )
    app = _FakeApplication(can_join_groups=False)

    with patch.object(adapter_module, "ApplicationBuilder", lambda: _FakeBuilder(app)):
        with caplog.at_level(logging.WARNING):
            _run(adapter.start(_noop, _noop, _noop, _noop, _noop))

    assert [link.key for link in _run(adapter.install_links())] == ["channel"]
    assert "Allow Groups" in caplog.text


def test_groups_are_assumed_allowed_when_the_bot_does_not_say() -> None:
    # BotFather's default, and an older Bot API that omits the field must not
    # be read as a refusal.
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username=BOT_USERNAME)
    )
    app = _FakeApplication()

    with patch.object(adapter_module, "ApplicationBuilder", lambda: _FakeBuilder(app)):
        _run(adapter.start(_noop, _noop, _noop, _noop, _noop))

    assert [link.key for link in _run(adapter.install_links())] == [
        "group",
        "channel",
    ]


def test_a_bad_token_fails_the_start_rather_than_running_deaf() -> None:
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="bad", bot_username=BOT_USERNAME)
    )
    app = _FakeApplication()

    async def _unauthorised() -> Any:
        raise TelegramError("Unauthorized")

    app.bot.get_me = _unauthorised  # type: ignore[attr-defined]

    with patch.object(adapter_module, "ApplicationBuilder", lambda: _FakeBuilder(app)):
        with pytest.raises(TelegramError, match="Unauthorized"):
            _run(adapter.start(_noop, _noop, _noop, _noop, _noop))

    assert app.updater.polling_kwargs is None


def test_an_application_without_an_updater_fails_loudly() -> None:
    # Polling is the only inbound path; an application that cannot poll would
    # otherwise send happily and receive nothing.
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username=BOT_USERNAME)
    )
    app = _FakeApplication()
    app.updater = None  # type: ignore[assignment]

    with patch.object(adapter_module, "ApplicationBuilder", lambda: _FakeBuilder(app)):
        with pytest.raises(RuntimeError, match="without an updater"):
            _run(adapter.start(_noop, _noop, _noop, _noop, _noop))


def test_the_command_menu_is_published_in_telegrams_spelling() -> None:
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username=BOT_USERNAME)
    )
    app = _FakeApplication()

    with patch.object(adapter_module, "ApplicationBuilder", lambda: _FakeBuilder(app)):
        _run(adapter.start(_noop, _noop, _noop, _noop, _noop))

    published = {c.command for c in app.bot.published_commands}
    assert "invite_agent" in published
    assert not any("-" in name for name in published)


def test_a_menu_telegram_rejects_does_not_stop_the_bridge(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # The bridge is fully usable without the menu; refusing to start over it
    # would be a far worse outcome.
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username=BOT_USERNAME)
    )
    app = _FakeApplication()

    async def _reject(_commands: Any) -> None:
        raise TelegramError("bad menu")

    app.bot.set_my_commands = _reject  # type: ignore[attr-defined]

    with patch.object(adapter_module, "ApplicationBuilder", lambda: _FakeBuilder(app)):
        with caplog.at_level(logging.ERROR):
            _run(adapter.start(_noop, _noop, _noop, _noop, _noop))

    assert "Could not publish the Telegram command menu" in caplog.text
    assert app.updater.polling_kwargs is not None


def test_a_mention_inside_a_link_does_not_nest_anchors() -> None:
    # Rewriting an `@name` that sits in a link's label or target produced an
    # anchor inside an anchor, which Telegram rejects — and a caption or an edit
    # has no plain-text retry to save it (CHOO-1686).
    adapter = _adapter()
    adapter.prime_mention_targets({"alice": "555"})

    assert (
        adapter.translate_outbound("[profile](https://x.com/@alice)")
        == '<a href="https://x.com/@alice">profile</a>'
    )
    assert (
        adapter.translate_outbound("[ping @alice](https://x.com)")
        == '<a href="https://x.com">ping @alice</a>'
    )


def test_formatting_inside_a_link_label_still_renders() -> None:
    adapter = _adapter()

    assert (
        adapter.translate_outbound("[**bold** link](https://e.com)")
        == '<a href="https://e.com"><b>bold</b> link</a>'
    )


def test_a_mention_outside_a_link_is_still_rendered() -> None:
    adapter = _adapter()
    adapter.prime_mention_targets({"alice": "555"})

    assert (
        adapter.translate_outbound("hi @alice")
        == 'hi <a href="tg://user?id=555">@alice</a>'
    )


def test_unmatched_brackets_do_not_stall_the_bridge() -> None:
    # `[` inside the link label's character class made the matcher retry the
    # whole tail from every position: 200k characters of unmatched brackets —
    # a pasted log, a changelog of `[FIX]` lines — blocked the event loop for
    # about thirteen seconds, and served as a denial of service.
    import time

    adapter = _adapter()
    body = "[unclosed " * 20_000

    started = time.monotonic()
    adapter.translate_outbound(body)

    assert time.monotonic() - started < 1.0


def test_an_over_long_edit_is_cut_to_valid_markup() -> None:
    # An edit cannot be split across messages the way a send can, and cutting
    # the rendered HTML by character count left it ending mid-attribute — which
    # Telegram rejects, losing the edit entirely.
    adapter = _adapter()
    rendered = adapter.translate_outbound("**" + "word " * 1500 + "**")

    clamped = adapter._clamp(rendered)

    assert len(clamped) <= 4096
    assert clamped.count("<b>") == clamped.count("</b>")


def test_an_edit_telegram_will_not_parse_is_resent_unformatted() -> None:
    # Without this the status message silently stays stale for good.
    adapter = _adapter()
    calls: list[dict[str, Any]] = []

    async def _edit(**kwargs: Any) -> None:
        calls.append(kwargs)
        if len(calls) == 1:
            raise BadRequest("Can't parse entities: bad tag")

    _bot(adapter).edit_message_text = _edit  # type: ignore[method-assign]

    _run(adapter.update_message(str(CHAT_ID), f"{CHAT_ID}:501", "<b>oops</unclosed>"))

    assert len(calls) == 2
    assert "parse_mode" not in calls[1]
    assert "<" not in calls[1]["text"]


def test_two_people_with_the_same_display_name_stay_distinct() -> None:
    # Stripping spaces makes collisions likelier ("Ann Marie" and "AnnMarie"),
    # and two people sharing a handle would share a room identity — a mention
    # meant for one reaching whichever spoke last.
    adapter = _adapter()

    class _U:
        def __init__(self, user_id: int, first: str, last: str) -> None:
            self.id = user_id
            self.username = None
            self.first_name = first
            self.last_name = last

    assert adapter._display_name(_U(1, "Ann", "Marie")) != adapter._display_name(
        _U(2, "AnnMarie", "")
    )


def test_a_public_username_is_used_as_is() -> None:
    adapter = _adapter()

    assert adapter._display_name(_FakeUser(user_id=7, username="alice")) == "alice"


def test_the_underscore_spelling_is_only_translated_for_slash_commands() -> None:
    # `!` is Switch's own prefix and its names are spelled as the dispatcher
    # knows them, so rewriting there would turn a typo into another command.
    adapter = _adapter()

    assert adapter._parse_command("/list_agents") == ("list-agents", "")
    assert adapter._parse_command("!list_agents") == ("list_agents", "")
    assert adapter._parse_command("!list-agents") == ("list-agents", "")


# ── Install links ────────────────────────────────────────────────────────────


def test_the_group_install_link_asks_for_no_permissions() -> None:
    # The bridge needs none in a group: a bot posts and deletes its own
    # messages as an ordinary member. Asking to be an administrator bought
    # only an exemption from privacy mode, which turning Group Privacy off in
    # BotFather gives once per bot rather than once per group — and its chat
    # picker leaves out basic groups entirely (CHOO-1686).
    adapter = _adapter()

    links = {link.key: link for link in _run(adapter.install_links())}

    group = links["group"]
    assert group.url == (f"https://t.me/{BOT_USERNAME}?startgroup={_INSTALL_PAYLOAD}")
    assert "admin=" not in group.url


def test_no_group_link_asks_to_be_an_administrator() -> None:
    # A permission prompt is only as trustworthy as its contents, and the
    # honest count for a group is zero.
    adapter = _adapter()

    for link in _run(adapter.install_links()):
        if link.key.startswith("group"):
            assert "admin=" not in link.url


def test_the_channel_install_link_asks_for_what_posting_there_needs() -> None:
    # A channel is a broadcast chat: posting and editing are admin-only, so it
    # is the one link that does ask for rights, and they are named as such.
    adapter = _adapter()

    channel = next(
        link for link in _run(adapter.install_links()) if link.key == "channel"
    )

    assert "startchannel" in channel.url
    rights = channel.url.split("admin=", 1)[1].split("&", 1)[0].split("+")
    assert set(rights) == {"post_messages", "edit_messages", "delete_messages"}


def test_the_channel_link_says_its_picker_may_be_empty() -> None:
    # Its picker holds only channels the person administers, and most people
    # have none — Telegram then opens a chat with the bot, which reads as a
    # broken link unless the dialog has already said what to expect.
    adapter = _adapter()

    channel = next(
        link for link in _run(adapter.install_links()) if link.key == "channel"
    )

    assert "nothing to pick" in channel.description
    assert "not groups" in channel.description


def test_an_install_link_carries_no_credential() -> None:
    # It is handed to the operator's browser and then to Telegram.
    adapter = _adapter()

    for link in _run(adapter.install_links()):
        assert "token" not in link.url


# ── What the bridge can see in a chat ────────────────────────────────────────


def test_an_administrator_bot_sees_everything_despite_privacy_mode() -> None:
    # Telegram's own rule: "bot admins always receive all messages". This is
    # what makes the one-click install enough on its own.
    adapter = _adapter()
    adapter._privacy_mode_disabled = False
    _bot(adapter).member_status = "administrator"

    assert _run(adapter._chat_visibility(str(CHAT_ID))).status == "full"


def test_a_plain_member_bot_with_privacy_mode_on_is_mention_only() -> None:
    adapter = _adapter()
    adapter._privacy_mode_disabled = False
    _bot(adapter).member_status = "member"

    assert _run(adapter._chat_visibility(str(CHAT_ID))).status == "mention_only"


def test_a_plain_member_bot_with_privacy_mode_off_sees_everything() -> None:
    adapter = _adapter()
    adapter._privacy_mode_disabled = True
    _bot(adapter).member_status = "member"

    assert _run(adapter._chat_visibility(str(CHAT_ID))).status == "full"


def test_a_one_to_one_chat_is_always_fully_visible() -> None:
    # Privacy mode has never applied to private chats.
    adapter = _adapter()
    adapter._privacy_mode_disabled = False
    _bot(adapter).chat = _FakeChat(chat_type="private")

    assert _run(adapter._chat_visibility("7")).status == "full"


def test_visibility_is_unknown_rather_than_guessed_when_the_lookup_fails() -> None:
    adapter = _adapter()
    _bot(adapter).get_chat_member_error = TelegramError("no")

    assert _run(adapter._chat_visibility(str(CHAT_ID))).status == "unknown"


def test_a_mention_only_chat_is_told_so_in_the_chat() -> None:
    # Otherwise it is indistinguishable from agents ignoring people.
    adapter = _adapter()
    adapter._privacy_mode_disabled = False
    _bot(adapter).member_status = "member"

    _run(adapter.announce_visibility(str(CHAT_ID)))

    posted = _bot(adapter).messages[-1]["text"]
    assert "only see messages that tag me" in posted
    assert "administrator" in posted


def test_a_fully_visible_chat_is_not_told_anything() -> None:
    adapter = _adapter()
    _bot(adapter).member_status = "administrator"

    _run(adapter.announce_visibility(str(CHAT_ID)))

    assert _bot(adapter).messages == []


def test_the_visibility_notice_is_posted_once() -> None:
    adapter = _adapter()
    adapter._privacy_mode_disabled = False
    _bot(adapter).member_status = "member"

    _run(adapter.announce_visibility(str(CHAT_ID)))
    _run(adapter.announce_visibility(str(CHAT_ID)))

    assert len(_bot(adapter).messages) == 1


def test_an_undetermined_visibility_says_nothing_and_stays_undetermined() -> None:
    # Claiming either way from a failed lookup would be worse than silence, and
    # the chat must not be marked as told — the next check should try again.
    adapter = _adapter()
    _bot(adapter).get_chat_member_error = TelegramError("no")

    _run(adapter.announce_visibility(str(CHAT_ID)))

    assert _bot(adapter).messages == []
    assert str(CHAT_ID) not in adapter._visibility_announced


def test_startup_audit_warns_for_each_mention_only_chat(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Logged, not posted: a restart must not repost a notice in every chat.
    adapter = _adapter()
    adapter._privacy_mode_disabled = False
    _bot(adapter).member_status = "member"

    with caplog.at_level(logging.WARNING):
        _run(
            adapter.ensure_channel_subscriptions(
                [(str(CHAT_ID), "channel_private"), ("7", "lobby")]
            )
        )

    assert str(CHAT_ID) in caplog.text
    assert _bot(adapter).messages == []


def test_startup_audit_is_quiet_when_every_chat_is_visible(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _adapter()
    _bot(adapter).member_status = "administrator"

    with caplog.at_level(logging.WARNING):
        _run(adapter.ensure_channel_subscriptions([(str(CHAT_ID), "channel_private")]))

    assert caplog.text == ""


# ── Telegram's own /start handshake ──────────────────────────────────────────


def test_the_install_handshake_is_absorbed_rather_than_bridged() -> None:
    # Adding the bot via ?startgroup=<payload> makes Telegram send the bot
    # `/start@bot <payload>`. That is the platform greeting the bot, not
    # somebody running a Switch command.
    adapter = _adapter()
    commands: list[InboundCommand] = []
    messages: list[InboundMessage] = []
    adapter._on_command = lambda c: _collect(commands, c)
    adapter._on_message = lambda m: _collect(messages, m)
    _bot(adapter).member_status = "administrator"

    _run(adapter._handle_message(_FakeInbound(text=f"/start@{BOT_USERNAME} switch")))

    assert commands == []
    assert messages == []


def test_the_install_handshake_reports_where_the_chat_came_from(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _adapter()
    _bot(adapter).member_status = "administrator"

    with caplog.at_level(logging.INFO):
        _run(adapter._handle_message(_FakeInbound(text="/start switch")))

    assert "install link" in caplog.text


def test_the_install_handshake_reports_a_chat_it_cannot_read() -> None:
    # The one moment the operator is looking at the chat, so a mention-only
    # install says so there and then.
    adapter = _adapter()
    adapter._privacy_mode_disabled = False
    _bot(adapter).member_status = "member"

    _run(adapter._handle_message(_FakeInbound(text="/start switch")))

    assert "only see messages that tag me" in _bot(adapter).messages[-1]["text"]


def test_a_bare_start_in_a_group_is_absorbed_too() -> None:
    # A bot added by hand gets one as well, and it is no more a Switch command
    # there than it is after an install link.
    adapter = _adapter()
    commands: list[InboundCommand] = []
    adapter._on_command = lambda c: _collect(commands, c)
    _bot(adapter).member_status = "administrator"

    _run(adapter._handle_message(_FakeInbound(text="/start")))

    assert commands == []


def test_a_bare_start_in_a_one_to_one_chat_is_left_alone() -> None:
    # It is how a person opens a conversation with the bot; swallowing it would
    # leave the DM unbridged until they typed again.
    adapter = _adapter()
    commands: list[InboundCommand] = []
    adapter._on_command = lambda c: _collect(commands, c)
    private = _FakeChat(chat_id=7, chat_type="private", title=None)

    _run(adapter._handle_message(_FakeInbound(chat=private, text="/start")))

    assert [c.command for c in commands] == ["start"]


def test_an_ordinary_command_is_still_dispatched() -> None:
    adapter = _adapter()
    commands: list[InboundCommand] = []
    adapter._on_command = lambda c: _collect(commands, c)

    _run(adapter._handle_message(_FakeInbound(text="/list-agents")))

    assert [c.command for c in commands] == ["list-agents"]


def test_administrator_status_is_reported_as_the_conclusive_answer() -> None:
    # The global privacy flag is not conclusive — Telegram only reads it when
    # the bot joins — so callers that can act on the difference need to know
    # which of the two settled it.
    adapter = _adapter()
    adapter._privacy_mode_disabled = True
    _bot(adapter).member_status = "administrator"

    assert _run(adapter._chat_visibility(str(CHAT_ID))).via_admin is True


def test_the_chat_creator_counts_as_an_administrator() -> None:
    adapter = _adapter()
    adapter._privacy_mode_disabled = False
    _bot(adapter).member_status = "creator"

    visibility = _run(adapter._chat_visibility(str(CHAT_ID)))
    assert visibility.status == "full"
    assert visibility.via_admin is True


def test_full_visibility_from_the_global_setting_alone_is_not_conclusive() -> None:
    adapter = _adapter()
    adapter._privacy_mode_disabled = True
    _bot(adapter).member_status = "member"

    assert _run(adapter._chat_visibility(str(CHAT_ID))).via_admin is False


def test_promoting_the_bot_retracts_the_mention_only_warning() -> None:
    # The documented way to upgrade a chat. Without this the warning stands
    # forever and nothing confirms the promotion worked.
    adapter = _adapter()
    adapter._privacy_mode_disabled = False
    _bot(adapter).member_status = "member"
    _run(adapter.announce_visibility(str(CHAT_ID)))

    _bot(adapter).member_status = "administrator"
    _run(adapter.announce_visibility(str(CHAT_ID)))

    assert "whole conversation here now" in _bot(adapter).messages[-1]["text"]


def test_demoting_the_bot_says_what_was_lost() -> None:
    adapter = _adapter()
    adapter._privacy_mode_disabled = False
    _bot(adapter).member_status = "administrator"
    _run(adapter.announce_visibility(str(CHAT_ID)))
    assert _bot(adapter).messages == []

    _bot(adapter).member_status = "member"
    _run(adapter.announce_visibility(str(CHAT_ID)))

    assert "only see messages that tag me" in _bot(adapter).messages[-1]["text"]


def test_a_chat_that_was_already_visible_is_not_congratulated() -> None:
    # Only a change is worth saying. A first look that finds everything in
    # order stays quiet.
    adapter = _adapter()
    _bot(adapter).member_status = "administrator"

    _run(adapter.announce_visibility(str(CHAT_ID)))
    _run(adapter.announce_visibility(str(CHAT_ID)))

    assert _bot(adapter).messages == []


def test_startup_audit_names_a_chat_it_is_taking_on_trust(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Privacy mode off, but the bot is not an admin here: Telegram reads that
    # setting at join time and no API call says which value this chat got. If
    # the bot predates the change it is still being filtered, and this is the
    # only line anywhere that says so.
    adapter = _adapter()
    adapter._privacy_mode_disabled = True
    _bot(adapter).member_status = "member"

    with caplog.at_level(logging.INFO):
        _run(adapter.ensure_channel_subscriptions([(str(CHAT_ID), "channel_private")]))

    assert "add it back" in caplog.text
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


def test_an_administrator_chat_is_audited_without_caveat(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _adapter()
    adapter._privacy_mode_disabled = False
    _bot(adapter).member_status = "administrator"

    with caplog.at_level(logging.INFO):
        _run(adapter.ensure_channel_subscriptions([(str(CHAT_ID), "channel_private")]))

    assert caplog.text == ""


def test_being_added_by_hand_still_discloses_a_mention_only_chat() -> None:
    # The route with no install link behind it, and the one most likely to be
    # mention-only. The notice must not depend on the /start handshake.
    adapter = _adapter()
    adapter._privacy_mode_disabled = False
    _bot(adapter).member_status = "member"
    joins: list[Any] = []
    adapter._on_app_joined = lambda j: _collect(joins, j)

    _run(
        adapter._handle_my_chat_member(
            _FakeChatMemberUpdate(_FakeChat(), status="member")
        )
    )

    assert [j.channel_id for j in joins] == [str(CHAT_ID)]
    # After provisioning: a notice about a room that does not exist yet would
    # point at nothing.
    assert "only see messages that tag me" in _bot(adapter).messages[-1]["text"]


def test_a_chat_reissued_a_new_id_is_re_assessed() -> None:
    # The new id is a different chat as far as Telegram is concerned, so
    # anything said about the old one no longer holds.
    adapter = _adapter()
    adapter._visibility_announced[str(CHAT_ID)] = "mention_only"
    adapter.set_channel_migration_handler(lambda old, new: _noop_migration())

    _run(adapter._repoint(str(CHAT_ID), "-1009876543210"))

    assert str(CHAT_ID) not in adapter._visibility_announced


async def _noop_migration() -> None:
    return None


def test_a_bridge_with_no_bot_username_offers_no_install_link() -> None:
    # The links are built from it; without one there is nothing to point at.
    adapter = _adapter()
    adapter._bot_username = ""

    assert _run(adapter.install_links()) == []


def test_the_group_link_lists_every_group() -> None:
    # The `admin=` form's picker lists only groups the person already
    # administers, which excludes a basic group — so it could offer nothing to
    # pick, and Telegram then opens a chat with the bot, reading as a broken
    # link. The plain form lists every group the person can add a member to.
    adapter = _adapter()

    links = {link.key: link for link in _run(adapter.install_links())}

    assert "group" in links
    assert links["group"].url.endswith(f"?startgroup={_INSTALL_PAYLOAD}")


def test_the_group_link_says_no_permissions_are_needed() -> None:
    # The operator is about to confirm a dialog; what it will and will not ask
    # for is the useful thing to know beforehand.
    adapter = _adapter()

    group = next(link for link in _run(adapter.install_links()) if link.key == "group")

    assert "no permissions" in group.description


def test_the_group_link_goes_when_groups_are_barred() -> None:
    adapter = _adapter()
    adapter._can_join_groups = False

    assert [link.key for link in _run(adapter.install_links())] == ["channel"]
