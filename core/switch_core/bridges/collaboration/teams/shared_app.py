"""The one deployment-level Microsoft Teams app.

The distributed Teams app is a single multi-tenant Entra app registration
backing a SingleTenant Azure Bot in our own directory (see
`TEAMS_DISTRIBUTED_APP.md`). One credential reaches every organisation that
approved it, so — like Discord's Gateway client — this object holds it, binds no
organisation, and is not a bridge. Each approving organisation gets an ordinary
bridge, and this hands that bridge what it needs to serve that organisation and
no other:

- Bot Connector tokens, issued in our own directory for every organisation,
  because that is the only directory a SingleTenant bot's tokens come from.
- Graph tokens issued in the organisation's directory, one provider each.
- The organisation's own `clientState`, derived rather than stored, so a secret
  leaked for one organisation forges nothing for another.
- The notification keyring and the authenticators for inbound activities and
  change notifications, which run before anything says which organisation a
  request is for.

It lives in the one switch-core process (a forced singleton), started at boot,
so there is never a second holder of the credential.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
from typing import Any

import httpx
from cryptography.hazmat.primitives import serialization

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.install import PUBLIC_PATH_PREFIX, public_url
from switch_core.bridges.collaboration.teams.adapter import TeamsAdapter
from switch_core.bridges.collaboration.teams.auth import (
    BOTFRAMEWORK_OPENID,
    MICROSOFT_IDENTITY_OPENID,
    BotFrameworkAuthenticator,
    ClientCertificate,
    ClientCredential,
    ClientSecret,
    FederatedTokenFile,
    GraphNotificationAuthenticator,
    SigningKeys,
    TeamsTokenProvider,
    verify_microsoft_id_token,
)
from switch_core.bridges.collaboration.teams.crypto import (
    load_certificate_der_b64,
    load_private_key,
)
from switch_core.bridges.collaboration.teams.identity import (
    BOT_CONNECTOR_HOSTS,
    REQUIRED_GRAPH_ROLES,
    NotificationKey,
    NotificationKeyring,
    OrgTokens,
    TeamsIdentity,
)
from switch_core.config import SwitchConfig

logger = logging.getLogger(__name__)

PLATFORM = "teams"

#: Distinguishes this use of `JWT_SECRET_KEY` from every other, as the install
#: state does. Changing it changes every organisation's clientState, which
#: fails every live subscription's origin check until it is recreated.
_CLIENT_STATE_KEY_INFO = b"switch/teams-client-state/v1"


def notifications_path() -> str:
    return f"{PUBLIC_PATH_PREFIX}/{PLATFORM}/notifications"


def client_state_for(secret: str, org_tenant_id: str) -> str:
    """The `clientState` Graph echoes on an organisation's notifications.

    Derived from the deployment secret and the organisation, so nothing is
    stored and a value learned for one organisation is useless for any other.
    Graph caps it at 128 characters; this is 43.
    """
    key = hmac.new(secret.encode(), _CLIENT_STATE_KEY_INFO, hashlib.sha256).digest()
    digest = hmac.new(key, org_tenant_id.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def _notification_certificate_id(private_key_pem: str) -> str:
    """A label for the notification keypair, derived from the key itself.

    Graph echoes it back on every notification so the right key can be picked,
    and deriving it means a retired key needs no label of its own to be found.
    """
    public = load_private_key(private_key_pem).public_key()
    der = public.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return "switch-" + hashlib.sha256(der).hexdigest()[:16]


def _credential(config: SwitchConfig) -> ClientCredential:
    if config.teams_app_client_secret:
        return ClientSecret(config.teams_app_client_secret)
    if config.teams_app_certificate:
        assert config.teams_app_certificate_private_key is not None
        return ClientCertificate(
            certificate_pem=config.teams_app_certificate,
            private_key_pem=config.teams_app_certificate_private_key,
        )
    assert config.teams_app_federated_token_file is not None
    return FederatedTokenFile(config.teams_app_federated_token_file)


class TeamsSharedApp:
    def __init__(
        self,
        *,
        app_id: str,
        home_tenant_id: str,
        credential: ClientCredential,
        keyring: NotificationKeyring,
        messaging_public_url: str,
        client_state_secret: str,
        http: httpx.AsyncClient,
    ) -> None:
        self._app_id = app_id
        self._credential = credential
        self._keyring = keyring
        self._notification_url = public_url(messaging_public_url, notifications_path())
        self._client_state_secret = client_state_secret
        self._http = http
        self._home_tokens = TeamsTokenProvider(
            tenant_id=home_tenant_id, app_id=app_id, credential=credential, http=http
        )
        self._org_tokens: dict[str, TeamsTokenProvider] = {}
        self.bot_authenticator = BotFrameworkAuthenticator(
            app_id=app_id,
            keys=SigningKeys(metadata_url=BOTFRAMEWORK_OPENID, http=http),
        )
        # One set of Microsoft identity platform keys signs both Graph's
        # validation tokens and the id token an approving admin signs in with.
        self._identity_keys = SigningKeys(
            metadata_url=MICROSOFT_IDENTITY_OPENID, http=http
        )
        self.notification_authenticator = GraphNotificationAuthenticator(
            app_id=app_id, keys=self._identity_keys
        )

    @classmethod
    def from_config(cls, config: SwitchConfig) -> TeamsSharedApp:
        assert config.teams_app_client_id is not None
        assert config.teams_app_tenant_id is not None
        assert config.teams_app_notification_certificate is not None
        assert config.teams_app_notification_private_key is not None
        assert config.messaging_public_url is not None
        current = NotificationKey(
            certificate_id=_notification_certificate_id(
                config.teams_app_notification_private_key
            ),
            private_key=load_private_key(config.teams_app_notification_private_key),
        )
        retired: tuple[NotificationKey, ...] = ()
        if config.teams_app_notification_previous_private_key:
            retired = (
                NotificationKey(
                    certificate_id=_notification_certificate_id(
                        config.teams_app_notification_previous_private_key
                    ),
                    private_key=load_private_key(
                        config.teams_app_notification_previous_private_key
                    ),
                ),
            )
        return cls(
            app_id=config.teams_app_client_id,
            home_tenant_id=config.teams_app_tenant_id,
            credential=_credential(config),
            keyring=NotificationKeyring(
                current=current,
                certificate_der_b64=load_certificate_der_b64(
                    config.teams_app_notification_certificate
                ),
                retired=retired,
            ),
            messaging_public_url=config.messaging_public_url,
            client_state_secret=config.jwt_secret_key,
            http=httpx.AsyncClient(timeout=30),
        )

    @property
    def app_id(self) -> str:
        return self._app_id

    @property
    def http(self) -> httpx.AsyncClient:
        return self._http

    @property
    def credential(self) -> ClientCredential:
        return self._credential

    async def verify_id_token(self, id_token: str) -> dict[str, Any]:
        """The claims of an id token Microsoft issued to this app, verified.

        Checked as Microsoft asks of a multi-tenant app: signed by a Microsoft
        identity platform key, addressed to this app, current, and issued by
        the organisation it names — the issuer carries the organisation's id,
        so a token from one organisation cannot claim to be another's.
        """
        return await verify_microsoft_id_token(
            id_token, app_id=self._app_id, keys=self._identity_keys
        )

    def client_state_for(self, org_tenant_id: str) -> str:
        return client_state_for(self._client_state_secret, org_tenant_id)

    def org_tokens(self, org_tenant_id: str) -> TeamsTokenProvider:
        """The provider of Graph tokens issued in one organisation's directory."""
        provider = self._org_tokens.get(org_tenant_id)
        if provider is None:
            provider = TeamsTokenProvider(
                tenant_id=org_tenant_id,
                app_id=self._app_id,
                credential=self._credential,
                http=self._http,
            )
            self._org_tokens[org_tenant_id] = provider
        return provider

    def tokens_for(self, org_tenant_id: str) -> OrgTokens:
        return OrgTokens(home=self._home_tokens, org=self.org_tokens(org_tenant_id))

    def identity_for(self, org_tenant_id: str) -> TeamsIdentity:
        return TeamsIdentity(
            app_id=self._app_id,
            org_tenant_id=org_tenant_id,
            shared=True,
            notification_url=self._notification_url,
            client_state=self.client_state_for(org_tenant_id),
            keyring=self._keyring,
            allowed_service_hosts=BOT_CONNECTOR_HOSTS,
            required_graph_roles=REQUIRED_GRAPH_ROLES,
        )

    def attach_if_teams(self, adapter: CollaborationAdapter) -> None:
        """Hand a starting Teams bridge on the distributed app this app.

        Registered as a bridge-starting listener, so it runs before the bridge
        does anything. Unconditional, unlike Discord's: there is no socket to
        wait for, so a bridge never starts without what it needs.
        """
        if isinstance(adapter, TeamsAdapter) and adapter.serves_shared_app:
            adapter.attach_shared_app(self)

    async def aclose(self) -> None:
        await self._http.aclose()
