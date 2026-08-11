"""Splitting a rendered Telegram body across messages.

The rule is separated from the adapter (as Discord's is) because it is pure and
the interesting cases are all about markup surviving a cut, which needs no bot,
no network and no event loop.
"""

from __future__ import annotations

import re

import pytest

from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.chunking import (
    MAX_MESSAGE,
    chunk_message,
)


def _render(markdown: str) -> str:
    """Markdown through the adapter's translation, which is what gets split."""
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="t", bot_username="b")
    )
    return adapter.translate_outbound(markdown)


def _tags_balanced(text: str) -> bool:
    stack: list[str] = []
    for match in re.finditer(r"<(/?)([a-z]+)[^>]*>", text):
        if match.group(1):
            if not stack or stack[-1] != match.group(2):
                return False
            stack.pop()
        else:
            stack.append(match.group(2))
    return not stack


def _visible(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text).replace("\n", "")


@pytest.mark.parametrize(
    ("name", "markdown"),
    [
        ("code block", "```\n" + "x" * 9000 + "\n```"),
        ("bold run", "**" + "word " * 1200 + "**"),
        ("bulleted list", "\n".join(f"- **item {i}** padding" for i in range(300))),
        ("link text", "[" + "L" * 5000 + "](https://e.com)"),
        ("unformatted", "y" * 10000),
    ],
)
def test_a_split_never_leaves_broken_markup(name: str, markdown: str) -> None:
    # A cut landing inside the formatting makes Telegram reject *both* halves,
    # so a long code block — the most common thing an agent posts — arrives
    # completely unformatted. Tags open at a cut are closed and reopened.
    chunks = chunk_message(_render(markdown))

    assert all(len(c) <= 4096 for c in chunks), name
    assert all(_tags_balanced(c) for c in chunks), name


def test_a_split_code_block_resumes_as_a_code_block() -> None:
    chunks = chunk_message(_render("```\n" + "x" * 9000 + "\n```"))

    assert len(chunks) > 1
    assert chunks[0].endswith("</pre>")
    assert chunks[1].startswith("<pre>")


def test_splitting_loses_no_text() -> None:
    body = _render("**Report**\n\n" + "\n".join(f"- line {i}" for i in range(700)))

    chunks = chunk_message(body)

    # `_visible` drops newlines, so this is about characters surviving; the
    # newline accounting is asserted separately below.
    assert _visible("".join(chunks)) == _visible(body)


def test_a_body_at_exactly_the_cap_is_left_whole() -> None:
    assert chunk_message("a" * 4096) == ["a" * 4096]


def test_markup_too_deep_to_split_degrades_to_plain_text() -> None:
    # Forcing a cut here severed a tag mid-character and put a bare `<` on the
    # wire, which Telegram rejects — and the plain-text retry could not
    # recognise the fragment as a tag either, so the text was mangled too.
    body = "".join(f"<b>text{i} " for i in range(2000))

    chunks = chunk_message(body)

    assert all(len(c) <= MAX_MESSAGE for c in chunks)
    assert all(_tags_balanced(c) for c in chunks)
    assert not any(re.search(r"<[a-z]*$", c) for c in chunks)
    assert _visible("".join(chunks)).replace("\n", "") == _visible(body).replace(
        "\n", ""
    )


def test_a_tag_longer_than_a_whole_message_still_carries_its_text() -> None:
    # No split keeps this markup, so it goes as text — but the link target is
    # the part a reader cannot recover, so it is spelled out rather than lost.
    body = _render("[click](https://example.com/" + "a" * 4090 + ")")

    chunks = chunk_message(body)

    assert all(len(c) <= MAX_MESSAGE for c in chunks)
    assert "click" in chunks[0]
    assert "example.com" in "".join(chunks)


def test_a_blank_line_at_a_boundary_is_not_swallowed() -> None:
    # Only the single newline the cut is made on is the separator; stripping the
    # run would merge two paragraphs into one.
    body = _render("para one\n\n" + "x" * 4200 + "\n\npara two")

    chunks = chunk_message(body)

    assert any("\n\n" in c for c in chunks)


def test_splitting_a_list_loses_only_the_separator_newlines() -> None:
    body = _render("\n".join(f"- **Item {i}**: text" for i in range(2000)))

    chunks = chunk_message(body)

    plain = re.sub(r"<[^>]+>", "", body)
    lost = plain.count("\n") - sum(
        re.sub(r"<[^>]+>", "", c).count("\n") for c in chunks
    )
    # Exactly one per boundary — each piece is its own message.
    assert lost == len(chunks) - 1
