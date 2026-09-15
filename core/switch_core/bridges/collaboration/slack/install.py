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

import json
import logging
from collections.abc import Mapping
from typing import Any, ClassVar
from urllib.parse import parse_qsl, urlencode

from slack_sdk.errors import SlackApiError
from slack_sdk.signature import SignatureVerifier
from slack_sdk.web.async_client import AsyncWebClient

from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    InstallGrant,
    MessagingAppInstaller,
    MessagingInstallError,
    WebhookAuthenticityError,
    WebhookEndpoint,
    WebhookPayloadError,
)

logger = logging.getLogger(__name__)

AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize"

#: Slack's ways of saying the token is finished already. Revoking one of these
#: is the outcome the caller wanted, so it is a success — and it is the usual
#: case, because the reason to be disconnecting is often that the customer
#: removed the app first.
_ALREADY_DEAD = frozenset({"invalid_auth", "token_revoked", "account_inactive"})

#: The two events by which Slack says an install is over, and what each means
#: in words an operator can read. `app_uninstalled` is the customer removing
#: the app; `tokens_revoked` is the narrower case of the tokens being killed
#: while the app stays. Both leave us unable to act in the workspace.
_REVOCATION_EVENTS: dict[str, str] = {
    "app_uninstalled": "the app was removed from the Slack workspace",
    "tokens_revoked": "Slack revoked this workspace's tokens",
}


def _json_object(raw: bytes) -> dict[str, Any]:
    try:
        parsed = json.loads(raw)
    except ValueError as error:
        raise WebhookPayloadError("Slack posted a body that is not JSON") from error
    if not isinstance(parsed, dict):
        raise WebhookPayloadError("Slack posted JSON that is not an object")
    return parsed


#: Slack's count of how many times it has re-sent a delivery, absent on the
#: first. Header names arrive from Starlette lower-cased and are compared that
#: way; Slack's own spelling is `X-Slack-Retry-Num`.
_RETRY_NUM_HEADER = "x-slack-retry-num"


def _retry_number(headers: Mapping[str, str]) -> int:
    """How many times Slack has sent this already, defaulting to none.

    Unauthenticated in the sense that it is not covered by the signature — the
    signature is over the body and the timestamp — so it is read as a hint and
    never as a decision. A forged value cannot make an event be handled twice
    or dropped, because the receipt decides that; the worst it can do is put a
    wrong number in a log line.
    """
    raw = headers.get(_RETRY_NUM_HEADER)
    if raw is None:
        return 0
    try:
        return int(raw)
    except ValueError:
        return 0


def _form_fields(raw: bytes) -> dict[str, Any]:
    """Slack's form encoding as a flat dict, matching Socket Mode's payload.

    `parse_qsl` and not `parse_qs`: the latter makes every value a list, and
    the adapter reads these fields as the strings Socket Mode hands it. A
    repeated field would be a Slack change worth noticing rather than a list to
    accommodate, and the last value wins the way a form is usually read.
    """
    try:
        return dict(
            parse_qsl(raw.decode(), keep_blank_values=True, strict_parsing=True)
        )
    except (UnicodeDecodeError, ValueError) as error:
        raise WebhookPayloadError(
            "Slack posted a body that is not form data"
        ) from error


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

    async def revoke(self, *, bot_token: str) -> None:
        try:
            response = await AsyncWebClient(token=bot_token).auth_revoke()
        except SlackApiError as error:
            reason = error.response.get("error", "")
            if reason in _ALREADY_DEAD:
                logger.info(
                    "Slack reports the bot token was already invalid (%s); "
                    "treating the revocation as done",
                    reason,
                )
                return
            raise MessagingInstallError(
                f"Slack refused to revoke the bot token: {reason or error}"
            ) from error

        # `revoked: false` with `ok: true` is Slack accepting the call and
        # telling you it did nothing — which for a disconnect is the whole of
        # what was asked for, so it cannot be read off `ok` alone.
        if not response.get("revoked"):
            raise MessagingInstallError(
                "Slack accepted the revocation request and reported the token "
                "was not revoked, so it is still valid."
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

    def parse_webhook(
        self, *, endpoint: WebhookEndpoint, headers: Mapping[str, str], body: bytes
    ) -> InboundWebhook:
        attempt = _retry_number(headers)

        if endpoint == "commands":
            # A slash command posts its fields as a form, and Socket Mode
            # delivers that same flat dict — so the parsed form *is* the
            # payload, with no unwrapping.
            return InboundWebhook(
                envelope_type="slash_commands",
                payload=_form_fields(body),
                handshake=None,
                # Slack retries neither of the two form endpoints. A command
                # and an interaction are a person waiting on a dialog, and a
                # reply that arrives a minute late is worse than none — so
                # Slack sends each exactly once and there is no id on it to
                # deduplicate by.
                external_event_id=None,
                delivery_attempt=attempt,
            )

        if endpoint == "interactive":
            # Nested once: the form carries a single `payload` field whose
            # value is JSON.
            raw = _form_fields(body).get("payload")
            if not raw:
                raise WebhookPayloadError(
                    "Slack posted an interaction with no payload field"
                )
            return InboundWebhook(
                envelope_type="interactive",
                payload=_json_object(raw.encode()),
                handshake=None,
                external_event_id=None,
                delivery_attempt=attempt,
            )

        envelope = _json_object(body)
        if envelope.get("type") == "url_verification":
            # Slack proving the URL is ours, at the moment the Request URL is
            # saved. It is signed like any other post, so it reaches here
            # having been verified — and it names no workspace, because none
            # has installed anything yet.
            challenge = envelope.get("challenge")
            if not isinstance(challenge, str) or not challenge:
                raise WebhookPayloadError(
                    "Slack sent a URL verification with no challenge to echo"
                )
            return InboundWebhook(
                envelope_type="url_verification",
                payload=envelope,
                handshake=challenge,
                external_event_id=None,
                delivery_attempt=attempt,
            )

        event_id = envelope.get("event_id")
        return InboundWebhook(
            envelope_type="events_api",
            payload=envelope,
            handshake=None,
            # The one envelope Slack numbers, and the one it retries. A
            # retried delivery carries the same `event_id` as the original,
            # which is the whole basis of handling it once.
            external_event_id=event_id
            if isinstance(event_id, str) and event_id
            else None,
            delivery_attempt=attempt,
        )

    def workspace_of_event(self, payload: Mapping[str, object]) -> str:
        """Which workspace an event came from, over Slack's two spellings.

        An event callback and a slash command name it flat, as `team_id`; an
        interaction nests it under `team`. Both are read here rather than
        normalised at parse time, because the payload handed to the adapter has
        to stay byte-identical to the one Socket Mode delivers.
        """
        workspace_id = payload.get("team_id")
        if not isinstance(workspace_id, str) or not workspace_id:
            team = payload.get("team")
            workspace_id = team.get("id") if isinstance(team, dict) else None
        if not isinstance(workspace_id, str) or not workspace_id:
            raise WebhookPayloadError("Slack event names no workspace")
        return workspace_id

    def revocation_of_event(self, payload: Mapping[str, object]) -> str | None:
        """Read the two end-of-install events out of an Events API envelope.

        Only `event_callback` envelopes carry one. A slash command or an
        interaction cannot say the app was uninstalled — there would be nobody
        left to press the button — so the inner `event.type` is the only place
        worth looking, and reading a `type` from anywhere else would let an
        interaction payload with the right-looking field disconnect a
        customer's workspace.
        """
        event = payload.get("event")
        if not isinstance(event, dict):
            return None
        return _REVOCATION_EVENTS.get(event.get("type", ""))

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
