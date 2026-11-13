"""Credentials an OAuth catalog entry takes pasted in place of its sign-in
(`auth.paste`), as the loader reads and refuses them."""

import re
import shutil

import pytest

from switch_core.connections.loader import (
    CATALOG,
    CATALOG_ROOT,
    CatalogError,
    load_catalog,
)
from tests.switch_core.connections.test_loader import (
    API_KEY_ENTRY,
    CHOICES_ENTRY,
    CLI_ENTRY,
    _write_example,
)

PASTE = (
    "  paste:\n"
    "    - name: token\n"
    "      label: Personal access token\n"
    "      fields:\n"
    "        - { name: pat, label: Personal access token, secret: true }\n"
    '      headers: { Authorization: "Bearer {pat}" }\n'
    "      expires: vendor\n"
    '      alias: "^(expat_[a-z0-9]+)_"\n'
    "      help_url: https://docs.example.test/tokens\n"
    "    - name: keys\n"
    "      label: API and application keys\n"
    "      fields:\n"
    "        - { name: api_key, label: API key, secret: true }\n"
    "        - { name: application_key, label: Application key, secret: true }\n"
    "      headers:\n"
    '        X-Example-Api-Key: "{api_key}"\n'
    '        X-Example-App-Key: "{application_key}"\n'
    '        X-Example-Site: "{site}"\n'
    "      expires: never\n"
    "      help_url: https://docs.example.test/keys\n"
)
# Example at two sites, signed in to with OAuth, or connected with a pasted
# token its vendor ends, or with keys that never expire: the shape of a
# vendor such as Datadog.
PASTE_ENTRY = CHOICES_ENTRY.replace("token: { kind", PASTE + "token: { kind")


@pytest.fixture
def catalog_copy(tmp_path):
    root = tmp_path / "catalog"
    shutil.copytree(CATALOG_ROOT, root)
    return root


def test_loads_the_ways_to_paste_beside_the_sign_in(catalog_copy):
    _write_example(catalog_copy, PASTE_ENTRY)
    definition = load_catalog(catalog_copy)["example"].definition
    token, keys = definition.auth.paste
    assert (token.name, token.label, token.expires, token.help_url) == (
        "token",
        "Personal access token",
        "vendor",
        "https://docs.example.test/tokens",
    )
    assert [(f.name, f.secret) for f in token.fields] == [("pat", True)]
    assert token.headers == {"Authorization": "Bearer {pat}"}
    assert (keys.name, keys.expires) == ("keys", "never")
    assert keys.headers == {
        "X-Example-Api-Key": "{api_key}",
        "X-Example-App-Key": "{application_key}",
        "X-Example-Site": "{site}",
    }
    assert definition.auth.paste_method("keys") == keys
    assert definition.auth.paste_method("oauth") is None
    assert definition.methods() == ["oauth", "token", "keys"]
    # The cap on the sign-in's token stands beside them.
    assert definition.token is not None and definition.token.max_lifetime == 3600


def test_an_entry_without_paste_methods_has_none(catalog_copy):
    _write_example(catalog_copy, CHOICES_ENTRY)
    assert load_catalog(catalog_copy)["example"].definition.auth.paste == []


def test_an_alias_names_the_public_part_of_a_token_only(catalog_copy):
    _write_example(catalog_copy, PASTE_ENTRY)
    [token, _] = load_catalog(catalog_copy)["example"].definition.auth.paste
    assert token.alias_of({"pat": "expat_ab12_SYNTHETICSECRET"}) == "expat_ab12"
    assert token.alias_of({"pat": "another-shape"}) is None
    assert token.alias_of({"pat": "expat_ab12"}) is None


def test_the_sign_ins_cap_still_bounds_the_oauth_token(catalog_copy):
    _write_example(
        catalog_copy,
        PASTE_ENTRY.replace("max_lifetime: 3600", f"max_lifetime: {8 * 24 * 3600}"),
    )
    with pytest.raises(CatalogError, match="(?s)example is invalid.*max_lifetime"):
        load_catalog(catalog_copy)


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        (
            "        - { name: pat, label: Personal access token, secret: true }\n",
            "        - { name: pat, label: Token, secret: false, choices: [a, b] }\n",
            "fields are what is pasted, each a secret",
        ),
        (
            '      headers: { Authorization: "Bearer {pat}" }\n',
            '      headers: { Authorization: "Bearer {token}" }\n',
            "paste method token's headers names an unknown field 'token'",
        ),
        (
            '        X-Example-App-Key: "{application_key}"\n',
            "",
            "asks for fields no header carries: application_key",
        ),
        (
            '      headers: { Authorization: "Bearer {pat}" }\n',
            '      headers: { Authorization: "Bearer {pat}", X-Region: "{region}" }\n',
            "names an unknown field 'region'",
        ),
        (
            "        - { name: api_key, label: API key, secret: true }\n",
            "        - { name: api_key, label: API key, secret: true }\n"
            "        - { name: site, label: Site, secret: true }\n",
            "names a field after a choice: site",
        ),
        ("    - name: keys\n", "    - name: token\n", "two paste methods share a name"),
        (
            "    - name: keys\n",
            "    - name: oauth\n",
            "Input should be 'token' or 'keys'",
        ),
        (
            "      expires: never\n",
            "      expires: soon\n",
            "Input should be 'vendor' or 'never'",
        ),
        (
            '      alias: "^(expat_[a-z0-9]+)_"\n',
            '      alias: "(expat_[a-z0-9]+)_"\n',
            "alias starts ^( and has one group",
        ),
        (
            '      alias: "^(expat_[a-z0-9]+)_"\n',
            '      alias: "^(expat)_([a-z0-9]+)_"\n',
            "alias starts ^( and has one group",
        ),
        (
            "      expires: never\n",
            '      expires: never\n      alias: "^(k[a-z]+)_"\n',
            "alias names a one-field credential",
        ),
        (
            "      help_url: https://docs.example.test/tokens\n",
            "      help_url: http://docs.example.test/tokens\n",
            "help_url",
        ),
    ],
)
def test_refuses_a_paste_method_that_does_not_fit(catalog_copy, old, new, message):
    assert old in PASTE_ENTRY
    _write_example(catalog_copy, PASTE_ENTRY.replace(old, new, 1))
    with pytest.raises(
        CatalogError, match=f"(?s)example is invalid.*{re.escape(message)}"
    ):
        load_catalog(catalog_copy)


@pytest.mark.parametrize(
    ("token", "message"),
    [
        (
            "token: { kind: minted, max_lifetime: 3600 }",
            "the oauth adapter passes the owner's token through",
        ),
        (
            "token: { kind: pass_through, max_lifetime: null }",
            "an OAuth access token expires: name its max_lifetime",
        ),
    ],
)
def test_refuses_a_paste_method_no_agent_could_be_handed(catalog_copy, token, message):
    """Issuing hands out a pasted credential only as the owner's own token,
    for an hour at a time, so an entry that could not is refused at load."""
    old = "token: { kind: pass_through, max_lifetime: 3600 }"
    assert old in PASTE_ENTRY
    _write_example(catalog_copy, PASTE_ENTRY.replace(old, token, 1))
    with pytest.raises(
        CatalogError, match=f"(?s)example is invalid.*{re.escape(message)}"
    ):
        load_catalog(catalog_copy)


def test_only_an_oauth_or_github_entry_takes_a_pasted_credential(catalog_copy):
    _write_example(
        catalog_copy,
        API_KEY_ENTRY.replace(
            "token: { kind",
            PASTE.replace("{site}", "{region}") + "token: { kind",
        ),
    )
    with pytest.raises(
        CatalogError,
        match="only an oauth or github entry takes a pasted credential in place of its sign-in",
    ):
        load_catalog(catalog_copy)


def test_a_pasted_credential_needs_an_mcp_server_to_be_checked_at(catalog_copy):
    _write_example(
        catalog_copy,
        CLI_ENTRY.replace(
            "token: { kind",
            PASTE.replace('        X-Example-Site: "{site}"\n', "") + "token: { kind",
        ),
    )
    with pytest.raises(CatalogError, match="this entry has none"):
        load_catalog(catalog_copy)


def test_the_shipped_datadog_entry_takes_a_token_or_keys_in_place_of_its_sign_in():
    definition = CATALOG["datadog"].definition
    token, keys = definition.auth.paste
    assert (token.name, token.label, token.expires, token.help_url) == (
        "token",
        "Personal access token",
        "vendor",
        "https://docs.datadoghq.com/account_management/personal-access-tokens/",
    )
    assert [(f.name, f.label, f.secret) for f in token.fields] == [
        ("pat", "Personal access token", True)
    ]
    assert token.headers == {"Authorization": "Bearer {pat}"}
    # Datadog shows a token by its public part, which names a connection whose
    # token may not read the account.
    assert token.alias_of({"pat": "ddpat_ab12cd_SYNTHETICSECRET"}) == "ddpat_ab12cd"
    assert (keys.name, keys.label, keys.expires, keys.help_url) == (
        "keys",
        "API and application keys",
        "never",
        "https://docs.datadoghq.com/account_management/api-app-keys/",
    )
    assert [(f.name, f.secret) for f in keys.fields] == [
        ("api_key", True),
        ("application_key", True),
    ]
    assert keys.headers == {
        "DD_API_KEY": "{api_key}",
        "DD_APPLICATION_KEY": "{application_key}",
    }
    assert keys.alias is None
    assert definition.methods() == ["oauth", "token", "keys"]


def test_github_takes_a_personal_access_token_its_vendor_ends():
    definition = CATALOG["github"].definition
    [method] = definition.auth.paste

    assert (method.name, method.label, method.expires) == (
        "token",
        "Personal access token",
        "vendor",
    )
    assert [(f.name, f.secret) for f in method.fields] == [("pat", True)]
    assert method.headers == {"Authorization": "Bearer {pat}"}
    assert method.help_url is not None
    assert method.help_url.startswith("https://docs.github.com/")
    # GitHub's form for a new fine-grained token, asking for what the App does.
    assert method.create_url is not None
    assert method.create_url.startswith(
        "https://github.com/settings/personal-access-tokens/new?"
    )
    assert "contents=write" in method.create_url
    assert "pull_requests=write" in method.create_url
    assert definition.methods() == ["oauth", "token"]


GITHUB_PASTE = (
    "  paste:\n"
    "    - name: token\n"
    "      label: Personal access token\n"
    "      fields:\n"
    "        - { name: pat, label: Personal access token, secret: true }\n"
    '      headers: { Authorization: "Bearer {pat}" }\n'
    "      expires: vendor\n"
)


@pytest.mark.parametrize(
    ("before", "after", "message"),
    [
        (
            "      expires: vendor\n",
            "      expires: never\n",
            "github's paste method token expires: vendor",
        ),
        (
            "        - { name: pat, label: Personal access token, secret: true }\n",
            "        - { name: pat, label: Personal access token, secret: true }\n"
            "        - { name: other, label: Other, secret: true }\n",
            "github's paste method token is one field",
        ),
        ("    - name: token\n", "    - name: keys\n", "takes one pasted method: token"),
        (
            '      headers: { Authorization: "Bearer {pat}" }\n',
            '      headers: { Authorization: "Bearer {other}" }\n',
            "names an unknown field 'other'",
        ),
    ],
)
def test_github_refuses_another_paste_method(catalog_copy, before, after, message):
    path = catalog_copy / "github" / "connection.yaml"
    text = path.read_text()
    start = text.index("  paste:\n")
    end = text.index("token: { kind")
    path.write_text(text[:start] + GITHUB_PASTE.replace(before, after) + text[end:])

    with pytest.raises(
        CatalogError, match=f"(?s)github is invalid.*{re.escape(message)}"
    ):
        load_catalog(catalog_copy)
