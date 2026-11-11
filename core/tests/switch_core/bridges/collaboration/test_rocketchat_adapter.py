"""The Rocket.Chat adapter, against a mocked REST API.

The server is mocked at the HTTP transport (`httpx.MockTransport`), never by
patching the adapter's own methods, so every test exercises the real request the
adapter builds and the real parsing of what the server answers. The payloads
are shaped like what a Rocket.Chat 8.9 server actually sent.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from switch_core.bridges.collaboration.adapter import (
    ActivityMarkRefused,
    RequestCard,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    InboundCommand,
    InboundMessage,
)
from switch_core.bridges.collaboration.rocketchat import adapter as rocketchat_module
from switch_core.bridges.collaboration.rocketchat.adapter import (
    RocketChatAdapter,
    RocketChatConnectionConfig,
)
from switch_core.bridges.collaboration.rocketchat.client import RocketChatAPIError
from switch_core.bridges.collaboration.rocketchat.realtime import (
    RealtimeLoginRefused,
    RoomMessage,
    SubscriptionAdded,
)
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.outbound import OutboundPolicy
from switch_core.sessions.contract import TurnUpsert

from .session_fixtures import open_request

SERVER = "https://chat.example.test"
BOT_ID = "bot-id"

Handler = Callable[[httpx.Request], httpx.Response]


def _ok(body: dict[str, Any] | None = None) -> httpx.Response:
    return httpx.Response(200, json={"success": True, **(body or {})})


def _refused(message: str, error_type: str | None = None) -> httpx.Response:
    body: dict[str, Any] = {"success": False, "error": message}
    if error_type:
        body["errorType"] = error_type
    return httpx.Response(400, json=body)


class FakeServer:
    """A scripted server: routes by method and path, and records every call."""

    def __init__(self) -> None:
        self.calls: list[httpx.Request] = []
        self.routes: dict[tuple[str, str], Handler] = {}
        self.route(
            "GET",
            "/api/v1/me",
            lambda r: _ok(
                {
                    "_id": BOT_ID,
                    "username": "switchbot",
                    "roles": ["bot"],
                    "active": True,
                }
            ),
        )
        self.route("POST", "/api/v1/subscriptions.read", lambda r: _ok())

    def route(self, method: str, path: str, handler: Handler) -> None:
        self.routes[(method, path)] = handler

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        handler = self.routes.get((request.method, request.url.path))
        if handler is None:
            return httpx.Response(404, json={"error": f"no route {request.url.path}"})
        return handler(request)

    def bodies(self, path: str) -> list[dict[str, Any]]:
        return [
            json.loads(call.content)
            for call in self.calls
            if call.method == "POST" and call.url.path == path
        ]

    def sent(self) -> list[dict[str, Any]]:
        return [body["message"] for body in self.bodies("/api/v1/chat.sendMessage")]

    def accept_posts(self, ref: str = "m-new") -> None:
        self.route(
            "POST",
            "/api/v1/chat.sendMessage",
            lambda r: _ok({"message": {"_id": ref}}),
        )


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> FakeServer:
    fake = FakeServer()

    def http(*_: Any) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(fake))

    monkeypatch.setattr(rocketchat_module, "_new_http", http)
    monkeypatch.setattr(rocketchat_module, "_unguarded_http", http)
    return fake


def _config() -> RocketChatConnectionConfig:
    return RocketChatConnectionConfig.model_validate(
        {"server_url": SERVER, "user_id": BOT_ID, "access_token": "tok"}
    )


class Received:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []
        self.app_joins: list[Any] = []
        self.user_joins: list[Any] = []

    async def message(self, m: InboundMessage) -> None:
        self.messages.append(m)

    async def command(self, c: InboundCommand) -> None:
        self.commands.append(c)

    async def app_join(self, j: Any) -> None:
        self.app_joins.append(j)

    async def user_join(self, j: Any) -> None:
        self.user_joins.append(j)

    async def ignore(self, _: Any) -> None:
        return None


async def _started(server: FakeServer) -> tuple[RocketChatAdapter, Received]:
    """An adapter past `start`, quiet so that no socket is opened: these tests
    hand it events directly, and `test_rocketchat_realtime.py` covers the socket."""
    adapter = RocketChatAdapter(config=_config())
    adapter.set_listening(False)
    adapter.set_outbound_policy(OutboundPolicy.parse(""))
    adapter.set_bridge_id("b1")
    adapter.set_max_attachment_bytes(1000)
    received = Received()
    await adapter.start(
        received.message,
        received.command,
        received.ignore,
        received.user_join,
        received.app_join,
    )
    return adapter, received


def _message(**fields: Any) -> dict[str, Any]:
    return {
        "_id": "m1",
        "rid": "room-1",
        "msg": "hello",
        "ts": {"$date": 1793907170000},
        "u": {"_id": "ada-id", "username": "ada", "name": "Ada"},
        **fields,
    }


def _event(message: dict[str, Any], room_type: str = "c") -> RoomMessage:
    return RoomMessage(message, room_type, "general-chat")


# ── Connection settings ──────────────────────────────────────────────────────


class TestConfig:
    def test_a_trailing_slash_is_not_part_of_the_address(self) -> None:
        config = RocketChatConnectionConfig.model_validate(
            {"server_url": f"{SERVER}/", "user_id": "u", "access_token": "t"}
        )
        assert config.server_url == SERVER

    @pytest.mark.parametrize(
        "url", ["chat.example.test", "ftp://chat.example.test", ""]
    )
    def test_an_address_must_name_a_server(self, url: str) -> None:
        with pytest.raises(ValueError, match="server_url"):
            RocketChatConnectionConfig.model_validate(
                {"server_url": url, "user_id": "u", "access_token": "t"}
            )

    @pytest.mark.parametrize("field", ["user_id", "access_token"])
    @pytest.mark.parametrize("value", ["", "two words"])
    def test_a_credential_is_pasted_whole(self, field: str, value: str) -> None:
        settings = {"server_url": SERVER, "user_id": "u", "access_token": "t"}
        with pytest.raises(ValueError, match="exactly as Rocket.Chat showed it"):
            RocketChatConnectionConfig.model_validate({**settings, field: value})

    def test_the_server_address_is_held_to_the_outbound_policy(self) -> None:
        settings: dict[str, object] = {"server_url": f"{SERVER}/"}
        assert RocketChatAdapter.outbound_urls(settings) == [SERVER]

    def test_one_server_is_connected_once(self) -> None:
        settings: dict[str, object] = {"server_url": SERVER}
        assert SERVER in str(RocketChatAdapter.claimed_workspace(settings))


class TestCredentials:
    SETTINGS: dict[str, object] = {
        "server_url": SERVER,
        "user_id": BOT_ID,
        "access_token": "tok",
    }

    async def test_a_bot_account_is_accepted(self, server: FakeServer) -> None:
        await RocketChatAdapter.verify_credentials(self.SETTINGS)

    async def test_a_rejected_token_says_so(self, server: FakeServer) -> None:
        server.route(
            "GET",
            "/api/v1/me",
            lambda r: httpx.Response(401, json={"status": "error"}),
        )
        with pytest.raises(BridgeCredentialError, match="rejected"):
            await RocketChatAdapter.verify_credentials(self.SETTINGS)

    async def test_a_persons_account_is_refused(self, server: FakeServer) -> None:
        server.route(
            "GET",
            "/api/v1/me",
            lambda r: _ok({"username": "ada", "roles": ["user"], "active": True}),
        )
        with pytest.raises(BridgeCredentialError, match="person's account"):
            await RocketChatAdapter.verify_credentials(self.SETTINGS)

    async def test_a_deactivated_account_is_refused(self, server: FakeServer) -> None:
        server.route(
            "GET",
            "/api/v1/me",
            lambda r: _ok({"username": "b", "roles": ["bot"], "active": False}),
        )
        with pytest.raises(BridgeCredentialError, match="deactivated"):
            await RocketChatAdapter.verify_credentials(self.SETTINGS)

    async def test_something_else_at_the_address_says_so(
        self, server: FakeServer
    ) -> None:
        server.route(
            "GET", "/api/v1/me", lambda r: httpx.Response(200, text="<html>hi</html>")
        )
        with pytest.raises(BridgeCredentialError, match="did not answer like"):
            await RocketChatAdapter.verify_credentials(self.SETTINGS)

    async def test_an_unreachable_server_says_so(self, server: FakeServer) -> None:
        def down(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        server.route("GET", "/api/v1/me", down)
        with pytest.raises(BridgeCredentialError, match="Could not reach"):
            await RocketChatAdapter.verify_credentials(self.SETTINGS)


class TestClassifyFailure:
    def test_failures_are_named_from_their_types(self) -> None:
        def refusal(status: int) -> RocketChatAPIError:
            return RocketChatAPIError(status, "x", error_type=None, retry_after=None)

        classify = RocketChatAdapter.classify_failure
        assert classify(refusal(401)) == "auth_failed"
        assert classify(refusal(400)) == "platform_error"
        assert classify(RealtimeLoginRefused("x")) == "auth_failed"
        assert classify(httpx.ConnectError("x")) == "network"
        assert classify(ValueError("not ours")) is None


# ── Inbound ──────────────────────────────────────────────────────────────────


class TestInbound:
    async def test_a_message_reaches_the_room(self, server: FakeServer) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(_event(_message()))
        [message] = received.messages
        assert message.channel_id == "room-1"
        assert message.channel_type == "channel_public"
        assert message.channel_name == "general-chat"
        assert message.sender_id == "ada-id"
        assert message.sender_name == "ada"
        assert message.content == "hello"
        assert message.message_ref == "m1"
        assert message.root_id is None
        assert message.self_mention_token is None

    @pytest.mark.parametrize(
        ("room_type", "expected"),
        [("c", "channel_public"), ("p", "channel_private"), ("d", "direct")],
    )
    async def test_room_types_map(
        self, server: FakeServer, room_type: str, expected: str
    ) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(_event(_message(), room_type))
        assert received.messages[0].channel_type == expected

    async def test_a_thread_reply_names_its_root(self, server: FakeServer) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(_event(_message(tmid="root-1")))
        assert received.messages[0].root_id == "root-1"

    async def test_the_read_mark_moves_only_after_the_handover(
        self, server: FakeServer
    ) -> None:
        adapter, received = await _started(server)

        async def refuse(_: InboundMessage) -> None:
            raise RuntimeError("the room could not take it")

        adapter._on_message = refuse
        with pytest.raises(RuntimeError):
            await adapter._handle_event(_event(_message()))
        assert server.bodies("/api/v1/subscriptions.read") == []

        adapter._on_message = received.message
        await adapter._handle_event(_event(_message(_id="m2")))
        assert server.bodies("/api/v1/subscriptions.read") == [{"rid": "room-1"}]

    async def test_the_bots_own_post_is_not_relayed(self, server: FakeServer) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(
            _event(_message(u={"_id": BOT_ID, "username": "switchbot"}))
        )
        assert received.messages == []
        assert server.bodies("/api/v1/subscriptions.read") == []

    @pytest.mark.parametrize(
        "change",
        [
            {"editedAt": {"$date": 1}},
            {"reactions": {":eyes:": {"usernames": ["ada"]}}},
            {"tcount": 1},
        ],
    )
    async def test_a_message_delivered_again_is_old_news(
        self, server: FakeServer, change: dict[str, Any]
    ) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(_event(_message(**change)))
        assert received.messages == []

    async def test_a_second_delivery_is_not_handled_twice(
        self, server: FakeServer
    ) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(_event(_message()))
        await adapter._handle_event(_event(_message()))
        assert len(received.messages) == 1

    async def test_a_mention_of_the_bot_alone_is_for_the_rooms_agent(
        self, server: FakeServer
    ) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(_event(_message(msg="@switchbot why?")))
        assert received.messages[0].self_mention_token == "switchbot"

    async def test_naming_an_agent_as_well_says_who_it_is_for(
        self, server: FakeServer
    ) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(_event(_message(msg="@switchbot @claude why?")))
        assert received.messages[0].self_mention_token is None

    async def test_a_command(self, server: FakeServer) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(_event(_message(msg="!invite-agent claude")))
        [command] = received.commands
        assert command.command == "invite-agent"
        assert command.args == "claude"
        assert command.message_ref == "m1"
        assert received.messages == []

    async def test_an_integration_cannot_run_a_command_or_answer_a_card(
        self, server: FakeServer
    ) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(
            _event(_message(msg="!stop", bot={"i": "webhook-1"}))
        )
        assert received.commands == []
        assert received.messages[0].sender_is_app is True

    async def test_a_person_joining_is_told_to_the_room(
        self, server: FakeServer
    ) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(_event(_message(t="uj", msg="ada")))
        [join] = received.user_joins
        assert (join.external_user_id, join.external_username) == ("ada-id", "ada")
        assert received.messages == []

    async def test_a_person_added_is_looked_up_by_name(
        self, server: FakeServer
    ) -> None:
        adapter, received = await _started(server)
        server.route(
            "GET",
            "/api/v1/users.info",
            lambda r: _ok({"user": {"_id": "ben-id", "username": "ben"}}),
        )
        await adapter._handle_event(_event(_message(t="au", msg="ben")))
        assert received.user_joins[0].external_user_id == "ben-id"

    async def test_the_bot_being_added_is_not_a_person_joining(
        self, server: FakeServer
    ) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(_event(_message(t="au", msg="switchbot")))
        assert received.user_joins == []

    async def test_other_system_messages_are_dropped(self, server: FakeServer) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(_event(_message(t="room_changed_topic")))
        assert received.messages == []

    async def test_being_added_to_a_room_adopts_it(self, server: FakeServer) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(
            SubscriptionAdded({"rid": "room-2", "t": "p", "name": "ops"})
        )
        [join] = received.app_joins
        assert join.channel_id == "room-2"
        assert join.channel_type == "channel_private"

    @pytest.mark.parametrize(
        "subscription",
        [
            {"rid": "room-2", "t": "c", "roles": ["owner"]},
            {"rid": "room-2", "t": "d"},
        ],
    )
    async def test_a_room_the_bot_made_is_not_adopted_again(
        self, server: FakeServer, subscription: dict[str, Any]
    ) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(SubscriptionAdded(subscription))
        assert received.app_joins == []


class TestFiles:
    LINK = "/file-upload/f1/notes.txt"

    def _serve_file(self, server: FakeServer, body: bytes) -> None:
        server.route(
            "GET",
            self.LINK,
            lambda r: httpx.Response(
                200, content=body, headers={"content-type": "text/plain; charset=utf-8"}
            ),
        )

    async def test_a_file_is_relayed_with_the_bots_token(
        self, server: FakeServer
    ) -> None:
        adapter, received = await _started(server)
        self._serve_file(server, b"body")
        await adapter._handle_event(
            _event(
                _message(attachments=[{"title": "notes.txt", "title_link": self.LINK}])
            )
        )
        [attachment] = received.messages[0].attachments
        assert attachment.filename == "notes.txt"
        assert attachment.mimetype == "text/plain"
        assert attachment.data == b"body"
        assert server.calls[-2].headers["x-auth-token"] == "tok"

    async def test_a_declared_oversize_is_refused_without_downloading(
        self, server: FakeServer
    ) -> None:
        adapter, received = await _started(server)
        adapter.set_max_attachment_bytes(1024 * 1024)
        await adapter._handle_event(
            _event(
                _message(
                    attachments=[
                        {
                            "title": "big",
                            "title_link": self.LINK,
                            "size": 5 * 1024 * 1024,
                        }
                    ]
                )
            )
        )
        [failure] = received.messages[0].attachment_failures
        assert "5 MB" in failure.reason
        assert not [c for c in server.calls if c.url.path == self.LINK]

    async def test_a_file_that_outgrows_its_declared_size_is_cut_off(
        self, server: FakeServer
    ) -> None:
        adapter, received = await _started(server)
        self._serve_file(server, b"x" * 2000)
        await adapter._handle_event(
            _event(_message(attachments=[{"title": "n", "title_link": self.LINK}]))
        )
        assert received.messages[0].attachments == []
        assert received.messages[0].attachment_failures

    @pytest.mark.parametrize(
        "link",
        [
            "https://evil.example.test/file-upload/x/y",
            "//evil.example.test/file-upload/x/y",
            "/api/v1/users.list",
            "/file-upload/../api/v1/me",
        ],
    )
    async def test_the_token_never_goes_anywhere_but_the_file_route(
        self, server: FakeServer, link: str
    ) -> None:
        adapter, received = await _started(server)
        before = len(server.calls)
        await adapter._handle_event(
            _event(_message(attachments=[{"title": "n", "title_link": link}]))
        )
        assert received.messages[0].attachment_failures
        assert [c.url.path for c in server.calls[before:]] == [
            "/api/v1/subscriptions.read"
        ]

    async def test_a_failed_download_is_disclosed(self, server: FakeServer) -> None:
        adapter, received = await _started(server)
        server.route(
            "GET", self.LINK, lambda r: httpx.Response(403, json={"error": "no"})
        )
        await adapter._handle_event(
            _event(_message(attachments=[{"title": "n", "title_link": self.LINK}]))
        )
        assert (
            "the download failed" in received.messages[0].attachment_failures[0].reason
        )

    async def test_a_quoted_message_is_not_a_file(self, server: FakeServer) -> None:
        adapter, received = await _started(server)
        await adapter._handle_event(
            _event(_message(attachments=[{"text": "quoted", "message_link": "x"}]))
        )
        assert received.messages[0].attachments == []
        assert received.messages[0].attachment_failures == []

    async def test_a_file_goes_out_with_the_agent_named_and_in_its_thread(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route(
            "POST", "/api/v1/rooms.media/room-1", lambda r: _ok({"file": {"_id": "f9"}})
        )
        server.route(
            "POST",
            "/api/v1/rooms.mediaConfirm/room-1/f9",
            lambda r: _ok({"message": {"_id": "m-file"}}),
        )
        ref = await adapter.send_attachment(
            "room-1", "claude", "r.txt", "text/plain", b"data", "Here", "root-1"
        )
        assert ref == "m-file"
        [confirm] = server.bodies("/api/v1/rooms.mediaConfirm/room-1/f9")
        assert confirm == {"msg": "**claude**\nHere", "tmid": "root-1"}

    async def test_a_file_the_server_refuses_is_said_in_the_thread(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.accept_posts()
        server.route(
            "POST",
            "/api/v1/rooms.media/room-1",
            lambda r: _refused("File exceeds allowed size", "error-file-too-large"),
        )
        await adapter.send_attachment(
            "room-1", "claude", "big.bin", "text/plain", b"data", None, "root-1"
        )
        [notice] = server.sent()
        assert "big.bin" in notice["msg"]
        assert "File exceeds allowed size" in notice["msg"]
        assert notice["tmid"] == "root-1"


class TestReadBack:
    def _room(self, server: FakeServer, *messages: dict[str, Any], **sub: Any) -> None:
        mark = datetime.now(UTC) - timedelta(minutes=10)
        server.route(
            "GET",
            "/api/v1/subscriptions.get",
            lambda r: _ok(
                {
                    "update": [
                        {
                            "rid": "room-1",
                            "t": "c",
                            "name": "ops",
                            "ls": _iso(mark),
                            **sub,
                        }
                    ]
                }
            ),
        )
        server.route(
            "GET",
            "/api/v1/chat.syncMessages",
            lambda r: _ok({"result": {"updated": list(messages), "deleted": []}}),
        )

    async def test_what_was_missed_is_relayed_in_order(
        self, server: FakeServer
    ) -> None:
        adapter, received = await _started(server)
        now = datetime.now(UTC)
        self._room(
            server,
            _message(_id="later", ts=_iso(now - timedelta(minutes=1))),
            _message(_id="earlier", ts=_iso(now - timedelta(minutes=5))),
        )
        await adapter._read_back()
        assert [m.message_ref for m in received.messages] == ["earlier", "later"]
        assert received.messages[0].channel_name == "ops"
        assert server.bodies("/api/v1/subscriptions.read") == [{"rid": "room-1"}]

    async def test_an_older_message_that_only_changed_is_left_alone(
        self, server: FakeServer
    ) -> None:
        adapter, received = await _started(server)
        self._room(
            server, _message(ts=_iso(datetime.now(UTC) - timedelta(hours=3)), tcount=2)
        )
        await adapter._read_back()
        assert received.messages == []

    async def test_a_message_edited_while_down_arrives_as_it_now_reads(
        self, server: FakeServer
    ) -> None:
        adapter, received = await _started(server)
        self._room(
            server,
            _message(
                msg="fixed typo",
                ts=_iso(datetime.now(UTC) - timedelta(minutes=1)),
                editedAt={"$date": 1},
            ),
        )
        await adapter._read_back()
        assert received.messages[0].content == "fixed typo"

    async def test_a_command_missed_while_down_is_run(self, server: FakeServer) -> None:
        adapter, received = await _started(server)
        self._room(
            server,
            _message(msg="!status", ts=_iso(datetime.now(UTC) - timedelta(minutes=1))),
        )
        await adapter._read_back()
        assert received.commands[0].message_ref == "m1"

    async def test_a_week_old_mark_reads_back_only_a_day(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        self._room(server, ls=_iso(datetime.now(UTC) - timedelta(days=7)), unread=3)
        await adapter._read_back()
        [call] = [c for c in server.calls if "syncMessages" in c.url.path]
        since = datetime.fromisoformat(
            call.url.params["lastUpdate"].replace("Z", "+00:00")
        )
        assert datetime.now(UTC) - since < timedelta(hours=25)

    async def test_a_room_that_cannot_be_read_does_not_stop_the_others(
        self, server: FakeServer
    ) -> None:
        adapter, received = await _started(server)
        mark = _iso(datetime.now(UTC) - timedelta(minutes=10))
        server.route(
            "GET",
            "/api/v1/subscriptions.get",
            lambda r: _ok(
                {
                    "update": [
                        {"rid": "broken", "t": "c", "ls": mark},
                        {"rid": "room-1", "t": "c", "ls": mark},
                    ]
                }
            ),
        )

        def sync(request: httpx.Request) -> httpx.Response:
            if request.url.params["roomId"] == "broken":
                return _refused("nope")
            fresh = _message(ts=_iso(datetime.now(UTC)))
            return _ok({"result": {"updated": [fresh], "deleted": []}})

        server.route("GET", "/api/v1/chat.syncMessages", sync)
        await adapter._read_back()
        assert [m.channel_id for m in received.messages] == ["room-1"]
        assert server.bodies("/api/v1/subscriptions.read") == [{"rid": "room-1"}]


# ── Outbound ─────────────────────────────────────────────────────────────────


class TestOutbound:
    async def test_a_post_carries_the_agents_name_and_thread(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.accept_posts()
        assert await adapter.send_message("room-1", "claude", "hi", "root-1") == "m-new"
        [sent] = server.sent()
        assert sent["rid"] == "room-1"
        assert sent["msg"] == "hi"
        assert sent["tmid"] == "root-1"
        assert sent["alias"] == "claude"

    async def test_a_long_reply_is_split_in_one_thread(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.accept_posts()
        await adapter.send_message("room-1", "claude", "line\n" * 2000, "root-1")
        sent = server.sent()
        assert len(sent) > 1
        assert all(part["tmid"] == "root-1" for part in sent)
        assert all(len(part["msg"]) <= 4500 for part in sent)

    async def test_a_server_that_forbids_aliases_gets_the_name_in_the_text(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)

        def post(request: httpx.Request) -> httpx.Response:
            if "alias" in json.loads(request.content)["message"]:
                return _refused("Not enough permission")
            return _ok({"message": {"_id": "m-new"}})

        server.route("POST", "/api/v1/chat.sendMessage", post)
        await adapter.send_message("room-1", "claude", "hi", None)
        await adapter.send_message("room-1", "claude", "again", None)
        sent = server.sent()
        assert [part["msg"] for part in sent] == [
            "hi",
            "**claude**\nhi",
            "**claude**\nagain",
        ]

    async def test_an_admin_notice_is_the_bots_own(self, server: FakeServer) -> None:
        adapter, _ = await _started(server)
        server.accept_posts()
        await adapter.admin_message("room-1", "Notice", None)
        assert "alias" not in server.sent()[0]

    async def test_a_refused_message_is_logged_and_reported_by_none(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route(
            "POST", "/api/v1/chat.sendMessage", lambda r: _refused("room is read only")
        )
        assert await adapter.send_message("room-1", "claude", "hi", None) is None

    async def test_an_edit_rewrites_the_text(self, server: FakeServer) -> None:
        adapter, _ = await _started(server)
        server.route("POST", "/api/v1/chat.update", lambda r: _ok())
        await adapter.update_message("room-1", "m1", "new")
        assert server.bodies("/api/v1/chat.update") == [
            {"roomId": "room-1", "msgId": "m1", "text": "new"}
        ]

    async def test_a_delete(self, server: FakeServer) -> None:
        adapter, _ = await _started(server)
        server.route("POST", "/api/v1/chat.delete", lambda r: _ok())
        await adapter.delete_message("room-1", "m1")
        assert server.bodies("/api/v1/chat.delete") == [
            {"roomId": "room-1", "msgId": "m1"}
        ]

    async def test_working_and_queued_are_different_reactions(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route("POST", "/api/v1/chat.react", lambda r: _ok())
        await adapter.mark_activity(
            "room-1", "m1", agent_name="claude", mark="working", on=True
        )
        await adapter.mark_activity(
            "room-1", "m1", agent_name="claude", mark="queued", on=False
        )
        assert server.bodies("/api/v1/chat.react") == [
            {"messageId": "m1", "emoji": ":eyes:", "shouldReact": True},
            {
                "messageId": "m1",
                "emoji": ":hourglass_flowing_sand:",
                "shouldReact": False,
            },
        ]

    async def test_a_refused_reaction_will_not_be_retried(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route(
            "POST", "/api/v1/chat.react", lambda r: _refused("Reactions are off")
        )
        with pytest.raises(ActivityMarkRefused):
            await adapter.mark_activity(
                "room-1", "m1", agent_name="claude", mark="working", on=True
            )

    async def test_a_reaction_that_might_work_later_is_left_to_raise(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route(
            "POST", "/api/v1/chat.react", lambda r: httpx.Response(503, json={})
        )
        with pytest.raises(RocketChatAPIError):
            await adapter.mark_activity(
                "room-1", "m1", agent_name="claude", mark="working", on=True
            )


def _card(**fields: Any) -> RequestCard:
    return RequestCard(
        open_request(), RequestReference(token="tok-1", handle="R7"), **fields
    )


def _turn(status: str = "running") -> TurnActivity:
    turn = TurnUpsert.model_validate(
        {"type": "turn.upsert", "turn_id": "t1", "status": status, "command_id": None}
    )
    return TurnActivity([], turn)


class TestCards:
    def test_the_platform_draws_session_activity(self) -> None:
        assert RocketChatAdapter.draws_session_activity is True
        assert RocketChatAdapter.removes_answered_cards is False

    async def test_a_button_says_what_typing_the_answer_would(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.accept_posts("card-1")
        assert (
            await adapter.post_rich("room-1", "claude", _card(), "root-1") == "card-1"
        )
        [sent] = server.sent()
        assert sent["tmid"] == "root-1"
        assert sent["alias"] == "claude"
        assert "R7" in sent["msg"]
        [attachment] = sent["attachments"]
        for position, action in enumerate(attachment["actions"], start=1):
            assert action["type"] == "button"
            assert action["msg"] == f"R7 {position}"
            assert action["msg_in_chat_window"] is True

    async def test_a_redrawn_open_card_keeps_its_buttons(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route(
            "POST",
            "/api/v1/method.call/updateMessage",
            lambda r: _ok({"message": json.dumps({"msg": "result", "id": "1"})}),
        )
        await adapter.update_rich("room-1", "claude", "card-1", _card(), None)
        [call] = server.bodies("/api/v1/method.call/updateMessage")
        [params] = json.loads(call["message"])["params"]
        assert params["_id"] == "card-1"
        assert params["attachments"][0]["actions"]

    async def test_a_card_that_cannot_be_answered_loses_its_buttons(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route(
            "POST",
            "/api/v1/method.call/updateMessage",
            lambda r: _ok({"message": json.dumps({"msg": "result", "id": "1"})}),
        )
        await adapter.update_rich(
            "room-1",
            "claude",
            "card-1",
            _card(unavailable_reason="Answer this in Console."),
            None,
        )
        [call] = server.bodies("/api/v1/method.call/updateMessage")
        [params] = json.loads(call["message"])["params"]
        assert params["attachments"] == []
        assert "Answer this in Console." in params["msg"]

    async def test_a_refusal_inside_a_200_is_still_a_refusal(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        result = {"msg": "result", "id": "1", "error": {"message": "Not allowed"}}
        server.route(
            "POST",
            "/api/v1/method.call/updateMessage",
            lambda r: _ok({"message": json.dumps(result)}),
        )
        with pytest.raises(RichContentFailed, match="Not allowed"):
            await adapter.update_rich("room-1", "claude", "card-1", _card(), None)

    async def test_a_card_names_who_it_is_waiting_on(self, server: FakeServer) -> None:
        adapter, _ = await _started(server)
        server.accept_posts()
        server.route(
            "GET",
            "/api/v1/users.info",
            lambda r: _ok({"user": {"_id": "ada-id", "username": "ada"}}),
        )
        await adapter.post_rich(
            "room-1", "claude", _card(notify_external_id="ada-id"), None
        )
        assert server.sent()[0]["msg"].startswith("@ada\n")

    async def test_someone_who_cannot_be_looked_up_is_not_guessed_at(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.accept_posts()
        server.route("GET", "/api/v1/users.info", lambda r: _refused("no such user"))
        await adapter.post_rich(
            "room-1", "claude", _card(notify_external_id="gone"), None
        )
        assert "@" not in server.sent()[0]["msg"].split("\n")[0]

    async def test_a_status_edit_leaves_attachments_alone(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route("POST", "/api/v1/chat.update", lambda r: _ok())
        await adapter.update_rich("room-1", "claude", "s1", _turn("completed"), None)
        [body] = server.bodies("/api/v1/chat.update")
        assert body["msgId"] == "s1"
        assert "attachments" not in body

    async def test_a_rate_limit_is_a_wait_not_a_refusal(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route(
            "POST",
            "/api/v1/chat.sendMessage",
            lambda r: httpx.Response(429, headers={"retry-after": "12"}, json={}),
        )
        with pytest.raises(RichContentThrottled) as caught:
            await adapter.post_rich("room-1", "claude", _card(), None)
        assert caught.value.retry_after == 12

    async def test_a_refused_post_is_a_rich_content_failure(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route(
            "POST", "/api/v1/chat.sendMessage", lambda r: _refused("room is read only")
        )
        with pytest.raises(RichContentFailed, match="read only"):
            await adapter.post_rich("room-1", "claude", _turn(), None)

    async def test_a_post_whose_outcome_is_unknown_keeps_the_reservation(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route(
            "POST", "/api/v1/chat.sendMessage", lambda r: httpx.Response(502, json={})
        )
        with pytest.raises(RocketChatAPIError):
            await adapter.post_rich("room-1", "claude", _turn(), None)

    async def test_the_first_reply_is_read_from_the_thread(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route(
            "GET",
            "/api/v1/chat.getThreadMessages",
            lambda r: _ok({"messages": [{"_id": "first"}]}),
        )
        assert await adapter.is_first_reply("room-1", "root", "first") is True
        assert await adapter.is_first_reply("room-1", "root", "second") is False

    async def test_an_unreadable_thread_is_not_a_first_reply(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route(
            "GET", "/api/v1/chat.getThreadMessages", lambda r: _refused("nope")
        )
        assert await adapter.is_first_reply("room-1", "root", "m") is False


class TestRooms:
    async def test_a_new_room_gets_a_valid_name_and_its_topic(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route(
            "POST",
            "/api/v1/groups.create",
            lambda r: _ok({"group": {"_id": "room-new"}}),
        )
        server.route("POST", "/api/v1/groups.setTopic", lambda r: _ok())
        room = await adapter.create_channel(
            "Incident 42!", "Payments are down", channel_type="channel_private"
        )
        assert room == "room-new"
        assert server.bodies("/api/v1/groups.create") == [{"name": "incident-42"}]
        assert server.bodies("/api/v1/groups.setTopic")[0]["topic"] == (
            "Payments are down"
        )

    async def test_a_refused_room_says_why(self, server: FakeServer) -> None:
        adapter, _ = await _started(server)
        server.route(
            "POST",
            "/api/v1/channels.create",
            lambda r: _refused("A channel with name 'x' exists"),
        )
        with pytest.raises(BridgeOperationError, match="exists"):
            await adapter.create_channel("x", "", channel_type="channel_public")

    async def test_a_direct_conversation(self, server: FakeServer) -> None:
        adapter, _ = await _started(server)
        server.route(
            "GET",
            "/api/v1/users.info",
            lambda r: _ok({"user": {"username": "ada"}}),
        )
        server.route(
            "POST", "/api/v1/im.create", lambda r: _ok({"room": {"rid": "dm-1"}})
        )
        room = await adapter.create_dm_channel(
            agent_name="claude", user_name="Ada", user_external_id="ada-id"
        )
        assert room == "dm-1"
        assert server.bodies("/api/v1/im.create") == [{"username": "ada"}]

    async def test_people_who_could_not_be_added_are_handed_back(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route("GET", "/api/v1/rooms.info", lambda r: _ok({"room": {"t": "c"}}))

        def invite(request: httpx.Request) -> httpx.Response:
            if json.loads(request.content)["userId"] == "ghost":
                return _refused("no such user")
            return _ok()

        server.route("POST", "/api/v1/channels.invite", invite)
        left = await adapter.add_users_to_channel(
            "room-1", ["ada", "ghost"], ["ada-id", "ghost"]
        )
        assert left == ["ghost"]

    async def test_deleting_a_room_archives_its_channel(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        server.route("GET", "/api/v1/rooms.info", lambda r: _ok({"room": {"t": "p"}}))
        server.route("POST", "/api/v1/groups.archive", lambda r: _ok())
        outcome = await adapter.retire_channel("room-1")
        assert outcome.outcome == "archived"
        assert RocketChatAdapter.channel_on_delete == "archived"

    async def test_a_refused_archive_is_reported(self, server: FakeServer) -> None:
        adapter, _ = await _started(server)
        server.route("GET", "/api/v1/rooms.info", lambda r: _ok({"room": {"t": "c"}}))
        server.route(
            "POST", "/api/v1/channels.archive", lambda r: _refused("Not allowed")
        )
        assert (await adapter.retire_channel("room-1")).outcome == "failed"

    @pytest.mark.parametrize(
        ("room_type", "path"),
        [("c", "channel/ops"), ("p", "group/ops"), ("d", "direct/ops")],
    )
    async def test_a_deeplink_opens_the_room(
        self, server: FakeServer, room_type: str, path: str
    ) -> None:
        adapter, _ = await _started(server)
        server.route(
            "GET",
            "/api/v1/rooms.info",
            lambda r: _ok({"room": {"t": room_type, "name": "ops"}}),
        )
        assert await adapter.channel_deeplink("room-1") == f"{SERVER}/{path}"

    async def test_the_directory_leaves_out_the_bot(self, server: FakeServer) -> None:
        adapter, _ = await _started(server)
        server.route(
            "GET",
            "/api/v1/users.autocomplete",
            lambda r: _ok({"items": [{"_id": "a", "username": "ada", "name": "Ada"}]}),
        )
        [user] = await adapter.search_directory_users("ad")
        assert (user.external_user_id, user.username, user.display_name) == (
            "a",
            "ada",
            "Ada",
        )
        selector = json.loads(server.calls[-1].url.params["selector"])
        assert selector == {"term": "ad", "exceptions": ["switchbot"]}


class TestMarkup:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("*bold* text", "**bold** text"),
            ("`*code*` and ```\n*fence*\n```", "`*code*` and ```\n*fence*\n```"),
            ("2 * 3 * 4", "2 * 3 * 4"),
            ("**already**", "**already**"),
        ],
    )
    async def test_inbound(self, server: FakeServer, raw: str, expected: str) -> None:
        adapter, _ = await _started(server)
        assert adapter.translate_inbound(raw) == expected

    async def test_italic_goes_out_as_rocket_chat_writes_it(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        assert adapter.translate_outbound("*soft* **loud** `*code*`") == (
            "_soft_ **loud** `*code*`"
        )

    async def test_a_mass_mention_from_an_agent_pages_nobody(
        self, server: FakeServer
    ) -> None:
        adapter, _ = await _started(server)
        assert "@all" not in adapter.translate_outbound("tell @all now")


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")
