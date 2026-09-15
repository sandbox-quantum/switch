"""Persist activity anchors and reserve posts before calling a platform.

A dedicated connection holds an advisory lock while short transactions commit
publication checkpoints. A process crash releases the lock without erasing the
reservation. An uncertain post is searched for, never blindly posted again.

Completed SDK turns retain only a completion receipt until their session or
bridge is deleted (foreign keys cascade). Expiring those receipts independently
would allow retained SDK history to be replayed. Provisional turns retain their
anchors so a later SDK turn can reuse the same message. On first deployment,
pre-journal live messages cannot be adopted automatically and may be duplicated.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from sqlalchemy import Text, cast, func, select, text, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from switch_core.db.models import SessionActivityPost, require_tenant_id


@dataclass
class ActivityRecord:
    sessions: async_sessionmaker[AsyncSession]
    key: tuple[str, str, str, str]
    data: dict

    async def save(self) -> None:
        async with self.sessions() as db:
            row = await db.get(SessionActivityPost, self.key)
            if row is None:
                row = SessionActivityPost(
                    tenant_id=self.key[0],
                    bridge_id=self.key[1],
                    session_id=self.key[2],
                    command_id=self.key[3],
                    data=self.data.copy(),
                )
                db.add(row)
            else:
                row.data = self.data.copy()
            await db.commit()


class ActivityJournal:
    def __init__(self, sessions: async_sessionmaker[AsyncSession], bridge_id: str):
        self.sessions = sessions
        self.bridge_id = bridge_id

    async def recorded_commands(self, session_id: str) -> set[str]:
        async with self.sessions() as db:
            return set(
                await db.scalars(
                    select(SessionActivityPost.command_id).where(
                        SessionActivityPost.tenant_id == require_tenant_id(),
                        SessionActivityPost.bridge_id == self.bridge_id,
                        SessionActivityPost.session_id == session_id,
                    )
                )
            )

    async def reaction_held(
        self,
        key: tuple[str, str],
        channel: str,
        ref: str,
        *,
        agent_name: str | None = None,
        sessions: async_sessionmaker[AsyncSession],
    ) -> bool:
        """Whether another live turn still wants the mark on this message.

        `agent_name` narrows the question to one agent's own mark, for a
        platform where each agent reacts as its own bot: another agent holding
        its own reaction there says nothing about whether this one's should
        come off. Left None where every agent shares a bot and there is a
        single reaction between them.
        """
        anchor: dict[str, str] = {"channel_id": channel, "reaction_ref": ref}
        if agent_name is not None:
            anchor["agent_name"] = agent_name
        async with sessions() as db:
            rows = await db.scalars(
                select(SessionActivityPost).where(
                    SessionActivityPost.tenant_id == require_tenant_id(),
                    SessionActivityPost.bridge_id == self.bridge_id,
                    SessionActivityPost.data.contains({"anchor": anchor}),
                )
            )
            return any(
                (row.session_id, row.command_id) != key and not row.data.get("ended")
                for row in rows
            )

    async def mark_expected(
        self,
        mark: dict[str, str],
        *,
        sessions: async_sessionmaker[AsyncSession],
    ) -> bool:
        """Whether any turn is still expecting this reaction to be there.

        Asked when a *removal* is refused, to tell a mark that is still sitting
        on the message from one that was never put there. A process's own
        memory cannot answer it: a restart empties that, and empty then means
        "no idea" rather than "nothing was added".

        Ended turns count, unlike `reaction_held`, and that is the point. Turns
        share one reaction, so the turn that put it there routinely finishes
        first and is reduced to a receipt while a later holder is left to take
        it off. Asking only the live ones is how a mark comes to be reported as
        cleaned up with the 👀 still on the message.
        """
        async with sessions() as db:
            return bool(
                (
                    await db.scalars(
                        select(SessionActivityPost).where(
                            SessionActivityPost.tenant_id == require_tenant_id(),
                            SessionActivityPost.bridge_id == self.bridge_id,
                            SessionActivityPost.data.contains({"mark": mark}),
                        )
                    )
                ).first()
            )

    async def mark_holders(
        self,
        mark: dict[str, str],
        *,
        sessions: async_sessionmaker[AsyncSession],
    ) -> set[tuple[str, str, str]]:
        """Which turns are expecting this reaction right now, and on what ask.

        Read immediately before a removal is asked for, so that what the
        removal later clears is what it was actually removing. A turn that
        starts expecting the mark after this read has asked for a reaction of
        its own, and the answer to a request issued before it existed says
        nothing about that one.

        The ask as well as the turn, because a turn that already had the mark
        can ask for it again — a restart, a publisher taking the message up
        with no claim of its own — and the reaction the second ask puts there
        is as new as any other turn's. A row written before the asks were
        stamped carries no stamp, and is named by the empty one.
        """
        async with sessions() as db:
            rows = await db.scalars(
                select(SessionActivityPost).where(
                    SessionActivityPost.tenant_id == require_tenant_id(),
                    SessionActivityPost.bridge_id == self.bridge_id,
                    SessionActivityPost.data.contains({"mark": mark}),
                )
            )
            return {
                (row.session_id, row.command_id, row.data.get("mark_attempt", ""))
                for row in rows
            }

    async def forget_mark(
        self,
        mark: dict[str, str],
        *,
        holders: set[tuple[str, str, str]],
        sessions: async_sessionmaker[AsyncSession],
    ) -> None:
        """Erase the expectation of this reaction, for the given asks only.

        Called when the platform has taken the mark off. Every holder it was
        taken off on behalf of loses its expectation together, because they are
        all talking about one reaction and one left behind would have a later
        turn on that message waiting forever on a mark nobody can remove.

        `holders` rather than all of them, because a removal answers only for
        the claims that existed when it was issued. Its acknowledgement can
        arrive after another publisher has put the mark back — for a turn of
        its own, or for one of these turns asking again — and that mark really
        is on the message. So a row is cleared only while it still carries the
        ask the removal was issued against.

        Each row is tested and cleared by one statement, and the two keys are
        dropped from whatever the row holds at the moment it runs rather than
        from a copy read earlier. Nothing serialises this against the holder
        itself: the remover holds its own turn's advisory lock and not that
        holder's, so between a read and a write the holder can have saved a
        newer attempt, a delivery reservation or the end of its turn. Writing
        back a whole edited copy would erase all of it — and the stale attempt
        it carried would reinstate a claim this removal never answered for.
        """
        if not holders:
            return
        held = func.coalesce(SessionActivityPost.data["mark_attempt"].astext, "")
        forgotten = (
            SessionActivityPost.data.op("-")(cast("mark", Text))
            .op("-")(cast("mark_attempt", Text))
            .cast(JSONB)
        )
        async with sessions() as db:
            for session_id, command_id, attempt in holders:
                await db.execute(
                    update(SessionActivityPost)
                    .where(
                        SessionActivityPost.tenant_id == require_tenant_id(),
                        SessionActivityPost.bridge_id == self.bridge_id,
                        SessionActivityPost.session_id == session_id,
                        SessionActivityPost.command_id == command_id,
                        SessionActivityPost.data.contains({"mark": mark}),
                        held == attempt,
                    )
                    .values(data=forgotten)
                )
            await db.commit()

    @asynccontextmanager
    async def open(
        self, session_id: str, command_id: str
    ) -> AsyncIterator[ActivityRecord | None]:
        key = (require_tenant_id(), self.bridge_id, session_id, command_id)
        engine = self.sessions.kw["bind"]
        if not isinstance(engine, AsyncEngine):
            raise TypeError("Activity journal requires an engine-bound session factory")
        async with engine.connect() as connection:
            locked = False
            try:
                locked = bool(
                    await connection.scalar(
                        text("SELECT pg_try_advisory_lock(hashtextextended(:key, 0))"),
                        {"key": repr(key)},
                    )
                )
                await connection.commit()
                if not locked:
                    yield None
                    return
                # Keep the connection checked out across checkpoint commits. This
                # avoids borrowing a second pool slot while holding the lock.
                bound = async_sessionmaker(
                    bind=connection,
                    **{k: v for k, v in self.sessions.kw.items() if k != "bind"},
                )
                async with bound() as db:
                    row = await db.get(SessionActivityPost, key)
                    data = dict(row.data) if row else {}
                yield ActivityRecord(bound, key, data)
            finally:
                try:
                    await connection.rollback()
                    if locked:
                        await connection.execute(
                            text(
                                "SELECT pg_advisory_unlock(hashtextextended(:key, 0))"
                            ),
                            {"key": repr(key)},
                        )
                    await connection.commit()
                except BaseException:
                    # Never return a connection with a session lock to the pool.
                    await connection.invalidate()
                    raise
