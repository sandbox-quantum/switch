"""What `revocation_machine.py` revokes: one class per resource.

Each grants and revokes by writing the rows another process would, so every
process the machine runs hears of it only through the trigger's signal, and
checks access through the path a request takes.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any, ClassVar, Literal

from sqlalchemy import text, update
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.auth import ControllerAuthError, ControllerPrincipal
from switch_core.bridges.agent.controller_auth_cache import ControllerAuthCache
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.bridges.agent.room_access_cache import RoomAccessCache
from switch_core.db.models import TENANT_ZERO_ID, AgentController, ApiKey, User
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import Membership, RoomStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.management.auth import ManagementAuthenticator
from switch_core.transport import TransportHandlers
from switch_core.transport.cursors import FromHead
from switch_core.transport.ephemeral import EphemeralBus
from switch_core.transport.invites import InviteBus
from switch_core.transport.membership_signals import MembershipSignals
from switch_core.transport.observer import IgnoreParticipantMessages
from switch_core.transport.postgres import DELIVERY_PAGE, PostgresTransport
from switch_core.transport.room_cache import RoomCacheLimits, RoomDeliveryCache
from tests.routing import add_member, make_agent, make_room, router_on
from tests.switch_core.properties.revocation_machine import (
    TTL,
    Process,
    SessionFactory,
    held_read,
    until,
)


class _Nothing:
    """What a cache runs beside its process's bus, and waits for: nothing."""

    async def start(self, process: Process) -> None:
        return None

    async def stop(self, process: Process) -> None:
        return None

    async def settled(self, process: Process) -> None:
        return None


# ── A controller's access token ───────────────────────────────────────────────


class _HeldControllerStore(AgentControllerStore):
    def __init__(self, process: Process) -> None:
        super().__init__()
        self._process = process

    async def get(  # type: ignore[override]
        self, session: AsyncSession, tenant_id: str, controller_id: str
    ) -> Any:
        return await held_read(
            self._process, super().get(session, tenant_id, controller_id)
        )


class ControllerAccess(_Nothing):
    """A controller's access token, checked as every request checks it
    (`ManagementAuthenticator.current`), through `ControllerAuthCache`.
    Revoked by setting `revoked_at`, which `controller.auth_changed` names."""

    kind: ClassVar[Literal["held", "reread"]] = "held"

    def __init__(self) -> None:
        self.principal: ControllerPrincipal | None = None

    async def seed(self, session_factory: SessionFactory) -> None:
        async with session_factory() as session:
            owner = User(name="owner", email="owner@example.invalid", role="user")
            session.add(owner)
            await session.flush()
            key = ApiKey(
                user_id=owner.id,
                key_hash="controller-hash",
                encrypted_key="",
                label="k",
                type="controller",
            )
            session.add(key)
            await session.flush()
            controller = await AgentControllerStore().create(
                session,
                owner_id=owner.id,
                name="box",
                description=None,
                kind="daemon",
                platform={"os": "linux", "arch": "x64", "os_version": "6"},
                version="0.1.0",
                public_key=None,
                api_key_id=key.id,
            )
            await session.commit()
        self.principal = ControllerPrincipal(
            controller_id=controller.id, owner_id=owner.id, tenant_id=TENANT_ZERO_ID
        )

    def attach(self, process: Process, session_factory: SessionFactory) -> None:
        cache = ControllerAuthCache(ttl_seconds=TTL, max_entries=10)
        cache.follow(process.bus)
        process.parts["auth"] = ManagementAuthenticator(
            session_factory=session_factory,
            controllers=_HeldControllerStore(process),
            token_secret="unused",
            presence=ControllerPresence(on_bound=lambda _agent_id: None),
            auth_cache=cache,
        )

    async def _set_revoked(
        self, session_factory: SessionFactory, revoked: bool
    ) -> None:
        assert self.principal is not None
        async with session_factory() as session:
            await session.execute(
                update(AgentController)
                .where(AgentController.id == self.principal.controller_id)
                .values(revoked_at=text("now()") if revoked else None)
            )
            await session.commit()

    async def grant(self, session_factory: SessionFactory) -> None:
        await self._set_revoked(session_factory, False)

    async def revoke(self, session_factory: SessionFactory) -> None:
        await self._set_revoked(session_factory, True)

    async def allowed(self, process: Process) -> bool:
        assert self.principal is not None
        try:
            await process.parts["auth"].current(self.principal)
        except ControllerAuthError:
            return False
        return True

    async def slow(self, process: Process) -> bool | None:
        return await self.allowed(process)


# ── An agent's membership of a room, as a post checks it ──────────────────────


class _HeldRoomStore(RoomStore):
    def __init__(self, process: Process) -> None:
        super().__init__()
        self._process = process

    async def get_with_membership(  # type: ignore[override]
        self, session: AsyncSession, room_id: str, agent_id: str
    ) -> Any:
        return await held_read(
            self._process, super().get_with_membership(session, room_id, agent_id)
        )

    async def memberships_of(
        self, session: AsyncSession, client_id: str
    ) -> list[Membership]:
        return await held_read(
            self._process, super().memberships_of(session, client_id)
        )


class RoomAccess(_Nothing):
    """An agent's membership of a room, checked as a post checks it
    (`AgentCore.require_room_member`), through `RoomAccessCache`. Revoked by
    deleting its `room_agents` row, which `room_agent.changed` names."""

    kind: ClassVar[Literal["held", "reread"]] = "held"

    async def seed(self, session_factory: SessionFactory) -> None:
        room = await make_room(session_factory, "room")
        agent, client = await make_agent(session_factory, "agent")
        await add_member(session_factory, room, client, agent=agent)
        self.room_id, self.agent_id = room.id, agent.id

    def attach(self, process: Process, session_factory: SessionFactory) -> None:
        cache = RoomAccessCache(ttl_seconds=TTL, max_entries=10)
        cache.follow(process.bus)
        # Only what `require_room_member` reaches.
        core = AgentCore.__new__(AgentCore)
        core.session_factory = session_factory
        core.room_access = cache
        core.room_store = _HeldRoomStore(process)
        process.parts["core"] = core

    async def grant(self, session_factory: SessionFactory) -> None:
        async with session_factory() as session:
            await RoomStore().add_agents(session, self.room_id, [self.agent_id])
            await session.commit()

    async def revoke(self, session_factory: SessionFactory) -> None:
        async with session_factory() as session:
            await RoomStore().remove_agents(session, self.room_id, [self.agent_id])
            await session.commit()

    async def allowed(self, process: Process) -> bool:
        try:
            await process.parts["core"].require_room_member(self.agent_id, self.room_id)
        except PermissionError:
            return False
        return True

    async def slow(self, process: Process) -> bool | None:
        return await self.allowed(process)


# ── A client's copy reading a room ────────────────────────────────────────────


class _CountedInvites(InviteBus):
    """The invitation bus, counting the re-reads under way."""

    def __init__(self) -> None:
        super().__init__()
        self.rereading = 0

    async def reconcile(self, client_id: str) -> None:
        self.rereading += 1
        try:
            await super().reconcile(client_id)
        finally:
            self.rereading -= 1


class _Listener:
    """The message listener, which nothing here needs to wake."""

    def subscribe(
        self, room_id: str, waker: Any, *, types: frozenset[str] | None = None
    ) -> None:
        return None

    def unsubscribe(self, room_id: str, waker: Any) -> None:
        return None


class RoomMembership:
    """A client's membership of a room, as the copy of the client each
    process runs reads it: whether that copy still reads the room
    (`PostgresTransport`). Revoked by deleting the `client_rooms` row, which
    `membership.changed` names; the copy re-reads its rows on the signal,
    on resync and on the periodic re-check (`MembershipSignals`)."""

    kind: ClassVar[Literal["held", "reread"]] = "reread"

    async def seed(self, session_factory: SessionFactory) -> None:
        room = await make_room(session_factory, "room")
        agent, client = await make_agent(session_factory, "agent")
        await add_member(session_factory, room, client, agent=agent)
        self.room_id, self.client_id = room.id, client.id
        self.user_id = client.transport_user_id

    def attach(self, process: Process, session_factory: SessionFactory) -> None:
        invites = _CountedInvites()
        transport = PostgresTransport(
            user_id=self.user_id,
            client_id=self.client_id,
            tenant_id=TENANT_ZERO_ID,
            display_name="agent",
            actor_role="agent",
            session_factory=session_factory,
            room_store=_HeldRoomStore(process),
            message_store=MessageStore(),
            usage_store=UsageStore(),
            media_store=MediaStore(),
            listener=_Listener(),  # type: ignore[arg-type]
            invites=invites,
            ephemeral=EphemeralBus(),
            room_cache=RoomDeliveryCache(
                session_factory=session_factory,
                message_store=MessageStore(),
                limits=RoomCacheLimits(
                    max_bytes=1024 * 1024,
                    max_rooms=10,
                    max_rows_per_room=DELIVERY_PAGE,
                    max_age_seconds=60.0,
                ),
                page=DELIVERY_PAGE,
            ),
            message_observer=IgnoreParticipantMessages(),
            router=router_on(session_factory),
        )

        async def join(room: Any, _event: Any) -> None:
            # What a consumer does with an invitation: join, which reads it.
            await transport.join_room(room.room_id)

        async def ignore(*_args: Any) -> None:
            return None

        transport.register_handlers(
            TransportHandlers(
                on_message=ignore,
                on_media=ignore,
                on_member_event=ignore,
                on_custom_event=ignore,
                on_invite=join,
                on_removed=ignore,
            )
        )
        process.parts.update(
            transport=transport,
            invites=invites,
            membership=MembershipSignals(
                invites=invites, bus=process.bus, router=router_on(session_factory)
            ),
        )

    async def start(self, process: Process) -> None:
        transport = process.parts["transport"]
        process.parts["receiving"] = asyncio.create_task(
            transport.receive_forever(FromHead(MessageStore()))
        )
        await until(
            lambda: self.room_id in transport._watching, "the copy to read its room"
        )

    async def stop(self, process: Process) -> None:
        task = process.parts.get("receiving")
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def settled(self, process: Process) -> None:
        owed = process.parts["membership"]._owed
        invites = process.parts["invites"]
        await until(
            lambda: owed.pending == 0 and invites.rereading == 0,
            "the copy's re-reads to finish",
        )

    async def grant(self, session_factory: SessionFactory) -> None:
        async with session_factory() as session:
            await RoomStore().add_client(session, self.client_id, self.room_id)
            await session.commit()

    async def revoke(self, session_factory: SessionFactory) -> None:
        async with session_factory() as session:
            await RoomStore().remove_client(session, self.client_id, self.room_id)
            await session.commit()

    async def allowed(self, process: Process) -> bool:
        return self.room_id in process.parts["transport"]._watching

    async def slow(self, process: Process) -> bool | None:
        await process.parts["transport"]._reconcile_membership()
        return None
