"""Choosing which teams the distributed Teams app is in, from the dashboard."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.teams.auth import TokenRequestRefused
from switch_core.bridges.collaboration.teams.graph import AppInstallation
from switch_core.bridges.collaboration.teams.identity import TeamsIdentity
from switch_core.db.models import Client, CollaborationBridge, MessagingInstall, User
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.messaging_install_store import MessagingInstallStore
from switch_core.gateway.teams_placements import (
    add_to_team,
    list_team_placements,
    remove_from_team,
)

ORG = "aaaaaaaa-0000-0000-0000-000000000001"


class _Graph:
    def __init__(self, *, installed_in: dict[str, str] | None = None) -> None:
        self.added: list[tuple[str, str]] = []
        # team id -> the catalogue id its installation reports
        self.installed_in = installed_in or {}
        self.fail_with: Exception | None = None

    async def list_teams(self) -> list[dict[str, Any]]:
        if self.fail_with is not None:
            raise self.fail_with
        return [
            {"id": "team-1", "displayName": "Engineering"},
            {"id": "team-2", "displayName": "Sales"},
        ]

    async def find_app_installations(
        self, *, team_id: str, external_id: str
    ) -> list[AppInstallation]:
        if team_id in self.installed_in:
            return [
                AppInstallation(
                    installation_id=f"I-{team_id}",
                    catalog_app_id=self.installed_in[team_id],
                )
            ]
        return []

    async def install_app(self, *, team_id: str, catalog_app_id: str) -> None:
        self.added.append((team_id, catalog_app_id))

    async def uninstall_app(self, *, team_id: str, installation_id: str) -> None: ...


class _Lifecycle:
    def __init__(self, adapter: TeamsAdapter | None) -> None:
        self._adapter = adapter

    def get_adapter(self, bridge_id: str) -> TeamsAdapter | None:
        return self._adapter


def _shared_adapter(graph: _Graph) -> TeamsAdapter:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig.model_validate(
            {"event_delivery": "shared", "tenant_id": ORG, "team_id": "team-1"}
        )
    )
    adapter._identity = _identity()
    adapter._graph = graph  # type: ignore[assignment]
    return adapter


def _identity() -> TeamsIdentity:
    return TeamsIdentity(
        app_id="switch-app",
        org_tenant_id=ORG,
        shared=True,
        notification_url="https://switch.example/messaging/teams/notifications",
        client_state="x",
        keyring=None,
        allowed_service_hosts=frozenset({"smba.trafficmanager.net"}),
        required_graph_roles=frozenset(),
    )


def _admin() -> User:
    return User(id="admin", name="admin", email="admin@example.test", role="admin")


async def _connection(
    session: AsyncSession, *, platform_data: dict[str, object]
) -> str:
    user = User(name="installer", email=f"{uuid.uuid4().hex}@example.test", role="user")
    session.add(user)
    client = Client(
        matrix_user_id=f"@bridge-{uuid.uuid4().hex[:12]}:test",
        display_name="bridge client",
        type="bridge",
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="teams",
        display_name="Contoso",
        client_id=client.id,
        status="active",
        connection_config={"event_delivery": "shared", "tenant_id": ORG},
    )
    session.add(bridge)
    await session.flush()
    session.add(
        MessagingInstall(
            platform="teams",
            external_workspace_id=ORG,
            encrypted_bot_token=None,
            scopes="",
            status="active",
            installed_by_user_id=user.id,
            bridge_id=bridge.id,
            platform_data=platform_data,
        )
    )
    await session.flush()
    return bridge.id


async def _call(
    route: Any, session: AsyncSession, lifecycle: _Lifecycle, **kwargs: Any
) -> Any:
    return await route(
        session=session,
        bridge_store=CollaborationBridgeStore(),
        install_store=MessagingInstallStore(),
        collab_lifecycle=lifecycle,  # type: ignore[arg-type]
        _user=_admin(),
        **kwargs,
    )


async def test_the_teams_are_listed_with_the_default_marked(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    graph = _Graph()
    async with session_factory() as session:
        bridge_id = await _connection(session, platform_data={"catalog_app_id": "c-1"})

        placements = await _call(
            list_team_placements,
            session,
            _Lifecycle(_shared_adapter(graph)),
            bridge_id=bridge_id,
        )

    assert [(t.name, t.has_switch, t.is_default) for t in placements.teams] == [
        ("Engineering", False, True),
        ("Sales", False, False),
    ]
    assert placements.in_catalog
    assert placements.catalog_problem is None


async def test_switch_is_added_to_a_team_from_the_catalogue(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    graph = _Graph()
    async with session_factory() as session:
        bridge_id = await _connection(session, platform_data={"catalog_app_id": "c-1"})

        await _call(
            add_to_team,
            session,
            _Lifecycle(_shared_adapter(graph)),
            bridge_id=bridge_id,
            team_id="team-1",
        )

    assert graph.added == [("team-1", "c-1")]


async def test_without_the_app_in_the_catalogue_it_says_what_to_do(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    graph = _Graph()
    async with session_factory() as session:
        bridge_id = await _connection(
            session,
            platform_data={
                "catalog_app_id": None,
                "publish_problem": "not a Teams admin",
            },
        )
        lifecycle = _Lifecycle(_shared_adapter(graph))

        placements = await _call(
            list_team_placements, session, lifecycle, bridge_id=bridge_id
        )
        with pytest.raises(HTTPException) as refused:
            await _call(
                add_to_team, session, lifecycle, bridge_id=bridge_id, team_id="team-1"
            )

    assert not placements.in_catalog
    assert placements.catalog_problem == "not a Teams admin"
    assert refused.value.status_code == 409
    assert graph.added == []


async def test_a_bridge_with_no_install_is_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        with pytest.raises(HTTPException) as refused:
            await _call(
                remove_from_team,
                session,
                _Lifecycle(None),
                bridge_id="no-such-bridge",
                team_id="team-1",
            )

    assert refused.value.status_code == 404


async def test_an_app_uploaded_by_hand_is_learned_from_the_first_team_it_is_in(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Switch could not publish the app, a Teams admin uploaded it, and a team
    owner added it to one team from Teams: that installation reports the id,
    and from then on Switch adds it to the rest."""
    graph = _Graph(installed_in={"team-2": "uploaded-by-hand"})
    async with session_factory() as session:
        bridge_id = await _connection(
            session,
            platform_data={"publish_problem": "not a Teams admin"},
        )
        lifecycle = _Lifecycle(_shared_adapter(graph))

        await _call(
            add_to_team, session, lifecycle, bridge_id=bridge_id, team_id="team-1"
        )
        install = await MessagingInstallStore().get_for_bridge(
            session, bridge_id=bridge_id
        )
        placements = await _call(
            list_team_placements, session, lifecycle, bridge_id=bridge_id
        )

    assert graph.added == [("team-1", "uploaded-by-hand")]
    assert install is not None
    assert install.platform_data["catalog_app_id"] == "uploaded-by-hand"
    assert placements.in_catalog
    assert placements.catalog_problem is None


async def test_an_organisation_that_withdrew_its_approval_is_told_so_not_a_500(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    graph = _Graph()
    graph.fail_with = TokenRequestRefused(
        "AADSTS700016: application not found", error_codes=frozenset({700016})
    )
    async with session_factory() as session:
        bridge_id = await _connection(session, platform_data={"catalog_app_id": "c-1"})

        with pytest.raises(HTTPException) as refused:
            await _call(
                list_team_placements,
                session,
                _Lifecycle(_shared_adapter(graph)),
                bridge_id=bridge_id,
            )

    assert refused.value.status_code == 502
    assert "AADSTS700016" in str(refused.value.detail)
