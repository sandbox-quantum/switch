"""Installing *our* app into someone else's workspace.

A `CollaborationAdapter` is what a bridge runs; this is what happens before
there is one. The distinction is not organisational — the two have genuinely
different lifetimes and genuinely different secrets:

- An adapter is per bridge, built from a `connection_config` that already
  holds a working credential, and it exists only while that bridge runs.
- An installer is per deployment, built once from the credentials of the app
  *we* registered with the platform, and it exists whether or not any bridge
  does. It is what turns a click on "Add to Slack" into a credential, and what
  proves an inbound webhook came from the platform rather than from anyone who
  found the URL.

So an installer is not a classmethod on the adapter. Making it one would mean
threading a client secret through every call, and would put "which app did we
register with Slack" on an object whose whole scope is one customer's bridge.

**The seam between the two is `connection_config`.** An installer's last act
is to render the grant into exactly the dict the platform's adapter already
takes, so nothing downstream of the install knows an install happened:
`CollaborationBridgeLifecycleService.register` validates and starts it the way
it does a bridge an operator typed in by hand. That is deliberate — an
installed bridge and a self-registered one differ in where the token came
from, and in nothing else.

**Registration is the feature flag.** There is no `installs_enabled` setting.
An installer exists for a platform when that platform's app credentials are
configured, and the endpoints refuse when it does not — a deployment that has
not registered an app cannot half-offer installs.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass
from typing import ClassVar

#: The public prefix every install endpoint hangs off.
#:
#: Its own prefix rather than a corner of an existing one, because everything
#: under it is unauthenticated by nature — a Slack event carries no credential
#: of ours, and a callback arrives before there is anything to authenticate
#: against. Grouping them makes that one property of the prefix rather than of
#: each route.
#:
#: Deliberately not under `/gateway`, which is cookie-authenticated and is not
#: routed to this application from outside; and deliberately not under
#: `/oauth`, which already belongs to agents authenticating *to* Switch and
#: would share only the word.
PUBLIC_PATH_PREFIX = "/messaging"


def oauth_callback_path(platform: str) -> str:
    return f"{PUBLIC_PATH_PREFIX}/{platform}/oauth/callback"


def events_path(platform: str) -> str:
    return f"{PUBLIC_PATH_PREFIX}/{platform}/events"


def interactive_path(platform: str) -> str:
    return f"{PUBLIC_PATH_PREFIX}/{platform}/interactive"


def commands_path(platform: str) -> str:
    return f"{PUBLIC_PATH_PREFIX}/{platform}/commands"


def public_url(public_origin: str, path: str) -> str:
    """Absolute URL for one install path, given the deployment's public origin.

    The origin is `GATEWAY_PUBLIC_URL`, which is validated at startup as scheme
    and host with no path, so this is a join and not a merge. It exists as a
    function so the redirect URI sent to the platform and the one registered
    with the app are built the same way — the platform compares them exactly,
    and a trailing slash on one side is a refused install with a message that
    does not say so.
    """
    return f"{public_origin.rstrip('/')}{path}"


class MessagingInstallError(RuntimeError):
    """An install could not be completed, with a reason fit to show an operator.

    Raised rather than returned for the usual reason: every caller of these
    methods is a request handler that must not continue on a failure, and a
    falsy return is the kind of thing a caller forgets to check.
    """


class WebhookAuthenticityError(RuntimeError):
    """An inbound webhook did not prove it came from the platform.

    Separate from `MessagingInstallError` because the two are answered
    differently: an install failure is shown to the operator who caused it,
    while this one is a request from an unknown party and gets a bare 401 with
    nothing in it. Never log the body alongside this — it is unauthenticated
    input.
    """


@dataclass(frozen=True)
class InstallGrant:
    """What the platform handed back when a workspace installed us.

    Deliberately three fields and not the platform's whole response. What a
    grant *is*, across platforms, is a workspace, a credential, and the
    permissions that credential was actually given — everything else in the
    response is Slack's shape and belongs behind `connection_config`.

    `scopes` is the platform's own spelling, kept verbatim. A scope string that
    means nothing to us is still the thing to show an operator asking why a
    call was refused, and parsing it into a list here would be a parser to keep
    in step with someone else's vocabulary for no gain.
    """

    external_workspace_id: str
    bot_token: str
    scopes: str


class MessagingAppInstaller(ABC):
    """The install half of one platform, holding that platform's app credentials.

    One instance per platform per deployment, built at boot from config and
    registered by platform name. Every method is deliberately synchronous
    except the code exchange, which is the only one that talks to the network.
    """

    #: The platform this installs, matching the adapter registry's key and the
    #: `platform` column on `messaging_installs`.
    platform: ClassVar[str]

    @abstractmethod
    def authorize_url(self, *, state: str, redirect_uri: str) -> str:
        """Where to send the browser to begin an install.

        `state` is opaque here and is not the installer's to interpret: it is
        minted, signed and redeemed by the install service, and this method's
        only obligation is to hand it back to the platform unchanged.
        """

    @abstractmethod
    async def redeem(self, *, code: str, redirect_uri: str) -> InstallGrant:
        """Exchange the authorization code the callback carried for a credential.

        `redirect_uri` is passed again because the platform checks it matches
        the one the flow started with — it is part of the proof, not a
        convenience.

        Raise :class:`MessagingInstallError` on anything short of a usable
        grant, including a well-formed response the platform marked as failed.
        """

    @abstractmethod
    def verify_webhook(self, *, headers: Mapping[str, str], body: bytes) -> None:
        """Prove an inbound event came from the platform, or raise.

        Takes the **raw body**, not a parsed payload, because every platform's
        signature covers the bytes as sent: re-serialising a parsed dict
        produces different bytes and a signature that never verifies.

        This is the first thing any webhook handler does — before parsing,
        before resolving a tenant, before logging the body. Raise
        :class:`WebhookAuthenticityError`.
        """

    @abstractmethod
    def workspace_of_event(self, payload: Mapping[str, object]) -> str:
        """Which workspace an authenticated event came from.

        The answer is what resolves a tenant, so this runs on a request with
        nothing bound and must not touch the database. Raise
        :class:`WebhookAuthenticityError` for a payload that names no
        workspace: an event we cannot route is not an event we may guess at.
        """

    @abstractmethod
    def connection_config(self, grant: InstallGrant) -> dict[str, object]:
        """Render a grant as the connection config this platform's adapter takes.

        The whole point of the abstraction: after this, an installed bridge is
        indistinguishable from one an operator registered by hand, and every
        line of lifecycle, validation and start-up code is shared.
        """


class MessagingInstallerRegistry:
    """The installers this deployment has app credentials for.

    A dict with a loud `__getitem__`, which is the only behaviour worth a class
    here: asking for a platform nobody registered an app for is the ordinary
    case (most deployments will register none), and it has to produce a
    sentence an operator can act on rather than a `KeyError` in a traceback.
    """

    def __init__(self) -> None:
        self._installers: dict[str, MessagingAppInstaller] = {}

    def register(self, installer: MessagingAppInstaller) -> None:
        if installer.platform in self._installers:
            raise MessagingInstallError(
                f"an installer for {installer.platform!r} is already registered"
            )
        self._installers[installer.platform] = installer

    def get(self, platform: str) -> MessagingAppInstaller:
        try:
            return self._installers[platform]
        except KeyError:
            raise MessagingInstallError(
                f"no {platform} app is registered with this deployment, so it "
                "cannot be installed into a workspace. Configure the app's "
                "credentials and restart."
            ) from None

    def platforms(self) -> list[str]:
        return sorted(self._installers)
