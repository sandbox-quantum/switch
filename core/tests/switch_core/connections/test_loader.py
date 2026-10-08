import shutil

import pytest

from switch_core.connections.loader import (
    CATALOG,
    CATALOG_ROOT,
    MAX_SKILL_BYTES,
    CatalogError,
    load_catalog,
)

PLACEHOLDERS = {
    "jira",
    "asana",
    "gitlab",
    "bitbucket",
    "google-workspace",
    "microsoft-365",
    "datadog",
    "new-relic",
    "notion",
    "linear",
    "salesforce",
    "box",
    "canva",
    "vercel",
}


def test_shipped_catalog_enables_only_github():
    assert set(CATALOG) == PLACEHOLDERS | {"github"}
    assert [slug for slug, entry in CATALOG.items() if entry.definition.enabled] == [
        "github"
    ]
    assert all(not CATALOG[slug].skill_files for slug in PLACEHOLDERS)
    assert "SKILL.md" in CATALOG["github"].skill_files


@pytest.fixture
def catalog_copy(tmp_path):
    root = tmp_path / "catalog"
    shutil.copytree(CATALOG_ROOT, root)
    return root


def test_rejects_unknown_keys(catalog_copy):
    path = catalog_copy / "jira" / "connection.yaml"
    path.write_text(path.read_text() + "icon: jira.svg\n")
    with pytest.raises(CatalogError, match="jira is invalid"):
        load_catalog(catalog_copy)


def test_rejects_invalid_yaml(catalog_copy):
    (catalog_copy / "jira" / "connection.yaml").write_text("slug: [jira\n")
    with pytest.raises(CatalogError, match="jira is invalid"):
        load_catalog(catalog_copy)


def test_rejects_unknown_auth_type(catalog_copy):
    path = catalog_copy / "jira" / "connection.yaml"
    path.write_text(path.read_text().replace("type: oauth", "type: password"))
    with pytest.raises(CatalogError, match="jira is invalid"):
        load_catalog(catalog_copy)


def test_rejects_a_slug_that_differs_from_its_directory(catalog_copy):
    path = catalog_copy / "jira" / "connection.yaml"
    path.write_text(path.read_text().replace("slug: jira", "slug: asana"))
    with pytest.raises(CatalogError, match="different slug"):
        load_catalog(catalog_copy)


def test_rejects_an_enabled_entry_without_a_skill(catalog_copy):
    shutil.rmtree(catalog_copy / "github" / "skill")
    with pytest.raises(CatalogError, match="github is enabled but has no skill"):
        load_catalog(catalog_copy)


def test_rejects_a_skill_whose_name_differs_from_the_slug(catalog_copy):
    path = catalog_copy / "github" / "skill" / "SKILL.md"
    path.write_text(path.read_text().replace("name: github", "name: git"))
    with pytest.raises(CatalogError, match="frontmatter"):
        load_catalog(catalog_copy)


def test_rejects_a_placeholder_that_ships_a_skill(catalog_copy):
    shutil.copytree(catalog_copy / "github" / "skill", catalog_copy / "jira" / "skill")
    with pytest.raises(CatalogError, match="must not ship a skill"):
        load_catalog(catalog_copy)


def test_rejects_an_oversized_skill(catalog_copy):
    (catalog_copy / "github" / "skill" / "notes.md").write_text("x" * MAX_SKILL_BYTES)
    with pytest.raises(CatalogError, match="exceeds"):
        load_catalog(catalog_copy)


def test_rejects_a_symlink_in_a_skill(catalog_copy, tmp_path):
    (tmp_path / "outside.md").write_text("outside")
    (catalog_copy / "github" / "skill" / "linked.md").symlink_to(
        tmp_path / "outside.md"
    )
    with pytest.raises(CatalogError, match="symlink"):
        load_catalog(catalog_copy)


def test_rejects_unexpected_files_beside_the_definition(catalog_copy):
    (catalog_copy / "jira" / "icon.svg").write_text("<svg/>")
    with pytest.raises(CatalogError, match="unexpected files"):
        load_catalog(catalog_copy)


def test_the_shipped_github_entry_says_what_each_level_reaches():
    definition = CATALOG["github"].definition
    assert definition.auth.refresh == "rotating"
    assert definition.access is not None
    assert definition.access.read.permissions == {
        "contents": "read",
        "pull_requests": "read",
    }
    assert definition.access.write is not None
    assert definition.access.write.permissions == {
        "contents": "write",
        "pull_requests": "write",
    }
    assert definition.level_tools("write") == []
    assert definition.adapter == "github"
    assert definition.token is not None
    assert (definition.token.kind, definition.token.max_lifetime) == ("minted", 3600)
    assert definition.mcp is None


def _rewrite_github(root, old: str, new: str) -> None:
    path = root / "github" / "connection.yaml"
    text = path.read_text()
    assert old in text
    path.write_text(text.replace(old, new))


@pytest.mark.parametrize(
    ("old", "new"),
    [
        ("  refresh: rotating\n", ""),
        ("tools:\n  mode: listed\n  read: []\n  write: []\n", ""),
        (
            "access:\n  read:\n    permissions: { contents: read, pull_requests: read }\n"
            "  write:\n    permissions: { contents: write, pull_requests: write }\n",
            "",
        ),
        ("adapter: github\n", ""),
        ("token: { kind: minted, max_lifetime: 3600 }\n", ""),
    ],
    ids=["auth.refresh", "tools", "access", "adapter", "token"],
)
def test_rejects_an_enabled_entry_missing_a_v2_field(catalog_copy, old, new):
    _rewrite_github(catalog_copy, old, new)
    with pytest.raises(
        CatalogError, match="(?s)github is invalid.*an enabled entry needs"
    ):
        load_catalog(catalog_copy)


def test_rejects_a_level_that_reaches_nothing(catalog_copy):
    _rewrite_github(
        catalog_copy,
        "permissions: { contents: read, pull_requests: read }",
        "permissions: {}",
    )
    with pytest.raises(CatalogError, match="(?s)github is invalid.*at least one"):
        load_catalog(catalog_copy)


def test_rejects_a_level_with_both_scopes_and_permissions(catalog_copy):
    _rewrite_github(
        catalog_copy,
        "permissions: { contents: read, pull_requests: read }",
        "permissions: { contents: read }\n    scopes: [repo]",
    )
    with pytest.raises(CatalogError, match="(?s)github is invalid.*not both"):
        load_catalog(catalog_copy)


def test_rejects_a_write_tool_listed_under_read(catalog_copy):
    _rewrite_github(
        catalog_copy,
        "tools:\n  mode: listed\n  read: []\n  write: []\n",
        "tools:\n  mode: listed\n  read: [list_issues, create_issue]\n  write: [create_issue]\n",
    )
    with pytest.raises(
        CatalogError,
        match=r"(?s)github is invalid.*both read and write: \['create_issue'\]",
    ):
        load_catalog(catalog_copy)


def test_rejects_write_without_read(catalog_copy):
    _rewrite_github(
        catalog_copy,
        "  read:\n    permissions: { contents: read, pull_requests: read }\n",
        "",
    )
    with pytest.raises(CatalogError, match="github is invalid"):
        load_catalog(catalog_copy)


def test_a_placeholder_may_describe_its_levels(catalog_copy):
    path = catalog_copy / "jira" / "connection.yaml"
    path.write_text(
        path.read_text()
        + "access:\n  read: { scopes: [read:jira-work] }\n"
        + "tools:\n  mode: listed\n  read: [search_issues]\n  write: []\n"
    )
    definition = load_catalog(catalog_copy)["jira"].definition
    assert definition.level_tools("read") == ["search_issues"]


@pytest.mark.parametrize(
    "phrase", ["GH_TOKEN", "gh auth status", "an Access Token", "API key"]
)
def test_rejects_a_skill_that_talks_about_credentials(catalog_copy, phrase):
    path = catalog_copy / "github" / "skill" / "SKILL.md"
    path.write_text(path.read_text() + f"\nNever use {phrase}.\n")
    with pytest.raises(CatalogError, match="never credentials or setup"):
        load_catalog(catalog_copy)


def test_rejects_a_minted_token_that_outlives_the_hour(catalog_copy):
    _rewrite_github(catalog_copy, "max_lifetime: 3600", "max_lifetime: 7200")
    with pytest.raises(CatalogError, match="(?s)github is invalid.*at most 3600"):
        load_catalog(catalog_copy)


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        (
            "token: { kind: minted, max_lifetime: 3600 }",
            "token: { kind: pass_through, max_lifetime: 3600 }",
            "mints its tokens",
        ),
        (
            "tools:\n",
            "mcp:\n  servers: [{ name: github, url: 'https://mcp.example.test/mcp' }]\n"
            "tools:\n",
            "no MCP servers",
        ),
        ("adapter: github", "adapter: gitlab", "adapter"),
    ],
    ids=["pass-through", "mcp", "unknown-adapter"],
)
def test_rejects_a_github_entry_that_is_not_githubs(catalog_copy, old, new, message):
    _rewrite_github(catalog_copy, old, new)
    with pytest.raises(CatalogError, match=f"(?s)github is invalid.*{message}"):
        load_catalog(catalog_copy)


OAUTH_MCP_ENTRY = """\
slug: example
name: Example
category: Project management
description: Read and update Example work items.
enabled: true
adapter: oauth-mcp
auth:
  type: oauth
  refresh: rotating
  oauth:
    registration: dynamic
    redirect: [loopback, core]
  identity:
    url: https://api.example.test/me
    account_id: account.id
    label: account.email
token: { kind: pass_through, max_lifetime: 3600 }
mcp:
  servers:
    - { name: example, url: "https://mcp.example.test/v1/mcp" }
access:
  read: { scopes: ["read:items"] }
  write: { scopes: ["read:items", "write:items"] }
tools: { mode: pass_through }
"""


def _write_example(root, text: str = OAUTH_MCP_ENTRY) -> None:
    directory = root / "example"
    directory.mkdir(exist_ok=True)
    (directory / "connection.yaml").write_text(text)
    skill = directory / "skill"
    skill.mkdir(exist_ok=True)
    (skill / "SKILL.md").write_text(
        "---\nname: example\ndescription: Work with Example items.\n---\n\n"
        "Use the tools.\n"
    )


def test_loads_an_oauth_mcp_entry(catalog_copy):
    _write_example(catalog_copy)
    definition = load_catalog(catalog_copy)["example"].definition
    assert definition.adapter == "oauth-mcp"
    assert definition.auth.oauth is not None
    assert definition.auth.oauth.registration == "dynamic"
    assert definition.auth.oauth.redirect == ["loopback", "core"]
    assert definition.auth.identity is not None
    assert definition.auth.identity.account_id == "account.id"
    assert definition.token is not None
    assert definition.token.kind == "pass_through"
    assert definition.mcp is not None
    assert [server.name for server in definition.mcp.servers] == ["example"]
    assert definition.level_tools("write") == []


def test_loads_a_static_client_with_its_endpoints(catalog_copy):
    _write_example(
        catalog_copy,
        OAUTH_MCP_ENTRY.replace(
            "    registration: dynamic\n",
            "    registration: static\n"
            "    client_settings: EXAMPLE\n"
            "    authorization_url: https://auth.example.test/authorize\n"
            "    token_url: https://auth.example.test/token\n"
            "    revocation_url: https://auth.example.test/revoke\n",
        ).replace("refresh: rotating", "refresh: reusable"),
    )
    oauth = load_catalog(catalog_copy)["example"].definition.auth.oauth
    assert oauth is not None
    assert oauth.client_settings == "EXAMPLE"
    assert oauth.revocation_url == "https://auth.example.test/revoke"


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        (
            "  oauth:\n    registration: dynamic\n    redirect: [loopback, core]\n",
            "",
            "an oauth-mcp entry needs auth.oauth",
        ),
        (
            "  identity:\n    url: https://api.example.test/me\n"
            "    account_id: account.id\n    label: account.email\n",
            "",
            "needs auth.identity",
        ),
        (
            "mcp:\n  servers:\n"
            '    - { name: example, url: "https://mcp.example.test/v1/mcp" }\n',
            "",
            "needs mcp",
        ),
        ("registration: dynamic", "registration: static", "client_settings"),
        (
            "    registration: dynamic\n",
            "    registration: dynamic\n    client_settings: EXAMPLE\n",
            "client_settings",
        ),
        ("redirect: [loopback, core]", "redirect: [core, core]", "listed twice"),
        ("redirect: [loopback, core]", "redirect: []", "redirect"),
        ("redirect: [loopback, core]", "redirect: [browser]", "redirect"),
        (
            "    redirect: [loopback, core]\n",
            "    redirect: [loopback, core]\n"
            "    authorization_url: https://auth.example.test/authorize\n",
            "given together",
        ),
        (
            "    redirect: [loopback, core]\n",
            "    redirect: [loopback, core]\n"
            "    authorization_url: https://auth.example.test/authorize\n"
            "    token_url: https://auth.example.test/token\n",
            "discovers its endpoints",
        ),
        ("https://mcp.example.test", "http://mcp.example.test", "url"),
        ("{ name: example,", "{ name: switch,", "named switch"),
        (
            '    - { name: example, url: "https://mcp.example.test/v1/mcp" }\n',
            '    - { name: example, url: "https://mcp.example.test/v1/mcp" }\n'
            '    - { name: example, url: "https://mcp.example.test/v2/mcp" }\n',
            "share a name",
        ),
        ("kind: pass_through", "kind: minted", "passes the owner's token through"),
        (
            "tools: { mode: pass_through }",
            "tools: { mode: listed, read: [], write: [] }",
            "pass through until classified",
        ),
        (
            "tools: { mode: pass_through }",
            "tools: { mode: pass_through, read: [] }",
            "not listed by level",
        ),
        (
            'read: { scopes: ["read:items"] }',
            "read: { permissions: { items: read } }",
            "name OAuth scopes",
        ),
        ("refresh: rotating", "refresh: none", "rotating or reusable"),
        ("max_lifetime: 3600", "max_lifetime: 60", "max_lifetime"),
        ("account_id: account.id", "account_id: account/id", "account_id"),
        (
            "    redirect: [loopback, core]\n",
            "    redirect: [core]\n    loopback_ports: [43123]\n",
            "loopback_ports are for a loopback redirect",
        ),
        (
            "    redirect: [loopback, core]\n",
            "    redirect: [loopback, core]\n    loopback_ports: [43123, 43123]\n",
            "listed twice",
        ),
        (
            "    redirect: [loopback, core]\n",
            "    redirect: [loopback, core]\n    loopback_ports: [80]\n",
            "loopback_ports",
        ),
        (
            "    redirect: [loopback, core]\n",
            "    redirect: [loopback, core]\n    prompt: always\n",
            "prompt",
        ),
        (
            "    redirect: [loopback, core]\n",
            "    redirect: [loopback, core]\n    revocation_discovered: true\n"
            "    revocation_url: https://auth.example.test/revoke\n",
            "revocation_discovered",
        ),
    ],
)
def test_rejects_an_incomplete_or_inconsistent_oauth_mcp_entry(
    catalog_copy, old, new, message
):
    assert old in OAUTH_MCP_ENTRY
    _write_example(catalog_copy, OAUTH_MCP_ENTRY.replace(old, new))
    with pytest.raises(CatalogError, match=f"(?s)example is invalid.*{message}"):
        load_catalog(catalog_copy)


def test_placeholders_keep_their_short_form():
    for slug in PLACEHOLDERS:
        definition = CATALOG[slug].definition
        assert definition.adapter is None
        assert definition.token is None
        assert definition.mcp is None
