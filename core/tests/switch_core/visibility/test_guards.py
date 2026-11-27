"""The role guards: only Core's operator list makes an operator, the operator
list and the admin bit open no workspace admin route, and a user acts only on
their own things."""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from switch_core.tenant_context import tenant_scope
from switch_core.visibility import guards
from switch_core.visibility.operators import OperatorList


def _user(user_id: str, role: str = "user") -> SimpleNamespace:
    return SimpleNamespace(id=user_id, role=role)


class _Recorder:
    """Stands in for the log: records what each list change would write."""

    def __init__(self) -> None:
        self.calls: list[frozenset[str]] = []
        self.warned: list[frozenset[str]] = []
        self.grant = False


@pytest.fixture
def recorded(monkeypatch: pytest.MonkeyPatch) -> _Recorder:
    rec = _Recorder()

    async def fake(
        _factory: object, ids: frozenset[str]
    ) -> tuple[frozenset, frozenset]:
        rec.calls.append(ids)
        return (ids if rec.grant else frozenset()), frozenset()

    async def fake_warn(_factory: object, ops: OperatorList) -> None:
        rec.warned.append(ops.snapshot().ids)

    monkeypatch.setattr(guards, "record_operator_list", fake)
    monkeypatch.setattr(guards, "warn_if_operators_hold_admin", fake_warn)
    guards._recorded.clear()
    return rec


def _list(tmp_path: Path, ids: list[str]) -> OperatorList:
    path = tmp_path / "operators.json"
    path.write_text(json.dumps({"operators": ids}))
    os.chmod(path, 0o600)
    return OperatorList(path)


async def test_the_deployment_admin_bit_does_not_make_an_operator(
    tmp_path: Path, recorded: _Recorder
) -> None:
    ops = _list(tmp_path, ["u1"])
    with pytest.raises(HTTPException) as exc:
        await guards.require_operator(_user("boss", "admin"), ops, None)  # type: ignore[arg-type]
    assert exc.value.status_code == 403
    user = _user("u1")
    assert await guards.require_operator(user, ops, None) is user  # type: ignore[arg-type]


async def test_unwired_means_no_operators(recorded: _Recorder) -> None:
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
    ops = guards.get_operator_list(request)  # type: ignore[arg-type]
    with pytest.raises(HTTPException):
        await guards.require_operator(_user("u1"), ops, None)  # type: ignore[arg-type]


async def test_a_removal_takes_effect_and_is_recorded_first(
    tmp_path: Path, recorded: _Recorder
) -> None:
    ops = _list(tmp_path, ["u1", "u2"])
    await guards.require_operator(_user("u2"), ops, None)  # type: ignore[arg-type]
    await guards.require_operator(_user("u1"), ops, None)  # type: ignore[arg-type]
    # One change of the file, one write to the log.
    assert recorded.calls == [frozenset({"u1", "u2"})]
    path = tmp_path / "operators.json"
    path.write_text(json.dumps({"operators": ["u1"]}))
    with pytest.raises(HTTPException):
        await guards.require_operator(_user("u2"), ops, None)  # type: ignore[arg-type]
    assert recorded.calls == [frozenset({"u1", "u2"}), frozenset({"u1"})]


def test_require_own_hides_other_peoples_things() -> None:
    guards.require_own(_user("u1"), "u1")  # type: ignore[arg-type]
    for owner in ("u2", None):
        with pytest.raises(HTTPException) as exc:
            guards.require_own(_user("u1"), owner)  # type: ignore[arg-type]
        assert exc.value.status_code == 404
    # No admin bypass on a user's own things.
    with pytest.raises(HTTPException):
        guards.require_own(_user("boss", "admin"), "u1")  # type: ignore[arg-type]


class _Store:
    def __init__(self, roles: dict[tuple[str, str], str]) -> None:
        self.roles = roles

    async def tenant_role(
        self, session: object, tenant_id: str, user_id: str
    ) -> str | None:
        return self.roles.get((tenant_id, user_id))


class _Session:
    async def commit(self) -> None:
        pass


async def test_workspace_admins_pass_by_membership() -> None:
    # Main merged the workspace `owner` role into `admin` (a3c5e7f9b1d2), so
    # `admin` is the one role that administers a workspace.
    store = _Store({("ws-a", "u1"): "admin"})
    with tenant_scope("ws-a"):
        user = _user("u1")
        assert await guards.require_workspace_admin(_Session(), user, store) is user  # type: ignore[arg-type]


async def test_the_operator_bit_does_not_open_a_workspace_admin_route() -> None:
    """An operator must not reach a workspace's People or Activity
    tab, where names show with no reason and no audit entry."""
    store = _Store({})
    with tenant_scope("ws-a"), pytest.raises(HTTPException) as exc:
        await guards.require_workspace_admin(_Session(), _user("op", "admin"), store)  # type: ignore[arg-type]
    assert exc.value.status_code == 403


async def test_members_and_other_workspaces_admins_are_refused() -> None:
    store = _Store({("ws-a", "u1"): "member", ("ws-b", "u2"): "admin"})
    with tenant_scope("ws-a"):
        for user_id in ("u1", "u2"):
            with pytest.raises(HTTPException):
                await guards.require_workspace_admin(_Session(), _user(user_id), store)  # type: ignore[arg-type]


async def test_no_bound_workspace_is_refused() -> None:
    with pytest.raises(HTTPException):
        await guards.require_workspace_admin(_Session(), _user("u1"), _Store({}))  # type: ignore[arg-type]


async def test_a_new_grant_reruns_the_admin_overlap_check(
    tmp_path: Path, recorded: _Recorder
) -> None:
    recorded.grant = True
    ops = _list(tmp_path, ["u1"])
    await guards.require_operator(_user("u1"), ops, None)  # type: ignore[arg-type]
    assert recorded.warned == [frozenset({"u1"})]
    # No change to the file, no second check.
    await guards.require_operator(_user("u1"), ops, None)  # type: ignore[arg-type]
    assert recorded.warned == [frozenset({"u1"})]


async def test_access_is_checked_against_the_list_that_was_logged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the file changes while a grant is being logged, the request is
    answered from the logged list, so nobody acts on an unlogged grant."""
    ops = _list(tmp_path, ["u1"])
    path = tmp_path / "operators.json"

    async def record_then_change(
        _factory: object, ids: frozenset[str]
    ) -> tuple[frozenset, frozenset]:
        path.write_text(json.dumps({"operators": ["u1", "u2-added-late"]}))
        return ids, frozenset()

    async def no_warn(_factory: object, _ops: OperatorList) -> None:
        return None

    monkeypatch.setattr(guards, "record_operator_list", record_then_change)
    monkeypatch.setattr(guards, "warn_if_operators_hold_admin", no_warn)
    guards._recorded.clear()
    with pytest.raises(HTTPException):
        await guards.require_operator(_user("u2-added-late"), ops, None)  # type: ignore[arg-type]
