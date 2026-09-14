"""`GET /collaborations/{id}/me` answers the question a kickoff asks: who is
the caller on this bridge? It must agree with `post_kickoff`, which is why it
goes through `resolve_switch_user` rather than reading claims itself."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from switch_core.gateway.collaborations import resolve_my_bridge_identity


def _user() -> Any:
    user = MagicMock()
    user.id = "user-1"
    user.name = "Abel"
    user.email = "abel@example.com"
    return user


def _external_user() -> Any:
    ext = MagicMock()
    ext.id = "row-1"
    ext.bridge_id = "bridge-1"
    ext.external_user_id = "U0ABC"
    ext.external_username = "dantas.abel"
    return ext


@pytest.mark.asyncio
async def test_a_bridge_that_does_not_exist_is_a_404() -> None:
    bridge_store = MagicMock()
    bridge_store.get = AsyncMock(return_value=None)
    with pytest.raises(HTTPException) as raised:
        await resolve_my_bridge_identity(
            "bridge-1",
            session=MagicMock(),
            bridge_store=bridge_store,
            external_user_store=MagicMock(),
            user_store=MagicMock(),
            collab_lifecycle=MagicMock(),
            user=_user(),
        )
    assert raised.value.status_code == 404


@pytest.mark.asyncio
async def test_a_bridge_that_is_not_running_answers_nobody() -> None:
    bridge_store = MagicMock()
    bridge_store.get = AsyncMock(return_value=MagicMock())
    lifecycle = MagicMock()
    lifecycle.get = MagicMock(return_value=None)
    assert (
        await resolve_my_bridge_identity(
            "bridge-1",
            session=MagicMock(),
            bridge_store=bridge_store,
            external_user_store=MagicMock(),
            user_store=MagicMock(),
            collab_lifecycle=lifecycle,
            user=_user(),
        )
        is None
    )


@pytest.mark.asyncio
async def test_the_answer_is_whatever_the_bridge_resolves_for_the_caller() -> None:
    """Name and email travel with the call, so an unclaimed account that the
    platform knows by email is an answer, not a warning."""
    bridge_store = MagicMock()
    bridge_store.get = AsyncMock(return_value=MagicMock())
    bridge_core = MagicMock()
    bridge_core.resolve_switch_user = AsyncMock(return_value=_external_user())
    lifecycle = MagicMock()
    lifecycle.get = MagicMock(return_value=bridge_core)
    external_user_store = MagicMock()
    external_user_store.claimant_ids = AsyncMock(return_value=[])
    user_store = MagicMock()

    summary = await resolve_my_bridge_identity(
        "bridge-1",
        session=MagicMock(),
        bridge_store=bridge_store,
        external_user_store=external_user_store,
        user_store=user_store,
        collab_lifecycle=lifecycle,
        user=_user(),
    )

    bridge_core.resolve_switch_user.assert_awaited_once_with(
        "user-1", name="Abel", email="abel@example.com"
    )
    assert summary is not None
    assert summary.external_username == "dantas.abel"
    assert summary.claimed_by == []
