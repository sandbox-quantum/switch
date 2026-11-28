import pytest

from switch_core.bridges.collaboration.irc.protocol import (
    BOLD,
    MAX_LINE_BYTES,
    MONOSPACE,
    SOURCE_ALLOWANCE,
    format_line,
    markdown_to_irc,
    parse_line,
    privmsg_budget,
    split_text,
    strip_formatting,
)


def test_a_line_with_tags_a_source_and_a_trailing_parameter() -> None:
    line = parse_line(
        "@msgid=abc\\s1;account=alice;+draft/x :alice!a@host.example "
        "PRIVMSG #switch :@helper hi there\r\n"
    )
    assert line is not None
    assert line.tags == {"msgid": "abc 1", "account": "alice", "+draft/x": ""}
    assert line.nick == "alice"
    assert line.command == "PRIVMSG"
    assert line.params == ["#switch", "@helper hi there"]


def test_server_lines_and_numerics() -> None:
    welcome = parse_line(":irc.test 001 switchbot :Welcome")
    assert welcome is not None and welcome.nick is None
    assert (welcome.command, welcome.params) == ("001", ["switchbot", "Welcome"])
    ping = parse_line("PING :irc.test")
    assert ping is not None and ping.params == ["irc.test"]
    assert parse_line("") is None
    assert parse_line(":only.a.source") is None


def test_a_line_cannot_carry_a_second_command() -> None:
    assert format_line("PRIVMSG", "#switch", "hi there") == "PRIVMSG #switch :hi there"
    assert format_line("JOIN", "#switch") == "JOIN #switch"
    assert format_line("PRIVMSG", "#switch", ":)") == "PRIVMSG #switch ::)"
    with pytest.raises(ValueError):
        format_line("PRIVMSG", "#switch", "hi\r\nQUIT :bye")
    with pytest.raises(ValueError):
        format_line("PRIVMSG", "#a b", "hi")


def test_every_piece_fits_the_line_the_server_relays() -> None:
    budget = privmsg_budget("#switch")
    assert budget + len(b"PRIVMSG #switch :") + 2 + SOURCE_ALLOWANCE == MAX_LINE_BYTES
    text = "word " * 300
    pieces = split_text(text, budget)
    assert all(len(piece.encode()) <= budget for piece in pieces)
    assert " ".join(pieces).split() == text.split()


def test_no_character_is_split_across_two_lines() -> None:
    text = "日本語" * 100  # three bytes each, no spaces
    pieces = split_text(text, 40)
    assert all(len(piece.encode()) <= 40 for piece in pieces)
    assert "".join(pieces) == text


def test_one_message_per_line_and_no_empty_ones() -> None:
    assert split_text("first\n\n  \nsecond\r\nthird", 100) == [
        "first",
        "second",
        "third",
    ]


def test_markdown_becomes_irc_markup() -> None:
    assert (
        markdown_to_irc("**bold** and `code`")
        == f"{BOLD}bold{BOLD} and {MONOSPACE}code{MONOSPACE}"
    )
    assert (
        markdown_to_irc("see [the docs](https://x.test/a)")
        == "see the docs (https://x.test/a)"
    )
    assert markdown_to_irc("## Plan") == f"{BOLD}Plan{BOLD}"
    assert markdown_to_irc("```py\nprint(1)\n```") == "\nprint(1)\n"


def test_colours_and_styles_are_stripped_from_what_people_say() -> None:
    assert (
        strip_formatting("\x0304,01red\x03 \x02bold\x02 \x1ditalic\x0f")
        == "red bold italic"
    )
