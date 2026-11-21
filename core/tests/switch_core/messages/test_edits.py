from switch_core.messages.edits import (
    Edit,
    edit_content,
    edit_fallback,
    is_edit,
    parse_edit,
)


def test_an_edit_round_trips() -> None:
    content: dict[str, object] = {
        "msgtype": "m.text",
        "body": edit_fallback("new text"),
        **edit_content("$original", "new text"),
    }
    assert content["body"] == "* new text"
    assert parse_edit(content) == Edit(original_event_id="$original", body="new text")
    assert is_edit(content)


def test_other_messages_are_not_edits() -> None:
    assert parse_edit({"body": "hi"}) is None
    thread = {"body": "hi", "m.relates_to": {"rel_type": "m.thread", "event_id": "$r"}}
    assert parse_edit(thread) is None
    # A replace relation without the new content says nothing to apply.
    bare = {"body": "* x", "m.relates_to": {"rel_type": "m.replace", "event_id": "$o"}}
    assert parse_edit(bare) is None
