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
from typing import Any

from sqlalchemy import Text, cast, func, literal, select, text, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.sql.elements import ColumnElement

from switch_core.db.models import SessionActivityPost, require_tenant_id


def _without_claim(document: Any) -> ColumnElement:
    """The document with the reaction claim taken out of it."""
    stripped: ColumnElement = (
        document.op("-")(cast("mark", Text))
        .op("-")(cast("mark_attempt", Text))
        .cast(JSONB)
    )
    return stripped


def _claim_in(document: Any) -> ColumnElement:
    """Just the reaction claim, as the row holds it at this moment.

    Empty where the row carries none: an absent key reads as SQL NULL, becomes
    a JSON null in the object built from it, and is stripped back out.
    """
    return func.jsonb_strip_nulls(
        func.jsonb_build_object(
            "mark",
            document["mark"],
            "mark_attempt",
            document["mark_attempt"],
        )
    )


@dataclass
class ActivityRecord:
    sessions: async_sessionmaker[AsyncSession]
    key: tuple[str, str, str, str]
    data: dict

    async def save(self) -> None:
        """Write this turn's own state, leaving the shared claim where it is.

        Everything in `data` belongs to this turn and is written whole — the
        anchor it redraws from, the delivery reservation, the end of the turn.
        The reaction claim does not. Turns share one mark, so the turn that
        takes it off is routinely another one, and it clears the claim holding
        no lock this turn holds. The copy in `data` was read when the record
        was opened, which may be long before this write: a platform call sits
        in between. Writing it back is how a reaction genuinely taken off the
        message returns as an expectation nothing will ever answer for, and a
        later turn on that message waits forever on it.

        So the two claim keys are carried across from the row as it stands when
        the statement runs, and are changed only by `claim` and `disclaim`,
        which say which attempt they speak for. The row is written in one
        statement for the same reason: there is no moment between reading it
        and writing it for a removal to fall into.
        """
        insert = pg_insert(SessionActivityPost).values(
            tenant_id=self.key[0],
            bridge_id=self.key[1],
            session_id=self.key[2],
            command_id=self.key[3],
            data=self.data.copy(),
        )
        async with self.sessions() as db:
            await db.execute(
                insert.on_conflict_do_update(
                    index_elements=[
                        SessionActivityPost.tenant_id,
                        SessionActivityPost.bridge_id,
                        SessionActivityPost.session_id,
                        SessionActivityPost.command_id,
                    ],
                    set_={
                        "data": _without_claim(insert.excluded.data).op("||")(
                            _claim_in(SessionActivityPost.data)
                        )
                    },
                )
            )
            await db.commit()

    async def claim(self, mark: dict[str, str], attempt: str) -> None:
        """Take the reaction claim for this attempt, whatever the row held.

        Its own statement rather than part of the next `save`, because the two
        answer to different owners: the rest of the row is this turn's and the
        claim is shared with whichever turn eventually takes the mark off. A
        fresh attempt supersedes what was there unconditionally — this turn is
        asking for the reaction now, and that is true whoever asked before.
        """
        async with self.sessions() as db:
            await db.execute(
                update(SessionActivityPost)
                .where(*self._row())
                .values(
                    data=SessionActivityPost.data.op("||")(
                        literal({"mark": mark, "mark_attempt": attempt}, JSONB)
                    )
                )
            )
            await db.commit()
        self.data["mark"] = mark
        self.data["mark_attempt"] = attempt

    async def disclaim(self, attempt: str, *, renewed: str | None) -> None:
        """Give the claim up, or put it back to the attempt this one renewed.

        Only while the row still names the attempt being given up. A refusal
        speaks for the attempt it answers and for nothing that happened after
        it: a later ask is a claim in its own right, and a removal issued
        against an earlier one has already cleared what it was entitled to.
        """
        held = func.coalesce(SessionActivityPost.data["mark_attempt"].astext, "")
        forgotten = (
            _without_claim(SessionActivityPost.data)
            if renewed is None
            else SessionActivityPost.data.op("||")(
                literal({"mark_attempt": renewed}, JSONB)
            )
        )
        async with self.sessions() as db:
            await db.execute(
                update(SessionActivityPost)
                .where(*self._row(), held == attempt)
                .values(data=forgotten)
            )
            await db.commit()
        if self.data.get("mark_attempt") != attempt:
            return
        if renewed is None:
            self.data.pop("mark", None)
            self.data.pop("mark_attempt", None)
        else:
            self.data["mark_attempt"] = renewed

    def _row(self) -> tuple[ColumnElement, ...]:
        return (
            SessionActivityPost.tenant_id == self.key[0],
            SessionActivityPost.bridge_id == self.key[1],
            SessionActivityPost.session_id == self.key[2],
            SessionActivityPost.command_id == self.key[3],
        )


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
        claiming: dict[str, str] | None = None,
        not_claiming: dict[str, str] | None = None,
        sessions: async_sessionmaker[AsyncSession],
    ) -> bool:
        """Whether another live turn still wants the mark on this message.

        `agent_name` narrows the question to one agent's own mark, for a
        platform where each agent reacts as its own bot: another agent holding
        its own reaction there says nothing about whether this one's should
        come off. Left None where every agent shares a bot and there is a
        single reaction between them.

        `claiming` and `not_claiming` say what the mark is evidenced by, and
        the two marks differ. Being anchored here is enough to want the working
        mark — every live turn does, whether or not its own attempt has landed,
        which is why narrowing that one to its claimants would take the
        reaction off under a turn whose claim was refused. A turn waiting to
        start is the exception, because it wants the hourglass *instead*: it is
        named by `not_claiming` and does not hold the eyes. The hourglass
        itself runs the other way — only a turn still waiting wants it, its
        status is not in the row and its claim is, so `claiming` makes the
        claim the whole of the evidence.
        """
        anchor: dict[str, str] = {"channel_id": channel, "reaction_ref": ref}
        if agent_name is not None:
            anchor["agent_name"] = agent_name
        held: dict[str, Any] = {"anchor": anchor}
        if claiming is not None:
            held["mark"] = claiming
        criteria = [SessionActivityPost.data.contains(held)]
        if not_claiming is not None:
            criteria.append(~SessionActivityPost.data.contains({"mark": not_claiming}))
        async with sessions() as db:
            rows = await db.scalars(
                select(SessionActivityPost).where(
                    SessionActivityPost.tenant_id == require_tenant_id(),
                    SessionActivityPost.bridge_id == self.bridge_id,
                    *criteria,
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

        Rows are taken in a fixed order so that two removals clearing an
        overlapping set cannot each hold a row the other is waiting for.
        """
        if not holders:
            return
        held = func.coalesce(SessionActivityPost.data["mark_attempt"].astext, "")
        forgotten = _without_claim(SessionActivityPost.data)
        async with sessions() as db:
            for session_id, command_id, attempt in sorted(holders):
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
