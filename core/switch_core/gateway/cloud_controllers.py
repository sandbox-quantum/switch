"""What Core needs from agent management for the cloud machines that run
the shared agent controller. Management installs it at startup."""

from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import AgentController, HostedMachine


class CloudControllersUnavailable(RuntimeError):
    """Agent management is not enabled, so no cloud machine can run the agent controller."""


class CloudControllers(Protocol):
    """What preparing a machine on the controller runtime, and telling its
    controller a login sealed for it changed, need from agent management,
    which owns controllers, their credentials and their streams. Management
    installs it (`set_cloud_controllers`); Core never imports management."""

    async def cloud_controller(
        self, session: AsyncSession, machine: HostedMachine
    ) -> tuple[AgentController, bool]: ...

    async def cloud_credential(
        self,
        session: AsyncSession,
        machine: HostedMachine,
        controller: AgentController,
        stored: str | None,
    ) -> tuple[str, bool]: ...

    def credential_replaced(self, controller_id: str) -> None: ...

    def provider_credential_changed(
        self, controller_id: str, provider: str, revision: int
    ) -> None: ...

    def pending_control_relays(self, controller_id: str) -> int: ...


_cloud_controllers: CloudControllers | None = None


def set_cloud_controllers(provider: CloudControllers | None) -> None:
    global _cloud_controllers
    _cloud_controllers = provider


def cloud_controllers() -> CloudControllers:
    if _cloud_controllers is None:
        raise CloudControllersUnavailable(
            "A cloud machine runs the agent controller, and agent management "
            "is not enabled to provide it (AGENT_MANAGEMENT_ENABLED)."
        )
    return _cloud_controllers
