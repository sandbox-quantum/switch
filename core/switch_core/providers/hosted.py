import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    field_validator,
    model_validator,
)

logger = logging.getLogger(__name__)

# What a caller this server doesn't offer cloud machines to is told: the same
# words for a workspace or an account off its list, so no answer says which.
NOT_AVAILABLE = "This server does not support cloud agents."

# The longest an operator-bearer overlap may be set ahead: a rotation's previous bearer, or the move-over's
# acceptance of the controller bearer on the operator routes. One forgotten
# overlap closes itself within a day at most.
OPERATOR_OVERLAP_MAX = timedelta(hours=24)

OPEN_TO_ALL_WARNING = (
    "Cloud machines are open to every workspace and account: neither "
    "allowed_tenant_ids nor allowed_user_ids is set in the hosted controller "
    "config."
)


class HostedControllerSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The workspaces whose members may use cloud machines; null for every one.
    allowed_tenant_ids: list[Annotated[str, Field(min_length=1)]] | None
    # Within those workspaces, the accounts (user ids) that may; null (or left
    # out) for every account, as before this setting existed.
    allowed_user_ids: list[Annotated[str, Field(min_length=1)]] | None = None
    # The workspaces that may use agent management at all (/v1/management,
    # /v1/controllers and /gateway/management); null (or left out) for every
    # one, as today. Separate from the cloud-machine lists: setting it shuts
    # every other workspace's own computers out too.
    management_tenant_ids: list[Annotated[str, Field(min_length=1)]] | None = None
    token: SecretStr = Field(min_length=32)
    # The box provisioner's own credential, a separate identity from the
    # controller's `token` (one of three identities). Accepted only on the
    # provisioner's two routes; unset, no provisioner can claim anything.
    provisioner_token: SecretStr | None = Field(default=None, min_length=32)
    # The operator API's own credential: the
    # in-cluster restart and drain workers list operator actions and report
    # their steps with it, and nothing else accepts it. Unset, those two
    # routes refuse every call.
    operator_token: SecretStr | None = Field(default=None, min_length=32)
    # A rotation's overlap: the old operator bearer, accepted on the same two
    # routes only until `operator_token_previous_until` (UTC), then refused
    # whether or not it's still here. Both or neither.
    operator_token_previous: SecretStr | None = Field(default=None, min_length=32)
    operator_token_previous_until: datetime | None = None
    # The move-over from the controller bearer: until this time (UTC) the two
    # operator routes also take the controller's `token`. Only with
    # `operator_token` set.
    operator_routes_accept_controller_until: datetime | None = None
    agent_api_endpoint: str

    @model_validator(mode="after")
    def separate_identities(self) -> "HostedControllerSettings":
        if (
            self.provisioner_token is not None
            and self.provisioner_token.get_secret_value()
            == self.token.get_secret_value()
        ):
            raise ValueError(
                "provisioner_token must differ from token: the provisioner and "
                "the controller are separate identities"
            )
        named = [
            (name, value.get_secret_value())
            for name, value in (
                ("token", self.token),
                ("provisioner_token", self.provisioner_token),
                ("operator_token", self.operator_token),
                ("operator_token_previous", self.operator_token_previous),
            )
            if value is not None
        ]
        for i, (first, a) in enumerate(named):
            for second, b in named[i + 1 :]:
                if a == b:
                    raise ValueError(
                        f"{second} must differ from {first}: each bearer is a "
                        "separate identity"
                    )
        return self

    @model_validator(mode="after")
    def bounded_operator_overlaps(self) -> "HostedControllerSettings":
        if (self.operator_token_previous is None) != (
            self.operator_token_previous_until is None
        ):
            raise ValueError(
                "operator_token_previous and operator_token_previous_until are "
                "set together or not at all"
            )
        if (
            self.operator_routes_accept_controller_until is not None
            and self.operator_token is None
        ):
            raise ValueError(
                "operator_routes_accept_controller_until needs operator_token"
            )
        if self.operator_token_previous is not None and self.operator_token is None:
            raise ValueError("operator_token_previous needs operator_token")
        latest = datetime.now(UTC) + OPERATOR_OVERLAP_MAX
        for name in (
            "operator_token_previous_until",
            "operator_routes_accept_controller_until",
        ):
            until = getattr(self, name)
            if until is None:
                continue
            if until.tzinfo is None:
                raise ValueError(f"{name} must carry a UTC offset")
            if until > latest:
                raise ValueError(f"{name} may be at most 24 hours ahead")
        return self

    @field_validator("agent_api_endpoint")
    @classmethod
    def https_endpoint(cls, value: str) -> str:
        url = urlsplit(value)
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ValueError("Cloud agents require an HTTPS agent API endpoint.")
        return value.rstrip("/")


def open_to_all(settings: HostedControllerSettings | None, capacity: int) -> bool:
    """Whether this server lets anyone at all claim a cloud machine: it can
    run them, and neither list narrows who may. Not wrong in itself (it is
    the default), but worth saying out loud."""
    return (
        settings is not None
        and capacity > 0
        and settings.allowed_tenant_ids is None
        and settings.allowed_user_ids is None
    )


def warn_if_open_to_all(
    settings: HostedControllerSettings | None, capacity: int
) -> bool:
    """Logs one WARN at start when `open_to_all`; returns whether it did."""
    if not open_to_all(settings, capacity):
        return False
    logger.warning(OPEN_TO_ALL_WARNING)
    return True


def load_hosted_settings(path: str | None) -> HostedControllerSettings | None:
    """The hosted controller config at `HOSTED_CONTROLLER_CONFIG_PATH`, or None
    when the server has none."""
    if not path:
        return None
    settings = HostedControllerSettings.model_validate_json(Path(path).read_text())
    holds = [
        name
        for name in ("provisioner_token", "operator_token", "operator_token_previous")
        if getattr(settings, name) is not None
    ]
    if holds and Path(path).stat().st_mode & 0o077:
        # Box provisioning and the operator bearer: a file holding the
        # provisioner's or the operator's bearer is Core's alone. Only checked
        # when it holds one, so an existing config isn't refused for a
        # credential it doesn't carry.
        raise ValueError(
            "HOSTED_CONTROLLER_CONFIG_PATH holds the provisioner's or the operator's "
            "credential, so it must be readable by Core's user only (0400 or 0600)."
        )
    return settings


def log_operator_overlaps(
    settings: HostedControllerSettings | None, now: datetime | None = None
) -> list[str]:
    """At start: one INFO per open operator-bearer overlap, with its end, and
    one WARN per lapsed one still in the config, so platform tidies it. Never
    a bearer. Returns the overlap names it logged, for tests."""
    if settings is None:
        return []
    moment = now or datetime.now(UTC)
    logged = []
    for name, until in (
        ("operator_token_previous_until", settings.operator_token_previous_until),
        (
            "operator_routes_accept_controller_until",
            settings.operator_routes_accept_controller_until,
        ),
    ):
        if until is None:
            continue
        if until > moment:
            logger.info(
                "Operator bearer overlap open until %s (%s)", until.isoformat(), name
            )
        else:
            logger.warning(
                "Operator bearer overlap lapsed at %s and is refused; remove %s "
                "from the hosted controller config",
                until.isoformat(),
                name,
            )
        logged.append(name)
    return logged


def tenant_allowed(tenant_ids: list[str] | None, tenant_id: str) -> bool:
    """The one workspace rule, for every list of workspaces in this file: a
    workspace is allowed when the list is unset (as today) or names it."""
    return tenant_ids is None or tenant_id in tenant_ids
