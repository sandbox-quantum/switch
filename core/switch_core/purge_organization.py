"""`switch-purge-organization`: delete an organization and everything Switch
holds for it, when its owner asks (`accounts/organization_purge.py`).

- `switch-purge-organization ORGANIZATION` shows what a purge would delete
  and keep, and why it can't go ahead if it can't. Nothing is changed.
- `switch-purge-organization ORGANIZATION --execute --request REFERENCE`
  purges it. `REFERENCE` says which request this answers (a ticket or
  similar reference) and is kept in the server's audit log.

`ORGANIZATION` is its id, slug or WorkOS organization id. A purge that has to
wait for something outside Switch (a cloud machine being torn down, a service
token its vendor has not yet revoked) says so and exits 3; run the same
command again later. It never touches WorkOS: it prints the WorkOS
organization and users to remove there instead.

Run it where switch-core runs, with the same configuration: it revokes
messaging apps and service sign-ins with the server's own credentials. It
refuses a database connection that row-level security does not bind (the
schema owner's, a superuser's), as the server does with
DB_REQUIRE_RESTRICTED_ROLE on.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import uuid

import telegram

from switch_core.accounts.organization_purge import (
    OrganizationPurge,
    PurgeOutcome,
    PurgePlan,
    PurgeRefused,
)
from switch_core.announcer import Announcer
from switch_core.bridges.collaboration.discord.install import DiscordAppInstaller
from switch_core.bridges.collaboration.install import (
    MessagingInstallerRegistry,
    events_path,
    public_url,
)
from switch_core.bridges.collaboration.slack.install import SlackAppInstaller
from switch_core.bridges.collaboration.teams.app_package import (
    build_distributed_app_package,
)
from switch_core.bridges.collaboration.teams.install import TeamsAppInstaller
from switch_core.bridges.collaboration.teams.shared_app import TeamsSharedApp
from switch_core.bridges.collaboration.telegram.app_client import (
    TelegramAppClient,
    initialize_bot,
)
from switch_core.bridges.collaboration.telegram.install import TelegramAppInstaller
from switch_core.config import SwitchConfig
from switch_core.connections.organization_apps import OrganizationApps
from switch_core.connections.registry import ClientRegistration
from switch_core.db.engine import (
    create_engine_from_config,
    create_session_factory,
    create_unpooled_engine,
)
from switch_core.db.runtime_role import RuntimeRoleError, verify_restricted_role
from switch_core.db.stores.organization_app_credential_store import (
    OrganizationAppCredentialStore,
)
from switch_core.main import (
    build_connector_apps,
    build_service_broker,
    controller_removal_publisher,
)
from switch_core.outbound import guarded_async_client
from switch_core.signals import SignalBus

logger = logging.getLogger(__name__)

EXIT_WAITING = 3


async def _installers(config: SwitchConfig) -> MessagingInstallerRegistry:
    """An installer for each platform this deployment has an app for, as the
    server registers them, able to revoke and release but serving nothing."""
    installers = MessagingInstallerRegistry()
    if config.slack_app_client_id:
        assert config.slack_app_client_secret is not None
        assert config.slack_app_signing_secret is not None
        installers.register(
            SlackAppInstaller(
                client_id=config.slack_app_client_id,
                client_secret=config.slack_app_client_secret,
                signing_secret=config.slack_app_signing_secret,
            )
        )
    if config.discord_app_client_id:
        assert config.discord_app_client_secret is not None
        assert config.discord_app_application_id is not None
        installers.register(
            DiscordAppInstaller(
                client_id=config.discord_app_client_id,
                client_secret=config.discord_app_client_secret,
                application_id=config.discord_app_application_id,
            )
        )
    if config.teams_app_client_id:
        assert config.messaging_public_url is not None
        assert config.teams_app_privacy_url is not None
        assert config.teams_app_terms_url is not None
        installers.register(
            TeamsAppInstaller(
                app=TeamsSharedApp.from_config(config),
                package=build_distributed_app_package(
                    app_id=config.teams_app_client_id,
                    app_name=config.teams_app_name,
                    messaging_public_url=config.messaging_public_url,
                    privacy_url=config.teams_app_privacy_url,
                    terms_url=config.teams_app_terms_url,
                ),
            )
        )
    if config.telegram_app_bot_token:
        assert config.telegram_app_webhook_secret is not None
        assert config.messaging_public_url is not None
        bot = telegram.Bot(config.telegram_app_bot_token)
        # Initialized, not started: starting would point the bot's webhook
        # here, away from the server.
        await initialize_bot(bot.initialize())
        installers.register(
            TelegramAppInstaller(
                client=TelegramAppClient(
                    bot=bot,
                    webhook_url=public_url(
                        config.messaging_public_url, events_path("telegram")
                    ),
                    webhook_secret=config.telegram_app_webhook_secret,
                    on_connected=_never_connected,
                ),
                webhook_secret=config.telegram_app_webhook_secret,
            )
        )
    return installers


async def _never_connected(_client: TelegramAppClient) -> None:
    raise AssertionError("the purge never starts the Telegram app")


def _print_plan(plan: PurgePlan) -> None:
    print(f"Organization {plan.slug} ({plan.organization_id}): {plan.name}")
    print(f"  WorkOS organization: {plan.workos_organization_id or '-'}")
    print(f"  Customer id: {plan.customer_id or '-'}")
    print(f"\nWorkspaces to delete ({len(plan.workspaces)}):")
    for workspace in plan.workspaces:
        print(f"  {workspace.slug} ({workspace.id}): {workspace.name}")
        for table, count in sorted(workspace.rows.items()):
            print(f"      {table}: {count}")
    print(f"\nAccounts to delete ({len(plan.deleted_accounts)}):")
    for account in plan.deleted_accounts:
        print(f"  {account.email} ({account.id})")
    kept = [account for account in plan.accounts if account.kept_because]
    print(f"\nAccounts kept, losing only their place here ({len(kept)}):")
    for account in kept:
        print(f"  {account.email} ({account.id}): {account.kept_because}")
    if plan.machines:
        print(f"\nCloud machines to tear down ({len(plan.machines)}):")
        for machine_id in plan.machines:
            print(f"  {machine_id}")
    if plan.detached_machines:
        print(
            "\nCloud machines of kept accounts, taken off the organization's "
            f"workspaces and left running ({len(plan.detached_machines)}):"
        )
        for machine_id in plan.detached_machines:
            print(f"  {machine_id}")
    if plan.resuming:
        print(
            "\nAn earlier run already deleted the organization; this one "
            "finishes its accounts."
        )
    if plan.refusals:
        print("\nThe purge can't go ahead:")
        for refusal in plan.refusals:
            print(f"  - {refusal}")


def _print_outcome(plan: PurgePlan, outcome: PurgeOutcome) -> None:
    for warning in outcome.warnings:
        print(f"WARNING: {warning}")
    if not outcome.finished:
        print("\nWaiting on what lives outside Switch; nothing has been deleted yet:")
        for waiting in outcome.waiting:
            print(f"  - {waiting}")
        print("Run the same command again later.")
        return
    print(f"\nPurged organization {plan.slug} and {len(plan.workspaces)} workspace(s).")
    print(f"Deleted {len(outcome.deleted_accounts)} account(s).")
    for account, error in outcome.failed_accounts:
        print(f"ERROR: account {account.email} ({account.id}) not deleted: {error}")
    if outcome.failed_accounts:
        print("Run the same command again to retry them.")
    print("\nStill to do at WorkOS, by whoever owns the environment:")
    if plan.workos_organization_id:
        print(f"  - the organization {plan.workos_organization_id}")
    for account in outcome.deleted_accounts:
        for issuer, subject in account.identities:
            print(f"  - user {subject} ({account.email}, signed in via {issuer})")
    for account in plan.accounts:
        if account.kept_because:
            for issuer, subject in account.identities:
                print(
                    f"  - membership of user {subject} ({account.email}, via "
                    f"{issuer}) in the organization, not the user: "
                    f"{account.kept_because}"
                )


async def _run(config: SwitchConfig, arguments: argparse.Namespace) -> int:
    if arguments.execute and not arguments.request:
        print("--execute needs --request REFERENCE", file=sys.stderr)
        return 2
    engine = create_engine_from_config(config)
    try:
        # The service broker finds a workspace's sign-ins through the
        # tenant-isolation policies alone, so on a connection they don't
        # bind it would revoke every workspace's.
        await verify_restricted_role(engine)
    except RuntimeRoleError as error:
        await engine.dispose()
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    session_factory = create_session_factory(engine)
    announcer = Announcer(session_factory)
    signals = SignalBus(
        session_factory,
        lambda: create_unpooled_engine(config),
        process_id=f"organization-purge-{uuid.uuid4().hex[:8]}",
        announcer=announcer,
    )
    await announcer.start()
    try:
        async with guarded_async_client(config.outbound_policy, timeout=20) as http:
            registration = ClientRegistration(
                session_factory=session_factory,
                keyring=config.keyring,
                public_url=config.gateway_public_url,
                server_name=config.id_server_name,
            )
            connector_apps = build_connector_apps(
                config,
                session_factory=session_factory,
                http=http,
                registration=registration,
            )
            await connector_apps.load()
            organization_apps = (
                OrganizationApps(
                    apps=connector_apps,
                    store=OrganizationAppCredentialStore(config.keyring),
                )
                if config.organization_connector_apps_enabled
                else None
            )
            purge = OrganizationPurge(
                session_factory=session_factory,
                broker=build_service_broker(
                    config,
                    connector_apps,
                    organization_apps,
                    session_factory=session_factory,
                    http=http,
                    registration=registration,
                    telemetry=None,
                ),
                installers=await _installers(config),
                keyring=config.keyring,
                signals=signals,
                controller_removed=controller_removal_publisher(signals),
                admin_email=config.gateway_admin_email,
            )
            try:
                plan = await purge.plan(await purge.find(arguments.organization))
                _print_plan(plan)
                if not arguments.execute:
                    print(
                        "\nNothing changed. Add --execute --request REFERENCE to purge."
                    )
                    return 1 if plan.refusals else 0
                outcome = await purge.run(plan, arguments.request)
            except PurgeRefused as refused:
                print(f"\nRefused: {refused}", file=sys.stderr)
                return 1
            _print_outcome(plan, outcome)
            if not outcome.finished:
                return EXIT_WAITING
            return 1 if outcome.failed_accounts else 0
    finally:
        # Sends the signals that tell the running servers what went.
        await announcer.stop()
        await engine.dispose()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        prog="switch-purge-organization",
        description="Delete an organization and everything Switch holds for it.",
    )
    parser.add_argument(
        "organization", help="The organization's id, slug or WorkOS organization id."
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Purge it. Without this, only show what would go.",
    )
    parser.add_argument(
        "--request",
        help="Which request this answers (a ticket or similar reference), "
        "kept in the server's audit log.",
    )
    arguments = parser.parse_args()
    sys.exit(asyncio.run(_run(SwitchConfig(), arguments)))
