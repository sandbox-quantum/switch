"""`!remove-user`: the room's owner or an admin takes a person out (CHOO-4255)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from switch_core.bridges.agent.commands import COMMANDS_BY_NAME, _cmd_remove_user
from switch_core.room_service import RemovalMiss
from tests.switch_core.bridges.agent.test_commands_remove_agent import (
    _ALICE,
    _CAROL,
    _Harness,
    _person,
)


class _People:
    def __init__(self, misses: list[RemovalMiss]) -> None:
        self.misses = misses
        self.calls: list[tuple[str, list[str], str]] = []

    async def remove_users_from_room(
        self, room_id: str, user_names: list[str], *, removed_by: str
    ) -> list[RemovalMiss]:
        self.calls.append((room_id, user_names, removed_by))
        return self.misses


def _harness(
    monkeypatch: pytest.MonkeyPatch,
    sender: str,
    *,
    misses: list[RemovalMiss] | None = None,
    admins: set[str] = frozenset(),  # type: ignore[assignment]
) -> tuple[_Harness, _People]:
    h = _Harness(
        monkeypatch,
        allowed=False,
        principal=_person(sender),
        agents={},
        room_agent_ids=[],
        admins=admins,
    )
    people = _People(misses or [])
    h.client._room_service = people
    return h, people


async def _run(h: _Harness, args: str) -> None:
    event = SimpleNamespace(
        command="remove-user",
        args=args,
        thread_id=None,
        user_id="@sender:x",
        user_name="carol",
    )
    await _cmd_remove_user(
        h.client,  # type: ignore[arg-type]
        SimpleNamespace(room_id="!m:x"),  # type: ignore[arg-type]
        event,  # type: ignore[arg-type]
        False,
    )


def test_is_registered_as_an_admin_command_with_a_required_person() -> None:
    cmd = COMMANDS_BY_NAME["remove-user"]
    assert cmd.admin_owned
    assert [arg.required for arg in cmd.args_spec] == [True]


async def test_the_rooms_owner_removes_a_person(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    h, people = _harness(monkeypatch, _CAROL)

    await _run(h, "@bob")

    assert people.calls == [("room-1", ["bob"], "carol")]
    assert h.posted == ["Removed **bob**."]


async def test_a_workspace_admin_removes_a_person(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    h, people = _harness(monkeypatch, _ALICE, admins={_ALICE})

    await _run(h, "@bob")

    assert [names for _, names, _ in people.calls] == [["bob"]]


async def test_someone_else_in_the_room_may_not(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    h, people = _harness(monkeypatch, _ALICE)

    await _run(h, "@bob")

    assert people.calls == []
    assert len(h.posted) == 1
    assert "owner" in h.posted[0]


async def test_says_who_did_not_go_as_asked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    h, _ = _harness(
        monkeypatch,
        _CAROL,
        misses=[
            RemovalMiss(name="dave", reason="platform_refused"),
            RemovalMiss(name="ghost", reason="not_in_room"),
        ],
    )

    await _run(h, "@bob @dave @ghost")

    [reply] = h.posted
    assert "Removed **bob**." in reply
    assert "Could not remove **dave**" in reply
    assert "Remove them from the channel itself" in reply
    assert "Nobody in this room goes by `ghost`." in reply


async def test_without_a_name_says_how(monkeypatch: pytest.MonkeyPatch) -> None:
    h, people = _harness(monkeypatch, _CAROL)

    await _run(h, "")

    assert people.calls == []
    assert h.posted[0].startswith("Usage: `!remove-user @username`")
