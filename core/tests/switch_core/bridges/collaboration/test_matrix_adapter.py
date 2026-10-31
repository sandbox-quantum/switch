from __future__ import annotations

from typing import Any, cast

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.matrix.adapter import (
    MatrixAdapter,
    MatrixConnectionConfig,
)
from switch_core.bridges.collaboration.matrix.client import MatrixApiError, MatrixClient
from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)


class FakeMatrixClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.members: dict[str, Any] = {
            "joined": {"@bot:example.com": {}, "@ada:example.com": {}}
        }
        self.fail_invites: set[str] = set()
        self.downloaded = b"file"

    async def joined_members(self, room_id: str) -> dict[str, Any]:
        self.calls.append(("joined_members", room_id))
        return self.members

    async def join(self, room_id: str) -> None:
        self.calls.append(("join", room_id))

    async def send_message(self, room_id: str, content: dict[str, Any]) -> str:
        self.calls.append(("send_message", (room_id, content)))
        return "$event"

    async def redact(self, room_id: str, event_id: str) -> None:
        self.calls.append(("redact", (room_id, event_id)))

    async def typing(self, room_id: str, user_id: str, *, typing: bool) -> None:
        self.calls.append(("typing", (room_id, user_id, typing)))

    async def create_room(self, *, name: str, topic: str, public: bool) -> str:
        self.calls.append(("create_room", (name, topic, public)))
        return "!new:example.com"

    async def invite(self, room_id: str, user_id: str) -> None:
        self.calls.append(("invite", (room_id, user_id)))
        if user_id in self.fail_invites:
            raise MatrixApiError(403, "M_FORBIDDEN", "cannot invite")

    async def leave(self, room_id: str) -> None:
        self.calls.append(("leave", room_id))

    async def search_users(self, query: str) -> list[dict[str, Any]]:
        self.calls.append(("search_users", query))
        return [
            {"user_id": "@ada:example.com", "display_name": "Ada"},
            {"user_id": "@bob:example.com"},
        ]

    async def upload(self, data: bytes, *, filename: str, mimetype: str) -> str:
        self.calls.append(("upload", (data, filename, mimetype)))
        return "mxc://example.com/media"

    async def download(self, mxc_uri: str) -> bytes:
        self.calls.append(("download", mxc_uri))
        return self.downloaded


def adapter() -> MatrixAdapter:
    value = MatrixAdapter(
        config=MatrixConnectionConfig(
            homeserver_url="https://matrix.example.com", access_token="secret"
        )
    )
    value._client = cast(MatrixClient, FakeMatrixClient())
    value._user_id = "@bot:example.com"
    return value


def test_config_normalises_homeserver() -> None:
    config = MatrixConnectionConfig(
        homeserver_url=" https://matrix.example.com/ ", access_token="secret"
    )
    assert config.homeserver_url == "https://matrix.example.com"


@pytest.mark.parametrize(
    "url",
    [
        "ftp://matrix.example.com",
        "https://matrix.example.com/_matrix",
        "https://user:secret@matrix.example.com",
        "https://matrix.example.com?token=x",
    ],
)
def test_config_refuses_non_origin_homeserver(url: str) -> None:
    with pytest.raises(ValidationError):
        MatrixConnectionConfig(homeserver_url=url, access_token="secret")


def test_sync_token_is_hidden_from_connect_schema() -> None:
    schema = MatrixConnectionConfig.model_json_schema()
    assert "sync_token" not in schema["properties"]


def test_exclusive_resource_does_not_disclose_token() -> None:
    resource = MatrixAdapter.exclusive_resource(
        {"homeserver_url": "https://matrix.example.com", "access_token": "secret"}
    )
    assert resource is not None
    assert "secret" not in resource


@pytest.mark.asyncio
async def test_client_authenticates_and_encodes_room_path() -> None:
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"joined": {}})

    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        headers={"Authorization": "Bearer token"},
    )
    client = MatrixClient(
        homeserver_url="https://matrix.example.com", access_token="token", http=http
    )
    await client.joined_members("!room:example.com")
    assert seen[0].headers["authorization"] == "Bearer token"
    assert "%21room%3Aexample.com" in str(seen[0].url)
    await http.aclose()


@pytest.mark.asyncio
async def test_client_surfaces_matrix_error() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401, json={"errcode": "M_UNKNOWN_TOKEN", "error": "expired"}
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = MatrixClient(
        homeserver_url="https://matrix.example.com", access_token="token", http=http
    )
    with pytest.raises(MatrixApiError) as raised:
        await client.whoami()
    assert raised.value.errcode == "M_UNKNOWN_TOKEN"
    await http.aclose()


def message_event(
    *,
    body: str = "hello",
    relates: dict[str, Any] | None = None,
    msgtype: str = "m.text",
) -> dict[str, Any]:
    content: dict[str, Any] = {"msgtype": msgtype, "body": body}
    if relates:
        content["m.relates_to"] = relates
    return {
        "type": "m.room.message",
        "event_id": "$message",
        "sender": "@ada:example.com",
        "content": content,
    }


@pytest.mark.asyncio
async def test_sync_discovers_room_and_dispatches_thread() -> None:
    value = adapter()
    messages: list[InboundMessage] = []
    app_joins: list[InboundAppJoin] = []

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    async def on_app_joined(joined: InboundAppJoin) -> None:
        app_joins.append(joined)

    value._on_message = on_message
    value._on_app_joined = on_app_joined
    response = {
        "next_batch": "s1",
        "rooms": {
            "join": {
                "!room:example.com": {
                    "state": {
                        "events": [
                            {
                                "type": "m.room.name",
                                "content": {"name": "Project"},
                            },
                            {
                                "type": "m.room.member",
                                "state_key": "@ada:example.com",
                                "content": {"displayname": "Ada", "membership": "join"},
                            },
                        ]
                    },
                    "timeline": {
                        "events": [
                            message_event(
                                relates={
                                    "rel_type": "m.thread",
                                    "event_id": "$root",
                                }
                            )
                        ]
                    },
                }
            }
        },
    }
    await value._apply_sync(response, dispatch_timeline=True)
    assert app_joins[0].channel_id == "!room:example.com"
    assert app_joins[0].channel_type == "direct"
    assert app_joins[0].channel_name == "Project"
    assert messages[0].sender_name == "Ada"
    assert messages[0].root_id == "$root"
    assert messages[0].message_ref == "$message"


@pytest.mark.asyncio
async def test_initial_sync_does_not_replay_timeline() -> None:
    value = adapter()
    messages: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    value._on_message = on_message
    await value._apply_sync(
        {
            "rooms": {
                "join": {
                    "!room:example.com": {
                        "state": {"events": []},
                        "timeline": {"events": [message_event()]},
                    }
                }
            }
        },
        dispatch_timeline=False,
    )
    assert messages == []


@pytest.mark.asyncio
async def test_sync_cursor_is_persisted_after_dispatch() -> None:
    value = adapter()
    saved: list[dict[str, object]] = []

    async def persist(changes: dict[str, object]) -> None:
        saved.append(changes)

    value.set_state_persister(persist)
    await value._advance_cursor({"next_batch": "s2"})
    assert value._sync_token == "s2"
    assert saved == [{"sync_token": "s2"}]


@pytest.mark.asyncio
async def test_invited_room_is_joined() -> None:
    value = adapter()
    await value._apply_sync(
        {"rooms": {"invite": {"!invite:example.com": {}}}},
        dispatch_timeline=True,
    )
    fake = cast(FakeMatrixClient, value._client)
    assert ("join", "!invite:example.com") in fake.calls


@pytest.mark.asyncio
async def test_command_routes_to_command_callback() -> None:
    value = adapter()
    commands: list[InboundCommand] = []

    async def on_command(command: InboundCommand) -> None:
        commands.append(command)

    value._on_command = on_command
    await value._handle_event("!room:example.com", message_event(body="!reset @ada"))
    assert commands[0].command == "reset"
    assert commands[0].args == "@ada"


@pytest.mark.asyncio
async def test_bot_echo_and_inbound_edit_are_ignored() -> None:
    value = adapter()
    messages: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    value._on_message = on_message
    echo = message_event()
    echo["sender"] = "@bot:example.com"
    await value._handle_event("!room:example.com", echo)
    await value._handle_event(
        "!room:example.com",
        message_event(relates={"rel_type": "m.replace", "event_id": "$old"}),
    )
    assert messages == []


@pytest.mark.asyncio
async def test_member_join_is_reported_once() -> None:
    value = adapter()
    joins: list[InboundUserJoin] = []

    async def on_user_joined(joined: InboundUserJoin) -> None:
        joins.append(joined)

    value._on_user_joined = on_user_joined
    event = {
        "type": "m.room.member",
        "sender": "@admin:example.com",
        "state_key": "@ada:example.com",
        "content": {"membership": "join", "displayname": "Ada"},
    }
    await value._handle_event("!room:example.com", event)
    await value._handle_event("!room:example.com", event)
    assert len(joins) == 1
    assert joins[0].external_username == "Ada"


@pytest.mark.asyncio
async def test_encrypted_event_sets_attention_and_is_not_dispatched() -> None:
    value = adapter()
    messages: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    value._on_message = on_message
    await value._handle_event(
        "!secret:example.com",
        {
            "type": "m.room.encrypted",
            "event_id": "$ciphertext",
            "sender": "@ada:example.com",
            "content": {"algorithm": "m.megolm.v1.aes-sha2"},
        },
    )
    assert messages == []
    assert "end-to-end encryption" in (await value.attention() or "")
    with pytest.raises(BridgeOperationError, match="end-to-end encrypted"):
        await value.send_message("!secret:example.com", "Ada", "hello")


@pytest.mark.asyncio
async def test_media_download_and_limit() -> None:
    value = adapter()
    messages: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    value._on_message = on_message
    event = message_event(body="photo.jpg", msgtype="m.image")
    event["content"].update(
        {
            "url": "mxc://example.com/media",
            "info": {"size": 4, "mimetype": "image/jpeg"},
        }
    )
    await value._handle_event("!room:example.com", event)
    assert messages[0].attachments[0].data == b"file"
    value.set_max_attachment_bytes(3)
    event["event_id"] = "$large"
    await value._handle_event("!room:example.com", event)
    assert "larger" in messages[1].attachment_failures[0].reason


@pytest.mark.asyncio
async def test_outbound_message_contains_matrix_thread_relation() -> None:
    value = adapter()
    ref = await value.send_message(
        "!room:example.com", "Ada", "<p>Hello <strong>world</strong></p>", "$root"
    )
    assert ref == "$event"
    fake = cast(FakeMatrixClient, value._client)
    content = fake.calls[0][1][1]
    assert content["body"] == "Ada: Hello world"
    assert content["m.relates_to"]["rel_type"] == "m.thread"
    assert content["m.relates_to"]["event_id"] == "$root"


@pytest.mark.asyncio
async def test_update_uses_replace_and_delete_redacts() -> None:
    value = adapter()
    await value.update_message("!room:example.com", "$old", "<p>new</p>")
    await value.delete_message("!room:example.com", "$old")
    fake = cast(FakeMatrixClient, value._client)
    update = fake.calls[0][1][1]
    assert update["m.relates_to"] == {"rel_type": "m.replace", "event_id": "$old"}
    assert update["m.new_content"]["body"] == "new"
    assert fake.calls[1] == ("redact", ("!room:example.com", "$old"))


@pytest.mark.asyncio
async def test_create_room_and_invites_report_partial_failure() -> None:
    value = adapter()
    room_id = await value.create_channel("Project", "topic", channel_type="group")
    fake = cast(FakeMatrixClient, value._client)
    fake.fail_invites.add("@bad:example.com")
    failed = await value.add_users_to_channel(
        room_id,
        ["Ada", "Bad"],
        ["@ada:example.com", "@bad:example.com"],
    )
    assert room_id == "!new:example.com"
    assert fake.calls[0] == ("create_room", ("Project", "topic", False))
    assert failed == ["@bad:example.com"]


@pytest.mark.asyncio
async def test_directory_search_returns_matrix_ids() -> None:
    value = adapter()
    users = await value.search_directory_users("ada")
    assert [user.external_user_id for user in users] == [
        "@ada:example.com",
        "@bob:example.com",
    ]
    assert users[0].display_name == "Ada"


@pytest.mark.asyncio
async def test_attachment_upload_uses_mxc_uri() -> None:
    value = adapter()
    ref = await value.send_attachment(
        "!room:example.com", "Ada", "photo.jpg", "image/jpeg", b"data"
    )
    fake = cast(FakeMatrixClient, value._client)
    assert ref == "$event"
    assert fake.calls[0][0] == "upload"
    content = fake.calls[1][1][1]
    assert content["msgtype"] == "m.image"
    assert content["url"] == "mxc://example.com/media"


@pytest.mark.asyncio
async def test_retire_room_leaves_it() -> None:
    value = adapter()
    outcome = await value.retire_channel("!room:example.com")
    assert outcome.outcome == "left"


def test_rendering_produces_html_and_plain_fallback() -> None:
    value = adapter()
    rendered = value._render_outbound("**bold** and [link](https://example.com)")
    assert "<strong>bold</strong>" in rendered
    assert MatrixAdapter._plain(rendered) == "bold and link"


@pytest.mark.asyncio
async def test_missing_sync_cursor_is_refused() -> None:
    value = adapter()
    with pytest.raises(BridgeOperationError, match="next_batch"):
        await value._advance_cursor({})
