"""A Mattermost webhook's posts are the integration's, not its creator's
(CHOO-3881).

Mattermost files an incoming webhook's post under the user id of whoever made
the webhook, though anyone holding its URL may have sent it. Credited to that
person, it could confirm or remove their links and speak to their agents as
them, so it goes under a stand-in instead.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import InboundCommand, InboundMessage

_CREATOR = "creator-user-id"


class _Users:
    def get_user(self, user_id: str) -> dict[str, str]:
        if user_id != _CREATOR:
            raise AssertionError(f"looked up {user_id!r}, not a Mattermost user")
        return {"id": _CREATOR, "username": "ada"}


def _adapter() -> tuple[MattermostAdapter, list[Any]]:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )
    adapter._admin_driver = type("_Driver", (), {"users": _Users()})()  # type: ignore[assignment]
    received: list[Any] = []

    async def record(event: Any) -> None:
        received.append(event)

    adapter._on_message = record
    adapter._on_command = record
    return adapter, received


def _deliver(adapter: MattermostAdapter, post: dict[str, Any]) -> None:
    loop = asyncio.new_event_loop()
    dispatched: list[Any] = []
    adapter._main_loop = loop
    adapter._dispatch = lambda coro, _loop: dispatched.append(coro)  # type: ignore[method-assign]
    event = {
        "event": "posted",
        "data": {"post": json.dumps(post), "channel_type": "O"},
    }
    try:
        loop.run_until_complete(adapter._ws_handler(json.dumps(event), "some-agent"))
        for coro in dispatched:
            loop.run_until_complete(coro)
    finally:
        loop.close()


def _post(message: str, **props: str) -> dict[str, Any]:
    return {
        "id": f"post-{message}",
        "user_id": _CREATOR,
        "channel_id": "channel-1",
        "message": message,
        "props": props,
    }


def test_a_persons_own_post_is_theirs() -> None:
    adapter, received = _adapter()

    _deliver(adapter, _post("hello"))

    [message] = received
    assert isinstance(message, InboundMessage)
    assert (message.sender_id, message.sender_name) == (_CREATOR, "ada")


def test_a_webhook_post_goes_under_a_stand_in_not_its_creator() -> None:
    adapter, received = _adapter()

    _deliver(
        adapter, _post("build failed", from_webhook="true", override_username="ci")
    )

    [message] = received
    assert isinstance(message, InboundMessage)
    assert message.sender_id == f"webhook:{_CREATOR}"
    # Named after the person who set it up, not the name the post claims.
    assert message.sender_name == "ada's webhook"


def test_a_command_from_a_webhook_is_not_the_creators() -> None:
    adapter, received = _adapter()

    _deliver(adapter, _post("!unlink-account ada", from_webhook="true"))

    [command] = received
    assert isinstance(command, InboundCommand)
    assert command.command == "unlink-account"
    assert command.sender_id == f"webhook:{_CREATOR}"
    assert command.sender_name == "ada's webhook"


def test_the_stand_in_cannot_be_linked() -> None:
    assert MattermostAdapter.unlinkable_account_reason(f"webhook:{_CREATOR}")
    assert MattermostAdapter.unlinkable_account_reason(_CREATOR) is None


def test_the_stand_in_is_never_mentioned() -> None:
    adapter, _received = _adapter()
    loop = asyncio.new_event_loop()
    try:
        assert loop.run_until_complete(adapter._mention(f"webhook:{_CREATOR}")) is None
    finally:
        loop.close()


def test_mattermost_post_edited_relayed_with_microseconds() -> None:
    adapter, received = _adapter()
    post = _post("edited text")
    post["edit_at"] = 1712345678123  # ms

    loop = asyncio.new_event_loop()
    dispatched: list[Any] = []
    adapter._main_loop = loop
    adapter._dispatch = lambda coro, _loop: dispatched.append(coro)  # type: ignore[method-assign]
    event = {
        "event": "post_edited",
        "data": {"post": json.dumps(post), "channel_type": "O"},
    }
    try:
        loop.run_until_complete(adapter._ws_handler(json.dumps(event), "some-agent"))
        for coro in dispatched:
            loop.run_until_complete(coro)
    finally:
        loop.close()

    [message] = received
    assert isinstance(message, InboundMessage)
    assert message.content == "edited text"
    assert message.message_ref == post["id"]
    assert message.edit_revision == 1712345678123000


def test_mattermost_post_edited_dropped_from_self_or_bot() -> None:
    adapter, received = _adapter()
    adapter._admin_user_id = "admin-bot"
    post = _post("bot update")
    post["user_id"] = "admin-bot"
    post["edit_at"] = 1712345678123

    loop = asyncio.new_event_loop()
    dispatched: list[Any] = []
    adapter._main_loop = loop
    adapter._dispatch = lambda coro, _loop: dispatched.append(coro)  # type: ignore[method-assign]
    event = {
        "event": "post_edited",
        "data": {"post": json.dumps(post), "channel_type": "O"},
    }
    try:
        loop.run_until_complete(adapter._ws_handler(json.dumps(event), "some-agent"))
        for coro in dispatched:
            loop.run_until_complete(coro)
    finally:
        loop.close()

    assert received == []


@pytest.mark.parametrize("edit_at", [0, None, "", -1, "invalid"])
def test_mattermost_post_edited_dropped_when_edit_at_missing_or_zero(
    edit_at: Any,
) -> None:
    adapter, received = _adapter()
    post = _post("pinned or unpinned or missing edit_at")
    if edit_at is not None:
        post["edit_at"] = edit_at
    else:
        post.pop("edit_at", None)

    loop = asyncio.new_event_loop()
    dispatched: list[Any] = []
    adapter._main_loop = loop
    adapter._dispatch = lambda coro, _loop: dispatched.append(coro)  # type: ignore[method-assign]
    event = {
        "event": "post_edited",
        "data": {"post": json.dumps(post), "channel_type": "O"},
    }
    try:
        loop.run_until_complete(adapter._ws_handler(json.dumps(event), "some-agent"))
        for coro in dispatched:
            loop.run_until_complete(coro)
    finally:
        loop.close()

    assert received == []
    assert dispatched == []
