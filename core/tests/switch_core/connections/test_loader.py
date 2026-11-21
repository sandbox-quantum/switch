import json
import re
import shutil

import pytest

from switch_core.connections.loader import (
    CATALOG,
    CATALOG_ROOT,
    MAX_SKILL_BYTES,
    CatalogError,
    ChoicesError,
    choice_key,
    load_catalog,
    with_access_profiles,
)

PLACEHOLDERS = {
    "asana",
    "bitbucket",
    "microsoft-365",
    "new-relic",
    "salesforce",
    "box",
    "canva",
    "vercel",
}


def test_shipped_catalog_enables_its_live_connectors():
    assert set(CATALOG) == PLACEHOLDERS | {
        "github",
        "airtable",
        "atlassian",
        "bigquery",
        "datadog",
        "google-workspace",
        "gitlab",
        "notion",
        "sentry",
        "linear",
    }
    assert [slug for slug, entry in CATALOG.items() if entry.definition.enabled] == [
        "airtable",
        "atlassian",
        "bigquery",
        "datadog",
        "github",
        "gitlab",
        "google-workspace",
        "linear",
        "notion",
        "sentry",
    ]
    assert all(not CATALOG[slug].skill_files for slug in PLACEHOLDERS)
    assert "SKILL.md" in CATALOG["github"].skill_files
    assert "SKILL.md" in CATALOG["airtable"].skill_files
    assert "SKILL.md" in CATALOG["atlassian"].skill_files
    assert "SKILL.md" in CATALOG["bigquery"].skill_files
    assert "SKILL.md" in CATALOG["datadog"].skill_files
    assert "SKILL.md" in CATALOG["google-workspace"].skill_files
    assert "SKILL.md" in CATALOG["gitlab"].skill_files
    assert "SKILL.md" in CATALOG["notion"].skill_files
    assert "SKILL.md" in CATALOG["sentry"].skill_files
    assert "SKILL.md" in CATALOG["linear"].skill_files


def test_every_shipped_entry_that_can_be_connected_names_its_publisher_and_pages():
    for slug, entry in CATALOG.items():
        definition = entry.definition
        if definition.enabled:
            assert definition.publisher, slug
            assert definition.links is not None, slug


GOOGLE = "https://www.googleapis.com/auth/"


# Identity arguments are fixed self-references that the vendor documents as
# the caller. A value that names a person would make every sign-in resolve to
# that person, so a new value needs a deliberate review here.
SELF_REFERENCES = {"me"}


def test_shipped_identity_arguments_only_refer_to_the_caller():
    for slug, entry in CATALOG.items():
        identity = entry.definition.auth.identity
        if identity is None or identity.arguments is None:
            continue
        assert set(identity.arguments.values()) <= SELF_REFERENCES, slug


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
    assert oauth.prompt == "consent select_account"
    assert oauth.revocation_url == "https://oauth2.googleapis.com/revoke"
    # Google revokes the whole grant, so a reconnect keeps the old sign-in.
    assert oauth.revocation_ends_grant is True
    # Revoking the sign-in ends the access tokens agents were given too.
    assert oauth.revocation_ends_tokens is True
    # Google refuses a made-up code before comparing the redirect URI.
    assert oauth.unchecked is not None and "redirect URI" in oauth.unchecked
    assert definition.auth.refresh == "reusable"
    assert definition.auth.identity is not None
    assert (definition.auth.identity.account_id, definition.auth.identity.label) == (
        "sub",
        "email",
    )
    assert definition.token is not None
    # Google's tokens live under an hour; one handed out never has more left.
    assert (definition.token.kind, definition.token.max_lifetime) == (
        "pass_through",
        3600,
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
    # Console's listener by default; Core's callback where the server names it,
    # since a site's admin must allow-list it first.
    assert (definition.adapter, oauth.registration, oauth.redirect) == (
        "oauth",
        "dynamic",
        ["loopback", "core"],
    )
    # Atlassian matches a loopback redirect's port, so the ports are fixed.
    assert oauth.loopback_ports is not None and len(oauth.loopback_ports) >= 3
    assert oauth.prompt == "consent"
    assert oauth.revocation_discovered is True
    # Its tokens are taken to outlive a revoked sign-in, up to their 8 hours.
    assert oauth.revocation_ends_tokens is False
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
    confluence_read = [
        "read:confluence:agent-interface",
        "search:confluence:agent-interface",
    ]
    assert definition.access.read.scopes == identity + jira_read + confluence_read
    assert definition.access.write.scopes == [
        *identity,
        *jira_read,
        "write:jira:agent-interface",
        *confluence_read,
        "write:confluence:agent-interface",
    ]
    # Jira and Confluence, and none of the scopes whose every call spends the
    # organization's Rovo credits: Rovo search and Teamwork Graph.
    every = set(definition.access.write.scopes)
    assert not any(":rovo:" in scope or ":twg" in scope for scope in every)
    assert definition.auth.identity is not None
    assert definition.auth.identity.url == "https://api.atlassian.com/me"


def test_the_shipped_sentry_entry_signs_in_as_its_mcp_server_requires():
    definition = CATALOG["sentry"].definition
    oauth = definition.auth.oauth
    assert oauth is not None
    assert (definition.adapter, oauth.registration, oauth.redirect) == (
        "oauth",
        "dynamic",
        ["loopback"],
    )
    assert oauth.loopback_ports == [39231, 39232, 39233, 39234, 39235]
    assert oauth.revocation_discovered is True
    assert definition.auth.refresh == "rotating"
    assert definition.token is not None
    assert (definition.token.kind, definition.token.max_lifetime) == (
        "pass_through",
        3600,
    )
    # A renewed Sentry token outlives the cap, so agents have Sentry for up to
    # an hour after each sign-in, and people are told so. A disconnect deletes
    # every agent's grant, so the note says to turn Sentry on again.
    assert definition.token.note is not None
    assert "up to an hour after each sign-in" in definition.token.note
    assert "turn Sentry on again for each agent" in definition.token.note
    assert "up to an hour after each sign-in" in definition.description
    assert definition.mcp is not None
    assert [(s.name, s.url) for s in definition.mcp.servers] == [
        ("sentry", "https://mcp.sentry.dev/mcp")
    ]
    # Sentry's REST API refuses an MCP token, so the account comes from the
    # MCP server's whoami tool.
    identity = definition.auth.identity
    assert identity is not None
    assert (identity.url, identity.mcp_tool) == (None, "whoami")
    assert (identity.account_id, identity.label) == ("user.id", "user.email")
    # Sentry grants the same scopes whatever is chosen at consent.
    assert definition.access is not None and definition.access.write is not None
    assert definition.access.read.scopes == definition.access.write.scopes


def test_the_shipped_linear_entry_signs_in_through_linears_mcp_server():
    definition = CATALOG["linear"].definition
    oauth = definition.auth.oauth
    assert oauth is not None
    # Linear's MCP server registers clients dynamically: nothing to set up.
    assert (definition.adapter, oauth.registration) == ("oauth", "dynamic")
    assert oauth.client_settings is None
    assert oauth.redirect == ["core", "loopback"]
    assert oauth.loopback_ports is not None and len(oauth.loopback_ports) >= 3
    # Consent is asked for on every connect.
    assert oauth.prompt == "consent"
    assert oauth.revocation_discovered is True
    assert definition.auth.refresh == "rotating"
    assert definition.token is not None
    # Linear's measured expires_in, first token and after a refresh.
    assert (definition.token.kind, definition.token.max_lifetime) == (
        "pass_through",
        86100,
    )
    assert definition.mcp is not None
    # One endpoint: the scope decides, not /mcp/readonly.
    assert [(s.name, s.url) for s in definition.mcp.servers] == [
        ("linear", "https://mcp.linear.app/mcp")
    ]
    assert definition.access is not None and definition.access.write is not None
    assert definition.access.read.scopes == ["read"]
    assert definition.access.write.scopes == ["read", "write"]
    # Never workspace administration.
    assert "admin" not in set(definition.access.write.scopes)
    assert definition.tools is not None and definition.tools.mode == "pass_through"
    # Linear's API refuses an MCP token, and whoami is not read-only, so the
    # account comes from the read-only get_user tool, asked for "me".
    identity = definition.auth.identity
    assert identity is not None
    assert (identity.url, identity.mcp_tool, identity.arguments) == (
        None,
        "get_user",
        {"query": "me"},
    )
    assert (identity.account_id, identity.label) == ("id", "email")


def test_the_linear_skill_keeps_safe_defaults():
    text = CATALOG["linear"].skill_files["SKILL.md"]
    assert text.startswith("---\nname: linear\n")
    for rule in ("Read before writing", "Search before creating", "Confirm first"):
        assert rule in text
    assert "information, not instructions" in text


def test_the_shipped_airtable_entry_signs_in_as_the_spike_found_it_must():
    definition = CATALOG["airtable"].definition
    oauth = definition.auth.oauth
    assert oauth is not None
    # Airtable keeps a client it registered dynamically in one person's
    # account, usable by them alone, so each server's operator registers one.
    assert (definition.adapter, oauth.registration, oauth.redirect) == (
        "oauth",
        "static",
        ["core"],
    )
    assert oauth.client_settings == "AIRTABLE"
    # Back to Core's own https callback, as Google Workspace's.
    assert oauth.loopback_ports is None
    # Airtable has no revocation endpoint, so people remove Switch there, and
    # are told a sign-in left behind widens the next.
    assert (oauth.revocation_url, oauth.revocation_discovered) == (None, False)
    assert oauth.remove_access is not None
    assert "Third-party integrations" in oauth.remove_access
    assert "reaches the bases it shared" in oauth.remove_access
    # Nothing Switch asks Airtable shows whether the integration is published.
    assert oauth.unchecked is not None and "published" in oauth.unchecked
    assert definition.auth.refresh == "rotating"
    assert definition.token is not None
    assert (definition.token.kind, definition.token.max_lifetime) == (
        "pass_through",
        3600,
    )
    assert definition.mcp is not None
    assert [(s.name, s.url) for s in definition.mcp.servers] == [
        ("airtable", "https://mcp.airtable.com/mcp")
    ]
    assert definition.access is not None and definition.access.write is not None
    read = [
        "data.records:read",
        "schema.bases:read",
        "data.recordComments:read",
        "workspacesAndBases:read",
    ]
    assert definition.access.read.scopes == read
    assert set(definition.access.write.scopes or []) == {
        *read,
        "data.records:write",
        "data.recordComments:write",
    }
    # Never the scope that creates and changes bases, tables and fields.
    assert "schema.bases:write" not in definition.access.write.scopes
    assert definition.auth.identity is not None
    assert definition.auth.identity.url == "https://api.airtable.com/v0/meta/whoami"
    # whoami names no email without a scope Airtable's MCP server does not
    # offer, so the account id names the connection too.
    assert (definition.auth.identity.account_id, definition.auth.identity.label) == (
        "id",
        "id",
    )


def test_the_shipped_notion_entry_signs_in_as_the_spike_found_it_must():
    definition = CATALOG["notion"].definition
    oauth = definition.auth.oauth
    assert oauth is not None
    # Notion offers dynamic registration and takes a loopback on any port.
    assert (definition.adapter, oauth.registration, oauth.redirect) == (
        "oauth",
        "dynamic",
        ["loopback"],
    )
    assert oauth.loopback_ports is None
    assert (oauth.authorization_url, oauth.token_url) == (None, None)
    assert oauth.revocation_discovered is True
    assert definition.auth.refresh == "rotating"
    assert definition.token is not None
    assert (definition.token.kind, definition.token.max_lifetime) == (
        "pass_through",
        8 * 3600,
    )
    assert definition.mcp is not None
    assert [(s.name, s.url) for s in definition.mcp.servers] == [
        ("notion", "https://mcp.notion.com/mcp")
    ]
    # One scope covers everything Notion's MCP server does.
    assert definition.access is not None and definition.access.write is not None
    assert (
        definition.access.read.scopes == definition.access.write.scopes == ["default"]
    )
    # Read by introspection, never from the token answer: the workspace and
    # the user, so the same person in two workspaces is two account ids.
    identity = definition.auth.identity
    assert identity is not None
    assert (identity.url, identity.introspection) == (None, True)
    assert identity.account_id == ["workspace_id", "user_id"]
    # The answer names nothing by name, so the workspace's id tells two apart.
    assert identity.label == "workspace_id"


RESTRICTED_DRIVE = {
    "drive",
    "drive.readonly",
    "drive.metadata",
    "drive.metadata.readonly",
    "drive.activity",
    "drive.activity.readonly",
    "drive.meet.readonly",
    "drive.scripts",
}


def test_the_shipped_google_entry_offers_drive_file_without_restricted_scopes():
    entry = CATALOG["google-workspace"]
    full = entry.definition.access
    profile = entry.definition.access_profiles["drive-file"]
    assert full is not None and full.write is not None
    assert profile.access.write is not None
    read = set(profile.access.read.scopes or [])
    write = set(profile.access.write.scopes or [])
    assert {"openid", f"{GOOGLE}userinfo.email"} <= read < write
    # Google reviews drive and drive.readonly with a yearly security
    # assessment; this profile asks for neither.
    assert not {scope.removeprefix(GOOGLE) for scope in write} & RESTRICTED_DRIVE
    assert {scope.removeprefix(GOOGLE) for scope in write - read} == {
        "drive.file",
        "documents",
        "spreadsheets",
        "presentations",
        "calendar.events",
    }
    # The rest is what the full levels ask for.
    assert read == set(full.read.scopes or []) - {f"{GOOGLE}drive.readonly"}
    assert write - {f"{GOOGLE}drive.file"} == set(full.write.scopes or []) - {
        f"{GOOGLE}drive.readonly",
        f"{GOOGLE}drive",
    }
    skill = entry.skill_files[profile.skill]
    assert skill.startswith("---\nname: google-workspace\n")
    assert "drive files list` finds only the files created" in skill


def test_a_server_choosing_a_profile_offers_its_levels_and_skill():
    offered = with_access_profiles(CATALOG, {"google-workspace": "drive-file"})
    entry = offered["google-workspace"]
    profile = CATALOG["google-workspace"].definition.access_profiles["drive-file"]
    assert entry.definition.access == profile.access
    assert (
        entry.skill_files["SKILL.md"]
        == CATALOG["google-workspace"].skill_files["drive-file/SKILL.md"]
    )
    assert entry.definition.cli == CATALOG["google-workspace"].definition.cli
    # Every other entry, and the shipped catalog, are as they were.
    assert all(
        offered[slug] is CATALOG[slug] for slug in CATALOG if slug != "google-workspace"
    )
    assert CATALOG["google-workspace"].skill_files["SKILL.md"].count("Find files") == 1


def test_a_server_choosing_no_profile_offers_the_catalog_as_shipped():
    assert with_access_profiles(CATALOG, {}) == CATALOG


@pytest.mark.parametrize(
    ("chosen", "message"),
    [
        ({"jira": "drive-file"}, "names a service not in the catalog: jira"),
        (
            {"google-workspace": "gmail"},
            r"does not have: 'gmail' \(it has: drive-file\)",
        ),
        ({"github": "drive-file"}, r"does not have: 'drive-file' \(it has: none\)"),
        (
            {"microsoft-365": "drive-file"},
            r"does not have: 'drive-file' \(it has: none\)",
        ),
    ],
)
def test_a_profile_the_catalog_does_not_have_stops_the_server(chosen, message):
    with pytest.raises(CatalogError, match=message):
        with_access_profiles(CATALOG, chosen)


# The endpoint and scope values come from GitLab's published MCP
# documentation and authorization-server metadata; the shipped entry's
# comment explains the registration shape.
def test_the_shipped_gitlab_entry_signs_in_as_the_spike_found_it_must():
    definition = CATALOG["gitlab"].definition
    oauth = definition.auth.oauth
    assert oauth is not None
    assert (definition.adapter, oauth.registration, oauth.redirect) == (
        "oauth",
        "static",
        ["core"],
    )
    # The operator's application is named through its settings variable.
    assert oauth.client_settings == "GITLAB"
    # No loopback redirect, so no ports are fixed or listed.
    assert oauth.loopback_ports is None
    # A static entry names its endpoints (the discovery document's own
    # values) instead of discovering them, and no prompt is forced on
    # every authorization.
    assert oauth.authorization_url == "https://gitlab.com/oauth/authorize"
    assert oauth.token_url == "https://gitlab.com/oauth/token"
    assert oauth.revocation_url == "https://gitlab.com/oauth/revoke"
    # Revoking the refresh token also ends the access tokens agents hold.
    assert oauth.revocation_ends_tokens is True
    assert oauth.revocation_ends_grant is False
    assert oauth.prompt is None
    assert oauth.revocation_discovered is False
    # A check with a made-up code shows neither the redirect URI nor the
    # application's scopes, so the operator is told what to confirm.
    assert oauth.unchecked is not None and "redirect URI" in oauth.unchecked
    assert {"mcp", "read_api", "read_user", "api"} <= set(
        re.findall(r"[a-z_]+", oauth.unchecked)
    )
    assert definition.auth.refresh == "rotating"
    assert definition.token is not None
    assert (definition.token.kind, definition.token.max_lifetime) == (
        "pass_through",
        2 * 3600,
    )
    assert definition.mcp is not None
    assert [(s.name, s.url) for s in definition.mcp.servers] == [
        ("gitlab", "https://gitlab.com/api/v4/mcp")
    ]
    # The operator's application carries the REST scopes beside `mcp`:
    # read_api at the read level, api at the write level, and read_user
    # for the identity read below at both — the scopes a dynamically
    # registered client is never given, which is why the entry is static.
    assert definition.access is not None and definition.access.write is not None
    assert definition.access.read.scopes == ["mcp", "read_api", "read_user"]
    assert definition.access.write.scopes == ["mcp", "api", "read_user"]
    assert definition.tools is not None
    assert definition.tools.mode == "pass_through"
    assert definition.auth.identity is not None
    assert definition.auth.identity.url == "https://gitlab.com/api/v4/user"
    assert definition.auth.identity.account_id == "id"
    assert definition.auth.identity.label == "username"


def test_the_shipped_bigquery_entry_signs_in_as_google_was_measured_to():
    definition = CATALOG["bigquery"].definition
    oauth = definition.auth.oauth
    assert oauth is not None
    # Its own Google client, apart from Google Workspace's.
    assert (definition.adapter, oauth.registration, oauth.client_settings) == (
        "oauth",
        "static",
        "BIGQUERY",
    )
    assert (
        oauth.client_settings
        != CATALOG["google-workspace"].definition.auth.oauth.client_settings
    )  # type: ignore[union-attr]
    # Back to Switch Console, on the fixed ports the Web client registers.
    assert oauth.redirect == ["loopback"]
    assert oauth.loopback_ports == [39231, 39232, 39233, 39234, 39235]
    # Google ends the whole grant on a revocation, and hands out a refresh
    # token only for offline access, asked with consent.
    assert oauth.revocation_url == "https://oauth2.googleapis.com/revoke"
    assert oauth.revocation_ends_grant is True
    assert oauth.authorization_params == {"access_type": "offline"}
    assert oauth.prompt == "consent select_account"
    assert definition.auth.refresh == "reusable"
    assert definition.auth.identity is not None
    assert (
        definition.auth.identity.url
        == "https://openidconnect.googleapis.com/v1/userinfo"
    )
    assert definition.token is not None
    assert (definition.token.kind, definition.token.max_lifetime) == (
        "pass_through",
        3600,
    )
    assert definition.mcp is not None
    assert [(s.name, s.url) for s in definition.mcp.servers] == [
        ("bigquery", "https://bigquery.googleapis.com/mcp")
    ]
    # One scope, so one level, read and write: both name the same scopes, and
    # the description says it can change data.
    assert definition.access is not None and definition.access.write is not None
    assert definition.access.read.scopes == definition.access.write.scopes
    assert f"{GOOGLE}bigquery" in (definition.access.write.scopes or [])
    assert "changes data" in definition.description
    skill = CATALOG["bigquery"].skill_files["SKILL.md"]
    assert "This connection can write." in skill
    assert "execute_sql_readonly" in skill


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


@pytest.mark.parametrize("lifetime", ["7200", "null"])
def test_rejects_a_minted_token_that_outlives_the_hour(catalog_copy, lifetime):
    _rewrite_github(catalog_copy, "max_lifetime: 3600", f"max_lifetime: {lifetime}")
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
publisher: Example
links:
  documentation: https://docs.example.test/mcp
  support: https://support.example.test
  privacy: https://example.test/privacy
adapter: oauth
auth:
  type: oauth
  refresh: rotating
  oauth:
    registration: dynamic
    redirect: [loopback, core]
    remove_access: Remove Switch under Connected apps in Example.
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


def test_takes_several_prompt_values_as_oauth_writes_them(catalog_copy):
    _write_example(
        catalog_copy,
        OAUTH_ENTRY.replace(
            "    redirect: [loopback, core]\n",
            "    redirect: [loopback, core]\n    prompt: consent select_account\n",
        ),
    )
    oauth = load_catalog(catalog_copy)["example"].definition.auth.oauth
    assert oauth is not None and oauth.prompt == "consent select_account"


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


def test_rejects_revocation_ending_tokens_on_an_entry_that_passes_none_through(
    catalog_copy,
):
    _write_example(
        catalog_copy,
        OAUTH_ENTRY.replace(
            "    remove_access: Remove Switch under Connected apps in Example.\n",
            "    revocation_url: https://auth.example.test/revoke\n"
            "    revocation_ends_tokens: true\n",
        ).replace(
            "token: { kind: pass_through, max_lifetime: 3600 }\n",
            "token: { kind: minted, max_lifetime: 3600 }\n",
        ),
    )
    with pytest.raises(CatalogError, match="revocation_ends_tokens"):
        load_catalog(catalog_copy)


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        (
            "  oauth:\n    registration: dynamic\n    redirect: [loopback, core]\n"
            "    remove_access: Remove Switch under Connected apps in Example.\n",
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
        (
            "    redirect: [loopback, core]\n",
            "    redirect: [loopback, core]\n    revocation_ends_grant: true\n",
            "revocation_ends_grant",
        ),
        (
            "    redirect: [loopback, core]\n",
            "    redirect: [loopback, core]\n    revocation_ends_tokens: true\n",
            "revocation_ends_tokens",
        ),
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
        ("max_lifetime: 3600", "max_lifetime: null", "name its max_lifetime"),
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
            "    redirect: [loopback, core]\n    prompt: consent none\n",
            "prompt",
        ),
        (
            "    redirect: [loopback, core]\n",
            "    redirect: [loopback, core]\n    prompt: consent  login\n",
            "prompt",
        ),
        (
            "    redirect: [loopback, core]\n",
            "    redirect: [loopback, core]\n    prompt: consent consent\n",
            "listed twice",
        ),
        (
            "    redirect: [loopback, core]\n",
            "    redirect: [loopback, core]\n    revocation_discovered: true\n"
            "    revocation_url: https://auth.example.test/revoke\n",
            "revocation_discovered",
        ),
        (
            "    remove_access: Remove Switch under Connected apps in Example.\n",
            "",
            "remove_access",
        ),
        (
            "    redirect: [loopback, core]\n",
            "    redirect: [loopback, core]\n    unchecked: Publish it.\n",
            "unchecked is for a static client",
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


GET_IDENTITY = (
    "  identity:\n"
    "    url: https://api.example.test/me\n"
    "    account_id: account.id\n"
    "    label: account.email\n"
)
INTROSPECTION_IDENTITY = (
    "  identity:\n"
    "    introspection: true\n"
    "    account_id: [workspace_id, user_id]\n"
    "    label: username\n"
)


def test_loads_an_identity_read_by_introspection(catalog_copy):
    _write_example(
        catalog_copy, OAUTH_ENTRY.replace(GET_IDENTITY, INTROSPECTION_IDENTITY)
    )
    identity = load_catalog(catalog_copy)["example"].definition.auth.identity
    assert identity is not None
    assert (identity.url, identity.introspection) == (None, True)
    assert identity.account_id == ["workspace_id", "user_id"]


def test_a_get_identity_stays_as_it_was(catalog_copy):
    _write_example(catalog_copy)
    identity = load_catalog(catalog_copy)["example"].definition.auth.identity
    assert identity is not None
    assert (identity.url, identity.introspection, identity.account_id) == (
        "https://api.example.test/me",
        False,
        "account.id",
    )


CHOICES = (
    "    choices:\n"
    "      - name: site\n"
    "        label: Example site\n"
    "        secret: false\n"
    "        choices: [example.test, eu.example.test]\n"
)
# Example at two sites, each its own MCP server, account API and
# authorization server, as a vendor with regional deployments is.
CHOICES_ENTRY = (
    OAUTH_ENTRY.replace(
        "    redirect: [loopback, core]\n", "    redirect: [loopback, core]\n" + CHOICES
    )
    .replace("https://api.example.test/me", "https://api.{site}/me")
    .replace("https://mcp.example.test/v1/mcp", "https://mcp.{site}/v1/mcp")
)


def test_loads_an_oauth_entry_whose_urls_name_its_choices(catalog_copy):
    _write_example(catalog_copy, CHOICES_ENTRY)
    definition = load_catalog(catalog_copy)["example"].definition
    oauth = definition.auth.oauth
    assert oauth is not None
    [field] = oauth.choices
    assert (field.name, field.secret, field.choices) == (
        "site",
        False,
        ["example.test", "eu.example.test"],
    )
    assert definition.mcp is not None
    assert definition.mcp.servers[0].url == "https://mcp.{site}/v1/mcp"
    assert definition.auth.identity is not None
    assert definition.auth.identity.url == "https://api.{site}/me"


def test_an_entry_without_choices_has_none(catalog_copy):
    _write_example(catalog_copy)
    oauth = load_catalog(catalog_copy)["example"].definition.auth.oauth
    assert oauth is not None and oauth.choices == []
    assert oauth.checked_choices({}) == {}


def test_a_static_client_may_name_its_choices_in_its_endpoints(catalog_copy):
    _write_example(
        catalog_copy,
        CHOICES_ENTRY.replace(
            "    registration: dynamic\n",
            "    registration: static\n"
            "    client_settings: EXAMPLE\n"
            "    authorization_url: https://auth.{site}/authorize\n"
            "    token_url: https://auth.{site}/token\n"
            "    revocation_url: https://auth.{site}/revoke\n",
        ),
    )
    oauth = load_catalog(catalog_copy)["example"].definition.auth.oauth
    assert oauth is not None
    assert (oauth.authorization_url, oauth.token_url, oauth.revocation_url) == (
        "https://auth.{site}/authorize",
        "https://auth.{site}/token",
        "https://auth.{site}/revoke",
    )


@pytest.mark.parametrize(
    ("identity", "message"),
    [
        (
            GET_IDENTITY.replace(
                "  identity:\n", "  identity:\n    introspection: true\n"
            ),
            "exactly one of url, mcp_tool or introspection",
        ),
        (
            INTROSPECTION_IDENTITY.replace(
                "  identity:\n", "  identity:\n    mcp_tool: whoami\n"
            ),
            "exactly one of url, mcp_tool or introspection",
        ),
        (
            INTROSPECTION_IDENTITY.replace(
                "introspection: true", "introspection: false"
            ),
            "exactly one of url, mcp_tool or introspection",
        ),
        (
            INTROSPECTION_IDENTITY.replace(
                "introspection: true", 'introspection: "yes"'
            ),
            "introspection",
        ),
        (
            INTROSPECTION_IDENTITY.replace(
                "[workspace_id, user_id]", "[workspace_id, workspace_id]"
            ),
            "lists a path twice",
        ),
        (
            INTROSPECTION_IDENTITY.replace("[workspace_id, user_id]", "[user_id]"),
            "account_id",
        ),
        (
            INTROSPECTION_IDENTITY.replace("[workspace_id, user_id]", "[]"),
            "account_id",
        ),
        (
            INTROSPECTION_IDENTITY.replace(
                "[workspace_id, user_id]", "[workspace_id, user/id]"
            ),
            "account_id",
        ),
    ],
)
def test_rejects_an_identity_that_is_not_one_clear_source(
    catalog_copy, identity, message
):
    _write_example(catalog_copy, OAUTH_ENTRY.replace(GET_IDENTITY, identity))
    with pytest.raises(CatalogError, match=f"(?s)example is invalid.*{message}"):
        load_catalog(catalog_copy)


@pytest.mark.parametrize(
    ("entry", "old", "new", "message"),
    [
        (
            CHOICES_ENTRY,
            "        secret: false\n        choices: [example.test, eu.example.test]\n",
            "        secret: true\n",
            "never a secret",
        ),
        (
            CHOICES_ENTRY,
            "        choices: [example.test, eu.example.test]\n",
            "",
            "one of the two",
        ),
        (
            CHOICES_ENTRY,
            "        choices: [example.test, eu.example.test]\n",
            "        choices: [example.test, Example.test]\n",
            "choices",
        ),
        (
            CHOICES_ENTRY,
            "        choices: [example.test, eu.example.test]\n",
            "        choices: [example.test, eu.example.test]\n"
            + CHOICES.removeprefix("    choices:\n"),
            "two choices share a name",
        ),
        (
            CHOICES_ENTRY,
            "https://mcp.{site}/v1/mcp",
            "https://mcp.{region}/v1/mcp",
            "MCP server example's URL may name only a choice field, not 'region'",
        ),
        (
            CHOICES_ENTRY,
            "https://api.{site}/me",
            "https://api.{region}/me",
            "the identity call's URL may name only a choice field",
        ),
        (
            CHOICES_ENTRY,
            "https://mcp.{site}/v1/mcp",
            "https://mcp.{site/v1/mcp",
            "brace that names no field",
        ),
        (
            CHOICES_ENTRY,
            "    redirect: [loopback, core]\n",
            "    redirect: [loopback, core]\n"
            "    revocation_url: https://auth.{region}/revoke\n",
            "the revocation endpoint's URL may name only a choice field",
        ),
        (
            OAUTH_ENTRY,
            "https://mcp.example.test/v1/mcp",
            "https://mcp.{site}/v1/mcp",
            "may name only a choice field, not 'site'",
        ),
    ],
)
def test_rejects_choices_or_templates_that_do_not_fit(
    catalog_copy, entry, old, new, message
):
    assert old in entry
    _write_example(catalog_copy, entry.replace(old, new))
    with pytest.raises(
        CatalogError, match=f"(?s)example is invalid.*{re.escape(message)}"
    ):
        load_catalog(catalog_copy)


def test_checks_choices_against_the_entrys_lists(catalog_copy):
    _write_example(catalog_copy, CHOICES_ENTRY)
    oauth = load_catalog(catalog_copy)["example"].definition.auth.oauth
    assert oauth is not None
    assert oauth.checked_choices({"site": "eu.example.test"}) == {
        "site": "eu.example.test"
    }
    with pytest.raises(ChoicesError, match="Example site is required"):
        oauth.checked_choices({})
    with pytest.raises(
        ChoicesError, match="Example site must be one of example.test, eu.example.test"
    ):
        oauth.checked_choices({"site": "elsewhere.test"})
    with pytest.raises(ChoicesError, match="no choice named region"):
        oauth.checked_choices({"site": "example.test", "region": "eu"})


def test_keys_choices_by_one_stable_string():
    assert choice_key({}) == ""
    assert choice_key({"site": "eu.example.test"}) == "eu.example.test"
    assert (
        choice_key({"site": "eu.example.test", "plan": "team"})
        == choice_key({"plan": "team", "site": "eu.example.test"})
        == '{"plan":"team","site":"eu.example.test"}'
    )


MARKERS = "  consent: { read: items_read, write: items_write }\n"
MARKED_ENTRY = OAUTH_ENTRY.replace(
    "tools: { mode: pass_through }", MARKERS + "tools: { mode: pass_through }"
)


def test_an_oauth_entry_may_read_its_consent_from_markers(catalog_copy):
    _write_example(catalog_copy, MARKED_ENTRY)
    access = load_catalog(catalog_copy)["example"].definition.access
    assert access is not None and access.consent is not None
    assert (access.consent.read, access.consent.write) == ("items_read", "items_write")


def test_an_entry_without_markers_has_none(catalog_copy):
    _write_example(catalog_copy)
    access = load_catalog(catalog_copy)["example"].definition.access
    assert access is not None and access.consent is None


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        (
            '  write: { scopes: ["read:items", "write:items"] }\n',
            "",
            "the entry names both levels",
        ),
        (MARKERS, "  consent: { read: items_read }\n", "write"),
        (
            MARKERS,
            "  consent: { read: items_read, write: items_read }\n",
            "one scope",
        ),
        (
            MARKERS,
            '  consent: { read: "items read", write: items_write }\n',
            "read",
        ),
        (
            MARKERS,
            "  consent: { read: items_read, write: items_write, admin: x }\n",
            "admin",
        ),
    ],
)
def test_rejects_consent_markers_that_cannot_tell_the_levels(
    catalog_copy, old, new, message
):
    assert old in MARKED_ENTRY
    _write_example(catalog_copy, MARKED_ENTRY.replace(old, new))
    with pytest.raises(CatalogError, match=f"(?s)example is invalid.*{message}"):
        load_catalog(catalog_copy)


@pytest.mark.parametrize("without", ["discovery", "an mcp server"])
def test_introspection_needs_a_discovered_authorization_server(catalog_copy, without):
    entry = (
        OAUTH_ENTRY.replace(
            "    registration: dynamic\n",
            "    registration: static\n"
            "    client_settings: EXAMPLE\n"
            "    authorization_url: https://auth.example.test/authorize\n"
            "    token_url: https://auth.example.test/token\n"
            "    revocation_url: https://auth.example.test/revoke\n",
        )
        if without == "discovery"
        else CLI_ENTRY
    )
    assert GET_IDENTITY in entry
    _write_example(catalog_copy, entry.replace(GET_IDENTITY, INTROSPECTION_IDENTITY))
    with pytest.raises(CatalogError, match="introspection asks the authorization"):
        load_catalog(catalog_copy)


def _mcp_identity(arguments: str) -> str:
    # JSON is YAML, so the arguments reach the loader exactly as given.
    return (
        "  identity:\n"
        "    mcp_tool: get_user\n"
        f"    arguments: {arguments}\n"
        "    account_id: id\n"
        "    label: email\n"
    )


@pytest.mark.parametrize(
    "arguments",
    [
        {"query": "me"},
        {"a": "1", "b": "2", "c": "3", "_" + "d" * 63: "x" * 64},
    ],
)
def test_loads_an_mcp_identity_with_fixed_arguments(catalog_copy, arguments):
    _write_example(
        catalog_copy,
        OAUTH_ENTRY.replace(GET_IDENTITY, _mcp_identity(json.dumps(arguments))),
    )
    identity = load_catalog(catalog_copy)["example"].definition.auth.identity
    assert identity is not None
    assert (identity.mcp_tool, identity.arguments) == ("get_user", arguments)


def test_an_identity_has_no_arguments_unless_given(catalog_copy):
    _write_example(catalog_copy)
    identity = load_catalog(catalog_copy)["example"].definition.auth.identity
    assert identity is not None and identity.arguments is None


@pytest.mark.parametrize(
    "identity",
    [
        GET_IDENTITY + '    arguments: { query: "me" }\n',
        INTROSPECTION_IDENTITY + '    arguments: { query: "me" }\n',
    ],
    ids=["url", "introspection"],
)
def test_rejects_arguments_without_an_mcp_tool(catalog_copy, identity):
    _write_example(catalog_copy, OAUTH_ENTRY.replace(GET_IDENTITY, identity))
    with pytest.raises(
        CatalogError, match="(?s)example is invalid.*arguments are for an mcp_tool"
    ):
        load_catalog(catalog_copy)


@pytest.mark.parametrize(
    "arguments",
    [
        {},
        {"a": "1", "b": "2", "c": "3", "d": "4", "e": "5"},
        {"1query": "me"},
        {"que-ry": "me"},
        {"q" * 65: "me"},
        {"": "me"},
        {"query": ""},
        {"query": "x" * 65},
        {"query": "{me}"},
        {"query": "me}"},
        {"query": "{user_id}"},
        {"query": "m\ne"},
        {"query": "me\u0000"},
        {"query": "me\u007f"},
        {"query": "me\u0085"},
        {"query": 1},
        {"query": None},
        {"query": ["me"]},
        ["query", "me"],
        "me",
    ],
    ids=lambda arguments: json.dumps(arguments)[:40],
)
def test_rejects_identity_arguments_that_are_not_fixed_short_text(
    catalog_copy, arguments
):
    _write_example(
        catalog_copy,
        OAUTH_ENTRY.replace(GET_IDENTITY, _mcp_identity(json.dumps(arguments))),
    )
    with pytest.raises(
        CatalogError, match="(?s)example is invalid.*auth.identity.arguments"
    ) as raised:
        load_catalog(catalog_copy)
    assert "extra_forbidden" not in str(raised.value)


def _with_note(note: str) -> str:
    # JSON is YAML, so the note reaches the loader exactly as given.
    return OAUTH_ENTRY.replace(
        "token: { kind: pass_through, max_lifetime: 3600 }",
        f"token: {{ kind: pass_through, max_lifetime: 3600, note: {json.dumps(note)} }}",
    )


@pytest.mark.parametrize("note", ["", "x" * 401, "a\nb"])
def test_rejects_a_token_note_that_is_empty_too_long_or_multiline(catalog_copy, note):
    _write_example(catalog_copy, _with_note(note))
    with pytest.raises(CatalogError, match="(?s)example is invalid.*note"):
        load_catalog(catalog_copy)


def test_takes_a_token_note_of_400_characters(catalog_copy):
    _write_example(catalog_copy, _with_note("x" * 400))
    token = load_catalog(catalog_copy)["example"].definition.token
    assert token is not None and token.note == "x" * 400


def test_only_an_oauth_entry_reads_consent_markers(catalog_copy):
    path = catalog_copy / "asana" / "connection.yaml"
    path.write_text(
        path.read_text()
        + "access:\n  read: { scopes: [items_read] }\n"
        + "  write: { scopes: [items_write] }\n"
        + MARKERS
    )
    with pytest.raises(CatalogError, match="only an oauth entry reads its consent"):
        load_catalog(catalog_copy)


def test_placeholders_keep_their_short_form():
    for slug in PLACEHOLDERS:
        definition = CATALOG[slug].definition
        assert definition.adapter is None
        assert definition.token is None
        assert definition.mcp is None
        assert definition.cli is None
        assert definition.publisher is None
        assert definition.links is None


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
        ("config_env: EXCLI_CONFIG_DIR", "config_env: EXCLI_TOKEN", "credential sets"),
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


API_KEY_ENTRY = """slug: example
name: Example
category: Observability
description: Query Example telemetry.
enabled: true
adapter: api_key
auth:
  type: api_key
  refresh: none
  api_key:
    fields:
      - { name: api_key, label: API key, secret: true }
      - name: region
        label: Region
        secret: false
        choices: [us.example.test, eu.example.test]
    identity:
      method: GET
      url: "https://api.{region}/me"
      headers: { X-Key: "{api_key}" }
      account_id: account.id
      label: account.email
token: { kind: pass_through, max_lifetime: null }
mcp:
  servers:
    - name: example
      url: "https://mcp.{region}/mcp"
      headers: { Authorization: "Token token={api_key}" }
tools: { mode: pass_through }
"""


DATADOG_SITES = [
    "datadoghq.com",
    "us3.datadoghq.com",
    "us5.datadoghq.com",
    "datadoghq.eu",
    "ap1.datadoghq.com",
    "ap2.datadoghq.com",
    "uk1.datadoghq.com",
]


def test_the_shipped_datadog_entry_signs_in_at_the_site_people_pick():
    definition = CATALOG["datadog"].definition
    oauth = definition.auth.oauth
    assert oauth is not None
    # Datadog registers a public client at each site; Console's listener by
    # default, Core's callback where the server names it, since an
    # organization's admin must allow-list it first.
    assert (definition.adapter, oauth.registration, oauth.redirect) == (
        "oauth",
        "dynamic",
        ["loopback", "core"],
    )
    assert oauth.loopback_ports == [39241, 39242, 39243, 39244, 39245]
    [site] = oauth.choices
    assert (site.name, site.secret, site.choices) == ("site", False, DATADOG_SITES)
    # No revocation endpoint: people remove Switch in Datadog themselves.
    assert (oauth.revocation_url, oauth.revocation_discovered) == (None, False)
    assert oauth.revocation_ends_tokens is False
    assert oauth.remove_access is not None
    assert "Authorized Apps" in oauth.remove_access
    # Refresh tokens are reused, not rotated; access tokens live 3,599 s.
    assert definition.auth.refresh == "reusable"
    assert definition.token is not None
    assert (definition.token.kind, definition.token.max_lifetime) == (
        "pass_through",
        3600,
    )
    identity = definition.auth.identity
    assert identity is not None
    assert (identity.url, identity.account_id, identity.label) == (
        "https://api.{site}/api/v2/current_user",
        "data.id",
        "data.attributes.email",
    )
    assert definition.mcp is not None
    assert [(s.name, s.url, s.headers) for s in definition.mcp.servers] == [
        ("datadog", "https://mcp.{site}/v1/mcp", None)
    ]
    # Datadog offers the one scope; its consent page decides the level, which
    # the token's scope says by its markers.
    access = definition.access
    assert access is not None and access.write is not None
    assert access.read.scopes == access.write.scopes == ["mcp_all"]
    assert access.consent is not None
    assert (access.consent.read, access.consent.write) == ("mcp_read", "mcp_write")
    assert definition.tools is not None and definition.tools.mode == "pass_through"
    assert "SKILL.md" in CATALOG["datadog"].skill_files


def test_loads_an_api_key_entry(catalog_copy):
    _write_example(catalog_copy, API_KEY_ENTRY)
    definition = load_catalog(catalog_copy)["example"].definition
    assert definition.adapter == "api_key"
    assert definition.access is None
    sign_in = definition.auth.api_key
    assert sign_in is not None
    assert sign_in.choice_names() == {"region"}
    assert definition.mcp is not None
    assert definition.mcp.servers[0].headers == {
        "Authorization": "Token token={api_key}"
    }


def test_loads_an_api_key_entry_whose_tool_is_a_cli(catalog_copy):
    cli = CLI_ENTRY.split("cli:\n", 1)[1].split("access:\n", 1)[0]
    cli = cli.replace(
        "  token_env: EXCLI_TOKEN\n", '  env: { EXCLI_KEY: "{api_key}" }\n'
    )
    text = API_KEY_ENTRY.replace(
        API_KEY_ENTRY[API_KEY_ENTRY.index("mcp:\n") : API_KEY_ENTRY.index("tools:")],
        "cli:\n" + cli,
    )
    _write_example(catalog_copy, text)
    definition = load_catalog(catalog_copy)["example"].definition
    assert definition.cli is not None
    assert definition.cli.env == {"EXCLI_KEY": "{api_key}"}
    assert definition.cli.token_env is None


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        (
            '      url: "https://mcp.{region}/mcp"\n',
            '      url: "https://mcp.example.test/{api_key}"\n',
            "may name only a choice field",
        ),
        (
            '      headers: { Authorization: "Token token={api_key}" }\n',
            '      headers: { Authorization: "Token token={secret}" }\n',
            "unknown field",
        ),
        (
            '      headers: { Authorization: "Token token={api_key}" }\n',
            "",
            "names the headers the key goes in",
        ),
        (
            '      headers: { X-Key: "{api_key}" }\n',
            '      headers: { X-Key: "{api_key" }\n',
            "brace that names no field",
        ),
        (
            "      - { name: api_key, label: API key, secret: true }\n",
            "",
            "at least one secret field",
        ),
        (
            "        secret: false\n",
            "        secret: true\n",
            "one of the two",
        ),
        ("  refresh: none\n", "  refresh: rotating\n", "refresh is none"),
        (
            "token: { kind: pass_through, max_lifetime: null }",
            "token: { kind: pass_through, max_lifetime: 3600 }",
            "never handed to an agent",
        ),
        (
            "tools: { mode: pass_through }",
            'tools: { mode: pass_through }\naccess:\n  read: { scopes: ["x"] }',
            "no access",
        ),
        (
            "      method: GET\n",
            "      method: POST\n",
            "sends a body",
        ),
    ],
)
def test_rejects_an_inconsistent_api_key_entry(catalog_copy, old, new, message):
    assert old in API_KEY_ENTRY
    _write_example(catalog_copy, API_KEY_ENTRY.replace(old, new))
    with pytest.raises(CatalogError, match=message):
        load_catalog(catalog_copy)


def test_rejects_an_oauth_entry_with_key_headers(catalog_copy):
    _write_example(
        catalog_copy,
        OAUTH_ENTRY.replace(
            '    - { name: example, url: "https://mcp.example.test/v1/mcp" }\n',
            '    - name: example\n      url: "https://mcp.example.test/v1/mcp"\n'
            '      headers: { X-Key: "{token}" }\n',
        ),
    )
    with pytest.raises(CatalogError, match="only an api_key entry"):
        load_catalog(catalog_copy)


def _rewrite_google(catalog_copy, old, new):
    path = catalog_copy / "google-workspace" / "connection.yaml"
    text = path.read_text()
    assert text.count(old) == 1
    path.write_text(text.replace(old, new))


def test_rejects_a_profile_whose_skill_file_is_not_shipped(catalog_copy):
    _rewrite_google(
        catalog_copy, "skill: drive-file/SKILL.md", "skill: elsewhere/SKILL.md"
    )
    with pytest.raises(CatalogError, match="does not ship: elsewhere/SKILL.md"):
        load_catalog(catalog_copy)


def test_rejects_a_profile_skill_named_for_another_entry(catalog_copy):
    path = catalog_copy / "google-workspace" / "skill" / "drive-file" / "SKILL.md"
    path.write_text(
        path.read_text().replace("name: google-workspace", "name: github", 1)
    )
    with pytest.raises(
        CatalogError,
        match="drive-file/SKILL.md needs frontmatter with name: google-workspace",
    ):
        load_catalog(catalog_copy)


def test_rejects_a_profile_without_the_entrys_levels(catalog_copy):
    path = catalog_copy / "google-workspace" / "connection.yaml"
    text = path.read_text()
    start = text.index("      write:\n", text.index("access_profiles:"))
    path.write_text(text[:start] + "tools: { mode: pass_through }\n")
    with pytest.raises(
        CatalogError,
        match="(?s)google-workspace is invalid.*must name the levels the entry does",
    ):
        load_catalog(catalog_copy)


def test_rejects_a_profile_on_a_disabled_entry(catalog_copy):
    _rewrite_google(catalog_copy, "enabled: true", "enabled: false")
    shutil.rmtree(catalog_copy / "google-workspace" / "skill")
    with pytest.raises(
        CatalogError,
        match="(?s)google-workspace is invalid.*only an enabled entry has access profiles",
    ):
        load_catalog(catalog_copy)


def test_rejects_a_profile_on_an_entry_that_is_not_oauth(catalog_copy):
    path = catalog_copy / "github" / "connection.yaml"
    path.write_text(
        path.read_text()
        + "access_profiles:\n  less:\n    skill: SKILL.md\n"
        + "    access: { read: { scopes: [a] } }\n"
    )
    with pytest.raises(
        CatalogError,
        match="(?s)github is invalid.*only an oauth entry with access levels",
    ):
        load_catalog(catalog_copy)


def test_rejects_a_profile_on_an_entry_that_takes_a_pasted_credential(catalog_copy):
    path = catalog_copy / "datadog" / "connection.yaml"
    path.write_text(
        path.read_text()
        + "access_profiles:\n  less:\n    skill: SKILL.md\n"
        + "    access:\n      read: { scopes: [mcp_all] }\n"
        + "      write: { scopes: [mcp_all] }\n"
    )
    with pytest.raises(
        CatalogError,
        match="(?s)datadog is invalid.*takes no pasted credential.*no granted scopes",
    ):
        load_catalog(catalog_copy)


def test_skill_frontmatter_accepts_windows_line_endings(catalog_copy):
    path = catalog_copy / "github" / "skill" / "SKILL.md"
    raw = path.read_bytes().replace(b"\r\n", b"\n")
    path.write_bytes(raw.replace(b"\n", b"\r\n"))
    assert load_catalog(catalog_copy)["github"].skill_files["SKILL.md"] == raw.decode()
