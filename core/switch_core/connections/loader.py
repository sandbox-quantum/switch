"""The built-in connection catalog shipped in ``connections/catalog/``.

Each ``catalog/<slug>/connection.yaml`` describes one service a user can
connect. Enabled entries ship a skill under ``catalog/<slug>/skill/``, which
each session of an agent granted the service is given; placeholder entries
ship none. The catalog is validated once, at import, so a malformed
entry stops the server rather than surfacing on the first launch.

An enabled entry also names the adapter that reaches the vendor (``adapter``:
``github``, or the generic ``oauth``), says what each access level reaches
(``access``: OAuth scopes, or GitHub App permissions), which of the service's
tools each level offers (``tools``), how its sign-in is refreshed
(``auth.refresh``) and what a token it hands out is (``token``). An ``oauth``
entry also says how its OAuth client is had and where a sign-in may return
(``auth.oauth``), how the account's stable id is read (``auth.identity``), and
how its tools reach a session: the vendor's MCP servers (``mcp``), or the
vendor's command-line tool, run by the session host (``cli``). Placeholder
entries may leave all of those out.
"""

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

CATALOG_ROOT = Path(__file__).parent / "catalog"
MAX_SKILL_BYTES = 32 * 1024
SLUG_PATTERN = r"^[a-z0-9][a-z0-9-]{0,62}$"
HTTPS_URL_PATTERN = r"^https://[^\s/?#]+[^\s#]*$"
JSON_PATH_PATTERN = r"^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$"
# A minted token is made for the one issue, so the broker holds it to the hour
# every token it hands out was always held to.
MINTED_MAX_LIFETIME = 3600
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


AdapterName = Literal["github", "oauth"]
RedirectMode = Literal["loopback", "core"]
# Sign-in parameters a vendor may need beyond OAuth's own. The rest of an
# authorization request is Core's to set.
AuthorizationParam = Literal["access_type", "include_granted_scopes"]


class OAuthClient(BaseModel):
    """How Core has its OAuth client at the vendor, and where a sign-in returns.

    `registration`: `static`, a client the operator registers and names in
    `<client_settings>_CLIENT_CONFIG_PATH`; or `dynamic`, one Core registers
    itself on first connect and stores. `redirect`: where the browser may come
    back with the code, `core` (Core's own callback) or `loopback` (Switch
    Console's listener on 127.0.0.1), in the order offered. Without
    `authorization_url` and `token_url`, both are discovered from the MCP
    server's metadata. `revocation_url` is where a disconnect revokes the
    sign-in, where the vendor has one; `revocation_discovered` revokes at the
    authorization server's advertised revocation endpoint instead.
    `setup_note` tells people what a server without the client's settings
    lacks.

    `loopback_ports`: the only ports Switch Console's listener may use, for a
    vendor that matches a loopback redirect exactly, port included; without
    them any port is used. `prompt` is sent with every authorization, for a
    vendor that needs it (`consent`, to consent to a narrower set of scopes).
    So are `authorization_params`, which only a vendor-specific key may name
    (`access_type: offline`, for a vendor that hands out a refresh token only
    when asked), never one Core sets itself.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    registration: Literal["dynamic", "static"]
    client_settings: str | None = Field(default=None, pattern=r"^[A-Z][A-Z0-9_]{0,62}$")
    redirect: list[RedirectMode] = Field(min_length=1)
    loopback_ports: list[Annotated[int, Field(ge=1024, le=65535)]] | None = Field(
        default=None, min_length=1, max_length=10
    )
    prompt: Literal["consent", "login", "select_account"] | None = None
    authorization_params: dict[
        AuthorizationParam, Annotated[str, Field(pattern=r"^[A-Za-z0-9._~-]{1,64}$")]
    ] = Field(default_factory=dict)
    authorization_url: str | None = Field(default=None, pattern=HTTPS_URL_PATTERN)
    token_url: str | None = Field(default=None, pattern=HTTPS_URL_PATTERN)
    revocation_url: str | None = Field(default=None, pattern=HTTPS_URL_PATTERN)
    revocation_discovered: bool = False
    setup_note: str | None = Field(
        default=None, min_length=1, max_length=200, pattern=r"^[^\n]+$"
    )

    @model_validator(mode="after")
    def _consistent(self) -> "OAuthClient":
        if (self.registration == "static") != (self.client_settings is not None):
            raise ValueError(
                "client_settings names a static client's settings, and only one's"
            )
        if len(set(self.redirect)) != len(self.redirect):
            raise ValueError("a redirect mode is listed twice")
        if (self.authorization_url is None) != (self.token_url is None):
            raise ValueError(
                "authorization_url and token_url are given together, or discovered"
            )
        # The registration endpoint is found where the other two are.
        if self.registration == "dynamic" and self.authorization_url is not None:
            raise ValueError(
                "a dynamically registered client discovers its endpoints from the "
                "MCP server"
            )
        if self.loopback_ports is not None:
            if "loopback" not in self.redirect:
                raise ValueError("loopback_ports are for a loopback redirect")
            if len(set(self.loopback_ports)) != len(self.loopback_ports):
                raise ValueError("a loopback port is listed twice")
        if self.revocation_discovered and (
            self.revocation_url is not None or self.authorization_url is not None
        ):
            raise ValueError(
                "revocation_discovered takes the revocation endpoint from the "
                "discovered metadata, so neither it nor the others are named"
            )
        return self


class ConnectionIdentity(BaseModel):
    """Where the account's stable id is read: a GET of `url` with the access
    token, and the dotted paths in its JSON answer to the id and to a label
    people recognise (an email, a login)."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    url: str = Field(pattern=HTTPS_URL_PATTERN)
    account_id: str = Field(pattern=JSON_PATH_PATTERN)
    label: str = Field(pattern=JSON_PATH_PATTERN)


class ConnectionAuth(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    type: Literal["oauth", "api_key"]
    # rotating: each refresh returns a new refresh token and spends the old
    # one, so two refreshes must never race. reusable: the refresh token
    # survives its use. none: the stored secret is used as it is.
    refresh: Literal["rotating", "reusable", "none"] | None = None
    oauth: OAuthClient | None = None
    identity: ConnectionIdentity | None = None


class TokenPolicy(BaseModel):
    """What a token the broker hands out is.

    `minted`: made for the one issue and narrowed to the grant (GitHub's
    installation tokens). `pass_through`: the owner's own access token, shared
    by every agent they grant, which can be neither narrowed nor revoked per
    agent. `max_lifetime`, in seconds, is the longest the vendor's token may
    live; a longer one is refused.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    kind: Literal["minted", "pass_through"]
    max_lifetime: int = Field(ge=300, le=7 * 24 * 3600)

    @model_validator(mode="after")
    def _minted_within_the_hour(self) -> "TokenPolicy":
        if self.kind == "minted" and self.max_lifetime > MINTED_MAX_LIFETIME:
            raise ValueError(
                f"a minted token lives at most {MINTED_MAX_LIFETIME} seconds"
            )
        return self


class McpServer(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    name: str = Field(pattern=SLUG_PATTERN)
    url: str = Field(pattern=HTTPS_URL_PATTERN)


class ConnectionMcp(BaseModel):
    """The vendor's MCP servers a session calls, each under its own name."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    servers: list[McpServer] = Field(min_length=1)

    @model_validator(mode="after")
    def _distinct(self) -> "ConnectionMcp":
        names = [server.name for server in self.servers]
        if len(set(names)) != len(names):
            raise ValueError("two MCP servers share a name")
        # The session's own Switch server goes by this name.
        if "switch" in names:
            raise ValueError("an MCP server may not be named switch")
        return self


ENV_NAME_PATTERN = r"^[A-Z][A-Z0-9_]{0,62}$"
COMMAND_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,62}$"
FLAG_PATTERN = r"^(-[A-Za-z]|--[a-z0-9][a-z0-9-]{0,62})$"


class TokenRefused(BaseModel):
    """How a run of the tool says the vendor refused its token: its exit code,
    and a value at a dotted path in the JSON it writes to standard output."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    exit_code: int = Field(ge=1, le=255)
    json_path: str = Field(pattern=JSON_PATH_PATTERN)
    value: int | str


class ConnectionCli(BaseModel):
    """The vendor's command-line tool, which a session reaches as one Switch
    tool: the session host checks each command and runs `binary` itself, never
    through a shell.

    `name` is the tool's name in the session. The token goes only into
    `token_env` in the run's own environment; `config_env`, where the tool has
    one, names a configuration folder made for the session. A command's first
    argument must be in `allow` and not in `deny`, which also names flags
    refused anywhere in a command. `path_flags` are the flags whose value is a
    local file, read or written; the session host keeps them inside the
    session's folder. Output past `output_cap_bytes` goes to a file, and a run
    is stopped after `timeout_s`. A run that ends as `token_refused` says is
    run once more with a token asked for again.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    name: str = Field(pattern=SLUG_PATTERN)
    binary: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
    token_env: str = Field(pattern=ENV_NAME_PATTERN)
    config_env: str | None = Field(default=None, pattern=ENV_NAME_PATTERN)
    allow: list[Annotated[str, Field(pattern=COMMAND_PATTERN)]] = Field(min_length=1)
    deny: list[Annotated[str, Field(pattern=f"{COMMAND_PATTERN}|{FLAG_PATTERN}")]]
    path_flags: dict[
        Annotated[str, Field(pattern=FLAG_PATTERN)], Literal["read", "write"]
    ]
    output_cap_bytes: int = Field(ge=1024, le=10 * 1024 * 1024)
    timeout_s: int = Field(ge=5, le=600)
    token_refused: TokenRefused

    @model_validator(mode="after")
    def _consistent(self) -> "ConnectionCli":
        if self.name == "switch":
            raise ValueError("a command-line tool may not be named switch")
        if len(set(self.allow)) != len(self.allow):
            raise ValueError("a command is allowed twice")
        both = sorted(set(self.allow) & set(self.deny))
        if both:
            raise ValueError(f"commands both allowed and denied: {both}")
        denied_paths = sorted(set(self.path_flags) & set(self.deny))
        if denied_paths:
            raise ValueError(f"path flags that are also denied: {denied_paths}")
        if self.token_env == self.config_env:
            raise ValueError("token_env and config_env name the same variable")
        return self


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
    """The service's tools by level.

    `listed`: each level's tools are named, and a write grant gets both lists.
    `pass_through`: the vendor's own tool list is offered as it is, until its
    tools are classified by level.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    mode: Literal["listed", "pass_through"]
    read: list[str] | None = None
    write: list[str] | None = None

    @model_validator(mode="after")
    def _disjoint(self) -> "ConnectionTools":
        if self.mode == "pass_through":
            if self.read is not None or self.write is not None:
                raise ValueError("pass_through tools are not listed by level")
            return self
        if self.read is None or self.write is None:
            raise ValueError("listed tools name a read and a write list")
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
    adapter: AdapterName | None = None
    auth: ConnectionAuth
    token: TokenPolicy | None = None
    mcp: ConnectionMcp | None = None
    cli: ConnectionCli | None = None
    access: ConnectionAccess | None = None
    tools: ConnectionTools | None = None

    @model_validator(mode="after")
    def _enabled_is_complete(self) -> "ConnectionDefinition":
        if self.enabled:
            missing = [
                name
                for name, value in (
                    ("adapter", self.adapter),
                    ("token", self.token),
                    ("access", self.access),
                    ("tools", self.tools),
                    ("auth.refresh", self.auth.refresh),
                )
                if value is None
            ]
            if missing:
                raise ValueError(f"an enabled entry needs {', '.join(missing)}")
        if self.adapter == "github":
            self._check_github()
        elif self.adapter == "oauth":
            self._check_oauth()
        return self

    def _check_github(self) -> None:
        if self.auth.oauth is not None or self.auth.identity is not None:
            raise ValueError(
                "the github adapter takes its client from the GitHub App settings"
            )
        if self.mcp is not None or self.cli is not None:
            raise ValueError(
                "the github adapter has no MCP servers or command-line tool of its own"
            )
        if self.token is not None and self.token.kind != "minted":
            raise ValueError("the github adapter mints its tokens")

    def _check_oauth(self) -> None:
        if self.auth.type != "oauth":
            raise ValueError("the oauth adapter signs in with OAuth")
        if self.mcp is not None and self.cli is not None:
            raise ValueError(
                "an oauth entry's tools are its MCP servers or its command-line "
                "tool, not both"
            )
        if self.enabled:
            missing = [
                name
                for name, value in (
                    ("auth.oauth", self.auth.oauth),
                    ("auth.identity", self.auth.identity),
                    ("mcp or cli", self.mcp or self.cli),
                )
                if value is None
            ]
            if missing:
                raise ValueError(f"an oauth entry needs {', '.join(missing)}")
        oauth = self.auth.oauth
        # Discovery starts from an MCP server, so without one the catalog names
        # the endpoints, and the client is the operator's.
        if self.mcp is None and oauth is not None:
            if oauth.registration == "dynamic":
                raise ValueError(
                    "a dynamically registered client is found through an MCP "
                    "server, and this entry has none"
                )
            if oauth.authorization_url is None or oauth.revocation_discovered:
                raise ValueError(
                    "an entry without MCP servers names its authorization_url and "
                    "token_url, and its revocation_url where it has one"
                )
        if self.auth.refresh not in (None, "rotating", "reusable"):
            raise ValueError("an oauth sign-in is refreshed: rotating or reusable")
        if self.token is not None and self.token.kind != "pass_through":
            raise ValueError("the oauth adapter passes the owner's token through")
        if self.tools is not None and self.tools.mode != "pass_through":
            raise ValueError("an oauth entry's tools pass through until classified")
        if self.access is not None and any(
            level is not None and level.scopes is None
            for level in (self.access.read, self.access.write)
        ):
            raise ValueError("an oauth entry's levels name OAuth scopes")

    def level_tools(self, access: AccessLevel) -> list[str]:
        """Every tool a grant at `access` may be given. None are named while
        the vendor's tools pass through."""
        if self.tools is None or self.tools.read is None or self.tools.write is None:
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
    _check_server_names(catalog)
    return catalog


def session_server_names(definition: ConnectionDefinition) -> list[str]:
    """The names an entry's tools go by in a session, beside `switch`."""
    if definition.mcp is not None:
        return [server.name for server in definition.mcp.servers]
    if definition.cli is not None:
        return [definition.cli.name]
    return []


def _check_server_names(catalog: dict[str, Connection]) -> None:
    """A session is given every granted entry's servers at once, so no two
    entries may name one alike."""
    owners: dict[str, str] = {}
    for slug, entry in catalog.items():
        for name in session_server_names(entry.definition):
            if name in owners:
                raise CatalogError(
                    f"Connections {owners[name]} and {slug} both name a session "
                    f"server {name}."
                )
            owners[name] = slug


CATALOG = load_catalog(CATALOG_ROOT)
