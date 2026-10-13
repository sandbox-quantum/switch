"""The providers and their advanced-configuration fields, as the gateway
serves them to every client — Switch Console builds the advanced form of each
agent, its own and managed ones, from these."""

from __future__ import annotations

from typing import Any

from switch_core.providers.registry import agent_providers


def advanced_config_schema() -> dict[str, Any]:
    """Every provider's fields, as `GET /gateway/management/advanced-config`
    serves them."""
    return {
        "providers": {
            provider.id: {
                "fields": [field.wire() for field in provider.advanced_fields]
            }
            for provider in agent_providers()
        }
    }


def providers_schema() -> dict[str, Any]:
    """Every provider a definition can name, in the order a client offers
    them, as `GET /gateway/management/providers` serves them."""
    return {
        "providers": [
            {
                "id": provider.id,
                "label": provider.label,
                "advanced_fields": [field.wire() for field in provider.advanced_fields],
            }
            for provider in agent_providers()
        ]
    }
