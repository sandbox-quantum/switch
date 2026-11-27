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
    ValidationInfo,
    field_validator,
    model_validator,
)

from switch_core.secret_files import mounted_for_cores_group

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
    "allowed_tenant_ids nor allowed_user_ids narrows who may use them in the "
    "hosted controller config."
)
# With hosted agents v2 on, an unset cloud-machine list admits nobody: said
# once at start, so a server that turned v2 on knows why nobody can claim.
CLOSED_BY_DEFAULT_WARNING = (
    "Hosted agents v2 is on and {lists} unset in the hosted controller config, "
    "so nobody can use cloud machines. Name the workspaces and accounts, or "
    'set "*" to open them to everyone.'
)

# The explicit "everyone" for a cloud-machine list (`allowed_tenant_ids`,
# `allowed_user_ids`), alone in it: `"*"` or `["*"]`.
EVERYONE = "*"


class HostedControllerSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The workspaces whose members may use cloud machines, or "*" for every
    # one. Null means every one with hosted agents v2 off (as before v2) and
    # none with it on: v2 is closed until a server says who
    # (`machines_tenant_allowed`).
    allowed_tenant_ids: list[Annotated[str, Field(min_length=1)]] | None
    # Within those workspaces, the accounts (user ids) that may, or "*" for
    # every account; null (or left out) as for the workspaces.
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
    # The warm pool's reaper (hosted agents v2): its own bearer, accepted only
    # on the two reaper routes (`/hosted-provisioner/pool/retiring` and
    # `…/pool/{id}/gone`). Unset, those routes refuse every call.
    reaper_token: SecretStr | None = Field(default=None, min_length=32)
    # Box removal's remover (hosted agents v2): its own bearer, separate from
    # the reaper's, accepted only on the remover's two routes
    # (`/hosted-provisioner/removals/{id}` and `…/removals/listed`). Unset,
    # those routes refuse every call.
    remover_token: SecretStr | None = Field(default=None, min_length=32)
    # The move-over from the controller bearer: until this time (UTC) the two
    # operator routes also take the controller's `token`. Only with
    # `operator_token` set.
    operator_routes_accept_controller_until: datetime | None = None
    agent_api_endpoint: str

    @field_validator("allowed_tenant_ids", "allowed_user_ids", mode="before")
    @classmethod
    def everyone_alone(cls, value: object, info: ValidationInfo) -> object:
        """With hosted agents v2 on, `"*"` is the explicit everyone, as itself
        or alone in the list; beside names it would hide a mistake, so it's
        refused. With v2 off the lists load exactly as before v2. The mode is
        the loader's (`load_hosted_settings(v2=hosted_v2_on(config))`), never
        the process flag, which isn't set yet when the settings load; with no
        mode given, off."""
        context = info.context if isinstance(info.context, dict) else {}
        if context.get("v2") is not True:
            return value
        if value == EVERYONE:
            return [EVERYONE]
        if isinstance(value, list) and EVERYONE in value and len(value) > 1:
            raise ValueError('"*" means everyone, so it must stand alone')
        return value

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
                ("reaper_token", self.reaper_token),
                ("remover_token", self.remover_token),
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


def _v2(v2: bool | None) -> bool:
    if v2 is not None:
        return v2
    from switch_core.hosted_v2 import process_hosted_v2

    return process_hosted_v2()


def v2_of(config: object) -> bool:
    """The mode for the lists, from the caller's config where it has one:
    on when the config says so (`hosted_v2_on`), so a process that never
    recorded its mode still reads v2's closed rule, else this process's."""
    from switch_core.hosted_v2 import hosted_v2_on, process_hosted_v2

    return hosted_v2_on(config) or process_hosted_v2()


def _admits(ids: list[str] | None, member: str, v2: bool) -> bool:
    """The cloud-machine list rule. With hosted agents v2 off, exactly as
    before v2: unset admits everyone and a list whom it names (`"*"` is just
    a name). With v2 on, unset admits nobody, `"*"` everyone, and a list whom
    it names."""
    if not v2:
        return ids is None or member in ids
    if ids is None:
        return False
    return EVERYONE in ids or member in ids


def machines_tenant_allowed(
    settings: HostedControllerSettings, tenant_id: str, *, v2: bool | None = None
) -> bool:
    """Whether `allowed_tenant_ids` admits the workspace to cloud machines.
    `v2` defaults to this process's answer (`process_hosted_v2`)."""
    return _admits(settings.allowed_tenant_ids, tenant_id, _v2(v2))


def machines_user_allowed(
    settings: HostedControllerSettings, user_id: str, *, v2: bool | None = None
) -> bool:
    """Whether `allowed_user_ids` admits the account to cloud machines."""
    return _admits(settings.allowed_user_ids, user_id, _v2(v2))


def _everyone(ids: list[str] | None, v2: bool) -> bool:
    return ids == [EVERYONE] if v2 else ids is None


def open_to_all(
    settings: HostedControllerSettings | None,
    capacity: int,
    *,
    v2: bool | None = None,
) -> bool:
    """Whether this server lets anyone at all claim a cloud machine: it can
    run them, and neither list narrows who may: both `"*"`, or, with hosted
    agents v2 off, both unset (the v1 default). Not wrong in itself, but worth
    saying out loud."""
    on = _v2(v2)
    return (
        settings is not None
        and capacity > 0
        and _everyone(settings.allowed_tenant_ids, on)
        and _everyone(settings.allowed_user_ids, on)
    )


def warn_if_open_to_all(
    settings: HostedControllerSettings | None,
    capacity: int,
    *,
    v2: bool | None = None,
) -> bool:
    """Logs one WARN at start when `open_to_all`, and, with hosted agents v2
    on, one when an unset list shuts everyone out; returns whether it warned
    that it's open to all."""
    on = _v2(v2)
    if settings is not None and capacity > 0 and on:
        unset = [
            name
            for name in ("allowed_tenant_ids", "allowed_user_ids")
            if getattr(settings, name) is None
        ]
        if unset:
            logger.warning(
                CLOSED_BY_DEFAULT_WARNING.format(
                    lists=" and ".join(unset) + (" are" if len(unset) > 1 else " is")
                )
            )
    if not open_to_all(settings, capacity, v2=on):
        return False
    logger.warning(OPEN_TO_ALL_WARNING)
    return True


PER_WORKSPACE_UNSET_WARNING = (
    "Hosted agents v2 is on and HOSTED_LAUNCH_CAPACITY_PER_WORKSPACE is 0, so "
    "one workspace may take every cloud machine on this server. Set it before "
    "v2 serves more than one workspace."
)


def warn_if_no_per_workspace_limit(
    capacity: int, per_workspace: int, *, v2: bool
) -> bool:
    """Logs one WARN at start when hosted agents v2 can run machines with no
    per-workspace limit; returns whether it did."""
    if not v2 or capacity <= 0 or per_workspace > 0:
        return False
    logger.warning(PER_WORKSPACE_UNSET_WARNING)
    return True


def load_hosted_settings(
    path: str | None, *, v2: bool | None = None
) -> HostedControllerSettings | None:
    """The hosted controller config at `HOSTED_CONTROLLER_CONFIG_PATH`, or None
    when the server has none. `v2` is the server's mode
    (`hosted_v2_on(config)`), for the lists' `"*"`: it's read before this
    process records its mode, so callers pass it; unset, this process's."""
    if not path:
        return None
    settings = HostedControllerSettings.model_validate_json(
        Path(path).read_text(), context={"v2": _v2(v2)}
    )
    holds = [
        name
        for name in (
            "provisioner_token",
            "operator_token",
            "operator_token_previous",
            "reaper_token",
            "remover_token",
        )
        if getattr(settings, name) is not None
    ]
    if (
        holds
        and (st := Path(path).stat()).st_mode & 0o077
        and not mounted_for_cores_group(st)
    ):
        # Box provisioning and the operator bearer: a file holding the
        # provisioner's or the operator's bearer is Core's alone. Only checked
        # when it holds one, so an existing config isn't refused for a
        # credential it doesn't carry.
        raise ValueError(
            "HOSTED_CONTROLLER_CONFIG_PATH holds the provisioner's or the operator's "
            "credential, so it must be readable by Core's user only (0400 or 0600, "
            "or a mounted Secret readable by Core's group alone)."
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
