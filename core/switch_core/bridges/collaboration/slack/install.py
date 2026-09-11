"""Installing the distributed Slack app into a customer's workspace.

The counterpart to `SLACK_SETUP.md`'s self-registered app, and a different
Slack app from it. See `docs/old/bridges/SLACK_DISTRIBUTED_APP.md` for the
registration walkthrough and the manifest; `BOT_SCOPES` below is the same list
as that manifest's, and a test compares them so the two cannot drift.

The one structural difference from the self-registered app runs through
everything here: it has no app-level token, because Slack does not permit
Socket Mode for a distributed app and a single socket could not be shared by
replicas anyway. Events arrive over HTTPS and are proved genuine by the
signing secret instead — which is why `verify_webhook` exists on this side of
the boundary and has no equivalent on the adapter.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import ClassVar
from urllib.parse import urlencode

from slack_sdk.errors import SlackApiError
from slack_sdk.signature import SignatureVerifier
from slack_sdk.web.async_client import AsyncWebClient

from switch_core.bridges.collaboration.install import (
    InstallGrant,
    MessagingAppInstaller,
    MessagingInstallError,
    WebhookAuthenticityError,
)

logger = logging.getLogger(__name__)

AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize"

#: The bot scopes the distributed app requests, in the manifest's order.
#:
#: Identical to the self-registered app's: the two apps differ in how they are
#: installed and how events reach them, never in what the bot may do once it is
#: in a channel.
BOT_SCOPES: tuple[str, ...] = (
    "files:read",
    "files:write",
    "assistant:write",
    "channels:history",
    "channels:manage",
    "channels:read",
    "chat:write",
    "chat:write.customize",
    "commands",
    "groups:history",
    "groups:read",
    "groups:write",
    "im:history",
    "im:read",
    "im:write",
    "mpim:history",
    "reactions:read",
    "reactions:write",
    "users:read",
    "usergroups:read",
    "usergroups:write",
)


class SlackAppInstaller(MessagingAppInstaller):
    platform: ClassVar[str] = "slack"

    def __init__(
        self, *, client_id: str, client_secret: str, signing_secret: str
    ) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self._verifier = SignatureVerifier(signing_secret)

    def authorize_url(self, *, state: str, redirect_uri: str) -> str:
        return f"{AUTHORIZE_URL}?" + urlencode(
            {
                "client_id": self._client_id,
                "scope": ",".join(BOT_SCOPES),
                "redirect_uri": redirect_uri,
                "state": state,
            }
        )

    async def redeem(self, *, code: str, redirect_uri: str) -> InstallGrant:
        try:
            response = await AsyncWebClient().oauth_v2_access(
                client_id=self._client_id,
                client_secret=self._client_secret,
                code=code,
                redirect_uri=redirect_uri,
            )
        except SlackApiError as error:
            raise MessagingInstallError(
                f"Slack refused the install: {error.response.get('error', error)}"
            ) from error

        # Slack answers 200 with `ok: false` for most refusals, so the absence
        # of an exception above proves nothing on its own.
        if not response.get("ok"):
            raise MessagingInstallError(
                f"Slack refused the install: {response.get('error', 'unknown error')}"
            )

        if response.get("is_enterprise_install"):
            raise MessagingInstallError(
                "this app was installed org-wide on Slack Enterprise Grid, which "
                "Switch cannot yet record: an org-wide install is identified by "
                "an enterprise rather than by a single workspace, and an "
                "installation is stored against one workspace. Install it into "
                "a single workspace instead."
            )

        team = response.get("team") or {}
        workspace_id = team.get("id")
        access_token = response.get("access_token")
        if not workspace_id or not access_token:
            raise MessagingInstallError(
                "Slack accepted the install but returned no workspace id or no "
                "bot token, so there is nothing to record. Nothing was saved."
            )

        return InstallGrant(
            external_workspace_id=workspace_id,
            workspace_name=team.get("name") or workspace_id,
            bot_token=access_token,
            scopes=response.get("scope") or "",
        )

    def verify_webhook(self, *, headers: Mapping[str, str], body: bytes) -> None:
        try:
            valid = self._verifier.is_valid_request(body, dict(headers))
        except ValueError as error:
            # A non-numeric timestamp header reaches int() inside the verifier.
            # It is unauthenticated input, so it must answer like any other bad
            # signature rather than as a server fault.
            raise WebhookAuthenticityError("malformed Slack timestamp") from error
        if not valid:
            raise WebhookAuthenticityError("bad Slack signature")

    def workspace_of_event(self, payload: Mapping[str, object]) -> str:
        workspace_id = payload.get("team_id")
        if not isinstance(workspace_id, str) or not workspace_id:
            raise WebhookAuthenticityError("Slack event names no workspace")
        return workspace_id

    def connection_config(self, grant: InstallGrant) -> dict[str, object]:
        return {
            "bot_token": grant.bot_token,
            "workspace_id": grant.external_workspace_id,
            # Not a detail of this rendering: it is the difference between the
            # two apps. Left out, the config validates as a Socket Mode bridge
            # missing its app token, and the install fails at registration
            # rather than at anything a reader would look at.
            "event_delivery": "webhook",
        }
