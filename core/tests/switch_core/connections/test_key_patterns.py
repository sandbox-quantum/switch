"""Synthetic catalog/input cases; no vendor requests or credentials."""

import copy

import httpx
import pytest

from switch_core.connections.adapters.api_key import ApiKeyAdapter, InvalidKeyError
from switch_core.connections.loader import ApiKeyField, ConnectionDefinition
from switch_core.gateway.service_connections import _key_form

ENTRY = {
    "slug": "example",
    "name": "Example",
    "category": "Support",
    "description": "Synthetic identifier contract.",
    "enabled": False,
    "adapter": "api_key",
    "auth": {
        "type": "api_key",
        "refresh": "none",
        "api_key": {
            "fields": [
                {
                    "name": "account",
                    "label": "Account",
                    "secret": False,
                    "pattern": "^[a-z][a-z0-9-]{0,62}$",
                },
                {"name": "api_key", "label": "Key", "secret": True},
            ],
            "identity": {
                "method": "GET",
                "url": "https://{account}.example.test/api/me",
                "headers": {"API-Key": "{api_key}"},
            },
        },
    },
    "token": {"kind": "pass_through", "max_lifetime": None},
}


def definition(
    url: str = "https://{account}.example.test/api/me",
) -> ConnectionDefinition:
    entry = copy.deepcopy(ENTRY)
    entry["auth"]["api_key"]["identity"]["url"] = url
    return ConnectionDefinition.model_validate(entry)


@pytest.mark.parametrize(
    "url",
    [
        "https://{account}.example.test/api/me",
        "https://api.example.test/accounts/{account}/me",
        "https://{account}.api.example.test/{account}/me",
    ],
)
def test_pattern_identifiers_occupy_complete_fixed_domain_components(url: str) -> None:
    assert definition(url).auth.api_key.fields[0].pattern


@pytest.mark.parametrize(
    "url",
    [
        "https://{account}/me",
        "https://{account}.test/me",
        "https://prefix-{account}.example.test/me",
        "https://api.example.test/accounts/prefix-{account}",
        "https://{account}@api.example.test/me",
        "https://api.example.test:{account}/me",
        "https://api.example.test:443/{account}",
        "https://api.example.test/me?account={account}",
        "https://api.example.test/me#{account}",
        "https://{account}.example.test/me?again={account}",
        "https://{account}.example.test/{api_key}",
    ],
)
def test_pattern_templates_cannot_change_authority_or_partial_components(
    url: str,
) -> None:
    with pytest.raises(ValueError):
        definition(url)


@pytest.mark.parametrize(
    "extra",
    [
        {"secret": True, "pattern": "^[a-z]+$"},
        {"secret": False, "pattern": "^[a-z]+$", "choices": ["example"]},
        {"secret": False},
        {"secret": False, "pattern": "[a-z]+"},
        {"secret": False, "pattern": r"^(a)\1$"},
    ],
)
def test_field_kinds_and_linear_anchored_patterns_are_checked(extra: dict) -> None:
    with pytest.raises(ValueError):
        ApiKeyField.model_validate({"name": "account", "label": "Account", **extra})


async def test_values_are_rechecked_before_the_identity_http_request() -> None:
    requests = []
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: requests.append(r) or httpx.Response(200)
        )
    ) as http:
        adapter = ApiKeyAdapter(definition(), http)
        for value in [
            "other.test",
            "../path",
            "user@host",
            "a/b",
            "a%2fb",
            "a?b",
            "a#b",
            "a:443",
            "a\\b",
            "é",
            "a" * 64,
        ]:
            with pytest.raises(InvalidKeyError):
                await adapter.identify({"account": value, "api_key": "SYNTHETIC-KEY"})
        with pytest.raises(InvalidKeyError):
            await adapter.identify(
                {"account": "example", "api_key": "SYNTHETIC-KEY", "unknown": "extra"}
            )
        assert requests == []
        await adapter.identify({"account": "example-1", "api_key": "SYNTHETIC-KEY"})
        assert str(requests[0].url) == "https://example-1.example.test/api/me"


async def test_permissive_catalog_regex_still_cannot_admit_url_syntax() -> None:
    entry = copy.deepcopy(ENTRY)
    entry["auth"]["api_key"]["fields"][0]["pattern"] = "^.*$"
    async with httpx.AsyncClient() as http:
        adapter = ApiKeyAdapter(ConnectionDefinition.model_validate(entry), http)
        for value in ["a.example.test", "a/b", "user@host", "a%2fb"]:
            with pytest.raises(InvalidKeyError):
                adapter.checked_fields({"account": value, "api_key": "SYNTHETIC-KEY"})


def test_pattern_is_presented_to_console_without_changing_legacy_choices() -> None:
    assert _key_form(definition())["fields"][0]["pattern"] == "^[a-z][a-z0-9-]{0,62}$"
    field = ApiKeyField.model_validate(
        {
            "name": "region",
            "label": "Region",
            "secret": False,
            "choices": ["example.test"],
        }
    )
    assert field.pattern is None


@pytest.mark.parametrize(
    "pattern", ["^[a-$", "^(?=a)a$", r"^(a)\1$", "^a$)|(?:x)|(?:^b$"]
)
def test_invalid_patterns_become_catalog_errors(tmp_path, pattern: str) -> None:
    import yaml

    from switch_core.connections.loader import CatalogError, load_catalog

    entry = copy.deepcopy(ENTRY)
    entry["auth"]["api_key"]["fields"][0]["pattern"] = pattern
    folder = tmp_path / "example"
    folder.mkdir()
    (folder / "connection.yaml").write_text(yaml.safe_dump(entry))
    with pytest.raises(CatalogError, match="example is invalid"):
        load_catalog(tmp_path)
