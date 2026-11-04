"""A person editing a post on Mattermost is passed on as an edit.

Mattermost sends `post_edited` on every agent bot's socket, and for changes
nobody typed as well (a pin, a link preview): only a post whose `edit_at` is
set was edited, and each edit is passed on once.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import InboundEdit

_PERSON = "person-user-id"
_AGENT_BOT = "agent-bot-user-id"


class _Users:
    def get_user(self, user_id: str) -> dict[str, object]:
        if user_id != _PERSON:
            raise AssertionError(f"looked up {user_id!r}, not a person")
        return {"id": _PERSON, "username": "ada"}


def _adapter() -> tuple[MattermostAdapter, list[InboundEdit]]:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )
    adapter._admin_driver = type("_Driver", (), {"users": _Users()})()  # type: ignore[assignment]
    adapter._bridge_bot_ids.add(_AGENT_BOT)
    edits: list[InboundEdit] = []

    async def record(edit: InboundEdit) -> None:
        edits.append(edit)

    adapter.set_edit_handler(record)
    return adapter, edits


def _deliver(adapter: MattermostAdapter, post: dict[str, Any]) -> None:
    loop = asyncio.new_event_loop()
    dispatched: list[Any] = []
    adapter._main_loop = loop
    adapter._dispatch = lambda coro, _loop: dispatched.append(coro)  # type: ignore[method-assign]
    event = {"event": "post_edited", "data": {"post": json.dumps(post)}}
    try:
        loop.run_until_complete(adapter._ws_handler(json.dumps(event), "some-agent"))
        for coro in dispatched:
            loop.run_until_complete(coro)
    finally:
        loop.close()


def _post(**fields: Any) -> dict[str, Any]:
    return {
        "id": "post-1",
        "user_id": _PERSON,
        "channel_id": "channel-1",
        "root_id": "",
        "message": "fix the typo in README",
        "edit_at": 1_700_000_000_500,
        "props": {},
        **fields,
    }


def test_a_persons_edit_is_passed_on() -> None:
    adapter, edits = _adapter()

    _deliver(adapter, _post(root_id="root-post"))

    assert edits == [
        InboundEdit(
            channel_id="channel-1",
            sender_id=_PERSON,
            sender_name="ada",
            content="fix the typo in README",
            message_ref="post-1",
            root_id="root-post",
            edited_at=1_700_000_000_500,
        )
    ]


def test_each_edit_is_passed_on_once_whichever_socket_delivers_it() -> None:
    adapter, edits = _adapter()

    _deliver(adapter, _post())
    _deliver(adapter, _post())
    _deliver(
        adapter, _post(message="fix the typo in README.md", edit_at=1_700_000_009_000)
    )

    assert [edit.content for edit in edits] == [
        "fix the typo in README",
        "fix the typo in README.md",
    ]


def test_a_change_nobody_typed_is_not_an_edit() -> None:
    adapter, edits = _adapter()

    _deliver(adapter, _post(edit_at=0))

    assert edits == []


def test_the_bridges_own_posts_are_not_passed_on() -> None:
    """Its bots edit their activity and cards all the time."""
    adapter, edits = _adapter()

    _deliver(adapter, _post(user_id=_AGENT_BOT))

    assert edits == []


def test_system_and_webhook_posts_are_not_passed_on() -> None:
    adapter, edits = _adapter()

    _deliver(adapter, _post(type="system_join_channel"))
    _deliver(adapter, _post(id="post-2", props={"from_webhook": "true"}))

    assert edits == []
