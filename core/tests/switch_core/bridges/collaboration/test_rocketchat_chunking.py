"""Splitting a long reply into messages Rocket.Chat accepts."""

from __future__ import annotations

from switch_core.bridges.collaboration.rocketchat.chunking import (
    MAX_MESSAGE_CHARS,
    chunk_markdown,
    clamp_markdown,
)


def test_a_short_reply_is_one_message() -> None:
    assert chunk_markdown("hello") == ["hello"]


def test_no_part_passes_the_limit() -> None:
    parts = chunk_markdown("word " * 3000)
    assert len(parts) > 1
    assert all(len(part) <= MAX_MESSAGE_CHARS for part in parts)


def test_nothing_is_lost() -> None:
    words = [f"w{n}" for n in range(3000)]
    assert " ".join(chunk_markdown(" ".join(words))).split() == words


def test_a_paragraph_break_is_preferred() -> None:
    first = "a" * 3000
    second = "b" * 3000
    assert chunk_markdown(f"{first}\n\n{second}") == [first, second]


def test_a_single_huge_word_is_still_cut() -> None:
    parts = chunk_markdown("x" * 10000)
    assert all(len(part) <= MAX_MESSAGE_CHARS for part in parts)
    assert "".join(parts) == "x" * 10000


def test_a_code_block_cut_in_two_is_code_on_both_sides() -> None:
    body = "\n".join(f"line {n}" for n in range(2000))
    parts = chunk_markdown(f"```python\n{body}\n```")
    assert len(parts) > 1
    for part in parts:
        assert part.startswith("```python\n")
        assert part.endswith("```")
        assert len(part) <= MAX_MESSAGE_CHARS


def test_a_clamped_message_says_it_was_cut_and_closes_its_code() -> None:
    clamped = clamp_markdown("```\n" + "x\n" * 5000)
    assert len(clamped) <= MAX_MESSAGE_CHARS
    assert clamped.endswith("```\n…")


def test_a_short_message_is_not_clamped() -> None:
    assert clamp_markdown("hello") == "hello"
