from __future__ import annotations

import pytest
from pydantic import ValidationError as PydanticValidationError

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
    # agent_roles is offered but not required: it needs Manage Roles and room
    # under Discord's 250-role cap, so a connection stays valid without it.
    assert set(schema["properties"]) == {"bot_token", "guild_id", "agent_roles"}
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

    # agent_usergroups is offered but not required: it needs a paid plan and an
    # admin-granted permission, so a connection stays valid without it.
    assert set(schema["properties"]) == {
        "bot_token",
        "app_token",
        "workspace_id",
        "agent_usergroups",
        "agent_sessions",
    }
    assert set(schema["required"]) == {"bot_token", "app_token", "workspace_id"}


def test_get_config_schema_unknown_type_raises() -> None:
    service = _service()
    with pytest.raises(ValueError, match="Unknown bridge type"):
        service.get_config_schema("does-not-exist")


# ── Channel-creation capability ──────────────────────────────────────────────


def test_only_telegram_cannot_create_channels() -> None:
    # A platform fact, not a preference. Telegram's Bot API has no call to make
    # a chat; every other platform Switch bridges to does.
    assert TelegramAdapter.supports_channel_creation is False
    for adapter in (SlackAdapter, MattermostAdapter, DiscordAdapter, TeamsAdapter):
        assert adapter.supports_channel_creation is True


def test_capability_is_answerable_without_a_running_bridge() -> None:
    # Read from the registered class, not a live adapter, because the operator
    # needs the answer while registering a connection and while one is stopped.
    service = _service()
    service.register_adapter("telegram", TelegramAdapter, TelegramConnectionConfig)
    service.register_adapter("slack", SlackAdapter, SlackConnectionConfig)

    assert service.supports_channel_creation("telegram") is False
    assert service.supports_channel_creation("slack") is True


def test_an_unregistered_type_is_not_reported_as_incapable() -> None:
    # Registration rejects an unknown type by name, which is a better error than
    # a capability claim about a platform Switch does not have.
    assert _service().supports_channel_creation("does-not-exist") is True


async def test_registering_telegram_cannot_grant_channel_creation() -> None:
    # The operator switch only ever narrows the platform's ceiling. Storing
    # "allowed" here would be a claim the connection could never honour.
    service = _service()
    service.register_adapter("telegram", TelegramAdapter, TelegramConnectionConfig)

    with pytest.raises(ValueError, match="cannot create channels"):
        await service.register(
            bridge_type="telegram",
            display_name="Acme Telegram",
            connection_config={"bot_token": "t", "bot_username": "b"},
            channel_creation_enabled=True,
        )


def test_teams_adapter_registers_with_expected_required_fields() -> None:
    service = _service()
    service.register_adapter("teams", TeamsAdapter, TeamsConnectionConfig)

    assert "teams" in service.get_registered_types()

    schema = service.get_config_schema("teams")
    # Every field on the form is a value the operator has to fetch from Azure,
    # and all of them are required — there is no such thing as a half-configured
    # Teams bridge.
    assert set(schema["required"]) == {
        "app_id",
        "app_password",
        "tenant_id",
        "team_id",
        "public_base_url",
    }
    assert set(schema["properties"]) == set(schema["required"])
    # Switch-internal fields are hidden: the listener bind and the
    # runtime-learned serviceUrl, plus everything Switch generates for itself —
    # the clientState shared secret and the Graph encryption trio. Asking an
    # operator to invent a secret or paste PEMs is three ways to get a silently
    # broken bridge.
    for hidden in (
        "listen_host",
        "listen_port",
        "service_url",
        "client_state",
        "encryption_certificate_id",
        "encryption_public_certificate",
        "encryption_private_key",
        "channel_teams",
    ):
        assert hidden not in schema["properties"]


# ── Connection config validation ─────────────────────────────────────────────


def test_validate_connection_config_accepts_a_valid_edit() -> None:
    service = _service()
    service.register_adapter("slack", SlackAdapter, SlackConnectionConfig)

    service.validate_connection_config(
        "slack",
        {
            "bot_token": "xoxb-1",
            "app_token": "xapp-1",
            "workspace_id": "T1",
            "agent_usergroups": True,
        },
    )


def test_validate_connection_config_rejects_a_broken_edit() -> None:
    # Editing a connection is checked before it is stored: a config the adapter
    # cannot parse would otherwise take the bridge down at its next start, long
    # after the request that caused it.
    service = _service()
    service.register_adapter("slack", SlackAdapter, SlackConnectionConfig)

    with pytest.raises(PydanticValidationError):
        service.validate_connection_config("slack", {"bot_token": "xoxb-1"})


def test_validate_connection_config_unknown_type_raises() -> None:
    service = _service()
    with pytest.raises(ValueError, match="Unknown bridge type"):
        service.validate_connection_config("does-not-exist", {})
