from __future__ import annotations

import pytest

from switch_core.room_service import RoomCreateConfig, RoomService

# `create_room` must reject a bad (read, write) visibility pair the same way
# `update_room` and the resource create paths do. A bad value accepted here is
# stored permanently: the only repair is a PATCH, which `update_room` would
# itself refuse.


def _config(*, read: str, write: str) -> RoomCreateConfig:
    return RoomCreateConfig(
        name="R",
        description="d",
        agent_ids=["a1"],
        read_visibility=read,
        write_visibility=write,
    )


async def test_create_room_rejects_unknown_visibility() -> None:
    svc = object.__new__(RoomService)

    with pytest.raises(ValueError, match="Invalid read_visibility 'privat'"):
        await svc.create_room(_config(read="privat", write="private"))


async def test_create_room_rejects_public_write_with_private_read() -> None:
    svc = object.__new__(RoomService)

    with pytest.raises(ValueError, match="requires read_visibility=public"):
        await svc.create_room(_config(read="private", write="public"))
