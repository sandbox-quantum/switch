"""Finishing an install in the dashboard (`/messaging-apps/{platform}/...`).

The install callback hands the dashboard a sealed confirmation; whoever
started the install connects it at once, anyone else has to be a workspace
admin who has seen what it connects. A forwarded install link must not
connect a workspace to another organization unseen.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from switch_core.bridges.collaboration.install_confirmation import InstallTicketError
from switch_core.bridges.collaboration.install_service import PendingInstall
from switch_core.db.models import User
from switch_core.gateway.messaging_installs import (
    FinishTicket,
    PendingTicket,
    cancel_install,
    connect_install,
    pending_install,
)

STARTER = "u-starter"


def _user(user_id: str) -> User:
    user = User(name=user_id, email=f"{user_id}@example.test", role="user")
    user.id = user_id
    return user


class _Service:
    def __init__(self) -> None:
        self.confirmed: list[str] = []
        self.cancelled: list[str] = []

    async def pending(self, *, platform: str, ticket: str) -> PendingInstall:
        if ticket == "forged":
            raise InstallTicketError("not ours")
        return PendingInstall(
            platform=platform,
            workspace_name="Acme",
            external_workspace_id="T1",
            organisation="Acme Robotics",
            requested_by="starter@example.test",
            requested_by_user_id=STARTER,
            ticket=ticket,
        )

    async def confirm(self, *, platform: str, ticket: str) -> SimpleNamespace:
        self.confirmed.append(ticket)
        return SimpleNamespace(bridge_id="b1")

    async def cancel(self, *, platform: str, ticket: str) -> None:
        self.cancelled.append(ticket)


async def test_the_person_who_started_it_connects_it_at_once() -> None:
    service = _Service()
    view = await pending_install(
        "slack",
        PendingTicket(ticket="t"),
        service,
        _user(STARTER),
        False,  # type: ignore[arg-type]
    )
    assert view.started_by_you is True
    done = await connect_install(
        "slack",
        FinishTicket(ticket="t", confirmed=False),
        service,
        _user(STARTER),
        False,  # type: ignore[arg-type]
    )
    assert done.bridge_id == "b1"
    assert service.confirmed == ["t"]


async def test_someone_else_is_asked_first() -> None:
    service = _Service()
    with pytest.raises(HTTPException) as unseen:
        await connect_install(
            "slack",
            FinishTicket(ticket="t", confirmed=False),
            service,
            _user("u-admin"),
            True,  # type: ignore[arg-type]
        )
    assert unseen.value.status_code == 409
    assert service.confirmed == []
    await connect_install(
        "slack",
        FinishTicket(ticket="t", confirmed=True),
        service,
        _user("u-admin"),
        True,  # type: ignore[arg-type]
    )
    assert service.confirmed == ["t"]


async def test_someone_else_who_is_no_admin_may_not_see_or_finish_it() -> None:
    service = _Service()
    for attempt in (
        pending_install(
            "slack", PendingTicket(ticket="t"), service, _user("u-member"), False
        ),  # type: ignore[arg-type]
        connect_install(
            "slack",
            FinishTicket(ticket="t", confirmed=True),
            service,
            _user("u-member"),
            False,  # type: ignore[arg-type]
        ),
        cancel_install(
            "slack", PendingTicket(ticket="t"), service, _user("u-member"), False
        ),  # type: ignore[arg-type]
    ):
        with pytest.raises(HTTPException) as refused:
            await attempt
        assert refused.value.status_code == 403
    assert service.confirmed == [] and service.cancelled == []


async def test_a_ticket_not_ours_is_refused() -> None:
    with pytest.raises(HTTPException) as refused:
        await pending_install(
            "slack",
            PendingTicket(ticket="forged"),
            _Service(),
            _user(STARTER),
            False,  # type: ignore[arg-type]
        )
    assert refused.value.status_code == 400
