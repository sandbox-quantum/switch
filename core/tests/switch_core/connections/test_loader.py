import shutil

import pytest

from switch_core.connections.loader import (
    CATALOG,
    CATALOG_ROOT,
    MAX_SKILL_BYTES,
    CatalogError,
    deployment_skills,
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


def test_deployment_skills_carries_the_skill_files():
    skills = deployment_skills(CATALOG, ["github"])
    assert skills == [{"slug": "github", "files": CATALOG["github"].skill_files}]


def test_deployment_skills_rejects_placeholders_and_unknown_slugs():
    for slug in ("jira", "unknown"):
        with pytest.raises(CatalogError, match="not an enabled catalog entry"):
            deployment_skills(CATALOG, [slug])
