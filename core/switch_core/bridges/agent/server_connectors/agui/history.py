"""Turning a room's timeline into the `messages` array a run carries.

AG-UI is stateless per run, so every run re-uploads the conversation. Switch
already owns the transcript, which is what makes that workable — but it also
means the history has to be *bounded*, because a room that has been running for
months will not fit in any model's context and the protocol says nothing about
whether a partial array is allowed.

Two rules follow.

**The window is explicit.** A fixed number of recent entries, oldest first,
rather than "everything we can get".

**Truncation is disclosed.** When the window omits earlier history the agent is
told so through `context`, rather than being handed a shortened transcript that
looks complete. An agent that cannot see the start of a conversation should
know that — the same courtesy `read_context`'s own `truncated` flag extends to
a first-class agent.

Roles are assigned by speaker: what this agent said becomes `assistant`,
everything else becomes `user` tagged with the speaker's name, so a
multi-participant room does not collapse into an anonymous dialogue.
"""

from __future__ import annotations

from typing import Any

from switch_core.bridges.agent.server_connectors.agui.request import (
    AssistantMessage,
    Context,
    Message,
    UserMessage,
)

DEFAULT_HISTORY_LIMIT = 40


def build_messages(
    timeline: dict[str, Any],
    *,
    own_agent_name: str,
    limit: int,
) -> list[Message]:
    """Flatten `read_context`'s threads into a chronological message array."""
    entries = _chronological(timeline)
    windowed = entries[-limit:] if limit > 0 else entries

    messages: list[Message] = []
    for entry in windowed:
        body = entry.get("body")
        if not body:
            continue
        identifier = str(entry.get("id") or f"entry-{len(messages)}")
        speaker = entry.get("sender_name") or "unknown"

        if speaker == own_agent_name:
            messages.append(AssistantMessage(id=identifier, content=body))
        else:
            messages.append(
                UserMessage(id=identifier, content=body, name=_safe_name(speaker))
            )
    return messages


def build_context(
    timeline: dict[str, Any],
    *,
    room_name: str,
    limit: int,
) -> list[Context]:
    """Ambient context for the run, including any disclosure of truncation."""
    context = [
        Context(
            description="room",
            value=(
                f"You are taking part in the Switch room {room_name!r}. "
                "Other agents and humans can see everything you say here."
            ),
        )
    ]

    total = len(_chronological(timeline))
    omitted = max(0, total - limit) if limit > 0 else 0
    if omitted or timeline.get("truncated"):
        context.append(
            Context(
                description="history_truncated",
                value=(
                    "This conversation is longer than the history you were "
                    "given. Earlier messages are not shown. Use the "
                    "read_context tool if you need them."
                ),
            )
        )
    return context


def _chronological(timeline: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten `{threads: [{root, replies}]}` into one time-ordered list.

    `read_context` orders threads by latest activity, so a thread's own root
    can be older than another thread's replies. Sorting by timestamp is what
    makes the result read as a conversation rather than as grouped threads.
    """
    entries: list[dict[str, Any]] = []
    for thread in timeline.get("threads", []):
        root = thread.get("root")
        if root:
            entries.append(root)
        entries.extend(thread.get("replies", []))

    entries.sort(key=lambda entry: entry.get("timestamp") or 0)
    return entries


def _safe_name(speaker: str) -> str:
    """A speaker name the wire will accept as a message `name`."""
    cleaned = "".join(
        char if char.isalnum() or char in "._-" else "_" for char in speaker
    )
    return cleaned[:64] or "unknown"
