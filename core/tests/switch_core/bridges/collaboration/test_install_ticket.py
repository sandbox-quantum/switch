"""The confirmation ticket, sealed at the callback and opened at the decision."""

from __future__ import annotations

import base64
import json

from cryptography.fernet import Fernet

from switch_core.bridges.collaboration.install import InstallGrant
from switch_core.bridges.collaboration.install_confirmation import (
    InstallTicket,
    open_ticket,
    seal,
)
from switch_core.keys import Purpose
from tests.conftest import TEST_KEYRING


def test_a_ticket_opens_to_what_was_sealed() -> None:
    ticket = InstallTicket(
        tenant_id="tenant-a",
        state_id="state-1",
        platform="teams",
        grant=InstallGrant(
            external_workspace_id="org-1",
            workspace_name="Contoso",
            bot_token=None,
            scopes=["ChannelMessage.Read.All"],
            platform_data={"catalog_app_id": "app-1"},
        ),
    )

    assert (
        open_ticket(seal(ticket, keyring=TEST_KEYRING), keyring=TEST_KEYRING) == ticket
    )


def test_a_ticket_sealed_before_platform_data_existed_still_opens() -> None:
    """A confirmation page left open across the deploy that added platform
    data carries a ticket without it; Connect must still finish the install."""
    payload = {
        "tid": "tenant-a",
        "sid": "state-1",
        "plat": "slack",
        "ws": "T123",
        "name": "Acme",
        "tok": "bot-token-placeholder",
        "scopes": ["chat:write"],
    }
    key = TEST_KEYRING.derive(Purpose.INSTALL_CONFIRM)
    token = (
        Fernet(base64.urlsafe_b64encode(key))
        .encrypt(json.dumps(payload).encode())
        .decode()
    )

    opened = open_ticket(token, keyring=TEST_KEYRING)

    assert opened.grant.platform_data == {}
    assert opened.grant.bot_token == "bot-token-placeholder"
