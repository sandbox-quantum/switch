"""Telling a signed-in user that something of theirs changed, so their Console
reads it again instead of polling for it.

A change names a kind and an id (`managed_agent`, `machine`) and carries
nothing else: the client already knows how to read the current state, and a
notice that is only "read again" cannot leak what the reader would not be
allowed to read. That also makes a lost notice cheap. A client reads
everything again whenever its socket (re)connects, so a notice lost to a
restart or to a socket that was between connections costs a delay, never
correctness, and notices can coalesce: the same change twice before the
socket wakes is sent once.

Subscriptions are per (tenant, user), because a session is bound to one
tenant: a change in another of the user's workspaces is not this session's.

Core runs as one process, so `LocalUserChanges` fans out in memory and only
reaches the sockets this process holds. Writers depend on `UserChangePublisher`
alone, so that a multi-replica Core can swap in a publisher that sends each
change through Postgres (`pg_notify` on a channel every replica LISTENs to, as
`messages/notify.py` does for room messages) and have each replica hand what it
hears to its own `LocalUserChanges`.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Protocol

MANAGED_AGENT = "managed_agent"
MACHINE = "machine"
KINDS = (MANAGED_AGENT, MACHINE)

# Notices a subscription holds before it collapses them into one per kind
# (`id` None, "something of this kind changed"), so a socket that is not being
# read cannot grow without bound.
_MAX_PENDING = 64


@dataclass(frozen=True)
class UserChange:
    kind: str
    # None when the notice covers every one of its kind.
    id: str | None


class UserChangePublisher(Protocol):
    def publish(self, tenant_id: str, user_id: str, kind: str, id: str) -> None:
        """Tell `user_id`'s sessions in `tenant_id` that this changed. Call it
        after the change has committed, and never wait on it."""
        ...


class UserChangeSubscription:
    """One open socket's pending notices, and the event that wakes it."""

    def __init__(self, feed: LocalUserChanges, key: tuple[str, str]) -> None:
        self._feed = feed
        self.key = key
        self.wake = asyncio.Event()
        # A dict as an ordered set: notices go out in the order they came.
        self._pending: dict[UserChange, None] = {}

    def _add(self, change: UserChange) -> None:
        # A pending "any of this kind" already covers this one.
        if UserChange(change.kind, None) in self._pending:
            self.wake.set()
            return
        self._pending[change] = None
        if len(self._pending) > _MAX_PENDING:
            kinds = dict.fromkeys(c.kind for c in self._pending)
            self._pending = {UserChange(kind, None): None for kind in kinds}
        self.wake.set()

    def drain(self) -> list[UserChange]:
        self.wake.clear()
        changes = list(self._pending)
        self._pending.clear()
        return changes

    def close(self) -> None:
        self._feed._unsubscribe(self)


class LocalUserChanges:
    """`UserChangePublisher` for one process, and the subscriptions it reaches."""

    def __init__(self) -> None:
        self._subscriptions: dict[tuple[str, str], set[UserChangeSubscription]] = {}

    def subscribe(self, tenant_id: str, user_id: str) -> UserChangeSubscription:
        key = (tenant_id, user_id)
        subscription = UserChangeSubscription(self, key)
        self._subscriptions.setdefault(key, set()).add(subscription)
        return subscription

    def _unsubscribe(self, subscription: UserChangeSubscription) -> None:
        held = self._subscriptions.get(subscription.key)
        if held is None:
            return
        held.discard(subscription)
        if not held:
            del self._subscriptions[subscription.key]

    def subscriber_count(self, tenant_id: str, user_id: str) -> int:
        return len(self._subscriptions.get((tenant_id, user_id), ()))

    def publish(self, tenant_id: str, user_id: str, kind: str, id: str) -> None:
        change = UserChange(kind, id)
        for subscription in self._subscriptions.get((tenant_id, user_id), ()):
            subscription._add(change)
