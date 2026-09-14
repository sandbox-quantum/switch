from __future__ import annotations

from enum import StrEnum

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

# Marker for a platform-sourced message (CHOO-2719). Unlike ADMIN_MARKER, a
# platform message IS addressed to agents and expects action — the marker
# tells the bridge to render it as the Switch app and lets resolve_sender
# identify it as sender_kind="platform". Carried as a content field on a
# plain m.room.message whose body is the human-readable default text.
#
# Value is a dict: {"on_behalf_of": "<name>"} when the platform is
# impersonating a creator, or {} for a direct platform message.
PLATFORM_MARKER = "com.switch.platform"


class AdminMessageType(StrEnum):
    """The kind of admin/system message, carried in the marker so a bridge
    adapter can special-case rendering per platform. Adapters that do not
    special-case a type fall back to rendering the default text."""

    ABSENT_AGENT = "absent_agent"
    UNREACHABLE_ROLE = "unreachable_role"
    COMMAND_RESULT = "command_result"
    SELF_MENTION_UNALIASED = "self_mention_unaliased"
    NO_AGENTS = "no_agents"


def admin_extra_content(message_type: AdminMessageType | None) -> dict[str, object]:
    """The `extra_content` marker for an admin message. Carries the type (or
    None) so a bridge adapter can special-case rendering; its mere presence
    flags the message as system-generated."""
    return {ADMIN_MARKER: {"type": message_type.value if message_type else None}}
