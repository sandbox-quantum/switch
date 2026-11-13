"""A vendor that revokes by access token: the loader's setting, and what the
broker does with it when a person connects again, disconnects, or a new
sign-in is not kept.

The adapter's own handling is in `adapters/test_oauth_bearer_revocation.py`.
Here the vendor is the broker's stand-in, so these show when the broker asks
for a revocation, and what it tells the person after.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time

import pytest
from sqlalchemy import select

from switch_core.connections import broker as broker_module
from switch_core.connections.adapters import (
    ConnectionSecret,
    ServiceAdapterError,
)
from switch_core.connections.loader import CATALOG_ROOT, CatalogError, load_catalog
from switch_core.db.models import ServiceConnection
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.test_broker import (
    _issue,
    _pass_through,
)
from tests.switch_core.connections.test_loader import OAUTH_ENTRY, _write_example

BEARER = (
    "    redirect: [loopback, core]\n"
    "    revocation_url: https://api.example.test/2/revoke\n"
    "    revocation_bearer: true\n"
)
BEARER_ENTRY = OAUTH_ENTRY.replace("    redirect: [loopback, core]\n", BEARER)
TAKEN_BACK = "cannot be taken back and may keep working until"


@pytest.fixture
def catalog(tmp_path):
    root = tmp_path / "catalog"
    shutil.copytree(CATALOG_ROOT, root)
    return root


class TestTheSetting:
    def test_is_off_unless_an_entry_turns_it_on(self, catalog) -> None:
        _write_example(catalog)
        oauth = load_catalog(catalog)["example"].definition.auth.oauth
        assert oauth is not None and oauth.revocation_bearer is False

    def test_names_the_call_it_changes(self, catalog) -> None:
        _write_example(catalog, BEARER_ENTRY)
        oauth = load_catalog(catalog)["example"].definition.auth.oauth
        assert oauth is not None
        assert oauth.revocation_bearer is True
        assert oauth.revocation_url == "https://api.example.test/2/revoke"

    def test_needs_the_address_to_call(self, catalog) -> None:
        _write_example(
            catalog,
            OAUTH_ENTRY.replace(
                "    redirect: [loopback, core]\n",
                "    redirect: [loopback, core]\n    revocation_bearer: true\n",
            ),
        )
        with pytest.raises(CatalogError, match="named revocation_url"):
            load_catalog(catalog)

    def test_is_not_for_a_discovered_endpoint(self, catalog) -> None:
        _write_example(
            catalog,
            OAUTH_ENTRY.replace(
                "    redirect: [loopback, core]\n",
                "    redirect: [loopback, core]\n"
                "    revocation_discovered: true\n    revocation_bearer: true\n",
            ),
        )
        with pytest.raises(CatalogError, match="named revocation_url"):
            load_catalog(catalog)

    def test_is_a_yes_or_no(self, catalog) -> None:
        _write_example(catalog, BEARER_ENTRY.replace("bearer: true", 'bearer: "yes"'))
        with pytest.raises(CatalogError):
            load_catalog(catalog)


async def _connection(session_factory, owner_id: str) -> ServiceConnection | None:
    async with session_factory() as session:
        return await session.scalar(
            select(ServiceConnection).where(
                ServiceConnection.user_id == owner_id,
                ServiceConnection.service == "example",
            )
        )


def _new_secret() -> ConnectionSecret:
    return ConnectionSecret(
        {
            "access_token": "owner_access_1",
            "expires_at": time.time() + 3000,
            "refresh_token": "owner_refresh_1",
        }
    )


async def _relink(pt, session_factory) -> str | None:
    async with session_factory() as session:
        return await pt.broker.connect(
            session,
            user_id=pt.world.owner.id,
            service="example",
            consent="write",
            granted_scopes=["read:items", "write:items"],
            account_id="acct-1",
            external_identity="ada@example.test",
            secret=_new_secret(),
            oauth_client_id=None,
        )


async def _with_token(session_factory, tmp_path, entry: str):
    pt = await _pass_through(
        session_factory, tmp_path / "c", expires_in=50 * 60, entry=entry
    )
    await _issue(pt.broker, session_factory, pt.world.agent.id, service="example")
    return pt


class TestConnectingAgain:
    async def test_revokes_the_old_sign_in_only_after_the_new_one_is_saved(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _pass_through(
            session_factory, tmp_path / "c", expires_in=50 * 60, entry=BEARER_ENTRY
        )
        seen: list[tuple[str | None, str]] = []

        async def revoke(secret: ConnectionSecret) -> None:
            row = await _connection(session_factory, pt.world.owner.id)
            assert row is not None
            stored = json.loads(TEST_KEYRING.decrypt(row.encrypted_secret))
            seen.append((secret.access_token, stored["access_token"]))

        pt.vendor.revoke_connection = revoke  # type: ignore[method-assign]
        assert await _relink(pt, session_factory) is None
        assert seen == [("owner_access_0", "owner_access_1")]

    async def test_revokes_when_the_same_account_signs_in_again_through_the_same_client(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _pass_through(
            session_factory, tmp_path / "c", expires_in=50 * 60, entry=BEARER_ENTRY
        )
        pt.vendor.client_id = "client-1"
        revoked: list[str] = []

        async def revoke(secret: ConnectionSecret) -> None:
            revoked.append(secret.access_token)

        pt.vendor.revoke_connection = revoke  # type: ignore[method-assign]
        assert await _relink(pt, session_factory) is None
        assert revoked == ["owner_access_0"]

    async def test_a_save_that_fails_revokes_nothing(
        self, session_factory, tmp_path, monkeypatch
    ) -> None:
        pt = await _pass_through(
            session_factory, tmp_path / "c", expires_in=50 * 60, entry=BEARER_ENTRY
        )

        async def refuse(*args, **kwargs):
            raise RuntimeError("the save failed")

        monkeypatch.setattr(pt.broker._store, "save_connection", refuse)
        with pytest.raises(RuntimeError, match="the save failed"):
            await _relink(pt, session_factory)
        assert pt.vendor.connections_revoked == []
        row = await _connection(session_factory, pt.world.owner.id)
        assert row is not None
        stored = json.loads(TEST_KEYRING.decrypt(row.encrypted_secret))
        assert stored["access_token"] == "owner_access_0"

    async def test_says_nothing_of_tokens_that_may_keep_working_once_they_are_ended(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _with_token(session_factory, tmp_path, BEARER_ENTRY)
        assert await _relink(pt, session_factory) is None
        assert len(pt.vendor.connections_revoked) == 1

    async def test_an_entry_without_the_setting_still_says_so(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _with_token(session_factory, tmp_path, OAUTH_ENTRY)
        warning = await _relink(pt, session_factory)
        assert warning is not None and TAKEN_BACK in warning
        assert len(pt.vendor.connections_revoked) == 1

    async def test_a_failed_revoke_keeps_the_new_connection_and_leaks_nothing(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _with_token(session_factory, tmp_path, BEARER_ENTRY)

        async def refuse(secret: ConnectionSecret) -> None:
            raise ServiceAdapterError(f"refused {secret.access_token}")

        pt.vendor.revoke_connection = refuse  # type: ignore[method-assign]
        warning = await _relink(pt, session_factory)
        assert warning is not None
        assert "Example could not revoke the old sign-in." in warning
        assert "Revoke it in your Example settings." in warning
        assert TAKEN_BACK in warning
        assert "owner_access_0" not in warning
        row = await _connection(session_factory, pt.world.owner.id)
        assert row is not None and row.status == "active"
        stored = json.loads(TEST_KEYRING.decrypt(row.encrypted_secret))
        assert stored["access_token"] == "owner_access_1"

    async def test_a_revoke_that_times_out_does_the_same(
        self, session_factory, tmp_path, monkeypatch
    ) -> None:
        pt = await _with_token(session_factory, tmp_path, BEARER_ENTRY)

        async def hang(secret: ConnectionSecret) -> None:
            await asyncio.sleep(5)

        pt.vendor.revoke_connection = hang  # type: ignore[method-assign]
        monkeypatch.setattr(broker_module, "VENDOR_CALL_SECONDS", 0.05)
        warning = await _relink(pt, session_factory)
        assert warning is not None
        assert "Example could not revoke the old sign-in." in warning
        assert TAKEN_BACK in warning
        row = await _connection(session_factory, pt.world.owner.id)
        assert row is not None and row.status == "active"


class TestDisconnecting:
    async def test_revokes_and_says_nothing_of_tokens_that_may_keep_working(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _with_token(session_factory, tmp_path, BEARER_ENTRY)
        async with session_factory() as session:
            warning = await pt.broker.disconnect(session, pt.world.owner.id, "example")
        assert warning is None
        assert len(pt.vendor.connections_revoked) == 1
        assert await _connection(session_factory, pt.world.owner.id) is None

    async def test_an_entry_without_the_setting_still_says_so(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _with_token(session_factory, tmp_path, OAUTH_ENTRY)
        async with session_factory() as session:
            warning = await pt.broker.disconnect(session, pt.world.owner.id, "example")
        assert warning is not None and TAKEN_BACK in warning

    async def test_a_failed_revoke_still_disconnects_and_says_so(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _with_token(session_factory, tmp_path, BEARER_ENTRY)

        async def refuse(secret: ConnectionSecret) -> None:
            raise ServiceAdapterError(f"refused {secret.access_token}")

        pt.vendor.revoke_connection = refuse  # type: ignore[method-assign]
        async with session_factory() as session:
            warning = await pt.broker.disconnect(session, pt.world.owner.id, "example")
        assert warning is not None
        assert (
            "Example could not revoke the sign-in. Revoke it in your Example" in warning
        )
        assert TAKEN_BACK in warning and "owner_access_0" not in warning
        assert await _connection(session_factory, pt.world.owner.id) is None


class TestASignInThatIsNotKept:
    async def test_is_revoked(self, session_factory, tmp_path) -> None:
        pt = await _pass_through(
            session_factory, tmp_path / "c", expires_in=50 * 60, entry=BEARER_ENTRY
        )
        secret = _new_secret()
        async with session_factory() as session:
            note = await pt.broker._revoke_unkept(session, "example", secret, None)
        assert note is None and pt.vendor.connections_revoked == [secret]

    async def test_that_cannot_be_revoked_tells_the_person_where_to_remove_it(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _pass_through(
            session_factory, tmp_path / "c", expires_in=50 * 60, entry=BEARER_ENTRY
        )

        async def refuse(secret: ConnectionSecret) -> None:
            raise ServiceAdapterError("no")

        pt.vendor.revoke_connection = refuse  # type: ignore[method-assign]
        async with session_factory() as session:
            note = await pt.broker._revoke_unkept(
                session, "example", _new_secret(), None
            )
        assert note is not None and "connected apps" in note


class TestOnlyARevokedSignInEndsTheWarning:
    async def test_removing_an_agents_grant_still_says_its_token_may_keep_working(
        self, session_factory, tmp_path
    ) -> None:
        pt = await _with_token(session_factory, tmp_path, BEARER_ENTRY)
        async with session_factory() as session:
            warning = await pt.broker.revoke_grant(
                session,
                await pt.broker._store.get_grant(session, pt.world.agent.id, "example"),  # type: ignore[arg-type]
                pt.world.owner.id,
            )
        assert warning is not None and TAKEN_BACK in warning
        assert pt.vendor.connections_revoked == []


class TestACancelledRequest:
    """The revocation runs once the change has committed, and the old secret
    lives only in memory from then on: a request cancelled meanwhile (a client
    gone, a restart) must still revoke."""

    async def _cancelled_during_revoke(
        self, session_factory, tmp_path, act, fail=False
    ):
        pt = await _pass_through(
            session_factory, tmp_path / "c", expires_in=50 * 60, entry=BEARER_ENTRY
        )
        started = asyncio.Event()
        finished: list[str | None] = []

        async def revoke(secret: ConnectionSecret) -> None:
            started.set()
            await asyncio.sleep(0.2)
            finished.append(secret.access_token)
            if fail:
                raise ServiceAdapterError("refused")

        pt.vendor.revoke_connection = revoke  # type: ignore[method-assign]
        task = asyncio.create_task(act(pt))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return pt, finished

    async def test_connecting_again_still_revokes_the_old_sign_in(
        self, session_factory, tmp_path
    ) -> None:
        pt, finished = await self._cancelled_during_revoke(
            session_factory, tmp_path, lambda pt: _relink(pt, session_factory)
        )
        assert finished == ["owner_access_0"]
        row = await _connection(session_factory, pt.world.owner.id)
        assert row is not None
        stored = json.loads(TEST_KEYRING.decrypt(row.encrypted_secret))
        assert stored["access_token"] == "owner_access_1"

    async def test_disconnecting_still_revokes_the_sign_in(
        self, session_factory, tmp_path
    ) -> None:
        async def disconnect(pt) -> None:
            async with session_factory() as session:
                await pt.broker.disconnect(session, pt.world.owner.id, "example")

        pt, finished = await self._cancelled_during_revoke(
            session_factory, tmp_path, disconnect
        )
        assert finished == ["owner_access_0"]
        assert await _connection(session_factory, pt.world.owner.id) is None

    async def test_a_sign_in_that_is_not_kept_is_still_revoked(
        self, session_factory, tmp_path
    ) -> None:
        async def unkept(pt) -> None:
            async with session_factory() as session:
                await pt.broker._revoke_unkept(session, "example", _new_secret(), None)

        _, finished = await self._cancelled_during_revoke(
            session_factory, tmp_path, unkept
        )
        assert finished == ["owner_access_1"]

    async def test_a_revoke_that_then_fails_is_logged_not_raised(
        self, session_factory, tmp_path, caplog
    ) -> None:
        caplog.set_level(logging.ERROR)
        _, finished = await self._cancelled_during_revoke(
            session_factory,
            tmp_path,
            lambda pt: _relink(pt, session_factory),
            fail=True,
        )
        assert finished == ["owner_access_0"]
        assert "failed after its caller was cancelled" in caplog.text
        assert "owner_access_0" not in caplog.text
