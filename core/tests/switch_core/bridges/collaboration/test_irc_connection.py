"""One IRC connection: logging in, keeping alive, and pacing what it writes."""

from __future__ import annotations

import asyncio
import contextlib
import time

import pytest

from switch_core.bridges.collaboration.irc import client as client_module
from switch_core.bridges.collaboration.irc.client import (
    IrcConnection,
    IrcDisconnected,
    Outbox,
    Settings,
)
from switch_core.bridges.collaboration.irc.protocol import Line, build

from .irc_fakes import FakeIrcServer


def _settings(server: FakeIrcServer, **overrides: object) -> Settings:
    values: dict[str, object] = {
        "host": "127.0.0.1",
        "port": server.port,
        "tls": server.tls,
        "verify_tls": False,
        "nick": "switchbot",
        "username": "switchbot",
        "realname": "Switch bridge",
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


async def _open(
    server: FakeIrcServer, *, outbox: Outbox | None = None, **overrides: object
) -> tuple[IrcConnection, list[Line]]:
    seen: list[Line] = []

    async def on_line(line: Line) -> None:
        seen.append(line)

    connection = IrcConnection(
        _settings(server, **overrides), on_line=on_line, outbox=outbox, pace=0.05
    )
    await connection.open("127.0.0.1")
    return connection, seen


async def test_requests_only_the_capabilities_it_uses() -> None:
    async with FakeIrcServer(caps=("server-time", "echo-message", "batch")) as server:
        connection, _ = await _open(server)
        await connection.close()
    assert "CAP REQ :server-time batch" in server.received
    assert connection.server.caps == {"server-time", "batch"}


async def test_asks_for_sasl_only_with_a_login() -> None:
    async with FakeIrcServer() as server:
        connection, _ = await _open(server)
        await connection.close()
    request = next(line for line in server.received if line.startswith("CAP REQ"))
    assert "sasl" not in request
    assert connection.logged_in_as is None


async def test_logs_in_with_sasl_and_reads_the_network() -> None:
    async with FakeIrcServer(tls=True) as server:
        connection, _ = await _open(server, account="switchbot", password="s3cret")
        await connection.close()
    assert connection.logged_in_as == "switchbot"
    assert connection.server.network == "Fake"
    assert connection.server.chantypes == "#&"


async def test_registers_under_a_fallback_while_the_nick_is_held() -> None:
    async with FakeIrcServer(taken={"switchbot"}) as server:
        connection, _ = await _open(server)
        assert connection.nick == "switchbot_"
        server.taken.clear()
        task = asyncio.create_task(connection.run())
        server.say(":fake PING :later")
        await server.wait_for(lambda line: line == "NICK switchbot")
        await asyncio.sleep(0.1)
        assert connection.nick == "switchbot"
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, IrcDisconnected):
            await task


async def test_answers_ping_and_hands_other_lines_on() -> None:
    async with FakeIrcServer() as server:
        connection, seen = await _open(server)
        task = asyncio.create_task(connection.run())
        server.say(":fake PING :abc")
        server.say(":ada!a@h PRIVMSG #c :hi")
        await server.wait_for(lambda line: line == "PONG abc")
        await asyncio.sleep(0.1)
        assert [line.command for line in seen] == ["PRIVMSG"]
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, IrcDisconnected):
            await task


async def test_pings_an_idle_server_and_drops_a_silent_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(client_module, "IDLE_PING_AFTER", 0.2)
    monkeypatch.setattr(client_module, "PONG_WITHIN", 0.2)
    async with FakeIrcServer() as server:
        connection, _ = await _open(server)
        server.received.clear()
        # The fake answers PING, so stop it reading: a server gone silent.
        for client in server.clients:
            client.writer.transport.pause_reading()  # type: ignore[attr-defined]
        with pytest.raises(IrcDisconnected, match="stopped answering"):
            await asyncio.wait_for(connection.run(), timeout=5)


async def test_a_handler_that_fails_does_not_end_the_connection() -> None:
    async with FakeIrcServer() as server:
        calls: list[str] = []

        async def on_line(line: Line) -> None:
            calls.append(line.command)
            if len(calls) == 1:
                raise RuntimeError("boom")

        connection = IrcConnection(_settings(server), on_line=on_line, pace=0.05)
        await connection.open("127.0.0.1")
        task = asyncio.create_task(connection.run())
        server.say(":ada!a@h PRIVMSG #c :one")
        server.say(":ada!a@h PRIVMSG #c :two")
        for _ in range(100):
            if len(calls) == 2:
                break
            await asyncio.sleep(0.02)
        assert calls == ["PRIVMSG", "PRIVMSG"]
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, IrcDisconnected):
            await task


async def test_paces_after_a_burst() -> None:
    async with FakeIrcServer() as server:
        connection = IrcConnection(
            _settings(server), on_line=_ignore, burst=3, pace=0.2
        )
        await connection.open("127.0.0.1")
        started = time.monotonic()
        for n in range(6):
            connection.send(build("PRIVMSG", "#c", f"line {n}"))
        await server.wait_for(lambda line: line == "PRIVMSG #c :line 5", timeout=5)
        elapsed = time.monotonic() - started
        await connection.close()
    # Three at once, then three more a pace apart.
    assert 0.45 <= elapsed < 1.5


async def test_channel_upkeep_goes_ahead_of_a_long_reply() -> None:
    async with FakeIrcServer() as server:
        connection = IrcConnection(
            _settings(server), on_line=_ignore, burst=1, pace=0.1
        )
        await connection.open("127.0.0.1")
        for n in range(5):
            connection.send(build("PRIVMSG", "#c", f"part {n}"))
        connection.send(build("JOIN", "#new"), urgent=True)
        await server.wait_for(lambda line: line == "PRIVMSG #c :part 4", timeout=5)
        await connection.close()
    order = [
        line for line in server.received if line.startswith(("PRIVMSG #c", "JOIN"))
    ]
    assert order.index("JOIN #new") <= 1


async def test_lines_queued_while_disconnected_go_out_on_the_next_connection() -> None:
    outbox = Outbox()
    async with FakeIrcServer() as server:
        first, _ = await _open(server, outbox=outbox)
        await first.close()
        outbox.put(build("PRIVMSG", "#c", "kept across the drop"))
        second, _ = await _open(server, outbox=outbox)
        await server.wait_for(lambda line: line == "PRIVMSG #c :kept across the drop")
        await second.close()


async def test_learns_its_own_prefix_from_its_join() -> None:
    async with FakeIrcServer() as server:
        connection, _ = await _open(server)
        before = connection.relay_prefix_bytes()
        task = asyncio.create_task(connection.run())
        connection.send(build("JOIN", "#c"), urgent=True)
        for _ in range(100):
            if connection.relay_prefix_bytes() != before:
                break
            await asyncio.sleep(0.02)
        assert connection.relay_prefix_bytes() == len(":switchbot!bot@fake.host ")
        assert connection.text_budget("PRIVMSG", "#c") == (
            512 - len(":switchbot!bot@fake.host ") - len("PRIVMSG #c :") - 2
        )
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, IrcDisconnected):
            await task


async def test_before_it_knows_its_prefix_it_reserves_the_longest() -> None:
    async with FakeIrcServer() as server:
        connection, _ = await _open(server)
        await connection.close()
    # nick plus every fallback underscore, an 11-byte user and a 63-byte host.
    assert (
        connection.relay_prefix_bytes() == 1 + len("switchbot___") + 1 + 11 + 1 + 63 + 1
    )


async def _ignore(line: Line) -> None:
    return None
