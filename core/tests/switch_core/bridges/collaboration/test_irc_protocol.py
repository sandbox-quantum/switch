"""The IRC wire format: parsing a line into its tags/prefix/command/params,
building one back, and the SASL PLAIN payload. All pure functions."""

from __future__ import annotations

import base64

from switch_core.bridges.collaboration.irc.protocol import (
    format_line,
    parse_line,
    sasl_plain_payload,
)


def test_parses_a_plain_privmsg() -> None:
    line = parse_line(":nick!user@host PRIVMSG #switch :hello there")
    assert line.prefix == "nick!user@host"
    assert line.nick == "nick"
    assert line.command == "PRIVMSG"
    assert line.params == ["#switch", "hello there"]
    assert line.trailing == "hello there"


def test_parses_a_line_with_no_prefix() -> None:
    line = parse_line("PING :irc.example.net")
    assert line.prefix is None
    assert line.command == "PING"
    assert line.params == ["irc.example.net"]


def test_parses_message_tags() -> None:
    line = parse_line(
        "@msgid=abc123;time=2024-01-01T00:00:00.000Z :nick!u@h PRIVMSG #c :hi"
    )
    assert line.tags == {"msgid": "abc123", "time": "2024-01-01T00:00:00.000Z"}
    assert line.command == "PRIVMSG"


def test_unescapes_tag_values() -> None:
    line = parse_line(r"@note=a\sb\:c\\d :nick!u@h PRIVMSG #c :hi")
    assert line.tags["note"] == "a b;c\\d"


def test_a_colon_free_trailing_free_line_splits_on_spaces() -> None:
    line = parse_line("CAP * ACK :sasl")
    assert line.command == "CAP"
    assert line.params == ["*", "ACK", "sasl"]


def test_a_param_with_no_trailing_marker() -> None:
    line = parse_line("JOIN #switch")
    assert line.command == "JOIN"
    assert line.params == ["#switch"]


def test_format_line_puts_a_leading_colon_on_a_trailing_param_with_a_space() -> None:
    assert (
        format_line("PRIVMSG", ["#switch", "hello there"])
        == "PRIVMSG #switch :hello there"
    )


def test_format_line_leaves_a_single_word_param_bare() -> None:
    assert format_line("JOIN", ["#switch"]) == "JOIN #switch"


def test_format_line_quotes_an_empty_trailing_param() -> None:
    assert format_line("PRIVMSG", ["#switch", ""]) == "PRIVMSG #switch :"


def test_format_line_never_lets_a_crlf_through() -> None:
    # The caller is responsible for never passing one (chunking.split_to_lines
    # strips CR/LF before this is called), but this is the last line standing
    # between a value and the wire, so it is asserted here too.
    line = format_line("PRIVMSG", ["#switch", "a\r\nQUIT"])
    assert "\r" not in line
    assert "\n" not in line


def test_sasl_plain_payload_is_authzid_authcid_password_base64() -> None:
    payload = sasl_plain_payload("alice", "s3cret")
    decoded = base64.b64decode(payload)
    assert decoded == b"\0alice\0s3cret"
