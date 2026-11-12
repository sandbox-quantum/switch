"""Purging an organization at its owner's request.

Against a real database: the purge is only right if every row of every
workspace goes, foreign keys and all, while what belongs to someone else
stays. What reaches outside Switch (a messaging platform, a vendor, the other
processes) is faked, recording what it was asked to do.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts import organization_purge
from switch_core.accounts.organization_purge import OrganizationPurge, PurgeRefused
from switch_core.accounts.purge_elsewhere import PurgeElsewhere
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
from switch_core.gateway.hosted_controller import machine_item
from switch_core.keys import Keyring
from switch_core.trust.client import HttpTrustClient
from tests.switch_core.accounts.test_account_deletion import ADMIN_EMAIL, _agent
from tests.switch_core.accounts.test_workos_offboarding import FakeWorkOS
from tests.switch_core.hosted_machine_helpers import add_workspace, seed_machine

KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)
ISSUER = "https://auth.test"


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
        sign_in_issuer=ISSUER,
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
        session.add(OidcIdentity(user_id=user.id, iss=ISSUER, sub=f"user_{name}"))
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


async def test_a_machine_in_retention_loses_its_disk_now_not_when_retention_ends(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    organization_id, (workspace,) = await _organization(session_factory, 1)
    alice = await _person(session_factory, "alice", [workspace], organization_id)
    later = datetime.now(UTC) + timedelta(days=7)
    async with tenant_session(session_factory, workspace) as session:
        retained = await seed_machine(
            session,
            owner_id=alice,
            state="retained",
            desired_state="retained",
            stop_reason=None,
            revision=5,
        )
        retained.retain_until = later
        await session.commit()
        machine_id = retained.id
    purge, _, _ = _purge(session_factory)

    first = await purge.run(await purge.plan(organization_id), "TICKET-6")

    assert not first.finished
    async with session_factory() as session:
        machine = await session.get(CloudMachine, machine_id)
        assert machine is not None
        assert machine.desired_state == "deleted" and machine.revision == 6
        # What the hosted controller is sent: deleted, with the disk's
        # retention already over, so it deletes the volume at once.
        item = machine_item(machine)
        assert item["desired_state"] == "deleted"
        assert datetime.fromisoformat(item["retain_until"]) <= datetime.now(UTC)
        # The controller reports deleted once the volume is gone.
        machine.state = "deleted"
        await session.commit()

    plan = await purge.plan(organization_id)
    assert plan.removed_machines == [machine_id]
    assert (await purge.run(plan, "TICKET-6")).finished


async def test_a_machine_already_set_to_be_deleted_has_its_retention_ended(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A machine an earlier run set to be deleted, keeping its disk's
    retention date: the controller never brings that date forward on its
    own, so it is brought forward in a new revision."""
    organization_id, (workspace,) = await _organization(session_factory, 1)
    alice = await _person(session_factory, "alice", [workspace], organization_id)
    async with tenant_session(session_factory, workspace) as session:
        machine = await seed_machine(
            session,
            owner_id=alice,
            state="deleting",
            desired_state="deleted",
            stop_reason=None,
            revision=2,
        )
        machine.retain_until = datetime.now(UTC) + timedelta(days=30)
        await session.commit()
        machine_id = machine.id
    purge, _, _ = _purge(session_factory)

    await purge.run(await purge.plan(organization_id), "TICKET-7")
    await purge.run(await purge.plan(organization_id), "TICKET-7")

    async with session_factory() as session:
        machine = await session.get(CloudMachine, machine_id)
        assert machine is not None
        assert machine.retain_until is not None
        assert machine.retain_until <= datetime.now(UTC)
        assert machine.revision == 3, "only the first run needed a new revision"


class _Trust:
    """Switch Trust's provisional deletion endpoint, faked."""

    def __init__(self) -> None:
        self.deleted: list[str] = []
        self.fail_once: set[str] = set()

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.method == "DELETE"
        assert request.headers["x-flintai-api-key"] == "trust-key"
        session_id = request.url.path.removeprefix("/guardrails/sessions/")
        if session_id in self.fail_once:
            self.fail_once.discard(session_id)
            return httpx.Response(503)
        if session_id in self.deleted:
            return httpx.Response(404)
        self.deleted.append(session_id)
        return httpx.Response(204)

    def client(self) -> HttpTrustClient:
        return HttpTrustClient(
            base_url="https://trust.test",
            api_key="trust-key",
            policy_id="pol_1",
            timeout_seconds=1.0,
            client=httpx.AsyncClient(transport=httpx.MockTransport(self.handler)),
        )


def _elsewhere(
    session_factory: async_sessionmaker[AsyncSession],
    workos: FakeWorkOS | None,
    trust: _Trust | None,
) -> PurgeElsewhere:
    async def eraser() -> HttpTrustClient | None:
        return None if trust is None else trust.client()

    return PurgeElsewhere(
        session_factory=session_factory,
        workos=None if workos is None else workos.client(),
        trust=eraser,
        sign_in_issuer=ISSUER,
    )


async def _room_ids(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> list[str]:
    async with tenant_session(session_factory, tenant_id) as session:
        return list(
            await session.scalars(select(Room.id).where(Room.tenant_id == tenant_id))
        )


async def test_after_the_purge_workos_and_switch_trust_are_cleaned_and_recorded(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    organization_id, (first, second) = await _organization(session_factory, 2)
    _, (elsewhere_ws,) = await _organization(session_factory, 1)
    alice = await _person(session_factory, "alice", [first, second], organization_id)
    await _person(session_factory, "bob", [first, elsewhere_ws], organization_id)
    await _fill(session_factory, first, alice)
    await _fill(session_factory, second, alice)
    rooms = sorted(
        await _room_ids(session_factory, first)
        + await _room_ids(session_factory, second)
    )
    workos_org = f"org_{organization_id}"
    workos = FakeWorkOS()
    workos.member("om_alice", "user_alice", workos_org)
    workos.member("om_bob", "user_bob", workos_org)
    trust = _Trust()
    purge, _, _ = _purge(session_factory)
    elsewhere = _elsewhere(session_factory, workos, trust)

    plan = await purge.plan(organization_id)
    assert plan.workos_users == {
        "user_alice": alice,
        "user_bob": plan.workos_users["user_bob"],
    }
    assert plan.trust_sessions == rooms
    preview = await elsewhere.plan_workos(plan)
    assert preview is not None and preview.users_deleted == ["user_alice"]
    assert workos.deleted == []

    assert (await purge.run(plan, "TICKET-8")).finished
    outcome = await elsewhere.run(plan, "TICKET-8")

    assert not outcome.failed and not outcome.left_by_hand
    assert outcome.workos is not None
    # Alice's account went, and nothing else has her user; Bob keeps his
    # account, so only his membership goes.
    assert outcome.workos.users_deleted == ["user_alice"]
    assert outcome.workos.users_kept == {"user_bob": "Switch still uses this user"}
    assert "user_bob" in workos.users and workos.memberships == {}
    assert outcome.workos.organization_deleted
    assert sorted(trust.deleted) == rooms and outcome.trust_deleted == len(rooms)

    records = {
        action: details
        for action, details in (await _server_audit(session_factory)).values()
    }
    assert records["organization.purge_workos"]["users_deleted"] == ["user_alice"]
    assert records["organization.purge_workos"]["organization_deleted"] is True
    assert records["organization.purge_trust"]["sessions_deleted"] == len(rooms)
    assert records["organization.purge_trust"]["request"] == "TICKET-8"
    assert records["organization.purge_started"]["trust_sessions"] == rooms


async def test_a_resumed_purge_still_cleans_what_deleted_workspaces_left_outside(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The first workspace is deleted, then the run fails. The rerun finds
    its rooms and its people's WorkOS users only in the run's record, and a
    Switch Trust deletion that fails is retried by the run after."""
    organization_id, workspaces = await _organization(session_factory, 2)
    first, second = sorted(workspaces)
    carol = await _person(session_factory, "carol", [first], None)
    await _fill(session_factory, first, carol)
    rooms = await _room_ids(session_factory, first)
    workos = FakeWorkOS()
    workos.users.add("user_carol")
    trust = _Trust()
    trust.fail_once.update(rooms)
    purge, _, _ = _purge(session_factory)
    elsewhere = _elsewhere(session_factory, workos, trust)
    real = organization_purge.purge_workspace

    async def failing_on(session: AsyncSession, tenant_id: str, request: str) -> list:
        if tenant_id == second:
            raise RuntimeError("lock timeout")
        return await real(session, tenant_id, request)

    monkeypatch.setattr(organization_purge, "purge_workspace", failing_on)
    with pytest.raises(RuntimeError):
        await purge.run(await purge.plan(organization_id), "TICKET-9")
    monkeypatch.setattr(organization_purge, "purge_workspace", real)

    plan = await purge.plan(organization_id)
    assert plan.trust_sessions == rooms
    assert plan.workos_users == {"user_carol": carol}
    assert (await purge.run(plan, "TICKET-9")).finished
    failed = await elsewhere.run(plan, "TICKET-9")

    assert failed.failed and [s for s, _ in failed.trust_failed] == rooms
    assert failed.workos is not None and failed.workos.users_deleted == ["user_carol"]

    again = await elsewhere.run(await purge.plan(organization_id), "TICKET-9")

    assert not again.failed
    assert trust.deleted == rooms and again.trust_deleted == len(rooms)


async def test_without_a_workos_key_the_purge_lists_what_is_left_there(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    organization_id, (workspace,) = await _organization(session_factory, 1)
    await _person(session_factory, "dave", [workspace], organization_id)
    purge, _, _ = _purge(session_factory)
    elsewhere = _elsewhere(session_factory, None, None)

    plan = await purge.plan(organization_id)
    assert (await purge.run(plan, "TICKET-10")).finished
    outcome = await elsewhere.run(plan, "TICKET-10")

    assert outcome.workos is None and outcome.left_by_hand
    assert outcome.workos_leftover is not None
    assert outcome.workos_leftover.organization == f"org_{organization_id}"
    assert outcome.workos_leftover.users == ["user_dave"]
    assert not outcome.trust_configured and not outcome.failed
    records = {
        action: details
        for action, details in (await _server_audit(session_factory)).values()
    }
    assert records["organization.purge_workos"]["configured"] is False
    assert records["organization.purge_workos"]["left_by_hand"] is True
    assert records["organization.purge_trust"]["configured"] is False
