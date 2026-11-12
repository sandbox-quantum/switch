"""The bot's connection, against an IRC server on a local socket: who opens
it, how it registers, how fast it sends, and how it comes back."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest

from switch_core.bridges.collaboration.irc import client as client_module
from switch_core.bridges.collaboration.irc.client import (
    IrcLoginRefused,
    IrcNotConnected,
    IrcSession,
)
from switch_core.bridges.collaboration.irc.protocol import Line
from switch_core.outbound import OutboundPolicy, OutboundURLRefused
from tests.switch_core.bridges.collaboration.irc_fakes import (
    CHANNEL,
    NICK,
    PASSWORD,
    FakeIrcServer,
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


class Lines:
    def __init__(self) -> None:
        self.seen: list[Line] = []
        self.registered = 0

    async def line(self, line: Line) -> None:
        self.seen.append(line)

    def on_registered(self) -> None:
        self.registered += 1


def _session(
    server: FakeIrcServer,
    lines: Lines,
    *,
    host: str = "127.0.0.1",
    password: str | None = None,
    resolve: OutboundPolicy | None = None,
) -> IrcSession:
    policy = resolve or OutboundPolicy.parse("127.0.0.0/8")
    return IrcSession(
        host=host,
        port=server.port,
        ssl_context=None,
        resolve=policy.resolve,
        nick=NICK,
        account=None,
        password=password,
        on_line=lines.line,
        on_registered=lines.on_registered,
    )


async def test_registration_asks_only_for_what_the_bridge_uses(
    server: FakeIrcServer,
) -> None:
    session = _session(server, Lines())
    await session.start()
    try:
        (request,) = [line for line in server.sent("CAP") if line.params[0] == "REQ"]
        assert request.params[1].split() == [
            "account-notify",
            "account-tag",
            "batch",
            "draft/chathistory",
            "draft/read-marker",
            "message-tags",
            "server-time",
        ]
        assert session.registered and session.nick == NICK
    finally:
        await session.stop()


async def test_the_server_is_answered_when_it_pings(server: FakeIrcServer) -> None:
    session = _session(server, Lines())
    await session.start()
    try:
        await server.tell("PING :are-you-there")
        await server.wait_for(lambda: bool(server.sent("PONG")))
        assert server.sent("PONG")[0].params == ("are-you-there",)
    finally:
        await session.stop()


async def test_a_quiet_server_is_pinged_and_a_silent_one_dropped(
    server: FakeIrcServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(client_module, "_IDLE_SECONDS", 0.1)
    session = _session(server, Lines())
    await session.start()
    try:
        await server.wait_for(lambda: bool(server.sent("PING")))
        # The fake answers pings, so the connection stays.
        await asyncio.sleep(0.3)
        assert server.connections == 1
    finally:
        await session.stop()


async def test_the_bot_dials_the_address_the_policy_allowed(
    server: FakeIrcServer,
) -> None:
    asked: list[tuple[str, int]] = []

    class Pinned(OutboundPolicy):
        async def resolve(self, hostname: str, port: int) -> list[str]:
            asked.append((hostname, port))
            return ["127.0.0.1"]

    # `irc.example.test` resolves nowhere: only the checked address is dialled.
    session = _session(
        server,
        Lines(),
        host="irc.example.test",
        resolve=Pinned(frozenset(), ()),
    )
    await session.start()
    try:
        assert asked == [("irc.example.test", server.port)]
        assert session.registered
    finally:
        await session.stop()


async def test_a_server_the_policy_refuses_is_never_dialled(
    server: FakeIrcServer,
) -> None:
    session = _session(server, Lines(), resolve=OutboundPolicy.parse(""))
    with pytest.raises(OutboundURLRefused):
        await session.start()
    await session.stop()
    assert server.connections == 0


async def test_a_refused_login_fails_the_start(server: FakeIrcServer) -> None:
    session = _session(server, Lines(), password="not-the-password")
    with pytest.raises(IrcLoginRefused, match="SASL authentication failed"):
        await session.start()
    await session.stop()
    assert server.connections == 1


async def test_a_login_refused_after_a_drop_is_tried_again(
    server: FakeIrcServer,
) -> None:
    session = _session(server, Lines(), password=PASSWORD)
    await session.start()
    try:
        server.accounts[NICK] = "changed-elsewhere"
        await server.drop()
        await server.wait_for(lambda: server.connections >= 3)
        assert not session.registered
    finally:
        await session.stop()


async def test_a_taken_nick_is_registered_with_underscores_and_taken_back(
    server: FakeIrcServer,
) -> None:
    server.taken = {NICK}
    session = _session(server, Lines())
    await session.start()
    try:
        assert session.nick == f"{NICK}_"
        server.taken = set()
        await server.tell("PING :later")
        await until(lambda: session.nick == NICK)
    finally:
        await session.stop()


async def test_a_dropped_connection_comes_back_and_rejoins(
    server: FakeIrcServer,
) -> None:
    lines = Lines()
    session = _session(server, lines)
    session.join(CHANNEL)
    await session.start()
    try:
        await server.wait_for(lambda: len(server.sent("JOIN")) == 1)
        await server.drop()
        await server.wait_for(lambda: len(server.sent("JOIN")) == 2)
        assert server.connections == 2
        assert lines.registered == 2
        assert [r.connection for r in server.received if r.line.command == "JOIN"] == [
            1,
            2,
        ]
    finally:
        await session.stop()


async def test_lines_queued_when_the_connection_drops_fail_rather_than_wait(
    server: FakeIrcServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(client_module, "_LINE_INTERVAL_SECONDS", 10.0)
    monkeypatch.setattr(client_module, "_BURST", 1)
    session = _session(server, Lines())
    await session.start()
    try:
        sending = asyncio.create_task(session.send(CHANNEL, ["one", "two"]))
        await server.wait_for(lambda: server.said() == ["one"])
        await server.drop()
        with pytest.raises(IrcNotConnected):
            await sending
        assert server.said() == ["one"]
    finally:
        await session.stop()


async def test_a_send_waiting_on_no_connection_is_refused(
    server: FakeIrcServer,
) -> None:
    session = _session(server, Lines())
    with pytest.raises(IrcNotConnected):
        await session.send(CHANNEL, ["hi"])
    assert server.connections == 0


async def test_a_queued_line_waits_for_a_connection_and_survives_a_drop(
    server: FakeIrcServer,
) -> None:
    session = _session(server, Lines())
    session.queue(CHANNEL, ["said once connected"])
    await session.start()
    try:
        await server.wait_for(lambda: server.said() == ["said once connected"])
        server.taken = {NICK, f"{NICK}_", f"{NICK}__", f"{NICK}___"}
        await server.drop()
        await server.wait_for(lambda: server.connections >= 2)
        session.queue(CHANNEL, ["said after the drop"])
        server.taken = set()
        await server.wait_for(lambda: len(server.said()) == 2)
        assert server.said()[-1] == "said after the drop"
    finally:
        await session.stop()


async def test_every_allowed_address_is_tried_in_turn(server: FakeIrcServer) -> None:
    class TwoAddresses(OutboundPolicy):
        async def resolve(self, hostname: str, port: int) -> list[str]:
            # Nothing listens on the first.
            return ["127.0.0.2", "127.0.0.1"]

    session = _session(server, Lines(), resolve=TwoAddresses(frozenset(), ()))
    await session.start()
    try:
        assert session.registered
    finally:
        await session.stop()


async def test_a_nick_still_taken_is_waited_out_rather_than_refused(
    server: FakeIrcServer,
) -> None:
    server.taken = {NICK, f"{NICK}_", f"{NICK}__", f"{NICK}___"}
    session = _session(server, Lines())
    await session.start()
    try:
        assert not session.registered
        server.taken = set()
        await until(lambda: session.registered)
        assert session.nick == NICK
    finally:
        await session.stop()


async def test_stopping_while_still_connecting_ends_the_start(
    server: FakeIrcServer,
) -> None:
    server.silent = True
    session = _session(server, Lines())
    starting = asyncio.create_task(session.start())
    await server.wait_for(lambda: server.connections == 1)
    await session.stop()
    with pytest.raises(IrcNotConnected):
        async with asyncio.timeout(2):
            await starting


async def test_lines_go_out_in_a_burst_then_at_the_pace_the_network_allows(
    server: FakeIrcServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(client_module, "_BURST", 3)
    monkeypatch.setattr(client_module, "_LINE_INTERVAL_SECONDS", 0.1)
    session = _session(server, Lines())
    await session.start()
    try:
        await session.send(CHANNEL, [f"line {n}" for n in range(7)])
        await server.wait_for(lambda: len(server.said()) == 7)
        times = [r.at for r in server.received if r.line.command == "PRIVMSG"]
        gaps = [later - earlier for earlier, later in zip(times, times[1:])]
        assert server.said() == [f"line {n}" for n in range(7)]
        assert sum(gaps[:2]) < 0.05
        assert all(gap >= 0.08 for gap in gaps[2:])
    finally:
        await session.stop()


async def test_joining_does_not_wait_behind_a_long_reply(
    server: FakeIrcServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(client_module, "_BURST", 1)
    monkeypatch.setattr(client_module, "_LINE_INTERVAL_SECONDS", 0.05)
    session = _session(server, Lines())
    await session.start()
    try:
        session.queue(CHANNEL, [f"line {n}" for n in range(6)])
        session.join("#deploys")
        await server.wait_for(lambda: len(server.said()) == 6)
        order = [r.line.command for r in server.received if r.connection == 1]
        assert order.index("JOIN") < order.index("PRIVMSG")
    finally:
        await session.stop()


async def test_stopping_first_finishes_what_is_being_said(
    server: FakeIrcServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(client_module, "_BURST", 1)
    monkeypatch.setattr(client_module, "_LINE_INTERVAL_SECONDS", 0.05)
    session = _session(server, Lines())
    await session.start()
    session.queue(CHANNEL, [f"line {n}" for n in range(4)])
    await session.stop()
    await server.wait_for(lambda: bool(server.sent("QUIT")))
    commands = [r.line.command for r in server.received]
    assert server.said() == [f"line {n}" for n in range(4)]
    assert commands.index("QUIT") > max(
        i for i, command in enumerate(commands) if command == "PRIVMSG"
    )


async def test_stopping_says_goodbye_and_closes(server: FakeIrcServer) -> None:
    session = _session(server, Lines())
    await session.start()
    await session.stop()
    await server.wait_for(lambda: server.open == 0)
    assert server.sent("QUIT")


async def test_a_quiet_copy_opens_no_connection(server: FakeIrcServer) -> None:
    adapter = await started(server, listening=False)
    await asyncio.sleep(0.1)
    assert server.connections == 0
    await adapter.stop()


async def test_messages_reach_the_handler_in_order_while_one_is_slow(
    server: FakeIrcServer,
) -> None:
    seen: list[str] = []
    release = asyncio.Event()

    class Slow(Lines):
        async def line(self, line: Line) -> None:
            if line.command == "PRIVMSG" and line.params[1] == "first":
                await release.wait()
            seen.append(line.params[-1])

    session = _session(server, Slow())
    await session.start()
    try:
        await server.tell(privmsg("first", msgid="1"))
        await server.tell(privmsg("second", msgid="2"))
        # The slow handler does not keep the server from being answered.
        await server.tell("PING :still-there")
        await server.wait_for(lambda: bool(server.sent("PONG")))
        release.set()
        await until(lambda: len(seen) == 2)
        assert seen == ["first", "second"]
    finally:
        await session.stop()


async def test_a_connection_that_drops_at_once_is_dialled_less_and_less_often(
    server: FakeIrcServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A server that welcomes the bot and closes the link at once (a ban, a
    flood limit) must not be dialled every second."""
    delays: list[float] = []

    def jittered(delay: float) -> float:
        delays.append(delay)
        return 0.001

    monkeypatch.setattr(client_module, "_jittered", jittered)
    lines = Lines()
    session = _session(server, lines)
    await session.start()
    try:
        for connection in (1, 2, 3):
            await until(lambda n=connection: lines.registered == n)
            assert server.connections == connection
            await server.drop()
        await until(lambda: len(delays) == 3)
        assert delays == [0.01, 0.02, 0.04]
    finally:
        await session.stop()


async def test_a_connection_that_stayed_up_is_dialled_again_at_once(
    server: FakeIrcServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    delays: list[float] = []

    def jittered(delay: float) -> float:
        delays.append(delay)
        return 0.001

    monkeypatch.setattr(client_module, "_jittered", jittered)
    monkeypatch.setattr(client_module, "_STABLE_SECONDS", 0.0)
    lines = Lines()
    session = _session(server, lines)
    await session.start()
    try:
        for connection in (1, 2, 3):
            await until(lambda n=connection: lines.registered == n)
            await server.drop()
        await until(lambda: len(delays) == 3)
        assert delays == [0.01, 0.01, 0.01]
    finally:
        await session.stop()


async def test_a_send_cut_short_by_a_drop_says_how_many_lines_went_out(
    server: FakeIrcServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(client_module, "_LINE_INTERVAL_SECONDS", 10.0)
    monkeypatch.setattr(client_module, "_BURST", 1)
    session = _session(server, Lines())
    await session.start()
    try:
        sending = asyncio.create_task(session.send(CHANNEL, ["one", "two", "three"]))
        await server.wait_for(lambda: server.said() == ["one"])
        await server.drop()
        with pytest.raises(IrcNotConnected) as cut:
            await sending
        assert cut.value.written == 1
    finally:
        await session.stop()
