"""Building the message array: bounded, chronological, and honest about it."""

from __future__ import annotations

from typing import Any

from switch_core.bridges.agent.server_connectors.agui.history import (
    build_context,
    build_messages,
)

OWN_NAME = "research-bot"


def _entry(entry_id: str, sender: str, body: str, timestamp: int) -> dict[str, Any]:
    return {
        "id": entry_id,
        "kind": "message",
        "sender": f"@{sender}:switch.local",
        "sender_name": sender,
        "body": body,
        "timestamp": timestamp,
        "attachments": [],
    }


def _timeline(*threads: dict[str, Any], truncated: bool = False) -> dict[str, Any]:
    return {"threads": list(threads), "truncated": truncated, "oldest_timestamp": 1}


def _thread(root: dict[str, Any], *replies: dict[str, Any]) -> dict[str, Any]:
    return {"root": root, "replies": list(replies)}


def test_speakers_map_to_roles() -> None:
    timeline = _timeline(
        _thread(_entry("$1", "christian", "hello", 1)),
        _thread(_entry("$2", OWN_NAME, "hi back", 2)),
    )
    messages = build_messages(timeline, own_agent_name=OWN_NAME, limit=40)

    assert [message.role for message in messages] == ["user", "assistant"]
    assert messages[0].name == "christian"


def test_other_agents_are_users_not_assistants() -> None:
    # A room can hold several agents. Only *this* agent's own words are its
    # assistant turns; another agent's are just more conversation.
    timeline = _timeline(_thread(_entry("$1", "other-bot", "my view is", 1)))
    messages = build_messages(timeline, own_agent_name=OWN_NAME, limit=40)

    assert messages[0].role == "user"
    assert messages[0].name == "other-bot"


def test_threads_are_flattened_into_time_order() -> None:
    # read_context orders threads by latest activity, so a thread's root can be
    # older than another thread's replies. Sorting by timestamp is what makes
    # the array read as a conversation.
    timeline = _timeline(
        _thread(_entry("$3", "christian", "third", 30)),
        _thread(
            _entry("$1", "christian", "first", 10), _entry("$2", OWN_NAME, "second", 20)
        ),
    )
    messages = build_messages(timeline, own_agent_name=OWN_NAME, limit=40)

    assert [message.content for message in messages] == ["first", "second", "third"]


def test_the_window_keeps_the_most_recent_entries() -> None:
    timeline = _timeline(
        *[_thread(_entry(f"${i}", "christian", f"m{i}", i)) for i in range(1, 11)]
    )
    messages = build_messages(timeline, own_agent_name=OWN_NAME, limit=3)

    assert [message.content for message in messages] == ["m8", "m9", "m10"]


def test_empty_bodies_are_dropped() -> None:
    timeline = _timeline(
        _thread(_entry("$1", "christian", "", 1)),
        _thread(_entry("$2", "christian", "real", 2)),
    )
    messages = build_messages(timeline, own_agent_name=OWN_NAME, limit=40)

    assert [message.content for message in messages] == ["real"]


def test_join_events_without_a_body_do_not_become_messages() -> None:
    timeline = _timeline(
        _thread({"id": "$j", "kind": "room_join", "sender_name": "x", "timestamp": 1})
    )
    assert build_messages(timeline, own_agent_name=OWN_NAME, limit=40) == []


def test_an_empty_room_yields_no_messages() -> None:
    assert build_messages(_timeline(), own_agent_name=OWN_NAME, limit=40) == []


def test_speaker_names_are_made_wire_safe() -> None:
    timeline = _timeline(_thread(_entry("$1", "christian mcdermott!", "hi", 1)))
    messages = build_messages(timeline, own_agent_name=OWN_NAME, limit=40)

    assert messages[0].name == "christian_mcdermott_"


# ── Disclosure ────────────────────────────────────────────────────────────────


def test_context_names_the_room() -> None:
    context = build_context(_timeline(), room_name="room-1", limit=40)
    assert any("room-1" in item.value for item in context)


def test_truncation_is_disclosed_when_the_window_cuts_history() -> None:
    # Handing an agent a shortened transcript that looks complete is the same
    # failure mode as a truncated stream, one layer up.
    timeline = _timeline(
        *[_thread(_entry(f"${i}", "christian", f"m{i}", i)) for i in range(1, 11)]
    )
    context = build_context(timeline, room_name="room-1", limit=3)

    assert any(item.description == "history_truncated" for item in context)


def test_truncation_is_disclosed_when_read_context_itself_truncated() -> None:
    timeline = _timeline(
        _thread(_entry("$1", "christian", "hi", 1)),
        truncated=True,
    )
    context = build_context(timeline, room_name="room-1", limit=40)

    assert any(item.description == "history_truncated" for item in context)


def test_no_truncation_notice_when_the_whole_room_fits() -> None:
    timeline = _timeline(_thread(_entry("$1", "christian", "hi", 1)))
    context = build_context(timeline, room_name="room-1", limit=40)

    assert not any(item.description == "history_truncated" for item in context)
