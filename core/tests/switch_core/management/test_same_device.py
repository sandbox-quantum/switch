"""A controller enrolling on a device its owner already has, end to end.

Switch Console set up afresh on the same computer (a reinstall, a new data
directory) or a headless controller enrolled again on the same machine says
which machine and OS account it is (`device_id`). A device of its owner's on
the same one that is not running is taken over, agents and all, rather than
another of the same name added beside it; one running now is another
controller's, and is left to it.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta

import httpx
import jwt
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    AgentController,
    AgentControllerOperation,
    SealedProviderLogin,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.management import tokens
from switch_core.management.device_identity import device_hash
from tests.switch_core.management.harness import (
    TOKEN_SECRET,
    EnrolledController,
    Harness,
    add_member,
    build_harness,
    cookies_for,
    enroll_console,
    fixture,
    place_agent,
    platform,
    report_status,
    report_status_only,
    status_report,
)

# The device the status fixture reports, so a controller that reports with it
# stays on the device it enrolled as.
DEVICE = fixture("status_request.json")["machine"]["device_id"]
OTHER_DEVICE = "b" * 64


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _enroll(
    client: httpx.AsyncClient,
    owner: User,
    device_id: str | None,
    *,
    name: str = "laptop",
) -> dict:
    """Switch Console enrolling this computer, as the response says it."""
    response = await client.post(
        "/gateway/management/controllers",
        json={
            "name": name,
            "kind": "console",
            "platform": platform(),
            "version": "0.2.0",
            **({} if device_id is None else {"device_id": device_id}),
        },
        cookies=cookies_for(owner),
    )
    assert response.status_code == 201, response.text
    return dict(response.json())


async def _row(harness: Harness, controller_id: str) -> AgentController:
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        row = await session.get(AgentController, controller_id)
    assert row is not None
    return row


async def _offline(harness: Harness, controller: EnrolledController) -> None:
    """Its socket goes, as when its Console quits."""
    presence = harness.protocol.connections.controllers
    conn = presence.current_connection(controller.controller_id)
    assert conn is not None
    presence.detach_stream(conn, conn.stream_token)
    await harness.management.ledger.flush_all()


async def _exchange(
    client: httpx.AsyncClient, controller_id: str, credential: str
) -> httpx.Response:
    return await client.post(
        f"/v1/management/controllers/{controller_id}/token",
        json={"credential": credential},
    )


async def _assignment(
    client: httpx.AsyncClient, controller_id: str, token: str
) -> httpx.Response:
    return await client.get(
        f"/v1/management/controllers/{controller_id}/assignment",
        headers={"Authorization": f"Bearer {token}"},
    )


class TestTakingOverADevice:
    async def test_a_console_set_up_again_takes_over_its_device_and_agents(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            before = await enroll_console(harness, client, owner, device_id=DEVICE)
            agent_id = await place_agent(client, before, name="buddy")
            await _offline(harness, before)
            again = await _enroll(client, owner, DEVICE, name="laptop (new)")
            stale_exchange = await _exchange(
                client, before.controller_id, before.credential
            )
            stale_token = await _assignment(
                client, before.controller_id, before.access_token
            )
            fresh = await _exchange(client, again["controller_id"], again["credential"])
            assignment = await _assignment(
                client, again["controller_id"], fresh.json()["access_token"]
            )
        row = await _row(harness, before.controller_id)

        assert again["controller_id"] == before.controller_id
        assert again["adopted"] is True
        # The process that held it can do nothing more as it: its credential
        # is gone, and the access token it holds names that credential.
        assert stale_exchange.status_code == 401
        assert stale_exchange.json()["error"]["code"] == "invalid_credential"
        assert stale_token.status_code == 401
        assert stale_token.json()["error"]["code"] == "token_expired"
        assert fresh.status_code == 200, fresh.text
        assert assignment.status_code == 200, assignment.text
        assert [agent["agent_id"] for agent in assignment.json()["agents"]] == [
            agent_id
        ]
        # The owner's name for it stays; what the old process reported goes.
        assert row.name == "laptop"
        assert row.version == "0.2.0"
        assert row.status is None and row.status_seq is None
        assert row.revoked_at is None

    async def test_a_headless_controller_enrolled_again_takes_over_its_machine(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")

        async def enroll() -> dict:
            code = await client.post(
                "/gateway/management/enrollment-codes", cookies=cookies_for(owner)
            )
            body = fixture("enroll_request.json")
            body["proof"]["code"] = code.json()["code"]
            body["controller"]["device_id"] = DEVICE
            response = await client.post("/v1/management/controllers/enroll", json=body)
            assert response.status_code == 201, response.text
            return dict(response.json())

        async with harness.client() as client:
            first = await enroll()
            harness.clock.advance(minutes=2)
            second = await enroll()

        assert first["adopted"] is False
        assert second["adopted"] is True
        assert second["controller_id"] == first["controller_id"]
        assert second["credential"] != first["credential"]

    async def test_what_was_given_to_or_asked_of_the_old_process_goes_with_it(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            before = await enroll_console(harness, client, owner, device_id=DEVICE)
            agent_id = await place_agent(client, before, name="buddy")
            restart = await client.post(
                "/gateway/management/operations",
                json={
                    "controller_id": before.controller_id,
                    "agent_id": agent_id,
                    "kind": "agent.restart",
                },
                cookies=cookies_for(owner),
            )
            assert restart.status_code == 201, restart.text
            async with tenant_session(
                harness.session_factory, TENANT_ZERO_ID
            ) as session:
                session.add(
                    SealedProviderLogin(
                        controller_id=before.controller_id,
                        provider="claude",
                        revision=1,
                        sealed={"alg": "X25519-HKDF-SHA256-A256GCM"},
                        sealed_by=owner.id,
                    )
                )
                await session.commit()
            await _offline(harness, before)
            await _enroll(client, owner, DEVICE)

        async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
            logins = list(
                await session.scalars(
                    select(SealedProviderLogin).where(
                        SealedProviderLogin.controller_id == before.controller_id
                    )
                )
            )
            operations = list(
                await session.scalars(
                    select(AgentControllerOperation).where(
                        AgentControllerOperation.controller_id == before.controller_id
                    )
                )
            )
        assert logins == []
        assert operations, "the restart made an operation"
        assert all(operation.state == "cancelled" for operation in operations)


class TestWhatIsLeftAlone:
    async def test_a_device_running_now_is_another_controllers(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            running = await enroll_console(harness, client, owner, device_id=DEVICE)
            await report_status(client, running, 1)
            second = await _enroll(client, owner, DEVICE)
            still = await _assignment(
                client, running.controller_id, running.access_token
            )

        assert second["adopted"] is False
        assert second["controller_id"] != running.controller_id
        assert still.status_code == 200

    async def test_a_device_just_enrolled_is_left_to_the_process_that_enrolled_it(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            first = await _enroll(client, owner, DEVICE)
            racing = await _enroll(client, owner, DEVICE)
            harness.clock.advance(minutes=2)
            later = await _enroll(client, owner, DEVICE)

        assert racing["adopted"] is False
        assert racing["controller_id"] != first["controller_id"]
        # Once the grace is over, the one seen last (neither ever was: the one
        # made last) is taken over.
        assert later["adopted"] is True
        assert later["controller_id"] == racing["controller_id"]

    async def test_only_the_owners_device_of_the_same_kind_on_the_same_machine(
        self, harness: Harness
    ) -> None:
        ada = await add_member(harness.session_factory, "ada")
        grace = await add_member(harness.session_factory, "grace")
        async with harness.client() as client:
            mine = await _enroll(client, ada, DEVICE)
            harness.clock.advance(minutes=2)
            theirs = await _enroll(client, grace, DEVICE)
            elsewhere = await _enroll(client, ada, OTHER_DEVICE)
            unnamed = await _enroll(client, ada, None)

        for other in (theirs, elsewhere, unnamed):
            assert other["adopted"] is False
            assert other["controller_id"] != mine["controller_id"]

    async def test_a_removed_device_is_not_brought_back(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            removed = await _enroll(client, owner, DEVICE)
            gone = await client.delete(
                f"/gateway/management/controllers/{removed['controller_id']}",
                cookies=cookies_for(owner),
            )
            assert gone.status_code == 200, gone.text
            harness.clock.advance(minutes=2)
            again = await _enroll(client, owner, DEVICE)

        assert again["adopted"] is False
        assert again["controller_id"] != removed["controller_id"]

    async def test_an_older_server_body_without_a_device_is_a_new_device(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            first = await _enroll(client, owner, None)
            harness.clock.advance(minutes=2)
            second = await _enroll(client, owner, None)

        assert second["controller_id"] != first["controller_id"]

    async def test_a_malformed_device_id_is_refused(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            response = await client.post(
                "/gateway/management/controllers",
                json={
                    "name": "laptop",
                    "kind": "console",
                    "platform": platform(),
                    "version": "0.2.0",
                    "device_id": "not-a-device",
                },
                cookies=cookies_for(owner),
            )

        assert response.status_code == 422


class TestTheDeviceKept:
    async def test_is_the_owners_hash_of_the_device_never_the_id(
        self, harness: Harness
    ) -> None:
        ada = await add_member(harness.session_factory, "ada")
        grace = await add_member(harness.session_factory, "grace")
        async with harness.client() as client:
            hers = await _enroll(client, ada, DEVICE)
            his = await _enroll(client, grace, DEVICE)
        her_row = await _row(harness, hers["controller_id"])
        his_row = await _row(harness, his["controller_id"])

        assert her_row.device_hash == device_hash(ada.id, DEVICE)
        assert (
            her_row.device_hash
            == hashlib.sha256(f"{ada.id}\n{DEVICE}".encode()).hexdigest()
        )
        assert his_row.device_hash != her_row.device_hash
        assert DEVICE not in {her_row.device_hash, his_row.device_hash}

    async def test_a_status_report_names_the_device_of_one_enrolled_without(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            unnamed = await _row(harness, controller.controller_id)
            reported = await report_status_only(client, controller, 1)
        row = await _row(harness, controller.controller_id)

        assert unnamed.device_hash is None
        assert reported.status_code == 200, reported.text
        assert row.device_hash == device_hash(owner.id, DEVICE)
        # The device id itself is not kept in the status its owner and the
        # workspace's admins are shown.
        assert row.status is not None
        assert "device_id" not in row.status["machine"]

    async def test_a_malformed_device_id_in_a_report_costs_nothing_but_itself(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner, device_id=DEVICE)
            report = status_report(1)
            report["machine"]["device_id"] = "not-a-device"
            reported = await client.put(
                f"/v1/management/controllers/{controller.controller_id}/status",
                json=report,
                headers=controller.headers,
            )
        row = await _row(harness, controller.controller_id)

        assert reported.status_code == 200, reported.text
        assert row.status_seq == 1
        assert row.device_hash == device_hash(owner.id, DEVICE)


class TestAccessTokens:
    async def test_a_token_from_before_tokens_named_their_credential_still_works(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            now = datetime.now(UTC)
            legacy = tokens.ACCESS_TOKEN_PREFIX + jwt.encode(
                {
                    "cid": controller.controller_id,
                    "tid": TENANT_ZERO_ID,
                    "oid": owner.id,
                    "aud": tokens.ACCESS_TOKEN_AUDIENCE,
                    "iat": int(now.timestamp()),
                    "exp": int((now + timedelta(hours=1)).timestamp()),
                },
                TOKEN_SECRET,
                algorithm=tokens.ACCESS_TOKEN_ALGORITHM,
            )
            response = await _assignment(client, controller.controller_id, legacy)

        assert response.status_code == 200, response.text
