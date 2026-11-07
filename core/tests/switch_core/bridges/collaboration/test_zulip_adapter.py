"""The Zulip adapter: its config, its markup, and what it sends to and reads
from a Zulip server, mocked at the HTTP transport."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from typing import Any
from urllib.parse import parse_qsl

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    InboundCommand,
    InboundMessage,
)
from switch_core.bridges.collaboration.platforms import PLATFORMS
from switch_core.bridges.collaboration.zulip.adapter import (
    MAX_MESSAGE,
    ZulipAdapter,
    ZulipApiError,
    ZulipConnectionConfig,
    split_message,
    to_zulip_markdown,
)

SITE = "https://example.zulipchat.com"
BOT = 100
ALICE = 7
BOB = 8
STREAM = 42


def _config(**overrides: Any) -> ZulipConnectionConfig:
    values: dict[str, Any] = {
        "site": SITE,
        "email": "switch-bot@example.zulipchat.com",
        "api_key": "test-api-key",
        "default_agent": "claude",
    }
    values.update(overrides)
    return ZulipConnectionConfig.model_validate(values)


def _stream_message(
    content: str = "hi",
    *,
    message_id: int = 500,
    sender: int = ALICE,
    topic: str = "deploy",
    stream: int = STREAM,
) -> dict[str, Any]:
    return {
        "id": message_id,
        "type": "stream",
        "sender_id": sender,
        "sender_full_name": "Alice Smith" if sender == ALICE else "Switch Bot",
        "stream_id": stream,
        "display_recipient": "engineering",
        "subject": topic,
        "content": content,
    }


def _direct_message(
    content: str = "hi", *, message_id: int = 600, people: tuple[int, ...] = (ALICE,)
) -> dict[str, Any]:
    return {
        "id": message_id,
        "type": "private",
        "sender_id": people[0],
        "sender_full_name": "Alice Smith",
        "display_recipient": [{"id": p} for p in (*people, BOT)],
        "content": content,
    }


class Zulip:
    """A Zulip server, as far as the adapter calls it."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.me: dict[str, Any] = {"user_id": BOT, "is_bot": True}
        self.streams = {
            STREAM: {"stream_id": STREAM, "name": "engineering", "invite_only": False}
        }
        self.unread: list[dict[str, Any]] = []
        self.events: list[list[dict[str, Any]]] = []
        self.errors: dict[str, tuple[int, dict[str, Any]]] = {}
        self.next_id = 1000
        self.uploads = {"/user_uploads/temporary/abc": b"file bytes"}

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        key = f"{request.method} {path}"
        if key in self.errors:
            status, body = self.errors[key]
            return httpx.Response(status, json=body)
        if path in self.uploads:
            return httpx.Response(
                200, content=self.uploads[path], headers={"content-type": "text/plain"}
            )
        ok = {"result": "success", "msg": ""}
        if key == "GET /api/v1/users/me":
            return httpx.Response(200, json={**ok, **self.me})
        if key == "POST /api/v1/register":
            return httpx.Response(
                200,
                json={
                    **ok,
                    "queue_id": "q1",
                    "last_event_id": -1,
                    "max_file_upload_size_mib": 1,
                },
            )
        if key == "GET /api/v1/messages":
            return httpx.Response(200, json={**ok, "messages": self.unread})
        if key == "GET /api/v1/events":
            if self.events:
                return httpx.Response(200, json={**ok, "events": self.events.pop(0)})
            return httpx.Response(
                400,
                json={
                    "result": "error",
                    "code": "BAD_EVENT_QUEUE_ID",
                    "msg": "Bad event queue id",
                },
            )
        if key == "POST /api/v1/messages":
            self.next_id += 1
            return httpx.Response(200, json={**ok, "id": self.next_id})
        if (
            path.startswith("/api/v1/messages/")
            and path.count("/") == 4
            and request.method == "GET"
        ):
            return httpx.Response(
                200, json={**ok, "message": {"subject": "from-lookup"}}
            )
        if path.startswith("/api/v1/streams/"):
            stream = self.streams.get(int(path.rsplit("/", 1)[1]))
            if stream is None:
                return httpx.Response(
                    400,
                    json={
                        "result": "error",
                        "code": "BAD_REQUEST",
                        "msg": "Invalid channel ID",
                    },
                )
            return httpx.Response(200, json={**ok, "stream": stream})
        if key == "GET /api/v1/get_stream_id":
            return httpx.Response(200, json={**ok, "stream_id": 77})
        if key == "POST /api/v1/user_uploads":
            return httpx.Response(
                200, json={**ok, "url": "/user_uploads/2/ab/report.txt"}
            )
        if path.startswith("/api/v1/user_uploads/"):
            return httpx.Response(
                200, json={**ok, "url": "/user_uploads/temporary/abc"}
            )
        return httpx.Response(200, json=ok)

    def calls(self, method: str, path: str) -> list[dict[str, str]]:
        """The form or query values of every matching call."""
        out = []
        for r in self.requests:
            if r.method == method and r.url.path == f"/api/v1{path}":
                if method in ("GET", "DELETE"):
                    out.append(dict(r.url.params))
                elif r.headers.get("content-type", "").startswith("multipart"):
                    out.append({"multipart": "yes"})
                else:
                    out.append(
                        dict(parse_qsl(r.content.decode(), keep_blank_values=True))
                    )
        return out


@pytest.fixture
def zulip(monkeypatch: pytest.MonkeyPatch) -> Iterator[Zulip]:
    fake = Zulip()
    monkeypatch.setattr(ZulipAdapter, "_transport", httpx.MockTransport(fake.handler))
    yield fake


class Heard:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []

    async def message(self, m: InboundMessage) -> None:
        self.messages.append(m)

    async def command(self, c: InboundCommand) -> None:
        self.commands.append(c)


async def _ignore(_: Any) -> None:
    return None


async def _started(
    listening: bool = False, **overrides: Any
) -> tuple[ZulipAdapter, Heard]:
    adapter = ZulipAdapter(config=_config(**overrides))
    adapter.set_listening(listening)
    heard = Heard()
    await adapter.start(heard.message, heard.command, _ignore, _ignore, _ignore)
    return adapter, heard


# ── Registration and config ──────────────────────────────────────────────────


def test_zulip_is_registered() -> None:
    keys = {p.key: p for p in PLATFORMS}
    assert keys["zulip"].adapter is ZulipAdapter
    assert keys["zulip"].config is ZulipConnectionConfig
    assert ZulipAdapter.display_name == "Zulip"
    assert ZulipAdapter.keeps_quiet_unless_listening is True
    assert ZulipAdapter.supports_directory_search is False
    assert ZulipAdapter.supports_activity_reactions is True


def test_config_normalises_its_fields() -> None:
    config = _config(
        site=" https://example.zulipchat.com/ ",
        default_agent="@claude",
        default_topic=" ops ",
    )
    assert config.site == SITE
    assert config.default_agent == "claude"
    assert config.default_topic == "ops"
    assert _config(default_agent=" ").default_agent is None
    assert "api_key" in ZulipConnectionConfig.model_json_schema()["properties"]


@pytest.mark.parametrize(
    ("field", "value", "says"),
    [
        ("site", "example.zulipchat.com", "https://"),
        ("site", "https://example.zulipchat.com/api/v1", "without a path"),
        ("email", "switch-bot", "bot's email"),
        ("api_key", "  ", "API key"),
        ("default_topic", " ", "topic"),
    ],
)
def test_config_refuses_what_it_cannot_use(field: str, value: str, says: str) -> None:
    with pytest.raises(ValidationError, match=says):
        _config(**{field: value})


def test_outbound_urls_name_the_site() -> None:
    assert ZulipAdapter.outbound_urls({"site": SITE}) == [SITE]
    assert ZulipAdapter.outbound_urls({}) == []


# ── Credentials ──────────────────────────────────────────────────────────────


async def test_verify_credentials_accepts_a_bot(zulip: Zulip) -> None:
    await ZulipAdapter.verify_credentials(_config().model_dump())
    assert zulip.requests[0].headers["authorization"].startswith("Basic ")


async def test_verify_credentials_refuses_a_bad_key(zulip: Zulip) -> None:
    zulip.errors["GET /api/v1/users/me"] = (
        401,
        {"result": "error", "msg": "Invalid API key"},
    )
    with pytest.raises(
        BridgeCredentialError, match="refused the bot's email and API key"
    ):
        await ZulipAdapter.verify_credentials(_config().model_dump())


async def test_verify_credentials_refuses_a_persons_key(zulip: Zulip) -> None:
    zulip.me["is_bot"] = False
    with pytest.raises(BridgeCredentialError, match="not a bot's"):
        await ZulipAdapter.verify_credentials(_config().model_dump())


async def test_verify_credentials_explains_no_server(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    monkeypatch.setattr(ZulipAdapter, "_transport", httpx.MockTransport(refuse))
    with pytest.raises(BridgeCredentialError, match="No Zulip server answers"):
        await ZulipAdapter.verify_credentials(_config().model_dump())


def test_classify_failure() -> None:
    request = httpx.Request("GET", SITE)
    assert (
        ZulipAdapter.classify_failure(httpx.ConnectError("x", request=request))
        == "network"
    )
    assert (
        ZulipAdapter.classify_failure(ZulipApiError(400, "BAD_REQUEST", "x"))
        == "platform_error"
    )
    assert ZulipAdapter.classify_failure(ValueError("x")) is None


# ── Markup ───────────────────────────────────────────────────────────────────


def test_markdown_becomes_zulips_dialect() -> None:
    assert (
        to_zulip_markdown("## Plan\n__done__ and _soon_")
        == "**Plan**\n**done** and *soon*"
    )
    assert (
        to_zulip_markdown("`snake_case_name` and ```\n__x__\n```")
        == "`snake_case_name` and ```\n__x__\n```"
    )


async def test_outbound_defuses_zulips_wildcard_mentions(zulip: Zulip) -> None:
    adapter, _ = await _started()
    text = adapter.translate_outbound("ping @**all** and @_**topic** and @everyone")
    assert "@**all**" not in text
    assert "@_**topic**" not in text
    assert "@everyone" not in text


def test_inbound_mentions_become_switch_handles() -> None:
    adapter = ZulipAdapter(config=_config())
    assert (
        adapter.translate_inbound("@**Alice Smith** ask @_**claude|12**")
        == "@AliceSmith ask @claude"
    )


def test_split_message_never_breaks_a_code_block() -> None:
    long_code = "```\n" + "x = 1\n" * 3000 + "```"
    pieces = split_message(long_code)
    assert all(len(p) <= MAX_MESSAGE + 4 for p in pieces)
    assert all(p.count("```") % 2 == 0 for p in pieces)
    assert split_message("short") == ["short"]


# ── Inbound ──────────────────────────────────────────────────────────────────


async def test_a_channel_message_lands_in_its_topics_thread(zulip: Zulip) -> None:
    adapter, heard = await _started()
    await adapter.handle_message(_stream_message("hello @**claude**"))
    [message] = heard.messages
    assert message.channel_id == f"stream:{STREAM}"
    assert message.channel_type == "channel_public"
    assert message.root_id == "topic:deploy"
    assert message.message_ref == "500"
    assert message.sender_id == str(ALICE)
    assert message.sender_name == "AliceSmith"
    assert message.content == "hello @claude"
    assert zulip.calls("POST", "/messages/flags") == [
        {"messages": "[500]", "op": "add", "flag": "read"}
    ]


async def test_a_private_channel_is_private(zulip: Zulip) -> None:
    zulip.streams[STREAM]["invite_only"] = True
    adapter, heard = await _started()
    await adapter.handle_message(_stream_message())
    assert heard.messages[0].channel_type == "channel_private"


async def test_direct_messages_are_rooms_without_threads(zulip: Zulip) -> None:
    adapter, heard = await _started()
    await adapter.handle_message(_direct_message("one"))
    await adapter.handle_message(
        _direct_message("two", message_id=601, people=(BOB, ALICE))
    )
    one, two = heard.messages
    assert (one.channel_id, one.channel_type, one.root_id) == (
        f"dm:{ALICE}",
        "direct",
        None,
    )
    assert (two.channel_id, two.channel_type) == (f"dm:{ALICE},{BOB}", "group")


async def test_the_bots_own_messages_are_ignored(zulip: Zulip) -> None:
    adapter, heard = await _started()
    await adapter.handle_message(_stream_message("**claude:** done", sender=BOT))
    assert heard.messages == []
    assert zulip.calls("POST", "/messages/flags") == []


async def test_bang_commands_become_commands(zulip: Zulip) -> None:
    adapter, heard = await _started()
    await adapter.handle_message(_stream_message("!invite-agent  claude "))
    [command] = heard.commands
    assert (command.command, command.args, command.root_id) == (
        "invite-agent",
        "claude",
        "topic:deploy",
    )
    assert heard.messages == []


async def test_a_failed_delivery_stays_unread(zulip: Zulip) -> None:
    adapter = ZulipAdapter(config=_config())
    adapter.set_listening(False)

    async def broken(_: InboundMessage) -> None:
        raise RuntimeError("database down")

    await adapter.start(broken, _ignore, _ignore, _ignore, _ignore)
    with pytest.raises(RuntimeError):
        await adapter.handle_message(_stream_message())
    assert zulip.calls("POST", "/messages/flags") == []


async def test_uploaded_files_are_downloaded(zulip: Zulip) -> None:
    adapter, heard = await _started()
    await adapter.handle_message(
        _stream_message("see [notes.txt](/user_uploads/2/ab/notes.txt)")
    )
    [attachment] = heard.messages[0].attachments
    assert (attachment.filename, attachment.mimetype, attachment.data) == (
        "notes.txt",
        "text/plain",
        b"file bytes",
    )


async def test_oversized_or_unfetchable_files_are_reported(zulip: Zulip) -> None:
    adapter, heard = await _started()
    adapter.set_max_attachment_bytes(4)
    await adapter.handle_message(
        _stream_message("[big.txt](/user_uploads/2/ab/big.txt)")
    )
    zulip.errors["GET /api/v1/user_uploads/2/cd/gone.pdf"] = (
        400,
        {"result": "error", "code": "BAD_REQUEST", "msg": "Invalid file"},
    )
    await adapter.handle_message(
        _stream_message("[gone.pdf](/user_uploads/2/cd/gone.pdf)", message_id=501)
    )
    failures = [f for m in heard.messages for f in m.attachment_failures]
    assert [f.filename for f in failures] == ["big.txt", "gone.pdf"]
    assert "larger" in failures[0].reason
    assert "Invalid file" in failures[1].reason


# ── The event queue ──────────────────────────────────────────────────────────


async def test_catches_up_on_unread_then_reads_events(zulip: Zulip) -> None:
    zulip.unread = [
        _stream_message("missed b", message_id=2),
        _stream_message("missed a", message_id=1),
    ]
    zulip.events = [
        [
            {"id": 0, "type": "heartbeat"},
            {
                "id": 1,
                "type": "message",
                "message": _stream_message("live", message_id=3),
            },
        ]
    ]
    adapter = ZulipAdapter(config=_config())
    messages = [m["content"] async for m in adapter._messages()]
    assert messages == ["missed a", "missed b", "live"]
    [register] = zulip.calls("POST", "/register")
    assert json.loads(register["event_types"]) == ["message"]
    assert register["apply_markdown"] == "false"
    assert json.loads(zulip.calls("GET", "/messages")[0]["narrow"]) == [
        {"operator": "is", "operand": "unread"}
    ]
    polls = zulip.calls("GET", "/events")
    assert [p["last_event_id"] for p in polls] == ["-1", "1"]
    assert adapter._max_upload_bytes == 1024 * 1024


async def test_a_listening_adapter_delivers_from_the_queue(zulip: Zulip) -> None:
    zulip.events = [
        [{"id": 0, "type": "message", "message": _stream_message("streamed")}]
    ]
    adapter, heard = await _started(listening=True)
    for _ in range(100):
        if heard.messages:
            break
        await asyncio.sleep(0.01)
    await adapter.stop()
    assert heard.messages[0].content == "streamed"


async def test_a_quiet_adapter_opens_no_queue(zulip: Zulip) -> None:
    adapter, _ = await _started(listening=False)
    await asyncio.sleep(0.02)
    await adapter.stop()
    assert zulip.calls("POST", "/register") == []


# ── Outbound ─────────────────────────────────────────────────────────────────


async def test_a_reply_goes_back_into_its_topic(zulip: Zulip) -> None:
    adapter, _ = await _started()
    ref = await adapter.send_message(
        f"stream:{STREAM}", "claude", "Done: **3** files", "topic:deploy"
    )
    assert zulip.calls("POST", "/messages") == [
        {
            "type": "stream",
            "to": str(STREAM),
            "topic": "deploy",
            "content": "**claude:** Done: **3** files",
        }
    ]
    assert ref == str(zulip.next_id)


async def test_a_new_post_goes_to_the_default_topic(zulip: Zulip) -> None:
    adapter, _ = await _started(default_topic="ops")
    await adapter.send_message(f"stream:{STREAM}", "claude", "hello")
    assert zulip.calls("POST", "/messages")[0]["topic"] == "ops"


async def test_a_thread_rooted_at_a_message_uses_that_messages_topic(
    zulip: Zulip,
) -> None:
    adapter, _ = await _started()
    await adapter.handle_message(_stream_message(message_id=500, topic="known"))
    await adapter.send_message(f"stream:{STREAM}", "claude", "a", "500")
    await adapter.send_message(f"stream:{STREAM}", "claude", "b", "900")
    assert [c["topic"] for c in zulip.calls("POST", "/messages")] == [
        "known",
        "from-lookup",
    ]


async def test_direct_replies_go_to_the_same_people(zulip: Zulip) -> None:
    adapter, _ = await _started()
    await adapter.send_message(f"dm:{ALICE},{BOB}", "claude", "hi")
    [sent] = zulip.calls("POST", "/messages")
    assert sent["type"] == "direct"
    assert json.loads(sent["to"]) == [ALICE, BOB]


async def test_a_long_reply_goes_as_several_messages(zulip: Zulip) -> None:
    adapter, _ = await _started()
    first = zulip.next_id + 1
    ref = await adapter.send_message(
        f"stream:{STREAM}", "claude", "word " * 4500, "topic:deploy"
    )
    sent = zulip.calls("POST", "/messages")
    assert len(sent) == 3
    assert all(len(s["content"]) <= MAX_MESSAGE for s in sent)
    assert {s["topic"] for s in sent} == {"deploy"}
    assert ref == str(first)


async def test_edit_and_delete(zulip: Zulip) -> None:
    adapter, _ = await _started()
    await adapter.update_message(f"stream:{STREAM}", "1001", "fixed")
    await adapter.delete_message(f"stream:{STREAM}", "1001")
    assert zulip.calls("PATCH", "/messages/1001") == [{"content": "fixed"}]
    assert len(zulip.calls("DELETE", "/messages/1001")) == 1


async def test_working_reaction_is_idempotent(zulip: Zulip) -> None:
    adapter, _ = await _started()
    await adapter.mark_activity(
        f"stream:{STREAM}", "500", agent_name="claude", mark="working", on=True
    )
    zulip.errors["POST /api/v1/messages/500/reactions"] = (
        400,
        {
            "result": "error",
            "code": "REACTION_ALREADY_EXISTS",
            "msg": "Reaction already exists.",
        },
    )
    await adapter.mark_activity(
        f"stream:{STREAM}", "500", agent_name="claude", mark="working", on=True
    )
    await adapter.mark_activity(
        f"stream:{STREAM}", "500", agent_name="claude", mark="working", on=False
    )
    assert zulip.calls("DELETE", "/messages/500/reactions") == [{"emoji_name": "eyes"}]
    zulip.errors["DELETE /api/v1/messages/500/reactions"] = (
        400,
        {"result": "error", "code": "BAD_REQUEST", "msg": "Invalid message"},
    )
    with pytest.raises(BridgeOperationError, match="Invalid message"):
        await adapter.mark_activity(
            f"stream:{STREAM}", "500", agent_name="claude", mark="working", on=False
        )


async def test_typing_in_a_topic_and_a_direct_message(zulip: Zulip) -> None:
    adapter, _ = await _started()
    await adapter.notify_working(f"stream:{STREAM}", "claude", "topic:deploy")
    await adapter.send_typing(f"dm:{ALICE}", "claude", False)
    await adapter.send_typing(
        f"stream:{STREAM}", "claude", True
    )  # no topic: nothing to do
    assert zulip.calls("POST", "/typing") == [
        {"type": "stream", "stream_id": str(STREAM), "topic": "deploy", "op": "start"},
        {"type": "direct", "to": f"[{ALICE}]", "op": "stop"},
    ]


async def test_send_attachment_uploads_and_links(zulip: Zulip) -> None:
    adapter, _ = await _started()
    await adapter.send_attachment(
        f"stream:{STREAM}",
        "claude",
        "report.txt",
        "text/plain",
        b"abc",
        caption="here",
        thread_root_id="topic:deploy",
    )
    assert zulip.calls("POST", "/user_uploads") == [{"multipart": "yes"}]
    [sent] = zulip.calls("POST", "/messages")
    assert (
        sent["content"]
        == "**claude:** here\n[report.txt](/user_uploads/2/ab/report.txt)"
    )


async def test_an_oversized_attachment_is_refused_visibly(zulip: Zulip) -> None:
    adapter, _ = await _started()
    adapter._max_upload_bytes = 2
    await adapter.send_attachment(
        f"stream:{STREAM}", "claude", "big.bin", "application/octet-stream", b"abc"
    )
    assert zulip.calls("POST", "/user_uploads") == []
    assert "too large" in zulip.calls("POST", "/messages")[0]["content"]


async def test_a_refused_send_is_an_operation_error(zulip: Zulip) -> None:
    adapter, _ = await _started()
    zulip.errors["POST /api/v1/messages"] = (
        400,
        {
            "result": "error",
            "code": "STREAM_DOES_NOT_EXIST",
            "msg": "Channel does not exist",
        },
    )
    with pytest.raises(BridgeOperationError, match="Channel does not exist"):
        await adapter.send_message(f"stream:{STREAM}", "claude", "hi")


# ── Channels ─────────────────────────────────────────────────────────────────


async def test_create_channel_and_add_people(zulip: Zulip) -> None:
    adapter, _ = await _started()
    channel = await adapter.create_channel(
        "incident-12", "Checkout outage", channel_type="channel_private"
    )
    assert channel == "stream:77"
    [created] = zulip.calls("POST", "/users/me/subscriptions")
    assert json.loads(created["subscriptions"]) == [
        {"name": "incident-12", "description": "Checkout outage"}
    ]
    assert created["invite_only"] == "true"

    not_added = await adapter.add_users_to_channel(
        f"stream:{STREAM}", ["alice", "x"], [str(ALICE), "nope"]
    )
    assert not_added == ["nope"]
    added = zulip.calls("POST", "/users/me/subscriptions")[1]
    assert json.loads(added["principals"]) == [ALICE]
    assert json.loads(added["subscriptions"]) == [{"name": "engineering"}]


async def test_direct_conversations_start_on_zulip(zulip: Zulip) -> None:
    adapter, _ = await _started()
    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("x", "y", channel_type="direct")
    assert await adapter.add_users_to_channel(f"dm:{ALICE}", ["bob"], [str(BOB)]) == [
        str(BOB)
    ]


async def test_agents_and_links(zulip: Zulip) -> None:
    adapter, _ = await _started()
    assert await adapter.get_channel_agent_names(f"stream:{STREAM}") == ["claude"]
    assert (
        await adapter.channel_deeplink(f"stream:{STREAM}")
        == f"{SITE}/#narrow/channel/{STREAM}"
    )
    assert await adapter.channel_deeplink(f"dm:{ALICE}") is None
    assert await adapter.home_deeplink() == SITE
    assert await adapter.get_channel_type("stream:999") == "channel_private"
