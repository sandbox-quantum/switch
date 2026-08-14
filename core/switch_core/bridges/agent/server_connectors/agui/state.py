"""Agent-owned state, and the RFC 6902 patches that mutate it.

AG-UI is stateless per run: whatever an agent wants to remember between runs
travels as `state`, updated by `STATE_SNAPSHOT` (replace it) or `STATE_DELTA`
(patch it). Switch holds that state per (agent, room, thread) and hands it back
on the next run.

The patch applier is strict on purpose. A `STATE_DELTA` is a mutation written
by an external agent and applied to data Switch stores, so "apply what parses
and skip the rest" would let a malformed patch leave state in a shape nobody
intended and nobody was told about. Every operation is validated first, a
failure raises, and because the document is copied up front a rejected patch
leaves the original untouched rather than half-modified.
"""

from __future__ import annotations

import copy
from typing import Any

from switch_core.bridges.agent.server_connectors.agui.events import AgUiProtocolError

_MUTATING_OPS = frozenset({"add", "remove", "replace", "move", "copy", "test"})


class StatePatchError(AgUiProtocolError):
    """A state patch was malformed, or did not apply to the document."""


def parse_pointer(pointer: str) -> list[str]:
    """Decode a JSON Pointer into its tokens.

    `~1` means `/` and `~0` means `~`, and the order matters: unescaping `~0`
    first would turn `~01` into `/` instead of `~1`.
    """
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise StatePatchError(
            f"JSON Pointer must be empty or start with '/': {pointer!r}"
        )
    return [
        token.replace("~1", "/").replace("~0", "~") for token in pointer[1:].split("/")
    ]


def apply_patch(document: Any, patch: list[dict[str, Any]]) -> Any:
    """Apply an RFC 6902 patch, returning a new document.

    All-or-nothing: on any failure the caller's document is unchanged.
    """
    if not isinstance(patch, list):
        raise StatePatchError(f"state patch must be a list, got {type(patch).__name__}")

    working = copy.deepcopy(document)
    for index, operation in enumerate(patch):
        working = _apply_one(working, operation, index)
    return working


def _apply_one(document: Any, operation: object, index: int) -> Any:
    if not isinstance(operation, dict):
        raise StatePatchError(f"patch[{index}] is not an object")

    op = operation.get("op")
    if op not in _MUTATING_OPS:
        raise StatePatchError(f"patch[{index}] has unsupported op {op!r}")

    path = operation.get("path")
    if not isinstance(path, str):
        raise StatePatchError(f"patch[{index}] has no string 'path'")
    tokens = parse_pointer(path)

    if op == "add":
        return _set(document, tokens, _value_of(operation, index), insert=True)
    if op == "replace":
        _get(document, tokens, index)
        return _set(document, tokens, _value_of(operation, index), insert=False)
    if op == "remove":
        return _remove(document, tokens, index)
    if op == "test":
        actual = _get(document, tokens, index)
        if actual != _value_of(operation, index):
            raise StatePatchError(f"patch[{index}] test failed at {path!r}")
        return document

    from_path = operation.get("from")
    if not isinstance(from_path, str):
        raise StatePatchError(f"patch[{index}] '{op}' has no string 'from'")
    from_tokens = parse_pointer(from_path)
    value = _get(document, from_tokens, index)

    if op == "copy":
        return _set(document, tokens, copy.deepcopy(value), insert=True)

    document = _remove(document, from_tokens, index)
    return _set(document, tokens, value, insert=True)


def _value_of(operation: dict[str, Any], index: int) -> Any:
    if "value" not in operation:
        raise StatePatchError(f"patch[{index}] has no 'value'")
    return operation["value"]


def _descend(document: Any, tokens: list[str], index: int) -> Any:
    node = document
    for token in tokens:
        node = _child(node, token, index)
    return node


def _child(node: Any, token: str, index: int) -> Any:
    if isinstance(node, dict):
        if token not in node:
            raise StatePatchError(f"patch[{index}] path missing key {token!r}")
        return node[token]
    if isinstance(node, list):
        return node[_list_index(node, token, index, allow_end=False)]
    raise StatePatchError(
        f"patch[{index}] cannot descend into {type(node).__name__} at {token!r}"
    )


def _list_index(node: list[Any], token: str, index: int, *, allow_end: bool) -> int:
    if token == "-":
        if not allow_end:
            raise StatePatchError(f"patch[{index}] cannot read the '-' array position")
        return len(node)
    try:
        position = int(token)
    except ValueError:
        raise StatePatchError(
            f"patch[{index}] array index {token!r} is not a number"
        ) from None
    limit = len(node) if allow_end else len(node) - 1
    if position < 0 or position > limit:
        raise StatePatchError(f"patch[{index}] array index {position} is out of range")
    return position


def _get(document: Any, tokens: list[str], index: int) -> Any:
    if not tokens:
        return document
    return _descend(document, tokens, index)


def _set(document: Any, tokens: list[str], value: Any, *, insert: bool) -> Any:
    if not tokens:
        return value

    parent = _descend(document, tokens[:-1], 0)
    leaf = tokens[-1]

    if isinstance(parent, dict):
        if not insert and leaf not in parent:
            raise StatePatchError(f"cannot replace missing key {leaf!r}")
        parent[leaf] = value
        return document
    if isinstance(parent, list):
        position = _list_index(parent, leaf, 0, allow_end=insert)
        if insert:
            parent.insert(position, value)
        else:
            parent[position] = value
        return document

    raise StatePatchError(f"cannot set {leaf!r} on {type(parent).__name__}")


def _remove(document: Any, tokens: list[str], index: int) -> Any:
    if not tokens:
        raise StatePatchError(f"patch[{index}] cannot remove the whole document")

    parent = _descend(document, tokens[:-1], index)
    leaf = tokens[-1]

    if isinstance(parent, dict):
        if leaf not in parent:
            raise StatePatchError(f"patch[{index}] cannot remove missing key {leaf!r}")
        del parent[leaf]
        return document
    if isinstance(parent, list):
        del parent[_list_index(parent, leaf, index, allow_end=False)]
        return document

    raise StatePatchError(
        f"patch[{index}] cannot remove {leaf!r} from {type(parent).__name__}"
    )
