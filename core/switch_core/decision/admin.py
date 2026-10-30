"""A workspace's decision settings as its admins see and change them.

One implementation behind both doors: the gateway's `/decision-settings`
routes (`gateway/decision_settings.py`, behind `require_tenant_admin`) and
the agent operations an agent runs for its owner (`get_decision_routing`,
`set_decision_routing`). Each caller has checked that whoever acts
administers the workspace; what is checked here is everything else, the
machine above all: a machine can be chosen only by its owner, from their own
machines enrolled in this workspace, and only with a model it offers.

The key is never returned; a key the server can no longer decrypt still
loads, as set but unreadable, so an admin can save a replacement.

Choosing a machine, moving off one or changing its model bumps the
assignment revision of every controller it affects and, once committed,
nudges them, so the machine starts or stops its model at once
(`DynamicDecisionClient.nudge`).
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, cast

from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.decision.machine import (
    choice_refusal,
    decision_status,
    is_connected,
    is_removed,
    machine_option,
)
from switch_core.decision.settings import availability, resolve
from switch_core.gateway.schemas import (
    DecisionEffective,
    DecisionMachineOption,
    DecisionMachineProgress,
    DecisionMachineState,
    DecisionMachineSupport,
    DecisionOptions,
    DecisionServerDefault,
    DecisionSettingsResponse,
    DecisionSettingsTestRequest,
    DecisionSettingsUpdateRequest,
    DecisionTestError,
    DecisionTestResponse,
    DecisionWorkspaceSettings,
    TestErrorCode,
)
from switch_core.keys import UndecryptableError
from switch_core.outbound import OutboundURLRefused
from switch_core.process_lease import ProcessLeases, read_leases

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.db.models import AgentController, DecisionSettings
    from switch_core.decision.client import DynamicDecisionClient, TestOutcome
    from switch_core.decision.machine import MachineChoice
    from switch_core.keys import Keyring

logger = logging.getLogger(__name__)

_PROCESSES = SwitchCoreProcessStore()


class DecisionSettingsRefused(ValueError):
    """A save or test the server won't make; the message says why, for the
    person who asked."""


# ── Reading ───────────────────────────────────────────────────────────────────


def _machine_view(machine: MachineChoice) -> DecisionMachineState:
    progress = machine.progress
    return DecisionMachineState(
        id=machine.id,
        name=machine.name,
        model=machine.model,
        state=machine.state,
        progress=(
            DecisionMachineProgress(
                done_bytes=progress["done_bytes"], total_bytes=progress["total_bytes"]
            )
            if progress is not None
            and isinstance(progress.get("done_bytes"), int)
            and isinstance(progress.get("total_bytes"), int)
            else None
        ),
        ready=machine.ready,
        connected=bool(machine.connected),
        since=machine.since,
        reason=machine.reason,
        last_decision_ms=machine.last_decision_ms,
    )


def _workspace_view(
    row: DecisionSettings, keyring: Keyring
) -> DecisionWorkspaceSettings:
    last4: str | None = None
    unreadable = False
    if row.api_key_encrypted is not None:
        try:
            last4 = keyring.decrypt(row.api_key_encrypted)[-4:]
        except UndecryptableError:
            unreadable = True
            logger.warning(
                "Workspace %s's decision key is not decryptable under any "
                "current key; reporting it as set but unreadable.",
                row.tenant_id,
            )
    return DecisionWorkspaceSettings(
        backend=row.backend,  # type: ignore[arg-type]
        endpoint=row.endpoint,
        threshold=row.threshold,
        has_api_key=row.api_key_encrypted is not None,
        api_key_last4=last4,
        api_key_unreadable=unreadable,
        updated_at=row.updated_at.isoformat(),
        machine_id=row.controller_id,
        model=row.model,
    )


def _option(
    controller: AgentController, leases: ProcessLeases
) -> DecisionMachineOption:
    option = machine_option(controller, is_connected(controller, leases))
    return DecisionMachineOption(
        id=option["id"],
        name=option["name"],
        connected=option["connected"],
        decision=DecisionMachineSupport(**option["decision"]),
    )


async def settings_view(
    session: AsyncSession,
    client: DynamicDecisionClient,
    keyring: Keyring,
    *,
    tenant_id: str,
    user_id: str,
) -> DecisionSettingsResponse:
    """What the workspace uses and why, its saved choice, the server
    default, and what `user_id` may choose: the Haiku backends the server
    offers, and their own machines here."""
    checks = client.availability
    server = checks.server
    row = await checks.store.get(session, tenant_id)
    controller = await checks.controller_of(session, row)
    leases = await read_leases(session, _PROCESSES)
    connected = (
        is_connected(controller, leases)
        if controller is not None
        else (False if row is not None and row.backend == "machine" else None)
    )
    resolved = resolve(row, server, controller, connected)
    applies = availability(checks.enabled, resolved)
    mine = await checks.controllers.list_for_owner(session, tenant_id, user_id)
    return DecisionSettingsResponse(
        source=resolved.source,
        effective=DecisionEffective(
            backend=resolved.backend,
            endpoint=resolved.endpoint,
            threshold=resolved.threshold,
            available=applies.available,
            reason=applies.reason,
            machine=(
                _machine_view(resolved.machine)
                if resolved.machine is not None
                else None
            ),
        ),
        workspace=_workspace_view(row, keyring) if row is not None else None,
        server_default=DecisionServerDefault(
            configured=server.configured,
            endpoint=server.endpoint_url,
            has_api_key=server.api_key is not None,
        ),
        options=DecisionOptions(
            haiku_anthropic=server.haiku_anthropic,
            haiku_bedrock=server.haiku_bedrock,
            machines=[_option(c, leases) for c in mine if not is_removed(c)],
        ),
    )


# ── Changing ──────────────────────────────────────────────────────────────────


def _refuse_unoffered(
    req: DecisionSettingsUpdateRequest, client: DynamicDecisionClient
) -> None:
    server = client.server
    if req.backend == "haiku_anthropic" and not server.haiku_anthropic:
        raise DecisionSettingsRefused(
            "Haiku runs in the server's decision service, and this server "
            "has none configured."
        )
    if req.backend == "haiku_bedrock" and not server.haiku_bedrock:
        raise DecisionSettingsRefused(
            "Haiku on Bedrock isn't offered on this server: it needs the "
            "server's decision service and DECISION_BEDROCK_ENABLED."
        )


async def _refuse_unreachable(endpoint: str, client: DynamicDecisionClient) -> None:
    """Refuse an endpoint the server would never connect to on the
    workspace's behalf: link-local and metadata addresses always, and private
    ones unless the operator lists them."""
    try:
        await client.outbound_policy.check_url(endpoint)
    except OutboundURLRefused as refused:
        raise DecisionSettingsRefused(
            f"{refused} A workspace's decision endpoint must be a public "
            "address, or a private host the server's operator lists in "
            "OUTBOUND_ALLOWED_PRIVATE_HOSTS."
        ) from refused


def kept_key(
    req: DecisionSettingsUpdateRequest | DecisionSettingsTestRequest,
    existing: DecisionSettings | None,
) -> str | None:
    """The stored key a request leaves in place: only when it names the same
    backend, so an endpoint's token is never sent to Anthropic as a key."""
    if req.clear_api_key or existing is None or existing.backend != req.backend:
        return None
    return existing.api_key_encrypted


async def chosen_machine(
    session: AsyncSession,
    client: DynamicDecisionClient,
    *,
    tenant_id: str,
    user_id: str,
    machine_id: str,
    model: str,
) -> AgentController:
    """The caller's machine they may run the workspace's decisions on with
    `model`; refused with the reason otherwise."""
    controller = await client.availability.controllers.get(
        session, tenant_id, machine_id
    )
    refusal = choice_refusal(controller, user_id, model)
    if refusal is not None:
        raise DecisionSettingsRefused(refusal)
    assert controller is not None
    return controller


def _machine_of(row: DecisionSettings | None) -> tuple[str, str] | None:
    if row is None or row.backend != "machine" or row.controller_id is None:
        return None
    return (row.controller_id, row.model or "")


async def _bump(
    session: AsyncSession,
    client: DynamicDecisionClient,
    tenant_id: str,
    before: DecisionSettings | None,
    after: tuple[str, str] | None,
) -> dict[str, int]:
    """Bump the assignment of each controller whose decision work changes:
    the machine moved off, and the one chosen."""
    previous = _machine_of(before)
    if previous == after:
        return {}
    affected = {m[0] for m in (previous, after) if m is not None}
    controllers = client.availability.controllers
    return {
        controller_id: await controllers.bump_assignment_revision(
            session, tenant_id, controller_id
        )
        for controller_id in sorted(affected)
    }


async def save_settings(
    session: AsyncSession,
    client: DynamicDecisionClient,
    keyring: Keyring,
    *,
    tenant_id: str,
    user_id: str,
    req: DecisionSettingsUpdateRequest,
) -> DecisionSettingsResponse:
    """Save the workspace's choice, commit, and nudge the controllers it
    affects. Raises `DecisionSettingsRefused` for a choice it won't save."""
    _refuse_unoffered(req, client)
    if req.backend == "endpoint":
        assert req.endpoint is not None
        await _refuse_unreachable(req.endpoint, client)
    store = client.availability.store
    existing = await store.get_for_update(session, tenant_id)
    if req.backend == "machine":
        assert req.machine_id is not None and req.model is not None
        controller = await chosen_machine(
            session,
            client,
            tenant_id=tenant_id,
            user_id=user_id,
            machine_id=req.machine_id,
            model=req.model,
        )
        revisions = await _bump(
            session, client, tenant_id, existing, (controller.id, req.model)
        )
        await store.save_machine(
            session,
            tenant_id,
            controller_id=controller.id,
            model=req.model,
            threshold=req.threshold,
        )
    else:
        api_key_encrypted = (
            keyring.encrypt(req.api_key)
            if req.api_key is not None
            else kept_key(req, existing)
        )
        if req.backend in ("none", "haiku_bedrock"):
            api_key_encrypted = None
        if req.backend == "haiku_anthropic" and api_key_encrypted is None:
            raise DecisionSettingsRefused(
                "Haiku on the Anthropic API needs an Anthropic key."
            )
        revisions = await _bump(session, client, tenant_id, existing, None)
        await store.save(
            session,
            tenant_id,
            backend=req.backend,
            endpoint=req.endpoint if req.backend == "endpoint" else None,
            api_key_encrypted=api_key_encrypted,
            threshold=req.threshold,
        )
    await session.commit()
    client.forget(tenant_id)
    client.nudge(tenant_id, revisions)
    return await settings_view(
        session, client, keyring, tenant_id=tenant_id, user_id=user_id
    )


async def clear_settings(
    session: AsyncSession, client: DynamicDecisionClient, *, tenant_id: str
) -> None:
    """Back to the server default: commit, and nudge a machine moved off."""
    store = client.availability.store
    existing = await store.get_for_update(session, tenant_id)
    revisions = await _bump(session, client, tenant_id, existing, None)
    await store.clear(session, tenant_id)
    await session.commit()
    client.forget(tenant_id)
    client.nudge(tenant_id, revisions)


# ── Testing ───────────────────────────────────────────────────────────────────


def _test_response(outcome: TestOutcome) -> DecisionTestResponse:
    return DecisionTestResponse(
        ok=outcome.ok,
        agent=outcome.agent,
        model_choice=outcome.model_choice,
        confidence=outcome.confidence,
        latency_ms=outcome.latency_ms,
        backend=outcome.backend,
        error=(
            DecisionTestError(
                code=cast("TestErrorCode", outcome.error_code),
                message=outcome.error_message or "",
            )
            if outcome.error_code is not None
            else None
        ),
    )


def _not_ready(code: TestErrorCode, message: str) -> DecisionTestResponse:
    return DecisionTestResponse(
        ok=False,
        agent=None,
        model_choice=None,
        confidence=None,
        latency_ms=None,
        backend="machine",
        error=DecisionTestError(code=code, message=message),
    )


async def _test_machine(
    session: AsyncSession,
    client: DynamicDecisionClient,
    *,
    tenant_id: str,
    user_id: str,
    req: DecisionSettingsTestRequest,
) -> DecisionTestResponse:
    assert req.machine_id is not None and req.model is not None
    controller = await chosen_machine(
        session,
        client,
        tenant_id=tenant_id,
        user_id=user_id,
        machine_id=req.machine_id,
        model=req.model,
    )
    leases = await read_leases(session, _PROCESSES)
    connected = is_connected(controller, leases)
    status = decision_status(controller)
    name = controller.name
    # Not held across the call to the machine.
    await session.commit()
    if not connected:
        return _not_ready(
            "machine_offline", f"{name} isn't connected to Switch right now."
        )
    if status.get("state") != "running" or status.get("model") != req.model:
        return _not_ready(
            "machine_not_ready",
            f"The decision model isn't running on {name} yet "
            f"(it reports {status.get('state') or 'nothing'}).",
        )
    return _test_response(
        await client.test_machine(
            controller_id=controller.id, model=req.model, threshold=req.threshold
        )
    )


async def run_sample(
    session: AsyncSession,
    client: DynamicDecisionClient,
    keyring: Keyring,
    *,
    tenant_id: str,
    user_id: str,
    req: DecisionSettingsTestRequest,
) -> DecisionTestResponse:
    """Run the sample decision against the values entered, saved or not; an
    omitted key means the stored one. `backend: "default"` tests the server
    default, with the server's own endpoint and key and never the
    workspace's; `machine` asks the caller's machine, when it reports the
    model running. Nothing is saved, and no room's data is sent."""
    if req.backend == "machine":
        return await _test_machine(
            session, client, tenant_id=tenant_id, user_id=user_id, req=req
        )
    existing = await client.availability.store.get(session, tenant_id)
    # Not held across the call to the decision service.
    await session.commit()
    api_key = req.api_key
    if api_key is None and req.backend != "default":
        stored = kept_key(req, existing)
        if stored is not None:
            try:
                api_key = keyring.decrypt(stored)
            except UndecryptableError:
                return DecisionTestResponse(
                    ok=False,
                    agent=None,
                    model_choice=None,
                    confidence=None,
                    latency_ms=None,
                    backend=req.backend,
                    error=DecisionTestError(
                        code="not_configured",
                        message="The stored key can't be decrypted by this server; "
                        "enter it again.",
                    ),
                )
    outcome = await client.test(
        backend=req.backend,
        endpoint=req.endpoint if req.backend == "endpoint" else None,
        api_key=api_key if req.backend in ("endpoint", "haiku_anthropic") else None,
        threshold=req.threshold,
    )
    return _test_response(outcome)
