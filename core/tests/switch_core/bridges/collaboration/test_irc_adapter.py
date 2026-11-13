"""The IRC adapter against a fake network on a real local socket."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import RequestCard, TurnActivity
from switch_core.bridges.collaboration.irc import adapter as adapter_module
from switch_core.bridges.collaboration.irc import client as client_module
from switch_core.bridges.collaboration.irc.adapter import (
    IrcAdapter,
    IrcConnectionConfig,
)
from switch_core.bridges.collaboration.irc.client import IrcLoginRefused
from switch_core.bridges.collaboration.irc.markup import BOLD
from switch_core.bridges.collaboration.models import (
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
)
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.sessions.contract import TurnUpsert
from switch_core.signals import MAX_PAYLOAD_BYTES

from .irc_fakes import FakeIrcServer
from .session_fixtures import EXAMPLES_PATH, open_request, recorded_requests


class _Policy:
    async def resolve(self, host: str, port: int) -> list[str]:
        return ["127.0.0.1"]


class _Recorded:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []
        self.app_joins: list[InboundAppJoin] = []

    async def on_message(self, message: InboundMessage) -> None:
        self.messages.append(message)

    async def on_command(self, command: InboundCommand) -> None:
        self.commands.append(command)

    async def on_app(self, event: InboundAppJoin) -> None:
        self.app_joins.append(event)

    async def ignore(self, *args: Any) -> None:
        return None


def _adapter(server: FakeIrcServer, **overrides: object) -> IrcAdapter:
    config = IrcConnectionConfig.model_validate(
        {
            "server": "127.0.0.1",
            "port": server.port,
            "tls": False,
            "nick": "switchbot",
            **overrides,
        }
    )
    adapter = IrcAdapter(config=config)
    adapter.set_outbound_policy(_Policy())  # type: ignore[arg-type]
    return adapter


async def _start(adapter: IrcAdapter, seen: _Recorded) -> None:
    await adapter.start(
        seen.on_message, seen.on_command, seen.ignore, seen.ignore, seen.on_app
    )


@asynccontextmanager
async def _holder(
    server: FakeIrcServer, **overrides: object
) -> AsyncIterator[tuple[IrcAdapter, _Recorded]]:
    adapter = _adapter(server, **overrides)
    seen = _Recorded()
    await _start(adapter, seen)
    try:
        yield adapter, seen
    finally:
        await adapter.stop()


async def _until(condition: Any, timeout: float = 5.0) -> None:
    for _ in range(int(timeout / 0.02)):
        if condition():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition never held")


async def _drained(adapter: IrcAdapter) -> None:
    """Wait until every queued line is written: the bridge paces itself."""
    await _until(lambda: adapter._outbox.empty(), timeout=30)
    await asyncio.sleep(0.2)


def _said(server: FakeIrcServer, target: str = "#ops") -> list[str]:
    return [
        line.split(" :", 1)[1]
        for line in server.received
        if line.startswith(f"PRIVMSG {target} ")
    ]


# ── Messages in ──────────────────────────────────────────────────────────────


async def test_a_channel_message_becomes_a_room_message() -> None:
    async with FakeIrcServer() as server, _holder(server, channels="#Ops") as (_, seen):
        server.say(
            "@msgid=m1;time=2026-11-05T10:00:00.000Z :Ada!a@h PRIVMSG #Ops :hi \x02all\x02"
        )
        await _until(lambda: seen.messages)
    message = seen.messages[0]
    assert (message.channel_id, message.channel_type) == ("#ops", "channel_public")
    assert (message.sender_id, message.sender_name) == ("nick:ada", "Ada")
    assert message.content == "hi **all**"
    assert message.message_ref == "irc:m1"
    assert message.channel_name == "#Ops"


async def test_a_logged_in_sender_is_known_by_account() -> None:
    async with FakeIrcServer() as server, _holder(server) as (_, seen):
        server.say("@account=ada :ada_away!a@h PRIVMSG #ops :hello")
        await _until(lambda: seen.messages)
    assert seen.messages[0].sender_id == "account:ada"


async def test_a_private_message_is_a_direct_room() -> None:
    async with FakeIrcServer() as server, _holder(server) as (_, seen):
        server.say(":Ada!a@h PRIVMSG switchbot :just us")
        await _until(lambda: seen.messages)
    assert (seen.messages[0].channel_id, seen.messages[0].channel_type) == (
        "ada",
        "direct",
    )


async def test_a_bang_command_is_a_command() -> None:
    async with FakeIrcServer() as server, _holder(server) as (_, seen):
        server.say(":ada!a@h PRIVMSG #ops :!invite-agent coder now")
        await _until(lambda: seen.commands)
    assert (seen.commands[0].command, seen.commands[0].args) == (
        "invite-agent",
        "coder now",
    )
    assert not seen.messages


async def test_me_is_relayed_and_other_ctcp_is_not() -> None:
    async with FakeIrcServer() as server, _holder(server) as (_, seen):
        server.say(":ada!a@h PRIVMSG #ops :\x01VERSION\x01")
        server.say(":ada!a@h PRIVMSG #ops :\x01ACTION waves\x01")
        await _until(lambda: seen.messages)
        await asyncio.sleep(0.1)
    assert [m.content for m in seen.messages] == ["*waves*"]


@pytest.mark.parametrize(
    "line",
    [
        ":switchbot!b@h PRIVMSG #ops :an echo",
        ":switchbot_!b@h PRIVMSG #ops :an echo under a fallback nick",
        ":NickServ!s@services PRIVMSG switchbot :You are now identified",
        ":irc.example.net PRIVMSG #ops :from the server itself",
        ":ada!a@h PRIVMSG @#ops :for operators only",
    ],
)
async def test_lines_that_are_not_a_persons_message_are_ignored(line: str) -> None:
    async with FakeIrcServer() as server, _holder(server) as (_, seen):
        server.say(line)
        server.say(":ada!a@h PRIVMSG #ops :marker")
        await _until(lambda: seen.messages)
    assert [m.content for m in seen.messages] == ["marker"]


@pytest.mark.parametrize(
    ("text", "mentioned"),
    [
        ("switchbot: are you there?", True),
        ("SwitchBot, hello", True),
        ("hey @switchbot look", True),
        ("switchbots are great", False),
        ("ask @switchbot-two", False),
    ],
)
async def test_addressing_the_bot_is_a_mention_of_it(
    text: str, mentioned: bool
) -> None:
    async with FakeIrcServer() as server, _holder(server) as (_, seen):
        server.say(f":ada!a@h PRIVMSG #ops :{text}")
        await _until(lambda: seen.messages)
    assert (seen.messages[0].self_mention_token == "switchbot") is mentioned


async def test_a_replayed_line_without_msgid_keeps_its_reference() -> None:
    line = "@time=2026-11-05T10:00:00.000Z :ada!a@h PRIVMSG #ops :same"
    async with FakeIrcServer() as server, _holder(server) as (_, seen):
        server.say(line)
        server.say(line)
        server.say(":ada!a@h PRIVMSG #ops :untimed")
        server.say(":ada!a@h PRIVMSG #ops :untimed")
        await _until(lambda: len(seen.messages) == 4)
    refs = [m.message_ref for m in seen.messages]
    assert refs[0] == refs[1]
    assert refs[2] != refs[3]


async def test_joining_announces_each_channel_once() -> None:
    async with (
        FakeIrcServer() as server,
        _holder(server, channels="#ops, #dev") as (a, seen),
    ):
        await _until(lambda: len(seen.app_joins) == 2)
        server.say(":switchbot!bot@fake.host JOIN #ops")
        await asyncio.sleep(0.1)
    assert sorted(e.channel_id for e in seen.app_joins) == ["#dev", "#ops"]


async def test_an_invite_is_accepted_or_not_as_configured() -> None:
    async with FakeIrcServer() as server, _holder(server) as (_, seen):
        server.say(":ada!a@h INVITE switchbot #new")
        await _until(lambda: any(e.channel_id == "#new" for e in seen.app_joins))
    async with (
        FakeIrcServer() as server,
        _holder(server, accept_invites=False) as (_, seen),
    ):
        server.say(":ada!a@h INVITE switchbot #new")
        await asyncio.sleep(0.2)
    assert "JOIN #new" not in server.received


# ── Messages out ─────────────────────────────────────────────────────────────


async def test_each_line_carries_the_agents_name() -> None:
    async with FakeIrcServer() as server, _holder(server, channels="#ops") as (a, _):
        await a.send_message("#ops", "coder", a.translate_outbound("one\ntwo **bold**"))
        await server.wait_for(lambda line: "two" in line)
    assert _said(server) == ["<coder> one", f"<coder> two {BOLD}bold{BOLD}"]


async def test_a_long_multibyte_reply_fits_every_line_on_the_wire() -> None:
    async with FakeIrcServer() as server, _holder(server, channels="#ops") as (a, _):
        await _until(
            lambda: a._connection is not None and a._connection._learned_prefix
        )
        body = ("Unicode é, emoji 😀 and **bold words** that run on. " * 30).strip()
        await a.send_message("#ops", "coder", a.translate_outbound(body))
        await _until(lambda: len(_said(server)) >= 4, timeout=15)
        await asyncio.sleep(0.5)
    prefix = len(b":switchbot!bot@fake.host ")
    for line in server.received:
        if line.startswith("PRIVMSG #ops"):
            assert prefix + len(line.encode()) + 2 <= 512
    joined = " ".join(text.removeprefix("<coder> ") for text in _said(server))
    assert "😀" in joined and "é" in joined


async def test_text_cannot_become_a_command_of_its_own() -> None:
    async with FakeIrcServer() as server, _holder(server, channels="#ops") as (a, _):
        await a.send_message(
            "#ops", "evil\r\nQUIT", a.translate_outbound("hi\r\nJOIN #x")
        )
        await server.wait_for(lambda line: line.startswith("PRIVMSG #ops"))
        await asyncio.sleep(0.2)
    assert "JOIN #x" not in server.received
    assert not any(line.startswith("QUIT") for line in server.received)


async def test_a_code_block_keeps_its_indentation() -> None:
    async with FakeIrcServer() as server, _holder(server, channels="#ops") as (a, _):
        await a.send_message(
            "#ops", "coder", a.translate_outbound("```\nif x:\n    y()\n```")
        )
        await server.wait_for(lambda line: "y()" in line)
    assert _said(server) == ["<coder> if x:", "<coder>     y()"]


async def test_edits_and_deletes_send_nothing() -> None:
    async with FakeIrcServer() as server, _holder(server, channels="#ops") as (a, _):
        await a.update_message("#ops", "irc:out-1", "changed")
        await a.delete_message("#ops", "irc:out-1")
        await asyncio.sleep(0.2)
    assert not _said(server)


# ── Cards and turns ──────────────────────────────────────────────────────────


def _card(settled: bool = False) -> RequestCard:
    request = (
        recorded_requests(EXAMPLES_PATH, "answerLifecycle")["request-demo"]
        if settled
        else open_request()
    )
    return RequestCard(request, RequestReference(token="tok", handle="A1"))


def _turn(status: str, error: str | None = None) -> TurnActivity:
    turn = TurnUpsert.model_validate(
        {"type": "turn.upsert", "turnId": "t1", "status": status, "commandId": None}
    )
    return TurnActivity(items=[], turn=turn, error_summary=error)


async def test_a_card_is_said_with_its_handle_in_irc_formatting() -> None:
    async with FakeIrcServer() as server, _holder(server, channels="#ops") as (a, _):
        await a.post_rich("#ops", "coder", _card())
        await _drained(a)
    said = "\n".join(_said(server))
    assert "A1" in said
    assert "**" not in said


async def test_a_card_is_said_again_once_when_settled() -> None:
    async with FakeIrcServer() as server, _holder(server, channels="#ops") as (a, _):
        ref = await a.post_rich("#ops", "coder", _card())
        await a.update_rich("#ops", "coder", ref, _card(), None)
        await _drained(a)
        posted = len(_said(server))
        await a.update_rich("#ops", "coder", ref, _card(settled=True), None)
        await _drained(a)
        settled = len(_said(server)) - posted
        await a.update_rich("#ops", "coder", ref, _card(settled=True), None)
        await _drained(a)
    assert posted > 0 and settled > 0
    assert len(_said(server)) == posted + settled


async def test_a_settled_card_names_who_answered_by_their_irc_handle() -> None:
    card = _card(settled=True)
    request = card.request.model_copy(
        update={
            "decided_by": card.request.decided_by.model_copy(  # type: ignore[union-attr]
                update={"actor_id": "@switch-irc-1-ada:localhost", "surface": "irc"}
            )
        }
    )
    answered = RequestCard(request, card.reference, responder_external_id="account:ada")
    async with FakeIrcServer() as server, _holder(server) as (a, _):
        text = a.rich_fallback_text(answered)
    assert "ada from IRC" in text
    assert "switch-irc" not in text


async def test_a_turn_is_not_posted_unless_it_failed() -> None:
    async with FakeIrcServer() as server, _holder(server, channels="#ops") as (a, _):
        ref = await a.post_rich("#ops", "coder", _turn("running"))
        await a.update_rich("#ops", "coder", ref, _turn("completed"), None)
        await asyncio.sleep(0.2)
        assert not _said(server)
        await a.update_rich(
            "#ops", "coder", ref, _turn("error", "The model refused"), None
        )
        await a.update_rich(
            "#ops", "coder", ref, _turn("error", "The model refused"), None
        )
        await server.wait_for(lambda line: "refused" in line)
        await asyncio.sleep(0.2)
    assert _said(server) == ["<coder> The model refused"]


# ── Channels ─────────────────────────────────────────────────────────────────


async def test_creating_a_private_room_makes_a_fresh_invite_only_channel() -> None:
    async with FakeIrcServer() as server, _holder(server) as (a, _):
        created = await a.create_channel(
            "Release Train!", "Shipping 2.0", channel_type="channel_private"
        )
        channel = created.id
        assert created.name == channel
        await a.add_users_to_channel(channel, ["ada"], ["nick:ada"])
        await server.wait_for(lambda line: line.startswith("INVITE"))
    assert (
        channel.startswith("#release-train-")
        and len(channel) == len("#release-train-") + 4
    )
    upkeep = [
        line
        for line in server.received
        if line.split(" ")[0] in ("JOIN", "MODE", "TOPIC", "INVITE")
    ]
    assert upkeep == [
        f"JOIN {channel}",
        f"MODE {channel} +si",
        f"TOPIC {channel} :Shipping 2.0",
        f"INVITE ada {channel}",
    ]


async def test_a_channel_that_already_existed_is_left_as_it_is() -> None:
    async with FakeIrcServer() as server, _holder(server) as (a, _):
        server.channels["#taken-0000"] = ["ada"]
        a._create_here("#taken-0000", "mine now", True)
        await a.add_users_to_channel("#taken-0000", ["bob"], ["nick:bob"])
        await server.wait_for(lambda line: line.startswith("INVITE"))
    assert not server.sent("MODE") and not server.sent("TOPIC")


async def test_someone_known_only_by_account_is_handed_back() -> None:
    async with FakeIrcServer() as server, _holder(server, channels="#ops") as (a, _):
        left_out = await a.add_users_to_channel(
            "#ops", ["Ada Lovelace"], ["account:ada"]
        )
    assert left_out == ["account:ada"]


async def test_deleting_a_room_leaves_its_channel() -> None:
    async with FakeIrcServer() as server, _holder(server, channels="#ops") as (a, _):
        outcome = await a.retire_channel("#ops")
        await server.wait_for(lambda line: line.startswith("PART #ops"))
    assert outcome.outcome == "left"


async def test_binding_refuses_what_is_not_a_channel_and_joins_what_is() -> None:
    from switch_core.bridges.collaboration.adapter import ChannelNotBindable

    async with FakeIrcServer() as server, _holder(server) as (a, _):
        with pytest.raises(ChannelNotBindable):
            await a.require_bindable_channel("ada")
        await a.require_bindable_channel("#bound")
        await server.wait_for(lambda line: line == "JOIN #bound")


async def test_rooms_channels_are_joined_on_start() -> None:
    async with FakeIrcServer() as server, _holder(server) as (a, _):
        await a.ensure_channel_subscriptions(
            [("#ops", "channel_public"), ("ada", "direct")]
        )
        await server.wait_for(lambda line: line == "JOIN #ops")
    assert "JOIN ada" not in server.received


# ── Several pods ─────────────────────────────────────────────────────────────


def _quiet(server: FakeIrcServer) -> tuple[IrcAdapter, list[dict[str, str]]]:
    adapter = _adapter(server)
    adapter.set_listening(False)
    relayed: list[dict[str, str]] = []
    adapter.set_holder_relay(relayed.append)
    return adapter, relayed


async def test_a_quiet_copy_opens_no_connection() -> None:
    async with FakeIrcServer() as server:
        quiet, _ = _quiet(server)
        await _start(quiet, _Recorded())
        await asyncio.sleep(0.2)
        await quiet.stop()
    assert not server.received


async def test_a_quiet_copys_message_is_said_by_the_holder_in_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(client_module, "PACE", 0.01)
    async with (
        FakeIrcServer() as server,
        _holder(server, channels="#ops") as (holder, _),
    ):
        quiet, relayed = _quiet(server)
        await _start(quiet, _Recorded())
        body = "\n".join(f"line {n} " + "x" * 400 for n in range(40))
        await quiet.send_message("#ops", "coder", quiet.translate_outbound(body))
        assert len(relayed) > 1
        for request in relayed:
            assert len(json.dumps({"request": request}).encode()) < MAX_PAYLOAD_BYTES
        for request in reversed(relayed):
            await holder.receive_relayed(request)
        await server.wait_for(lambda line: "line 39" in line, timeout=60)
    numbers = [
        int(text.split()[2])
        for text in _said(server)
        if text.startswith("<coder> line")
    ]
    assert numbers == sorted(numbers) and numbers[-1] == 39


async def test_two_identical_relayed_messages_are_both_said() -> None:
    async with (
        FakeIrcServer() as server,
        _holder(server, channels="#ops") as (holder, _),
    ):
        quiet, relayed = _quiet(server)
        await quiet.send_message("#ops", "coder", "same")
        await quiet.send_message("#ops", "coder", "same")
        for request in relayed:
            await holder.receive_relayed(request)
        await _until(lambda: len(_said(server)) == 2)


@pytest.mark.parametrize(
    "request_",
    [
        {
            "action": "say",
            "target": "#ops",
            "id": "x",
            "part": "0",
            "of": "1",
            "lines": '["JOIN #evil"]',
        },
        {
            "action": "say",
            "target": "#ops",
            "id": "x",
            "part": "0",
            "of": "1",
            "lines": "not json",
        },
        {"action": "say", "target": "#ops", "id": "x"},
        {"action": "invite", "channel": "#ops", "nicks": "[1, 2]"},
    ],
)
async def test_a_malformed_relay_is_refused(request_: dict[str, str]) -> None:
    async with (
        FakeIrcServer() as server,
        _holder(server, channels="#ops") as (holder, _),
    ):
        await holder.receive_relayed(request_)
        await asyncio.sleep(0.2)
    assert "JOIN #evil" not in server.received
    assert not server.sent("INVITE")


async def test_a_quiet_copys_channel_work_is_done_by_the_holder() -> None:
    async with FakeIrcServer() as server, _holder(server) as (holder, _):
        quiet, relayed = _quiet(server)
        channel = (
            await quiet.create_channel("Ops", "", channel_type="channel_private")
        ).id
        await quiet.add_users_to_channel(channel, ["ada"], ["nick:ada"])
        await quiet.require_bindable_channel("#bound")
        await quiet.retire_channel("#old")
        assert [r["action"] for r in relayed] == ["create", "invite", "join", "part"]
        for request in relayed:
            await holder.receive_relayed(request)
        await server.wait_for(lambda line: line.startswith("INVITE ada"))
        await server.wait_for(lambda line: line.startswith("PART #old"))
    assert f"MODE {channel} +si" in server.received
    assert "JOIN #bound" in server.received


# ── Missed messages ──────────────────────────────────────────────────────────


def _history(*items: tuple[str, str, str]) -> list[str]:
    return [
        f"@time={stamp};msgid={msgid} :ada!a@h PRIVMSG #ops :{text}"
        for stamp, msgid, text in items
    ]


async def test_reads_back_what_was_said_after_the_marker() -> None:
    history = {
        "#ops": _history(
            ("2099-01-01T10:00:00.000Z", "h1", "before"),
            ("2099-01-01T10:01:00.000Z", "h2", "missed one"),
            ("2099-01-01T10:02:00.000Z", "h3", "missed two"),
        )
    }
    markers = {"#ops": "2099-01-01T10:00:00.000Z"}
    async with FakeIrcServer(history=history, markers=markers) as server:
        async with _holder(server, channels="#ops") as (_, seen):
            await _until(lambda: len(seen.messages) == 2)
            await _until(
                lambda: server.markers["#ops"] == "2099-01-01T10:02:00.000Z", timeout=8
            )
    assert [m.content for m in seen.messages] == ["missed one", "missed two"]
    assert [m.message_ref for m in seen.messages] == ["irc:h2", "irc:h3"]


async def test_a_channel_never_read_is_not_read_back() -> None:
    async with FakeIrcServer(
        history={"#ops": _history(("2099-01-01T10:00:00.000Z", "h1", "old"))}
    ) as server:
        async with _holder(server, channels="#ops") as (_, seen):
            await server.wait_for(lambda line: line == "JOIN #ops")
            await asyncio.sleep(0.3)
    assert not server.sent("CHATHISTORY")
    assert not seen.messages


async def test_reads_back_page_by_page(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(adapter_module, "_HISTORY_PAGE", 2)
    items = [(f"2099-01-01T10:0{n}:00.000Z", f"h{n}", f"m{n}") for n in range(1, 6)]
    async with FakeIrcServer(
        history={"#ops": _history(*items)}, markers={"#ops": "2099-01-01T10:00:00.000Z"}
    ) as server:
        async with _holder(server, channels="#ops") as (_, seen):
            await _until(lambda: len(seen.messages) == 5)
    assert [m.content for m in seen.messages] == ["m1", "m2", "m3", "m4", "m5"]
    assert any("msgid=h2" in line for line in server.sent("CHATHISTORY"))


async def test_reads_back_no_more_than_a_day() -> None:
    async with FakeIrcServer(markers={"#ops": "2000-01-01T00:00:00.000Z"}) as server:
        async with _holder(server, channels="#ops") as _:
            request = await server.wait_for(lambda line: line.startswith("CHATHISTORY"))
    assert "2000-01-01" not in request


async def test_without_history_no_marker_is_sent() -> None:
    caps = ("server-time", "message-tags")
    async with (
        FakeIrcServer(caps=caps) as server,
        _holder(server, channels="#ops") as (_, seen),
    ):
        server.say("@time=2099-01-01T10:00:00.000Z :ada!a@h PRIVMSG #ops :hi")
        await _until(lambda: seen.messages)
        await asyncio.sleep(2.5)
    assert not server.sent("MARKREAD")


# ── Starting, reconnecting, stopping ─────────────────────────────────────────


async def test_a_refused_login_fails_the_first_start() -> None:
    async with FakeIrcServer() as server:
        adapter = _adapter(server)
        object.__setattr__(adapter.config, "account", "switchbot")
        object.__setattr__(adapter.config, "password", "wrong")
        with pytest.raises(IrcLoginRefused):
            await _start(adapter, _Recorded())


async def test_reconnects_rejoins_and_sends_what_was_queued(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(adapter_module, "_RECONNECT_FIRST", 0.05)
    async with FakeIrcServer() as server, _holder(server, channels="#ops") as (a, _):
        await server.wait_for(lambda line: line == "JOIN #ops")
        first = a._connection
        await server.drop_everyone()
        server.received.clear()
        # IRC acknowledges nothing, so what matters is a line queued once the
        # bridge knows the connection is gone: it waits for the next one.
        await _until(lambda: a._connection is not first)
        await a.send_message("#ops", "coder", "said during the drop")
        await server.wait_for(lambda line: line == "JOIN #ops", timeout=10)
        await server.wait_for(lambda line: "said during the drop" in line, timeout=10)


async def test_stop_writes_what_is_queued_then_quits() -> None:
    async with FakeIrcServer() as server:
        adapter = _adapter(server, channels="#ops")
        await _start(adapter, _Recorded())
        for n in range(8):
            await adapter.send_message("#ops", "coder", f"queued {n}")
        await adapter.stop()
        await server.wait_for(lambda line: line.startswith("QUIT"))
    assert len([t for t in _said(server) if "queued" in t]) == 8
