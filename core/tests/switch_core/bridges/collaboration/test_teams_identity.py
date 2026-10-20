"""Who a Teams bridge on the distributed app speaks as.

`OrgTokens` is the one place a SingleTenant bot's two directories meet: every
Bot Connector token comes from Switch's own directory, and every Graph token
from the customer's. Get the delegation backwards and either the bridge posts
with a token the customer's directory never issued, or it reads Graph with a
token the organisation approving the app never granted.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.teams.auth import BOT_CONNECTOR_SCOPE
from switch_core.bridges.collaboration.teams.crypto import ResourceDataError
from switch_core.bridges.collaboration.teams.identity import (
    NotificationKey,
    NotificationKeyring,
    OrgTokens,
)


class _FakeProvider:
    def __init__(self, name: str) -> None:
        self.name = name
        self.invalidated: list[str] = []

    async def bot_token(self) -> str:
        return f"{self.name}-bot-token"

    async def graph_token(self) -> str:
        return f"{self.name}-graph-token"

    async def graph_roles(self) -> frozenset[str]:
        return frozenset({f"{self.name}-role"})

    def invalidate(self, scope: str, *, min_age_seconds: float = 0.0) -> bool:
        self.invalidated.append(scope)
        return True


def _tokens() -> tuple[OrgTokens, _FakeProvider, _FakeProvider]:
    home, org = _FakeProvider("home"), _FakeProvider("org")
    return OrgTokens(home=home, org=org), home, org  # type: ignore[arg-type]


async def test_bot_connector_tokens_come_from_switchs_own_directory() -> None:
    tokens, home, _ = _tokens()

    assert await tokens.bot_token() == "home-bot-token"


async def test_graph_tokens_come_from_the_organisations_own_directory() -> None:
    tokens, _, org = _tokens()

    assert await tokens.graph_token() == "org-graph-token"
    assert await tokens.graph_roles() == frozenset({"org-role"})


def test_invalidating_the_bot_connector_scope_drops_the_home_tenants_token() -> None:
    tokens, home, org = _tokens()

    assert tokens.invalidate(BOT_CONNECTOR_SCOPE) is True

    assert home.invalidated == [BOT_CONNECTOR_SCOPE]
    assert org.invalidated == []


def test_invalidating_any_other_scope_drops_the_organisations_own_token() -> None:
    tokens, home, org = _tokens()

    assert tokens.invalidate("https://graph.microsoft.com/.default") is True

    assert org.invalidated == ["https://graph.microsoft.com/.default"]
    assert home.invalidated == []


def test_a_notification_encrypted_to_a_certificate_held_nowhere_is_refused() -> None:
    current = NotificationKey(certificate_id="switch-current", private_key=None)  # type: ignore[arg-type]
    keyring = NotificationKeyring(
        current=current, certificate_der_b64="ignored", retired=()
    )

    with pytest.raises(ResourceDataError, match="which this deployment does not hold"):
        keyring.decrypt({"encryptionCertificateId": "some-other-cert"})
