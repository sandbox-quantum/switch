from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)


def _service() -> CollaborationBridgeLifecycleService:
    """A service instance for exercising the adapter registry only.

    get_registered_types / get_config_schema touch just the in-memory
    registries populated by register_adapter, so the heavy collaborators are
    irrelevant here and passed as None.
    """
    return CollaborationBridgeLifecycleService(
        bridge_store=None,  # type: ignore[arg-type]
        external_user_store=None,  # type: ignore[arg-type]
        bridge_message_map_store=None,  # type: ignore[arg-type]
        room_store=None,  # type: ignore[arg-type]
        agent_store=None,  # type: ignore[arg-type]
        client_store=None,  # type: ignore[arg-type]
        client_lifecycle=None,  # type: ignore[arg-type]
        room_service=None,  # type: ignore[arg-type]
        matrix_admin=None,  # type: ignore[arg-type]
        session_factory=None,  # type: ignore[arg-type]
        config=None,  # type: ignore[arg-type]
    )


def test_get_registered_types_lists_registered() -> None:
    service = _service()
    service.register_adapter("slack", SlackAdapter, SlackConnectionConfig)
    service.register_adapter(
        "mattermost", MattermostAdapter, MattermostConnectionConfig
    )

    assert sorted(service.get_registered_types()) == ["mattermost", "slack"]


def test_discord_adapter_registers_with_expected_required_fields() -> None:
    service = _service()
    service.register_adapter("discord", DiscordAdapter, DiscordConnectionConfig)

    assert service.get_registered_types() == ["discord"]
    schema = service.get_config_schema("discord")
    assert set(schema["properties"]) == {"bot_token", "guild_id"}
    assert set(schema["required"]) == {"bot_token", "guild_id"}


def test_telegram_adapter_registers_with_expected_required_fields() -> None:
    service = _service()
    service.register_adapter("telegram", TelegramAdapter, TelegramConnectionConfig)

    assert service.get_registered_types() == ["telegram"]
    schema = service.get_config_schema("telegram")
    # bot_username is required alongside the token because every t.me link the
    # bridge hands out is built from it, with no API call to fall back on.
    assert set(schema["properties"]) == {"bot_token", "bot_username"}
    assert set(schema["required"]) == {"bot_token", "bot_username"}


def test_get_config_schema_exposes_required_fields() -> None:
    service = _service()
    service.register_adapter("slack", SlackAdapter, SlackConnectionConfig)

    schema = service.get_config_schema("slack")

    assert set(schema["properties"]) == {"bot_token", "app_token", "workspace_id"}
    assert set(schema["required"]) == {"bot_token", "app_token", "workspace_id"}


def test_get_config_schema_unknown_type_raises() -> None:
    service = _service()
    with pytest.raises(ValueError, match="Unknown bridge type"):
        service.get_config_schema("does-not-exist")


def test_teams_adapter_registers_with_expected_required_fields() -> None:
    service = _service()
    service.register_adapter("teams", TeamsAdapter, TeamsConnectionConfig)

    assert "teams" in service.get_registered_types()

    schema = service.get_config_schema("teams")
    # The credentials + endpoint fields with no default are required; the
    # subscription/encryption fields are optional. client_state is required —
    # it is the only control that authenticates a notification's origin.
    assert set(schema["required"]) == {
        "app_id",
        "app_password",
        "tenant_id",
        "team_id",
        "public_base_url",
        "client_state",
    }
    # Switch-internal fields (the listener bind, the runtime-learned serviceUrl)
    # are hidden from the admin config form — the admin only supplies genuine
    # Teams/Azure credentials + endpoint.
    assert set(schema["properties"]) == {
        "app_id",
        "app_password",
        "tenant_id",
        "team_id",
        "public_base_url",
        "client_state",
        "encryption_certificate_id",
        "encryption_public_certificate",
        "encryption_private_key",
    }
    assert "listen_host" not in schema["properties"]
    assert "listen_port" not in schema["properties"]
    assert "service_url" not in schema["properties"]
