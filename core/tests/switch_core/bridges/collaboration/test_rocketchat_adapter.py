"""The Rocket.Chat adapter against its HTTP API, mocked at the transport.

The payloads are shaped as a Rocket.Chat 8.9 server sent them. Ids and names
are invented.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosedOK

from switch_core.bridges.collaboration.adapter import (
    ActivityMarkRefused,
    AgentIdentity,
    AgentPresentation,
    RequestCard,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.bridges.collaboration.rocketchat import adapter as module
from switch_core.bridges.collaboration.rocketchat.adapter import (
    RocketChatAdapter,
    RocketChatConnectionConfig,
    _Joined,
    _Posted,
    _publication_id,
    _ReadBack,
)
from switch_core.bridges.collaboration.rocketchat.client import (
    RocketChatAuthError,
    RocketChatClient,
    RocketChatRefused,
    RocketChatThrottled,
    RocketChatUnavailable,
)
from switch_core.bridges.collaboration.rocketchat.realtime import (
    RealtimeError,
    RocketChatRealtime,
    websocket_url,
)
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.outbound import OutboundPolicy, OutboundURLRefused

from .rocketchat_fakes import DdpServer, until
from .session_fixtures import _item, _turn, open_request

SERVER = "https://chat.example.test"
BOT = "botUserId"
PERSON = "personUserId"
ROOM = "roomId"

CONFIG = {
    "url": SERVER,
    "user_id": BOT,
    "personal_access_token": "fixture-token",
}

Handler = Callable[[httpx.Request], httpx.Response]


def ok(**body: Any) -> httpx.Response:
    return httpx.Response(200, json={"success": True, **body})


def refused(error_type: str, status: int = 400) -> httpx.Response:
    return httpx.Response(
        status,
        json={"success": False, "error": f"No [{error_type}]", "errorType": error_type},
    )


class Server:
    """Answers by endpoint and records every request it was sent."""

    def __init__(self, routes: dict[str, Handler | httpx.Response] | None = None):
        self.routes: dict[str, Handler | httpx.Response] = routes or {}
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        endpoint = request.url.path.removeprefix("/api/v1/")
        route = self.routes.get(endpoint)
        if route is None:
            for known, candidate in self.routes.items():
                if endpoint.startswith(known):
                    route = candidate
                    break
        if route is None:
            raise AssertionError(f"Unexpected call to {endpoint}")
        return route(request) if callable(route) else route

    def to(self, endpoint: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path.endswith(endpoint)]

    def body(self, endpoint: str, index: int = -1) -> dict[str, Any]:
        return json.loads(self.to(endpoint)[index].content)


def message_response(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)["message"]
    return ok(message={"_id": body.get("_id", "generated"), **body})


def adapter_on(
    server: Server, *, config: dict[str, Any] | None = None
) -> RocketChatAdapter:
    adapter = RocketChatAdapter(
        config=RocketChatConnectionConfig.model_validate({**CONFIG, **(config or {})})
    )
    http = httpx.AsyncClient(transport=httpx.MockTransport(server))
    adapter._client = RocketChatClient(
        http, url=SERVER, user_id=BOT, token="fixture-token"
    )
    adapter._bot_username = "switchbot"
    adapter._connected.set()
    return adapter


def posted(**fields: Any) -> dict[str, Any]:
    return {
        "_id": "msg1",
        "rid": ROOM,
        "msg": "hello",
        "ts": {"$date": 1_000_000},
        "_updatedAt": {"$date": 1_000_050},
        "u": {"_id": PERSON, "username": "alice", "name": "Alice"},
        "mentions": [],
        **fields,
    }


def stream_event(message: dict[str, Any], room_type: str = "c") -> _Posted:
    return _Posted(message=message, room_type=room_type, room_name="general")


def listening(adapter: RocketChatAdapter) -> AsyncMock:
    on_message = AsyncMock()
    adapter._on_message = on_message
    adapter._on_command = AsyncMock()
    adapter._on_user_joined = AsyncMock()
    adapter._on_app_joined = AsyncMock()
    return on_message


# ── Config ───────────────────────────────────────────────────────────────────


def test_config_normalises_the_server_url() -> None:
    config = RocketChatConnectionConfig.model_validate(
        {**CONFIG, "url": " HTTPS://Chat.Example.Test:443/rc/ "}
    )
    assert config.url == "https://chat.example.test/rc"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("url", "ftp://chat.example.test"),
        ("url", "chat.example.test"),
        ("url", "https://chat.example.test/?a=1"),
        ("url", "https://chat.example.test:notaport"),
        ("url", "  "),
        ("user_id", "   "),
        ("personal_access_token", ""),
    ],
)
def test_config_refuses(field: str, value: str) -> None:
    with pytest.raises(ValidationError) as error:
        RocketChatConnectionConfig.model_validate({**CONFIG, field: value})
    assert field in str(error.value)


def test_config_error_does_not_echo_the_token() -> None:
    with pytest.raises(ValidationError) as error:
        RocketChatConnectionConfig.model_validate({**CONFIG, "url": "nonsense"})
    assert "fixture-token" not in str(error.value)


def test_the_connect_form_is_built_from_the_config() -> None:
    schema = RocketChatConnectionConfig.model_json_schema()
    assert schema["required"] == ["url", "user_id", "personal_access_token"]
    assert schema["properties"]["url"]["title"] == "Server URL"


def test_the_same_server_is_claimed_however_it_is_spelled() -> None:
    claims = {
        RocketChatAdapter.claimed_workspace({"url": url})
        for url in (
            "https://chat.example.test",
            "https://CHAT.example.test/",
            "https://chat.example.test:443",
        )
    }
    assert claims == {"Rocket.Chat server https://chat.example.test"}


def test_the_server_url_goes_through_the_outbound_policy() -> None:
    assert RocketChatAdapter.outbound_urls({"url": "https://chat.example.test/"}) == [
        "https://chat.example.test"
    ]


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://chat.example.test", "wss://chat.example.test/websocket"),
        ("http://localhost:3000/rc", "ws://localhost:3000/rc/websocket"),
    ],
)
def test_websocket_url(url: str, expected: str) -> None:
    assert websocket_url(url) == expected


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("https://chat.example.test:8443/", "https://chat.example.test:8443"),
        ("http://[::1]:3000/rc/", "http://[::1]:3000/rc"),
        ("http://[::1]/", "http://[::1]"),
    ],
)
def test_the_server_url_keeps_a_port_that_is_not_the_default(
    given: str, expected: str
) -> None:
    config = RocketChatConnectionConfig.model_validate({**CONFIG, "url": given})
    assert config.url == expected


def test_a_blank_public_url_is_no_public_url() -> None:
    config = RocketChatConnectionConfig.model_validate({**CONFIG, "public_url": "  "})
    assert config.public_url is None


@pytest.mark.parametrize(
    ("value", "millis"),
    [
        ({"$date": 1_500}, 1_500),
        (1_500, 1_500),
        ("1970-01-01T00:00:01.500Z", 1_500),
        (None, 0),
        ("", 0),
    ],
)
def test_a_server_time_is_read_in_milliseconds(value: Any, millis: int) -> None:
    assert module._millis(value) == millis


# ── Credentials ──────────────────────────────────────────────────────────────


POLICY = OutboundPolicy.parse("")


def patch_plain_client(
    monkeypatch: pytest.MonkeyPatch, server: Server | Callable[..., httpx.Response]
) -> None:
    def guarded(policy: OutboundPolicy, **kwargs: Any) -> httpx.AsyncClient:
        assert policy is POLICY
        kwargs.pop("verify", None)
        return httpx.AsyncClient(transport=httpx.MockTransport(server), **kwargs)

    monkeypatch.setattr(module, "guarded_async_client", guarded)


PERMISSIONS = {
    "update": [
        {"_id": "message-impersonate", "roles": ["bot", "app"]},
        {"_id": "delete-own-message", "roles": ["admin", "user"]},
    ]
}


async def test_good_credentials_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    server = Server(
        {
            "me": ok(_id=BOT, username="switchbot", roles=["bot"]),
            "permissions.listAll": ok(**PERMISSIONS),
        }
    )
    patch_plain_client(monkeypatch, server)
    await RocketChatAdapter.verify_credentials(dict(CONFIG), POLICY)
    sent = server.to("/me")[0].headers
    assert sent["x-user-id"] == BOT
    assert sent["x-auth-token"] == "fixture-token"


async def test_a_rejected_token_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_plain_client(monkeypatch, Server({"me": httpx.Response(401, json={})}))
    with pytest.raises(BridgeCredentialError, match="personal access token"):
        await RocketChatAdapter.verify_credentials(dict(CONFIG), POLICY)


async def test_an_unreachable_server_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    patch_plain_client(monkeypatch, unreachable)
    with pytest.raises(BridgeCredentialError, match="Could not reach"):
        await RocketChatAdapter.verify_credentials(dict(CONFIG), POLICY)


async def test_something_that_is_not_rocket_chat_says_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_plain_client(
        monkeypatch, Server({"me": httpx.Response(200, text="<html>hello</html>")})
    )
    with pytest.raises(BridgeCredentialError, match="not Rocket.Chat's API"):
        await RocketChatAdapter.verify_credentials(dict(CONFIG), POLICY)


async def test_an_account_without_the_bot_role_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = Server(
        {
            "me": ok(_id=PERSON, username="alice", roles=["user"]),
            "permissions.listAll": ok(**PERMISSIONS),
        }
    )
    patch_plain_client(monkeypatch, server)
    with pytest.raises(BridgeCredentialError, match="bot role"):
        await RocketChatAdapter.verify_credentials(dict(CONFIG), POLICY)


async def test_a_server_the_policy_refuses_is_never_sent_the_token() -> None:
    with pytest.raises(BridgeCredentialError, match="may not connect"):
        await RocketChatAdapter.verify_credentials(
            {**CONFIG, "url": "http://127.0.0.1:9"}, POLICY
        )


def test_failures_are_named_by_the_shared_classes() -> None:
    assert issubclass(RocketChatAuthError, BridgeCredentialError)
    assert issubclass(RocketChatRefused, BridgeOperationError)
    assert issubclass(RocketChatUnavailable, BridgeOperationError)


# ── Start ────────────────────────────────────────────────────────────────────


def started_server(**extra: Any) -> Server:
    return Server(
        {
            "me": ok(_id=BOT, username="switchbot", roles=["bot"]),
            "settings.public": ok(
                settings=[{"_id": "Message_MaxAllowedSize", "value": 1200}]
            ),
            "permissions.listAll": ok(**PERMISSIONS),
            **extra,
        }
    )


async def start_quietly(
    monkeypatch: pytest.MonkeyPatch, server: Server
) -> RocketChatAdapter:
    monkeypatch.setattr(
        module,
        "guarded_async_client",
        lambda *a, **k: httpx.AsyncClient(transport=httpx.MockTransport(server)),
    )
    adapter = RocketChatAdapter(config=RocketChatConnectionConfig(**CONFIG))
    adapter.set_outbound_policy(OutboundPolicy.parse(""))
    adapter.set_listening(False)
    callback = AsyncMock()
    await adapter.start(callback, callback, callback, callback, callback)
    return adapter


async def test_a_refused_start_lets_go_of_its_http_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            Server({"me": httpx.Response(401, json={})}).__call__
        )
    )
    monkeypatch.setattr(module, "guarded_async_client", lambda *a, **k: http)
    adapter = RocketChatAdapter(config=RocketChatConnectionConfig(**CONFIG))
    adapter.set_outbound_policy(OutboundPolicy.parse(""))
    callback = AsyncMock()
    with pytest.raises(RocketChatAuthError):
        await adapter.start(callback, callback, callback, callback, callback)
    assert http.is_closed


async def test_a_quiet_copy_opens_no_connection_and_still_posts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = started_server(**{"chat.sendMessage": message_response})
    adapter = await start_quietly(monkeypatch, server)
    assert adapter._realtime is None
    assert adapter._tasks == []
    assert await adapter.send_message(ROOM, "cody", "hi") == "generated"
    await adapter.stop()


async def test_the_server_decides_how_long_a_message_may_be(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = await start_quietly(monkeypatch, started_server())
    assert adapter.rich_fallback_limit() == 1200
    await adapter.stop()


async def test_a_missing_delete_permission_is_shown_on_the_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = await start_quietly(monkeypatch, started_server())
    notice = await adapter.attention()
    assert notice is not None and "delete-own-message" in notice
    await adapter.stop()


async def test_a_granted_delete_permission_needs_no_notice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = started_server(
        **{
            "permissions.listAll": ok(
                update=[{"_id": "delete-own-message", "roles": ["bot"]}]
            )
        }
    )
    adapter = await start_quietly(monkeypatch, server)
    assert await adapter.attention() is None
    await adapter.stop()


async def test_a_token_revoked_while_running_is_shown_on_the_connection() -> None:
    adapter = adapter_on(Server())
    adapter._note_login_refused()
    notice = await adapter.attention()
    assert notice is not None and "personal access token" in notice


async def test_a_token_rejected_on_a_call_is_shown_and_clears_when_replaced() -> None:
    answers = iter([httpx.Response(401, json={}), ok(message={"_id": "m1"})])
    adapter = adapter_on(Server({"chat.sendMessage": lambda request: next(answers)}))
    assert await adapter.send_message(ROOM, "cody", "hi") is None
    notice = await adapter.attention()
    assert notice is not None and "personal access token" in notice
    assert await adapter.send_message(ROOM, "cody", "hi") == "m1"
    assert await adapter.attention() is None


async def test_quiet_copies_read_nothing_back() -> None:
    adapter = adapter_on(Server())
    adapter.set_listening(False)
    await adapter.ensure_channel_subscriptions([(ROOM, "channel_public")])
    assert adapter._incoming.empty()


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(500),
        ok(settings=[]),
        ok(settings=[{"_id": "Message_MaxAllowedSize", "value": "lots"}]),
    ],
)
async def test_a_message_size_that_cannot_be_read_is_the_default_and_says_so(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    answer: httpx.Response,
) -> None:
    adapter = await start_quietly(
        monkeypatch, started_server(**{"settings.public": answer})
    )
    assert adapter.rich_fallback_limit() == module._DEFAULT_MAX_MESSAGE
    assert "Could not read Rocket.Chat's message size limit" in caplog.text
    await adapter.stop()


async def test_a_message_size_too_small_to_split_to_is_the_default_and_says_so(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    answer = ok(settings=[{"_id": "Message_MaxAllowedSize", "value": 8}])
    adapter = await start_quietly(
        monkeypatch, started_server(**{"settings.public": answer})
    )
    assert adapter.rich_fallback_limit() == module._DEFAULT_MAX_MESSAGE
    assert "below the 100 Switch can split a message to fit" in caplog.text
    await adapter.stop()


async def test_a_connection_that_is_ready_clears_a_refused_login_notice() -> None:
    adapter = adapter_on(Server())
    adapter._note_login_refused()
    assert await adapter.attention() is not None
    adapter._on_realtime_ready()
    assert await adapter.attention() is None
    assert isinstance(adapter._incoming.get_nowait(), _ReadBack)


async def test_a_listening_adapter_relays_what_the_stream_sends(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ddp = DdpServer()
    async with serve(ddp, "127.0.0.1", 0) as listening:
        port = listening.sockets[0].getsockname()[1]
        rest = started_server(**markers_move())
        monkeypatch.setattr(
            module,
            "guarded_async_client",
            lambda *a, **k: httpx.AsyncClient(transport=httpx.MockTransport(rest)),
        )
        adapter = RocketChatAdapter(
            config=RocketChatConnectionConfig(
                **{**CONFIG, "url": f"http://127.0.0.1:{port}"}
            )
        )
        adapter.set_outbound_policy(OutboundPolicy.parse("127.0.0.0/8"))
        adapter.set_listening(True)
        on_message, callback = AsyncMock(), AsyncMock()
        await adapter.start(on_message, callback, callback, callback, callback)
        try:
            await until(
                lambda: len([f for f in ddp.received if f.get("msg") == "sub"]) == 2
            )
            await ddp.push(
                "stream-room-messages",
                "__my_messages__",
                [posted(), {"roomType": "c", "roomName": "general"}],
            )
            await until(lambda: on_message.await_count == 1)
        finally:
            await adapter.stop()

    inbound: InboundMessage = on_message.await_args.args[0]
    assert (inbound.content, inbound.channel_name) == ("hello", "general")
    subscribed = [f["name"] for f in ddp.received if f.get("msg") == "sub"]
    assert subscribed == ["stream-room-messages", "stream-notify-user"]
    assert adapter._realtime is None
    assert adapter._tasks == []
    assert adapter._http is None


# ── Inbound ──────────────────────────────────────────────────────────────────


async def test_a_message_reaches_the_room() -> None:
    adapter = adapter_on(Server())
    on_message = listening(adapter)
    await adapter._handle(stream_event(posted()))
    inbound: InboundMessage = on_message.await_args.args[0]
    assert inbound.channel_id == ROOM
    assert inbound.channel_type == "channel_public"
    assert inbound.sender_id == PERSON
    assert inbound.sender_name == "alice"
    assert inbound.content == "hello"
    assert inbound.message_ref == "msg1"
    assert inbound.root_id is None
    assert inbound.channel_name == "general"


async def test_a_reply_names_its_thread() -> None:
    adapter = adapter_on(Server())
    on_message = listening(adapter)
    await adapter._handle(stream_event(posted(tmid="root1")))
    assert on_message.await_args.args[0].root_id == "root1"


@pytest.mark.parametrize(
    ("message", "room_type"),
    [
        pytest.param(
            posted(u={"_id": BOT, "username": "switchbot"}, alias="Cody"),
            "c",
            id="the bot's own",
        ),
        pytest.param(
            posted(tcount=1, _updatedAt={"$date": 1_000_000 + 60_000}),
            "c",
            id="an old one touched after a restart",
        ),
        pytest.param(
            posted(msg="fixed", editedAt={"$date": 1_000_020}), "c", id="an edit"
        ),
        pytest.param(posted(t="room-archived", msg=""), "c", id="a system message"),
        pytest.param(posted(), "l", id="a kind of room Switch does not bridge"),
    ],
)
async def test_what_is_not_a_new_message_is_not_relayed(
    message: dict[str, Any], room_type: str
) -> None:
    adapter = adapter_on(Server())
    on_message = listening(adapter)
    await adapter._handle(stream_event(message, room_type=room_type))
    on_message.assert_not_awaited()


async def test_a_message_touched_again_is_not_a_new_message() -> None:
    adapter = adapter_on(Server())
    on_message = listening(adapter)
    await adapter._handle(stream_event(posted()))
    reacted = posted(reactions={":eyes:": {"usernames": ["alice"]}})
    await adapter._handle(stream_event(reacted))
    assert on_message.await_count == 1


async def test_an_encrypted_room_is_reported_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = adapter_on(Server())
    on_message = listening(adapter)
    await adapter._handle(stream_event(posted(t="e2e", _id="m1")))
    await adapter._handle(stream_event(posted(t="e2e", _id="m2")))
    on_message.assert_not_awaited()
    assert caplog.text.count("end-to-end encrypted") == 1


async def test_a_mention_of_the_bot_is_marked() -> None:
    adapter = adapter_on(Server())
    on_message = listening(adapter)
    mention = {"_id": BOT, "username": "switchbot"}
    await adapter._handle(stream_event(posted(mentions=[mention])))
    assert on_message.await_args.args[0].self_mention_token == "switchbot"


async def test_a_post_from_an_integration_cannot_answer_a_card() -> None:
    adapter = adapter_on(Server())
    on_message = listening(adapter)
    await adapter._handle(stream_event(posted(bot={"i": "integration"})))
    assert on_message.await_args.args[0].sender_is_app is True


async def test_a_command_is_a_command() -> None:
    adapter = adapter_on(Server())
    on_message = listening(adapter)
    await adapter._handle(stream_event(posted(msg="!invite-agent  cody ", tmid="r")))
    on_message.assert_not_awaited()
    command: InboundCommand = adapter._on_command.await_args.args[0]  # type: ignore[union-attr]
    assert command.command == "invite-agent"
    assert command.args == "cody"
    assert command.message_ref == "msg1"
    assert command.root_id == "r"


@pytest.mark.parametrize(("people", "channel_type"), [(2, "direct"), (3, "group")])
async def test_a_direct_message_is_direct_between_two_and_a_group_beyond(
    people: int, channel_type: str
) -> None:
    room = {"_id": ROOM, "t": "d", "usersCount": people}
    adapter = adapter_on(Server({"rooms.info": ok(room=room)}))
    on_message = listening(adapter)
    await adapter._handle(stream_event(posted(), room_type="d"))
    inbound = on_message.await_args.args[0]
    assert inbound.channel_type == channel_type
    assert (inbound.channel_name is None) == (channel_type == "direct")


def test_a_quote_link_is_taken_off_inbound_text() -> None:
    adapter = adapter_on(Server())
    raw = f"[ ]({SERVER}/channel/general?msg=abc) what about this?"
    assert adapter.translate_inbound(raw) == "what about this?"


async def test_the_bot_being_added_makes_a_room() -> None:
    adapter = adapter_on(Server())
    listening(adapter)
    await adapter._handle(_Joined(room_id=ROOM, room_type="p", room_name="ops"))
    join: InboundAppJoin = adapter._on_app_joined.await_args.args[0]  # type: ignore[union-attr]
    assert (join.channel_id, join.channel_type) == (ROOM, "channel_private")
    assert join.channel_name == "ops"
    assert ROOM in adapter._known_rooms


async def test_a_direct_message_being_opened_makes_no_room() -> None:
    adapter = adapter_on(Server())
    listening(adapter)
    await adapter._handle(_Joined(room_id=ROOM, room_type="d", room_name=None))
    adapter._on_app_joined.assert_not_awaited()  # type: ignore[union-attr]


@pytest.mark.parametrize("adder", [PERSON, BOT])
async def test_a_person_added_by_anyone_joins(adder: str) -> None:
    server = Server({"users.info": ok(user={"_id": "carolId", "username": "carol"})})
    adapter = adapter_on(server)
    listening(adapter)
    added = posted(t="au", msg="carol", u={"_id": adder, "username": "someone"})
    await adapter._handle(stream_event(added))
    join: InboundUserJoin = adapter._on_user_joined.await_args.args[0]  # type: ignore[union-attr]
    assert join.external_user_id == "carolId"
    assert join.external_username == "carol"


async def test_the_bots_own_join_message_is_not_a_person() -> None:
    adapter = adapter_on(Server())
    listening(adapter)
    await adapter._handle(stream_event(posted(t="au", msg="switchbot")))
    adapter._on_user_joined.assert_not_awaited()  # type: ignore[union-attr]


def stream_args(subscription: dict[str, Any]) -> list[Any]:
    return ["inserted", subscription]


def test_stream_events_are_queued_in_order() -> None:
    adapter = adapter_on(Server())
    adapter._on_stream_event(
        "stream-room-messages",
        "__my_messages__",
        [posted(), {"roomType": "c", "roomName": "general"}],
    )
    adapter._on_stream_event(
        "stream-notify-user",
        f"{BOT}/subscriptions-changed",
        stream_args({"rid": ROOM, "t": "c", "name": "general"}),
    )
    adapter._on_stream_event(
        "stream-notify-user",
        f"{BOT}/subscriptions-changed",
        ["updated", {"rid": ROOM, "t": "c"}],
    )
    assert isinstance(adapter._incoming.get_nowait(), _Posted)
    assert isinstance(adapter._incoming.get_nowait(), _Joined)
    assert adapter._incoming.empty()


@pytest.mark.parametrize(
    ("stream", "args"),
    [
        ("stream-room-messages", [None]),
        ("stream-room-messages", ["not a message", {}]),
        ("stream-notify-user", ["inserted", None]),
    ],
)
def test_a_stream_event_that_is_not_an_object_is_dropped_and_said(
    caplog: pytest.LogCaptureFixture, stream: str, args: list[Any]
) -> None:
    adapter = adapter_on(Server())
    adapter._on_stream_event(stream, "__my_messages__", args)
    assert adapter._incoming.empty()
    assert "is not an object" in caplog.text


async def test_a_bad_stream_event_does_not_stop_the_next_one() -> None:
    adapter = adapter_on(Server(markers_move()))
    on_message = listening(adapter)
    adapter._on_stream_event("stream-room-messages", "__my_messages__", [None])
    adapter._incoming.put_nowait(stream_event(posted(_id="after")))
    await run_until_idle(adapter)
    assert on_message.await_count == 1


async def test_a_person_joining_a_room_nobody_bridges_is_not_looked_up() -> None:
    adapter = adapter_on(Server())
    listening(adapter)
    await adapter._handle(stream_event(posted(t="au", msg="carol"), room_type="l"))
    adapter._on_user_joined.assert_not_awaited()  # type: ignore[union-attr]


async def test_the_window_of_seen_messages_forgets_its_oldest_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(module, "_MAX_SEEN", 2)
    adapter = adapter_on(Server())
    on_message = listening(adapter)
    for message_id in ("a", "b", "c"):
        await adapter._handle(stream_event(posted(_id=message_id)))
    await adapter._handle(stream_event(posted(_id="a")))
    await adapter._handle(stream_event(posted(_id="c")))
    assert on_message.await_count == 4


# ── Attachments ──────────────────────────────────────────────────────────────


FILE = {
    "_id": "file1",
    "name": "a b.txt",
    "type": "text/plain; charset=utf-8",
    "size": 5,
}


def uploaded_here(
    download: Callable[[httpx.Request], httpx.Response], *file_ids: str
) -> Callable[[httpx.Request], httpx.Response]:
    """A server whose room lists `file_ids` as its uploads."""

    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(".files"):
            return ok(files=[{"_id": file_id} for file_id in file_ids])
        return download(request)

    return handle


async def test_an_uploaded_file_is_downloaded_with_the_bots_credentials() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=b"hello")

    adapter = adapter_on(Server())
    adapter._client = RocketChatClient(
        httpx.AsyncClient(
            transport=httpx.MockTransport(uploaded_here(handle, "file1"))
        ),
        url=SERVER,
        user_id=BOT,
        token="fixture-token",
    )
    on_message = listening(adapter)
    await adapter._handle(stream_event(posted(msg="", files=[FILE], file=FILE)))
    inbound = on_message.await_args.args[0]
    assert seen[0].url.raw_path == b"/file-upload/file1/a%20b.txt"
    assert seen[0].headers["x-auth-token"] == "fixture-token"
    assert inbound.attachments[0].data == b"hello"
    assert inbound.attachments[0].mimetype == "text/plain"
    assert inbound.attachments[0].filename == "a b.txt"


async def test_a_file_name_cannot_step_out_of_the_upload_path() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=b"x")

    adapter = adapter_on(Server())
    adapter._client = RocketChatClient(
        httpx.AsyncClient(
            transport=httpx.MockTransport(uploaded_here(handle, "file1"))
        ),
        url=SERVER,
        user_id=BOT,
        token="fixture-token",
    )
    listening(adapter)
    sly = {**FILE, "name": "../../api/v1/me"}
    await adapter._handle(stream_event(posted(files=[sly])))
    assert seen[0].url.raw_path == b"/file-upload/file1/..%2F..%2Fapi%2Fv1%2Fme"


async def test_a_thumbnail_is_not_a_second_file() -> None:
    adapter = adapter_on(Server())
    adapter._client = RocketChatClient(
        httpx.AsyncClient(
            transport=httpx.MockTransport(
                uploaded_here(lambda r: httpx.Response(200, content=b"x"), "i", "t")
            )
        ),
        url=SERVER,
        user_id=BOT,
        token="fixture-token",
    )
    on_message = listening(adapter)
    image = {"_id": "i", "name": "a.png", "type": "image/png", "size": 1}
    thumb = {"_id": "t", "name": "thumb-a.png", "typeGroup": "thumb", "size": 1}
    await adapter._handle(stream_event(posted(msg="", files=[image, thumb])))
    assert len(on_message.await_args.args[0].attachments) == 1


async def test_the_description_is_the_caption_of_a_file() -> None:
    adapter = adapter_on(Server())
    adapter._client = RocketChatClient(
        httpx.AsyncClient(
            transport=httpx.MockTransport(
                uploaded_here(lambda r: httpx.Response(200, content=b"x"), "file1")
            )
        ),
        url=SERVER,
        user_id=BOT,
        token="fixture-token",
    )
    on_message = listening(adapter)
    await adapter._handle(
        stream_event(
            posted(msg="", files=[FILE], attachments=[{"description": "the report"}])
        )
    )
    assert on_message.await_args.args[0].content == "the report"


async def test_a_link_in_attachments_is_never_fetched_with_the_token() -> None:
    def must_not_be_called(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Fetched {request.url}")

    adapter = adapter_on(Server())
    adapter._client = RocketChatClient(
        httpx.AsyncClient(transport=httpx.MockTransport(must_not_be_called)),
        url=SERVER,
        user_id=BOT,
        token="fixture-token",
    )
    on_message = listening(adapter)
    forged = [{"title_link": "https://elsewhere.example/steal", "type": "file"}]
    await adapter._handle(stream_event(posted(attachments=forged)))
    assert on_message.await_args.args[0].attachments == []


async def test_a_file_over_the_limit_is_disclosed_without_downloading() -> None:
    adapter = adapter_on(Server())
    adapter.set_max_attachment_bytes(4)
    on_message = listening(adapter)
    await adapter._handle(stream_event(posted(files=[FILE])))
    inbound = on_message.await_args.args[0]
    assert inbound.attachments == []
    assert "exceeds" in inbound.attachment_failures[0].reason


async def test_a_file_that_says_it_is_small_is_still_cut_off() -> None:
    adapter = adapter_on(Server())
    adapter._client = RocketChatClient(
        httpx.AsyncClient(
            transport=httpx.MockTransport(
                uploaded_here(lambda r: httpx.Response(200, content=b"x" * 9), "file1")
            )
        ),
        url=SERVER,
        user_id=BOT,
        token="fixture-token",
    )
    adapter.set_max_attachment_bytes(8)
    on_message = listening(adapter)
    await adapter._handle(stream_event(posted(files=[{**FILE, "size": 1}])))
    assert "exceeds" in on_message.await_args.args[0].attachment_failures[0].reason


async def test_a_redirect_to_storage_does_not_carry_the_token() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.host == "chat.example.test":
            return httpx.Response(
                302, headers={"location": "https://storage.example.test/signed"}
            )
        return httpx.Response(200, content=b"stored")

    client = RocketChatClient(
        httpx.AsyncClient(transport=httpx.MockTransport(handle)),
        url=SERVER,
        user_id=BOT,
        token="fixture-token",
    )
    assert await client.download("/file-upload/f/a.txt", limit=100) == b"stored"
    assert "x-auth-token" in seen[0].headers
    assert "x-auth-token" not in seen[1].headers


async def test_a_failed_download_says_why_without_the_signed_address(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.host == "chat.example.test":
            return httpx.Response(
                302,
                headers={"location": "https://storage.example.test/o?Signature=SECRET"},
            )
        return httpx.Response(403)

    adapter = adapter_on(Server())
    adapter._client = RocketChatClient(
        httpx.AsyncClient(
            transport=httpx.MockTransport(uploaded_here(handle, "file1"))
        ),
        url=SERVER,
        user_id=BOT,
        token="fixture-token",
    )
    on_message = listening(adapter)
    await adapter._handle(stream_event(posted(files=[FILE])))
    reason = on_message.await_args.args[0].attachment_failures[0].reason
    assert reason == "download failed: HTTP 403"
    assert "SECRET" not in caplog.text


async def test_a_file_not_uploaded_in_its_room_is_never_fetched(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def only_the_listing(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Fetched {request.url}")

    adapter = adapter_on(Server())
    adapter._client = RocketChatClient(
        httpx.AsyncClient(
            transport=httpx.MockTransport(uploaded_here(only_the_listing, "other"))
        ),
        url=SERVER,
        user_id=BOT,
        token="fixture-token",
    )
    on_message = listening(adapter)
    elsewhere = {**FILE, "_id": "from-a-private-room"}
    await adapter._handle(stream_event(posted(msg="look", files=[elsewhere])))
    delivered = on_message.await_args.args[0]
    assert delivered.content == "look"
    assert delivered.attachments == []
    assert delivered.attachment_failures[0].reason == "not uploaded in this room"
    assert "not uploaded in its room" in caplog.text


@pytest.mark.parametrize(
    ("room_type", "kind"), [("c", "channels"), ("p", "groups"), ("d", "im")]
)
async def test_a_file_is_checked_against_its_rooms_own_uploads(
    room_type: str, kind: str
) -> None:
    server = Server(
        {
            "rooms.info": ok(room={"_id": ROOM, "t": "d", "usersCount": 2}),
            f"{kind}.files": ok(files=[{"_id": "file1"}]),
            "/file-upload": httpx.Response(200, content=b"hi"),
        }
    )
    adapter = adapter_on(server)
    listening(adapter)
    await adapter._handle(stream_event(posted(files=[FILE]), room_type=room_type))
    asked = server.to(f"{kind}.files")[0].url.params
    assert (asked["roomId"], asked["name"]) == (ROOM, "a\\ b\\.txt")


async def test_a_file_that_cannot_be_checked_is_not_fetched() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(".files"):
            return httpx.Response(503)
        raise AssertionError(f"Fetched {request.url}")

    adapter = adapter_on(Server())
    adapter._client = RocketChatClient(
        httpx.AsyncClient(transport=httpx.MockTransport(handle)),
        url=SERVER,
        user_id=BOT,
        token="fixture-token",
    )
    on_message = listening(adapter)
    await adapter._handle(stream_event(posted(files=[FILE])))
    reason = on_message.await_args.args[0].attachment_failures[0].reason
    assert reason == "could not be checked"


async def test_file_records_that_are_not_records_are_skipped() -> None:
    adapter = adapter_on(Server())
    on_message = listening(adapter)
    await adapter._handle(
        stream_event(posted(msg="hi", files=["x", 3], attachments=["y"]))
    )
    delivered = on_message.await_args.args[0]
    assert (delivered.content, delivered.attachments) == ("hi", [])


async def test_a_download_the_policy_refuses_is_disclosed_and_the_text_delivered() -> (
    None
):
    def refuse(request: httpx.Request) -> httpx.Response:
        raise OutboundURLRefused("internal.example resolves to 10.0.0.5")

    adapter = adapter_on(Server())
    adapter._client = RocketChatClient(
        httpx.AsyncClient(
            transport=httpx.MockTransport(uploaded_here(refuse, "file1"))
        ),
        url=SERVER,
        user_id=BOT,
        token="fixture-token",
    )
    on_message = listening(adapter)
    await adapter._handle(stream_event(posted(msg="see the file", files=[FILE])))
    delivered = on_message.await_args.args[0]
    assert delivered.content == "see the file"
    reason = delivered.attachment_failures[0].reason
    assert "may not connect to" in reason
    assert "10.0.0.5" not in reason
    assert adapter._marker_held == set()


# ── Reading back ─────────────────────────────────────────────────────────────


def markers_move() -> dict[str, httpx.Response]:
    return {"subscriptions.read": ok(), "subscriptions.unread": ok()}


def read_back_server(updated: list[dict[str, Any]], *, ls: str) -> Server:
    return Server(
        {
            "subscriptions.get": ok(
                update=[
                    {"rid": ROOM, "t": "c", "name": "general", "ls": ls},
                    {"rid": "elsewhere", "t": "c", "name": "other", "ls": ls},
                ]
            ),
            "chat.syncMessages": ok(result={"updated": updated, "deleted": []}),
            **markers_move(),
        }
    )


def rest_message(message_id: str, ts: str, **fields: Any) -> dict[str, Any]:
    return posted(_id=message_id, ts=ts, _updatedAt=ts, **fields)


async def test_what_was_missed_is_read_back_in_order_from_the_marker() -> None:
    server = read_back_server(
        [
            rest_message("later", "2026-10-31T10:00:03.000Z"),
            rest_message("earlier", "2026-10-31T10:00:02.000Z"),
        ],
        ls="2026-10-31T10:00:00.000Z",
    )
    adapter = adapter_on(server)
    on_message = listening(adapter)
    await adapter.ensure_channel_subscriptions([(ROOM, "channel_public")])
    await adapter._handle(adapter._incoming.get_nowait())
    refs = [call.args[0].message_ref for call in on_message.await_args_list]
    assert refs == ["earlier", "later"]
    assert server.to("chat.syncMessages")[0].url.params["lastUpdate"] == (
        "2026-10-31T09:59:58.000Z"
    )


async def test_only_rooms_switch_knows_are_read_back() -> None:
    server = read_back_server([], ls="2026-10-31T10:00:00.000Z")
    adapter = adapter_on(server)
    listening(adapter)
    await adapter.ensure_channel_subscriptions([(ROOM, "channel_public")])
    await adapter._handle(adapter._incoming.get_nowait())
    rooms = [r.url.params["roomId"] for r in server.to("chat.syncMessages")]
    assert rooms == [ROOM]


async def test_a_message_touched_since_the_marker_is_not_replayed() -> None:
    server = read_back_server(
        [
            posted(
                _id="old",
                ts="2026-10-30T10:00:00.000Z",
                _updatedAt="2026-10-31T10:00:01.000Z",
            )
        ],
        ls="2026-10-31T10:00:00.000Z",
    )
    adapter = adapter_on(server)
    on_message = listening(adapter)
    await adapter.ensure_channel_subscriptions([(ROOM, "channel_public")])
    await adapter._handle(adapter._incoming.get_nowait())
    on_message.assert_not_awaited()


async def test_a_room_with_no_marker_reads_back_from_when_the_bot_joined() -> None:
    server = read_back_server([], ls="")
    server.routes["subscriptions.get"] = ok(
        update=[{"rid": ROOM, "t": "c", "ts": "2026-10-31T10:00:00.000Z"}]
    )
    adapter = adapter_on(server)
    listening(adapter)
    await adapter.ensure_channel_subscriptions([(ROOM, "channel_public")])
    await adapter._handle(adapter._incoming.get_nowait())
    assert server.to("chat.syncMessages")[0].url.params["lastUpdate"] == (
        "2026-10-31T09:59:58.000Z"
    )


async def test_a_huge_gap_keeps_the_latest_and_says_so(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(module, "_MAX_READ_BACK", 1)
    server = read_back_server(
        [
            rest_message("a", "2026-10-31T10:00:01.000Z"),
            rest_message("b", "2026-10-31T10:00:02.000Z"),
        ],
        ls="2026-10-31T10:00:00.000Z",
    )
    adapter = adapter_on(server)
    on_message = listening(adapter)
    await adapter.ensure_channel_subscriptions([(ROOM, "channel_public")])
    await adapter._handle(adapter._incoming.get_nowait())
    assert [c.args[0].message_ref for c in on_message.await_args_list] == ["b"]
    assert "reading back the latest" in caplog.text


async def test_a_failed_read_back_holds_the_marker_and_says_so(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(module, "_READ_BACK_RETRY_SECONDS", 0.0)
    server = read_back_server([], ls="2026-10-31T10:00:00.000Z")
    server.routes["chat.syncMessages"] = httpx.Response(500)
    adapter = adapter_on(server)
    listening(adapter)
    adapter._known_rooms.add(ROOM)
    await adapter._read_back()
    assert ROOM in adapter._marker_held
    assert "may be missing" in caplog.text
    assert isinstance(await adapter._incoming.get(), _ReadBack)


async def test_rooms_that_fail_together_are_retried_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(module, "_READ_BACK_RETRY_SECONDS", 3600.0)
    server = read_back_server([], ls="2026-10-31T10:00:00.000Z")
    server.routes["chat.syncMessages"] = httpx.Response(500)
    adapter = adapter_on(server)
    listening(adapter)
    adapter._known_rooms.update({ROOM, "elsewhere"})
    scheduled: list[Any] = []
    loop = asyncio.get_running_loop()
    call_later = loop.call_later

    def recording_call_later(delay: float, callback: Any, *args: Any) -> Any:
        scheduled.append(callback)
        return call_later(delay, callback, *args)

    monkeypatch.setattr(loop, "call_later", recording_call_later)
    await adapter._read_back()
    await adapter._read_back()
    assert adapter._marker_held == {ROOM, "elsewhere"}
    assert len(scheduled) == 1
    await adapter.stop()
    assert adapter._read_back_retry is None


async def test_a_retry_that_fires_can_schedule_the_next(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(module, "_READ_BACK_RETRY_SECONDS", 0.0)
    server = read_back_server([], ls="2026-10-31T10:00:00.000Z")
    server.routes["chat.syncMessages"] = httpx.Response(500)
    adapter = adapter_on(server)
    listening(adapter)
    adapter._known_rooms.add(ROOM)
    await adapter._read_back()
    await adapter._handle(await asyncio.wait_for(adapter._incoming.get(), 1))
    assert isinstance(await asyncio.wait_for(adapter._incoming.get(), 1), _ReadBack)


async def test_a_failed_list_of_rooms_holds_every_marker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(module, "_READ_BACK_RETRY_SECONDS", 0.0)
    adapter = adapter_on(Server({"subscriptions.get": httpx.Response(503)}))
    listening(adapter)
    adapter._known_rooms.update({ROOM, "other"})
    await adapter._read_back()
    assert adapter._marker_held == {ROOM, "other"}


async def test_a_live_message_cannot_pass_a_read_back_that_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(module, "_READ_BACK_RETRY_SECONDS", 3600.0)
    server = read_back_server([], ls="2026-10-31T10:00:00.000Z")
    server.routes["chat.syncMessages"] = httpx.Response(500)
    adapter = adapter_on(server)
    listening(adapter)
    adapter._known_rooms.add(ROOM)
    adapter._incoming.put_nowait(_ReadBack())
    adapter._incoming.put_nowait(stream_event(posted()))
    await run_until_idle(adapter)
    assert server.to("subscriptions.read") == []


async def test_a_read_back_that_works_lets_go_of_the_marker() -> None:
    server = read_back_server([], ls="2026-10-31T10:00:00.000Z")
    adapter = adapter_on(server)
    listening(adapter)
    adapter._known_rooms.add(ROOM)
    adapter._marker_held.add(ROOM)
    await adapter._read_back()
    assert adapter._marker_held == set()


async def test_a_message_that_failed_holds_the_marker_and_is_tried_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(module, "_READ_BACK_RETRY_SECONDS", 3600.0)
    server = read_back_server(
        [rest_message("flaky", "2026-10-31T10:00:01.000Z")],
        ls="2026-10-31T10:00:00.000Z",
    )
    adapter = adapter_on(server)
    on_message = listening(adapter)
    on_message.side_effect = [RuntimeError("database gone"), None]
    adapter._known_rooms.add(ROOM)
    await adapter._read_back()
    assert ROOM in adapter._marker_held
    assert adapter._read_back_retry is not None
    adapter._read_back_retry.cancel()
    await adapter._read_back()
    assert on_message.await_count == 2
    assert ROOM not in adapter._marker_held


async def test_a_message_that_always_fails_is_given_up_and_lets_the_marker_go(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(module, "_READ_BACK_RETRY_SECONDS", 3600.0)
    server = read_back_server(
        [rest_message("broken", "2026-10-31T10:00:01.000Z")],
        ls="2026-10-31T10:00:00.000Z",
    )
    adapter = adapter_on(server)
    on_message = listening(adapter)
    on_message.side_effect = RuntimeError("always")
    adapter._known_rooms.add(ROOM)
    for _ in range(module._MAX_HANDOVER_ATTEMPTS):
        await adapter._read_back()
        if adapter._read_back_retry is not None:
            adapter._read_back_retry.cancel()
            adapter._read_back_retry = None
    assert on_message.await_count == module._MAX_HANDOVER_ATTEMPTS
    assert ROOM not in adapter._marker_held
    assert "broken" in adapter._seen
    assert "Giving up on Rocket.Chat message broken" in caplog.text
    await adapter._read_back()
    assert on_message.await_count == module._MAX_HANDOVER_ATTEMPTS


async def test_a_room_that_cannot_be_read_back_for_any_reason_is_held_and_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(module, "_READ_BACK_RETRY_SECONDS", 3600.0)
    server = read_back_server([], ls="not a time")
    adapter = adapter_on(server)
    listening(adapter)
    adapter._known_rooms.add(ROOM)
    await adapter._read_back()
    assert ROOM in adapter._marker_held
    assert adapter._read_back_retry is not None
    adapter._read_back_retry.cancel()


async def run_until_idle(adapter: RocketChatAdapter) -> None:
    worker = asyncio.create_task(adapter._handle_incoming())
    for _ in range(200):
        await asyncio.sleep(0)
    worker.cancel()
    await asyncio.gather(worker, return_exceptions=True)


async def test_the_marker_moves_to_the_last_message_once_the_queue_has_drained() -> (
    None
):
    server = Server(markers_move())
    adapter = adapter_on(server)
    listening(adapter)
    adapter._incoming.put_nowait(stream_event(posted(_id="a")))
    adapter._incoming.put_nowait(stream_event(posted(_id="b")))
    await run_until_idle(adapter)
    assert [r.url.path.rsplit("/", 1)[-1] for r in server.requests] == [
        "subscriptions.read",
        "subscriptions.unread",
    ]
    assert server.body("subscriptions.read") == {"rid": ROOM}
    assert server.body("subscriptions.unread") == {"firstUnreadMessage": {"_id": "b"}}


async def test_an_older_message_read_back_leaves_the_marker_on_the_newest() -> None:
    server = Server(markers_move())
    adapter = adapter_on(server)
    listening(adapter)
    await adapter._handle(
        stream_event(rest_message("newest", "2026-10-31T10:00:05.000Z"))
    )
    await adapter._handle(
        replace(
            stream_event(rest_message("older", "2026-10-31T10:00:04.000Z")),
            reading_back=True,
        )
    )
    await adapter._advance_read_markers()
    assert server.body("subscriptions.unread") == {
        "firstUnreadMessage": {"_id": "newest"}
    }


async def test_a_message_sharing_the_markers_millisecond_is_read_back() -> None:
    server = read_back_server(
        [
            rest_message("handed", "2026-10-31T10:00:04.000Z"),
            rest_message("sibling", "2026-10-31T10:00:04.000Z"),
        ],
        ls="2026-10-31T10:00:03.999Z",
    )
    adapter = adapter_on(server)
    on_message = listening(adapter)
    adapter._known_rooms.add(ROOM)
    await adapter._read_back()
    refs = {call.args[0].message_ref for call in on_message.await_args_list}
    assert refs == {"handed", "sibling"}


async def test_the_bots_own_system_message_is_not_where_the_marker_goes() -> None:
    server = Server(markers_move())
    adapter = adapter_on(server)
    listening(adapter)
    await adapter._handle(
        stream_event(rest_message("person", "2026-10-31T10:00:04.000Z"))
    )
    await adapter._handle(
        stream_event(
            rest_message(
                "bots-own",
                "2026-10-31T10:00:05.000Z",
                t="room_changed_topic",
                u={"_id": CONFIG["user_id"], "username": "switchbot"},
            )
        )
    )
    await adapter._advance_read_markers()
    assert server.body("subscriptions.unread") == {
        "firstUnreadMessage": {"_id": "person"}
    }


async def test_a_marker_that_cannot_be_pulled_back_is_logged_and_stays_moved(
    caplog: pytest.LogCaptureFixture,
) -> None:
    server = Server(
        {
            "subscriptions.read": ok(),
            "subscriptions.unread": refused("error-action-not-allowed"),
        }
    )
    adapter = adapter_on(server)
    listening(adapter)
    await adapter._handle(stream_event(posted(_id="a")))
    await adapter._advance_read_markers()
    assert "could be missed after a restart" in caplog.text
    assert adapter._unread == set()


async def test_a_message_that_failed_keeps_the_marker_where_it_is() -> None:
    server = Server(markers_move())
    adapter = adapter_on(server)
    on_message = listening(adapter)
    on_message.side_effect = [RuntimeError("database gone"), None]
    adapter._incoming.put_nowait(stream_event(posted(_id="a")))
    adapter._incoming.put_nowait(stream_event(posted(_id="b")))
    await run_until_idle(adapter)
    assert on_message.await_count == 2
    assert server.to("subscriptions.read") == []


async def test_a_failure_in_read_back_does_not_stop_the_rest_of_the_room() -> None:
    server = read_back_server(
        [
            rest_message("a", "2026-10-31T10:00:01.000Z"),
            rest_message("b", "2026-10-31T10:00:02.000Z"),
        ],
        ls="2026-10-31T10:00:00.000Z",
    )
    adapter = adapter_on(server)
    on_message = listening(adapter)
    on_message.side_effect = [RuntimeError("database gone"), None]
    adapter._known_rooms.add(ROOM)
    await adapter._read_back()
    assert on_message.await_count == 2
    assert ROOM in adapter._marker_held


async def test_a_reconnect_reads_from_the_last_message_not_from_the_marker() -> None:
    delayed = rest_message("delayed", "2026-10-31T10:00:05.000Z")
    server = read_back_server([delayed], ls="2026-10-31T10:00:30.000Z")
    adapter = adapter_on(server)
    on_message = listening(adapter)
    adapter._known_rooms.add(ROOM)
    await adapter._handle(
        stream_event(rest_message("handed", "2026-10-31T10:00:04.000Z"))
    )
    await adapter._read_back()
    assert server.to("chat.syncMessages")[0].url.params["lastUpdate"] == (
        "2026-10-31T10:00:02.000Z"
    )
    assert on_message.await_args.args[0].message_ref == "delayed"


async def test_a_message_read_back_and_also_streamed_is_handed_over_once() -> None:
    server = read_back_server(
        [rest_message("both", "2026-10-31T10:00:01.000Z")],
        ls="2026-10-31T10:00:00.000Z",
    )
    adapter = adapter_on(server)
    on_message = listening(adapter)
    adapter._known_rooms.add(ROOM)
    await adapter._read_back()
    await adapter._handle(
        stream_event(rest_message("both", "2026-10-31T10:00:01.000Z"))
    )
    assert on_message.await_count == 1


async def test_a_message_changed_by_someone_else_is_not_read_back_as_its_author(
    caplog: pytest.LogCaptureFixture,
) -> None:
    changed = rest_message(
        "changed",
        "2026-10-31T10:00:01.000Z",
        msg="A7 yes",
        editedAt="2026-10-31T10:00:09.000Z",
        editedBy={"_id": "moderator", "username": "mod"},
    )
    fixed = rest_message(
        "fixed",
        "2026-10-31T10:00:02.000Z",
        msg="fixed",
        editedAt="2026-10-31T10:00:09.000Z",
        editedBy={"_id": PERSON, "username": "alice"},
    )
    server = read_back_server([changed, fixed], ls="2026-10-31T10:00:00.000Z")
    adapter = adapter_on(server)
    on_message = listening(adapter)
    adapter._known_rooms.add(ROOM)
    await adapter._read_back()
    assert [c.args[0].message_ref for c in on_message.await_args_list] == ["fixed"]
    assert "not by its author" in caplog.text


async def test_a_failure_moving_the_markers_does_not_stop_delivery(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = adapter_on(Server(markers_move()))
    on_message = listening(adapter)
    moves = AsyncMock(side_effect=[RuntimeError("boom"), None])
    adapter._advance_read_markers = moves  # type: ignore[method-assign]
    adapter._incoming.put_nowait(stream_event(posted(_id="a")))
    await run_until_idle(adapter)
    adapter._incoming.put_nowait(stream_event(posted(_id="b")))
    await run_until_idle(adapter)
    assert on_message.await_count == 2
    assert "Could not move the Rocket.Chat read markers" in caplog.text


async def test_nothing_to_read_back_asks_the_server_nothing() -> None:
    adapter = adapter_on(Server())
    listening(adapter)
    await adapter._read_back()
    assert adapter._marker_held == set()


async def test_a_marker_that_cannot_be_moved_is_logged_and_read_again_later(
    caplog: pytest.LogCaptureFixture,
) -> None:
    server = Server({"subscriptions.read": refused("error-not-allowed")})
    adapter = adapter_on(server)
    listening(adapter)
    await adapter._handle(stream_event(posted(_id="a")))
    await adapter._advance_read_markers()
    assert "read again on the next start" in caplog.text
    assert server.to("subscriptions.unread") == []
    assert adapter._unread == set()


# ── Outbound ─────────────────────────────────────────────────────────────────


async def with_presentation(adapter: RocketChatAdapter) -> RocketChatAdapter:
    async def resolve(name: str) -> AgentPresentation | None:
        return AgentPresentation(
            display_name="Cody", icon_url="https://example.test/cody.png"
        )

    adapter.set_agent_presentation_resolver(resolve)
    adapter.set_third_party_avatars(True)
    return adapter


async def test_a_reply_goes_out_under_the_agents_name_in_its_thread() -> None:
    server = Server({"chat.sendMessage": message_response})
    adapter = await with_presentation(adapter_on(server))
    ref = await adapter.send_message(ROOM, "cody", "hi", "root1")
    assert ref == "generated"
    assert server.body("chat.sendMessage")["message"] == {
        "rid": ROOM,
        "msg": "hi",
        "alias": "Cody",
        "avatar": "https://example.test/cody.png",
        "tmid": "root1",
    }


async def test_a_long_reply_is_split_in_order_in_one_thread() -> None:
    server = Server({"chat.sendMessage": message_response})
    adapter = adapter_on(server)
    adapter._max_message = 100
    text = "\n".join(f"line {i:03}" + "x" * 40 for i in range(10))
    await adapter.send_message(ROOM, "cody", text, "root1")
    bodies = [json.loads(r.content)["message"] for r in server.to("chat.sendMessage")]
    assert len(bodies) > 1
    assert all(len(body["msg"]) <= 100 for body in bodies)
    assert all(body["tmid"] == "root1" for body in bodies)
    assert "\n".join(body["msg"] for body in bodies) == text


async def test_a_split_never_leaves_a_code_fence_open() -> None:
    server = Server({"chat.sendMessage": message_response})
    adapter = adapter_on(server)
    adapter._max_message = 100
    code = "\n".join(f"print({i})" + " " * 20 for i in range(30))
    await adapter.send_message(ROOM, "cody", f"```python\n{code}\n```")
    bodies = [
        json.loads(r.content)["message"]["msg"] for r in server.to("chat.sendMessage")
    ]
    assert all(body.count("```") == 2 for body in bodies)


async def test_length_is_measured_the_way_the_server_measures_it() -> None:
    server = Server({"chat.sendMessage": message_response})
    adapter = adapter_on(server)
    adapter._max_message = 100
    await adapter.send_message(ROOM, "cody", "😀" * 80)
    bodies = [
        json.loads(r.content)["message"]["msg"] for r in server.to("chat.sendMessage")
    ]
    assert all(len(body.encode("utf-16-le")) // 2 <= 100 for body in bodies)


@pytest.mark.parametrize(
    ("endpoint", "call", "logged"),
    [
        ("chat.sendMessage", lambda a: a.send_message(ROOM, "cody", "hi"), "send"),
        ("chat.update", lambda a: a.update_message(ROOM, "m1", "x"), "update"),
        ("chat.delete", lambda a: a.delete_message(ROOM, "m1"), "delete"),
    ],
)
async def test_a_refused_send_edit_or_delete_is_logged_and_reports_no_ref(
    caplog: pytest.LogCaptureFixture,
    endpoint: str,
    call: Callable[[RocketChatAdapter], Awaitable[str | None]],
    logged: str,
) -> None:
    adapter = adapter_on(Server({endpoint: refused("error-not-allowed")}))
    assert await call(adapter) is None
    assert f"Failed to {logged}" in caplog.text


async def test_an_edit_keeps_the_message_it_edits() -> None:
    server = Server({"chat.update": ok(message={})})
    adapter = adapter_on(server)
    await adapter.update_message(ROOM, "m1", "better")
    assert server.body("chat.update") == {
        "roomId": ROOM,
        "msgId": "m1",
        "text": "better",
    }


async def test_an_edit_over_the_limit_is_cut_and_says_so(
    caplog: pytest.LogCaptureFixture,
) -> None:
    server = Server({"chat.update": ok(message={})})
    adapter = adapter_on(server)
    adapter._max_message = 200
    await adapter.update_message(ROOM, "m1", "word " * 80)
    text = server.body("chat.update")["text"]
    assert len(text) <= 200
    assert text.startswith("word word")
    assert text.endswith(module._EDIT_CUT_NOTICE)
    assert "over the size limit" in caplog.text


async def test_a_delete_goes_through() -> None:
    server = Server({"chat.delete": ok()})
    adapter = adapter_on(server)
    await adapter.delete_message(ROOM, "m1")
    assert server.body("chat.delete") == {"roomId": ROOM, "msgId": "m1"}


async def test_a_file_goes_out_under_the_agents_name_in_its_thread() -> None:
    server = Server(
        {
            "rooms.media/": ok(file={"_id": "file1", "url": "/file-upload/file1/a"}),
            "rooms.mediaConfirm/": ok(message={"_id": "fm1"}),
        }
    )
    adapter = await with_presentation(adapter_on(server))
    ref = await adapter.send_attachment(
        ROOM, "cody", "a.txt", "text/plain", b"data", "**look**", "root1"
    )
    assert ref == "fm1"
    assert server.to(f"rooms.mediaConfirm/{ROOM}/file1")
    body = server.body(f"rooms.mediaConfirm/{ROOM}/file1")
    assert body["msg"] == "**look**"
    assert body["alias"] == "Cody"
    assert body["tmid"] == "root1"
    assert "rid" not in body


async def test_a_file_the_server_refuses_is_said_in_the_channel() -> None:
    server = Server(
        {
            "rooms.media/": refused("error-file-too-large"),
            "chat.sendMessage": message_response,
        }
    )
    adapter = adapter_on(server)
    await adapter.send_attachment(ROOM, "cody", "big.bin", "application/x", b"x")
    assert (
        "couldn't be relayed: big.bin"
        in (server.body("chat.sendMessage")["message"]["msg"])
    )


async def test_a_reply_only_partly_sent_keeps_its_first_part_and_says_so(
    caplog: pytest.LogCaptureFixture,
) -> None:
    answers = iter(
        [
            ok(message={"_id": "first"}),
            refused("error-not-allowed"),
            ok(message={"_id": "notice"}),
        ]
    )
    server = Server({"chat.sendMessage": lambda request: next(answers)})
    adapter = adapter_on(server)
    adapter._max_message = 100
    text = "\n".join(f"line {i:03}" + "x" * 40 for i in range(4))
    assert await adapter.send_message(ROOM, "cody", text, "root1") == "first"
    sent = server.to("chat.sendMessage")
    assert len(sent) == 3
    notice = json.loads(sent[-1].content)["message"]
    assert notice["msg"] == (
        "⚠️ Only 1 of 4 parts of this message could be delivered — the rest "
        "was rejected by Rocket.Chat."
    )
    assert notice["tmid"] == "root1"
    assert "Failed to send part 2 of 4" in caplog.text


async def test_a_reply_whose_first_part_fails_posts_no_notice() -> None:
    server = Server({"chat.sendMessage": refused("error-not-allowed")})
    adapter = adapter_on(server)
    assert await adapter.send_message(ROOM, "cody", "hello") is None
    assert len(server.to("chat.sendMessage")) == 1


# ── Reactions ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("mark", "emoji", "on"),
    [
        ("working", "eyes", True),
        ("queued", "hourglass_flowing_sand", True),
        ("working", "eyes", False),
    ],
)
async def test_a_mark_is_a_reaction(mark: Any, emoji: str, on: bool) -> None:
    server = Server({"chat.react": ok()})
    adapter = adapter_on(server)
    await adapter.mark_activity(ROOM, "m1", agent_name="cody", mark=mark, on=on)
    assert server.body("chat.react") == {
        "messageId": "m1",
        "emoji": emoji,
        "shouldReact": on,
    }


@pytest.mark.parametrize(
    ("answer", "raised"),
    [
        pytest.param(refused("error-not-allowed"), ActivityMarkRefused, id="final"),
        pytest.param(httpx.Response(502), RocketChatUnavailable, id="may have landed"),
    ],
)
async def test_a_mark_that_fails_says_whether_to_retry(
    answer: httpx.Response, raised: type[Exception]
) -> None:
    adapter = adapter_on(Server({"chat.react": answer}))
    with pytest.raises(raised):
        await adapter.mark_activity(
            ROOM, "m1", agent_name="cody", mark="working", on=True
        )


class FakeRealtime:
    def __init__(self, *, connected: bool = True, fails: bool = False) -> None:
        self.connected = connected
        self.fails = fails
        self.calls: list[tuple[str, list[Any]]] = []

    async def call(self, method: str, params: list[Any]) -> None:
        self.calls.append((method, params))
        if self.fails:
            raise RealtimeError("no")


async def test_typing_is_said_on_the_connection() -> None:
    adapter = adapter_on(Server())
    realtime = FakeRealtime()
    adapter._realtime = realtime  # type: ignore[assignment]
    await adapter.send_typing(ROOM, "cody", True)
    await adapter.send_typing(ROOM, "cody", False)
    assert realtime.calls == [
        (
            "stream-notify-room",
            [f"{ROOM}/user-activity", "switchbot", ["user-typing"], {}],
        ),
        ("stream-notify-room", [f"{ROOM}/user-activity", "switchbot", [], {}]),
    ]


async def test_typing_without_a_connection_is_nothing() -> None:
    adapter = adapter_on(Server())
    await adapter.notify_working(ROOM, "cody", None)


async def test_typing_that_fails_stops_nothing() -> None:
    adapter = adapter_on(Server())
    adapter._realtime = FakeRealtime(fails=True)  # type: ignore[assignment]
    await adapter.send_typing(ROOM, "cody", True)


class ClosedSocket:
    async def send(self, data: str) -> None:
        raise ConnectionClosedOK(None, None)


async def test_a_connection_that_has_just_closed_stops_nothing() -> None:
    server = Server({"chat.update": ok(message={})})
    adapter = adapter_on(server)
    realtime = RocketChatRealtime(
        url=SERVER,
        token="fixture-token",
        policy=OutboundPolicy.parse(""),
        verify_tls=True,
        subscriptions=[],
        on_event=lambda stream, event, args: None,
        on_ready=lambda: None,
        on_login_refused=lambda: None,
    )
    realtime._socket = ClosedSocket()  # type: ignore[assignment]
    adapter._realtime = realtime
    await adapter.notify_working(ROOM, "cody", None)
    await adapter.update_rich(ROOM, "cody", "m1", card("resolved"), None)
    assert server.to("chat.update")


# ── Cards ────────────────────────────────────────────────────────────────────


def card(state: str = "open") -> RequestCard:
    return RequestCard(
        request=open_request().model_copy(update={"state": state}),
        reference=RequestReference(token="tok1", handle="R42"),
    )


async def test_a_card_has_buttons_that_post_the_typed_answer() -> None:
    server = Server({"chat.sendMessage": message_response})
    adapter = adapter_on(server)
    ref = await adapter.post_rich(ROOM, "cody", card(), "root1")
    body = server.body("chat.sendMessage")["message"]
    assert ref == _publication_id("tok1")
    assert body["_id"] == ref
    assert body["tmid"] == "root1"
    actions = body["attachments"][0]["actions"]
    assert [(a["text"], a["msg"]) for a in actions] == [
        ("Allow once", "R42 1"),
        ("Deny", "R42 2"),
    ]
    assert all(action["msg_in_chat_window"] for action in actions)


async def test_a_settled_card_is_posted_without_buttons() -> None:
    server = Server({"chat.sendMessage": message_response})
    adapter = adapter_on(server)
    await adapter.post_rich(ROOM, "cody", card("resolved"))
    assert "attachments" not in server.body("chat.sendMessage")["message"]


async def test_posting_a_card_twice_finds_the_first() -> None:
    server = Server(
        {
            "chat.sendMessage": refused("error-duplicate"),
            "chat.getMessage": ok(
                message={
                    "_id": _publication_id("tok1"),
                    "rid": ROOM,
                    "u": {"_id": BOT},
                }
            ),
        }
    )
    adapter = adapter_on(server)
    assert await adapter.post_rich(ROOM, "cody", card()) == _publication_id("tok1")


async def test_a_refused_card_says_what_it_would_have_shown() -> None:
    server = Server(
        {
            "chat.sendMessage": refused("error-not-allowed"),
            "chat.getMessage": httpx.Response(400, json={"success": False}),
        }
    )
    adapter = adapter_on(server)
    with pytest.raises(RichContentFailed) as failure:
        await adapter.post_rich(ROOM, "cody", card())
    assert "R42" in failure.value.text


async def test_a_card_whose_outcome_is_unknown_is_not_called_refused() -> None:
    server = Server({"chat.sendMessage": httpx.Response(502)})
    adapter = adapter_on(server)
    with pytest.raises(RocketChatUnavailable):
        await adapter.post_rich(ROOM, "cody", card())


async def test_a_rate_limit_carries_its_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "switch_core.bridges.collaboration.rocketchat.client.time.time", lambda: 1000.0
    )
    server = Server(
        {
            "chat.sendMessage": httpx.Response(
                429, headers={"x-ratelimit-reset": "1012000"}
            )
        }
    )
    adapter = adapter_on(server)
    with pytest.raises(RichContentThrottled) as throttled:
        await adapter.post_rich(ROOM, "cody", card())
    assert throttled.value.retry_after == 12.0


async def test_redrawing_an_open_card_changes_only_its_text() -> None:
    server = Server({"chat.update": ok(message={})})
    adapter = adapter_on(server)
    realtime = FakeRealtime()
    adapter._realtime = realtime  # type: ignore[assignment]
    await adapter.update_rich(ROOM, "cody", "m1", card(), None)
    assert server.body("chat.update")["msgId"] == "m1"
    assert realtime.calls == []


async def test_a_settled_card_loses_its_buttons_over_the_connection() -> None:
    server = Server()
    adapter = adapter_on(server)
    realtime = FakeRealtime()
    adapter._realtime = realtime  # type: ignore[assignment]
    await adapter.update_rich(ROOM, "cody", "m1", card("resolved"), None)
    method, params = realtime.calls[0]
    assert method == "updateMessage"
    assert params[0]["_id"] == "m1"
    assert params[0]["attachments"] == []
    assert server.requests == []


@pytest.mark.parametrize(
    "realtime", [None, FakeRealtime(connected=False), FakeRealtime(fails=True)]
)
async def test_a_settled_card_is_redrawn_even_with_no_connection(
    realtime: FakeRealtime | None, caplog: pytest.LogCaptureFixture
) -> None:
    server = Server({"chat.update": ok(message={})})
    adapter = adapter_on(server)
    adapter._realtime = realtime  # type: ignore[assignment]
    await adapter.update_rich(ROOM, "cody", "m1", card("resolved"), None)
    assert server.to("chat.update")
    assert "keeps its buttons" in caplog.text


async def test_a_rejected_token_on_a_card_is_a_failure_the_publisher_releases() -> None:
    unauthorized = httpx.Response(401, json={})
    adapter = adapter_on(
        Server({"chat.sendMessage": unauthorized, "chat.update": unauthorized})
    )
    with pytest.raises(RichContentFailed):
        await adapter.post_rich(ROOM, "cody", card())
    with pytest.raises(RichContentFailed):
        await adapter.update_rich(ROOM, "cody", "m1", card(), None)


async def test_a_refused_redraw_is_reported() -> None:
    server = Server({"chat.update": refused("error-message-not-found")})
    adapter = adapter_on(server)
    with pytest.raises(RichContentFailed):
        await adapter.update_rich(ROOM, "cody", "m1", card(), None)


def status(**fields: Any) -> TurnActivity:
    return TurnActivity(
        items=[_item(title="Ran the tests")], turn=_turn("running"), **fields
    )


async def test_a_status_is_posted_under_the_agents_name_and_its_id() -> None:
    server = Server({"chat.sendMessage": message_response})
    adapter = await with_presentation(adapter_on(server))
    ref = await adapter.post_rich(
        ROOM, "cody", status(publication_token="status1"), "root1"
    )
    body = server.body("chat.sendMessage")["message"]
    assert ref == _publication_id("status1") == body["_id"]
    assert (body["alias"], body["tmid"]) == ("Cody", "root1")
    assert "Ran the tests" in body["msg"]
    assert "attachments" not in body


async def test_a_status_with_no_token_is_given_an_id_by_the_server() -> None:
    server = Server({"chat.sendMessage": message_response})
    adapter = adapter_on(server)
    assert await adapter.post_rich(ROOM, "cody", status()) == "generated"
    assert "_id" not in server.body("chat.sendMessage")["message"]


async def test_a_status_redrawn_in_place_keeps_its_message() -> None:
    server = Server({"chat.update": ok(message={})})
    adapter = adapter_on(server)
    realtime = FakeRealtime()
    adapter._realtime = realtime  # type: ignore[assignment]
    await adapter.update_rich(ROOM, "cody", "m1", status(), None)
    update = server.body("chat.update")
    assert update["msgId"] == "m1"
    assert "Ran the tests" in update["text"]
    assert realtime.calls == []


@pytest.mark.parametrize("unreachable", [True, False])
async def test_a_status_says_when_nobody_was_there_to_notify(
    unreachable: bool,
) -> None:
    server = Server({"chat.sendMessage": message_response})
    adapter = adapter_on(server)
    await adapter.post_rich(ROOM, "cody", status(notify_unreachable=unreachable))
    text = server.body("chat.sendMessage")["message"]["msg"]
    assert (adapter.unnotified_notice() in text) is unreachable


async def test_a_redraw_of_a_status_that_is_throttled_carries_its_wait(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "switch_core.bridges.collaboration.rocketchat.client.time.time", lambda: 1000.0
    )
    server = Server(
        {"chat.update": httpx.Response(429, headers={"x-ratelimit-reset": "1012000"})}
    )
    adapter = adapter_on(server)
    with pytest.raises(RichContentThrottled) as throttled:
        await adapter.update_rich(ROOM, "cody", "m1", status(), None)
    assert throttled.value.retry_after == 12.0


def test_a_card_falls_back_to_text_that_says_how_to_answer_it() -> None:
    text = adapter_on(Server()).rich_fallback_text(card())
    assert "1. Allow once" in text and "2. Deny" in text
    assert "Reply with `R42`" in text and "`R42 1`" in text


async def test_a_publication_is_found_by_its_token() -> None:
    expected = _publication_id("tok1")
    server = Server(
        {
            "chat.getMessage": ok(
                message={"_id": expected, "rid": ROOM, "u": {"_id": BOT}}
            )
        }
    )
    adapter = adapter_on(server)
    found = await adapter.find_request_card(
        ROOM, None, "tok1", datetime.now(UTC), "R42"
    )
    assert found == expected
    assert server.to("chat.getMessage")[0].url.params["msgId"] == expected


@pytest.mark.parametrize(
    "message",
    [
        {"rid": "another-room", "u": {"_id": BOT}},
        {"rid": ROOM, "u": {"_id": PERSON}},
    ],
)
async def test_an_id_somebody_else_holds_is_not_the_publication(
    message: dict[str, Any],
) -> None:
    server = Server({"chat.getMessage": ok(message=message)})
    adapter = adapter_on(server)
    found = await adapter.find_request_card(
        ROOM, None, "tok1", datetime.now(UTC), "R42"
    )
    assert found is None


async def test_a_lookup_that_fails_is_asked_again() -> None:
    server = Server({"chat.getMessage": httpx.Response(503)})
    adapter = adapter_on(server)
    found = await adapter.find_request_card(
        ROOM, None, "tok1", datetime.now(UTC), "R42"
    )
    assert found is None


async def test_first_reply_reads_the_thread() -> None:
    server = Server({"chat.getThreadMessages": ok(messages=[{"_id": "reply1"}])})
    adapter = adapter_on(server)
    assert await adapter.is_first_reply(ROOM, "root", "reply1") is True
    assert await adapter.is_first_reply(ROOM, "root", "reply2") is False


async def test_first_reply_never_raises() -> None:
    server = Server({"chat.getThreadMessages": httpx.Response(500)})
    adapter = adapter_on(server)
    assert await adapter.is_first_reply(ROOM, "root", "reply1") is False
    adapter._client = None
    assert await adapter.is_first_reply(ROOM, "root", "reply1") is False


async def test_a_mention_is_resolved_once() -> None:
    server = Server({"users.info": ok(user={"username": "alice"})})
    adapter = adapter_on(server)
    assert await adapter._mention(PERSON) == "@alice"
    assert await adapter._mention(PERSON) == "@alice"
    assert len(server.to("users.info")) == 1


async def test_a_mention_that_cannot_be_resolved_is_left_out_of_the_card(
    caplog: pytest.LogCaptureFixture,
) -> None:
    server = Server(
        {"chat.sendMessage": message_response, "users.info": httpx.Response(500)}
    )
    adapter = adapter_on(server)
    await adapter.post_rich(ROOM, "cody", replace(card(), notify_external_id=PERSON))
    assert "@" not in server.body("chat.sendMessage")["message"]["msg"]
    assert "Could not resolve Rocket.Chat user" in caplog.text


async def test_the_name_cache_forgets_its_oldest_name_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(module, "_MAX_SEEN", 1)
    names = {"u1": "alice", "u2": "bob"}
    server = Server(
        {
            "users.info": lambda request: ok(
                user={"username": names[request.url.params["userId"]]}
            )
        }
    )
    adapter = adapter_on(server)
    assert await adapter._mention("u1") == "@alice"
    assert await adapter._mention("u2") == "@bob"
    assert await adapter._mention("u1") == "@alice"
    assert len(server.to("users.info")) == 3


# ── Channels ─────────────────────────────────────────────────────────────────


async def test_a_public_channel_is_created_with_its_topic() -> None:
    server = Server(
        {"channels.create": ok(channel={"_id": "c1"}), "channels.setTopic": ok()}
    )
    adapter = adapter_on(server)
    room = await adapter.create_channel("Deploy Reviews!", "Reviews")
    assert room == "c1"
    assert server.body("channels.create") == {"name": "deploy-reviews"}
    assert server.body("channels.setTopic") == {"roomId": "c1", "topic": "Reviews"}


async def test_a_private_channel_is_a_group() -> None:
    server = Server({"groups.create": ok(group={"_id": "g1"})})
    adapter = adapter_on(server)
    room = await adapter.create_channel("ops", "", channel_type="channel_private")
    assert room == "g1"


async def test_a_taken_name_gets_a_suffix() -> None:
    answers = iter([refused("error-duplicate-channel-name"), ok(channel={"_id": "c2"})])
    server = Server({"channels.create": lambda request: next(answers)})
    adapter = adapter_on(server)
    assert await adapter.create_channel("ops", "") == "c2"
    assert server.body("channels.create")["name"].startswith("ops-")


async def test_a_refused_channel_carries_what_the_server_said() -> None:
    server = Server({"channels.create": refused("error-not-allowed")})
    adapter = adapter_on(server)
    with pytest.raises(RocketChatRefused, match="error-not-allowed"):
        await adapter.create_channel("ops", "")


async def test_a_direct_room_cannot_be_created_as_a_channel() -> None:
    adapter = adapter_on(Server())
    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("x", "", channel_type="direct")


async def test_a_direct_message_is_opened_with_the_person() -> None:
    server = Server(
        {
            "users.info": ok(user={"_id": PERSON, "username": "alice"}),
            "im.create": ok(room={"rid": "d1"}),
        }
    )
    adapter = adapter_on(server)
    room = await adapter.create_dm_channel(
        agent_name="cody", user_name="alice", user_external_id=PERSON
    )
    assert room == "d1"
    assert server.body("im.create") == {"username": "alice"}


async def test_no_direct_message_opens_with_someone_who_took_the_persons_name() -> None:
    server = Server({"users.info": ok(user={"_id": "newcomer", "username": "alice"})})
    adapter = adapter_on(server)
    with pytest.raises(BridgeOperationError, match="no longer the person"):
        await adapter.create_dm_channel(
            agent_name="cody", user_name="alice", user_external_id=PERSON
        )
    assert server.to("im.create") == []


async def test_who_could_not_be_added_is_handed_back() -> None:
    answers = iter([ok(), refused("error-not-allowed")])
    server = Server(
        {
            "rooms.info": ok(room={"_id": ROOM, "t": "c"}),
            "channels.invite": lambda request: next(answers),
        }
    )
    adapter = adapter_on(server)
    left_out = await adapter.add_users_to_channel(ROOM, ["a", "b"], ["idA", "idB"])
    assert left_out == ["idB"]


async def test_nobody_can_be_added_to_a_direct_message() -> None:
    server = Server({"rooms.info": ok(room={"_id": ROOM, "t": "d", "usersCount": 2})})
    adapter = adapter_on(server)
    assert await adapter.add_users_to_channel(ROOM, ["a"], ["idA"]) == ["idA"]


async def test_a_room_that_cannot_be_read_leaves_everyone_out(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = adapter_on(Server({"rooms.info": httpx.Response(500)}))
    left_out = await adapter.add_users_to_channel(ROOM, ["a", "b"], ["idA", "idB"])
    assert left_out == ["idA", "idB"]
    assert "Could not read Rocket.Chat room" in caplog.text


async def test_inviting_nobody_is_nothing() -> None:
    adapter = adapter_on(Server())
    assert await adapter.add_users_to_channel(ROOM, [], []) == []


async def test_a_deleted_rooms_channel_is_archived() -> None:
    server = Server(
        {"rooms.info": ok(room={"_id": ROOM, "t": "p"}), "groups.archive": ok()}
    )
    adapter = adapter_on(server)
    outcome = await adapter.retire_channel(ROOM)
    assert outcome.outcome == "archived"


async def test_a_refused_archive_says_why() -> None:
    server = Server(
        {
            "rooms.info": ok(room={"_id": ROOM, "t": "c"}),
            "channels.archive": refused("error-not-authorized"),
        }
    )
    adapter = adapter_on(server)
    outcome = await adapter.retire_channel(ROOM)
    assert outcome.outcome == "failed"
    assert "error-not-authorized" in (outcome.reason or "")


async def test_a_direct_message_is_kept_when_its_room_is_deleted() -> None:
    server = Server({"rooms.info": ok(room={"_id": ROOM, "t": "d", "usersCount": 2})})
    adapter = adapter_on(server)
    assert (await adapter.retire_channel(ROOM)).outcome == "kept"


async def test_agents_have_no_membership_or_identity_to_keep() -> None:
    adapter = adapter_on(Server())
    agent = AgentIdentity(
        agent_id="a1", name="cody", description="", display_name="Cody"
    )
    assert await adapter.add_agents_to_channel(ROOM, ["cody"]) is None
    assert await adapter.get_channel_agent_names(ROOM) == []
    assert await adapter.create_agent_identity(agent) is None
    assert await adapter.remove_agent_identity(agent) is None


@pytest.mark.parametrize(
    ("room", "expected"),
    [
        ({"t": "c", "name": "general"}, f"{SERVER}/channel/general"),
        ({"t": "p", "name": "ops"}, f"{SERVER}/group/ops"),
        ({"t": "d"}, f"{SERVER}/direct/{ROOM}"),
    ],
)
async def test_channel_links(room: dict[str, Any], expected: str) -> None:
    adapter = adapter_on(Server({"rooms.info": ok(room=room)}))
    assert await adapter.channel_deeplink(ROOM) == expected


async def test_a_kind_of_room_switch_does_not_bridge_is_not_called_a_channel() -> None:
    adapter = adapter_on(Server({"rooms.info": ok(room={"_id": ROOM, "t": "l"})}))
    with pytest.raises(BridgeOperationError, match="does not bridge"):
        await adapter.get_channel_type(ROOM)


async def test_a_renamed_room_gets_a_link_with_its_new_name() -> None:
    names = iter(["before", "after"])
    server = Server(
        {"rooms.info": lambda request: ok(room={"t": "c", "name": next(names)})}
    )
    adapter = adapter_on(server)
    assert await adapter.channel_deeplink(ROOM) == f"{SERVER}/channel/before"
    assert await adapter.channel_deeplink(ROOM) == f"{SERVER}/channel/after"


async def test_links_use_the_public_address_where_there_is_one() -> None:
    server = Server({"rooms.info": ok(room={"t": "c", "name": "general"})})
    adapter = adapter_on(server, config={"public_url": "https://chat.public.test/"})
    assert await adapter.channel_deeplink(ROOM) == (
        "https://chat.public.test/channel/general"
    )
    assert await adapter.home_deeplink() == "https://chat.public.test"


async def test_a_link_to_a_room_that_cannot_be_read_is_none(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = adapter_on(Server({"rooms.info": httpx.Response(500)}))
    assert await adapter.channel_deeplink(ROOM) is None
    assert "Could not build a link" in caplog.text


async def test_directory_matches_people_and_leaves_out_bots() -> None:
    users = [
        {"_id": "1", "username": "alice", "name": "Alice A", "type": "user"},
        {"_id": "2", "username": "bob", "name": "Malice B", "type": "user"},
        {"_id": "3", "username": "carol", "name": "Carol", "type": "user"},
        {"_id": "4", "username": "alicebot", "name": "x", "type": "bot"},
        {"_id": BOT, "username": "alice-switch", "name": "x", "type": "user"},
        {"_id": "5", "username": "alice2", "name": "y", "active": False},
    ]
    server = Server({"users.list": ok(users=users, total=len(users))})
    adapter = adapter_on(server)
    found = await adapter.search_directory_users(" ALICE ")
    assert [user.external_user_id for user in found] == ["1", "2"]
    assert found[0].email is None


async def test_directory_reads_every_page() -> None:
    def page(request: httpx.Request) -> httpx.Response:
        offset = int(request.url.params["offset"])
        users = [
            {"_id": str(offset + i), "username": f"user{offset + i}"}
            for i in range(200)
        ]
        return ok(users=users if offset < 400 else [], total=400)

    adapter = adapter_on(Server({"users.list": page}))
    assert len(await adapter.search_directory_users("user")) == 400


async def test_a_directory_past_the_limit_is_searched_up_to_it_and_says_so(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(module, "_DIRECTORY_PAGE", 2)
    monkeypatch.setattr(module, "_DIRECTORY_MAX_USERS", 4)

    def page(request: httpx.Request) -> httpx.Response:
        offset = int(request.url.params["offset"])
        users = [
            {"_id": f"id{offset + i}", "username": f"user{offset + i}"}
            for i in range(2)
        ]
        return ok(users=users, total=100)

    server = Server({"users.list": page})
    found = await adapter_on(server).search_directory_users("user")
    assert len(found) == 4
    assert len(server.to("users.list")) == 2
    assert "more than 4 users" in caplog.text


async def test_a_blank_directory_search_finds_nobody() -> None:
    adapter = adapter_on(Server())
    assert await adapter.search_directory_users("  ") == []


async def test_a_failed_directory_search_says_so() -> None:
    adapter = adapter_on(Server({"users.list": httpx.Response(500)}))
    with pytest.raises(RuntimeError, match="directory lookup failed"):
        await adapter.search_directory_users("alice")


# ── Rendering ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("**bold** stays", "**bold** stays"),
        ("*italic* word", "_italic_ word"),
        ("2*3*4 stays", "2*3*4 stays"),
        ("`*code*` stays", "`*code*` stays"),
        ("```\n*code*\n```\n*text*", "```\n*code*\n```\n_text_"),
        ("- a list item", "- a list item"),
        ("see @alice:switch.example.test now", "see @alice now"),
        ("Hi @cody:switch.example.test, can you", "Hi @cody, can you"),
        ("(see @cody:switch.example.test)", "(see @cody)"),
        ("ask `@cody:switch.example.test`", "ask `@cody`"),
        ("ping @cody:switch.example.test.", "ping @cody."),
        ("on @cody:localhost:8448!", "on @cody!"),
        ("mail me@host:25 stays", "mail me@host:25 stays"),
    ],
)
def test_outbound_markup(given: str, expected: str) -> None:
    assert adapter_on(Server())._render_outbound(given) == expected


@pytest.mark.parametrize("text", ["@all hi", "@here hi", "@channel hi"])
def test_a_body_cannot_page_the_room(text: str) -> None:
    rendered = adapter_on(Server()).translate_outbound(text)
    assert not rendered.startswith(text[:4] + " ")


def test_a_room_wide_mention_names_nobody_the_server_would_refuse() -> None:
    adapter = adapter_on(Server())
    assert adapter.room_wide_mention_notifies is False
    assert "@all" not in adapter.render_room_wide_mention("@everyone deploy done")


def test_an_app_mention_is_a_handle() -> None:
    assert adapter_on(Server()).render_app_mention("switchbot") == "@switchbot"


def test_what_the_platform_can_do_is_declared() -> None:
    assert RocketChatAdapter.keeps_quiet_unless_listening is True
    assert RocketChatAdapter.draws_session_activity is True
    assert RocketChatAdapter.supports_channel_creation is True
    assert RocketChatAdapter.supports_directory_search is True
    assert RocketChatAdapter.activity_reactions_per_agent is False
    assert RocketChatAdapter.renders_custom_url_schemes is False
    assert RocketChatAdapter.channel_on_delete == "archived"
    assert adapter_on(Server()).slash_invite_hint() is None


# ── The client ───────────────────────────────────────────────────────────────


def client_for(answer: httpx.Response) -> RocketChatClient:
    return RocketChatClient(
        httpx.AsyncClient(transport=httpx.MockTransport(lambda r: answer)),
        url=SERVER,
        user_id=BOT,
        token="fixture-token",
    )


async def test_a_server_under_a_path_is_addressed_under_it() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return ok()

    client = RocketChatClient(
        httpx.AsyncClient(transport=httpx.MockTransport(handle)),
        url=f"{SERVER}/rc",
        user_id=BOT,
        token="fixture-token",
    )
    await client.get("me")
    assert seen[0].url.path == "/rc/api/v1/me"


async def test_success_false_on_a_200_is_a_refusal() -> None:
    with pytest.raises(RocketChatRefused):
        await client_for(httpx.Response(200, json={"success": False})).get("me")


async def test_a_redirect_is_not_followed_with_the_token() -> None:
    answer = httpx.Response(301, json={}, headers={"location": "https://x.example"})
    with pytest.raises(RocketChatUnavailable, match="redirect"):
        await client_for(answer).get("me")


async def test_a_rate_limit_with_no_reset_still_waits() -> None:
    with pytest.raises(RocketChatThrottled) as throttled:
        await client_for(httpx.Response(429)).get("me")
    assert throttled.value.retry_after > 0


async def test_a_body_that_is_not_an_object_is_unavailable() -> None:
    with pytest.raises(RocketChatUnavailable, match="something other than an object"):
        await client_for(httpx.Response(200, json=["not", "an", "object"])).get("me")
