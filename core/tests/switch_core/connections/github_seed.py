"""GitHub as a cloud launch's tests need it: connected, granted, behind a broker.

The owner's GitHub connection and the launch agent's write grant on its
repository, as a cloud launch leaves them, and a broker whose GitHub is the
fake vendor, so the hosted routes issue and revoke against it.
"""

from __future__ import annotations

import json
import time
from datetime import timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.broker import ServiceBroker
from switch_core.connections.loader import CATALOG
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.keys import Keyring
from tests.switch_core.connections.fake_vendor import FakeVendor

STORE = ServiceConnectionStore()
INSTALLATION_ID = 123
REPOSITORY_ID = 456


@pytest.fixture
def github_vendor() -> FakeVendor:
    return FakeVendor()


async def connect_github(session: AsyncSession, owner: str, keyring: Keyring) -> None:
    await STORE.save_connection(
        session,
        user_id=owner,
        service="github",
        consent="write",
        granted_scopes=[],
        account_id="1001",
        external_identity="example-user",
        encrypted_secret=keyring.encrypt(
            json.dumps(
                {
                    "access_token": "SYNTHETIC-GITHUB",
                    "expires_at": time.time() + 3600,
                    "refresh_token": "SYNTHETIC-REFRESH",
                    "refresh_expires_at": time.time() + 7200,
                    "login": "example-user",
                    "user_id": 1001,
                }
            )
        ),
    )


async def grant_repository(session: AsyncSession, agent_id: str, owner: str) -> None:
    await STORE.save_grant(
        session,
        agent_id=agent_id,
        owner_id=owner,
        service="github",
        access="write",
        tool_mode="deny",
        tools=[],
        resources={
            "installation_id": INSTALLATION_ID,
            "repository_ids": [REPOSITORY_ID],
        },
        account_id="1001",
        created_by=owner,
    )


def github_broker(
    session_factory: async_sessionmaker[AsyncSession],
    keyring: Keyring,
    vendor: FakeVendor,
) -> ServiceBroker:
    return ServiceBroker(
        session_factory=session_factory,
        keyring=keyring,
        catalog=CATALOG,
        adapters={"github": vendor},
        store=STORE,
        token_retention=timedelta(days=30),
    )
