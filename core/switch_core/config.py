from urllib.parse import urlsplit

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class SwitchConfig(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="")

    db_host: str
    db_port: str
    db_user: str
    db_password: str
    db_name: str

    matrix_server: str
    matrix_server_name: str
    matrix_admin_user: str
    matrix_admin_password: str
    matrix_registration_shared_secret: str
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
    # different IdP. Active only when issuer + client id + secret are all
    # set; the provider's endpoints are read from OIDC discovery.
    gateway_oidc_issuer_url: str | None = None
    gateway_oidc_client_id: str | None = None
    gateway_oidc_client_secret: str | None = None
    gateway_oidc_scopes: str | None = None
    gateway_oidc_provider_label: str | None = None
    # Absolute callback URL registered with the IdP. Must exactly match the
    # provider registration, e.g.
    # https://switch-gateway.<tailnet>.ts.net/gateway/auth/oidc/callback
    gateway_oidc_redirect_url: str | None = None
    # Lets the password login path be disabled (OIDC-only) without code changes.
    gateway_password_login_enabled: bool = True
    # Sets the Secure flag on the switch_auth cookie. Defaults to False so local
    # dev over plain HTTP keeps working; deployments serving over HTTPS must set
    # this true so the JWT session cookie is never sent over an insecure channel.
    gateway_cookie_secure: bool = False

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

    # libpq-style TLS mode for the Postgres connection, forwarded to asyncpg.
    # "disable" (the default) keeps in-cluster / local-dev connections plain,
    # matching current behaviour. Managed Postgres (RDS / Cloud SQL / Azure)
    # requires TLS — set "require" to encrypt without verifying the server
    # certificate, or "verify-ca" / "verify-full" to also validate it.
    db_ssl_mode: str = "disable"

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
        )
        set_count = sum(1 for value in required if value)
        if 0 < set_count < len(required):
            raise ValueError(
                "Partial gateway OIDC config: set all of "
                "GATEWAY_OIDC_ISSUER_URL / GATEWAY_OIDC_CLIENT_ID / "
                "GATEWAY_OIDC_CLIENT_SECRET, or none of them."
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
        return (
            f"postgresql+asyncpg://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )

    @property
    def db_connect_args(self) -> dict[str, object]:
        """asyncpg connect args derived from config.

        TLS is passed as asyncpg's ``ssl`` string argument (it accepts the same
        modes as libpq's ``sslmode``). ``disable`` means no argument at all, so
        plain connections behave exactly as before.
        """
        if self.db_ssl_mode == "disable":
            return {}
        return {"ssl": self.db_ssl_mode}
