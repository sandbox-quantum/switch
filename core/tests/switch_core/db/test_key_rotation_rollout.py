"""Rolling a new front key out to several processes, in two phases.

Each process records the ids of its keys on its lease; one starting with a
front key that a live process lacks refuses to start, since what it writes
under that key would be unreadable to the other.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.registration_bootstrap import BOOTSTRAP_KEY_TYPE
from switch_core.config import SwitchConfig
from switch_core.db.key_rotation import (
    KeyRotationError,
    reencrypt_stale_text,
    require_front_key_readable,
)
from switch_core.db.models import ApiKey, TrustSettings
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.db.stores.user_store import UserStore
from switch_core.keys import Keyring
from switch_core.main import _seed_admin_and_bootstrap_key
from switch_core.process_lease import ProcessLease

OLD = "old:" + "o" * 40
NEW = "new:" + "n" * 40


async def _running(
    session_factory: async_sessionmaker[AsyncSession],
    process_id: str,
    key_ids: list[str],
) -> ProcessLease:
    lease = ProcessLease(
        process_id=process_id,
        session_factory=session_factory,
        processes=SwitchCoreProcessStore(),
        key_ids=key_ids,
    )
    await lease.renew()
    return lease


def _keyring(value: str) -> Keyring:
    return Keyring.parse(value, legacy_secret=None)


async def _boot_seeding(
    session_factory: async_sessionmaker[AsyncSession],
    process_id: str,
    secret_keys: str,
    registration_token: str,
) -> None:
    """The seeding a process does at boot, with these keys and token."""
    config = SwitchConfig(
        db_host="unused",
        db_port="5432",
        db_user="unused",
        db_password="unused",
        db_name="unused",
        id_server_name="test",
        agent_registration_token=registration_token,
        secret_keys=secret_keys,
        gateway_admin_email="admin@switch.local",
        gateway_admin_password="unused",
    )
    await _seed_admin_and_bootstrap_key(
        session_factory, UserStore(), ApiKeyStore(), AgentStore(), config, process_id
    )


async def test_a_new_front_key_another_process_lacks_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _running(session_factory, "old-pod", ["old"])
    starting = _keyring(f"{NEW},{OLD}")
    await _running(session_factory, "new-pod", ["new", "old"])

    with pytest.raises(KeyRotationError, match="two phases"):
        await require_front_key_readable(session_factory, starting, "new-pod")


async def test_a_refused_process_has_encrypted_nothing_under_its_front_key(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The boot seeding rewrites the agent-registration bootstrap key under
    the front key when AGENT_REGISTRATION_TOKEN changes. A process refused
    only after that would already have stored a value the old one cannot
    decrypt."""
    await _running(session_factory, "old-pod", ["old"])
    await _boot_seeding(session_factory, "old-pod", OLD, "first-token")

    with pytest.raises(KeyRotationError, match="two phases"):
        await _boot_seeding(session_factory, "new-pod", f"{NEW},{OLD}", "second-token")

    async with session_factory() as session:
        stored = await session.scalar(
            select(ApiKey.encrypted_key).where(ApiKey.type == BOOTSTRAP_KEY_TYPE)
        )
    assert stored is not None
    assert _keyring(OLD).decrypt(stored) == "first-token"


async def test_a_key_every_process_already_holds_may_go_to_the_front(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The second phase: the old processes were given the key at the back."""
    await _running(session_factory, "old-pod", ["old", "new"])
    await _running(session_factory, "new-pod", ["new", "old"])

    await require_front_key_readable(
        session_factory, _keyring(f"{NEW},{OLD}"), "new-pod"
    )


async def test_the_first_phase_adds_a_key_at_the_back(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _running(session_factory, "old-pod", ["old"])
    await _running(session_factory, "new-pod", ["old", "new"])

    await require_front_key_readable(
        session_factory, _keyring(f"{OLD},{NEW}"), "new-pod"
    )


async def test_a_process_that_stopped_is_not_counted(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """One replica replaced rather than rolled rotates in one step, as before."""
    old = await _running(session_factory, "old-pod", ["old"])
    await old.stop()

    await require_front_key_readable(session_factory, _keyring(NEW), "new-pod")


async def test_a_process_from_before_the_check_is_named_not_refused(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    async with session_factory() as session:
        await session.execute(
            text("INSERT INTO switch_core_processes (id) VALUES ('older-pod')")
        )
        await session.commit()

    with caplog.at_level(logging.WARNING, logger="switch_core.db.key_rotation"):
        await require_front_key_readable(session_factory, _keyring(NEW), "new-pod")

    assert "older-pod" in caplog.text


class _WritesFirst:
    """A keyring that, as the sweep re-encrypts a value, lets another process
    write a fresh one to the same row and commit it first."""

    def __init__(self, keyring: Keyring, write: Any) -> None:
        self._keyring = keyring
        self._write = write

    def current_prefix(self) -> str:
        return self._keyring.current_prefix()

    def decrypt(self, value: str) -> str:
        return self._keyring.decrypt(value)

    def encrypt(self, plaintext: str) -> str:
        self._write()
        return self._keyring.encrypt(plaintext)


async def test_a_value_written_during_the_sweep_is_kept(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    old, new = _keyring(OLD), _keyring(f"{NEW},{OLD}")
    async with session_factory() as session:
        session.add(
            TrustSettings(
                id="rollout-test",
                endpoint="https://trust.example.test",
                api_key_encrypted=old.encrypt("read-by-the-sweep"),
            )
        )
        await session.commit()

    pending: list[Any] = []

    def write_elsewhere() -> None:
        async def write() -> None:
            async with session_factory() as other:
                await other.execute(
                    update(TrustSettings)
                    .where(TrustSettings.id == "rollout-test")
                    .values(api_key_encrypted=new.encrypt("written-meanwhile"))
                )
                await other.commit()

        pending.append(write())

    sweeping = _WritesFirst(new, write_elsewhere)
    async with session_factory() as session:
        rows = await session.execute(
            select(TrustSettings.id, TrustSettings.api_key_encrypted).where(
                TrustSettings.id == "rollout-test"
            )
        )
        assert rows.all()
        # Run the other process's write between the sweep's read and its update.
        original_execute = session.execute

        async def execute(statement: Any, *args: Any, **kwargs: Any) -> Any:
            for write in pending:
                await write
            pending.clear()
            return await original_execute(statement, *args, **kwargs)

        session.execute = execute  # type: ignore[method-assign]
        rewritten = await reencrypt_stale_text(
            session,
            sweeping,  # type: ignore[arg-type]
            TrustSettings,
            "api_key_encrypted",
        )
        await session.commit()

    assert rewritten == 0
    async with session_factory() as session:
        stored = await session.scalar(
            select(TrustSettings.api_key_encrypted).where(
                TrustSettings.id == "rollout-test"
            )
        )
    assert stored is not None and new.decrypt(stored) == "written-meanwhile"
