"""One session's state, as a room reads it.

The fold is a port of `SessionReplica` in
`console/packages/shared/src/session-v1/replica.ts`: snapshot plus sequenced
deltas, deduplicated by revision, tolerant of the sequence gaps a permission
filter leaves behind. Everything the contract carries is folded, so nothing is
dropped on the floor.

Nothing here decides where anything goes. The contract used to carry the room a
request was addressed to, and that was the only thing in it naming a
destination; it is being removed, because which people see a session's request
is Switch's decision to make from the session's agent and the rooms it is in,
and not one a host is in any position to take. So this reads a session, and the
bridge above it chooses where what it reads is published.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar

from .contract import (
    CommandStatus,
    DecidedBy,
    Item,
    ItemUpsert,
    Notice,
    RequestOpened,
    RequestSettled,
    RequestSubmitting,
    ServerEvent,
    SessionConnectivity,
    SessionUpsert,
    Snapshot,
    SnapshotRequest,
    TurnUpsert,
)

T = TypeVar("T")


class SessionProjection:
    """A per-session replica: everything the session said, folded in order."""

    def __init__(self, snapshot: Snapshot) -> None:
        if snapshot.next_page_token is not None:
            raise ValueError("Load all snapshot pages before replay.")
        self._value = snapshot
        self.notices: list[Notice] = []

    @property
    def snapshot(self) -> Snapshot:
        return self._value

    @property
    def through_sequence(self) -> int:
        return self._value.through_sequence

    # ── The fold ─────────────────────────────────────────────────────────────

    def apply(self, event: ServerEvent) -> bool:
        """Fold one server event in. False when it was already accounted for."""
        if event.session_id != self._value.session.session_id:
            raise ValueError("Event belongs to another session.")
        if event.sequence <= self._value.through_sequence:
            return False

        body = event.body
        if isinstance(body, SessionUpsert):
            if body.session.session_id != event.session_id:
                raise ValueError("Session identity mismatch.")
            if body.session.epoch != self._value.session.epoch:
                raise ValueError("STALE_EPOCH: reload the snapshot.")
            self._value = self._value.model_copy(update={"session": body.session})
        elif isinstance(body, SessionConnectivity):
            self._amend_session(connectivity=body.connectivity)
        elif isinstance(body, TurnUpsert):
            self._upsert("turns", body, lambda turn: turn.turn_id)
        elif isinstance(body, ItemUpsert):
            self._apply_item(body)
        elif isinstance(body, RequestOpened):
            self._apply_request_opened(body)
        elif isinstance(body, RequestSubmitting):
            self._apply_request_submitting(body)
        elif isinstance(body, RequestSettled):
            self._apply_request_settled(body)
        elif isinstance(body, CommandStatus):
            self._upsert("command_statuses", body, lambda status: status.command_id)
        elif isinstance(body, Notice):
            self.notices.append(body)
        # command.result is deliberately not folded: only the server confirms
        # the status of a command shared between surfaces.

        self._amend_session(
            pending_request_ids=[
                request.request_id
                for request in self._value.requests
                if request.state in ("open", "submitting")
            ]
        )
        self._value = self._value.model_copy(
            update={"through_sequence": event.sequence}
        )
        return True

    def _apply_item(self, body: ItemUpsert) -> None:
        previous = next(
            (x for x in self._value.items if x.item_id == body.item.item_id), None
        )
        if (
            previous is not None
            and previous.revision == body.item.revision
            and previous != body.item
        ):
            raise ValueError("Conflicting item revision.")
        if previous is None or previous.revision < body.item.revision:
            self._upsert("items", body.item, lambda item: item.item_id)

    def _apply_request_opened(self, body: RequestOpened) -> None:
        previous = self.request(body.request.request_id)
        if previous is not None and previous.revision >= body.request.revision:
            return
        opened = SnapshotRequest.model_validate(
            {
                **body.request.model_dump(by_alias=True),
                "result": None,
                "decidedBy": None,
            }
        )
        self._upsert("requests", opened, lambda request: request.request_id)

    def _apply_request_submitting(self, body: RequestSubmitting) -> None:
        request = self.request(body.request_id)
        if request is None or request.revision != body.revision:
            return
        if request.state != "open":
            return
        decided_by = DecidedBy(
            actor_id=body.actor_id, surface=body.surface, command_id=body.command_id
        )
        self._upsert(
            "requests",
            request.model_copy(
                update={"state": "submitting", "decided_by": decided_by}
            ),
            lambda x: x.request_id,
        )

    def _apply_request_settled(self, body: RequestSettled) -> None:
        request = self.request(body.request_id)
        if request is None or request.revision >= body.revision:
            return
        answered = body.outcome == "answered"
        self._upsert(
            "requests",
            request.model_copy(
                update={
                    "state": "resolved" if answered else "closed",
                    "revision": body.revision,
                    "result": body,
                    "decided_by": (
                        request.decided_by
                        if request.decided_by is not None
                        and request.decided_by.command_id == body.command_id
                        else None
                    ),
                }
            ),
            lambda x: x.request_id,
        )

    # ── What a turn did ──────────────────────────────────────────────────────

    def turn_activity(self, turn_id: str) -> list[Item]:
        """One turn's items, in the order the session first mentioned them.

        Fold order rather than revision order: an item that is revised in place
        keeps the position it had when it opened, so a tool that takes a minute
        does not jump to the end of the list when it finishes.
        """
        return [item for item in self._value.items if item.turn_id == turn_id]

    def turn(self, turn_id: str) -> TurnUpsert | None:
        """Return the current state of a turn, if known."""
        return next((x for x in self._value.turns if x.turn_id == turn_id), None)

    # ── What is waiting on someone ───────────────────────────────────────────

    def open_requests(self) -> list[SnapshotRequest]:
        """Every request still waiting on an answer, in the order it opened.

        Every one of them, deliberately: a session's requests are the session's,
        and picking which of them a given room is shown is a decision made above
        this, with knowledge this does not have.
        """
        return [
            request
            for request in self._value.requests
            if request.state in ("open", "submitting")
        ]

    def request(self, request_id: str) -> SnapshotRequest | None:
        return next(
            (x for x in self._value.requests if x.request_id == request_id), None
        )

    # ── Internals ────────────────────────────────────────────────────────────

    def _amend_session(self, **fields: object) -> None:
        self._value = self._value.model_copy(
            update={"session": self._value.session.model_copy(update=fields)}
        )

    def _upsert(self, field: str, value: T, key: Callable[[T], str]) -> None:
        values: list[T] = list(getattr(self._value, field))
        identity = key(value)
        for index, existing in enumerate(values):
            if key(existing) == identity:
                values[index] = value
                break
        else:
            values.append(value)
        self._value = self._value.model_copy(update={field: values})
