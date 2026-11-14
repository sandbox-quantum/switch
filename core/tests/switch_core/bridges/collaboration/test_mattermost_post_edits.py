"""Mattermost's `post_edited` events: a person's edit goes to the edit callback
once, however many of the bridge's bot sockets report it."""

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
_BOT_ACCOUNT = "jira-bot-user-id"


class _Users:
    def get_user(self, user_id: str) -> dict[str, object]:
        if user_id == _BOT_ACCOUNT:
            return {"id": _BOT_ACCOUNT, "username": "jira", "is_bot": True}
        return {"id": user_id, "username": "ada"}


def _adapter() -> tuple[MattermostAdapter, list[InboundEdit], list[Any]]:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm", admin_user="admin", admin_password="pw", team_name="team"
        )
    )
    adapter._admin_driver = type("_Driver", (), {"users": _Users()})()  # type: ignore[assignment]
    edits: list[InboundEdit] = []
    messages: list[Any] = []

    async def on_edit(edit: InboundEdit) -> None:
        edits.append(edit)

    async def on_message(msg: Any) -> None:
        messages.append(msg)

    adapter.set_edit_handler(on_edit)
    adapter._on_message = on_message
    return adapter, edits, messages


def _deliver(adapter: MattermostAdapter, *events: dict[str, Any]) -> None:
    loop = asyncio.new_event_loop()
    dispatched: list[Any] = []
    adapter._main_loop = loop
    adapter._dispatch = lambda coro, _loop: dispatched.append(coro)  # type: ignore[method-assign]
    try:
        for event in events:
            loop.run_until_complete(
                adapter._ws_handler(json.dumps(event), "some-agent")
            )
        for coro in dispatched:
            loop.run_until_complete(coro)
    finally:
        loop.close()


def _edited(message: str, *, edit_at: int = 1700, **post: Any) -> dict[str, Any]:
    body = {
        "id": "post-1",
        "user_id": _PERSON,
        "channel_id": "channel-1",
        "message": message,
        "edit_at": edit_at,
        "props": {},
    }
    body.update(post)
    return {"event": "post_edited", "data": {"post": json.dumps(body)}}


def test_an_edit_reaches_the_edit_callback_once() -> None:
    adapter, edits, messages = _adapter()
    # Every agent's bot socket in the channel reports the same edit.
    _deliver(adapter, _edited("fixed text"), _edited("fixed text"))
    assert edits == [
        InboundEdit(
            channel_id="channel-1",
            sender_id=_PERSON,
            sender_name="ada",
            content="fixed text",
            message_ref="post-1",
            revision="1700",
        )
    ]
    assert messages == []


def test_a_second_edit_of_the_same_post_is_its_own() -> None:
    adapter, edits, _ = _adapter()
    _deliver(adapter, _edited("first fix"), _edited("second fix", edit_at=1800))
    assert [(e.content, e.revision) for e in edits] == [
        ("first fix", "1700"),
        ("second fix", "1800"),
    ]


def test_integrations_and_system_posts_are_not_edits() -> None:
    adapter, edits, _ = _adapter()
    _deliver(
        adapter,
        _edited("bot", user_id=_BOT_ACCOUNT),
        _edited("hook", props={"from_webhook": "true"}),
        _edited("joined", type="system_join_channel"),
    )
    assert edits == []
