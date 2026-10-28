"""A session factory that counts the sessions opened through it, for tests
that pin how many pool checkouts a path costs. One session is one checkout."""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


class CountingSessionFactory:
    """The real factory, counting the sessions opened through it."""

    def __init__(self, inner: async_sessionmaker[AsyncSession]) -> None:
        self._inner = inner
        self.opened = 0

    def __call__(self) -> Any:
        self.opened += 1
        return self._inner()
