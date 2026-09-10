import asyncio
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.session.contract import Command, Snapshot
from switch_core.bridges.collaboration.session.outbound import SessionRequestCards
from switch_core.db.models import Agent, ClientRoom, Room, SdkSession, SdkSessionCommand
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore
from switch_core.sessions.service import SessionError

logger = logging.getLogger(__name__)


async def refresh_cards(
    session_factory: async_sessionmaker[AsyncSession],
    bridge_id: str,
    session_id: str,
    cards: SessionRequestCards,
) -> None:
    posts = SessionRequestPostStore()
    async with session_factory() as db:
        row = await db.get(SdkSession, session_id)
        if row is None:
            raise SessionError("NOT_FOUND", "Session not found.")
        snapshot = Snapshot.model_validate(row.snapshot)
        agent = await db.get(Agent, row.agent_id)
        if agent is None:
            raise SessionError("NOT_FOUND", "Session agent not found.")
        publications = []
        for request in snapshot.requests:
            turn = next(t for t in snapshot.turns if t.turn_id == request.turn_id)
            stored = await db.get(SdkSessionCommand, (row.id, turn.command_id))
            if stored is None:
                raise SessionError("NOT_FOUND", "Request has no source command.")
            origin = Command.model_validate(stored.command).origin
            if origin.room_id is None:
                continue
            room = await db.get(Room, origin.room_id)
            if room is None or room.bridge_id != bridge_id:
                continue
            if await db.get(ClientRoom, (agent.client_id, room.id)) is None:
                logger.warning(
                    "Skipping session %s request %s: agent left room %s.",
                    row.id,
                    request.request_id,
                    room.id,
                )
                continue
            if not room.external_channel_id:
                raise SessionError("NOT_FOUND", "Request room has no platform channel.")
            post = await posts.get_by_request(db, bridge_id, row.id, request.request_id)
            publications.append(
                (request, post, room.id, room.external_channel_id, origin.thread_id)
            )
        epoch = row.epoch
        agent_name = agent.name
        db.expunge_all()
    for request, post, room_id, channel_id, thread_id in publications:
        if post is None:
            if request.state != "open":
                continue
            await cards.post(
                request,
                channel_id=channel_id,
                thread_root_id=thread_id,
                room_id=room_id,
                session_id=session_id,
                epoch=epoch,
                agent_name=agent_name,
            )
        else:
            if post.external_post_id == post.token:
                post = await cards.recover(post)
            await cards.refresh(post, request)


class SessionPublisher:
    """Reconcile persisted snapshots independently of host acknowledgements."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        bridge_id: str,
        cards: SessionRequestCards,
    ) -> None:
        self._sessions = session_factory
        self._bridge_id = bridge_id
        self._cards = cards
        self._published: dict[str, int] = {}
        self._wake = asyncio.Event()

    def wake(self) -> None:
        self._wake.set()

    async def publish_pending(self) -> None:
        async with self._sessions() as db:
            rows = (
                await db.execute(
                    select(
                        SdkSession.id,
                        SdkSession.snapshot["throughSequence"].as_integer(),
                    )
                )
            ).all()
        for session_id, sequence in rows:
            if self._published.get(session_id) == sequence:
                continue
            try:
                await refresh_cards(
                    self._sessions, self._bridge_id, session_id, self._cards
                )
            except Exception:
                logger.exception(
                    "Session %s card publication failed on bridge %s; will retry.",
                    session_id,
                    self._bridge_id,
                )
            else:
                self._published[session_id] = sequence

    async def run(self) -> None:
        while True:
            self._wake.clear()
            try:
                await self.publish_pending()
            except Exception:
                logger.exception(
                    "Could not read pending session publications on bridge %s; will retry.",
                    self._bridge_id,
                )
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=5)
            except TimeoutError:
                pass
