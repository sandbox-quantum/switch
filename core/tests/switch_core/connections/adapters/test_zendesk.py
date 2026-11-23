"""The shipped Zendesk entry's key check, against Zendesk's own answers.

`/api/v2/users/me.json` names the caller. A token is sent as Basic
credentials, `{email}/token` and the token. The answers below are the ones
Zendesk documents for that call and gives a caller: 401 for a wrong token,
200 with an anonymous user whose id is null for a caller it did not
authenticate, and 404 for a subdomain with no help desk.
"""

from __future__ import annotations

import base64

import httpx
import pytest

from switch_core.connections.adapters import ConnectionNotRevocable
from switch_core.connections.adapters.api_key import ApiKeyAdapter, InvalidKeyError
from switch_core.connections.loader import CATALOG

FIELDS = {
    "subdomain": "acme",
    "email": "ada@example.test",
    "api_token": "SYNTHETIC-ZENDESK-TOKEN",
}
AUTHENTICATED = {
    "user": {
        "id": 35436,
        "url": "https://acme.zendesk.com/api/v2/users/35436.json",
        "name": "Ada Example",
        "email": "ada@example.test",
        "role": "admin",
        "verified": True,
    }
}
ANONYMOUS = {
    "user": {
        "id": None,
        "url": None,
        "name": "Anonymous user",
        "email": "invalid@example.com",
        "role": "end-user",
        "verified": False,
    }
}


class ZendeskStandIn:
    """Answers `/api/v2/users/me.json` as Zendesk does."""

    def __init__(self, answer: httpx.Response) -> None:
        self.answer = answer
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.answer


def _adapter(zendesk: ZendeskStandIn) -> ApiKeyAdapter:
    return ApiKeyAdapter(
        CATALOG["zendesk"].definition,
        httpx.AsyncClient(transport=httpx.MockTransport(zendesk)),
    )


def test_the_entry_is_coming_soon_and_never_hands_a_token_to_an_agent() -> None:
    definition = CATALOG["zendesk"].definition
    assert definition.enabled is False
    assert definition.adapter == "api_key"
    assert definition.mcp is None and definition.cli is None
    assert definition.access is None
    assert definition.token is not None
    assert definition.token.max_lifetime is None
    assert definition.token.issued_to_agents is False
    sign_in = definition.auth.api_key
    assert sign_in is not None
    assert [(f.name, f.secret) for f in sign_in.fields] == [
        ("subdomain", False),
        ("email", False),
        ("api_token", True),
    ]
    assert sign_in.pattern_names() == {"subdomain", "email"}


async def test_the_authenticated_user_names_the_connection() -> None:
    zendesk = ZendeskStandIn(httpx.Response(200, json=AUTHENTICATED))

    identity = await _adapter(zendesk).identify(FIELDS)

    assert (identity.account_id, identity.label) == ("35436", "ada@example.test")
    [request] = zendesk.requests
    assert request.method == "GET"
    assert str(request.url) == "https://acme.zendesk.com/api/v2/users/me.json"
    scheme, _, encoded = request.headers["Authorization"].partition(" ")
    assert scheme == "Basic"
    assert (
        base64.b64decode(encoded).decode()
        == "ada@example.test/token:SYNTHETIC-ZENDESK-TOKEN"
    )


async def test_the_anonymous_user_is_a_failed_check() -> None:
    zendesk = ZendeskStandIn(httpx.Response(200, json=ANONYMOUS))
    with pytest.raises(InvalidKeyError, match="did not name the key's account"):
        await _adapter(zendesk).identify(FIELDS)


async def test_a_wrong_token_is_refused() -> None:
    zendesk = ZendeskStandIn(
        httpx.Response(
            401,
            json={
                "error": {
                    "title": "Unauthorized",
                    "message": "Couldn't authenticate you",
                }
            },
        )
    )
    with pytest.raises(InvalidKeyError, match=r"Zendesk refused the key \(HTTP 401\)"):
        await _adapter(zendesk).identify(FIELDS)


async def test_a_subdomain_with_no_help_desk_is_refused() -> None:
    zendesk = ZendeskStandIn(
        httpx.Response(
            404,
            json={
                "error": {
                    "title": "No help desk at nobody.zendesk.com",
                    "message": "There is no help desk configured at this address.",
                }
            },
        )
    )
    with pytest.raises(InvalidKeyError, match=r"HTTP 404"):
        await _adapter(zendesk).identify({**FIELDS, "subdomain": "nobody"})


@pytest.mark.parametrize(
    "subdomain",
    ["acme.evil.test", "acme/x", "evil.test#", "-acme", "acme-", "", "a" * 64],
)
def test_a_subdomain_is_one_dns_label(subdomain: str) -> None:
    zendesk = ZendeskStandIn(httpx.Response(200, json=AUTHENTICATED))
    with pytest.raises(InvalidKeyError):
        _adapter(zendesk).checked_fields({**FIELDS, "subdomain": subdomain})
    assert zendesk.requests == []


@pytest.mark.parametrize(
    "email", ["ada", "ada@", "a:b@example.test", "ada @example.test"]
)
def test_an_email_never_carries_a_colon_or_a_space(email: str) -> None:
    zendesk = ZendeskStandIn(httpx.Response(200, json=AUTHENTICATED))
    with pytest.raises(InvalidKeyError):
        _adapter(zendesk).checked_fields({**FIELDS, "email": email})


async def test_disconnecting_says_only_zendesk_can_revoke_the_token() -> None:
    zendesk = ZendeskStandIn(httpx.Response(200, json=AUTHENTICATED))
    adapter = _adapter(zendesk)
    with pytest.raises(ConnectionNotRevocable, match="Revoke it in Zendesk"):
        await adapter.revoke_connection(adapter.secret(FIELDS), "keys")
    assert zendesk.requests == []
