"""Provider logins sealed to a controller's own key, end to end against Postgres.

A controller registers its public key; its owner gives it a login sealed to
that key, which the controller is told to take up through a `provider.login`
operation and fetches as ciphertext; the owner can take it back. Switch
checks the envelope and the key it names, and never sees inside.
"""

from __future__ import annotations

import base64
import os

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.management.sealed_logins import key_id
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    add_member,
    build_harness,
    cookies_for,
    enroll_console,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


def _b64(size: int) -> str:
    return base64.b64encode(os.urandom(size)).decode()


def _sealed(public_key: str, **overrides: str) -> dict[str, str]:
    return {
        "alg": "X25519-HKDF-SHA256-A256GCM",
        "key_id": key_id(public_key),
        "ephemeral_key": _b64(32),
        "nonce": _b64(12),
        "ciphertext": _b64(80),
        **overrides,
    }


async def _register_key(client, controller: EnrolledController, key: str):
    return await client.patch(
        f"/v1/management/controllers/{controller.controller_id}",
        json={"public_key": {"alg": "X25519", "key": key}},
        headers=controller.headers,
    )


def _logins_path(controller: EnrolledController, provider: str | None = None) -> str:
    path = f"/gateway/management/controllers/{controller.controller_id}/provider-logins"
    return f"{path}/{provider}" if provider else path


class TestPublicKey:
    async def test_a_controller_registers_its_key_once(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        key = _b64(32)
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            first = await _register_key(client, controller, key)
            same = await _register_key(client, controller, key)
            other = await _register_key(client, controller, _b64(32))
            listed = await client.get(
                "/gateway/management/controllers", cookies=cookies_for(owner)
            )
        assert first.status_code == 200, first.text
        assert first.json()["public_key"] == {
            "alg": "X25519",
            "key": key,
            "key_id": key_id(key),
        }
        assert same.status_code == 200, same.text
        assert other.status_code == 409, other.text
        assert listed.json()[0]["public_key"]["key"] == key

    @pytest.mark.parametrize(
        "public_key",
        [
            {"alg": "RSA", "key": base64.b64encode(b"k" * 32).decode()},
            {"alg": "X25519", "key": base64.b64encode(b"short").decode()},
            {"alg": "X25519", "key": "not base64!"},
        ],
    )
    async def test_anything_but_an_x25519_key_is_refused(
        self, harness: Harness, public_key: dict[str, str]
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            response = await client.patch(
                f"/v1/management/controllers/{controller.controller_id}",
                json={"public_key": public_key},
                headers=controller.headers,
            )
        assert response.status_code == 422, response.text


class TestSealedLogins:
    async def test_the_owner_gives_a_login_the_controller_fetches(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        key = _b64(32)
        sealed = _sealed(key)
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await _register_key(client, controller, key)
            given = await client.put(
                _logins_path(controller, "claude"),
                json={"sealed": sealed},
                cookies=cookies_for(owner),
            )
            fetched = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/provider-credentials/claude",
                headers=controller.headers,
            )
            pending = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/operations",
                params={"state": "pending"},
                headers=controller.headers,
            )
            again = await client.put(
                _logins_path(controller, "claude"),
                json={"sealed": _sealed(key)},
                cookies=cookies_for(owner),
            )
            listed = await client.get(
                _logins_path(controller), cookies=cookies_for(owner)
            )
        assert given.status_code == 200, given.text
        body = given.json()
        assert body["login"]["provider"] == "claude"
        assert body["login"]["revision"] == 1
        assert "ciphertext" not in body["login"]
        assert body["operation"]["kind"] == "provider.login"
        assert body["operation"]["params"] == {
            "provider": "claude",
            "method": "sealed",
            "revision": 1,
        }
        assert fetched.status_code == 200, fetched.text
        assert fetched.headers["cache-control"] == "no-store"
        assert fetched.json() == {"provider": "claude", "revision": 1, "sealed": sealed}
        assert [operation["kind"] for operation in pending.json()["operations"]] == [
            "provider.login"
        ]
        assert again.json()["login"]["revision"] == 2
        assert [(login["provider"], login["revision"]) for login in listed.json()] == [
            ("claude", 2)
        ]

    async def test_a_missing_login_is_provider_login_missing(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            response = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/provider-credentials/codex",
                headers=controller.headers,
            )
        assert response.status_code == 404, response.text
        assert response.json()["error"]["code"] == "provider_login_missing"

    async def test_a_login_sealed_to_another_key_is_refused(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            keyless = await client.put(
                _logins_path(controller, "claude"),
                json={"sealed": _sealed(_b64(32))},
                cookies=cookies_for(owner),
            )
            await _register_key(client, controller, _b64(32))
            stale = await client.put(
                _logins_path(controller, "claude"),
                json={"sealed": _sealed(_b64(32))},
                cookies=cookies_for(owner),
            )
        assert keyless.status_code == 409, keyless.text
        assert stale.status_code == 409, stale.text
        assert "no longer has" in stale.json()["error"]["message"]

    async def test_a_malformed_envelope_or_provider_is_refused(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        key = _b64(32)
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await _register_key(client, controller, key)
            short_nonce = await client.put(
                _logins_path(controller, "claude"),
                json={"sealed": _sealed(key, nonce=_b64(8))},
                cookies=cookies_for(owner),
            )
            plaintext = await client.put(
                _logins_path(controller, "claude"),
                json={"kind": "api-key", "credential": "sk-ant-api-placeholder"},
                cookies=cookies_for(owner),
            )
            unknown = await client.put(
                _logins_path(controller, "notepad"),
                json={"sealed": _sealed(key)},
                cookies=cookies_for(owner),
            )
        assert short_nonce.status_code == 422, short_nonce.text
        assert plaintext.status_code == 422, plaintext.text
        assert unknown.status_code == 422, unknown.text

    async def test_only_the_owner_sees_or_gives_a_machine_logins(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        other = await add_member(harness.session_factory, "bob")
        key = _b64(32)
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await _register_key(client, controller, key)
            given = await client.put(
                _logins_path(controller, "claude"),
                json={"sealed": _sealed(key)},
                cookies=cookies_for(other),
            )
            listed = await client.get(
                _logins_path(controller), cookies=cookies_for(other)
            )
        assert given.status_code == 404, given.text
        assert listed.status_code == 404, listed.text

    async def test_withdrawing_a_login_has_the_controller_recheck(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        key = _b64(32)
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await _register_key(client, controller, key)
            await client.put(
                _logins_path(controller, "claude"),
                json={"sealed": _sealed(key)},
                cookies=cookies_for(owner),
            )
            withdrawn = await client.delete(
                _logins_path(controller, "claude"), cookies=cookies_for(owner)
            )
            twice = await client.delete(
                _logins_path(controller, "claude"), cookies=cookies_for(owner)
            )
            fetched = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/provider-credentials/claude",
                headers=controller.headers,
            )
            pending = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/operations",
                params={"state": "pending"},
                headers=controller.headers,
            )
        assert withdrawn.status_code == 200, withdrawn.text
        assert twice.status_code == 404, twice.text
        assert fetched.status_code == 404, fetched.text
        assert [operation["kind"] for operation in pending.json()["operations"]] == [
            "provider.login",
            "provider.recheck",
        ]

    async def test_revoking_the_machine_drops_its_logins(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        key = _b64(32)
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await _register_key(client, controller, key)
            await client.put(
                _logins_path(controller, "claude"),
                json={"sealed": _sealed(key)},
                cookies=cookies_for(owner),
            )
            revoked = await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(owner),
            )
            listed = await client.get(
                _logins_path(controller), cookies=cookies_for(owner)
            )
            again = await client.put(
                _logins_path(controller, "claude"),
                json={"sealed": _sealed(key)},
                cookies=cookies_for(owner),
            )
        assert revoked.status_code == 200, revoked.text
        assert listed.json() == []
        assert again.status_code == 409, again.text
