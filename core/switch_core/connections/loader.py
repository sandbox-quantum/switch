"""The built-in connection catalog shipped in ``connections/catalog/``.

Each ``catalog/<slug>/connection.yaml`` describes one service a user can
connect. Enabled entries ship a skill under ``catalog/<slug>/skill/``, which
each session of an agent granted the service is given; placeholder entries
ship none. The catalog is validated once, at import, so a malformed
entry stops the server rather than surfacing on the first launch.

An enabled entry also says what each access level reaches (``access``: OAuth
scopes, or GitHub App permissions), which of the service's tools each level
offers (``tools``), and how its sign-in is refreshed (``auth.refresh``).
Placeholder entries may leave those out.
"""

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

CATALOG_ROOT = Path(__file__).parent / "catalog"
MAX_SKILL_BYTES = 32 * 1024
SLUG_PATTERN = r"^[a-z0-9][a-z0-9-]{0,62}$"
SKILL_PATH_RE = re.compile(
    r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}(/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}){0,7}$"
)
FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
# A skill describes tasks, tools and limits. How a credential reaches the agent
# is its host's business, and a skill that names one invites the agent to go
# looking for it.
SKILL_FORBIDDEN = ("GH_TOKEN", "gh auth", "access token", "API key")


class CatalogError(RuntimeError):
    pass


AccessLevel = Literal["read", "write"]


class ConnectionAuth(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    type: Literal["oauth", "api_key"]
    # rotating: each refresh returns a new refresh token and spends the old
    # one, so two refreshes must never race. reusable: the refresh token
    # survives its use. none: the stored secret is used as it is.
    refresh: Literal["rotating", "reusable", "none"] | None = None


class LevelAccess(BaseModel):
    """What one access level reaches: OAuth scopes, or GitHub App permissions."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    scopes: list[str] | None = None
    permissions: dict[str, AccessLevel] | None = None

    @model_validator(mode="after")
    def _one_kind(self) -> "LevelAccess":
        if (self.scopes is None) == (self.permissions is None):
            raise ValueError("an access level holds scopes or permissions, not both")
        if not (self.scopes or self.permissions):
            raise ValueError("an access level needs at least one scope or permission")
        return self


class ConnectionAccess(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    read: LevelAccess
    write: LevelAccess | None = None


class ConnectionTools(BaseModel):
    """The service's tools by level. A write grant gets both lists."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    read: list[str]
    write: list[str]

    @model_validator(mode="after")
    def _disjoint(self) -> "ConnectionTools":
        both = sorted(set(self.read) & set(self.write))
        if both:
            raise ValueError(f"tools listed under both read and write: {both}")
        return self


class ConnectionDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    slug: str = Field(pattern=SLUG_PATTERN)
    name: str = Field(min_length=1, max_length=64)
    category: str = Field(min_length=1, max_length=64)
    description: str = Field(min_length=1, max_length=200, pattern=r"^[^\n]+$")
    enabled: bool
    auth: ConnectionAuth
    access: ConnectionAccess | None = None
    tools: ConnectionTools | None = None

    @model_validator(mode="after")
    def _enabled_is_complete(self) -> "ConnectionDefinition":
        if self.enabled:
            missing = [
                name
                for name, value in (
                    ("access", self.access),
                    ("tools", self.tools),
                    ("auth.refresh", self.auth.refresh),
                )
                if value is None
            ]
            if missing:
                raise ValueError(f"an enabled entry needs {', '.join(missing)}")
        return self

    def level_tools(self, access: AccessLevel) -> list[str]:
        """Every tool a grant at `access` may be given."""
        if self.tools is None:
            return []
        if access == "read":
            return list(self.tools.read)
        return [*self.tools.read, *self.tools.write]


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
        lowered = content.lower()
        for phrase in SKILL_FORBIDDEN:
            if phrase.lower() in lowered:
                raise CatalogError(
                    f"Connection {slug} skill file {relative} mentions {phrase!r}. "
                    "A skill describes tasks, tools and limits, never credentials "
                    "or setup."
                )
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


CATALOG = load_catalog(CATALOG_ROOT)
