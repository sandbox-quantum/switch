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
    "asana",
    "gitlab",
    "bitbucket",
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


def test_shipped_catalog_enables_github_atlassian_and_google_workspace():
    assert set(CATALOG) == PLACEHOLDERS | {"github", "atlassian", "google-workspace"}
    assert [slug for slug, entry in CATALOG.items() if entry.definition.enabled] == [
        "atlassian",
        "github",
        "google-workspace",
    ]
    assert all(not CATALOG[slug].skill_files for slug in PLACEHOLDERS)
    assert "SKILL.md" in CATALOG["github"].skill_files
    assert "SKILL.md" in CATALOG["atlassian"].skill_files
    assert "SKILL.md" in CATALOG["google-workspace"].skill_files


GOOGLE = "https://www.googleapis.com/auth/"


def test_the_shipped_google_entry_signs_in_and_runs_gws_as_the_spike_found_it_must():
    definition = CATALOG["google-workspace"].definition
    oauth = definition.auth.oauth
    assert oauth is not None
    assert (definition.adapter, oauth.registration, oauth.redirect) == (
        "oauth",
        "static",
        ["core"],
    )
    assert oauth.client_settings == "GOOGLE_WORKSPACE"
    # A refresh token comes only with offline access, and again on a later
    # sign-in only when consent is asked for.
    assert oauth.authorization_params == {"access_type": "offline"}
    assert oauth.prompt == "consent"
    assert oauth.revocation_url == "https://oauth2.googleapis.com/revoke"
    assert definition.auth.refresh == "reusable"
    assert definition.auth.identity is not None
    assert (definition.auth.identity.account_id, definition.auth.identity.label) == (
        "sub",
        "email",
    )
    assert definition.token is not None
    assert (definition.token.kind, definition.token.max_lifetime) == (
        "pass_through",
        3920,
    )
    access = definition.access
    assert access is not None and access.write is not None
    read = set(access.read.scopes or [])
    write = set(access.write.scopes or [])
    # Google answers with full scope URLs, which the level is read from.
    assert {"openid", f"{GOOGLE}userinfo.email"} <= read < write
    assert all(scope == "openid" or scope.startswith(GOOGLE) for scope in write)
    assert not any("gmail" in scope or "mail.google" in scope for scope in write)
    assert {scope.removeprefix(GOOGLE) for scope in write - read} == {
        "drive",
        "documents",
        "spreadsheets",
        "presentations",
        "calendar.events",
    }
    cli = definition.cli
    assert cli is not None and definition.mcp is None
    assert (cli.binary, cli.token_env, cli.config_env) == (
        "gws",
        "GOOGLE_WORKSPACE_CLI_TOKEN",
        "GOOGLE_WORKSPACE_CLI_CONFIG_DIR",
    )
    assert cli.allow == ["drive", "docs", "sheets", "slides", "calendar", "schema"]
    assert {"auth", "gmail", "--api-version", "--sanitize"} <= set(cli.deny)
    assert cli.path_flags == {"--upload": "read", "--output": "write", "-o": "write"}
    assert [(arg.after, arg.direction) for arg in cli.path_args] == [
        ("+upload", "read")
    ]
    assert (
        cli.token_refused.exit_code,
        cli.token_refused.json_path,
        cli.token_refused.value,
    ) == (1, "error.code", 401)
    assert cli.release.version == "0.22.5"
    assert sorted(cli.release.targets) == [
        "darwin-arm64",
        "darwin-x64",
        "linux-arm64",
        "linux-x64",
        "win32-x64",
    ]
    for target, build in cli.release.targets.items():
        assert build.url.startswith(
            "https://github.com/googleworkspace/cli/releases/download/v0.22.5/"
        )
        assert build.path == ("gws.exe" if target == "win32-x64" else "gws")
        if target.startswith("linux"):
            assert build.url.endswith("-unknown-linux-musl.tar.gz")


def test_the_shipped_atlassian_entry_signs_in_as_the_spike_found_it_must():
    definition = CATALOG["atlassian"].definition
    oauth = definition.auth.oauth
    assert oauth is not None
    assert (definition.adapter, oauth.registration, oauth.redirect) == (
        "oauth",
        "dynamic",
        ["loopback"],
    )
    # Atlassian matches a loopback redirect's port, so the ports are fixed.
    assert oauth.loopback_ports is not None and len(oauth.loopback_ports) >= 3
    assert oauth.prompt == "consent"
    assert oauth.revocation_discovered is True
    assert definition.auth.refresh == "rotating"
    assert definition.token is not None
    assert (definition.token.kind, definition.token.max_lifetime) == (
        "pass_through",
        8 * 3600,
    )
    assert definition.mcp is not None
    assert [(s.name, s.url) for s in definition.mcp.servers] == [
        ("atlassian", "https://mcp.atlassian.com/v2/mcp")
    ]
    assert definition.access is not None and definition.access.write is not None
    identity = ["read:me", "read:account", "email", "offline_access"]
    jira_read = ["read:jira:agent-interface", "search:jira:agent-interface"]
    assert definition.access.read.scopes == identity + jira_read
    assert definition.access.write.scopes == [
        *identity,
        *jira_read,
        "write:jira:agent-interface",
    ]
    # Jira only: nothing that reaches Confluence or spends Rovo credits by scope.
    every = set(definition.access.write.scopes)
    assert not any("confluence" in scope for scope in every)
    assert definition.auth.identity is not None
    assert definition.auth.identity.url == "https://api.atlassian.com/me"


@pytest.fixture
def catalog_copy(tmp_path):
    root = tmp_path / "catalog"
    shutil.copytree(CATALOG_ROOT, root)
    return root


def test_rejects_unknown_keys(catalog_copy):
    path = catalog_copy / "asana" / "connection.yaml"
    path.write_text(path.read_text() + "icon: jira.svg\n")
    with pytest.raises(CatalogError, match="asana is invalid"):
        load_catalog(catalog_copy)


def test_rejects_invalid_yaml(catalog_copy):
    (catalog_copy / "asana" / "connection.yaml").write_text("slug: [asana\n")
    with pytest.raises(CatalogError, match="asana is invalid"):
        load_catalog(catalog_copy)


def test_rejects_unknown_auth_type(catalog_copy):
    path = catalog_copy / "asana" / "connection.yaml"
    path.write_text(path.read_text().replace("type: oauth", "type: password"))
    with pytest.raises(CatalogError, match="asana is invalid"):
        load_catalog(catalog_copy)


def test_rejects_a_slug_that_differs_from_its_directory(catalog_copy):
    path = catalog_copy / "asana" / "connection.yaml"
    path.write_text(path.read_text().replace("slug: asana", "slug: jira"))
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
    shutil.copytree(catalog_copy / "github" / "skill", catalog_copy / "asana" / "skill")
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
    (catalog_copy / "asana" / "icon.svg").write_text("<svg/>")
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
    path = catalog_copy / "asana" / "connection.yaml"
    path.write_text(
        path.read_text()
        + "access:\n  read: { scopes: [read:jira-work] }\n"
        + "tools:\n  mode: listed\n  read: [search_issues]\n  write: []\n"
    )
    definition = load_catalog(catalog_copy)["asana"].definition
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


OAUTH_ENTRY = """\
slug: example
name: Example
category: Project management
description: Read and update Example work items.
enabled: true
adapter: oauth
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


def _write_example(root, text: str = OAUTH_ENTRY) -> None:
    directory = root / "example"
    directory.mkdir(exist_ok=True)
    (directory / "connection.yaml").write_text(text)
    skill = directory / "skill"
    skill.mkdir(exist_ok=True)
    (skill / "SKILL.md").write_text(
        "---\nname: example\ndescription: Work with Example items.\n---\n\n"
        "Use the tools.\n"
    )


def test_loads_an_oauth_entry(catalog_copy):
    _write_example(catalog_copy)
    definition = load_catalog(catalog_copy)["example"].definition
    assert definition.adapter == "oauth"
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
        OAUTH_ENTRY.replace(
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
            "an oauth entry needs auth.oauth",
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
            "needs mcp or cli",
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
def test_rejects_an_incomplete_or_inconsistent_oauth_entry(
    catalog_copy, old, new, message
):
    assert old in OAUTH_ENTRY
    _write_example(catalog_copy, OAUTH_ENTRY.replace(old, new))
    with pytest.raises(CatalogError, match=f"(?s)example is invalid.*{message}"):
        load_catalog(catalog_copy)


def test_placeholders_keep_their_short_form():
    for slug in PLACEHOLDERS:
        definition = CATALOG[slug].definition
        assert definition.adapter is None
        assert definition.token is None
        assert definition.mcp is None
        assert definition.cli is None


CLI_RELEASE = (
    "  release:\n"
    "    version: 1.2.3\n"
    "    targets:\n"
    "      linux-x64:\n"
    "        url: https://downloads.example.test/excli-1.2.3-linux-x64.tar.gz\n"
    f"        sha256: {'a' * 64}\n"
    "        path: excli\n"
    "      win32-x64:\n"
    "        url: https://downloads.example.test/excli-1.2.3-win32-x64.zip\n"
    f"        sha256: {'b' * 64}\n"
    "        path: bin/excli.exe\n"
)

CLI_ENTRY = (
    OAUTH_ENTRY.replace(
        "    registration: dynamic\n",
        "    registration: static\n"
        "    client_settings: EXAMPLE\n"
        "    authorization_url: https://auth.example.test/authorize\n"
        "    token_url: https://auth.example.test/token\n"
        "    revocation_url: https://auth.example.test/revoke\n",
    )
    .replace("refresh: rotating", "refresh: reusable")
    .replace(
        "mcp:\n  servers:\n"
        '    - { name: example, url: "https://mcp.example.test/v1/mcp" }\n',
        "cli:\n"
        "  name: example-cli\n"
        "  binary: excli\n"
        "  token_env: EXCLI_TOKEN\n"
        "  config_env: EXCLI_CONFIG_DIR\n"
        "  allow: [items, boards]\n"
        "  deny: [auth, --profile]\n"
        "  path_flags: { --upload: read, --output: write, -o: write }\n"
        "  path_args: [{ after: +put, direction: read }]\n"
        "  output_cap_bytes: 65536\n"
        "  timeout_s: 120\n"
        "  token_refused: { exit_code: 1, json_path: error.code, value: 401 }\n"
        + CLI_RELEASE,
    )
)


def test_loads_an_oauth_entry_whose_tool_is_a_cli(catalog_copy):
    _write_example(catalog_copy, CLI_ENTRY)
    definition = load_catalog(catalog_copy)["example"].definition
    assert definition.mcp is None
    cli = definition.cli
    assert cli is not None
    assert (cli.name, cli.binary, cli.token_env, cli.config_env) == (
        "example-cli",
        "excli",
        "EXCLI_TOKEN",
        "EXCLI_CONFIG_DIR",
    )
    assert cli.allow == ["items", "boards"]
    assert cli.deny == ["auth", "--profile"]
    assert cli.path_flags == {"--upload": "read", "--output": "write", "-o": "write"}
    assert [(arg.after, arg.direction) for arg in cli.path_args] == [("+put", "read")]
    assert (cli.output_cap_bytes, cli.timeout_s) == (65536, 120)
    assert definition.auth.oauth is not None
    assert definition.auth.oauth.authorization_params == {}
    assert (
        cli.token_refused.exit_code,
        cli.token_refused.json_path,
        cli.token_refused.value,
    ) == (1, "error.code", 401)
    assert cli.release.version == "1.2.3"
    assert sorted(cli.release.targets) == ["linux-x64", "win32-x64"]
    assert cli.release.targets["win32-x64"].path == "bin/excli.exe"


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        (
            "cli:\n",
            "mcp:\n  servers:\n"
            '    - { name: example, url: "https://mcp.example.test/v1/mcp" }\n'
            "cli:\n",
            "not both",
        ),
        (
            "    registration: static\n    client_settings: EXAMPLE\n"
            "    authorization_url: https://auth.example.test/authorize\n"
            "    token_url: https://auth.example.test/token\n",
            "    registration: dynamic\n",
            "has none",
        ),
        (
            "    authorization_url: https://auth.example.test/authorize\n"
            "    token_url: https://auth.example.test/token\n",
            "",
            "names its authorization_url",
        ),
        (
            "    revocation_url: https://auth.example.test/revoke\n",
            "    revocation_discovered: true\n",
            "revocation_discovered",
        ),
        ("name: example-cli", "name: switch", "may not be named switch"),
        ("name: example-cli", "name: Example CLI", "name"),
        ("binary: excli", "binary: ../excli", "binary"),
        ("binary: excli", "binary: sh -c", "binary"),
        ("token_env: EXCLI_TOKEN", "token_env: excli-token", "token_env"),
        ("config_env: EXCLI_CONFIG_DIR", "config_env: EXCLI_TOKEN", "same variable"),
        ("allow: [items, boards]", "allow: []", "allow"),
        ("allow: [items, boards]", "allow: [items, items]", "allowed twice"),
        ("allow: [items, boards]", "allow: [items, auth]", "both allowed and denied"),
        ("allow: [items, boards]", "allow: [items, --all]", "allow"),
        ("deny: [auth, --profile]", "deny: [auth, '--profile;x']", "deny"),
        ("--upload: read", "--upload: delete", "path_flags"),
        ("--upload: read", "-ox: read", "path_flags"),
        ("deny: [auth, --profile]", "deny: [auth, --upload]", "also denied"),
        ("output_cap_bytes: 65536", "output_cap_bytes: 10", "output_cap_bytes"),
        ("timeout_s: 120", "timeout_s: 3600", "timeout_s"),
        ("  timeout_s: 120\n", "", "timeout_s"),
        ("  deny: [auth, --profile]\n", "", "deny"),
        ("exit_code: 1,", "exit_code: 0,", "exit_code"),
        (
            "    client_settings: EXAMPLE\n",
            "    client_settings: EXAMPLE\n"
            "    authorization_params: { redirect_uri: https://elsewhere.test }\n",
            "authorization_params",
        ),
        (
            "    client_settings: EXAMPLE\n",
            "    client_settings: EXAMPLE\n    authorization_params: { scope: all }\n",
            "authorization_params",
        ),
        (
            "    client_settings: EXAMPLE\n",
            "    client_settings: EXAMPLE\n"
            "    authorization_params: { access_type: 'offline&scope=all' }\n",
            "authorization_params",
        ),
        ("json_path: error.code", "json_path: error/code", "json_path"),
        (
            "  token_refused: { exit_code: 1, json_path: error.code, value: 401 }\n",
            "",
            "token_refused",
        ),
        (CLI_RELEASE, "", "release"),
        (
            "{ after: +put, direction: read }",
            "{ after: +put, direction: run }",
            "direction",
        ),
        (
            "{ after: +put, direction: read }",
            "{ after: '+put x', direction: read }",
            "after",
        ),
        (
            "[{ after: +put, direction: read }]",
            "[{ after: +put, direction: read }, { after: +put, direction: write }]",
            "named twice",
        ),
        ("  path_args: [{ after: +put, direction: read }]\n", "", "path_args"),
        ("version: 1.2.3", "version: latest version", "version"),
        ("      linux-x64:\n", "      freebsd-x64:\n", "targets"),
        (
            "url: https://downloads.example.test/excli-1.2.3-linux-x64.tar.gz",
            "url: http://downloads.example.test/excli-1.2.3-linux-x64.tar.gz",
            "url",
        ),
        (f"sha256: {'a' * 64}", f"sha256: {'A' * 64}", "sha256"),
        (f"sha256: {'a' * 64}", "sha256: abc", "sha256"),
        ("path: excli", "path: ../excli", "path"),
        ("path: excli", "path: /usr/bin/excli", "path"),
        (
            "    targets:\n"
            "      linux-x64:\n"
            "        url: https://downloads.example.test/excli-1.2.3-linux-x64.tar.gz\n"
            f"        sha256: {'a' * 64}\n"
            "        path: excli\n"
            "      win32-x64:\n"
            "        url: https://downloads.example.test/excli-1.2.3-win32-x64.zip\n"
            f"        sha256: {'b' * 64}\n"
            "        path: bin/excli.exe\n",
            "    targets: {}\n",
            "targets",
        ),
    ],
)
def test_rejects_an_inconsistent_cli_entry(catalog_copy, old, new, message):
    assert old in CLI_ENTRY
    _write_example(catalog_copy, CLI_ENTRY.replace(old, new))
    with pytest.raises(CatalogError, match=f"(?s)example is invalid.*{message}"):
        load_catalog(catalog_copy)


def test_rejects_a_github_entry_with_a_cli(catalog_copy):
    _rewrite_github(
        catalog_copy,
        "tools:\n",
        "cli:\n  name: gh\n  binary: gh\n  token_env: GH_TOKEN\n  allow: [repo]\n"
        "  deny: []\n  path_flags: {}\n  path_args: []\n  output_cap_bytes: 65536\n  timeout_s: 60\n"
        "  token_refused: { exit_code: 1, json_path: status, value: 401 }\n"
        + CLI_RELEASE
        + "tools:\n",
    )
    with pytest.raises(CatalogError, match="(?s)github is invalid.*command-line tool"):
        load_catalog(catalog_copy)


def test_rejects_two_entries_that_name_a_session_server_alike(catalog_copy):
    _write_example(
        catalog_copy, CLI_ENTRY.replace("name: example-cli", "name: atlassian")
    )
    with pytest.raises(CatalogError, match="atlassian and example both name"):
        load_catalog(catalog_copy)
