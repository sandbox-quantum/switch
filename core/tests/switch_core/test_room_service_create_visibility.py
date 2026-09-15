"""`create_room` validates the (read, write) visibility pair up front.

Regression for issue #453: `POST /rooms` accepted a visibility pair that
`update_room` (and every resource-create path) rejects — e.g. a misspelled
`read_visibility`, or `write_visibility=public` with a non-public
`read_visibility`, the invariant-violating combo `validate_visibility_pair`
exists to reject. A room stored that way could then only be repaired by a
PATCH, which itself refuses the stored value.

The check is the first thing `create_room` does, before any provisioning, so a
bare service (no stores, no bridge, no Matrix) is enough to exercise it — if the
pair is bad it must raise before touching any of that.
"""

from __future__ import annotations

import pytest

from switch_core.room_service import RoomCreateConfig, RoomService


async def test_create_room_rejects_invalid_read_visibility() -> None:
    svc = object.__new__(RoomService)
    with pytest.raises(ValueError, match="read_visibility"):
        await svc.create_room(
            RoomCreateConfig(name="Room", description="d", read_visibility="privat")
        )


async def test_create_room_rejects_writable_but_unreadable_pair() -> None:
    svc = object.__new__(RoomService)
    with pytest.raises(ValueError, match="write_visibility=public"):
        await svc.create_room(
            RoomCreateConfig(
                name="Room",
                description="d",
                read_visibility="private",
                write_visibility="public",
            )
        )
