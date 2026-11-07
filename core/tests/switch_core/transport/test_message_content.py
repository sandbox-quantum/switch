"""An edit's content names the message it replaces, and the row reads it out."""

from __future__ import annotations

import pytest

from switch_core.messages.row import message_row, replaces_of, thread_root_of
from switch_core.transport.content import message_content


def test_an_edit_relates_to_the_message_it_replaces() -> None:
    content = message_content(
        "the file", sender_name="alice", format="markdown", replaces_event_id="$m"
    )

    assert content["body"] == "the file"
    assert content["m.relates_to"] == {"rel_type": "m.replace", "event_id": "$m"}
    assert replaces_of(content) == "$m"
    assert thread_root_of(content) is None


def test_a_message_of_its_own_replaces_nothing() -> None:
    content = message_content("hello", sender_name="alice", thread_root_id="$root")

    assert replaces_of(content) is None
    assert thread_root_of(content) == "$root"


def test_an_edit_carries_one_relation_only() -> None:
    with pytest.raises(ValueError, match="not to a thread"):
        message_content(
            "the file",
            sender_name="alice",
            thread_root_id="$root",
            replaces_event_id="$m",
        )


def test_the_row_denormalises_what_it_replaces() -> None:
    row = message_row(
        room_id="room",
        event_id="$edit",
        sender_id="@alice:s",
        sender_client_id="client",
        sender_name="alice",
        event_type="m.room.message",
        content=message_content(
            "the file", sender_name="alice", replaces_event_id="$m"
        ),
        client_txn_id=None,
    )

    assert row.replaces_event_id == "$m"
    assert row.thread_root_event_id is None
    assert row.body == "the file"
