"""Bringing the agents an official template created up to a new revision of
it, through the real management service: values nobody changed follow the
template, values somebody changed stay theirs, permissions never move, and
two servers updating at once update each agent once."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import switch_core.official_templates as official_templates_package
from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations import template_status
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentDefinition,
    TemplateInstall,
    User,
)
from switch_core.db.stores.agent_definition_store import DefinitionChanged
from switch_core.db.stores.template_install_store import TemplateInstallStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.rooms import router as rooms_router
from switch_core.management import template_updates as template_updates_module
from switch_core.management.template_updates import BUDDY_ID, TemplateUpdates
from switch_core.official_templates import (
    OfficialTemplate,
    official_template,
    released_agent_fingerprints,
    revisions,
)
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    cookies_for,
    enroll_console,
)
from tests.switch_core.management.test_agent_operations import _NoRooms, _online

pytestmark = pytest.mark.usefixtures("_short_listen")


@pytest.fixture
def _short_listen(monkeypatch: pytest.MonkeyPatch) -> None:
    from switch_core.gateway import rooms as gateway_rooms

    monkeypatch.setattr(gateway_rooms, "LISTEN_TIMEOUT_SECONDS", 0.1)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Iterator[Harness]:
    harness = build_harness(session_factory)
    harness.protocol.config.feature_flags = {  # type: ignore[attr-defined]
        "agent_management": True,
        "switch_buddy": True,
    }
    previous = op_context._protocol
    op_context.init_operations_protocol(harness.protocol)
    harness.gateway_app.include_router(rooms_router, prefix="/rooms")
    harness.gateway_app.dependency_overrides[gw_deps.get_room_yaml_service] = lambda: (
        _NoRooms()
    )
    try:
        yield harness
    finally:
        op_context._protocol = previous


@pytest.fixture
async def client(harness: Harness) -> AsyncIterator[httpx.AsyncClient]:
    async with harness.client() as client:
        yield client


_OFFICIAL = Path(official_templates_package.__file__).parent


@pytest.fixture(autouse=True)
def _released_as_served(monkeypatch: pytest.MonkeyPatch) -> None:
    """As on a released server: the template's files are its last recorded
    revision, even on a branch that changed them since."""
    current = revisions.entry_for(_OFFICIAL / "switch-buddy")["agents"]
    older = [
        (revision, agents)
        for revision, agents in released_agent_fingerprints("switch-buddy")
        if revision != _buddy().version
    ]
    monkeypatch.setattr(
        template_updates_module,
        "released_agent_fingerprints",
        lambda slug: [(_buddy().version, current), *older],
    )


def _buddy() -> OfficialTemplate:
    buddy = official_template(BUDDY_ID, True, switch_buddy=True)
    assert buddy is not None
    return buddy


def _next_revision(
    *, edit: str = "", can_manage_agents: bool = True
) -> OfficialTemplate:
    """switch-buddy as a release after this one might ship it."""
    buddy = _buddy()
    content = buddy.content.replace(
        "Your assistant in Switch.", "Your assistant in Switch, revised."
    ).replace("You are **switch-buddy**", "You are **switch-buddy** (revised)" + edit)
    if not can_manage_agents:
        content = content.replace("can_manage_agents: true", "can_manage_agents: false")
    assert content != buddy.content
    return replace(buddy, content=content, version=buddy.version + 1)


def _updates(harness: Harness) -> TemplateUpdates:
    return TemplateUpdates(
        engine=harness.session_factory.kw["bind"],
        session_factory=harness.session_factory,
        management=harness.management.service,
        protocol=harness.protocol,
        agent_management=True,
        switch_buddy=True,
    )


async def _create_buddy(
    harness: Harness, client: httpx.AsyncClient, owner: User, name: str
) -> str:
    controller = await enroll_console(harness, client, owner, name=f"laptop-{name}")
    await _online(client, controller)
    response = await client.post(
        "/gateway/rooms/from-template-document",
        json={
            "template": _buddy().content,
            "template_name": "switch-buddy",
            "inputs": {"agent_name": name, "provider": "claude"},
        },
        cookies=cookies_for(owner),
    )
    assert response.status_code == 201, response.text
    return str(response.json()["created_agents"][0]["agent_id"])


async def _agent(harness: Harness, agent_id: str) -> tuple[Agent, AgentDefinition]:
    async with harness.session_factory() as session:
        agent = await session.get(Agent, agent_id)
        row = (
            await session.execute(
                select(AgentDefinition).where(AgentDefinition.agent_id == agent_id)
            )
        ).scalar_one()
        assert agent is not None
        return agent, row


async def _install(harness: Harness, agent_id: str) -> tuple[TemplateInstall, Any]:
    async with harness.session_factory() as session:
        found = await TemplateInstallStore().for_agent(session, agent_id)
        assert found is not None
        return found


async def _owner_edits_instructions(harness: Harness, agent_id: str, text: str) -> None:
    _, row = await _agent(harness, agent_id)
    async with harness.session_factory() as session:
        await session.execute(
            update(AgentDefinition)
            .where(AgentDefinition.agent_id == agent_id)
            .values(
                definition={**row.definition, "instructions": text},
                revision=row.revision + 1,
            )
        )
        await session.commit()


async def test_values_nobody_changed_follow_the_new_revision(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    agent_id = await _create_buddy(harness, client, owner, "switch-buddy-ada")
    _, before = await _agent(harness, agent_id)
    install, _ = await _install(harness, agent_id)
    new = _next_revision()

    await _updates(harness).update_install(TENANT_ZERO_ID, new, install)

    agent, row = await _agent(harness, agent_id)
    assert agent.description.startswith("Your assistant in Switch, revised.")
    assert "(revised)" in row.definition["instructions"]
    assert row.revision == before.revision + 1
    assert row.definition["provider"] == before.definition["provider"]
    install, resource = await _install(harness, agent_id)
    assert install.revision == new.version
    assert resource.notice is None


async def test_values_somebody_changed_stay_theirs_and_the_agent_is_told(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    agent_id = await _create_buddy(harness, client, owner, "switch-buddy-ada")
    await _owner_edits_instructions(harness, agent_id, "Mine, all mine.")
    install, _ = await _install(harness, agent_id)
    new = _next_revision()

    await _updates(harness).update_install(TENANT_ZERO_ID, new, install)

    agent, row = await _agent(harness, agent_id)
    assert row.definition["instructions"] == "Mine, all mine."
    assert agent.description.startswith("Your assistant in Switch, revised.")
    install, resource = await _install(harness, agent_id)
    assert install.revision == new.version
    assert resource.notice is not None
    assert "instructions" in resource.notice
    assert "get_template_status" in resource.notice


async def test_permissions_never_move_and_the_agent_is_told(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    agent_id = await _create_buddy(harness, client, owner, "switch-buddy-ada")
    install, _ = await _install(harness, agent_id)

    await _updates(harness).update_install(
        TENANT_ZERO_ID, _next_revision(can_manage_agents=False), install
    )

    agent, _ = await _agent(harness, agent_id)
    assert agent.can_manage_agents is True
    _, resource = await _install(harness, agent_id)
    assert resource.notice is not None and "can_manage_agents" in resource.notice


async def test_an_install_at_the_current_revision_is_left_alone(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    agent_id = await _create_buddy(harness, client, owner, "switch-buddy-ada")
    _, before = await _agent(harness, agent_id)

    await _updates(harness).update_installs(TENANT_ZERO_ID, _buddy())

    _, after = await _agent(harness, agent_id)
    assert after.revision == before.revision


async def test_an_agent_changed_mid_update_is_left_to_the_next_start(
    harness: Harness, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    agent_id = await _create_buddy(harness, client, owner, "switch-buddy-ada")
    install, _ = await _install(harness, agent_id)

    async def changed(*args: Any, **kwargs: Any) -> None:
        raise DefinitionChanged("changed meanwhile")

    monkeypatch.setattr(harness.management.service, "patch_managed_agent", changed)
    await _updates(harness).update_install(TENANT_ZERO_ID, _next_revision(), install)

    install, _ = await _install(harness, agent_id)
    assert install.revision == _buddy().version


async def test_two_servers_updating_at_once_update_each_agent_once(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    agent_id = await _create_buddy(harness, client, owner, "switch-buddy-ada")
    _, before = await _agent(harness, agent_id)
    install, _ = await _install(harness, agent_id)
    new = _next_revision()

    await asyncio.gather(
        _updates(harness).update_install(TENANT_ZERO_ID, new, install),
        _updates(harness).update_install(TENANT_ZERO_ID, new, install),
    )

    _, row = await _agent(harness, agent_id)
    assert "(revised)" in row.definition["instructions"]
    assert row.revision == before.revision + 1
    install, _ = await _install(harness, agent_id)
    assert install.revision == new.version


async def _forget_install(harness: Harness, agent_id: str) -> None:
    install, _ = await _install(harness, agent_id)
    async with harness.session_factory() as session:
        await session.delete(await session.get(TemplateInstall, install.id))
        await session.commit()


async def test_an_old_buddy_is_recorded_as_the_revision_it_matches(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    agent_id = await _create_buddy(harness, client, owner, "switch-buddy-ada")
    await _forget_install(harness, agent_id)

    assert await _updates(harness).record_existing_buddies(TENANT_ZERO_ID) == 1

    install, resource = await _install(harness, agent_id)
    assert (install.template_id, install.revision) == (BUDDY_ID, _buddy().version)
    assert resource.key == "buddy"
    assert (
        resource.fingerprints
        == revisions.entry_for(_OFFICIAL / "switch-buddy")["agents"]["buddy"]
    )
    assert await _updates(harness).record_existing_buddies(TENANT_ZERO_ID) == 0


async def test_an_old_buddy_somebody_changed_is_recorded_and_its_changes_kept(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    agent_id = await _create_buddy(harness, client, owner, "switch-buddy-ada")
    await _forget_install(harness, agent_id)
    await _owner_edits_instructions(harness, agent_id, "Mine, all mine.")
    await _updates(harness).record_existing_buddies(TENANT_ZERO_ID)
    install, _ = await _install(harness, agent_id)

    await _updates(harness).update_install(TENANT_ZERO_ID, _next_revision(), install)

    agent, row = await _agent(harness, agent_id)
    assert row.definition["instructions"] == "Mine, all mine."
    assert agent.description.startswith("Your assistant in Switch, revised.")


async def test_a_name_alone_does_not_make_an_agent_a_buddy(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    agent_id = await _create_buddy(harness, client, owner, "switch-buddy-ada")
    await _forget_install(harness, agent_id)
    async with harness.session_factory() as session:
        await session.execute(
            update(Agent)
            .where(Agent.id == agent_id)
            .values(description="My own thing.", icon_url=None)
        )
        await session.commit()

    assert await _updates(harness).record_existing_buddies(TENANT_ZERO_ID) == 0


async def test_an_agent_not_named_as_a_buddy_is_never_taken_for_one(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    agent_id = await _create_buddy(harness, client, owner, "my-helper")
    await _forget_install(harness, agent_id)

    assert await _updates(harness).record_existing_buddies(TENANT_ZERO_ID) == 0


async def test_the_agent_reads_how_it_differs_and_is_no_longer_told(
    harness: Harness, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    agent_id = await _create_buddy(harness, client, owner, "switch-buddy-ada")
    await _owner_edits_instructions(harness, agent_id, "Mine, all mine.")
    install, _ = await _install(harness, agent_id)
    new = _next_revision(can_manage_agents=False)
    await _updates(harness).update_install(TENANT_ZERO_ID, new, install)
    monkeypatch.setattr(template_status, "official_template", lambda *a: new)

    status = await _as(agent_id, template_status.get_template_status)

    assert status["template"] == {
        "id": BUDDY_ID,
        "name": "switch-buddy",
        "source": "official",
    }
    assert (status["installed_revision"], status["current_revision"]) == (
        new.version,
        new.version,
    )
    ((differs),) = status["differs"]
    assert differs["field"] == "instructions"
    assert differs["yours"] == "Mine, all mine."
    assert "(revised)" in differs["recommended"]
    assert status["permissions"] == [
        {"setting": "can_manage_agents", "yours": True, "recommended": False}
    ]
    _, resource = await _install(harness, agent_id)
    assert resource.notice is None


async def test_an_agent_from_no_template_has_no_status(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    agent_id = await _create_buddy(harness, client, owner, "switch-buddy-ada")
    await _forget_install(harness, agent_id)

    assert await _as(agent_id, template_status.get_template_status) == {
        "template": None
    }


async def _as(agent_id: str, fn: Any, **kwargs: Any) -> Any:
    token = set_call_context(
        CallContext(agent_id=agent_id, session_key=None, session=None)
    )
    try:
        return await fn(**kwargs)
    finally:
        reset_call_context(token)


async def test_a_managed_agent_says_which_template_made_it(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    agent_id = await _create_buddy(harness, client, owner, "switch-buddy-ada")
    await _create_buddy(harness, client, owner, "my-helper")
    await _forget_install(
        harness,
        next(
            a["agent_id"]
            for a in await _managed(harness, owner)
            if a["name"] == "my-helper"
        ),
    )

    listed = {a["name"]: a for a in await _managed(harness, owner)}

    assert listed["switch-buddy-ada"]["template"] == {
        "id": BUDDY_ID,
        "key": "buddy",
        "revision": _buddy().version,
    }
    assert listed["my-helper"]["template"] is None
    async with harness.session_factory() as session:
        one = await harness.management.service.get_managed_agent(
            session, TENANT_ZERO_ID, owner.id, agent_id
        )
    assert one["template"] == listed["switch-buddy-ada"]["template"]


async def _managed(harness: Harness, owner: User) -> list[dict[str, Any]]:
    async with harness.session_factory() as session:
        return await harness.management.service.list_managed_agents(
            session, TENANT_ZERO_ID, owner.id
        )


async def _set_install_revision(harness: Harness, agent_id: str, revision: int) -> None:
    install, _ = await _install(harness, agent_id)
    async with harness.session_factory() as session:
        await session.execute(
            update(TemplateInstall)
            .where(TemplateInstall.id == install.id)
            .values(revision=revision)
        )
        await session.commit()


async def test_a_tenant_another_server_is_updating_is_skipped(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    agent_id = await _create_buddy(harness, client, owner, "switch-buddy-ada")
    await _set_install_revision(harness, agent_id, 1)
    key = func.hashtext(f"template-updates:{TENANT_ZERO_ID}")

    async with harness.session_factory() as other_server:
        assert (
            await other_server.execute(select(func.pg_try_advisory_lock(key)))
        ).scalar()
        await _updates(harness).run([TENANT_ZERO_ID])
        install, _ = await _install(harness, agent_id)
        assert install.revision == 1
        await other_server.execute(select(func.pg_advisory_unlock(key)))

    await _updates(harness).run([TENANT_ZERO_ID])
    install, _ = await _install(harness, agent_id)
    assert install.revision == _buddy().version

    # Released after the pass: the next server takes it.
    async with harness.session_factory() as next_server:
        assert (
            await next_server.execute(select(func.pg_try_advisory_lock(key)))
        ).scalar()
        await next_server.execute(select(func.pg_advisory_unlock(key)))


async def test_only_installs_behind_the_revision_are_read(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    behind_id = await _create_buddy(harness, client, owner, "switch-buddy-ada")
    current_id = await _create_buddy(harness, client, owner, "switch-buddy-ada-2")
    await _set_install_revision(harness, behind_id, 1)

    async with harness.session_factory() as session:
        behind = await TemplateInstallStore().behind(
            session, BUDDY_ID, _buddy().version
        )

    assert [i.id for i in behind] == [(await _install(harness, behind_id))[0].id]
    assert (await _install(harness, current_id))[0].id not in [i.id for i in behind]
