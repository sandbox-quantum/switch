"""A person signing in to a service, for any OAuth/MCP catalog entry.

Switch Console starts a flow with a one-time state, the port of its listener
on 127.0.0.1 and a completion secret. Core keeps the PKCE verifier and
exchanges the code itself, so neither Console nor the browser ever holds a
token. The browser comes back one of two ways, as the catalog allows and this
server can offer:

- **loopback**: the vendor redirects straight to Console's listener.
- **core**: the vendor redirects to Core's callback, which asks the person to
  continue (showing whose Switch account the sign-in will join), then relays
  the code to Console's listener. A cookie set when the browser left through
  Core ties the return to that browser.

Either way Console posts the code back with its completion secret, Core
exchanges it and reads the account, and Console confirms; only then is the
connection written, through `ServiceBroker.connect`.

Flows live in memory, as GitHub's do: ten minutes each, at most 256, one per
person.
"""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlencode

from switch_core.connections.adapters import (
    ReauthorizationRequiredError,
    ServiceAdapterError,
)
from switch_core.connections.adapters.oauth_mcp import (
    Identity,
    OAuthMcpAdapter,
    SignIn,
    s256,
)
from switch_core.connections.loader import (
    AccessLevel,
    ConnectionDefinition,
    RedirectMode,
)
from switch_core.connections.oauth_clients import LOOPBACK_CALLBACK_PATH, core_callback

FLOW_SECONDS = 600
MAX_FLOWS = 256
MAX_CODE_LENGTH = 2048
INTERRUPTED = "Sign-in was interrupted. Start it again from Switch Console."


class FlowError(Exception):
    """The flow cannot go on; the message is for the person."""


@dataclass
class ServiceFlow:
    service: str
    name: str
    tenant_id: str
    user_id: str
    expires_at: float
    mode: RedirectMode
    redirect_uri: str
    port: int
    completion_secret: str
    owner_label: str
    consent: AccessLevel
    scopes: list[str]
    read_scopes: list[str]
    write_scopes: list[str]
    verifier: str
    browser_nonce: str
    # pending → authorizing → (core: returning → delivered) → checking →
    # ready | failed.
    status: str = "pending"
    account: Identity | None = None
    signed_in: SignIn | None = None
    error: str | None = None


def loopback_redirect(port: int) -> str:
    return f"http://127.0.0.1:{port}{LOOPBACK_CALLBACK_PATH}"


class ServiceFlows:
    def __init__(self, public_url: str | None) -> None:
        self._public_url = public_url
        self.flows: dict[str, ServiceFlow] = {}

    def mode(self, definition: ConnectionDefinition) -> RedirectMode | None:
        """The first way back the catalog allows that this server can offer."""
        assert definition.auth.oauth is not None
        for mode in definition.auth.oauth.redirect:
            if mode == "loopback" or self._public_url is not None:
                return mode
        return None

    def authorize_url(self, service: str, state: str) -> str:
        """Core's own step in front of the vendor's, in core mode."""
        assert self._public_url is not None
        return (
            f"{self._public_url.rstrip('/')}/gateway/service-connections/"
            f"{service}/flows/authorize?" + urlencode({"state": state})
        )

    def start(
        self,
        *,
        definition: ConnectionDefinition,
        tenant_id: str,
        user_id: str,
        state: str,
        port: int,
        completion_secret: str,
        owner_label: str,
    ) -> ServiceFlow:
        now = time.time()
        self.flows = {k: v for k, v in self.flows.items() if v.expires_at > now}
        if state in self.flows:
            raise FlowError("This sign-in has already been used. Connect again.")
        for key in [
            key
            for key, flow in self.flows.items()
            if (flow.tenant_id, flow.user_id) == (tenant_id, user_id)
        ]:
            del self.flows[key]
        if len(self.flows) >= MAX_FLOWS:
            raise FlowError(
                "Too many sign-ins are under way. Please try again shortly."
            )
        mode = self.mode(definition)
        if mode is None:
            raise FlowError(
                f"{definition.name} can return a sign-in only to this server, "
                "which has no public address (GATEWAY_PUBLIC_URL)."
            )
        access = definition.access
        assert access is not None
        # Connecting asks for everything a grant may need: write where the
        # service has it. The grant is then on or off.
        consent: AccessLevel = "write" if access.write is not None else "read"
        level = access.write or access.read
        assert level.scopes is not None and access.read.scopes is not None
        flow = ServiceFlow(
            service=definition.slug,
            name=definition.name,
            tenant_id=tenant_id,
            user_id=user_id,
            expires_at=now + FLOW_SECONDS,
            mode=mode,
            redirect_uri=(
                loopback_redirect(port)
                if mode == "loopback"
                else core_callback(self._public_url or "", definition.slug)
            ),
            port=port,
            completion_secret=completion_secret,
            owner_label=owner_label,
            consent=consent,
            scopes=list(level.scopes),
            read_scopes=list(access.read.scopes),
            write_scopes=list(level.scopes) if consent == "write" else [],
            verifier=secrets.token_urlsafe(48),
            browser_nonce=secrets.token_urlsafe(32),
        )
        self.flows[state] = flow
        return flow

    def flow(self, state: str) -> ServiceFlow:
        flow = self.flows.get(state)
        if flow is None or flow.expires_at <= time.time():
            self.flows.pop(state, None)
            raise FlowError(INTERRUPTED)
        return flow

    def owned(self, state: str, tenant_id: str, user_id: str) -> ServiceFlow:
        flow = self.flow(state)
        if (flow.tenant_id, flow.user_id) != (tenant_id, user_id):
            raise FlowError(INTERRUPTED)
        return flow

    async def vendor_url(self, state: str, adapter: OAuthMcpAdapter) -> str:
        """Where the browser signs in at the vendor; once per flow."""
        flow = self.flow(state)
        if flow.status != "pending":
            raise FlowError("This sign-in has already been used. Connect again.")
        flow.status = "authorizing"
        try:
            return await adapter.authorization_url(
                redirect_uri=flow.redirect_uri,
                state=state,
                code_challenge=s256(flow.verifier),
                scopes=flow.scopes,
            )
        except BaseException:
            self.flows.pop(state, None)
            raise

    def returning(self, state: str, code: str, nonce: str) -> ServiceFlow:
        """The browser is back at Core's callback, in core mode."""
        flow = self.flow(state)
        if (
            flow.mode != "core"
            or flow.status not in ("authorizing", "returning")
            or len(code) > MAX_CODE_LENGTH
            or not secrets.compare_digest(flow.browser_nonce, nonce)
        ):
            raise FlowError("The sign-in could not be verified.")
        if not code:
            flow.status = "failed"
            flow.error = f"{flow.name} sign-in was cancelled."
            raise FlowError(flow.error)
        flow.status = "returning"
        return flow

    def deliver(self, state: str, code: str, nonce: str) -> str:
        """The person continued: where their browser takes the code to Console."""
        flow = self.flow(state)
        if (
            flow.mode != "core"
            or flow.status != "returning"
            or not code
            or len(code) > MAX_CODE_LENGTH
            or not secrets.compare_digest(flow.browser_nonce, nonce)
        ):
            raise FlowError("The sign-in could not be verified.")
        flow.status = "delivered"
        return f"{loopback_redirect(flow.port)}?" + urlencode(
            {"code": code, "state": state}
        )

    async def complete(
        self,
        state: str,
        *,
        completion_secret: str,
        code: str,
        adapter: OAuthMcpAdapter,
    ) -> ServiceFlow:
        """Console hands back the code; Core exchanges it and reads the account."""
        flow = self.flow(state)
        ready_for = "authorizing" if flow.mode == "loopback" else "delivered"
        if (
            not secrets.compare_digest(flow.completion_secret, completion_secret)
            or flow.status != ready_for
            or not code
            or len(code) > MAX_CODE_LENGTH
        ):
            raise FlowError(
                f"{flow.name} sign-in could not be verified. Connect again."
            )
        flow.status = "checking"
        try:
            signed_in = await adapter.exchange_code(
                code=code,
                verifier=flow.verifier,
                redirect_uri=flow.redirect_uri,
                scopes=flow.scopes,
            )
            account = await adapter.identify(signed_in.secret.access_token or "")
        except ReauthorizationRequiredError:
            flow.status = "failed"
            flow.error = f"{flow.name} refused the sign-in. Connect again."
            raise FlowError(flow.error) from None
        except ServiceAdapterError as error:
            flow.status = "failed"
            flow.error = str(error)
            raise FlowError(flow.error) from None
        except BaseException:
            flow.status = "failed"
            flow.error = INTERRUPTED
            raise
        flow.signed_in = signed_in
        flow.account = account
        flow.status = "ready"
        return flow

    def consent(self, flow: ServiceFlow) -> AccessLevel:
        """What the person consented to, as the vendor granted it."""
        assert flow.signed_in is not None
        granted = set(flow.signed_in.granted_scopes)
        if flow.write_scopes and set(flow.write_scopes) <= granted:
            return "write"
        if set(flow.read_scopes) <= granted:
            return "read"
        raise FlowError(
            f"{flow.name} granted less than Switch needs to read. Connect again "
            "and allow what it asks for."
        )

    def ready(self, state: str, completion_secret: str) -> ServiceFlow:
        flow = self.flow(state)
        if not secrets.compare_digest(flow.completion_secret, completion_secret):
            raise FlowError(INTERRUPTED)
        if flow.status != "ready":
            raise FlowError(f"Finish signing in to {flow.name} before confirming.")
        return flow
