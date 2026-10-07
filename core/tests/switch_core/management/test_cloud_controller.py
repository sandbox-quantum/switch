"""A cloud machine on the controller runtime, against Postgres.

Preparing the machine links it to its owner's ec2 controller and hands the
machine that controller's credential, the same one for every retry at a
revision. The controller exchanges it only from the machine's own instance,
reads its owner's provider logins sealed for it, and fetches repository tokens
for the agents it runs. KMS is stubbed; everything else is real.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.routing import Mount

from switch_core.bridges.agent import dependencies as bridge_deps
from switch_core.bridges.agent.api.hosted_routes import router as hosted_router
from switch_core.connections.loader import CATALOG, deployment_skills
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentController,
    AgentDefinition,
    HostedMachine,
    ProviderConnection,
    SealedProviderCredential,
    User,
)
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.hosted_controller import router as hosted_controller_router
from switch_core.gateway.hosted_machines import router as hosted_machines_router
from switch_core.gateway.provider_connections import (
    router as provider_connections_router,
)
from switch_core.providers import sealing
from switch_core.providers.github_installation import RepositoryCredential
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.providers.sealing import SealingNotConfigured
from tests.switch_core.hosted_machine_helpers import seed_machine
from tests.switch_core.hosted_wire_fixtures import MACHINE_ID, assert_wire_fixture
from tests.switch_core.management.harness import (
    KEYRING,
    EnrolledController,
    Harness,
    add_member,
    bearer,
    build_harness,
    cookies_for,
    create_managed_agent,
    definition,
    enroll_console,
    provider,
    report_status,
)

OPERATOR_TOKEN = "SYNTHETIC-OPERATOR-CREDENTIAL-FOR-TESTS"  # gitleaks:allow
KEY_ARN = "arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000000"
DATA_KEY = bytes(range(32))
INSTANCE = "i-00000000000000001"
BOOT = "boot-00000001"
REPOSITORY = {"installation_id": 123, "repository_id": 456}
FIXTURE_SLOT_ID = "slot-a"
FIXTURE_OWNER_ID = "3f1c2b4a-0000-4000-8000-0000000000b1"
FIXTURE_CONTROLLER_ID = "3f1c2b4a-0000-4000-8000-0000000000e1"
FIXTURE_CREDENTIAL = "swcc_test-000000000000000000000000000000000000"


class FakeKms:
    def generate_data_key(self, **kwargs: Any) -> dict[str, Any]:
        return {"Plaintext": DATA_KEY, "CiphertextBlob": b"placeholder-blob"}


@dataclass
class Cloud:
    harness: Harness
    client: httpx.AsyncClient
    config: SimpleNamespace
    issue: AsyncMock
    repositories: AsyncMock

    @property
    def factory(self) -> async_sessionmaker[AsyncSession]:
        return self.harness.session_factory

    async def prepare(self, machine_id: str) -> httpx.Response:
        return await self.client.post(
            f"/gateway/hosted-controller/machines/{machine_id}/prepare",
            headers=bearer(OPERATOR_TOKEN),
        )

    async def exchange(
        self,
        controller_id: str,
        credential: str,
        instance_id: str | None = INSTANCE,
        boot_id: str | None = BOOT,
    ) -> httpx.Response:
        headers = {}
        if instance_id is not None:
            headers["X-Switch-Host-Instance-Id"] = instance_id
        if boot_id is not None:
            headers["X-Switch-Host-Boot-Id"] = boot_id
        return await self.client.post(
            f"/v1/management/controllers/{controller_id}/token",
            json={"credential": credential},
            headers=headers,
        )

    async def machine(self, owner: User) -> str:
        async with self.factory() as session:
            machine = await seed_machine(
                session,
                owner_id=owner.id,
                slot_id=f"slot-{uuid4().hex[:8]}",
                state="queued",
                desired_state="running",
                stop_reason=None,
                revision=1,
                generation=1,
            )
            machine.instance_id = INSTANCE
            await session.commit()
            return machine.id

    async def update_machine(self, machine_id: str, **values: Any) -> None:
        async with self.factory() as session:
            machine = await session.get(HostedMachine, (TENANT_ZERO_ID, machine_id))
            assert machine is not None
            for key, value in values.items():
                setattr(machine, key, value)
            await session.commit()

    async def cloud_controller(self, owner: User) -> EnrolledController:
        """Prepare a machine for `owner` and exchange its controller's credential."""
        prepared = await self.prepare(await self.machine(owner))
        assert prepared.status_code == 200, prepared.text
        controller = prepared.json()["controller"]
        token = await self.exchange(controller["id"], controller["credential"])
        assert token.status_code == 200, token.text
        return EnrolledController(
            controller_id=controller["id"],
            credential=controller["credential"],
            access_token=token.json()["access_token"],
            owner=owner,
        )

    async def envelope(
        self, controller: EnrolledController, provider_name: str, path_id: str = ""
    ) -> httpx.Response:
        return await self.client.get(
            f"/v1/management/controllers/{path_id or controller.controller_id}"
            f"/provider-credentials/{provider_name}",
            headers=controller.headers,
        )


def _gateway_app(harness: Harness) -> Any:
    return next(
        route.app
        for route in harness.app.routes
        if isinstance(route, Mount) and route.path == "/gateway"
    )


@pytest.fixture
async def cloud(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> AsyncIterator[Cloud]:
    harness = build_harness(session_factory)
    settings = HostedControllerSettings(
        tenant_id=TENANT_ZERO_ID,
        token=OPERATOR_TOKEN,
        machine_slots=["slot-a", "slot-b"],
        github_private_key_path="/tmp/synthetic-signing-key.pem",
        agent_api_endpoint="https://switch.example.com/api/agent",
    )
    settings_path = tmp_path / "controller.json"
    settings_path.write_text(
        json.dumps({**settings.model_dump(mode="json"), "token": OPERATOR_TOKEN})
    )
    config = SimpleNamespace(
        keyring=KEYRING,
        gateway_tenant_choice_enabled=False,
        hosted_login_kms_key_arn=KEY_ARN,
        hosted_login_kms_region="us-east-1",
        hosted_launch_capacity=2,
        hosted_controller_config_path=str(settings_path),
        hosted_github_config_path="/tmp/synthetic-github.json",
    )
    gateway = _gateway_app(harness)
    gateway.state.hosted_controller_settings = settings
    gateway.include_router(hosted_controller_router)
    gateway.include_router(hosted_machines_router)
    gateway.include_router(provider_connections_router, prefix="/provider-connections")
    gateway.dependency_overrides[gw_deps.get_config] = lambda: config
    harness.app.include_router(hosted_router)
    harness.app.dependency_overrides[bridge_deps.get_config] = lambda: config

    monkeypatch.setattr(sealing, "kms_client", lambda region: FakeKms())
    issue = AsyncMock(
        return_value=RepositoryCredential(
            "SYNTHETIC-REPOSITORY",
            datetime.now(UTC) + timedelta(hours=1),
            456,
            "example/project",
        )
    )
    monkeypatch.setattr(
        "switch_core.bridges.agent.api.hosted_routes.GitHubConnections",
        lambda _: SimpleNamespace(client_id="synthetic-app"),
    )
    monkeypatch.setattr(
        "switch_core.bridges.agent.api.hosted_routes.GitHubInstallationCredentials",
        lambda *_: SimpleNamespace(issue=issue, revoke=AsyncMock()),
    )
    repositories = AsyncMock(
        return_value=[
            {
                "id": 123,
                "account": "example",
                "repositories": [
                    {
                        "id": 456,
                        "name": "Example/Project",
                        "permissions": {
                            "push": True,
                            "maintain": False,
                            "admin": False,
                        },
                    },
                    {
                        "id": 789,
                        "name": "example/read-only",
                        "permissions": {
                            "push": False,
                            "maintain": False,
                            "admin": False,
                        },
                    },
                ],
            }
        ]
    )
    gateway.state.github_connections = SimpleNamespace(
        repositories=repositories, install_url="https://github.example/install"
    )
    async with harness.client() as client:
        yield Cloud(
            harness=harness,
            client=client,
            config=config,
            issue=issue,
            repositories=repositories,
        )


def _open(envelope: dict[str, Any]) -> dict[str, Any]:
    sealed = base64.b64decode(envelope["ciphertext"]) + base64.b64decode(
        envelope["tag"]
    )
    return dict(
        json.loads(
            AESGCM(DATA_KEY).decrypt(
                base64.b64decode(envelope["iv"]),
                sealed,
                sealing.additional_data(envelope["context"], envelope["revision"]),
            )
        )
    )


async def _connect(
    cloud: Cloud, owner: User, provider_name: str, kind: str, credential: str
) -> httpx.Response:
    return await cloud.client.put(
        f"/gateway/provider-connections/{provider_name}",
        json={"kind": kind, "credential": credential},
        cookies=cookies_for(owner),
    )


async def _connection(cloud: Cloud, owner: User, provider_name: str) -> Any:
    async with cloud.factory() as session:
        return await session.scalar(
            select(ProviderConnection).where(
                ProviderConnection.user_id == owner.id,
                ProviderConnection.provider == provider_name,
            )
        )


async def _connect_github(cloud: Cloud, owner: User) -> None:
    async with cloud.factory() as session:
        session.add(
            ProviderConnection(
                user_id=owner.id,
                provider="github",
                kind="oauth",
                encrypted_credential=KEYRING.encrypt(
                    json.dumps(
                        {
                            "access_token": "SYNTHETIC-GITHUB",
                            "login": "ada",
                            "expires_at": (
                                datetime.now(UTC) + timedelta(hours=1)
                            ).timestamp(),
                        }
                    )
                ),
                verified_at=datetime.now(UTC),
            )
        )
        await session.commit()


class TestPrepare:
    async def test_a_retry_at_one_revision_returns_the_same_credential(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        machine_id = await cloud.machine(owner)

        first = await cloud.prepare(machine_id)
        again = await cloud.prepare(machine_id)

        assert first.status_code == 200, first.text
        assert first.headers["cache-control"] == "no-store"
        body = first.json()
        assert again.json() == body
        controller_id = body["controller"]["id"]
        assert body["controller"]["credential"].startswith("swcc_")
        assert body["runtime"] == "controller"
        assert body["revision"] == 1
        assert body["kms"] == {
            "key_arn": KEY_ARN,
            "region": "us-east-1",
            "context": {
                "switch:tenant": TENANT_ZERO_ID,
                "switch:owner_id": owner.id,
                "switch:controller_id": controller_id,
            },
        }
        async with cloud.factory() as session:
            controller = await session.get(AgentController, controller_id)
            machine = await session.get(HostedMachine, (TENANT_ZERO_ID, machine_id))
        assert controller is not None and machine is not None
        assert (controller.kind, controller.name, controller.owner_id) == (
            "ec2",
            "Switch cloud",
            owner.id,
        )
        assert machine.controller_id == controller_id
        assert machine.state == "provisioning"

    async def test_the_response_matches_the_controllers_wire_fixture(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        machine_id = await cloud.machine(owner)
        async with cloud.factory() as session:
            machine = await session.get(HostedMachine, (TENANT_ZERO_ID, machine_id))
            assert machine is not None
            slot_id = machine.slot_id

        prepared = await cloud.prepare(machine_id)

        assert prepared.status_code == 200, prepared.text
        body = prepared.json()
        assert_wire_fixture(
            "prepare_controller_response.json",
            body,
            placeholders={
                MACHINE_ID: machine_id,
                FIXTURE_SLOT_ID: slot_id,
                FIXTURE_OWNER_ID: owner.id,
                FIXTURE_CONTROLLER_ID: body["controller"]["id"],
            },
            volatile={("controller", "credential"): FIXTURE_CREDENTIAL},
        )

    async def test_a_new_revision_replaces_the_credential_and_its_tokens(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        machine_id = await cloud.machine(owner)
        first = (await cloud.prepare(machine_id)).json()["controller"]
        old_token = await cloud.exchange(first["id"], first["credential"])
        assert old_token.status_code == 200, old_token.text
        old_headers = bearer(old_token.json()["access_token"])
        assert (
            await cloud.client.get(
                f"/v1/management/controllers/{first['id']}/assignment",
                headers=old_headers,
            )
        ).status_code == 200

        await cloud.update_machine(machine_id, revision=2)
        second = (await cloud.prepare(machine_id)).json()["controller"]

        assert second["id"] == first["id"]
        assert second["credential"] != first["credential"]
        refused = await cloud.exchange(first["id"], first["credential"])
        assert refused.status_code == 401
        stale = await cloud.client.get(
            f"/v1/management/controllers/{first['id']}/assignment",
            headers=old_headers,
        )
        assert (stale.status_code, stale.json()["error"]["code"]) == (
            401,
            "token_expired",
        )
        assert (
            await cloud.exchange(second["id"], second["credential"])
        ).status_code == (200)

    async def test_a_second_machine_reuses_the_owners_controller(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        first = await cloud.prepare(await cloud.machine(owner))
        await cloud.update_machine(first.json()["machine_id"], state="deleted")

        second = await cloud.prepare(await cloud.machine(owner))

        assert second.json()["controller"]["id"] == first.json()["controller"]["id"]

    async def test_an_owners_enrolled_ec2_lookalike_is_never_taken_over(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        console = await enroll_console(cloud.harness, cloud.client, owner)
        async with cloud.factory() as session:
            row = await session.get(AgentController, console.controller_id)
            assert row is not None
            row.kind = "ec2"
            await session.commit()

        prepared = await cloud.prepare(await cloud.machine(owner))

        assert prepared.json()["controller"]["id"] != console.controller_id

    async def test_an_unconfigured_kms_key_fails_loudly(self, cloud: Cloud) -> None:
        cloud.config.hosted_login_kms_key_arn = None
        owner = await add_member(cloud.factory, "ada")
        with pytest.raises(SealingNotConfigured):
            await cloud.prepare(await cloud.machine(owner))


class TestEnsure:
    async def test_a_new_users_machine_runs_the_controller_it_is_linked_to(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        async with cloud.factory() as session:
            await ProviderConnectionStore().save(
                session,
                owner.id,
                "setup-token",
                KEYRING.encrypt("PLACEHOLDER-CLAUDE-TOKEN"),
                datetime.now(UTC),
            )
            await session.commit()

        ensured = await cloud.client.post(
            "/gateway/hosted-machines/ensure", cookies=cookies_for(owner)
        )

        assert ensured.status_code == 200, ensured.text
        body = ensured.json()
        async with cloud.factory() as session:
            machine = await session.get(
                HostedMachine, (TENANT_ZERO_ID, body["machine_id"])
            )
            assert machine is not None
            controller = await session.get(AgentController, body["controller_id"])
        assert machine.runtime == "controller"
        assert machine.controller_id == body["controller_id"]
        assert controller is not None
        assert (controller.kind, controller.owner_id) == ("ec2", owner.id)

        prepared = await cloud.prepare(body["machine_id"])
        assert prepared.status_code == 200, prepared.text
        credential = prepared.json()["controller"]
        await cloud.update_machine(body["machine_id"], instance_id=INSTANCE)
        assert credential["id"] == body["controller_id"]
        token = await cloud.exchange(credential["id"], credential["credential"])
        assert token.status_code == 200, token.text
        envelope = await cloud.envelope(
            EnrolledController(
                controller_id=credential["id"],
                credential=credential["credential"],
                access_token=token.json()["access_token"],
                owner=owner,
            ),
            "claude",
        )
        assert envelope.status_code == 200, envelope.text
        assert _open(envelope.json())["credential"] == "PLACEHOLDER-CLAUDE-TOKEN"

    async def test_an_agent_in_a_repository_is_placed_before_the_machine_reports(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        await _connect_github(cloud, owner)
        ensured = await cloud.client.post(
            "/gateway/hosted-machines/ensure", cookies=cookies_for(owner)
        )
        assert ensured.status_code == 200, ensured.text

        created = await create_managed_agent(
            cloud.client,
            owner,
            name="cloud-helper",
            controller_id=ensured.json()["controller_id"],
            definition_body=definition(repository=REPOSITORY),
        )

        assert created.status_code == 201, created.text
        agent_id = created.json()["agent_id"]
        async with cloud.factory() as session:
            row = await session.scalar(
                select(AgentDefinition).where(AgentDefinition.agent_id == agent_id)
            )
        assert row is not None
        assert row.controller_id == ensured.json()["controller_id"]
        assert row.definition["repository"] == REPOSITORY
        assert row.definition["isolation"] == "isolated"
        assert (
            row.definition["directory"] == f"/data/worktrees/{agent_id}/example/project"
        )

    async def test_an_agent_without_a_repository_works_in_a_fresh_workspace(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        ensured = await cloud.client.post(
            "/gateway/hosted-machines/ensure", cookies=cookies_for(owner)
        )
        assert ensured.status_code == 200, ensured.text

        created = await create_managed_agent(
            cloud.client,
            owner,
            name="cloud-helper",
            controller_id=ensured.json()["controller_id"],
        )

        assert created.status_code == 201, created.text
        agent_id = created.json()["agent_id"]
        assert (
            created.json()["definition"]["directory"]
            == f"/data/worktrees/{agent_id}/workspace"
        )
        cloud.repositories.assert_not_awaited()

    async def test_a_name_already_taken_is_refused_as_taken(self, cloud: Cloud) -> None:
        owner = await add_member(cloud.factory, "ada")
        ensured = await cloud.client.post(
            "/gateway/hosted-machines/ensure", cookies=cookies_for(owner)
        )
        assert ensured.status_code == 200, ensured.text
        first = await create_managed_agent(
            cloud.client,
            owner,
            name="cloud-helper",
            controller_id=ensured.json()["controller_id"],
        )
        assert first.status_code == 201, first.text

        again = await create_managed_agent(
            cloud.client,
            owner,
            name="cloud-helper",
            controller_id=ensured.json()["controller_id"],
        )

        assert again.status_code == 409, again.text
        assert "already exists" in again.json()["error"]["message"]

    @pytest.mark.parametrize(
        ("connected", "repository", "message"),
        [
            (False, REPOSITORY, "Connect GitHub"),
            (
                True,
                {"installation_id": 123, "repository_id": 999},
                "no longer has access",
            ),
            (True, {"installation_id": 123, "repository_id": 789}, "write access"),
        ],
    )
    async def test_a_repository_the_owner_cannot_push_to_registers_nothing(
        self, cloud: Cloud, connected: bool, repository: dict[str, int], message: str
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        if connected:
            await _connect_github(cloud, owner)
        ensured = await cloud.client.post(
            "/gateway/hosted-machines/ensure", cookies=cookies_for(owner)
        )
        assert ensured.status_code == 200, ensured.text

        created = await create_managed_agent(
            cloud.client,
            owner,
            name="cloud-helper",
            controller_id=ensured.json()["controller_id"],
            definition_body=definition(repository=repository),
        )

        assert created.status_code == 422, created.text
        assert created.json()["error"]["code"] == "validation_error"
        assert message in created.json()["error"]["message"]
        async with cloud.factory() as session:
            assert (
                await session.scalar(select(Agent).where(Agent.name == "cloud-helper"))
                is None
            )


class TestExchange:
    async def test_is_refused_without_the_instance_headers(self, cloud: Cloud) -> None:
        owner = await add_member(cloud.factory, "ada")
        body = (await cloud.prepare(await cloud.machine(owner))).json()["controller"]

        for instance_id, boot_id in [(None, BOOT), (INSTANCE, None), (None, None)]:
            refused = await cloud.exchange(
                body["id"], body["credential"], instance_id, boot_id
            )
            assert (refused.status_code, refused.json()["error"]["code"]) == (
                401,
                "invalid_credential",
            )

    async def test_another_instance_is_a_retryable_mismatch(self, cloud: Cloud) -> None:
        owner = await add_member(cloud.factory, "ada")
        prepared = (await cloud.prepare(await cloud.machine(owner))).json()
        body = prepared["controller"]

        refused = await cloud.exchange(
            body["id"], body["credential"], "i-00000000000000002"
        )
        assert refused.status_code == 409
        assert refused.json()["error"]["code"] == "instance_mismatch"
        assert refused.json()["error"]["retryable"] is True

        await cloud.update_machine(prepared["machine_id"], desired_state="stopped")
        stopped = await cloud.exchange(body["id"], body["credential"])
        assert stopped.status_code == 409
        assert stopped.json()["error"]["code"] == "instance_mismatch"

    async def test_a_console_controller_needs_no_instance(self, cloud: Cloud) -> None:
        owner = await add_member(cloud.factory, "ada")
        console = await enroll_console(cloud.harness, cloud.client, owner)
        token = await cloud.exchange(
            console.controller_id, console.credential, None, None
        )
        assert token.status_code == 200, token.text

    async def test_a_cloud_controller_cannot_rotate_its_own_credential(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        controller = await cloud.cloud_controller(owner)
        refused = await cloud.client.post(
            f"/v1/management/controllers/{controller.controller_id}/credential/rotate",
            headers=controller.headers,
        )
        assert refused.status_code == 403


class TestSealedLogins:
    async def test_logins_held_when_the_controller_is_linked_are_sealed_for_it(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        async with cloud.factory() as session:
            await ProviderConnectionStore().save(
                session,
                owner.id,
                "setup-token",
                KEYRING.encrypt("PLACEHOLDER-CLAUDE-TOKEN"),
                datetime.now(UTC),
            )
            await session.commit()

        controller = await cloud.cloud_controller(owner)
        response = await cloud.envelope(controller, "claude")

        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "no-store"
        envelope = response.json()
        assert (envelope["status"], envelope["revision"]) == ("connected", 1)
        assert envelope["context"] == {
            "switch:tenant": TENANT_ZERO_ID,
            "switch:owner_id": owner.id,
            "switch:controller_id": controller.controller_id,
            "switch:provider": "claude",
        }
        assert _open(envelope) == {
            "status": "connected",
            "revision": "1",
            "provider": "claude",
            "kind": "setup-token",
            "credential": "PLACEHOLDER-CLAUDE-TOKEN",
        }
        connection = await _connection(cloud, owner, "claude")
        assert connection.encrypted_credential is not None

    async def test_a_new_login_is_held_only_sealed_and_a_disconnect_revokes_it(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        controller = await cloud.cloud_controller(owner)
        assert (await cloud.envelope(controller, "cursor")).status_code == 404

        connected = await _connect(cloud, owner, "cursor", "api-key", "PLACEHOLDER-1")
        assert connected.status_code == 200, connected.text
        assert (await _connection(cloud, owner, "cursor")).encrypted_credential is None
        first = (await cloud.envelope(controller, "cursor")).json()
        assert (first["status"], first["revision"]) == ("connected", 1)
        assert _open(first)["credential"] == "PLACEHOLDER-1"

        await _connect(cloud, owner, "cursor", "api-key", "PLACEHOLDER-2")
        second = (await cloud.envelope(controller, "cursor")).json()
        assert second["revision"] == 2
        assert _open(second) == {
            "status": "connected",
            "revision": "2",
            "provider": "cursor",
            "kind": "api-key",
            "credential": "PLACEHOLDER-2",
        }

        disconnected = await cloud.client.delete(
            "/gateway/provider-connections/cursor", cookies=cookies_for(owner)
        )
        assert disconnected.status_code == 204
        revoked = (await cloud.envelope(controller, "cursor")).json()
        assert (revoked["status"], revoked["revision"]) == ("revoked", 3)
        assert revoked["ciphertext"] is None and revoked["encrypted_key"] is None

    async def test_each_seal_and_revoke_tells_the_controller_to_fetch_again(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        controller = await cloud.cloud_controller(owner)
        stream = cloud.harness.management.service.notifier.subscribe(
            controller.controller_id
        )
        try:
            await _connect(cloud, owner, "cursor", "api-key", "PLACEHOLDER-1")
            sealed = stream.drain()
            await cloud.client.delete(
                "/gateway/provider-connections/cursor", cookies=cookies_for(owner)
            )
            revoked = stream.drain()
        finally:
            stream.close()

        assert sealed == [
            ("provider.credential_changed", {"provider": "cursor", "revision": 1})
        ]
        assert revoked == [
            ("provider.credential_changed", {"provider": "cursor", "revision": 2})
        ]


async def _status(cloud: Cloud, owner: User, provider_name: str) -> str:
    response = await cloud.client.get(
        f"/gateway/provider-connections/{provider_name}", cookies=cookies_for(owner)
    )
    assert response.status_code == 200, response.text
    return str(response.json()["status"])


async def _machine_of(cloud: Cloud, controller: EnrolledController) -> str:
    async with cloud.factory() as session:
        machine_id = await session.scalar(
            select(HostedMachine.id).where(
                HostedMachine.controller_id == controller.controller_id
            )
        )
    assert machine_id is not None
    return str(machine_id)


async def _revoke(cloud: Cloud, controller: EnrolledController) -> None:
    async with cloud.factory() as session:
        await cloud.harness.management.service.revoke_controller(
            session, TENANT_ZERO_ID, controller.owner.id, controller.controller_id
        )


class TestReconnectRequired:
    async def test_a_login_held_only_sealed_for_a_revoked_controller_needs_reconnecting(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        controller = await cloud.cloud_controller(owner)
        machine_id = await _machine_of(cloud, controller)
        await _connect(cloud, owner, "cursor", "api-key", "PLACEHOLDER-1")
        assert await _status(cloud, owner, "cursor") == "configured"

        await _revoke(cloud, controller)
        assert await _status(cloud, owner, "cursor") == "reconnect_required"

        await cloud.update_machine(machine_id, revision=2)
        prepared = await cloud.prepare(machine_id)
        assert prepared.status_code == 200, prepared.text
        replacement = prepared.json()["controller"]["id"]
        assert replacement != controller.controller_id
        assert await _status(cloud, owner, "cursor") == "reconnect_required"

        await _connect(cloud, owner, "cursor", "api-key", "PLACEHOLDER-2")
        assert await _status(cloud, owner, "cursor") == "configured"
        async with cloud.factory() as session:
            row = await session.get(
                SealedProviderCredential, (TENANT_ZERO_ID, replacement, "cursor")
            )
        assert row is not None and row.status == "connected"

    async def test_a_controller_kept_across_machines_keeps_the_login_connected(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        controller = await cloud.cloud_controller(owner)
        await _connect(cloud, owner, "cursor", "api-key", "PLACEHOLDER-1")

        await cloud.update_machine(
            await _machine_of(cloud, controller), state="deleted"
        )
        assert await _status(cloud, owner, "cursor") == "configured"

        prepared = await cloud.prepare(await cloud.machine(owner))
        assert prepared.json()["controller"]["id"] == controller.controller_id
        assert await _status(cloud, owner, "cursor") == "configured"

    async def test_a_claude_login_with_no_envelope_for_the_controller_needs_reconnecting(
        self, cloud: Cloud
    ) -> None:
        _gateway_app(cloud.harness).state.claude_verifier = object()
        owner = await add_member(cloud.factory, "ada")
        await cloud.cloud_controller(owner)
        async with cloud.factory() as session:
            await ProviderConnectionStore().save(
                session, owner.id, "setup-token", None, datetime.now(UTC)
            )
            await session.commit()

        assert await _status(cloud, owner, "claude") == "reconnect_required"

    async def test_a_keyring_copy_never_needs_reconnecting(self, cloud: Cloud) -> None:
        owner = await add_member(cloud.factory, "ada")
        async with cloud.factory() as session:
            await ProviderConnectionStore().save(
                session,
                owner.id,
                "setup-token",
                KEYRING.encrypt("PLACEHOLDER-CLAUDE-TOKEN"),
                datetime.now(UTC),
            )
            await session.commit()
        _gateway_app(cloud.harness).state.claude_verifier = object()
        controller = await cloud.cloud_controller(owner)
        await _revoke(cloud, controller)

        assert await _status(cloud, owner, "claude") == "connected"


class TestTheEnvelopeEndpoint:
    async def test_answers_only_the_owners_own_cloud_controller(
        self, cloud: Cloud
    ) -> None:
        ada = await add_member(cloud.factory, "ada")
        grace = await add_member(cloud.factory, "grace")
        ada_cloud = await cloud.cloud_controller(ada)
        grace_cloud = await cloud.cloud_controller(grace)
        await _connect(cloud, ada, "cursor", "api-key", "PLACEHOLDER-1")
        assert (await cloud.envelope(ada_cloud, "cursor")).status_code == 200

        assert (
            await cloud.envelope(grace_cloud, "cursor", ada_cloud.controller_id)
        ).status_code == 404
        assert (await cloud.envelope(grace_cloud, "cursor")).status_code == 404

    async def test_a_console_controller_gets_none(self, cloud: Cloud) -> None:
        owner = await add_member(cloud.factory, "ada")
        await cloud.cloud_controller(owner)
        await _connect(cloud, owner, "cursor", "api-key", "PLACEHOLDER-1")
        console = await enroll_console(cloud.harness, cloud.client, owner)

        assert (await cloud.envelope(console, "cursor")).status_code == 404

    async def test_a_controller_whose_machine_is_gone_gets_none(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        controller = await cloud.cloud_controller(owner)
        await _connect(cloud, owner, "cursor", "api-key", "PLACEHOLDER-1")
        async with cloud.factory() as session:
            machine = await session.scalar(
                select(HostedMachine).where(
                    HostedMachine.controller_id == controller.controller_id
                )
            )
            assert machine is not None
            machine.state = "deleted"
            await session.commit()

        assert (await cloud.envelope(controller, "cursor")).status_code == 404


class TestRepositoryCredential:
    async def _agent(
        self, cloud: Cloud, controller: EnrolledController, **overrides: Any
    ) -> str:
        await report_status(cloud.client, controller, 1, providers=[provider("claude")])
        created = await create_managed_agent(
            cloud.client,
            controller.owner,
            name="cloud-helper",
            controller_id=controller.controller_id,
            definition_body=definition(**overrides),
        )
        assert created.status_code == 201, created.text
        return str(created.json()["agent_id"])

    async def _fetch(
        self, cloud: Cloud, controller: EnrolledController, agent_id: str
    ) -> httpx.Response:
        return await cloud.client.post(
            "/hosted/github-credential",
            headers={**controller.headers, "X-Switch-Agent-Id": agent_id},
        )

    async def test_a_cloud_controller_fetches_its_agents_repository_token(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        await _connect_github(cloud, owner)
        controller = await cloud.cloud_controller(owner)
        agent_id = await self._agent(cloud, controller, repository=REPOSITORY)

        response = await self._fetch(cloud, controller, agent_id)

        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "no-store"
        assert response.json()["token"] == "SYNTHETIC-REPOSITORY"
        assert response.json()["repository"] == "example/project"
        _, access_token, installation_id, repository_id = cloud.issue.await_args.args
        assert (access_token, installation_id, repository_id) == (
            "SYNTHETIC-GITHUB",
            123,
            456,
        )

    async def test_an_agent_without_a_repository_gets_none(self, cloud: Cloud) -> None:
        owner = await add_member(cloud.factory, "ada")
        await _connect_github(cloud, owner)
        controller = await cloud.cloud_controller(owner)
        agent_id = await self._agent(cloud, controller)

        assert (await self._fetch(cloud, controller, agent_id)).status_code == 403
        cloud.issue.assert_not_awaited()

    async def test_an_agent_in_a_repository_is_given_the_github_skill(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        await _connect_github(cloud, owner)
        controller = await cloud.cloud_controller(owner)
        in_repository = await self._agent(cloud, controller, repository=REPOSITORY)

        assigned = await cloud.client.get(
            f"/v1/management/controllers/{controller.controller_id}/assignment",
            headers=controller.headers,
        )

        assert assigned.status_code == 200, assigned.text
        (entry,) = assigned.json()["agents"]
        assert entry["agent_id"] == in_repository
        assert entry["definition"]["skills"] == deployment_skills(CATALOG, ["github"])
        assert [skill["slug"] for skill in entry["definition"]["skills"]] == ["github"]

    async def test_an_agent_without_a_repository_is_given_no_skill(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        controller = await cloud.cloud_controller(owner)
        await self._agent(cloud, controller)

        assigned = await cloud.client.get(
            f"/v1/management/controllers/{controller.controller_id}/assignment",
            headers=controller.headers,
        )

        assert assigned.status_code == 200, assigned.text
        (entry,) = assigned.json()["agents"]
        assert entry["definition"]["skills"] == []

    async def test_a_console_controller_gets_none(self, cloud: Cloud) -> None:
        owner = await add_member(cloud.factory, "ada")
        await _connect_github(cloud, owner)
        console = await enroll_console(cloud.harness, cloud.client, owner)
        agent_id = await self._agent(cloud, console)

        assert (await self._fetch(cloud, console, agent_id)).status_code == 403
        cloud.issue.assert_not_awaited()

    async def test_a_console_controller_is_refused_a_repository(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        console = await enroll_console(cloud.harness, cloud.client, owner)
        await report_status(cloud.client, console, 1, providers=[provider("claude")])

        created = await create_managed_agent(
            cloud.client,
            owner,
            name="cloud-helper",
            controller_id=console.controller_id,
            definition_body=definition(repository=REPOSITORY),
        )

        assert created.status_code == 422, created.text
        assert "Switch cloud machine" in created.json()["error"]["message"]
        async with cloud.factory() as session:
            assert (
                await session.scalar(select(Agent).where(Agent.name == "cloud-helper"))
                is None
            )


class TestTheCloudWorkingDirectory:
    async def test_an_agent_moved_onto_a_cloud_machine_works_in_its_worktree(
        self, cloud: Cloud
    ) -> None:
        owner = await add_member(cloud.factory, "ada")
        controller = await cloud.cloud_controller(owner)
        await report_status(cloud.client, controller, 1, providers=[provider("claude")])
        created = await create_managed_agent(
            cloud.client, owner, name="cloud-helper", controller_id=None
        )
        agent_id = created.json()["agent_id"]

        moved = await cloud.client.patch(
            f"/gateway/management/agents/{agent_id}",
            json={"controller_id": controller.controller_id},
            cookies=cookies_for(owner),
        )

        assert moved.status_code == 200, moved.text
        assert (
            moved.json()["definition"]["directory"]
            == f"/data/worktrees/{agent_id}/workspace"
        )
