"""The IRC wire format and text conversions, with no connection at all."""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.irc.protocol import (
    BOLD,
    build_line,
    irc_to_markdown,
    is_channel,
    is_valid_nick,
    markdown_to_irc,
    normalize_target,
    parse_line,
    payload_budget,
    split_message,
    strip_formatting,
)


def test_parse_line_reads_tags_prefix_and_trailing() -> None:
    msg = parse_line(
        r"@msgid=abc;account=alice;+note=a\sb\:c :alice!a@host PRIVMSG #ops :hello there"
    )
    assert msg.command == "PRIVMSG"
    assert msg.params == ["#ops", "hello there"]
    assert msg.nick == "alice"
    assert msg.tags == {"msgid": "abc", "account": "alice", "+note": "a b;c"}


def test_parse_line_numeric_without_prefix_or_trailing() -> None:
    msg = parse_line("PING srv.example")
    assert (msg.command, msg.params, msg.prefix) == ("PING", ["srv.example"], None)


def test_build_line_cannot_be_used_to_smuggle_a_second_command() -> None:
    line = build_line("PRIVMSG", "#ops", "hi\r\nQUIT :bye")
    assert line.count("\r\n") == 1
    assert line.endswith("\r\n")
    assert "QUIT" in line  # kept as text, on the same line
    with pytest.raises(ValueError):
        build_line("PRIVMSG", "#a b", "hi")


def test_names() -> None:
    assert is_channel("#ops") and is_channel("&local")
    assert not is_channel("alice") and not is_channel("#bad name")
    assert is_valid_nick("switch-bot") and is_valid_nick("[away]")
    assert not is_valid_nick("1abc") and not is_valid_nick("has space")
    assert normalize_target("#Ops[1]") == "#ops{1}"


def test_split_message_keeps_every_line_inside_the_byte_limit() -> None:
    text = "word " * 200 + "\n\nsecond paragraph é" * 3
    lines = split_message(text, 100)
    assert all(len(line.encode()) <= 100 for line in lines)
    assert all(line.strip() for line in lines)
    assert " ".join(lines).split() == text.split()


def test_split_message_never_cuts_a_utf8_character() -> None:
    lines = split_message("ü" * 300, 51)
    assert all(len(line.encode()) <= 51 for line in lines)
    assert "".join(lines) == "ü" * 300


def test_payload_budget_leaves_room_for_the_relayed_prefix() -> None:
    budget = payload_budget("switch-bot", "#ops")
    line = build_line("PRIVMSG", "#ops", "x" * budget)
    relayed = ":switch-bot!" + "u" * 10 + "@" + "h" * 63 + " " + line
    assert len(relayed.encode()) <= 512


def test_markdown_to_irc() -> None:
    out = markdown_to_irc("**Done**: see [the PR](https://x.test/1)\n```\ncode\n```")
    assert split_message(out, 400) == [
        f"{BOLD}Done{BOLD}: see the PR (https://x.test/1)",
        "code",
    ]


def test_irc_to_markdown_keeps_bold_and_drops_colours() -> None:
    assert irc_to_markdown(f"{BOLD}ship it{BOLD} \x0304red\x03 now") == (
        "**ship it** red now"
    )
    assert strip_formatting("\x1ditalic\x1d \x0312,04x\x0f") == "italic x"
