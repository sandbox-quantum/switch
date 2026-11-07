"""Links to Switch Console pages on each chat platform.

An agent (switch-buddy above all) points a person at a Console page with a
Markdown link to `switchdash://open/…`. Slack, Discord, Telegram and Teams
cannot open that scheme: Slack wrote it as a link its clients ignore, Discord
left it as text, Telegram made it tap-to-copy code and Teams stripped it to
"()". So the bridge rewrites it to the server's https handoff route, keeping
the label, or names the page in words when the server has no public address.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.adapter import PlatformAdapter
from tests.switch_core.bridges.collaboration.test_room_wide_mention_rendering import (
    ADAPTERS,
)

GATEWAY = "https://switch.example"
BODY = "Open [Agent settings](switchdash://open/agent/abc?tab=settings) to change it."
HTTPS = "https://switch.example/deeplink/open/agent/abc?tab=settings"


def _adapter(platform: str, gateway_public_url: str | None) -> PlatformAdapter:
    adapter = ADAPTERS[platform]()
    adapter.set_gateway_public_url(gateway_public_url)
    return adapter


@pytest.mark.parametrize(
    ("platform", "expected"),
    [
        ("slack", f"Open <{HTTPS}|Agent settings> to change it."),
        ("discord", f"Open [Agent settings]({HTTPS}) to change it."),
        ("telegram", f'Open <a href="{HTTPS}">Agent settings</a> to change it.'),
        ("teams", f"Open [Agent settings]({HTTPS}) to change it."),
    ],
)
def test_platforms_that_cannot_open_the_scheme_get_an_https_link(
    platform: str, expected: str
) -> None:
    adapter = _adapter(platform, GATEWAY)

    assert not adapter.renders_custom_url_schemes
    assert adapter.translate_outbound(BODY) == expected


@pytest.mark.parametrize("platform", ["slack", "discord", "telegram", "teams"])
def test_without_a_public_address_the_page_is_named_in_words(platform: str) -> None:
    adapter = _adapter(platform, None)

    rendered = adapter.translate_outbound(BODY)

    assert "Agent settings (in Switch Console: your agent's settings)" in rendered
    assert "switchdash://" not in rendered
    assert "http" not in rendered


def test_a_link_inside_code_is_left_as_written() -> None:
    adapter = _adapter("discord", GATEWAY)
    body = "Write `[x](switchdash://open/home)` like that."

    assert adapter.translate_outbound(body) == body


def test_a_link_to_a_page_console_does_not_have_is_left_as_written() -> None:
    adapter = _adapter("discord", GATEWAY)
    body = "[Nowhere](switchdash://open/nowhere)"

    assert adapter.translate_outbound(body) == body


def test_a_session_deeplink_is_not_a_console_page_link() -> None:
    adapter = _adapter("discord", GATEWAY)
    body = "[Session](switchdash://session?room=r)"

    assert adapter.translate_outbound(body) == body
