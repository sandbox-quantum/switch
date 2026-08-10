from __future__ import annotations

from types import SimpleNamespace

from switch_core.bridges.agent.commands import (
    COMMANDS_BY_NAME,
    _format_status_lines,
)
from switch_core.bridges.agent.protocol.types import AgentStatus


def _agent(
    agent_id: str,
    name: str,
    agent_type: str,
    *,
    can_delegate: bool = False,
    can_accept: bool = False,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=agent_id,
        name=name,
        agent_type=agent_type,
        integration_profile={
            "task_protocol": {
                "can_delegate": can_delegate,
                "can_accept": can_accept,
            }
        },
    )


class TestFormatStatusLines:
    def test_renders_emoji_type_and_capabilities_sorted_by_name(self) -> None:
        agents = [
            _agent(
                "w",
                "worker",
                "session_addressable",
                can_delegate=True,
                can_accept=True,
            ),
            _agent("m", "moderator", "always_on"),
        ]
        statuses = {"w": AgentStatus.NO_SESSION, "m": AgentStatus.LIVE}

        out = _format_status_lines(agents, statuses, {}, {})
        lines = out.splitlines()

        assert lines[0] == "**Agent status in this room:**"
        # Sorted by name: moderator before worker.
        assert lines[1] == "- 🟢 **moderator** — live · always_on"
        assert lines[2] == (
            "- ⚪ **worker** — no session · session_addressable · delegate+accept"
        )

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

        out = _format_status_lines(agents, statuses, {}, {})

        assert "🟢 **a** — live" in out
        assert "🔴 **b** — disconnected" in out
        assert "⚪ **c** — no session" in out
        assert "🟡 **d** — awaiting manual poll" in out

    def test_no_capabilities_omits_the_segment(self) -> None:
        agents = [_agent("a", "a", "always_on")]
        out = _format_status_lines(agents, {"a": AgentStatus.LIVE}, {}, {})
        # No trailing " · " capability segment when the agent has neither cap.
        assert out.endswith("🟢 **a** — live · always_on")

    def test_runtime_state_appended_after_presence(self) -> None:
        agents = [_agent("a", "alice", "session_addressable")]
        out = _format_status_lines(
            agents, {"a": AgentStatus.LIVE}, {"a": "working"}, {}
        )
        assert out.endswith("🟢 **alice** — live · ⚙️ working · session_addressable")

    def test_awaiting_input_runtime_state_rendered(self) -> None:
        agents = [_agent("a", "alice", "session_addressable")]
        out = _format_status_lines(
            agents, {"a": AgentStatus.LIVE}, {"a": "awaiting-input"}, {}
        )
        assert "✋ awaiting input" in out

    def test_idle_runtime_state_is_omitted(self) -> None:
        # idle carries no extra signal over the presence status.
        agents = [_agent("a", "alice", "session_addressable")]
        out = _format_status_lines(agents, {"a": AgentStatus.LIVE}, {"a": "idle"}, {})
        assert out.endswith("🟢 **alice** — live · session_addressable")

    def test_switchdash_deeplink_appended_when_present(self) -> None:
        agents = [_agent("a", "alice", "session_addressable")]
        out = _format_status_lines(
            agents,
            {"a": AgentStatus.LIVE},
            {},
            {"a": "switchdash://session?server=s&agent=a&room=r"},
        )
        assert out.endswith(
            "· [Open in Switch Console](switchdash://session?server=s&agent=a&room=r)"
        )

    def test_no_deeplink_segment_when_absent(self) -> None:
        agents = [_agent("a", "alice", "session_addressable")]
        out = _format_status_lines(agents, {"a": AgentStatus.LIVE}, {}, {})
        assert "Switch Console" not in out

    def test_deeplink_hidden_when_session_not_live_here(self) -> None:
        # A stored link survives a room switch; don't surface it where the
        # agent's session is no longer live (it would point at a session that
        # has moved on).
        agents = [_agent("a", "alice", "session_addressable")]
        out = _format_status_lines(
            agents,
            {"a": AgentStatus.NO_SESSION},
            {},
            {"a": "switchdash://session?server=s&agent=a&room=r"},
        )
        assert "Switch Console" not in out


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
