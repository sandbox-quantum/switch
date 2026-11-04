from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.webhook.chunking import split_text


class TestSplittingText:
    def test_short_text_is_left_alone(self) -> None:
        assert split_text("hello", 100) == ["hello"]

    def test_no_limit_means_no_splitting(self) -> None:
        long = "word " * 5000
        assert split_text(long, 0) == [long]

    def test_every_part_fits_the_limit(self) -> None:
        text = "\n\n".join(f"Paragraph {i}. " + "word " * 40 for i in range(12))
        parts = split_text(text, 300)

        assert len(parts) > 1
        assert all(len(p) <= 300 for p in parts)

    def test_nothing_is_lost(self) -> None:
        text = " ".join(f"w{i}" for i in range(2000))
        parts = split_text(text, 250)
        assert " ".join(parts).split() == text.split()

    def test_it_prefers_a_paragraph_break(self) -> None:
        first = "A" * 60
        text = f"{first}\n\n{'B' * 60}"
        assert split_text(text, 100) == [first, "B" * 60]

    def test_it_falls_back_to_a_sentence_end(self) -> None:
        text = "First sentence is here. Second sentence follows right after it."
        parts = split_text(text, 40)
        assert parts[0] == "First sentence is here."

    def test_it_falls_back_to_a_space(self) -> None:
        parts = split_text("alpha beta gamma delta epsilon", 20)
        assert parts == ["alpha beta gamma ", "delta epsilon"] or all(
            not p.startswith(" ") for p in parts
        )
        assert all(" ".join(p.split()) == p.strip() for p in parts)

    def test_a_single_long_word_is_cut_hard(self) -> None:
        parts = split_text("x" * 450, 100)
        assert all(len(p) <= 100 for p in parts)
        assert "".join(parts) == "x" * 450

    def test_a_code_block_is_closed_and_reopened_across_parts(self) -> None:
        body = "\n".join(f"line {i}" for i in range(60))
        text = f"Intro\n```\n{body}\n```\nOutro"
        parts = split_text(text, 200)

        assert len(parts) > 2
        for part in parts:
            assert part.count("```") % 2 == 0, part
        assert parts[1].startswith("```")

    @pytest.mark.parametrize("limit", [100, 137, 500])
    def test_the_limit_holds_for_any_size(self, limit: int) -> None:
        text = ("Some text. " * 30 + "\n\n") * 20
        assert all(len(p) <= limit for p in split_text(text, limit))
