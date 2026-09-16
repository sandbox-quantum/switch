"""The shared connection routes each guild message by resolving it fresh.

This is where the isolation guards on the multi-tenant socket are pinned:
- G1: the dispatch runs with no tenant bound, and the tenant is resolved fresh
  per event (nothing about a guild's tenant is cached on the connection).
- G3: a guild with no active install resolves to nothing and is dropped, never
  routed to a default or first tenant.
"""

from __future__ import annotations

from typing import Any

import discord

from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.discord.gateway import DiscordGatewayClient
from switch_core.bridges.collaboration.install_service import (
    WebhookBridgeUnavailable,
    WebhookTarget,
    WebhookWorkspaceUnknown,
)
from switch_core.tenant_context import current_tenant_id, tenant_scope

GUILD_ID = 42


class _FakeInstallService:
    def __init__(
        self, *, target: WebhookTarget | None = None, error: Exception | None = None
    ) -> None:
        self._target = target
        self._error = error
        self.calls: list[tuple[str, str]] = []

    async def resolve_by_workspace(
        self, *, platform: str, workspace_id: str
    ) -> WebhookTarget:
        self.calls.append((platform, workspace_id))
        if self._error is not None:
            raise self._error
        assert self._target is not None
        return self._target


def _gateway(install_service: Any) -> DiscordGatewayClient:
    return DiscordGatewayClient(
        bot_token="bot-token",
        message_content=False,
        members=False,
        install_service=install_service,
    )


def _shared_adapter() -> DiscordAdapter:
    return DiscordAdapter(
        config=DiscordConnectionConfig(guild_id=str(GUILD_ID), event_delivery="shared")
    )


def _message(guild_id: int | None) -> discord.Message:
    guild = None if guild_id is None else type("_G", (), {"id": guild_id})()
    return type("_M", (), {"guild": guild})()  # type: ignore[return-value]


def _target(adapter: Any) -> WebhookTarget:
    return WebhookTarget(
        tenant_id="tenant-a", platform="discord", bridge_id="bridge-1", adapter=adapter
    )


async def test_a_resolved_message_is_dispatched_to_its_bridge() -> None:
    adapter = _shared_adapter()
    seen: dict[str, Any] = {}

    async def fake_dispatch(message: discord.Message) -> None:
        seen["message"] = message

    adapter.dispatch_inbound = fake_dispatch  # type: ignore[method-assign]
    service = _FakeInstallService(target=_target(adapter))
    gateway = _gateway(service)

    message = _message(GUILD_ID)
    await gateway._on_guild_message(message)

    assert service.calls == [("discord", str(GUILD_ID))]
    assert seen["message"] is message
    # The inert bridge was handed the shared connection on first use.
    assert adapter._connection is gateway.connection


async def test_dispatch_runs_with_no_tenant_bound() -> None:
    """G1: even if the caller had a tenant bound, the dispatch does not — each
    handler below binds the tenant of the room it acts on."""
    adapter = _shared_adapter()
    seen: dict[str, Any] = {}

    async def fake_dispatch(message: discord.Message) -> None:
        seen["tenant_during"] = current_tenant_id()

    adapter.dispatch_inbound = fake_dispatch  # type: ignore[method-assign]
    gateway = _gateway(_FakeInstallService(target=_target(adapter)))

    with tenant_scope("tenant-somebody-else"):
        await gateway._on_guild_message(_message(GUILD_ID))
        # The binding is restored for the caller after the event (G1).
        assert current_tenant_id() == "tenant-somebody-else"

    assert seen["tenant_during"] is None


async def test_a_guild_with_no_active_install_is_dropped() -> None:
    """G3: fails closed — no default or first tenant."""
    adapter = _shared_adapter()
    dispatched = False

    async def fake_dispatch(message: discord.Message) -> None:
        nonlocal dispatched
        dispatched = True

    adapter.dispatch_inbound = fake_dispatch  # type: ignore[method-assign]
    gateway = _gateway(
        _FakeInstallService(error=WebhookWorkspaceUnknown("no tenant holds it"))
    )

    await gateway._on_guild_message(_message(GUILD_ID))

    assert dispatched is False


async def test_a_bridge_not_yet_running_is_dropped() -> None:
    gateway = _gateway(
        _FakeInstallService(error=WebhookBridgeUnavailable("no bridge yet"))
    )
    # No adapter to dispatch to; the point is it does not raise.
    await gateway._on_guild_message(_message(GUILD_ID))


async def test_a_dm_shaped_event_is_ignored() -> None:
    """Defensive: the connection routes DMs to the (unset) DM handler, but a
    guild-less event reaching here is dropped before any resolution (G4)."""
    service = _FakeInstallService()
    gateway = _gateway(service)

    await gateway._on_guild_message(_message(None))

    assert service.calls == []


async def test_a_non_discord_bridge_is_dropped_not_dispatched() -> None:
    """A guild resolving to a non-Discord bridge is a wiring fault, not a
    message to force through."""

    class _NotDiscord:
        pass

    gateway = _gateway(_FakeInstallService(target=_target(_NotDiscord())))
    await gateway._on_guild_message(_message(GUILD_ID))  # logs and returns


class _FakeResponse:
    def __init__(self) -> None:
        self.refusals: list[tuple[str, bool]] = []

    async def send_message(self, content: str, *, ephemeral: bool = False) -> None:
        self.refusals.append((content, ephemeral))


def _interaction(guild_id: int | None) -> Any:
    return type("_I", (), {"guild_id": guild_id, "response": _FakeResponse()})()


def _command() -> Any:
    return type("_C", (), {"name": "help"})()


async def test_a_slash_command_is_routed_to_its_guilds_bridge() -> None:
    adapter = _shared_adapter()
    seen: dict[str, Any] = {}

    async def fake_slash(interaction: Any, command: Any, values: Any) -> None:
        seen["tenant_during"] = current_tenant_id()
        seen["command"] = command

    adapter.dispatch_slash = fake_slash  # type: ignore[method-assign]
    gateway = _gateway(_FakeInstallService(target=_target(adapter)))

    interaction = _interaction(GUILD_ID)
    command = _command()
    with tenant_scope("tenant-somebody-else"):
        await gateway._on_slash(interaction, command, {})

    assert seen["command"] is command
    assert seen["tenant_during"] is None  # G1
    assert interaction.response.refusals == []
    assert adapter._connection is gateway.connection


async def test_a_slash_from_an_uninstalled_guild_is_refused_ephemerally() -> None:
    """Global commands appear everywhere; an unmapped guild gets an ephemeral
    refusal rather than an unacknowledged 'interaction failed' (and G3)."""
    gateway = _gateway(
        _FakeInstallService(error=WebhookWorkspaceUnknown("no tenant holds it"))
    )
    interaction = _interaction(GUILD_ID)

    await gateway._on_slash(interaction, _command(), {})

    assert len(interaction.response.refusals) == 1
    assert interaction.response.refusals[0][1] is True  # ephemeral


async def test_a_slash_with_no_guild_is_refused() -> None:
    gateway = _gateway(_FakeInstallService())
    interaction = _interaction(None)

    await gateway._on_slash(interaction, _command(), {})

    assert len(interaction.response.refusals) == 1
