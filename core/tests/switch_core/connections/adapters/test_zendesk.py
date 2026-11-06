"""Documented Zendesk Show Self shapes, using synthetic data and MockTransport.

No Zendesk account is configured and no live sign-in is claimed. The official
Users reference allows anonymous Show Self requests, so HTTP 200 is insufficient:
https://developer.zendesk.com/api-reference/ticketing/users/users/#show-self
https://github.com/sandbox-quantum/switch/issues/843#issuecomment-6624736482
"""

import base64

import httpx
import pytest

from switch_core.connections.adapters.api_key import ApiKeyAdapter, InvalidKeyError
from switch_core.connections.loader import CATALOG, ConnectionDefinition

FIELDS = {
    "subdomain": "example",
    "email": "support@example.test",
    "api_token": "SYNTHETIC-ZENDESK-TOKEN",
}


async def test_documented_authenticated_user_shape_and_basic_auth() -> None:
    requests = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "user": {
                    "id": 42,
                    "name": "Synthetic user",
                    "email": "support@example.test",
                    "role": "agent",
                }
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        adapter = ApiKeyAdapter(CATALOG["zendesk"].definition, http)
        identity = await adapter.identify(FIELDS)
    assert (identity.account_id, identity.label) == ("42", "support@example.test")
    [request] = requests
    assert str(request.url) == "https://example.zendesk.com/api/v2/users/me.json"
    expected = base64.b64encode(
        b"support@example.test/token:SYNTHETIC-ZENDESK-TOKEN"
    ).decode()
    assert request.headers["Authorization"] == "Basic " + expected
    assert "SYNTHETIC" not in str(request.url)


@pytest.mark.parametrize("identifier", [None, -1, 0, "", "-1", True])
async def test_anonymous_or_malformed_200_response_never_identifies_an_account(
    identifier,
) -> None:
    # Synthetic variants cover both anonymous/null and invalid ID representations.
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(
                200,
                json={
                    "user": {"id": identifier, "name": "Anonymous user", "email": None}
                },
            )
        )
    ) as http:
        adapter = ApiKeyAdapter(CATALOG["zendesk"].definition, http)
        with pytest.raises(InvalidKeyError):
            await adapter.identify(FIELDS)


@pytest.mark.parametrize("status", [401, 403, 302])
async def test_refusals_and_redirects_are_not_followed(status: int) -> None:
    requests = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            status, headers={"Location": "https://other.example.test/"}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        with pytest.raises(InvalidKeyError):
            await ApiKeyAdapter(CATALOG["zendesk"].definition, http).identify(FIELDS)
    assert len(requests) == 1


@pytest.mark.parametrize("header", ["Authorization", "authorization", "AUTHORIZATION"])
def test_basic_auth_cannot_conflict_with_an_authorization_header(header: str) -> None:
    entry = CATALOG["zendesk"].definition.model_dump()
    entry["auth"]["api_key"]["identity"]["headers"][header] = "Bearer {api_token}"
    with pytest.raises(ValueError, match="not both"):
        ConnectionDefinition.model_validate(entry)


def test_basic_auth_templates_name_only_declared_fields() -> None:
    entry = CATALOG["zendesk"].definition.model_dump()
    entry["auth"]["api_key"]["identity"]["basic_auth"]["password"] = "{unknown}"
    with pytest.raises(ValueError, match="unknown field"):
        ConnectionDefinition.model_validate(entry)


def test_the_entry_loads_but_cannot_advertise_a_transport_or_finite_key_lifetime() -> (
    None
):
    entry = CATALOG["zendesk"]
    assert entry.definition.enabled is False
    assert entry.definition.adapter == "api_key"
    assert entry.definition.mcp is entry.definition.cli is None
    assert entry.definition.token.max_lifetime is None
    assert entry.skill_files == {}
