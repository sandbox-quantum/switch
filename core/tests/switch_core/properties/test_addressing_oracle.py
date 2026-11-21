"""The router's addressing against a reference model, `addressing_reference.py`.

Each example is a room made in a transaction: its agents, their aliases,
roles and policies, and a message from someone. The message is written
through the router, which decides in that transaction which agents it is for;
the agents it stored own events for must be exactly those the reference
names. The transaction is then rolled back, so every example starts from the
same world.
"""

from __future__ import annotations

import asyncio
from collections import Counter

import pytest
from hypothesis import given, note, settings
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from switch_core.db.engine import create_session_factory
from switch_core.db.models import TENANT_ZERO_ID, AgentEventRow, Message
from switch_core.db.session_scope import tenant_session
from switch_core.tenant_context import tenant_scope
from switch_core.transport.postgres import new_event_id
from tests.conftest import empty_the_database
from tests.routing import router_on
from tests.switch_core.properties.addressing_reference import (
    ACCOUNTS,
    AGENTS,
    Case,
    addressable,
    cases,
    content_of,
    expected,
    formatted_body_of,
    make_world,
    mentions,
    sender_of,
    write_room,
)

COVERAGE: Counter[str] = Counter()
SHOULD_REACH = (
    "for nobody",
    "for one agent",
    "for several agents",
    "refused by a policy",
    "by alias",
    "by role",
    "alone in a direct room",
    "a person's name taken out",
    "let through as the owner",
    "let through as the owner's agent",
    "let through on a person's behalf",
    "let through on an agent's behalf",
)


def _count(case: Case, decided: set[str]) -> None:
    COVERAGE[
        "for nobody"
        if not decided
        else "for one agent"
        if len(decided) == 1
        else "for several agents"
    ] += 1
    if any(
        mentions(case.body, name) and not mentions(addressable(case), name)
        for name in case.person_names or ()
    ):
        COVERAGE["a person's name taken out"] += 1
    if case.channel_type == "direct" and len(case.members) == 1 and decided:
        COVERAGE["alone in a direct room"] += 1
    for member in case.members:
        if member.agent in decided and member.policy is not None:
            owner = AGENTS[member.agent]
            behalf = (case.platform_marker or {}).get("on_behalf_of")
            if behalf is not None:
                COVERAGE[
                    "let through on an agent's behalf"
                    if "agent_id" in behalf
                    else "let through on a person's behalf"
                ] += 1
            elif case.sender.startswith("agent:"):
                if AGENTS[case.sender.removeprefix("agent:")] == owner:
                    COVERAGE["let through as the owner's agent"] += 1
            elif case.sender == "member:pete" and owner == "pete":
                COVERAGE["let through as the owner"] += 1
            elif case.sender.startswith("account:") and owner in ACCOUNTS.get(
                case.sender.removeprefix("account:"), ()
            ):
                COVERAGE["let through as the owner"] += 1
        if member.agent in decided:
            if member.alias and f"@{member.alias.lower()}" in case.body.lower():
                COVERAGE["by alias"] += 1
            if member.role and f"@{member.role.lower()}" in case.body.lower():
                COVERAGE["by role"] += 1
        elif f"@{member.agent}" in case.body and member.policy is not None:
            COVERAGE["refused by a policy"] += 1


@pytest.mark.property("delivery.addressing-matches-reference")
def test_a_row_is_for_the_agents_the_reference_says(postgres_schema: str) -> None:
    COVERAGE.clear()
    loop = asyncio.new_event_loop()
    scope = tenant_scope(TENANT_ZERO_ID)
    scope.__enter__()
    engine = create_async_engine(postgres_schema)
    try:
        loop.run_until_complete(empty_the_database(engine))
        factory = create_session_factory(engine)
        world = loop.run_until_complete(make_world(factory))
        router = router_on(factory)
        names = {agent_id: name for name, agent_id in world.agents.items()}

        async def decide(case: Case) -> set[str]:
            async with tenant_session(factory, TENANT_ZERO_ID) as session:
                room = await write_room(session, world, case)
                sender, sender_client = sender_of(world, case)
                routed = await router.store(
                    session,
                    tenant_id=TENANT_ZERO_ID,
                    room_id=room.id,
                    transport_room_id=room.transport_room_id,
                    message=Message(
                        room_id=room.id,
                        transport_event_id=new_event_id(),
                        sender_id=sender,
                        sender_client_id=sender_client,
                        sender_name=case.sender,
                        event_type="m.room.message",
                        msgtype="m.text",
                        body=case.body,
                        formatted_body=formatted_body_of(world, case),
                        content=content_of(world, case),
                    ),
                    attachments=[],
                )
                decided = set(
                    (
                        await session.scalars(
                            select(AgentEventRow.agent_id).where(
                                AgentEventRow.room_id == room.id,
                                AgentEventRow.room_seq == routed.seq,
                            )
                        )
                    ).all()
                )
                await session.rollback()
            return {names[agent_id] for agent_id in decided}

        current = settings()

        @settings(current, max_examples=max(500, 5 * current.max_examples))
        @given(case=cases())
        def check(case: Case) -> None:
            decided = loop.run_until_complete(decide(case))
            note(f"the router decided {sorted(decided)}")
            _count(case, decided)
            assert decided == expected(case)

        check()
    finally:
        try:
            loop.run_until_complete(engine.dispose())
        finally:
            scope.__exit__(None, None, None)
            loop.close()
    print(f"reached {dict(COVERAGE)}")
    if settings.get_current_profile_name() == "nightly":
        unreached = [what for what in SHOULD_REACH if COVERAGE[what] == 0]
        assert not unreached, (
            f"the run never reached {unreached}; it reached {dict(COVERAGE)}"
        )
