"""An agent listing rooms or fetching a file writes a security event naming
it, so a log monitor can count one agent's access."""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock

import pytest

from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.definitions import list_all_rooms
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.logging_context import structured_fields
from switch_core.security_events import LOGGER_NAME
from switch_core.tenant_context import bind_tenant_id, tenant_scope, unbind_tenant_id
from switch_core.transport.types import DownloadResult

AGENT = "agent-1"


def _events(caplog: pytest.LogCaptureFixture, name: str) -> list[dict[str, Any]]:
    return [
        structured_fields(record)
        for record in caplog.records
        if record.name == LOGGER_NAME
        and structured_fields(record)["switch"]["event"] == name
    ]


@pytest.fixture(autouse=True)
def _capture(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)


async def test_listing_rooms_is_logged_with_how_many_and_no_names(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    rooms = [
        SimpleNamespace(
            id=f"room-{n}", name=f"Secret {n}", description="", archived_at=None
        )
        for n in range(3)
    ]
    protocol = SimpleNamespace(list_all_rooms=AsyncMock(return_value=(rooms, "next")))
    monkeypatch.setattr(op_context, "_protocol", protocol)
    call = set_call_context(CallContext(agent_id=AGENT, session_key=None, session=None))
    tenant = bind_tenant_id(TENANT_ZERO_ID)
    try:
        await list_all_rooms(name_contains="Secret")
    finally:
        unbind_tenant_id(tenant)
        reset_call_context(call)

    [event] = _events(caplog, "security.agent.rooms_listed")
    assert event["switch"]["agent_id"] == AGENT
    assert event["switch"]["tenant_id"] == TENANT_ZERO_ID
    assert event["security_details"] == {"rooms": 3, "next_page": True}
    assert "Secret" not in str(event)


async def test_a_file_an_agent_fetches_is_logged_and_a_refused_one_is_not(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = SimpleNamespace(
        tenant_id=TENANT_ZERO_ID,
        transport=SimpleNamespace(
            download_media=AsyncMock(
                return_value=DownloadResult(
                    body=b"12345", content_type="text/plain", filename="plan.txt"
                )
            )
        ),
    )
    member = AsyncMock()
    core = SimpleNamespace(
        require_room_member=member,
        client_lifecycle=SimpleNamespace(
            get_tenant_agent=lambda _agent_id, _tenant_id: client
        ),
    )

    with tenant_scope(TENANT_ZERO_ID):
        await AgentCore.download_media(
            cast(Any, core), AGENT, "room-1", "switch-media://a"
        )
        member.side_effect = PermissionError("not a member")
        with pytest.raises(PermissionError):
            await AgentCore.download_media(
                cast(Any, core), AGENT, "room-2", "switch-media://b"
            )

    [event] = _events(caplog, "security.attachment.downloaded")
    assert event["switch"]["agent_id"] == AGENT
    assert event["switch"]["room_id"] == "room-1"
    assert event["switch"]["actor_user_id"] is None
    assert event["security_details"] == {"media_uri": "switch-media://a", "size": 5}
    assert "plan.txt" not in str(event)
