"""The built-in connection catalog shipped in ``connections/catalog/``.

Each ``catalog/<slug>/connection.yaml`` describes one service a user can
connect. Enabled entries ship a skill under ``catalog/<slug>/skill/``, which
each session of an agent granted the service is given; placeholder entries
ship none. The catalog is validated once, at import, so a malformed
entry stops the server rather than surfacing on the first launch.

An enabled entry also names the adapter that reaches the vendor (``adapter``:
``github``, the generic ``oauth``, or ``api_key`` for a vendor whose people
paste a key rather than sign in), says what each access level reaches
(``access``: OAuth scopes, or GitHub App permissions), which of the service's
tools each level offers (``tools``), how its sign-in is refreshed
(``auth.refresh``) and what a token it hands out is (``token``). An ``oauth``
entry also says how its OAuth client is had and where a sign-in may return
(``auth.oauth``), how the account's stable id is read (``auth.identity``), and
how its tools reach a session: the vendor's MCP servers (``mcp``), or the
vendor's command-line tool, run by the session host (``cli``). An ``api_key``
entry names the fields a person pastes and the call that checks them
(``auth.api_key``), and how the session host puts them into each MCP request's
headers or each CLI run's environment, by template. Placeholder entries may
leave all of those out.
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


AdapterName = Literal["github", "oauth", "api_key"]
RedirectMode = Literal["loopback", "core"]
# Sign-in parameters a vendor may need beyond OAuth's own. The rest of an
# authorization request is Core's to set.
AuthorizationParam = Literal["access_type", "include_granted_scopes"]


class OAuthClient(BaseModel):
    """How Core has its OAuth client at the vendor, and where a sign-in returns.

    `registration`: `static`, a client the operator registers and saves from
    the dashboard or names in `<client_settings>_CLIENT_CONFIG_PATH`; or `dynamic`, one Core registers
    itself on first connect and stores. `redirect`: where the browser may come
    back with the code, `core` (Core's own callback) or `loopback` (Switch
    Console's listener on 127.0.0.1), in the order offered. Without
    `authorization_url` and `token_url`, both are discovered from the MCP
    server's metadata. `revocation_url` is where a disconnect revokes the
    sign-in, where the vendor has one; `revocation_discovered` revokes at the
    authorization server's advertised revocation endpoint instead. A vendor
    with neither needs `remove_access`: where the person removes Switch
    themselves, and what the sign-in does until they do, said whenever Switch
    drops one it cannot revoke.

    `unchecked`: what a static client's operator must see to themselves,
    because asking the vendor about the client cannot show it; said with every
    check that passes.

    `loopback_ports`: the only ports Switch Console's listener may use, for a
    vendor that matches a loopback redirect exactly, port included; without
    them any port is used. `prompt` is sent with every authorization, for a
    vendor that needs it (`consent`, to consent to a narrower set of scopes;
    `select_account`, to let the person choose the account), one value or
    several separated by spaces, as OAuth writes it.
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
    prompt: str | None = Field(
        default=None,
        pattern=r"^(consent|login|select_account)( (consent|login|select_account)){0,2}$",
    )
    authorization_params: dict[
        AuthorizationParam, Annotated[str, Field(pattern=r"^[A-Za-z0-9._~-]{1,64}$")]
    ] = Field(default_factory=dict)
    authorization_url: str | None = Field(default=None, pattern=HTTPS_URL_PATTERN)
    token_url: str | None = Field(default=None, pattern=HTTPS_URL_PATTERN)
    revocation_url: str | None = Field(default=None, pattern=HTTPS_URL_PATTERN)
    revocation_discovered: bool = False
    remove_access: str | None = Field(default=None, min_length=1, max_length=400)
    unchecked: str | None = Field(default=None, min_length=1, max_length=400)

    @model_validator(mode="after")
    def _consistent(self) -> "OAuthClient":
        if self.prompt is not None:
            prompts = self.prompt.split(" ")
            if len(set(prompts)) != len(prompts):
                raise ValueError("a prompt value is listed twice")
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
        if self.unchecked is not None and self.registration != "static":
            raise ValueError("unchecked is for a static client, which is checked")
        if (
            self.revocation_url is None
            and not self.revocation_discovered
            and self.remove_access is None
        ):
            raise ValueError(
                "a vendor Switch cannot revoke a sign-in at needs remove_access: "
                "where people remove Switch themselves"
            )
        return self


class ConnectionIdentity(BaseModel):
    """Where the account's stable id is read: a GET or POST of `url` with the access
    token, and the dotted paths in its JSON answer to the id and to a label
    people recognise (an email, a login)."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    method: Literal["GET", "POST"] = "GET"
    url: str = Field(pattern=HTTPS_URL_PATTERN)
    body: dict[str, object] | None = None
    account_id: str = Field(pattern=JSON_PATH_PATTERN)
    label: str = Field(pattern=JSON_PATH_PATTERN)

    @model_validator(mode="after")
    def _body_for_post(self) -> "ConnectionIdentity":
        if (self.body is not None) != (self.method == "POST"):
            raise ValueError("a POST identity call sends a body, and only one does")
        return self


FIELD_NAME_PATTERN = r"^[a-z][a-z0-9_]{0,31}$"
HEADER_NAME_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
# A choice ends up in a URL's host or path, so it is a plain DNS-ish word.
CHOICE_PATTERN = r"^[a-z0-9][a-z0-9.-]{0,62}$"
TEMPLATE_FIELD_RE = re.compile(r"\{([^{}]*)\}")
# What a session host puts in a template for a token that is not made of
# fields: the whole token, as an OAuth entry's servers take it.
TOKEN_PLACEHOLDER = "token"


def template_fields(template: str) -> list[str]:
    """The fields a template names, as `{name}`; a stray brace is refused."""
    names = TEMPLATE_FIELD_RE.findall(template)
    if TEMPLATE_FIELD_RE.sub("", template).count("{") or TEMPLATE_FIELD_RE.sub(
        "", template
    ).count("}"):
        raise ValueError(f"{template!r} has a brace that names no field")
    for name in names:
        if not re.fullmatch(FIELD_NAME_PATTERN, name):
            raise ValueError(f"{template!r} names a field that cannot be one: {name!r}")
    return names


class ApiKeyField(BaseModel):
    """One value a person pastes, or picks, to connect.

    A `secret` field is the key itself, typed freely and never shown again.
    Any other field is a choice among `choices` (a site, a region), which
    templates may put in a URL: never free text.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    name: str = Field(pattern=FIELD_NAME_PATTERN)
    label: str = Field(min_length=1, max_length=64)
    secret: bool
    help: str | None = Field(
        default=None, min_length=1, max_length=200, pattern=r"^[^\n]+$"
    )
    choices: list[Annotated[str, Field(pattern=CHOICE_PATTERN)]] | None = Field(
        default=None, min_length=1, max_length=20
    )

    @model_validator(mode="after")
    def _secret_or_choice(self) -> "ApiKeyField":
        if self.name == TOKEN_PLACEHOLDER:
            raise ValueError(f"a field may not be named {TOKEN_PLACEHOLDER}")
        if self.secret == (self.choices is not None):
            raise ValueError(
                f"field {self.name} is a secret typed freely, or a choice among "
                "choices: one of the two"
            )
        if self.choices is not None and len(set(self.choices)) != len(self.choices):
            raise ValueError(f"field {self.name} lists a choice twice")
        return self


class ApiKeyIdentity(BaseModel):
    """The call that checks a pasted key and says whose it is: `method` to
    `url`, with `headers` (and a JSON `body`, for a POST), each a template of
    the fields. `account_id` and `label` are dotted paths in its JSON answer;
    without `account_id` the account is the key itself (its SHA-256), and
    without `label` the connection is named by the service and its choices."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    method: Literal["GET", "POST"]
    url: str = Field(pattern=HTTPS_URL_PATTERN)
    headers: dict[Annotated[str, Field(pattern=HEADER_NAME_PATTERN)], str] = Field(
        min_length=1
    )
    body: dict[str, object] | None = None
    account_id: str | None = Field(default=None, pattern=JSON_PATH_PATTERN)
    label: str | None = Field(default=None, pattern=JSON_PATH_PATTERN)

    @model_validator(mode="after")
    def _body_for_post(self) -> "ApiKeyIdentity":
        if (self.body is not None) != (self.method == "POST"):
            raise ValueError("a POST identity call sends a body, and only one does")
        return self


class ApiKeySignIn(BaseModel):
    """How a person connects with a key: the fields they paste or pick, the
    call that checks them, and where they make the key (`help_url`)."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    fields: list[ApiKeyField] = Field(min_length=1, max_length=4)
    identity: ApiKeyIdentity
    help_url: str | None = Field(default=None, pattern=HTTPS_URL_PATTERN)

    @model_validator(mode="after")
    def _fields_used_well(self) -> "ApiKeySignIn":
        names = [field.name for field in self.fields]
        if len(set(names)) != len(names):
            raise ValueError("two fields share a name")
        if not any(field.secret for field in self.fields):
            raise ValueError("an api_key sign-in has at least one secret field")
        check_templates(
            self,
            urls=[self.identity.url],
            values=list(self.identity.headers.values()),
            where="the identity call",
        )
        return self

    def field_names(self) -> set[str]:
        return {field.name for field in self.fields}

    def choice_names(self) -> set[str]:
        return {field.name for field in self.fields if not field.secret}


def check_templates(
    sign_in: "ApiKeySignIn", *, urls: list[str], values: list[str], where: str
) -> None:
    """Templates name only the sign-in's fields, and a URL only its choices."""
    known = sign_in.field_names()
    choices = sign_in.choice_names()
    for url in urls:
        for name in template_fields(url):
            if name not in choices:
                raise ValueError(
                    f"{where}'s URL may name only a choice field, not {name!r}"
                )
    for value in values:
        for name in template_fields(value):
            if name not in known:
                raise ValueError(f"{where} names an unknown field {name!r}")


class ConnectionAuth(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    type: Literal["oauth", "api_key"]
    # rotating: each refresh returns a new refresh token and spends the old
    # one, so two refreshes must never race. reusable: the refresh token
    # survives its use. none: the stored secret is used as it is.
    refresh: Literal["rotating", "reusable", "none"] | None = None
    oauth: OAuthClient | None = None
    identity: ConnectionIdentity | None = None
    api_key: ApiKeySignIn | None = None


class TokenPolicy(BaseModel):
    """What a token the broker hands out is.

    `minted`: made for the one issue and narrowed to the grant (GitHub's
    installation tokens). `pass_through`: the owner's own access token, shared
    by every agent they grant, which can be neither narrowed nor revoked per
    agent. `max_lifetime`, in seconds, is the longest the credential handed
    out may stay valid at the vendor; one valid for longer is refused. It is
    null for a credential that never expires (a pasted key): Switch could
    neither take such a credential back nor wait for it to lapse, so it is
    never handed to an agent.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    kind: Literal["minted", "pass_through"]
    max_lifetime: Annotated[int, Field(ge=300, le=7 * 24 * 3600)] | None

    @property
    def issued_to_agents(self) -> bool:
        return self.max_lifetime is not None

    @model_validator(mode="after")
    def _minted_within_the_hour(self) -> "TokenPolicy":
        if self.kind == "minted" and (
            self.max_lifetime is None or self.max_lifetime > MINTED_MAX_LIFETIME
        ):
            raise ValueError(
                f"a minted token lives at most {MINTED_MAX_LIFETIME} seconds"
            )
        return self


class McpServer(BaseModel):
    """One vendor MCP server. `headers` are an api_key entry's, templates of
    its fields; an OAuth entry's server takes the token as a bearer."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    name: str = Field(pattern=SLUG_PATTERN)
    url: str = Field(pattern=HTTPS_URL_PATTERN)
    headers: dict[Annotated[str, Field(pattern=HEADER_NAME_PATTERN)], str] | None = (
        Field(default=None, min_length=1)
    )


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


class PathArgument(BaseModel):
    """A command's positional argument that is a local file: the one right
    after the word `after`, wherever that word stands."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    after: str = Field(pattern=r"^\+?[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
    direction: Literal["read", "write"]


ReleaseTarget = Literal[
    "darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"
]


class ReleaseBuild(BaseModel):
    """One machine's build: the archive, its SHA-256, and where the binary is
    inside it."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    url: str = Field(pattern=HTTPS_URL_PATTERN)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    path: str = Field(
        pattern=r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}(/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}){0,3}$"
    )


class CliRelease(BaseModel):
    """The tool's pinned release. A session host downloads the archive for its
    own machine (`<platform>-<arch>`, as Node names them), refuses it unless
    its SHA-256 matches, and runs the binary from it. A machine without a
    build cannot run the tool."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    version: str = Field(pattern=r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$")
    targets: dict[ReleaseTarget, ReleaseBuild] = Field(min_length=1)


class ConnectionCli(BaseModel):
    """The vendor's command-line tool, which a session reaches as one Switch
    tool: the session host checks each command and runs `binary` itself, never
    through a shell.

    `name` is the tool's name in the session. The token goes only into
    `token_env` in the run's own environment (an api_key entry's fields into
    `env`'s variables, by template); `config_env`, where the tool has
    one, names a configuration folder made for the session. A command's first
    argument must be in `allow` and not in `deny`, which also names flags
    refused anywhere in a command. `path_flags` are the flags whose value is a
    local file, read or written, and `path_args` the positional arguments that
    are; the session host keeps both inside the session's folder. Output past `output_cap_bytes` goes to a file, and a run
    is stopped after `timeout_s`. A run that ends as `token_refused` says is
    run once more with a token asked for again. `release` pins the build every
    session runs.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    name: str = Field(pattern=SLUG_PATTERN)
    binary: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
    token_env: str | None = Field(default=None, pattern=ENV_NAME_PATTERN)
    # An api_key entry's: each variable set in the run, a template of its fields.
    env: dict[Annotated[str, Field(pattern=ENV_NAME_PATTERN)], str] | None = Field(
        default=None, min_length=1, max_length=8
    )
    config_env: str | None = Field(default=None, pattern=ENV_NAME_PATTERN)
    allow: list[Annotated[str, Field(pattern=COMMAND_PATTERN)]] = Field(min_length=1)
    deny: list[Annotated[str, Field(pattern=f"{COMMAND_PATTERN}|{FLAG_PATTERN}")]]
    path_flags: dict[
        Annotated[str, Field(pattern=FLAG_PATTERN)], Literal["read", "write"]
    ]
    path_args: list[PathArgument]
    output_cap_bytes: int = Field(ge=1024, le=10 * 1024 * 1024)
    timeout_s: int = Field(ge=5, le=600)
    token_refused: TokenRefused
    release: CliRelease

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
        afters = [argument.after for argument in self.path_args]
        if len(set(afters)) != len(afters):
            raise ValueError("a path argument is named twice")
        if (self.token_env is None) == (self.env is None):
            raise ValueError(
                "a command-line tool takes its token in token_env, or its key's "
                "fields in env: one of the two"
            )
        if self.config_env is not None and (
            self.config_env == self.token_env or self.config_env in (self.env or {})
        ):
            raise ValueError("config_env names a variable the credential sets")
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
                    # A key reaches whatever its vendor let it; no level is named.
                    ("access", self.access or self.adapter == "api_key" or None),
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
        elif self.adapter == "api_key":
            self._check_api_key()
        if self.adapter != "api_key":
            if self.auth.api_key is not None:
                raise ValueError("only the api_key adapter has key fields")
            if self.mcp is not None and any(s.headers for s in self.mcp.servers):
                raise ValueError("only an api_key entry's MCP servers name headers")
            if self.cli is not None and self.cli.env is not None:
                raise ValueError("only an api_key entry's tool takes env templates")
        return self

    def _check_api_key(self) -> None:
        if self.auth.type != "api_key":
            raise ValueError("the api_key adapter connects with a pasted key")
        if self.auth.oauth is not None or self.auth.identity is not None:
            raise ValueError("an api_key entry has no OAuth client or identity")
        if self.auth.refresh not in (None, "none"):
            raise ValueError("a key is not refreshed: refresh is none")
        if self.mcp is not None and self.cli is not None:
            raise ValueError(
                "an api_key entry's tools are its MCP servers or its command-line "
                "tool, not both"
            )
        if self.enabled and (self.auth.api_key is None or not (self.mcp or self.cli)):
            raise ValueError("an api_key entry needs auth.api_key, and mcp or cli")
        if self.token is not None and (
            self.token.kind != "pass_through" or self.token.max_lifetime is not None
        ):
            raise ValueError(
                "a key does not expire, so it is never handed to an agent: "
                "token is { kind: pass_through, max_lifetime: null }"
            )
        if self.access is not None:
            raise ValueError("a key reaches whatever its vendor let it: no access")
        if self.tools is not None and self.tools.mode != "pass_through":
            raise ValueError("an api_key entry's tools pass through")
        sign_in = self.auth.api_key
        if sign_in is None:
            return
        if self.mcp is not None:
            for server in self.mcp.servers:
                if server.headers is None:
                    raise ValueError(
                        f"MCP server {server.name} names the headers the key goes in"
                    )
                check_templates(
                    sign_in,
                    urls=[server.url],
                    values=list(server.headers.values()),
                    where=f"MCP server {server.name}",
                )
        if self.cli is not None:
            if self.cli.env is None:
                raise ValueError("an api_key entry's tool names env templates")
            check_templates(
                sign_in,
                urls=[],
                values=list(self.cli.env.values()),
                where=f"command-line tool {self.cli.name}",
            )

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
        if self.cli is not None and self.cli.token_env is None:
            raise ValueError("an oauth entry's tool takes its token in token_env")
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
        if self.token is not None and self.token.max_lifetime is None:
            raise ValueError("an OAuth access token expires: name its max_lifetime")
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
