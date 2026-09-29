"""The built-in connection catalog shipped in ``connections/catalog/``.

Each ``catalog/<slug>/connection.yaml`` describes one service a user can
connect. Enabled entries ship a skill under ``catalog/<slug>/skill/`` that is
installed on the cloud agents the connection is granted to; placeholder
entries ship none. The catalog is validated once, at import, so a malformed
entry stops the server rather than surfacing on the first launch.
"""

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

CATALOG_ROOT = Path(__file__).parent / "catalog"
MAX_SKILL_BYTES = 32 * 1024
SLUG_PATTERN = r"^[a-z0-9][a-z0-9-]{0,62}$"
SKILL_PATH_RE = re.compile(
    r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}(/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}){0,7}$"
)
FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)

# Hosts whose agent loads skills from a directory the hosted bootstrap can
# install into. Cursor and Antigravity have none, so a cloud agent on those
# providers gets connection credentials but no connection skills.
SKILL_PROVIDERS = frozenset({"claude", "codex", "opencode"})


class CatalogError(RuntimeError):
    pass


class ConnectionAuth(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    type: Literal["oauth", "api_key"]


class ConnectionDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    slug: str = Field(pattern=SLUG_PATTERN)
    name: str = Field(min_length=1, max_length=64)
    category: str = Field(min_length=1, max_length=64)
    description: str = Field(min_length=1, max_length=200, pattern=r"^[^\n]+$")
    enabled: bool
    auth: ConnectionAuth


@dataclass(frozen=True)
class Connection:
    definition: ConnectionDefinition
    skill_files: dict[str, str]


def _load_skill(slug: str, root: Path) -> dict[str, str]:
    files: dict[str, str] = {}
    total = 0
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            raise CatalogError(
                f"Connection {slug} skill contains a symlink: {relative}"
            )
        if path.is_dir():
            continue
        if not path.is_file() or not SKILL_PATH_RE.fullmatch(relative):
            raise CatalogError(
                f"Connection {slug} skill has an unsafe path: {relative}"
            )
        raw = path.read_bytes()
        total += len(raw)
        if total > MAX_SKILL_BYTES:
            raise CatalogError(
                f"Connection {slug} skill exceeds {MAX_SKILL_BYTES} bytes."
            )
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise CatalogError(
                f"Connection {slug} skill file is not UTF-8: {relative}"
            ) from None
        if "\x00" in content:
            raise CatalogError(f"Connection {slug} skill file contains NUL: {relative}")
        files[relative] = content
    if "SKILL.md" not in files:
        raise CatalogError(f"Connection {slug} is enabled but has no skill/SKILL.md.")
    match = FRONTMATTER_RE.match(files["SKILL.md"])
    frontmatter = yaml.safe_load(match.group(1)) if match else None
    if (
        not isinstance(frontmatter, dict)
        or frontmatter.get("name") != slug
        or not isinstance(frontmatter.get("description"), str)
        or not frontmatter["description"]
    ):
        raise CatalogError(
            f"Connection {slug} SKILL.md needs frontmatter with name: {slug} and a description."
        )
    return files


def load_catalog(root: Path) -> dict[str, Connection]:
    catalog: dict[str, Connection] = {}
    for directory in sorted(root.iterdir()):
        if not directory.is_dir() or directory.is_symlink():
            raise CatalogError(f"Unexpected catalog entry: {directory.name}")
        allowed = {"connection.yaml", "skill"}
        unexpected = {child.name for child in directory.iterdir()} - allowed
        if unexpected:
            raise CatalogError(
                f"Connection {directory.name} has unexpected files: {sorted(unexpected)}"
            )
        try:
            raw = yaml.safe_load((directory / "connection.yaml").read_text("utf-8"))
            definition = ConnectionDefinition.model_validate(raw)
        except (OSError, yaml.YAMLError, ValidationError) as error:
            raise CatalogError(
                f"Connection {directory.name} is invalid: {error}"
            ) from None
        if definition.slug != directory.name:
            raise CatalogError(
                f"Connection {directory.name} declares a different slug: {definition.slug}"
            )
        skill = directory / "skill"
        if definition.enabled:
            if not skill.is_dir() or skill.is_symlink():
                raise CatalogError(
                    f"Connection {definition.slug} is enabled but has no skill."
                )
            files = _load_skill(definition.slug, skill)
        else:
            if skill.exists():
                raise CatalogError(
                    f"Placeholder connection {definition.slug} must not ship a skill."
                )
            files = {}
        catalog[definition.slug] = Connection(definition, files)
    if not catalog:
        raise CatalogError("The connection catalog is empty.")
    return catalog


def deployment_skills(catalog: dict[str, Connection], slugs: list[str]) -> list[dict]:
    """The ``deployment.skills`` payload for the granted connections."""
    skills = []
    total = 0
    for slug in slugs:
        connection = catalog.get(slug)
        if connection is None or not connection.definition.enabled:
            raise CatalogError(f"Connection {slug} is not an enabled catalog entry.")
        total += sum(
            len(content.encode()) for content in connection.skill_files.values()
        )
        if total > MAX_SKILL_BYTES:
            raise CatalogError(
                f"Granted connection skills exceed {MAX_SKILL_BYTES} bytes."
            )
        skills.append({"slug": slug, "files": dict(connection.skill_files)})
    return skills


CATALOG = load_catalog(CATALOG_ROOT)
