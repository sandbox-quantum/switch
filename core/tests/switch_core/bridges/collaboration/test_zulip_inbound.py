"""What Zulip hands Switch: streams, topics, commands and files.

The event queue is the platform's whole inbound surface here, so the tests drive
`_handle_message` with the payload Zulip delivers and assert what the bridge
callbacks receive — which is the only thing the rest of Switch ever sees.
"""

from __future__ import annotations

import httpx

from switch_core.bridges.collaboration.zulip.adapter import (
    ZulipAdapter,
    ZulipConnectionConfig,
)
from switch_core.bridges.collaboration.zulip.http_client import ZulipClient


def _adapter(handler=None) -> ZulipAdapter:
    def default_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"result": "success", "msg": ""})

    adapter = ZulipAdapter(
        config=ZulipConnectionConfig(
            url="https://acme.zulipchat.com",
            email="switch-bot@acme.zulipchat.com",
            api_key="key",
        )
    )
    adapter._client = ZulipClient(
        url="https://acme.zulipchat.com",
        email="switch-bot@acme.zulipchat.com",
        api_key="key",
        transport=httpx.MockTransport(handler or default_handler),
    )
    adapter._bot_user_id = "9"
    adapter._stream_types["12"] = "channel_private"
    adapter._stream_names["12"] = "research"
    return adapter


def _message(**overrides: object) -> dict[str, object]:
    message: dict[str, object] = {
        "id": 101,
        "type": "stream",
        "stream_id": 12,
        "subject": "Plan",
        "sender_id": 7,
        "sender_full_name": "Ada Lovelace",
        "sender_email": "ada@acme.zulipchat.com",
        "content": "hello there",
        "attachments": [],
    }
    message.update(overrides)
    return message


async def _collect(adapter: ZulipAdapter) -> tuple[list, list]:
    messages: list = []
    commands: list = []

    async def on_message(message):  # noqa: ANN001 - mirrors the callback
        messages.append(message)

    async def on_command(command):  # noqa: ANN001
        commands.append(command)

    adapter._on_message = on_message
    adapter._on_command = on_command
    return messages, commands


async def test_a_stream_message_is_a_room_message_in_its_topic() -> None:
    adapter = _adapter()
    messages, _ = await _collect(adapter)

    await adapter._handle_message(_message())

    assert len(messages) == 1
    message = messages[0]
    assert message.channel_id == "12"
    assert message.channel_type == "channel_private"
    assert message.channel_name == "research"
    assert message.sender_id == "7"
    assert message.sender_name == "Ada Lovelace"
    assert message.message_ref == "101"
    # The topic is the thread both ways, so a reply lands back in it.
    assert message.root_id == "Plan"


async def test_a_message_in_the_default_topic_is_top_level() -> None:
    adapter = _adapter()
    messages, _ = await _collect(adapter)

    await adapter._handle_message(_message(subject="Switch"))

    assert messages[0].root_id is None


async def test_zulip_markup_is_translated_for_the_room() -> None:
    adapter = _adapter()
    messages, _ = await _collect(adapter)

    await adapter._handle_message(
        _message(content="@**Switch** look at #**Design>Colour** and @_**Ada**")
    )

    assert messages[0].content == "@Switch look at #Design > Colour and @Ada"


async def test_the_bots_own_posts_are_not_relayed() -> None:
    adapter = _adapter()
    messages, _ = await _collect(adapter)

    await adapter._handle_message(_message(sender_id=9))
    await adapter._handle_message(
        _message(sender_id=11, sender_email="SWITCH-BOT@acme.zulipchat.com")
    )

    assert messages == []


async def test_a_direct_message_is_not_a_room() -> None:
    # A Switch room is a stream; a conversation between two accounts has no
    # stream to belong to, so it is not guessed into one.
    adapter = _adapter()
    messages, _ = await _collect(adapter)

    await adapter._handle_message(_message(type="private", stream_id=None))

    assert messages == []


async def test_a_message_that_starts_with_a_bang_is_a_command() -> None:
    adapter = _adapter()
    messages, commands = await _collect(adapter)

    await adapter._handle_message(_message(content="!invite-agent archimedes"))

    assert messages == []
    assert len(commands) == 1
    assert commands[0].command == "invite-agent"
    assert commands[0].args == "archimedes"
    assert commands[0].message_ref == "101"
    assert commands[0].root_id == "Plan"


async def test_an_attachment_is_fetched_and_relayed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/user_uploads/2/ab/notes.txt"
        return httpx.Response(200, content=b"the notes")

    adapter = _adapter(handler)
    messages, _ = await _collect(adapter)

    await adapter._handle_message(
        _message(
            attachments=[
                {
                    "file_name": "notes.txt",
                    "file_size": 9,
                    "url": "/user_uploads/2/ab/notes.txt",
                    "mimetype": "text/plain; charset=utf-8",
                }
            ]
        )
    )

    attachment = messages[0].attachments[0]
    assert attachment.filename == "notes.txt"
    assert attachment.data == b"the notes"
    # The charset parameter comes off, so consumers comparing types match.
    assert attachment.mimetype == "text/plain"


async def test_an_oversize_file_is_refused_visibly_and_not_downloaded() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, content=b"x")

    adapter = _adapter(handler)
    adapter.set_max_attachment_bytes(4)
    messages, _ = await _collect(adapter)

    await adapter._handle_message(
        _message(
            attachments=[
                {
                    "file_name": "huge.bin",
                    "file_size": 5_000,
                    "url": "/user_uploads/2/huge.bin",
                    "mimetype": "application/octet-stream",
                }
            ]
        )
    )

    assert messages[0].attachments == []
    assert "huge.bin" in messages[0].attachment_failures[0].filename
    assert "over" in messages[0].attachment_failures[0].reason
    assert calls == []
