"""What the platform operator's server commands share: `switch-orgs`,
`switch-accounts`, `switch-connector-apps` and `switch-promote-org-admin`.

The operator has no pages in the dashboard. What they do across the whole
deployment they do with these commands, run where switch-core runs, with its
configuration. Each change is recorded in the audit log as the equivalent
dashboard action is, with no actor, since no account is behind it, and
`PLATFORM_OPERATOR_COMMAND` set. Each command that changes something takes
`--execute` where the change is hard to undo, and shows what it would do
without it.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import uuid
from collections.abc import AsyncIterator, Callable, Coroutine
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.announcer import Announcer
from switch_core.config import SwitchConfig
from switch_core.db.engine import (
    create_engine_from_config,
    create_session_factory,
    create_unpooled_engine,
)
from switch_core.db.models import User
from switch_core.db.runtime_role import verify_restricted_role
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.invite_mail import SmtpInviteMailer
from switch_core.organization_admin_notices import OrganizationAdminNotices
from switch_core.signals import SignalBus
from switch_core.tenant_context import no_tenant


class CommandRefused(Exception):
    """The command can't do what it was asked; the message says why, for the
    operator."""


@asynccontextmanager
async def database(
    config: SwitchConfig, *, restricted: bool
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """Sessions on the server's database. With `restricted`, refuses a
    connection the tenant policies don't bind (`RuntimeRoleError`), as a
    command must whose work relies on them to keep to one workspace."""
    engine = create_engine_from_config(config)
    try:
        if restricted:
            await verify_restricted_role(engine)
        yield create_session_factory(engine)
    finally:
        await engine.dispose()


@asynccontextmanager
async def signals(
    config: SwitchConfig,
    session_factory: async_sessionmaker[AsyncSession],
    command: str,
) -> AsyncIterator[SignalBus]:
    """A signal bus that only sends, to tell the running servers what the
    command changed. What was published is sent before this returns."""
    announcer = Announcer(session_factory)
    bus = SignalBus(
        session_factory,
        lambda: create_unpooled_engine(config),
        process_id=f"{command}-{uuid.uuid4().hex[:8]}",
        announcer=announcer,
    )
    await announcer.start()
    try:
        yield bus
    finally:
        await announcer.stop()


def admin_notices(
    config: SwitchConfig, session_factory: async_sessionmaker[AsyncSession]
) -> OrganizationAdminNotices:
    """E-mails to an organization's admins, through the relay invitations go
    through, as the server sends them."""
    return OrganizationAdminNotices(
        session_factory=session_factory,
        mailer=(
            SmtpInviteMailer.from_config(config)
            if config.invite_email_enabled
            else None
        ),
        dashboard_base_url=config.dashboard_base_url,
    )


def read_text_file(path: Path, what: str) -> str:
    """The text of the file at `path`, which `what` names in a refusal: one
    that is missing, can't be read or isn't text is refused in plain words
    rather than a traceback."""
    try:
        return path.read_text(encoding="utf-8")
    except OSError as error:
        raise CommandRefused(
            f"Can't read {what} {path}: {error.strerror or error}."
        ) from None
    except UnicodeDecodeError:
        raise CommandRefused(f"{what.capitalize()} {path} isn't UTF-8 text.") from None


async def account_by_email(
    session_factory: async_sessionmaker[AsyncSession], email: str
) -> User:
    """The account with `email`, matched without regard to case."""
    with no_tenant():
        async with session_factory() as session:
            user = await UserStore().get_by_email(session, email)
    if user is None:
        raise CommandRefused(f"No account has the email {email}.")
    return user


def run(
    parser: argparse.ArgumentParser,
    command: Callable[[SwitchConfig, argparse.Namespace], Coroutine[Any, Any, int]],
) -> None:
    """Parse the arguments, then run `command` with the server's
    configuration and exit with what it returns."""
    arguments = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    raise SystemExit(asyncio.run(command(SwitchConfig(), arguments)))
