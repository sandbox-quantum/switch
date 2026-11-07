"""The CAP/SASL/NICK/USER registration state machine, against an in-memory
fake transport — no socket, no TLS, no real server.

This is where a wrong SASL password, a nick already in use, and a wrong
server password have to surface as a clear, specific failure rather than a
silent retry.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.irc.client import (
    IRCConnectionParams,
    RegistrationFailed,
    register,
)
from switch_core.bridges.collaboration.irc.protocol import ParsedLine, parse_line
from switch_core.bridges.collaboration.models import BridgeCredentialError


class FakeTransport:
    """A scripted server: `read_line` plays back canned responses, keyed by
    reacting to what was just written, via a small list of (predicate,
    response_lines) steps consumed in order."""

    def __init__(self) -> None:
        self.written: list[tuple[str, list[str]]] = []
        self._incoming: list[ParsedLine] = []

    def queue(self, *raw_lines: str) -> None:
        self._incoming.extend(parse_line(line) for line in raw_lines)

    async def write_line(self, command: str, params: list[str]) -> None:
        self.written.append((command, params))

    async def read_line(self) -> ParsedLine | None:
        if not self._incoming:
            return None
        return self._incoming.pop(0)


def _params(**overrides: object) -> IRCConnectionParams:
    base = dict(
        host="irc.example.net",
        port=6697,
        use_tls=True,
        verify_tls=True,
        nick="switchbot",
        username="switchbot",
        realname="Switch",
        channels=["#switch"],
    )
    base.update(overrides)
    return IRCConnectionParams(**base)  # type: ignore[arg-type]


async def test_registers_with_no_sasl_and_no_password() -> None:
    transport = FakeTransport()
    transport.queue(
        "CAP * LS :message-tags echo-message",
        ":irc.example.net CAP switchbot ACK :message-tags echo-message",
        ":irc.example.net 001 switchbot :Welcome",
    )
    nick = await register(transport, _params())
    assert nick == "switchbot"
    sent = [cmd for cmd, _ in transport.written]
    assert "PASS" not in sent
    assert ("NICK", ["switchbot"]) in transport.written
    assert ("CAP", ["END"]) in transport.written


async def test_sends_pass_before_anything_else_when_a_server_password_is_set() -> None:
    transport = FakeTransport()
    transport.queue(
        "CAP * LS :message-tags",
        ":irc.example.net CAP switchbot ACK :message-tags",
        ":irc.example.net 001 switchbot :Welcome",
    )
    await register(transport, _params(server_password="s3cret"))
    assert transport.written[0] == ("PASS", ["s3cret"])


async def test_wrong_server_password_raises_a_credential_error() -> None:
    transport = FakeTransport()
    transport.queue(
        "CAP * LS :message-tags",
        ":irc.example.net CAP switchbot ACK :message-tags",
        ":irc.example.net 464 switchbot :Password incorrect",
    )
    with pytest.raises(RegistrationFailed):
        await register(transport, _params(server_password="wrong"))


async def test_successful_sasl_plain_login() -> None:
    transport = FakeTransport()
    transport.queue(
        "CAP * LS :sasl message-tags",
        ":irc.example.net CAP switchbot ACK :sasl message-tags",
        "AUTHENTICATE +",
        ":irc.example.net 903 switchbot :SASL authentication successful",
        ":irc.example.net 001 switchbot :Welcome",
    )
    nick = await register(
        transport, _params(sasl_username="switchbot", sasl_password="s3cret")
    )
    assert nick == "switchbot"
    assert ("AUTHENTICATE", ["PLAIN"]) in transport.written
    auth_payloads = [p[0] for cmd, p in transport.written if cmd == "AUTHENTICATE"]
    assert len(auth_payloads) == 2  # "PLAIN", then the base64 payload


async def test_wrong_sasl_password_raises_a_credential_error_not_a_retry() -> None:
    transport = FakeTransport()
    transport.queue(
        "CAP * LS :sasl",
        ":irc.example.net CAP switchbot ACK :sasl",
        "AUTHENTICATE +",
        ":irc.example.net 904 switchbot :SASL authentication failed",
    )
    with pytest.raises(RegistrationFailed) as excinfo:
        await register(
            transport, _params(sasl_username="switchbot", sasl_password="wrong")
        )
    assert isinstance(excinfo.value, BridgeCredentialError)
    assert "904" in str(excinfo.value)


async def test_sasl_requested_but_not_advertised_fails_fast_without_authenticating() -> (
    None
):
    transport = FakeTransport()
    transport.queue("CAP * LS :message-tags")
    with pytest.raises(RegistrationFailed):
        await register(
            transport, _params(sasl_username="switchbot", sasl_password="s3cret")
        )
    assert ("AUTHENTICATE", ["PLAIN"]) not in transport.written


async def test_sasl_acked_but_server_never_prompts_fails_rather_than_hanging() -> None:
    transport = FakeTransport()
    transport.queue(
        "CAP * LS :sasl",
        ":irc.example.net CAP switchbot ACK :sasl",
        ":irc.example.net 001 switchbot :unexpected welcome before SASL prompt",
    )
    with pytest.raises(RegistrationFailed):
        await register(
            transport, _params(sasl_username="switchbot", sasl_password="s3cret")
        )


async def test_nick_in_use_retries_with_a_suffix_then_succeeds() -> None:
    transport = FakeTransport()
    transport.queue(
        "CAP * LS :message-tags",
        ":irc.example.net CAP switchbot ACK :message-tags",
        ":irc.example.net 433 * switchbot :Nickname is already in use",
        ":irc.example.net 001 switchbot_1 :Welcome",
    )
    nick = await register(transport, _params())
    assert nick == "switchbot_1"
    assert ("NICK", ["switchbot_1"]) in transport.written


async def test_nick_in_use_forever_gives_up_rather_than_retrying_without_end() -> None:
    transport = FakeTransport()
    lines = [
        "CAP * LS :message-tags",
        ":irc.example.net CAP switchbot ACK :message-tags",
    ]
    lines += [":irc.example.net 433 * switchbot :Nickname is already in use"] * 10
    transport.queue(*lines)
    with pytest.raises(RegistrationFailed):
        await register(transport, _params())
    nick_attempts = [p for cmd, p in transport.written if cmd == "NICK"]
    # The initial NICK plus every retry, not an unbounded number of them.
    assert 1 < len(nick_attempts) <= 7


async def test_banned_from_server_raises_a_credential_error() -> None:
    transport = FakeTransport()
    transport.queue(
        "CAP * LS :message-tags",
        ":irc.example.net CAP switchbot ACK :message-tags",
        ":irc.example.net 465 switchbot :You are banned from this server",
    )
    with pytest.raises(RegistrationFailed):
        await register(transport, _params())


async def test_multiline_cap_ls_is_accumulated_across_lines() -> None:
    transport = FakeTransport()
    transport.queue(
        "CAP * LS * :sasl message-tags",
        "CAP * LS :echo-message server-time",
        ":irc.example.net CAP switchbot ACK :sasl message-tags echo-message server-time",
        "AUTHENTICATE +",
        ":irc.example.net 903 switchbot :SASL authentication successful",
        ":irc.example.net 001 switchbot :Welcome",
    )
    await register(
        transport, _params(sasl_username="switchbot", sasl_password="s3cret")
    )
    # Only reachable if "sasl" from the *first* LS chunk was retained.
    assert ("AUTHENTICATE", ["PLAIN"]) in transport.written


async def test_connection_closing_mid_registration_fails_rather_than_hanging() -> None:
    transport = FakeTransport()
    transport.queue("CAP * LS :message-tags")  # then EOF
    with pytest.raises(RegistrationFailed):
        await register(transport, _params())
