import asyncio
from urllib.parse import parse_qs, urlsplit

from switch_core.agent_icon import default_icon_url
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.slack.avatar import (
    SLACK_SURFACE,
    on_slack_background,
)

DICEBEAR = "https://api.dicebear.com/9.x/bottts/png?seed=worker&size=256"


def _background(url: str) -> list[str]:
    return parse_qs(urlsplit(url).query).get("backgroundColor", [])


def test_gives_a_dicebear_avatar_slacks_background() -> None:
    # Without this the PNG is transparent and Slack flattens it onto white,
    # putting a bright square around every agent in a dark message list.
    assert _background(on_slack_background(DICEBEAR)) == [SLACK_SURFACE]


def test_keeps_the_rest_of_the_url_intact() -> None:
    # The seed decides which bot is drawn: lose it and the agent changes face.
    query = parse_qs(urlsplit(on_slack_background(DICEBEAR)).query)
    assert query["seed"] == ["worker"]
    assert query["size"] == ["256"]


def test_leaves_a_background_that_was_already_chosen() -> None:
    chosen = f"{DICEBEAR}&backgroundColor=ff0000"
    assert on_slack_background(chosen) == chosen


def test_leaves_an_operators_own_image_alone() -> None:
    # There is no parameter to add to someone else's URL, and rewriting one on
    # a guess would be worse than leaving it as authored.
    custom = "https://example.com/avatar.png"
    assert on_slack_background(custom) == custom


def test_leaves_the_initials_default_alone() -> None:
    # ui-avatars already draws an opaque background, so it has no white square
    # to fix and its own colour must survive.
    default = default_icon_url("switch_worker")
    assert on_slack_background(default) == default


def test_does_not_match_a_lookalike_host() -> None:
    # `api.dicebear.com.evil.test` is not DiceBear; only the exact host is.
    impostor = "https://api.dicebear.com.evil.test/9.x/bottts/png?seed=worker"
    assert on_slack_background(impostor) == impostor


def test_adds_the_background_once_when_applied_twice() -> None:
    assert _background(on_slack_background(on_slack_background(DICEBEAR))) == [
        SLACK_SURFACE
    ]


def test_the_slack_adapter_applies_it_to_a_resolved_icon() -> None:
    """The override wired to the resolver, which is the thing that actually has
    to work and which none of the tests above prove on its own."""
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test",
            app_token="xapp-test",
            workspace_id="T123",
        )
    )

    async def resolver(name: str) -> str | None:
        return DICEBEAR

    adapter.set_agent_icon_resolver(resolver)

    resolved = asyncio.run(adapter.agent_icon_url("worker"))
    assert _background(resolved) == [SLACK_SURFACE]
