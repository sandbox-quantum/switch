"""`switch-accounts`: the deployment's accounts, for the platform operator
(`operator_commands.py`).

- `list [--operators]` prints every account, or only the platform operators.
- `create EMAIL --name NAME [--operator]` adds an account in no workspace,
  as an invitation or a domain join then places it. Its password is read
  from `--password-file` or standard input, never from the command line.
- `delete EMAIL [--execute]` deletes an account through the account deletion
  the dashboard uses (`accounts/deletion.py`), with its refusals. Without
  `--execute` it only says what would happen. It also refuses while the
  account owns agents, devices or open chats: only a running server can stop
  and remove those, so they go first, from the dashboard or Switch Console.
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
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
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
    Workspace,
)
from switch_core.authz import ORGANIZATION_ADMIN_ROLE
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
from switch_core.db.models import Organization, OrganizationMember, Tenant, User
from switch_core.db.runtime_role import RuntimeRoleError
from switch_core.db.session_scope import tenant_session
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
    (`DeletionPlan.needs_the_server`), so nothing is asked to delete one. A
    key the deletion removes is forgotten by each running server when its
    short-lived cache entry expires (`ApiKeyCache`)."""

    def __init__(self) -> None:
        self.api_key_cache = _NothingCached()

    async def delete_agent(
        self, *, agent_id: str | None = None, agent_name: str | None = None
    ) -> object:
        raise RuntimeError(
            "switch-accounts delete was asked to delete an agent, which only a "
            "running server can do; it should have refused first"
        )


class _NothingCached:
    def invalidate(self, key_hash: str) -> None:
        return None


class _NoChats:
    """The room service, for a command that runs none: refused first, as
    `_NoAgentBridge` is, while the account has an open chat."""

    async def set_room_archived(self, room_id: str, archived: bool) -> None:
        raise RuntimeError(
            "switch-accounts delete was asked to archive a chat, which only a "
            "running server can do; it should have refused first"
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


@dataclass
class DeletionPlan:
    user: User
    workspaces: list[Workspace]
    # Why the account deletion refuses, if it does.
    refusal: str | None
    # What only a running server can stop or archive, by workspace name.
    held: dict[str, Held] = field(default_factory=dict)
    # The organizations they are `org_admin` of, by name.
    administers: list[str] = field(default_factory=list)

    @property
    def needs_the_server(self) -> str | None:
        """Why this command can't delete the account itself, or None."""
        if not self.held:
            return None
        listed = "; ".join(
            f"{name}: {_held_text(held)}" for name, held in sorted(self.held.items())
        )
        return (
            "The account owns things only a running server can stop and remove "
            f"({listed}). Delete those first: their owner can, from Switch "
            "Console or the dashboard, as can a workspace admin for agents and "
            "devices. Or the person can delete their own account from the "
            "dashboard, which removes them with it."
        )


def _held_text(held: Held) -> str:
    parts = []
    if held.agent_ids:
        parts.append(f"{len(held.agent_ids)} agent(s)")
    if held.controller_ids:
        parts.append(f"{len(held.controller_ids)} device(s)")
    if held.chat_ids:
        parts.append(f"{len(held.chat_ids)} open chat(s)")
    return ", ".join(parts)


async def plan_deletion(
    deletion: AccountDeletion,
    session_factory: async_sessionmaker[AsyncSession],
    email: str,
) -> DeletionPlan:
    """What deleting the account with `email` would do, and what stops it."""
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
    plan = DeletionPlan(user=user, workspaces=workspaces, refusal=refusal)
    administered: dict[str, str] = {}
    for workspace in workspaces:
        held = await deletion.held(user.id, workspace.id)
        if held:
            plan.held[workspace.name] = held
        async with tenant_session(session_factory, workspace.id) as session:
            tenant = await session.get(Tenant, workspace.id)
            if tenant is None or tenant.organization_id is None:
                continue
            member = await session.get(
                OrganizationMember, (tenant.organization_id, user.id)
            )
            if member is not None and member.role == ORGANIZATION_ADMIN_ROLE:
                organization = await session.get(Organization, tenant.organization_id)
                assert organization is not None
                administered[organization.id] = organization.name
    plan.administers = sorted(administered.values())
    return plan


def print_plan(plan: DeletionPlan) -> None:
    user = plan.user
    print(f"Account {user.email} ({user.id}): {user.name}")
    print(f"Workspaces it leaves ({len(plan.workspaces)}):")
    for workspace in plan.workspaces:
        print(f"  {workspace.name} ({workspace.id}), as {workspace.role}")
    if plan.administers:
        print(
            "Organizations it stops being an organization admin of, whose other "
            f"admins are e-mailed: {', '.join(plan.administers)}"
        )
    if plan.refusal is not None:
        print(f"\nThe account can't be deleted: {plan.refusal}")
    elif plan.needs_the_server is not None:
        print(f"\nThis command can't delete it yet: {plan.needs_the_server}")


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
    plan: DeletionPlan,
) -> None:
    """Delete the account `plan` describes, recorded in the server's audit
    log as the operator's deletion from the dashboard was: deleted, refused,
    or failed part-way."""
    user_id = plan.user.id
    reason = plan.refusal or plan.needs_the_server
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
                await deletion.delete(session, user, plan.workspaces, actor_id=None)
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
                raise


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
            "name. Refused, with what to do first, wherever the account "
            "deletion refuses (the only admin of a workspace or organization "
            "with other people, a platform operator, a cloud machine), and "
            "while the account owns agents, devices or open chats, which only "
            "a running server can stop and remove. Without --execute it only "
            "says what would happen."
        ),
    )
    delete.add_argument("email")
    delete.add_argument(
        "--execute",
        action="store_true",
        help="delete it. Without this, only show what would happen.",
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
            return await _delete(config, arguments.email, execute=arguments.execute)
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


async def _delete(config: SwitchConfig, email: str, *, execute: bool) -> int:
    try:
        async with (
            database(config, restricted=True) as session_factory,
            deletion_services(config, session_factory) as deletion,
        ):
            plan = await plan_deletion(deletion, session_factory, email)
            print_plan(plan)
            if not execute:
                print("\nNothing changed. Add --execute to delete it.")
                blocked = plan.refusal or plan.needs_the_server
                return 1 if blocked else 0
            await delete_account(deletion, session_factory, plan)
    except RuntimeRoleError as error:
        # The broker finds a workspace's sign-ins through the tenant policies
        # alone; on a connection they don't bind it would revoke every one.
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    print(f"\nDeleted the account {email}.")
    return 0


def main() -> None:
    run(_parser(), _run)
