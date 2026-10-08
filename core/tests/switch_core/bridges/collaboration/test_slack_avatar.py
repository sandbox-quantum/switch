import asyncio
import logging
from urllib.parse import parse_qs, urlsplit

import pytest

from switch_core.agent_icon import generated_icon_url, initials_icon_url
from switch_core.bridges.collaboration.adapter import AgentPresentation
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.slack.avatar import (
    SLACK_ICON_URL_MAX,
    SLACK_SURFACE,
    on_slack_background,
    slack_icon_argument,
)

DICEBEAR = generated_icon_url("worker")


def _background(url: str) -> list[str]:
    return parse_qs(urlsplit(url).query).get("backgroundColor", [])


def _options(url: str) -> dict[str, list[str]]:
    """Each option's values, however the URL spells a list of them."""
    return {
        key: [item for value in values for item in value.split(",")]
        for key, values in parse_qs(urlsplit(url).query).items()
    }


def test_gives_a_dicebear_avatar_slacks_background() -> None:
    # Without this the PNG is transparent and Slack flattens it onto white,
    # putting a bright square around every agent in a dark message list.
    assert _background(on_slack_background(DICEBEAR)) == [SLACK_SURFACE]


def test_keeps_the_rest_of_the_url_intact() -> None:
    # The seed decides which face is drawn: lose it and the agent changes face.
    query = _options(on_slack_background(DICEBEAR))
    assert query["seed"] == ["worker"]
    assert {
        key: values for key, values in query.items() if key != "backgroundColor"
    } == _options(DICEBEAR)


def test_writes_the_shapes_as_one_comma_list() -> None:
    # Spelled out one parameter per shape, a generated icon runs past the 255
    # characters Slack accepts, and Slack refuses the whole post. DiceBear
    # draws the same image from the list, which is kept unencoded.
    adapted = on_slack_background(DICEBEAR)
    assert "%2C" not in adapted
    assert parse_qs(urlsplit(adapted).query)["shapeVariant"] == [
        ",".join(_options(DICEBEAR)["shapeVariant"])
    ]


def test_a_generated_icon_for_a_uuid_seed_fits_slacks_limit() -> None:
    # Console seeds a new agent's icon with a UUID.
    adapted = on_slack_background(
        generated_icon_url("0faf365b-e9bc-4d38-8438-ab50087065eb")
    )
    assert len(adapted) <= SLACK_ICON_URL_MAX


def test_leaves_a_background_that_was_already_chosen() -> None:
    chosen = f"{DICEBEAR}&backgroundColor=ff0000"
    assert _background(on_slack_background(chosen)) == ["ff0000"]


def test_leaves_an_operators_own_image_alone() -> None:
    # There is no parameter to add to someone else's URL, and rewriting one on
    # a guess would be worse than leaving it as authored.
    custom = "https://example.com/avatar.png"
    assert on_slack_background(custom) == custom


def test_leaves_the_initials_badge_alone() -> None:
    # ui-avatars already draws an opaque background, so it has no white square
    # to fix and its own colour must survive.
    badge = initials_icon_url("switch_worker")
    assert on_slack_background(badge) == badge


def test_does_not_match_a_lookalike_host() -> None:
    # `api.dicebear.com.evil.test` is not DiceBear; only the exact host is.
    impostor = "https://api.dicebear.com.evil.test/10.x/gaze/png?seed=worker"
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

    async def resolver(name: str) -> AgentPresentation | None:
        return AgentPresentation(display_name=None, icon_url=DICEBEAR)

    adapter.set_agent_presentation_resolver(resolver)

    resolved = asyncio.run(adapter.agent_icon_url("worker"))
    assert _background(resolved) == [SLACK_SURFACE]


def test_hands_slack_an_icon_url_up_to_its_limit() -> None:
    at_limit = "https://example.com/" + "a" * (SLACK_ICON_URL_MAX - 20)
    assert len(at_limit) == SLACK_ICON_URL_MAX
    assert slack_icon_argument(at_limit, "worker") == at_limit


def test_sends_no_icon_url_past_slacks_limit() -> None:
    # Slack refuses the post itself over this, so the message would be lost.
    over = "https://example.com/" + "a" * (SLACK_ICON_URL_MAX - 19)
    assert slack_icon_argument(over, "worker") is None


def test_an_oversized_icon_is_reported_once(caplog: pytest.LogCaptureFixture) -> None:
    # An agent posts every turn; one unchanged condition is one warning.
    oversized = "https://icons.example/" + "a" * 300 + "-once.png"
    with caplog.at_level(logging.WARNING):
        assert slack_icon_argument(oversized, "worker") is None
        assert slack_icon_argument(oversized, "worker") is None
    assert len([r for r in caplog.records if "over Slack's limit" in r.message]) == 1
