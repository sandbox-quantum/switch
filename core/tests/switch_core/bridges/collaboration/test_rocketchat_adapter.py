"""Rocket.Chat: the connection config, the REST calls it makes, and what the
realtime socket turns into inbound events. The platform is mocked at the HTTP
transport and at the WebSocket, never at the adapter's own methods."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from pydantic import ValidationError
from websockets.exceptions import ConnectionClosedError, InvalidStatus

from switch_core.bridges.collaboration import platforms
from switch_core.bridges.collaboration.adapter import AgentPresentation
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.bridges.collaboration.rocketchat import adapter as rc
from switch_core.bridges.collaboration.rocketchat.adapter import (
    RocketChatAdapter,
    RocketChatConnectionConfig,
    split_message,
)

BOT = "botid"
CONFIG: dict[str, object] = {
    "url": "https://chat.example.com/",
    "user_id": BOT,
    "auth_token": "synthetic-token",
}

Handler = Callable[[httpx.Request], httpx.Response]


def ok(**body: Any) -> httpx.Response:
    return httpx.Response(200, json={"success": True, **body})


class Server:
    """A Rocket.Chat REST API: routes by path, remembers every request."""

    def __init__(self) -> None:
        self.routes: dict[str, Handler] = {}
        self.requests: list[httpx.Request] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        route = self.routes.get(request.url.path)
        if route is None:
            return httpx.Response(
                404, json={"success": False, "error": "no such route"}
            )
        return route(request)

    def sent(self, path: str) -> list[dict[str, Any]]:
        return [
            json.loads(r.content)
            for r in self.requests
            if r.url.path == path and r.content
        ]


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> Server:
    fake = Server()
    fake.routes["/api/v1/me"] = lambda r: ok(_id=BOT, username="switch-bot")

    def client(config: RocketChatConnectionConfig) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=config.url,
            headers={"X-User-Id": config.user_id, "X-Auth-Token": config.auth_token},
            transport=httpx.MockTransport(fake.handle),
        )

    monkeypatch.setattr(rc, "_http_client", client)
    return fake


class Inbox:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []
        self.users: list[InboundUserJoin] = []
        self.apps: list[InboundAppJoin] = []

    async def message(self, m: InboundMessage) -> None:
        self.messages.append(m)

    async def command(self, c: InboundCommand) -> None:
        self.commands.append(c)

    async def agent(self, _: Any) -> None:
        return None

    async def user(self, u: InboundUserJoin) -> None:
        self.users.append(u)

    async def app(self, a: InboundAppJoin) -> None:
        self.apps.append(a)


async def started(
    server: Server, *, listening: bool = False
) -> tuple[RocketChatAdapter, Inbox]:
    server.routes["/api/v1/rooms.info"] = lambda r: ok(
        room={"_id": r.url.params["roomId"], "t": "c", "name": "general"}
    )
    adapter = RocketChatAdapter(
        config=RocketChatConnectionConfig.model_validate(CONFIG)
    )
    adapter.set_listening(listening)

    async def presentation(name: str) -> AgentPresentation:
        return AgentPresentation(
            display_name="Helper Bot", icon_url="https://img.example/h.png"
        )

    adapter.set_agent_presentation_resolver(presentation)
    adapter.set_third_party_avatars(True)
    inbox = Inbox()
    await adapter.start(
        inbox.message, inbox.command, inbox.agent, inbox.user, inbox.app
    )
    return adapter, inbox


def post(**fields: Any) -> dict[str, Any]:
    return {
        "_id": "m1",
        "rid": "room1",
        "msg": "hello",
        "ts": {"$date": 1_700_000_000_000},
        "u": {"_id": "u1", "username": "ada"},
        **fields,
    }


# Config
def test_a_config_names_a_server_and_drops_the_trailing_slash() -> None:
    assert (
        RocketChatConnectionConfig.model_validate(CONFIG).url
        == "https://chat.example.com"
    )


@pytest.mark.parametrize(
    "url", ["chat.example.com", "ftp://chat.example.com", "https://", "http://h:99999"]
)
def test_a_url_that_is_not_a_server_is_refused(url: str) -> None:
    with pytest.raises(ValidationError):
        RocketChatConnectionConfig.model_validate({**CONFIG, "url": url})


def test_a_token_never_appears_in_a_validation_error() -> None:
    with pytest.raises(ValidationError) as raised:
        RocketChatConnectionConfig.model_validate({**CONFIG, "url": "nope"})
    assert "synthetic-token" not in str(raised.value)


def test_the_platform_is_registered_and_declares_what_it_cannot_do() -> None:
    registered = {p.key: p for p in platforms.PLATFORMS}["rocketchat"]
    assert registered.adapter is RocketChatAdapter
    assert RocketChatAdapter.display_name == "Rocket.Chat"
    assert RocketChatAdapter.keeps_quiet_unless_listening is True
    assert RocketChatAdapter.draws_session_activity is False
    assert RocketChatAdapter.activity_reactions_per_agent is False


def test_two_bridges_for_one_bot_on_one_server_are_one_claim() -> None:
    claim = RocketChatAdapter.claimed_workspace
    assert claim({**CONFIG, "url": "https://Chat.Example.com/"}) == claim(
        {**CONFIG, "url": "https://chat.example.com:443"}
    )
    assert claim(CONFIG) != claim({**CONFIG, "user_id": "other"})


# Credentials
async def test_good_credentials_pass(server: Server) -> None:
    await RocketChatAdapter.verify_credentials(CONFIG)
    assert server.requests[0].headers["X-Auth-Token"] == "synthetic-token"
    assert server.requests[0].headers["X-User-Id"] == BOT


async def test_a_refused_token_says_what_to_check(server: Server) -> None:
    server.routes["/api/v1/me"] = lambda r: httpx.Response(
        401, json={"status": "error", "message": "You must be logged in"}
    )
    with pytest.raises(BridgeCredentialError, match="user_id and auth_token"):
        await RocketChatAdapter.verify_credentials(CONFIG)


async def test_a_token_for_another_user_is_refused(server: Server) -> None:
    server.routes["/api/v1/me"] = lambda r: ok(_id="someone-else")
    with pytest.raises(BridgeCredentialError, match="different user"):
        await RocketChatAdapter.verify_credentials(CONFIG)


async def test_an_unreachable_server_is_a_credential_error_naming_it(
    server: Server,
) -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    server.routes["/api/v1/me"] = down
    with pytest.raises(BridgeCredentialError, match="chat.example.com"):
        await RocketChatAdapter.verify_credentials(CONFIG)


def test_failures_are_classified_without_reading_messages() -> None:
    classify = RocketChatAdapter.classify_failure
    request = httpx.Request("GET", "https://chat.example.com")
    assert classify(httpx.ConnectError("x", request=request)) == "network"
    assert classify(httpx.ReadTimeout("x", request=request)) == "network"
    assert classify(ConnectionClosedError(None, None)) == "network"
    assert classify(ValueError("auth")) is None
    rejected = InvalidStatus(httpx.Response(401))  # type: ignore[arg-type]
    assert classify(rejected) == "auth_failed"


# Outbound
async def test_an_agent_posts_under_its_own_name_and_avatar(server: Server) -> None:
    server.routes["/api/v1/chat.postMessage"] = lambda r: ok(message={"_id": "new1"})
    adapter, _ = await started(server)
    ref = await adapter.send_message("room1", "helper", "hi there")
    assert ref == "new1"
    assert server.sent("/api/v1/chat.postMessage") == [
        {
            "roomId": "room1",
            "text": "hi there",
            "alias": "Helper Bot",
            "avatar": "https://img.example/h.png",
        }
    ]


async def test_a_reply_stays_in_its_thread(server: Server) -> None:
    server.routes["/api/v1/chat.postMessage"] = lambda r: ok(message={"_id": "new1"})
    adapter, _ = await started(server)
    await adapter.send_message("room1", "helper", "hi", thread_root_id="root9")
    assert server.sent("/api/v1/chat.postMessage")[0]["tmid"] == "root9"


async def test_a_long_reply_is_split_and_the_first_post_is_the_reference(
    server: Server,
) -> None:
    count = iter(range(100))
    server.routes["/api/v1/chat.postMessage"] = lambda r: ok(
        message={"_id": f"p{next(count)}"}
    )
    adapter, _ = await started(server)
    ref = await adapter.send_message("room1", "helper", "\n".join(["x" * 900] * 12))
    posts = server.sent("/api/v1/chat.postMessage")
    assert len(posts) > 1
    assert all(len(p["text"]) <= rc.MAX_MESSAGE for p in posts)
    assert ref == "p0"


async def test_edit_and_delete_reach_the_post(server: Server) -> None:
    server.routes["/api/v1/chat.update"] = lambda r: ok()
    server.routes["/api/v1/chat.delete"] = lambda r: ok()
    adapter, _ = await started(server)
    await adapter.update_message("room1", "m9", "new text")
    await adapter.delete_message("room1", "m9")
    assert server.sent("/api/v1/chat.update") == [
        {"roomId": "room1", "msgId": "m9", "text": "new text"}
    ]
    assert server.sent("/api/v1/chat.delete") == [{"roomId": "room1", "msgId": "m9"}]


async def test_a_refusal_carries_rocket_chats_own_words(server: Server) -> None:
    server.routes["/api/v1/chat.update"] = lambda r: httpx.Response(
        400, json={"success": False, "error": "Message editing is not allowed"}
    )
    adapter, _ = await started(server)
    with pytest.raises(BridgeOperationError, match="Message editing is not allowed"):
        await adapter.update_message("room1", "m9", "x")


async def test_a_rate_limit_is_waited_out_then_retried(
    server: Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    waits: list[float] = []

    async def sleep(seconds: float) -> None:
        waits.append(seconds)

    monkeypatch.setattr(rc.asyncio, "sleep", sleep)
    answers = iter(
        [httpx.Response(429, headers={"Retry-After": "3"}), ok(message={"_id": "a"})]
    )
    server.routes["/api/v1/chat.postMessage"] = lambda r: next(answers)
    adapter, _ = await started(server)
    assert await adapter.send_message("room1", "helper", "hi") == "a"
    assert waits == [3.0]


async def test_a_file_goes_up_with_the_agent_named_in_its_caption(
    server: Server,
) -> None:
    server.routes["/api/v1/rooms.upload/room1"] = lambda r: ok(message={"_id": "f1"})
    adapter, _ = await started(server)
    ref = await adapter.send_attachment(
        "room1",
        "helper",
        "a.txt",
        "text/plain",
        b"data",
        caption="see",
        thread_root_id="t1",
    )
    assert ref == "f1"
    request = server.requests[-1]
    assert request.headers["content-type"].startswith("multipart/form-data")
    assert b"**Helper Bot**\nsee" in request.content
    assert b'name="tmid"' in request.content
    assert b"data" in request.content


async def test_activity_is_a_reaction_that_can_be_taken_back(server: Server) -> None:
    server.routes["/api/v1/chat.react"] = lambda r: ok()
    adapter, _ = await started(server)
    await adapter.mark_activity(
        "room1", "m1", agent_name="helper", mark="working", on=True
    )
    await adapter.mark_activity(
        "room1", "m1", agent_name="helper", mark="working", on=False
    )
    await adapter.mark_activity(
        "room1", "m1", agent_name="helper", mark="queued", on=True
    )
    assert server.sent("/api/v1/chat.react") == [
        {"messageId": "m1", "emoji": ":hourglass_flowing_sand:", "shouldReact": True},
        {"messageId": "m1", "emoji": ":hourglass_flowing_sand:", "shouldReact": False},
        {"messageId": "m1", "emoji": ":eyes:", "shouldReact": True},
    ]


# Channels and people
async def test_a_public_channel_is_created_with_a_clean_name_and_topic(
    server: Server,
) -> None:
    server.routes["/api/v1/channels.create"] = lambda r: ok(
        channel={"_id": "c1", "t": "c"}
    )
    server.routes["/api/v1/channels.setTopic"] = lambda r: ok()
    adapter, _ = await started(server)
    assert await adapter.create_channel("Release Plan #3", "ship it") == "c1"
    assert server.sent("/api/v1/channels.create") == [
        {"name": "release-plan--3", "members": []}
    ]
    assert server.sent("/api/v1/channels.setTopic") == [
        {"roomId": "c1", "topic": "ship it"}
    ]


async def test_a_private_channel_adds_the_default_member(server: Server) -> None:
    server.routes["/api/v1/groups.create"] = lambda r: ok(group={"_id": "g1", "t": "p"})
    server.routes["/api/v1/groups.setTopic"] = lambda r: ok()
    adapter, _ = await started(server)
    adapter.config.default_member = "ada"
    assert (
        await adapter.create_channel("ops", "", channel_type="channel_private") == "g1"
    )
    assert server.sent("/api/v1/groups.create") == [{"name": "ops", "members": ["ada"]}]
    assert server.sent("/api/v1/groups.setTopic") == []
    assert await adapter.get_channel_type("g1") == "channel_private"


async def test_a_name_the_server_refuses_raises_with_its_reason(server: Server) -> None:
    server.routes["/api/v1/channels.create"] = lambda r: httpx.Response(
        400, json={"success": False, "error": "error-duplicate-channel-name"}
    )
    adapter, _ = await started(server)
    with pytest.raises(BridgeOperationError, match="error-duplicate-channel-name"):
        await adapter.create_channel("ops", "")


async def test_people_who_cannot_be_added_are_handed_back(server: Server) -> None:
    def invite(request: httpx.Request) -> httpx.Response:
        if json.loads(request.content)["userId"] == "bad":
            return httpx.Response(
                400, json={"success": False, "error": "error-not-allowed"}
            )
        return ok()

    server.routes["/api/v1/channels.invite"] = invite
    adapter, _ = await started(server)
    failed = await adapter.add_users_to_channel("room1", ["ada", "bob"], ["u1", "bad"])
    assert failed == ["bad"]


async def test_the_directory_is_searched_on_the_server(server: Server) -> None:
    server.routes["/api/v1/directory"] = lambda r: ok(
        result=[
            {
                "_id": "u1",
                "username": "ada",
                "name": "Ada L",
                "emails": [{"address": "a@x.test"}],
            },
            {"_id": "u2", "username": "bob"},
            {"username": "no-id"},
        ]
    )
    adapter, _ = await started(server)
    users = await adapter.search_directory_users("a")
    assert [(u.external_user_id, u.display_name, u.email) for u in users] == [
        ("u1", "Ada L", "a@x.test"),
        ("u2", "bob", None),
    ]
    assert server.requests[-1].url.params["text"] == "a"


async def test_links_are_https_only(server: Server) -> None:
    adapter, _ = await started(server)
    assert await adapter.home_deeplink() == "https://chat.example.com"
    assert (
        await adapter.channel_deeplink("room1")
        == "https://chat.example.com/channel/general"
    )
    adapter.config.url = "http://chat.example.com"
    assert await adapter.home_deeplink() is None


# Inbound
async def test_a_message_becomes_an_inbound_message(server: Server) -> None:
    adapter, inbox = await started(server)
    await adapter._handle_message(post(msg="@helper hello"))
    assert inbox.messages == [
        InboundMessage(
            channel_id="room1",
            channel_type="channel_public",
            sender_id="u1",
            sender_name="ada",
            content="@helper hello",
            message_ref="m1",
            channel_name="general",
        )
    ]


async def test_a_thread_reply_carries_its_root(server: Server) -> None:
    adapter, inbox = await started(server)
    await adapter._handle_message(post(tmid="root1"))
    assert inbox.messages[0].root_id == "root1"


async def test_the_bots_own_posts_system_posts_edits_and_repeats_are_ignored(
    server: Server,
) -> None:
    adapter, inbox = await started(server)
    await adapter._handle_message(
        post(_id="own", u={"_id": BOT, "username": "switch-bot"})
    )
    await adapter._handle_message(post(_id="sys", t="rm", msg="x"))
    await adapter._handle_message(post(_id="edit", editedAt="2026-01-01T00:00:00Z"))
    await adapter._handle_message(post(_id="once"))
    await adapter._handle_message(post(_id="once"))
    assert [m.message_ref for m in inbox.messages] == ["once"]


async def test_a_command_is_split_from_its_arguments(server: Server) -> None:
    adapter, inbox = await started(server)
    await adapter._handle_message(post(msg="!interrupt  now please", tmid="t1"))
    assert inbox.messages == []
    assert [(c.command, c.args, c.root_id) for c in inbox.commands] == [
        ("interrupt", "now please", "t1")
    ]


async def test_a_post_from_an_integration_is_marked_as_an_app(server: Server) -> None:
    adapter, inbox = await started(server)
    await adapter._handle_message(post(bot={"i": "hook"}))
    assert inbox.messages[0].sender_is_app is True


async def test_someone_joining_and_the_bot_being_added_are_reported(
    server: Server,
) -> None:
    adapter, inbox = await started(server)
    await adapter._handle_message(post(_id="j", t="uj", msg=""))
    await adapter._handle_room_change(
        "inserted", {"_id": "room2", "t": "p", "name": "ops", "fname": "Ops"}
    )
    await adapter._handle_room_change("updated", {"_id": "room3", "t": "c"})
    assert [(u.external_user_id, u.external_username) for u in inbox.users] == [
        ("u1", "ada")
    ]
    assert [(a.channel_id, a.channel_type, a.channel_name) for a in inbox.apps] == [
        ("room2", "channel_private", "Ops")
    ]


async def test_files_are_downloaded_and_an_oversized_one_is_refused_visibly(
    server: Server,
) -> None:
    server.routes["/file-upload/f1/a.txt"] = lambda r: httpx.Response(
        200, content=b"hello"
    )
    adapter, inbox = await started(server)
    adapter.set_max_attachment_bytes(2 * 1024 * 1024)
    await adapter._handle_message(
        post(
            msg="",
            files=[
                {"_id": "f1", "name": "a.txt", "type": "text/plain", "size": 5},
                {
                    "_id": "f2",
                    "name": "big.bin",
                    "type": "application/zip",
                    "size": 3 * 1024 * 1024,
                },
                {"_id": "f3", "name": "gone.txt", "type": "text/plain", "size": 1},
            ],
        )
    )
    message = inbox.messages[0]
    assert [(a.filename, a.mimetype, a.data) for a in message.attachments] == [
        ("a.txt", "text/plain", b"hello")
    ]
    failures = {f.filename: f.reason for f in message.attachment_failures}
    assert "2 MB" in failures["big.bin"]
    assert "download failed" in failures["gone.txt"]


async def test_a_message_that_failed_is_tried_again_on_replay(server: Server) -> None:
    adapter, inbox = await started(server)
    server.routes["/api/v1/rooms.info"] = lambda r: httpx.Response(
        500, json={"success": False}
    )
    adapter._rooms.clear()
    with pytest.raises(BridgeOperationError):
        await adapter._handle_message(post())
    server.routes["/api/v1/rooms.info"] = lambda r: ok(room={"_id": "room1", "t": "c"})
    await adapter._handle_message(post())
    assert len(inbox.messages) == 1


# The realtime socket
class FakeSocket:
    """One end of a Rocket.Chat realtime connection."""

    def __init__(
        self, script: list[dict[str, Any] | Exception], login_error: bool = False
    ):
        self.sent: list[dict[str, Any]] = []
        self.login_error = login_error
        self._queue: asyncio.Queue[Any] = asyncio.Queue()
        self._script = script

    async def send(self, raw: str) -> None:
        frame = json.loads(raw)
        self.sent.append(frame)
        if frame["msg"] == "connect":
            self._queue.put_nowait({"msg": "connected", "session": "s"})
        elif frame.get("method") == "login":
            reply: dict[str, Any] = {
                "msg": "result",
                "id": "login",
                "result": {"id": BOT},
            }
            if self.login_error:
                reply = {
                    "msg": "result",
                    "id": "login",
                    "error": {"reason": "Unauthorized"},
                }
            self._queue.put_nowait(reply)
        elif frame["msg"] == "sub" and frame["id"] == "rooms":
            for item in self._script:
                self._queue.put_nowait(item)

    async def recv(self) -> str:
        item = await self._queue.get()
        if isinstance(item, Exception):
            raise item
        return json.dumps(item)

    async def __aenter__(self) -> FakeSocket:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None


def changed(collection: str, event: str, *args: Any) -> dict[str, Any]:
    return {
        "msg": "changed",
        "collection": collection,
        "id": "id",
        "fields": {"eventName": event, "args": list(args)},
    }


async def test_the_socket_signs_in_with_the_token_subscribes_and_hands_over_messages(
    server: Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    socket = FakeSocket(
        [
            {"msg": "ping"},
            changed("stream-room-messages", "__my_messages__", post(_id="live")),
            changed(
                "stream-notify-user",
                f"{BOT}/rooms-changed",
                "inserted",
                {"_id": "r9", "t": "c"},
            ),
            ConnectionClosedError(None, None),
        ]
    )
    urls: list[str] = []

    def connect(url: str, **_: Any) -> FakeSocket:
        urls.append(url)
        return socket

    monkeypatch.setattr(rc.websockets, "connect", connect)
    adapter, inbox = await started(server)
    with pytest.raises(ConnectionClosedError):
        await adapter._socket_session()
    await asyncio.sleep(0)
    for task in list(adapter._handlers):
        await task
    assert urls == ["wss://chat.example.com/websocket"]
    sent = socket.sent
    assert sent[0]["msg"] == "connect"
    login = next(f for f in sent if f.get("method") == "login")
    assert login["params"] == [{"resume": "synthetic-token"}]
    assert {"msg": "pong"} in sent
    subscriptions = {f["name"]: f["params"] for f in sent if f["msg"] == "sub"}
    assert subscriptions == {
        "stream-room-messages": ["__my_messages__", False],
        "stream-notify-user": [f"{BOT}/rooms-changed", False],
    }
    assert [m.message_ref for m in inbox.messages] == ["live"]
    assert [a.channel_id for a in inbox.apps] == ["r9"]


async def test_a_token_the_socket_refuses_is_a_credential_error(
    server: Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        rc.websockets, "connect", lambda url, **_: FakeSocket([], login_error=True)
    )
    adapter, _ = await started(server)
    with pytest.raises(BridgeCredentialError, match="Unauthorized"):
        await adapter._socket_session()
    await adapter._run_socket()
    assert (
        adapter.socket_failure is not None and "Unauthorized" in adapter.socket_failure
    )


async def test_after_a_dropped_socket_what_was_said_meanwhile_is_replayed_once(
    server: Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    server.routes["/api/v1/subscriptions.get"] = lambda r: ok(update=[{"rid": "room1"}])
    server.routes["/api/v1/chat.syncMessages"] = lambda r: ok(
        result={
            "updated": [
                post(_id="late", ts="2023-11-14T22:13:21.000Z"),
                post(_id="live", ts="2023-11-14T22:13:20.000Z"),
            ],
            "deleted": [],
        }
    )
    sockets = iter(
        [
            FakeSocket(
                [
                    changed(
                        "stream-room-messages", "__my_messages__", post(_id="live")
                    ),
                    ConnectionClosedError(None, None),
                ]
            ),
            FakeSocket([ConnectionClosedError(None, None)]),
        ]
    )
    monkeypatch.setattr(rc.websockets, "connect", lambda url, **_: next(sockets))
    adapter, inbox = await started(server)
    for _ in range(2):
        with pytest.raises(ConnectionClosedError):
            await adapter._socket_session()
        for task in list(adapter._handlers):
            await task
    assert [m.message_ref for m in inbox.messages] == ["live", "late"]
    asked = server.requests[-1].url.params
    assert asked["roomId"] == "room1"
    assert asked["lastUpdate"] == "2023-11-14T22:13:20.000Z"


async def test_a_quiet_bridge_opens_no_socket_but_still_serves_requests(
    server: Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    def connect(*_: Any, **__: Any) -> None:
        raise AssertionError("a quiet bridge must not open a socket")

    monkeypatch.setattr(rc.websockets, "connect", connect)
    server.routes["/api/v1/chat.postMessage"] = lambda r: ok(message={"_id": "q1"})
    adapter, _ = await started(server, listening=False)
    assert adapter._socket_task is None
    assert await adapter.send_message("room1", "helper", "still works") == "q1"
    await adapter.stop()


async def test_a_listening_bridge_starts_and_stops_its_socket(
    server: Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    gate = asyncio.Event()

    class Idle(FakeSocket):
        async def recv(self) -> str:
            await gate.wait()
            return "{}"

    monkeypatch.setattr(rc.websockets, "connect", lambda url, **_: Idle([]))
    adapter, _ = await started(server, listening=True)
    assert adapter._socket_task is not None
    await asyncio.sleep(0.01)
    await adapter.stop()
    assert adapter._socket_task is None


# Splitting
def test_a_short_text_is_one_post() -> None:
    assert split_message("hi") == ["hi"]


def test_a_cut_inside_a_code_fence_closes_and_reopens_it() -> None:
    text = "\n".join(["```py"] + ["x" * 100] * 30 + ["```", "after"])
    parts = split_message(text, 1000)
    assert len(parts) > 1
    assert all(len(part) <= 1000 for part in parts)
    assert all(part.count("```") % 2 == 0 for part in parts)
    assert parts[1].startswith("```py")


def test_one_endless_line_is_still_cut_to_fit() -> None:
    parts = split_message("y" * 9500, 4000)
    assert all(len(part) <= 4000 for part in parts)
    assert "".join(parts) == "y" * 9500
