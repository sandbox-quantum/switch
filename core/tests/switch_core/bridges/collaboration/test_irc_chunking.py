"""Turning a message body into safe IRC lines, and neutralising inbound
control codes. All pure functions, no socket."""

from __future__ import annotations

from switch_core.bridges.collaboration.irc.chunking import (
    render_markup,
    split_to_lines,
    strip_formatting,
)


def test_strips_mirc_colour_codes() -> None:
    assert strip_formatting("\x0304red\x03 text") == "red text"
    assert strip_formatting("\x034,8colour pair\x03") == "colour pair"


def test_strips_bold_italic_underline_reverse_reset_strike_monospace() -> None:
    raw = "\x02bold\x02 \x1ditalic\x1d \x1funder\x1f \x16rev\x16 \x0freset \x1estrike\x1e \x11mono\x11"
    assert strip_formatting(raw) == "bold italic under rev reset strike mono"


def test_strips_hex_colour_codes() -> None:
    assert strip_formatting("\x04FF0000red\x04") == "red"


def test_strips_a_literal_cr_and_lf_so_no_second_line_can_be_smuggled_in() -> None:
    # A user cannot type a raw CR/LF from a normal IRC client — but an
    # inbound value is never trusted to have come from one.
    assert strip_formatting("hello\r\nQUIT :bye") == "helloQUIT :bye"


def test_leaves_ordinary_punctuation_alone() -> None:
    assert strip_formatting("plain: text! (nothing to strip)") == (
        "plain: text! (nothing to strip)"
    )


def test_render_markup_bold() -> None:
    assert render_markup("say **hello** now") == "say \x02hello\x02 now"
    assert render_markup("say __hello__ now") == "say \x02hello\x02 now"


def test_render_markup_link_shows_text_and_url() -> None:
    assert (
        render_markup("see [docs](https://example.com)")
        == "see docs (https://example.com)"
    )


def test_render_markup_strips_heading_hashes() -> None:
    assert render_markup("# Title\nbody") == "Title\nbody"


def test_split_to_lines_keeps_a_short_message_on_one_line() -> None:
    assert split_to_lines("hi there", prefix="<bot> ") == ["<bot> hi there"]


def test_split_to_lines_respects_the_byte_budget() -> None:
    text = "word " * 50
    lines = split_to_lines(text, prefix="<bot> ", max_bytes=40)
    for line in lines:
        assert len(line.encode("utf-8")) <= 40


def test_split_to_lines_every_line_carries_the_prefix() -> None:
    text = "word " * 50
    lines = split_to_lines(text, prefix="<agent-name> ", max_bytes=40)
    assert len(lines) > 1
    for line in lines:
        assert line.startswith("<agent-name> ")


def test_split_to_lines_prefers_word_boundaries() -> None:
    lines = split_to_lines("alpha beta gamma delta", prefix="", max_bytes=12)
    assert all(len(line.encode("utf-8")) <= 12 for line in lines)
    assert "".join(lines).replace(" ", "") != ""
    # Words stay whole where they fit; none is split mid-word here.
    for line in lines:
        assert (
            line.strip() in {"alpha", "beta", "gamma", "delta"} or " " in line.strip()
        )


def test_split_to_lines_hard_splits_a_word_longer_than_the_budget() -> None:
    long_word = "x" * 30
    lines = split_to_lines(long_word, prefix="", max_bytes=10)
    assert len(lines) == 3
    assert "".join(lines) == long_word
    for line in lines:
        assert len(line.encode("utf-8")) <= 10


def test_split_to_lines_never_cuts_a_multibyte_character_in_half() -> None:
    # Each "é" is 2 UTF-8 bytes; a budget of 5 must still yield only whole
    # characters, never a lone continuation byte.
    text = "é" * 10
    lines = split_to_lines(text, prefix="", max_bytes=5)
    for line in lines:
        encoded = line.encode("utf-8")
        assert len(encoded) <= 5
        encoded.decode("utf-8")  # raises if a codepoint was split


def test_split_to_lines_preserves_existing_line_breaks_as_separate_lines() -> None:
    lines = split_to_lines("first\nsecond", prefix="", max_bytes=100)
    assert lines == ["first", "second"]


def test_split_to_lines_never_lets_cr_or_lf_reach_a_single_line() -> None:
    lines = split_to_lines("one\r\ntwo\r\nthree", prefix="", max_bytes=100)
    for line in lines:
        assert "\r" not in line
        assert "\n" not in line
