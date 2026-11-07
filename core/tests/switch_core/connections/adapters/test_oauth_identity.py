"""Identity request contracts, without a live provider or database."""

import json

import httpx
import pytest
import yaml
from pydantic import ValidationError

from switch_core.connections.adapters import (
    ReauthorizationRequiredError,
    ServiceAdapterError,
)
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.loader import ConnectionDefinition, ConnectionIdentity
from tests.switch_core.connections.test_loader import OAUTH_ENTRY

IDENTITY = {
    "url": "https://api.example.test/v2",
    "account_id": "data.me.id",
    "label": "data.me.email",
}
QUERY = {"query": "{ me { id email } }"}


@pytest.mark.parametrize("method", [None, "GET", "POST"])
@pytest.mark.parametrize("body", [None, {}, QUERY])
def test_identity_method_and_static_body_are_validated(method, body):
    values = {**IDENTITY, "body": body}
    if method is not None:
        values["method"] = method
    if body is not None and method != "POST":
        with pytest.raises(ValidationError, match="only a POST"):
            ConnectionIdentity.model_validate(values)
    else:
        identity = ConnectionIdentity.model_validate(values)
        assert identity.method == (method or "GET")
        assert identity.body == body


@pytest.mark.parametrize(
    "extra",
    [
        {"method": "DELETE"},
        {"method": "post"},
        {"url": "http://api.example.test/v2"},
        {"method": "POST", "body": "query { me { id } }"},
        {"method": "POST", "body": ["query"]},
        {"method": "POST", "body": {"query": object()}},
        {"headers": {"Authorization": "arbitrary"}},
    ],
)
def test_identity_rejects_unsupported_requests(extra):
    with pytest.raises(ValidationError):
        ConnectionIdentity.model_validate({**IDENTITY, **extra})


def _definition(identity):
    values = yaml.safe_load(OAUTH_ENTRY)
    values["auth"]["identity"] = identity
    return ConnectionDefinition.model_validate(values)


@pytest.mark.parametrize(
    "method,body",
    [(None, None), ("GET", None), ("POST", None), ("POST", {}), ("POST", QUERY)],
)
async def test_identity_sends_only_the_configured_request(method, body):
    identity = {**IDENTITY, "body": body}
    if method is not None:
        identity["method"] = method
    requests = []

    def handle(request):
        requests.append(request)
        assert request.method == (method or "GET")
        assert str(request.url) == IDENTITY["url"]
        assert request.headers["Authorization"] == "Bearer identity-placeholder"
        assert request.headers["Accept"] == "application/json"
        if body is None:
            assert request.content == b""
            assert "content-type" not in request.headers
        else:
            assert request.headers["content-type"] == "application/json"
            assert json.loads(request.content) == body
            assert b"identity-placeholder" not in request.content
        return httpx.Response(
            200, json={"data": {"me": {"id": 1001, "email": "user@example.test"}}}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        adapter = OAuthAdapter(
            _definition(identity),
            StaticClient(OAuthClientCredentials("example-client", None, None)),
            http,
        )
        result = await adapter.identify("identity-placeholder")
    assert (result.account_id, result.label) == ("1001", "user@example.test")
    assert len(requests) == 1


@pytest.mark.parametrize(
    "status,body,error",
    [
        (401, {}, ReauthorizationRequiredError),
        (403, {}, ServiceAdapterError),
        (429, {}, ServiceAdapterError),
        (500, {}, ServiceAdapterError),
        (200, {"errors": [{"message": "Permission denied"}]}, ServiceAdapterError),
        (200, {"data": {"me": None}}, ServiceAdapterError),
        (200, {"data": {"me": {"id": True}}}, ServiceAdapterError),
        (200, {"data": {"me": {"id": ""}}}, ServiceAdapterError),
        (200, [], ServiceAdapterError),
    ],
)
async def test_post_identity_keeps_response_validation(status, body, error):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(status, json=body))
    ) as http:
        adapter = OAuthAdapter(
            _definition({**IDENTITY, "method": "POST", "body": QUERY}),
            StaticClient(OAuthClientCredentials("example-client", None, None)),
            http,
        )
        with pytest.raises(error):
            await adapter.identify("identity-placeholder")
