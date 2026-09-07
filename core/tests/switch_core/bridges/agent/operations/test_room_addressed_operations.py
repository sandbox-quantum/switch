"""Naming the room on an operation, for a connection that holds several.

`require_connected_room` has always answered "which room is this call about?"
from the caller's binding alone, which works precisely while a caller has one
room. A connection covering several surfaces has no single answer, and today it
gets an error that tells it to "pass the room explicitly" — an affordance no
operation actually offers. Delivery to such a connection works and every action
fails.

So the room becomes an optional argument on the operations that plausibly act
across rooms, and resolution moves into one place:

- omitted with one room, the room (every existing caller, unchanged);
- omitted with several, an error rather than a guess — picking one silently is
  how a private answer ends up in a public channel;
- supplied, checked against what the caller actually holds, because a room id
  arriving from a model is an argument and not a permission.

That bounded widening — `post_message`, `read_context`, `send_targeted_message`
and nothing else — turned out to be the wrong line, and a live `multi` session
found it within minutes: it called `list_participants`, was told to "pass
room_id explicitly", and had no such parameter to pass. Nineteen operations were
in that state. A connection could talk and read, and do nothing else.

So the rule is now structural rather than a list, and the tests below derive it
from the source rather than restating it:

- an operation that **acts on** a room takes `room_id` and passes it through;
- an operation that only needs the caller to **be** somewhere calls
  `require_connected` instead, and takes no room argument — demanding a room id
  it then discards is noise the caller cannot act on.

Deriving it matters more than the individual cases: the failure is not that
someone widened the wrong three, it is that "which operations take a room" was
a list someone had to remember to extend. An operation added tomorrow is
covered here without anyone thinking about it.
"""

from __future__ import annotations

import ast
import re
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.operations import definitions as ops
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.context import (
    init_operations_protocol,
    require_connected_room,
)
from switch_core.bridges.agent.operations.registry import all_operations
from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)

AGENT = "agent-1"
CONN = "conn-1"
ROOM_A = "room-a"
ROOM_B = "room-b"
ROOM_ELSEWHERE = "room-elsewhere"

WIDENED = ("post_message", "read_context", "send_targeted_message")


# ── Which operations are room-bound, read off the source ─────────────────────


def _operation_defs() -> list[ast.AsyncFunctionDef]:
    source = Path(ops.__file__).read_text()
    return [
        node
        for node in ast.parse(source).body
        if isinstance(node, ast.AsyncFunctionDef)
        and any(
            isinstance(d, ast.Name) and d.id == "operation" for d in node.decorator_list
        )
    ]


def _resolver_calls(node: ast.AST, name: str) -> list[ast.Call]:
    return [
        n
        for n in ast.walk(node)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == name
    ]


def _classify() -> tuple[set[str], set[str]]:
    """Split the room-bound operations by which resolver they call.

    Keyed on the resolver, not on the shape of the statement around it.
    An earlier version asked whether the call was an `ast.Assign` (acts on the
    room) or a bare `ast.Expr` (connectivity only), which had two failures that
    both passed silently: reverting an operation to `require_connected_room()`
    moved it back into `binding_only` — so the very regression under test
    re-classified itself out of the test — and any other statement shape, say
    `if await require_connected_room():`, landed in neither set and generated
    no cases at all.

    Touching the room resolver at all means the caller must be able to say
    which room. That is the rule, and it does not depend on syntax.
    """
    acts_on, binding_only = set(), set()
    for fn in _operation_defs():
        if _resolver_calls(fn, "require_connected"):
            binding_only.add(fn.name)
        if _resolver_calls(fn, "require_connected_room"):
            acts_on.add(fn.name)
    return acts_on, binding_only


def _passes_room_id_through() -> set[str]:
    """Operations that pass their own `room_id` to `require_connected_room`.

    Matches the name, not merely "some argument": `require_connected_room("x")`
    or a different variable would satisfy the looser check while sending every
    caller to one hard-coded room.
    """

    def names_room_id(call: ast.Call) -> bool:
        supplied = [*call.args, *(k.value for k in call.keywords)]
        return any(isinstance(a, ast.Name) and a.id == "room_id" for a in supplied)

    return {
        fn.name
        for fn in _operation_defs()
        if any(names_room_id(c) for c in _resolver_calls(fn, "require_connected_room"))
    }


ACTS_ON_A_ROOM, ONLY_NEEDS_A_BINDING = _classify()


# ── Fakes ────────────────────────────────────────────────────────────────────


class _NoSession:
    """A session factory that yields nothing — no database in these tests."""

    def __call__(self) -> _NoSession:
        return self

    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *_exc: Any) -> bool:
        return False


class _BindingRows:
    """The legacy `agent_sessions` binding, for callers with no connection."""

    def __init__(self, bound_room: str | None) -> None:
        self._bound_room = bound_room

    async def get_connected_room(self, _db: Any, _key: str) -> tuple[str, str] | None:
        if self._bound_room is None:
            return None
        return ("session-row", self._bound_room)


class _Protocol(SimpleNamespace):
    """Records what the operations asked the protocol to do."""

    def __init__(self, registry: ConnectionRegistry, bound_room: str | None = None):
        super().__init__(
            connections=registry,
            session_factory=_NoSession(),
            agent_session_store=_BindingRows(bound_room),
        )
        self.sent: list[tuple[str, str]] = []
        self.targeted: list[tuple[str, str]] = []
        self.read: list[str] = []
        self.participants_of: list[str] = []
        self.documents_created: list[str] = []
        self.roles_assumed: list[tuple[str, str]] = []
        self.roles_released: list[str] = []

    async def list_participants(self, room_id: str) -> list[Any]:
        self.participants_of.append(room_id)
        return []

    async def require_room_member(self, _agent_id: str, _room_id: str) -> None:
        return None

    async def request_room_document_create(self, *, room_id: str, **_kw: Any) -> str:
        self.documents_created.append(room_id)
        return "doc-1"

    async def assume_room_role(
        self, _agent_id: str, room_id: str, role: str, _key: str | None
    ) -> dict[str, Any]:
        self.roles_assumed.append((room_id, role))
        return {"role": role, "instructions": ""}

    async def release_room_role(self, agent_id: str) -> None:
        self.roles_released.append(agent_id)

    # The task lifecycle. Keyed on a task id, never on the caller's room.
    async def accept_task(self, _agent_id: str, _task_id: str) -> None:
        return None

    async def update_task(self, _agent_id: str, _task_id: str, _update: str) -> None:
        return None

    async def finalise_task(self, _agent_id: str, _task_id: str, _outcome: str) -> None:
        return None

    async def cancel_task(self, _agent_id: str, _task_id: str, _reason: str) -> None:
        return None

    async def list_rooms(self, _agent_id: str, **_kw: Any) -> list[Any]:
        return [
            SimpleNamespace(id=r, name=r, description="", archived=False)
            for r in (ROOM_A, ROOM_B, ROOM_ELSEWHERE)
        ]

    async def get_task(self, _agent_id: str, task_id: str) -> Any:
        return SimpleNamespace(
            id=task_id,
            status=SimpleNamespace(value="ongoing"),
            accepted_at=None,
            finalised_at=None,
            outcome=None,
            summary="",
            updates=[],
        )

    async def send_message(
        self, _agent_id: str, room_id: str, body: str, **_kw: Any
    ) -> str:
        self.sent.append((room_id, body))
        return "$event"

    async def send_targeted_message(
        self, _agent_id: str, room_id: str, _names: list[str], body: str, **_kw: Any
    ) -> Any:
        self.targeted.append((room_id, body))
        return SimpleNamespace(event_id="$event", target_statuses={})

    async def read_context(self, _agent_id: str, room_id: str, **_kw: Any) -> dict:
        self.read.append(room_id)
        return {"threads": [], "truncated": False, "oldest_timestamp": None}


def _registry_holding(*rooms: str, scope: str = "multi") -> ConnectionRegistry:
    registry = ConnectionRegistry()
    conn = registry.open(
        agent_id=AGENT,
        connection_id=CONN,
        scope=scope,  # type: ignore[arg-type]
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
    )
    for room in rooms:
        registry.claim_room(conn, room)
    return registry


@contextmanager
def _calling(protocol: Any, session_key: str | None = CONN):
    init_operations_protocol(protocol)
    token = set_call_context(CallContext(agent_id=AGENT, session_key=session_key))
    try:
        yield protocol
    finally:
        reset_call_context(token)


# ── Resolution: the room is omitted ──────────────────────────────────────────


async def test_one_room_and_no_argument_resolves_to_that_room() -> None:
    """Every caller that exists today. This must not change."""
    with _calling(_Protocol(_registry_holding(ROOM_A))):
        assert await require_connected_room() == ROOM_A


async def test_several_rooms_and_no_argument_is_an_error_not_a_guess() -> None:
    """Picking one silently is how a private answer reaches a public channel."""
    with _calling(_Protocol(_registry_holding(ROOM_A, ROOM_B))):
        with pytest.raises(ValueError) as excinfo:
            await require_connected_room()

    # Named specifically: "room" alone also matches the not-connected error, so
    # deleting the connection branch outright would leave this test green.
    message = str(excinfo.value)
    assert "several rooms" in message
    assert ROOM_A in message and ROOM_B in message


async def test_no_binding_at_all_still_says_to_connect_first() -> None:
    with _calling(_Protocol(ConnectionRegistry()), session_key=None):
        with pytest.raises(ValueError) as excinfo:
            await require_connected_room()

    assert "connect_to_room" in str(excinfo.value)


# ── Resolution: the room is supplied ─────────────────────────────────────────


async def test_a_supplied_room_the_caller_holds_is_used() -> None:
    with _calling(_Protocol(_registry_holding(ROOM_A, ROOM_B))):
        assert await require_connected_room(ROOM_B) == ROOM_B


async def test_a_supplied_room_the_caller_does_not_hold_is_refused() -> None:
    """A room id from a model is an argument, not a permission.

    Without the check, an agent could post into any room it can name — including
    one another of its own connections is claiming, which the slot invariant
    exists to prevent.
    """
    with _calling(_Protocol(_registry_holding(ROOM_A, ROOM_B))):
        with pytest.raises(ValueError) as excinfo:
            await require_connected_room(ROOM_ELSEWHERE)

    assert ROOM_ELSEWHERE in str(excinfo.value)


async def test_a_single_room_caller_may_name_the_room_it_holds() -> None:
    """Passing the room explicitly is allowed everywhere, not just under `multi`."""
    with _calling(_Protocol(_registry_holding(ROOM_A, scope="single"))):
        assert await require_connected_room(ROOM_A) == ROOM_A


async def test_a_single_room_caller_cannot_name_a_different_room() -> None:
    with _calling(_Protocol(_registry_holding(ROOM_A, scope="single"))):
        with pytest.raises(ValueError):
            await require_connected_room(ROOM_B)


# ── Resolution: the legacy binding row (MCP transport sessions) ──────────────


async def test_a_connectionless_caller_still_resolves_from_its_binding_row() -> None:
    protocol = _Protocol(ConnectionRegistry(), bound_room=ROOM_A)
    with _calling(protocol, session_key="mcp-transport-session"):
        assert await require_connected_room() == ROOM_A


async def test_a_connectionless_caller_may_name_the_room_it_is_bound_to() -> None:
    protocol = _Protocol(ConnectionRegistry(), bound_room=ROOM_A)
    with _calling(protocol, session_key="mcp-transport-session"):
        assert await require_connected_room(ROOM_A) == ROOM_A


async def test_a_connectionless_caller_cannot_name_another_room() -> None:
    """The row binds one room; naming a different one is not a way around it."""
    protocol = _Protocol(ConnectionRegistry(), bound_room=ROOM_A)
    with _calling(protocol, session_key="mcp-transport-session"):
        with pytest.raises(ValueError):
            await require_connected_room(ROOM_B)


async def test_a_connectionless_caller_with_no_row_says_to_connect_first() -> None:
    protocol = _Protocol(ConnectionRegistry(), bound_room=None)
    with _calling(protocol, session_key="mcp-transport-session"):
        with pytest.raises(ValueError) as excinfo:
            await require_connected_room()

    assert "connect_to_room" in str(excinfo.value)


# ── The widened operations actually route by it ──────────────────────────────


async def test_post_message_posts_to_the_named_room() -> None:
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        await ops.post_message("hello", room_id=ROOM_B)

    assert protocol.sent == [(ROOM_B, "hello")]


async def test_post_message_without_a_room_refuses_when_several_are_held() -> None:
    """No fallback to "the first one" — the failure has to be visible."""
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        with pytest.raises(ValueError):
            await ops.post_message("hello")

    assert protocol.sent == []


async def test_read_context_reads_the_named_room() -> None:
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        await ops.read_context(room_id=ROOM_B)

    assert protocol.read == [ROOM_B]


async def test_send_targeted_message_sends_to_the_named_room() -> None:
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        await ops.send_targeted_message(
            "over here", target_names=["someone"], room_id=ROOM_B
        )

    assert protocol.targeted == [(ROOM_B, "over here")]


async def test_an_operation_without_a_room_still_refuses_rather_than_guessing() -> None:
    """Widening must not leave a silent picker behind.

    Holding several rooms and naming none, `list_participants` must fail rather
    than answer about whichever room came first.
    """
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        with pytest.raises(ValueError):
            await ops.list_participants()


# ── The newly widened operations route by the room, not just accept it ───────


async def test_list_participants_answers_about_the_named_room() -> None:
    """The operation the live session actually hit."""
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        await ops.list_participants(room_id=ROOM_B)

    assert protocol.participants_of == [ROOM_B]


async def test_list_participants_refuses_a_room_the_caller_does_not_hold() -> None:
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        with pytest.raises(ValueError):
            await ops.list_participants(room_id=ROOM_ELSEWHERE)

    assert protocol.participants_of == []


async def test_create_room_document_creates_in_the_named_room() -> None:
    """US-3's schedule persistence writes through here.

    While this could not be told which room, a `multi` agent had nowhere to
    keep a schedule — so the wake-up story was not merely unbuilt, it was
    unbuildable on this scope.
    """
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        await ops.create_room_document(
            name="schedule", description="d", instructions="i", content="c",
            room_id=ROOM_B,
        )

    assert protocol.documents_created == [ROOM_B]


async def test_assume_role_takes_the_role_in_the_named_room() -> None:
    """A role is held per room, so this one is a routing decision, not a lookup."""
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        await ops.assume_role(role="reviewer", room_id=ROOM_B)

    assert protocol.roles_assumed == [(ROOM_B, "reviewer")]


# ── "Where am I?" has to answer with every room ──────────────────────────────


async def test_list_rooms_marks_every_room_the_caller_holds() -> None:
    """`list_rooms` resolves the room inline, so D4's fix did not reach it.

    It marked `connected` only when the caller held exactly one room, so a
    connection holding two was told it was in **neither** — and the skill sends
    an agent here to answer "where am I?". A multi-surface agent that believes
    it is nowhere reconnects, and reconnecting is what costs it a room slot.
    """
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        listed = await ops.list_rooms()

    connected = {r["room_id"] for r in listed if r["connected"]}
    assert connected == {ROOM_A, ROOM_B}


async def test_list_rooms_still_marks_the_single_room_case() -> None:
    protocol = _Protocol(_registry_holding(ROOM_A, scope="single"))
    with _calling(protocol):
        listed = await ops.list_rooms()

    assert {r["room_id"] for r in listed if r["connected"]} == {ROOM_A}


async def test_list_rooms_marks_nothing_when_the_caller_holds_nothing() -> None:
    """The claim must come from the rooms held, not from the room existing."""
    protocol = _Protocol(_registry_holding())
    with _calling(protocol):
        listed = await ops.list_rooms()

    assert not [r for r in listed if r["connected"]]


# ── The connectivity-only operations stop demanding a room ───────────────────


async def test_release_role_works_while_several_rooms_are_held() -> None:
    """It never used the room. Refusing it for ambiguity was the bug.

    A role lease is per agent, so an agent on two surfaces could take a role
    and then be unable to give it back.
    """
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        assert await ops.release_role() == {"status": "released"}

    assert protocol.roles_released == [AGENT]


@pytest.mark.parametrize(
    "call",
    [
        pytest.param(lambda: ops.accept_task("task-1"), id="accept_task"),
        pytest.param(lambda: ops.update_task("task-1", "progress"), id="update_task"),
        pytest.param(lambda: ops.finalise_task("task-1", "done"), id="finalise_task"),
        pytest.param(lambda: ops.cancel_task("task-1", "changed my mind"), id="cancel_task"),
    ],
)
async def test_the_task_lifecycle_works_while_several_rooms_are_held(call) -> None:
    """The four operations a schema check cannot speak for.

    Reverting these to `require_connected_room()` reinstates D4 for the whole
    task lifecycle, and the structural tests stay green either way: the schema
    assertion is "no room_id", which the broken version also satisfies. Only
    calling them proves it.

    A task id is globally unique and every one of these re-checks membership of
    the task's *own* room, so the caller's room was never part of the decision.
    """
    protocol = _Protocol(_registry_holding(ROOM_A, ROOM_B))
    with _calling(protocol):
        await call()


async def test_a_connectivity_only_operation_still_needs_a_connection() -> None:
    """Relaxing ambiguity must not relax the check itself.

    Deleting the call outright would satisfy every other test in this section.
    """
    with _calling(_Protocol(ConnectionRegistry()), session_key=None):
        with pytest.raises(ValueError) as excinfo:
            await ops.release_role()

    assert "connect_to_room" in str(excinfo.value)


# ── Both front doors see it ──────────────────────────────────────────────────


@pytest.mark.parametrize("name", sorted(ACTS_ON_A_ROOM))
def test_every_room_acting_operation_publishes_room_id(name: str) -> None:
    """The whole of D4 in one assertion, for every operation at once.

    An operation that resolves a room and cannot be told which one is
    uncallable the moment a connection holds two — the caller is told to pass
    `room_id` and there is nowhere to put it. Derived from the source, so an
    operation added later is covered without being added to a list.
    """
    schema = all_operations()[name].input_schema

    assert "room_id" in schema["properties"], (
        f"{name} resolves a room but publishes no room_id — a caller holding "
        f"two rooms cannot call it at all"
    )
    assert "room_id" not in schema.get("required", [])


@pytest.mark.parametrize("name", sorted(ACTS_ON_A_ROOM))
def test_every_room_acting_operation_passes_room_id_through(name: str) -> None:
    """Accepting the argument and ignoring it is the silent version of D4.

    The schema check above passes for an operation that takes `room_id` and
    still calls `require_connected_room()` bare — the caller supplies a room,
    is refused for ambiguity anyway, and nothing says why.
    """
    assert name in _passes_room_id_through(), (
        f"{name} accepts room_id but does not pass it to require_connected_room"
    )


@pytest.mark.parametrize("name", sorted(ACTS_ON_A_ROOM))
def test_every_room_acting_operation_documents_room_id(name: str) -> None:
    """The docstring **is** the MCP tool description.

    A parameter that exists and is undescribed is invisible to the model that
    has to decide whether to pass it — the same discoverability failure as D4,
    narrowed to one tool. `list_linked_rooms` was in that state, and was missed
    by a first check that matched the substring `room_id` against the
    `target_room_id` in its own return shape. Hence the token match here.
    """
    doc = all_operations()[name].description

    assert re.search(r"(?<![\w.])room_id\b", doc), (
        f"{name} takes room_id and never names it in its description"
    )


@pytest.mark.parametrize("name", sorted(ONLY_NEEDS_A_BINDING))
def test_a_connectivity_only_operation_asks_for_no_room(name: str) -> None:
    """The other half of the rule, and the reason it is not "add room_id to all".

    These five never use the room they resolve — they only require the caller
    to be somewhere. Demanding a room id and discarding it is an argument the
    caller cannot reason about, so they check connectivity instead.
    """
    schema = all_operations()[name].input_schema

    assert "room_id" not in schema["properties"], (
        f"{name} discards the room it resolves; it should call "
        f"require_connected rather than take a room_id it ignores"
    )


def test_the_source_scan_actually_found_operations() -> None:
    """Guards the three parametrized tests above from passing vacuously.

    They are generated from an AST walk. If it stops matching — a rename, an
    import style change — every case silently disappears and the suite goes
    green with nothing checked.
    """
    assert len(ACTS_ON_A_ROOM) >= 15
    assert len(ONLY_NEEDS_A_BINDING) >= 5
    # The two sets are the same scan split in half; an overlap means the
    # "uses the room" test is deciding both answers.
    assert not (ACTS_ON_A_ROOM & ONLY_NEEDS_A_BINDING)
    assert set(WIDENED) <= ACTS_ON_A_ROOM

    # Total, not just non-empty. Thresholds alone let a partial regression
    # through: two operations dropping out of the scan still clears `>= 15`.
    every_room_bound = {
        fn.name
        for fn in _operation_defs()
        if _resolver_calls(fn, "require_connected_room")
        or _resolver_calls(fn, "require_connected")
    }
    assert ACTS_ON_A_ROOM | ONLY_NEEDS_A_BINDING == every_room_bound


@pytest.mark.parametrize("name", WIDENED)
def test_the_room_argument_is_published_on_the_tool_surface(name: str) -> None:
    """The MCP server and the HTTP endpoint are both built from this schema.

    If `room_id` is not in it, the parameter exists in Python and no agent can
    reach it.
    """
    schema = all_operations()[name].input_schema

    assert "room_id" in schema["properties"]


@pytest.mark.parametrize("name", WIDENED)
def test_the_room_argument_is_optional(name: str) -> None:
    """Existing single-room callers must keep working untouched.

    Asserts presence as well as optionality: "not in required" is satisfied by
    a parameter that does not exist, so on its own it would pass today and go
    on passing if the argument were later dropped.
    """
    schema = all_operations()[name].input_schema

    assert "room_id" in schema["properties"]
    assert "room_id" not in schema.get("required", [])
