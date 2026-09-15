from __future__ import annotations

import pytest

from switch_core.room_service import RoomCreateConfig, RoomService

# `create_room` must validate its (read, write) visibility pair, the same way
# `update_room` and every resource create path do. Without it `POST /rooms`
# would accept a bogus value (e.g. "privat", which `authz.can` then treats as
# never-public) or the invariant-violating public-write/private-read pair —
# a room only a subsequent PATCH could repair, which would itself refuse the
# stored value. The check is the first thing `create_room` does, so it raises
# before any Matrix room or external channel is provisioned.


def _config(*, read_visibility: str, write_visibility: str) -> RoomCreateConfig:
    return RoomCreateConfig(
        name="R",
        description="d",
        agent_ids=["a1"],
        read_visibility=read_visibility,
        write_visibility=write_visibility,
    )


async def test_create_room_rejects_unknown_visibility() -> None:
    cfg = _config(read_visibility="privat", write_visibility="private")
    with pytest.raises(ValueError, match="Invalid read_visibility"):
        await RoomService.create_room(object.__new__(RoomService), cfg)


async def test_create_room_rejects_public_write_private_read() -> None:
    cfg = _config(read_visibility="private", write_visibility="public")
    with pytest.raises(ValueError, match="write_visibility=public requires"):
        await RoomService.create_room(object.__new__(RoomService), cfg)
