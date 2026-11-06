"""How a reply is cut into SMS-sized parts, and how its cost is counted."""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.sms.segments import (
    TRUNCATION_NOTE,
    plan_reply,
    segment_count,
    to_plain_text,
    uses_gsm7,
)

RIGHT_QUOTE = "’"
PARTY = "\U0001f389"


class TestEncoding:
    def test_plain_ascii_is_gsm7(self) -> None:
        assert uses_gsm7("Hello, build 42 passed!")

    def test_an_emoji_forces_unicode(self) -> None:
        assert not uses_gsm7(f"done {PARTY}")

    def test_curly_quotes_force_unicode(self) -> None:
        assert not uses_gsm7(f"it{RIGHT_QUOTE}s done")


class TestSegmentCount:
    def test_empty_costs_nothing(self) -> None:
        assert segment_count("") == 0

    def test_160_gsm_characters_are_one_segment(self) -> None:
        assert segment_count("a" * 160) == 1

    def test_161_gsm_characters_are_two_segments(self) -> None:
        assert segment_count("a" * 161) == 2

    def test_a_concatenated_gsm_segment_holds_153(self) -> None:
        assert segment_count("a" * 306) == 2
        assert segment_count("a" * 307) == 3

    def test_70_unicode_characters_are_one_segment(self) -> None:
        assert segment_count(RIGHT_QUOTE * 70) == 1
        assert segment_count(RIGHT_QUOTE * 71) == 2

    def test_a_unicode_concatenated_segment_holds_67(self) -> None:
        assert segment_count(RIGHT_QUOTE * 134) == 2
        assert segment_count(RIGHT_QUOTE * 135) == 3

    def test_gsm_extension_characters_count_twice(self) -> None:
        assert segment_count("{" * 80) == 1
        assert segment_count("{" * 81) == 2

    def test_a_character_outside_the_bmp_counts_two_unicode_units(self) -> None:
        assert segment_count(PARTY * 35) == 1
        assert segment_count(PARTY * 36) == 2


class TestPlainText:
    def test_emphasis_markers_are_removed(self) -> None:
        assert to_plain_text("**bold** and _soft_ and `code`") == (
            "bold and soft and code"
        )

    def test_a_link_keeps_its_target(self) -> None:
        assert to_plain_text("see [the docs](https://example.com/d)") == (
            "see the docs (https://example.com/d)"
        )

    def test_headings_lose_their_hashes(self) -> None:
        assert to_plain_text("## Result\nok") == "Result\nok"

    def test_code_fences_are_dropped_but_their_content_stays(self) -> None:
        assert to_plain_text("```py\nprint(1)\n```") == "print(1)"

    def test_blank_runs_collapse(self) -> None:
        assert to_plain_text("a\n\n\n\nb") == "a\n\nb"


def _body(part: str) -> str:
    return part.split(") ", 1)[1]


class TestPlanReply:
    def test_a_short_reply_is_one_unnumbered_part(self) -> None:
        plan = plan_reply("Build passed.", max_segments=8)
        assert plan.parts == ["Build passed."]
        assert not plan.truncated

    def test_a_long_reply_is_split_and_numbered(self) -> None:
        text = " ".join(f"Sentence number {i} is here." for i in range(40))
        plan = plan_reply(text, max_segments=20)
        assert len(plan.parts) > 1
        assert not plan.truncated
        total = len(plan.parts)
        for index, part in enumerate(plan.parts, start=1):
            assert part.startswith(f"({index}/{total}) ")

    def test_no_part_is_over_three_segments(self) -> None:
        text = " ".join(f"word{i}" for i in range(600))
        plan = plan_reply(text, max_segments=20)
        for part in plan.parts:
            assert segment_count(part) <= 3

    def test_unicode_parts_stay_within_three_segments(self) -> None:
        text = " ".join(f"café{RIGHT_QUOTE}s {i}" for i in range(300))
        plan = plan_reply(text, max_segments=20)
        for part in plan.parts:
            assert segment_count(part) <= 3

    def test_splits_prefer_sentence_boundaries(self) -> None:
        sentence = "This sentence is exactly fifty characters long ok."
        text = " ".join([sentence] * 20)
        plan = plan_reply(text, max_segments=20)
        for part in plan.parts:
            assert part.rstrip().endswith("ok.")

    def test_a_word_longer_than_a_part_is_cut_hard(self) -> None:
        plan = plan_reply("x" * 2000, max_segments=20)
        assert len(plan.parts) > 1
        assert "".join(_body(p) for p in plan.parts) == "x" * 2000

    def test_the_whole_reply_never_exceeds_the_cap(self) -> None:
        text = " ".join(f"word{i}" for i in range(5000))
        plan = plan_reply(text, max_segments=8)
        assert plan.truncated
        assert sum(segment_count(p) for p in plan.parts) <= 8

    def test_a_cut_reply_ends_with_the_note(self) -> None:
        text = " ".join(f"word{i}" for i in range(5000))
        plan = plan_reply(text, max_segments=8)
        assert plan.parts[-1] == TRUNCATION_NOTE
        assert segment_count(TRUNCATION_NOTE) == 1
        assert uses_gsm7(TRUNCATION_NOTE)

    def test_text_that_exactly_fits_is_not_cut(self) -> None:
        plan = plan_reply("a" * 160, max_segments=8)
        assert not plan.truncated
        assert plan.parts == ["a" * 160]

    def test_nothing_is_lost_below_the_cap(self) -> None:
        words = [f"w{i}" for i in range(80)]
        plan = plan_reply(" ".join(words), max_segments=20)
        rebuilt = " ".join(_body(p) for p in plan.parts).split()
        assert rebuilt == words

    @pytest.mark.parametrize("cap", [0, 3])
    def test_a_cap_too_small_for_one_part_is_refused(self, cap: int) -> None:
        with pytest.raises(ValueError):
            plan_reply("hello", max_segments=cap)

    def test_empty_text_has_no_parts(self) -> None:
        assert plan_reply("   ", max_segments=8).parts == []
