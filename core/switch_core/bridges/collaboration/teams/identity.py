"""Who a Teams bridge speaks as, and how it reads what Graph sends it.

A bring-your-own bridge carries its own app: its credentials, the secret Graph
echoes back, and the keypair Graph encrypts to all live in its connection
config. A bridge serving the distributed app carries none of that — the app is
the deployment's, shared by every organisation that approved it — and is told
which organisation it serves.

Everything the adapter needs from either is behind `TeamsIdentity` and
`TeamsTokens`, so the rest of the adapter is one code path whichever app a
bridge belongs to.
"""

from __future__ import annotations

import hmac
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.asymmetric import rsa

from switch_core.bridges.collaboration.teams.auth import (
    BOT_CONNECTOR_SCOPE,
    TeamsTokenProvider,
)
from switch_core.bridges.collaboration.teams.crypto import (
    ResourceDataError,
    decrypt_resource_data,
)

#: The Graph application permissions an organisation's admin grants the
#: distributed app, and that every token issued in their directory must carry.
#: A token missing any of them means the approval was narrowed or withdrawn,
#: and the bridge says so rather than failing call by call.
REQUIRED_GRAPH_ROLES = frozenset(
    {
        "ChannelMessage.Read.All",
        "Channel.Create",
        "Channel.ReadBasic.All",
        "TeamMember.ReadWriteNonOwnerRole.All",
        "ChannelMember.ReadWrite.All",
        "User.ReadBasic.All",
        "Team.ReadBasic.All",
        "TeamsAppInstallation.ReadWriteSelfForTeam.All",
    }
)

#: Where Microsoft's public-cloud Bot Connector lives. The distributed app's
#: Bot Connector token is good in every approving organisation, so it is sent
#: here and nowhere else, whatever address a stored reference or a learned
#: setting names. Government clouds have hosts of their own and are out of
#: scope.
BOT_CONNECTOR_HOSTS = frozenset({"smba.trafficmanager.net"})


class TeamsTokens(Protocol):
    """The tokens the Bot Connector and Graph clients authorise calls with."""

    def invalidate(self, scope: str, *, min_age_seconds: float = 0.0) -> bool: ...

    async def bot_token(self) -> str: ...

    async def graph_token(self) -> str: ...

    async def graph_roles(self) -> frozenset[str]: ...


class OrgTokens:
    """Tokens for one customer organisation under the distributed app.

    The two halves come from different directories, which is the whole of
    Microsoft's arrangement for a SingleTenant bot serving other
    organisations: every Bot Connector token is issued in our own directory,
    and every Graph token in the organisation whose data it reads.
    """

    def __init__(self, *, home: TeamsTokenProvider, org: TeamsTokenProvider) -> None:
        self._home = home
        self._org = org

    def invalidate(self, scope: str, *, min_age_seconds: float = 0.0) -> bool:
        provider = self._home if scope == BOT_CONNECTOR_SCOPE else self._org
        return provider.invalidate(scope, min_age_seconds=min_age_seconds)

    async def bot_token(self) -> str:
        return await self._home.bot_token()

    async def graph_token(self) -> str:
        return await self._org.graph_token()

    async def graph_roles(self) -> frozenset[str]:
        return await self._org.graph_roles()


@dataclass(frozen=True)
class NotificationKey:
    certificate_id: str
    private_key: rsa.RSAPrivateKey


class NotificationKeyring:
    """The keypair Graph encrypts notifications to, and any it still might.

    New subscriptions are made against the current certificate. A notification
    names the certificate it was encrypted to, so one made against a key being
    retired is still read until its subscription runs out — which is the whole
    of what rotating the key needs.
    """

    def __init__(
        self,
        *,
        current: NotificationKey,
        certificate_der_b64: str,
        retired: tuple[NotificationKey, ...],
    ) -> None:
        self._current = current
        self._certificate_der_b64 = certificate_der_b64
        self._keys = {key.certificate_id: key for key in (current, *retired)}

    @property
    def certificate_id(self) -> str:
        return self._current.certificate_id

    @property
    def certificate_der_b64(self) -> str:
        return self._certificate_der_b64

    def decrypt(self, encrypted_content: dict[str, Any]) -> dict[str, Any]:
        named = encrypted_content.get("encryptionCertificateId")
        key = self._keys.get(str(named)) if named else self._current
        if key is None:
            raise ResourceDataError(
                f"notification is encrypted to certificate {named!r}, which this "
                "deployment does not hold"
            )
        return decrypt_resource_data(encrypted_content, key.private_key)


@dataclass(frozen=True)
class TeamsIdentity:
    """The app a bridge speaks as, and the organisation it serves.

    `shared` is the one fact the adapter branches on outside its start-up:
    under the distributed app one credential reaches every organisation, so a
    bridge must refuse whatever belongs to an organisation other than its own,
    and must only ever send that credential to Microsoft.
    """

    app_id: str
    org_tenant_id: str
    shared: bool
    notification_url: str
    client_state: str
    #: None when a bring-your-own bridge has no encryption material, in which
    #: case channel capture is degraded and says so.
    keyring: NotificationKeyring | None
    #: Hosts the Bot Connector token may be sent to, or None for no restriction.
    allowed_service_hosts: frozenset[str] | None
    #: The Graph application permissions the organisation must have granted,
    #: checked against every token. Empty for a bring-your-own bridge, whose
    #: operator decides what their own app is granted.
    required_graph_roles: frozenset[str]

    def delivers_here(self, notification_url: str) -> bool:
        """Whether a subscription's notification URL is this deployment's own.

        Compared without the query, which carries the clientState key's
        fingerprint: a subscription made under an earlier key still delivers
        here, and is this deployment's to clean up.
        """
        theirs = urlsplit(notification_url)
        ours = urlsplit(self.notification_url)
        return (theirs.scheme, theirs.netloc, theirs.path) == (
            ours.scheme,
            ours.netloc,
            ours.path,
        )

    def accepts_client_state(self, value: object) -> bool:
        # Constant time: this is an authentication check, and a `!=` on a
        # secret leaks its prefix through timing.
        return hmac.compare_digest(str(value or ""), self.client_state)

    def serves(self, tenant_id: str | None) -> bool:
        """Whether something from directory `tenant_id` is this bridge's.

        A bring-your-own bridge's credential reaches only its own directory,
        so whatever it receives is its own. A shared bridge's reaches every
        approving organisation's, so only its own is.
        """
        if not self.shared:
            return True
        return tenant_id == self.org_tenant_id
