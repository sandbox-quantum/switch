"""Subagents listed under an agent's live "working on it…" indicator.

An agent that delegates reports the subagents it currently has running with its
runtime state. The bridge hands the list to the adapter, which renders one line
per subagent below the activity line. These pin down what the reader sees: the
agent's own activity line untouched, each subagent's name and detail escaped for
the platform, and the per-platform ceilings on how many lines and how long.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

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
from switch_core.events import ActiveSubagent, AgentRuntimeStateEvent


def _mattermost() -> MattermostAdapter:
    return MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )


def _slack() -> SlackAdapter:
    return SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
        )
    )


def _teams() -> TeamsAdapter:
    return TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="app-123",
            app_password="secret",
            tenant_id="tenant-1",
            team_id="team-1",
            public_base_url="https://switch.example",
            client_state="s3cr3t",
        )
    )


def _telegram() -> TelegramAdapter:
    return TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username="bot")
    )


def _discord() -> DiscordAdapter:
    return DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id="1")
    )


def _subagent(name: str, state: str, detail: str | None = None) -> ActiveSubagent:
    return {
        "agent_id": f"sub-{name}",
        "agent_name": name,
        "state": state,
        "detail": detail,
    }


# ── Rendering ────────────────────────────────────────────────────────────────


def test_the_agents_own_activity_line_is_never_escaped() -> None:
    # The detail comes from the connector, not from a room member, and has
    # always been rendered as written — "Editing foo_bar.py" must not turn into
    # "Editing foo\_bar.py" just because subagents can now appear below it.
    adapter = _mattermost()

    assert adapter._working_body("Editing foo_bar.py", None) == "⚙️ Editing foo_bar.py"
    assert adapter._working_body(
        "Editing foo_bar.py", None, [_subagent("Explore", "working")]
    ) == ("⚙️ Editing foo_bar.py\n- ⚙️ Explore")


def test_no_subagents_leaves_the_working_line_alone() -> None:
    adapter = _mattermost()
    plain = adapter._working_body("Running tests", None)

    assert adapter._working_body("Running tests", None, None) == plain
    assert adapter._working_body("Running tests", None, []) == plain


def test_a_subagent_detail_is_rendered_after_its_name() -> None:
    adapter = _mattermost()

    body = adapter._working_body(
        "Running tests", None, [_subagent("Explore", "working", "reading models.py")]
    )

    assert body == "⚙️ Running tests\n- ⚙️ Explore: reading models.py"


def test_each_state_gets_its_own_marker() -> None:
    adapter = _mattermost()
    subagents = [
        _subagent("a", "working"),
        _subagent("b", "awaiting-input"),
        _subagent("c", "complete"),
        _subagent("d", "failed"),
        _subagent("e", "idle"),
    ]

    lines = adapter._working_body("Delegating", None, subagents).splitlines()[1:]

    assert lines == [
        "- ⚙️ a",
        "- ⏸️ b",
        "- ✅ c",
        "- ❌ d",
        "- ⏹️ e",
    ]


def test_teams_renders_the_same_emoji_as_everywhere_else() -> None:
    # Adaptive Cards render emoji, so Teams has no reason to fall back to ASCII.
    body = _teams()._working_body("Delegating", None, [_subagent("Explore", "failed")])

    assert "❌ Explore" in body


def test_a_subagent_name_and_detail_are_escaped_for_the_platform() -> None:
    # Unlike the agent's own detail, these are names an agent chose and text it
    # wrote, so markdown in them must not reformat the indicator.
    body = _mattermost()._working_body(
        "Delegating",
        None,
        [_subagent("code_review", "working", "found *3* issues")],
    )

    assert body == "⚙️ Delegating\n- ⚙️ code\\_review: found \\*3\\* issues"


def test_slack_escapes_the_mrkdwn_control_characters() -> None:
    body = _slack()._working_body(
        "Delegating", None, [_subagent("<script>", "working", "a & b")]
    )

    assert "&lt;script&gt;" in body
    assert "a &amp; b" in body


# ── Platform ceilings ────────────────────────────────────────────────────────


def test_each_platform_lists_at_most_its_own_number_of_subagents() -> None:
    subagents = [_subagent(f"agent{i}", "working") for i in range(25)]

    for adapter, limit in ((_discord(), 20), (_slack(), 10), (_teams(), 4)):
        lines = adapter._working_body("Delegating", None, subagents).splitlines()[1:]
        assert len([line for line in lines if line.strip()]) == limit


def test_slack_and_telegram_truncate_a_long_subagent_detail() -> None:
    detail = "x" * 300

    slack_line = _slack()._working_body(
        "Delegating", None, [_subagent("Explore", "working", detail)]
    )
    telegram_line = _telegram()._working_body(
        "Delegating", None, [_subagent("Explore", "working", detail)]
    )

    assert "x" * 99 + "…" in slack_line
    assert "x" * 100 not in slack_line
    assert "x" * 119 + "…" in telegram_line
    assert "x" * 120 not in telegram_line


# ── Bridge → adapter ─────────────────────────────────────────────────────────


class _FakeAdapter:
    runtime_state_follows_anchor = False

    def __init__(self) -> None:
        self.reported: list[list[ActiveSubagent] | None] = []

    def agents_with_live_runtime_state(self, channel_id: str) -> list[str]:
        return []

    async def apply_runtime_state(
        self,
        channel_id: str,
        agent_name: str,
        state: str,
        *,
        mention_handle: str | None,
        thread_root_id: str | None,
        deeplink_url: str | None,
        detail: str | None,
        trigger_thread_root_id: str | None = None,
        anchor_message_ref: str | None = None,
        active_subagents: list[ActiveSubagent] | None = None,
    ) -> None:
        self.reported.append(active_subagents)

    async def reposition_runtime_state(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        return None


def _bridge() -> Any:
    adapter = _FakeAdapter()

    async def external_post_for_matrix_event(event_id: str) -> str | None:
        return None

    ns = SimpleNamespace(
        _adapter=adapter,
        _indicator_move_timers={},
        _indicator_move_targets={},
        _reported_anchors={},
        _find_channel=lambda **kwargs: "chan-1",
        _external_post_for_matrix_event=external_post_for_matrix_event,
        adapter_spy=adapter,
    )
    for name in (
        "handle_agent_runtime_state",
        "_follow_reported_anchor",
        "_schedule_indicator_move",
        "_run_indicator_move",
    ):
        setattr(ns, name, getattr(BridgeCore, name).__get__(ns))
    return ns


def _report(bridge: Any, subagents: list[ActiveSubagent] | None) -> None:
    event = AgentRuntimeStateEvent(
        agent_id="agent-1",
        agent_name="worker",
        room_id="!room:switch.local",
        state="working",
        active_subagents=subagents,
    )
    room = SimpleNamespace(room_id="!room:switch.local")
    asyncio.run(bridge.handle_agent_runtime_state(room, event))


def test_reported_subagents_reach_the_adapter() -> None:
    bridge = _bridge()
    subagents = [_subagent("Explore", "working", "reading models.py")]

    _report(bridge, subagents)

    assert bridge.adapter_spy.reported == [subagents]


def test_a_report_without_subagents_says_so() -> None:
    bridge = _bridge()

    _report(bridge, None)

    assert bridge.adapter_spy.reported == [None]
