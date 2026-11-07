import httpx
import pytest
import yaml
from pydantic import ValidationError

from switch_core.connections.adapters import ServiceAdapterError
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.loader import ConnectionDefinition
from tests.switch_core.connections.test_loader import OAUTH_ENTRY


def definition(parts):
    body = yaml.safe_load(OAUTH_ENTRY)
    body["auth"]["identity"]["account_id"] = parts
    return ConnectionDefinition.model_validate(body)


@pytest.mark.parametrize("parts", [[], ["account.id", "bad/path"], [4]])
def test_account_paths_are_nonempty_and_valid(parts):
    with pytest.raises(ValidationError):
        definition(parts)


@pytest.mark.parametrize(
    "account, expected",
    [
        ({"tenant": "a:b", "id": "c/d%"}, "a%3Ab:c%2Fd%25"),
        ({"tenant": "a", "id": 17}, "a:17"),
    ],
)
async def test_account_parts_have_unambiguous_escaped_boundaries(account, expected):
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"account": account})
        )
    )
    adapter = OAuthAdapter(
        definition(["account.tenant", "account.id"]),
        StaticClient(OAuthClientCredentials("client", None, None)),
        http,
    )
    assert (await adapter.identify("secret")).account_id == expected


@pytest.mark.parametrize("value", [None, "", [], {}, True, 1.5])
async def test_missing_or_nonscalar_part_never_becomes_an_account(value):
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, json={"account": {"tenant": "a", "id": value}}
            )
        )
    )
    adapter = OAuthAdapter(
        definition(["account.tenant", "account.id"]),
        StaticClient(OAuthClientCredentials("client", None, None)),
        http,
    )
    with pytest.raises(ServiceAdapterError):
        await adapter.identify("secret")
