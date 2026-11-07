"""Actions the Gateway hides that the server now refuses on its own, so no
route relies on the page to keep them from happening."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Document,
    Invitation,
    Package,
    Room,
    package_references,
)
from switch_core.tenant_context import tenant_scope
from tests.switch_core.gateway.role_matrix.harness import (
    TENANT,
    Persona,
    build_gateway,
    client,
    seed_people,
)
from tests.switch_core.gateway.role_matrix.world import World


async def test_a_direct_or_group_conversations_members_are_not_changed_here(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Its platform fixes who is in it. A DM the bridge adopted is writable by
    every member, so without this anyone could put their own agent in
    someone else's DM."""
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    answers: dict[tuple[str, str], int] = {}
    async with client(gateway) as http:
        for channel_type in ("direct", "group"):
            world = World(
                session_factory, people, f"{channel_type}-room", http, gateway
            )
            room_id = await world.room_agent()
            agent_id = await world.agent()
            other = await world.other_agent()
            with tenant_scope(TENANT):
                async with session_factory() as session:
                    await session.execute(
                        update(Room)
                        .where(Room.id == room_id)
                        .values(
                            channel_type=channel_type,
                            read_visibility="public",
                            write_visibility="public",
                        )
                    )
                    await session.commit()
            for persona in (Persona.MEMBER, Persona.WORKSPACE_ADMIN):
                headers = people.headers(persona)
                for what, response in (
                    (
                        "add agent",
                        await http.post(
                            f"/gateway/rooms/{room_id}/agents",
                            json={"agent_ids": [other]},
                            headers=headers,
                        ),
                    ),
                    (
                        "remove agent",
                        await http.delete(
                            f"/gateway/rooms/{room_id}/agents/{agent_id}",
                            headers=headers,
                        ),
                    ),
                    (
                        "add people",
                        await http.post(
                            f"/gateway/rooms/{room_id}/users",
                            json={"user_names": ["someone"]},
                            headers=headers,
                        ),
                    ),
                ):
                    answers[(f"{channel_type} {what}", persona.value)] = (
                        response.status_code
                    )
    assert set(answers.values()) == {409}, answers


async def test_adding_to_a_package_takes_reading_what_is_added(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A package lists what it holds to everyone who may read it, so adding
    an item someone can't read would show it to them."""
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    async with client(gateway) as http:
        world = World(session_factory, people, "package-read", http, gateway)
        package_id = await world.package()
        reference_id = await world.reference()
        document_id = await world.document()
        with tenant_scope(TENANT):
            async with session_factory() as session:
                await session.execute(
                    update(Package)
                    .where(Package.id == package_id)
                    .values(read_visibility="public", write_visibility="public")
                )
                await session.commit()
        headers = people.headers(Persona.MEMBER)
        reference = await http.post(
            f"/gateway/packages/{package_id}/references/{reference_id}", headers=headers
        )
        document = await http.post(
            f"/gateway/packages/{package_id}/documents/{document_id}", headers=headers
        )
        listed = await http.get(
            f"/gateway/packages/{package_id}/references", headers=headers
        )
    assert (reference.status_code, document.status_code) == (403, 403)
    assert listed.status_code == 200 and listed.json() == []


async def test_a_rooms_own_document_is_changed_in_its_room_not_the_library(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    async with client(gateway) as http:
        world = World(session_factory, people, "room-document", http, gateway)
        room_id = await world.room()
        document_id = await world.document()
        with tenant_scope(TENANT):
            async with session_factory() as session:
                await session.execute(
                    update(Document)
                    .where(Document.id == document_id)
                    .values(room_id=room_id)
                )
                await session.commit()
        answers = {
            persona.value: (
                (
                    await http.patch(
                        f"/gateway/documents/{document_id}",
                        json={"read_visibility": "public"},
                        headers=people.headers(persona),
                    )
                ).status_code,
                (
                    await http.delete(
                        f"/gateway/documents/{document_id}",
                        headers=people.headers(persona),
                    )
                ).status_code,
            )
            for persona in (Persona.OWNER, Persona.WORKSPACE_ADMIN, Persona.MEMBER)
        }
    assert answers == {
        Persona.OWNER.value: (409, 409),
        Persona.WORKSPACE_ADMIN.value: (409, 409),
        # Not told what it is: it can't read it.
        Persona.MEMBER.value: (403, 403),
    }


async def test_an_invitation_that_has_ended_is_not_revoked_again(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Revoking it again would rewrite when, and by whom, it ended."""
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    headers = people.headers(Persona.WORKSPACE_ADMIN)
    async with client(gateway) as http:
        revoked = await World(
            session_factory, people, "revoked", http, gateway
        ).invitation()
        expired = await World(
            session_factory, people, "expired", http, gateway
        ).invitation()
        with tenant_scope(TENANT):
            async with session_factory() as session:
                await session.execute(
                    update(Invitation)
                    .where(Invitation.id == expired)
                    .values(expires_at=datetime.now(UTC) - timedelta(days=1))
                )
                await session.commit()
        path = f"/gateway/tenants/{TENANT}/invitations"
        first = await http.delete(f"{path}/{revoked}", headers=headers)
        with tenant_scope(TENANT):
            async with session_factory() as session:
                revoked_at = await session.scalar(
                    select(Invitation.revoked_at).where(Invitation.id == revoked)
                )
        again = await http.delete(f"{path}/{revoked}", headers=headers)
        late = await http.delete(f"{path}/{expired}", headers=headers)
        with tenant_scope(TENANT):
            async with session_factory() as session:
                assert (
                    await session.scalar(
                        select(Invitation.revoked_at).where(Invitation.id == revoked)
                    )
                    == revoked_at
                )
    assert (first.status_code, again.status_code, late.status_code) == (200, 409, 409)


async def test_attaching_what_is_already_attached_changes_nothing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """As for references: the page leaves attached things out of its pickers,
    and asking again is not a server error."""
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    headers = people.headers(Persona.OWNER)
    async with client(gateway) as http:
        world = World(session_factory, people, "attach-twice", http, gateway)
        room_id = await world.room()
        package_id = await world.package()
        document_id = await world.document()
        reference_id = await world.reference()
        statuses = [
            (await http.post(path, headers=headers)).status_code
            for path in (
                f"/gateway/rooms/{room_id}/documents/{document_id}",
                f"/gateway/rooms/{room_id}/documents/{document_id}",
                f"/gateway/rooms/{room_id}/packages/{package_id}",
                f"/gateway/rooms/{room_id}/packages/{package_id}",
                f"/gateway/packages/{package_id}/references/{reference_id}",
                f"/gateway/packages/{package_id}/references/{reference_id}",
                f"/gateway/packages/{package_id}/documents/{document_id}",
                f"/gateway/packages/{package_id}/documents/{document_id}",
            )
        ]
        with tenant_scope(TENANT):
            async with session_factory() as session:
                held = (
                    await session.execute(
                        select(package_references).where(
                            package_references.c.package_id == package_id
                        )
                    )
                ).all()
    assert all(status < 300 for status in statuses), statuses
    assert len(held) == 1


async def test_saving_an_addressing_rule_that_can_never_match_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """It would let nobody in while looking as if it did, and a policy of
    nothing else would shut the agent off, its owner included."""
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    headers = people.headers(Persona.OWNER)
    async with client(gateway) as http:
        world = World(session_factory, people, "dead-rule", http, gateway)
        path = f"/gateway/agents/{await world.agent()}/addressing-policy"
        dead = await http.put(
            path,
            json={
                "policy": {
                    "rules": [
                        {"users": [], "agents": [], "owner": True},
                        {"rooms": [], "owner": True},
                    ]
                }
            },
            headers=headers,
        )
        kept = (
            await http.get(path.removesuffix("/addressing-policy"), headers=headers)
        ).json()
        owner_only = await http.put(
            path,
            json={"policy": {"rules": [{"users": [], "agents": [], "owner": True}]}},
            headers=headers,
        )
    assert dead.status_code == 422, dead.text
    assert "rule 2: it names no rooms" in dead.json()["detail"]
    assert "rule 1" not in dead.json()["detail"]
    assert kept["addressing_policy"] is None
    assert owner_only.status_code == 200, owner_only.text
