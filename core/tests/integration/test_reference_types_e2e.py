"""End-to-end coverage for user-defined Reference types.

Drives the genuine path over the integration stack: a user creates a type, then
a Reference of it, attaches the Reference to a real room, and an agent runs the
real `connect_to_room` operation. The assertions read the on-connect payload the
agent actually receives, so nothing is inferred from service-level state.

Three properties are pinned here, each stated as a decision in the
implementation plan:

* a user-defined type reaches the connected agent with its own `instructions`
  and `origin: "user"`;
* it reaches the agent even when the type is private to a *different*, unrelated
  user — the room attachment is the grant, and withholding the instructions
  would ship a Reference the agent cannot act on while looking healthy;
* a Reference whose slug resolves to nothing at all is delivered flagged
  `missing`, not silently stripped.
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator
from typing import Any

import pytest

from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.context import init_operations_protocol
from switch_core.bridges.agent.operations.definitions import connect_to_room
from switch_core.db.models import Reference, User
from switch_core.room_service import RoomCreateConfig
from tests.integration.conftest import Harness, SessionEnv

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="session")]


@contextlib.asynccontextmanager
async def _acting_as(harness: Harness, agent_id: str) -> AsyncIterator[None]:
    """Bind the caller an operation resolves itself from.

    Both agent-facing front doors set the operations protocol and a call context
    before dispatching; a test driving an operation directly has to do the same.
    The protocol is a module global re-bound on every entry, so a value left
    behind by an earlier test is never the one an operation reads.
    """
    init_operations_protocol(harness.protocol)
    token = set_call_context(
        CallContext(agent_id=agent_id, session_key=f"session-{agent_id}")
    )
    try:
        yield
    finally:
        reset_call_context(token)


async def _connect(harness: Harness, agent_id: str, room_id: str) -> dict[str, Any]:
    async with _acting_as(harness, agent_id):
        return await connect_to_room(room_id, include_general_instructions=False)


async def _create_user(harness: Harness, name: str, email: str) -> str:
    user = User(name=name, email=email, role="user")
    async with harness.session_factory() as session:  # type: ignore[operator]
        session.add(user)
        await session.commit()
    return user.id


async def _room_with(harness: Harness, name: str, agent_id: str) -> str:
    result = await harness.room_service.create_room(
        RoomCreateConfig(
            name=name,
            description="integration reference-type test",
            agent_ids=[agent_id],
        )
    )
    return result.room.id


async def _attach(
    harness: Harness, room_id: str, reference_id: str, user_id: str
) -> None:
    async with harness.session_factory() as session:  # type: ignore[operator]
        await harness.protocol.resource_service.attach_reference_to_room(
            session, room_id, reference_id, user_id=user_id, is_admin=False
        )
        await session.commit()


async def test_a_user_defined_type_reaches_the_connected_agent(
    harness: Harness,
) -> None:
    agent = await harness.register_agent("e2e-reftype-owner")
    await harness.start_clients()

    resources = harness.protocol.resource_service
    async with harness.session_factory() as session:  # type: ignore[operator]
        await resources.create_reference_type(
            session,
            owner_id=harness.owner_id,
            type="team_wiki",
            display_name="Team Wiki",
            instructions="Read the linked wiki pages before answering.",
            value_hint="Paste links to wiki pages.",
            read_visibility="private",
            write_visibility="private",
        )
        ref = await resources.create_reference(
            session,
            owner_id=harness.owner_id,
            is_admin=False,
            read_visibility="private",
            write_visibility="private",
            type="team_wiki",
            name="Onboarding wiki",
            description="Where the team writes things down",
            instructions="Start at the index page.",
            value={"urls": ["https://example.com/wiki/index"]},
        )
        await session.commit()
        reference_id = ref.id

    room_id = await _room_with(harness, "e2e-reftype-room", agent.agent_id)
    await _attach(harness, room_id, reference_id, harness.owner_id)

    payload = await _connect(harness, agent.agent_id, room_id)

    assert [r["id"] for r in payload["references"]] == [reference_id]
    entry = payload["reference_types"]["team_wiki"]
    assert entry["origin"] == "user"
    assert entry["display_name"] == "Team Wiki"
    assert entry["instructions"] == "Read the linked wiki pages before answering."
    assert entry["value_hint"] == "Paste links to wiki pages."
    assert "missing" not in entry


async def test_a_type_private_to_another_user_still_reaches_the_agent(
    harness: Harness,
) -> None:
    """Decision 3: `read_visibility` gates picking and enumerating a type, never
    delivery of its metadata for a Reference already attached to a room.

    The room attachment is the grant. Do not "fix" this into a visibility filter:
    the agent would receive a Reference it cannot act on while the payload looks
    healthy.
    """
    author_id = await _create_user(harness, "Author", "reftype-author@switch.local")
    # The agent's owner must be a non-admin, or admin-wide visibility would
    # satisfy the assertion without delivery ignoring visibility at all.
    harness.owner_id = await _create_user(
        harness, "Viewer", "reftype-viewer@switch.local"
    )
    agent = await harness.register_agent("e2e-reftype-outsider")
    await harness.start_clients()

    resources = harness.protocol.resource_service
    async with harness.session_factory() as session:  # type: ignore[operator]
        await resources.create_reference_type(
            session,
            owner_id=author_id,
            type="private_playbook",
            display_name="Private Playbook",
            instructions="Follow the playbook's escalation ladder exactly.",
            value_hint="Paste links to playbook pages.",
            read_visibility="private",
            write_visibility="private",
        )
        ref = await resources.create_reference(
            session,
            owner_id=author_id,
            is_admin=False,
            read_visibility="public",
            write_visibility="private",
            type="private_playbook",
            name="Incident playbook",
            description="What to do when paged",
            instructions="Escalate before investigating.",
            value={"urls": ["https://example.com/playbook"]},
        )
        await session.commit()
        reference_id = ref.id

    room_id = await _room_with(harness, "e2e-reftype-private-room", agent.agent_id)
    await _attach(harness, room_id, reference_id, author_id)

    pickable = await harness.protocol.list_reference_types(agent.agent_id)
    assert "private_playbook" not in {e["type"] for e in pickable}

    payload = await _connect(harness, agent.agent_id, room_id)

    entry = payload["reference_types"]["private_playbook"]
    assert entry["origin"] == "user"
    assert entry["display_name"] == "Private Playbook"
    assert entry["instructions"] == "Follow the playbook's escalation ladder exactly."
    assert "missing" not in entry


async def test_an_unresolvable_type_is_delivered_flagged_missing(
    harness: Harness, session_env: SessionEnv
) -> None:
    """Decision 7: `references.type` carries no foreign key and cannot carry one
    (built-ins are not rows), so a slug registered nowhere is a reachable state —
    a built-in retired in a later release, or a row removed by direct SQL.

    Reached here the way production reaches it: a Reference written through the
    store, which validates no type.
    """
    agent = await harness.register_agent("e2e-reftype-missing")
    await harness.start_clients()

    async with harness.session_factory() as session:  # type: ignore[operator]
        ref = await session_env.reference_store.create(
            session,
            Reference(
                owner_id=harness.owner_id,
                read_visibility="private",
                write_visibility="private",
                type="never_registered",
                name="Orphaned reference",
                description="Its type is registered nowhere",
                instructions="Ask the operator what this is.",
                value={"urls": ["https://example.com/orphan"]},
            ),
        )
        await session.commit()
        reference_id = ref.id

    room_id = await _room_with(harness, "e2e-reftype-missing-room", agent.agent_id)
    await _attach(harness, room_id, reference_id, harness.owner_id)

    payload = await _connect(harness, agent.agent_id, room_id)

    entry = payload["reference_types"]["never_registered"]
    assert entry["missing"] is True
    assert entry["origin"] == "unknown"
    assert entry["type"] == "never_registered"
    assert "never_registered" in entry["instructions"]
