"""`switch-room-moderation`: the server operator takes an account out of
every room of one workspace, for when the dashboard is not the place to do it
from.

`remove-agent` takes an agent out of every room it is in; `remove-person`
takes a person's Switch Console membership out of every room they are in,
and with `--include-agents` every agent they own there too. Each room records
the departure as a removal by the server's operator, and the workspace's
audit log has one `member.removed_from_all_rooms` event naming the rooms and
`--request`. Run it where switch-core runs, with the same configuration.

It writes through the same single-room steps as the gateway route
(`room_moderation.AccountRemoval`), with a router of its own: the running
servers hear of each removal from the membership triggers, as they do of any
other process's. What it cannot reach is their in-process listeners, so
Switch Console's room lists catch up on their next read rather than at once;
it says so when it finishes.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from collections.abc import Awaitable, Callable

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.config import SwitchConfig
from switch_core.db.engine import create_engine_from_config, create_session_factory
from switch_core.db.models import User, agent_event_boot_sequence
from switch_core.db.runtime_role import RuntimeRoleError, verify_restricted_role
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.budget_store import BudgetStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.delivery.conversation import ConversationRules, ConversationSettings
from switch_core.delivery.recipient import RecipientServices
from switch_core.delivery.router import MessageRouter
from switch_core.provisioning.postgres import PostgresProvisioning
from switch_core.room_moderation import (
    AccountRemoval,
    ModerationTargetNotFound,
    RemovedFromRooms,
)
from switch_core.telemetry.messages import MessageTelemetry
from switch_core.telemetry.setup import build_telemetry
from switch_core.tenant_context import no_tenant
from switch_core.transport.invites import InviteBus
from switch_core.version import switch_core_version

logger = logging.getLogger(__name__)

# How each room's history names who removed the account.
REMOVED_BY = "the server's operator"

CONSOLE_CATCHES_UP = (
    "Switch Console's room lists catch up on their next read, within a few "
    "minutes, rather than at once."
)


class RoomModerationAdminError(Exception):
    """The command cannot be carried out; the message says why."""


class _NoRoomReads:
    """Room announcements for a process that reads no room's conversation."""

    def subscribe(self, room_id: str, waker: Callable[[str], Awaitable[None]]) -> None:
        return None

    def unsubscribe(
        self, room_id: str, waker: Callable[[str], Awaitable[None]]
    ) -> None:
        return None


class _NoListeners:
    """The running servers' in-process listeners, which this process cannot
    reach (`CONSOLE_CATCHES_UP`)."""

    async def room_agents_changed(self, tenant_id: str, room_id: str) -> None:
        return None

    def room_changed(self, tenant_id: str, room_id: str) -> None:
        return None

    def memberships_changed(
        self, tenant_id: str, user_ids: list[str], room_ids: list[str]
    ) -> None:
        return None


async def require_workspace(
    factory: async_sessionmaker[AsyncSession], workspace: str
) -> str:
    """`workspace`, once it is known to be a workspace's id."""
    if workspace not in await all_tenant_ids(factory):
        raise RoomModerationAdminError(f"No workspace has the id {workspace}.")
    return workspace


async def require_user(factory: async_sessionmaker[AsyncSession], email: str) -> str:
    """The id of the account with `email`, matched without regard to case."""
    with no_tenant():
        async with factory() as session:
            user_id = await session.scalar(
                select(User.id).where(func.lower(User.email) == email.lower())
            )
    if user_id is None:
        raise RoomModerationAdminError(f"No account has the email {email}.")
    return user_id


def report(result: RemovedFromRooms) -> dict[str, object]:
    return {
        "target_type": result.target_type,
        "target_id": result.target_id,
        "rooms": [room.to_json() for room in result.rooms],
        "agents": {
            agent_id: [room.to_json() for room in rooms]
            for agent_id, rooms in result.agents.items()
        },
        "note": CONSOLE_CATCHES_UP,
    }


async def _router(
    config: SwitchConfig, factory: async_sessionmaker[AsyncSession], engine: AsyncEngine
) -> tuple[MessageRouter, Callable[[], Awaitable[None]]]:
    """A router for this process's writes, built as the server builds its
    own, and what to close once it is idle."""
    async with engine.begin() as connection:
        event_boot = await connection.scalar(agent_event_boot_sequence.next_value())
    telemetry, _, telemetry_http = await build_telemetry(
        config, factory, switch_core_version()
    )
    message_store = MessageStore()
    room_store = RoomStore()
    agent_store = AgentStore()
    room_role_store = RoomRoleStore()
    router = MessageRouter(
        services=RecipientServices(
            session_factory=factory,
            event_buffer=EventBuffer(
                factory,
                sequence_base=event_boot << 32,
                rooms=_NoRoomReads(),
                retention_seconds=config.agent_event_retention_seconds,
                session_slots=None,
            ),
            agent_store=agent_store,
            room_store=room_store,
            document_store=DocumentStore(),
            reference_store=ReferenceStore(),
            package_store=PackageStore(),
            agent_session_store=AgentSessionStore(),
            room_role_store=room_role_store,
            external_user_store=ExternalUserStore(),
            connections=AgentConnectionRegistry(),
            frontend_base_url=config.dashboard_base_url,
            message_telemetry=MessageTelemetry(
                telemetry=telemetry, session_factory=factory
            ),
            announcer=None,
        ),
        message_store=message_store,
        client_store=ClientStore(),
        budget_store=BudgetStore(),
        conversation=ConversationRules(
            settings=ConversationSettings.from_config(config),
            message_store=message_store,
            room_store=room_store,
            agent_store=agent_store,
            room_role_store=room_role_store,
        ),
        decisions=None,
        decision_max_age_seconds=config.decision_pending_max_age_seconds,
    )

    async def close() -> None:
        await router.idle()
        if telemetry_http is not None:
            await telemetry_http.aclose()

    return router, close


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="switch-room-moderation",
        description="Take an agent or a person out of every room of a workspace.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    agent = commands.add_parser(
        "remove-agent", help="take an agent out of every room it is in"
    )
    agent.add_argument("agent_id")
    person = commands.add_parser(
        "remove-person",
        help="take a person's Switch Console membership out of every room",
    )
    person.add_argument("--email", required=True)
    person.add_argument(
        "--include-agents",
        action="store_true",
        help="take every agent they own in the workspace out too",
    )
    for command in (agent, person):
        command.add_argument("--workspace", required=True, help="the workspace's id")
        command.add_argument(
            "--request",
            required=True,
            help="which request this answers (an incident or ticket reference), "
            "kept in the workspace's audit log",
        )
    return parser


async def remove(
    config: SwitchConfig,
    factory: async_sessionmaker[AsyncSession],
    engine: AsyncEngine,
    arguments: argparse.Namespace,
) -> RemovedFromRooms:
    """Carry out `arguments`' removal on a connection already checked to be
    one the tenant policies bind."""
    router, close = await _router(config, factory, engine)
    listeners = _NoListeners()
    removal = AccountRemoval(
        session_factory=factory,
        provisioning=PostgresProvisioning(
            session_factory=factory,
            room_store=RoomStore(),
            client_store=ClientStore(),
            router=router,
            invites=InviteBus(),
        ),
        room_store=RoomStore(),
        listeners=listeners,
        memberships_changed=listeners.memberships_changed,
    )
    try:
        tenant_id = await require_workspace(factory, arguments.workspace)
        if arguments.command == "remove-agent":
            return await removal.remove_agent(
                tenant_id,
                arguments.agent_id,
                actor_user_id=None,
                removed_by=REMOVED_BY,
                request=arguments.request,
            )
        return await removal.remove_person(
            tenant_id,
            await require_user(factory, arguments.email),
            include_agents=arguments.include_agents,
            actor_user_id=None,
            removed_by=REMOVED_BY,
            request=arguments.request,
        )
    finally:
        await close()


async def _run(config: SwitchConfig, arguments: argparse.Namespace) -> int:
    engine = create_engine_from_config(config)
    try:
        # Every write here is scoped to the workspace by its session, so on a
        # connection the tenant policies do not bind it would not be.
        await verify_restricted_role(engine)
    except RuntimeRoleError as error:
        await engine.dispose()
        print(json.dumps({"error": f"Refused: {error}"}), file=sys.stderr)
        return 1
    try:
        try:
            result = await remove(
                config, create_session_factory(engine), engine, arguments
            )
        except (RoomModerationAdminError, ModerationTargetNotFound) as error:
            print(json.dumps({"error": str(error)}), file=sys.stderr)
            return 1
        print(json.dumps(report(result), sort_keys=True))
        return 0
    finally:
        await engine.dispose()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    raise SystemExit(asyncio.run(_run(SwitchConfig(), _parser().parse_args())))
