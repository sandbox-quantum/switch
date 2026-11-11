"""Request-only OIDC parameters never replace resource authorization."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError

from switch_core.connections.app_checks import check_oauth_client
from switch_core.connections.app_credentials import AppValues
from switch_core.connections.flows import FlowError, ServiceFlows
from switch_core.connections.loader import CATALOG, ConnectionDefinition
from switch_core.connections.registry import every_scope

BASE = "api://2a72489c-aab2-4b65-b93a-a91edccf33b8/Ado.Mcp.Tools"


def consent(granted):
    d = CATALOG["azure-devops"].definition
    e = SimpleNamespace(
        signed_in=SimpleNamespace(granted_scopes=granted),
        flow=SimpleNamespace(
            details={
                "name": d.name,
                "consent": "write",
                "read_scopes": None,
                "write_scopes": d.access.write.scopes,
            }
        ),
    )
    return ServiceFlows(None, None).consent(e)


@pytest.mark.parametrize(
    "granted", [[BASE], [BASE, "openid"], [BASE, "openid", "offline_access"]]
)
def test_resource_scope_is_sufficient(granted):
    assert consent(granted) == "write"


@pytest.mark.parametrize("granted", [[], ["offline_access", "openid"], ["other"]])
def test_oidc_does_not_grant_resource_access(granted):
    with pytest.raises(FlowError):
        consent(granted)


async def test_flow_preserves_requests_but_compares_resource_only():
    store = SimpleNamespace(start=AsyncMock(return_value=SimpleNamespace()))
    d = CATALOG["azure-devops"].definition
    await ServiceFlows(None, store).start(
        definition=d,
        tenant_id="tenant",
        user_id="user",
        state="state",
        port=39251,
        completion_secret="secret",
        owner_label="QA",
    )
    details = store.start.call_args.kwargs["details"]
    assert details["scopes"] == [BASE, "offline_access", "openid"]
    assert details["write_scopes"] == [BASE]
    assert every_scope(d) == details["scopes"]


@pytest.mark.parametrize(
    "bad", ["Ado.Mcp.Tools", "https://example.test/write", "arbitrary"]
)
def test_request_only_scope_allowlist(bad):
    data = CATALOG["azure-devops"].definition.model_dump()
    data["auth"]["oauth"]["request_scopes"] = [bad]
    with pytest.raises(ValidationError):
        ConnectionDefinition.model_validate(data)


def test_other_catalog_entries_do_not_opt_in():
    for name, entry in CATALOG.items():
        oauth = entry.definition.auth.oauth
        if oauth and name != "azure-devops":
            assert not oauth.request_scopes


@pytest.mark.parametrize("error", ["invalid_grant", "invalid_client", "unknown_error"])
async def test_azure_probe_never_proves_nonexistent_client(error):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(400, json={"error": error})
        )
    ) as http:
        result = await check_oauth_client(
            http,
            CATALOG["azure-devops"].definition,
            AppValues("synthetic-nonexistent-client", {}, {}),
            "http://127.0.0.1:39251/callback",
        )
    assert not result.ok
    assert not result.checks[0].ok
    assert "accepts this client" not in result.checks[0].message
    if error == "invalid_grant":
        assert (
            "No credentials or redirect have been verified" in result.checks[0].message
        )


@pytest.mark.parametrize(
    "scopes", [[], ["openid"], ["offline_access"], [BASE, "openid"]]
)
def test_opt_in_needs_separate_real_resource_scope(scopes):
    data = CATALOG["azure-devops"].definition.model_dump()
    data["access"]["write"]["scopes"] = scopes
    with pytest.raises(ValidationError):
        ConnectionDefinition.model_validate(data)


def test_duplicate_request_scopes_are_refused():
    data = CATALOG["azure-devops"].definition.model_dump()
    data["auth"]["oauth"]["request_scopes"] = ["openid", "openid"]
    with pytest.raises(ValidationError):
        ConnectionDefinition.model_validate(data)


def test_refresh_token_is_still_required():
    from switch_core.connections.adapters import ServiceAdapterError
    from switch_core.connections.adapters.oauth import (
        OAuthAdapter,
        OAuthClientCredentials,
        StaticClient,
    )

    d = CATALOG["azure-devops"].definition
    adapter = OAuthAdapter(
        d,
        StaticClient(OAuthClientCredentials("synthetic", None, None)),
        httpx.AsyncClient(),
    )
    with pytest.raises(ServiceAdapterError, match="no refresh token"):
        adapter._credentials(
            {"access_token": "synthetic", "expires_in": 3600, "scope": BASE}, {}
        )
