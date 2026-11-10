"""The `get_permalinks` operation's own checks, over a fake protocol.

The HTTP door checks only argument names, so the operation checks the
types and the size itself. What reaches the protocol is the list with its
duplicates collapsed, in the order given.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pytest

from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.definitions import (
    GET_PERMALINKS_MAX_IDS,
    get_permalinks,
)

AGENT = "agent-1"


class _Protocol:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list[str]]] = []

    async def get_permalinks(
        self, agent_id: str, message_ids: Sequence[str]
    ) -> dict[str, dict[str, str]]:
        self.calls.append((agent_id, list(message_ids)))
        return {"permalinks": {}, "unavailable": dict.fromkeys(message_ids, "x")}


@pytest.fixture
def protocol(monkeypatch: pytest.MonkeyPatch) -> _Protocol:
    service = _Protocol()
    monkeypatch.setattr(op_context, "_protocol", service)
    return service


@pytest.fixture
def caller():
    token = set_call_context(
        CallContext(agent_id=AGENT, session_key="conn-1", session=None)
    )
    yield
    reset_call_context(token)


@pytest.fixture
def unbound_caller():
    """A caller with no connection at all, so no room is connected."""
    token = set_call_context(
        CallContext(agent_id=AGENT, session_key=None, session=None)
    )
    yield
    reset_call_context(token)


async def test_empty_list_is_refused(protocol: _Protocol, caller: None) -> None:
    with pytest.raises(ValueError, match="at least one"):
        await get_permalinks([])
    assert protocol.calls == []


async def test_more_than_fifty_ids_is_refused(
    protocol: _Protocol, caller: None
) -> None:
    with pytest.raises(ValueError, match="50"):
        await get_permalinks([f"$e{n}" for n in range(GET_PERMALINKS_MAX_IDS + 1)])
    assert protocol.calls == []


async def test_fifty_ids_are_accepted(protocol: _Protocol, caller: None) -> None:
    ids = [f"$e{n}" for n in range(GET_PERMALINKS_MAX_IDS)]

    await get_permalinks(ids)

    assert protocol.calls == [(AGENT, ids)]


@pytest.mark.parametrize("bad", [[1], ["$ok", None], "$not-a-list"])
async def test_non_string_id_is_refused(
    protocol: _Protocol, caller: None, bad: Any
) -> None:
    with pytest.raises(ValueError):
        await get_permalinks(bad)
    assert protocol.calls == []


async def test_duplicates_are_collapsed_before_delegating(
    protocol: _Protocol, caller: None
) -> None:
    result = await get_permalinks(["$b", "$a", "$b"])

    assert protocol.calls == [(AGENT, ["$b", "$a"])]
    assert list(result["unavailable"]) == ["$b", "$a"]


async def test_no_connected_room_is_needed(
    protocol: _Protocol, unbound_caller: None
) -> None:
    await get_permalinks(["$a"])

    assert protocol.calls == [(AGENT, ["$a"])]
