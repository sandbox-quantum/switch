"""`switch-accounts`: the deployment's accounts, for the platform operator
(`operator_commands.py`).

- `list [--operators]` prints every account, or only the platform operators.
- `create EMAIL --name NAME [--operator]` adds an account in no workspace,
  as an invitation or a domain join then places it. Its password is read
  from `--password-file` or standard input, never from the command line.
- `delete EMAIL [--execute [--yes]]` deletes an account through the account
  deletion the dashboard uses (`accounts/deletion.py`), with its refusals.
  It first shows what is connected to the account, as that deletion finds it.
  It also refuses while the account owns agents, devices or open chats: only
  a running server can stop and remove those, so they go first, from the
  dashboard or Switch Console. Without `--execute` it only says what would
  happen; with it, the operator types the account's e-mail to confirm, unless
  `--yes` is given. Either way it looks again just before deleting, and
  deletes nothing if the account has changed since it was shown.
- `sign-out EMAIL` ends every session the account holds.
- `grant-operator EMAIL` and `revoke-operator EMAIL` make an account a
  platform operator, or a regular account again. The account at
  GATEWAY_ADMIN_EMAIL stays an operator, and the server keeps at least one.

Each change is recorded in the server's audit log, with no actor and
`PLATFORM_OPERATOR_COMMAND` set.
"""

from __future__ import annotations

import argparse
import getpass
import sys
import textwrap
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.deletion import (
    AccountDeletion,
    AccountDeletionIncomplete,
    AccountDeletionRefused,
    Held,
    Named,
    Workspace,
    WorkspacePreview,
)
from switch_core.bridges.agent.registration_bootstrap import is_bootstrap_owner
from switch_core.bridges.resource.service import ResourceService
from switch_core.clients.client_signals import CLIENT_CHANGED_SIGNAL
from switch_core.config import SwitchConfig
from switch_core.connections.organization_apps import OrganizationApps
from switch_core.connections.registry import ClientRegistration
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.audit import (
    PLATFORM_OPERATOR_COMMAND,
    ServerAuditAction,
    record_server_audit_event,
)
from switch_core.db.models import User
from switch_core.db.runtime_role import RuntimeRoleError
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.organization_app_credential_store import (
    OrganizationAppCredentialStore,
)
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.template_store import TemplateStore
from switch_core.db.stores.user_store import UserStore, email_taken
from switch_core.gateway.auth import hash_password_off_loop, list_held_memberships
from switch_core.gateway.schemas import Email, Password
from switch_core.main import build_connector_apps, build_service_broker
from switch_core.operator_commands import (
    CommandRefused,
    account_by_email,
    admin_notices,
    database,
    run,
    signals,
)
from switch_core.outbound import guarded_async_client
from switch_core.signals import SignalBus
from switch_core.tenant_context import no_tenant

OPERATOR_ROLE = "admin"
REGULAR_ROLE = "user"


def _by_command() -> dict[str, bool]:
    return {PLATFORM_OPERATOR_COMMAND: True}


# ── list ──────────────────────────────────────────────────────────────────────


async def list_accounts(
    session_factory: async_sessionmaker[AsyncSession], *, operators: bool
) -> list[User]:
    """Every account, or only the platform operators, by e-mail."""
    query = select(User).order_by(User.email, User.id)
    if operators:
        query = query.where(User.role == OPERATOR_ROLE)
    with no_tenant():
        async with session_factory() as session:
            return list(await session.scalars(query))


def print_accounts(users: list[User]) -> None:
    for user in users:
        role = "platform operator" if user.role == OPERATOR_ROLE else "-"
        print(f"{user.id}\t{user.email}\t{user.name}\t{role}\t{user.created_at}")
    print(f"{len(users)} account(s)")


# ── create ────────────────────────────────────────────────────────────────────


async def create_account(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    email: str,
    name: str,
    password: str,
    operator: bool,
) -> User:
    """Add an account in no workspace and no organization. Refuses an e-mail
    an account already has, whatever its case."""
    try:
        email = TypeAdapter(Email).validate_python(email)
    except ValidationError:
        raise CommandRefused(f"{email!r} is not an e-mail address.") from None
    try:
        password = TypeAdapter(Password).validate_python(password)
    except ValidationError as error:
        problems = "; ".join(
            str(problem["msg"]) for problem in error.errors(include_input=False)
        )
        raise CommandRefused(f"That password won't do: {problems}") from None
    name = " ".join(name.split())
    if not name or len(name) > 255:
        raise CommandRefused("--name must be 1 to 255 characters.")
    user_store = UserStore()
    with no_tenant():
        async with session_factory() as session:
            if await user_store.get_by_email(session, email) is not None:
                raise CommandRefused(f"An account already has the email {email}.")
            # Not held across bcrypt.
            await session.commit()
            user = User(
                name=name,
                email=email,
                role=OPERATOR_ROLE if operator else REGULAR_ROLE,
                password_hash=await hash_password_off_loop(password),
            )
            session.add(user)
            try:
                await session.flush()
            except IntegrityError as error:
                if not email_taken(error):
                    raise
                raise CommandRefused(
                    f"An account already has the email {email}."
                ) from None
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.USER_CREATED,
                target_type="user",
                target_id=user.id,
                details={"role": user.role, **_by_command()},
            )
            await session.commit()
            return user


def read_password(password_file: Path | None) -> str:
    """The password, from `password_file` or standard input: asked for twice
    on a terminal, read whole from a pipe. One line ending is dropped."""
    if password_file is not None:
        return _one_line_ending_off(password_file.read_text())
    if sys.stdin.isatty():
        first = getpass.getpass("Password: ")
        if getpass.getpass("Again: ") != first:
            raise CommandRefused("The two passwords differ.")
        return first
    return _one_line_ending_off(sys.stdin.read())


def _one_line_ending_off(text: str) -> str:
    return text.removesuffix("\n").removesuffix("\r")


# ── sign-out ──────────────────────────────────────────────────────────────────


async def sign_out(
    session_factory: async_sessionmaker[AsyncSession], email: str
) -> User:
    """End every session the account holds, as "Sign out of all devices"
    does: the session version moves on, so every cookie it had is refused."""
    user_store = UserStore()
    with no_tenant():
        async with session_factory() as session:
            user = await user_store.get_by_email(session, email)
            if user is None:
                raise CommandRefused(f"No account has the email {email}.")
            await user_store.end_sessions(session, user.id)
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.USER_SESSIONS_ENDED,
                target_type="user",
                target_id=user.id,
                details=_by_command(),
            )
            await session.commit()
            return user


# ── grant-operator, revoke-operator ───────────────────────────────────────────


async def _lock_operators(session: AsyncSession) -> set[str]:
    """The platform operators' ids, their rows locked to the end of the
    transaction, in id order so two callers lock them alike."""
    return set(
        await session.scalars(
            select(User.id)
            .where(User.role == OPERATOR_ROLE)
            .order_by(User.id)
            .with_for_update()
        )
    )


async def grant_operator(
    session_factory: async_sessionmaker[AsyncSession], email: str
) -> User:
    """Make the account a platform operator, who administers every
    workspace. Never the agent-registration service account, whose agents
    would act with that power."""
    with no_tenant():
        async with session_factory() as session:
            user = await UserStore().get_by_email(session, email)
            if user is None:
                raise CommandRefused(f"No account has the email {email}.")
            if is_bootstrap_owner(user):
                raise CommandRefused(
                    "That's the agent-registration service account, which can't be "
                    "a platform operator: agents added with the shared "
                    "registration token act with its role."
                )
            if user.role == OPERATOR_ROLE:
                raise CommandRefused(f"{email} is already a platform operator.")
            previous = user.role
            user.role = OPERATOR_ROLE
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.USER_PROMOTED,
                target_type="user",
                target_id=user.id,
                details={"from": previous, "to": OPERATOR_ROLE, **_by_command()},
            )
            await session.commit()
            return user


async def revoke_operator(
    session_factory: async_sessionmaker[AsyncSession], email: str, admin_email: str
) -> User:
    """Make a platform operator a regular account. Their workspace and
    organization roles stay as they are; the database ends every session they
    hold (`db/session_version_ddl.py`). Never the account at
    GATEWAY_ADMIN_EMAIL, which Switch recreates as an operator every time it
    starts, and never the last operator: the operators' rows are locked until
    the change commits, so two revocations at once can't take both."""
    with no_tenant():
        async with session_factory() as session:
            user = await UserStore().get_by_email(session, email)
            if user is None:
                raise CommandRefused(f"No account has the email {email}.")
            if user.email.lower() == admin_email.lower():
                raise CommandRefused(
                    "That's Switch's administrator account (GATEWAY_ADMIN_EMAIL), "
                    "which stays a platform operator: Switch recreates it every "
                    "time it starts."
                )
            operators = await _lock_operators(session)
            if user.id not in operators:
                raise CommandRefused(f"{email} is not a platform operator.")
            if not operators - {user.id}:
                raise CommandRefused(
                    f"{email} is the only platform operator, and Switch keeps at "
                    "least one. Make another account one first."
                )
            user.role = REGULAR_ROLE
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.USER_DEMOTED,
                target_type="user",
                target_id=user.id,
                details={"from": OPERATOR_ROLE, "to": REGULAR_ROLE, **_by_command()},
            )
            await session.commit()
            return user


# ── delete ────────────────────────────────────────────────────────────────────


class _NoAgentBridge:
    """The agent bridge, for a command that runs none. The deletion is
    refused before it starts while the account owns an agent
    (`DeletionPlan.needs_the_server`, looked at again just before the
    deletion starts), so it is asked to delete one only when the agent was
    made while the deletion was working through the account's other
    workspaces (`delete_account`). A key the deletion removes is forgotten by
    each running server when its short-lived cache entry expires
    (`ApiKeyCache`)."""

    def __init__(self) -> None:
        self.api_key_cache = _NothingCached()

    async def delete_agent(
        self, *, agent_id: str | None = None, agent_name: str | None = None
    ) -> object:
        raise RuntimeError(
            f"the account owns an agent ({agent_id}) made since the deletion "
            "started, which only a running server can delete; delete it from "
            "the dashboard or Switch Console first"
        )


class _NothingCached:
    def invalidate(self, key_hash: str) -> None:
        return None


class _NoChats:
    """The room service, for a command that runs none: refused first, as
    `_NoAgentBridge` is, while the account has an open chat."""

    async def set_room_archived(self, room_id: str, archived: bool) -> None:
        raise RuntimeError(
            f"the account opened a chat ({room_id}) since the deletion started, "
            "which only a running server can archive; archive it from the "
            "dashboard or Switch Console first"
        )


@dataclass
class _ServerClients:
    """The clients a deleted workspace had run in the running servers, which
    reconcile with the table when told. This process runs none."""

    bus: SignalBus

    async def reconcile_tenant(self, tenant_id: str) -> None:
        return None

    def announce(self, tenant_id: str) -> None:
        self.bus.publish(CLIENT_CHANGED_SIGNAL, tenant_id=tenant_id)


# Where the command's own wording is wrapped.
WIDTH = 78

WHAT_GOES_FIRST = (
    "They go first: in the dashboard, a workspace admin (an admin of its "
    "organization counts) can transfer the agents to someone else or delete "
    "them, and remove the devices, and their owner can delete any of them "
    "from Switch Console or the dashboard. Or the person can delete their own "
    "account from the dashboard, which removes them with it."
)


@dataclass
class DeletionPlan:
    user: User
    workspaces: list[Workspace]
    # Why the account deletion refuses, if it does.
    refusal: str | None
    # What deleting the account does in each workspace, by workspace id.
    previews: dict[str, WorkspacePreview]
    # The organizations they are `org_admin` of, by name.
    administers: list[str]

    @property
    def needs_the_server(self) -> str | None:
        """Why this command can't delete the account itself, or None: what
        only a running server can stop or archive."""
        listed = "; ".join(
            f"{workspace.name}: {_held_text(self.previews[workspace.id].held)}"
            for workspace in self.workspaces
            if self.previews[workspace.id].held
        )
        if not listed:
            return None
        return (
            "The account owns things only a running server can stop and "
            f"remove ({listed}). {WHAT_GOES_FIRST}"
        )

    @property
    def reasons(self) -> list[str]:
        """Everything that stops this command deleting the account."""
        return [r for r in (self.refusal, self.needs_the_server) if r is not None]

    @property
    def blocked(self) -> str | None:
        """`reasons`, in one, or None."""
        return " ".join(self.reasons) if self.reasons else None


def _held_text(held: Held) -> str:
    parts = []
    if held.agents:
        parts.append(f"{len(held.agents)} agent(s)")
    if held.controllers:
        parts.append(f"{len(held.controllers)} device(s)")
    if held.chats:
        parts.append(f"{len(held.chats)} open chat(s)")
    return ", ".join(parts)


async def plan_deletion(
    deletion: AccountDeletion,
    session_factory: async_sessionmaker[AsyncSession],
    email: str,
) -> DeletionPlan:
    """What deleting the account with `email` would do, and what stops it,
    as the account deletion itself finds them."""
    user = await account_by_email(session_factory, email)
    user_store = UserStore()
    memberships = [
        Workspace(id=m.id, name=m.name, role=m.role)
        for m in await list_held_memberships(session_factory, user_store, user.id)
    ]
    workspaces = await deletion.with_former_workspaces(user.id, memberships)
    with no_tenant():
        async with session_factory() as session:
            refusal = await deletion.refusal(session, user, workspaces)
    administered = await deletion.organizations_administered(user.id, workspaces)
    return DeletionPlan(
        user=user,
        workspaces=workspaces,
        refusal=refusal,
        previews={w.id: await deletion.preview(user.id, w.id) for w in workspaces},
        administers=sorted(administered.values()),
    )


def describe(plan: DeletionPlan) -> list[str]:
    """What the command shows of `plan`, line by line: what is connected to
    the account, and anything that blocks deleting it."""
    user = plan.user
    lines = [
        f"Account {user.email} ({user.id}): {user.name}",
        "",
        f"Workspaces it leaves ({len(plan.workspaces)}):",
        *(f"  {w.name} ({w.id}), as {w.role}" for w in plan.workspaces),
    ]
    if plan.administers:
        lines.append(
            "Organizations it stops being an organization admin of, whose other "
            f"admins are e-mailed: {', '.join(plan.administers)}"
        )
    for workspace in plan.workspaces:
        lines += ["", f"In {workspace.name} ({workspace.id}):"]
        lines += _preview_lines(plan.previews[workspace.id]) or [
            "  no agents, devices, chats, API keys, connections or rooms, and "
            "nothing handed over"
        ]
    if plan.reasons:
        lines += ["", "Blocked. The account can't be deleted until this is done:"]
        for reason in plan.reasons:
            lines += textwrap.wrap(
                reason, WIDTH, initial_indent="  - ", subsequent_indent="    "
            )
    return lines


def _preview_lines(preview: WorkspacePreview) -> list[str]:
    held = preview.held

    def names(named: list[Named]) -> list[str]:
        return [n.name for n in named]

    listed = [
        ("Agents it owns", names(held.agents)),
        ("Devices", names(held.controllers)),
        ("Open chats", names(held.chats)),
        ("API keys, deleted", names(preview.api_keys)),
        ("Service connections, removed and signed out", preview.services),
        (
            "Rooms it created or owns, which stay with no owner for the "
            "workspace's admins",
            names(preview.rooms),
        ),
    ]
    lines = [
        f"  {title} ({len(items)}): {', '.join(items)}"
        for title, items in listed
        if items
    ]
    if preview.handed_over:
        counted = ", ".join(
            f"{count} {kind}(s)" for kind, count in preview.handed_over.items()
        )
        if preview.successor is not None:
            lines.append(f"  Passed to {preview.successor}: {counted}")
        else:
            lines.append(f"  Deleted, with no other admin to pass them to: {counted}")
    return lines


def print_plan(plan: DeletionPlan) -> None:
    print("\n".join(describe(plan)))


def confirm(email: str) -> None:
    """Ask the operator to type the account's `email`; refuse unless they
    type exactly it. Refuses without asking when standard input isn't a
    terminal, where nobody could answer and the prompt would wait forever."""
    if not sys.stdin.isatty():
        raise CommandRefused(
            "Standard input isn't a terminal, so nobody can confirm, and "
            "nothing was deleted. Run it on a terminal, or add --yes to delete "
            "without asking."
        )
    try:
        typed = input(f"\nTo delete it, type the account's e-mail ({email}): ")
    except EOFError:
        print()
        raise CommandRefused("No e-mail was typed, so nothing was deleted.") from None
    if typed != email:
        raise CommandRefused("That isn't the account's e-mail, so nothing was deleted.")


async def _record_refusal(
    session_factory: async_sessionmaker[AsyncSession], user_id: str, reason: str
) -> None:
    with no_tenant():
        async with session_factory() as session:
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.USER_DELETION_REFUSED,
                target_type="user",
                target_id=user_id,
                details={"outcome": "refused", "reason": reason, **_by_command()},
            )
            await session.commit()


async def delete_account(
    deletion: AccountDeletion,
    session_factory: async_sessionmaker[AsyncSession],
    shown: DeletionPlan,
) -> None:
    """Delete the account `shown` describes, recorded in the server's audit
    log as the operator's deletion from the dashboard was: deleted, refused,
    or failed part-way. The admins of an organization it was `org_admin` of
    are e-mailed once the deletion has committed and its session is closed.

    Immediately before anything changes, it looks at every workspace again,
    as `plan_deletion` does, and deletes nothing unless it finds the account
    as `shown`: the plan can be stale by then, for the confirmation prompt can
    wait a long time and the person can act meanwhile, and an agent, device
    or open chat (`DeletionPlan.needs_the_server`) must stop it before the
    first workspace is left, not be found in the second. The look is not
    held under a lock, because nothing that makes an agent, a device or a
    chat takes one it could hold. One made while the deletion is working
    through the account's earlier workspaces is found only when its own
    workspace is reached: the deletion stops there, failed partway, and a
    run once it has gone finishes."""
    plan = await plan_deletion(deletion, session_factory, shown.user.email)
    if describe(plan) != describe(shown):
        print("\nThe account changed since it was shown. Now:\n")
        print_plan(plan)
        raise CommandRefused(
            "Nothing was deleted. Run it again to delete the account as it is now."
        )
    user_id = plan.user.id
    reason = plan.blocked
    if reason is not None:
        await _record_refusal(session_factory, user_id, reason)
        raise CommandRefused(reason)
    with no_tenant():
        async with session_factory() as session:
            user = await session.get(User, user_id)
            if user is None:
                raise CommandRefused("That account no longer exists.")
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.USER_DELETED,
                target_type="user",
                target_id=user_id,
                details={
                    "outcome": "deleted",
                    "workspaces": len(plan.workspaces),
                    **_by_command(),
                },
            )
            try:
                changes = await deletion.delete(
                    session, user, plan.workspaces, actor_id=None
                )
            except AccountDeletionRefused as refused:
                await session.rollback()
                await _record_refusal(session_factory, user_id, str(refused))
                raise CommandRefused(str(refused)) from None
            except AccountDeletionIncomplete as error:
                await session.rollback()
                await record_server_audit_event(
                    session,
                    actor_user_id=None,
                    action=ServerAuditAction.USER_DELETION_FAILED,
                    target_type="user",
                    target_id=user_id,
                    details={
                        "outcome": "failed",
                        "workspaces": len(plan.workspaces),
                        "workspaces_completed": [w.id for w in error.completed],
                        "error": type(error.__cause__).__name__,
                        **_by_command(),
                    },
                )
                await session.commit()
                raise CommandRefused(
                    f"Deleting {plan.user.email} failed partway, after leaving "
                    f"{len(error.completed)} of {len(plan.workspaces)} "
                    f"workspace(s): {type(error.__cause__).__name__}: "
                    f"{error.__cause__}. The account still exists, and the "
                    "audit log records what was finished. Run it again to "
                    "finish."
                ) from error
    await deletion.admin_notices.send_all(changes)


async def run_delete(
    deletion: AccountDeletion,
    session_factory: async_sessionmaker[AsyncSession],
    email: str,
    *,
    execute: bool,
    yes: bool,
) -> int:
    """`switch-accounts delete`: show what is connected to the account and
    anything that blocks deleting it, then, with `execute`, delete it once
    the operator has typed its e-mail, or at once with `yes`, as long as it
    is still as shown (`delete_account`). Returns the exit status; a deletion
    refused or not confirmed raises `CommandRefused`."""
    plan = await plan_deletion(deletion, session_factory, email)
    print_plan(plan)
    reason = plan.blocked
    if reason is not None:
        if not execute:
            print("\nNothing changed.")
            return 1
        await _record_refusal(session_factory, plan.user.id, reason)
        raise CommandRefused(
            "Nothing was deleted. What has to happen first is listed above."
        )
    if not execute:
        print("\nNothing changed. Add --execute to delete it.")
        return 0
    if not yes:
        confirm(plan.user.email)
    await delete_account(deletion, session_factory, plan)
    print(f"\nDeleted the account {plan.user.email}.")
    return 0


@asynccontextmanager
async def deletion_services(
    config: SwitchConfig, session_factory: async_sessionmaker[AsyncSession]
) -> AsyncIterator[AccountDeletion]:
    """The account deletion, with what this command can give it: the
    server's own broker, to revoke service sign-ins as the server does, a
    signal bus to tell the running servers which clients went, and stand-ins
    for the agent bridge and the room service, which only a running server
    has (`DeletionPlan.needs_the_server`)."""
    async with (
        signals(config, session_factory, "switch-accounts") as bus,
        guarded_async_client(config.outbound_policy, timeout=20) as http,
    ):
        registration = ClientRegistration(
            session_factory=session_factory,
            keyring=config.keyring,
            public_url=config.gateway_public_url,
            server_name=config.id_server_name,
            redirects=config.service_sign_in_redirect,
        )
        connector_apps = build_connector_apps(
            config,
            session_factory=session_factory,
            http=http,
            registration=registration,
        )
        await connector_apps.load()
        organization_apps = (
            OrganizationApps(
                apps=connector_apps,
                store=OrganizationAppCredentialStore(config.keyring),
            )
            if config.organization_connector_apps_enabled
            else None
        )
        yield AccountDeletion(
            session_factory=session_factory,
            protocol=_NoAgentBridge(),
            management=None,
            broker=build_service_broker(
                config,
                connector_apps,
                organization_apps,
                session_factory=session_factory,
                http=http,
                registration=registration,
            ),
            resources=ResourceService(
                reference_store=ReferenceStore(),
                reference_type_store=ReferenceTypeStore(),
                document_store=DocumentStore(),
                package_store=PackageStore(),
                room_link_store=RoomLinkStore(),
                session_factory=session_factory,
            ),
            rooms=_NoChats(),
            sign_in_flows=SignInFlows(session_factory, config.keyring),
            users=UserStore(),
            organizations=OrganizationStore(),
            agents=AgentStore(),
            api_keys=ApiKeyStore(),
            templates=TemplateStore(),
            clients=_ServerClients(bus),
            admin_email=config.gateway_admin_email,
            admin_notices=admin_notices(config, session_factory),
        )


# ── The command ───────────────────────────────────────────────────────────────


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="switch-accounts",
        description=(
            "The accounts on this Switch deployment, for its platform "
            "operator. Run it where switch-core runs, with the same "
            "configuration. Every change is recorded in the server's audit "
            "log as made by a platform operator command."
        ),
    )
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser(
        "list",
        help="every account",
        description="Print every account: id, e-mail, name, and whether it is "
        "a platform operator. Changes nothing.",
    )
    listing.add_argument(
        "--operators", action="store_true", help="only the platform operators"
    )
    create = commands.add_parser(
        "create",
        help="add an account, in no workspace",
        description=(
            "Add an account with a password, in no workspace and no "
            "organization: it signs in to an empty start page until an "
            "invitation or a domain join puts it in a workspace. The password "
            "is read from --password-file, or else from standard input (asked "
            "for twice on a terminal), never from the command line. Refuses an "
            "e-mail another account already has."
        ),
    )
    create.add_argument("email")
    create.add_argument("--name", required=True, help="the name others see")
    create.add_argument(
        "--operator",
        action="store_true",
        help="make it a platform operator, who administers every workspace",
    )
    create.add_argument(
        "--password-file",
        type=Path,
        help="a file holding the password (one trailing line ending is dropped)",
    )
    delete = commands.add_parser(
        "delete",
        help="delete an account (shows what would happen unless --execute)",
        description=(
            "Delete an account everywhere on this server, as the account's own "
            "deletion does: its workspaces are left, what it owns is deleted "
            "or handed over, and its messages stay under a former member's "
            "name. It first shows what is connected to the account: the "
            "workspaces it is in and its role in each, the organizations it is "
            "an organization admin of, and in each workspace its agents, "
            "devices, open chats, API keys and service connections, the rooms "
            "it leaves without an owner, and the invitations and other setup "
            "that pass to another admin. It is blocked, exiting non-zero with "
            "what has to happen first, wherever the account deletion refuses "
            "(the only admin of a workspace or organization with other people, "
            "a platform operator, a cloud machine), and while the account owns "
            "agents, devices or open chats, which only a running server can "
            "stop and remove. Without --execute it stops there. With it, the "
            "account's e-mail must be typed to confirm before anything is "
            "deleted; --yes skips that, for scripts. Without --yes it needs a "
            "terminal to ask on, and refuses otherwise. Either way it looks "
            "again just before deleting, and deletes nothing if the account has "
            "changed since it was shown."
        ),
    )
    delete.add_argument("email")
    delete.add_argument(
        "--execute",
        action="store_true",
        help="delete it, once its e-mail is typed to confirm. Without this, "
        "only show what would happen.",
    )
    delete.add_argument(
        "--yes",
        action="store_true",
        help="with --execute, delete without asking to confirm, for scripts",
    )
    sign_out_command = commands.add_parser(
        "sign-out",
        help="end every session of an account",
        description=(
            "Sign an account out of every device, for a lost laptop or an "
            "account that looks taken over: every session it holds stops "
            "working, and it signs in again."
        ),
    )
    sign_out_command.add_argument("email")
    grant = commands.add_parser(
        "grant-operator",
        help="make an account a platform operator",
        description=(
            "Make an account a platform operator, who administers every "
            "workspace and organization here. Never the agent-registration "
            "service account."
        ),
    )
    grant.add_argument("email")
    revoke = commands.add_parser(
        "revoke-operator",
        help="make a platform operator a regular account",
        description=(
            "Make a platform operator a regular account again, ending every "
            "session it holds. Its roles in workspaces and organizations stay. "
            "Refused for the account at GATEWAY_ADMIN_EMAIL, which Switch "
            "recreates as an operator every time it starts, and for the last "
            "platform operator."
        ),
    )
    revoke.add_argument("email")
    return parser


async def _run(config: SwitchConfig, arguments: argparse.Namespace) -> int:
    command = arguments.command
    try:
        if command == "delete":
            return await _delete(
                config, arguments.email, execute=arguments.execute, yes=arguments.yes
            )
        async with database(config, restricted=False) as session_factory:
            if command == "list":
                print_accounts(
                    await list_accounts(session_factory, operators=arguments.operators)
                )
            elif command == "create":
                password = read_password(arguments.password_file)
                user = await create_account(
                    session_factory,
                    email=arguments.email,
                    name=arguments.name,
                    password=password,
                    operator=arguments.operator,
                )
                role = "platform operator" if arguments.operator else "account"
                print(f"Created {role} {user.email} ({user.id}), in no workspace.")
            elif command == "sign-out":
                user = await sign_out(session_factory, arguments.email)
                print(f"Ended every session of {user.email} ({user.id}).")
            elif command == "grant-operator":
                user = await grant_operator(session_factory, arguments.email)
                print(f"{user.email} ({user.id}) is now a platform operator.")
            else:
                user = await revoke_operator(
                    session_factory, arguments.email, config.gateway_admin_email
                )
                print(
                    f"{user.email} ({user.id}) is now a regular account; every "
                    "session it held has ended."
                )
    except CommandRefused as refused:
        print(f"Refused: {refused}", file=sys.stderr)
        return 1
    return 0


async def _delete(config: SwitchConfig, email: str, *, execute: bool, yes: bool) -> int:
    try:
        async with (
            database(config, restricted=True) as session_factory,
            deletion_services(config, session_factory) as deletion,
        ):
            return await run_delete(
                deletion, session_factory, email, execute=execute, yes=yes
            )
    except RuntimeRoleError as error:
        # The broker finds a workspace's sign-ins through the tenant policies
        # alone; on a connection they don't bind it would revoke every one.
        print(f"Refused: {error}", file=sys.stderr)
        return 1


def main() -> None:
    run(_parser(), _run)
