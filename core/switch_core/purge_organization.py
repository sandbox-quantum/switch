"""`switch-purge-organization`: delete an organization and everything Switch
holds for it, when its owner asks (`accounts/organization_purge.py`).

- `switch-purge-organization ORGANIZATION` shows what a purge would delete
  and keep, and why it can't go ahead if it can't. Nothing is changed.
- `switch-purge-organization ORGANIZATION --execute --request REFERENCE`
  purges it. `REFERENCE` says which request this answers (a ticket or
  similar reference) and is kept in the server's audit log.

`ORGANIZATION` is its id, slug or WorkOS organization id. Once Switch's
side is done it takes the organization out of WorkOS and has Switch Trust
delete what it holds (`accounts/purge_elsewhere.py`).

Exit codes:

- `0`: done, in Switch and outside it.
- `1`: refused, or something failed (an account, a WorkOS or Switch Trust
  call). Run the same command again to retry.
- `3`: waiting for something outside Switch (a cloud machine being torn
  down, a service token its vendor has not yet revoked); nothing deleted
  yet. Run the same command again later.
- `4`: done in Switch, but the server has no `WORKOS_API_KEY`, so the WorkOS
  organization, users or memberships it prints are left for a person to
  remove.

Run it where switch-core runs, with the same configuration: it revokes
messaging apps and service sign-ins, and calls WorkOS and Switch Trust, with
the server's own credentials. It refuses a database connection that
row-level security does not bind (the schema owner's, a superuser's), as the
server does with DB_REQUIRE_RESTRICTED_ROLE on.
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
from switch_core.accounts.purge_elsewhere import ElsewhereOutcome, PurgeElsewhere
from switch_core.accounts.workos_offboarding import (
    WorkOSError,
    WorkOSOffboarding,
    WorkOSSteps,
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
from switch_core.trust.client import GuardrailsCheckError
from switch_core.trust.setup import build_trust_client

logger = logging.getLogger(__name__)

EXIT_WAITING = 3
EXIT_LEFT_BY_HAND = 4

BACKUPS_NOTE = (
    "Backups still hold the organization: the nightly database dumps and "
    "point-in-time restore keep it for up to 37 days, after which it is gone "
    "from them too. Restoring one within that time brings it back; purge it "
    "again after a restore."
)


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
        print(
            "\nCloud machines to delete, instance and disk, without waiting out "
            f"the disk's retention ({len(plan.machines)}):"
        )
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


def _print_workos_steps(steps: WorkOSSteps, plan: PurgePlan, done: bool) -> None:
    removed, deleted = ("Removed", "Deleted") if done else ("Remove", "Delete")
    organization = plan.workos_organization_id
    for membership in steps.memberships:
        print(
            f"  - {removed} membership {membership.id} of user "
            f"{membership.user_id} in {organization}"
        )
    for user_id in steps.users_deleted:
        print(f"  - {deleted} user {user_id}{_account_of(plan, user_id)}")
    for user_id, why in sorted(steps.users_kept.items()):
        print(f"  - Keep user {user_id}{_account_of(plan, user_id)}: {why}")
    if organization is None:
        print("  - No WorkOS organization: the organization was never linked.")
    elif steps.organization_deleted:
        print(f"  - {deleted} organization {organization}")
    elif steps.organization_kept:
        print(f"  - Keep organization {organization}: {steps.organization_kept}")
    for failure in steps.failures:
        print(f"  ERROR: {failure}")


def _account_of(plan: PurgePlan, user_id: str) -> str:
    account_id = plan.workos_users[user_id]
    for account in plan.accounts:
        if account.id == account_id:
            return f" ({account.email})"
    return f" (account {account_id})"


def _print_outcome(
    plan: PurgePlan, outcome: PurgeOutcome, elsewhere: ElsewhereOutcome | None
) -> None:
    for warning in outcome.warnings:
        print(f"WARNING: {warning}")
    if not outcome.finished:
        print("\nWaiting on what lives outside Switch; nothing has been deleted yet:")
        for waiting in outcome.waiting:
            print(f"  - {waiting}")
        print("Run the same command again later.")
        return
    assert elsewhere is not None
    print(f"\nPurged organization {plan.slug} and {len(plan.workspaces)} workspace(s).")
    print(f"Deleted {len(outcome.deleted_accounts)} account(s).")
    for account, error in outcome.failed_accounts:
        print(f"ERROR: account {account.email} ({account.id}) not deleted: {error}")

    print("\nOutside Switch:")
    print(
        f"  Service sign-ins removed and revoked at their vendors by this run: "
        f"{outcome.revoked_sign_ins}"
    )
    print(
        "  Messaging installs ended at their platforms: "
        f"{', '.join(outcome.ended_installs) or 'none'}"
    )
    print(
        "  Cloud machines deleted by the hosted controller, instance and disk: "
        f"{', '.join(plan.removed_machines) or 'none'}"
    )
    if plan.detached_machines:
        print(
            "  Cloud machines of kept accounts, taken off the organization's "
            f"workspaces: {', '.join(plan.detached_machines)}"
        )
    if elsewhere.workos is not None:
        print("  WorkOS:")
        _print_workos_steps(elsewhere.workos, plan, done=True)
    else:
        leftover = elsewhere.workos_leftover
        assert leftover is not None
        if leftover.empty:
            print("  WorkOS: nothing there for this organization.")
        else:
            print(
                "  WorkOS: NOT CLEANED. This server has no WORKOS_API_KEY. Remove "
                "these there by hand, if its sign-in is WorkOS:"
            )
            if leftover.organization:
                print(
                    f"    - the organization {leftover.organization}, unless "
                    "another product still uses it"
                )
            for user_id in leftover.users:
                print(
                    f"    - user {user_id}{_account_of(plan, user_id)}, unless "
                    "another product's organization still has them"
                )
            for user_id in leftover.memberships_only:
                print(
                    f"    - only the membership of user {user_id}"
                    f"{_account_of(plan, user_id)} in the organization: Switch "
                    "still uses the user"
                )
    if not elsewhere.trust_configured:
        print(
            "  Switch Trust: not configured on this server, so no message was "
            "sent to it for deletion. If it was configured while the "
            f"organization used Switch, its {len(plan.trust_sessions)} room "
            "id(s), recorded in organization.purge_started, are the sessions "
            "to delete there."
        )
    else:
        print(
            f"  Switch Trust: {elsewhere.trust_deleted} of "
            f"{len(plan.trust_sessions)} room session(s) deleted."
        )
        for session_id, error in elsewhere.trust_failed:
            print(f"  ERROR: Switch Trust session {session_id}: {error}")
    print(f"\n{BACKUPS_NOTE}")
    if outcome.failed_accounts or elsewhere.failed:
        print("\nRun the same command again to retry what failed.")


async def _print_dry_run_elsewhere(
    plan: PurgePlan, elsewhere: PurgeElsewhere, trust_configured: bool
) -> None:
    """What `--execute` would do outside Switch. Raises `WorkOSError` when
    WorkOS can't be read."""
    steps = await elsewhere.plan_workos(plan)
    if steps is not None:
        print("\nAt WorkOS, once Switch's side is done:")
        _print_workos_steps(steps, plan, done=False)
    elif plan.workos_organization_id is None and not plan.workos_users:
        print("\nWorkOS: nothing there for this organization.")
    else:
        print(
            "\nWorkOS: this server has no WORKOS_API_KEY, so nothing there will "
            "change; the purge will list these to remove by hand and exit 4:"
        )
        if plan.workos_organization_id:
            print(f"  - the organization {plan.workos_organization_id}")
        for user_id in sorted(plan.workos_users):
            print(f"  - user {user_id}{_account_of(plan, user_id)}")
    if trust_configured:
        print(
            f"\nSwitch Trust: delete what it holds for {len(plan.trust_sessions)} "
            "room session(s)."
        )
    else:
        print("\nSwitch Trust: not configured on this server; nothing to delete.")
    print(f"\n{BACKUPS_NOTE}")


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
    trust_client, trust_http = build_trust_client(session_factory, config)
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
                ),
                installers=await _installers(config),
                keyring=config.keyring,
                signals=signals,
                controller_removed=controller_removal_publisher(signals),
                admin_email=config.gateway_admin_email,
                sign_in_issuer=config.gateway_oidc_issuer_url,
            )
            elsewhere = PurgeElsewhere(
                session_factory=session_factory,
                workos=WorkOSOffboarding(
                    http, config.workos_api_key, config.workos_api_url
                )
                if config.workos_api_key
                else None,
                trust=trust_client.session_eraser,
                sign_in_issuer=config.gateway_oidc_issuer_url,
            )
            try:
                plan = await purge.plan(await purge.find(arguments.organization))
                _print_plan(plan)
                if not arguments.execute:
                    await _print_dry_run_elsewhere(
                        plan,
                        elsewhere,
                        await trust_client.session_eraser() is not None,
                    )
                    print(
                        "\nNothing changed. Add --execute --request REFERENCE to purge."
                    )
                    return 1 if plan.refusals else 0
                outcome = await purge.run(plan, arguments.request)
            except PurgeRefused as refused:
                print(f"\nRefused: {refused}", file=sys.stderr)
                return 1
            except (WorkOSError, GuardrailsCheckError) as error:
                print(
                    f"\nCould not read what to do outside Switch: {error}",
                    file=sys.stderr,
                )
                return 1
            if not outcome.finished:
                _print_outcome(plan, outcome, None)
                return EXIT_WAITING
            elsewhere_outcome = await elsewhere.run(plan, arguments.request)
            _print_outcome(plan, outcome, elsewhere_outcome)
            if outcome.failed_accounts or elsewhere_outcome.failed:
                return 1
            return EXIT_LEFT_BY_HAND if elsewhere_outcome.left_by_hand else 0
    finally:
        # Sends the signals that tell the running servers what went.
        await announcer.stop()
        await trust_http.aclose()
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
