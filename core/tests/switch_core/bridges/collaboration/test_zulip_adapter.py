"""The Zulip adapter against Zulip's HTTP API, mocked at the transport.

Payloads are the shapes a Zulip 12 server answered with when the adapter was
built against one; ids, names and keys are made up.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.adapter import ActivityMarkRefused
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    InboundCommand,
    InboundMessage,
)
from switch_core.bridges.collaboration.zulip import adapter as zulip
from switch_core.bridges.collaboration.zulip.adapter import (
    NEW_CONVERSATION_TOPIC,
    ZulipAdapter,
    ZulipConnectionConfig,
    ZulipError,
)

SERVER = "https://chat.example.com"
BOT_ID = 10
PERSON_ID = 9
STREAM_ID = 6
CONFIG = {
    "server_url": SERVER,
    "bot_email": "switch-bot@chat.example.com",
    "api_key": "made-up-key",
}

Handler = Callable[[httpx.Request], httpx.Response]


def _ok(**fields: Any) -> httpx.Response:
    return httpx.Response(200, json={"result": "success", "msg": "", **fields})


def _form(request: httpx.Request) -> dict[str, str]:
    return {
        key: values[0] for key, values in parse_qs(request.content.decode()).items()
    }


class Zulip:
    """A Zulip server that answers what a test sets and records what it was asked."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.routes: dict[tuple[str, str], Handler] = {}
        self.next_id = 100

    def on(self, method: str, path: str, handler: Handler) -> None:
        self.routes[(method, path)] = handler

    def sent(self, method: str, path: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.method == method and r.url.path == path]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        handler = self.routes.get((request.method, request.url.path))
        if handler is None:
            raise AssertionError(f"unexpected request: {request.method} {request.url}")
        return handler(request)


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> Zulip:
    fake = Zulip()

    def client(config: ZulipConnectionConfig) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=config.server_url,
            auth=(config.bot_email, config.api_key),
            transport=httpx.MockTransport(fake),
        )

    monkeypatch.setattr(zulip, "_client", client)
    fake.on(
        "GET",
        "/api/v1/users/me",
        lambda r: _ok(user_id=BOT_ID, full_name="Switch", is_bot=True),
    )
    fake.on(
        "GET",
        f"/api/v1/streams/{STREAM_ID}",
        lambda r: _ok(
            stream={"stream_id": STREAM_ID, "name": "ops", "invite_only": False}
        ),
    )
    return fake


def _topic_rooted_at(root_id: int) -> Handler:
    return lambda r: _ok(messages=[{"id": root_id, "subject": "deploys"}])


async def _started(server: Zulip) -> tuple[ZulipAdapter, list[Any]]:
    heard: list[Any] = []

    async def hear(item: Any) -> None:
        heard.append(item)

    async def ignore(item: Any) -> None:
        return None

    adapter = ZulipAdapter(config=ZulipConnectionConfig.model_validate(CONFIG))
    adapter.set_listening(False)
    await adapter.start(hear, hear, ignore, ignore, ignore)
    return adapter, heard


def _message(**fields: Any) -> dict[str, Any]:
    return {
        "id": 15,
        "type": "stream",
        "stream_id": STREAM_ID,
        "display_recipient": "ops",
        "subject": "deploys",
        "sender_id": PERSON_ID,
        "sender_full_name": "Test Person",
        "sender_email": "user9@chat.example.com",
        "content": "hello",
        **fields,
    }


# ── Config ───────────────────────────────────────────────────────────────────


def test_a_server_url_is_kept_as_its_origin() -> None:
    config = ZulipConnectionConfig.model_validate(
        {**CONFIG, "server_url": f"{SERVER}/"}
    )
    assert config.server_url == SERVER


def test_plain_http_is_accepted_only_for_this_machine() -> None:
    local = {**CONFIG, "server_url": "http://zulip.localhost:9991"}
    assert (
        ZulipConnectionConfig.model_validate(local).server_url
        == "http://zulip.localhost:9991"
    )
    with pytest.raises(ValidationError, match="https"):
        ZulipConnectionConfig.model_validate(
            {**CONFIG, "server_url": "http://chat.example.com"}
        )


def test_a_server_url_with_a_path_is_refused() -> None:
    with pytest.raises(ValidationError, match="no path"):
        ZulipConnectionConfig.model_validate(
            {**CONFIG, "server_url": f"{SERVER}/api/v1"}
        )


def test_the_server_url_is_what_the_outbound_policy_checks() -> None:
    assert ZulipAdapter.outbound_urls(CONFIG) == [SERVER]


# ── Credentials and failures ─────────────────────────────────────────────────


async def test_a_bots_credentials_are_accepted(server: Zulip) -> None:
    await ZulipAdapter.verify_credentials(CONFIG)
    assert len(server.sent("GET", "/api/v1/users/me")) == 1


async def test_a_wrong_key_is_refused_in_zulips_own_words(server: Zulip) -> None:
    server.on(
        "GET",
        "/api/v1/users/me",
        lambda r: httpx.Response(
            401,
            json={
                "result": "error",
                "code": "UNAUTHORIZED",
                "msg": "Malformed API key",
            },
        ),
    )
    with pytest.raises(BridgeCredentialError, match="Malformed API key"):
        await ZulipAdapter.verify_credentials(CONFIG)


async def test_a_persons_credentials_are_refused_with_how_to_make_a_bot(
    server: Zulip,
) -> None:
    server.on(
        "GET",
        "/api/v1/users/me",
        lambda r: _ok(user_id=PERSON_ID, full_name="Test Person", is_bot=False),
    )
    with pytest.raises(BridgeCredentialError, match="generic bot"):
        await ZulipAdapter.verify_credentials(CONFIG)


def test_failures_are_classified_from_their_types() -> None:
    assert (
        ZulipAdapter.classify_failure(ZulipError("UNAUTHORIZED", "no")) == "auth_failed"
    )
    assert (
        ZulipAdapter.classify_failure(ZulipError("BAD_REQUEST", "no"))
        == "platform_error"
    )
    assert ZulipAdapter.classify_failure(httpx.ConnectError("down")) == "network"
    assert ZulipAdapter.classify_failure(ValueError("not ours")) is None


# ── Inbound ──────────────────────────────────────────────────────────────────


async def test_a_reply_in_a_topic_is_relayed_under_the_topics_first_message(
    server: Zulip,
) -> None:
    server.on("GET", "/api/v1/messages", _topic_rooted_at(12))
    adapter, heard = await _started(server)

    await adapter._relay(_message(content="@**helper** check the logs"), [])

    [inbound] = heard
    assert isinstance(inbound, InboundMessage)
    assert inbound.channel_id == str(STREAM_ID)
    assert inbound.channel_type == "channel_public"
    assert inbound.sender_id == str(PERSON_ID)
    assert inbound.sender_name == "Test Person"
    assert inbound.content == "@helper check the logs"
    assert inbound.message_ref == "15"
    assert inbound.root_id == "12"
    assert inbound.channel_name == "ops"
    assert inbound.self_mention_token is None


async def test_the_first_message_of_a_topic_is_a_threads_root(server: Zulip) -> None:
    server.on("GET", "/api/v1/messages", _topic_rooted_at(15))
    adapter, heard = await _started(server)

    await adapter._relay(_message(), [])

    assert heard[0].root_id is None


async def test_tagging_the_bot_itself_is_reported_by_its_name(server: Zulip) -> None:
    server.on("GET", "/api/v1/messages", _topic_rooted_at(15))
    adapter, heard = await _started(server)

    await adapter._relay(_message(content="@**Switch** who is here?"), ["mentioned"])

    assert heard[0].self_mention_token == "Switch"
    assert adapter.render_app_mention("Switch") == "@**Switch**"


async def test_a_bang_command_is_relayed_as_a_command(server: Zulip) -> None:
    server.on("GET", "/api/v1/messages", _topic_rooted_at(12))
    adapter, heard = await _started(server)

    await adapter._relay(_message(content="!invite-agent @helper"), [])

    [command] = heard
    assert isinstance(command, InboundCommand)
    assert (command.command, command.args) == ("invite-agent", "@helper")
    assert command.root_id == "12"


async def test_the_bots_own_messages_and_direct_messages_are_not_relayed(
    server: Zulip,
) -> None:
    adapter, heard = await _started(server)

    await adapter._relay(_message(sender_id=BOT_ID), [])
    await adapter._relay(_message(type="private"), [])

    assert heard == []


async def test_what_arrived_while_not_listening_is_relayed_and_marked_read(
    server: Zulip,
) -> None:
    def history(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("anchor") == "first_unread":
            return _ok(messages=[_message(id=21), _message(id=22)])
        return _ok(messages=[{"id": 21, "subject": "deploys"}])

    server.on("GET", "/api/v1/messages", history)
    server.on("POST", "/api/v1/messages/flags", lambda r: _ok())
    adapter, heard = await _started(server)

    await adapter._relay_unread()

    assert [m.message_ref for m in heard] == ["21", "22"]
    [marked] = server.sent("POST", "/api/v1/messages/flags")
    assert _form(marked) == {"messages": "[21, 22]", "op": "add", "flag": "read"}


# ── Outbound ─────────────────────────────────────────────────────────────────


async def test_an_agent_answers_in_its_threads_topic_under_its_name(
    server: Zulip,
) -> None:
    server.on(
        "GET",
        "/api/v1/messages/12",
        lambda r: _ok(message={"id": 12, "subject": "deploys"}),
    )
    server.on("POST", "/api/v1/messages", lambda r: _ok(id=30))
    adapter, _ = await _started(server)

    ref = await adapter.send_message(str(STREAM_ID), "helper", "Deployed **v2**.", "12")

    assert ref == "30"
    [posted] = server.sent("POST", "/api/v1/messages")
    assert _form(posted) == {
        "type": "stream",
        "to": str(STREAM_ID),
        "topic": "deploys",
        "content": "**helper:** Deployed **v2**.",
    }


async def test_a_post_outside_any_thread_goes_to_its_own_topic(server: Zulip) -> None:
    server.on("POST", "/api/v1/messages", lambda r: _ok(id=31))
    adapter, _ = await _started(server)

    await adapter.send_message(str(STREAM_ID), "helper", "Hello.")

    assert (
        _form(server.sent("POST", "/api/v1/messages")[0])["topic"]
        == NEW_CONVERSATION_TOPIC
    )


async def test_a_long_post_is_split_at_a_line_and_answers_with_its_first_part(
    server: Zulip,
) -> None:
    ids = iter([40, 41])
    server.on("POST", "/api/v1/messages", lambda r: _ok(id=next(ids)))
    adapter, _ = await _started(server)
    adapter._message_limit = 50

    ref = await adapter.send_message(
        str(STREAM_ID), "helper", "a" * 30 + "\n" + "b" * 30
    )

    assert ref == "40"
    parts = [_form(r)["content"] for r in server.sent("POST", "/api/v1/messages")]
    assert parts == ["**helper:** " + "a" * 30, "b" * 30]


async def test_a_mass_mention_notifies_nobody_unless_the_post_is_room_wide(
    server: Zulip,
) -> None:
    server.on("POST", "/api/v1/messages", lambda r: _ok(id=50))
    adapter, _ = await _started(server)

    await adapter.send_message(str(STREAM_ID), "helper", "ping @**all**")
    await adapter.send_message(
        str(STREAM_ID), "helper", "ping @**all**", room_wide_mention=True
    )

    first, second = (
        _form(r)["content"] for r in server.sent("POST", "/api/v1/messages")
    )
    assert "@**all**" not in first
    assert "@**all**" in second


async def test_an_edit_and_a_delete_reach_the_message(server: Zulip) -> None:
    server.on("PATCH", "/api/v1/messages/30", lambda r: _ok())
    server.on("DELETE", "/api/v1/messages/30", lambda r: _ok())
    adapter, _ = await _started(server)

    await adapter.update_message(str(STREAM_ID), "30", "Deployed v3.")
    await adapter.delete_message(str(STREAM_ID), "30")

    assert _form(server.sent("PATCH", "/api/v1/messages/30")[0]) == {
        "content": "Deployed v3."
    }
    assert len(server.sent("DELETE", "/api/v1/messages/30")) == 1


async def test_people_are_added_by_user_id_and_those_refused_are_named(
    server: Zulip,
) -> None:
    def subscribe(request: httpx.Request) -> httpx.Response:
        if json.loads(_form(request)["principals"]) == [99]:
            return httpx.Response(
                400,
                json={"result": "error", "code": "BAD_REQUEST", "msg": "No such user"},
            )
        return _ok()

    server.on("POST", "/api/v1/users/me/subscriptions", subscribe)
    adapter, _ = await _started(server)

    left_out = await adapter.add_users_to_channel(
        str(STREAM_ID), ["Test Person", "Gone"], ["9", "99"]
    )

    assert left_out == ["99"]


# ── Files ────────────────────────────────────────────────────────────────────


async def test_a_file_is_uploaded_and_posted_as_a_link(server: Zulip) -> None:
    server.on(
        "POST",
        "/api/v1/user_uploads",
        lambda r: _ok(url="/user_uploads/2/ab/report.pdf"),
    )
    server.on("POST", "/api/v1/messages", lambda r: _ok(id=60))
    adapter, _ = await _started(server)

    ref = await adapter.send_attachment(
        str(STREAM_ID),
        "helper",
        "report.pdf",
        "application/pdf",
        b"%PDF",
        caption="Here it is.",
    )

    assert ref == "60"
    assert b"report.pdf" in server.sent("POST", "/api/v1/user_uploads")[0].content
    content = _form(server.sent("POST", "/api/v1/messages")[0])["content"]
    assert (
        content
        == "**helper:** Here it is.\n[report.pdf](/user_uploads/2/ab/report.pdf)"
    )


async def test_a_file_zulip_will_not_take_is_named_with_its_reason(
    server: Zulip,
) -> None:
    server.on(
        "POST",
        "/api/v1/user_uploads",
        lambda r: httpx.Response(
            400,
            json={"result": "error", "code": "BAD_REQUEST", "msg": "File too large"},
        ),
    )
    server.on("POST", "/api/v1/messages", lambda r: _ok(id=61))
    adapter, _ = await _started(server)

    await adapter.send_attachment(
        str(STREAM_ID), "helper", "huge.bin", "application/octet-stream", b"x"
    )

    content = _form(server.sent("POST", "/api/v1/messages")[0])["content"]
    assert "huge.bin" in content and "File too large" in content


async def test_a_linked_upload_is_relayed_with_the_message(server: Zulip) -> None:
    server.on("GET", "/api/v1/messages", _topic_rooted_at(15))
    server.on(
        "GET",
        "/api/v1/user_uploads/2/ab/notes.txt",
        lambda r: _ok(url="/user_uploads/temporary/t1"),
    )
    server.on(
        "GET",
        "/user_uploads/temporary/t1",
        lambda r: httpx.Response(
            200,
            content=b"hello",
            headers={"content-type": 'text/plain; charset="ascii"'},
        ),
    )
    adapter, heard = await _started(server)

    await adapter._relay(
        _message(content="see [notes.txt](/user_uploads/2/ab/notes.txt)"), []
    )

    [file] = heard[0].attachments
    assert (file.filename, file.mimetype, file.data) == (
        "notes.txt",
        "text/plain",
        b"hello",
    )
    assert heard[0].attachment_failures == []


async def test_a_linked_upload_too_large_to_relay_is_reported_not_dropped(
    server: Zulip,
) -> None:
    server.on("GET", "/api/v1/messages", _topic_rooted_at(15))
    server.on(
        "GET",
        "/api/v1/user_uploads/2/ab/big.bin",
        lambda r: _ok(url="/user_uploads/temporary/t2"),
    )
    server.on(
        "GET",
        "/user_uploads/temporary/t2",
        lambda r: httpx.Response(200, content=b"x" * 2048),
    )
    adapter, heard = await _started(server)
    adapter.set_max_attachment_bytes(1024)

    await adapter._relay(_message(content="[big.bin](/user_uploads/2/ab/big.bin)"), [])

    assert heard[0].attachments == []
    [failure] = heard[0].attachment_failures
    assert failure.filename == "big.bin"


# ── Work marks ───────────────────────────────────────────────────────────────


async def test_work_marks_are_reactions_and_a_mark_already_as_asked_is_fine(
    server: Zulip,
) -> None:
    def react(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and _form(request)["emoji_name"] == "hourglass":
            return httpx.Response(
                400,
                json={
                    "result": "error",
                    "code": "REACTION_ALREADY_EXISTS",
                    "msg": "exists",
                },
            )
        return _ok()

    server.on("POST", "/api/v1/messages/15/reactions", react)
    server.on("DELETE", "/api/v1/messages/15/reactions", react)
    adapter, _ = await _started(server)

    await adapter.mark_activity(
        str(STREAM_ID), "15", agent_name="helper", mark="working", on=True
    )
    await adapter.mark_activity(
        str(STREAM_ID), "15", agent_name="helper", mark="queued", on=True
    )
    await adapter.mark_activity(
        str(STREAM_ID), "15", agent_name="helper", mark="working", on=False
    )

    assert [
        _form(r)["emoji_name"]
        for r in server.sent("POST", "/api/v1/messages/15/reactions")
    ] == [
        "eyes",
        "hourglass",
    ]
    assert (
        server.sent("DELETE", "/api/v1/messages/15/reactions")[0].url.params[
            "emoji_name"
        ]
        == "eyes"
    )


async def test_a_mark_zulip_refuses_is_refused_for_good(server: Zulip) -> None:
    server.on(
        "POST",
        "/api/v1/messages/15/reactions",
        lambda r: httpx.Response(
            400,
            json={
                "result": "error",
                "code": "BAD_REQUEST",
                "msg": "Invalid message(s)",
            },
        ),
    )
    adapter, _ = await _started(server)

    with pytest.raises(ActivityMarkRefused, match="Invalid message"):
        await adapter.mark_activity(
            str(STREAM_ID), "15", agent_name="helper", mark="working", on=True
        )
