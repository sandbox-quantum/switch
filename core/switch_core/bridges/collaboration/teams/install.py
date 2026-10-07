"""Approving the distributed Teams app for a customer's Microsoft organisation.

The counterpart to `TEAMS_SETUP.md`'s bring-your-own app (see
`TEAMS_DISTRIBUTED_APP.md`). An install here is a Microsoft admin signing in
from Switch and approving the app for their whole organisation; Switch then
puts the app into the organisation's Teams app catalogue itself.

Three things differ from Slack's installer, and all three are Microsoft's:

- **No token per install.** Approval grants the deployment's one app access
  to the organisation; Switch mints that organisation's tokens with its own
  credential when it needs them. The grant is tokenless, as Discord's is.
- **The redirect proves nothing by itself.** Microsoft's own docs warn that
  the organisation named on the redirect can be forged, and that `admin_consent`
  appears on error replies too. So nothing is recorded until three things are
  proved: the id token (from the code exchange, signed by Microsoft) names
  the organisation; the person who signed in holds an admin role there; and a
  token issued in that organisation carries every permission the app needs.
  Without the second, any employee of an organisation that had approved the
  app before — after a disconnect, say, since Switch cannot remove the
  approval on their side — could connect it to a workspace of their own.
- **Approval does not put the app anywhere.** Microsoft keeps consent, the
  Teams catalogue and each team's installed apps apart, so after approval
  Switch publishes the app to the organisation's catalogue with the admin's
  delegated token, which is then thrown away. If the admin may approve but
  not publish, the install still succeeds and says so (`platform_data`); the
  connection's Teams panel offers the package to upload instead.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections import OrderedDict
from collections.abc import Mapping
from typing import Any, ClassVar
from urllib.parse import urlencode

import httpx

from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    InstallGrant,
    MessagingAppInstaller,
    MessagingInstallError,
    WebhookAuthenticityError,
    WebhookEndpoint,
    WebhookPayloadError,
)
from switch_core.bridges.collaboration.teams.adapter import activity_tenant
from switch_core.bridges.collaboration.teams.app_package import DistributedAppPackage
from switch_core.bridges.collaboration.teams.auth import (
    GRAPH_SCOPE,
    TokenRequestRefused,
    token_endpoint,
)
from switch_core.bridges.collaboration.teams.identity import REQUIRED_GRAPH_ROLES
from switch_core.bridges.collaboration.teams.shared_app import PLATFORM, TeamsSharedApp

logger = logging.getLogger(__name__)

_AUTHORITY = "organizations"
_AUTHORIZE_URL = f"https://login.microsoftonline.com/{_AUTHORITY}/oauth2/v2.0/authorize"
#: Sign-in and every permission configured on the app registration, delegated
#: and application alike: `.default` is what lets one consent screen cover the
#: lot when the admin approves for the whole organisation.
_SCOPES = f"openid profile {GRAPH_SCOPE}"
_GRAPH = "https://graph.microsoft.com/v1.0"

#: Directory roles that may grant an app Microsoft Graph application
#: permissions: Global Administrator and Privileged Role Administrator. The
#: ids are Microsoft's role template ids, the same in every organisation.
_APPROVING_ROLES = frozenset(
    {
        "62e90394-69f5-4237-9190-012177145e10",
        "e8611ab8-c189-46e8-94e1-60213ab1f814",
    }
)

#: The directory personal Microsoft accounts sign in from. Not an organisation,
#: so nothing in it can approve an app for one.
_PERSONAL_ACCOUNTS_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad"

#: Government clouds, which the distributed app does not serve: their Teams
#: is reached at hosts of its own, which this deployment's token never goes to.
_GOVERNMENT_SUB_SCOPES = frozenset({"GCC", "DOD", "DODCON"})

#: A just-approved organisation can take a few seconds to issue the app its
#: first token. Long enough to ride that out, short enough that a person
#: watching a browser is not left wondering.
_APPROVAL_PROPAGATION_ATTEMPTS = 5
_APPROVAL_PROPAGATION_DELAY_SECONDS = 2.0

#: How many batches' vouched organisations are held between their check and
#: their parse. Both happen within one request, so this only bounds what a
#: request that failed between the two could leave behind.
_VOUCHED_KEPT = 256


class TeamsAppInstaller(MessagingAppInstaller):
    platform: ClassVar[str] = PLATFORM
    webhook_endpoints: ClassVar[frozenset[WebhookEndpoint]] = frozenset(
        {"events", "notifications"}
    )

    def __init__(self, *, app: TeamsSharedApp, package: DistributedAppPackage) -> None:
        self._app = app
        self._package = package
        self._vouched: OrderedDict[bytes, frozenset[str]] = OrderedDict()

    @property
    def package(self) -> DistributedAppPackage:
        """The app package, for an admin to upload by hand where Switch could
        not put it in the organisation's catalogue itself."""
        return self._package

    # ── Installing ───────────────────────────────────────────────────────────

    def authorize_url(self, *, state: str, redirect_uri: str) -> str:
        return f"{_AUTHORIZE_URL}?" + urlencode(
            {
                "client_id": self._app.app_id,
                "response_type": "code",
                "response_mode": "query",
                "redirect_uri": redirect_uri,
                "scope": _SCOPES,
                # Always ask, so the admin is shown the box that approves the
                # app for their whole organisation rather than for themselves.
                "prompt": "consent",
                "state": state,
            }
        )

    async def redeem(self, *, code: str, redirect_uri: str) -> InstallGrant:
        try:
            return await self._redeem(code=code, redirect_uri=redirect_uri)
        except (httpx.HTTPError, OSError) as error:
            # The install link is spent by now, so the person is told plainly
            # rather than shown a server error, and starts again.
            raise MessagingInstallError(
                f"Switch could not reach Microsoft to finish connecting ({error}). "
                "Nothing was saved; start again from Switch."
            ) from error

    async def _redeem(self, *, code: str, redirect_uri: str) -> InstallGrant:
        tokens = await self._exchange(code=code, redirect_uri=redirect_uri)
        claims = await self._verified_identity(tokens.get("id_token"))
        tenant_id = str(claims["tid"])
        if tenant_id == _PERSONAL_ACCOUNTS_TENANT:
            raise MessagingInstallError(
                "That is a personal Microsoft account. Sign in with a work account "
                "from the organisation whose Teams you are connecting."
            )
        sub_scope = str(claims.get("tenant_region_sub_scope") or "")
        if sub_scope.upper() in _GOVERNMENT_SUB_SCOPES:
            raise MessagingInstallError(
                f"This organisation is in a Microsoft government cloud ({sub_scope}), "
                "which the Switch Teams app does not serve."
            )
        self._require_approving_admin(claims)
        roles = await self._granted_roles(tenant_id)

        delegated = str(tokens.get("access_token") or "")
        name = await self._organisation_name(self._app.http, delegated, tenant_id)
        platform_data = await self._publish(self._app.http, delegated, tenant_id)
        return InstallGrant(
            external_workspace_id=tenant_id,
            workspace_name=name,
            bot_token=None,
            scopes=" ".join(sorted(roles)),
            platform_data=platform_data,
        )

    async def _exchange(self, *, code: str, redirect_uri: str) -> dict[str, Any]:
        token_url = token_endpoint(_AUTHORITY)
        form = {
            "grant_type": "authorization_code",
            "client_id": self._app.app_id,
            "code": code,
            "redirect_uri": redirect_uri,
            "scope": _SCOPES,
            **await self._app.credential.form(
                app_id=self._app.app_id, token_url=token_url
            ),
        }
        response = await self._app.http.post(token_url, data=form)
        try:
            payload: dict[str, Any] = response.json()
        except ValueError as error:
            raise MessagingInstallError(
                f"Microsoft answered the sign-in with something that is not JSON "
                f"({response.status_code}). Nothing was saved."
            ) from error
        if response.status_code != 200:
            raise MessagingInstallError(
                "Microsoft refused the sign-in: "
                f"{payload.get('error_description') or payload.get('error')}. "
                "Nothing was saved."
            )
        return payload

    async def _verified_identity(self, id_token: object) -> dict[str, Any]:
        """The signed-in person's claims, from an id token Microsoft signed.

        It came straight from Microsoft over TLS, but it is verified anyway:
        its `tid` is what decides which organisation is claimed, and a value
        that decides that is not one to take on trust.
        """
        if not isinstance(id_token, str) or not id_token:
            raise MessagingInstallError(
                "Microsoft returned no id token, so the organisation cannot be "
                "told. Nothing was saved."
            )
        try:
            return await self._app.verify_id_token(id_token)
        except PermissionError as error:
            raise MessagingInstallError(
                f"Microsoft's id token could not be verified ({error}). Nothing "
                "was saved."
            ) from error

    def _require_approving_admin(self, claims: Mapping[str, Any]) -> None:
        roles = claims.get("wids")
        if roles is None:
            raise MessagingInstallError(
                "Microsoft did not say which roles the person signing in holds, so "
                "Switch cannot check they may approve it. The Switch app "
                "registration must emit directory roles in its tokens (its "
                "groupMembershipClaims setting); this is for the deployment's "
                "operator to fix."
            )
        if not _APPROVING_ROLES & {str(role) for role in roles}:
            raise MessagingInstallError(
                "Approving Switch for an organisation needs a Microsoft Global "
                "Administrator or Privileged Role Administrator. Ask one of them "
                "to connect Teams from Switch."
            )

    async def _granted_roles(self, tenant_id: str) -> frozenset[str]:
        """Prove the organisation approved the app, by what its tokens carry.

        A token issued in the organisation lists the application permissions
        it was granted. Every one the app needs has to be there; a sign-in on
        which the admin did not approve for the organisation leaves them out.
        """
        tokens = self._app.org_tokens(tenant_id)
        for attempt in range(_APPROVAL_PROPAGATION_ATTEMPTS):
            try:
                granted = await tokens.graph_roles()
            except TokenRequestRefused as error:
                if not error.app_not_approved:
                    raise MessagingInstallError(
                        f"Microsoft would not issue Switch a token in this "
                        f"organisation ({error}). Nothing was saved."
                    ) from error
                granted = frozenset()
            missing = REQUIRED_GRAPH_ROLES - granted
            if not missing:
                return granted
            if attempt + 1 < _APPROVAL_PROPAGATION_ATTEMPTS:
                tokens.invalidate(GRAPH_SCOPE)
                await asyncio.sleep(_APPROVAL_PROPAGATION_DELAY_SECONDS)
        raise MessagingInstallError(
            "Switch was not approved for the whole organisation: "
            f"{', '.join(sorted(missing))} were not granted. Start again from "
            "Switch, and tick “Consent on behalf of your organization” on "
            "Microsoft's screen."
        )

    async def _organisation_name(
        self, http: httpx.AsyncClient, delegated: str, tenant_id: str
    ) -> str:
        try:
            response = await http.get(
                f"{_GRAPH}/organization",
                params={"$select": "displayName"},
                headers={"Authorization": f"Bearer {delegated}"},
            )
            response.raise_for_status()
            organisations = response.json().get("value") or []
            name = organisations[0].get("displayName") if organisations else None
        except (httpx.HTTPError, ValueError, AttributeError) as error:
            logger.warning(
                "Could not read the name of Microsoft organisation %s: %s",
                tenant_id,
                error,
            )
            return tenant_id
        return str(name) if name else tenant_id

    async def _publish(
        self, http: httpx.AsyncClient, delegated: str, tenant_id: str
    ) -> dict[str, object]:
        """Put the app into the organisation's catalogue, or say why not.

        Idempotent: an organisation that approved before, disconnected and is
        approving again already has the app, and is given the newer version if
        this one is. Publishing needs a Teams administrator as well as the
        approver's role, so a refusal does not fail the install — the approval
        is done — and is recorded for the connection to show.
        """
        headers = {"Authorization": f"Bearer {delegated}"}
        catalog_app_id: str | None = None
        try:
            existing = await http.get(
                f"{_GRAPH}/appCatalogs/teamsApps",
                params={
                    "$filter": f"externalId eq '{self._package.manifest_id}'",
                    "$expand": "appDefinitions($select=id,version,authorization)",
                },
                headers=headers,
            )
            existing.raise_for_status()
            found = existing.json().get("value") or []
            if found:
                definitions = found[0].get("appDefinitions") or []
                versions = [str(d.get("version")) for d in definitions]
                same_version = [
                    d
                    for d in definitions
                    if str(d.get("version")) == self._package.version
                ]
                if any(_asks_per_team(d) for d in same_version):
                    # Not Switch's package, which asks for nothing per team:
                    # most likely one uploaded by hand under the same id. It
                    # cannot be replaced at this version, and Switch cannot
                    # add an app that asks per team to a team itself.
                    return {
                        "publish_problem": (
                            "your organisation's Teams app list already has an "
                            "app under Switch's id that asks for per-team "
                            "permissions — probably a package uploaded by hand — "
                            "and Switch cannot add that one to teams. A Teams "
                            "admin should delete it (Teams admin center, Teams "
                            "apps, Manage apps), then approve Switch again so it "
                            "adds its own"
                        )
                    }
                catalog_app_id = str(found[0]["id"])
                if self._package.version not in versions:
                    updated = await http.post(
                        f"{_GRAPH}/appCatalogs/teamsApps/{catalog_app_id}/appDefinitions",
                        content=self._package.archive,
                        headers={**headers, "Content-Type": "application/zip"},
                    )
                    updated.raise_for_status()
            else:
                published = await http.post(
                    f"{_GRAPH}/appCatalogs/teamsApps",
                    content=self._package.archive,
                    headers={**headers, "Content-Type": "application/zip"},
                )
                published.raise_for_status()
                catalog_app_id = str(published.json()["id"])
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
            reason = _graph_refusal(error)
            logger.warning(
                "Could not publish the Teams app to organisation %s's catalogue: %s",
                tenant_id,
                reason,
            )
            # What was found is kept even when giving it the newer version
            # failed: the organisation still has the app, and an id that works
            # must not be lost to an update that did not.
            if catalog_app_id is not None:
                return {"catalog_app_id": catalog_app_id, "publish_problem": reason}
            return {"publish_problem": reason}
        return {
            "catalog_app_id": catalog_app_id,
            "manifest_version": self._package.version,
            "publish_problem": None,
        }

    def connection_config(self, grant: InstallGrant) -> dict[str, object]:
        return {"event_delivery": "shared", "tenant_id": grant.external_workspace_id}

    def workspace_of_bridge(
        self, connection_config: Mapping[str, object]
    ) -> str | None:
        if connection_config.get("event_delivery") != "shared":
            return None
        tenant_id = connection_config.get("tenant_id")
        return str(tenant_id) if tenant_id is not None else None

    async def release(self, *, external_workspace_id: str) -> None:
        """Leave an organisation whose bridge is not running to leave it itself.

        The same as the bridge's own `withdraw`, from outside it: delete the
        subscriptions this app holds there and take the app out of every team
        it is in.

        Best effort, and never a refusal, unlike what the base class allows:
        Graph refuses these calls exactly when the organisation has blocked
        the app or withdrawn its approval, and a customer who has done that
        must still be able to disconnect. What is left behind is logged as an
        error. A subscription left behind runs out within the hour, since
        nothing renews it.
        """
        await self._app.withdraw_from_org(external_workspace_id)

    async def revoke(self, *, bot_token: str) -> None:
        raise NotImplementedError(
            "a Teams install has no per-install token to revoke; the app's "
            "credential is deployment config shared by every install"
        )

    def describe_callback_error(self, *, error: str, description: str | None) -> str:
        text = description or ""
        if "AADSTS65004" in text or error == "access_denied":
            return "Switch was not approved on Microsoft's screen."
        if "AADSTS90094" in text or "AADSTS90008" in text:
            return (
                "Approving Switch needs a Microsoft Global Administrator or "
                "Privileged Role Administrator. Ask one of them to connect Teams "
                "from Switch."
            )
        return f"Microsoft reported: {description or error}."

    # ── Inbound ──────────────────────────────────────────────────────────────

    def unsigned_handshake(
        self, *, endpoint: WebhookEndpoint, query: Mapping[str, str]
    ) -> str | None:
        if endpoint == "notifications":
            return query.get("validationToken")
        return None

    async def verify_webhook(
        self,
        *,
        endpoint: WebhookEndpoint,
        headers: Mapping[str, str],
        query: Mapping[str, str],
        body: bytes,
    ) -> None:
        payload = _json(body, WebhookAuthenticityError)
        if endpoint == "events":
            try:
                await self._app.bot_authenticator.verify(
                    _header(headers, "authorization"),
                    service_url=str(payload.get("serviceUrl", "")).strip(),
                    channel_id=str(payload.get("channelId", "")),
                )
            except PermissionError as error:
                raise WebhookAuthenticityError(str(error)) from error
            return
        await self._verify_notifications(payload)

    async def _verify_notifications(self, payload: Mapping[str, Any]) -> None:
        """Check every validation token the batch carries.

        A forged token refuses the whole request. The tokens vouch for the
        organisations their notifications belong to; parsing then drops any
        notification carrying data for an organisation they did not vouch for,
        rather than refusing the batch — one organisation's missing token (it
        set "assignment required" on the Switch enterprise app, and Microsoft
        stops sending one) must not cost every other organisation in the same
        batch its messages. Lifecycle notifications carry no data and usually
        no tokens; they reach the bridge they name, which checks that
        organisation's own `clientState` and that the subscription is its own
        before acting.
        """
        items = payload.get("value")
        if not isinstance(items, list):
            raise WebhookAuthenticityError("not a Graph notification collection")
        carrying_data = [
            item
            for item in items
            if isinstance(item, dict) and not item.get("lifecycleEvent")
        ]
        if not carrying_data:
            return
        tokens = payload.get("validationTokens") or []
        try:
            vouched = await self._app.notification_authenticator.vouched_tenants(
                list(tokens)
            )
        except PermissionError as error:
            raise WebhookAuthenticityError(str(error)) from error
        self._remember_vouched(_digest(payload), vouched)

    def parse_webhook(
        self,
        *,
        endpoint: WebhookEndpoint,
        headers: Mapping[str, str],
        query: Mapping[str, str],
        body: bytes,
    ) -> list[InboundWebhook]:
        payload = _json(body, WebhookPayloadError)
        if endpoint == "events":
            return [_activity_event(payload)]
        items = payload.get("value")
        if not isinstance(items, list):
            raise WebhookPayloadError("a Graph notification collection had no value")
        vouched = self._vouched.pop(_digest(payload), frozenset())
        events: list[InboundWebhook] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            tenant = str(item.get("tenantId") or "")
            if not item.get("lifecycleEvent") and tenant not in vouched:
                logger.error(
                    "Dropped a Graph notification for organisation %s: no "
                    "validation token vouched for it. Microsoft sends none when "
                    "the organisation has set “assignment required” on the Switch "
                    "enterprise app.",
                    tenant,
                )
                continue
            events.append(_notification_event(item))
        return events

    def _remember_vouched(self, digest: bytes, vouched: frozenset[str]) -> None:
        """Hand the organisations a batch's tokens vouched for to its parse.

        Keyed by the body, so the parse of these bytes reads what the check of
        the same bytes found, and bounded, so a parse that never comes leaves
        nothing behind for long.
        """
        self._vouched[digest] = vouched
        while len(self._vouched) > _VOUCHED_KEPT:
            self._vouched.popitem(last=False)

    def workspace_of_event(self, payload: Mapping[str, object]) -> str:
        if "subscriptionId" in payload:
            tenant = payload.get("tenantId")
        else:
            tenant = activity_tenant(dict(payload))
        if not tenant:
            raise WebhookPayloadError(
                "a Teams event names no organisation, or names two"
            )
        return str(tenant)

    def revocation_of_event(self, payload: Mapping[str, object]) -> str | None:
        # Microsoft announces no organisation-wide uninstall: removal from a
        # team is per team, and goes to the bridge like any other activity.
        return None


def _digest(payload: Mapping[str, Any]) -> bytes:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).digest()


def _json(body: bytes, error: type[Exception]) -> dict[str, Any]:
    try:
        payload = json.loads(body)
    except ValueError as failure:
        raise error(f"the body is not JSON: {failure}") from failure
    if not isinstance(payload, dict):
        raise error("the body is not a JSON object")
    return payload


def _header(headers: Mapping[str, str], name: str) -> str | None:
    for key, value in headers.items():
        if key.lower() == name:
            return value
    return None


def _activity_event(activity: dict[str, Any]) -> InboundWebhook:
    is_invoke = activity.get("type") == "invoke"
    tenant = activity_tenant(activity)
    conversation = str((activity.get("conversation") or {}).get("id") or "")
    activity_id = str(activity.get("id") or "")
    return InboundWebhook(
        envelope_type="activity",
        payload=activity,
        handshake=None,
        # Teams message ids are only unique within one conversation, and a
        # workspace can hold several organisations, so the key carries both.
        # A press is never keyed: it is answered inline, and a retry of one
        # has to be answered again.
        external_event_id=(
            f"{tenant}|{conversation}|{activity_id}"
            if not is_invoke and tenant and conversation and activity_id
            else None
        ),
        delivery_attempt=0,
        answers_inline=is_invoke,
    )


def _notification_event(item: dict[str, Any]) -> InboundWebhook:
    resource = str(item.get("resource") or "")
    tenant = str(item.get("tenantId") or "")
    is_data = not item.get("lifecycleEvent")
    return InboundWebhook(
        envelope_type="notification",
        payload=item,
        handshake=None,
        # The resource names the team, the channel and the message, so the
        # same message captured twice is one key whichever subscription or
        # batch it came in.
        external_event_id=(
            f"{tenant}|{resource}|{item.get('changeType') or ''}"
            if is_data and tenant and resource
            else None
        ),
        delivery_attempt=0,
        answers_inline=False,
    )


def _asks_per_team(definition: Mapping[str, Any]) -> bool:
    """Whether a catalogue app definition requires resource-specific consent."""
    authorization = definition.get("authorization") or {}
    permission_set = authorization.get("requiredPermissionSet") or {}
    return bool(permission_set.get("resourceSpecificPermissions"))


def _graph_refusal(error: Exception) -> str:
    if isinstance(error, httpx.HTTPStatusError):
        response = error.response
        try:
            detail = response.json()["error"]["message"]
        except (ValueError, KeyError, TypeError):
            detail = response.text[:300]
        if response.status_code == 403:
            return (
                "the person who approved Switch is not a Teams administrator, so "
                f"Microsoft would not let Switch add the app to the organisation's "
                f"app list ({detail})"
            )
        return f"Microsoft refused ({response.status_code}): {detail}"
    return str(error)
