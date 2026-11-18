"""`switch-suspend`: the operator suspending a person or an agent, and lifting
it (`accounts/suspension.py`, `operator_commands.py`).

- `switch-suspend user EMAIL --reason TEXT` suspends the account with that
  email: its sessions end, its keys are refused, every agent it owns, in
  every workspace, is suspended with it, and its devices are disconnected
  until the suspension is lifted.
- `switch-suspend agent AGENT_ID --reason TEXT` suspends one agent.
- `--lift` in place of `--reason` lifts either. A suspension made here is the
  operator's, which no workspace or organization admin can lift.
- `switch-suspend show EMAIL` shows the account's suspension and its agents'.

Each prints what it did as JSON. Run it where switch-core runs, with the same
configuration: the running servers hear of the change over the signal bus and
close the agents' connections and stop them on their devices at once, and the
service tokens issued to the agents are revoked with the server's own
credentials. It refuses a database connection that row-level security does
not bind, as `switch-purge-organization` does. Each change is recorded in the
audit log with no actor and `PLATFORM_OPERATOR_COMMAND` set.
"""

from __future__ import annotations

import argparse
import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.suspension import (
    Suspender,
    SuspensionChanges,
    SuspensionRefused,
    suspend_agent,
    suspend_user,
    unsuspend_agent,
    unsuspend_user,
)
from switch_core.bridges.agent.protocol.connection_rows import CHANGED_SIGNAL
from switch_core.config import SwitchConfig
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.organization_apps import OrganizationApps
from switch_core.connections.registry import ClientRegistration
from switch_core.db.models import Agent, ServiceTokenIssuance, User
from switch_core.db.runtime_role import RuntimeRoleError
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.organization_app_credential_store import (
    OrganizationAppCredentialStore,
)
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.main import build_connector_apps, build_service_broker
from switch_core.management.signals import (
    ASSIGNMENT_CHANGED_SIGNAL,
    OWNER_SUSPENDED_SIGNAL,
)
from switch_core.operator_commands import (
    CommandRefused,
    account_by_email,
    database,
    print_refusal,
    run,
    signals,
)
from switch_core.outbound import guarded_async_client
from switch_core.signals import SignalBus

OPERATOR = Suspender(user_id=None, role="operator")


async def find_agent(factory: async_sessionmaker[AsyncSession], agent_id: str) -> str:
    """The workspace the agent is in. The operator names an agent by id
    alone, and no lookup answers which workspace holds one, so each is
    asked in turn."""
    for tenant_id in await all_tenant_ids(factory):
        async with tenant_session(factory, tenant_id) as session:
            if await session.scalar(
                select(Agent.id).where(
                    Agent.tenant_id == tenant_id, Agent.id == agent_id
                )
            ):
                return tenant_id
    raise CommandRefused(f"No agent {agent_id}.")


async def show_user(
    factory: async_sessionmaker[AsyncSession], email: str
) -> dict[str, Any]:
    user = await account_by_email(factory, email)
    agents: list[dict[str, Any]] = []
    for tenant_id in await all_tenant_ids(factory):
        async with tenant_session(factory, tenant_id) as session:
            for agent in await session.scalars(
                select(Agent)
                .where(Agent.tenant_id == tenant_id, Agent.owner_id == user.id)
                .order_by(Agent.name)
            ):
                agents.append(
                    {
                        "workspace_id": tenant_id,
                        "agent_id": agent.id,
                        "name": agent.name,
                        **_suspension(agent),
                        "with_owner": agent.suspended_with_owner,
                    }
                )
    return {
        "user_id": user.id,
        "email": user.email,
        **_suspension(user),
        "agents": agents,
    }


def _suspension(target: Agent | User) -> dict[str, Any]:
    return {
        "suspended_at": None
        if target.suspended_at is None
        else target.suspended_at.isoformat(),
        "reason": target.suspended_reason,
        "by_role": target.suspended_by_role,
    }


async def announce(
    factory: async_sessionmaker[AsyncSession],
    signals: SignalBus,
    broker: ServiceBroker,
    changes: SuspensionChanges,
) -> bool:
    """Tell the running servers what committed, as each tells the others of
    a change it made: the agents' connections ended, their controllers' new
    assignments, and then a suspended person's controllers disconnected.
    Then revoke the service tokens issued to the agents.
    Returns whether any token is still waiting to be revoked, which the
    servers' periodic pass keeps trying."""
    pending = False
    for tenant_id, agent_ids in changes.agents.items():
        if not changes.suspended:
            continue
        for agent_id in agent_ids:
            signals.publish(
                CHANGED_SIGNAL,
                tenant_id=tenant_id,
                agent_id=agent_id,
                released=[],
                ending="suspended",
            )
        async with tenant_session(factory, tenant_id) as session:
            pending = (
                await broker.revoke_pending(
                    session, (ServiceTokenIssuance.agent_id.in_(agent_ids),)
                )
                or pending
            )
    for tenant_id, revisions in changes.revisions.items():
        for controller_id, revision in revisions.items():
            signals.publish(
                ASSIGNMENT_CHANGED_SIGNAL,
                tenant_id=tenant_id,
                controller_id=controller_id,
                revision=revision,
            )
    for controller_ids in changes.controllers.values():
        for controller_id in controller_ids:
            signals.publish(OWNER_SUSPENDED_SIGNAL, controller_id=controller_id)
    return pending


async def _change(
    factory: async_sessionmaker[AsyncSession], arguments: argparse.Namespace
) -> tuple[dict[str, Any], SuspensionChanges]:
    if arguments.target == "user":
        user = await account_by_email(factory, arguments.id)
        if arguments.lift:
            done = await unsuspend_user(factory, user_id=user.id, by=OPERATOR)
        else:
            done = await suspend_user(
                factory, user_id=user.id, by=OPERATOR, reason=arguments.reason
            )
        return (
            {
                "user_id": user.id,
                "suspended": not arguments.lift,
                "changed": done.changed,
                "agents": done.changes.agents,
                "controllers_disconnected": done.changes.controllers,
            },
            done.changes,
        )
    tenant_id = await find_agent(factory, arguments.id)
    async with tenant_session(factory, tenant_id) as session:
        if arguments.lift:
            changes = await unsuspend_agent(
                session, tenant_id=tenant_id, agent_id=arguments.id, by=OPERATOR
            )
        else:
            changes = await suspend_agent(
                session,
                tenant_id=tenant_id,
                agent_id=arguments.id,
                by=OPERATOR,
                reason=arguments.reason,
            )
        await session.commit()
    return (
        {
            "workspace_id": tenant_id,
            "agent_id": arguments.id,
            "suspended": not arguments.lift,
            "agents": changes.agents,
        },
        changes,
    )


async def _run(config: SwitchConfig, arguments: argparse.Namespace) -> int:
    try:
        # The broker finds a workspace's tokens through the tenant-isolation
        # policies alone, so on a connection they don't bind it would revoke
        # every workspace's.
        async with database(config, restricted=True) as factory:
            if arguments.target == "show":
                print(json.dumps(await show_user(factory, arguments.id), indent=2))
                return 0
            async with signals(config, factory, "switch-suspend") as bus:
                report = await _suspend(config, factory, bus, arguments)
    except (RuntimeRoleError, CommandRefused, SuspensionRefused) as error:
        print_refusal(CommandRefused(str(error)))
        return 1
    print(json.dumps(report, indent=2))
    return 0


async def _suspend(
    config: SwitchConfig,
    factory: async_sessionmaker[AsyncSession],
    bus: SignalBus,
    arguments: argparse.Namespace,
) -> dict[str, Any]:
    async with guarded_async_client(config.outbound_policy, timeout=20) as http:
        registration = ClientRegistration(
            session_factory=factory,
            keyring=config.keyring,
            public_url=config.gateway_public_url,
            server_name=config.id_server_name,
            redirects=config.service_sign_in_redirect,
        )
        connector_apps = build_connector_apps(
            config, session_factory=factory, http=http, registration=registration
        )
        await connector_apps.load()
        broker = build_service_broker(
            config,
            connector_apps,
            OrganizationApps(
                apps=connector_apps,
                store=OrganizationAppCredentialStore(config.keyring),
            )
            if config.organization_connector_apps_enabled
            else None,
            session_factory=factory,
            http=http,
            registration=registration,
        )
        report, changes = await _change(factory, arguments)
        report["service_tokens_pending"] = await announce(factory, bus, broker, changes)
    return report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="switch-suspend",
        description="Suspend a person or an agent, or lift the suspension.",
    )
    sub = parser.add_subparsers(dest="target", required=True)
    for target, what, helped in (
        ("user", "id", "The account's email."),
        ("agent", "id", "The agent's id."),
    ):
        command = sub.add_parser(target, help=f"Suspend or lift a {target}.")
        command.add_argument(what, help=helped)
        action = command.add_mutually_exclusive_group(required=True)
        action.add_argument("--reason", help="Why; kept on it and in the audit log.")
        action.add_argument(
            "--lift", action="store_true", help="Lift the suspension instead."
        )
    show = sub.add_parser("show", help="Show an account's suspension and its agents'.")
    show.add_argument("id", help="The account's email.")
    return parser


def main() -> None:
    run(_parser(), _run)
