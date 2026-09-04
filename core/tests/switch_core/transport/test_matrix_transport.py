from types import SimpleNamespace
from typing import Any

import pytest
from nio import RoomMessagesError, RoomSendError

from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.transport import (
    MessageTransport,
    TransportError,
    TransportHandlers,
)
from switch_core.transport.matrix import MatrixTransport


class _FakeNio:
    def __init__(self, *, send_result: Any = None, upload_result: Any = None) -> None:
        self._send_result = send_result or SimpleNamespace(event_id="$evt")
        self._upload_result = upload_result
        self.room_send_calls: list[tuple[str, str, dict]] = []
        self.typing_calls: list[tuple[str, bool]] = []
        self.callbacks: list[tuple[Any, Any]] = []
        self.response_callbacks: list[tuple[Any, Any]] = []
        self.access_token = "tok"

    async def room_send(self, room_id: str, event_type: str, content: dict) -> Any:
        self.room_send_calls.append((room_id, event_type, content))
        return self._send_result

    async def upload(self, **kwargs: Any) -> tuple[Any, None]:
        return self._upload_result, None

    async def room_typing(self, room_id: str, is_typing: bool) -> Any:
        self.typing_calls.append((room_id, is_typing))
        return SimpleNamespace()

    async def joined_rooms(self) -> Any:
        return SimpleNamespace(rooms=["!a:s"])

    async def join(self, room_id: str) -> Any:
        return SimpleNamespace(room_id=room_id)

    async def room_messages(self, room_id: str, start: str | None, limit: int) -> Any:
        return SimpleNamespace(chunk=["e1", "e2"], end="tok-2")

    def add_event_callback(self, cb: Any, kind: Any) -> None:
        self.callbacks.append((cb, kind))

    def add_response_callback(self, cb: Any, kind: Any) -> None:
        self.response_callbacks.append((cb, kind))


def _transport(nio: _FakeNio) -> MatrixTransport:
    return MatrixTransport(
        server_url="https://s",
        user_id="@a:s",
        password="pw",
        client=nio,
    )


def test_matrix_transport_satisfies_the_port() -> None:
    assert isinstance(_transport(_FakeNio()), MessageTransport)


async def test_send_message_returns_a_neutral_result() -> None:
    nio = _FakeNio()

    result = await _transport(nio).send_message("!r:s", "hi", sender_name="Alice")

    assert result.event_id == "$evt"
    room_id, event_type, content = nio.room_send_calls[0]
    assert (room_id, event_type) == ("!r:s", "m.room.message")
    assert content["body"] == "hi"
    assert content["sender_name"] == "Alice"


async def test_send_message_threads_via_a_pure_thread_relation() -> None:
    nio = _FakeNio()

    await _transport(nio).send_message(
        "!r:s", "hi", sender_name="Alice", thread_root_id="$root"
    )

    _, _, content = nio.room_send_calls[0]
    assert content["m.relates_to"] == {"rel_type": "m.thread", "event_id": "$root"}


async def test_send_message_raises_rather_than_returning_an_error() -> None:
    nio = _FakeNio(send_result=object.__new__(RoomSendError))
    nio._send_result.message = "nope"  # type: ignore[attr-defined]

    with pytest.raises(TransportError, match="nope"):
        await _transport(nio).send_message("!r:s", "hi", sender_name="Alice")


async def test_send_media_with_a_caption_keeps_the_filename_separate() -> None:
    # The rich-media-caption convention: body carries the caption, and the real
    # filename rides alongside so it is not lost.
    nio = _FakeNio()

    await _transport(nio).send_media(
        "!r:s",
        "mxc://s/abc",
        "cat.png",
        "image/png",
        5,
        sender_name="Alice",
        msgtype="m.image",
        caption="look at this",
    )

    _, _, content = nio.room_send_calls[0]
    assert content["body"] == "look at this"
    assert content["filename"] == "cat.png"
    assert content["url"] == "mxc://s/abc"
    assert content["info"] == {"mimetype": "image/png", "size": 5}


async def test_send_media_without_a_caption_uses_the_filename_as_body() -> None:
    nio = _FakeNio()

    await _transport(nio).send_media(
        "!r:s",
        "mxc://s/abc",
        "cat.png",
        "image/png",
        5,
        sender_name="Alice",
        msgtype="m.image",
    )

    _, _, content = nio.room_send_calls[0]
    assert content["body"] == "cat.png"
    # No caption means nothing to disambiguate, so no separate filename key.
    assert "filename" not in content


async def test_send_media_marks_a_multi_file_group() -> None:
    # Matrix has no multi-attachment event, so N files share a group id that
    # receivers coalesce back into one message.
    nio = _FakeNio()
    group = {"id": "g1", "index": 0, "total": 2}

    await _transport(nio).send_media(
        "!r:s",
        "mxc://s/abc",
        "cat.png",
        "image/png",
        5,
        sender_name="Alice",
        msgtype="m.image",
        group=group,
    )

    _, _, content = nio.room_send_calls[0]
    assert content[ATTACHMENT_GROUP_KEY] == group


async def test_send_event_carries_the_type_through() -> None:
    nio = _FakeNio()

    await _transport(nio).send_event("!r:s", "com.switch.task.accept", {"task_id": "t"})

    assert nio.room_send_calls[0][1] == "com.switch.task.accept"


async def test_read_history_returns_neutral_events_and_its_cursor() -> None:
    nio = _FakeNio()

    async def _chunk(*args: Any, **kwargs: Any) -> Any:
        return SimpleNamespace(
            chunk=[
                SimpleNamespace(
                    event_id="$1",
                    sender="@a:s",
                    server_timestamp=7,
                    body="hello",
                    source={"content": {"body": "hello"}},
                )
            ],
            end="tok-2",
        )

    nio.room_messages = _chunk  # type: ignore[assignment]

    page = await _transport(nio).read_history("!r:s", start=None, limit=10)

    assert page.next_token == "tok-2"
    assert [e.event_id for e in page.events] == ["$1"]
    # History arrives already converted, so callers never see a nio type.
    assert page.events[0].room_id == "!r:s"
    assert page.events[0].timestamp == 7


async def test_read_history_raises_on_failure() -> None:
    nio = _FakeNio()
    err = object.__new__(RoomMessagesError)
    err.message = "boom"  # type: ignore[attr-defined]

    async def _fail(*args: Any, **kwargs: Any) -> Any:
        return err

    nio.room_messages = _fail  # type: ignore[assignment]

    with pytest.raises(TransportError, match="boom"):
        await _transport(nio).read_history("!r:s", start=None, limit=10)


def test_register_handlers_binds_only_what_was_supplied() -> None:
    nio = _FakeNio()

    _transport(nio).register_handlers(TransportHandlers(on_message=lambda r, e: None))  # type: ignore[arg-type]

    assert len(nio.callbacks) == 1
    assert nio.response_callbacks == []


async def test_typing_is_best_effort() -> None:
    nio = _FakeNio()

    await _transport(nio).set_typing("!r:s", True)

    assert nio.typing_calls == [("!r:s", True)]
