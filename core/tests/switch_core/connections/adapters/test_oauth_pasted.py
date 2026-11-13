"""The OAuth adapter's side of a credential pasted in place of a sign-in:
the MCP check and the identity call it makes, and what it will not do with
one. The vendor's HTTP side is a handler that records each request."""

from __future__ import annotations

import json
import re

import httpx
import pytest
import yaml

from switch_core.connections.adapters import (
    ConnectionNotRevocable,
    ConnectionSecret,
    ReauthorizationRequiredError,
    ServiceAdapterError,
)
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.loader import ConnectionDefinition
from tests.switch_core.connections.test_loader_paste import PASTE_ENTRY

SITE = "eu.example.test"
KEYS = {"api_key": "SYNTHETIC-API-KEY", "application_key": "SYNTHETIC-APP-KEY"}


class Vendor:
    def __init__(
        self, mcp_status: int, identity_status: int, identity_padding: int = 0
    ) -> None:
        self.mcp_status = mcp_status
        self.identity_status = identity_status
        self.identity_padding = identity_padding
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.host == f"mcp.{SITE}":
            return httpx.Response(self.mcp_status, json={"jsonrpc": "2.0", "id": 1})
        if request.url.host == f"api.{SITE}":
            return httpx.Response(
                self.identity_status,
                json={
                    "account": {"id": "acct-eu", "email": "ada@eu.example.test"},
                    "included": "x" * self.identity_padding,
                },
            )
        return httpx.Response(404)


def _adapter(vendor: Vendor, entry: str = PASTE_ENTRY) -> OAuthAdapter:
    return OAuthAdapter(
        ConnectionDefinition.model_validate(yaml.safe_load(entry)),
        StaticClient(OAuthClientCredentials("synthetic-client", None, None)),
        httpx.AsyncClient(transport=httpx.MockTransport(vendor)),
    )


async def test_the_check_is_an_initialize_at_the_sites_server_with_the_headers() -> (
    None
):
    vendor = Vendor(200, 200)
    adapter = _adapter(vendor)
    keys = adapter.paste_method("keys")

    await adapter.check_pasted(keys, KEYS, {"site": SITE})
    identity = await adapter.identify_pasted(keys, KEYS, {"site": SITE})

    initialize, me = vendor.requests
    assert (initialize.method, str(initialize.url)) == (
        "POST",
        f"https://mcp.{SITE}/v1/mcp",
    )
    assert json.loads(initialize.content)["method"] == "initialize"
    for request in (initialize, me):
        assert request.headers["x-example-api-key"] == KEYS["api_key"]
        assert request.headers["x-example-app-key"] == KEYS["application_key"]
        assert request.headers["x-example-site"] == SITE
    assert (me.method, str(me.url)) == ("GET", f"https://api.{SITE}/me")
    assert (identity.account_id, identity.label) == ("acct-eu", "ada@eu.example.test")


async def test_an_identity_answer_larger_than_metadata_is_read() -> None:
    """Datadog's account answer carries the user's roles and permissions and
    is far larger than a metadata or token answer."""
    adapter = _adapter(Vendor(200, 200, identity_padding=200 * 1024))
    keys = adapter.paste_method("keys")

    pasted = await adapter.identify_pasted(keys, KEYS, {"site": SITE})
    signed_in = await adapter.identify("SYNTHETIC-ACCESS-TOKEN", {"site": SITE})

    assert pasted.account_id == signed_in.account_id == "acct-eu"


async def test_an_identity_answer_over_a_mebibyte_is_refused() -> None:
    adapter = _adapter(Vendor(200, 200, identity_padding=1024 * 1024))
    keys = adapter.paste_method("keys")

    with pytest.raises(ServiceAdapterError, match="account is too large"):
        await adapter.identify_pasted(keys, KEYS, {"site": SITE})
    with pytest.raises(ServiceAdapterError, match="account is too large"):
        await adapter.identify("SYNTHETIC-ACCESS-TOKEN", {"site": SITE})


@pytest.mark.parametrize(
    ("status", "error", "message"),
    [
        (401, ReauthorizationRequiredError, "refused the pasted token"),
        (403, ServiceAdapterError, "would not take the pasted token (HTTP 403)"),
        (404, ServiceAdapterError, "(HTTP 404)"),
    ],
)
async def test_a_refusal_for_good_is_told_from_one_that_is_not(
    status: int, error: type[Exception], message: str
) -> None:
    adapter = _adapter(Vendor(status, 200))
    with pytest.raises(error, match=re.escape(message)) as caught:
        await adapter.check_pasted(
            adapter.paste_method("token"), {"pat": "expat_x_SYNTHETIC"}, {"site": SITE}
        )
    if status != 401:
        assert not isinstance(caught.value, ReauthorizationRequiredError)


async def test_a_pasted_credential_is_neither_refreshed_nor_revoked() -> None:
    vendor = Vendor(200, 200)
    adapter = _adapter(vendor)
    keys = adapter.paste_method("keys")
    secret = adapter.pasted_secret(keys, KEYS, {"site": SITE})

    with pytest.raises(ServiceAdapterError, match="not refreshed"):
        await adapter.refresh(secret)
    with pytest.raises(ConnectionNotRevocable, match="cannot revoke them"):
        await adapter.revoke_connection(secret, "keys")
    assert vendor.requests == []


async def test_what_a_disconnect_says_follows_how_the_connection_was_made() -> None:
    """A connection made with keys before its secret recorded how says it is
    keys Switch has forgotten, not a sign-in, and nothing is called."""
    vendor = Vendor(200, 200)
    adapter = _adapter(vendor)
    made_before = ConnectionSecret({"access_token": '{"public":{},"secret":{}}'})

    with pytest.raises(ConnectionNotRevocable) as keys:
        await adapter.revoke_connection(made_before, "keys")
    assert str(keys.value) == (
        "Switch has forgotten the pasted Example keys but cannot revoke them. "
        "Revoke them in Example to stop them working."
    )
    with pytest.raises(ConnectionNotRevocable, match="cannot revoke it. Revoke it"):
        await adapter.revoke_connection(made_before, "token")
    assert vendor.requests == []


def test_a_secret_reads_back_as_what_was_pasted() -> None:
    adapter = _adapter(Vendor(200, 200))
    keys = adapter.paste_method("keys")
    secret = adapter.pasted_secret(keys, KEYS, {"site": SITE})

    pasted = adapter.pasted(secret)

    assert pasted is not None
    assert (pasted.method, pasted.values, pasted.choices) == (
        keys,
        KEYS,
        {"site": SITE},
    )
    assert adapter.pasted(ConnectionSecret({"access_token": "signed-in"})) is None


@pytest.mark.parametrize(
    ("values", "message"),
    [
        ({"method": "token"}, "no longer fit"),
        ({"method": "elsewhere"}, "no longer takes"),
    ],
)
def test_a_secret_this_server_no_longer_takes_must_be_pasted_again(
    values: dict[str, str], message: str
) -> None:
    adapter = _adapter(Vendor(200, 200))
    secret = adapter.pasted_secret(adapter.paste_method("keys"), KEYS, {"site": SITE})
    with pytest.raises(ReauthorizationRequiredError, match=message):
        adapter.pasted(ConnectionSecret({**secret.values, **values}))
