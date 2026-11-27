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
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.accounts.suspension import owner_is_suspended
from switch_core.agent_icon import (
    InvalidIconUrl,
    drop_third_party_avatar,
    new_icon_url,
    normalise_icon_url,
)
from switch_core.archived_workspace import WORKSPACE_ARCHIVED, is_archived
from switch_core.bridges.agent.auth import ControllerPrincipal
from switch_core.bridges.agent.protocol.agent_core import AgentCore, AgentExistsError
from switch_core.bridges.agent.protocol.controller_presence import (
    DETACH_DELETED,
    DETACH_UNASSIGNED,
    DISCONNECT_REVOKED,
    ConnectionNotLetGoError,
    ControllerConnection,
    ControllerPresence,
    ControllerRevokedError,
    ControllerTakenOverError,
    UnknownControllerConnectionError,
)
from switch_core.bridges.agent.protocol.liveness import HEARTBEAT_LAPSED, TAKEN_OVER
from switch_core.config import ControllerRelease
from switch_core.db.audit import AuditAction, record_audit_event, request_actor
from switch_core.db.models import (
    CONTROLLER_ENROLLMENT_KEY_TYPE,
    CONTROLLER_KEY_TYPE,
    Agent,
    AgentController,
    AgentControllerEnrollmentCode,
    AgentControllerOperation,
    ApiKey,
    CloudMachine,
    HostedMigration,
    MachineWorkspace,
    ServiceTokenIssuance,
    require_tenant_id,
)
from switch_core.db.models import AgentDefinition as AgentDefinitionRow
from switch_core.db.stores.agent_controller_operation_store import (
    AgentControllerOperationStore,
)
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.budget_store import hosted_daily_cap
from switch_core.db.stores.hosted_machine_store import CloudMachineStore
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.db.stores.template_install_store import TemplateInstallStore
from switch_core.gateway.cloud_controllers import (
    enroll_revoked_again,
    record_controller_status,
    wake_controller_machine,
)
from switch_core.gateway.known_agents import KnownAgent, provider_known_agent
from switch_core.hosted_v2 import controller_backend, process_hosted_v2, v2_box
from switch_core.management import reason_codes, tokens
from switch_core.management.bindings import binding_of
from switch_core.management.device_identity import device_hash, is_device_id
from switch_core.management.errors import ManagementError, not_found
from switch_core.management.placement import (
    ControllerState,
    controller_state,
    is_revoked,
    require_placement,
)
from switch_core.management.schemas import (
    ControllerDescription,
    CreateManagedAgentRequest,
    DefinitionV1,
    StatusReport,
    assignment_entry,
    controller_release_view,
    controller_view,
    managed_agent_view,
    operation_view,
    operation_wire,
    sealed_login_view,
    workspaces_dir_of,
)
from switch_core.management.sealed_logins import PublicKey, SealedLogin, key_id
from switch_core.management.signals import ControllerSignals
from switch_core.process_lease import ProcessLeases, read_leases
from switch_core.providers.registry import (
    ProviderNotOffered,
    provider_ids,
    require_offered_provider,
)
from switch_core.user_changes import MACHINE, MANAGED_AGENT, UserChangePublisher
from switch_core.visibility.awake_usage import (
    record_awake_minutes,
    record_hosted_ai_calls,
)
from switch_core.visibility.stop_reason_sources import (
    ReasonSignals,
    agent_stop_reason,
    load_reason_signals,
)

_INSTALLS = TemplateInstallStore()
logger = logging.getLogger(__name__)

# Controllers whose old free-text memory note has been dropped, so each is
# logged once per Core process rather than on every report.
_OLD_NOTE_DROPPED: set[str] = set()


def _note_dropped(controller_id: str) -> None:
    """Count an older controller's dropped free-text memory note: its id only,
    never the text, once per controller."""
    if controller_id in _OLD_NOTE_DROPPED:
        return
    _OLD_NOTE_DROPPED.add(controller_id)
    logger.info(
        "Controller %s sent an old free-text memory note; it was dropped, not "
        "stored (%d controllers so far)",
        controller_id,
        len(_OLD_NOTE_DROPPED),
    )


OPERATION_LEASE = timedelta(minutes=5)
# An operation still open this long after it was created is expired rather
# than offered again: nothing is left pending for ever.
OPERATION_TTL = timedelta(hours=1)
OPERATION_LIST_LIMIT = 200

V1_OPERATION_KINDS = frozenset(
    {"agent.restart", "provider.recheck", "controller.restart"}
)

# The providers a machine's controller can sign in through a browser.
BROWSER_SIGN_IN = frozenset({"claude", "codex", "cursor", "antigravity", "opencode"})
# Those a cloud device can. Its agents' CLIs never hold the real login: the
# provider gateway fronts it, and of these sign-ins it fronts only Claude's
# setup token (`gatewayPlanFor` in the controller's box mode). Codex's and
# OpenCode's ChatGPT tokens refresh and rotate, and Cursor and Antigravity keep
# their login inside the CLI.
CLOUD_BROWSER_SIGN_IN = frozenset({"claude"})

# What a Switch Cloud machine's controller is called, whatever enrolled it.
CLOUD_MACHINE_NAME = "Switch Cloud"

# How long a device just enrolled or taken over is left to the process that
# did it, before another enrolling on the same device may take it over: long
# enough for that process to start and report, so two enrolling at once do
# not take it from each other.
TAKE_OVER_GRACE = timedelta(minutes=1)


@dataclass(frozen=True)
class Enrolled:
    """A controller enrolled, with the credential only its process holds.
    `adopted`: an existing device of its owner's on the same machine and
    account was taken over, agents and all, rather than a new one added."""

    controller: AgentController
    credential: str
    adopted: bool


@dataclass(frozen=True)
class ManagementSettings:
    token_secret: str
    status_interval_seconds: int
    # The public origin of the agent bridge, which a controller enrolls
    # against (`GATEWAY_PUBLIC_URL`). None when the deployment has not said,
    # and then nothing can tell an owner what `--server` to enroll with.
    server_url: str | None
    # `THIRD_PARTY_AVATARS_ENABLED`. Off, a new agent with no chosen icon
    # stores none rather than the generated one, which carries its name.
    third_party_avatars: bool
    # The deployment's feature flags (`FEATURE_FLAGS_ENABLED`), for the
    # providers a new agent may name.
    feature_flags: Mapping[str, bool]
    # The controller release every controller is told to run; None when the
    # deployment names none, and then controllers are told nothing.
    controller_release: ControllerRelease | None
    # How long a box lets a message wait for room before it lets it go and its agent shows
    # `waiting_too_long`: `hosted_wait_limit_minutes`, sent in every status answer.
    wait_limit_seconds: int = 600


@dataclass(frozen=True)
class _Placement:
    controller_id: str | None
    desired_state: str
    definition: dict[str, Any]


async def revoke_controller_rows(
    session: AsyncSession,
    tenant_id: str,
    controller_id: str,
    *,
    now: datetime,
    controllers: AgentControllerStore,
    api_keys: ApiKeyStore,
    operations: AgentControllerOperationStore,
    revoked_by: Literal["pause", "turn_off"] | None = None,
) -> None:
    """`ManagementService._revoke`'s rows, for a caller without the service
    (the hosted migration's command): mark revoked, delete the credential,
    audit the revoke, cancel open operations and drop sealed logins. Already
    revoked is fine. The caller commits; nothing is announced."""
    controller = await controllers.get(session, tenant_id, controller_id)
    if controller is None:
        return
    if controller.revoked_at is not None:
        if revoked_by is None and controller.revoked_by is not None:
            await controllers.clear_revoked_by(session, tenant_id, controller_id)
        return
    actor_user_id, acting_agent_id = request_actor()
    await record_audit_event(
        session,
        tenant_id=tenant_id,
        actor_user_id=actor_user_id,
        action=AuditAction.CONTROLLER_REVOKED,
        target_type="controller",
        target_id=controller_id,
        details={
            "name": controller.name,
            "kind": controller.kind,
            "owner_id": controller.owner_id,
            "acting_agent_id": acting_agent_id,
        },
    )
    key_id = controller.api_key_id
    await controllers.mark_revoked(
        session, tenant_id, controller_id, now, revoked_by=revoked_by
    )
    if key_id is not None:
        await api_keys.delete(session, key_id)
    await operations.cancel_open(
        session, tenant_id, controller_id=controller_id, agent_id=None
    )
    await controllers.delete_sealed_logins(session, tenant_id, controller_id, None)


class ManagementService:
    def __init__(
        self,
        *,
        settings: ManagementSettings,
        signals: ControllerSignals,
        user_changes: UserChangePublisher,
        controllers: AgentControllerStore,
        definitions: AgentDefinitionStore,
        operations: AgentControllerOperationStore,
        api_keys: ApiKeyStore,
        agents: AgentStore,
        processes: SwitchCoreProcessStore,
        presence: ControllerPresence,
        clock: Callable[[], datetime],
    ) -> None:
        self.settings = settings
        self.signals = signals
        self.notifier = signals.notifier
        self.user_changes = user_changes
        self.presence = presence
        self.controllers = controllers
        self.definitions = definitions
        self.operations = operations
        self.api_keys = api_keys
        self.agents = agents
        self.processes = processes
        self._clock = clock

    def now(self) -> datetime:
        return self._clock()

    def _require_offered(self, provider: str) -> None:
        """Refuses a provider this deployment's feature flags leave off, for
        anything that would start using it; an agent already on it is not
        checked."""
        try:
            require_offered_provider(provider, self.settings.feature_flags)
        except ProviderNotOffered as exc:
            raise ManagementError(422, reason_codes.VALIDATION_ERROR, str(exc)) from exc

    async def leases(self, session: AsyncSession) -> ProcessLeases:
        """Every switch-core process's lease, which a controller's state
        needs: read once per request, before the states it decides."""
        return await read_leases(session, self.processes)

    @staticmethod
    def state_of(controller: AgentController, leases: ProcessLeases) -> ControllerState:
        return controller_state(controller, leases)

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
    ) -> Enrolled:
        """Create a controller and its credential, or take over the owner's
        device on the same machine, account and data folder (`_device_to_take_over`), and
        commit."""
        tenant_id = require_tenant_id()
        await self._refuse_archived(session, tenant_id)
        same_device = (
            None
            if description.device_id is None
            else device_hash(owner_id, description.device_id)
        )
        twin = await self._device_to_take_over(
            session, tenant_id, owner_id, description.kind, same_device
        )
        if twin is not None:
            credential = await self._take_over(
                session, tenant_id, twin, description, public_key
            )
            await session.commit()
            self.signals.credential_replaced(twin.id)
            self.user_changes.publish(tenant_id, owner_id, MACHINE, twin.id)
            return Enrolled(twin, credential, adopted=True)
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
            device_hash=same_device,
        )
        await self._record_enrolled(session, controller, via="console")
        await session.commit()
        self.user_changes.publish(
            controller.tenant_id, owner_id, MACHINE, controller.id
        )
        logger.info(
            "Enrolled agent controller %s (%s) for user %s",
            controller.id,
            controller.kind,
            owner_id,
        )
        return Enrolled(controller, credential, adopted=False)

    async def _device_to_take_over(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        kind: str,
        same_device: str | None,
    ) -> AgentController | None:
        """The owner's device in the workspace on the machine, account and
        data folder `same_device` names, which a controller enrolling there
        takes over: not revoked, not running, and not enrolled or taken over
        in the last `TAKE_OVER_GRACE` without having reported since; the one
        seen last.

        A device running now has a process of its own on that data folder,
        which is left to it: the new one is a device of its own. The rows are
        locked until the caller commits.

        With hosted agents v2 on, a Switch Cloud machine's controller (kind
        `ec2`, every v2 box's) is never taken over, whatever device id is
        sent: a box enrolls again only after its controller was revoked or
        lost, and v2's own path (`_move_placed`, under the box's revocation
        and removal rules) is the only one that moves its agents."""
        if same_device is None or (process_hosted_v2() and kind == "ec2"):
            return None
        twins = await self.controllers.lock_same_device(
            session,
            tenant_id,
            owner_id=owner_id,
            kind=kind,
            device_hash=same_device,
        )
        if not twins:
            return None
        leases = await self.leases(session)
        # The database's clock, as it stamped `updated_at`: the app's need not
        # agree with it.
        database_now = (await session.execute(select(func.now()))).scalar_one()
        settled_before = database_now - TAKE_OVER_GRACE
        idle = [
            twin
            for twin in twins
            if self.state_of(twin, leases) != "online"
            and not (twin.status is None and twin.updated_at > settled_before)
        ]
        return max(
            idle,
            key=lambda twin: (twin.last_seen_at or twin.created_at, twin.created_at),
            default=None,
        )

    async def _take_over(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller: AgentController,
        description: ControllerDescription,
        public_key: PublicKey | None,
    ) -> str:
        """Give a device (`_device_to_take_over`) to the controller enrolling
        on it: a new credential, the old one deleted, and the key its provider
        logins are sealed to, or none until it registers one. What was given or
        asked of the process that held it goes with that process: the logins
        sealed to its key, its open operations, and the service tokens issued to
        it, queued for revocation. The device keeps its id,
        name, description and agents. The caller commits.

        An access token the old process still holds names the old credential,
        and is refused from now (`ManagementAuthenticator.current`), so that
        process cannot act for the device again. Once the caller has
        committed, `ControllerSignals.credential_replaced` has every process
        end any stream the old holder still has there; each drops its cached
        answer for the controller too, as it does on the row's credential
        changing."""
        key, credential = await self._new_hash_only_key(
            session,
            owner_id=controller.owner_id,
            key_type=CONTROLLER_KEY_TYPE,
            label=f"controller {controller.name}",
        )
        old_key_id = controller.api_key_id
        await self.controllers.take_over(
            session,
            controller,
            api_key_id=key.id,
            platform=description.platform.model_dump(),
            version=description.version,
            public_key=public_key.model_dump() if public_key is not None else None,
        )
        if old_key_id is not None:
            await self.api_keys.delete(session, old_key_id)
        await self.operations.cancel_open(
            session, tenant_id, controller_id=controller.id, agent_id=None
        )
        await self.controllers.delete_sealed_logins(
            session, tenant_id, controller.id, None
        )
        # Its service tokens are the old process's too. Nothing else queues
        # them, as the device keeps its grants, owner and agents; the route
        # revokes them at the vendor once this commits.
        await ServiceConnectionStore().queue_revocation(
            session,
            ServiceTokenIssuance.principal == "controller",
            ServiceTokenIssuance.controller_id == controller.id,
            ServiceTokenIssuance.revoke_requested.is_(False),
        )
        logger.info(
            "Agent controller %s (%s) of user %s was taken over by a controller "
            "enrolling on the same device",
            controller.id,
            controller.kind,
            controller.owner_id,
        )
        return credential

    async def issue_enrollment_code(
        self, session: AsyncSession, *, owner_id: str
    ) -> tuple[str, datetime]:
        await self._refuse_archived(session, require_tenant_id())
        key, code = await self._new_hash_only_key(
            session,
            owner_id=owner_id,
            key_type=CONTROLLER_ENROLLMENT_KEY_TYPE,
            label="controller enrollment code",
        )
        expires_at = self.now() + tokens.ENROLLMENT_CODE_LIFETIME
        await self.controllers.create_enrollment_code(
            session,
            owner_id=owner_id,
            api_key_id=key.id,
            expires_at=expires_at,
            machine_workspace_id=None,
        )
        await session.commit()
        return code, expires_at

    async def machine_enrollment_code(
        self, session: AsyncSession, workspace: MachineWorkspace, now: datetime
    ) -> str:
        """A code for a Switch Cloud machine's controller in the bound workspace
        to enroll with: the owner's, valid long enough for the machine to boot,
        and binding what enrolls with it to the workspace's row on the machine.
        The caller commits."""
        key, code = await self._new_hash_only_key(
            session,
            owner_id=workspace.owner_id,
            key_type=CONTROLLER_ENROLLMENT_KEY_TYPE,
            label="cloud machine enrollment code",
        )
        await self.controllers.create_enrollment_code(
            session,
            owner_id=workspace.owner_id,
            api_key_id=key.id,
            expires_at=now + await _machine_code_lifetime(session, workspace),
            machine_workspace_id=workspace.id,
        )
        return code

    async def _machine_code_row(
        self, session: AsyncSession, code: str
    ) -> tuple[ApiKey, AgentControllerEnrollmentCode] | None:
        key = await self.api_keys.get_by_hash(session, tokens.hash_secret(code))
        if key is None or key.type != CONTROLLER_ENROLLMENT_KEY_TYPE:
            return None  # used (its key is deleted on enrollment) or never issued
        row = await session.scalar(
            select(AgentControllerEnrollmentCode).where(
                AgentControllerEnrollmentCode.api_key_id == key.id
            )
        )
        return None if row is None else (key, row)

    async def machine_enrollment_code_live(
        self, session: AsyncSession, code: str, now: datetime
    ) -> bool:
        found = await self._machine_code_row(session, code)
        if found is None:
            return False
        _key, row = found
        return row.used_at is None and row.expires_at > now

    async def revoke_machine_controller(
        self, session: AsyncSession, tenant_id: str, controller_id: str
    ) -> None:
        """Revoke a cleaned-up cloud machine's old controller as its row is
        revived. Nothing is announced: the machine had no box. The caller
        commits."""
        await self._revoke(session, tenant_id, controller_id)

    async def retire_machine_enrollment_code(
        self, session: AsyncSession, code: str
    ) -> None:
        found = await self._machine_code_row(session, code)
        if found is None:
            return  # already spent: nothing holds it any more
        key, row = found
        if row.controller_id is not None:
            return  # never cut off what enrolled with it
        await self.api_keys.delete(session, key.id)

    async def enroll(
        self,
        session: AsyncSession,
        tenant_id: str,
        *,
        code: str,
        description: ControllerDescription,
        public_key: PublicKey | None,
    ) -> Enrolled:
        """Spend an enrollment code on a new controller, or on taking over the
        owner's device on the same machine, account and data folder
        (`_device_to_take_over`); a Switch Cloud machine's controller never
        does, as its machine names its device. The session must be bound to
        the tenant the code resolved to."""
        invalid = ManagementError(
            401,
            reason_codes.ENROLLMENT_CODE_INVALID,
            "The enrollment code is invalid, already used, or expired.",
        )
        key = await self.api_keys.get_by_hash(session, tokens.hash_secret(code))
        if (
            key is None
            or key.type != CONTROLLER_ENROLLMENT_KEY_TYPE
            or key.expired(self.now())
        ):
            raise invalid
        if await owner_is_suspended(session, key.user_id):
            raise ManagementError(
                403,
                reason_codes.ACCOUNT_SUSPENDED,
                "The account this enrollment code belongs to is suspended.",
            )
        consumed = await self.controllers.consume_enrollment_code(
            session, tenant_id, key.id, self.now()
        )
        if consumed is None:
            raise invalid
        workspace = (
            None
            if consumed.machine_workspace_id is None
            else await session.get(
                MachineWorkspace, (tenant_id, consumed.machine_workspace_id)
            )
        )
        machine = (
            None
            if workspace is None
            else await CloudMachineStore().locked(session, workspace.machine_id)
        )
        if consumed.machine_workspace_id is not None and (
            workspace is None or machine is None or machine.state == "deleted"
        ):
            raise invalid
        if consumed.machine_workspace_id is not None:
            await _refuse_for_box(
                session,
                None if machine is None else machine.backend,
                consumed.owner_id,
                tenant_id,
            )
        same_device = (
            None
            if machine is not None or description.device_id is None
            else device_hash(consumed.owner_id, description.device_id)
        )
        twin = await self._device_to_take_over(
            session, tenant_id, consumed.owner_id, description.kind, same_device
        )
        if twin is not None:
            controller = twin
            credential = await self._take_over(
                session, tenant_id, twin, description, public_key
            )
        else:
            controller_key, credential = await self._new_hash_only_key(
                session,
                owner_id=consumed.owner_id,
                key_type=CONTROLLER_KEY_TYPE,
                label=f"controller {description.name}",
            )
            controller = await self.controllers.create(
                session,
                owner_id=consumed.owner_id,
                name=CLOUD_MACHINE_NAME if machine is not None else description.name,
                description=description.description,
                # A Switch Cloud machine's controller is the cloud's, whatever the
                # program that enrolled says it is.
                kind="ec2" if machine is not None else description.kind,
                platform=description.platform.model_dump(),
                version=description.version,
                public_key=public_key.model_dump() if public_key is not None else None,
                api_key_id=controller_key.id,
                device_hash=same_device,
            )
        await self.controllers.complete_enrollment(
            session, tenant_id, consumed.id, controller.id
        )
        await self._record_enrolled(session, controller, via="enrollment_code")
        await self.api_keys.delete(session, key.id)
        replaced: str | None = None
        moved: list[AgentDefinitionRow] = []
        revisions: dict[str, int] = {}
        if workspace is not None:
            replaced = workspace.controller_id
            workspace.controller_id = controller.id
            # The code is spent: forget the encrypted copy kept for retried
            # prepares. A v2 box's only: a v1 machine keeps it, as upstream.
            if process_hosted_v2() and machine is not None and machine.backend == "box":
                workspace.enrollment_code_encrypted = None
                workspace.enrollment_code_revision = None
            # A box enrolling while an operator moves the machine from v1 takes
            # none of the agents yet: they stay on the v1 controller until the
            # copy is verified (the migration's hold; never set otherwise).
            held = (
                replaced is not None and replaced == workspace.moving_from_controller_id
            )
            if replaced is not None and replaced != controller.id:
                await self._revoke(session, tenant_id, replaced)
                if not held:
                    moved = await self._move_placed(
                        session, tenant_id, replaced, controller.id
                    )
                revisions = await self._bump_and_collect(
                    session, tenant_id, {replaced, controller.id}
                )
        await session.commit()
        if twin is not None:
            self.signals.credential_replaced(twin.id)
        if replaced is not None and replaced != controller.id:
            self._announce_revoked(replaced)
            for row in moved:
                await self._bind(session, tenant_id, row)
            self._nudge(tenant_id, revisions)
            logger.info(
                "Cloud machine %s enrolled again; revoked its previous controller %s "
                "and moved its %d agent(s) to %s",
                workspace.machine_id if workspace is not None else None,
                replaced,
                len(moved),
                controller.id,
            )
        self.user_changes.publish(tenant_id, consumed.owner_id, MACHINE, controller.id)
        logger.info(
            "Enrolled agent controller %s (%s) by code for user %s",
            controller.id,
            controller.kind,
            consumed.owner_id,
        )
        return Enrolled(controller, credential, adopted=twin is not None)

    async def exchange_token(
        self,
        session: AsyncSession,
        tenant_id: str,
        *,
        controller_id: str,
        credential: str,
    ) -> tuple[str, datetime]:
        invalid = ManagementError(
            401, reason_codes.INVALID_CREDENTIAL, "The credential is not valid."
        )
        key = await self.api_keys.get_by_hash(session, tokens.hash_secret(credential))
        if key is None or key.type != CONTROLLER_KEY_TYPE or key.expired(self.now()):
            raise invalid
        controller = await self.controllers.get_by_api_key(session, tenant_id, key.id)
        if controller is None or controller.id != controller_id:
            raise invalid
        if is_revoked(controller):
            raise ManagementError(
                401, reason_codes.CONTROLLER_REVOKED, "The controller has been revoked."
            )
        # Refused, not revoked: the same credential is exchanged again once
        # the suspension is lifted.
        if await owner_is_suspended(session, controller.owner_id):
            raise ManagementError(
                403,
                reason_codes.ACCOUNT_SUSPENDED,
                "The account this controller belongs to is suspended.",
            )
        if controller.kind == "ec2":
            await _refuse_for_box(
                session,
                await _controller_backend(session, tenant_id, controller.id),
                controller.owner_id,
                tenant_id,
            )
        return tokens.mint_access_token(
            secret=self.settings.token_secret,
            controller_id=controller.id,
            tenant_id=tenant_id,
            owner_id=controller.owner_id,
            key_id=key.id,
            now=self.now(),
        )

    async def rotate_credential(
        self, session: AsyncSession, principal: ControllerPrincipal
    ) -> str:
        controller = await self._principal_controller(session, principal)
        if controller.kind == "ec2":
            await _refuse_for_box(
                session,
                await _controller_backend(session, principal.tenant_id, controller.id),
                controller.owner_id,
                principal.tenant_id,
            )
        key, credential = await self._new_hash_only_key(
            session,
            owner_id=controller.owner_id,
            key_type=CONTROLLER_KEY_TYPE,
            label=f"controller {controller.name}",
        )
        old_key_id = controller.api_key_id
        await self.controllers.set_credential(
            session, principal.tenant_id, controller.id, key.id
        )
        if old_key_id is not None:
            await self.api_keys.delete(session, old_key_id)
        await session.commit()
        return credential

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
        archived = await is_archived(session, principal.tenant_id)
        assignment: dict[str, Any] = {
            "revision": controller.assignment_revision,
            "agents": [
                assignment_entry(row, agent, workspace_archived=archived)
                for row, agent in rows
            ],
        }
        if controller.kind == "ec2" and await v2_box(
            session, principal.tenant_id, controller.id
        ):
            # The workspace's daily AI cap for this box's gateway,
            # or null with none set. A person's own computer never gets one.
            # With hosted agents v2 off, absent, as before v2.
            assignment["gateway_daily_cap"] = await hosted_daily_cap(
                session, principal.tenant_id
            )
        return assignment

    async def assignment_revision(
        self, session: AsyncSession, principal: ControllerPrincipal
    ) -> int:
        return (
            await self._principal_controller(session, principal)
        ).assignment_revision

    async def controls_agent(
        self, session: AsyncSession, principal: ControllerPrincipal, agent_id: str
    ) -> bool:
        """Whether `agent_id` is bound to the calling controller: the only
        agents a controller may act for."""
        return any(
            agent.id == agent_id
            for _row, agent in await self.definitions.list_for_controller(
                session, principal.tenant_id, principal.controller_id
            )
        )

    async def record_status(
        self,
        session: AsyncSession,
        principal: ControllerPrincipal,
        report: StatusReport,
    ) -> dict[str, Any]:
        """Store a status report unless a newer one is stored, and tell the
        controller its assignment revision either way.

        The owner's Console is told only when what the report says changed,
        not on every report: free disk and memory, and the times a report and
        its provider checks were taken, move on every one of them.
        """
        # The v1/v2 switch: with v2 off, the report is stored as before v2, with
        # no read of the bound agents, no lock on the previous report and every
        # field kept as sent.
        v2 = process_hosted_v2()
        status = report.model_dump(mode="json", exclude_unset=True)
        if report.machine._dropped_old_note:
            _note_dropped(principal.controller_id)
        bound_clients: dict[str, str] = {}
        previous_seen_at: datetime | None = None
        previous_status: dict[str, Any] | None = None
        seen_at = self.now()
        if v2:
            # A session state is kept only for agents bound to this controller,
            # so a box can't set "Resting" or "Running" on anyone else's agent.
            # (Each agent's view reads only its own controller's report anyway.)
            bound_clients = {
                agent.id: agent.client_id
                for _row, agent in await self.definitions.list_for_controller(
                    session, principal.tenant_id, principal.controller_id
                )
            }
            for entry in status.get("agents", []):
                if entry.get("agent_id") not in bound_clients and "session" in entry:
                    entry.pop("session")
                    # Not an error a box can cause by accident: worth a look.
                    logger.warning(
                        "Controller %s reported a session state for agent %s, "
                        "which is not bound to it; the state was dropped",
                        principal.controller_id,
                        entry.get("agent_id"),
                    )
            (
                previous_seen_at,
                previous_status,
            ) = await self.controllers.lock_previous_report(
                session, principal.tenant_id, principal.controller_id
            )
        controller = await self._principal_controller(session, principal)
        before = _status_signature(controller.status)
        new_status = status
        # Kept as the device hash only, never in the status the device's
        # owner and the workspace's admins are shown.
        new_status["machine"].pop("device_id", None)
        reported = report.machine.device_id
        if reported is not None and not is_device_id(reported):
            logger.warning(
                "Controller %s reported a device id that is not one; keeping the "
                "device it had",
                principal.controller_id,
            )
            reported = None
        stored = await self.controllers.record_status(
            session,
            principal.tenant_id,
            principal.controller_id,
            seq=report.seq,
            status=new_status,
            version=report.controller.version,
            platform=report.machine.platform.model_dump(mode="json"),
            device_hash=(
                None
                if reported is None or controller.kind == "ec2"
                else device_hash(controller.owner_id, reported)
            ),
            seen_at=seen_at,
        )
        if not stored:
            logger.info(
                "Ignored status seq %s from controller %s: not newer than the stored one",
                report.seq,
                principal.controller_id,
            )
        # Read again: the store wrote the row without touching the copy loaded
        # above, and the release the controller is told depends on the status
        # it just reported.
        await session.refresh(controller)
        revision = controller.assignment_revision
        owner_id = controller.owner_id
        if stored and controller.kind == "ec2":
            await record_controller_status(
                session,
                controller.id,
                report.machine.model_dump(mode="json"),
                new_status.get("agents", []),
                new_status.get("providers", []),
                report.controller.started_at,
            )
        on_v2_box = controller.kind == "ec2" and await v2_box(
            session, principal.tenant_id, controller.id
        )
        if stored and on_v2_box:
            # Hosted agents' awake time, for usage and awake-time budgets.
            # With hosted agents v2 off, not recorded, as before v2.
            await record_awake_minutes(
                session,
                tenant_id=principal.tenant_id,
                previous_seen_at=previous_seen_at,
                seen_at=seen_at,
                agents=status.get("agents", []),
                bound=bound_clients,
            )
            # AI calls, as the day's rise, per agent (display only).
            await record_hosted_ai_calls(
                session,
                tenant_id=principal.tenant_id,
                previous_seen_at=previous_seen_at,
                seen_at=seen_at,
                previous_status=previous_status,
                status=status,
                bound=bound_clients,
            )
        await session.commit()
        if stored and _status_signature(new_status) != before:
            self.user_changes.publish(
                principal.tenant_id, owner_id, MACHINE, principal.controller_id
            )
        return {
            "assignment_revision": revision,
            "report_within_s": self.settings.status_interval_seconds,
            # v2's "waiting too long" limit, for a v2 box only; absent for any
            # other controller and with v2 off, as before v2 (sweep row 6).
            **(
                {"wait_limit_seconds": self.settings.wait_limit_seconds}
                if on_v2_box
                else {}
            ),
            "controller_release": controller_release_view(
                controller, self.settings.controller_release
            ),
        }

    async def record_opened(
        self,
        session: AsyncSession,
        principal: ControllerPrincipal,
        *,
        connection_id: str,
        generation: int,
        resume_cursors: dict[str, int | None],
    ) -> None:
        """Record the connection the controller is opening and tell every
        other process: its socket may attach through any of them, and a
        connection another process holds for this controller has been taken
        over.

        Committed before the connection is held here, so a read of the row
        that lands in between finds the new connection named there, or finds
        the earlier one while this process still holds only that one.

        With hosted agents v2 off, a v2 box's controller can't reconnect."""
        _refuse_box_while_v2_off(
            await _controller_backend(
                session, principal.tenant_id, principal.controller_id
            )
        )
        await self.controllers.record_opened(
            session,
            principal.tenant_id,
            principal.controller_id,
            connection_id=connection_id,
            generation=generation,
            process_id=self.signals.process_id,
            resume_cursors=resume_cursors,
        )
        await session.commit()
        self.signals.connection_changed(principal.tenant_id, principal.controller_id)

    async def hold_connection(
        self,
        session: AsyncSession,
        principal: ControllerPrincipal,
        connection_id: str,
        generation: int,
    ) -> ControllerConnection:
        """The connection a socket attaching names, held here, or the refusal.

        Decided on the controller's row rather than on this process's memory,
        which may be a moment behind what another process has done: only a
        connection older than the one the row names is refused as taken
        over. The row names the connection the controller opened last and the
        process holding it:

        - this connection, held by this process: the copy here is the one
          that counts, and none here means it ended here (its heartbeat
          lapsed, say), which is final, as it always was;
        - another connection: the controller has opened a newer one, so a
          copy of this one still here is closed `taken_over`, and the attach
          refused as this process answers for it;
        - this connection, held by another process: it is taken up here,
          replacing any copy this process kept from holding it before.
        """
        presence = self.presence
        controller_id = principal.controller_id
        controller = await self.controllers.get(
            session, principal.tenant_id, controller_id
        )
        if controller is None:
            raise UnknownControllerConnectionError(connection_id)
        if is_revoked(controller):
            raise ControllerRevokedError(controller_id)
        if controller.open_connection_id != connection_id:
            local = presence.current_connection(controller_id)
            if local is not None and local.id == connection_id:
                presence.supersede(controller_id)
            return presence.require(controller_id, connection_id, generation)
        if controller.open_process_id == self.signals.process_id:
            return presence.require(controller_id, connection_id, generation)
        return await self._take_up(
            session, principal, controller, connection_id, generation
        )

    async def _take_up(
        self,
        session: AsyncSession,
        principal: ControllerPrincipal,
        controller: AgentController,
        connection_id: str,
        generation: int,
    ) -> ControllerConnection:
        """Hold here the connection the controller opened last, which another
        process holds or held, unless something has ended it. Recorded before
        it is held, as an open is.

        Its stream resumes each agent from the cursors recorded with it, which
        are the open's until a socket on it goes and its holder writes them.
        A socket attached to it whose going was never written (its holder
        died, or has not written it yet) may have sent past them, and the
        beats confirming how far went with that holder: resuming there would
        skip what it sent after, so the controller is told to open again,
        with its own cursors.

        A holder that has not written the going yet may be about to: the
        refusal for that is `ConnectionNotLetGoError`, which the attach waits
        out for a moment before passing it on."""
        if controller.open_generation != generation or (
            controller.connection_id == connection_id
            and controller.disconnect_reason in _ENDING_REASONS
        ):
            raise UnknownControllerConnectionError(connection_id)
        if (
            controller.connection_id == connection_id
            and controller.disconnected_at is None
        ):
            raise ConnectionNotLetGoError(connection_id)
        resume_cursors = _resume_cursors(controller.open_cursors)
        if not await self.controllers.record_taken_up(
            session,
            principal.tenant_id,
            principal.controller_id,
            connection_id=connection_id,
            process_id=self.signals.process_id,
        ):
            # The controller opened another connection since the row was read.
            raise ControllerTakenOverError(connection_id)
        await session.commit()
        conn = self.presence.adopt(
            controller_id=principal.controller_id,
            tenant_id=principal.tenant_id,
            connection_id=connection_id,
            generation=generation,
            resume_cursors=resume_cursors,
        )
        self.signals.connection_changed(principal.tenant_id, principal.controller_id)
        return conn

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
        progress: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        """Renew the lease and record `progress` when sent. Answers what the
        owner sent the operation since (`{"code": ...}`), handed over once, or
        None."""
        await self._controller_operation(session, principal, operation_id)
        now = self.now()
        renewed = await self.operations.renew_lease(
            session,
            principal.tenant_id,
            operation_id,
            now + OPERATION_LEASE,
            progress,
        )
        if renewed is None:
            current = await self._controller_operation(session, principal, operation_id)
            raise self._no_longer_yours(current)
        given = await self.operations.take_input(
            session, principal.tenant_id, operation_id, now
        )
        await session.commit()
        return given

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
        leases = await self.leases(session)
        return [
            controller_view(
                controller,
                self.state_of(controller, leases),
                leases,
                self.settings.controller_release,
            )
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
        that is the name the room is told when the machine is offline. A cloud
        device is Switch's to name (`refuse_cloud`).
        """
        controller = await self.owned_controller(
            session, tenant_id, owner_id, controller_id
        )
        refuse_cloud(controller, "renamed")
        return await self._update_details(session, tenant_id, controller_id, changes)

    async def update_own_controller(
        self,
        session: AsyncSession,
        principal: ControllerPrincipal,
        changes: dict[str, Any],
    ) -> dict[str, Any]:
        """The controller renames itself or changes its description, with the
        same limits and effects as its owner's change, and registers the key its
        provider logins are sealed to.

        A key is registered once: replacing it would let whoever holds the
        controller's credential have the next login sealed to a key of their
        choosing, so a different one is refused and the machine is enrolled
        again instead. The same key again is not a change."""
        controller = await self._principal_controller(session, principal)
        details = dict(changes)
        key = details.pop("public_key", None)
        if isinstance(key, PublicKey):
            wanted = key.model_dump()
            if controller.public_key is None:
                await self.controllers.set_public_key(
                    session, principal.tenant_id, controller.id, wanted
                )
                logger.info("Agent controller %s registered its key", controller.id)
            elif controller.public_key != wanted:
                raise ManagementError(
                    409,
                    reason_codes.VALIDATION_ERROR,
                    "This controller already has a different public key. Enroll "
                    "the device again to give it a new one.",
                )
        if not details:
            leases = await self.leases(session)
            view = controller_view(
                controller,
                self.state_of(controller, leases),
                leases,
                self.settings.controller_release,
            )
            await session.commit()
            return view
        return await self._update_details(
            session, principal.tenant_id, principal.controller_id, details
        )

    async def _update_details(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_id: str,
        changes: dict[str, str | None],
    ) -> dict[str, Any]:
        controller = await self.controllers.update_details(
            session, tenant_id, controller_id, changes
        )
        leases = await self.leases(session)
        view = controller_view(
            controller,
            self.state_of(controller, leases),
            leases,
            self.settings.controller_release,
        )
        owner_id = controller.owner_id
        await session.commit()
        self.user_changes.publish(tenant_id, owner_id, MACHINE, controller_id)
        if "name" in changes:
            self.presence.rename_controller(controller_id, controller.name)
            self.signals.renamed(tenant_id, controller_id)
        logger.info(
            "Updated agent controller %s (%s)",
            controller_id,
            ", ".join(sorted(changes)),
        )
        return view

    async def revoke_controller(
        self, session: AsyncSession, tenant_id: str, owner_id: str, controller_id: str
    ) -> None:
        """Revoke the owner's controller, as `remove_controller` does, a cloud
        device's too: its machine enrolls a new controller in its place, which
        the agents move onto. For taking everything of a person's away, when
        their account goes."""
        controller = await self.owned_controller(
            session, tenant_id, owner_id, controller_id
        )
        await self._remove(session, tenant_id, controller)

    async def remove_controller(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_id: str,
        *,
        owner_id: str | None,
    ) -> None:
        """Remove a device: revoke it, and take its agents off it.

        With `owner_id`, only that person's device, 404 for anyone else's;
        without, anyone's, for a caller that has made sure it may (an admin of
        the workspace, or of its organization). A cloud device is not removed
        here (`refuse_cloud`).
        """
        controller = (
            await self.controllers.get(session, tenant_id, controller_id)
            if owner_id is None
            else await self.owned_controller(
                session, tenant_id, owner_id, controller_id
            )
        )
        if controller is None:
            raise not_found("Controller")
        refuse_cloud(controller, "removed")
        await self._remove(session, tenant_id, controller)

    async def _remove(
        self, session: AsyncSession, tenant_id: str, controller: AgentController
    ) -> None:
        """Revoke: delete the credential, cancel open operations, and nudge.

        Its agents stop, and are taken off it: placed nowhere until their owner
        places them again. A cloud device's machine enrolls again instead, and
        the agents move onto the controller it enrolls (`enroll`).
        """
        # Two removals take turns, so only the first revokes and takes the
        # agents off.
        locked = await self.controllers.locked(session, tenant_id, controller.id)
        if locked is None:
            return
        if locked.revoked_at is not None:
            if locked.revoked_by is None:
                # Already revoked for good: nothing to do.
                return
            # Revoked by a pause or turn-off: the owner's removal now wins, so
            # no resume may wake its box again. Whatever the switch says,
            # so a removal while v2 is off still holds once it's on again.
            await self._revoke(session, tenant_id, locked.id)
            await session.commit()
            return
        controller = locked
        controller_id, owner_id = controller.id, controller.owner_id
        await self._revoke(session, tenant_id, controller_id)
        detached: list[AgentDefinitionRow] = []
        machine = None
        if controller.kind == "ec2":
            machine = await enroll_revoked_again(session, controller_id, self.now())
        else:
            detached = await self._detach_placed(session, tenant_id, controller)
        await session.commit()
        self.user_changes.publish(tenant_id, owner_id, MACHINE, controller_id)
        for row in detached:
            self.user_changes.publish(
                tenant_id, row.owner_id, MANAGED_AGENT, row.agent_id
            )
        logger.info(
            "Revoked agent controller %s, taking %d agent(s) off it",
            controller_id,
            len(detached),
        )
        if machine is not None:
            logger.info(
                "Cloud machine %s enrolls a new controller for workspace %s at revision %s",
                machine.id,
                tenant_id,
                machine.revision,
            )
        self._announce_revoked(controller_id)
        for row in detached:
            await self._bind(session, tenant_id, row)

    async def _detach_placed(
        self, session: AsyncSession, tenant_id: str, controller: AgentController
    ) -> list[AgentDefinitionRow]:
        """Take every agent off `controller`, as they were otherwise. A
        workspace it made for one means nothing on the next device, so the
        definition stops naming it. The caller commits, then unbinds them."""
        detached = []
        for row, _agent in await self.definitions.list_for_controller(
            session, tenant_id, controller.id
        ):
            definition = dict(row.definition)
            directory = definition.get("directory")
            if isinstance(directory, str) and _inside_workspaces(controller, directory):
                definition["directory"] = None
            detached.append(
                await self.definitions.update(
                    session,
                    tenant_id,
                    row.agent_id,
                    controller_id=None,
                    desired_state=row.desired_state,
                    definition=definition,
                    expected_revision=None,
                )
            )
        return detached

    async def _record_auto_approve(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        agent_id: str,
        agent_name: str,
        change: str,
    ) -> None:
        _, acting_agent_id = request_actor()
        await record_audit_event(
            session,
            tenant_id=tenant_id,
            actor_user_id=owner_id,
            action=AuditAction.AGENT_AUTO_APPROVE_ENABLED,
            target_type="agent",
            target_id=agent_id,
            details={
                "agent_name": agent_name,
                "change": change,
                "acting_agent_id": acting_agent_id,
            },
        )

    async def _record_enrolled(
        self, session: AsyncSession, controller: AgentController, *, via: str
    ) -> None:
        await record_audit_event(
            session,
            tenant_id=controller.tenant_id,
            actor_user_id=controller.owner_id,
            action=AuditAction.CONTROLLER_ENROLLED,
            target_type="controller",
            target_id=controller.id,
            details={
                "name": controller.name,
                "kind": controller.kind,
                "via": via,
            },
        )

    async def _revoke(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_id: str,
        revoked_by: Literal["pause", "turn_off"] | None = None,
    ) -> None:
        """Mark revoked, delete the credential, cancel open operations and
        drop sealed logins. The caller commits, then announces it.

        `revoked_by` is only for an operator's pause or an admin's turn-off:
        a message after the lift may then wake the hosted box to enrol a new
        controller. Every other caller leaves it None,
        which also clears the mark on a row a pause already revoked, so a path
        added later is safe without knowing about it."""
        await revoke_controller_rows(
            session,
            tenant_id,
            controller_id,
            now=self.now(),
            controllers=self.controllers,
            api_keys=self.api_keys,
            operations=self.operations,
            revoked_by=revoked_by,
        )

    async def _move_placed(
        self, session: AsyncSession, tenant_id: str, source: str, target: str
    ) -> list[AgentDefinitionRow]:
        """Place every agent of `source` on `target`, as they were. The caller
        commits, then binds them."""
        moved = []
        for row, _agent in await self.definitions.list_for_controller(
            session, tenant_id, source
        ):
            moved.append(
                await self.definitions.update(
                    session,
                    tenant_id,
                    row.agent_id,
                    controller_id=target,
                    desired_state=row.desired_state,
                    definition=row.definition,
                    expected_revision=None,
                )
            )
        return moved

    def _announce_revoked(self, controller_id: str) -> None:
        self.signals.revoked(controller_id)

    async def revoke_controllers(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_ids: list[str],
        revoked_by: Literal["pause", "turn_off"] | None = None,
    ) -> None:
        """Revoke these controllers as a replaced one is revoked on enrolment,
        for an operator's pause and an admin's per-person switch. The caller
        commits, then calls `announce_revoked`: each live
        stream then gets `credential.revoked`, and its box controller stops its
        agents and exits."""
        for controller_id in controller_ids:
            await self._revoke(session, tenant_id, controller_id, revoked_by)

    def announce_revoked(self, controller_ids: list[str]) -> None:
        for controller_id in controller_ids:
            self._announce_revoked(controller_id)

    # ── Provider logins sealed to a controller ────────────────────────────────

    async def list_sealed_logins(
        self, session: AsyncSession, tenant_id: str, owner_id: str, controller_id: str
    ) -> list[dict[str, Any]]:
        await self.owned_controller(session, tenant_id, owner_id, controller_id)
        rows = await self.controllers.sealed_logins(session, tenant_id, controller_id)
        return [sealed_login_view(row) for row in rows]

    async def give_sealed_login(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        controller_id: str,
        provider: str,
        sealed: SealedLogin,
    ) -> dict[str, Any]:
        """Give the owner's machine a provider login the owner's client sealed
        to it, and have the controller take it up now: a `provider.login`
        operation, whose result says whether the provider signs in with it."""
        controller = await self._sealing_target(
            session, tenant_id, owner_id, controller_id, provider
        )
        await _refuse_while_migrating(session, tenant_id, controller_id)
        public_key = controller.public_key
        if public_key is None:
            raise ManagementError(
                409,
                reason_codes.VALIDATION_ERROR,
                "This device has no key to seal a login to yet. Update its "
                "controller, which registers one when it next runs.",
            )
        if sealed.key_id != key_id(public_key["key"]):
            raise ManagementError(
                409,
                reason_codes.VALIDATION_ERROR,
                "The login was sealed to a key this device no longer has. Seal "
                "it again to the key the device shows now.",
            )
        row = await self.controllers.put_sealed_login(
            session,
            tenant_id,
            controller_id,
            provider,
            sealed.model_dump(),
            owner_id,
        )
        login = sealed_login_view(row)
        operation = await self.operations.create(
            session,
            controller_id=controller_id,
            agent_id=None,
            kind="provider.login",
            params={"provider": provider, "method": "sealed", "revision": row.revision},
            created_by=owner_id,
        )
        view = operation_view(operation)
        await session.commit()
        logger.info(
            "Gave agent controller %s a sealed %s login (revision %s)",
            controller_id,
            provider,
            row.revision,
        )
        self.signals.operation_pending(
            controller_id,
            operation_id=operation.id,
            kind="provider.login",
            agent_id=None,
        )
        return {"login": login, "operation": view}

    async def start_browser_login(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        controller_id: str,
        provider: str,
    ) -> dict[str, Any]:
        """Have the owner's machine sign `provider` in through a browser: a
        `provider.login` operation with `method: "browser"`, in which the
        controller runs the provider's own sign-in, reports the page to open
        as progress, takes a code pasted back (`give_sign_in_code`) when the
        page shows one, and keeps the login it ends with as a login given to
        it, sealed to its own key (`keep_browser_login`). A sign-in already
        running for the provider there is cancelled: only the newest stands."""
        controller = await self._sealing_target(
            session, tenant_id, owner_id, controller_id, provider
        )
        await _refuse_while_migrating(session, tenant_id, controller_id)
        offered = CLOUD_BROWSER_SIGN_IN if controller.kind == "ec2" else BROWSER_SIGN_IN
        if provider not in offered:
            raise ManagementError(
                422,
                reason_codes.VALIDATION_ERROR,
                f"{provider} can't be signed in through a browser on this device; "
                "give it a key or token instead.",
            )
        if controller.public_key is None:
            raise ManagementError(
                409,
                reason_codes.VALIDATION_ERROR,
                "This device has no key to keep a login with yet. Update its "
                "controller, which registers one when it next runs.",
            )
        params = {"provider": provider, "method": "browser"}
        replaced = await self.operations.cancel_open_matching(
            session,
            tenant_id,
            controller_id=controller_id,
            kind="provider.login",
            params=params,
        )
        operation = await self.operations.create(
            session,
            controller_id=controller_id,
            agent_id=None,
            kind="provider.login",
            params=params,
            created_by=owner_id,
        )
        view = operation_view(operation)
        await session.commit()
        logger.info(
            "Started a browser sign-in for %s on agent controller %s%s",
            provider,
            controller_id,
            f", replacing {', '.join(replaced)}" if replaced else "",
        )
        self.signals.operation_pending(
            controller_id,
            operation_id=operation.id,
            kind="provider.login",
            agent_id=None,
        )
        return {"operation": view}

    async def give_sign_in_code(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        operation_id: str,
        code: str,
    ) -> None:
        """Send the code the sign-in page showed to the browser sign-in
        waiting for it on the owner's machine. Once per sign-in: a second
        code, or one the sign-in is not waiting for, is refused."""
        operation = await self.operations.get(session, tenant_id, operation_id)
        if operation is None:
            raise not_found("Operation")
        await self.owned_controller(
            session, tenant_id, owner_id, operation.controller_id
        )
        if not _is_browser_login(operation):
            raise ManagementError(
                409,
                reason_codes.VALIDATION_ERROR,
                "That operation is not a browser sign-in.",
            )
        sign_in = (operation.progress or {}).get("sign_in")
        if (
            operation.state != "claimed"
            or not isinstance(sign_in, dict)
            or sign_in.get("needs_code") is not True
        ):
            raise ManagementError(
                409,
                reason_codes.VALIDATION_ERROR,
                "The sign-in is not waiting for a code. Start it again.",
            )
        given = await self.operations.give_input(
            session, tenant_id, operation_id, {"code": code}
        )
        if given is None:
            raise ManagementError(
                409,
                reason_codes.VALIDATION_ERROR,
                "A code was already sent to this sign-in. Start it again to "
                "send another.",
            )
        await session.commit()
        logger.info(
            "Sent a sign-in code to operation %s on agent controller %s",
            operation_id,
            operation.controller_id,
        )

    async def keep_browser_login(
        self,
        session: AsyncSession,
        principal: ControllerPrincipal,
        operation_id: str,
        sealed: SealedLogin,
    ) -> dict[str, Any]:
        """Keep the login a browser sign-in on the machine ended with, sealed
        by the controller to its own key, as a login its owner gave it: the
        controller then takes it up as it would one pasted, and Switch never
        sees inside. Only while the controller holds that sign-in."""
        operation = await self._controller_operation(session, principal, operation_id)
        if not _is_browser_login(operation):
            raise ManagementError(
                409,
                reason_codes.VALIDATION_ERROR,
                "That operation is not a browser sign-in.",
            )
        if operation.state != "claimed":
            raise self._no_longer_yours(operation)
        controller = await self.controllers.get(
            session, principal.tenant_id, principal.controller_id
        )
        if controller is None or controller.public_key is None:
            raise ManagementError(
                409,
                reason_codes.VALIDATION_ERROR,
                "This device has no key registered to keep a login with.",
            )
        if sealed.key_id != key_id(controller.public_key["key"]):
            raise ManagementError(
                409,
                reason_codes.VALIDATION_ERROR,
                "The login is sealed to a key Switch does not hold for this device.",
            )
        provider = operation.params["provider"]
        row = await self.controllers.put_sealed_login(
            session,
            principal.tenant_id,
            principal.controller_id,
            provider,
            sealed.model_dump(),
            operation.created_by,
        )
        await session.commit()
        logger.info(
            "Agent controller %s kept the %s login a browser sign-in ended with "
            "(revision %s)",
            principal.controller_id,
            provider,
            row.revision,
        )
        return sealed_login_view(row)

    async def replace_own_sealed_login(
        self,
        session: AsyncSession,
        principal: ControllerPrincipal,
        provider: str,
        sealed: SealedLogin,
        replaces: int,
    ) -> dict[str, Any]:
        """Keep a login a box's controller renewed itself (a Codex ChatGPT
        sign-in, whose refresh token rotates and is refused once used), sealed
        to its own key, in place of revision `replaces`, which it came from.
        Refused (409) once the owner has given another login or withdrawn it,
        so a renewal never overwrites a newer login. Only a box's controller:
        no other renews a login for its agents."""
        backend = await _controller_backend(
            session, principal.tenant_id, principal.controller_id
        )
        _refuse_box_while_v2_off(backend)
        if backend != "box":
            raise ManagementError(
                403,
                reason_codes.VALIDATION_ERROR,
                "Only a Switch Cloud box keeps a login it renewed itself.",
            )
        controller = await self.controllers.get(
            session, principal.tenant_id, principal.controller_id
        )
        if controller is None or controller.public_key is None:
            raise ManagementError(
                409,
                reason_codes.VALIDATION_ERROR,
                "This device has no key registered to keep a login with.",
            )
        if sealed.key_id != key_id(controller.public_key["key"]):
            raise ManagementError(
                409,
                reason_codes.VALIDATION_ERROR,
                "The login is sealed to a key Switch does not hold for this device.",
            )
        row = await self.controllers.replace_sealed_login(
            session,
            principal.tenant_id,
            principal.controller_id,
            provider,
            sealed.model_dump(),
            replaces,
        )
        if row is None:
            raise ManagementError(
                409,
                reason_codes.VALIDATION_ERROR,
                f"The {provider} login is no longer at revision {replaces}.",
            )
        await session.commit()
        logger.info(
            "Agent controller %s kept the %s login it renewed (revision %s)",
            principal.controller_id,
            provider,
            row.revision,
        )
        return sealed_login_view(row)

    async def withdraw_sealed_login(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        controller_id: str,
        provider: str,
    ) -> None:
        """Take the provider login back, and have the controller check the
        provider again, which stops using it."""
        await self._sealing_target(
            session, tenant_id, owner_id, controller_id, provider
        )
        removed = await self.controllers.delete_sealed_logins(
            session, tenant_id, controller_id, provider
        )
        if not removed:
            raise not_found("Sealed login")
        operation = await self.operations.create(
            session,
            controller_id=controller_id,
            agent_id=None,
            kind="provider.recheck",
            params={"provider": provider},
            created_by=owner_id,
        )
        await session.commit()
        logger.info(
            "Withdrew agent controller %s's sealed %s login", controller_id, provider
        )
        self.signals.operation_pending(
            controller_id,
            operation_id=operation.id,
            kind="provider.recheck",
            agent_id=None,
        )

    async def _sealing_target(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        controller_id: str,
        provider: str,
    ) -> AgentController:
        if provider not in provider_ids():
            raise ManagementError(
                422,
                reason_codes.VALIDATION_ERROR,
                f"Unknown provider {provider!r}; one of "
                f"{', '.join(sorted(provider_ids()))}.",
            )
        controller = await self.owned_controller(
            session, tenant_id, owner_id, controller_id
        )
        if is_revoked(controller):
            raise ManagementError(
                409, reason_codes.CONTROLLER_REVOKED, "The controller has been revoked."
            )
        return controller

    async def own_sealed_login(
        self, session: AsyncSession, principal: ControllerPrincipal, provider: str
    ) -> dict[str, Any]:
        """The controller's sealed login for `provider`, as it opens it. With
        hosted agents v2 off, never to a v2 box's controller."""
        _refuse_box_while_v2_off(
            await _controller_backend(
                session, principal.tenant_id, principal.controller_id
            )
        )
        row = await self.controllers.sealed_login(
            session, principal.tenant_id, principal.controller_id, provider
        )
        if row is None:
            raise ManagementError(
                404,
                reason_codes.PROVIDER_LOGIN_MISSING,
                f"No {provider} login has been given to this device.",
            )
        return {
            "provider": row.provider,
            "revision": row.revision,
            "sealed": row.sealed,
        }

    # ── Managed agents, owner side ────────────────────────────────────────────

    async def _view(
        self,
        session: AsyncSession,
        tenant_id: str,
        row: AgentDefinitionRow,
        agent: Agent,
        controllers: dict[str, AgentController],
        leases: ProcessLeases,
        templates: dict[str, dict[str, Any]] | None = None,
        signals: ReasonSignals | None = None,
    ) -> dict[str, Any]:
        """The managed agent as the API shows it. `templates` is what
        `templates_of_agents` read for a list of agents at once; without it,
        this agent's is read."""
        controller = None
        if row.controller_id is not None:
            controller = controllers.get(row.controller_id)
            if controller is None:
                controller = await self.controllers.get(
                    session, tenant_id, row.controller_id
                )
                if controller is not None:
                    controllers[controller.id] = controller
        if templates is None:
            templates = await _INSTALLS.templates_of_agents(session, [agent.id])
        v2 = process_hosted_v2()
        if signals is None and v2:
            signals = await load_reason_signals(
                session,
                tenant_id,
                [agent.id],
                controller_ids=[controller.id] if controller is not None else [],
                owner_ids=[agent.owner_id] if agent.owner_id else [],
            )
        view = managed_agent_view(
            row,
            agent,
            controller,
            self.state_of(controller, leases) if controller is not None else None,
            templates.get(agent.id),
        )
        if not v2 or signals is None:
            # With hosted agents v2 off, no reason and nothing read for it, as
            # upstream (sweep row 22).
            return view
        # Why it stopped: a fixed code and times, worked out by Core.
        provider = (row.definition or {}).get("provider")
        view["stop_reason"] = agent_stop_reason(
            agent,
            controller,
            leases,
            signals,
            self.now(),
            provider=provider if isinstance(provider, str) else None,
        )
        return view

    async def list_managed_agents(
        self, session: AsyncSession, tenant_id: str, owner_id: str
    ) -> list[dict[str, Any]]:
        controllers = {
            controller.id: controller
            for controller in await self.controllers.list_for_owner(
                session, tenant_id, owner_id
            )
        }
        leases = await self.leases(session)
        rows = await self.definitions.list_for_owner(session, tenant_id, owner_id)
        templates = await _INSTALLS.templates_of_agents(
            session, [agent.id for _, agent in rows]
        )
        # The reasons' signals for every agent at once: four queries, not four
        # per agent. None with hosted agents v2 off: no reasons then.
        signals = (
            await load_reason_signals(
                session,
                tenant_id,
                [agent.id for _, agent in rows],
                controller_ids=list(controllers),
                owner_ids=[owner_id],
            )
            if process_hosted_v2()
            else None
        )
        return [
            await self._view(
                session, tenant_id, row, agent, controllers, leases, templates, signals
            )
            for row, agent in rows
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
        return await self._view(
            session, tenant_id, row, agent, {}, await self.leases(session)
        )

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
        if check_placement and controller.kind == "ec2":
            await _refuse_for_box(
                session,
                await _controller_backend(session, tenant_id, controller.id),
                controller.owner_id,
                tenant_id,
            )
        if check_placement:
            # Placing an agent on a sleeping Switch Cloud machine wakes it.
            machine = (
                await wake_controller_machine(
                    session, controller.id, self.now(), "agent_placed"
                )
                if controller.kind == "ec2"
                else None
            )
            require_placement(
                controller,
                provider,
                leases=await self.leases(session),
                now=self.now(),
                interval_seconds=self.settings.status_interval_seconds,
                waking=machine is not None
                and machine.desired_state == "running"
                and machine.state != "ready",
            )
        return controller

    async def _bump_and_collect(
        self, session: AsyncSession, tenant_id: str, controller_ids: set[str | None]
    ) -> dict[str, int]:
        revisions: dict[str, int] = {}
        for controller_id in sorted(c for c in controller_ids if c is not None):
            revisions[controller_id] = await self.controllers.bump_assignment_revision(
                session, tenant_id, controller_id
            )
        return revisions

    def _nudge(self, tenant_id: str, revisions: dict[str, int]) -> None:
        for controller_id, revision in revisions.items():
            self.signals.assignment_changed(tenant_id, controller_id, revision)

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
        self.presence.bind(
            binding_of(
                tenant_id,
                row,
                controller,
                workspace_archived=await is_archived(session, tenant_id),
                agent_suspended=await self.definitions.agent_suspended(
                    session, tenant_id, row.agent_id
                ),
            )
        )

    async def _refuse_archived(self, session: AsyncSession, tenant_id: str) -> None:
        """Refuse setting up a new device or managed agent in an archived
        workspace, which would never run there. A Switch cloud machine that
        already serves it is left to its own flow (`machine_enrollment_code`):
        refusing it would put the machine in an error state its owner's other
        workspaces share, while its agents are assigned stopped regardless."""
        if await is_archived(session, tenant_id):
            raise ManagementError(
                409, reason_codes.WORKSPACE_ARCHIVED, WORKSPACE_ARCHIVED
            )

    async def workspace_archive_changed(
        self, session: AsyncSession, tenant_id: str
    ) -> None:
        """The workspace was archived or restored, and that has committed:
        each of its controllers fetches its assignment again, which now has
        every agent stopped or as its owner set it (`assignment_entry`), and
        Core's bindings follow, here and in every other process."""
        controller_ids: set[str | None] = set(
            await session.scalars(
                select(AgentController.id).where(
                    AgentController.tenant_id == tenant_id,
                    AgentController.revoked_at.is_(None),
                )
            )
        )
        revisions = await self._bump_and_collect(session, tenant_id, controller_ids)
        placed = await self.definitions.list_placed(session, tenant_id)
        await session.commit()
        for row in placed:
            await self._bind(session, tenant_id, row)
        self._nudge(tenant_id, revisions)

    async def agents_suspension_changed(
        self,
        session: AsyncSession,
        tenant_id: str,
        agent_ids: list[str],
        revisions: dict[str, int],
    ) -> None:
        """The agents were suspended or let back in, and that has committed
        with their controllers' revisions moved on (`accounts/suspension.py`):
        Core's bindings follow, here and in every other process, and each
        controller pulls its assignment, which has a suspended agent stopped
        and any other as its owner set it (`assignment_entry`)."""
        rows = [
            row
            for agent_id in agent_ids
            if (
                row := await self.definitions.get_for_agent(
                    session, tenant_id, agent_id
                )
            )
            is not None
            and row.controller_id is not None
        ]
        for row in rows:
            await self._bind(session, tenant_id, row)
        await session.commit()
        self._nudge(tenant_id, revisions)

    def owner_suspended(self, controller_ids: list[str]) -> None:
        """The controllers' owner was suspended, and that has committed: each
        controller's stream ends, here and in every other process, and it is
        refused until the suspension is lifted (`management/auth.py`). Not a
        revocation: its credential stays, and lets it back in after."""
        for controller_id in controller_ids:
            self.signals.owner_suspended(controller_id)

    async def check_new_managed_agent(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        request: CreateManagedAgentRequest,
    ) -> None:
        """The checks `create_managed_agent` makes before it registers
        anything, raising as it would, with nothing created."""
        await self._refuse_archived(session, tenant_id)
        self._require_offered(request.definition.provider)
        await self._check_target(
            session,
            tenant_id,
            owner_id,
            request.controller_id,
            request.definition.provider,
            check_placement=True,
        )
        try:
            normalise_icon_url(request.icon_url)
        except InvalidIconUrl as exc:
            raise ManagementError(422, reason_codes.VALIDATION_ERROR, str(exc)) from exc

    async def create_managed_agent(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        request: CreateManagedAgentRequest,
        protocol: AgentCore,
    ) -> dict[str, Any]:
        """Register a new agent through the known-agent spec for its provider,
        and place it. Placement is checked before anything is registered, so a
        refusal leaves nothing behind."""
        await self._refuse_archived(session, tenant_id)
        self._require_offered(request.definition.provider)
        controller = await self._check_target(
            session,
            tenant_id,
            owner_id,
            request.controller_id,
            request.definition.provider,
            check_placement=True,
        )
        definition = with_directory(request.definition, controller, request.name)
        try:
            icon_url = drop_third_party_avatar(
                normalise_icon_url(request.icon_url),
                third_party_avatars=self.settings.third_party_avatars,
            )
            if icon_url is None and self.settings.third_party_avatars:
                icon_url = new_icon_url(request.name)
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
            )
        except AgentExistsError as exc:
            raise ManagementError(409, reason_codes.VALIDATION_ERROR, str(exc)) from exc
        except ValueError as exc:
            raise ManagementError(422, reason_codes.VALIDATION_ERROR, str(exc)) from exc
        row = await self.definitions.create(
            session,
            agent_id=result.agent_id,
            owner_id=owner_id,
            controller_id=request.controller_id,
            desired_state=request.desired_state,
            definition=definition.model_dump(),
        )
        if definition.auto_approve:
            await self._record_auto_approve(
                session, tenant_id, owner_id, result.agent_id, request.name, "created"
            )
        revisions = await self._bump_and_collect(
            session, tenant_id, {request.controller_id}
        )
        await session.commit()
        self.user_changes.publish(tenant_id, owner_id, MANAGED_AGENT, result.agent_id)
        await self._bind(session, tenant_id, row)
        self._nudge(tenant_id, revisions)
        logger.info(
            "Created managed agent %s on controller %s",
            result.agent_id,
            request.controller_id,
        )
        agent = await self._owned_agent(session, owner_id, result.agent_id)
        return await self._view(
            session, tenant_id, row, agent, {}, await self.leases(session)
        )

    async def put_managed_agent(
        self,
        session: AsyncSession,
        tenant_id: str,
        owner_id: str,
        agent_id: str,
        target: _Placement,
        protocol: AgentCore,
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
            expected_revision=None,
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
        expected_revision: int | None,
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
            expected_revision=expected_revision,
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
        expected_revision: int | None,
    ) -> dict[str, Any]:
        """Write `target` over `existing`. With `expected_revision`, only
        while the definition is still at that revision (`DefinitionChanged`
        otherwise), for a change worked out from what it was."""
        definition = DefinitionV1.model_validate(target.definition)
        # Read now: updating the definition writes over `existing` in place.
        was_auto_approve = existing is not None and bool(
            existing.definition.get("auto_approve")
        )
        if (
            existing is None
            or existing.definition.get("provider") != definition.provider
        ):
            self._require_offered(definition.provider)
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
            # The old machine's workspace for the agent means nothing on the
            # new one. Matched on the workspaces folder rather than the exact
            # path, because a rename pins the folder under the agent's old name.
            if _inside_workspaces(previous, directory):
                directory = None
        if directory is None:
            directory = default_directory(controller, agent.name)
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
            return await self._view(
                session, tenant_id, existing, agent, {}, await self.leases(session)
            )

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
                expected_revision=expected_revision,
            )
            affected = {previous_controller_id, target.controller_id}
            if previous_controller_id is not None and moved:
                await self.operations.cancel_open(
                    session,
                    tenant_id,
                    controller_id=previous_controller_id,
                    agent_id=agent.id,
                )
        if target.definition.get("auto_approve") and not was_auto_approve:
            await self._record_auto_approve(
                session,
                tenant_id,
                owner_id,
                agent.id,
                agent.name,
                "adopted" if existing is None else "updated",
            )
        revisions = await self._bump_and_collect(session, tenant_id, affected)
        await session.commit()
        self.user_changes.publish(tenant_id, owner_id, MANAGED_AGENT, agent.id)
        await self._bind(session, tenant_id, row)
        self._nudge(tenant_id, revisions)
        agent = await self._owned_agent(session, owner_id, agent.id)
        return await self._view(
            session, tenant_id, row, agent, {}, await self.leases(session)
        )

    async def delete_managed_agent(
        self,
        session: AsyncSession,
        tenant_id: str,
        agent_id: str,
        *,
        owner_id: str | None,
    ) -> None:
        """Stop managing the agent. Its controller stops it; the agent itself
        is not deleted.

        With `owner_id`, only that person's agent, 404 for anyone else's;
        without, anyone's, for a caller that has made sure it may (an admin of
        the workspace, or of its organization)."""
        if owner_id is None:
            found = await self.definitions.get_for_agent(session, tenant_id, agent_id)
            if found is None:
                raise not_found("Managed agent")
            row = found
        else:
            row, _agent = await self._owned_definition(
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
        self.user_changes.publish(tenant_id, row.owner_id, MANAGED_AGENT, agent_id)
        self.presence.unbind(agent_id, DETACH_UNASSIGNED)
        self._nudge(tenant_id, revisions)

    async def agent_renamed(
        self, session: AsyncSession, tenant_id: str, agent_id: str, old_name: str
    ) -> None:
        """Hand a renamed agent's new name to the machine that runs it.

        The assignment carries the agent's name live, so all a rename needs is
        a new revision for the controller to pull. A definition naming no
        directory would have the controller derive the workspace from the name,
        moving the agent to an empty folder, so the old one is pinned first.
        """
        row = await self.definitions.get_for_agent(session, tenant_id, agent_id)
        if row is None:
            return
        definition = dict(row.definition)
        if definition.get("directory") is None and row.controller_id is not None:
            controller = await self.controllers.get(
                session, tenant_id, row.controller_id
            )
            directory = default_directory(controller, old_name)
            if directory is not None:
                definition["directory"] = directory
        await self.definitions.update(
            session,
            tenant_id,
            agent_id,
            controller_id=row.controller_id,
            desired_state=row.desired_state,
            definition=definition,
            expected_revision=None,
        )
        revisions = await self._bump_and_collect(
            session, tenant_id, {row.controller_id}
        )
        await session.commit()
        self._nudge(tenant_id, revisions)
        logger.info("Told the controller of agent %s about its new name", agent_id)

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
        self.user_changes.publish(tenant_id, row.owner_id, MANAGED_AGENT, agent_id)
        self.presence.unbind(agent_id, DETACH_DELETED)
        self._nudge(tenant_id, revisions)
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
        if is_revoked(controller):
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
        elif kind == "controller.restart":
            # The controller process itself, for a fix that only a fresh start
            # picks up. A controller too old to know the kind fails it, saying
            # so, rather than doing anything else.
            if agent_id is not None or params:
                raise ManagementError(
                    422,
                    reason_codes.VALIDATION_ERROR,
                    "controller.restart takes no agent_id and no params.",
                )
        else:
            provider = params.get("provider")
            if (
                agent_id is not None
                or provider not in provider_ids()
                or set(params) != {"provider"}
            ):
                raise ManagementError(
                    422,
                    reason_codes.VALIDATION_ERROR,
                    "provider.recheck takes no agent_id and params.provider naming "
                    f"one of {', '.join(sorted(provider_ids()))}.",
                )
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
        self.signals.operation_pending(
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


# Why a connection ended for good: a socket going for any of these leaves
# nothing to reattach to, and the controller opens another.
_ENDING_REASONS = frozenset(
    {HEARTBEAT_LAPSED.code, TAKEN_OVER.code, DISCONNECT_REVOKED}
)


def _resume_cursors(recorded: dict[str, Any] | None) -> dict[str, int | None]:
    """The cursors recorded with a connection, as the presence holds them."""
    if not recorded:
        return {}
    return {
        agent_id: cursor if isinstance(cursor, int) else None
        for agent_id, cursor in recorded.items()
    }


def _is_browser_login(operation: AgentControllerOperation) -> bool:
    return (
        operation.kind == "provider.login"
        and operation.params.get("method") == "browser"
    )


def refuse_cloud(controller: AgentController, done: str) -> None:
    """Raise unless `controller` is one its owner names and removes. Switch
    does that for a cloud device: it serves its owner in every workspace they
    hold one in, and comes and goes with its machine."""
    if controller.kind == "ec2":
        raise ManagementError(
            409,
            reason_codes.CLOUD_MANAGED,
            f"Switch manages cloud devices, so this one can't be {done}.",
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


def _inside_workspaces(controller: AgentController | None, directory: str) -> bool:
    """Whether `directory` is one of the workspaces `controller` makes for its
    agents: a folder directly inside its workspaces folder."""
    if controller is None:
        return False
    root = workspaces_dir_of(controller)
    if root is None:
        return False
    platform = controller.platform or {}
    if platform.get("os") == "windows":
        return bool(ntpath.dirname(ntpath.normpath(directory)) == ntpath.normpath(root))
    return posixpath.dirname(posixpath.normpath(directory)) == posixpath.normpath(root)


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
) -> tuple[KnownAgent, Any, dict[str, Any]]:
    """The known-agent spec, options and metadata a definition registers with.

    Options the definition does not speak to (Claude Code's `channels_enabled`,
    say) keep whatever the agent already had. An agent already registered as
    a different known type is refused rather than silently converted.
    """
    spec = provider_known_agent(definition.provider)
    known_type = spec.provider.known_agent_type
    metadata = dict(existing_metadata) if isinstance(existing_metadata, dict) else {}
    current_type = metadata.get("known_agent_type")
    if current_type is not None and current_type != known_type:
        raise ManagementError(
            409,
            reason_codes.VALIDATION_ERROR,
            f"This agent is registered as {current_type!r}, which does not run "
            f"provider {definition.provider!r}.",
        )
    current_options = metadata.get("known_agent_options")
    raw_options = dict(current_options) if isinstance(current_options, dict) else {}
    raw_options["auto_session"] = True
    raw_options["repo_dir"] = definition.directory
    options = spec.parse_options(raw_options)
    metadata["known_agent_type"] = known_type
    metadata["known_agent_options"] = options.model_dump()
    return spec, options, metadata


# Status fields that change on every report whether or not anything happened.
_VOLATILE_MACHINE = ("disk_free_bytes", "mem_free_bytes")


def _status_signature(status: dict[str, Any] | None) -> dict[str, Any] | None:
    """A status report without the fields that move on every report, so two
    reports compare equal when nothing a person would see has changed."""
    if status is None:
        return None
    signature = {k: v for k, v in status.items() if k not in ("seq", "observed_at")}
    machine = signature.get("machine")
    if isinstance(machine, dict):
        signature["machine"] = {
            k: v for k, v in machine.items() if k not in _VOLATILE_MACHINE
        }
    providers = signature.get("providers")
    if isinstance(providers, list):
        signature["providers"] = [
            {k: v for k, v in p.items() if k != "checked_at"}
            if isinstance(p, dict)
            else p
            for p in providers
        ]
    return signature


# One reader for the machine behind a controller, shared with the switch.
_controller_backend = controller_backend


def _refuse_box_while_v2_off(backend: str | None) -> None:
    """The v1/v2 switch: with hosted agents v2 off, a v2 box's controller is
    refused: no enrolment, no token, no reconnect, no sealed login, no
    placement. A v1 machine's, and a person's own computer's, as before."""
    if backend == "box" and not process_hosted_v2():
        from switch_core.providers.hosted import NOT_AVAILABLE

        raise ManagementError(403, reason_codes.HOSTED_V2_OFF, NOT_AVAILABLE)


async def _machine_code_lifetime(
    session: AsyncSession, workspace: MachineWorkspace
) -> timedelta:
    """15 minutes for a v2 box's code; upstream's 30 for a v1
    machine's, and for any with v2 off, with nothing read (sweep row 18)."""
    if not process_hosted_v2():
        return tokens.V1_MACHINE_ENROLLMENT_CODE_LIFETIME
    backend = await session.scalar(
        select(CloudMachine.backend).where(CloudMachine.id == workspace.machine_id)
    )
    if backend == "box":
        return tokens.MACHINE_ENROLLMENT_CODE_LIFETIME
    return tokens.V1_MACHINE_ENROLLMENT_CODE_LIFETIME


async def _refuse_for_box(
    session: AsyncSession, backend: str | None, owner_id: str, tenant_id: str
) -> None:
    """The v1/v2 switch at a controller's doors: with v2 off a box is refused
    (`hosted_v2_off`); with it on, a box is refused while its owner is paused or
    turned off. Pause and turn-off are v2 powers over boxes, so a v1 machine and
    a person's own computer are never refused here."""
    _refuse_box_while_v2_off(backend)
    if backend == "box":
        await _refuse_if_blocked(session, owner_id, tenant_id)


async def _refuse_while_migrating(
    session: AsyncSession, tenant_id: str, controller_id: str
) -> None:
    """No login is given to a machine an operator is moving from v1 to a v2
    box, until the move is done: 409 `migration_in_progress` (the migration
    design). With hosted agents v2 off there is no move, as before v2."""
    if not process_hosted_v2():
        return
    machine_id = await session.scalar(
        select(MachineWorkspace.machine_id).where(
            MachineWorkspace.tenant_id == tenant_id,
            (MachineWorkspace.controller_id == controller_id)
            | (MachineWorkspace.moving_from_controller_id == controller_id),
        )
    )
    if machine_id is None:
        return
    moving = await session.scalar(
        select(HostedMigration.step).where(
            HostedMigration.machine_id == machine_id,
            HostedMigration.step.not_in(("done", "rolled_back", "cleaned")),
        )
    )
    if moving is not None:
        raise ManagementError(
            409,
            reason_codes.HOSTED_MIGRATING,
            "migration_in_progress",
        )


async def _refuse_if_blocked(
    session: AsyncSession, owner_id: str, tenant_id: str
) -> None:
    """Refuse a cloud box's controller work for an owner an operator paused, or
    a workspace admin turned off here. With hosted agents v2
    off, nothing to refuse, as before v2."""
    if not process_hosted_v2():
        return
    from switch_core.visibility.hosted_access import block_reason_in
    from switch_core.visibility.reason_codes import StopReason

    blocked = await block_reason_in(session, owner_id, tenant_id)
    if blocked is StopReason.PAUSED_BY_SWITCH:
        raise ManagementError(
            403, reason_codes.HOSTED_PAUSED, "Hosted agents are paused for this user."
        )
    if blocked is StopReason.TURNED_OFF_BY_ADMIN:
        raise ManagementError(
            403,
            reason_codes.HOSTED_TURNED_OFF,
            "Hosted agents are turned off for this user in this workspace.",
        )
