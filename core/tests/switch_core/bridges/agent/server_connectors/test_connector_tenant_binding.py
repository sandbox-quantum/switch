"""A server-side connector acts as its own row's tenant (CHOO-2623).

A connector runs in-process and calls `ProtocolService` directly, so unlike an
external agent there is no bearer token in front of it to resolve a tenant
from. Its own row is the answer, and `ServerSideConnectorLifecycleService.start`
reads it unscoped — from boot with nothing bound, and from an HTTP request
with the caller's tenant bound, which is not necessarily the connector's.

What the runtime then does with it is the point of these tests: the poll loop
is a long-lived task, so it unbinds for its lifetime and binds per pass,
rather than binding once and holding it for days.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock

import pytest

from switch_core.bridges.agent.protocol.types import (
    IntegrationProfile,
    TaskProtocolConfig,
)
from switch_core.bridges.agent.server_connectors.base import DiscoveredAgent
from switch_core.bridges.agent.server_connectors.core import ConnectorCore
from switch_core.tenant_context import current_tenant_id, tenant_scope

CONNECTOR_TENANT = "tenant-connector"
CALLER_TENANT = "tenant-caller"


def _core(protocol: Any, connector: Any) -> ConnectorCore:
    return ConnectorCore(
        connector_id="connector-1",
        connector_tenant_id=CONNECTOR_TENANT,
        connector_type="opencode",
        connector=connector,
        registration_token="tok",
        protocol=protocol,
    )


class TestThePollLoop:
    async def test_it_binds_per_pass_and_holds_nothing_between_them(self) -> None:
        seen: list[str | None] = []
        between: list[str | None] = []

        class _Protocol:
            async def poll_events(self, agent_id: str, timeout: int) -> list[Any]:
                seen.append(current_tenant_id())
                if len(seen) >= 3:
                    raise asyncio.CancelledError
                return []

        core = _core(_Protocol(), MagicMock())
        handle = MagicMock()
        handle.agent_id = "agent-1"
        handle.agent_name = "agent"

        # Created from a context that has no business deciding how the
        # connector acts, exactly as `restart` from a gateway request would.
        with tenant_scope(CALLER_TENANT):
            task = asyncio.create_task(core._poll_loop(handle))
            await task
            between.append(current_tenant_id())

        assert seen == [CONNECTOR_TENANT] * 3, (
            "a poll ran under something other than the connector's own tenant"
        )
        assert between == [CALLER_TENANT], (
            "the loop's unbinding escaped it and cleared its creator's context"
        )

    async def test_a_failing_pass_leaves_nothing_bound_for_the_next(self) -> None:
        """The loop logs and sleeps past an error. The tenant must not survive
        the exception into the retry, or a pass that raised would decide what
        the next one reads."""
        seen: list[str | None] = []
        inside_sleep: list[str | None] = []
        real_sleep = asyncio.sleep

        async def _sleep(delay: float) -> None:
            inside_sleep.append(current_tenant_id())
            await real_sleep(0)

        class _Protocol:
            async def poll_events(self, agent_id: str, timeout: int) -> list[Any]:
                seen.append(current_tenant_id())
                if len(seen) >= 2:
                    raise asyncio.CancelledError
                raise RuntimeError("boom")

        core = _core(_Protocol(), MagicMock())
        handle = MagicMock()
        handle.agent_id = "agent-1"
        handle.agent_name = "agent"

        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(
                "switch_core.bridges.agent.server_connectors.core.asyncio.sleep",
                _sleep,
            )
            await core._poll_loop(handle)

        assert seen == [CONNECTOR_TENANT, CONNECTOR_TENANT]
        assert inside_sleep == [None], (
            "the failed pass's tenant was still bound over the backoff"
        )


async def test_registering_an_agent_binds_the_connectors_tenant() -> None:
    """`register_agent_with_token` re-derives the tenant from the token for
    the write itself, but everything else `register_agent` touches — the
    client, the identity fan-out — runs under whatever is bound here, and
    `start` is reached from boot with nothing bound."""
    seen: list[str | None] = []

    class _Protocol:
        async def register_agent_with_token(self, **kwargs: Any) -> Any:
            seen.append(current_tenant_id())
            return MagicMock(agent_id="agent-1")

    class _Connector:
        async def start(self) -> None:
            return None

        async def stop(self) -> None:
            return None

        async def discover_agents(self) -> list[DiscoveredAgent]:
            return [
                DiscoveredAgent(
                    name="worker",
                    description="d",
                    integration_profile=IntegrationProfile(
                        connection_model="session_passive",
                        message_exchange=True,
                        pre_invocation_mediation=[],
                        post_invocation_mediation=[],
                        event_reporting=[],
                        task_protocol=TaskProtocolConfig(
                            can_delegate=False, can_accept=False
                        ),
                    ),
                    tools=[],
                    models=[],
                )
            ]

    core = _core(_Protocol(), _Connector())
    await core.start()
    await core.stop()

    assert seen == [CONNECTOR_TENANT]
