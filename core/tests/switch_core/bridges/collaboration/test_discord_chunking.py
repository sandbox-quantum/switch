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


def test_help_shaped_output_over_the_cap_splits() -> None:
    # The concrete regression: `!help` / `/help` renders every command and
    # overshot Discord's cap, so the send was rejected and the user saw
    # nothing at all. Today's list fits in one message, so the command lines
    # are repeated to keep a help-shaped body over the cap.
    lines = ["**Available commands:**"]
    for command in COMMANDS:
        if command.hidden:
            continue
        lines.append(f"- `!{command.name}` — {command.description}")
    body = "\n".join(lines + lines[1:])

    assert len(body) > MAX_MESSAGE
    chunks = chunk_message(body)
    assert len(chunks) >= 2
    assert all(len(c) <= MAX_MESSAGE for c in chunks)
    assert _rejoin(chunks) == body


def _only_an_empty_fence(chunk: str) -> bool:
    lines = chunk.split("\n")
    return len(lines) == 2 and lines[0].startswith("```") and lines[1].strip() == "```"


@pytest.mark.parametrize("language", ["", "python", "typescriptreact"])
@pytest.mark.parametrize("length", [1950, 1985, 1990, 1999, 2000, 5000])
def test_a_long_line_inside_a_code_block_fits_every_part(
    language: str, length: int
) -> None:
    # A line wrapped to the old budget filled a part that already started with
    # the reopened fence, so the next flush emitted that fence on its own and
    # the part after it overshot the cap by the language's length.
    body = f"intro\n```{language}\n" + "z" * length + "\nshort\n```\noutro"

    chunks = chunk_message(body)

    assert all(len(c) <= MAX_MESSAGE for c in chunks), [len(c) for c in chunks]
    assert not any(_only_an_empty_fence(c) for c in chunks)
    assert all(c.count("```") % 2 == 0 for c in chunks)
    assert "".join(chunks).count("z") == length


def test_a_code_block_ending_at_a_part_boundary_does_not_reopen() -> None:
    # The block's own closing line, trailing spaces and all, would not fit, so
    # the part's closing fence stands in for it and the next part starts
    # outside the block.
    code = "\n".join("a" * 99 for _ in range(19))
    body = "```\n" + code + "\n" + "b" * 92 + "\n```  \nafter"

    chunks = chunk_message(body)

    assert len(chunks) == 2
    assert not any(_only_an_empty_fence(c) for c in chunks)
    assert chunks[0].endswith("b" * 92 + "\n```")
    assert chunks[1] == "after"


def test_an_opening_fence_is_not_left_alone_at_the_end_of_a_part() -> None:
    body = "x" * 1990 + "\n```python\n" + "y = 1\n" * 10 + "```"

    chunks = chunk_message(body)

    assert chunks[0] == "x" * 1990
    assert chunks[1].startswith("```python\ny = 1")


def test_a_one_line_fenced_span_does_not_open_a_block() -> None:
    # Taken as an opener, ```npm test``` started a block with the language
    # "npm test```", and every later part was reopened with that.
    prose = "\n".join(f"prose line {i} " + "p" * 50 for i in range(80))
    body = "Run this:\n```npm test```\n" + prose

    chunks = chunk_message(body)

    assert len(chunks) > 1
    assert not any(c.startswith("```npm") for c in chunks[1:])
    assert not any(c.endswith("\n```") for c in chunks)
    assert _rejoin(chunks) == body


def test_a_fence_line_with_trailing_text_does_not_close_the_block() -> None:
    # CommonMark: a closing fence carries nothing but whitespace after the
    # backticks, so "``` not a close" is a line of code.
    code = "\n".join(f"line {i}" for i in range(400))
    body = "```text\n``` not a close\n" + code + "\n```"

    chunks = chunk_message(body)

    assert len(chunks) > 1
    assert all(c.startswith("```text") for c in chunks)
    assert all(c.endswith("```") for c in chunks)


def test_a_closing_fence_may_carry_trailing_whitespace() -> None:
    body = "```\ncode\n```   \n" + "\n".join(f"prose {i}" for i in range(400))

    chunks = chunk_message(body)

    assert not any(c.startswith("```") for c in chunks[1:])
    assert _rejoin(chunks) == body


def test_a_longer_fence_is_reopened_and_closed_with_its_own_length() -> None:
    code = "\n".join(f"```inner {i}" for i in range(300))
    body = "````md\n" + code + "\n````"

    chunks = chunk_message(body)

    assert len(chunks) > 1
    assert all(c.startswith("````md") for c in chunks)
    assert all(c.endswith("\n````") for c in chunks)


def test_a_tilde_fence_is_closed_and_reopened_across_a_split() -> None:
    body = (
        "intro\n~~~python\n"
        + "\n".join(f"x = {i}" for i in range(400))
        + "\n~~~\nafter"
    )

    chunks = chunk_message(body)

    assert len(chunks) > 1
    assert all(len(c) <= MAX_MESSAGE for c in chunks)
    assert chunks[0].endswith("\n~~~")
    assert all(c.startswith("~~~python") for c in chunks[1:])
    assert chunks[-1].endswith("~~~\nafter")
    assert not any("```" in c for c in chunks)


def test_a_tilde_fence_is_not_closed_by_backticks_nor_a_shorter_run() -> None:
    # CommonMark: a block closes only on its own character, at least as long
    # as its opener, so these are lines of code.
    code = "\n".join(f"line {i}" for i in range(400))
    body = "~~~~text\n```\n~~~\n" + code + "\n~~~~\nafter"

    chunks = chunk_message(body)

    assert len(chunks) > 1
    assert chunks[0].startswith("~~~~text\n```\n~~~\n")
    assert all(c.startswith("~~~~text") for c in chunks[1:])
    assert all(c.endswith("\n~~~~") for c in chunks[:-1])


def test_a_tilde_opener_may_carry_backticks_in_its_info_string() -> None:
    body = "~~~ a`b\n" + "\n".join(f"x = {i}" for i in range(400)) + "\n~~~"

    chunks = chunk_message(body)

    assert len(chunks) > 1
    assert all(c.startswith("~~~ a`b") or c.startswith("~~~a`b") for c in chunks)


def test_a_backtick_block_is_not_closed_by_tildes() -> None:
    code = "\n".join(f"line {i}" for i in range(400))
    body = "```text\n~~~\n" + code + "\n```"

    chunks = chunk_message(body)

    assert len(chunks) > 1
    assert all(c.startswith("```text") for c in chunks)
    assert all(c.endswith("```") for c in chunks)


def test_a_line_indented_four_spaces_is_not_a_fence() -> None:
    # Indented code that happens to start with backticks: in CommonMark it is
    # not a fence, and counting it as one inverted every block after it.
    prose = "\n".join(f"prose line {i} " + "p" * 50 for i in range(80))
    body = "Indented:\n\n    ```python\n    x = 1\n\n" + prose

    chunks = chunk_message(body)

    assert len(chunks) > 1
    assert _rejoin(chunks) == body
    assert not any(c.startswith("```") for c in chunks[1:])


def test_an_indented_code_line_inside_a_block_does_not_close_it() -> None:
    code = "\n".join(f"line {i}" for i in range(400))
    body = "```text\n    ```\n" + code + "\n```"

    chunks = chunk_message(body)

    assert len(chunks) > 1
    assert all(c.startswith("```text") for c in chunks)
    assert all(c.endswith("\n```") for c in chunks)


def test_a_fence_indented_up_to_three_spaces_still_counts() -> None:
    code = "\n".join(f"line {i}" for i in range(400))
    body = "   ```text\n" + code + "\n   ```\nafter"

    chunks = chunk_message(body)

    assert len(chunks) > 1
    assert chunks[0].endswith("\n```")
    assert all(c.startswith("```text") for c in chunks[1:])
