"""Input checks in the audit writer that refuse before anything is written."""

from __future__ import annotations

import pytest

from switch_core.db.audit import ServerAuditAction
from switch_core.visibility.audit_log import (
    MAX_WORKSPACE_COPIES,
    AuditInputError,
    record_operator_request,
)
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind

KEY = KeyedIdKey(b"a-made-up-test-key-of-thirty-two-bytes-or-more", "k1")


def _never() -> object:
    raise AssertionError("nothing should be written")


def _ws(raw: str) -> tuple[str, str]:
    return raw, KEY.keyed_id(KeyedIdKind.WORKSPACE, raw)


@pytest.mark.parametrize(
    "workspaces",
    [
        [_ws("a"), _ws("a")],
        [("a", "Ada's workspace")],
        [("", KEY.keyed_id(KeyedIdKind.WORKSPACE, "x"))],
        [_ws(f"w{i}") for i in range(MAX_WORKSPACE_COPIES + 1)],
    ],
)
async def test_bad_workspace_lists_are_refused(
    workspaces: list[tuple[str, str]],
) -> None:
    with pytest.raises(AuditInputError):
        await record_operator_request(
            _never,  # type: ignore[arg-type]
            actor_user_id="op-1",
            action=ServerAuditAction.HOSTED_USER_PAUSED,
            target_type="user",
            target_keyed_id=KEY.keyed_id(KeyedIdKind.USER, "u"),
            reason="r",
            workspaces=workspaces,
        )


async def test_the_single_and_list_forms_cant_name_one_workspace_twice() -> None:
    with pytest.raises(AuditInputError):
        await record_operator_request(
            _never,  # type: ignore[arg-type]
            actor_user_id="op-1",
            action=ServerAuditAction.HOSTED_USER_PAUSED,
            target_type="user",
            target_keyed_id=KEY.keyed_id(KeyedIdKind.USER, "u"),
            reason="r",
            workspace_id="a",
            workspace_keyed_id=_ws("a")[1],
            workspaces=[_ws("a")],
        )
