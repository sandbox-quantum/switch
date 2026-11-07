"""HubSpot root IDs: explicit spellings, strict types and no inferred identity."""

from itertools import product
from unittest.mock import AsyncMock

import httpx
import pytest

from switch_core.connections.adapters import ServiceAdapterError
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
    _hubspot_identity,
)
from switch_core.connections.loader import CATALOG_ROOT, load_catalog

USERS = ("userId", "userid", "user_id", "UserId", "UserID", "userID")
ACCOUNTS = (
    "accountId",
    "accountid",
    "account_id",
    "AccountId",
    "AccountID",
    "accountID",
)


@pytest.mark.parametrize("user,account", list(product(USERS, ACCOUNTS)))
def test_explicit_root_spellings(user, account):
    assert _hubspot_identity({user: 17, account: 29, "email": "not-returned"}) == {
        "userId": 17,
        "accountId": 29,
    }


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"userId": 17},
        {"accountId": 29},
        {"userId": 17, "hubId": 29},
        {"userId": True, "accountId": 29},
        {"userId": 17, "accountId": False},
        {"userId": "17", "accountId": 29},
        {"userId": 17, "accountId": "29"},
        {"userId": None, "accountId": 29},
        {"data": {"userId": 17, "accountId": 29}},
        {"userId": 17, "userid": 17, "accountId": 29},
        {"userId": 17, "accountId": 29, "account_id": 30},
        {"userId": 17, "accountId": 29, "account_id": 29},
        {"USER-ID": 17, "ACCOUNT-ID": 29},
    ],
)
def test_missing_ambiguous_or_wrong_type_fails_closed(payload):
    with pytest.raises(ServiceAdapterError, match="unambiguous user and account"):
        _hubspot_identity(payload)


async def test_actual_hubspot_catalog_identifies_user_and_account_without_private_values(
    monkeypatch,
):
    definition = load_catalog(CATALOG_ROOT)["hubspot"].definition
    async with httpx.AsyncClient() as http:
        adapter = OAuthAdapter(
            definition,
            StaticClient(OAuthClientCredentials("example", None, authentication=None)),
            http,
        )
        monkeypatch.setattr(
            adapter,
            "_mcp_identity",
            AsyncMock(
                return_value={
                    "user_id": 17,
                    "accountId": 29,
                    "email": "private@example.test",
                }
            ),
        )
        identity = await adapter.identify("not-a-real-token")
    assert identity.account_id == "17:29"
    assert identity.label == "17:29"


async def test_two_accounts_for_same_user_stay_separate(monkeypatch):
    definition = load_catalog(CATALOG_ROOT)["hubspot"].definition
    async with httpx.AsyncClient() as http:
        adapter = OAuthAdapter(
            definition,
            StaticClient(OAuthClientCredentials("example", None, authentication=None)),
            http,
        )
        mock = AsyncMock(
            side_effect=[
                {"userId": 17, "accountId": 29},
                {"userid": 17, "account_id": 30},
            ]
        )
        monkeypatch.setattr(adapter, "_mcp_identity", mock)
        first = await adapter.identify("not-a-real-token")
        second = await adapter.identify("not-a-real-token")
    assert (first.account_id, second.account_id) == ("17:29", "17:30")
