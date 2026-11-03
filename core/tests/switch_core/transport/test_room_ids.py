"""The room ids a process's transports share: every open room of a tenant
read at once, by whichever transport misses first, and only once."""

from __future__ import annotations

import asyncio

import pytest

from switch_core.transport.postgres import RoomIds


async def test_transports_missing_together_read_the_rooms_once() -> None:
    ids = RoomIds()
    reads = 0
    release = asyncio.Event()

    async def read() -> list[tuple[str, str]]:
        nonlocal reads
        reads += 1
        await release.wait()
        return [("!a:test", "room-a")]

    first = asyncio.ensure_future(ids.of_tenant("t1").read_all_once(read))
    second = asyncio.ensure_future(ids.of_tenant("t1").read_all_once(read))
    await asyncio.sleep(0)
    release.set()
    await asyncio.gather(first, second)
    await ids.of_tenant("t1").read_all_once(read)

    assert reads == 1
    assert ids.of_tenant("t1").get("!a:test") == "room-a"


async def test_each_tenant_has_its_own_rooms() -> None:
    ids = RoomIds()

    async def read() -> list[tuple[str, str]]:
        return [("!a:test", "room-a")]

    await ids.of_tenant("t1").read_all_once(read)

    assert ids.of_tenant("t2").get("!a:test") is None


async def test_a_read_that_failed_is_tried_again() -> None:
    ids = RoomIds()
    failed = False

    async def read() -> list[tuple[str, str]]:
        nonlocal failed
        if not failed:
            failed = True
            raise ConnectionError("the pool timed out")
        return [("!a:test", "room-a")]

    with pytest.raises(ConnectionError):
        await ids.of_tenant("t1").read_all_once(read)
    await ids.of_tenant("t1").read_all_once(read)

    assert ids.of_tenant("t1").get("!a:test") == "room-a"
