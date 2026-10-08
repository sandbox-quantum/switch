"""A bridge on the deployment's own app may only start for the tenant that
installed it.

Such a bridge reaches whatever workspace its config names through the one
credential every tenant shares, so a config naming another tenant's workspace
would put this tenant's rooms in it. The guard asks for the tenant's live
install of that workspace before the bridge runs.

Postgres is real because the install is read under row-level security, and
that read is what keeps one tenant's install from vouching for another's
bridge.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass

import pytest

from switch_core.bridges.collaboration.install import MessagingInstallerRegistry
from switch_core.bridges.collaboration.install_service import MessagingInstallService
from switch_core.bridges.collaboration.models import BridgeStartRefused
from switch_core.db.models import CollaborationBridge
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.db.stores.messaging_install_store import MessagingInstallStore
from tests.conftest import RLSHarness

from .test_install_service import (
    _KEYRING,
    _ORIGIN,
    _begin,
    _FakeInstaller,
    _FakeLifecycle,
    _fixture,
)

pytestmark = pytest.mark.no_ambient_tenant


class _SharedAppInstaller(_FakeInstaller):
    """A platform whose installed bridges all run on the deployment's credential."""

    def workspace_of_bridge(
        self, connection_config: Mapping[str, object]
    ) -> str | None:
        if connection_config.get("event_delivery") != "shared":
            return None
        return str(connection_config["workspace_id"])


class _StartingLifecycle(_FakeLifecycle):
    """Asks the guard as the real lifecycle does when it starts the bridge
    the install flow registers, while the install's pointer is still empty."""

    service: MessagingInstallService
    workspace_id: str

    async def register(self, **kwargs: object) -> CollaborationBridge:
        bridge = await super().register(**kwargs)
        await self.service.refuse_uninstalled_bridge(
            bridge_id=bridge.id,
            tenant_id=self._tenant_id,
            bridge_type=str(kwargs["bridge_type"]),
            connection_config=_shared(self.workspace_id),
        )
        return bridge


@dataclass(frozen=True)
class _Ids:
    tenant_a: str
    tenant_b: str
    workspace: str
    bridge_id: str


def _shared(workspace_id: str) -> dict[str, object]:
    return {"workspace_id": workspace_id, "event_delivery": "shared"}


async def _shared_app(harness: RLSHarness) -> tuple[MessagingInstallService, _Ids]:
    base = await _fixture(harness)
    suffix = uuid.uuid4().hex[:8]
    lifecycle = _StartingLifecycle(harness.restricted, base.tenant_a, suffix)
    installers = MessagingInstallerRegistry()
    installers.register(_SharedAppInstaller(base.workspace))
    service = MessagingInstallService(
        session_factory=harness.restricted,
        store=MessagingInstallStore(),
        receipts=MessagingEventReceiptStore(),
        installers=installers,
        lifecycle=lifecycle,  # type: ignore[arg-type]
        public_origin=_ORIGIN,
        keyring=_KEYRING,
    )
    lifecycle.service = service
    lifecycle.workspace_id = base.workspace
    base.service = service
    state = await _begin(harness.restricted, base, base.tenant_a)
    pending = await service.complete(platform="slack", code="c", state_token=state)
    install = (await service.confirm(platform="slack", ticket=pending.ticket)).install
    assert install.bridge_id is not None
    return service, _Ids(
        tenant_a=base.tenant_a,
        tenant_b=base.tenant_b,
        workspace=base.workspace,
        bridge_id=install.bridge_id,
    )


class TestWhatMayStart:
    async def test_the_bridge_the_install_built(self, rls_harness: RLSHarness) -> None:
        # Getting here at all is the install flow passing the guard while the
        # install's pointer was still empty.
        service, ids = await _shared_app(rls_harness)

        await service.refuse_uninstalled_bridge(
            bridge_id=ids.bridge_id,
            tenant_id=ids.tenant_a,
            bridge_type="slack",
            connection_config=_shared(ids.workspace),
        )

    async def test_a_bridge_that_is_not_on_the_shared_app(
        self, rls_harness: RLSHarness
    ) -> None:
        """Its own credential reaches only what its owner added it to."""
        service, ids = await _shared_app(rls_harness)

        await service.refuse_uninstalled_bridge(
            bridge_id="someone-elses",
            tenant_id=ids.tenant_b,
            bridge_type="slack",
            connection_config={"workspace_id": ids.workspace},
        )

    async def test_a_platform_this_deployment_has_no_app_for(
        self, rls_harness: RLSHarness
    ) -> None:
        service, ids = await _shared_app(rls_harness)

        await service.refuse_uninstalled_bridge(
            bridge_id="any",
            tenant_id=ids.tenant_b,
            bridge_type="mattermost",
            connection_config=_shared(ids.workspace),
        )


class TestWhatIsRefused:
    async def test_another_tenants_bridge_naming_the_workspace(
        self, rls_harness: RLSHarness
    ) -> None:
        """The takeover: tenant B registers a shared bridge for A's workspace."""
        service, ids = await _shared_app(rls_harness)

        with pytest.raises(BridgeStartRefused, match=ids.workspace):
            await service.refuse_uninstalled_bridge(
                bridge_id="tenant-b-bridge",
                tenant_id=ids.tenant_b,
                bridge_type="slack",
                connection_config=_shared(ids.workspace),
            )

    async def test_a_second_bridge_of_the_same_tenant_on_the_workspace(
        self, rls_harness: RLSHarness
    ) -> None:
        """One install, one bridge: a bridge it did not build is not vouched for."""
        service, ids = await _shared_app(rls_harness)

        with pytest.raises(BridgeStartRefused):
            await service.refuse_uninstalled_bridge(
                bridge_id="another-bridge",
                tenant_id=ids.tenant_a,
                bridge_type="slack",
                connection_config=_shared(ids.workspace),
            )

    async def test_a_workspace_nobody_installed(self, rls_harness: RLSHarness) -> None:
        service, ids = await _shared_app(rls_harness)

        with pytest.raises(BridgeStartRefused):
            await service.refuse_uninstalled_bridge(
                bridge_id=ids.bridge_id,
                tenant_id=ids.tenant_a,
                bridge_type="slack",
                connection_config=_shared("T-never-installed"),
            )
