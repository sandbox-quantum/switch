"""The IRC adapter against a scripted server on a local port: signing in,
what reaches Switch, what the bot posts, and the refusals an operator sees."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.irc.adapter import (
    IrcAdapter,
    IrcAuthError,
    IrcConnectionConfig,
    IrcError,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    InboundCommand,
    InboundMessage,
)
from tests.switch_core.bridges.collaboration.irc_fake_server import FakeIrcServer


def _config(port: int, **overrides: Any) -> dict[str, Any]:
    return {
        "server": "127.0.0.1",
        "port": port,
        "tls": False,
        "nick": "switchbot",
        "password": "correct horse",
        "channels": ["#switch"],
        **overrides,
    }


async def _until(check: Any, timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not check():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("timed out")
        await asyncio.sleep(0.01)


class _Started:
    def __init__(self, adapter: IrcAdapter) -> None:
        self.adapter = adapter
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []

    async def start(self) -> None:
        async def on_message(msg: InboundMessage) -> None:
            self.messages.append(msg)

        async def on_command(cmd: InboundCommand) -> None:
            self.commands.append(cmd)

        async def ignore(_event: object) -> None:
            return None

        await self.adapter.start(on_message, on_command, ignore, ignore, ignore)


@pytest.fixture(autouse=True)
def _fast_pacing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "switch_core.bridges.collaboration.irc.adapter._LINE_INTERVAL", 0.001
    )


# ── Config ────────────────────────────────────────────────────────────────


def test_a_valid_config_parses_with_tls_on_by_default() -> None:
    config = IrcConnectionConfig.model_validate(
        {
            "server": "irc.libera.chat",
            "nick": "switch-bot",
            "channels": ["#a", "#A", "&b"],
        }
    )
    assert (config.port, config.tls) == (6697, True)
    assert config.channels == ["#a", "&b"]


@pytest.mark.parametrize(
    ("field", "value", "says"),
    [
        ("nick", "9lives", "nick"),
        ("nick", "has space", "nick"),
        ("channels", ["switch"], "channel"),
        ("channels", ["#a,#b"], "channel"),
        ("channels", [], "at least 1"),
        ("server", "irc.test/path", "host name"),
        ("port", 0, "greater than or equal"),
    ],
)
def test_an_unusable_config_is_refused_with_a_reason(
    field: str, value: Any, says: str
) -> None:
    raw: dict[str, Any] = {"server": "irc.test", "nick": "bot", "channels": ["#a"]}
    raw[field] = value
    with pytest.raises(ValidationError, match=says):
        IrcConnectionConfig.model_validate(raw)


def test_an_account_needs_a_password() -> None:
    with pytest.raises(ValidationError, match="password"):
        IrcConnectionConfig.model_validate(
            {"server": "irc.test", "nick": "bot", "channels": ["#a"], "account": "acct"}
        )


def test_the_server_is_checked_against_the_outbound_policy() -> None:
    assert IrcAdapter.outbound_urls(_config(6697, server="irc.test")) == [
        "https://irc.test:6697"
    ]


# ── Signing in ────────────────────────────────────────────────────────────


async def test_it_logs_in_with_sasl_and_joins_its_channels() -> None:
    async with FakeIrcServer(account="switchbot") as server:
        started = _Started(
            IrcAdapter(config=IrcConnectionConfig(**_config(server.port)))
        )
        await started.start()
        await asyncio.wait_for(server.joined.wait(), 5)
        assert "CAP REQ :account-tag message-tags sasl" in server.received
        assert "AUTHENTICATE PLAIN" in server.received
        assert server.sent("JOIN") == ["JOIN #switch"]
        # Logged in by SASL, so nothing goes to NickServ.
        assert not any("NickServ" in line for line in server.received)
        await started.adapter.stop()


async def test_without_sasl_it_identifies_to_nickserv() -> None:
    async with FakeIrcServer(caps="") as server:
        started = _Started(
            IrcAdapter(config=IrcConnectionConfig(**_config(server.port)))
        )
        await started.start()
        await asyncio.wait_for(server.joined.wait(), 5)
        assert "PRIVMSG NickServ :IDENTIFY switchbot correct horse" in server.received
        await started.adapter.stop()


async def test_wrong_credentials_and_a_taken_nick_are_said_plainly() -> None:
    async with FakeIrcServer(password="something else") as server:
        with pytest.raises(BridgeCredentialError, match="refused the login"):
            await IrcAdapter.verify_credentials(_config(server.port))
    async with FakeIrcServer(refuse_nick="433") as server:
        with pytest.raises(BridgeCredentialError, match="already in use"):
            await IrcAdapter.verify_credentials(_config(server.port))


async def test_an_unreachable_server_is_said_plainly() -> None:
    probe = await asyncio.start_server(lambda r, w: None, "127.0.0.1", 0)
    port = probe.sockets[0].getsockname()[1]
    probe.close()
    await probe.wait_closed()
    with pytest.raises(BridgeCredentialError, match="Could not reach"):
        await IrcAdapter.verify_credentials(_config(port))


async def test_good_credentials_pass_the_check_and_sign_off() -> None:
    async with FakeIrcServer() as server:
        await IrcAdapter.verify_credentials(_config(server.port))
        await _until(lambda: bool(server.sent("QUIT")))


def test_failures_are_classified() -> None:
    assert IrcAdapter.classify_failure(IrcAuthError("x")) == "auth_failed"
    assert IrcAdapter.classify_failure(IrcError("x")) == "network"
    assert IrcAdapter.classify_failure(ValueError("x")) is None


# ── Inbound ───────────────────────────────────────────────────────────────


async def test_what_people_say_reaches_switch() -> None:
    async with FakeIrcServer() as server:
        started = _Started(
            IrcAdapter(config=IrcConnectionConfig(**_config(server.port)))
        )
        await started.start()
        await asyncio.wait_for(server.joined.wait(), 5)
        await server.say(
            "@msgid=m-1;account=alice :Alice!a@host PRIVMSG #Switch :@helper \x02fix\x02 the build"
        )
        await server.say(":Bob!b@host PRIVMSG #switch :!invite-agent @helper")
        await server.say(":Carol!c@host PRIVMSG switchbot :a private word")
        await server.say(":switchbot!bot@test PRIVMSG #switch :my own line")
        await server.say(":Dave!d@host PRIVMSG #switch :\x01VERSION\x01")
        await _until(lambda: len(started.messages) == 2 and len(started.commands) == 1)

        first, private = started.messages
        assert first.model_dump(
            include={
                "channel_id",
                "channel_type",
                "sender_id",
                "sender_name",
                "message_ref",
            }
        ) == {
            "channel_id": "#switch",
            "channel_type": "channel_public",
            "sender_id": "account:alice",
            "sender_name": "Alice",
            "message_ref": "m-1",
        }
        assert (
            started.adapter.translate_inbound(first.content) == "@helper fix the build"
        )
        assert (private.channel_id, private.channel_type, private.sender_id) == (
            "carol",
            "direct",
            "nick:carol",
        )
        [command] = started.commands
        assert (command.command, command.args) == ("invite-agent", "@helper")
        await started.adapter.stop()


async def test_a_nick_without_an_account_cannot_be_linked() -> None:
    assert IrcAdapter.unlinkable_account_reason("nick:carol") is not None
    assert IrcAdapter.unlinkable_account_reason("account:alice") is None


async def test_it_answers_the_servers_pings() -> None:
    async with FakeIrcServer() as server:
        started = _Started(
            IrcAdapter(config=IrcConnectionConfig(**_config(server.port)))
        )
        await started.start()
        await asyncio.wait_for(server.joined.wait(), 5)
        await server.say("PING :are-you-there")
        await _until(lambda: "PONG are-you-there" in server.received)
        await started.adapter.stop()


# ── Outbound ──────────────────────────────────────────────────────────────


async def test_an_agents_reply_is_led_by_its_name_and_split_to_fit() -> None:
    async with FakeIrcServer() as server:
        adapter = IrcAdapter(config=IrcConnectionConfig(**_config(server.port)))
        await _Started(adapter).start()
        await asyncio.wait_for(server.joined.wait(), 5)
        body = adapter.translate_outbound("**Done.**\n" + "word " * 120)
        await adapter.send_message("#switch", "helper", body)
        await _until(lambda: len(server.sent("PRIVMSG")) >= 3)
        lines = server.sent("PRIVMSG")
        assert lines[0] == "PRIVMSG #switch :[helper] \x02Done.\x02"
        assert all(line.startswith("PRIVMSG #switch :[helper] ") for line in lines)
        assert all(len(line.encode()) + 2 <= 512 - 107 for line in lines)
        await adapter.stop()


async def test_a_very_long_reply_says_how_much_it_left_out() -> None:
    async with FakeIrcServer() as server:
        adapter = IrcAdapter(config=IrcConnectionConfig(**_config(server.port)))
        await _Started(adapter).start()
        await asyncio.wait_for(server.joined.wait(), 5)
        await adapter.send_message(
            "#switch", "helper", "\n".join(f"line {i}" for i in range(40))
        )
        await _until(lambda: len(server.sent("PRIVMSG")) == 15)
        assert server.sent("PRIVMSG")[-1].endswith(
            "26 more lines not shown here; the whole reply is in Switch."
        )
        await adapter.stop()


async def test_a_quiet_copy_hands_its_lines_to_the_holder() -> None:
    adapter = IrcAdapter(config=IrcConnectionConfig(**_config(1)))
    adapter.set_listening(False)
    relayed: list[dict[str, str]] = []
    adapter.set_holder_relay(relayed.append)
    # Opens nothing: port 1 would refuse a connection.
    await _Started(adapter).start()
    await adapter.send_message("#switch", "helper", "hello")
    assert len(relayed) == 1
    assert relayed[0].pop("id")
    assert relayed[0] == {
        "action": "send",
        "channel_id": "#switch",
        "sender_name": "helper",
        "content": "hello",
    }


async def test_a_long_message_is_relayed_in_parts_each_with_its_own_id() -> None:
    adapter = IrcAdapter(config=IrcConnectionConfig(**_config(1)))
    adapter.set_listening(False)
    relayed: list[dict[str, str]] = []
    adapter.set_holder_relay(relayed.append)
    await _Started(adapter).start()
    body = "\n".join(f"line {n} " + "x" * 400 for n in range(40))
    await adapter.send_message("#switch", "helper", body)
    assert len(relayed) > 1
    assert all(len(r["content"].encode()) <= 6000 for r in relayed)
    assert len({r["id"] for r in relayed}) == len(relayed)
    assert "\n".join(r["content"] for r in relayed) == body
    # Two identical messages are two requests, not one.
    relayed.clear()
    await adapter.send_message("#switch", "helper", "same")
    await adapter.send_message("#switch", "helper", "same")
    assert len({r["id"] for r in relayed}) == 2


async def test_a_retried_relay_does_not_post_the_lines_it_already_sent() -> None:
    async with FakeIrcServer() as server:
        adapter = IrcAdapter(config=IrcConnectionConfig(**_config(server.port)))
        await _Started(adapter).start()
        await asyncio.wait_for(server.joined.wait(), 5)
        request = {
            "action": "send",
            "id": "r1",
            "channel_id": "#switch",
            "sender_name": "Switch",
            "content": "one\ntwo\nthree",
        }
        real_write = adapter._write
        calls = 0

        async def flaky(command: str, *params: str) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("connection dropped")
            await real_write(command, *params)

        adapter._write = flaky  # type: ignore[method-assign]
        with pytest.raises(RuntimeError):
            await adapter.receive_relayed(request)
        await adapter.receive_relayed(request)  # the relay retries the request
        await adapter.receive_relayed(request)  # and a redelivery changes nothing
        await _until(lambda: "PRIVMSG #switch :[Switch] three" in server.received)
        sent = [m for m in server.received if m.startswith("PRIVMSG #switch")]
        assert sent == [
            "PRIVMSG #switch :[Switch] one",
            "PRIVMSG #switch :[Switch] two",
            "PRIVMSG #switch :[Switch] three",
        ]
        await adapter.stop()


async def test_the_holder_posts_what_a_quiet_copy_handed_it() -> None:
    async with FakeIrcServer() as server:
        adapter = IrcAdapter(config=IrcConnectionConfig(**_config(server.port)))
        await _Started(adapter).start()
        await asyncio.wait_for(server.joined.wait(), 5)
        await adapter.receive_relayed(
            {
                "action": "send",
                "channel_id": "#switch",
                "sender_name": "Switch",
                "content": "hi",
            }
        )
        await _until(lambda: "PRIVMSG #switch :[Switch] hi" in server.received)
        await adapter.stop()


async def test_sending_while_disconnected_is_refused() -> None:
    adapter = IrcAdapter(config=IrcConnectionConfig(**_config(1)))
    with pytest.raises(BridgeOperationError, match="not connected"):
        await adapter.send_message("#switch", "helper", "hello")


async def test_what_irc_cannot_do_is_declared() -> None:
    assert IrcAdapter.supports_channel_creation is False
    assert IrcAdapter.supports_directory_search is False
    assert IrcAdapter.keeps_quiet_unless_listening is True
    adapter = IrcAdapter(config=IrcConnectionConfig(**_config(1)))
    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("new", "topic")
    assert await adapter.get_channel_type("#switch") == "channel_public"
    assert await adapter.get_channel_type("carol") == "direct"
    assert await adapter.add_users_to_channel("#switch", ["eve"], ["nick:eve"]) == [
        "nick:eve"
    ]
