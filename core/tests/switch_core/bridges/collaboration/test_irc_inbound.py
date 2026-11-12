"""What IRC says, as Switch is handed it: messages, commands, the bot's own
echoes, joins, and what was missed while nobody was connected."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from switch_core.bridges.collaboration.irc import adapter as adapter_module
from switch_core.bridges.collaboration.irc import client as client_module
from switch_core.bridges.collaboration.irc.adapter import IrcAdapter
from tests.switch_core.bridges.collaboration.irc_fakes import (
    CHANNEL,
    NICK,
    PASSWORD,
    FakeIrcServer,
    Inbound,
    ago,
    privmsg,
    quick,
    started,
    until,
)


@pytest.fixture
async def server() -> AsyncIterator[FakeIrcServer]:
    async with FakeIrcServer() as running:
        yield running


@pytest.fixture(autouse=True)
def _quick(monkeypatch: pytest.MonkeyPatch) -> None:
    quick(monkeypatch)


@pytest.fixture
def inbound() -> Inbound:
    return Inbound()


@pytest.fixture
async def adapter(server: FakeIrcServer, inbound: Inbound) -> AsyncIterator[IrcAdapter]:
    running = await started(server, inbound)
    yield running
    await running.stop()


# ── Messages ─────────────────────────────────────────────────────────────────


async def test_a_channel_message_becomes_a_message_in_its_room(
    server: FakeIrcServer, inbound: Inbound, adapter: IrcAdapter
) -> None:
    await server.tell(privmsg("hello @coder", target="#Ops", msgid="abc"))
    await until(lambda: bool(inbound.messages))
    (message,) = inbound.messages
    assert message.channel_id == CHANNEL
    assert message.channel_type == "channel_public"
    assert message.channel_name == "ops"
    assert message.sender_id == "account:ada"
    assert message.sender_name == "ada"
    assert message.content == "hello @coder"
    assert message.message_ref == "abc"
    assert message.root_id is None
    assert message.self_mention_token is None


async def test_someone_not_logged_in_is_known_by_nick_alone(
    server: FakeIrcServer, inbound: Inbound, adapter: IrcAdapter
) -> None:
    await server.tell(privmsg("hi", nick="Guest42", account=None))
    await until(lambda: bool(inbound.messages))
    assert inbound.messages[0].sender_id == "nick:guest42"


async def test_a_message_to_the_bot_is_a_direct_conversation(
    server: FakeIrcServer, inbound: Inbound, adapter: IrcAdapter
) -> None:
    await server.tell(privmsg("psst", nick="Ada", target=NICK))
    await until(lambda: bool(inbound.messages))
    (message,) = inbound.messages
    assert (message.channel_id, message.channel_type) == ("ada", "direct")
    assert message.channel_name == "Ada"


async def test_what_no_room_stands_for_is_not_relayed(
    server: FakeIrcServer, inbound: Inbound, adapter: IrcAdapter
) -> None:
    await server.tell(privmsg("ops only", target=f"@{CHANNEL}", msgid="1"))
    await server.tell(":irc.example NOTICE switchbot :server notice")
    await server.tell(":irc.example PRIVMSG switchbot :from the server")
    await server.tell(privmsg("\x01VERSION\x01", msgid="2"))
    await server.tell(privmsg("\x02\x03\x02", msgid="3"))
    await server.tell(privmsg("last", msgid="4"))
    await until(lambda: bool(inbound.messages))
    assert [m.content for m in inbound.messages] == ["last"]


async def test_formatting_is_dropped_and_an_action_reads_as_one(
    server: FakeIrcServer, inbound: Inbound, adapter: IrcAdapter
) -> None:
    await server.tell(privmsg("\x02deploy\x02 \x0304now\x03", msgid="1"))
    await server.tell(privmsg("\x01ACTION waves\x01", msgid="2"))
    await until(lambda: len(inbound.messages) == 2)
    assert [adapter.translate_inbound(m.content) for m in inbound.messages] == [
        "deploy now",
        "*waves*",
    ]


async def test_the_bots_own_lines_are_echoes(
    server: FakeIrcServer, inbound: Inbound, adapter: IrcAdapter
) -> None:
    await server.tell(privmsg("<coder> done", nick="SwitchBot", account=None))
    await server.tell(privmsg("real", msgid="2"))
    await until(lambda: bool(inbound.messages))
    assert [m.content for m in inbound.messages] == ["real"]


async def test_a_logged_in_bots_lines_from_an_older_nick_are_echoes_too(
    tmp_path: Path, inbound: Inbound
) -> None:
    async with FakeIrcServer(tls_in=tmp_path) as tls_server:
        adapter = await started(
            tls_server,
            inbound,
            tls=True,
            verify_tls=False,
            account_password=PASSWORD,
        )
        try:
            # Said before a reconnect, while the nick was taken, and read back.
            await tls_server.tell(
                privmsg("<coder> old", nick=f"{NICK}_", account=NICK, msgid="1")
            )
            await tls_server.tell(privmsg("real", msgid="2"))
            await until(lambda: bool(inbound.messages))
            assert [m.content for m in inbound.messages] == ["real"]
        finally:
            await adapter.stop()


async def test_the_bot_addressed_by_nick_is_a_mention_of_it(
    server: FakeIrcServer, inbound: Inbound, adapter: IrcAdapter
) -> None:
    await server.tell(privmsg(f"{NICK}: can you help", msgid="1"))
    await server.tell(privmsg(f"ping @{NICK.upper()} please", msgid="2"))
    await server.tell(privmsg(f"{NICK}ty is not it", msgid="3"))
    await until(lambda: len(inbound.messages) == 3)
    assert [m.self_mention_token for m in inbound.messages] == [NICK, NICK, None]


async def test_a_bang_command_is_a_command(
    server: FakeIrcServer, inbound: Inbound, adapter: IrcAdapter
) -> None:
    await server.tell(privmsg("!invite-agent  @coder ", msgid="c1"))
    await until(lambda: bool(inbound.commands))
    (command,) = inbound.commands
    assert (command.command, command.args) == ("invite-agent", "@coder")
    assert (command.channel_id, command.sender_id) == (CHANNEL, "account:ada")
    assert command.message_ref == "c1"
    assert not inbound.messages


async def test_what_services_say_to_the_bot_is_not_a_conversation(
    server: FakeIrcServer, inbound: Inbound, adapter: IrcAdapter
) -> None:
    await server.tell(privmsg("You are now identified", nick="NickServ", target=NICK))
    await server.tell(privmsg("person", msgid="2", target=NICK))
    await until(lambda: bool(inbound.messages))
    assert [m.content for m in inbound.messages] == ["person"]


async def test_a_message_without_an_id_gets_one_its_replay_repeats(
    server: FakeIrcServer, inbound: Inbound, adapter: IrcAdapter
) -> None:
    sent = ago(seconds=5)
    await server.tell(privmsg("same", msgid=None, sent=sent))
    await server.tell(privmsg("same", msgid=None, sent=sent))
    await server.tell(privmsg("same", msgid=None))
    await server.tell(privmsg("same", msgid=None))
    await until(lambda: len(inbound.messages) == 4)
    refs = [m.message_ref for m in inbound.messages]
    assert refs[0] == refs[1]
    assert len({refs[0], refs[2], refs[3]}) == 3


async def test_joining_a_channel_makes_its_room(
    inbound: Inbound, adapter: IrcAdapter
) -> None:
    await until(lambda: bool(inbound.app_joins))
    (join,) = inbound.app_joins
    assert (join.channel_id, join.channel_type, join.channel_name) == (
        CHANNEL,
        "channel_public",
        "ops",
    )


# ── Read markers and what was missed ─────────────────────────────────────────


async def test_each_relayed_message_moves_the_channels_read_marker(
    server: FakeIrcServer, inbound: Inbound, adapter: IrcAdapter
) -> None:
    first, second = ago(seconds=2), ago(seconds=1)
    await server.tell(privmsg("one", msgid="1", sent=first))
    await server.tell(privmsg("two", msgid="2", sent=second))
    await server.wait_for(lambda: server.markers.get(CHANNEL) == second)


async def test_a_message_switch_could_not_take_keeps_the_marker_before_it(
    server: FakeIrcServer, inbound: Inbound, adapter: IrcAdapter
) -> None:
    await server.tell(privmsg("one", msgid="1", sent=ago(seconds=3)))
    await until(lambda: bool(inbound.messages))
    await server.wait_for(lambda: server.markers.get(CHANNEL) is not None)
    marked = server.markers[CHANNEL]
    inbound.refused = {"lost"}
    await server.tell(privmsg("lost", msgid="2", sent=ago(seconds=2)))
    await server.tell(privmsg("after", msgid="3", sent=ago(seconds=1)))
    await until(lambda: [m.content for m in inbound.messages] == ["one", "after"])
    await server.tell("PING :sync")
    await server.wait_for(lambda: bool(server.sent("PONG")))
    assert server.markers[CHANNEL] == marked


async def test_what_was_said_while_away_is_read_back_from_the_marker(
    server: FakeIrcServer, inbound: Inbound
) -> None:
    server.markers[CHANNEL] = ago(minutes=10)
    server.history[CHANNEL] = [
        (sent, privmsg(text, msgid=text.replace(" ", "-"), sent=sent))
        for sent, text in [
            (ago(minutes=20), "read already"),
            (ago(minutes=5), "missed"),
            (ago(minutes=4), "also missed"),
        ]
    ]
    adapter = await started(server, inbound)
    try:
        await until(lambda: len(inbound.messages) == 2)
        assert [m.content for m in inbound.messages] == ["missed", "also missed"]
        (asked,) = server.sent("CHATHISTORY")
        assert asked.params[:2] == ("AFTER", CHANNEL)
    finally:
        await adapter.stop()


async def test_a_long_gap_is_read_back_a_page_at_a_time(
    server: FakeIrcServer, inbound: Inbound, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(client_module, "_HISTORY_PAGE", 2)
    server.markers[CHANNEL] = ago(minutes=10)
    sent = [ago(minutes=9 - n) for n in range(5)]
    server.history[CHANNEL] = [
        (sent[n], privmsg(f"m{n}", msgid=f"m{n}", sent=sent[n])) for n in range(5)
    ]
    adapter = await started(server, inbound)
    try:
        await until(lambda: len(inbound.messages) == 5)
        assert [m.content for m in inbound.messages] == [f"m{n}" for n in range(5)]
        assert len(server.sent("CHATHISTORY")) == 3
    finally:
        await adapter.stop()


async def test_a_page_full_of_other_lines_still_asks_for_the_next(
    server: FakeIrcServer, inbound: Inbound, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(client_module, "_HISTORY_PAGE", 2)
    server.markers[CHANNEL] = ago(minutes=10)
    notice = f"@msgid=n0;time={ago(minutes=9)} :ada!a@h NOTICE {CHANNEL} :fyi"
    server.history[CHANNEL] = [
        (ago(minutes=9), notice),
        (ago(minutes=8), privmsg("m1", msgid="m1", sent=ago(minutes=8))),
        (ago(minutes=7), privmsg("m2", msgid="m2", sent=ago(minutes=7))),
    ]
    adapter = await started(server, inbound)
    try:
        await until(lambda: len(inbound.messages) == 2)
        assert [m.content for m in inbound.messages] == ["m1", "m2"]
        asked = [line.params[2] for line in server.sent("CHATHISTORY")]
        # The first page, a notice and m1, was full; the second was not.
        assert asked[1:] == ["msgid=m1"]
    finally:
        await adapter.stop()


async def test_the_marker_waits_for_the_history_before_a_newer_message(
    server: FakeIrcServer, inbound: Inbound
) -> None:
    missed = ago(minutes=5)
    server.markers[CHANNEL] = ago(minutes=10)
    server.history[CHANNEL] = [(missed, privmsg("missed", msgid="h1", sent=missed))]
    server.hold_history = asyncio.Event()
    adapter = await started(server, inbound)
    try:
        live = ago(seconds=1)
        await server.tell(privmsg("live", msgid="l1", sent=live))
        await until(lambda: [m.content for m in inbound.messages] == ["live"])
        await server.tell("PING :sync")
        await server.wait_for(lambda: bool(server.sent("PONG")))
        # Marked now, a stop before the history arrived would skip it.
        assert not server.sent("MARKREAD")
        server.hold_history.set()
        await until(lambda: len(inbound.messages) == 2)
        await server.wait_for(lambda: server.markers[CHANNEL] == live)
    finally:
        await adapter.stop()


async def test_a_channel_never_read_is_not_read_back(
    server: FakeIrcServer, inbound: Inbound
) -> None:
    server.history[CHANNEL] = [(ago(minutes=1), privmsg("old", sent=ago(minutes=1)))]
    adapter = await started(server, inbound)
    try:
        assert not server.sent("CHATHISTORY")
        assert not inbound.messages
    finally:
        await adapter.stop()


async def test_reading_back_stops_a_day_ago(
    server: FakeIrcServer, inbound: Inbound, caplog: pytest.LogCaptureFixture
) -> None:
    server.markers[CHANNEL] = ago(days=3)
    server.history[CHANNEL] = [
        (sent, privmsg(text, msgid=text.replace(" ", "-"), sent=sent))
        for sent, text in [(ago(days=2), "too old"), (ago(hours=2), "recent")]
    ]
    adapter = await started(server, inbound)
    try:
        await until(lambda: bool(inbound.messages))
        assert [m.content for m in inbound.messages] == ["recent"]
        assert "only that much is read back" in caplog.text
    finally:
        await adapter.stop()


async def test_a_network_without_history_says_what_is_lost(
    server: FakeIrcServer, inbound: Inbound, caplog: pytest.LogCaptureFixture
) -> None:
    del server.caps["draft/chathistory"]
    server.markers[CHANNEL] = ago(minutes=10)
    adapter = await started(server, inbound)
    try:
        assert not server.sent("CHATHISTORY")
        assert "is not relayed" in caplog.text
    finally:
        await adapter.stop()


async def test_only_a_bang_and_a_word_is_a_command(
    server: FakeIrcServer, inbound: Inbound, adapter: IrcAdapter
) -> None:
    for number, text in enumerate(["!!!", "! look at this", "!1 two", "!Reset now"]):
        await server.tell(privmsg(text, msgid=f"b{number}"))
    await until(lambda: len(inbound.messages) == 3 and len(inbound.commands) == 1)
    assert [m.content for m in inbound.messages] == ["!!!", "! look at this", "!1 two"]
    (command,) = inbound.commands
    assert (command.command, command.args) == ("Reset", "now")


async def test_a_message_switch_could_not_take_is_read_back_while_connected(
    server: FakeIrcServer, inbound: Inbound, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The connection stays up, so no join reads the channel back: the
    adapter does, until the message is taken, and the marker then moves."""
    monkeypatch.setattr(adapter_module, "_READ_BACK_RETRY_SECONDS", (0.05,))
    adapter = await started(server, inbound)
    try:
        first, lost = ago(seconds=3), ago(seconds=2)
        await server.tell(privmsg("one", msgid="1", sent=first))
        await server.wait_for(lambda: server.markers.get(CHANNEL) == first)
        inbound.refused = {"lost"}
        raw = privmsg("lost", msgid="2", sent=lost)
        server.history[CHANNEL] = [
            (first, privmsg("one", msgid="1", sent=first)),
            (lost, raw),
        ]
        await server.tell(raw)
        # Read back, and refused again, twice over.
        await server.wait_for(lambda: server.marker_queries >= 2)
        assert server.markers[CHANNEL] == first
        inbound.refused = set()
        await until(lambda: "lost" in [m.content for m in inbound.messages])
        await server.wait_for(lambda: server.markers.get(CHANNEL) == lost)
        assert server.connections == 1
    finally:
        await adapter.stop()


async def test_a_newer_mark_held_during_a_read_back_does_not_skip_a_failure(
    server: FakeIrcServer, inbound: Inbound
) -> None:
    marked, missed = ago(minutes=10), ago(minutes=5)
    server.markers[CHANNEL] = marked
    server.history[CHANNEL] = [(missed, privmsg("lost", msgid="h1", sent=missed))]
    server.hold_history = asyncio.Event()
    inbound.refused = {"lost"}
    adapter = await started(server, inbound)
    try:
        await server.tell(privmsg("live", msgid="l1", sent=ago(seconds=1)))
        await until(lambda: [m.content for m in inbound.messages] == ["live"])
        server.hold_history.set()
        await server.wait_for(lambda: bool(server.sent("CHATHISTORY")))
        await asyncio.sleep(0.1)
        await server.tell("PING :sync")
        await server.wait_for(lambda: bool(server.sent("PONG")))
        # Moving it to `live` would leave `lost` behind it for good.
        assert server.markers[CHANNEL] == marked
    finally:
        await adapter.stop()
