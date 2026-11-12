"""`!list-documents` and `!list-references` are admin-owned, so the admin
client's `CommandConsumer` runs them, and they read what the room's packages
bring through its package store."""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from switch_core.bridges.agent.commands import dispatch_admin_command
from switch_core.clients.command_consumer import CommandConsumer

_ROOM = SimpleNamespace(room_id="!room:test")


def _consumer() -> CommandConsumer:
    package = SimpleNamespace(id="pkg-1", name="Payments context")
    document = SimpleNamespace(
        id="doc-1",
        name="runbook",
        description="",
        room_id=None,
        created_by_agent_id=None,
    )
    reference = SimpleNamespace(
        id="ref-1", name="payments-repo", type="github", description=""
    )
    consumer = CommandConsumer(
        actor=MagicMock(),
        agent_store=MagicMock(),
        room_store=MagicMock(),
        room_role_store=MagicMock(),
        external_user_store=MagicMock(),
        connections=MagicMock(),
        document_store=SimpleNamespace(
            list_for_room=AsyncMock(return_value=[]),
            get_many=AsyncMock(return_value=[document]),
        ),
        reference_store=SimpleNamespace(
            list_for_room=AsyncMock(return_value=[]),
            get=AsyncMock(return_value=reference),
        ),
        package_store=SimpleNamespace(
            list_for_room=AsyncMock(return_value=[package]),
            list_document_ids_for_package=AsyncMock(return_value=["doc-1"]),
            list_reference_ids_for_package=AsyncMock(return_value=["ref-1"]),
        ),
        agent_session_store=MagicMock(),
        room_service=MagicMock(),
        user_store=MagicMock(),
        agent_admin=MagicMock(),
        deletion_requests=MagicMock(),
        frontend_base_url=None,
        follow_the_conversation_enabled=False,
        decision_availability=MagicMock(),
    )

    @asynccontextmanager
    async def _session():  # type: ignore[no-untyped-def]
        yield SimpleNamespace()

    consumer.actor.session_factory = _session
    consumer._resolve_room_meta = AsyncMock(  # type: ignore[method-assign]
        return_value=SimpleNamespace(room_id="room-1")
    )
    consumer._is_direct_room = AsyncMock(return_value=False)  # type: ignore[method-assign]
    consumer.reply_command = AsyncMock()  # type: ignore[method-assign]
    return consumer


@pytest.mark.parametrize(
    ("command", "listed"),
    [
        ("list-documents", "- **runbook** _(via Payments context)_"),
        ("list-references", "- **payments-repo** _(github, via Payments context)_"),
    ],
)
async def test_the_admin_client_lists_what_the_rooms_packages_bring(
    command: str, listed: str
) -> None:
    consumer = _consumer()

    await dispatch_admin_command(
        consumer,
        _ROOM,
        SimpleNamespace(command=command, args="", thread_id=None, user_id="@a:test"),  # type: ignore[arg-type]
    )

    [reply] = consumer.reply_command.await_args_list
    assert listed in reply.args[1].splitlines()
