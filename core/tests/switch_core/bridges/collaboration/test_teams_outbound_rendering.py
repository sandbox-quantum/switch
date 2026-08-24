"""CHOO-2067 — what an agent's message looks like once it reaches Teams.

Three faults, all seen in one screenshot from switch-dev: a Slack-shaped
`<@28:11111111-…>` printed at the reader, an `@name` that highlighted nobody,
and a heading running into the line beneath it.
"""

from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.teams.cards import agent_message_card


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _adapter(**targets: str) -> TeamsAdapter:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="app-123",
            app_password="secret",
            tenant_id="tenant-9",
            team_id="team-7",
            public_base_url="https://switch.example",
            client_state="s3cr3t",
        )
    )
    if targets:
        adapter.prime_mention_targets(dict(targets))
    return adapter


# ── @mentions ────────────────────────────────────────────────────────────────


def test_a_known_person_becomes_real_mention_markup() -> None:
    adapter = _adapter(alice="aad-alice")

    assert adapter.translate_outbound("hi @alice") == "hi <at>alice</at>"


def test_the_markup_is_matched_by_an_entity_or_it_highlights_nobody() -> None:
    adapter = _adapter(alice="aad-alice")
    body = adapter.translate_outbound("hi @alice")

    assert adapter._mention_entities(body) == [
        {
            "type": "mention",
            "text": "<at>alice</at>",
            "mentioned": {"id": "aad-alice", "name": "alice"},
        }
    ]


def test_mention_matching_ignores_case() -> None:
    adapter = _adapter(Alice="aad-alice")

    assert adapter.translate_outbound("hi @alice") == "hi <at>alice</at>"


def test_an_unknown_name_is_left_alone() -> None:
    # Agent names land here: an agent is not a Teams user, and Switch's own
    # addressing wants the plain `@name`. Marking it would render a mention
    # that highlights nobody.
    adapter = _adapter(alice="aad-alice")

    assert adapter.translate_outbound("ask @james about it") == ("ask @james about it")
    assert adapter._mention_entities("ask @james about it") == []


def test_a_name_repeated_gets_one_entity() -> None:
    adapter = _adapter(alice="aad-alice")
    body = adapter.translate_outbound("@alice ping @alice again")

    assert body.count("<at>alice</at>") == 2
    assert len(adapter._mention_entities(body)) == 1


def test_the_card_carries_mentions_where_teams_looks_for_them() -> None:
    # On a card the entities live under `msteams`, not on the activity.
    adapter = _adapter(alice="aad-alice")
    body = adapter.translate_outbound("hi @alice")

    activity = _run(adapter._message_activity("james", body))
    card = activity["attachments"][0]["content"]

    assert card["msteams"]["entities"][0]["mentioned"]["id"] == "aad-alice"


def test_a_card_with_no_mentions_carries_no_msteams_block() -> None:
    assert "msteams" not in agent_message_card("james", "hello", "http://icon")


# ── the app's own handle ─────────────────────────────────────────────────────


def test_the_app_is_named_in_words_not_in_slack_syntax() -> None:
    # This is the `<@28:11111111-…>` from the screenshot. Teams has no inline
    # syntax that turns its app id into a mention, so printing one at the
    # reader is strictly worse than saying "me".
    adapter = _adapter()

    rendered = adapter.render_app_mention("28:11111111-2222-3333-4444-555555555555")

    assert rendered == "me"
    assert "<@" not in rendered


# ── line breaks ──────────────────────────────────────────────────────────────


def test_a_single_newline_survives() -> None:
    # Adaptive Cards follow Markdown: one newline is whitespace. This is the
    # heading that ran into the sentence under it.
    adapter = _adapter()

    assert adapter.translate_outbound("**Heading:**\nbody") == ("**Heading:**\n\nbody")


def test_an_existing_paragraph_gap_is_not_widened() -> None:
    adapter = _adapter()

    assert adapter.translate_outbound("one\n\ntwo") == "one\n\ntwo"


def test_list_items_keep_their_own_lines() -> None:
    adapter = _adapter()

    rendered = adapter.translate_outbound("- one\n- two")

    assert rendered == "- one\n\n- two"
    assert rendered.count("- ") == 2


def test_a_body_with_no_newlines_is_unchanged() -> None:
    adapter = _adapter()

    assert adapter.translate_outbound("just a sentence") == "just a sentence"


# ── translated once, not twice ───────────────────────────────────────────────


def test_send_message_does_not_translate_again() -> None:
    # Callers of send_message translate first, by documented contract. The
    # adapter used to translate a second time, which is invisible while
    # translation is a no-op and corrupting the moment it is not — doubling
    # every newline again, and re-marking text that was already marked.
    adapter = _adapter(alice="aad-alice")
    already = adapter.translate_outbound("hi @alice\nthere")

    activity = _run(adapter._message_activity("james", already))

    assert activity["attachments"][0]["content"]["body"][-1]["text"] == already
    assert "<at><at>" not in already
    assert "\n\n\n" not in already


# ── commands ─────────────────────────────────────────────────────────────────


def test_both_command_prefixes_name_the_same_command() -> None:
    # Teams has no server-registered slash commands: a manifest command list
    # types the text into the compose box, so `/help` arrives as an ordinary
    # message. By the time we see it the two prefixes are the same thing.
    assert TeamsAdapter._command_name("!list-agents") == "list-agents"
    assert TeamsAdapter._command_name("/list-agents") == "list-agents"


def test_a_bare_word_is_not_mistaken_for_a_command_name() -> None:
    assert TeamsAdapter._command_name("list-agents") == "list-agents"


def test_the_invite_hint_offers_the_slash_form_unconditionally() -> None:
    hint = _adapter().slash_invite_hint()

    assert hint is not None
    assert "/invite-agent" in hint
    # Teams has no server-registered slash commands, so `/` is just a message
    # prefix the bot parses. It works whether or not the operator has declared
    # a command list, and the hint must not imply otherwise.
    assert "manifest" not in hint
