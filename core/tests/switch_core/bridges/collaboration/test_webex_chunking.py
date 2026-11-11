"""Splitting replies to fit Webex's per-message limit."""

from __future__ import annotations

from switch_core.bridges.collaboration.webex.chunking import (
    MAX_MESSAGE_BYTES,
    chunk_markdown,
    clamp_markdown,
)


def _fits(piece: str) -> bool:
    return len(piece.encode("utf-8")) <= MAX_MESSAGE_BYTES


def test_a_short_message_is_one_piece() -> None:
    assert chunk_markdown("hello") == ["hello"]


def test_a_long_message_splits_at_paragraphs() -> None:
    paragraph = "word " * 300
    pieces = chunk_markdown("\n\n".join([paragraph.strip()] * 10))
    assert len(pieces) > 1
    assert all(_fits(p) for p in pieces)
    assert all(p.endswith("word") for p in pieces)


def test_multibyte_text_is_measured_in_bytes() -> None:
    pieces = chunk_markdown("é" * 10_000)
    assert all(_fits(p) for p in pieces)
    assert "".join(pieces) == "é" * 10_000


def test_a_code_block_cut_in_two_is_closed_and_reopened() -> None:
    code = "```python\n" + "\n".join(f"line_{i} = {i}" for i in range(1500)) + "\n```"
    pieces = chunk_markdown(code)
    assert len(pieces) > 1
    assert all(_fits(p) for p in pieces)
    for piece in pieces:
        assert piece.count("```") % 2 == 0, piece[:40]
    assert pieces[1].startswith("```python\n")


def test_clamp_cuts_to_one_message_and_says_so() -> None:
    clamped = clamp_markdown("x" * 20_000)
    assert _fits(clamped)
    assert clamped.endswith("_…(cut to fit one Webex message)_")
    assert clamp_markdown("short") == "short"
