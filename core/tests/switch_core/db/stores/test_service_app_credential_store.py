"""The operator's connector apps, stored encrypted, against Postgres."""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import ServiceAppCredential, User
from switch_core.db.stores.service_app_credential_store import (
    MissingSecretsError,
    ServiceAppCredentialStore,
)
from switch_core.keys import Keyring, UndecryptableError
from tests.conftest import TEST_KEYRING

STORE = ServiceAppCredentialStore(TEST_KEYRING)
GITHUB_SECRETS = frozenset({"client_secret", "private_key"})


async def _user(session_factory: async_sessionmaker[AsyncSession], name: str) -> str:
    async with session_factory() as session:
        user = User(
            name=name,
            email=f"{name}-{uuid.uuid4().hex[:6]}@example.invalid",
            role="admin",
        )
        session.add(user)
        await session.commit()
        return user.id


async def _save(
    session: AsyncSession, operator: str, secrets: dict[str, str]
) -> ServiceAppCredential:
    return await STORE.save(
        session,
        service="github",
        client_id="example-client-id",
        settings={"slug": "example-app"},
        secrets=secrets,
        secret_names=GITHUB_SECRETS,
        updated_by=operator,
    )


class TestSave:
    async def test_a_first_save_stores_the_secrets_encrypted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        operator = await _user(session_factory, "operator")
        async with session_factory() as session:
            await _save(
                session,
                operator,
                {"client_secret": "example-secret-0000", "private_key": "pem-0000"},
            )
            await session.commit()
            raw = await session.scalar(
                text(
                    "SELECT encrypted_secrets FROM service_app_credentials "
                    "WHERE service = 'github'"
                )
            )
            row = await STORE.get(session, "github")

        assert isinstance(raw, str) and "example-secret-0000" not in raw
        assert row is not None
        assert row.client_id == "example-client-id"
        assert row.settings == {"slug": "example-app"}
        assert row.updated_by == operator
        assert STORE.secrets(row) == {
            "client_secret": "example-secret-0000",
            "private_key": "pem-0000",
        }

    async def test_a_first_save_needs_every_secret(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        operator = await _user(session_factory, "operator")
        async with session_factory() as session:
            with pytest.raises(MissingSecretsError) as refused:
                await _save(session, operator, {"client_secret": "example-secret-0000"})
        assert refused.value.names == ["private_key"]

    async def test_a_secret_the_kind_lacks_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        operator = await _user(session_factory, "operator")
        async with session_factory() as session:
            with pytest.raises(ValueError, match="no secret named"):
                await _save(
                    session,
                    operator,
                    {
                        "client_secret": "example-secret-0000",
                        "private_key": "pem-0000",
                        "certificate": "nope",
                    },
                )

    async def test_a_partial_save_keeps_the_other_secret(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        first = await _user(session_factory, "first")
        second = await _user(session_factory, "second")
        async with session_factory() as session:
            await _save(
                session,
                first,
                {"client_secret": "example-secret-0000", "private_key": "pem-0000"},
            )
            await session.commit()
            row = await _save(session, second, {"client_secret": "example-secret-1111"})
            await session.commit()

        assert row.updated_by == second
        assert STORE.secrets(row) == {
            "client_secret": "example-secret-1111",
            "private_key": "pem-0000",
        }

    async def test_two_partial_saves_at_once_both_land(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        operator = await _user(session_factory, "operator")
        async with session_factory() as session:
            await _save(
                session,
                operator,
                {"client_secret": "example-secret-0000", "private_key": "pem-0000"},
            )
            await session.commit()

        async def save(secrets: dict[str, str]) -> None:
            async with session_factory() as session:
                await _save(session, operator, secrets)
                # Hold the lock long enough for the other save to queue on it.
                await asyncio.sleep(0.1)
                await session.commit()

        await asyncio.gather(
            save({"client_secret": "example-secret-1111"}),
            save({"private_key": "pem-1111"}),
        )

        async with session_factory() as session:
            row = await STORE.get(session, "github")
        assert row is not None
        assert STORE.secrets(row) == {
            "client_secret": "example-secret-1111",
            "private_key": "pem-1111",
        }

    async def test_every_secret_replaces_one_no_key_opens(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        operator = await _user(session_factory, "operator")
        retired = Keyring.parse("retired:" + "r" * 40, legacy_secret=None)
        async with session_factory() as session:
            session.add(
                ServiceAppCredential(
                    service="github",
                    client_id="example-client-id",
                    settings={"slug": "example-app"},
                    encrypted_secrets=retired.encrypt(
                        json.dumps({"client_secret": "x"})
                    ),
                    updated_by=operator,
                )
            )
            await session.commit()

            with pytest.raises(UndecryptableError):
                await _save(session, operator, {"client_secret": "example-secret-1111"})
            await session.rollback()

            row = await _save(
                session,
                operator,
                {"client_secret": "example-secret-1111", "private_key": "pem-1111"},
            )
            await session.commit()
        assert STORE.secrets(row)["client_secret"] == "example-secret-1111"

    async def test_updated_by_is_required(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            with pytest.raises(IntegrityError):
                await _save(
                    session,
                    "no-such-user",
                    {"client_secret": "example-secret-0000", "private_key": "pem"},
                )


class TestRemove:
    async def test_remove_returns_the_row_and_leaves_none(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        operator = await _user(session_factory, "operator")
        async with session_factory() as session:
            await _save(
                session,
                operator,
                {"client_secret": "example-secret-0000", "private_key": "pem-0000"},
            )
            await session.commit()

            removed = await STORE.remove(session, "github")
            await session.commit()
            assert removed is not None and removed.client_id == "example-client-id"
            assert await STORE.get(session, "github") is None
            assert await STORE.list_all(session) == {}
            assert await STORE.remove(session, "github") is None


class TestRecordSettings:
    async def test_what_the_vendor_says_again_replaces_the_settings_alone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        operator = await _user(session_factory, "operator")
        checker = await _user(session_factory, "checker")
        settings = {"slug": "example-app", "permissions": {"contents": "read"}}
        async with session_factory() as session:
            await _save(
                session,
                operator,
                {"client_secret": "example-secret-0000", "private_key": "pem-0000"},
            )
            await session.commit()
            row = await STORE.record_settings(
                session,
                service="github",
                client_id="example-client-id",
                settings=settings,
                updated_by=checker,
            )
            await session.commit()
        assert row is not None
        assert (row.settings, row.updated_by) == (settings, checker)
        assert STORE.secrets(row) == {
            "client_secret": "example-secret-0000",
            "private_key": "pem-0000",
        }

    async def test_nothing_is_written_for_an_app_no_longer_saved(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        operator = await _user(session_factory, "operator")
        async with session_factory() as session:
            assert (
                await STORE.record_settings(
                    session,
                    service="github",
                    client_id="example-client-id",
                    settings={"slug": "example-app"},
                    updated_by=operator,
                )
                is None
            )
            await _save(
                session,
                operator,
                {"client_secret": "example-secret-0000", "private_key": "pem-0000"},
            )
            await session.commit()
            assert (
                await STORE.record_settings(
                    session,
                    service="github",
                    client_id="another-client-id",
                    settings={"slug": "another-app"},
                    updated_by=operator,
                )
                is None
            )
            await session.commit()
            row = await STORE.get(session, "github")
        assert row is not None and row.settings == {"slug": "example-app"}
