"""Where an `@name` mention starts and ends."""

from __future__ import annotations

import pytest

from switch_core.clients.mention_warnings import unmatched_mentions
from switch_core.clients.mentions import (
    mention_regex,
    mention_tokens,
    unique_mention_tokens,
)
from switch_core.delivery.conversation import mentioned_names, mentions_anyone


def _mentions(name: str, text: str) -> bool:
    return mention_regex(name).search(text) is not None


class TestMentionEnd:
    @pytest.mark.parametrize(
        "text",
        [
            "Can you review this, @reviewer.",
            "Can you review this @reviewer...",
            "@reviewer, can you look?",
            "thanks @reviewer!",
            "is that right @reviewer?",
            "(@reviewer)",
            "_@reviewer_ please",
            "@reviewer- and the rest",
            "@reviewer.\nNext line",
            "@reviewer",
        ],
    )
    def test_trailing_punctuation_is_not_part_of_the_name(self, text: str) -> None:
        assert _mentions("reviewer", text)

    @pytest.mark.parametrize(
        "text",
        [
            "@reviewer.bot please",
            "@reviewer-2 please",
            "@reviewer_two please",
            "@reviewers please",
        ],
    )
    def test_a_longer_name_is_not_a_mention_of_its_prefix(self, text: str) -> None:
        assert not _mentions("reviewer", text)

    def test_prefix_name_inside_a_longer_name(self) -> None:
        assert not _mentions("cc-bug-fixing", "@cc-bug-fixing-2 take this")
        assert _mentions("cc-bug-fixing-2", "@cc-bug-fixing-2 take this")

    def test_a_dotted_name_matches_whole(self) -> None:
        assert _mentions(
            "claude-code.my-project.alice", "@claude-code.my-project.alice."
        )

    def test_case_insensitive(self) -> None:
        assert _mentions("reviewer", "@Reviewer.")


class TestMentionStart:
    @pytest.mark.parametrize(
        "text",
        [
            "ssh root@staging is failing",
            "mail ops@staging.",
            "ops@staging",
        ],
    )
    def test_an_at_inside_a_word_is_not_a_mention(self, text: str) -> None:
        assert not _mentions("staging", text)

    def test_an_email_address_names_nobody(self) -> None:
        assert not _mentions("example", "write to ops@example.com")
        assert mention_tokens("write to ops@example.com") == []

    @pytest.mark.parametrize(
        "text", ["@staging", " @staging", "(@staging)", ".@staging"]
    )
    def test_an_at_that_starts_a_word_is_a_mention(self, text: str) -> None:
        assert _mentions("staging", text)


class TestMentionTokens:
    def test_tokens_leave_trailing_punctuation_out(self) -> None:
        assert mention_tokens("ping @reviewer. and @helper... and @ops-") == [
            "reviewer",
            "helper",
            "ops",
        ]

    def test_tokens_keep_inner_punctuation(self) -> None:
        assert mention_tokens("@claude-code.my-project.alice.") == [
            "claude-code.my-project.alice"
        ]

    def test_tokens_skip_addresses(self) -> None:
        assert mention_tokens("ssh root@staging, then @deployer") == ["deployer"]

    def test_unique_tokens(self) -> None:
        assert unique_mention_tokens("@Reviewer. @reviewer, @helper") == [
            "Reviewer",
            "helper",
        ]

    def test_a_sentence_end_mention_is_not_unmatched(self) -> None:
        assert unmatched_mentions("Look at this, @reviewer.", ["reviewer"]) == []

    def test_an_address_is_not_unmatched(self) -> None:
        assert unmatched_mentions("ssh root@staging", []) == []


class TestConversationMentions:
    def test_mentioned_names_without_punctuation(self) -> None:
        assert mentioned_names("thanks @Reviewer.") == {"reviewer"}

    def test_mentions_anyone(self) -> None:
        assert mentions_anyone("over to you, @reviewer.")
        assert not mentions_anyone("write to ops@example.com")
