"""One session's state, and what a room is allowed to see of it.

The fold is a port of `SessionReplica` in
`console/packages/shared/src/session-v1/replica.ts`: snapshot plus sequenced
deltas, deduplicated by revision, tolerant of the sequence gaps a permission
filter leaves behind. Everything the contract carries is folded, so nothing is
dropped on the floor; what this layer adds on top is the audience gate.

`audience` is access, not placement. It answers whether something may reach a
room at all — a `session-members` audience never does, because no messaging
platform has a surface that means "session members only": Slack's expandable
detail on an assistant message is visible to everyone in the channel. Which
surface a publishable thing lands on is a separate decision, made from
`Item.kind`, and it is not an access decision.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar

from .contract import (
    CommandStatus,
    DecidedBy,
    ItemUpsert,
    Notice,
    RequestOpened,
    RequestSettled,
    RequestSubmitting,
    RoomAudience,
    ServerEvent,
    SessionConnectivity,
    SessionUpsert,
    Snapshot,
    SnapshotRequest,
    TurnUpsert,
)

T = TypeVar("T")


class SessionProjection:
    """A per-session replica, read through an audience gate."""

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
                    "decided_by": request.decided_by if answered else None,
                }
            ),
            lambda x: x.request_id,
        )

    # ── The audience gate ────────────────────────────────────────────────────

    def room_requests(self, room_id: str) -> list[SnapshotRequest]:
        """Requests this room may be shown, in the order they were opened.

        A `session-members` audience is absent by construction, and a request
        addressed to another room is not this room's business either.
        """
        return [
            request
            for request in self._value.requests
            if isinstance(request.audience, RoomAudience)
            and request.audience.room_id == room_id
        ]

    def open_room_requests(self, room_id: str) -> list[SnapshotRequest]:
        """Those of them still waiting on someone."""
        return [
            request
            for request in self.room_requests(room_id)
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
