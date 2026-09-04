"""A client records every kind of send, and records nothing it did not send.

The recorder is only as good as the set of sends that reach it. Messages,
media and custom events each take a different route out of `ClientBase`, so
each is checked here rather than trusting that instrumenting one instrumented
the others.

The negative cases carry as much weight. A row for a message the transport
rejected would be a record of something that never happened, which is worse
than no record at all.
"""

from __future__ import annotations

import pytest

from switch_core.clients.client_base import ClientBase, ClientConfig
from switch_core.transport import TransportError
from tests.switch_core.transport.fake import FakeMessageRecorder, FakeTransport


def _client(
    transport: FakeTransport,
) -> tuple[ClientBase[ClientConfig], FakeMessageRecorder]:
    recorder = FakeMessageRecorder()
    client: ClientBase[ClientConfig] = object.__new__(ClientBase)
    client.transport = transport
    client.message_recorder = recorder
    client.matrix_user_id = "@agent:test"
    client.client_id = "client-1"
    client.display_name = "agent one"
    return client, recorder


class TestEverySendIsRecorded:
    async def test_a_message(self) -> None:
        transport = FakeTransport()
        client, recorder = _client(transport)

        event_id = await client.send_message("!room:test", "hello")

        assert len(recorder.recorded) == 1
        recorded = recorder.recorded[0]
        assert recorded["transport_room_id"] == "!room:test"
        assert recorded["result"].event_id == event_id
        assert recorded["result"].content["body"] == "hello"
        assert recorded["sender_matrix_id"] == "@agent:test"
        assert recorded["sender_client_id"] == "client-1"
        assert recorded["sender_name"] == "agent one"

    async def test_a_custom_event(self) -> None:
        transport = FakeTransport()
        client, recorder = _client(transport)

        event_id = await client.send_event(
            "!room:test", "com.switch.command", {"command": "reset"}
        )

        assert len(recorder.recorded) == 1
        result = recorder.recorded[0]["result"]
        assert result.event_id == event_id
        assert result.event_type == "com.switch.command"
        assert result.content == {"command": "reset"}

    async def test_media(self) -> None:
        transport = FakeTransport()
        client, recorder = _client(transport)

        event_id = await client.send_media(
            "!room:test",
            "mxc://test/abc",
            "chart.png",
            "image/png",
            4096,
            msgtype="m.image",
        )

        assert len(recorder.recorded) == 1
        result = recorder.recorded[0]["result"]
        assert result.event_id == event_id
        assert result.content["url"] == "mxc://test/abc"

    async def test_what_is_recorded_is_what_the_transport_sent(self) -> None:
        """The recorder is handed the transport's own content dict.

        Reconstructing it at the client would drift from the transport the
        first time the wire format changed, and nothing would notice.
        """
        transport = FakeTransport()
        client, recorder = _client(transport)

        await client.send_message(
            "!room:test", "**bold**", format="markdown", thread_root_id="$root"
        )

        content = recorder.recorded[0]["result"].content
        assert content["m.relates_to"] == {
            "rel_type": "m.thread",
            "event_id": "$root",
        }


class TestNothingIsRecordedForASendThatFailed:
    async def test_a_failed_message(self) -> None:
        transport = FakeTransport(fail_send="homeserver said no")
        client, recorder = _client(transport)

        assert await client.send_message("!room:test", "hello") is None
        assert recorder.recorded == []

    async def test_a_failed_media_send(self) -> None:
        transport = FakeTransport(fail_send="homeserver said no")
        client, recorder = _client(transport)

        result = await client.send_media(
            "!room:test",
            "mxc://test/abc",
            "chart.png",
            "image/png",
            4096,
            msgtype="m.image",
        )

        assert result is None
        assert recorder.recorded == []

    async def test_a_failed_custom_event_raises_and_records_nothing(self) -> None:
        """Unlike a chat message, a custom event carries protocol state, so the
        caller is told rather than left to assume it landed."""
        transport = FakeTransport(fail_send="homeserver said no")
        client, recorder = _client(transport)

        with pytest.raises(TransportError):
            await client.send_event("!room:test", "com.switch.command", {})

        assert recorder.recorded == []
