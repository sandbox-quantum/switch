from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from switch_core.bridges.agent.server_connectors.base import ConnectorReporter
from switch_core.bridges.agent.server_connectors.opencode.connector import (
    OpenCodeConnectionConfig,
    OpenCodeConnector,
)

SESSION_ID = "sess-1"
ROOM_ID = "room-1"


class _FakeReporter(ConnectorReporter):
    def __init__(self) -> None:
        self.messages: list[str] = []
        self.statuses: list[str] = []
        self.events: list[Any] = []

    async def send_message(self, room_id: str, content: str) -> None:
        self.messages.append(content)

    async def report_events(self, room_id: str, events: Any) -> None:
        self.events.extend(events)

    async def send_status(self, room_id: str, detail: str) -> None:
        self.statuses.append(detail)

    async def set_typing(self, room_id: str, is_typing: bool) -> None:
        pass


class _FakeClient:
    """Stands in for OpenCodeClient, replaying a scripted SSE event stream."""

    def __init__(self, events: list[dict[str, Any]]) -> None:
        self._events = events
        self.permission_responses: list[tuple[str, str, str]] = []

    @asynccontextmanager
    async def subscribe_events(self) -> AsyncIterator[AsyncIterator[dict[str, Any]]]:
        async def _gen() -> AsyncIterator[dict[str, Any]]:
            for event in self._events:
                yield event

        yield _gen()

    async def respond_permission(
        self, session_id: str, permission_id: str, response: str
    ) -> None:
        self.permission_responses.append((session_id, permission_id, response))


class _FailingPermissionClient(_FakeClient):
    """A client whose permission reply always fails."""

    async def respond_permission(
        self, session_id: str, permission_id: str, response: str
    ) -> None:
        raise RuntimeError("opencode unreachable")


def _connector_with(
    events: list[dict[str, Any]],
    client: _FakeClient | None = None,
) -> tuple[OpenCodeConnector, _FakeClient]:
    config = OpenCodeConnectionConfig(
        server_url="http://localhost", username="u", password="p"
    )
    connector = OpenCodeConnector(config)
    client = client or _FakeClient(events)
    connector._client = client  # type: ignore[assignment]
    return connector, client


async def test_permission_request_is_auto_approved() -> None:
    events = [
        {
            "type": "permission.updated",
            "properties": {
                "id": "perm-1",
                "sessionID": SESSION_ID,
                "type": "bash",
            },
        },
        {"type": "session.idle", "properties": {"sessionID": SESSION_ID}},
    ]
    connector, client = _connector_with(events)
    reporter = _FakeReporter()

    await connector._stream_response(SESSION_ID, ROOM_ID, reporter)

    assert client.permission_responses == [(SESSION_ID, "perm-1", "always")]


async def test_permission_for_other_session_is_ignored() -> None:
    events = [
        {
            "type": "permission.updated",
            "properties": {"id": "perm-x", "sessionID": "other-session"},
        },
        {"type": "session.idle", "properties": {"sessionID": SESSION_ID}},
    ]
    connector, client = _connector_with(events)

    await connector._stream_response(SESSION_ID, ROOM_ID, _FakeReporter())

    assert client.permission_responses == []


async def test_permission_responded_only_once() -> None:
    perm = {
        "type": "permission.updated",
        "properties": {"id": "perm-1", "sessionID": SESSION_ID},
    }
    events = [
        perm,
        perm,
        {"type": "session.idle", "properties": {"sessionID": SESSION_ID}},
    ]
    connector, client = _connector_with(events)

    await connector._stream_response(SESSION_ID, ROOM_ID, _FakeReporter())

    assert client.permission_responses == [(SESSION_ID, "perm-1", "always")]


async def test_permission_event_read_from_data_key() -> None:
    """Some OpenCode builds carry the payload under `data` rather than `properties`."""
    events = [
        {
            "type": "permission.updated",
            "data": {"id": "perm-1", "sessionID": SESSION_ID},
        },
        {"type": "session.idle", "properties": {"sessionID": SESSION_ID}},
    ]
    connector, client = _connector_with(events)

    await connector._stream_response(SESSION_ID, ROOM_ID, _FakeReporter())

    assert client.permission_responses == [(SESSION_ID, "perm-1", "always")]


async def test_permission_reply_failure_does_not_break_the_stream() -> None:
    events = [
        {
            "type": "permission.updated",
            "properties": {"id": "perm-1", "sessionID": SESSION_ID},
        },
        {
            "type": "message.part.updated",
            "properties": {
                "sessionID": SESSION_ID,
                "part": {
                    "type": "text",
                    "id": "text-1",
                    "text": "done",
                    "time": {"end": 1},
                },
            },
        },
        {"type": "session.idle", "properties": {"sessionID": SESSION_ID}},
    ]
    connector, _ = _connector_with(events, client=_FailingPermissionClient(events))
    reporter = _FakeReporter()

    await connector._stream_response(SESSION_ID, ROOM_ID, reporter)

    assert reporter.messages == ["done"]


async def test_text_part_still_relayed_after_permission() -> None:
    events = [
        {
            "type": "permission.updated",
            "properties": {"id": "perm-1", "sessionID": SESSION_ID},
        },
        {
            "type": "message.part.updated",
            "properties": {
                "sessionID": SESSION_ID,
                "part": {
                    "type": "text",
                    "id": "text-1",
                    "text": "done",
                    "time": {"end": 1},
                },
            },
        },
        {"type": "session.idle", "properties": {"sessionID": SESSION_ID}},
    ]
    connector, client = _connector_with(events)
    reporter = _FakeReporter()

    await connector._stream_response(SESSION_ID, ROOM_ID, reporter)

    assert client.permission_responses == [(SESSION_ID, "perm-1", "always")]
    assert reporter.messages == ["done"]
