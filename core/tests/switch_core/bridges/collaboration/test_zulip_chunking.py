"""Markdown rendering/mention translation and length-based splitting. Pure
functions, no network."""

from __future__ import annotations

from switch_core.bridges.collaboration.zulip.chunking import (
    defuse_wildcard_mentions,
    split_to_chunks,
    translate_mentions_inbound,
)


def test_defuses_wildcard_all_mention() -> None:
    assert defuse_wildcard_mentions("@**all**") == "@**​all**"


def test_defuses_every_wildcard_word() -> None:
    for word in ("all", "everyone", "channel", "stream", "topic"):
        rendered = defuse_wildcard_mentions(f"@**{word}**")
        assert rendered == f"@**​{word}**"


def test_does_not_defuse_a_real_name_mention() -> None:
    assert defuse_wildcard_mentions("@**Alice Smith**") == "@**Alice Smith**"


def test_translates_a_name_mention_to_plain_at_name() -> None:
    assert translate_mentions_inbound("hi @**Alice Smith**, can you help?") == (
        "hi @Alice Smith, can you help?"
    )


def test_translates_a_disambiguated_mention_dropping_the_user_id() -> None:
    assert translate_mentions_inbound("@**Alice Smith|42**") == "@Alice Smith"


def test_translates_a_silent_mention() -> None:
    assert translate_mentions_inbound("@_**Alice Smith**") == "@Alice Smith"


def test_translates_a_group_mention() -> None:
    assert translate_mentions_inbound("ping @*support team*") == "ping @support team"


def test_split_short_text_is_one_chunk() -> None:
    assert split_to_chunks("hello", max_length=100) == ["hello"]


def test_split_respects_the_length_budget() -> None:
    text = "word " * 500
    chunks = split_to_chunks(text, max_length=200)
    assert len(chunks) > 1
    for chunk in chunks:
        assert len(chunk) <= 200


def test_split_never_breaks_inside_a_fenced_code_block() -> None:
    code = "```\n" + "x" * 300 + "\n```"
    text = f"before\n\n{code}\n\nafter"
    chunks = split_to_chunks(text, max_length=100)
    for chunk in chunks:
        assert chunk.count("```") % 2 == 0, f"unbalanced fence in chunk: {chunk!r}"


def test_split_closes_and_reopens_a_fence_that_spans_a_split() -> None:
    long_code_body = "\n".join(f"line {i}" for i in range(50))
    text = f"```\n{long_code_body}\n```"
    chunks = split_to_chunks(text, max_length=60)
    assert len(chunks) > 1
    for chunk in chunks:
        assert chunk.count("```") % 2 == 0
    # Reassembling the fenced lines (minus the markers this function adds)
    # recovers every original line, in order, none lost or duplicated.
    rebuilt_lines = []
    for chunk in chunks:
        for line in chunk.splitlines():
            if line.strip() != "```":
                rebuilt_lines.append(line)
    assert rebuilt_lines == long_code_body.splitlines()


def test_split_keeps_multibyte_characters_whole() -> None:
    text = "é" * 50 + " " + "x" * 50
    chunks = split_to_chunks(text, max_length=30)
    for chunk in chunks:
        assert len(chunk) <= 30
    assert "".join(chunks).replace(" ", "") == text.replace(" ", "")
