"""The IRC wire format, and Switch Markdown to IRC formatting and back."""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.irc.markup import (
    BOLD,
    ITALIC,
    MONO,
    STRIKE,
    RenderedLine,
    from_irc,
    to_irc,
    wrap,
)
from switch_core.bridges.collaboration.irc.protocol import (
    MAX_LINE_BYTES,
    LineError,
    build,
    casefold,
    is_channel,
    parse,
    valid_channel,
    valid_nick,
)

# ── Parsing and building ─────────────────────────────────────────────────────


def test_parses_tags_source_command_and_trailing() -> None:
    line = parse(
        "@msgid=abc;time=2026-11-05T10:00:00.000Z;account=ada "
        ":ada!a@host PRIVMSG #ops :hello there"
    )
    assert line.command == "PRIVMSG"
    assert line.params == ["#ops", "hello there"]
    assert line.source is not None
    assert (line.source.nick, line.source.user, line.source.host) == (
        "ada",
        "a",
        "host",
    )
    assert line.tags == {
        "msgid": "abc",
        "time": "2026-11-05T10:00:00.000Z",
        "account": "ada",
    }


def test_unescapes_tag_values() -> None:
    line = parse(r"@note=a\sb\:c\\d :s NOTICE x :y")
    assert line.tags["note"] == "a b;c\\d"


def test_a_server_source_has_no_user() -> None:
    line = parse(":irc.example.net 001 bot :Welcome")
    assert line.source is not None
    assert line.source.nick == "irc.example.net"
    assert line.source.user is None


def test_a_line_without_trailing_keeps_its_words() -> None:
    assert parse("JOIN #a").params == ["#a"]
    assert parse("PING :token").params == ["token"]


def test_builds_with_a_colon_only_where_needed() -> None:
    assert build("PRIVMSG", "#c", "hi") == "PRIVMSG #c hi"
    assert build("PRIVMSG", "#c", "hi there") == "PRIVMSG #c :hi there"
    assert build("PRIVMSG", "#c", ":)") == "PRIVMSG #c ::)"
    assert build("PRIVMSG", "#c", "") == "PRIVMSG #c :"


@pytest.mark.parametrize("bad", ["a\r\nQUIT :bye", "a\nJOIN #x", "a\x00b"])
def test_refuses_text_that_would_become_a_second_command(bad: str) -> None:
    with pytest.raises(LineError):
        build("PRIVMSG", "#c", bad)


def test_refuses_a_middle_parameter_irc_cannot_carry() -> None:
    with pytest.raises(LineError):
        build("PRIVMSG", "#a b", "text")
    with pytest.raises(LineError):
        build("PRIVMSG", "", "text")


def test_refuses_a_line_over_the_limit() -> None:
    with pytest.raises(LineError):
        build("PRIVMSG", "#c", "x" * MAX_LINE_BYTES)


def test_casefolds_as_the_server_compares() -> None:
    assert casefold("Nick[]\\~") == "nick{}|^"
    assert casefold("Nick[]", "ascii") == "nick[]"
    assert casefold("ÄBC", "ascii") == "Äbc"


def test_channel_and_nick_names() -> None:
    assert is_channel("#ops") and is_channel("&local") and not is_channel("ada")
    assert valid_channel("#release-train")
    assert not valid_channel("#with space")
    assert not valid_channel("#a,b")
    assert not valid_channel("ops")
    assert valid_nick("switch_bot") and valid_nick("[bot]")
    assert not valid_nick("9lives")
    assert not valid_nick("has space")


# ── Markdown to IRC ──────────────────────────────────────────────────────────


def _texts(markdown: str) -> list[str]:
    return [line.text for line in to_irc(markdown)]


def test_emphasis_becomes_irc_codes() -> None:
    assert _texts("**bold** *it* _it_ ~~gone~~ `code`") == [
        f"{BOLD}bold{BOLD} {ITALIC}it{ITALIC} {ITALIC}it{ITALIC} "
        f"{STRIKE}gone{STRIKE} {MONO}code{MONO}"
    ]


def test_underscores_inside_words_are_left_alone() -> None:
    assert _texts("snake_case_name stays") == ["snake_case_name stays"]


def test_links_are_written_out() -> None:
    assert _texts("see [the docs](https://example.com) or <https://x.y>") == [
        "see the docs (https://example.com) or https://x.y"
    ]
    assert _texts("[https://a.b](https://a.b)") == ["https://a.b"]


def test_headings_become_bold_and_blank_lines_go() -> None:
    assert _texts("# Title\n\nbody") == [f"{BOLD}Title{BOLD}", "body"]


def test_a_code_block_loses_its_fences_and_keeps_its_indentation() -> None:
    lines = to_irc("```python\ndef f():\n    return **not bold**\n```")
    assert lines == [
        RenderedLine("def f():", code=True),
        RenderedLine("    return **not bold**", code=True),
    ]


def test_control_characters_in_text_are_dropped() -> None:
    assert _texts("a\x03\x04red\x07b\x01ACTION") == ["aredbACTION"]


# ── IRC to Markdown ──────────────────────────────────────────────────────────


def test_irc_formatting_becomes_markdown_and_colour_goes() -> None:
    assert from_irc(f"{BOLD}hi{BOLD} \x0304,01red\x03 {ITALIC}it") == "**hi** red *it*"
    assert from_irc(f"{MONO}x{MONO} \x1funder\x1f \x16rev") == "`x` under rev"


def test_reset_closes_what_is_open() -> None:
    assert from_irc(f"{BOLD}{ITALIC}both\x0f plain") == "***both*** plain"


# ── Cutting to length ────────────────────────────────────────────────────────


def test_prose_is_cut_at_spaces_within_the_budget() -> None:
    text = " ".join(f"word{n}" for n in range(60))
    lines = wrap([RenderedLine(text)], 50)
    assert all(len(line.encode()) <= 50 for line in lines)
    assert " ".join(lines) == text


def test_a_style_open_at_a_cut_is_closed_and_reopened() -> None:
    text = f"{BOLD}" + "bold " * 20 + f"{BOLD} after"
    lines = wrap([RenderedLine(text)], 40)
    for line in lines[:-1]:
        assert line.count(BOLD) % 2 == 0
    assert lines[1].startswith(BOLD)


def test_multibyte_text_is_never_cut_inside_a_character() -> None:
    lines = wrap([RenderedLine("é" * 100 + "😀" * 50)], 37)
    assert all(len(line.encode()) <= 37 for line in lines)
    assert "".join(lines) == "é" * 100 + "😀" * 50


def test_a_code_line_is_cut_only_when_too_long_and_keeps_its_spaces() -> None:
    lines = wrap([RenderedLine("    x = 1", code=True)], 40)
    assert lines == ["    x = 1"]
    long = wrap([RenderedLine("    " + "a " * 40, code=True)], 30)
    assert long[0].startswith("    a a")
    assert all(len(line.encode()) <= 30 for line in long)


def test_a_word_longer_than_a_line_is_cut_where_it_must() -> None:
    lines = wrap([RenderedLine("x" * 100)], 30)
    assert "".join(lines) == "x" * 100
    assert all(len(line) <= 30 for line in lines)


def test_refuses_a_budget_too_small_to_carry_text() -> None:
    with pytest.raises(ValueError):
        wrap([RenderedLine("x")], 4)
