"""Purging an organization at its owner's request.

Against a real database: the purge is only right if every row of every
workspace goes, foreign keys and all, while what belongs to someone else
stays. What reaches outside Switch (a messaging platform, a vendor, the other
processes) is faked, recording what it was asked to do.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts import organization_purge
from switch_core.accounts.organization_purge import OrganizationPurge, PurgeRefused
from switch_core.bridges.collaboration.install import MessagingInstallerRegistry
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import (
    AuditEvent,
    Client,
    CloudMachine,
    MachineWorkspace,
    Message,
    MessagingInstall,
    OidcIdentity,
    Organization,
    OrganizationAuditEvent,
    OrganizationMember,
    Room,
    ServerAuditEvent,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.message_store import MessageStore
from switch_core.keys import Keyring
from tests.switch_core.accounts.test_account_deletion import ADMIN_EMAIL, _agent
from tests.switch_core.hosted_machine_helpers import add_workspace, seed_machine

KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)


class _Installer:
    platform = "slack"
    installs_by_claim = False

    def __init__(self) -> None:
        self.revoked: list[str] = []
        self.released: list[str] = []

    async def revoke(self, *, bot_token: str) -> None:
        self.revoked.append(bot_token)

    async def release(self, *, external_workspace_id: str) -> None:
        self.released.append(external_workspace_id)


class _Broker:
    def __init__(self) -> None:
        self.removed: list[str] = []

    async def remove_connections(self, _session: AsyncSession, user_id: str) -> list:
        self.removed.append(user_id)
        return []

    async def finish_disconnect(self, *_args: Any) -> None:
        return None

    async def revoke_pending(self, *_args: Any) -> bool:
        return False


class _Signals:
    def __init__(self) -> None:
        self.published: list[tuple[str, dict[str, Any]]] = []

    def publish(self, kind: str, **fields: Any) -> None:
        self.published.append((kind, fields))


def _purge(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[OrganizationPurge, _Installer, _Signals]:
    installer = _Installer()
    installers = MessagingInstallerRegistry()
    installers.register(installer)  # type: ignore[arg-type]
    signals = _Signals()
    purge = OrganizationPurge(
        session_factory=session_factory,
        broker=_Broker(),
        installers=installers,
        keyring=KEYRING,
        signals=signals,  # type: ignore[arg-type]
        controller_removed=lambda controller_id: signals.publish(
            "controller.revoked", controller_id=controller_id
        ),
        admin_email=ADMIN_EMAIL,
    )
    return purge, installer, signals


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _organization(
    session_factory: async_sessionmaker[AsyncSession], workspaces: int
) -> tuple[str, list[str]]:
    organization_id = _id("org")
    tenant_ids = [_id("ws") for _ in range(workspaces)]
    async with session_factory() as session:
        session.add(
            Organization(
                id=organization_id,
                slug=organization_id,
                name="Acme",
                workos_organization_id=f"org_{organization_id}",
            )
        )
        await session.flush()
        for tenant_id in tenant_ids:
            session.add(
                Tenant(
                    id=tenant_id,
                    slug=tenant_id,
                    name=tenant_id,
                    organization_id=organization_id,
                )
            )
        await session.commit()
    return organization_id, tenant_ids


async def _person(
    session_factory: async_sessionmaker[AsyncSession],
    name: str,
    workspaces: list[str],
    organization_id: str | None,
) -> str:
    async with session_factory() as session:
        user = User(name=name, email=f"{name}@example.test", role="user")
        session.add(user)
        await session.flush()
        session.add(
            OidcIdentity(user_id=user.id, iss="https://auth.test", sub=f"user_{name}")
        )
        if organization_id is not None:
            session.add(
                OrganizationMember(
                    organization_id=organization_id, user_id=user.id, role="member"
                )
            )
        for tenant_id in workspaces:
            session.add(
                TenantMember(tenant_id=tenant_id, user_id=user.id, role="admin")
            )
        await session.commit()
        return user.id


async def _fill(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str, owner_id: str
) -> None:
    """A room with a message, an agent, a live Slack install and some
    history, as a workspace in use has."""
    async with tenant_session(session_factory, tenant_id) as session:
        owner = await session.get(User, owner_id)
        assert owner is not None
        await _agent(session, tenant_id, owner, "helper")
        sender = Client(
            transport_user_id=f"@switch-member-{owner_id}-{tenant_id}:test",
            display_name="owner",
            type="member",
            user_id=owner_id,
        )
        room = Room(
            transport_room_id=f"!{uuid.uuid4().hex}:test", name="Chat", description=""
        )
        session.add_all([sender, room])
        await session.flush()
        await MessageStore().create(
            session,
            Message(
                room_id=room.id,
                transport_event_id=f"${uuid.uuid4().hex}",
                sender_id=sender.transport_user_id,
                sender_client_id=sender.id,
                sender_name="owner",
                event_type="m.room.message",
                content={"body": "secret plans", "sender_name": "owner"},
            ),
            [],
        )
        session.add(
            MessagingInstall(
                platform="slack",
                external_workspace_id=f"T-{tenant_id}",
                scopes="chat:write",
                status="active",
                installed_by_user_id=owner_id,
                encrypted_bot_token=KEYRING.encrypt(f"xoxb-{tenant_id}"),
            )
        )
        await record_audit_event(
            session,
            tenant_id=tenant_id,
            actor_user_id=owner_id,
            action=AuditAction.API_KEY_CREATED,
            target_type="api_key",
            target_id="k",
            details=None,
        )
        await session.commit()


async def _count(
    session_factory: async_sessionmaker[AsyncSession], model: Any, *where: Any
) -> int:
    async with session_factory() as session:
        return (
            await session.scalar(select(func.count()).select_from(model).where(*where))
            or 0
        )


async def test_the_plan_names_what_goes_and_who_stays_and_changes_nothing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    organization_id, (first, second) = await _organization(session_factory, 2)
    _, (elsewhere,) = await _organization(session_factory, 1)
    alice = await _person(session_factory, "alice", [first, second], organization_id)
    bob = await _person(session_factory, "bob", [first, elsewhere], organization_id)
    await _fill(session_factory, first, alice)
    purge, installer, _ = _purge(session_factory)

    plan = await purge.plan(await purge.find(organization_id))

    assert plan.refusals == []
    assert [workspace.id for workspace in plan.workspaces] == sorted([first, second])
    rows = next(w for w in plan.workspaces if w.id == first).rows
    assert rows["messages"] == 1 and rows["agents"] == 1 and rows["rooms"] == 1
    assert [account.id for account in plan.deleted_accounts] == [alice]
    (kept,) = [account for account in plan.accounts if account.id == bob]
    assert kept.kept_because == "a member of another workspace"
    assert installer.revoked == []
    assert await _count(session_factory, Tenant, Tenant.id == first) == 1


async def test_found_by_slug_or_workos_id(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    organization_id, _ = await _organization(session_factory, 1)
    purge, _, _ = _purge(session_factory)
    assert await purge.find(organization_id) == organization_id
    assert await purge.find(f"org_{organization_id}") == organization_id
    try:
        await purge.find("nobody")
    except PurgeRefused as refused:
        assert "nobody" in str(refused)
    else:
        raise AssertionError("an unknown organization was found")


async def test_a_purge_deletes_everything_and_withdraws_it_outside_first(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    organization_id, (first, second) = await _organization(session_factory, 2)
    _, (elsewhere,) = await _organization(session_factory, 1)
    alice = await _person(session_factory, "alice", [first, second], organization_id)
    bob = await _person(session_factory, "bob", [first, elsewhere], organization_id)
    await _fill(session_factory, first, alice)
    await _fill(session_factory, elsewhere, bob)
    purge, installer, signals = _purge(session_factory)

    plan = await purge.plan(organization_id)
    outcome = await purge.run(plan, "TICKET-1")

    assert outcome.finished and outcome.failed_accounts == []
    assert [account.id for account in outcome.deleted_accounts] == [alice]
    assert installer.revoked == [f"xoxb-{first}"]
    for tenant_id in (first, second):
        assert await _count(session_factory, Tenant, Tenant.id == tenant_id) == 0
        assert (
            await _count(session_factory, Message, Message.tenant_id == tenant_id) == 0
        )
        assert await _count(session_factory, Room, Room.tenant_id == tenant_id) == 0
    assert (
        await _count(session_factory, Organization, Organization.id == organization_id)
        == 0
    )
    assert (
        await _count(
            session_factory,
            OrganizationAuditEvent,
            OrganizationAuditEvent.organization_id == organization_id,
        )
        == 0
    )
    assert await _count(session_factory, User, User.id == alice) == 0
    assert (
        await _count(session_factory, OidcIdentity, OidcIdentity.user_id == alice) == 0
    )

    # Bob, and the workspace he has outside the organization, are untouched.
    assert await _count(session_factory, User, User.id == bob) == 1
    assert await _count(session_factory, Message, Message.tenant_id == elsewhere) == 1
    assert await _count(session_factory, TenantMember, TenantMember.user_id == bob) == 1

    # The workspace's history stays for the retention pass; the server's log
    # records each workspace, the organization and the account.
    assert await _count(session_factory, AuditEvent, AuditEvent.tenant_id == first) == 2
    actions = sorted(
        (await _server_audit(session_factory)).values(), key=lambda pair: pair[0]
    )
    assert [action for action, _ in actions] == [
        "organization.purge_started",
        "organization.purged",
        "user.deleted",
        "workspace.deleted",
        "workspace.deleted",
    ]
    assert all("TICKET-1" in str(details) for _, details in actions), (
        "every record names the request"
    )
    (started,) = [details for action, details in actions if action.endswith("started")]
    assert started["accounts_to_delete"] == [alice]

    kinds = [kind for kind, _ in signals.published]
    assert kinds.count("client.changed") == 2
    # The agent's connections close and its cached keys go in every process.
    (ended,) = [
        fields
        for kind, fields in signals.published
        if kind == "agent_connections.changed"
    ]
    assert ended["tenant_id"] == first and ended["ending"] == "deleted"


async def _server_audit(
    session_factory: async_sessionmaker[AsyncSession],
) -> dict[str, tuple[str, Any]]:
    async with session_factory() as session:
        return {
            event.id: (event.action, event.details)
            for event in await session.scalars(select(ServerAuditEvent))
        }


async def test_a_cloud_machine_is_torn_down_before_anything_is_deleted(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    organization_id, (workspace,) = await _organization(session_factory, 1)
    alice = await _person(session_factory, "alice", [workspace], organization_id)
    async with tenant_session(session_factory, workspace) as session:
        machine = await seed_machine(
            session,
            owner_id=alice,
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=3,
        )
        await session.commit()
        machine_id = machine.id
    await _fill(session_factory, workspace, alice)
    purge, installer, _ = _purge(session_factory)

    plan = await purge.plan(organization_id)
    assert plan.machines == [machine_id]
    first = await purge.run(plan, "TICKET-2")

    assert not first.finished
    assert any(machine_id in waiting for waiting in first.waiting)
    # The Slack install keeps its token while the purge waits, so its bridge
    # is never left running on a revoked one.
    assert installer.revoked == []
    assert await _server_audit(session_factory) == {}
    async with session_factory() as session:
        machine = await session.get(CloudMachine, machine_id)
        assert machine is not None
        assert machine.desired_state == "deleted" and machine.revision == 4
        # The hosted controller terminates it.
        machine.state = "deleted"
        await session.commit()
    assert await _count(session_factory, Tenant, Tenant.id == workspace) == 1

    second = await purge.run(await purge.plan(organization_id), "TICKET-2")

    assert second.finished
    assert installer.revoked == [f"xoxb-{workspace}"]
    assert await _count(session_factory, Tenant, Tenant.id == workspace) == 0
    assert (
        await _count(session_factory, CloudMachine, CloudMachine.id == machine_id) == 0
    )
    assert await _count(session_factory, User, User.id == alice) == 0


async def test_a_kept_accounts_machine_only_loses_the_organizations_workspaces(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    organization_id, (workspace,) = await _organization(session_factory, 1)
    _, (elsewhere,) = await _organization(session_factory, 1)
    owner = await _person(session_factory, "owner", [workspace, elsewhere], None)
    async with tenant_session(session_factory, workspace) as session:
        machine = await seed_machine(
            session,
            owner_id=owner,
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
        )
        await session.commit()
        machine_id = machine.id
    async with tenant_session(session_factory, elsewhere) as session:
        machine = await session.get(CloudMachine, machine_id)
        assert machine is not None
        await add_workspace(session, machine, created_at=machine.created_at)
        await session.commit()
    purge, _, _ = _purge(session_factory)

    plan = await purge.plan(organization_id)
    assert plan.refusals == [] and plan.machines == []
    assert plan.detached_machines == [machine_id]
    outcome = await purge.run(plan, "TICKET-3")

    assert outcome.finished
    assert await _count(session_factory, Tenant, Tenant.id == workspace) == 0
    async with session_factory() as session:
        machine = await session.get(CloudMachine, machine_id)
        assert machine is not None
        assert machine.desired_state == "running" and machine.revision == 2
    assert (
        await _count(
            session_factory,
            MachineWorkspace,
            MachineWorkspace.machine_id == machine_id,
        )
        == 1
    ), "it still serves the workspace outside the organization"


async def test_an_account_found_only_through_a_deleted_workspace_survives_a_failed_run(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Carol was only in the workspace purged first, never in the
    organization itself: once it is gone, only the run's record finds her."""
    organization_id, workspaces = await _organization(session_factory, 2)
    # The purge goes through workspaces in id order.
    first, second = sorted(workspaces)
    carol = await _person(session_factory, "carol", [first], None)
    purge, _, _ = _purge(session_factory)
    real = organization_purge.purge_workspace

    async def failing_on(session: AsyncSession, tenant_id: str, request: str) -> list:
        if tenant_id == second:
            raise RuntimeError("lock timeout")
        return await real(session, tenant_id, request)

    monkeypatch.setattr(organization_purge, "purge_workspace", failing_on)
    with pytest.raises(RuntimeError):
        await purge.run(await purge.plan(organization_id), "TICKET-4")
    assert await _count(session_factory, Tenant, Tenant.id == first) == 0
    assert await _count(session_factory, User, User.id == carol) == 1

    monkeypatch.setattr(organization_purge, "purge_workspace", real)
    plan = await purge.plan(organization_id)
    assert [account.id for account in plan.deleted_accounts] == [carol]
    outcome = await purge.run(plan, "TICKET-4")

    assert outcome.finished
    assert await _count(session_factory, User, User.id == carol) == 0


async def test_a_failed_account_is_recorded_and_retried_after_the_organization_went(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    organization_id, (workspace,) = await _organization(session_factory, 1)
    dave = await _person(session_factory, "dave", [workspace], organization_id)
    purge, _, _ = _purge(session_factory)
    real = organization_purge.delete_account_rows

    async def failing(*_args: Any) -> None:
        raise RuntimeError("admin account missing")

    monkeypatch.setattr(organization_purge, "delete_account_rows", failing)
    outcome = await purge.run(await purge.plan(organization_id), "TICKET-5")

    assert outcome.finished
    assert [account.id for account, _ in outcome.failed_accounts] == [dave]
    actions = [action for action, _ in (await _server_audit(session_factory)).values()]
    assert "user.deletion_failed" in actions and "user.deleted" not in actions
    assert (
        await _count(session_factory, Organization, Organization.id == organization_id)
        == 0
    )

    monkeypatch.setattr(organization_purge, "delete_account_rows", real)
    # Found again by its slug and its WorkOS id, from the run's record.
    assert await purge.find(organization_id) == organization_id
    assert await purge.find(f"org_{organization_id}") == organization_id
    plan = await purge.plan(organization_id)
    assert plan.resuming and plan.workspaces == []
    retried = await purge.run(plan, "TICKET-5")

    assert retried.finished
    assert [account.id for account in retried.deleted_accounts] == [dave]
    assert await _count(session_factory, User, User.id == dave) == 0


@pytest.mark.parametrize(("backend", "revoked"), [("box", True), ("vm", False)])
async def test_tearing_down_a_box_machine_revokes_its_controller(
    session_factory: async_sessionmaker[AsyncSession], backend: str, revoked: bool
) -> None:
    """A hosted agents v2 box keeps its disk, which holds its controller
    credential: tearing its machine down revokes the controller at once, and
    every process is told. A v1 machine is torn down as before."""
    import dataclasses

    from tests.switch_core.hosted_machine_helpers import link_controller

    organization_id, (workspace,) = await _organization(session_factory, 1)
    alice = await _person(session_factory, "alice", [workspace], organization_id)
    async with tenant_session(session_factory, workspace) as session:
        machine = await seed_machine(
            session,
            owner_id=alice,
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=3,
        )
        machine.backend = backend
        controller = await link_controller(session, machine)
        await session.commit()
        controller_id = controller.id
    calls: list[tuple[str, str]] = []

    async def revoke(_session: AsyncSession, tenant_id: str, cid: str) -> None:
        calls.append((tenant_id, cid))

    purge, _installer, signals = _purge(session_factory)
    purge = dataclasses.replace(purge, revoke_box_controller=revoke)

    first = await purge.run(await purge.plan(organization_id), "TICKET-3")
    assert not first.finished  # still waits on the teardown, as before
    removed = [
        data["controller_id"]
        for name, data in signals.published
        if name == "controller.revoked"
    ]
    if revoked:
        assert calls == [(workspace, controller_id)]
        assert removed == [controller_id]
    else:
        assert calls == []
        assert removed == []

    # A second run while it waits doesn't revoke it again.
    await purge.run(await purge.plan(organization_id), "TICKET-3")
    assert len(calls) == (1 if revoked else 0)


async def test_a_box_revoke_that_fails_never_stops_a_purge(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The revoke is extra care: if it fails, the purge goes on as before,
    and the workspace's rows, the credential among them, still go later."""
    import dataclasses
    import logging

    from tests.switch_core.hosted_machine_helpers import link_controller

    organization_id, (workspace,) = await _organization(session_factory, 1)
    alice = await _person(session_factory, "alice", [workspace], organization_id)
    async with tenant_session(session_factory, workspace) as session:
        machine = await seed_machine(
            session,
            owner_id=alice,
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=3,
        )
        machine.backend = "box"
        await link_controller(session, machine)
        await session.commit()
        machine_id = machine.id

    async def revoke(*_args: Any) -> None:
        raise RuntimeError("token tok-secret broke")

    purge, _installer, signals = _purge(session_factory)
    purge = dataclasses.replace(purge, revoke_box_controller=revoke)
    caplog.set_level(logging.ERROR, logger="switch_core.accounts.organization_purge")

    first = await purge.run(await purge.plan(organization_id), "TICKET-5")

    assert not first.finished  # waits on the teardown, as before
    assert any(machine_id in waiting for waiting in first.waiting)
    assert not [n for n, _ in signals.published if n == "controller.revoked"]
    (line,) = [r for r in caplog.records if "box controllers" in r.getMessage()]
    assert "secret" not in line.getMessage() and "(RuntimeError)" in line.getMessage()


@pytest.mark.parametrize("backend", ["box", "vm"])
async def test_a_purge_with_a_box_machine_finishes_once_its_box_is_at_zero(
    session_factory: async_sessionmaker[AsyncSession], backend: str
) -> None:
    """A box is never deleted by the scaler, only scaled to 0 and reported
    `stopped`, which Core counts as deleted: the purge then finishes, and a
    durable entry naming the box's disk for removal outlives it. A v1
    machine's `stopped` is not its deletion, and it writes no entry."""
    from switch_core.db.audit import ServerAuditAction
    from switch_core.db.models import ServerAuditEvent
    from switch_core.gateway.hosted_controller import Observation, observe

    organization_id, (workspace,) = await _organization(session_factory, 1)
    alice = await _person(session_factory, "alice", [workspace], organization_id)
    async with tenant_session(session_factory, workspace) as session:
        machine = await seed_machine(
            session,
            owner_id=alice,
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=3,
        )
        machine.backend = backend
        await session.commit()
        machine_id = machine.id
    purge, _installer, _ = _purge(session_factory)

    first = await purge.run(await purge.plan(organization_id), "TICKET-4")
    assert not first.finished
    # The controller's `stopped` report, as the box scaler sends it at 0.
    async with session_factory() as session:
        wanted = await session.get(CloudMachine, machine_id)
        assert wanted is not None and wanted.desired_state == "deleted"
        revision = wanted.revision
    async with session_factory() as session:
        await observe(
            machine_id,
            Observation(state="stopped", revision=revision),
            session,
            session_factory,
        )

    second = await purge.run(await purge.plan(organization_id), "TICKET-4")
    entries = await _count(
        session_factory,
        ServerAuditEvent,
        ServerAuditEvent.action == ServerAuditAction.HOSTED_BOX_TO_REMOVE,
    )
    purged = [
        details
        for action, details in (await _server_audit(session_factory)).values()
        if action == ServerAuditAction.ORGANIZATION_PURGED
    ]
    if backend == "box":
        assert second.finished
        assert await _count(session_factory, Tenant, Tenant.id == workspace) == 0
        assert entries == 1  # once for the box, and it outlives the purge
        # Finished, but never silently: the disk left behind is counted.
        assert second.warnings == [
            "1 box disk(s) await manual removal, listed in the operator audit "
            "log as hosted.box_to_remove."
        ]
        [details] = purged
        assert details["boxes_awaiting_removal"] == 1
    else:
        assert not second.finished  # waits for its real `deleted` report
        assert entries == 0
        assert purged == []
