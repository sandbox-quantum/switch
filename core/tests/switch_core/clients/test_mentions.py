from switch_core.clients.mentions import mention_regex, mention_tokens


def test_trailing_punctuation_still_addresses_agent() -> None:
    for punctuation in (".", ",", "...", "-"):
        assert mention_regex("reviewer").search(f"please review, @reviewer{punctuation}")


def test_longer_dotted_name_is_not_a_prefix_match() -> None:
    assert not mention_regex("reviewer").search("@reviewer.bot")
    assert mention_regex("reviewer.bot").search("@reviewer.bot")


def test_email_and_embedded_at_are_not_mentions() -> None:
    for text in ("ssh root@staging", "ops@example.com", "user@agent"):
        assert not mention_regex("staging").search(text)
        assert not mention_regex("agent").search(text)


def test_mention_tokens_strip_only_terminal_punctuation() -> None:
    assert mention_tokens("@reviewer. @reviewer... @reviewer- @reviewer.bot") == [
        "reviewer", "reviewer", "reviewer", "reviewer.bot"
    ]


def test_mention_tokens_ignore_embedded_at_and_preserve_prefix_names() -> None:
    assert mention_tokens("root@staging @cc-bug-fixing-2") == ["cc-bug-fixing-2"]
    assert not mention_regex("cc-bug-fixing").search("@cc-bug-fixing-2")
    assert mention_regex("cc-bug-fixing-2").search("@cc-bug-fixing-2")
