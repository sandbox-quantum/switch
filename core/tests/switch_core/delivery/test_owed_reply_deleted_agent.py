"""What a row leaves an agent to say, when the agent is deleted meanwhile.

The work runs after the row commits, and only while the agent is a member.
With several processes, the agent can be deleted on another one between that
check and the work's own write, which then finds no agent to write as.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.exc import IntegrityError

from switch_core.delivery.router import _bind


def _recipient(*, member_after: bool) -> Any:
    answers = iter([True, member_after])

    async def still_member() -> bool:
        return next(answers)

    async def connect() -> None:
        return None

    return SimpleNamespace(
        agent=SimpleNamespace(name="helper"),
        actor=SimpleNamespace(connect=connect),
        still_member=still_member,
    )


async def _write_refused(row: Any) -> None:
    raise IntegrityError("INSERT INTO messages", {}, Exception("fk_messages_sender"))


_ROW = SimpleNamespace(room_id="room-1", event_id="event-1")


def test_an_agent_deleted_before_its_write_says_nothing_and_raises_nothing() -> None:
    run = _bind(_recipient(member_after=False), _write_refused, _ROW)  # type: ignore[arg-type]
    asyncio.run(run())


def test_a_refused_write_by_an_agent_still_in_the_room_is_raised() -> None:
    run = _bind(_recipient(member_after=True), _write_refused, _ROW)  # type: ignore[arg-type]
    with pytest.raises(IntegrityError):
        asyncio.run(run())
