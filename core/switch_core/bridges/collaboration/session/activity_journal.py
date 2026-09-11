"""Persist activity anchors and reserve posts before calling a platform.

A dedicated connection holds an advisory lock while short transactions commit
publication checkpoints. A process crash releases the lock without erasing the
reservation. An uncertain post is searched for, never blindly posted again.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from sqlalchemy import select, text
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
        sessions: async_sessionmaker[AsyncSession],
    ) -> bool:
        async with sessions() as db:
            rows = await db.scalars(
                select(SessionActivityPost).where(
                    SessionActivityPost.tenant_id == require_tenant_id(),
                    SessionActivityPost.bridge_id == self.bridge_id,
                    SessionActivityPost.data["anchor"]["channel_id"].as_string()
                    == channel,
                    SessionActivityPost.data["anchor"]["reaction_ref"].as_string()
                    == ref,
                )
            )
            return any(
                (row.session_id, row.command_id) != key and not row.data.get("ended")
                for row in rows
            )

    @asynccontextmanager
    async def open(
        self, session_id: str, command_id: str
    ) -> AsyncIterator[ActivityRecord]:
        key = (require_tenant_id(), self.bridge_id, session_id, command_id)
        engine = self.sessions.kw["bind"]
        if not isinstance(engine, AsyncEngine):
            raise TypeError("Activity journal requires an engine-bound session factory")
        async with engine.connect() as connection:
            try:
                await connection.execute(
                    text("SELECT pg_advisory_lock(hashtextextended(:key, 0))"),
                    {"key": repr(key)},
                )
                await connection.commit()
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
                    await connection.execute(
                        text("SELECT pg_advisory_unlock(hashtextextended(:key, 0))"),
                        {"key": repr(key)},
                    )
                    await connection.commit()
                except BaseException:
                    # Never return a connection with a session lock to the pool.
                    await connection.invalidate()
                    raise
