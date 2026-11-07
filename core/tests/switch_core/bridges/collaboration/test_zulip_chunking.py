"""Splitting a rendered Zulip body across messages.

Pure, so it is tested on its own: the interesting cases are all about a cut
landing inside markup, which needs no organization and no event loop.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.zulip.chunking import (
    MAX_MESSAGE,
    chunk_message,
    fence_opener,
)


def test_a_body_within_the_cap_is_left_whole() -> None:
    assert chunk_message("hello") == ["hello"]
    assert chunk_message("a" * MAX_MESSAGE) == ["a" * MAX_MESSAGE]


def test_a_long_body_is_split_within_the_cap_and_loses_no_text() -> None:
    body = "".join(f"line {index} of a long answer\n" for index in range(2000))

    chunks = chunk_message(body)

    assert len(chunks) > 1
    assert all(len(chunk) <= MAX_MESSAGE for chunk in chunks)
    assert "".join(chunks).replace("\n", "") == body.replace("\n", "")


def test_a_cut_prefers_a_line_break() -> None:
    body = "".join(f"paragraph {index}\n" for index in range(2000))

    for chunk in chunk_message(body):
        assert not chunk.endswith("paragraph")


def test_a_code_block_is_closed_and_reopened_across_the_split() -> None:
    # A fence opened in one message and never closed makes the second half
    # render as prose, which is how a long code answer arrives unformatted.
    body = "```python\n" + "x" * 15_000 + "\n```"

    chunks = chunk_message(body)

    assert len(chunks) > 1
    assert chunks[0].endswith("```")
    assert chunks[1].startswith("```python")
    assert all(len(chunk) <= MAX_MESSAGE for chunk in chunks)
    assert "".join(chunks).count("x") == 15_000


def test_a_body_that_ends_inside_a_code_block_reports_it() -> None:
    assert fence_opener("text\n```js\nconst a = 1;") == "```js"
    assert fence_opener("```js\nconst a = 1;\n```\n") == ""


@pytest.mark.parametrize(
    "body",
    [
        "y" * 25_000,
        "```\n" + "y" * 20_000 + "\n```",
        "\n".join(f"- item {index}" for index in range(3000)),
    ],
    # Named: the node id would otherwise be the whole body, and Windows refuses
    # an environment variable that long (pytest puts the node id in one).
    ids=["unbroken run", "long code block", "long list"],
)
def test_every_piece_fits_whatever_the_body(body: str) -> None:
    chunks = chunk_message(body)

    assert chunks
    assert all(0 < len(chunk) <= MAX_MESSAGE for chunk in chunks)
