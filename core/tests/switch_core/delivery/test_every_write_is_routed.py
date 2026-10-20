"""Every row written to `messages` goes through the router.

The router decides, in the transaction that writes a room row, which agents
the row is for, and stores their own events with it. A row written any other
way is decided for nobody: an addressed message that never reaches the agent
it names, with nothing to say so. So the calls that number and insert a live
row, `MessageStore.create` and `MessageStore.create_unless_stored`, are made
by the router and nowhere else, and this test fails the moment another module
makes one, or inserts into `messages` some other way.

`MessageStore.create_historical` is exempt by design: it backfills history
below a room's live rows, which nothing delivers.
"""

from __future__ import annotations

import ast
from pathlib import Path

import switch_core

_PACKAGE_ROOT = Path(switch_core.__file__).resolve().parent
_ROUTER = _PACKAGE_ROOT / "delivery" / "router.py"
_STORE = _PACKAGE_ROOT / "db" / "stores" / "message_store.py"
_STORE_NAMES = {"message_store", "_message_store", "messages", "_messages"}


def _calls(tree: ast.AST) -> list[ast.Call]:
    return [node for node in ast.walk(tree) if isinstance(node, ast.Call)]


def _is_message_store_create(call: ast.Call) -> bool:
    """`<the message store>.create(...)` or `MessageStore().create(...)`, or
    the same with `create_unless_stored`.

    Matched on the receiver's name, the way every caller has spelled it: a
    store held as `message_store`, `_message_store` or `_messages`, or built
    on the spot.
    """
    func = call.func
    if not isinstance(func, ast.Attribute) or func.attr not in {
        "create",
        "create_unless_stored",
    }:
        return False
    receiver = func.value
    if isinstance(receiver, ast.Attribute):
        return receiver.attr in _STORE_NAMES
    if isinstance(receiver, ast.Name):
        return receiver.id in _STORE_NAMES
    if isinstance(receiver, ast.Call) and isinstance(receiver.func, ast.Name):
        return receiver.func.id == "MessageStore"
    return False


def _inserts_into_messages(call: ast.Call) -> bool:
    """`insert(Message)` / `pg_insert(Message)`: a row written past the store."""
    func = call.func
    name = (
        func.id
        if isinstance(func, ast.Name)
        else func.attr
        if isinstance(func, ast.Attribute)
        else None
    )
    return (
        name in {"insert", "pg_insert"}
        and len(call.args) == 1
        and isinstance(call.args[0], ast.Name)
        and call.args[0].id == "Message"
    )


def test_only_the_router_writes_room_rows() -> None:
    offenders: list[str] = []
    for path in sorted(_PACKAGE_ROOT.rglob("*.py")):
        if path in (_ROUTER, _STORE) or "migrations" in path.parts:
            continue
        tree = ast.parse(path.read_text(), filename=str(path))
        for call in _calls(tree):
            if _is_message_store_create(call) or _inserts_into_messages(call):
                offenders.append(f"{path.relative_to(_PACKAGE_ROOT)}:{call.lineno}")

    assert offenders == [], (
        "These write a room row without the router, so no agent is ever told "
        f"about it: {offenders}. Write it with `MessageRouter.store` in the "
        "caller's transaction, and call `Routed.committed()` after the commit."
    )


def test_the_router_is_what_writes_them() -> None:
    """The other half: the router does call the store, so the check above is
    looking for the right thing rather than passing on a rename."""
    tree = ast.parse(_ROUTER.read_text(), filename=str(_ROUTER))

    assert any(_is_message_store_create(call) for call in _calls(tree))
