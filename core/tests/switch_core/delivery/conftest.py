from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tests.switch_core.delivery.world import World, make_world


@pytest.fixture
async def world(session_factory: async_sessionmaker[AsyncSession]) -> World:
    return await make_world(session_factory)
