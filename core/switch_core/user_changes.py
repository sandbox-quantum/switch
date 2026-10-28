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

Each process holds its own Consoles' sockets, so a change committed in one
process has to reach every other. `LocalUserChanges` fans a notice out in
memory to the sockets this process holds. `SignalUserChanges` is what writers
are given: it hands each notice to this process's `LocalUserChanges` at once
and publishes it on the `SignalBus` (`switch_core.signals`), and every other
process hands what it hears to its own. Writers depend on
`UserChangePublisher` alone.

A notice that the bus loses (its sender died between the commit and the send,
or a receiver's listening connection was down) is not re-sent: there is
nothing in the database to compare a socket against. Instead, when a
process's listening connection comes back, every socket it holds is told that
everything of every kind changed, so its Console reads it all again, as it
would on reconnecting. That does not cover a notice that was never sent: the
writer pod died after its commit, or an older pod without this module made the
change during a rolling deploy. For those, Console also reads its lists again
every few minutes while the socket is up, which bounds how stale one can get.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from switch_core.signals import SignalBus

logger = logging.getLogger(__name__)

MANAGED_AGENT = "managed_agent"
MACHINE = "machine"
KINDS = (MANAGED_AGENT, MACHINE)

USER_CHANGED_SIGNAL = "user.changed"

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

    def publish_everything(self) -> None:
        """Tell every subscription here that anything of any kind may have
        changed: for when notices may have been missed."""
        everything = [UserChange(kind, None) for kind in KINDS]
        for held in self._subscriptions.values():
            for subscription in held:
                for change in everything:
                    subscription._add(change)


class SignalUserChanges:
    """`UserChangePublisher` for every process: a notice published in one
    reaches the subscriptions held in each of them."""

    def __init__(self, *, local: LocalUserChanges, bus: SignalBus) -> None:
        self._local = local
        self._bus = bus
        bus.handle(USER_CHANGED_SIGNAL, self._on_changed)
        bus.on_resync(self._resync)

    def publish(self, tenant_id: str, user_id: str, kind: str, id: str) -> None:
        # The bus skips a process's own signals, so this one is told here.
        self._local.publish(tenant_id, user_id, kind, id)
        self._bus.publish(
            USER_CHANGED_SIGNAL,
            tenant_id=tenant_id,
            user_id=user_id,
            # `kind` is the signal's own.
            change=kind,
            id=id,
        )

    def _on_changed(self, signal: dict[str, Any]) -> None:
        kind = signal.get("change")
        if kind not in KINDS:
            # A newer process may send kinds an older one does not know,
            # during a rolling deploy; its Console polls for those anyway.
            logger.debug("Ignoring a user change of unknown kind %r", kind)
            return
        self._local.publish(signal["tenant_id"], signal["user_id"], kind, signal["id"])

    async def _resync(self) -> None:
        self._local.publish_everything()
