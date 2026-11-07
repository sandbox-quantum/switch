"""Restart recovery (catch-up on unread, mark-read-after-delivery) and the
several-pods lease contract (`keeps_quiet_unless_listening`) — the two
things that make "a restart loses and duplicates nothing" true.

Against a fake client (no HTTP): `_catch_up` and `_run`'s queue-expiry path
only call a handful of named methods, so a duck-typed fake exercises the
real adapter code exactly as the live test does, without a server.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from switch_core.bridges.collaboration.zulip.adapter import (
    ZulipAdapter,
    ZulipConnectionConfig,
)
from switch_core.bridges.collaboration.zulip.client import (
    BadEventQueueId,
    RegisteredQueue,
)
from switch_core.outbound import OutboundPolicy

_PERMISSIVE_POLICY = OutboundPolicy(allowed_hostnames=frozenset(), allowed_networks=())


def _config() -> ZulipConnectionConfig:
    return ZulipConnectionConfig(
        site="https://example.zulipchat.com",
        bot_email="bot@example.com",
        api_key="s3cret",
    )


def _message(msg_id: int, content: str = "hi") -> dict:
    return {
        "id": msg_id,
        "sender_id": 2,
        "sender_full_name": "Alice",
        "content": content,
        "type": "stream",
        "stream_id": 7,
        "subject": "general",
    }


class _FakeCatchUpClient:
    """Serves one page of unread messages, then none — like a real server
    once the bot has caught up. Records every `mark_read` call so a test
    can assert messages are marked read only after delivery."""

    def __init__(self, pages: list[list[dict]]) -> None:
        self._pages = pages
        self.marked_read: list[list[int]] = []

    async def get_unread_messages(self, *, anchor, num_after: int):
        if not self._pages:
            return [], True
        page = self._pages.pop(0)
        found_newest = not self._pages
        return page, found_newest

    async def mark_read(self, message_ids: list[int]) -> None:
        self.marked_read.append(list(message_ids))


async def test_catch_up_delivers_every_unread_message_oldest_first() -> None:
    adapter = ZulipAdapter(config=_config())
    adapter._bot_user_id = 99
    delivered: list[int] = []
    adapter._on_message = lambda msg: delivered.append(int(msg.message_ref))  # type: ignore[assignment]

    async def record(msg) -> None:
        delivered.append(int(msg.message_ref))

    adapter._on_message = record
    client = _FakeCatchUpClient([[_message(1), _message(2)], [_message(3)]])
    await adapter._catch_up(client)  # type: ignore[arg-type]
    assert delivered == [1, 2, 3]


async def test_catch_up_marks_messages_read_only_after_delivering_them() -> None:
    adapter = ZulipAdapter(config=_config())
    adapter._bot_user_id = 99
    order: list[str] = []

    async def record(msg) -> None:
        order.append(f"delivered:{msg.message_ref}")

    adapter._on_message = record
    client = _FakeCatchUpClient([[_message(1), _message(2)]])
    # Wrap mark_read to observe ordering relative to delivery.
    original_mark_read = client.mark_read

    async def tracked_mark_read(ids: list[int]) -> None:
        order.append(f"marked_read:{ids}")
        await original_mark_read(ids)

    client.mark_read = tracked_mark_read  # type: ignore[method-assign]
    await adapter._catch_up(client)  # type: ignore[arg-type]
    assert order == ["delivered:1", "delivered:2", "marked_read:[1, 2]"]


async def test_catch_up_paginates_using_the_last_messages_id_as_the_next_anchor() -> (
    None
):
    adapter = ZulipAdapter(config=_config())
    adapter._bot_user_id = 99
    adapter._on_message = lambda msg: None  # type: ignore[assignment]

    async def ignore(msg) -> None:
        return None

    adapter._on_message = ignore
    client = _FakeCatchUpClient([[_message(1), _message(2)], [_message(3)]])
    seen_anchors: list[object] = []
    original = client.get_unread_messages

    async def tracked(*, anchor, num_after):
        seen_anchors.append(anchor)
        return await original(anchor=anchor, num_after=num_after)

    client.get_unread_messages = tracked  # type: ignore[method-assign]
    await adapter._catch_up(client)  # type: ignore[arg-type]
    assert seen_anchors == ["oldest", 2]


async def test_catch_up_with_nothing_unread_delivers_nothing() -> None:
    adapter = ZulipAdapter(config=_config())
    adapter._bot_user_id = 99
    delivered = []

    async def record(msg) -> None:
        delivered.append(msg)

    adapter._on_message = record
    client = _FakeCatchUpClient([])
    await adapter._catch_up(client)  # type: ignore[arg-type]
    assert delivered == []


# ── Queue expiry mid-run ─────────────────────────────────────────────────


class _ExpiringThenOkClient:
    """`get_events` raises BAD_EVENT_QUEUE_ID exactly once, then the loop is
    cancelled — enough to prove `_run` re-registers and catches up again
    rather than giving up."""

    def __init__(self) -> None:
        self.register_calls = 0
        self.catch_up_calls = 0

    async def get_unread_messages(self, *, anchor, num_after: int):
        self.catch_up_calls += 1
        return [], True

    async def mark_read(self, message_ids: list[int]) -> None:
        return None

    async def register_queue(self) -> RegisteredQueue:
        self.register_calls += 1
        return RegisteredQueue(
            queue_id=f"q{self.register_calls}",
            last_event_id=-1,
            max_message_length=10000,
            max_file_upload_size_mib=25,
        )

    async def get_events(self, *, queue_id: str, last_event_id: int):
        if self.register_calls == 1:
            raise BadEventQueueId("BAD_EVENT_QUEUE_ID", "expired", status_code=400)
        raise asyncio.CancelledError()


async def test_a_bad_event_queue_id_re_registers_and_catches_up_again() -> None:
    adapter = ZulipAdapter(config=_config())
    adapter._bot_user_id = 99
    client = _ExpiringThenOkClient()
    adapter._client = client  # type: ignore[assignment]
    with pytest.raises(asyncio.CancelledError):
        await adapter._run()
    assert client.register_calls == 2
    assert client.catch_up_calls == 2


# ── Several pods: quiet copy opens no queue ──────────────────────────────


async def test_a_quiet_copy_opens_no_queue(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = ZulipAdapter(config=_config())
    adapter.set_outbound_policy(_PERMISSIVE_POLICY)
    adapter.set_listening(False)

    registered = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal registered
        if request.url.path == "/api/v1/register":
            registered = True
        return httpx.Response(
            200, json={"result": "success", "msg": "", "user_id": 1, "is_bot": True}
        )

    real_client = httpx.AsyncClient

    def patched(**kwargs):
        kwargs.pop("transport", None)
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)

    async def noop(_x: object) -> None:
        return None

    await adapter.start(noop, noop, noop, noop, noop)  # type: ignore[arg-type]
    assert adapter._poll_task is None
    assert registered is False
    await adapter.stop()


async def test_a_listening_copy_opens_a_queue(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = ZulipAdapter(config=_config())
    adapter.set_outbound_policy(_PERMISSIVE_POLICY)

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/users/me":
            return httpx.Response(
                200, json={"result": "success", "msg": "", "user_id": 1, "is_bot": True}
            )
        if request.url.path == "/api/v1/messages":
            return httpx.Response(
                200,
                json={
                    "result": "success",
                    "msg": "",
                    "messages": [],
                    "found_newest": True,
                },
            )
        if request.url.path == "/api/v1/register":
            return httpx.Response(
                200,
                json={
                    "result": "success",
                    "msg": "",
                    "queue_id": "q1",
                    "last_event_id": -1,
                    "max_message_length": 10000,
                    "max_file_upload_size_mib": 25,
                },
            )
        # A real long-poll never returns instantly; without a delay here
        # the poll loop spins so fast it starves this test's own tasks
        # (the sleep below, and `stop()`) of a turn on the event loop.
        await asyncio.sleep(0.5)
        return httpx.Response(200, json={"result": "success", "msg": "", "events": []})

    real_client = httpx.AsyncClient

    def patched(**kwargs):
        kwargs.pop("transport", None)
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)

    async def noop(_x: object) -> None:
        return None

    await adapter.start(noop, noop, noop, noop, noop)  # type: ignore[arg-type]
    await asyncio.sleep(0.05)
    assert adapter._poll_task is not None
    await adapter.stop()
