"""Asking a running bridge whether an edit of its settings is sound."""

from __future__ import annotations

from collections.abc import Mapping
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import BridgeNotRunning
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)

_SHARED = {"event_delivery": "shared", "tenant_id": "org-1"}


def _service() -> CollaborationBridgeLifecycleService:
    service = CollaborationBridgeLifecycleService(
        bridge_store=MagicMock(),
        external_user_store=MagicMock(),
        bridge_message_map_store=MagicMock(),
        room_store=MagicMock(),
        agent_store=MagicMock(),
        client_store=MagicMock(),
        client_lifecycle=MagicMock(),
        room_service=MagicMock(),
        matrix_admin=MagicMock(),
        session_factory=MagicMock(),
        config=MagicMock(),
        client_factory=MagicMock(),
        session_activity_listener=MagicMock(),
        session_activity_service=MagicMock(),
        connections=MagicMock(),
    )
    service.register_adapter("teams", TeamsAdapter, TeamsConnectionConfig)
    service.register_adapter(
        "mattermost", MattermostAdapter, MattermostConnectionConfig
    )
    return service


class _Adapter:
    def __init__(self) -> None:
        self.asked: list[Mapping[str, object]] = []

    async def check_config_edit(self, connection_config: Mapping[str, object]) -> None:
        self.asked.append(connection_config)


def _running(service: CollaborationBridgeLifecycleService, adapter: Any) -> None:
    service._bridges["b-1"] = SimpleNamespace(adapter=adapter)  # type: ignore[assignment]


async def test_the_running_bridge_is_asked() -> None:
    service = _service()
    adapter = _Adapter()
    _running(service, adapter)
    edited = {**_SHARED, "team_id": "team-2"}

    await service.check_config_edit(
        bridge_id="b-1",
        bridge_type="teams",
        current=_SHARED,
        connection_config=edited,
    )

    assert adapter.asked == [edited]


async def test_a_stopped_bridge_on_the_deployments_app_cannot_be_checked() -> None:
    """Its edits need the platform to check, so one made while it is stopped
    is refused rather than stored unchecked."""
    with pytest.raises(BridgeNotRunning):
        await _service().check_config_edit(
            bridge_id="b-1",
            bridge_type="teams",
            current=_SHARED,
            connection_config={**_SHARED, "team_id": "team-2"},
        )


async def test_a_stopped_bridge_on_its_own_app_is_edited_on_validation_alone() -> None:
    await _service().check_config_edit(
        bridge_id="b-1",
        bridge_type="mattermost",
        current={"url": "https://mm.example"},
        connection_config={"url": "https://mm2.example"},
    )


def test_an_unknown_type_leaves_editing_to_validation() -> None:
    assert _service().editable_config_keys("no-such-platform", {}) is None


def test_the_adapter_names_what_is_editable() -> None:
    assert _service().editable_config_keys("teams", _SHARED) == frozenset({"team_id"})
