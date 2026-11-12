"""Who is in a Discord channel, and the changes to it, kept cheap.

Discord has no channel membership. Someone is "in" a guild text channel when
they are in the guild and their roles and the channel's permission overwrites
let them see it. So a room follows its channel through three things:

- the guild's members (who is in the server), read in one go;
- the live member events (someone joins or leaves the server, or their roles
  change), which come only with the privileged server-members intent;
- channel and role permission changes, which come without it.

Everything here exists to keep that within Discord's limits on the shared
connection, which every tenant's guild shares:

- `RoleChangeFilter` drops member updates that did not change anyone's roles
  (nickname, avatar, timeout, boost), which are most of them.
- `GuildChangeBatcher` gathers a guild's member changes for a few seconds, so a
  burst (a role handed to fifty people) costs one tenant lookup, not fifty.
- `MemberReadQueue` lets only a few guild member reads run at once across the
  whole connection, and keeps them inside the member-search budget the
  connection shares with people searching for each other, leaving headroom for
  those searches.
"""

from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

logger = logging.getLogger(__name__)

MemberChangeKind = Literal["join", "leave", "update"]


@dataclass(frozen=True)
class GuildMemberChange:
    """One person's change in a guild, as the Gateway reported it.

    `member` is the discord.py Member for a join or an update, from which the
    channels they can see are worked out; None for a leave, which carries only
    the user."""

    kind: MemberChangeKind
    guild_id: int
    user_id: int
    username: str
    member: Any = None


class RoleChangeFilter:
    """Remembers each person's roles, to tell a role change from any other
    member update.

    Discord sends a member update for a nickname, an avatar, a timeout or a
    boost as much as for a role, and only roles change what someone can see.
    Without the member cache (which would hold every member of every guild),
    the update carries no "before", so the roles last seen are kept here,
    bounded: someone not seen recently counts as changed, which costs one
    check, never a missed change.
    """

    def __init__(self, max_entries: int = 50_000) -> None:
        self._max_entries = max_entries
        self._roles: OrderedDict[tuple[int, int], frozenset[int]] = OrderedDict()

    def changed(self, guild_id: int, user_id: int, role_ids: frozenset[int]) -> bool:
        key = (guild_id, user_id)
        previous = self._roles.get(key)
        self._roles[key] = role_ids
        self._roles.move_to_end(key)
        while len(self._roles) > self._max_entries:
            self._roles.popitem(last=False)
        return previous != role_ids

    def forget(self, guild_id: int, user_id: int) -> None:
        self._roles.pop((guild_id, user_id), None)


@dataclass
class _PendingGuild:
    changes: dict[int, GuildMemberChange] = field(default_factory=dict)
    task: asyncio.Task[None] | None = None


class GuildChangeBatcher:
    """Gathers each guild's member changes and hands them on together.

    The first change for a guild starts a short wait; whatever else arrives for
    that guild in the meantime joins it, a person's later change replacing
    their earlier one, and the lot is handed to `flush` once. A guild that
    gathers `max_batch` people is handed on at once rather than growing.
    """

    def __init__(
        self,
        flush: Callable[[int, list[GuildMemberChange]], Awaitable[None]],
        *,
        delay: float = 3.0,
        max_batch: int = 500,
    ) -> None:
        self._flush = flush
        self._delay = delay
        self._max_batch = max_batch
        self._pending: dict[int, _PendingGuild] = {}
        self._tasks: set[asyncio.Task[None]] = set()

    def add(self, change: GuildMemberChange) -> None:
        """Note a change. Synchronous, so the Gateway's parser can call it."""
        pending = self._pending.setdefault(change.guild_id, _PendingGuild())
        pending.changes[change.user_id] = change
        if len(pending.changes) >= self._max_batch:
            self._start(change.guild_id, delay=0.0)
        elif pending.task is None:
            pending.task = self._start(change.guild_id, delay=self._delay)

    def _start(self, guild_id: int, *, delay: float) -> asyncio.Task[None]:
        task = asyncio.get_running_loop().create_task(self._run(guild_id, delay))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def _run(self, guild_id: int, delay: float) -> None:
        if delay:
            await asyncio.sleep(delay)
        pending = self._pending.pop(guild_id, None)
        if pending is None or not pending.changes:
            return
        try:
            await self._flush(guild_id, list(pending.changes.values()))
        except Exception:
            logger.exception(
                "Could not act on %d member change(s) in Discord guild %s",
                len(pending.changes),
                guild_id,
            )

    async def drain(self) -> None:
        """Hand on everything gathered now (tests, and shutting down)."""
        for guild_id in list(self._pending):
            await self._run(guild_id, 0.0)

    def close(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        self._pending.clear()


class PermissionChangeBatcher:
    """Gathers each guild's permission changes and hands them on together.

    Someone editing a channel's permissions, or a role's, tends to make several
    changes in a row; each would otherwise re-check rooms against the guild's
    members. The channels changed in a guild in the wait are handed on once,
    or None when a role changed, which can affect every channel.
    """

    def __init__(
        self,
        flush: Callable[[int, set[int] | None], Awaitable[None]],
        *,
        delay: float = 10.0,
    ) -> None:
        self._flush = flush
        self._delay = delay
        # guild id -> channels changed, None meaning all of them.
        self._pending: dict[int, set[int] | None] = {}
        self._tasks: dict[int, asyncio.Task[None]] = {}

    def add(self, guild_id: int, channel_ids: list[int] | None) -> None:
        """Note a change. Synchronous, so a Gateway handler can call it."""
        if channel_ids is None:
            self._pending[guild_id] = None
        elif guild_id not in self._pending:
            self._pending[guild_id] = set(channel_ids)
        else:
            current = self._pending[guild_id]
            if current is not None:
                current.update(channel_ids)
        if guild_id not in self._tasks:
            task = asyncio.get_running_loop().create_task(self._run(guild_id))
            self._tasks[guild_id] = task

    async def _run(self, guild_id: int, delay: float | None = None) -> None:
        try:
            await asyncio.sleep(self._delay if delay is None else delay)
            if guild_id not in self._pending:
                return
            channel_ids = self._pending.pop(guild_id)
            try:
                await self._flush(guild_id, channel_ids)
            except Exception:
                logger.exception(
                    "Could not act on a permission change in Discord guild %s",
                    guild_id,
                )
        finally:
            if self._tasks.get(guild_id) is asyncio.current_task():
                del self._tasks[guild_id]

    async def drain(self) -> None:
        """Hand on everything gathered now (tests, and shutting down)."""
        for guild_id in list(self._pending):
            task = self._tasks.pop(guild_id, None)
            if task is not None:
                task.cancel()
            await self._run(guild_id, 0.0)

    def close(self) -> None:
        for task in list(self._tasks.values()):
            task.cancel()
        self._tasks.clear()
        self._pending.clear()


class MemberReadQueue:
    """Paces background reads of guild members on one Gateway connection.

    A guild's member list, or a batch of people asked about by id, is one
    request over the Gateway, which Discord limits per connection, and the
    connection's member-search budget is shared with people searching for each
    other. Background reads wait their turn here: at most `concurrency` at
    once, and only while `reserve` searches are left for people.
    """

    def __init__(
        self,
        *,
        budget_left: Callable[[], tuple[int, float]],
        spend: Callable[[], None],
        concurrency: int = 2,
        reserve: int = 20,
    ) -> None:
        self._budget_left = budget_left
        self._spend = spend
        self._reserve = reserve
        self._slots = asyncio.Semaphore(concurrency)

    async def run(self, read: Callable[[], Awaitable[Any]]) -> Any:
        async with self._slots:
            while True:
                left, wait = self._budget_left()
                if left > self._reserve:
                    break
                await asyncio.sleep(max(wait, 0.5))
            self._spend()
            return await read()
