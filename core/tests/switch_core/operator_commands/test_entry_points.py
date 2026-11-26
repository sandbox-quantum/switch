"""Each operator command run as an operator runs it: from its argument
parser through `_run`, with the configuration it reads where switch-core
runs and the services it wires up itself, against this test's database as
the restricted role a deployment connects as. For `switch-accounts delete`
that is the server's own broker and the stand-ins for what only a running
server has (`deletion_services`). What each prints and the status it exits
with are checked here; the other tests in this directory cover what the
commands do."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest
from sqlalchemy import select

from switch_core import (
    accounts_admin,
    connector_apps_admin,
    organizations_admin,
    promote_org_admin,
)
from switch_core.config import SwitchConfig
from switch_core.db.models import TENANT_ZERO_ID, ServerAuditEvent, TenantMember, User
from switch_core.tenant_context import tenant_scope
from tests.conftest import RLSHarness
from tests.switch_core.accounts.test_account_deletion import _agent
from tests.switch_core.operator_commands.helpers import (
    command_config,
    email_of,
    make_organization,
)

pytestmark = pytest.mark.no_ambient_tenant


async def _accounts(config: SwitchConfig, *argv: str) -> int:
    return await accounts_admin._run(config, accounts_admin._parser().parse_args(argv))


async def _member_of_tenant_zero(
    rls_harness: RLSHarness, name: str, role: str, *, owns_an_agent: bool = False
) -> User:
    with tenant_scope(TENANT_ZERO_ID):
        async with rls_harness.owner() as session:
            user = User(name=name, email=email_of(name), role="user")
            session.add(user)
            await session.flush()
            session.add(
                TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role=role)
            )
            await session.flush()
            if owns_an_agent:
                await _agent(session, TENANT_ZERO_ID, user, "helper")
            await session.commit()
            return user


async def _exists(rls_harness: RLSHarness, user_id: str) -> bool:
    async with rls_harness.owner() as session:
        return await session.get(User, user_id) is not None


async def _server_actions(rls_harness: RLSHarness) -> list[str]:
    async with rls_harness.owner() as session:
        return list(
            await session.scalars(
                select(ServerAuditEvent.action).order_by(ServerAuditEvent.occurred_at)
            )
        )


class TestAccountsCreate:
    async def test_is_refused_where_accounts_are_workos_users(
        self, rls_harness: RLSHarness, capsys: pytest.CaptureFixture[str]
    ) -> None:
        config = command_config(rls_harness).model_copy(
            update={"organization_directory": "workos"}
        )

        status = await _accounts(
            config, "create", "new@example.invalid", "--name", "New"
        )

        assert status == 1
        assert "invite this person through the organization" in capsys.readouterr().err
        async with rls_harness.owner() as session:
            assert (
                await session.scalar(
                    select(User.id).where(User.email == "new@example.invalid")
                )
                is None
            )


class TestAccountsDelete:
    async def test_a_dry_run_shows_it_and_changes_nothing(
        self, rls_harness: RLSHarness, capsys: pytest.CaptureFixture[str]
    ) -> None:
        await _member_of_tenant_zero(rls_harness, "keeper", "admin")
        leaving = await _member_of_tenant_zero(rls_harness, "leaving", "member")

        status = await _accounts(command_config(rls_harness), "delete", leaving.email)

        assert status == 0
        out = capsys.readouterr().out
        assert f"Account {leaving.email} ({leaving.id}): leaving" in out
        assert "Nothing changed. Add --execute to delete it." in out
        assert await _exists(rls_harness, leaving.id)
        assert await _server_actions(rls_harness) == []

    async def test_an_account_owning_an_agent_is_refused(
        self, rls_harness: RLSHarness, capsys: pytest.CaptureFixture[str]
    ) -> None:
        await _member_of_tenant_zero(rls_harness, "keeper", "admin")
        owner = await _member_of_tenant_zero(
            rls_harness, "owner", "member", owns_an_agent=True
        )

        status = await _accounts(
            command_config(rls_harness), "delete", owner.email, "--execute", "--yes"
        )

        assert status == 1
        captured = capsys.readouterr()
        assert "  Agents it owns (1): helper" in captured.out
        assert captured.err == (
            "Refused: Nothing was deleted. What has to happen first is listed above.\n"
        )
        assert await _exists(rls_harness, owner.id)
        assert await _server_actions(rls_harness) == ["user.deletion_refused"]

    async def test_yes_deletes_it_through_the_server_services(
        self, rls_harness: RLSHarness, capsys: pytest.CaptureFixture[str]
    ) -> None:
        made = await make_organization(
            rls_harness,
            people={
                "keeper": ("admin", "org_admin"),
                "leaving": ("member", "org_admin"),
            },
        )
        leaving = made.ids["leaving"]

        status = await _accounts(
            command_config(rls_harness),
            "delete",
            email_of(leaving),
            "--execute",
            "--yes",
        )

        assert status == 0
        assert f"Deleted the account {email_of(leaving)}." in capsys.readouterr().out
        assert not await _exists(rls_harness, leaving)
        assert await _server_actions(rls_harness) == ["user.deleted"]


async def test_accounts_create_refuses_a_missing_password_file(
    rls_harness: RLSHarness, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    missing = tmp_path / "password"

    status = await _accounts(
        command_config(rls_harness),
        "create",
        "new@example.invalid",
        "--name",
        "New",
        "--password-file",
        str(missing),
    )

    assert status == 1
    err = capsys.readouterr().err
    assert err.startswith(f"Refused: Can't read the password file {missing}: ")
    async with rls_harness.owner() as session:
        assert list(await session.scalars(select(User.id))) == []


async def test_connector_apps_list(
    rls_harness: RLSHarness, capsys: pytest.CaptureFixture[str]
) -> None:
    status = await connector_apps_admin._run(
        command_config(rls_harness),
        connector_apps_admin._parser().parse_args(["list"]),
    )

    assert status == 0
    out = capsys.readouterr().out.splitlines()
    assert "github (GitHub): none" in out
    assert "  client id: -" in out


async def test_orgs_list(
    rls_harness: RLSHarness, capsys: pytest.CaptureFixture[str]
) -> None:
    made = await make_organization(rls_harness, people={"ada": ("admin", "org_admin")})

    status = await organizations_admin._run(
        command_config(rls_harness),
        organizations_admin._parser().parse_args(["list"]),
    )

    assert status == 0
    out = capsys.readouterr().out
    assert made.organization_id in out and email_of(made.ids["ada"]) in out


async def test_promote_org_admin_refuses_someone_in_none_of_its_workspaces(
    rls_harness: RLSHarness, capsys: pytest.CaptureFixture[str]
) -> None:
    made = await make_organization(
        rls_harness,
        people={"ada": ("admin", "org_admin"), "outsider": (None, None)},
    )

    status = await promote_org_admin._run(
        command_config(rls_harness),
        promote_org_admin._parser().parse_args(
            [made.slug, email_of(made.ids["outsider"]), "--reason", "locked out"]
        ),
    )

    assert status == 1
    err = capsys.readouterr().err
    assert err == (
        f"Refused: {email_of(made.ids['outsider'])} is in none of Acme's "
        "workspaces. Invite them to one of its workspaces first, then run this "
        "again.\n"
    )
    async with rls_harness.owner() as session:
        assert list(await session.scalars(select(ServerAuditEvent.id))) == []


def _environment(config: SwitchConfig) -> dict[str, str]:
    """`config`, as the environment switch-core reads it from."""
    assert config.gateway_admin_password is not None
    return {
        **os.environ,
        "DB_HOST": config.db_host,
        "DB_PORT": config.db_port,
        "DB_USER": config.db_user,
        "DB_PASSWORD": config.db_password,
        "DB_NAME": config.db_name,
        "ID_SERVER_NAME": config.id_server_name,
        "AGENT_REGISTRATION_TOKEN": config.agent_registration_token,
        "SECRET_KEYS": config.secret_keys,
        "GATEWAY_ADMIN_EMAIL": config.gateway_admin_email,
        "GATEWAY_ADMIN_PASSWORD": config.gateway_admin_password,
    }


@pytest.mark.parametrize(("owns_an_agent", "exit_status"), [(False, 0), (True, 1)])
async def test_main_exits_with_the_status_the_command_returns(
    rls_harness: RLSHarness, owns_an_agent: bool, exit_status: int
) -> None:
    """`switch-accounts` itself, in a process of its own: the configuration
    read from the environment, and the exit status."""
    await _member_of_tenant_zero(rls_harness, "keeper", "admin")
    person = await _member_of_tenant_zero(
        rls_harness, "person", "member", owns_an_agent=owns_an_agent
    )

    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        "from switch_core.accounts_admin import main; main()",
        "delete",
        person.email,
        env=_environment(command_config(rls_harness)),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await process.communicate()

    assert process.returncode == exit_status, err.decode()
    assert f"Account {person.email}" in out.decode()
    assert "Traceback" not in err.decode()
    assert await _exists(rls_harness, person.id)
