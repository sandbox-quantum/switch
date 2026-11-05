"""A homeserver for the Matrix bridge's tests, at the HTTP layer.

`FakeHomeserver.handle` answers the Client-Server API calls the adapter makes,
through `httpx.MockTransport`, and records what it was asked. Sync batches are
queued by the test; once they run out a sync waits, as a long poll does, until
the adapter is stopped.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import unquote

import httpx
import pytest

from switch_core.bridges.collaboration.matrix import adapter as matrix_adapter
from switch_core.bridges.collaboration.matrix import client as client_module
from switch_core.bridges.collaboration.matrix.adapter import (
    MatrixAdapter,
    MatrixConnectionConfig,
)
from switch_core.bridges.collaboration.models import (
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.outbound import OutboundPolicy

HOMESERVER = "https://matrix.example.org"
TOKEN = "syt_placeholder_token"
BOT = "@switch-bot:example.org"
ALICE = "@alice:example.org"
ROOM = "!room:example.org"


@dataclass
class Sent:
    room_id: str
    event_type: str
    content: dict[str, Any]
    event_id: str


@dataclass
class FakeHomeserver:
    token: str = TOKEN
    user_id: str = BOT
    whoami: tuple[int, dict[str, Any]] | None = None
    unreachable: bool = False
    initial_sync: dict[str, Any] = field(default_factory=dict)
    batches: deque[dict[str, Any]] = field(default_factory=deque)
    account_data: dict[str, dict[str, Any]] = field(default_factory=dict)
    state: dict[tuple[str, str, str], dict[str, Any]] = field(default_factory=dict)
    members: dict[str, list[str]] = field(default_factory=dict)
    events: dict[str, dict[str, Any]] = field(default_factory=dict)
    relations: dict[tuple[str, str], list[dict[str, Any]]] = field(default_factory=dict)
    messages_pages: deque[dict[str, Any]] = field(default_factory=deque)
    media: dict[str, tuple[bytes, str]] = field(default_factory=dict)
    upload_limit: int | None = 1_000_000
    directory: list[dict[str, Any]] = field(default_factory=list)
    # (method, path regex) -> (status, body), checked before anything else.
    refusals: dict[tuple[str, str], tuple[int, dict[str, Any]]] = field(
        default_factory=dict
    )
    # (method, path regex) -> how many more times to answer 429 before
    # answering as usual.
    rate_limited: dict[tuple[str, str], int] = field(default_factory=dict)
    # The wait a rate limit asks for, or None for an answer that names none.
    rate_limit_wait_ms: int | None = 5
    # Every wait the client took for a rate limit, in seconds (not slept).
    waits: list[float] = field(default_factory=list)
    # (method, path regex) -> makes a whole response, for answers no
    # homeserver gives.
    raw: dict[tuple[str, str], Callable[[], httpx.Response]] = field(
        default_factory=dict
    )
    # (room, type, state key) -> who sent that state event (`format=event`).
    state_senders: dict[tuple[str, str, str], str] = field(default_factory=dict)
    # mxc URI -> where its download redirects to.
    media_redirects: dict[str, str] = field(default_factory=dict)
    # Which HTTP client each connection was made with, and with what policy.
    clients: list[tuple[str, OutboundPolicy | None]] = field(default_factory=list)

    requests: list[httpx.Request] = field(default_factory=list)
    syncs: list[dict[str, str]] = field(default_factory=list)
    sent: list[Sent] = field(default_factory=list)
    redacted: list[tuple[str, str]] = field(default_factory=list)
    joined: list[str] = field(default_factory=list)
    left: list[str] = field(default_factory=list)
    invited: list[tuple[str, str]] = field(default_factory=list)
    created: list[dict[str, Any]] = field(default_factory=list)
    typing: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    uploads: list[tuple[bytes, str, str]] = field(default_factory=list)
    _counter: int = 0
    _served: dict[str, dict[str, Any]] = field(default_factory=dict)
    _wake: asyncio.Event | None = None
    _sync_waiters: list[tuple[int, asyncio.Future[None]]] = field(default_factory=list)

    # ── What a test asks of it ──────────────────────────────────────────────

    def queue(self, batch: dict[str, Any]) -> None:
        self.batches.append(batch)
        if self._wake is not None:
            self._wake.set()

    async def until_syncs(self, count: int) -> None:
        """Wait until the adapter has asked for `count` incremental syncs.

        The adapter asks for the next batch only once it has handed the last
        one to Switch, so this is how a test knows a batch was processed.
        """
        if len([s for s in self.syncs if "since" in s]) >= count:
            return
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._sync_waiters.append((count, future))
        await asyncio.wait_for(future, timeout=5)

    def messages_to(self, room_id: str) -> list[Sent]:
        return [
            s
            for s in self.sent
            if s.room_id == room_id and s.event_type == "m.room.message"
        ]

    def put_event(self, room_id: str, event: dict[str, Any]) -> None:
        self.events[event["event_id"]] = {"room_id": room_id, **event}

    # ── HTTP ─────────────────────────────────────────────────────────────────

    def _next_id(self, prefix: str) -> str:
        self._counter += 1
        return f"{prefix}{self._counter}"

    async def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.unreachable:
            raise httpx.ConnectError("connection refused", request=request)
        path = unquote(request.url.path)
        method = request.method
        for (want_method, pattern), respond in self.raw.items():
            if method == want_method and re.search(pattern, path):
                return respond()
        for key, remaining in self.rate_limited.items():
            if remaining > 0 and method == key[0] and re.search(key[1], path):
                self.rate_limited[key] = remaining - 1
                return httpx.Response(
                    429,
                    json={
                        "errcode": "M_LIMIT_EXCEEDED",
                        "error": "Too Many Requests",
                        **(
                            {"retry_after_ms": self.rate_limit_wait_ms}
                            if self.rate_limit_wait_ms is not None
                            else {}
                        ),
                    },
                )
        for (want_method, pattern), (status, body) in self.refusals.items():
            if method == want_method and re.search(pattern, path):
                return httpx.Response(status, json=body)
        if request.headers.get("authorization") != f"Bearer {self.token}":
            return httpx.Response(
                401,
                json={"errcode": "M_UNKNOWN_TOKEN", "error": "Invalid access token"},
            )
        body: dict[str, Any] = {}
        if (
            request.content
            and request.headers.get("content-type") == "application/json"
        ):
            body = json.loads(request.content)
        return await self._route(method, path, request, body)

    async def _route(
        self, method: str, path: str, request: httpx.Request, body: dict[str, Any]
    ) -> httpx.Response:
        ok = httpx.Response(200, json={})
        if path == "/_matrix/client/v3/account/whoami":
            if self.whoami is not None:
                return httpx.Response(self.whoami[0], json=self.whoami[1])
            return httpx.Response(200, json={"user_id": self.user_id})
        if path == "/_matrix/client/v3/sync":
            return await self._sync(dict(request.url.params))
        match = re.fullmatch(r"/_matrix/client/v3/user/[^/]+/account_data/(.+)", path)
        if match:
            if method == "PUT":
                self.account_data[match.group(1)] = body
                return ok
            stored = self.account_data.get(match.group(1))
            if stored is None:
                return httpx.Response(
                    404, json={"errcode": "M_NOT_FOUND", "error": "not found"}
                )
            return httpx.Response(200, json=stored)
        match = re.fullmatch(
            r"/_matrix/client/v3/rooms/([^/]+)/send/([^/]+)/[^/]+", path
        )
        if match:
            event_id = self._next_id("$sent")
            self.sent.append(Sent(match.group(1), match.group(2), body, event_id))
            self.events[event_id] = {
                "event_id": event_id,
                "room_id": match.group(1),
                "sender": self.user_id,
                "type": match.group(2),
                "content": body,
            }
            return httpx.Response(200, json={"event_id": event_id})
        match = re.fullmatch(
            r"/_matrix/client/v3/rooms/([^/]+)/redact/([^/]+)/[^/]+", path
        )
        if match:
            self.redacted.append((match.group(1), match.group(2)))
            return httpx.Response(200, json={"event_id": self._next_id("$redaction")})
        match = re.fullmatch(r"/_matrix/client/v3/rooms/([^/]+)/event/([^/]+)", path)
        if match:
            event = self.events.get(match.group(2))
            if event is None:
                return httpx.Response(404, json={"errcode": "M_NOT_FOUND"})
            return httpx.Response(200, json=event)
        match = re.fullmatch(
            r"/_matrix/client/v3/rooms/([^/]+)/state/([^/]+)/?(.*)", path
        )
        if match:
            key = (match.group(1), match.group(2), match.group(3))
            content = self.state.get(key)
            if content is None:
                return httpx.Response(404, json={"errcode": "M_NOT_FOUND"})
            if request.url.params.get("format") == "event":
                return httpx.Response(
                    200,
                    json={
                        "type": key[1],
                        "state_key": key[2],
                        "sender": self.state_senders.get(key, ALICE),
                        "content": content,
                    },
                )
            return httpx.Response(200, json=content)
        match = re.fullmatch(r"/_matrix/client/v3/rooms/([^/]+)/joined_members", path)
        if match:
            joined = self.members.get(
                match.group(1), [self.user_id, ALICE, "@bob:example.org"]
            )
            return httpx.Response(200, json={"joined": {m: {} for m in joined}})
        match = re.fullmatch(r"/_matrix/client/v3/join/(.+)", path)
        if match:
            self.joined.append(match.group(1))
            return httpx.Response(200, json={"room_id": match.group(1)})
        match = re.fullmatch(r"/_matrix/client/v3/rooms/([^/]+)/leave", path)
        if match:
            self.left.append(match.group(1))
            return ok
        match = re.fullmatch(r"/_matrix/client/v3/rooms/([^/]+)/invite", path)
        if match:
            self.invited.append((match.group(1), body["user_id"]))
            return ok
        if path == "/_matrix/client/v3/createRoom":
            self.created.append(body)
            return httpx.Response(
                200, json={"room_id": self._next_id("!created") + ":example.org"}
            )
        match = re.fullmatch(r"/_matrix/client/v3/rooms/([^/]+)/typing/[^/]+", path)
        if match:
            self.typing.append((match.group(1), body))
            return ok
        match = re.fullmatch(
            r"/_matrix/client/v1/rooms/([^/]+)/relations/([^/]+)/([^/]+)(/.*)?", path
        )
        if match:
            chunk = self.relations.get((match.group(2), match.group(3)), [])
            if request.url.params.get("dir") == "f":
                chunk = sorted(chunk, key=lambda e: e.get("origin_server_ts", 0))
            limit = int(request.url.params.get("limit", "100"))
            return httpx.Response(200, json={"chunk": chunk[:limit]})
        match = re.fullmatch(r"/_matrix/client/v3/rooms/([^/]+)/messages", path)
        if match:
            page = (
                self.messages_pages.popleft() if self.messages_pages else {"chunk": []}
            )
            return httpx.Response(200, json=page)
        if path == "/_matrix/client/v3/user_directory/search":
            return httpx.Response(
                200, json={"results": self.directory, "limited": False}
            )
        if path == "/_matrix/client/v1/media/config":
            config = (
                {}
                if self.upload_limit is None
                else {"m.upload.size": self.upload_limit}
            )
            return httpx.Response(200, json=config)
        if path == "/_matrix/media/v3/upload":
            self.uploads.append(
                (
                    request.content,
                    request.headers["content-type"],
                    request.url.params["filename"],
                )
            )
            uri = f"mxc://example.org/{self._next_id('media')}"
            return httpx.Response(200, json={"content_uri": uri})
        match = re.fullmatch(r"/_matrix/client/v1/media/download/([^/]+)/([^/]+)", path)
        if match:
            uri = f"mxc://{match.group(1)}/{match.group(2)}"
            if uri in self.media_redirects:
                return httpx.Response(
                    307, headers={"location": self.media_redirects[uri]}
                )
            found = self.media.get(uri)
            if found is None:
                return httpx.Response(404, json={"errcode": "M_NOT_FOUND"})
            return httpx.Response(
                200, content=found[0], headers={"content-type": found[1]}
            )
        match = re.fullmatch(r"/media-store/(.+)", path)
        if match:
            found = self.media.get(f"store:{match.group(1)}")
            if found is not None:
                return httpx.Response(
                    200, content=found[0], headers={"content-type": found[1]}
                )
        return httpx.Response(404, json={"errcode": "M_UNRECOGNIZED", "error": path})

    async def _sync(self, params: dict[str, str]) -> httpx.Response:
        self.syncs.append(params)
        incremental = len([s for s in self.syncs if "since" in s])
        for count, future in list(self._sync_waiters):
            if incremental >= count and not future.done():
                future.set_result(None)
        if "since" not in params:
            batch = {"next_batch": "s0", **self.initial_sync}
            return httpx.Response(200, json=batch)
        # A position asked for again gets the same batch, as from a homeserver.
        if params["since"] in self._served:
            return httpx.Response(200, json=self._served[params["since"]])
        # A long poll: held until a test queues the next batch.
        while not self.batches:
            self._wake = asyncio.Event()
            await self._wake.wait()
        batch = self.batches.popleft()
        self._served[params["since"]] = batch
        return httpx.Response(200, json=batch)


@dataclass
class Recorder:
    messages: list[InboundMessage] = field(default_factory=list)
    commands: list[InboundCommand] = field(default_factory=list)
    agent_joins: list[InboundAgentJoin] = field(default_factory=list)
    user_joins: list[InboundUserJoin] = field(default_factory=list)
    app_joins: list[InboundAppJoin] = field(default_factory=list)
    interactions: list[InboundInteraction] = field(default_factory=list)

    async def on_message(self, message: InboundMessage) -> None:
        self.messages.append(message)

    async def on_command(self, command: InboundCommand) -> None:
        self.commands.append(command)

    async def on_agent_joined(self, join: InboundAgentJoin) -> None:
        self.agent_joins.append(join)

    async def on_user_joined(self, join: InboundUserJoin) -> None:
        self.user_joins.append(join)

    async def on_app_joined(self, join: InboundAppJoin) -> None:
        self.app_joins.append(join)

    async def on_interaction(self, interaction: InboundInteraction) -> None:
        self.interactions.append(interaction)


def config(**overrides: Any) -> MatrixConnectionConfig:
    return MatrixConnectionConfig.model_validate(
        {
            "homeserver_url": HOMESERVER,
            "bot_user_id": BOT,
            "access_token": TOKEN,
            **overrides,
        }
    )


def serve(monkeypatch: pytest.MonkeyPatch, homeserver: FakeHomeserver) -> None:
    """Route both of the adapter's HTTP clients to `homeserver`, noting which
    client each connection was made with and the policy it was given."""

    def client(base_url: str) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=base_url, transport=httpx.MockTransport(homeserver.handle)
        )

    def unguarded(base_url: str) -> httpx.AsyncClient:
        homeserver.clients.append(("unguarded", None))
        return client(base_url)

    def guarded(
        policy: OutboundPolicy, *, base_url: str, **_: Any
    ) -> httpx.AsyncClient:
        homeserver.clients.append(("guarded", policy))
        return client(base_url)

    monkeypatch.setattr(matrix_adapter, "guarded_async_client", guarded)
    monkeypatch.setattr(matrix_adapter, "open_http", unguarded)

    async def no_sleep(seconds: float) -> None:
        homeserver.waits.append(seconds)
        await asyncio.sleep(0)

    monkeypatch.setattr(client_module, "_sleep", no_sleep)


def make_adapter(
    monkeypatch: pytest.MonkeyPatch,
    homeserver: FakeHomeserver,
    *,
    listening: bool = True,
    bridge_id: str = "bridge-1",
    **overrides: Any,
) -> MatrixAdapter:
    serve(monkeypatch, homeserver)
    adapter = MatrixAdapter(config=config(**overrides))
    adapter.set_outbound_policy(OutboundPolicy.parse(""))
    adapter.set_bridge_id(bridge_id)
    adapter.set_listening(listening)
    adapter.set_max_attachment_bytes(1000)
    return adapter


async def start(adapter: MatrixAdapter, recorder: Recorder) -> None:
    adapter.set_interaction_handler(recorder.on_interaction)
    await adapter.start(
        recorder.on_message,
        recorder.on_command,
        recorder.on_agent_joined,
        recorder.on_user_joined,
        recorder.on_app_joined,
    )


def message_event(
    event_id: str,
    body: str,
    *,
    sender: str = ALICE,
    msgtype: str = "m.text",
    **content: Any,
) -> dict[str, Any]:
    return {
        "type": "m.room.message",
        "event_id": event_id,
        "sender": sender,
        "origin_server_ts": 1,
        "content": {"msgtype": msgtype, "body": body, **content},
    }


def batch(
    next_batch: str,
    events: list[dict[str, Any]],
    *,
    room_id: str = ROOM,
    state: list[dict[str, Any]] | None = None,
    limited: bool = False,
    prev_batch: str | None = None,
) -> dict[str, Any]:
    timeline: dict[str, Any] = {"events": events, "limited": limited}
    if prev_batch is not None:
        timeline["prev_batch"] = prev_batch
    return {
        "next_batch": next_batch,
        "rooms": {
            "join": {room_id: {"timeline": timeline, "state": {"events": state or []}}}
        },
    }
