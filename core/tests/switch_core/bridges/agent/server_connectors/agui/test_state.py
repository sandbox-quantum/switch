"""State patching: strict, and atomic when it refuses."""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.agent.server_connectors.agui.state import (
    StatePatchError,
    apply_patch,
    parse_pointer,
)


def test_add_and_replace() -> None:
    doc = {"a": 1}
    assert apply_patch(doc, [{"op": "add", "path": "/b", "value": 2}]) == {
        "a": 1,
        "b": 2,
    }
    assert apply_patch(doc, [{"op": "replace", "path": "/a", "value": 9}]) == {"a": 9}


def test_remove() -> None:
    assert apply_patch({"a": 1, "b": 2}, [{"op": "remove", "path": "/a"}]) == {"b": 2}


def test_nested_paths() -> None:
    doc: dict[str, Any] = {"outer": {"inner": {"n": 1}}}
    patched = apply_patch(
        doc, [{"op": "replace", "path": "/outer/inner/n", "value": 2}]
    )
    assert patched["outer"]["inner"]["n"] == 2


def test_array_index_and_append() -> None:
    doc = {"xs": [1, 2, 3]}
    assert apply_patch(doc, [{"op": "replace", "path": "/xs/1", "value": 9}])["xs"] == [
        1,
        9,
        3,
    ]
    assert apply_patch(doc, [{"op": "add", "path": "/xs/-", "value": 4}])["xs"] == [
        1,
        2,
        3,
        4,
    ]
    assert apply_patch(doc, [{"op": "remove", "path": "/xs/0"}])["xs"] == [2, 3]


def test_move_copy_and_test() -> None:
    doc = {"a": 1, "b": 2}
    assert apply_patch(doc, [{"op": "move", "from": "/a", "path": "/c"}]) == {
        "b": 2,
        "c": 1,
    }
    assert apply_patch(doc, [{"op": "copy", "from": "/a", "path": "/c"}]) == {
        "a": 1,
        "b": 2,
        "c": 1,
    }
    assert apply_patch(doc, [{"op": "test", "path": "/a", "value": 1}]) == doc


def test_failing_test_op_raises() -> None:
    with pytest.raises(StatePatchError, match="test failed"):
        apply_patch({"a": 1}, [{"op": "test", "path": "/a", "value": 2}])


def test_several_operations_apply_in_order() -> None:
    result = apply_patch(
        {"n": 0},
        [
            {"op": "replace", "path": "/n", "value": 1},
            {"op": "add", "path": "/m", "value": 2},
            {"op": "replace", "path": "/n", "value": 3},
        ],
    )
    assert result == {"n": 3, "m": 2}


# ── Strictness ────────────────────────────────────────────────────────────────


def test_the_original_document_is_never_mutated() -> None:
    doc = {"a": 1, "nested": {"x": [1, 2]}}
    apply_patch(doc, [{"op": "replace", "path": "/nested/x/0", "value": 99}])
    assert doc == {"a": 1, "nested": {"x": [1, 2]}}


def test_a_rejected_patch_leaves_nothing_half_applied() -> None:
    # The interesting case: the first operation is valid, the second is not.
    doc = {"a": 1}
    with pytest.raises(StatePatchError):
        apply_patch(
            doc,
            [
                {"op": "add", "path": "/b", "value": 2},
                {"op": "remove", "path": "/missing"},
            ],
        )
    assert doc == {"a": 1}


def test_replace_of_a_missing_key_raises() -> None:
    with pytest.raises(StatePatchError, match="missing key"):
        apply_patch({"a": 1}, [{"op": "replace", "path": "/nope", "value": 1}])


def test_remove_of_a_missing_key_raises() -> None:
    with pytest.raises(StatePatchError, match="cannot remove missing key"):
        apply_patch({"a": 1}, [{"op": "remove", "path": "/nope"}])


def test_array_index_out_of_range_raises() -> None:
    with pytest.raises(StatePatchError, match="out of range"):
        apply_patch({"xs": [1]}, [{"op": "replace", "path": "/xs/7", "value": 1}])


def test_non_numeric_array_index_raises() -> None:
    with pytest.raises(StatePatchError, match="not a number"):
        apply_patch({"xs": [1]}, [{"op": "replace", "path": "/xs/first", "value": 1}])


def test_unsupported_op_raises() -> None:
    with pytest.raises(StatePatchError, match="unsupported op"):
        apply_patch({}, [{"op": "increment", "path": "/a", "value": 1}])


def test_missing_path_raises() -> None:
    with pytest.raises(StatePatchError, match="no string 'path'"):
        apply_patch({}, [{"op": "add", "value": 1}])


def test_missing_value_raises() -> None:
    with pytest.raises(StatePatchError, match="no 'value'"):
        apply_patch({}, [{"op": "add", "path": "/a"}])


def test_relative_pointer_raises() -> None:
    with pytest.raises(StatePatchError, match="must be empty or start with"):
        apply_patch({}, [{"op": "add", "path": "a/b", "value": 1}])


def test_patch_that_is_not_a_list_raises() -> None:
    with pytest.raises(StatePatchError, match="must be a list"):
        apply_patch({}, {"op": "add"})  # type: ignore[arg-type]


def test_descending_into_a_scalar_raises() -> None:
    with pytest.raises(StatePatchError, match="cannot descend"):
        apply_patch({"a": 1}, [{"op": "replace", "path": "/a/b", "value": 2}])


def test_removing_the_whole_document_raises() -> None:
    with pytest.raises(StatePatchError, match="whole document"):
        apply_patch({"a": 1}, [{"op": "remove", "path": ""}])


# ── Pointer escaping ──────────────────────────────────────────────────────────


def test_pointer_escapes_are_decoded_in_the_right_order() -> None:
    # ~1 is "/" and ~0 is "~". Unescaping ~0 first would turn "~01" into "/"
    # rather than "~1".
    assert parse_pointer("/a~1b") == ["a/b"]
    assert parse_pointer("/m~0n") == ["m~n"]
    assert parse_pointer("/~01") == ["~1"]


def test_pointer_with_escaped_key_round_trips_through_a_patch() -> None:
    doc = {"a/b": 1}
    assert apply_patch(doc, [{"op": "replace", "path": "/a~1b", "value": 2}]) == {
        "a/b": 2
    }


def test_empty_pointer_is_the_whole_document() -> None:
    assert parse_pointer("") == []
    assert apply_patch(
        {"a": 1}, [{"op": "replace", "path": "", "value": {"b": 2}}]
    ) == {"b": 2}
