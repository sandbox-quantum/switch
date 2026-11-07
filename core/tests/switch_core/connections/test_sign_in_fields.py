import re

import pytest
import yaml
from pydantic import ValidationError

from switch_core.connections.loader import (
    ConnectionDefinition,
    render_mcp_url,
    sign_in_field_values,
)

from .test_loader import FIELDS_ENTRY, OAUTH_ENTRY

URL = "https://mcp.example.test/v1/mcp/{tenant}"
FIELD = """      - name: tenant
        label: Example team
        help: Your team's name, such as team-a.
        pattern: '^[a-z0-9-]{1,30}$'
"""
STATIC = "registration: static\n    client_settings: EXAMPLE"


def load(text=FIELDS_ENTRY):
    return ConnectionDefinition.model_validate(yaml.safe_load(text))


def test_an_entry_with_a_sign_in_field_loads():
    definition = load()
    assert definition.auth.oauth.fields[0].name == "tenant"
    assert definition.mcp.servers[0].url == URL


@pytest.mark.parametrize(
    ("text", "message"),
    [
        (
            FIELDS_ENTRY.replace(
                "registration: dynamic",
                STATIC
                + "\n    authorization_url: https://example.test/authorize"
                + "\n    token_url: https://example.test/{tenant}/token",
            ),
            "an oauth entry's authorization, token, revocation and identity URLs stay fixed",
        ),
        (FIELDS_ENTRY.replace(FIELD, FIELD + FIELD), "two sign-in fields share a name"),
        (
            FIELDS_ENTRY.replace(URL, URL.replace("{tenant}", "{team}")),
            "an oauth entry's MCP URL names only its sign-in fields",
        ),
        (
            OAUTH_ENTRY.replace("https://mcp.example.test/v1/mcp", URL),
            "an oauth entry's MCP URL names only its sign-in fields",
        ),
        *[
            (
                FIELDS_ENTRY.replace(URL, url),
                "tenant fills a whole path segment, or a whole host label left of a fixed domain, of an MCP URL",
            )
            for url in [
                "https://mcp.example.test/v1/mcp-{tenant}",
                "https://{tenant}.test/mcp",
                "https://mcp.example.test:8443/v1/mcp/{tenant}",
            ]
        ],
        (
            FIELDS_ENTRY.replace(FIELD, FIELD + FIELD.replace("tenant", "region")),
            "every sign-in field is used in an MCP URL",
        ),
        (
            FIELDS_ENTRY.replace("registration: dynamic", STATIC),
            "an entry with sign-in fields registers dynamically or names its authorization_url and token_url",
        ),
        (
            FIELDS_ENTRY.replace("[connection.tenant, account.id]", "account.id"),
            "the account id lists every sign-in field as connection.<name>, and no other connection path",
        ),
        (
            FIELDS_ENTRY.replace(
                "[connection.tenant, account.id]", "[account.id, connection.region]"
            ),
            "the account id lists every sign-in field as connection.<name>, and no other connection path",
        ),
        (FIELDS_ENTRY.replace("^[a-z0-9-]{1,30}$", "[a-z]+"), "anchored"),
    ],
)
def test_refusals(text, message):
    with pytest.raises(ValidationError, match=re.escape(message)):
        load(text)


def test_a_host_label_on_a_fixed_domain_is_allowed():
    assert load(FIELDS_ENTRY.replace(URL, "https://{tenant}.mcp.example.test/v1/mcp"))


def test_values_are_held_to_the_pattern_and_the_safe_set():
    fields = load().auth.oauth.fields
    assert sign_in_field_values(fields, {"tenant": "team-a"}) == {"tenant": "team-a"}
    for value in [
        "https://team-a",
        "team-a/x",
        "team-a:443",
        "team a",
        "TEAM-A",
        "",
        "a" * 254,
        "team-a\n",
        7,
    ]:
        with pytest.raises(
            ValueError,
            match=re.escape(
                "Example team is not valid. Your team's name, such as team-a."
            ),
        ):
            sign_in_field_values(fields, {"tenant": value})
    for values in [{}, {"tenant": "team-a", "x": "y"}]:
        with pytest.raises(
            ValueError, match=re.escape("Enter exactly this service's sign-in fields.")
        ):
            sign_in_field_values(fields, values)


@pytest.mark.parametrize(
    "value", ["https://team-a", "team-a/x", "team-a:443", "team a", "", "team-a\n"]
)
def test_the_safe_set_applies_even_with_a_permissive_field_pattern(value):
    fields = load(
        FIELDS_ENTRY.replace("^[a-z0-9-]{1,30}$", "^[\\s\\S]*$")
    ).auth.oauth.fields
    with pytest.raises(ValueError):
        sign_in_field_values(fields, {"tenant": value})


def test_the_length_limit_applies_even_with_a_permissive_field_pattern():
    fields = load(FIELDS_ENTRY.replace("^[a-z0-9-]{1,30}$", "^.*$")).auth.oauth.fields
    assert sign_in_field_values(fields, {"tenant": "a" * 253}) == {"tenant": "a" * 253}
    with pytest.raises(ValueError):
        sign_in_field_values(fields, {"tenant": "a" * 254})


def test_render_mcp_url():
    assert (
        render_mcp_url(URL, {"tenant": "team-a"})
        == "https://mcp.example.test/v1/mcp/team-a"
    )
    host = "https://{tenant}.mcp.example.test/v1/mcp"
    assert (
        render_mcp_url(host, {"tenant": "team-a"})
        == "https://team-a.mcp.example.test/v1/mcp"
    )
    with pytest.raises(ValueError):
        render_mcp_url(host, {"tenant": "a.b"})
    with pytest.raises(ValueError):
        render_mcp_url(URL, {})
    assert (
        render_mcp_url(
            "https://mcp.grafana.com/mcp/{stack}",
            {"stack": "example-stack.grafana.net"},
        )
        == "https://mcp.grafana.com/mcp/example-stack.grafana.net"
    )
