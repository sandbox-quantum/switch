"""Matrix: the homeserver is mocked at the HTTP transport, as the guide asks."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from switch_core.bridges.collaboration.matrix import adapter as adapter_module
from switch_core.bridges.collaboration.matrix.adapter import (
    MatrixAdapter,
    MatrixConnectionConfig,
    handle_of,
    strip_reply_fallback,
)
from switch_core.bridges.collaboration.matrix.client import MatrixAPIError
from switch_core.bridges.collaboration.matrix.markup import (
    chunk_message,
    text_content,
    to_html,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
)
from switch_core.outbound import OutboundPolicy

BOT = "@bot:hs.test"
TOKEN = "syt_placeholder_token_value"  # gitleaks:allow
ROOM = "!room:hs.test"
CONFIG = {
    "homeserver_url": "https://hs.test/",
    "user_id": BOT,
    "access_token": TOKEN,
}

Handler = Callable[[httpx.Request], httpx.Response]


def _json(data: Any, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=data)


def _error(status: int, errcode: str, message: str = "no") -> httpx.Response:
    return _json({"errcode": errcode, "error": message}, status)


class Homeserver:
    """Records every request and answers from `routes`: `(method, regex)` to a
    response or a function of the request. Anything unrouted is a failure."""

    def __init__(self, routes: dict[tuple[str, str], Any] | None = None) -> None:
        self.routes: dict[tuple[str, str], Any] = {
            ("GET", r"/_matrix/client/v3/account/whoami"): {"user_id": BOT},
            ("PUT", r"/_matrix/client/v3/rooms/.*/send/m\.room\.message/.*"): {
                "event_id": "$sent"
            },
        }
        self.routes.update(routes or {})
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        for (method, pattern), answer in self.routes.items():
            if request.method == method and re.fullmatch(pattern, request.url.path):
                if callable(answer):
                    return answer(request)  # type: ignore[no-any-return]
                if isinstance(answer, httpx.Response):
                    return answer
                return _json(answer)
        return _error(
            404, "M_NOT_FOUND", f"unrouted {request.method} {request.url.path}"
        )

    def sent(self, event_type: str = "m.room.message") -> list[dict[str, Any]]:
        return [
            json.loads(r.content)
            for r in self.requests
            if r.method == "PUT" and f"/send/{event_type}/" in r.url.path
        ]

    def paths(self, method: str) -> list[str]:
        return [r.url.path for r in self.requests if r.method == method]


class Inbound:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []
        self.users: list[InboundUserJoin] = []
        self.apps: list[InboundAppJoin] = []

    async def message(self, m: InboundMessage) -> None:
        self.messages.append(m)

    async def command(self, c: InboundCommand) -> None:
        self.commands.append(c)

    async def user(self, u: InboundUserJoin) -> None:
        self.users.append(u)

    async def app(self, a: InboundAppJoin) -> None:
        self.apps.append(a)

    async def agent(self, _: Any) -> None:
        return None


async def connect(
    monkeypatch: pytest.MonkeyPatch,
    server: Homeserver,
    *,
    listening: bool = False,
    max_attachment_bytes: int | None = None,
) -> tuple[MatrixAdapter, Inbound]:
    monkeypatch.setattr(
        adapter_module,
        "_new_http",
        lambda policy: httpx.AsyncClient(transport=httpx.MockTransport(server)),
    )
    adapter = MatrixAdapter(config=MatrixConnectionConfig.model_validate(CONFIG))
    adapter.set_outbound_policy(OutboundPolicy.parse(""))
    adapter.set_listening(listening)
    if max_attachment_bytes is not None:
        adapter.set_max_attachment_bytes(max_attachment_bytes)
    inbound = Inbound()
    await adapter.start(
        inbound.message, inbound.command, inbound.agent, inbound.user, inbound.app
    )
    if listening:
        # The loop is exercised on its own; tests here drive `_process_sync`.
        assert adapter._sync_task is not None
        adapter._sync_task.cancel()
        adapter._sync_task = None
    return adapter, inbound


def room_routes(
    *, name: str = "general", rule: str = "invite", members: int = 3
) -> dict[tuple[str, str], Any]:
    base = r"/_matrix/client/v3/rooms/.*"
    return {
        ("GET", base + r"/state/m\.room\.name"): {"name": name},
        ("GET", base + r"/state/m\.room\.join_rules"): {"join_rule": rule},
        ("GET", base + r"/joined_members"): {
            "joined": {f"@u{i}:hs.test": {} for i in range(members)}
        },
    }


def text(
    event_id: str, body: str, sender: str = "@alice:hs.test", **extra: Any
) -> dict:
    content = {"msgtype": "m.text", "body": body, **extra}
    return {
        "type": "m.room.message",
        "event_id": event_id,
        "sender": sender,
        "content": content,
    }


def sync(
    events: list[dict], *, limited: bool = False, state: list | None = None
) -> dict:
    return {
        "next_batch": "s2",
        "rooms": {
            "join": {
                ROOM: {
                    "timeline": {
                        "events": events,
                        "limited": limited,
                        "prev_batch": "p1",
                    },
                    "state": {"events": state or []},
                }
            }
        },
    }


# ── Config ───────────────────────────────────────────────────────────────────


class TestConfig:
    def test_a_valid_config_parses_and_drops_the_trailing_slash(self) -> None:
        config = MatrixConnectionConfig.model_validate(CONFIG)
        assert config.homeserver_url == "https://hs.test"

    @pytest.mark.parametrize(
        "change",
        [
            {"homeserver_url": "ftp://hs.test"},
            {"homeserver_url": "https://user:pw@hs.test"},
            {"homeserver_url": "https://hs.test/?x=1"},
            {"homeserver_url": "not a url"},
            {"user_id": "bot"},
            {"user_id": "@bot"},
            {"access_token": "  "},
        ],
    )
    def test_an_unusable_config_is_refused_without_echoing_the_token(
        self, change: dict[str, str]
    ) -> None:
        with pytest.raises(ValueError) as raised:
            MatrixConnectionConfig.model_validate({**CONFIG, **change})
        assert TOKEN not in str(raised.value)

    def test_the_form_names_each_field_and_masks_the_token_by_its_name(self) -> None:
        properties = MatrixConnectionConfig.model_json_schema()["properties"]
        assert properties["homeserver_url"]["title"] == "Homeserver URL"
        assert properties["user_id"]["title"] == "Bot user ID"
        # Console masks any field whose name contains "token".
        assert "token" in "access_token" and "access_token" in properties

    def test_the_claim_and_outbound_url_come_from_the_config(self) -> None:
        assert MatrixAdapter.outbound_urls(CONFIG) == ["https://hs.test"]
        assert MatrixAdapter.claimed_workspace(CONFIG) == f"Matrix account {BOT}"


# ── Credentials and failures ────────────────────────────────────────────────


class TestCredentials:
    async def test_a_working_token_passes(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver()
        monkeypatch.setattr(
            adapter_module,
            "_new_http",
            lambda policy: httpx.AsyncClient(transport=httpx.MockTransport(server)),
        )
        await MatrixAdapter.verify_credentials(dict(CONFIG))
        assert server.requests[0].headers["authorization"] == f"Bearer {TOKEN}"
        assert TOKEN not in str(server.requests[0].url)

    async def test_a_refused_token_is_a_credential_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(
            {
                ("GET", r"/_matrix/client/v3/account/whoami"): _error(
                    401, "M_UNKNOWN_TOKEN"
                )
            }
        )
        monkeypatch.setattr(
            adapter_module,
            "_new_http",
            lambda policy: httpx.AsyncClient(transport=httpx.MockTransport(server)),
        )
        with pytest.raises(BridgeCredentialError) as raised:
            await MatrixAdapter.verify_credentials(dict(CONFIG))
        assert "rejected the access token" in str(raised.value)
        assert TOKEN not in str(raised.value)

    async def test_a_token_for_another_account_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(
            {("GET", r"/_matrix/client/v3/account/whoami"): {"user_id": "@x:hs.test"}}
        )
        monkeypatch.setattr(
            adapter_module,
            "_new_http",
            lambda policy: httpx.AsyncClient(transport=httpx.MockTransport(server)),
        )
        with pytest.raises(BridgeCredentialError, match="belongs to @x:hs.test"):
            await MatrixAdapter.verify_credentials(dict(CONFIG))

    async def test_an_unreachable_homeserver_is_said_to_be_unreachable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def refuse(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("down", request=request)

        monkeypatch.setattr(
            adapter_module,
            "_new_http",
            lambda policy: httpx.AsyncClient(transport=httpx.MockTransport(refuse)),
        )
        with pytest.raises(BridgeCredentialError, match="Could not reach"):
            await MatrixAdapter.verify_credentials(dict(CONFIG))

    def test_failures_are_classified_by_their_errcode_and_type(self) -> None:
        assert (
            MatrixAdapter.classify_failure(MatrixAPIError(401, "M_UNKNOWN_TOKEN", ""))
            == "auth_failed"
        )
        assert (
            MatrixAdapter.classify_failure(MatrixAPIError(403, "M_FORBIDDEN", ""))
            == "platform_error"
        )
        assert MatrixAdapter.classify_failure(httpx.ConnectError("x")) == "network"
        assert MatrixAdapter.classify_failure(ValueError("x")) is None

    async def test_the_token_never_reaches_the_log(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.DEBUG)
        server = Homeserver(
            {
                ("PUT", r".*/send/m\.room\.message/.*"): _error(
                    403, "M_FORBIDDEN", "muted"
                )
            }
        )
        adapter, _ = await connect(monkeypatch, server)
        await adapter.update_message(ROOM, "$e", "x")
        assert TOKEN not in caplog.text


# ── Formatting ───────────────────────────────────────────────────────────────


class TestMarkup:
    def test_markdown_renders_and_raw_html_does_not(self) -> None:
        html = to_html("**bold** <script>alert(1)</script>")
        assert "<strong>bold</strong>" in html
        assert "<script>" not in html

    def test_only_web_links_survive_and_images_are_dropped(self) -> None:
        html = to_html(
            "[ok](https://x.test) [bad](javascript:alert(1)) ![i](https://x.test/p.png)"
        )
        assert 'href="https://x.test"' in html
        assert "javascript" not in html
        assert "<img" not in html

    def test_a_label_heads_the_message_and_cannot_forge_markup(self) -> None:
        content = text_content("hello", "<b>x</b>")
        assert content["body"] == "<b>x</b>: hello"
        assert (
            "<strong>&lt;b&gt;x&lt;/b&gt;</strong>: hello" in content["formatted_body"]
        )

    def test_a_long_reply_is_cut_between_lines_and_keeps_code_fences_closed(
        self,
    ) -> None:
        source = (
            "intro\n```python\n"
            + "\n".join(f"line {i}" for i in range(400))
            + "\n```\nend"
        )
        pieces = chunk_message(source, 600)
        assert len(pieces) > 1
        assert all(len(p.encode()) <= 600 for p in pieces)
        for piece in pieces:
            assert piece.count("```") % 2 == 0
        assert "end" in pieces[-1]

    def test_a_short_reply_is_one_message(self) -> None:
        assert chunk_message("short") == ["short"]


# ── Inbound ──────────────────────────────────────────────────────────────────


class TestInbound:
    async def test_a_thread_reply_keeps_its_thread_and_a_plain_reply_its_target(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(room_routes())
        adapter, inbound = await connect(monkeypatch, server)
        events = [
            text(
                "$t",
                "in thread",
                **{"m.relates_to": {"rel_type": "m.thread", "event_id": "$root"}},
            ),
            text(
                "$r",
                "plain reply",
                **{"m.relates_to": {"m.in_reply_to": {"event_id": "$orig"}}},
            ),
            text("$n", "top level"),
        ]
        await adapter._process_sync(sync(events), initial=False)
        assert [(m.message_ref, m.root_id) for m in inbound.messages] == [
            ("$t", "$root"),
            ("$r", "$orig"),
            ("$n", None),
        ]
        assert inbound.messages[0].channel_type == "channel_private"
        assert inbound.messages[0].channel_name == "general"
        assert inbound.messages[0].sender_name == "alice"

    async def test_the_bots_own_messages_edits_and_repeats_are_not_relayed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(room_routes())
        adapter, inbound = await connect(monkeypatch, server)
        events = [
            text("$own", "echo", sender=BOT),
            text(
                "$edit",
                "* fixed",
                **{"m.relates_to": {"rel_type": "m.replace", "event_id": "$x"}},
            ),
            text("$a", "hello"),
            text("$a", "hello"),
        ]
        await adapter._process_sync(sync(events), initial=False)
        assert [m.message_ref for m in inbound.messages] == ["$a"]

    async def test_a_bang_command_is_a_command_with_its_thread(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(room_routes())
        adapter, inbound = await connect(monkeypatch, server)
        events = [
            text(
                "$c",
                "!invite-agent @scout",
                **{"m.relates_to": {"rel_type": "m.thread", "event_id": "$root"}},
            )
        ]
        await adapter._process_sync(sync(events), initial=False)
        assert inbound.messages == []
        command = inbound.commands[0]
        assert (command.command, command.args, command.root_id) == (
            "invite-agent",
            "@scout",
            "$root",
        )

    async def test_tagging_the_bot_and_a_notice_are_marked(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(room_routes())
        adapter, inbound = await connect(monkeypatch, server)
        events = [
            text("$m", "hi bot", **{"m.mentions": {"user_ids": [BOT]}}),
            {
                **text("$n", "bridge says"),
                "content": {"msgtype": "m.notice", "body": "bridge says"},
            },
        ]
        await adapter._process_sync(sync(events), initial=False)
        assert inbound.messages[0].self_mention_token == "bot"
        assert inbound.messages[1].sender_is_app is True

    def test_a_reply_fallback_is_not_part_of_the_text(self) -> None:
        raw = "> <@bob:hs.test> earlier\n> more\n\nthe answer"
        assert strip_reply_fallback(raw) == "the answer"
        assert (
            strip_reply_fallback("> a quote, not a reply") == "> a quote, not a reply"
        )

    def test_people_on_other_servers_keep_their_server_in_their_name(self) -> None:
        assert handle_of("@alice:hs.test", "hs.test") == "alice"
        assert handle_of("@alice:other.org", "hs.test") == "alice_other.org"

    async def test_a_file_is_downloaded_and_an_oversize_one_is_reported(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(
            {
                **room_routes(),
                (
                    "GET",
                    r"/_matrix/client/v1/media/download/hs\.test/ok",
                ): httpx.Response(200, content=b"data"),
            }
        )
        adapter, inbound = await connect(monkeypatch, server, max_attachment_bytes=10)

        def media(event_id: str, media_id: str, size: int) -> dict:
            return {
                "type": "m.room.message",
                "event_id": event_id,
                "sender": "@alice:hs.test",
                "content": {
                    "msgtype": "m.file",
                    "body": f"{media_id}.txt",
                    "url": f"mxc://hs.test/{media_id}",
                    "info": {"size": size, "mimetype": "text/plain"},
                },
            }

        await adapter._process_sync(
            sync([media("$ok", "ok", 4), media("$big", "big", 5000)]), initial=False
        )
        assert inbound.messages[0].attachments[0].data == b"data"
        assert (
            "exceeds the 10 byte limit"
            in inbound.messages[1].attachment_failures[0].reason
        )

    async def test_a_download_that_outgrows_its_stated_size_is_stopped(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(
            {
                **room_routes(),
                (
                    "GET",
                    r"/_matrix/client/v1/media/download/hs\.test/liar",
                ): httpx.Response(200, content=b"x" * 100),
            }
        )
        adapter, inbound = await connect(monkeypatch, server, max_attachment_bytes=10)
        event = {
            "type": "m.room.message",
            "event_id": "$l",
            "sender": "@alice:hs.test",
            "content": {
                "msgtype": "m.file",
                "body": "l.bin",
                "url": "mxc://hs.test/liar",
                "info": {"size": 1},
            },
        }
        await adapter._process_sync(sync([event]), initial=False)
        assert inbound.messages[0].attachments == []
        assert inbound.messages[0].attachment_failures[0].filename == "l.bin"

    async def test_someone_joining_is_a_user_join(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(room_routes())
        adapter, inbound = await connect(monkeypatch, server)
        member = {
            "type": "m.room.member",
            "event_id": "$j",
            "sender": "@carol:hs.test",
            "state_key": "@carol:hs.test",
            "content": {"membership": "join"},
        }
        await adapter._process_sync(sync([member]), initial=False)
        assert inbound.users[0].external_user_id == "@carol:hs.test"
        assert inbound.users[0].external_username == "carol"


# ── Invites and encryption ───────────────────────────────────────────────────


class TestInvitesAndEncryption:
    def invite(self, *, encrypted: bool = False, direct: bool = False) -> dict:
        events: list[dict[str, Any]] = [
            {"type": "m.room.name", "content": {"name": "team"}},
            {
                "type": "m.room.member",
                "state_key": BOT,
                "content": {"membership": "invite", "is_direct": direct},
            },
        ]
        if encrypted:
            events.append(
                {
                    "type": "m.room.encryption",
                    "content": {"algorithm": "m.megolm.v1.aes-sha2"},
                }
            )
        return {
            "next_batch": "s2",
            "rooms": {"invite": {ROOM: {"invite_state": {"events": events}}}},
        }

    def routes(self) -> dict[tuple[str, str], Any]:
        return {
            **room_routes(name="team", members=3),
            ("POST", r"/_matrix/client/v3/join/.*"): {"room_id": ROOM},
            ("POST", r"/_matrix/client/v3/rooms/.*/leave"): {},
            ("POST", r"/_matrix/client/v3/rooms/.*/forget"): {},
        }

    async def test_an_invite_is_joined_and_becomes_an_app_join(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(self.routes())
        adapter, inbound = await connect(monkeypatch, server)
        await adapter._process_sync(self.invite(), initial=False)
        assert server.paths("POST")[0].startswith("/_matrix/client/v3/join/")
        assert (inbound.apps[0].channel_id, inbound.apps[0].channel_name) == (
            ROOM,
            "team",
        )

    async def test_a_direct_invite_is_a_direct_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(self.routes())
        adapter, inbound = await connect(monkeypatch, server)
        await adapter._process_sync(self.invite(direct=True), initial=False)
        assert inbound.apps[0].channel_type == "direct"

    async def test_an_encrypted_invite_gets_a_plain_notice_and_is_left(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(self.routes())
        adapter, inbound = await connect(monkeypatch, server)
        await adapter._process_sync(self.invite(encrypted=True), initial=False)
        notice = server.sent()[0]
        assert notice["msgtype"] == "m.notice"
        assert "end-to-end encrypted" in notice["body"]
        assert any(p.endswith("/leave") for p in server.paths("POST"))
        assert inbound.apps == []

    async def test_encryption_turned_on_in_a_bridged_room_stops_the_bridging(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver({**self.routes()})
        adapter, inbound = await connect(monkeypatch, server)
        turned_on = {
            "type": "m.room.encryption",
            "event_id": "$e",
            "sender": "@alice:hs.test",
            "state_key": "",
            "content": {"algorithm": "m.megolm.v1.aes-sha2"},
        }
        await adapter._process_sync(
            sync([turned_on, text("$m", "secret")]), initial=False
        )
        assert inbound.messages == []
        assert "end-to-end encrypted" in server.sent()[0]["body"]
        assert any(p.endswith("/leave") for p in server.paths("POST"))

    async def test_an_encrypted_room_found_at_start_is_refused_too(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(self.routes())
        adapter, inbound = await connect(monkeypatch, server)
        state = [{"type": "m.room.encryption", "state_key": "", "content": {}}]
        await adapter._process_sync(sync([], state=state), initial=True)
        assert any(p.endswith("/leave") for p in server.paths("POST"))


# ── Restart and several pods ─────────────────────────────────────────────────


class TestCatchUp:
    def marker(self, event_id: str | None) -> dict[tuple[str, str], Any]:
        route = r"/_matrix/client/v3/user/.*/rooms/.*/account_data/m\.fully_read"
        return {
            ("GET", route): _error(404, "M_NOT_FOUND")
            if event_id is None
            else {"event_id": event_id},
            ("POST", r"/_matrix/client/v3/rooms/.*/read_markers"): {},
        }

    def read_to(self, server: Homeserver) -> list[str]:
        return [
            json.loads(r.content)["m.fully_read"]
            for r in server.requests
            if r.url.path.endswith("/read_markers")
        ]

    async def test_a_new_holder_relays_only_what_the_last_one_had_not(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver({**room_routes(), **self.marker("$b")})
        adapter, inbound = await connect(monkeypatch, server, listening=True)
        window = [text("$a", "a"), text("$b", "b"), text("$c", "c"), text("$d", "d")]
        await adapter._process_sync(sync(window), initial=True)
        assert [m.message_ref for m in inbound.messages] == ["$c", "$d"]
        assert self.read_to(server) == ["$d"]

    async def test_a_gap_longer_than_the_window_is_read_back_to_the_marker(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        pages = {
            "p1": {"chunk": [text("$y", "y"), text("$x", "x")], "end": "p0"},
            "p0": {"chunk": [text("$w", "w"), text("$old", "old")], "end": "pz"},
        }

        def messages(request: httpx.Request) -> httpx.Response:
            return _json(pages[request.url.params["from"]])

        server = Homeserver(
            {
                **room_routes(),
                **self.marker("$old"),
                ("GET", r"/_matrix/client/v3/rooms/.*/messages"): messages,
            }
        )
        adapter, inbound = await connect(monkeypatch, server)
        await adapter._process_sync(
            sync([text("$z", "z")], limited=True), initial=False
        )
        assert [m.message_ref for m in inbound.messages] == ["$w", "$x", "$y", "$z"]

    async def test_a_room_never_read_starts_at_the_bots_own_join(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        join = {
            "type": "m.room.member",
            "event_id": "$join",
            "sender": BOT,
            "state_key": BOT,
            "content": {"membership": "join"},
        }
        server = Homeserver({**room_routes(), **self.marker(None)})
        adapter, inbound = await connect(monkeypatch, server)
        await adapter._process_sync(
            sync([text("$before", "history"), join, text("$after", "hi")]), initial=True
        )
        assert [m.message_ref for m in inbound.messages] == ["$after"]

    async def test_a_room_never_read_with_no_join_in_view_relays_nothing_old(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver({**room_routes(), **self.marker(None)})
        adapter, inbound = await connect(monkeypatch, server)
        await adapter._process_sync(sync([text("$old", "old")]), initial=True)
        assert inbound.messages == []
        assert self.read_to(server) == ["$old"]

    async def test_a_failed_marker_write_does_not_stop_the_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(
            {
                **room_routes(),
                **self.marker("$a"),
                ("POST", r"/_matrix/client/v3/rooms/.*/read_markers"): _error(
                    500, "M_UNKNOWN"
                ),
            }
        )
        adapter, inbound = await connect(monkeypatch, server)
        await adapter._process_sync(
            sync([text("$a", "a"), text("$b", "b")]), initial=True
        )
        assert [m.message_ref for m in inbound.messages] == ["$b"]

    async def test_a_quiet_copy_opens_no_sync(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver()
        adapter, _ = await connect(monkeypatch, server, listening=False)
        assert adapter._sync_task is None
        assert not any("/sync" in r.url.path for r in server.requests)

    async def test_the_holder_syncs_and_a_revoked_token_is_surfaced(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(
            {("GET", r"/_matrix/client/v3/sync"): _error(401, "M_UNKNOWN_TOKEN")}
        )
        monkeypatch.setattr(
            adapter_module,
            "_new_http",
            lambda policy: httpx.AsyncClient(transport=httpx.MockTransport(server)),
        )
        adapter = MatrixAdapter(config=MatrixConnectionConfig.model_validate(CONFIG))
        adapter.set_outbound_policy(OutboundPolicy.parse(""))
        inbound = Inbound()
        await adapter.start(
            inbound.message, inbound.command, inbound.agent, inbound.user, inbound.app
        )
        assert adapter._sync_task is not None
        await adapter._sync_task
        assert "no longer accepts" in (await adapter.attention() or "")
        await adapter.stop()


# ── Outbound ─────────────────────────────────────────────────────────────────


class TestOutbound:
    async def test_an_agent_posts_under_its_name_in_the_thread(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver()
        adapter, _ = await connect(monkeypatch, server)
        ref = await adapter.send_message(ROOM, "scout", "**done**", "$root")
        assert ref == "$sent"
        content = server.sent()[0]
        assert content["body"] == "scout: **done**"
        assert (
            "<strong>scout</strong>: <strong>done</strong>" in content["formatted_body"]
        )
        assert content["m.relates_to"]["rel_type"] == "m.thread"
        assert content["m.relates_to"]["event_id"] == "$root"

    async def test_a_long_reply_is_several_messages_each_under_the_event_limit(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver()
        adapter, _ = await connect(monkeypatch, server)
        await adapter.send_message(ROOM, "scout", "\n".join(["word " * 20] * 500))
        sent = server.sent()
        assert len(sent) > 1
        assert all(len(json.dumps(c).encode()) < 65536 for c in sent)

    async def test_an_edit_replaces_and_a_delete_redacts(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(
            {("PUT", r"/_matrix/client/v3/rooms/.*/redact/.*"): {"event_id": "$r"}}
        )
        adapter, _ = await connect(monkeypatch, server)
        await adapter.update_message(ROOM, "$orig", "new text")
        edit = server.sent()[0]
        assert edit["m.relates_to"] == {"rel_type": "m.replace", "event_id": "$orig"}
        assert edit["m.new_content"]["body"] == "new text"
        await adapter.delete_message(ROOM, "$orig")
        assert any(
            "/redact/%24orig/" in r.url.raw_path.decode() for r in server.requests
        )

    async def test_typing_is_sent_for_the_bot(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver({("PUT", r"/_matrix/client/v3/rooms/.*/typing/.*"): {}})
        adapter, _ = await connect(monkeypatch, server)
        await adapter.send_typing(ROOM, "scout", True)
        body = json.loads(
            next(r for r in server.requests if "/typing/" in r.url.path).content
        )
        assert body["typing"] is True

    async def test_the_working_reaction_goes_on_and_comes_off_from_any_pod(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        reaction = {
            "event_id": "$mine",
            "sender": BOT,
            "content": {"m.relates_to": {"key": "👀"}},
        }
        other = {
            "event_id": "$theirs",
            "sender": "@alice:hs.test",
            "content": {"m.relates_to": {"key": "👀"}},
        }
        server = Homeserver(
            {
                ("PUT", r".*/send/m\.reaction/.*"): {"event_id": "$re"},
                ("GET", r"/_matrix/client/v1/rooms/.*/relations/.*"): {
                    "chunk": [other, reaction]
                },
                ("PUT", r"/_matrix/client/v3/rooms/.*/redact/.*"): {"event_id": "$x"},
            }
        )
        adapter, _ = await connect(monkeypatch, server)
        await adapter.mark_activity(
            ROOM, "$q", agent_name="scout", mark="working", on=True
        )
        assert server.sent("m.reaction")[0]["m.relates_to"]["key"] == "👀"
        await adapter.mark_activity(
            ROOM, "$q", agent_name="scout", mark="working", on=False
        )
        redacted = [r.url.path for r in server.requests if "/redact/" in r.url.path]
        assert len(redacted) == 1 and "$mine" in redacted[0]

    async def test_a_second_working_reaction_is_already_there(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(
            {("PUT", r".*/send/m\.reaction/.*"): _error(400, "M_DUPLICATE_ANNOTATION")}
        )
        adapter, _ = await connect(monkeypatch, server)
        await adapter.mark_activity(
            ROOM, "$q", agent_name="scout", mark="working", on=True
        )

    async def test_a_file_is_uploaded_and_posted_after_a_named_message(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(
            {
                ("GET", r"/_matrix/media/v3/config"): {"m.upload.size": 1000},
                ("POST", r"/_matrix/media/v3/upload"): {
                    "content_uri": "mxc://hs.test/new"
                },
            }
        )
        adapter, _ = await connect(monkeypatch, server)
        ref = await adapter.send_attachment(
            ROOM, "scout", "a.png", "image/png", b"12345", "chart"
        )
        assert ref == "$sent"
        first, second = server.sent()
        assert first["body"] == "scout: chart"
        assert (second["msgtype"], second["url"], second["info"]["size"]) == (
            "m.image",
            "mxc://hs.test/new",
            5,
        )

    async def test_a_file_over_the_upload_limit_is_refused_in_the_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(
            {("GET", r"/_matrix/media/v3/config"): {"m.upload.size": 3}}
        )
        adapter, _ = await connect(monkeypatch, server)
        await adapter.send_attachment(
            ROOM, "scout", "big.bin", "application/octet-stream", b"12345"
        )
        assert not any("/upload" in r.url.path for r in server.requests)
        assert "accepts at most 3" in server.sent()[0]["body"]

    async def test_several_files_go_one_at_a_time(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(
            {
                ("GET", r"/_matrix/media/v3/config"): {},
                ("POST", r"/_matrix/media/v3/upload"): {
                    "content_uri": "mxc://hs.test/f"
                },
            }
        )
        adapter, _ = await connect(monkeypatch, server)
        await adapter.send_attachments(
            ROOM,
            "scout",
            [
                OutboundAttachment(filename="a.txt", mimetype="text/plain", data=b"a"),
                OutboundAttachment(filename="b.txt", mimetype="text/plain", data=b"b"),
            ],
        )
        assert len(server.paths("POST")) == 2


# ── Rooms ────────────────────────────────────────────────────────────────────


class TestRooms:
    async def test_a_room_is_created_private_or_public(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(
            {("POST", r"/_matrix/client/v3/createRoom"): {"room_id": "!new:hs.test"}}
        )
        adapter, _ = await connect(monkeypatch, server)
        assert await adapter.create_channel("ops", "about ops") == "!new:hs.test"
        await adapter.create_channel("secret", "", channel_type="channel_private")
        presets = [
            json.loads(r.content)["preset"]
            for r in server.requests
            if r.url.path.endswith("createRoom")
        ]
        assert presets == ["public_chat", "private_chat"]

    async def test_a_refused_room_says_what_the_server_said(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from switch_core.bridges.collaboration.models import BridgeOperationError

        server = Homeserver(
            {
                ("POST", r"/_matrix/client/v3/createRoom"): _error(
                    403, "M_FORBIDDEN", "not allowed"
                )
            }
        )
        adapter, _ = await connect(monkeypatch, server)
        with pytest.raises(BridgeOperationError, match="not allowed"):
            await adapter.create_channel("ops", "")

    async def test_people_are_invited_and_the_ones_who_cannot_be_are_returned(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def invite(request: httpx.Request) -> httpx.Response:
            if json.loads(request.content)["user_id"] == "@ghost:hs.test":
                return _error(404, "M_NOT_FOUND")
            return _json({})

        server = Homeserver({("POST", r"/_matrix/client/v3/rooms/.*/invite"): invite})
        adapter, _ = await connect(monkeypatch, server)
        failed = await adapter.add_users_to_channel(
            ROOM, ["alice", "ghost"], ["@alice:hs.test", "@ghost:hs.test"]
        )
        assert failed == ["@ghost:hs.test"]

    async def test_deleting_a_room_leaves_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(
            {
                ("POST", r"/_matrix/client/v3/rooms/.*/leave"): {},
                ("POST", r"/_matrix/client/v3/rooms/.*/forget"): {},
            }
        )
        adapter, _ = await connect(monkeypatch, server)
        assert (await adapter.retire_channel(ROOM)).outcome == "left"

    async def test_the_directory_is_searched_and_a_room_has_a_link(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        server = Homeserver(
            {
                ("POST", r"/_matrix/client/v3/user_directory/search"): {
                    "results": [
                        {"user_id": "@alice:hs.test", "display_name": "Alice A"}
                    ]
                }
            }
        )
        adapter, _ = await connect(monkeypatch, server)
        found = await adapter.search_directory_users("ali")
        assert (found[0].username, found[0].display_name) == ("alice", "Alice A")
        assert (await adapter.channel_deeplink(ROOM)).startswith("https://matrix.to/")

    def test_what_matrix_cannot_do_is_declared(self) -> None:
        assert MatrixAdapter.renders_custom_url_schemes is False
        assert MatrixAdapter.channel_on_delete == "left"
        assert MatrixAdapter.keeps_quiet_unless_listening is True
        assert MatrixAdapter.activity_reactions_per_agent is False
        assert MatrixAdapter.channel_mention is None
        assert MatrixAdapter.supports_channel_creation is True
        adapter = MatrixAdapter(config=MatrixConnectionConfig.model_validate(CONFIG))
        assert adapter.slash_invite_hint() is None
