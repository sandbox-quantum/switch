"""`RoomService`'s telemetry helpers must not turn "the lookup failed" into a
value that looks like a real answer.

`_bridge_platform` used to return `"none"` — the same value an internal-only
room reports — for a lookup that raised, and `_was_ever_active` used to return
`False` — the same value a room with no activity reports — for a count that
raised. Both are read only when building `room_created`/`room_deleted`/
`room_archived`, so a transient database error at exactly the wrong moment
silently relabelled a Slack-bridged, actively-used room as an internal-only
room nobody ever spoke in. No real database is needed to exercise the failure
path: a session factory that fails on entry reproduces it directly.
"""

from __future__ import annotations

from types import TracebackType

from switch_core.room_service import RoomService


class _BrokenSession:
    """Fails on entry, the way a lost connection or a locked table would."""

    async def __aenter__(self) -> _BrokenSession:
        raise RuntimeError("database unreachable")

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> bool:
        return False


def _broken_session_factory() -> _BrokenSession:
    return _BrokenSession()


def _room_service() -> RoomService:
    """Only `_session_factory` and `_telemetry` are exercised by the methods
    under test; everything else is unreachable once the session fails."""
    return RoomService(
        matrix_admin=None,  # type: ignore[arg-type]
        room_store=None,  # type: ignore[arg-type]
        agent_store=None,  # type: ignore[arg-type]
        client_lifecycle=None,  # type: ignore[arg-type]
        collab_lifecycle=None,  # type: ignore[arg-type]
        collab_bridge_store=None,  # type: ignore[arg-type]
        resource_service=None,  # type: ignore[arg-type]
        session_factory=_broken_session_factory,  # type: ignore[arg-type]
        telemetry=object(),  # type: ignore[arg-type]
    )


class TestBridgePlatformReportsUnknownOnFailure:
    async def test_a_failed_lookup_is_unknown_not_none(self) -> None:
        """`none` means "no bridge"; a failed lookup must not say the same
        thing about a room that has one."""
        service = _room_service()

        result = await service._bridge_platform("bridge-1")

        assert result == "unknown"

    async def test_no_bridge_id_is_still_none(self) -> None:
        """The two cases must stay distinguishable in both directions: a
        genuinely internal-only room is not reported as unknown either."""
        service = _room_service()

        result = await service._bridge_platform(None)

        assert result == "none"


class TestWasEverActiveReportsUnknownOnFailure:
    async def test_a_failed_lookup_is_unknown_not_false(self) -> None:
        """A count that could not run is not evidence the room was never
        used — the exact fact this property exists to carry."""
        service = _room_service()

        result = await service._was_ever_active("tenant-1", "room-1")

        assert result == "unknown"
