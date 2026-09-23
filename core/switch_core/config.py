import re
import ssl
import uuid
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

    # Off by default: a person who belongs to more than one tenant and has not
    # selected one on their session gets the same 403 a single-tenant
    # deployment already returns today, rather than a 409 listing the tenants
    # to choose from. The 409 is a breaking change for a client that has never
    # had to handle it — set true only once the client that will authenticate
    # against this deployment knows what to do with it. See
    # docs/old/multi-tenancy-phase2-tenants.md, §4.
    gateway_tenant_choice_enabled: bool = False

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

    # ── Observability ────────────────────────────────────────────────────────
    # The OTLP/HTTP collector, as a base URL with no path: signals are appended
    # as `/v1/metrics` and `/v1/logs`, the `OTEL_EXPORTER_OTLP_ENDPOINT`
    # convention. Unset — the default — means nothing leaves the process.
    otlp_endpoint: str | None = None

    # Logs are off because they already reach the container's output; a second
    # copy over the network is a volume decision for whoever pays for it.
    # No traces setting: nothing produces spans, and a flag that changes
    # nothing is a configuration surface that lies about what it controls.
    otlp_metrics_enabled: bool = True
    otlp_logs_enabled: bool = False

    # `key=value` pairs, comma-separated, on every OTLP request. Usually an API
    # key for a collector that authenticates.
    otlp_headers: str | None = None

    otlp_timeout_seconds: float = 10.0
    otlp_export_interval_seconds: float = 60.0

    # Which deployment a measurement came from. Required whenever reporting is
    # on, because the collector drops payloads without one in silence and with
    # a 200 — a deployment that omitted it would look configured and appear in
    # no dashboard. Not generated per process: a fresh id each restart makes
    # one deployment look like an endless population of installs.
    #
    # Both streams use this value, so a deployment reporting metrics and usage
    # is one subject downstream. Product telemetry falls back to an id in the
    # database, which also carries the install date no env var can supply.
    deployment_id: str | None = None

    # ── Product telemetry ────────────────────────────────────────────────────
    # Usage reporting, separate from the operational export above and
    # deliberately so. That one names *a collector* — often the customer's own
    # — and carries how the server is behaving. This one carries how the
    # product is being used, and goes to the analytics relay. A self-hosted
    # deployment pointing its metrics at its own Datadog must not thereby send
    # its usage analytics there too, and Flint must not receive a customer's
    # operational metrics. Same wire format, same client, two destinations.
    #
    # **Off unless switched on, and that default is deliberate.** A Switch
    # server may be a customer's, and the usage may be theirs, so reporting it
    # is a decision an operator makes rather than one they discover. When this
    # is false nothing is collected and no request is made.
    #
    # What is reported is fixed in `telemetry/catalogue.py` and explained in
    # `docs/old/telemetry-events.md`: counts and durations only, never an
    # identifier for a room, tenant, agent, user or message, and never free
    # text. The catalogue is enforced at the boundary rather than trusted.
    telemetry_enabled: bool = False

    # Base URL of the relay, no path — `/v1/logs` is appended, the same
    # convention `otlp_endpoint` above follows. Defaults to the company relay,
    # which is where Switch Console already reports, so one pipeline carries
    # both. Override to point a development run at a local sink.
    telemetry_endpoint: str = "https://telemetry.flintai.dev"

    # How long to wait on the relay before giving up on a single event.
    # Telemetry is never worth delaying real work for, and a send that is
    # already this late is not worth finishing.
    telemetry_timeout_seconds: float = 10.0

    # How often the daily usage snapshot is collected and sent. Hours rather
    # than a fixed clock time so a deployment does not have to care which
    # timezone it is in; the schedule is anchored to what was last sent, not
    # to how long this process has been up.
    telemetry_snapshot_interval_hours: float = 24.0

    server_host: str = "0.0.0.0"
    server_port: int = 8000

    # Where collaboration bridges take platform callbacks. Only a Mattermost
    # button press needs one today: the press is delivered by the Mattermost
    # server to a URL, where every other platform Switch bridges to sends it
    # down a connection Switch already holds open.
    #
    # A socket of its own, not a route on the port above, which carries the
    # agent API, the MCP server and the operator dashboard. What an operator
    # has to expose for a button to work should be callbacks and nothing else,
    # so that one over-broad proxy rule cannot publish the other three. It
    # stays unbound in a deployment where no bridge asks to be called back.
    collaboration_callback_host: str = "0.0.0.0"
    collaboration_callback_port: int = 8081

    frontend_base_url: str | None = None

    # Public origin (scheme + host, no path) of the Switch API — the same host
    # Switch Console reports as its `server`, e.g. https://switch-api.<tailnet>.ts.net.
    # Distinct from `frontend_base_url`, which is the operator UI. Powers the
    # `switchdash://` deeplink HTTP redirect (`/deeplink/session`, served on the
    # agent-bridge app) so the "Open in Switch Console" link is clickable on platforms
    # that only linkify http(s) (Discord, and any future http-only bridge). When
    # unset, the raw `switchdash://` deeplink is posted as-is.
    gateway_public_url: str | None = None

    # Credentials of the distributed Slack app *we* registered — the one a
    # customer installs by clicking a button, as opposed to the app an operator
    # registers themselves and pastes tokens for. See
    # `docs/old/bridges/SLACK_DISTRIBUTED_APP.md`.
    #
    # Setting all three is what enables workspace installs at all: there is no
    # separate on/off switch, because an app with no credentials is not an app.
    # Setting some is a mistake and is refused at startup.
    #
    # The signing secret is the one that must never be treated as optional in
    # spirit: it is the whole of what distinguishes a Slack event from a post by
    # anyone who learned the URL.
    slack_app_client_id: str | None = None
    slack_app_client_secret: str | None = None
    slack_app_signing_secret: str | None = None

    # The distributed Discord app (`DISCORD_DISTRIBUTED_APP.md`): the one app
    # *we* register and a customer adds to their server, distinct from the
    # self-registered app whose token an operator pastes in.
    #
    # Four values and not three, and the shape difference from Slack is the last
    # one: Discord grants no per-install token, so the bot token is deployment
    # config that lives *here* and is injected into the one shared Gateway
    # connection — not captured per install the way a Slack workspace token is.
    # As with Slack, setting all of them is what enables installs (registration
    # is the feature flag) and setting some is a startup error.
    discord_app_client_id: str | None = None
    discord_app_client_secret: str | None = None
    discord_app_bot_token: str | None = None
    discord_app_application_id: str | None = None

    # Whether the shared Gateway connection requests the privileged message-
    # content intent. Off by default (mention-only): the connection opens
    # unapproved and agents still see mentions of the bot and its own messages.
    # Requesting it while unapproved closes the connection past Discord's
    # ~100-guild verification threshold, so it is a deliberate flag flipped once
    # the app is verified — not something inferred (decision #5).
    discord_app_message_content: bool = False

    # Whether the shared Gateway connection requests the privileged server-
    # members intent. Off by default, and privileged the same way message
    # content is: requesting it unapproved closes the connection past the
    # ~100-guild threshold. Off, member lookups fall back to API fetches; on
    # (once verified), the bot fills its member cache. Its own flag rather than
    # riding message content's, because the two are approved independently.
    discord_app_members: bool = False

    # Public origin (scheme + host, no path) that a messaging platform reaches
    # Switch on: the base of the OAuth redirect and of the three event URLs
    # under `/messaging`, and the one registered with the app.
    #
    # Separate from `gateway_public_url` because the two answer to different
    # audiences and need not be the same host. The gateway URL is opened by a
    # person following a deeplink and may live on a private network; this one
    # is dialled by Slack from the internet and must resolve and present a
    # browser-trusted certificate there. A deployment whose gateway is
    # reachable only over a VPN can still offer installs, and pointing the
    # gateway URL at the internet-facing host to achieve that would silently
    # move every deeplink along with it.
    messaging_public_url: str | None = None

    # Upper bound on a single attachment an agent may post to a room (and that
    # a collaboration bridge will relay out). Uploads over this raise instead
    # of being truncated or silently dropped.
    agent_media_max_bytes: int = 20 * 1024 * 1024

    # Development only. No agent host speaks the session interaction contract
    # yet, so there is no session whose requests could reach a channel. With
    # this set, `!session-demo` in a bridged Slack channel posts the recorded
    # fixture's request there as a real card, to exercise the answer path
    # against a real workspace. It needs the repository checkout for the
    # fixtures, and it says in the log that there is no session behind the card.
    session_demo_enabled: bool = False

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

    # How long a migration waits for a lock before giving up (a Postgres
    # interval such as "10s"; "0" waits forever). Migrations are DDL, so nearly
    # every statement wants ACCESS EXCLUSIVE, and a request for one queues
    # behind whatever transaction currently holds the table — and every reader
    # arriving after it queues behind the request. A migration that waits out a
    # long-running transaction therefore does not merely take longer; it stops
    # the deployment still serving traffic beside it for as long as it waits.
    # Failing instead turns that into an upgrade that did not happen, on a
    # deployment that is still up on the old schema, which is the better of the
    # two outcomes and the one worth retrying. Applies to the migration
    # connection only: the application engine's statements take ordinary row
    # and table locks that no amount of waiting escalates into this.
    db_migration_lock_timeout: str = "10s"

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
        # Checked whether or not telemetry is on, unlike the endpoint and the
        # timeout below: 0 is a plausible reading of "disable the snapshot" and
        # would instead mean "never not due", running the whole fan-out every
        # poll. A setting whose wrong value is a busy loop is worth refusing
        # even on a deployment that is not using it yet.
        if self.telemetry_snapshot_interval_hours <= 0:
            raise ValueError(
                "TELEMETRY_SNAPSHOT_INTERVAL_HOURS must be positive, got "
                f"{self.telemetry_snapshot_interval_hours!r}. Set "
                "TELEMETRY_ENABLED=false to switch reporting off."
            )
        if self.telemetry_enabled:
            # Checked only when telemetry is on: a deployment that never
            # reports should not be refused boot over the shape of a setting
            # it does not use.
            # The same checks `_validate_observability` applies to
            # OTLP_ENDPOINT, and for the same reasons: both are base URLs with
            # the signal path appended, and the relay answers a misdirected
            # post with a 404 that is logged once per event and read by nobody.
            if self.telemetry_endpoint != self.telemetry_endpoint.strip():
                raise ValueError(
                    "TELEMETRY_ENDPOINT has leading or trailing whitespace: "
                    f"{self.telemetry_endpoint!r}."
                )
            endpoint = urlsplit(self.telemetry_endpoint)
            if endpoint.scheme not in ("http", "https"):
                raise ValueError(
                    "TELEMETRY_ENDPOINT must be an http(s) URL, got "
                    f"{self.telemetry_endpoint!r}."
                )
            if not endpoint.netloc:
                raise ValueError(
                    "TELEMETRY_ENDPOINT must include a host, got "
                    f"{self.telemetry_endpoint!r}."
                )
            if endpoint.path.strip("/"):
                # `/v1/logs` is appended, so a value already carrying it posts
                # to `/v1/logs/v1/logs`. The full logs URL is the form most
                # people have seen written down, which makes pasting it here
                # the obvious mistake rather than an unlikely one.
                raise ValueError(
                    "TELEMETRY_ENDPOINT is the relay's base URL and the signal "
                    "path is appended to it, so it must have no path of its "
                    f"own. Got {self.telemetry_endpoint!r} — drop the "
                    f"{endpoint.path!r}."
                )
            if endpoint.query or endpoint.fragment:
                raise ValueError(
                    "TELEMETRY_ENDPOINT must be a bare base URL: a query or "
                    "fragment is dropped when the signal path is appended, so "
                    "it would silently never be sent. Got "
                    f"{self.telemetry_endpoint!r}."
                )
            if self.telemetry_timeout_seconds <= 0:
                raise ValueError(
                    "TELEMETRY_TIMEOUT_SECONDS must be positive, got "
                    f"{self.telemetry_timeout_seconds!r}."
                )

        if self.template_max_bytes < 1:
            raise ValueError(
                f"TEMPLATE_MAX_BYTES must be at least 1, got {self.template_max_bytes}."
            )
        return self

    @model_validator(mode="after")
    def _validate_deployment_id(self) -> "SwitchConfig":
        """The id's shape, checked wherever it is set.

        Separate from `_validate_observability` because both streams now use
        this value: product telemetry prefers it over the id generated into the
        database, so a malformed one reaches the relay on a deployment that has
        named no collector at all and would never run that validator. The relay
        requires a canonical UUID and drops what arrives without one — with a
        200, in silence — so the wrong shape here is not a degraded send, it is
        no send at all.
        """
        if self.deployment_id is None:
            return self
        try:
            uuid.UUID(self.deployment_id)
        except ValueError as error:
            raise ValueError(
                f"DEPLOYMENT_ID must be a UUID, got {self.deployment_id!r}. "
                "The relay's guard rejects anything else, silently."
            ) from error
        return self

    @model_validator(mode="after")
    def _validate_observability(self) -> "SwitchConfig":
        if self.otlp_endpoint is None:
            return self

        if self.otlp_endpoint != self.otlp_endpoint.strip():
            # A trailing space lands inside the host, not the path, so it
            # passes every check below and then resolves nowhere.
            raise ValueError(
                "OTLP_ENDPOINT has leading or trailing whitespace: "
                f"{self.otlp_endpoint!r}."
            )

        parts = urlsplit(self.otlp_endpoint)
        if parts.scheme not in ("http", "https"):
            raise ValueError(
                f"OTLP_ENDPOINT must be an http(s) URL, got {self.otlp_endpoint!r}."
            )
        if not parts.netloc:
            raise ValueError(
                f"OTLP_ENDPOINT must include a host, got {self.otlp_endpoint!r}."
            )
        if parts.path.strip("/"):
            # The signal path is appended, so a full URL becomes
            # `/v1/logs/v1/metrics`. Pasting one is the obvious mistake.
            raise ValueError(
                "OTLP_ENDPOINT is the collector's base URL and the signal path "
                "is appended to it, so it must have no path of its own. Got "
                f"{self.otlp_endpoint!r} — drop the {parts.path!r}."
            )
        if parts.query or parts.fragment:
            # Resolving the signal path against the base discards both, so a
            # credential written here would silently never be sent.
            raise ValueError(
                "OTLP_ENDPOINT must not carry a query string or fragment — the "
                "signal path is resolved against it and both are discarded, so "
                f"they would silently never be sent. Got {self.otlp_endpoint!r}. "
                "Put a credential in OTLP_HEADERS instead."
            )

        if not self.deployment_id:
            raise ValueError(
                "DEPLOYMENT_ID must be set when OTLP_ENDPOINT is: the collector "
                "drops payloads that do not identify the deployment, and it "
                "does so silently, so without one this server would report "
                "nothing while looking correctly configured."
            )
        for name, value in (
            ("OTLP_TIMEOUT_SECONDS", self.otlp_timeout_seconds),
            ("OTLP_EXPORT_INTERVAL_SECONDS", self.otlp_export_interval_seconds),
        ):
            if value <= 0:
                raise ValueError(f"{name} must be greater than 0, got {value!r}.")

        # So a malformed header is a startup error, not one per interval.
        self._parse_otlp_headers()
        return self

    def _parse_otlp_headers(self) -> dict[str, str]:
        if not self.otlp_headers:
            return {}
        headers: dict[str, str] = {}
        for pair in self.otlp_headers.split(","):
            if not pair.strip():
                continue
            key, separator, value = pair.partition("=")
            if not separator or not key.strip():
                raise ValueError(
                    "OTLP_HEADERS must be comma-separated key=value pairs, got "
                    f"{pair!r}."
                )
            headers[key.strip()] = value.strip()
        return headers

    @property
    def otlp_header_map(self) -> dict[str, str]:
        return self._parse_otlp_headers()

    @property
    def observability_enabled(self) -> bool:
        return self.otlp_endpoint is not None

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
    def _validate_migration_lock_timeout(self) -> "SwitchConfig":
        if not _PG_INTERVAL_RE.match(self.db_migration_lock_timeout):
            raise ValueError(
                "DB_MIGRATION_LOCK_TIMEOUT must be a Postgres interval such "
                "as '10s', '500ms' or a bare count of milliseconds ('0' waits "
                f"forever), got {self.db_migration_lock_timeout!r}."
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
    def _validate_messaging_public_url(self) -> "SwitchConfig":
        # Slack compares the redirect URI it is sent against the one registered
        # with the app, byte for byte, and reports a mismatch as a generic
        # refusal. A path here would make every install URL wrong in a way the
        # error message does not name, so it is a startup error instead.
        if self.messaging_public_url:
            parts = urlsplit(self.messaging_public_url)
            if not parts.scheme or not parts.netloc or parts.path not in ("", "/"):
                raise ValueError(
                    "MESSAGING_PUBLIC_URL must be a scheme + host only "
                    "(e.g. https://switch.example), with no path, "
                    f"got {self.messaging_public_url!r}."
                )
            if parts.scheme != "https":
                raise ValueError(
                    "MESSAGING_PUBLIC_URL must be https. Slack refuses to "
                    "register an http redirect or event URL, so an http origin "
                    f"cannot work, got {self.messaging_public_url!r}."
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

    @model_validator(mode="after")
    def _validate_slack_app(self) -> "SwitchConfig":
        required = (
            self.slack_app_client_id,
            self.slack_app_client_secret,
            self.slack_app_signing_secret,
        )
        set_count = sum(1 for value in required if value)
        if 0 < set_count < len(required):
            raise ValueError(
                "Partial distributed Slack app config: set all of "
                "SLACK_APP_CLIENT_ID / SLACK_APP_CLIENT_SECRET / "
                "SLACK_APP_SIGNING_SECRET, or none of them."
            )
        # The redirect URI and the events URL are both built from the public
        # origin, and Slack checks the redirect matches the one registered with
        # the app. Without the origin they would be built against nothing, so a
        # deployment configured to offer installs and unable to name itself is
        # a startup error rather than a broken button.
        if set_count and not self.messaging_public_url:
            raise ValueError(
                "A distributed Slack app is configured but MESSAGING_PUBLIC_URL "
                "is not. The install redirect and the events endpoint are built "
                "from it, and Slack rejects a redirect that does not match the "
                "one registered with the app."
            )
        return self

    @model_validator(mode="after")
    def _validate_discord_app(self) -> "SwitchConfig":
        required = (
            self.discord_app_client_id,
            self.discord_app_client_secret,
            self.discord_app_bot_token,
            self.discord_app_application_id,
        )
        set_count = sum(1 for value in required if value)
        if 0 < set_count < len(required):
            raise ValueError(
                "Partial distributed Discord app config: set all of "
                "DISCORD_APP_CLIENT_ID / DISCORD_APP_CLIENT_SECRET / "
                "DISCORD_APP_BOT_TOKEN / DISCORD_APP_APPLICATION_ID, or none "
                "of them."
            )
        # The OAuth redirect is built from the public origin, and Discord checks
        # it matches the one registered with the app byte for byte. Without the
        # origin a deployment offering the install button would build the
        # redirect against nothing, so it is a startup error rather than an
        # install that fails at Discord with nothing in our logs.
        if set_count and not self.messaging_public_url:
            raise ValueError(
                "A distributed Discord app is configured but MESSAGING_PUBLIC_URL "
                "is not. The install redirect is built from it, and Discord "
                "rejects a redirect that does not match the one registered with "
                "the app."
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
