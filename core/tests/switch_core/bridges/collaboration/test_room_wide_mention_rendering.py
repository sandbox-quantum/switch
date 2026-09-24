"""How each platform renders a room-wide mention, and why nothing else pages.

Only a message the server marked may page a channel. So two things are pinned
for every real adapter: a marked message opens with the platform's own
channel-wide mention, and no ordinary body — whatever tokens an agent writes
into it — reaches the platform able to page anyone.
"""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)
from switch_core.room_wide_mention import room_wide_mention_content
from switch_core.transport import InboundMessage, RoomRef

ZWSP = "\u200b"


def _slack() -> SlackAdapter:
    return SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
        )
    )


def _mattermost() -> MattermostAdapter:
    return MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm", admin_user="admin", admin_password="pw", team_name="team"
        )
    )


def _discord() -> DiscordAdapter:
    return DiscordAdapter(config=DiscordConnectionConfig(bot_token="t", guild_id="900"))


def _teams() -> TeamsAdapter:
    return TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="app-123",
            app_password="secret",
            tenant_id="tenant-9",
            team_id="team-7",
            public_base_url="https://switch.example",
            client_state="s3cr3t",
        )
    )


def _telegram() -> TelegramAdapter:
    return TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username="switch_bot")
    )


ADAPTERS = {
    "slack": _slack,
    "mattermost": _mattermost,
    "discord": _discord,
    "teams": _teams,
    "telegram": _telegram,
}


# ── A marked message ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("platform", "expected"),
    [
        ("slack", "<!channel> deploy at five"),
        ("mattermost", "@channel deploy at five"),
        ("discord", "@everyone deploy at five"),
        # No channel-wide mention a bot can send: the token stays legible and
        # inert, and the agent is told `unsupported`.
        ("teams", f"@{ZWSP}everyone deploy at five"),
        # Every member is notified of every message anyway, so an inert token
        # says who it was for without linking to a public `@everyone` handle.
        ("telegram", f"@{ZWSP}everyone deploy at five"),
    ],
)
def test_a_marked_message_opens_with_the_platforms_own_mention(
    platform: str, expected: str
) -> None:
    adapter = ADAPTERS[platform]()
    assert adapter.render_room_wide_mention("@everyone deploy at five") == expected


@pytest.mark.parametrize(
    ("platform", "notifies"),
    [
        ("slack", True),
        ("mattermost", True),
        ("discord", True),
        ("teams", False),
        ("telegram", True),
    ],
)
def test_what_each_platform_reports_back(platform: str, notifies: bool) -> None:
    assert ADAPTERS[platform]().room_wide_mention_notifies is notifies


def test_the_rest_of_a_marked_message_is_still_defused() -> None:
    # One page per message: an `@here` the agent wrote into the body of a
    # room-wide mention is not a second one.
    rendered = _mattermost().render_room_wide_mention("@everyone ping @here too")
    assert rendered == f"@channel ping @{ZWSP}here too"


def test_a_person_called_everyone_is_not_who_a_room_wide_mention_names() -> None:
    adapter = _slack()
    adapter.prime_mention_targets({"everyone": "U999"})

    assert adapter.render_room_wide_mention("@everyone hi") == "<!channel> hi"


def test_a_marked_message_with_no_body_is_just_the_mention() -> None:
    assert _slack().render_room_wide_mention("@everyone") == "<!channel>"


# ── An ordinary message ──────────────────────────────────────────────────────

STRAY = [
    "@everyone",
    "@channel",
    "@here",
    "@all",
    "@Channel.",
    "ping @here, please",
]


@pytest.mark.parametrize("platform", ADAPTERS)
@pytest.mark.parametrize("body", STRAY)
def test_no_ordinary_body_can_page_a_channel(platform: str, body: str) -> None:
    rendered = ADAPTERS[platform]().translate_outbound(body)

    assert f"@{ZWSP}" in rendered
    for word in ("everyone", "channel", "here", "all"):
        assert f"@{word}" not in rendered.lower()


@pytest.mark.parametrize("platform", ADAPTERS)
def test_handles_that_merely_start_with_a_reserved_word_are_left_alone(
    platform: str,
) -> None:
    rendered = ADAPTERS[platform]().translate_outbound("cc @allison and @all-hands")
    assert ZWSP not in rendered


@pytest.mark.parametrize("platform", ["slack", "mattermost", "discord", "teams"])
def test_code_keeps_its_text_exactly(platform: str) -> None:
    # `npm install @here/sdk` copied out of a message must not carry a
    # zero-width space with it; no platform resolves a mention in code anyway.
    rendered = ADAPTERS[platform]().translate_outbound("run `npm i @here/sdk`")
    assert ZWSP not in rendered


def test_telegram_code_keeps_its_text_exactly() -> None:
    rendered = _telegram().translate_outbound("run `npm i @here/sdk`")
    assert rendered == "run <code>npm i @here/sdk</code>"


@pytest.mark.parametrize(
    "body",
    [
        "<!channel>",
        "<!here>",
        "<!everyone>",
        "<!channel|channel>",
        # The Markdown translation writes Slack syntax itself: a link to
        # `!channel` comes out of it as `<!channel|x>`.
        "[x](!channel)",
    ],
)
def test_slacks_own_syntax_cannot_page_the_channel(body: str) -> None:
    rendered = _slack().translate_outbound(body)
    assert "<!" not in rendered
    assert "&lt;!" in rendered


def test_slacks_own_mentions_still_resolve() -> None:
    adapter = _slack()
    adapter.prime_mention_targets({"doe.jane": "U123"})
    assert adapter.translate_outbound("@doe.jane look") == "<@U123> look"


# ── The relay ────────────────────────────────────────────────────────────────


class _Recording:
    """An adapter that records what the relay asked it to send."""

    def __init__(self, platform: CollaborationAdapter) -> None:
        self._platform = platform
        self.sent: list[dict[str, Any]] = []

    def translate_outbound(self, content: str) -> str:
        return self._platform.translate_outbound(content)

    def render_room_wide_mention(self, body: str) -> str:
        return self._platform.render_room_wide_mention(body)

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        self.sent.append({"content": content, "room_wide_mention": room_wide_mention})
        return "ref"


async def _noop(*_args: Any, **_kwargs: Any) -> None:
    return None


async def _tenant(*_args: Any, **_kwargs: Any) -> str:
    return "tenant-1"


def _bridge(adapter: _Recording) -> BridgeCore:
    core = object.__new__(BridgeCore)
    core._bridge_type = "slack"  # type: ignore[attr-defined]
    core._adapter = adapter  # type: ignore[assignment]
    core._puppet_matrix_ids = set()  # type: ignore[assignment]
    core._bridge_client_matrix_user_id = "@bridge:switch.local"  # type: ignore[assignment]
    core._find_channel = lambda **_kwargs: "C1"  # type: ignore[assignment]
    core._channel_to_room = {"C1": ("room-uuid", "!r:switch.local")}  # type: ignore[assignment]
    core._room_tenant = _tenant  # type: ignore[assignment]
    core._record_message_map = _noop  # type: ignore[assignment]
    core._move_indicator_for_sender = _noop  # type: ignore[assignment]
    core._outbound_thread_root_ref = _noop  # type: ignore[assignment]
    return core


def _event(body: str, content: dict[str, Any]) -> InboundMessage:
    return InboundMessage(
        room_id="!r:switch.local",
        event_id="$e1",
        sender="@switch-agent-scout:switch.local",
        timestamp=1700000000000,
        content={"body": body, **content},
        body=body,
        sender_name="scout",
    )


async def test_the_relay_pages_the_channel_for_a_marked_message() -> None:
    adapter = _Recording(_slack())

    await _bridge(adapter).handle_outbound_message(
        RoomRef("!r:switch.local"),
        _event("@everyone deploy at five", room_wide_mention_content()),
    )

    assert adapter.sent == [
        {"content": "<!channel> deploy at five", "room_wide_mention": True}
    ]


async def test_the_relay_does_not_page_for_the_same_text_unmarked() -> None:
    # An agent that writes `@everyone` itself, rather than targeting it, has
    # sent an ordinary message.
    adapter = _Recording(_slack())

    await _bridge(adapter).handle_outbound_message(
        RoomRef("!r:switch.local"), _event("@everyone deploy at five", {})
    )

    assert adapter.sent == [
        {"content": f"@{ZWSP}everyone deploy at five", "room_wide_mention": False}
    ]
