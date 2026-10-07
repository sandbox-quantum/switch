"""The controller-facing routes, end to end against Postgres.

Enrollment by one-time code, token exchange, credential rotation, the
assignment and its ETag, status reports and the state derived from them,
the operation lifecycle, and the bindings placement keeps in Core.
"""

from __future__ import annotations

import hashlib

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.db.models import AgentControllerEnrollmentCode
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.management.bindings import load_bindings
from switch_core.management.controller_routes import ASSIGNMENT_FORMAT
from tests.switch_core.management.harness import (
    SERVER_URL,
    EnrolledController,
    Harness,
    add_member,
    bearer,
    build_harness,
    cookies_for,
    create_managed_agent,
    definition,
    enroll_console,
    fixture,
    provider,
    report_status,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _code(harness: Harness, owner_cookies: dict[str, str]) -> str:
    async with harness.client() as client:
        response = await client.post(
            "/gateway/management/enrollment-codes", cookies=owner_cookies
        )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["code"].startswith("swce_")
    return str(body["code"])


class TestEnrollmentCodes:
    async def test_a_code_names_the_server_to_enroll_against(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            response = await client.post(
                "/gateway/management/enrollment-codes", cookies=cookies_for(owner)
            )
        assert response.status_code == 201, response.text
        assert response.json()["server_url"] == SERVER_URL

    async def test_an_unconfigured_server_is_null_not_guessed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        harness = build_harness(session_factory, server_url=None)
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            response = await client.post(
                "/gateway/management/enrollment-codes", cookies=cookies_for(owner)
            )
        assert response.status_code == 201, response.text
        assert response.json()["server_url"] is None
        assert response.json()["code"].startswith("swce_")


def _enroll_body(code: str) -> dict:
    body = fixture("enroll_request.json")
    body["proof"]["code"] = code
    return body


class TestEnrollmentByCode:
    async def test_a_code_enrolls_once(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        code = await _code(harness, cookies_for(owner))

        async with harness.client() as client:
            first = await client.post(
                "/v1/management/controllers/enroll", json=_enroll_body(code)
            )
            second = await client.post(
                "/v1/management/controllers/enroll", json=_enroll_body(code)
            )

        assert first.status_code == 201, first.text
        assert first.json()["credential"].startswith("swcc_")
        assert second.status_code == 401
        assert second.json()["error"]["code"] == "enrollment_code_invalid"

    async def test_the_enrolled_controller_belongs_to_the_codes_owner(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        code = await _code(harness, cookies_for(owner))
        async with harness.client() as client:
            enrolled = await client.post(
                "/v1/management/controllers/enroll", json=_enroll_body(code)
            )
            listed = await client.get(
                "/gateway/management/controllers", cookies=cookies_for(owner)
            )
        assert [c["id"] for c in listed.json()] == [enrolled.json()["controller_id"]]
        assert listed.json()[0]["kind"] == "daemon"
        assert listed.json()[0]["state"] == "unknown"
        assert listed.json()[0]["description"] == "The build box in the office"

    async def test_a_description_is_optional_at_enrollment(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        code = await _code(harness, cookies_for(owner))
        body = _enroll_body(code)
        del body["controller"]["description"]
        async with harness.client() as client:
            enrolled = await client.post("/v1/management/controllers/enroll", json=body)
            listed = await client.get(
                "/gateway/management/controllers", cookies=cookies_for(owner)
            )
        assert enrolled.status_code == 201, enrolled.text
        assert listed.json()[0]["description"] is None

    async def test_an_overlong_description_is_refused(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        code = await _code(harness, cookies_for(owner))
        body = _enroll_body(code)
        body["controller"]["description"] = "x" * 501
        async with harness.client() as client:
            refused = await client.post("/v1/management/controllers/enroll", json=body)
        assert refused.status_code == 422
        assert refused.json()["error"]["code"] == "validation_error"

    async def test_a_used_code_leaves_no_credential_behind(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        code = await _code(harness, cookies_for(owner))
        async with harness.client() as client:
            await client.post(
                "/v1/management/controllers/enroll", json=_enroll_body(code)
            )
        code_hash = hashlib.sha256(code.encode()).hexdigest()
        async with harness.session_factory() as session:
            assert await ApiKeyStore().get_by_hash(session, code_hash) is None
            row = (
                await session.execute(select(AgentControllerEnrollmentCode))
            ).scalar_one()
            assert row.used_at is not None
            assert row.controller_id is not None
            assert row.api_key_id is None

    async def test_an_expired_code_is_refused(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        code = await _code(harness, cookies_for(owner))
        harness.clock.advance(minutes=11)
        async with harness.client() as client:
            response = await client.post(
                "/v1/management/controllers/enroll", json=_enroll_body(code)
            )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "enrollment_code_invalid"

    async def test_an_unknown_code_is_refused(self, harness: Harness) -> None:
        async with harness.client() as client:
            response = await client.post(
                "/v1/management/controllers/enroll",
                json=_enroll_body("swce_not_issued_by_anyone"),
            )
        assert response.status_code == 401
        assert response.json() == {
            "error": {
                "code": "enrollment_code_invalid",
                "message": "The enrollment code is invalid, already used, or expired.",
                "retryable": False,
            }
        }

    async def test_a_malformed_body_is_a_validation_error(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            response = await client.post(
                "/v1/management/controllers/enroll", json={"proof": {}}
            )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"


class TestTokenExchange:
    async def test_the_credential_buys_an_access_token(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
        assert controller.access_token.startswith("swct_")

    async def test_a_wrong_credential_is_refused(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            response = await client.post(
                f"/v1/management/controllers/{controller.controller_id}/token",
                json={"credential": "swcc_wrong"},
            )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "invalid_credential"

    async def test_a_credential_for_another_controller_is_refused(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            first = await enroll_console(harness, client, owner, "one")
            second = await enroll_console(harness, client, owner, "two")
            response = await client.post(
                f"/v1/management/controllers/{second.controller_id}/token",
                json={"credential": first.credential},
            )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "invalid_credential"

    async def test_a_revoked_controllers_credential_no_longer_exchanges(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(owner),
            )
            response = await client.post(
                f"/v1/management/controllers/{controller.controller_id}/token",
                json={"credential": controller.credential},
            )
        # Revocation deletes the credential, so it no longer resolves at all.
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "invalid_credential"


class TestCredentialRotation:
    async def test_rotation_replaces_the_credential(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            rotated = await client.post(
                f"/v1/management/controllers/{controller.controller_id}/credential/rotate",
                headers=controller.headers,
            )
            old = await client.post(
                f"/v1/management/controllers/{controller.controller_id}/token",
                json={"credential": controller.credential},
            )
            new = await client.post(
                f"/v1/management/controllers/{controller.controller_id}/token",
                json={"credential": rotated.json()["credential"]},
            )
        assert rotated.status_code == 200
        assert old.status_code == 401
        assert new.status_code == 200


class TestAssignment:
    async def test_carries_each_agents_isolation(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("claude")])
            for name, body in (
                ("shared-one", definition()),
                ("isolated-one", definition(isolation="isolated")),
            ):
                created = await create_managed_agent(
                    client,
                    owner,
                    name=name,
                    controller_id=controller.controller_id,
                    definition_body=body,
                )
                assert created.status_code == 201, created.text
            refused = await create_managed_agent(
                client,
                owner,
                name="sandboxed",
                controller_id=controller.controller_id,
                definition_body=definition(isolation="sandboxed"),
            )
            assignment = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/assignment",
                headers=controller.headers,
            )

        isolation = {
            entry["definition"]["name"]: entry["definition"]["isolation"]
            for entry in assignment.json()["agents"]
        }
        assert isolation == {"shared-one": "shared", "isolated-one": "isolated"}
        assert refused.status_code == 422

    async def test_etag_and_not_modified(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            path = f"/v1/management/controllers/{controller.controller_id}/assignment"
            first = await client.get(path, headers=controller.headers)
            etag = first.headers["ETag"]
            unchanged = await client.get(
                path, headers={**controller.headers, "If-None-Match": etag}
            )
            # Saved under an earlier definition format: pulled again in full.
            earlier_format = await client.get(
                path, headers={**controller.headers, "If-None-Match": '"0"'}
            )
            await report_status(client, controller, 1, providers=[provider("claude")])
            created = await create_managed_agent(
                client, owner, name="reviewer", controller_id=controller.controller_id
            )
            changed = await client.get(
                path, headers={**controller.headers, "If-None-Match": etag}
            )

        assert first.status_code == 200
        assert first.json() == {"revision": 0, "agents": []}
        assert etag == f'"{ASSIGNMENT_FORMAT}-0"'
        assert unchanged.status_code == 304
        assert unchanged.headers["ETag"] == etag
        assert earlier_format.status_code == 200
        assert created.status_code == 201, created.text
        assert changed.status_code == 200
        assert changed.headers["ETag"] == f'"{ASSIGNMENT_FORMAT}-1"'
        [entry] = changed.json()["agents"]
        assert entry["agent_id"] == created.json()["agent_id"]
        assert entry["revision"] == 1
        assert entry["definition"]["name"] == "reviewer"

    async def test_another_controllers_assignment_is_forbidden(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            first = await enroll_console(harness, client, owner, "one")
            second = await enroll_console(harness, client, owner, "two")
            response = await client.get(
                f"/v1/management/controllers/{second.controller_id}/assignment",
                headers=first.headers,
            )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "forbidden"


class TestStatus:
    async def test_a_report_makes_the_controller_online_until_it_goes_stale(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            response = await report_status(client, controller, 5)
            online = await client.get(
                "/gateway/management/controllers", cookies=cookies_for(owner)
            )
            harness.clock.advance(seconds=3 * 60 + 1)
            stale = await client.get(
                "/gateway/management/controllers", cookies=cookies_for(owner)
            )
        assert response.status_code == 200, response.text
        assert response.json() == {"assignment_revision": 0, "report_within_s": 60}
        assert online.json()[0]["state"] == "online"
        assert online.json()[0]["status"]["seq"] == 5
        assert stale.json()[0]["state"] == "unknown"

    async def test_an_older_seq_is_ignored_but_answered(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 7, providers=[provider("claude")])
            older = await report_status(
                client, controller, 6, providers=[provider("codex")]
            )
            same = await report_status(
                client, controller, 7, providers=[provider("codex")]
            )
            listed = await client.get(
                "/gateway/management/controllers", cookies=cookies_for(owner)
            )
        assert older.status_code == 200
        assert same.status_code == 200
        status = listed.json()[0]["status"]
        assert status["seq"] == 7
        assert [p["provider"] for p in status["providers"]] == ["claude"]

    async def test_a_failed_agent_without_a_reason_is_refused(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        report = fixture("status_request.json")
        del report["agents"][1]["reason"]
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            response = await client.put(
                f"/v1/management/controllers/{controller.controller_id}/status",
                json=report,
                headers=controller.headers,
            )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"

    async def test_an_oversized_report_is_refused(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        report = fixture("status_request.json")
        report["agents"][0]["detail"] = "x" * (64 * 1024)
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            response = await client.put(
                f"/v1/management/controllers/{controller.controller_id}/status",
                json=report,
                headers=controller.headers,
            )
        assert response.status_code == 413
        assert response.json()["error"]["code"] == "validation_error"

    async def test_an_unsupported_protocol_version_is_refused(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            response = await client.put(
                f"/v1/management/controllers/{controller.controller_id}/status",
                json=fixture("status_request.json"),
                headers={**controller.headers, "Switch-Controller-Protocol": "1"},
            )
            accepted = await client.put(
                f"/v1/management/controllers/{controller.controller_id}/status",
                json=fixture("status_request.json"),
                headers={**controller.headers, "Switch-Controller-Protocol": "2"},
            )
        assert response.status_code == 426
        assert response.json()["error"]["code"] == "protocol_unsupported"
        assert response.headers["Switch-Controller-Protocol-Accepts"] == "2-2"
        assert accepted.status_code == 200
        assert accepted.headers["Switch-Controller-Protocol-Accepts"] == "2-2"


async def _placed_agent(
    harness: Harness, client, controller: EnrolledController, name: str = "reviewer"
) -> str:
    await report_status(client, controller, 1, providers=[provider("claude")])
    created = await create_managed_agent(
        client, controller.owner, name=name, controller_id=controller.controller_id
    )
    assert created.status_code == 201, created.text
    return str(created.json()["agent_id"])


async def _operation(client, controller: EnrolledController, **body) -> dict:
    response = await client.post(
        "/gateway/management/operations",
        json={"controller_id": controller.controller_id, **body},
        cookies=cookies_for(controller.owner),
    )
    assert response.status_code == 201, response.text
    return dict(response.json())


class TestOperations:
    async def test_the_lifecycle(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await _placed_agent(harness, client, controller)
            created = await _operation(
                client, controller, kind="agent.restart", agent_id=agent_id
            )
            listed = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/operations",
                params={"state": "pending"},
                headers=controller.headers,
            )
            claim_path = f"/v1/management/operations/{created['id']}/claim"
            claimed = await client.post(claim_path, headers=controller.headers)
            again = await client.post(claim_path, headers=controller.headers)
            relisted = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/operations",
                headers=controller.headers,
            )
            progress = await client.post(
                f"/v1/management/operations/{created['id']}/progress",
                json={"message": "restarting"},
                headers=controller.headers,
            )
            result_path = f"/v1/management/operations/{created['id']}/result"
            done = await client.post(
                result_path,
                json=fixture("operation_result_succeeded.json"),
                headers=controller.headers,
            )
            repeat = await client.post(
                result_path,
                json=fixture("operation_result_failed.json"),
                headers=controller.headers,
            )
            claim_after = await client.post(claim_path, headers=controller.headers)
            history = await client.get(
                "/gateway/management/operations",
                params={"controller_id": controller.controller_id},
                cookies=cookies_for(owner),
            )

        assert created["state"] == "pending"
        assert [op["id"] for op in listed.json()["operations"]] == [created["id"]]
        assert "lease_expires_at" not in listed.json()["operations"][0]
        assert claimed.status_code == 200
        assert "lease_expires_at" in claimed.json()
        assert again.status_code == 200
        assert again.json() == claimed.json()
        assert relisted.json()["operations"] == []
        assert progress.status_code == 204
        assert done.status_code == 204
        assert repeat.status_code == 204
        assert claim_after.status_code == 409
        assert claim_after.json()["error"]["code"] == "already_claimed"
        [op] = history.json()
        assert op["state"] == "succeeded"
        assert op["result"] == fixture("operation_result_succeeded.json")

    async def test_an_expired_lease_is_offered_again(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            created = await _operation(
                client,
                controller,
                kind="provider.recheck",
                params={"provider": "claude"},
            )
            await client.post(
                f"/v1/management/operations/{created['id']}/claim",
                headers=controller.headers,
            )
            harness.clock.advance(minutes=5, seconds=1)
            listed = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/operations",
                headers=controller.headers,
            )
            reclaimed = await client.post(
                f"/v1/management/operations/{created['id']}/claim",
                headers=controller.headers,
            )
        assert [op["id"] for op in listed.json()["operations"]] == [created["id"]]
        assert reclaimed.status_code == 200

    async def test_an_operation_left_open_expires(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            created = await _operation(
                client,
                controller,
                kind="provider.recheck",
                params={"provider": "claude"},
            )
            harness.clock.advance(hours=2)
            # Created at the database's clock; the test clock moving past the
            # TTL is what makes it overdue.
            listed = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/operations",
                headers=controller.headers,
            )
            claimed = await client.post(
                f"/v1/management/operations/{created['id']}/claim",
                headers=controller.headers,
            )
        assert listed.json()["operations"] == []
        assert claimed.status_code == 410
        assert claimed.json()["error"]["code"] == "lease_expired"

    async def test_a_cancelled_operation_cannot_be_claimed(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await _placed_agent(harness, client, controller)
            created = await _operation(
                client, controller, kind="agent.restart", agent_id=agent_id
            )
            # Unmanaging the agent cancels its open operations.
            await client.delete(
                f"/gateway/management/agents/{agent_id}", cookies=cookies_for(owner)
            )
            claimed = await client.post(
                f"/v1/management/operations/{created['id']}/claim",
                headers=controller.headers,
            )
        assert claimed.status_code == 410
        assert claimed.json()["error"]["code"] == "cancelled"

    async def test_a_result_before_a_claim_is_refused(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            created = await _operation(
                client,
                controller,
                kind="provider.recheck",
                params={"provider": "claude"},
            )
            response = await client.post(
                f"/v1/management/operations/{created['id']}/result",
                json=fixture("operation_result_succeeded.json"),
                headers=controller.headers,
            )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "lease_expired"

    async def test_another_controllers_operation_is_not_found(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            first = await enroll_console(harness, client, owner, "one")
            second = await enroll_console(harness, client, owner, "two")
            created = await _operation(
                client, first, kind="provider.recheck", params={"provider": "claude"}
            )
            response = await client.post(
                f"/v1/management/operations/{created['id']}/claim",
                headers=second.headers,
            )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"

    @pytest.mark.parametrize("kind", ["agent.start", "session.open", "rm -rf"])
    async def test_an_unsupported_kind_is_refused(
        self, harness: Harness, kind: str
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            response = await client.post(
                "/gateway/management/operations",
                json={"controller_id": controller.controller_id, "kind": kind},
                cookies=cookies_for(owner),
            )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "operation_unsupported"


class TestPlacementBindsTheAgentInCore:
    async def test_placing_moving_and_removing_rebind_it(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        presence = harness.protocol.connections.controllers
        async with harness.client() as client:
            first = await enroll_console(harness, client, owner, "one")
            second = await enroll_console(harness, client, owner, "two")
            agent_id = await _placed_agent(harness, client, first)
            placed = presence.binding(agent_id)
            await report_status(client, second, 1, providers=[provider("claude")])
            moved = await client.patch(
                f"/gateway/management/agents/{agent_id}",
                json={"controller_id": second.controller_id},
                cookies=cookies_for(owner),
            )
            after_move = presence.binding(agent_id)
            first_assignment = await client.get(
                f"/v1/management/controllers/{first.controller_id}/assignment",
                headers=first.headers,
            )
            second_assignment = await client.get(
                f"/v1/management/controllers/{second.controller_id}/assignment",
                headers=second.headers,
            )
            removed = await client.delete(
                f"/gateway/management/agents/{agent_id}", cookies=cookies_for(owner)
            )

        assert placed is not None
        assert placed.controller_id == first.controller_id
        assert moved.status_code == 200, moved.text
        assert moved.json()["revision"] == 2
        assert (
            after_move is not None and after_move.controller_id == second.controller_id
        )
        assert first_assignment.json() == {"revision": 2, "agents": []}
        assert [a["agent_id"] for a in second_assignment.json()["agents"]] == [agent_id]
        assert removed.status_code == 200, removed.text
        assert presence.binding(agent_id) is None

    async def test_the_wanted_state_reaches_the_binding(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        presence = harness.protocol.connections.controllers
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await _placed_agent(harness, client, controller)
            running = presence.binding(agent_id)
            stop = await client.patch(
                f"/gateway/management/agents/{agent_id}",
                json={"desired_state": "stopped"},
                cookies=cookies_for(owner),
            )
            stopped = presence.binding(agent_id)
            presence.unbind(agent_id, "unassigned")
            await harness.management.load_bindings()
            reloaded = presence.binding(agent_id)
            start = await client.patch(
                f"/gateway/management/agents/{agent_id}",
                json={"desired_state": "running"},
                cookies=cookies_for(owner),
            )
            started = presence.binding(agent_id)

        assert stop.status_code == 200, stop.text
        assert start.status_code == 200, start.text
        assert running is not None and running.running is True
        assert stopped is not None and stopped.running is False
        assert presence.is_stopped(agent_id) is False
        assert reloaded is not None and reloaded.running is False
        assert started is not None and started.running is True

    async def test_an_unplaced_agent_is_not_bound(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            created = await create_managed_agent(
                client, owner, name="idle", controller_id=None
            )
        assert created.status_code == 201, created.text
        assert (
            harness.protocol.connections.controllers.binding(created.json()["agent_id"])
            is None
        )

    async def test_bindings_are_loaded_from_every_tenant_at_startup(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await _placed_agent(harness, client, controller)
        presence = harness.protocol.connections.controllers
        presence.unbind(agent_id, "unassigned")
        assert presence.binding(agent_id) is None

        loaded = await harness.management.load_bindings()

        assert loaded == 1
        binding = presence.binding(agent_id)
        assert binding is not None
        assert binding.controller_id == controller.controller_id
        assert binding.controller_name == "laptop"
        assert not presence.is_revoked(controller.controller_id)

    async def test_a_revoked_controller_reads_as_revoked_after_a_restart(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner, "workstation")
            agent_id = await _placed_agent(harness, client, controller)
            revoked = await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(owner),
            )
        assert revoked.status_code in (200, 204), revoked.text
        restarted = AgentConnectionRegistry().controllers

        await load_bindings(
            session_factory=harness.session_factory,
            definitions=harness.management.service.definitions,
            controllers=harness.management.service.controllers,
            presence=restarted,
        )

        binding = restarted.binding(agent_id)
        assert binding is not None and binding.controller_name == "workstation"
        assert restarted.is_revoked(controller.controller_id)


def test_bearer_helper() -> None:
    assert bearer("x") == {"Authorization": "Bearer x"}


def test_definition_helper_is_the_v1_shape() -> None:
    assert set(definition()) == {
        "provider",
        "model",
        "instructions",
        "auto_approve",
        "directory",
        "isolation",
    }
