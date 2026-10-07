"""What the cloud machine routes share: the controller settings and their refusals."""

from typing import cast

from fastapi import HTTPException, Request

from switch_core.config import SwitchConfig
from switch_core.db.models import HostedMachine, require_tenant_id
from switch_core.providers.hosted import HostedControllerSettings

MACHINE_ERROR = "The cloud machine needs attention. Retry it in Switch Console."
MACHINE_ERROR_NEEDS_ADMIN = (
    "The cloud machine needs attention. Contact your server administrator."
)
LAUNCH_DISABLED = "Cloud agent launch is not enabled on this server."


def machine_error_detail(machine: HostedMachine) -> str:
    """Why an errored machine refuses work, and whether retrying it can help."""
    if machine.error_code == "machine_needs_attention":
        return MACHINE_ERROR_NEEDS_ADMIN
    return MACHINE_ERROR


def hosted_settings(request: Request) -> HostedControllerSettings | None:
    return cast(
        HostedControllerSettings | None, request.app.state.hosted_controller_settings
    )


def controller_settings(request: Request) -> HostedControllerSettings:
    settings = hosted_settings(request)
    if settings is None:
        raise HTTPException(503, LAUNCH_DISABLED)
    return settings


def launch_enabled(config: SwitchConfig, settings: HostedControllerSettings) -> bool:
    """Whether the bound tenant may claim cloud machines on this server."""
    return (
        config.hosted_launch_capacity > 0 and settings.tenant_id == require_tenant_id()
    )
