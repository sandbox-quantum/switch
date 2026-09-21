"""`create_room` validates the visibility pair, like every other create path.

Issue #453: `RoomService.create_room` never called `validate_visibility_pair`,
so `POST /rooms` accepted a bogus `read_visibility` or the invariant-violating
`write_visibility="public"` with `read_visibility="private"` — a room that only
a PATCH could repair, and a PATCH would then refuse the stored value.

The validation runs at the very top of `create_room`, before any provisioning,
so exercising it needs no bridge, Matrix, or database — a bad config must raise
`ValueError` (which `gateway/rooms.py` maps to HTTP 400) before anything else.
"""

from __future__ import annotations

import pytest

from switch_core.room_service import RoomCreateConfig, RoomService


async def test_create_room_rejects_unknown_read_visibility() -> None:
    svc = object.__new__(RoomService)
    with pytest.raises(ValueError, match="read_visibility"):
        await svc.create_room(
            RoomCreateConfig(name="R", description="d", read_visibility="privat")
        )


async def test_create_room_rejects_writable_but_unreadable() -> None:
    svc = object.__new__(RoomService)
    with pytest.raises(ValueError, match="write_visibility=public"):
        await svc.create_room(
            RoomCreateConfig(
                name="R",
                description="d",
                read_visibility="private",
                write_visibility="public",
            )
        )
