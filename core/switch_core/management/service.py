"""What the management routes do, behind both doors.

The controller routes (bearer, on the agent bridge) and the owner's routes
(cookie, on the gateway) are thin: they authenticate, parse, and call in
here. Every method that changes something commits and only then nudges the
controllers it affected, so a controller woken by a nudge always finds the
change already visible.

Every change that affects what a controller should run bumps that
controller's `assignment_revision`; every change to one agent's definition,
desired state or placement bumps the definition's own `revision`. A move
bumps both controllers.

Placement is also told to Core, after the commit: which controller runs each
agent is Core's `ControllerPresence`, which lets that controller act as the
agent and carries the agent's events on that controller's stream alone. A move
rebinds the agent, which is what fences the old controller out.
"""

from __future__ import annotations

import logging
import ntpath
import posixpath
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.agent_icon import (
    InvalidIconUrl,
    generated_icon_url,
    normalise_icon_url,
)
from switch_core.bridges.agent.auth import ControllerPrincipal
from switch_core.bridges.agent.protocol.agent_core import AgentCore, AgentExistsError
from switch_core.bridges.agent.protocol.control_relay import ControlRelays
from switch_core.bridges.agent.protocol.controller_presence import (
    DETACH_DELETED,
    DETACH_UNASSIGNED,
    Binding,
    ControllerPresence,
)
from switch_core.db.models import (
    CONTROLLER_ENROLLMENT_KEY_TYPE,
    CONTROLLER_KEY_TYPE,
    CONTROLLER_REVOKED_KEY_TYPE,
    Agent,
    AgentController,
    AgentControllerOperation,
    ApiKey,
    HostedMachine,
)
from switch_core.db.models import AgentDefinition as AgentDefinitionRow
from switch_core.db.stores.agent_controller_operation_store import (
    AgentControllerOperationStore,
)
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.hosted_machine_store import (
    HostedMachineStore,
    accepts_controller_exchange,
)
from switch_core.gateway.cloud_workspace import worktree_path
from switch_core.gateway.hosted_controller_activity import (
    record_controller_heartbeat,
    wake_controller_machine,
    wake_for_placement,
)
from switch_core.gateway.known_agents import KNOWN_AGENTS, KnownAgent
from switch_core.management import reason_codes, tokens
from switch_core.management.errors import ManagementError, not_found
from switch_core.management.notifier import ControllerNotifier
from switch_core.management.placement import (
    ControllerState,
    controller_state,
    placement_refusal,
)
from switch_core.management.schemas import (
    PROVIDER_KNOWN_AGENT_TYPES,
    ConnectionGrant,
    ControllerDescription,
    CreateManagedAgentRequest,
    DefinitionV1,
    PublicKey,
    StatusReport,
    assignment_entry,
    controller_view,
    managed_agent_view,
    operation_view,
    operation_wire,
    workspaces_dir_of,
)
from switch_core.providers.sealing import reusable_cloud_controller

logger = logging.getLogger(__name__)

OPERATION_LEASE = timedelta(minutes=5)
# An operation still open this long after it was created is expired rather
# than offered again: nothing is left pending for ever.
OPERATION_TTL = timedelta(hours=1)
OPERATION_LIST_LIMIT = 200

V1_OPERATION_KINDS = frozenset({"agent.restart", "provider.recheck"})

# Checks that the owner can grant these connections to an agent; raises a
# `ManagementError` when they cannot.
CheckConnections = Callable[[list[ConnectionGrant]], Awaitable[None]]

CLOUD_CONTROLLER_KIND = "ec2"
CLOUD_CONTROLLER_NAME = "Switch cloud"
CLOUD_CONTROLLER_VERSION = "pending"
CLOUD_CONTROLLER_PLATFORM = {"os": "linux", "arch": "unknown", "os_version": "unknown"}


@dataclass(frozen=True)
class ManagementSettings:
    token_secret: str
    status_interval_seconds: int
    # The public origin of the agent bridge, which a controller enrolls
    # against (`GATEWAY_PUBLIC_URL`). None when the deployment has not said,
    # and then nothing can tell an owner what `--server` to enroll with.
    server_url: str | None


@dataclass(frozen=True)
class _Placement:
    controller_id: str | None
    desired_state: str
    definition: dict[str, Any]


class ManagementService:
    def __init__(
        self,
        *,
        settings: ManagementSettings,
        notifier: ControllerNotifier,
        controllers: AgentControllerStore,
        definitions: AgentDefinitionStore,
        operations: AgentControllerOperationStore,
        api_keys: ApiKeyStore,
        agents: AgentStore,
        presence: ControllerPresence,
        control_relays: ControlRelays,
        clock: Callable[[], datetime],
    ) -> None:
        self.settings = settings
        self.control_relays = control_relays
        self.notifier = notifier
        self.presence = presence
        self.controllers = controllers
        self.definitions = definitions
        self.operations = operations
        self.api_keys = api_keys
        self.agents = agents
        self._clock = clock
        # The latest revision of each (controller, provider) sealed login its
        # controller has been told of, so a reload announces only newer ones.
        self._announced_logins: dict[tuple[str, str], int] = {}

    def now(self) -> datetime:
        return self._clock()

    def state_of(self, controller: AgentController) -> ControllerState:
        return controller_state(
            controller,
            now=self.now(),
            interval_seconds=self.settings.status_interval_seconds,
        )

    # ── Credentials and enrollment ────────────────────────────────────────────

    async def _new_hash_only_key(
        self, session: AsyncSession, *, owner_id: str, key_type: str, label: str
    ) -> tuple[ApiKey, str]:
        secret = (
            tokens.new_credential()
            if key_type == CONTROLLER_KEY_TYPE
            else tokens.new_enrollment_code()
        )
        key = ApiKey(
            user_id=owner_id,
            key_hash=tokens.hash_secret(secret),
            encrypted_key="",
            label=label,
            type=key_type,
        )
        await self.api_keys.create(session, key)
        return key, secret

    async def create_controller(
        self,
        session: AsyncSession,
        *,
        owner_id: str,
        description: ControllerDescription,
        public_key: PublicKey | None,
    ) -> tuple[AgentController, str]:
        """Create a controller and its credential, and commit. Returns both."""
        key, credential = await self._new_hash_only_key(
            session,
            owner_id=owner_id,
            key_type=CONTROLLER_KEY_TYPE,
            label=f"controller {description.name}",
        )
        controller = await self.controllers.create(
            session,
            owner_id=owner_id,
            name=description.name,
            description=description.description,
            kind=description.kind,
            platform=description.platform.model_dump(),
            version=description.version,
            public_key=public_key.model_dump() if public_key is not None else None,
            api_key_id=key.id,
        )
        await session.commit()
        logger.info(
            "Enrolled agent controller %s (%s) for user %s",
            controller.id,
            controller.kind,
            owner_id,
        )
        return controller, credential

    async def issue_enrollment_code(
        self, session: AsyncSession, *, owner_id: str
    ) -> tuple[str, datetime]:
        key, code = await self._new_hash_only_key(
            session,
            owner_id=owner_id,
            key_type=CONTROLLER_ENROLLMENT_KEY_TYPE,
            label="controller enrollment code",
        )
        expires_at = self.now() + tokens.ENROLLMENT_CODE_LIFETIME
        await self.controllers.create_enrollment_code(
            session, owner_id=owner_id, api_key_id=key.id, expires_at=expires_at
        )
        await session.commit()
        return code, expires_at

    async def enroll(
        self,
        session: AsyncSession,
        tenant_id: str,
        *,
        code: str,
        description: ControllerDescription,
        public_key: PublicKey | None,
    ) -> tuple[AgentController, str]:
        """Spend an enrollment code on a new controller. The session must be
        bound to the tenant the code resolved to."""
        invalid = ManagementError(
            401,
            reason_codes.ENROLLMENT_CODE_INVALID,
            "The enrollment code is invalid, already used, or expired.",
        )
        key = await self.api_keys.get_by_hash(session, tokens.hash_secret(code))
        if key is None or key.type != CONTROLLER_ENROLLMENT_KEY_TYPE:
            raise invalid
        consumed = await self.controllers.consume_enrollment_code(
            session, tenant_id, key.id, self.now()
        )
        if consumed is None:
            raise invalid
        controller_key, credential = await self._new_hash_only_key(
            session,
            owner_id=consumed.owner_id,
            key_type=CONTROLLER_KEY_TYPE,
            label=f"controller {description.name}",
        )
        controller = await self.controllers.create(
            session,
            owner_id=consumed.owner_id,
            name=description.name,
            description=description.description,
            kind=description.kind,
            platform=description.platform.model_dump(),
            version=description.version,
            public_key=public_key.model_dump() if public_key is not None else None,
            api_key_id=controller_key.id,
        )
        await self.controllers.complete_enrollment(
            session, tenant_id, consumed.id, controller.id
        )
        await self.api_keys.delete(session, key.id)
        await session.commit()
        logger.info(
            "Enrolled agent controller %s (%s) by code for user %s",
            controller.id,
            controller.kind,
            consumed.owner_id,
        )
        return controller, credential

    async def exchange_token(
        self,
        session: AsyncSession,
        tenant_id: str,
        *,
        controller_id: str,
        credential: str,
        instance_id: str | None,
        boot_id: str | None,
    ) -> tuple[str, datetime]:
        """Exchange a credential for an access token.

        An ec2 controller says which instance and boot it runs on, and only
        the instance Core has seen as its machine's, while that machine is
        starting or running, gets a token: a credential copied off a machine
        is no use anywhere else, and a replaced instance cannot outlive its
        replacement.
        """
        invalid = ManagementError(
            401, reason_codes.INVALID_CREDENTIAL, "The credential is not valid."
        )
        key = await self.api_keys.get_by_hash(session, tokens.hash_secret(credential))
        if key is None or key.type not in (
            CONTROLLER_KEY_TYPE,
            CONTROLLER_REVOKED_KEY_TYPE,
        ):
            raise invalid
        controller = await self.controllers.get_by_api_key(session, tenant_id, key.id)
        if controller is None or controller.id != controller_id:
            raise invalid
        if (
            key.type == CONTROLLER_REVOKED_KEY_TYPE
            or self.state_of(controller) == "revoked"
        ):
            raise ManagementError(
                401, reason_codes.CONTROLLER_REVOKED, "The controller has been revoked."
            )
        if controller.kind == CLOUD_CONTROLLER_KIND:
            await self._check_cloud_instance(session, controller, instance_id, boot_id)
        return tokens.mint_access_token(
            secret=self.settings.token_secret,
            controller_id=controller.id,
            tenant_id=tenant_id,
            owner_id=controller.owner_id,
            credential_id=key.id,
            now=self.now(),
        )

    async def _check_cloud_instance(
        self,
        session: AsyncSession,
        controller: AgentController,
        instance_id: str | None,
        boot_id: str | None,
    ) -> None:
        if not instance_id or not boot_id:
            raise ManagementError(
                401,
                reason_codes.INVALID_CREDENTIAL,
                "An ec2 controller must send X-Switch-Host-Instance-Id and "
                "X-Switch-Host-Boot-Id with its credential.",
            )
        machine = await HostedMachineStore().linking_controller(session, controller.id)
        if machine is None or not accepts_controller_exchange(machine, instance_id):
            logger.warning(
                "Refused a token exchange for ec2 controller %s from instance %s "
                "(boot %s): machine %s is %s/%s on instance %s",
                controller.id,
                instance_id,
                boot_id,
                machine.id if machine is not None else None,
                machine.state if machine is not None else None,
                machine.desired_state if machine is not None else None,
                machine.instance_id if machine is not None else None,
            )
            raise ManagementError(
                409,
                reason_codes.INSTANCE_MISMATCH,
                "This instance is not the one running the controller's cloud "
                "machine, or that machine is not starting or running.",
                retryable=True,
            )

    async def rotate_credential(
        self, session: AsyncSession, principal: ControllerPrincipal
    ) -> str:
        controller = await self._principal_controller(session, principal)
        if await HostedMachineStore().linking_controller(session, controller.id):
            raise ManagementError(
                403,
                reason_codes.FORBIDDEN,
                "A Switch cloud controller's credential is issued with its "
                "machine and cannot be rotated by the controller.",
            )
        credential = await self._replace_credential(session, controller)
        await session.commit()
        self.presence.credential_replaced(controller.id)
        return credential

    async def _replace_credential(
        self, session: AsyncSession, controller: AgentController
    ) -> str:
        """Give the controller a new credential and delete the old one, which
        retires every access token exchanged for it. The caller commits, then
        tells `presence.credential_replaced`."""
        key, credential = await self._new_hash_only_key(
            session,
            owner_id=controller.owner_id,
            key_type=CONTROLLER_KEY_TYPE,
            label=f"controller {controller.name}",
        )
        old_key_id = controller.api_key_id
        await self.controllers.set_credential(
            session, controller.tenant_id, controller.id, key.id
        )
        controller.api_key_id = key.id
        if old_key_id is not None:
            await self.api_keys.delete(session, old_key_id)
        return credential

    # ── Switch cloud controllers ──────────────────────────────────────────────

    async def cloud_controller(
        self, session: AsyncSession, machine: HostedMachine
    ) -> tuple[AgentController, bool]:
        """The ec2 controller a cloud machine runs as, linked to it. Returns it
        and whether it was linked just now.

        The machine's own controller while it is not revoked; otherwise the
        oldest live one any of the owner's machines ever ran as; otherwise a
        new one. Only a controller a machine was linked to counts: an owner
        can enroll a controller that says it is ec2, and that one is never
        taken over. The caller holds the machine's lock and commits.
        """
        if machine.controller_id is not None:
            linked = await self.controllers.get(
                session, machine.tenant_id, machine.controller_id
            )
            if linked is not None and linked.revoked_at is None:
                return linked, False
        reused = await reusable_cloud_controller(session, machine.owner_id)
        if reused is None:
            key, _ = await self._new_hash_only_key(
                session,
                owner_id=machine.owner_id,
                key_type=CONTROLLER_KEY_TYPE,
                label=f"controller {CLOUD_CONTROLLER_NAME}",
            )
            reused = await self.controllers.create(
                session,
                owner_id=machine.owner_id,
                name=CLOUD_CONTROLLER_NAME,
                description=None,
                kind=CLOUD_CONTROLLER_KIND,
                platform=CLOUD_CONTROLLER_PLATFORM,
                version=CLOUD_CONTROLLER_VERSION,
                public_key=None,
                api_key_id=key.id,
            )
            logger.info(
                "Created Switch cloud controller %s for user %s on machine %s",
                reused.id,
                machine.owner_id,
                machine.id,
            )
        machine.controller_id = reused.id
        return reused, True

    def credential_replaced(self, controller_id: str) -> None:
        self.presence.credential_replaced(controller_id)

    def provider_credential_changed(
        self, controller_id: str, provider: str, revision: int
    ) -> None:
        key = (controller_id, provider)
        self._announced_logins[key] = max(
            revision, self._announced_logins.get(key, revision)
        )
        self.notifier.provider_credential_changed(controller_id, provider, revision)

    def announce_login_revisions(self, revisions: dict[tuple[str, str], int]) -> int:
        """Tell each controller of every sealed login revision newer than the
        one it was last told of. Returns how many."""
        announced = 0
        for (controller_id, provider), revision in sorted(revisions.items()):
            if revision > self._announced_logins.get((controller_id, provider), -1):
                self.provider_credential_changed(controller_id, provider, revision)
                announced += 1
        return announced

    def pending_control_relays(self, controller_id: str) -> int:
        return self.control_relays.pending_control_relays(controller_id)

    async def cloud_credential(
        self,
        session: AsyncSession,
        machine: HostedMachine,
        controller: AgentController,
        stored: str | None,
    ) -> tuple[str, bool]:
        """The controller credential for the machine's current revision, and
        whether it was replaced just now.

        `stored` is what the machine kept for this revision. It is returned
        again while it is still the controller's credential; anything else
        mints a new one and deletes the old, so at most one is ever valid.
        """
        if stored is not None and controller.api_key_id is not None:
            key = await self.api_keys.get(session, controller.api_key_id)
            if key is not None and key.key_hash == tokens.hash_secret(stored):
                return stored, False
        return await self._replace_credential(session, controller), True

    async def cloud_controller_for_owner(
        self, session: AsyncSession, tenant_id: str, owner_id: str, controller_id: str
    ) -> AgentController:
        """A Switch cloud controller of the owner's, or 404 for any other."""
        controller = await self.owned_controller(
            session, tenant_id, owner_id, controller_id
        )
        if (
            controller.kind != CLOUD_CONTROLLER_KIND
            or await HostedMachineStore().linking_controller(session, controller.id)
            is None
        ):
            raise not_found("Controller")
        return controller

    # ── The controller's own view ─────────────────────────────────────────────

    async def _principal_controller(
        self, session: AsyncSession, principal: ControllerPrincipal
    ) -> AgentController:
        controller = await self.controllers.get(
            session, principal.tenant_id, principal.controller_id
        )
        if controller is None:
            raise not_found("Controller")
        return controller

    async def assignment(
        self, session: AsyncSession, principal: ControllerPrincipal
    ) -> dict[str, Any]:
        controller = await self._principal_controller(session, principal)
        rows = await self.definitions.list_for_controller(
            session, principal.tenant_id, controller.id
        )
        return {
            "revision": controller.assignment_revision,
            "agents": [assignment_entry(row, agent) for row, agent in rows],
        }

    async def assignment_revision(
        self, session: AsyncSession, principal: ControllerPrincipal
    ) -> int:
        return (
            await self._principal_controller(session, principal)
        ).assignment_revision

    async def record_status(
        self,
        session: AsyncSession,
        principal: ControllerPrincipal,
        report: StatusReport,
    ) -> dict[str, Any]:
        """Store a status report unless a newer one is stored, and tell the
        controller its assignment revision either way."""
        stored = await self.controllers.record_status(
            session,
            principal.tenant_id,
            principal.controller_id,
            seq=report.seq,
            status=report.model_dump(mode="json", exclude_unset=True),
            version=report.controller.version,
            platform=report.machine.platform.model_dump(mode="json"),
            seen_at=self.now(),
        )
        if not stored:
            logger.info(
                "Ignored status seq %s from controller %s: not newer than the stored one",
                report.seq,
                principal.controller_id,
            )
        controller = await self._principal_controller(session, principal)
        revision = controller.assignment_revision
        await session.commit()
        if stored and controller.kind == CLOUD_CONTROLLER_KIND:
            await record_controller_heartbeat(
                session, controller.id, report.model_dump(mode="json"), self.now()
            )
            await session.commit()
        return {
            "assignment_revision": revision,
            "report_within_s": self.settings.status_interval_seconds,
        }

    async def connection_state(
        self, session: AsyncSession, principal: ControllerPrincipal
    ) -> dict[str, Any]:
        return {
            "controller_id": principal.controller_id,
            "assignment_revision": await self.assignment_revision(session, principal),
            "report_within_s": self.settings.status_interval_seconds,
        }

    # ── Operations, controller side ───────────────────────────────────────────

    async def _expire_overdue(
        self, session: AsyncSession, tenant_id: str, controller_id: str
    ) -> None:
        expired = await self.operations.expire_overdue(
            session, tenant_id, controller_id, self.now() - OPERATION_TTL
        )
        if expired:
            logger.warning(
                "Expired %d operation(s) on controller %s left open past %s: %s",
                len(expired),
                controller_id,
                OPERATION_TTL,
                ", ".join(expired),
            )

    async def offered_operations(
        self, session: AsyncSession, principal: ControllerPrincipal
    ) -> list[dict[str, Any]]:
        await self._expire_overdue(
            session, principal.tenant_id, principal.controller_id
        )
        offered = await self.operations.list_offered(
            session, principal.tenant_id, principal.controller_id, self.now()
        )
        await session.commit()
        return [operation_wire(operation) for operation in offered]

    async def _controller_operation(
        self,
        session: AsyncSession,
        principal: ControllerPrincipal,
        operation_id: str,
    ) -> AgentControllerOperation:
        operation = await self.operations.get(
            session, principal.tenant_id, operation_id
        )
        if operation is None or operation.controller_id != principal.controller_id:
            raise not_found("Operation")
        return operation

    def _no_longer_yours(self, operation: AgentControllerOperation) -> ManagementError:
        if operation.state == "cancelled":
            return ManagementError(
                410, reason_codes.CANCELLED, "The operation was cancelled."
            )
        if operation.state == "expired":
            return ManagementError(
                410, reason_codes.LEASE_EXPIRED, "The operation has expired."
            )
        if operation.state == "pending":
            return ManagementError(
                409,
                reason_codes.LEASE_EXPIRED,
                "The operation is not claimed; claim it first.",
            )
        return ManagementError(
            409, reason_codes.ALREADY_CLAIMED, "The operation already has a result."
        )

    async def claim_operation(
        self,
        session: AsyncSession,
        principal: ControllerPrincipal,
        operation_id: str,
    ) -> dict[str, Any]:
        """Claim under a five-minute lease. Claiming again while the lease is
        live returns the same claim: the operation is this controller's alone,
        so a repeat is a retry, not a contest."""
        await self._controller_operation(session, principal, operation_id)
        await self._expire_overdue(
            session, principal.tenant_id, principal.controller_id
        )
        now = self.now()
        claimed = await self.operations.claim(
            session,
            principal.tenant_id,
            operation_id,
            now=now,
            lease_expires_at=now + OPERATION_LEASE,
        )
        if claimed is None:
            current = await self._controller_operation(session, principal, operation_id)
            await session.commit()
            if current.state == "claimed":
                return operation_wire(current)
            raise self._no_longer_yours(current)
        await session.commit()
        return operation_wire(claimed)

    async def renew_operation(
        self,
        session: AsyncSession,
        principal: ControllerPrincipal,
        operation_id: str,
    ) -> None:
        await self._controller_operation(session, principal, operation_id)
        renewed = await self.operations.renew_lease(
            session, principal.tenant_id, operation_id, self.now() + OPERATION_LEASE
        )
        if renewed is None:
            current = await self._controller_operation(session, principal, operation_id)
            raise self._no_longer_yours(current)
        await session.commit()

    async def complete_operation(
        self,
        session: AsyncSession,
        principal: ControllerPrincipal,
        operation_id: str,
        result: dict[str, Any],
    ) -> None:
        """Record the result. A repeat after the first result is accepted and
        changes nothing: the first result stands."""
        await self._controller_operation(session, principal, operation_id)
        state = "succeeded" if result["outcome"] == "succeeded" else "failed"
        completed = await self.operations.complete(
            session, principal.tenant_id, operation_id, state=state, result=result
        )
        if completed is None:
            current = await self._controller_operation(session, principal, operation_id)
            if current.state in ("succeeded", "failed"):
                return
            raise self._no_longer_yours(current)
        await session.commit()

    # ── Controllers, owner side ───────────────────────────────────────────────

    async def owned_controller(
        self, session: AsyncSession, tenant_id: str, owner_id: str, controller_id: str
    ) -> AgentController:
        """The caller's controller, or 404 — also for someone else's, so a
        controller's existence is not disclosed to anyone but its owner."""
        controller = await self.controllers.get(session, tenant_id, controller_id)
        if controller is None or controller.owner_id != owner_id:
            raise not_found("Controller")
        return controller

    async def list_controllers(
        self, session: AsyncSession, tenant_id: str, owner_id: str
    ) -> list[dict[str, Any]]:
        controllers = await self.controllers.list_for_owner(
            session, tenant_id, owner_id
        )
        return [
            controller_view(controller, self.state_of(controller))
            for controller in controllers
        ]

    async def update_controller(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        controller_id: str,
        changes: dict[str, str | None],
    ) -> dict[str, Any]:
        """Rename the caller's controller or change its description.

        A revoked one may still be renamed: its agents stay shown against it
        until they are moved. A new name reaches Core's bindings too, since
        that is the name the room is told when the machine is offline.
        """
        await self.owned_controller(session, tenant_id, owner_id, controller_id)
        controller = await self.controllers.update_details(
            session, tenant_id, controller_id, changes
        )
        view = controller_view(controller, self.state_of(controller))
        await session.commit()
        if "name" in changes:
            self.presence.rename_controller(controller_id, controller.name)
        logger.info(
            "Updated agent controller %s (%s)",
            controller_id,
            ", ".join(sorted(changes)),
        )
        return view

    async def revoke_controller(
        self, session: AsyncSession, tenant_id: str, owner_id: str, controller_id: str
    ) -> None:
        """Revoke: retire the credential, cancel open operations, and nudge.

        The credential's row is kept, retyped so nothing accepts it, so that
        a controller that missed the nudge is told it was revoked when it next
        exchanges the credential, rather than that the credential is unknown.

        Definitions placed on it stay placed, and are shown against a revoked
        controller until their owner moves or removes them.
        """
        controller = await self.owned_controller(
            session, tenant_id, owner_id, controller_id
        )
        if controller.revoked_at is not None:
            return
        key_id = controller.api_key_id
        await self.controllers.mark_revoked(
            session, tenant_id, controller_id, self.now()
        )
        if key_id is not None:
            await self.api_keys.set_type(session, key_id, CONTROLLER_REVOKED_KEY_TYPE)
        await self.operations.cancel_open(
            session, tenant_id, controller_id=controller_id, agent_id=None
        )
        await session.commit()
        logger.info("Revoked agent controller %s", controller_id)
        self.notifier.credential_revoked(controller_id)
        self.presence.revoke_controller(controller_id)

    # ── Managed agents, owner side ────────────────────────────────────────────

    async def _view(
        self,
        session: AsyncSession,
        tenant_id: str,
        row: AgentDefinitionRow,
        agent: Agent,
        controllers: dict[str, AgentController],
    ) -> dict[str, Any]:
        controller = None
        if row.controller_id is not None:
            controller = controllers.get(row.controller_id)
            if controller is None:
                controller = await self.controllers.get(
                    session, tenant_id, row.controller_id
                )
                if controller is not None:
                    controllers[controller.id] = controller
        return managed_agent_view(
            row,
            agent,
            controller,
            self.state_of(controller) if controller is not None else None,
        )

    async def list_managed_agents(
        self, session: AsyncSession, tenant_id: str, owner_id: str
    ) -> list[dict[str, Any]]:
        controllers: dict[str, AgentController] = {}
        return [
            await self._view(session, tenant_id, row, agent, controllers)
            for row, agent in await self.definitions.list_for_owner(
                session, tenant_id, owner_id
            )
        ]

    async def _owned_agent(
        self, session: AsyncSession, owner_id: str, agent_id: str
    ) -> Agent:
        agent = await self.agents.get(session, agent_id)
        if agent is None or agent.owner_id != owner_id:
            raise not_found("Agent")
        return agent

    async def _owned_definition(
        self, session: AsyncSession, tenant_id: str, owner_id: str, agent_id: str
    ) -> tuple[AgentDefinitionRow, Agent]:
        agent = await self._owned_agent(session, owner_id, agent_id)
        row = await self.definitions.get_for_agent(session, tenant_id, agent_id)
        if row is None:
            raise not_found("Managed agent")
        return row, agent

    async def get_managed_agent(
        self, session: AsyncSession, tenant_id: str, owner_id: str, agent_id: str
    ) -> dict[str, Any]:
        row, agent = await self._owned_definition(
            session, tenant_id, owner_id, agent_id
        )
        return await self._view(session, tenant_id, row, agent, {})

    async def _check_target(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        controller_id: str | None,
        provider: str,
        *,
        check_placement: bool,
    ) -> AgentController | None:
        if controller_id is None:
            return None
        controller = await self.owned_controller(
            session, tenant_id, owner_id, controller_id
        )
        if not check_placement:
            return controller
        refusal = placement_refusal(
            controller,
            provider,
            now=self.now(),
            interval_seconds=self.settings.status_interval_seconds,
        )
        if refusal is None:
            return controller
        code, message = refusal
        # A cloud machine asleep reports nothing; its controller takes the
        # agent once the machine this wakes is back.
        if (
            code == reason_codes.CONTROLLER_OFFLINE
            and controller.kind == CLOUD_CONTROLLER_KIND
            and await wake_for_placement(session, controller.id, self.now())
        ):
            logger.info(
                "Placing an agent on controller %s while its cloud machine "
                "sleeps; woke the machine",
                controller.id,
            )
            return controller
        raise ManagementError(409, code, f"Cannot place the agent: {message}.")

    async def _bump_and_collect(
        self, session: AsyncSession, tenant_id: str, controller_ids: set[str | None]
    ) -> dict[str, int]:
        revisions: dict[str, int] = {}
        for controller_id in sorted(c for c in controller_ids if c is not None):
            revisions[controller_id] = await self.controllers.bump_assignment_revision(
                session, tenant_id, controller_id
            )
        return revisions

    def _nudge(self, revisions: dict[str, int]) -> None:
        for controller_id, revision in revisions.items():
            self.notifier.assignment_changed(controller_id, revision)

    async def _bind(
        self, session: AsyncSession, tenant_id: str, row: AgentDefinitionRow
    ) -> None:
        """Tell Core where the agent runs now, after the change has committed."""
        if row.controller_id is None:
            self.presence.unbind(row.agent_id, DETACH_UNASSIGNED)
            return
        controller = await self.controllers.get(session, tenant_id, row.controller_id)
        if controller is None:
            raise RuntimeError(
                f"agent {row.agent_id} is placed on controller {row.controller_id}, "
                "which does not exist"
            )
        self.presence.bind(binding_of(tenant_id, row, controller))

    async def create_managed_agent(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        request: CreateManagedAgentRequest,
        protocol: AgentCore,
        check_connections: CheckConnections,
    ) -> dict[str, Any]:
        """Register a new agent through the known-agent spec for its provider,
        and place it. Placement is checked before anything is registered, so a
        refusal leaves nothing behind; a failure after registering deletes the
        registered agent again. `check_connections` checks that the owner can
        grant the definition's connections."""
        controller = await self._check_target(
            session,
            tenant_id,
            owner_id,
            request.controller_id,
            request.definition.provider,
            check_placement=True,
        )
        refuse_connections_off_cloud(request.definition, controller)
        if request.definition.connections:
            await check_connections(request.definition.connections)
        agent_id: str | None = None
        if controller is not None and controller.kind == CLOUD_CONTROLLER_KIND:
            # Its worktree there is named by its id, so the id comes first.
            agent_id = str(uuid4())
            definition = cloud_definition(request.definition, agent_id)
        else:
            definition = with_directory(request.definition, controller, request.name)
        try:
            icon_url = normalise_icon_url(request.icon_url) or generated_icon_url(
                request.name
            )
        except InvalidIconUrl as exc:
            raise ManagementError(422, reason_codes.VALIDATION_ERROR, str(exc)) from exc
        spec, options, metadata = _known_agent_registration(definition, None)
        await session.commit()
        try:
            result = await protocol.register_agent(
                registration_path="gateway",
                name=request.name,
                description=request.description,
                display_name=request.display_name,
                icon_url=icon_url,
                connector_type=spec.connector_type,
                integration_profile=spec.build_profile(options),
                tools=spec.tools,
                models=spec.models,
                metadata=metadata,
                owner_id=owner_id,
                owner_only=True,
                reserved_agent_id=agent_id,
            )
        except AgentExistsError as exc:
            raise ManagementError(409, reason_codes.VALIDATION_ERROR, str(exc)) from exc
        except ValueError as exc:
            raise ManagementError(422, reason_codes.VALIDATION_ERROR, str(exc)) from exc
        try:
            row = await self.definitions.create(
                session,
                agent_id=result.agent_id,
                owner_id=owner_id,
                controller_id=request.controller_id,
                desired_state=request.desired_state,
                definition=definition.model_dump(),
            )
            revisions = await self._bump_and_collect(
                session, tenant_id, {request.controller_id}
            )
            await session.commit()
            await self._bind(session, tenant_id, row)
        except Exception:
            await session.rollback()
            await self._discard_registered(protocol, result.agent_id)
            raise
        self._nudge(revisions)
        logger.info(
            "Created managed agent %s on controller %s",
            result.agent_id,
            request.controller_id,
        )
        agent = await self._owned_agent(session, owner_id, result.agent_id)
        return await self._view(session, tenant_id, row, agent, {})

    async def _discard_registered(self, protocol: AgentCore, agent_id: str) -> None:
        """Delete an agent registered for a managed agent whose creation then
        failed, so the failure leaves no agent behind. The caller re-raises the
        original error; a failure here is logged beside it, not raised over it."""
        try:
            await protocol.delete_agent(agent_id=agent_id)
        except Exception:
            logger.error(
                "Could not delete agent %s after creating it as a managed agent "
                "failed; it is left registered with no definition",
                agent_id,
                exc_info=True,
            )
            return
        logger.warning(
            "Deleted agent %s: creating it as a managed agent failed", agent_id
        )

    async def put_managed_agent(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        agent_id: str,
        target: _Placement,
        protocol: AgentCore,
        check_connections: CheckConnections,
    ) -> dict[str, Any]:
        """Adopt an agent the caller owns, or replace its definition and placement."""
        agent = await self._owned_agent(session, owner_id, agent_id)
        existing = await self.definitions.get_for_agent(session, tenant_id, agent_id)
        return await self._apply(
            session,
            tenant_id,
            owner_id,
            agent,
            existing,
            target,
            protocol,
            check_connections,
        )

    async def patch_managed_agent(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        agent_id: str,
        *,
        definition: DefinitionV1 | None,
        desired_state: str | None,
        controller_id: str | None,
        controller_id_given: bool,
        protocol: AgentCore,
        check_connections: CheckConnections,
    ) -> dict[str, Any]:
        existing, agent = await self._owned_definition(
            session, tenant_id, owner_id, agent_id
        )
        target = _Placement(
            controller_id=controller_id
            if controller_id_given
            else existing.controller_id,
            desired_state=desired_state or existing.desired_state,
            definition=(
                definition.model_dump()
                if definition is not None
                else existing.definition
            ),
        )
        return await self._apply(
            session,
            tenant_id,
            owner_id,
            agent,
            existing,
            target,
            protocol,
            check_connections,
        )

    async def _apply(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        agent: Agent,
        existing: AgentDefinitionRow | None,
        target: _Placement,
        protocol: AgentCore,
        check_connections: CheckConnections,
    ) -> dict[str, Any]:
        definition = DefinitionV1.model_validate(target.definition)
        moved = existing is None or existing.controller_id != target.controller_id
        to_running = target.desired_state == "running" and (
            existing is None or existing.desired_state != "running"
        )
        controller = await self._check_target(
            session,
            tenant_id,
            owner_id,
            target.controller_id,
            definition.provider,
            check_placement=moved or to_running,
        )
        refuse_connections_off_cloud(definition, controller)
        granted = existing.definition.get("connections", []) if existing else []
        if (
            definition.connections
            and [grant.model_dump() for grant in definition.connections] != granted
        ):
            await check_connections(definition.connections)
        directory = definition.directory
        if (
            moved
            and directory is not None
            and existing is not None
            and existing.controller_id is not None
        ):
            previous = await self.controllers.get(
                session, tenant_id, existing.controller_id
            )
            # The old machine's workspace for the agent means nothing on the new one.
            if directory == placed_directory(previous, agent.id, agent.name):
                directory = None
        if directory is None:
            directory = placed_directory(controller, agent.id, agent.name)
        if directory != definition.directory:
            definition = definition.model_copy(update={"directory": directory})
            target = replace(
                target, definition={**target.definition, "directory": directory}
            )
        if existing is not None and (
            existing.controller_id == target.controller_id
            and existing.desired_state == target.desired_state
            and existing.definition == target.definition
        ):
            return await self._view(session, tenant_id, existing, agent, {})

        previous_controller_id = existing.controller_id if existing else None
        if existing is None or existing.definition != target.definition:
            spec, options, metadata = _known_agent_registration(
                definition, agent.metadata_
            )
            await session.commit()
            await protocol.update_agent(
                agent.id,
                integration_profile=spec.build_profile(options).model_dump(),
                metadata=metadata,
            )

        if existing is None:
            row = await self.definitions.create(
                session,
                agent_id=agent.id,
                owner_id=owner_id,
                controller_id=target.controller_id,
                desired_state=target.desired_state,
                definition=target.definition,
            )
            affected: set[str | None] = {target.controller_id}
        else:
            row = await self.definitions.update(
                session,
                tenant_id,
                agent.id,
                controller_id=target.controller_id,
                desired_state=target.desired_state,
                definition=target.definition,
            )
            affected = {previous_controller_id, target.controller_id}
            if previous_controller_id is not None and moved:
                await self.operations.cancel_open(
                    session,
                    tenant_id,
                    controller_id=previous_controller_id,
                    agent_id=agent.id,
                )
        revisions = await self._bump_and_collect(session, tenant_id, affected)
        await session.commit()
        await self._bind(session, tenant_id, row)
        self._nudge(revisions)
        agent = await self._owned_agent(session, owner_id, agent.id)
        return await self._view(session, tenant_id, row, agent, {})

    async def delete_managed_agent(
        self, session: AsyncSession, tenant_id: str, owner_id: str, agent_id: str
    ) -> None:
        """Stop managing the agent. Its controller stops it; the agent itself
        is not deleted.
        """
        row, agent = await self._owned_definition(
            session, tenant_id, owner_id, agent_id
        )
        await self.definitions.delete(session, tenant_id, agent_id)
        if row.controller_id is not None:
            await self.operations.cancel_open(
                session, tenant_id, controller_id=row.controller_id, agent_id=agent_id
            )
        revisions = await self._bump_and_collect(
            session, tenant_id, {row.controller_id}
        )
        await session.commit()
        self.presence.unbind(agent_id, DETACH_UNASSIGNED)
        self._nudge(revisions)

    async def forget_deleted_agent(
        self, session: AsyncSession, tenant_id: str, agent_id: str
    ) -> None:
        """Unmanage an agent that is about to be deleted through Core.

        The definition would go with the agent by cascade, but its controller
        would never hear of it: its assignment revision would stand, and every
        pull would answer 304 while it kept running an agent that no longer
        exists.
        """
        row = await self.definitions.get_for_agent(session, tenant_id, agent_id)
        if row is None:
            return
        await self.definitions.delete(session, tenant_id, agent_id)
        if row.controller_id is not None:
            await self.operations.cancel_open(
                session, tenant_id, controller_id=row.controller_id, agent_id=agent_id
            )
        revisions = await self._bump_and_collect(
            session, tenant_id, {row.controller_id}
        )
        await session.commit()
        self.presence.unbind(agent_id, DETACH_DELETED)
        self._nudge(revisions)
        logger.info("Stopped managing agent %s, which is being deleted", agent_id)

    # ── Operations, owner side ────────────────────────────────────────────────

    async def create_operation(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        *,
        controller_id: str,
        agent_id: str | None,
        kind: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        if kind not in V1_OPERATION_KINDS:
            raise ManagementError(
                400,
                reason_codes.OPERATION_UNSUPPORTED,
                f"Operation kind {kind!r} is not supported; supported kinds are "
                f"{', '.join(sorted(V1_OPERATION_KINDS))}.",
            )
        controller = await self.owned_controller(
            session, tenant_id, owner_id, controller_id
        )
        if self.state_of(controller) == "revoked":
            raise ManagementError(
                409, reason_codes.CONTROLLER_REVOKED, "The controller has been revoked."
            )
        if kind == "agent.restart":
            if agent_id is None:
                raise ManagementError(
                    422,
                    reason_codes.VALIDATION_ERROR,
                    "agent.restart needs an agent_id.",
                )
            row = await self.definitions.get_for_agent(session, tenant_id, agent_id)
            if row is None or row.controller_id != controller_id:
                raise ManagementError(
                    409,
                    reason_codes.NOT_ASSIGNED,
                    "That agent is not assigned to this controller.",
                )
            if params:
                raise ManagementError(
                    422, reason_codes.VALIDATION_ERROR, "agent.restart takes no params."
                )
        else:
            provider = params.get("provider")
            if (
                agent_id is not None
                or provider not in PROVIDER_KNOWN_AGENT_TYPES
                or set(params) != {"provider"}
            ):
                raise ManagementError(
                    422,
                    reason_codes.VALIDATION_ERROR,
                    "provider.recheck takes no agent_id and params.provider naming "
                    f"one of {', '.join(sorted(PROVIDER_KNOWN_AGENT_TYPES))}.",
                )
        if controller.kind == CLOUD_CONTROLLER_KIND:
            await wake_controller_machine(session, controller_id, self.now())
        operation = await self.operations.create(
            session,
            controller_id=controller_id,
            agent_id=agent_id,
            kind=kind,
            params=params,
            created_by=owner_id,
        )
        view = operation_view(operation)
        await session.commit()
        self.notifier.operation_pending(
            controller_id, operation_id=operation.id, kind=kind, agent_id=agent_id
        )
        return view

    async def list_operations(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        controller_id: str | None,
    ) -> list[dict[str, Any]]:
        if controller_id is not None:
            await self.owned_controller(session, tenant_id, owner_id, controller_id)
            controller_ids = [controller_id]
        else:
            controller_ids = [
                controller.id
                for controller in await self.controllers.list_for_owner(
                    session, tenant_id, owner_id
                )
            ]
        operations = await self.operations.list_for_controllers(
            session, tenant_id, controller_ids, OPERATION_LIST_LIMIT
        )
        return [operation_view(operation) for operation in operations]


def binding_of(
    tenant_id: str, row: AgentDefinitionRow, controller: AgentController
) -> Binding:
    """The binding Core keeps for a definition placed on `controller`."""
    assert row.controller_id == controller.id
    return Binding(
        agent_id=row.agent_id,
        controller_id=controller.id,
        tenant_id=tenant_id,
        controller_name=controller.name,
        running=row.desired_state == "running",
    )


def placement_from(
    controller_id: str | None, desired_state: str, definition: DefinitionV1
) -> _Placement:
    return _Placement(
        controller_id=controller_id,
        desired_state=desired_state,
        definition=definition.model_dump(),
    )


def default_directory(controller: AgentController | None, name: str) -> str | None:
    """The workspace `controller` makes for an agent named `name` when its
    definition names no directory (the controller's `DataLayout.workspace`),
    or None when the controller has not reported where it keeps them."""
    if controller is None:
        return None
    root = workspaces_dir_of(controller)
    if root is None:
        return None
    platform = controller.platform or {}
    if platform.get("os") == "windows":
        return ntpath.join(root, name)
    return posixpath.join(root, name)


def placed_directory(
    controller: AgentController | None, agent_id: str, name: str
) -> str | None:
    """The directory an agent works in on `controller` when its definition
    names none: on a Switch cloud machine its own worktree, which is the only
    place that machine runs it; elsewhere the machine's workspace for it."""
    if controller is not None and controller.kind == CLOUD_CONTROLLER_KIND:
        return worktree_path(agent_id)
    return default_directory(controller, name)


def cloud_definition(definition: DefinitionV1, agent_id: str) -> DefinitionV1:
    """A new agent's definition on a Switch cloud machine, which runs every
    agent isolated, in its own workspace unless the definition names a
    directory."""
    return definition.model_copy(
        update={
            "isolation": "isolated",
            "directory": definition.directory or worktree_path(agent_id),
        }
    )


def refuse_connections_off_cloud(
    definition: DefinitionV1, controller: AgentController | None
) -> None:
    """Only an agent on a Switch cloud machine is given connection credentials."""
    if (
        definition.connections
        and controller is not None
        and controller.kind != CLOUD_CONTROLLER_KIND
    ):
        raise ManagementError(
            422,
            reason_codes.VALIDATION_ERROR,
            "Only an agent on a Switch cloud machine can be granted connections; "
            "choose your Switch cloud machine, or grant no connections.",
        )


def with_directory(
    definition: DefinitionV1, controller: AgentController | None, name: str
) -> DefinitionV1:
    """The definition, naming its machine's workspace for the agent when it
    names no directory and the machine has said where that is."""
    if definition.directory is not None:
        return definition
    directory = default_directory(controller, name)
    if directory is None:
        return definition
    return definition.model_copy(update={"directory": directory})


def _known_agent_registration(
    definition: DefinitionV1, existing_metadata: dict[str, Any] | None
) -> tuple[type[KnownAgent], Any, dict[str, Any]]:
    """The known-agent spec, options and metadata a definition registers with.

    Options the definition does not speak to (Claude Code's `channels_enabled`,
    say) keep whatever the agent already had. An agent already registered as
    a different known type is refused rather than silently converted.
    """
    known_type = PROVIDER_KNOWN_AGENT_TYPES[definition.provider]
    metadata = dict(existing_metadata) if isinstance(existing_metadata, dict) else {}
    current_type = metadata.get("known_agent_type")
    if current_type is not None and current_type != known_type:
        raise ManagementError(
            409,
            reason_codes.VALIDATION_ERROR,
            f"This agent is registered as {current_type!r}, which does not run "
            f"provider {definition.provider!r}.",
        )
    spec = KNOWN_AGENTS[known_type]
    current_options = metadata.get("known_agent_options")
    raw_options = dict(current_options) if isinstance(current_options, dict) else {}
    raw_options["auto_session"] = True
    raw_options["repo_dir"] = definition.directory
    options = spec.parse_options(raw_options)
    metadata["known_agent_type"] = known_type
    metadata["known_agent_options"] = options.model_dump()
    return spec, options, metadata
