import re
import ssl
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# A Postgres time value: a bare count of milliseconds, or a count with a unit.
_PG_INTERVAL_RE = re.compile(r"^\d+\s*(us|ms|s|min|h|d)?$")

# An unquoted Postgres identifier, and a conservative one: real role names are
# always this shape in practice, so anything outside it is a misconfiguration
# worth catching at startup rather than at the first `GRANT`. The 63-character
# cap matches Postgres's own `NAMEDATALEN` limit.
_DB_ROLE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")


class SwitchConfig(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="")

    db_host: str
    db_port: str
    db_user: str
    db_password: str
    db_name: str

    # The schema owner, used for exactly two things and never to serve a
    # request: running Alembic, and re-issuing the runtime role's grants right
    # after it, so a table a migration has just added is readable by the role
    # that is about to need it.
    #
    # `DB_USER` above is the *runtime* role, the one the row-level-security
    # policies apply to. It deliberately owns nothing and can create nothing,
    # so it cannot run a migration — that is what it is for, not an oversight
    # — and granting it schema rights so that boot-time migrations keep
    # working would hand back the ownership exemption the policies rely on it
    # not having.
    #
    # Boot always runs `alembic upgrade head`, unconditionally, whether or not
    # this is set — that is `main()`'s job, not this setting's. What this
    # setting decides is which connection that migration (and the runtime
    # role's grant re-issue right after it) runs on: `migrations/env.py` uses
    # the owner connection where one is configured here, and falls back to the
    # runtime connection where none is. That fallback is what keeps `alembic`
    # on the command line working against a scratch database a developer
    # points it at, where the two roles are the same one. For a deployment
    # that has moved DB_USER to a genuinely restricted runtime role without
    # also setting this, the same fallback is what makes the failure loud: the
    # runtime role cannot issue DDL, so the migration fails immediately with a
    # permission error naming the statement it could not run, rather than
    # boot silently skipping the migration or half-applying it.
    db_owner_user: str | None = None
    db_owner_password: str | None = None

    # Refuse to serve when the runtime connection is not actually subject to
    # the policies — a superuser, a `BYPASSRLS` role, or the owner of the
    # scoped tables. On by default because the failure it catches is silent: a
    # Switch that believes it is isolating tenants and is not looks exactly
    # like one that is, right up until a second customer reads the first's
    # rooms.
    #
    # Set false only for a deployment that has not created its runtime role
    # yet. Boot then logs at `error` on every start, because that is a
    # deployment with no tenant isolation in it.
    db_require_restricted_role: bool = True

    # The server half of every client's `@localpart:server` id. Not a
    # homeserver address — nothing is contacted at it — but the ids are stable
    # public handles, so the shape outlives the homeserver that chose it.
    matrix_server_name: str
    agent_registration_token: str

    # JWT auth
    jwt_secret_key: str

    # Gateway admin seed
    gateway_admin_email: str
    gateway_admin_password: str

    # OIDC (optional — enables OAuth token validation on the MCP server)
    oauth_issuer_url: str | None = None
    oauth_audience: str | None = None
    oauth_verify_issuer: bool = True

    # Gateway OIDC login (optional — bring-your-own identity provider for the
    # gateway browser login, e.g. Okta). Distinct from the agent oauth_*
    # settings above, which gate the MCP/agent bridge and may point at a
    # different IdP. Active only when issuer + client id + secret + scopes
    # are all set; the provider's endpoints are read from OIDC discovery.
    gateway_oidc_issuer_url: str | None = None
    gateway_oidc_client_id: str | None = None
    gateway_oidc_client_secret: str | None = None
    # Must include "openid": authlib omits the scope parameter entirely when
    # this is unset, so the provider applies its own default scope, which may
    # not include "openid" — the provider then issues no id_token, and the
    # callback falls back to the provider's userinfo endpoint, which may not
    # answer.
    gateway_oidc_scopes: str | None = None
    gateway_oidc_provider_label: str | None = None
    # Absolute callback URL registered with the IdP. Must exactly match the
    # provider registration, e.g.
    # https://switch-gateway.<tailnet>.ts.net/gateway/auth/oidc/callback
    gateway_oidc_redirect_url: str | None = None
    # JIT provisioning trusts the email claim, so by default a login is refused
    # unless the IdP asserts `email_verified`. That guards against an IdP where
    # a user can self-assert an address. It also rejects every user of an IdP
    # that never emits the claim as true — Okta's org authorization server only
    # sets it for users who completed its own email-verification flow, so
    # directory-provisioned users are permanently false and cannot be fixed
    # from the Okta side. Set false ONLY for a single-tenant IdP whose
    # addresses are authoritative (corporate directory, HR-provisioned).
    #
    # This only controls whether an unverified login is accepted at all — for
    # a brand-new identity, or one already linked to an account. It never lets
    # an unverified email link a *new* identity into a *different*,
    # pre-existing account: that always requires the IdP to assert
    # `email_verified=true`, regardless of this setting. See
    # UserStore.get_or_create_oidc_user.
    #
    # Exception: a legacy identity linked before issuers were tracked at all
    # resolves, and has its issuer backfilled, purely by matching its stored
    # subject — it never consults email, `email_verified`, or this setting.
    # That is not new here; it is the same subject-only match this login has
    # always done for such a row. See OidcIdentity's docstring in models.py.
    gateway_oidc_require_email_verified: bool = True
    # Lets the password login path be disabled (OIDC-only) without code changes.
    gateway_password_login_enabled: bool = True
    # Sets the Secure flag on the switch_auth cookie. Defaults to False so local
    # dev over plain HTTP keeps working; deployments serving over HTTPS must set
    # this true so the JWT session cookie is never sent over an insecure channel.
    gateway_cookie_secure: bool = False

    # ── Logging ──────────────────────────────────────────────────────────────
    # "text" for a terminal, "json" for a log pipeline that parses fields.
    log_format: str = "text"
    log_level: str = "INFO"
    switch_log_level: str = "INFO"
    # Emitted on every JSON log line as `service` / `env`, matching what a log
    # pipeline expects to group and filter by. `environment` is the deployment
    # (pilot, development, demo, public), not the machine.
    service_name: str = "switch-core"
    environment: str | None = None

    # The placeholder a log line carries when no tenant is bound at all —
    # deliberately not a tenant id, and it must not be set to one. An
    # authenticated request binds the caller's tenant (`gateway/auth.py`,
    # `bridges/agent/auth.py`); background work binds the tenant of the row it
    # is acting on (`tenant_context.py`); `LogContextFilter` prefers either
    # over this. What is left is code that has bound neither, which cannot
    # write a scoped row at all — `db/models.require_tenant_id` raises — so
    # this value never names where anything landed. Set it to a real tenant's
    # id and it starts to: every unattributed line in the deployment would be
    # indistinguishable from that tenant's own when an operator filters on
    # `tenant_id`.
    tenant_id: str = "default"

    server_host: str = "0.0.0.0"
    server_port: int = 8000

    frontend_base_url: str | None = None

    # Public origin (scheme + host, no path) of the Switch API — the same host
    # Switch Console reports as its `server`, e.g. https://switch-api.<tailnet>.ts.net.
    # Distinct from `frontend_base_url`, which is the operator UI. Powers the
    # `switchdash://` deeplink HTTP redirect (`/deeplink/session`, served on the
    # agent-bridge app) so the "Open in Switch Console" link is clickable on platforms
    # that only linkify http(s) (Discord, and any future http-only bridge). When
    # unset, the raw `switchdash://` deeplink is posted as-is.
    gateway_public_url: str | None = None

    # Upper bound on a single attachment an agent may post to a room (and that
    # a collaboration bridge will relay out). Uploads over this raise instead
    # of being truncated or silently dropped.
    agent_media_max_bytes: int = 20 * 1024 * 1024

    # Upper bound on a template document uploaded to the registry. The column
    # itself is unbounded, so raising this is a deploy-time change and never a
    # migration. Oversize uploads are refused rather than truncated.
    template_max_bytes: int = 1024 * 1024

    # Every authenticated agent request resolves its bearer token against the
    # database before the handler runs, and each live agent connection beats
    # every 2s, so the pool is sized against connection count rather than
    # human traffic: a fleet of N connections costs roughly N/2 checkouts per
    # second. Exceeding the pool does not shed load, it queues, and a queued
    # heartbeat that misses HEARTBEAT_TTL_SECONDS costs the connection.
    db_pool_size: int = 30
    db_max_overflow: int = 10
    db_pool_recycle: int = 1800
    db_pool_pre_ping: bool = True
    # SQLAlchemy's default is 30s, long enough that pool starvation surfaces as
    # unexplained latency rather than an error. Fail fast and loudly instead.
    db_pool_timeout: float = 5.0

    # Resolving a bearer token to its agent is the highest-frequency query in
    # the system — it runs before every authenticated request, and a fleet of
    # agents beats continuously — so a successful resolution is memoised in
    # process for this long. Only successes are cached; an unknown or revoked
    # token always reaches Postgres, and a rotation or an agent deletion drops
    # the entry immediately rather than waiting for it to expire. This is the
    # window in which an already-issued credential outlives its revocation, so
    # it is deliberately shorter than the agent heartbeat TTL. Set to 0 to
    # disable the cache and read the database on every request.
    agent_auth_cache_ttl_seconds: float = 5.0
    # Bound on the memo. One entry per distinct live token; the oldest is
    # evicted past this, so a flood of tokens cannot grow the process.
    agent_auth_cache_max_entries: int = 4096

    # Postgres terminates a connection that sits inside an open transaction
    # without executing anything for longer than this (a Postgres interval such
    # as "15s"), turning a slot that never comes back into a loud, attributable
    # error. Disabled by default, and it must stay that way until Matrix I/O
    # moves out of the RoomService transactions: `add_agents_to_room`,
    # `remove_agents_from_room` and `delete_room` currently hold a transaction
    # across invite/kick round trips, so enabling this today would trade a
    # latency problem for a consistency one — Matrix membership changed, the
    # rows that record it rolled back. Applies to the application engine only;
    # Alembic builds its own engine from `db_connect_args`, so a migration is
    # never killed mid-transaction.
    db_idle_in_transaction_session_timeout: str | None = None

    # A Postgres server that goes away without closing its sockets — a managed
    # instance failing over to its standby — leaves every connection open and
    # apparently healthy. Nothing above the socket can tell the difference:
    # reads block, the listener's heartbeat never returns, and the process goes
    # on reporting itself connected while delivering nothing. Only the kernel
    # finds out, and left to its own defaults it takes around fifteen minutes.
    #
    # These two mechanisms bound that, and both are needed because they cover
    # different sockets. Keepalive probes fail a connection that was idle when
    # the server vanished; the user timeout fails one that had already sent
    # something, which keepalives never look at. Seconds; 0 disables either.
    db_tcp_keepalive_idle: int = 10
    db_tcp_keepalive_interval: int = 5
    db_tcp_keepalive_count: int = 3
    db_tcp_user_timeout: int = 30

    # libpq-style TLS mode for the Postgres connection, forwarded to asyncpg.
    # "disable" (the default) keeps in-cluster / local-dev connections plain,
    # matching current behaviour. Managed Postgres (RDS / Cloud SQL / Azure)
    # requires TLS — set "require" to encrypt without verifying the server
    # certificate, or "verify-ca" / "verify-full" to also validate it.
    db_ssl_mode: str = "disable"

    # PEM bundle of certificate authorities the server certificate is checked
    # against, for the two verifying modes. Managed Postgres is signed by the
    # provider's own root rather than a public one — RDS publishes a global
    # bundle — so without this, "verify-ca" and "verify-full" fall back to the
    # system trust store and reject a perfectly good RDS instance.
    db_ssl_root_cert: str | None = None

    @model_validator(mode="after")
    def _validate_agent_auth_cache(self) -> "SwitchConfig":
        if self.agent_auth_cache_ttl_seconds < 0:
            raise ValueError(
                "AGENT_AUTH_CACHE_TTL_SECONDS must not be negative (0 disables "
                f"the cache), got {self.agent_auth_cache_ttl_seconds!r}."
            )
        if self.agent_auth_cache_max_entries < 1:
            raise ValueError(
                "AGENT_AUTH_CACHE_MAX_ENTRIES must be at least 1, got "
                f"{self.agent_auth_cache_max_entries!r}."
            )
        return self

    @model_validator(mode="after")
    def _validate_logging(self) -> "SwitchConfig":
        if self.log_format not in ("text", "json"):
            raise ValueError(
                f"LOG_FORMAT must be 'text' or 'json', got {self.log_format!r}."
            )
        levels = {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG", "NOTSET"}
        for name, value in (
            ("LOG_LEVEL", self.log_level),
            ("SWITCH_LOG_LEVEL", self.switch_log_level),
        ):
            if value.upper() not in levels:
                raise ValueError(
                    f"{name} must be one of {sorted(levels)}, got {value!r}."
                )
        if not self.tenant_id.strip():
            raise ValueError("TENANT_ID must not be empty.")
        if self.template_max_bytes < 1:
            raise ValueError(
                f"TEMPLATE_MAX_BYTES must be at least 1, got {self.template_max_bytes}."
            )
        return self

    @model_validator(mode="after")
    def _validate_db_user(self) -> "SwitchConfig":
        # `db_user` is the runtime role name, and `db/runtime_role.py` builds
        # `GRANT`/`ALTER DEFAULT PRIVILEGES` DDL by interpolating it (quoted
        # through Postgres's own `quote_ident`, which is what makes that safe
        # against injection). This is a second, independent layer: a role name
        # outside the shape every real one takes is far more likely a typo or
        # a stray character from a copied connection string than an intended
        # identifier, and rejecting it here turns that into a startup error
        # instead of a `GRANT` that quietly names a role nobody meant.
        if not _DB_ROLE_RE.match(self.db_user):
            raise ValueError(
                "DB_USER must be a plain identifier (letters, digits, "
                "underscore, not starting with a digit, 63 characters or "
                f"fewer), got {self.db_user!r}."
            )
        return self

    @model_validator(mode="after")
    def _validate_idle_in_transaction_session_timeout(self) -> "SwitchConfig":
        value = self.db_idle_in_transaction_session_timeout
        if value is not None and not _PG_INTERVAL_RE.match(value):
            raise ValueError(
                "DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT must be a Postgres "
                "interval such as '15s', '500ms' or a bare count of "
                f"milliseconds, got {value!r}."
            )
        return self

    @model_validator(mode="after")
    def _validate_db_ssl_mode(self) -> "SwitchConfig":
        allowed = {
            "disable",
            "allow",
            "prefer",
            "require",
            "verify-ca",
            "verify-full",
        }
        if self.db_ssl_mode not in allowed:
            raise ValueError(
                f"DB_SSL_MODE must be one of {sorted(allowed)}, "
                f"got {self.db_ssl_mode!r}."
            )
        if self.db_ssl_root_cert is not None:
            if self.db_ssl_mode not in ("verify-ca", "verify-full"):
                raise ValueError(
                    "DB_SSL_ROOT_CERT is only used by the verifying TLS modes, "
                    "so setting it with DB_SSL_MODE="
                    f"{self.db_ssl_mode!r} would silently not verify anything. "
                    "Set DB_SSL_MODE to 'verify-ca' or 'verify-full'."
                )
            if not Path(self.db_ssl_root_cert).is_file():
                raise ValueError(
                    f"DB_SSL_ROOT_CERT {self.db_ssl_root_cert!r} is not a file. "
                    "It must point at a PEM bundle readable by this process."
                )
        return self

    @model_validator(mode="after")
    def _validate_gateway_public_url(self) -> "SwitchConfig":
        # The deeplink redirect is registered at the gateway root (`/deeplink/
        # session`), so a public URL carrying a path prefix would build links
        # that 404. Reject it at startup rather than fail silently at click time.
        if self.gateway_public_url:
            parts = urlsplit(self.gateway_public_url)
            if not parts.scheme or not parts.netloc or parts.path not in ("", "/"):
                raise ValueError(
                    "GATEWAY_PUBLIC_URL must be a scheme + host only "
                    "(e.g. https://gateway.example), with no path, "
                    f"got {self.gateway_public_url!r}."
                )
        return self

    @model_validator(mode="after")
    def _validate_gateway_oidc(self) -> "SwitchConfig":
        required = (
            self.gateway_oidc_issuer_url,
            self.gateway_oidc_client_id,
            self.gateway_oidc_client_secret,
            self.gateway_oidc_scopes,
        )
        set_count = sum(1 for value in required if value)
        if 0 < set_count < len(required):
            raise ValueError(
                "Partial gateway OIDC config: set all of "
                "GATEWAY_OIDC_ISSUER_URL / GATEWAY_OIDC_CLIENT_ID / "
                "GATEWAY_OIDC_CLIENT_SECRET / GATEWAY_OIDC_SCOPES, or none "
                "of them."
            )
        if self.gateway_oidc_scopes and "openid" not in (
            self.gateway_oidc_scopes.split()
        ):
            raise ValueError(
                "GATEWAY_OIDC_SCOPES must include 'openid': without it the "
                "provider issues no id_token, and the callback falls back "
                "to the provider's userinfo endpoint, which may not answer. "
                f"Got {self.gateway_oidc_scopes!r}."
            )
        return self

    @property
    def gateway_oidc_enabled(self) -> bool:
        return bool(
            self.gateway_oidc_issuer_url
            and self.gateway_oidc_client_id
            and self.gateway_oidc_client_secret
        )

    @property
    def gateway_oidc_metadata_url(self) -> str:
        if self.gateway_oidc_issuer_url is None:
            raise ValueError("gateway_oidc_issuer_url is not set")
        return (
            f"{self.gateway_oidc_issuer_url.rstrip('/')}"
            "/.well-known/openid-configuration"
        )

    @property
    def database_url(self) -> str:
        """The runtime connection: the restricted role that serves every request."""
        return (
            f"postgresql+asyncpg://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )

    @property
    def owner_database_url(self) -> str | None:
        """The schema owner's connection, or None if this deployment has none.

        Same host, port and database as the runtime connection — only the role
        differs. Two roles rather than two databases is the entire shape: the
        owner exists so that something can run DDL, and the runtime role exists
        so that nothing serving a request can.
        """
        if self.db_owner_user is None or self.db_owner_password is None:
            return None
        return (
            f"postgresql+asyncpg://{self.db_owner_user}:{self.db_owner_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )

    @property
    def db_connect_args(self) -> dict[str, object]:
        """asyncpg connect args derived from config.

        TLS is passed as asyncpg's ``ssl`` string argument (it accepts the same
        modes as libpq's ``sslmode``). ``disable`` means no argument at all, so
        plain connections behave exactly as before.

        With a CA bundle configured, an :class:`ssl.SSLContext` is passed
        instead, because the string form gives asyncpg no way to be told which
        authorities to trust.
        """
        if self.db_ssl_mode == "disable":
            return {}
        if self.db_ssl_root_cert is None:
            return {"ssl": self.db_ssl_mode}
        context = ssl.create_default_context(cafile=self.db_ssl_root_cert)
        context.verify_mode = ssl.CERT_REQUIRED
        # verify-ca proves the certificate chains to a trusted CA; verify-full
        # additionally proves it was issued for the host we asked for.
        context.check_hostname = self.db_ssl_mode == "verify-full"
        return {"ssl": context}
