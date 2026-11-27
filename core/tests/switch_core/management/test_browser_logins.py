"""Browser sign-ins on a machine, end to end against Postgres.

The owner starts one (`provider.login` with `method: "browser"`); the
controller reports the sign-in page as progress, which the owner reads with
the operation; the owner sends back the code the page showed, which the
controller takes once on its next progress; and the controller keeps the
login it ends with as one given to it, sealed to its own key.
"""

from __future__ import annotations

import base64
import os

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, AgentController
from switch_core.db.session_scope import tenant_session
from switch_core.management.sealed_logins import key_id
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    add_member,
    build_harness,
    cookies_for,
    enroll_console,
)

URL = "https://claude.ai/oauth/authorize?code=true&state=abc"


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


def _b64(size: int) -> str:
    return base64.b64encode(os.urandom(size)).decode()


def _sealed(public_key: str) -> dict[str, str]:
    return {
        "alg": "X25519-HKDF-SHA256-A256GCM",
        "key_id": key_id(public_key),
        "ephemeral_key": _b64(32),
        "nonce": _b64(12),
        "ciphertext": _b64(80),
    }


async def _keyed(harness: Harness, client, name: str = "ada"):
    owner = await add_member(harness.session_factory, name)
    controller = await enroll_console(harness, client, owner)
    key = _b64(32)
    registered = await client.patch(
        f"/v1/management/controllers/{controller.controller_id}",
        json={"public_key": {"alg": "X25519", "key": key}},
        headers=controller.headers,
    )
    assert registered.status_code == 200, registered.text
    return owner, controller, key


async def _start(client, controller: EnrolledController, provider: str = "claude"):
    return await client.post(
        f"/gateway/management/controllers/{controller.controller_id}"
        f"/provider-logins/{provider}/browser",
        cookies=cookies_for(controller.owner),
    )


async def _claimed(client, controller: EnrolledController) -> str:
    started = await _start(client, controller)
    assert started.status_code == 200, started.text
    operation_id = started.json()["operation"]["id"]
    claimed = await client.post(
        f"/v1/management/operations/{operation_id}/claim", headers=controller.headers
    )
    assert claimed.status_code == 200, claimed.text
    return str(operation_id)


async def _progress(client, controller: EnrolledController, operation_id: str, **body):
    return await client.post(
        f"/v1/management/operations/{operation_id}/progress",
        json={"message": "waiting for the sign-in", **body},
        headers=controller.headers,
    )


async def _code(client, controller: EnrolledController, operation_id: str, code: str):
    return await client.post(
        f"/gateway/management/operations/{operation_id}/sign-in-code",
        json={"code": code},
        cookies=cookies_for(controller.owner),
    )


async def _operation(client, controller: EnrolledController, operation_id: str):
    listed = await client.get(
        "/gateway/management/operations",
        params={"controller_id": controller.controller_id},
        cookies=cookies_for(controller.owner),
    )
    return next(op for op in listed.json() if op["id"] == operation_id)


class TestBrowserSignIn:
    async def test_the_sign_in_from_page_to_kept_login(self, harness: Harness) -> None:
        async with harness.client() as client:
            _owner, controller, key = await _keyed(harness, client)
            started = await _start(client, controller)
            operation_id = started.json()["operation"]["id"]
            offered = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/operations",
                headers=controller.headers,
            )
            await client.post(
                f"/v1/management/operations/{operation_id}/claim",
                headers=controller.headers,
            )
            early = await _code(client, controller, operation_id, "abc#def")
            reported = await _progress(
                client,
                controller,
                operation_id,
                sign_in={"url": URL, "needs_code": True},
            )
            seen = await _operation(client, controller, operation_id)
            sent = await _code(client, controller, operation_id, "  abc#def  ")
            again = await _code(client, controller, operation_id, "other")
            taken = await _progress(client, controller, operation_id)
            after = await _progress(client, controller, operation_id)
            seen_after = await _operation(client, controller, operation_id)
            kept = await client.put(
                f"/v1/management/operations/{operation_id}/provider-login",
                json={"sealed": _sealed(key)},
                headers=controller.headers,
            )
            fetched = await client.get(
                f"/v1/management/controllers/{controller.controller_id}"
                "/provider-credentials/claude",
                headers=controller.headers,
            )
            done = await client.post(
                f"/v1/management/operations/{operation_id}/result",
                json={"outcome": "succeeded", "output": {}},
                headers=controller.headers,
            )
            late = await client.put(
                f"/v1/management/operations/{operation_id}/provider-login",
                json={"sealed": _sealed(key)},
                headers=controller.headers,
            )

        assert started.status_code == 200, started.text
        assert started.json()["operation"]["params"] == {
            "provider": "claude",
            "method": "browser",
        }
        assert [op["id"] for op in offered.json()["operations"]] == [operation_id]
        assert early.status_code == 409, early.text
        assert reported.status_code == 204, reported.text
        assert seen["progress"] == {
            "message": "waiting for the sign-in",
            "sign_in": {"url": URL, "needs_code": True},
        }
        assert sent.status_code == 200, sent.text
        assert again.status_code == 409, again.text
        assert taken.status_code == 200, taken.text
        assert taken.json() == {"input": {"code": "abc#def"}}
        assert taken.headers["cache-control"] == "no-store"
        assert after.status_code == 204, after.text
        # The latest report stands; the code sent is never shown back.
        assert seen_after["progress"] == {"message": "waiting for the sign-in"}
        assert "abc#def" not in str(seen_after)
        assert kept.status_code == 200, kept.text
        assert kept.json()["provider"] == "claude"
        assert kept.json()["revision"] == 1
        assert fetched.status_code == 200, fetched.text
        assert fetched.json()["revision"] == 1
        assert done.status_code == 204, done.text
        assert late.status_code == 409, late.text

    async def test_starting_again_cancels_the_running_one(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            _owner, controller, _key = await _keyed(harness, client)
            first = await _claimed(client, controller)
            second = await _start(client, controller)
            stale = await _progress(client, controller, first)
            codex = await _start(client, controller, "codex")
            first_seen = await _operation(client, controller, first)
            second_seen = await _operation(
                client, controller, second.json()["operation"]["id"]
            )

        assert second.status_code == 200, second.text
        assert stale.status_code == 410, stale.text
        assert first_seen["state"] == "cancelled"
        # Another provider's sign-in is its own.
        assert codex.status_code == 200, codex.text
        assert second_seen["state"] == "pending"

    async def test_a_cloud_device_signs_in_nothing_through_a_browser(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            _owner, controller, _key = await _keyed(harness, client)
            async with tenant_session(
                harness.session_factory, TENANT_ZERO_ID
            ) as session:
                await session.execute(
                    update(AgentController)
                    .where(AgentController.id == controller.controller_id)
                    .values(kind="ec2")
                )
                await session.commit()
            refused = {
                provider: await _start(client, controller, provider)
                for provider in ("claude", "codex", "cursor", "antigravity", "opencode")
            }

        for provider, response in refused.items():
            assert response.status_code == 422, (provider, response.text)

    async def test_each_provider_with_a_browser_sign_in_starts_one(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            _owner, controller, _key = await _keyed(harness, client)
            started = {
                provider: await _start(client, controller, provider)
                for provider in ("cursor", "antigravity", "opencode")
            }

        for provider, response in started.items():
            assert response.status_code == 200, (provider, response.text)
            assert response.json()["operation"]["params"] == {
                "provider": provider,
                "method": "browser",
            }

    async def test_what_cannot_be_signed_in_is_refused(self, harness: Harness) -> None:
        async with harness.client() as client:
            owner = await add_member(harness.session_factory, "ada")
            keyless = await enroll_console(harness, client, owner)
            no_key = await _start(client, keyless)
            _owner, controller, _key = await _keyed(harness, client, "bob")
            pi = await _start(client, controller, "pi")
            unknown = await _start(client, controller, "nope")

        assert no_key.status_code == 409, no_key.text
        assert pi.status_code == 422, pi.text
        assert unknown.status_code == 422, unknown.text

    async def test_only_the_owner_sends_a_code_and_only_one_line(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            _owner, controller, _key = await _keyed(harness, client)
            operation_id = await _claimed(client, controller)
            await _progress(
                client,
                controller,
                operation_id,
                sign_in={"url": URL, "needs_code": True},
            )
            stranger = await add_member(harness.session_factory, "eve")
            theirs = await client.post(
                f"/gateway/management/operations/{operation_id}/sign-in-code",
                json={"code": "abc"},
                cookies=cookies_for(stranger),
            )
            two_lines = await _code(client, controller, operation_id, "abc\nexit")
            spaced = await _code(client, controller, operation_id, "abc def")
            empty = await _code(client, controller, operation_id, "   ")
            nothing_taken = await _progress(client, controller, operation_id)

        assert theirs.status_code == 404, theirs.text
        assert two_lines.status_code == 422, two_lines.text
        assert spaced.status_code == 422, spaced.text
        assert empty.status_code == 422, empty.text
        assert nothing_taken.status_code == 204, nothing_taken.text

    async def test_a_device_code_sign_in_takes_no_code(self, harness: Harness) -> None:
        async with harness.client() as client:
            _owner, controller, _key = await _keyed(harness, client)
            operation_id = await _claimed(client, controller)
            reported = await _progress(
                client,
                controller,
                operation_id,
                sign_in={
                    "url": "https://auth.openai.com/codex/device",
                    "user_code": "ABCD-12345",
                    "needs_code": False,
                },
            )
            code = await _code(client, controller, operation_id, "abc")
            seen = await _operation(client, controller, operation_id)

        assert reported.status_code == 204, reported.text
        assert code.status_code == 409, code.text
        assert seen["progress"]["sign_in"]["user_code"] == "ABCD-12345"

    @pytest.mark.parametrize(
        "sign_in",
        [
            {"url": "javascript:alert(1)", "needs_code": True},
            {"url": "http://claude.ai/oauth", "needs_code": True},
            {"url": URL, "needs_code": "yes"},
            {"url": URL, "user_code": "x" * 65, "needs_code": False},
        ],
    )
    async def test_a_malformed_sign_in_report_is_refused(
        self, harness: Harness, sign_in: dict
    ) -> None:
        async with harness.client() as client:
            _owner, controller, _key = await _keyed(harness, client)
            operation_id = await _claimed(client, controller)
            reported = await _progress(
                client, controller, operation_id, sign_in=sign_in
            )
        assert reported.status_code == 422, reported.text

    async def test_a_login_is_kept_only_for_a_browser_sign_in_and_its_key(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            _owner, controller, key = await _keyed(harness, client)
            recheck = await client.post(
                "/gateway/management/operations",
                json={
                    "controller_id": controller.controller_id,
                    "kind": "provider.recheck",
                    "params": {"provider": "claude"},
                },
                cookies=cookies_for(controller.owner),
            )
            recheck_id = recheck.json()["id"]
            await client.post(
                f"/v1/management/operations/{recheck_id}/claim",
                headers=controller.headers,
            )
            not_sign_in = await client.put(
                f"/v1/management/operations/{recheck_id}/provider-login",
                json={"sealed": _sealed(key)},
                headers=controller.headers,
            )
            operation_id = await _claimed(client, controller)
            other_key = await client.put(
                f"/v1/management/operations/{operation_id}/provider-login",
                json={"sealed": _sealed(_b64(32))},
                headers=controller.headers,
            )

        assert not_sign_in.status_code == 409, not_sign_in.text
        assert other_key.status_code == 409, other_key.text
