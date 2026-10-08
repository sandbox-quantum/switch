"""One platform workspace, connected at most once on the instance.

Two bridges into the same Slack workspace, Discord server or Mattermost team
would each deliver its events to their own tenant. The hosted install path
already holds a workspace to one tenant; these pin the same rule for bridges
registered by hand, and that Slack's `workspace_id` is the token's own rather
than whatever was typed in.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp
import pytest
from pydantic import ValidationError
from slack_sdk.errors import SlackApiError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.lifecycle_service import (
    BridgeClaimConflict,
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import BridgeCredentialError
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.db.models import Client, CollaborationBridge, Tenant
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.tenant_context import tenant_scope

_SLACK = {"bot_token": "xoxb-test", "app_token": "xapp-test", "workspace_id": "T1"}
_DISCORD = {"bot_token": "discord-test", "guild_id": "111"}
_MATTERMOST = {
    "url": "https://chat.example.invalid",
    "admin_user": "bot",
    "admin_password": "placeholder",  # gitleaks:allow
    "team_name": "eng",
}


def _service(
    session_factory: async_sessionmaker[AsyncSession],
) -> CollaborationBridgeLifecycleService:
    service = CollaborationBridgeLifecycleService(
        bridge_store=CollaborationBridgeStore(),
        external_user_store=MagicMock(),
        bridge_message_map_store=MagicMock(),
        room_store=RoomStore(),
        agent_store=MagicMock(),
        client_store=ClientStore(),
        client_lifecycle=MagicMock(),
        room_service=MagicMock(),
        provisioning=MagicMock(),
        session_factory=session_factory,
        config=MagicMock(),
        client_factory=MagicMock(),
        session_activity_listener=MagicMock(),
        session_activity_service=MagicMock(),
        connections=MagicMock(),
    )
    service.register_adapter("slack", SlackAdapter, SlackConnectionConfig)
    service.register_adapter("discord", DiscordAdapter, DiscordConnectionConfig)
    service.register_adapter(
        "mattermost", MattermostAdapter, MattermostConnectionConfig
    )
    return service


async def _bridge(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    tenant_id: str,
    bridge_type: str,
    connection_config: dict[str, Any],
    display_name: str = "Incumbent",
) -> None:
    async with session_factory() as session:
        if await session.get(Tenant, tenant_id) is None:
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
            await session.flush()
        client = Client(
            tenant_id=tenant_id,
            transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
            display_name="bridge client",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        session.add(
            CollaborationBridge(
                tenant_id=tenant_id,
                type=bridge_type,
                display_name=display_name,
                client_id=client.id,
                status="active",
                connection_config=connection_config,
            )
        )
        await session.commit()


async def _tenant(session_factory: async_sessionmaker[AsyncSession]) -> str:
    tenant_id = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.commit()
    return tenant_id


class TestWhatAWorkspaceIs:
    def test_slack_is_claimed_by_its_workspace_id(self) -> None:
        assert SlackAdapter.claimed_workspace(_SLACK) == "Slack workspace T1"

    def test_discord_is_claimed_by_its_server(self) -> None:
        assert DiscordAdapter.claimed_workspace(_DISCORD) == "Discord server 111"

    @pytest.mark.parametrize(
        "url",
        [
            "https://chat.example.invalid",
            "https://chat.example.invalid/",
            "HTTPS://Chat.Example.Invalid:443",
        ],
    )
    def test_a_mattermost_team_is_the_same_however_its_url_is_written(
        self, url: str
    ) -> None:
        config = {**_MATTERMOST, "url": url, "team_name": "Eng"}
        assert (
            MattermostAdapter.claimed_workspace(config)
            == "Mattermost team eng on https://chat.example.invalid"
        )

    @pytest.mark.parametrize(
        "url",
        [
            "chat.example.invalid",
            "http://chat.example.invalid",
            "chat.example.invalid:8065/",
            "HTTP://chat.example.invalid:8065",
        ],
    )
    def test_a_url_with_no_scheme_is_the_server_the_driver_reaches(
        self, url: str
    ) -> None:
        """The driver reads no scheme as http, and http with no port as 8065."""
        config = {**_MATTERMOST, "url": url, "team_name": "eng"}
        assert (
            MattermostAdapter.claimed_workspace(config)
            == "Mattermost team eng on http://chat.example.invalid"
        )

    def test_port_80_is_not_the_drivers_http_default(self) -> None:
        plain = {**_MATTERMOST, "url": "http://chat.example.invalid"}
        on_80 = {**_MATTERMOST, "url": "http://chat.example.invalid:80"}
        assert MattermostAdapter.claimed_workspace(
            plain
        ) != MattermostAdapter.claimed_workspace(on_80)

    def test_a_mattermost_team_on_another_port_is_another_team(self) -> None:
        config = {**_MATTERMOST, "url": "https://chat.example.invalid:8065"}
        assert MattermostAdapter.claimed_workspace(config) != (
            MattermostAdapter.claimed_workspace(_MATTERMOST)
        )


class TestRegistrationRefusesASecondClaim:
    @pytest.mark.parametrize(
        ("bridge_type", "config"),
        [("slack", _SLACK), ("discord", _DISCORD), ("mattermost", _MATTERMOST)],
    )
    async def test_another_tenants_workspace_is_refused_without_naming_it(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        bridge_type: str,
        config: dict[str, Any],
    ) -> None:
        incumbent = await _tenant(session_factory)
        newcomer = await _tenant(session_factory)
        await _bridge(
            session_factory,
            tenant_id=incumbent,
            bridge_type=bridge_type,
            connection_config=config,
            display_name="Their bridge",
        )

        with tenant_scope(newcomer):
            with pytest.raises(BridgeClaimConflict, match="already claimed") as raised:
                await _service(session_factory).reject_claim_conflict(
                    bridge_type, dict(config)
                )
        assert "Their bridge" not in str(raised.value)

    async def test_the_callers_own_bridge_is_named(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        tenant = await _tenant(session_factory)
        await _bridge(
            session_factory,
            tenant_id=tenant,
            bridge_type="slack",
            connection_config=_SLACK,
            display_name="Our Slack",
        )

        with tenant_scope(tenant):
            with pytest.raises(BridgeClaimConflict, match="'Our Slack'") as raised:
                await _service(session_factory).reject_claim_conflict(
                    "slack", dict(_SLACK)
                )
        assert "listen_port" not in str(raised.value)

    async def test_a_different_workspace_is_accepted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        incumbent = await _tenant(session_factory)
        newcomer = await _tenant(session_factory)
        await _bridge(
            session_factory,
            tenant_id=incumbent,
            bridge_type="slack",
            connection_config=_SLACK,
        )

        with tenant_scope(newcomer):
            await _service(session_factory).reject_claim_conflict(
                "slack", {**_SLACK, "workspace_id": "T2"}
            )

    async def test_the_same_id_on_another_platform_is_not_a_clash(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        incumbent = await _tenant(session_factory)
        newcomer = await _tenant(session_factory)
        await _bridge(
            session_factory,
            tenant_id=incumbent,
            bridge_type="discord",
            connection_config={**_DISCORD, "guild_id": "T1"},
        )

        with tenant_scope(newcomer):
            await _service(session_factory).reject_claim_conflict("slack", dict(_SLACK))


class TestAnEditIsHeldToTheSameRules:
    async def test_an_edit_to_another_tenants_workspace_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        incumbent = await _tenant(session_factory)
        newcomer = await _tenant(session_factory)
        await _bridge(
            session_factory,
            tenant_id=incumbent,
            bridge_type="discord",
            connection_config=_DISCORD,
        )

        with tenant_scope(newcomer):
            with pytest.raises(BridgeClaimConflict, match="already claimed"):
                await _service(session_factory).check_edited_connection_config(
                    bridge_id="the-edited-bridge",
                    bridge_type="discord",
                    connection_config=dict(_DISCORD),
                )

    async def test_editing_a_bridge_does_not_clash_with_itself(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        tenant = await _tenant(session_factory)
        await _bridge(
            session_factory,
            tenant_id=tenant,
            bridge_type="discord",
            connection_config=_DISCORD,
        )
        async with session_factory() as session:
            [bridge] = [
                b
                for b in await CollaborationBridgeStore().get_all(session)
                if b.tenant_id == tenant
            ]

        with tenant_scope(tenant):
            await _service(session_factory).check_edited_connection_config(
                bridge_id=bridge.id,
                bridge_type="discord",
                connection_config={**_DISCORD, "agent_roles": False},
            )

    async def test_an_edited_slack_workspace_id_must_be_the_tokens(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        tenant = await _tenant(session_factory)
        with tenant_scope(tenant), _auth_test(ok=True, team_id="T1"):
            with pytest.raises(BridgeCredentialError, match="T1, not T2"):
                await _service(session_factory).check_edited_connection_config(
                    bridge_id="the-edited-bridge",
                    bridge_type="slack",
                    connection_config={**_SLACK, "workspace_id": "T2"},
                )


def _auth_test(**response: Any) -> Any:
    return patch(
        "switch_core.bridges.collaboration.slack.adapter.AsyncWebClient.auth_test",
        AsyncMock(return_value=response),
    )


class TestSlackWorkspaceIdIsTheTokens:
    async def test_the_tokens_workspace_is_accepted(self) -> None:
        with _auth_test(ok=True, team_id="T1"):
            await SlackAdapter.verify_credentials(dict(_SLACK))

    async def test_an_enterprise_grid_org_id_is_accepted(self) -> None:
        with _auth_test(ok=True, team_id="T9", enterprise_id="E1"):
            await SlackAdapter.verify_credentials({**_SLACK, "workspace_id": "E1"})

    async def test_another_workspace_is_refused(self) -> None:
        # Otherwise a tenant could claim a workspace by typing its id, and
        # keep the real holder from connecting it.
        with _auth_test(ok=True, team_id="T2"):
            with pytest.raises(BridgeCredentialError, match="T2, not T1"):
                await SlackAdapter.verify_credentials(dict(_SLACK))

    async def test_a_token_slack_refuses_is_a_credential_error(self) -> None:
        refusal = SlackApiError("invalid_auth", MagicMock())
        refusal.response = {"ok": False, "error": "invalid_auth"}  # type: ignore[assignment]
        with patch(
            "switch_core.bridges.collaboration.slack.adapter.AsyncWebClient.auth_test",
            AsyncMock(side_effect=refusal),
        ):
            with pytest.raises(BridgeCredentialError, match="invalid_auth"):
                await SlackAdapter.verify_credentials(dict(_SLACK))

    @pytest.mark.parametrize(
        "failure",
        [aiohttp.ClientConnectionError("connection refused"), TimeoutError()],
    )
    async def test_slack_out_of_reach_is_a_credential_error_not_a_crash(
        self, failure: Exception
    ) -> None:
        """Add and edit answer 400 rather than 500 when Slack cannot be
        reached, and the install flow can tell it apart from a bug."""
        with patch(
            "switch_core.bridges.collaboration.slack.adapter.AsyncWebClient.auth_test",
            AsyncMock(side_effect=failure),
        ):
            with pytest.raises(BridgeCredentialError, match="Could not reach Slack"):
                await SlackAdapter.verify_credentials(dict(_SLACK))


class TestMattermostUrlIsCheckedUpFront:
    @pytest.mark.parametrize(
        "url",
        [
            "https://chat.example.invalid:99999",
            "https://chat.example.invalid:abc",
            "ftp://chat.example.invalid",
            "https://",
        ],
    )
    async def test_an_edit_with_a_bad_url_is_a_validation_error(
        self, session_factory: async_sessionmaker[AsyncSession], url: str
    ) -> None:
        tenant = await _tenant(session_factory)
        with tenant_scope(tenant):
            with pytest.raises(ValidationError, match="url"):
                await _service(session_factory).check_edited_connection_config(
                    bridge_id="the-edited-bridge",
                    bridge_type="mattermost",
                    connection_config={**_MATTERMOST, "url": url},
                )

    def test_a_url_with_no_scheme_is_still_valid(self) -> None:
        """Bridges configured before the check, the way the driver accepts."""
        MattermostConnectionConfig.model_validate(
            {**_MATTERMOST, "url": "chat.example.invalid:8065"}
        )
