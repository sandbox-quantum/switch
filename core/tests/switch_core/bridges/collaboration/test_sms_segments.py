from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.sms.formatting import to_gsm_friendly, to_sms
from switch_core.bridges.collaboration.sms.segments import (
    CUT_NOTICE,
    count_segments,
    fit_reply,
    is_gsm,
)


@pytest.mark.parametrize(
    ("text", "segments"),
    [
        ("a" * 160, 1),
        ("a" * 161, 2),
        ("a" * 304, 2),
        ("a" * 305, 3),
        ("é" * 160, 1),
        ("{" * 80, 1),
        ("{" * 81, 2),
        ("€" * 81, 2),
        ("✓" * 70, 1),
        ("✓" * 71, 2),
        ("😀" * 35, 1),
        ("😀" * 36, 2),
    ],
)
def test_count_segments(text: str, segments: int) -> None:
    assert count_segments(text) == segments


def test_one_character_outside_gsm_moves_the_whole_text() -> None:
    assert is_gsm("plain text")
    assert not is_gsm("plain text ✓")
    assert count_segments("a" * 100 + "✓") == 2


def test_short_reply_is_untouched() -> None:
    assert fit_reply("hello there", 5) == ["hello there"]


def test_long_reply_within_the_limit_is_not_cut() -> None:
    text = "word " * 100
    pieces = fit_reply(text, 5)
    assert "".join(pieces) == text
    assert CUT_NOTICE not in pieces[-1]


def test_reply_over_the_limit_is_cut_at_a_sentence_with_a_notice() -> None:
    text = "This is one sentence. " * 100
    pieces = fit_reply(text, 3)
    assert sum(count_segments(p) for p in pieces) <= 3
    assert pieces[-1].endswith(CUT_NOTICE)
    assert pieces[-1].removesuffix(CUT_NOTICE).endswith("sentence.")


@pytest.mark.parametrize("limit", [1, 2, 3, 5, 20])
@pytest.mark.parametrize(
    "text",
    ["a" * 9000, "😀" * 3000, "{}" * 3000, "✓ word. " * 1000, "line\n" * 2000],
    ids=["no-breaks", "emoji", "extended", "unicode-sentences", "lines"],
)
def test_no_reply_ever_costs_more_than_the_limit(text: str, limit: int) -> None:
    pieces = fit_reply(text, limit)
    assert sum(count_segments(p) for p in pieces) <= limit
    assert CUT_NOTICE.strip() in pieces[-1]


def test_long_reply_is_split_into_messages_twilio_accepts() -> None:
    pieces = fit_reply("A sentence goes here. " * 200, 40)
    assert len(pieces) > 1
    assert all(len(p) <= 1600 for p in pieces)
    assert sum(count_segments(p) for p in pieces) <= 40


def test_unicode_messages_stay_under_twilios_lower_limit() -> None:
    pieces = fit_reply("✓ short bit. " * 200, 60)
    assert len(pieces) > 1
    assert all(len(p) <= 700 for p in pieces)


@pytest.mark.parametrize(
    ("markdown", "plain"),
    [
        ("**bold** and *italic* and ~~gone~~", "bold and italic and gone"),
        ("# Heading", "Heading"),
        ("* item\n+ other", "- item\n- other"),
        ("[docs](https://example.com/a_b_c)", "docs (https://example.com/a_b_c)"),
        ("<https://example.com>", "https://example.com"),
        ("see https://example.com/a_b_c_d now", "see https://example.com/a_b_c_d now"),
        ("use `snake_case_name` here", "use snake_case_name here"),
        ("snake_case_name stays", "snake_case_name stays"),
        ("```python\nx = **1**\n```", "x = **1**"),
        ("", ""),
    ],
)
def test_to_sms(markdown: str, plain: str) -> None:
    assert to_sms(markdown) == plain


@pytest.mark.parametrize(
    ("text", "plain"),
    [
        ("it’s “fine” — ok…", 'it\'s "fine" - ok...'),
        ("na​me", "name"),
        ("keeps 😀 emoji", "keeps 😀 emoji"),
    ],
)
def test_to_gsm_friendly(text: str, plain: str) -> None:
    assert to_gsm_friendly(text) == plain
