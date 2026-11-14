"""IRC lines: read, built, rendered and cut to fit."""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.irc.markup import (
    BOLD,
    ITALIC,
    STRIKE,
    from_irc,
    lines,
    to_irc,
)
from switch_core.bridges.collaboration.irc.protocol import (
    MAX_LINE_BYTES,
    build,
    casefold,
    parse,
    text_budget,
)

# ── The wire format ──────────────────────────────────────────────────────────


def test_a_line_is_read_with_its_tags_source_and_trailing_text() -> None:
    line = parse(
        r"@msgid=abc;time=2026-01-01T00:00:00.000Z;+draft/x=a\sb\:c "
        ":ada!ada@users.example PRIVMSG #ops :hello there :)"
    )
    assert line.command == "PRIVMSG"
    assert line.params == ("#ops", "hello there :)")
    assert line.nick == "ada"
    assert line.tags == {
        "msgid": "abc",
        "time": "2026-01-01T00:00:00.000Z",
        "+draft/x": "a b;c",
    }


def test_a_server_is_not_a_nick() -> None:
    line = parse(":irc.example 001 switchbot :Welcome")
    assert line.nick is None
    assert line.params == ("switchbot", "Welcome")


def test_a_line_is_built_with_a_trailing_parameter_only_where_needed() -> None:
    assert build("JOIN", "#ops") == "JOIN #ops"
    assert build("PRIVMSG", "#ops", "hi there") == "PRIVMSG #ops :hi there"
    assert build("PRIVMSG", "#ops", ":)") == "PRIVMSG #ops ::)"


@pytest.mark.parametrize("text", ["hi\r\nQUIT", "hi\nJOIN #x", "nul\x00"])
def test_no_parameter_can_smuggle_in_a_second_line(text: str) -> None:
    with pytest.raises(ValueError, match="CR, LF or NUL"):
        build("PRIVMSG", "#ops", text)


def test_a_space_cannot_split_a_middle_parameter() -> None:
    with pytest.raises(ValueError, match="middle"):
        build("PRIVMSG", "#ops x", "hi")


def test_a_line_longer_than_irc_allows_is_refused() -> None:
    with pytest.raises(ValueError, match="512 bytes"):
        build("PRIVMSG", "#ops", "x" * 510)


def test_only_ascii_letters_are_folded() -> None:
    assert casefold("#Ops[1]") == "#ops[1]"
    assert casefold("#\u00dcn\u00efcode") == "#\u00dcn\u00efcode"


def test_the_budget_leaves_room_for_the_source_the_server_adds() -> None:
    budget = text_budget("switchbot", "#ops")
    longest_source = len(":switchbot___!" + "u" * 18 + "@" + "h" * 63 + " ")
    sent = len(f"PRIVMSG #ops :{'x' * budget}\r\n")
    assert longest_source + sent <= MAX_LINE_BYTES


# ── Markdown to IRC ──────────────────────────────────────────────────────────


def test_prose_marks_become_irc_codes() -> None:
    assert to_irc("**bold** and *it* and _it_ and ~~gone~~") == (
        f"{BOLD}bold{BOLD} and {ITALIC}it{ITALIC} and {ITALIC}it{ITALIC} and "
        f"{STRIKE}gone{STRIKE}"
    )
    assert to_irc("## Plan") == f"{BOLD}Plan{BOLD}"


def test_a_link_keeps_its_address_in_the_text() -> None:
    assert to_irc("see [the docs](https://docs.example/x)") == (
        "see the docs (https://docs.example/x)"
    )
    assert to_irc("[https://a.example](https://a.example)") == "https://a.example"


def test_code_is_left_exactly_as_written() -> None:
    markdown = "run `make **all**` then\n```py\nx = a_b_c * 2  # **no**\n```"
    assert to_irc(markdown) == markdown


def test_formatting_and_colours_are_dropped_on_the_way_in() -> None:
    assert from_irc("\x02bold\x02 \x0304,12red\x03 \x1dit\x1d \x0f\x0409ff00x") == (
        "bold red it x"
    )


# ── Cut into lines ───────────────────────────────────────────────────────────


def test_each_line_carries_the_prefix_and_blank_lines_are_dropped() -> None:
    assert lines("one\n\n  \ntwo", prefix="<coder> ", budget=400) == [
        "<coder> one",
        "<coder> two",
    ]


def test_a_long_line_is_wrapped_at_spaces_within_the_byte_budget() -> None:
    words = " ".join(f"word{i}" for i in range(200))
    out = lines(words, prefix="<coder> ", budget=100)
    assert len(out) > 1
    assert all(len(line.encode()) <= 100 for line in out)
    assert all(line.startswith("<coder> word") for line in out)
    assert " ".join(line.removeprefix("<coder> ") for line in out) == words


def test_multibyte_text_is_never_cut_inside_a_character() -> None:
    text = "日本語のテキスト🙂" * 40
    out = lines(text, prefix="", budget=101)
    assert all(len(line.encode()) <= 101 for line in out)
    assert "".join(out) == text


def test_a_code_block_keeps_its_lines_and_indentation_and_loses_its_fences() -> None:
    text = (
        "Here:\n```python\ndef f(x):\n\n    return x  * 2\n```\n"
        + "after the block " * 10
    )
    out = lines(text, prefix="> ", budget=60)
    assert out[:3] == ["> Here:", "> def f(x):", ">     return x  * 2"]
    assert all("```" not in line for line in out)


def test_a_code_line_is_only_cut_where_it_alone_is_too_long() -> None:
    code = "    x = " + "a" * 100
    out = lines(f"```\n{code}\n```", prefix="", budget=40)
    assert "".join(out) == code
    assert out[0].startswith("    x = ")


def test_nothing_that_ends_a_line_or_starts_a_ctcp_is_sent() -> None:
    assert lines("\x01ACTION hi\x01\r\nnext\x00", prefix="", budget=100) == [
        "ACTION hi",
        "next",
    ]


def test_globs_and_paths_keep_their_asterisks() -> None:
    for literal in (
        "src/**/*.py and lib/**/*.js",
        "src/*/lib/*",
        "*.md*",
        "*.py and *.js",
        "a * b * c",
        "2 ** 3 ** 4",
    ):
        assert to_irc(literal) == literal
    assert to_irc("say *hi!* to **them**") == (
        f"say {ITALIC}hi!{ITALIC} to {BOLD}them{BOLD}"
    )
