"""File requests over a controller's socket: what goes down, and which replies
are let through (`file_requests.py`)."""

from __future__ import annotations

import asyncio
import base64
import logging
import re
from typing import Any

import pytest

from switch_core.file_requests import (
    AGENT_NAME_PATTERN,
    CHUNK_BYTES,
    MAX_IN_FLIGHT_PER_CONTROLLER,
    BadReply,
    FileRequests,
)


class _Socket:
    def __init__(self) -> None:
        self.frames: list[dict[str, Any]] = []

    def send(self, frame: dict[str, Any]) -> None:
        self.frames.append(frame)


def _held(controller_id: str = "c-1") -> tuple[FileRequests, _Socket]:
    requests, socket = FileRequests(), _Socket()
    requests.socket_opened(controller_id, socket, socket.send)
    return requests, socket


def _reply(id_: str, seq: int = 0, **fields: Any) -> dict[str, Any]:
    return {"type": "files.reply", "id": id_, "seq": seq, "last": True, **fields}


async def test_a_request_goes_down_the_socket_with_only_the_agreed_fields() -> None:
    requests, socket = _held()

    request = requests.open("c-1", "read", "agent-a/notes.md", offset=0, cursor=None)

    assert socket.frames == [
        {
            "event": "files.request",
            "data": {
                "id": request.id,
                "op": "read",
                "path": "agent-a/notes.md",
                "offset": 0,
            },
        }
    ]
    assert len(request.id) <= 64


async def test_a_reply_reaches_its_request_with_its_bytes() -> None:
    requests, _ = _held()
    request = requests.open("c-1", "read", "a.txt", offset=0)

    requests.deliver(
        "c-1", _reply(request.id, data=base64.b64encode(b"hi").decode(), size=2)
    )

    reply = await request.reply(timeout=1)
    assert (reply.chunk(), reply.size) == (b"hi", 2)


async def test_a_reply_on_another_controllers_socket_is_dropped(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The binding rule: only a request open on this same socket."""
    requests, _ = _held()
    other = _Socket()
    requests.socket_opened("c-2", other, other.send)
    request = requests.open("c-1", "read", "a.txt", offset=0)

    with caplog.at_level(logging.WARNING):
        requests.deliver(
            "c-2", _reply(request.id, data=base64.b64encode(b"x").decode())
        )
        requests.deliver("c-1", _reply("f-never-asked", data="eA=="))

    assert request.replies.empty()
    assert caplog.text.count("files_reply_unbound") == 2
    assert "a.txt" not in caplog.text


@pytest.mark.parametrize(
    "fields",
    [
        {"seq": 1},  # out of order
        {"data": "not base64!"},
        {"data": base64.b64encode(b"x" * (CHUNK_BYTES + 1)).decode()},  # over one chunk
        {"error": "something_else"},
        {"surprise": True},  # an unknown field
        {"entries": [{"name": "../x", "kind": "pipe", "size": 0, "mtime": 1}]},
        {"entries": [{"name": "a", "kind": "file", "size": 1, "mtime": "2026-11-05"}]},
        {
            "entries": [
                {
                    "name": "a",
                    "kind": "folder",
                    "size": 0,
                    "mtime": 1,
                    "agent": "Bad Name",
                }
            ]
        },
        {
            "entries": [
                {
                    "name": "a",
                    "kind": "folder",
                    "size": 0,
                    "mtime": 1,
                    "agent": "a" * 256,
                }
            ]
        },
    ],
)
async def test_a_reply_that_breaks_the_frame_rules_fails_its_request(
    fields: dict[str, Any],
) -> None:
    requests, _ = _held()
    request = requests.open("c-1", "list", "")

    requests.deliver("c-1", {**_reply(request.id), **fields})

    with pytest.raises(BadReply):
        await request.reply(timeout=1)


async def test_more_than_one_reply_per_ask_fails_the_request() -> None:
    requests, _ = _held()
    request = requests.open("c-1", "zip", "")
    for seq in range(3):
        requests.deliver("c-1", {**_reply(request.id, seq=seq), "last": False})

    with pytest.raises(BadReply):
        while True:
            await request.reply(timeout=1)


async def test_a_controller_takes_at_most_its_share_and_only_where_its_socket_is() -> (
    None
):
    requests, _ = _held()
    for _ in range(MAX_IN_FLIGHT_PER_CONTROLLER):
        requests.open("c-1", "list", "")

    with pytest.raises(OverflowError):
        requests.open("c-1", "list", "")
    with pytest.raises(LookupError):
        requests.open("c-elsewhere", "list", "")


async def test_closing_a_request_frees_its_place_and_cancels_only_when_asked() -> None:
    requests, socket = _held()
    first = requests.open("c-1", "zip", "")
    second = requests.open("c-1", "read", "a.txt", offset=0)

    requests.close(first, cancel=True)
    requests.close(second, cancel=False)
    requests.close(first, cancel=True)  # once only

    assert [f["event"] for f in socket.frames] == [
        "files.request",
        "files.request",
        "files.cancel",
    ]
    assert socket.frames[-1]["data"] == {"id": first.id}
    requests.deliver("c-1", _reply(first.id))  # late: dropped, not delivered
    assert first.replies.empty()


async def test_a_socket_going_fails_its_open_requests_at_once() -> None:
    requests, socket = _held()
    request = requests.open("c-1", "read", "a.txt", offset=0)

    requests.socket_closed("c-1", socket)

    with pytest.raises(BadReply, match="socket_closed"):
        await asyncio.wait_for(request.reply(timeout=5), 1)
    assert not requests.holds("c-1")


async def test_an_old_socket_going_leaves_the_newer_one_in_place() -> None:
    requests, old = _held()
    new = _Socket()
    requests.socket_opened("c-1", new, new.send)

    requests.socket_closed("c-1", old)

    assert requests.holds("c-1")
    requests.open("c-1", "list", "")
    assert new.frames and not old.frames


async def test_a_listing_in_the_launchers_real_shape_reaches_its_request() -> None:
    """`mtime` is epoch milliseconds and `agent` an agent name, as the relay sends them."""
    requests, _ = _held()
    request = requests.open("c-1", "list", "")
    entries = [
        {
            "name": "scout",
            "kind": "folder",
            "size": 0,
            "mtime": 1793880000000,
            "label": "Scout",
            "agent": "scout",
        },
        {
            "name": "shared",
            "kind": "folder",
            "size": 0,
            "mtime": 1793880000000,
            "label": "Shared",
        },
        {"name": "notes.md", "kind": "file", "size": 12, "mtime": 1793880000123},
    ]

    requests.deliver("c-1", {**_reply(request.id), "entries": entries})

    reply = await request.reply(timeout=1)
    assert reply.entries is not None
    assert [entry.agent for entry in reply.entries] == ["scout", None, None]
    assert reply.entries[2].mtime == 1793880000123


async def test_bad_request_is_one_of_the_codes_a_reply_may_carry() -> None:
    requests, _ = _held()
    request = requests.open("c-1", "list", "")

    requests.deliver("c-1", {**_reply(request.id), "error": "bad_request"})

    reply = await request.reply(timeout=1)
    assert reply.error == "bad_request"


@pytest.mark.parametrize(
    "name", ["scout", "web-qa", "a.b_c-1", "0x", "Bad", "-x", "a b", ""]
)
def test_the_agent_name_rule_matches_cores_own(name: str) -> None:
    from switch_core.bridges.agent.protocol.agent_core import VALID_AGENT_NAME_RE

    assert bool(re.fullmatch(AGENT_NAME_PATTERN, name)) == bool(
        VALID_AGENT_NAME_RE.match(name)
    )


@pytest.mark.parametrize("agent", ["-x", ".x", "a b", "a/b", "Scout", "a\x00b", ""])
async def test_an_agent_key_that_isnt_an_agent_name_fails_the_request(
    agent: str,
) -> None:
    requests, _ = _held()
    request = requests.open("c-1", "list", "")
    entry = {
        "name": "a",
        "kind": "folder",
        "size": 0,
        "mtime": 1,
        "label": "A",
        "agent": agent,
    }

    requests.deliver("c-1", _reply(request.id, entries=[entry]))

    with pytest.raises(BadReply):
        await request.reply(timeout=1)


async def test_a_long_agent_name_is_accepted_up_to_one_path_part() -> None:
    """Core's agent names have no length limit, so 64 must not cap it."""
    requests, _ = _held()
    request = requests.open("c-1", "list", "")
    name = "a" * 255
    entry = {
        "name": name,
        "kind": "folder",
        "size": 0,
        "mtime": 1,
        "label": "A",
        "agent": name,
    }

    requests.deliver("c-1", _reply(request.id, entries=[entry]))

    reply = await request.reply(timeout=1)
    assert reply.entries is not None and reply.entries[0].agent == name
