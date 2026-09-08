"""Where a projection gets its snapshot and its events.

Everything downstream — the projection, the renderers, the Slack call — is
driven through this seam, so where a session's state comes from is the only
thing a new backing has to supply. One implementation replays recorded
fixtures, which is also how the whole path is tested.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterable, Sequence
from pathlib import Path
from typing import Any, Protocol

from .contract import ServerEvent, Snapshot, parse_server_event, parse_snapshot
from .projection import SessionProjection


class SessionEventSource(Protocol):
    """A session's state and the deltas that follow it."""

    async def snapshot(self, session_id: str) -> Snapshot:
        """The session as of `throughSequence`, with every page already merged."""
        ...

    def subscribe(self, session_id: str, after: int) -> AsyncIterator[ServerEvent]:
        """Events after `after`, in sequence order. Gaps are legal."""
        ...


class FixtureEventSource:
    """Replays a recorded snapshot and event stream.

    The recording is the same `examples.json` the TypeScript side tests against,
    so a fixture that stops parsing here is a fixture that changed shape.
    """

    def __init__(
        self, snapshot: Any, events: Sequence[Any], *, session_id: str
    ) -> None:
        self._snapshot = parse_snapshot(snapshot)
        self._events = [parse_server_event(event) for event in events]
        self._session_id = session_id

    @classmethod
    def from_examples(cls, path: Path, *, events: Iterable[str]) -> FixtureEventSource:
        """Build from `examples.json`, naming which of its streams to replay.

        `events` names top-level keys; a key holding a single event is replayed
        as a stream of one, which is how the file records `cancelledQuestion`.
        """
        recorded = json.loads(path.read_text())
        stream: list[Any] = []
        for key in events:
            value = recorded[key]
            stream.extend(value if isinstance(value, list) else [value])
        stream.sort(key=lambda event: event["sequence"])
        return cls(
            recorded["initialSnapshot"],
            stream,
            session_id=recorded["initialSnapshot"]["session"]["sessionId"],
        )

    async def snapshot(self, session_id: str) -> Snapshot:
        self._require(session_id)
        return self._snapshot

    async def subscribe(
        self, session_id: str, after: int
    ) -> AsyncIterator[ServerEvent]:
        self._require(session_id)
        for event in self._events:
            if event.sequence > after:
                yield event

    def _require(self, session_id: str) -> None:
        if session_id != self._session_id:
            raise ValueError(f"Fixture holds {self._session_id!r}, not {session_id!r}.")


async def project(source: SessionEventSource, session_id: str) -> SessionProjection:
    """Load a session and fold in everything the source has for it."""
    projection = SessionProjection(await source.snapshot(session_id))
    async for event in source.subscribe(session_id, projection.through_sequence):
        projection.apply(event)
    return projection
