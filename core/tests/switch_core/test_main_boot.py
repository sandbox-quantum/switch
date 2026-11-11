"""Core really boots: `python -m switch_core.main` in a subprocess, the way the
image's CMD starts it, against an empty database of its own.

Every other test imports `switch_core.main`, which never runs the module as
`__main__`, never migrates from nothing and never starts the lifespan's
background workers. So a boot-only failure passed every test until a
rehearsal (30 Oct): helpers defined below the `__main__` guard crashed startup
with NameError. `test_main_entrypoint_order.py` pins that one layout; this
boots the real thing, so any failure on the way to serving shows up here.

It also pins the exit status. uvicorn's `Server.serve()` returns normally when
the app's startup fails, so Core used to exit 0 after that crash: a clean stop
to `restart: on-failure`, Kubernetes or any supervisor, which would leave it
down unnoticed. A failed startup now exits non-zero.
"""

from __future__ import annotations

import os
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine
from uvicorn.main import STARTUP_FAILURE

_CORE = Path(__file__).resolve().parents[2]
#: Migrating an empty database and starting every worker, on a loaded runner.
_BOOT_TIMEOUT_S = 120.0
#: How long Core must stay up and healthy after its first 200.
_STAY_UP_S = 5.0
_STOP_TIMEOUT_S = 30.0
#: The test server's flags, so their workers start as they do there.
_FLAGS = "agent_management,hosted_agents,switch_buddy,agent_chats"


@dataclass(frozen=True)
class BootDatabase:
    host: str
    port: str
    name: str
    owner: str
    owner_password: str
    runtime: str
    runtime_password: str


@pytest.fixture
async def boot_database(postgres_url: str) -> AsyncIterator[BootDatabase]:
    """An empty database and a fresh restricted runtime role, both throwaway.

    Empty, not the session's create_all schema: boot has to migrate from
    nothing, as a new deployment does. The role is only created here; Core's
    own boot grants it (`_migrate_and_grant`), as it does on a server.
    """
    url = make_url(postgres_url)
    name = f"boot_{uuid.uuid4().hex[:12]}"
    runtime = f"switch_boot_{uuid.uuid4().hex[:12]}"
    runtime_password = secrets.token_hex(16)
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'CREATE DATABASE "{name}"'))
        # CREATE ROLE takes no bind parameter for PASSWORD; this one is a
        # fresh random throwaway.
        await connection.execute(
            text(
                f"CREATE ROLE \"{runtime}\" LOGIN PASSWORD '{runtime_password}' "
                "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
            )
        )
    try:
        yield BootDatabase(
            host=url.host or "127.0.0.1",
            port=str(url.port or 5432),
            name=name,
            owner=url.username or "",
            owner_password=url.password or "",
            runtime=runtime,
            runtime_password=runtime_password,
        )
    finally:
        async with admin.connect() as connection:
            await connection.execute(
                text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
            )
            await connection.execute(text(f'DROP ROLE IF EXISTS "{runtime}"'))
        await admin.dispose()


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _boot_env(tmp_path: Path, db: BootDatabase, port: int) -> dict[str, str]:
    """Only what Core needs, all throwaway: nothing leaks in from the runner's
    own environment."""
    return {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(tmp_path),
        "DB_HOST": db.host,
        "DB_PORT": db.port,
        "DB_NAME": db.name,
        "DB_USER": db.runtime,
        "DB_PASSWORD": db.runtime_password,
        "DB_OWNER_USER": db.owner,
        "DB_OWNER_PASSWORD": db.owner_password,
        "SERVER_HOST": "127.0.0.1",
        "SERVER_PORT": str(port),
        "SECRET_KEYS": f"boot:{secrets.token_hex(32)}",
        "AGENT_REGISTRATION_TOKEN": secrets.token_hex(24),
        "CONTROLLER_TOKEN_SECRET": secrets.token_hex(32),
        "ID_SERVER_NAME": "boot-test.invalid",
        "GATEWAY_ADMIN_EMAIL": "boot-admin@example.com",
        "GATEWAY_ADMIN_PASSWORD": secrets.token_hex(16),
        "FEATURE_FLAGS_ENABLED": _FLAGS,
        "TELEMETRY_ENABLED": "false",
        "TELEMETRY_ENVIRONMENT": "local",
    }


@dataclass
class Booted:
    process: subprocess.Popen[bytes]
    log: Path

    def text(self) -> str:
        return self.log.read_text(errors="replace")


StartCore = Callable[[list[str], dict[str, str]], "Booted"]


@pytest.fixture
def start_core(tmp_path: Path) -> Iterator[StartCore]:
    """Starts Core as a subprocess with its output in a file (a pipe nobody
    reads would fill and stall it), and kills whatever is left at the end."""
    started: list[Booted] = []

    def start(args: list[str], env: dict[str, str]) -> Booted:
        log = tmp_path / f"core-{len(started)}.log"
        with log.open("wb") as out:
            process = subprocess.Popen(  # noqa: S603 - our own interpreter and module
                [sys.executable, *args],
                cwd=_CORE,
                env=env,
                stdout=out,
                stderr=subprocess.STDOUT,
            )
        booted = Booted(process, log)
        started.append(booted)
        return booted

    yield start
    for booted in started:
        if booted.process.poll() is None:
            booted.process.kill()
            booted.process.wait(timeout=_STOP_TIMEOUT_S)


def _health(port: int) -> int | None:
    try:
        with urllib.request.urlopen(  # noqa: S310 - a fixed local URL
            f"http://127.0.0.1:{port}/health", timeout=2
        ) as answer:
            return int(answer.status)
    except (urllib.error.URLError, ConnectionError, TimeoutError):
        return None


def _wait_healthy(booted: Booted, port: int) -> None:
    deadline = time.monotonic() + _BOOT_TIMEOUT_S
    while time.monotonic() < deadline:
        if booted.process.poll() is not None:
            pytest.fail(
                f"Core exited {booted.process.returncode} before serving:\n"
                + booted.text()[-4000:]
            )
        if _health(port) == 200:
            return
        time.sleep(0.5)
    pytest.fail(
        f"Core didn't reach health 200 in {_BOOT_TIMEOUT_S}s:\n" + booted.text()[-4000:]
    )


def _wait_exit(booted: Booted) -> int:
    try:
        return booted.process.wait(timeout=_BOOT_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        pytest.fail("Core was still running:\n" + booted.text()[-4000:])


def test_python_m_boots_core_serves_and_stops_cleanly(
    tmp_path: Path, boot_database: BootDatabase, start_core: StartCore
) -> None:
    port = _free_port()
    booted = start_core(
        ["-m", "switch_core.main"], _boot_env(tmp_path, boot_database, port)
    )
    _wait_healthy(booted, port)
    time.sleep(_STAY_UP_S)
    assert booted.process.poll() is None, booted.text()[-4000:]
    assert _health(port) == 200
    log = booted.text()
    assert "Traceback" not in log, log[-4000:]
    booted.process.send_signal(signal.SIGTERM)
    assert _wait_exit(booted) == 0, booted.text()[-4000:]


def test_a_startup_failure_exits_non_zero(
    tmp_path: Path, boot_database: BootDatabase, start_core: StartCore
) -> None:
    """The rehearsal crash's shape: a call in the lifespan's startup raises. Core's
    real `main()`, migration, `run()` and uvicorn all run; only that one call is
    replaced, so the module is imported rather than run with `-m`."""
    port = _free_port()
    forced = (
        "import switch_core.main as m\n"
        "def boom(*_args, **_kwargs):\n"
        "    raise RuntimeError('boot test: forced startup failure')\n"
        "m._runtime_state_sweep_loop = boom\n"
        "m.main()\n"
    )
    booted = start_core(["-c", forced], _boot_env(tmp_path, boot_database, port))
    code = _wait_exit(booted)
    log = booted.text()
    assert code == STARTUP_FAILURE, log[-4000:]
    assert "boot test: forced startup failure" in log
    assert "switch-core did not start" in log


def test_no_database_exits_non_zero(tmp_path: Path, start_core: StartCore) -> None:
    """A failure before the server, here the boot migration with nothing to
    connect to, also ends non-zero. Needs no database."""
    nothing = BootDatabase(
        host="127.0.0.1",
        port=str(_free_port()),
        name="none",
        owner="none",
        owner_password="none",
        runtime="none",
        runtime_password="none",
    )
    booted = start_core(
        ["-m", "switch_core.main"], _boot_env(tmp_path, nothing, _free_port())
    )
    code = _wait_exit(booted)
    log = booted.text()
    assert code != 0, log[-4000:]
    # It got as far as the database: the settings themselves were accepted.
    assert "ValidationError" not in log, log[-4000:]
