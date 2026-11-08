"""A Mattermost post edited after it was relayed reaches the edit path.

Mattermost reports a correction as `post_edited`, and it reports other things
the same way: a pin, and every update this bridge makes to its own cards. Only
a person's text edit is passed on, once per version, however many bot
connections in the channel hear it.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import InboundMessageEdit

_AUTHOR = "author-user-id"
_BRIDGE_BOT = "bridge-bot-user-id"


class _Users:
    def __init__(self) -> None:
        self.looked_up: list[str] = []

    def get_user(self, user_id: str) -> dict[str, object]:
        self.looked_up.append(user_id)
        if user_id != _AUTHOR:
            raise AssertionError(f"looked up {user_id!r}, not a Mattermost user")
        return {"id": _AUTHOR, "username": "ada"}


def _adapter() -> tuple[MattermostAdapter, list[InboundMessageEdit], _Users]:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )
    users = _Users()
    adapter._admin_driver = type("_Driver", (), {"users": users})()  # type: ignore[assignment]
    adapter._bridge_bot_ids = {_BRIDGE_BOT}
    received: list[InboundMessageEdit] = []

    async def record(edit: InboundMessageEdit) -> None:
        received.append(edit)

    adapter.set_message_edit_handler(record)
    return adapter, received, users


def _deliver(
    adapter: MattermostAdapter, post: dict[str, Any], agent_name: str = "some-agent"
) -> None:
    loop = asyncio.new_event_loop()
    dispatched: list[Any] = []
    adapter._main_loop = loop
    adapter._dispatch = lambda coro, _loop: dispatched.append(coro)  # type: ignore[method-assign]
    event = {
        "event": "post_edited",
        "data": {"post": json.dumps(post)},
    }
    try:
        loop.run_until_complete(adapter._ws_handler(json.dumps(event), agent_name))
        for coro in dispatched:
            loop.run_until_complete(coro)
    finally:
        loop.close()


def _post(**fields: Any) -> dict[str, Any]:
    post: dict[str, Any] = {
        "id": "post-1",
        "user_id": _AUTHOR,
        "channel_id": "channel-1",
        "message": "@neo fix the login test",
        "root_id": "",
        "edit_at": 1762412345678,
        "type": "",
        "props": {},
    }
    post.update(fields)
    return post


def test_an_authors_edit_carries_the_new_text_and_its_version() -> None:
    adapter, received, _ = _adapter()

    _deliver(adapter, _post())

    [edit] = received
    assert edit == InboundMessageEdit(
        channel_id="channel-1",
        sender_id=_AUTHOR,
        sender_name="ada",
        content="@neo fix the login test",
        message_ref="post-1",
        revision="1762412345678",
        root_id=None,
    )


def test_an_edit_in_a_thread_names_the_threads_root() -> None:
    adapter, received, _ = _adapter()

    _deliver(adapter, _post(root_id="root-post"))

    [edit] = received
    assert edit.root_id == "root-post"


def test_one_edit_heard_on_every_bot_connection_is_passed_on_once() -> None:
    adapter, received, _ = _adapter()

    _deliver(adapter, _post(), agent_name="neo")
    _deliver(adapter, _post(), agent_name="trinity")

    assert len(received) == 1


def test_a_second_edit_of_the_same_post_is_passed_on_too() -> None:
    adapter, received, _ = _adapter()

    _deliver(adapter, _post(message="first fix", edit_at=1))
    _deliver(adapter, _post(message="second fix", edit_at=2))

    assert [(e.content, e.revision) for e in received] == [
        ("first fix", "1"),
        ("second fix", "2"),
    ]


def test_pinning_a_post_that_was_never_edited_is_not_an_edit() -> None:
    adapter, received, users = _adapter()

    _deliver(adapter, _post(edit_at=0, is_pinned=True))

    assert received == []
    assert users.looked_up == []


def test_the_bridges_own_card_updates_are_not_edits() -> None:
    adapter, received, users = _adapter()

    _deliver(adapter, _post(user_id=_BRIDGE_BOT))

    assert received == []
    assert users.looked_up == []


def test_an_edit_to_a_webhook_post_is_not_passed_on() -> None:
    adapter, received, _ = _adapter()

    _deliver(adapter, _post(props={"from_webhook": "true"}))

    assert received == []


def test_an_edit_to_a_system_post_is_not_passed_on() -> None:
    adapter, received, _ = _adapter()

    _deliver(adapter, _post(type="system_join_channel"))

    assert received == []


def test_nothing_happens_without_an_edit_handler() -> None:
    adapter, received, users = _adapter()
    adapter._on_message_edit = None

    _deliver(adapter, _post())

    assert received == []
    assert users.looked_up == []
