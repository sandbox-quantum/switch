"""An agent answers the person a platform message spoke for, not the admin
client that carried it. The kickoff a template posts is the case: replying
"@admin" named a client nobody is, while the creator waited unaddressed."""

from __future__ import annotations

from types import SimpleNamespace

from switch_core.clients.admin_messages import PLATFORM_MARKER
from switch_core.clients.agent_client import AgentClient
from switch_core.transport import InboundMessage


def _event(content: dict) -> InboundMessage:
    return InboundMessage(
        room_id="!r:switch.local",
        event_id="$e",
        sender="@switch-admin:switch.local",
        timestamp=1700000000000,
        content=content,
        body="@fixer go",
        sender_name="admin",
    )


def _handle(event: InboundMessage) -> str:
    ns = SimpleNamespace()
    return AgentClient._sender_handle(ns, event)  # type: ignore[arg-type]


def test_reply_handle_is_the_person_behind_a_platform_message() -> None:
    content = {
        "sender_name": "admin",
        PLATFORM_MARKER: {"on_behalf_of": {"user_id": "u9", "name": "dantas.abel"}},
    }
    assert _handle(_event(content)) == "dantas.abel"


def test_reply_handle_stays_the_sender_for_a_bare_platform_message() -> None:
    assert _handle(_event({"sender_name": "admin", PLATFORM_MARKER: {}})) == "admin"


def test_reply_handle_ignores_a_marker_without_a_person() -> None:
    assert (
        _handle(_event({"sender_name": "human", PLATFORM_MARKER: {"on_behalf_of": {}}}))
        == "human"
    )
