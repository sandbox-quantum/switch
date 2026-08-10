from __future__ import annotations

import pytest

from switch_core.bridges.agent.commands import COMMANDS
from switch_core.bridges.collaboration.discord.chunking import (
    MAX_MESSAGE,
    chunk_message,
)


def _rejoin(chunks: list[str]) -> str:
    return "\n".join(chunks)


def test_short_message_is_one_chunk_untouched() -> None:
    assert chunk_message("hello") == ["hello"]


def test_message_at_the_limit_is_not_split() -> None:
    exact = "x" * MAX_MESSAGE
    assert chunk_message(exact) == [exact]


def test_every_chunk_fits_the_limit() -> None:
    body = "\n".join(f"line {i} " + "y" * 60 for i in range(200))
    chunks = chunk_message(body)
    assert len(chunks) > 1
    assert all(len(c) <= MAX_MESSAGE for c in chunks)


def test_nothing_is_lost_when_splitting_on_lines() -> None:
    body = "\n".join(f"line {i}" for i in range(1000))
    assert _rejoin(chunk_message(body)) == body


def test_splits_prefer_line_boundaries() -> None:
    body = "\n".join(f"line {i}" for i in range(1000))
    for chunk in chunk_message(body):
        # No chunk starts or ends mid-line.
        assert chunk.startswith("line ")
        assert chunk.splitlines()[-1].startswith("line ")


def test_single_over_long_line_is_split_on_a_word() -> None:
    body = " ".join(["word"] * 2000)
    chunks = chunk_message(body)
    assert all(len(c) <= MAX_MESSAGE for c in chunks)
    # Broken between words, never through one.
    for chunk in chunks:
        assert "wor\n" not in chunk
        assert set(chunk.split()) == {"word"}


def test_unbroken_run_with_no_spaces_is_hard_split() -> None:
    body = "z" * 5000
    chunks = chunk_message(body)
    assert all(len(c) <= MAX_MESSAGE for c in chunks)
    assert "".join(chunks).replace("\n", "") == body


def test_code_fence_is_closed_and_reopened_across_a_split() -> None:
    body = "intro\n```python\n" + "\n".join(f"x = {i}" for i in range(400)) + "\n```"
    chunks = chunk_message(body)

    assert len(chunks) > 1
    for chunk in chunks:
        # A torn fence would render the rest of the message as plain text.
        assert chunk.count("```") % 2 == 0, chunk[:80]
    # The reopened fence keeps the language so highlighting survives.
    assert chunks[1].startswith("```python")
    assert chunks[0].endswith("```")


def test_reopened_fence_still_respects_the_limit() -> None:
    body = "```\n" + "\n".join("a" * 100 for _ in range(100)) + "\n```"
    assert all(len(c) <= MAX_MESSAGE for c in chunk_message(body))


def test_code_content_survives_the_fence_rewrite() -> None:
    lines = [f"x = {i}" for i in range(400)]
    body = "```python\n" + "\n".join(lines) + "\n```"
    chunks = chunk_message(body)
    # Every original code line still appears exactly once.
    rendered = _rejoin(chunks)
    for line in lines:
        assert rendered.count(f"\n{line}\n") + rendered.count(f"\n{line}") >= 1


def test_text_after_a_closed_fence_is_not_treated_as_code() -> None:
    body = "```\nshort\n```\n" + "\n".join(f"prose line {i}" for i in range(400))
    chunks = chunk_message(body)
    # The fence closed before the prose, so no chunk should reopen one.
    assert not chunks[-1].startswith("```")
    assert all(c.count("```") % 2 == 0 for c in chunks)


@pytest.mark.parametrize("size", [1, 100, 1999, 2000, 2001, 4001, 10000])
def test_round_trips_at_a_range_of_sizes(size: int) -> None:
    body = "\n".join("abcdefgh" for _ in range(size // 9 + 1))
    chunks = chunk_message(body)
    assert all(len(c) <= MAX_MESSAGE for c in chunks)
    assert _rejoin(chunks) == body


def test_help_output_now_fits() -> None:
    # The concrete regression: `!help` / `/help` renders every command and
    # overshot Discord's cap, so the send was rejected and the user saw
    # nothing at all.
    lines = ["**Available commands:**"]
    for command in COMMANDS:
        if command.hidden:
            continue
        lines.append(f"- `!{command.name}` — {command.description}")
    body = "\n".join(lines)

    assert len(body) > MAX_MESSAGE
    chunks = chunk_message(body)
    assert len(chunks) == 2
    assert all(len(c) <= MAX_MESSAGE for c in chunks)
    assert _rejoin(chunks) == body
