from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from switch_core.room_service import RoomCreateConfig, RoomService


@pytest.mark.parametrize(
    ("read_vis", "write_vis", "match"),
    [
        ("privat", "private", "Invalid read_visibility 'privat'"),
        ("private", "privat", "Invalid write_visibility 'privat'"),
        ("private", "public", "write_visibility=public requires read_visibility=public"),
    ],
)
async def test_create_room_rejects_invalid_visibility_pair(
    read_vis: str, write_vis: str, match: str
) -> None:
    service = MagicMock(spec=RoomService)
    # Bind the unbound method to the mock instance
    service.create_room = RoomService.create_room.__get__(service, RoomService)

    config = RoomCreateConfig(
        name="test-room",
        description="test room",
        read_visibility=read_vis,
        write_visibility=write_vis,
    )

    with pytest.raises(ValueError, match=match):
        await service.create_room(config)
