"""The controller's side of Console relays, mounted on the agent bridge.

A Console request for an agent on a controller is queued in `ControlRelays`
and written to the controller's stream as `agent.control` by
`ControlRelayNotifier`, alongside the management nudges. The controller
answers each at `POST .../control/{relay_id}`, and sends the live events of
the subscriptions Console views asked for at `POST .../control/push`.

Nothing relayed is written to the database or the log.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from switch_core.bridges.agent.auth import ControllerPrincipal
from switch_core.bridges.agent.dependencies import get_protocol
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.control_relay import (
    RELAY_REPLY_ENVELOPE_BYTES,
    RELAY_REPLY_LIMIT_BYTES,
    ControlOutlet,
    ControlRelays,
)
from switch_core.management import reason_codes
from switch_core.management.controller_routes import ControllerRoute
from switch_core.management.dependencies import (
    get_controller_principal,
    require_controller,
)
from switch_core.management.errors import ManagementError, error_body, not_found
from switch_core.management.notifier import (
    CREDENTIAL_REVOKED,
    ControllerNotifier,
    ControllerSubscription,
)

#: A push carries events a reply could carry, so it has the same bound.
CONTROL_BODY_LIMIT_BYTES = RELAY_REPLY_LIMIT_BYTES + RELAY_REPLY_ENVELOPE_BYTES
PUSH_KEYS = ("event", "failure", "health")
#: The generation pushes are sequenced under while the controller has no
#: stream open; stream generations start at 1.
NO_STREAM = 0


class ControlRelaySubscription(ControllerSubscription):
    """A stream's nudges, and the control frames owed to it while it is the
    controller's current stream."""

    def __init__(
        self, notifier: ControllerNotifier, controller_id: str, relays: ControlRelays
    ) -> None:
        super().__init__(notifier, controller_id)
        self._relays = relays
        self._outlet: ControlOutlet = relays.open_outlet(controller_id, self.wake)

    def drain(self) -> list[tuple[str, dict[str, Any]]]:
        frames = super().drain()
        control = self._relays.take_frames(self._outlet)
        if frames and frames[-1][0] == CREDENTIAL_REVOKED:
            return frames[:-1] + control + frames[-1:]
        return frames + control

    def close(self) -> None:
        self._relays.close_outlet(self._outlet)
        super().close()


class ControlRelayNotifier(ControllerNotifier):
    def __init__(self, relays: ControlRelays) -> None:
        super().__init__()
        self._relays = relays

    def subscribe(self, controller_id: str) -> ControllerSubscription:
        subscription = ControlRelaySubscription(self, controller_id, self._relays)
        self._subscriptions.setdefault(controller_id, set()).add(subscription)
        return subscription


class ControlReplyError(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=1, max_length=64)
    message: str = Field(max_length=2048)


class ControlReply(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ok: bool
    result: Any = None
    error: ControlReplyError | None = None

    @model_validator(mode="after")
    def _error_when_failed(self) -> ControlReply:
        if self.ok and self.error is not None:
            raise ValueError("A successful reply carries no error.")
        if not self.ok and self.error is None:
            raise ValueError("A failed reply carries an error.")
        if not self.ok and self.result is not None:
            raise ValueError("A failed reply carries no result.")
        return self


class ControlPushEvent(BaseModel):
    """One push, as the agent's control server sent it: exactly one of
    `event`, `failure` (null when the session's host recovered) or `health`,
    numbered per (agent, subscription)."""

    model_config = ConfigDict(extra="forbid")
    seq: int = Field(ge=0)
    event: Any = None
    failure: str | None = None
    health: Any = None

    @model_validator(mode="after")
    def _exactly_one(self) -> ControlPushEvent:
        present = [key for key in PUSH_KEYS if key in self.model_fields_set]
        if len(present) != 1:
            raise ValueError("A push carries exactly one of event, failure, health.")
        return self


class ControlPush(BaseModel):
    model_config = ConfigDict(extra="forbid")
    agent_id: str = Field(min_length=1)
    subscription: str = Field(min_length=1)
    events: list[ControlPushEvent]


Principal = Annotated[ControllerPrincipal, Depends(get_controller_principal)]
Protocol = Annotated[AgentCore, Depends(get_protocol)]


def _path_controller(controller_id: str, principal: Principal) -> ControllerPrincipal:
    return require_controller(controller_id, principal)


PathController = Annotated[ControllerPrincipal, Depends(_path_controller)]


async def _bounded_body(request: Request) -> bytes:
    raw = await request.body()
    if len(raw) > CONTROL_BODY_LIMIT_BYTES:
        raise ManagementError(
            413,
            reason_codes.VALIDATION_ERROR,
            f"A control reply or push is at most {CONTROL_BODY_LIMIT_BYTES} bytes; "
            "page the answer.",
        )
    return raw


def _parse[M: BaseModel](model: type[M], raw: bytes) -> M:
    try:
        return model.model_validate_json(raw)
    except ValidationError as exc:
        raise ManagementError(
            422,
            reason_codes.VALIDATION_ERROR,
            "; ".join(
                f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
                for error in exc.errors(include_input=False)
            ),
        ) from exc


def control_relay_router(relays: ControlRelays) -> APIRouter:
    router = APIRouter(route_class=ControllerRoute, tags=["agent management"])

    @router.post("/v1/management/controllers/{controller_id}/control/push")
    async def control_push(
        raw: Annotated[bytes, Depends(_bounded_body)],
        principal: PathController,
        protocol: Protocol,
    ) -> dict[str, bool]:
        """Live events for the Console views of one of this controller's agents.

        A `seq` at or below the last forwarded for the subscription is a
        duplicate and dropped; one past the next tells the views to resync.
        Sequences are compared within one controller stream only.
        `unsubscribe: true` says no view holds the subscription any more and
        the controller should drop it.
        """
        body = _parse(ControlPush, raw)
        binding = protocol.connections.controllers.binding(body.agent_id)
        if (
            binding is None
            or binding.controller_id != principal.controller_id
            or binding.tenant_id != principal.tenant_id
        ):
            raise ManagementError(
                403,
                reason_codes.FORBIDDEN,
                f"Agent {body.agent_id} is not run by this controller.",
            )
        stream = relays.generation(principal.controller_id)
        relays.views.deliver(
            body.agent_id,
            NO_STREAM if stream is None else stream,
            [
                {
                    "subscription": body.subscription,
                    **event.model_dump(include={"seq", *PUSH_KEYS}, exclude_unset=True),
                }
                for event in body.events
            ],
        )
        return {"unsubscribe": not relays.views.holds(body.agent_id, body.subscription)}

    @router.post(
        "/v1/management/controllers/{controller_id}/control/{relay_id}",
        response_model=None,
    )
    async def control_reply(
        relay_id: str,
        raw: Annotated[bytes, Depends(_bounded_body)],
        principal: PathController,
    ) -> dict[str, bool] | JSONResponse:
        """The controller's answer to one `agent.control` frame."""
        body = _parse(ControlReply, raw)
        relay = relays.get(relay_id)
        if relay is None or relay.tenant_id != principal.tenant_id:
            raise not_found("Relay")
        if relay.controller_id != principal.controller_id:
            raise ManagementError(
                403,
                reason_codes.FORBIDDEN,
                "This relay was sent to another controller.",
            )
        if relay.future.done():
            return JSONResponse(
                error_body(
                    reason_codes.RELAY_RESOLVED,
                    "This relay has already been answered or has expired.",
                    retryable=False,
                ),
                status_code=409,
            )
        answer: dict[str, Any] = {"ok": body.ok}
        if body.ok:
            answer["value"] = body.result
        else:
            assert body.error is not None
            answer["error"] = body.error.model_dump()
        relays.resolve(relay, answer)
        return {"ok": True}

    return router
