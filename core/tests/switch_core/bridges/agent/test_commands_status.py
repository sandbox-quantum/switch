from __future__ import annotations

import re
from types import SimpleNamespace

from switch_core.bridges.agent.commands import (
    COMMANDS_BY_NAME,
    _format_status_lines,
)
from switch_core.bridges.agent.protocol.types import AgentStatus

# Matches a live `@<handle>` mention token (same char class Switch re-parses).
_MENTION = re.compile(r"@[A-Za-z0-9._-]+")


def _agent(
    agent_id: str,
    name: str,
    agent_type: str,
    *,
    display_name: str | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=agent_id,
        name=name,
        display_name=display_name,
        agent_type=agent_type,
    )


class TestFormatStatusLines:
    def test_renders_emoji_and_type_sorted_by_name(self) -> None:
        agents = [
            _agent("w", "worker", "session_addressable"),
            _agent("m", "moderator", "always_on"),
        ]
        statuses = {"w": AgentStatus.NO_SESSION, "m": AgentStatus.LIVE}

        out = _format_status_lines(agents, statuses)
        lines = out.splitlines()

        assert lines[0] == "**Agent status in this room:**"
        # Sorted by name: moderator before worker.
        assert lines[1] == "- 🟢 **moderator** — live · always_on"
        assert lines[2] == "- ⚪ **worker** — no session · session_addressable"

    def test_each_status_maps_to_its_emoji(self) -> None:
        agents = [
            _agent("a", "a", "always_on"),
            _agent("b", "b", "always_on"),
            _agent("c", "c", "session_addressable"),
            _agent("d", "d", "session_passive"),
        ]
        statuses = {
            "a": AgentStatus.LIVE,
            "b": AgentStatus.DISCONNECTED,
            "c": AgentStatus.NO_SESSION,
            "d": AgentStatus.AWAITING_MANUAL_POLL,
        }

        out = _format_status_lines(agents, statuses)

        assert "🟢 **a** — live" in out
        assert "🔴 **b** — disconnected" in out
        assert "⚪ **c** — no session" in out
        assert "🟡 **d** — awaiting manual poll" in out

    def test_no_capabilities_omits_the_segment(self) -> None:
        agents = [_agent("a", "a", "always_on")]
        out = _format_status_lines(agents, {"a": AgentStatus.LIVE})
        # No trailing " · " capability segment when the agent has neither cap.
        assert out.endswith("🟢 **a** — live · always_on")


class TestFormatStatusLinesDisplayNames:
    def test_display_name_precedes_the_identifier_in_backticks(self) -> None:
        agents = [_agent("a", "switchdev", "always_on", display_name="Switch Dev")]
        out = _format_status_lines(agents, {"a": AgentStatus.LIVE})
        assert "**Switch Dev (`switchdev`)** — live" in out

    def test_no_display_name_renders_the_identifier_once(self) -> None:
        agents = [_agent("a", "switchdev", "always_on")]
        out = _format_status_lines(agents, {"a": AgentStatus.LIVE})
        assert "**switchdev** — live" in out
        assert "(`switchdev`)" not in out

    def test_a_display_name_cannot_ping_the_channel(self) -> None:
        agents = [_agent("a", "switchdev", "always_on", display_name="@everyone")]
        out = _format_status_lines(agents, {"a": AgentStatus.LIVE})
        assert _MENTION.search(out) is None
        assert "switchdev" in out

    def test_a_display_name_cannot_forge_a_link(self) -> None:
        agents = [
            _agent(
                "a",
                "switchdev",
                "always_on",
                display_name="[click here](https://example.invalid)",
            )
        ]
        out = _format_status_lines(agents, {"a": AgentStatus.LIVE})
        assert "](https://example.invalid)" not in out

    def test_order_follows_the_displayed_label(self) -> None:
        # Sorted by identifier this reads zeta, alpha; the reader sees the
        # display names, so those are what the order has to follow.
        agents = [
            _agent("z", "zeta", "always_on", display_name="Alpha Bot"),
            _agent("a", "alpha", "always_on", display_name="Zeta Bot"),
        ]
        statuses = {"z": AgentStatus.LIVE, "a": AgentStatus.LIVE}
        lines = _format_status_lines(agents, statuses).splitlines()
        assert "Alpha Bot" in lines[1]
        assert "Zeta Bot" in lines[2]

    def test_order_mixes_displayed_and_bare_identifiers(self) -> None:
        agents = [
            _agent("w", "worker", "always_on"),
            _agent("b", "zeta", "always_on", display_name="Bravo Bot"),
        ]
        statuses = {"w": AgentStatus.LIVE, "b": AgentStatus.LIVE}
        lines = _format_status_lines(agents, statuses).splitlines()
        assert "Bravo Bot" in lines[1]
        assert "worker" in lines[2]


class TestStatusCommandRegistration:
    def test_registered_and_admin_owned(self) -> None:
        # Primary name is `agents-status` (Slack reserves `/status`).
        cmd = COMMANDS_BY_NAME["agents-status"]
        assert cmd.handler is not None
        # The admin client owns and renders status; agents never answer it.
        assert cmd.admin_owned is True
        assert cmd.hidden is False

    def test_status_name_is_not_registered(self) -> None:
        # `status` is reserved by Slack and fully replaced by `agents-status`;
        # the old name no longer resolves.
        assert "status" not in COMMANDS_BY_NAME
