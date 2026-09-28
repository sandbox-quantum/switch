"""Installing *our* app into someone else's workspace.

A `PlatformAdapter` is what a bridge runs; this is what happens before
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
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, ClassVar, Literal

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


def oauth_confirm_path(platform: str) -> str:
    return f"{PUBLIC_PATH_PREFIX}/{platform}/oauth/confirm"


def events_path(platform: str) -> str:
    return f"{PUBLIC_PATH_PREFIX}/{platform}/events"


def interactive_path(platform: str) -> str:
    return f"{PUBLIC_PATH_PREFIX}/{platform}/interactive"


def commands_path(platform: str) -> str:
    return f"{PUBLIC_PATH_PREFIX}/{platform}/commands"


def notifications_path(platform: str) -> str:
    return f"{PUBLIC_PATH_PREFIX}/{platform}/notifications"


def public_url(public_origin: str, path: str) -> str:
    """Absolute URL for one install path, given the deployment's public origin.

    The origin is `MESSAGING_PUBLIC_URL`, which is validated at startup as
    scheme and host with no path, so this is a join and not a merge. It exists as a
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


class WebhookVerificationUnavailable(RuntimeError):
    """An inbound webhook could not be checked at all, so it is neither
    accepted nor refused.

    The platform's signing keys could not be fetched: that is the platform's
    outage, or ours, and says nothing about the request. Answered 503, which
    platforms retry, where a 401 would turn the outage into lost events.
    """


class WebhookPayloadError(RuntimeError):
    """A webhook proved genuine and then could not be read.

    Distinct from :class:`WebhookAuthenticityError` because it says something
    entirely different: the signature checked out, so this really is the
    platform, and what it sent is a shape this build does not know. That is a
    fault worth seeing in a log — an unrecognised body is how a platform's
    change first shows up — where a bad signature is just the internet.
    """


#: Which of a platform's inbound endpoints a request arrived on.
#:
#: Each platform declares the ones it uses (`webhook_endpoints`): Slack asks
#: for events, interactivity and slash commands; Teams for the Bot Framework's
#: events and Graph's change notifications. They are separate URLs rather than
#: one, because a platform decides that, not us — and they carry genuinely
#: different bodies (Slack posts JSON to one and a form to the others, and a
#: Bot Framework activity is signed differently from a Graph notification),
#: which is why the endpoint is an argument to verifying and parsing rather
#: than something a handler could infer.
WebhookEndpoint = Literal["events", "interactive", "commands", "notifications"]


@dataclass(frozen=True)
class InboundWebhook:
    """One authenticated inbound event, in the shape a running adapter takes.

    `envelope_type` and `payload` are deliberately the two arguments Socket
    Mode's own listener is handed, so an event that arrived over HTTP and the
    same event over a socket reach `dispatch_event` indistinguishable from one
    another. Anything that made them differ would be two code paths for one
    behaviour, drifting apart at the speed of whichever gets used more.

    `handshake` is the exception, and it is not an event at all: a platform
    proving the URL it was given is really ours (Slack's `url_verification`)
    expects a specific string echoed straight back and nothing dispatched. It
    is `None` for every real event, and it arrives before any workspace has
    installed anything — so it must be answerable with no tenant, no install
    row, and nothing running.

    `external_event_id` is the platform's own id for this delivery, and the
    only thing two copies of one event have in common — the payload is
    identical, so nothing else could tell a retry from a second message saying
    the same words. `None` means the platform does not number this kind of
    envelope, which on Slack means the kind it also does not retry; it never
    means "this one was not checked".

    `delivery_attempt` is how many times the platform has given up on us and
    sent this again, zero on a first delivery. It changes nothing about how the
    event is handled — the receipt decides that — and is carried because it is
    the only place the deployment is told its own acknowledgements are arriving
    too late.

    `answers_inline` marks an event the platform waits on for its answer in the
    response itself — a press on a Teams card, which spins on the presser's
    screen until the response arrives and says what came of it. Every other
    event is acknowledged first and handled after. One that answers inline is
    handled before the response, under a deadline, and is never deduplicated
    by receipt: a retry has to be given the same answer, not nothing.
    """

    envelope_type: str
    payload: dict[str, Any]
    handshake: str | None
    external_event_id: str | None
    delivery_attempt: int
    answers_inline: bool


@dataclass(frozen=True)
class InstallGrant:
    """What the platform handed back when a workspace installed us.

    Deliberately four fields and not the platform's whole response. What a
    grant *is*, across platforms, is a workspace, a credential, and the
    permissions that credential was actually given — everything else in the
    response is Slack's shape and belongs behind `connection_config`.

    `workspace_name` is the exception, and it earns its place by being the only
    thing here a person recognises. It names the bridge in the operator's list,
    where the alternative is a row of opaque platform ids. It is the customer's
    own text and is never matched on.

    `bot_token` is `None` for a platform whose credential is not per-install.
    A Discord install grants no per-guild token — the bot authenticates to
    every guild with the one deployment-level application token — so its grant
    is a guild id and a name and nothing to store. A Slack grant always carries
    one; the requirement lives on that platform's `connection_config` validator,
    not here (`SlackConnectionConfig.bot_token` is required), so an optional
    field here does not weaken it.

    `scopes` is the platform's own spelling, kept verbatim. A scope string that
    means nothing to us is still the thing to show an operator asking why a
    call was refused, and parsing it into a list here would be a parser to keep
    in step with someone else's vocabulary for no gain.

    `platform_data` is anything else the platform will need about this install
    later and that is not a secret — kept on the install row, where a
    workspace admin cannot edit it, rather than in the bridge's config, where
    they can. Empty for a platform with nothing to keep.
    """

    external_workspace_id: str
    workspace_name: str
    bot_token: str | None
    scopes: str
    platform_data: Mapping[str, object]


@dataclass(frozen=True)
class InstallClaim:
    """A platform event that asks for its workspace to be installed.

    The counterpart of a completed OAuth callback for a platform that has none.
    Telegram cannot redirect a browser anywhere; what it can do is post the
    state it was handed into the chat the bot was just added to, so the
    install arrives as an ordinary webhook event instead of a callback.

    `grant` is what that event amounts to, in the shape the rest of the install
    already takes. `workspace_name` names the bridge when this claim is the one
    that creates it, so for a platform whose bridge serves many workspaces it
    should name the connection rather than the one chat that happened to come
    first.
    """

    token: str
    grant: InstallGrant


#: Why a claim was refused, as a person trying to connect a chat needs to hear
#: it. `expired` covers a link already used too: the store cannot tell the two
#: apart, and neither is fixed differently — both want a fresh link.
ClaimRefusal = Literal["expired", "unrecognised", "already_connected", "not_permitted"]


#: Which state token an installer's platform can carry. `v1` for a platform
#: that hands the state back through a redirect; `compact` for one whose only
#: carrier is short (see `install_state`).
StateFormat = Literal["v1", "compact"]


class MessagingAppInstaller(ABC):
    """The install half of one platform, holding that platform's app credentials.

    One instance per platform per deployment, built at boot from config and
    registered by platform name. The methods that may need the network — the
    code exchange, and proving a webhook genuine, which for some platforms
    means fetching the keys it was signed with — are asynchronous; the rest
    are pure and synchronous.
    """

    #: The platform this installs, matching the adapter registry's key and the
    #: `platform` column on `messaging_installs`.
    platform: ClassVar[str]

    #: The inbound endpoints this platform's app posts to. A request to any
    #: other is answered as if no app were registered, before anything reads
    #: it — so a platform that delivers over a socket of its own declares none
    #: and its webhook URLs simply do not exist.
    webhook_endpoints: ClassVar[frozenset[WebhookEndpoint]]

    state_format: ClassVar[StateFormat] = "v1"

    #: Whether events from workspaces nobody has installed are routine here.
    #: Off for a platform whose app is only ever in workspaces that installed
    #: it, so such an event is worth a warning each time. On for one whose app
    #: can sit in chats nobody claimed and hear everything said there, where a
    #: warning per event would bury the drops that are real losses; those are
    #: counted instead.
    expects_unowned_events: ClassVar[bool] = False

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
    async def revoke(self, *, bot_token: str) -> None:
        """Tell the platform the credential it granted us is finished with.

        Called when an operator disconnects an install. Deleting our copy is
        not the same act: the token stays valid at the platform, so a dump
        taken before the disconnect would still hold a working key into a
        customer's workspace. This is the half only the platform can do.

        **A token the platform already considers dead is a success, not a
        failure.** The common reason to be disconnecting at all is that the
        customer removed the app on their side, and an implementation that
        raised on "this token is already invalid" would make exactly that
        install impossible to disconnect, forever.

        Raise :class:`MessagingInstallError` for anything else — a refusal we
        do not understand leaves a live credential behind and the operator
        should hear about it rather than see a disconnect that reports
        success.

        Not the same thing as the platform's own uninstall. Revoking a token
        does not remove the app from the workspace; it ends this deployment's
        access with it.
        """

    def unsigned_handshake(
        self, *, endpoint: WebhookEndpoint, query: Mapping[str, str]
    ) -> str | None:
        """The answer to a URL check the platform makes without signing it.

        Microsoft Graph proves a notification URL is ours by posting a
        `validationToken` in the query string with nothing to authenticate it
        by, and expects the token echoed back within seconds. That is answered
        here, before verification, because it cannot pass verification by
        design — and echoing a stranger's string back to them discloses
        nothing and does nothing.

        None — the default — for every other request. A platform whose URL
        check is signed (Slack's `url_verification`) answers it as an ordinary
        event's `handshake` instead, after it has been verified.
        """
        return None

    @abstractmethod
    async def verify_webhook(
        self,
        *,
        endpoint: WebhookEndpoint,
        headers: Mapping[str, str],
        query: Mapping[str, str],
        body: bytes,
    ) -> None:
        """Prove an inbound request came from the platform, or raise.

        Takes the **raw body**, not a parsed payload, because every platform's
        signature covers the bytes as sent: re-serialising a parsed dict
        produces different bytes and a signature that never verifies.

        Takes the endpoint because what proves a request genuine can differ by
        endpoint — a Teams activity carries a Bot Framework token, a Graph
        notification carries tokens from the Microsoft identity platform —
        and is asynchronous because proving it can mean fetching the keys it
        was signed with.

        This is the first thing any webhook handler does — before parsing,
        before resolving a tenant, before logging the body. Raise
        :class:`WebhookAuthenticityError`.
        """

    @abstractmethod
    def parse_webhook(
        self,
        *,
        endpoint: WebhookEndpoint,
        headers: Mapping[str, str],
        query: Mapping[str, str],
        body: bytes,
    ) -> list[InboundWebhook]:
        """Read a verified request into the events a running adapter takes.

        A list, because one request can carry several: Graph batches change
        notifications, and the notifications in one batch can belong to
        different organisations, each of which is routed on its own. Most
        platforms send one event per request and return one.

        Called only after :meth:`verify_webhook` has passed, and separate from
        it for exactly that reason: parsing before verifying is how an
        unauthenticated body gets to choose which code runs.

        Takes the raw bytes rather than a parsed payload because only this
        method knows the encoding, which is per platform and per endpoint —
        Slack posts JSON to one of its three and form data to the other two.

        Takes the headers as well as the body because a delivery is described
        in both: the event is in the body, and how many times it has been sent
        is in a header. Which header, and whether there is one, is the
        platform's business rather than the route's.

        Raise :class:`WebhookPayloadError` for a body that cannot be read.
        """

    @abstractmethod
    def workspace_of_event(self, payload: Mapping[str, object]) -> str:
        """Which workspace an authenticated event came from.

        The answer is what resolves a tenant, so this runs on a request with
        nothing bound and must not touch the database. Raise
        :class:`WebhookPayloadError` for a payload that names no workspace: an
        event we cannot route is not an event we may guess at.
        """

    @abstractmethod
    def revocation_of_event(self, payload: Mapping[str, object]) -> str | None:
        """Why this event says the install is over, or `None` if it does not.

        Platforms report the end of an install as an ordinary event on the
        ordinary endpoint, which makes it easy to treat as one: the app is
        removed from a workspace, an event arrives saying so, nothing reads
        it, and the deployment goes on holding a dead token, a running bridge
        and a claim on a workspace whose owner believes they have left.

        A reason rather than a flag because it is the thing worth logging — an
        operator asking why their bridge stopped needs the platform's own
        answer, and there is more than one way an install can end.

        Runs on a payload that has been authenticated and not yet routed, so
        like :meth:`workspace_of_event` it must not touch the database.
        """

    def workspace_of_bridge(
        self, connection_config: Mapping[str, object]
    ) -> str | None:
        """The workspace a bridge on the deployment's own credential serves.

        Set by a platform whose installed bridges all run on one credential
        the deployment holds (Discord's one bot), so a bridge naming a
        workspace is a bridge that can reach it. Such a bridge may only start
        for the tenant whose live install that workspace is, and this is what
        names the workspace to check. None for every other bridge, which
        reaches only what its own credential reaches.
        """
        return None

    async def release(self, *, external_workspace_id: str) -> None:
        """Take the app out of a workspace whose install is being disconnected.

        The counterpart of `revoke` for a platform with no per-install token,
        called only when the install's bridge is not running to do it itself
        (`PlatformAdapter.withdraw`). A no-op where there is nothing on
        the platform to undo. Best effort: raise `MessagingInstallError` to
        say what was left behind, and the disconnect is refused so it can be
        tried again.
        """
        return None

    def describe_callback_error(self, *, error: str, description: str | None) -> str:
        """What to tell the person whose install the platform refused, in plain words.

        The platform's own refusal arrives on the callback as a code and, from
        some platforms, a description written for developers. The default says
        which code it was; a platform whose codes mean something a person can
        act on — "you need to be an administrator" — says that instead.
        """
        return f"{self.platform} reported: {error}."

    def claim_of_event(self, payload: Mapping[str, object]) -> InstallClaim | None:
        """The install this event asks for, or `None` if it asks for none.

        Only a platform with no OAuth leg overrides this; for the rest an
        install arrives at the callback and never as an event.

        Asked before the event is resolved, because the workspace it names is
        by definition not installed yet and resolving it would drop the one
        event that could change that. Pure, like :meth:`workspace_of_event`:
        the token is verified and redeemed by the install service, not here.
        """
        return None

    def migration_of_event(
        self, payload: Mapping[str, object]
    ) -> tuple[str, str] | None:
        """`(old id, new id)` if this event says its workspace changed id.

        Telegram reissues a chat's id when a group becomes a supergroup. The
        install row is keyed by that id and has to follow it, or the chat's
        events stop resolving to anyone. Pure, like `workspace_of_event`,
        which for such an event answers the *old* id so it still resolves.
        """
        return None

    async def on_claim_refused(
        self, *, claim: InstallClaim, reason: ClaimRefusal
    ) -> None:
        """Tell the chat a claim came from why it was not connected.

        Runs after the platform has been answered. Without it the person who
        tapped the link sees nothing happen, which reads as Switch being broken
        rather than as a link that ran out. Must say nothing about which tenant
        holds a chat that is already connected.
        """
        return None

    async def on_unowned_event(
        self,
        *,
        workspace_id: str,
        payload: Mapping[str, object],
        still_unowned: Callable[[], Awaitable[bool]],
    ) -> None:
        """React to an authentic event from a workspace nobody holds.

        Runs after the platform has been answered. Nothing about the event may
        be stored; what a platform may do is say something back in the chat —
        how to connect it, or that a direct message reaches no one.
        `still_unowned` re-asks, for a reply worth delaying until a claim that
        may be in flight has had its chance.
        """
        return None

    def shared_connection(self) -> object | None:
        """The deployment-level connection this platform's bridges run on, if any.

        `None` for a platform whose bridges each hold their own credential.
        A platform with one app-wide bot returns what its bridges attach to,
        and the install service hands it to a bridge the first time it
        delivers that bridge an event — which is how a bridge registered after
        boot gets one.

        Raise :class:`MessagingInstallError` if it exists but cannot be used
        yet; the event is then refused as retryable rather than delivered to a
        bridge that could not act on it.
        """
        return None

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
