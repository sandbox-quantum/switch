"""WhatsApp's own markup, both ways, and how a long reply is split."""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.whatsapp.markup import (
    MAX_TEXT,
    chunk_text,
    to_switch_markdown,
    to_whatsapp,
)


@pytest.mark.parametrize(
    ("markdown", "whatsapp"),
    [
        ("**bold** and __bold__", "*bold* and *bold*"),
        ("*italic* and _italic_", "_italic_ and _italic_"),
        ("~~gone~~", "~gone~"),
        ("# Heading\n## Sub", "*Heading*\n*Sub*"),
        ("* one\n+ two\n- three", "- one\n- two\n- three"),
        ("[docs](https://example.com/a)", "docs (https://example.com/a)"),
        ("[https://example.com](https://example.com)", "https://example.com"),
        ("![chart](https://example.com/c.png)", "chart (https://example.com/c.png)"),
        ("> quoted", "> quoted"),
        ("***both***", "*_both_*"),
        ("# Heading **bold**", "*Heading bold*"),
        ("https://x.example/pkg/__init__.py", "https://x.example/pkg/__init__.py"),
        ("plain text", "plain text"),
    ],
)
def test_switch_markdown_becomes_whatsapp_markup(markdown: str, whatsapp: str) -> None:
    assert to_whatsapp(markdown) == whatsapp


def test_code_is_left_exactly_as_written() -> None:
    markdown = "run `rm **not bold**` then\n```python\nx = a*b*c\n```"

    assert to_whatsapp(markdown) == "run `rm **not bold**` then\n```\nx = a*b*c\n```"


def test_a_link_label_is_converted_but_its_address_is_not() -> None:
    assert (
        to_whatsapp("[**read** this](https://example.com/a_b_c)")
        == "*read* this (https://example.com/a_b_c)"
    )


@pytest.mark.parametrize(
    ("whatsapp", "markdown"),
    [
        ("*bold*", "**bold**"),
        ("_italic_", "_italic_"),
        ("~gone~", "~~gone~~"),
        ("2*3*4 stays", "2*3*4 stays"),
        ("snake_case_name stays", "snake_case_name stays"),
        ("`inline` and ```block```", "`inline` and ```block```"),
        ("```*not bold*```", "```*not bold*```"),
        ("@triage can you look", "@triage can you look"),
        ("https://x.example/*a*", "https://x.example/*a*"),
    ],
)
def test_whatsapp_markup_becomes_switch_markdown(whatsapp: str, markdown: str) -> None:
    assert to_switch_markdown(whatsapp) == markdown


def test_a_short_text_is_one_chunk() -> None:
    assert chunk_text("hello", MAX_TEXT) == ["hello"]


def test_a_long_text_splits_at_paragraphs_and_every_chunk_fits() -> None:
    paragraph = "word " * 300
    text = "\n\n".join([paragraph.strip()] * 5)

    chunks = chunk_text(text, MAX_TEXT)

    assert len(chunks) > 1
    assert all(len(chunk) <= MAX_TEXT for chunk in chunks)
    assert all(chunk == chunk.strip("\n").rstrip() for chunk in chunks)
    assert " ".join(" ".join(chunks).split()) == " ".join(text.split())


def test_a_split_inside_a_code_block_closes_and_reopens_the_fence() -> None:
    code = "\n".join(f"line {n}" for n in range(60))
    text = f"intro\n```\n{code}\n```"

    chunks = chunk_text(text, 200)

    assert len(chunks) > 2
    assert all(len(chunk) <= 200 for chunk in chunks)
    assert all(chunk.count("```") % 2 == 0 for chunk in chunks)
    joined = "\n".join(chunk.replace("```", "") for chunk in chunks)
    assert all(f"line {n}" in joined for n in range(60))


def test_a_word_longer_than_the_limit_is_cut_rather_than_lost() -> None:
    chunks = chunk_text("x" * 250, 100)

    assert chunks == ["x" * 100, "x" * 100, "x" * 50]


def test_code_indentation_survives_a_split() -> None:
    code = "\n".join(f"    line {n}" for n in range(60))
    chunks = chunk_text(f"```\n{code}\n```", 200)

    body = [line for chunk in chunks for line in chunk.splitlines() if "line" in line]
    assert len(body) == 60
    assert all(line.startswith("    line") for line in body)


def test_the_marks_this_module_writes_cannot_come_from_the_text() -> None:
    assert to_switch_markdown("\x000\x00 *b*") == "0 **b**"
