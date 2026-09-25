from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from typing import NamedTuple

# Marker stamped on the content of an admin/system `m.room.message`. Two jobs,
# mirroring AUTO_REPLY_FLAG:
#   1. It tells the collaboration bridge to render the message through the
#      adapter's native admin path (`admin_message`) — as the Switch app on
#      Slack, a Switch Admin bot on Mattermost — instead of as a normal
#      agent/user message.
#   2. Its mere presence marks the message as system-generated, so clients
#      (including the admin client itself) never react to it with warnings or
#      auto-replies.
# The marker rides as a field on a plain m.room.message whose body is the
# human-readable default text, so a vanilla Matrix client still renders it.
ADMIN_MARKER = "com.switch.admin"

# Marker for a message the Switch platform posts. Unlike ADMIN_MARKER it IS
# addressed to agents and expects action; the marker tells the bridge to
# render it as the Switch app and lets resolve_sender see sender_kind
# "platform". Carried as a content field on a plain m.room.message.
#
# Value: {} for the platform's own message, or {"on_behalf_of": {"user_id",
# "name"}} when it speaks with a person's authority (a template's kickoff).
# With an "agent_id" as well, the message speaks for that agent: a kickoff in
# a room an agent created. The authority is per message: the addressed
# agent's policy is evaluated for that person or agent when the event
# arrives, and nothing is granted beyond it. Only server-side code writes
# the marker.
PLATFORM_MARKER = "com.switch.platform"


class OnBehalfOf(NamedTuple):
    """Whose authority a platform message carries.

    A person, or an agent when ``agent_id`` is set. For an agent, ``user_id``
    is its owner and ``name`` is the agent's name. The distinction matters to
    addressing: a message for an agent is judged as that agent speaking, so
    it cannot wake an agent that answers only its owner.
    """

    user_id: str
    name: str
    agent_id: str | None = None

    @property
    def label(self) -> str:
        """How a message names whom it speaks for. A person is written as a
        mention. An agent is not: the mention would address it, and it would
        wake on the kickoff of the room it has just created."""
        return self.name if self.agent_id is not None else f"@{self.name}"


def platform_replies_in_channel(content: Mapping[str, object]) -> bool:
    """Whether a platform message asks the agents it addresses to answer in
    the channel rather than in its thread. A template's kickoff sits in a
    thread only to keep the channel to one line; the work belongs at the top
    level, where a person would have started it.
    """
    marker = content.get(PLATFORM_MARKER)
    return isinstance(marker, dict) and marker.get("reply_in_channel") is True


def platform_on_behalf_of(content: Mapping[str, object]) -> OnBehalfOf | None:
    """The person behind a platform-marked event, or None for a bare platform
    message or an event without the marker."""
    marker = content.get(PLATFORM_MARKER)
    if not isinstance(marker, dict):
        return None
    person = marker.get("on_behalf_of")
    if not isinstance(person, dict):
        return None
    user_id = person.get("user_id")
    name = person.get("name")
    if not isinstance(user_id, str) or not user_id:
        return None
    agent_id = person.get("agent_id")
    return OnBehalfOf(
        user_id,
        name if isinstance(name, str) and name else user_id,
        agent_id if isinstance(agent_id, str) and agent_id else None,
    )


class AdminMessageType(StrEnum):
    """The kind of admin/system message, carried in the marker so a bridge
    adapter can special-case rendering per platform. Adapters that do not
    special-case a type fall back to rendering the default text."""

    ABSENT_AGENT = "absent_agent"
    UNREACHABLE_ROLE = "unreachable_role"
    COMMAND_RESULT = "command_result"
    SELF_MENTION_UNALIASED = "self_mention_unaliased"
    NO_AGENTS = "no_agents"
    RUN_NOTICE = "run_notice"


def admin_extra_content(message_type: AdminMessageType | None) -> dict[str, object]:
    """The `extra_content` marker for an admin message. Carries the type (or
    None) so a bridge adapter can special-case rendering; its mere presence
    flags the message as system-generated."""
    return {ADMIN_MARKER: {"type": message_type.value if message_type else None}}
