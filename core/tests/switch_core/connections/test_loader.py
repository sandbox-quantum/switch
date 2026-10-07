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


def _rewrite_github(root, old: str, new: str) -> None:
    path = root / "github" / "connection.yaml"
    text = path.read_text()
    assert old in text
    path.write_text(text.replace(old, new))


@pytest.mark.parametrize(
    ("old", "new"),
    [
        ("  refresh: rotating\n", ""),
        ("tools:\n  read: []\n  write: []\n", ""),
        (
            "access:\n  read:\n    permissions: { contents: read, pull_requests: read }\n"
            "  write:\n    permissions: { contents: write, pull_requests: write }\n",
            "",
        ),
    ],
    ids=["auth.refresh", "tools", "access"],
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
        "tools:\n  read: []\n  write: []\n",
        "tools:\n  read: [list_issues, create_issue]\n  write: [create_issue]\n",
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
        + "tools:\n  read: [search_issues]\n  write: []\n"
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
