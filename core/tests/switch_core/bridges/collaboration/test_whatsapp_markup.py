"""Switch Markdown to WhatsApp markup and back, and splitting long replies."""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.whatsapp.adapter import (
    WhatsAppAdapter,
    WhatsAppConnectionConfig,
)
from switch_core.bridges.collaboration.whatsapp.chunking import (
    MAX_MESSAGE,
    chunk_message,
)
from switch_core.bridges.collaboration.whatsapp.formatting import (
    to_markdown,
    to_whatsapp,
)


class TestOutbound:
    @pytest.mark.parametrize(
        ("markdown", "whatsapp"),
        [
            ("**bold**", "*bold*"),
            ("__bold__", "*bold*"),
            ("*italic*", "_italic_"),
            ("_italic_", "_italic_"),
            ("***both***", "*_both_*"),
            ("~~gone~~", "~gone~"),
            ("# Plan", "*Plan*"),
            ("### Step two ###", "*Step two*"),
            ("* one\n* two", "- one\n- two"),
            ("[the docs](https://example.com/a)", "the docs (https://example.com/a)"),
            ("[https://example.com](https://example.com)", "https://example.com"),
            ("<https://example.com>", "https://example.com"),
            ("`**literal**`", "`**literal**`"),
            ("```python\nx = **1**\n```", "```x = **1**```"),
            ("> quoted", "> quoted"),
        ],
    )
    def test_markdown_renders_in_whatsapps_markup(
        self, markdown: str, whatsapp: str
    ) -> None:
        assert to_whatsapp(markdown) == whatsapp

    def test_a_link_inside_bold_keeps_its_address_intact(self) -> None:
        assert to_whatsapp("**see [a_b](https://x.y/a_b_c)**") == (
            "*see a_b (https://x.y/a_b_c)*"
        )

    def test_a_console_link_is_rewritten_to_https_before_rendering(self) -> None:
        adapter = WhatsAppAdapter(
            config=WhatsAppConnectionConfig(
                access_token="t",
                phone_number_id="1",
                app_secret="s",
                verify_token="v",
            )
        )
        adapter.set_gateway_public_url("https://gw.example")
        rendered = adapter.translate_outbound(
            "[open](switchdash://open/room/r-1) the room"
        )
        assert "switchdash://" not in rendered
        assert "https://gw.example" in rendered


class TestInbound:
    @pytest.mark.parametrize(
        ("whatsapp", "markdown"),
        [
            ("*bold*", "**bold**"),
            ("_italic_", "_italic_"),
            ("~gone~", "~~gone~~"),
            ("`code`", "`code`"),
            ("```one line```", "`one line`"),
            ("```a\nb```", "```\na\nb\n```"),
            ("2*3*4", "2*3*4"),
            ("plain text", "plain text"),
        ],
    )
    def test_whatsapp_markup_reaches_the_room_as_markdown(
        self, whatsapp: str, markdown: str
    ) -> None:
        assert to_markdown(whatsapp) == markdown

    def test_markup_inside_code_is_left_alone(self) -> None:
        assert to_markdown("```*not bold*```") == "`*not bold*`"


class TestRoundTrip:
    @pytest.mark.parametrize(
        "markdown",
        [
            "**bold** and _italic_ and ~~struck~~",
            "`code` stays `code`",
            "a plain sentence",
            "- one\n- two",
        ],
    )
    def test_markdown_survives_the_trip_through_whatsapp(self, markdown: str) -> None:
        assert to_markdown(to_whatsapp(markdown)) == markdown


class TestChunking:
    def test_a_short_body_is_one_message(self) -> None:
        assert chunk_message("hello") == ["hello"]

    def test_a_long_body_splits_on_paragraphs(self) -> None:
        paragraph = "x" * 3000
        chunks = chunk_message(f"{paragraph}\n\n{paragraph}")
        assert chunks == [paragraph, paragraph]

    def test_without_paragraphs_it_splits_on_lines_then_words(self) -> None:
        lines = "\n".join(["word " * 20] * 100)
        chunks = chunk_message(lines)
        assert all(len(c) <= MAX_MESSAGE for c in chunks)
        assert "".join(chunks).replace("\n", "") == lines.replace("\n", "")

    def test_one_unbroken_run_is_cut_hard_and_loses_nothing(self) -> None:
        run = "y" * (MAX_MESSAGE * 2 + 10)
        chunks = chunk_message(run)
        assert all(len(c) <= MAX_MESSAGE for c in chunks)
        assert "".join(chunks) == run

    def test_a_code_block_cut_in_two_is_closed_and_reopened(self) -> None:
        code = "\n".join(f"    line {i}" for i in range(600))
        chunks = chunk_message(f"```{code}```")
        assert len(chunks) > 1
        assert all(len(c) <= MAX_MESSAGE for c in chunks)
        assert all(c.count("```") == 2 for c in chunks)
        assert chunks[1].startswith("```\n    line")
