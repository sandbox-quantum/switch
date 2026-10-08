"""In-process nudges to connected controllers.

Core runs as one process, so a nudge only has to reach the streams this
process holds. Each open stream subscribes; a change commits and then calls
one of the `ControllerNotifier` methods, which records the latest signal on
every subscription for that controller and wakes it.

A nudge carries no state the controller depends on. It says "pull again",
and every reconnect resyncs in full, so a nudge lost to a restart or to a
stream that was between connections costs a delay, never correctness. That
is also why signals coalesce: two assignment changes before the stream wakes
become one frame naming the later revision.
"""

from __future__ import annotations

import asyncio
from typing import Any

ASSIGNMENT_CHANGED = "assignment.changed"
OPERATION_PENDING = "operation.pending"
CREDENTIAL_REVOKED = "credential.revoked"
CONNECTION_STATE = "connection_state"


class ControllerSubscription:
    """One open stream's pending signals, and the event that wakes it."""

    def __init__(self, notifier: ControllerNotifier, controller_id: str) -> None:
        self._notifier = notifier
        self.controller_id = controller_id
        self.wake = asyncio.Event()
        self._assignment_revision: int | None = None
        self._operations: dict[str, dict[str, Any]] = {}
        self._revoked = False

    def _assignment_changed(self, revision: int) -> None:
        if self._assignment_revision is None or revision > self._assignment_revision:
            self._assignment_revision = revision
        self.wake.set()

    def _operation_pending(self, data: dict[str, Any]) -> None:
        self._operations[data["operation_id"]] = data
        self.wake.set()

    def _credential_revoked(self) -> None:
        self._revoked = True
        self.wake.set()

    def drain(self) -> list[tuple[str, dict[str, Any]]]:
        """Take every pending signal, in the order a controller should act on them.

        A revocation comes last: the controller stops everything on it, so
        anything after it would never be read.
        """
        self.wake.clear()
        frames: list[tuple[str, dict[str, Any]]] = []
        if self._assignment_revision is not None:
            frames.append((ASSIGNMENT_CHANGED, {"revision": self._assignment_revision}))
            self._assignment_revision = None
        for data in self._operations.values():
            frames.append((OPERATION_PENDING, data))
        self._operations.clear()
        if self._revoked:
            frames.append((CREDENTIAL_REVOKED, {}))
            self._revoked = False
        return frames

    def close(self) -> None:
        self._notifier._unsubscribe(self)


class ControllerNotifier:
    def __init__(self) -> None:
        self._subscriptions: dict[str, set[ControllerSubscription]] = {}

    def subscribe(self, controller_id: str) -> ControllerSubscription:
        subscription = ControllerSubscription(self, controller_id)
        self._subscriptions.setdefault(controller_id, set()).add(subscription)
        return subscription

    def _unsubscribe(self, subscription: ControllerSubscription) -> None:
        held = self._subscriptions.get(subscription.controller_id)
        if held is None:
            return
        held.discard(subscription)
        if not held:
            del self._subscriptions[subscription.controller_id]

    def subscriber_count(self, controller_id: str) -> int:
        return len(self._subscriptions.get(controller_id, ()))

    def assignment_changed(self, controller_id: str, revision: int) -> None:
        for subscription in self._subscriptions.get(controller_id, ()):
            subscription._assignment_changed(revision)

    def operation_pending(
        self, controller_id: str, *, operation_id: str, kind: str, agent_id: str | None
    ) -> None:
        data = {"operation_id": operation_id, "kind": kind, "agent_id": agent_id}
        for subscription in self._subscriptions.get(controller_id, ()):
            subscription._operation_pending(data)

    def credential_revoked(self, controller_id: str) -> None:
        for subscription in self._subscriptions.get(controller_id, ()):
            subscription._credential_revoked()
