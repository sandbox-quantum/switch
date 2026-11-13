"""Revoking a sign-in at a vendor that takes an access token as the bearer.

Dropbox's `/2/auth/token/revoke` is a POST with the access token in the
Authorization header and no body, and ending one token ends its whole
sign-in. The fake below models that, so these show how Switch handles it, not
that Dropbox behaves so: that was measured against a disposable account.
"""

from __future__ import annotations

import copy
import json
import logging
import time
from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest

from switch_core.connections.adapters import (
    ConnectionSecret,
    ServiceAdapterError,
    ServiceUnavailableError,
)
from switch_core.connections.loader import CATALOG
from tests.switch_core.connections.adapters.test_oauth import (
    DROPBOX_ACCOUNT,
    DROPBOX_READ,
    STATIC,
    _adapter,
    _dropbox_adapter,
    _dropbox_sign_in,
    _sign_in,
)
from tests.switch_core.connections.fake_vendor import ISSUER, FakeOAuthServer, _json

REVOKE = "https://api.dropboxapi.com/2/auth/token/revoke"


class DropboxVendor(FakeOAuthServer):
    """Dropbox's sign-ins as measured: one refresh token and its access
    tokens form a family, and revoking by any access token ends the family."""

    def __init__(self) -> None:
        super().__init__(rotating=False, lifetime=14400)
        self.flat_account = True
        self.account = dict(DROPBOX_ACCOUNT)
        self.family: dict[str, str] = {}
        self.revocations: list[httpx.Request] = []
        self.revoke_answer: tuple[int, Any] | None = None

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        where = f"{url.scheme}://{url.host}{url.path}"
        if where == REVOKE and request.method == "POST":
            return self._revoke(request)
        response = super().handle(request)
        if (
            where == f"{ISSUER}/token"
            and request.method == "POST"
            and response.status_code == 200
        ):
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            body = json.loads(response.content)
            self.family[body["access_token"]] = (
                body.get("refresh_token") or form["refresh_token"]
            )
        return response

    def _revoke(self, request: httpx.Request) -> httpx.Response:
        self.revocations.append(request)
        if self.revoke_answer is not None:
            return _json(*self.revoke_answer)
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        if token not in self.live_access:
            return _json(401, {"error": {".tag": "invalid_access_token"}})
        refresh = self.family[token]
        for access, owner in list(self.family.items()):
            if owner == refresh:
                self.live_access.pop(access, None)
        self.live_refresh.pop(refresh, None)
        return httpx.Response(200, content=b"null")


async def _signed_in() -> tuple[DropboxVendor, Any, ConnectionSecret]:
    vendor = DropboxVendor()
    adapter = _dropbox_adapter(vendor)
    signed_in = await _dropbox_sign_in(adapter, vendor, DROPBOX_READ)
    return vendor, adapter, signed_in.secret


def _expired(secret: ConnectionSecret, *, in_seconds: float = -60) -> ConnectionSecret:
    values = copy.deepcopy(secret.values)
    values["expires_at"] = time.time() + in_seconds
    return ConnectionSecret(values)


def _bearer(request: httpx.Request) -> str:
    return request.headers["authorization"].removeprefix("Bearer ")


def _token_requests(vendor: DropboxVendor, grant: str) -> list[dict[str, str]]:
    return [r for r in vendor.token_requests if r.get("grant_type") == grant]


class TestTheRequest:
    async def test_is_a_bearer_post_with_no_body_and_no_client_fields(self) -> None:
        vendor, adapter, secret = await _signed_in()
        await adapter.revoke_connection(secret)
        [request] = vendor.revocations
        assert request.method == "POST" and str(request.url) == REVOKE
        assert _bearer(request) == secret.access_token
        assert request.content == b""
        assert "content-type" not in request.headers

    async def test_uses_a_live_stored_token_without_asking_for_another(self) -> None:
        vendor, adapter, secret = await _signed_in()
        await adapter.revoke_connection(secret)
        assert len(_token_requests(vendor, "refresh_token")) == 0

    async def test_ends_the_sign_in_and_every_token_made_from_it(self) -> None:
        vendor, adapter, secret = await _signed_in()
        sibling = await adapter.refresh(secret)
        await adapter.revoke_connection(secret)
        assert secret.access_token not in vendor.live_access
        assert sibling.access_token not in vendor.live_access
        assert secret.values["refresh_token"] not in vendor.live_refresh


class TestAnExpiredToken:
    async def test_is_replaced_by_one_from_the_refresh_token_first(self) -> None:
        vendor, adapter, secret = await _signed_in()
        stale = _expired(secret)
        await adapter.revoke_connection(stale)
        [refresh] = _token_requests(vendor, "refresh_token")
        assert refresh["refresh_token"] == secret.values["refresh_token"]
        [request] = vendor.revocations
        assert _bearer(request) not in (secret.access_token, None)
        assert _bearer(request) in vendor.family
        assert secret.values["refresh_token"] not in vendor.live_refresh

    async def test_close_to_expiry_counts_as_expired(self) -> None:
        vendor, adapter, secret = await _signed_in()
        await adapter.revoke_connection(_expired(secret, in_seconds=10))
        assert len(_token_requests(vendor, "refresh_token")) == 1
        assert _bearer(vendor.revocations[0]) != secret.access_token

    async def test_the_temporary_token_is_never_stored(self) -> None:
        vendor, adapter, secret = await _signed_in()
        stale = _expired(secret)
        before = copy.deepcopy(stale.values)
        await adapter.revoke_connection(stale)
        temporary = _bearer(vendor.revocations[0])
        assert stale.values == before
        assert temporary not in json.dumps(stale.values)

    async def test_one_the_vendor_no_longer_takes_is_replaced_and_asked_again(
        self,
    ) -> None:
        vendor, adapter, secret = await _signed_in()
        vendor.live_access.pop(secret.access_token)
        await adapter.revoke_connection(secret)
        first, second = vendor.revocations
        assert _bearer(first) == secret.access_token
        assert _bearer(second) != secret.access_token
        assert len(_token_requests(vendor, "refresh_token")) == 1
        assert secret.values["refresh_token"] not in vendor.live_refresh


class TestASignInAlreadyGone:
    async def test_a_refresh_token_the_vendor_refuses_is_a_revoked_sign_in(
        self,
    ) -> None:
        vendor, adapter, secret = await _signed_in()
        vendor.live_refresh.clear()
        await adapter.revoke_connection(_expired(secret))
        assert vendor.revocations == []

    async def test_so_is_one_whose_access_token_was_refused_too(self) -> None:
        vendor, adapter, secret = await _signed_in()
        vendor.live_access.clear()
        vendor.live_refresh.clear()
        await adapter.revoke_connection(secret)
        [request] = vendor.revocations
        assert _bearer(request) == secret.access_token


class TestFailures:
    async def test_a_refresh_that_cannot_be_made_fails_before_any_revoke(self) -> None:
        vendor, adapter, secret = await _signed_in()
        vendor.fail[f"{ISSUER}/token"] = (503, {})
        with pytest.raises(ServiceUnavailableError):
            await adapter.revoke_connection(_expired(secret))
        assert vendor.revocations == []

    async def test_a_refresh_the_vendor_refuses_for_another_reason_fails(self) -> None:
        vendor, adapter, secret = await _signed_in()
        vendor.fail[f"{ISSUER}/token"] = (400, {"error": "invalid_client"})
        with pytest.raises(ServiceAdapterError, match="refused Switch's token request"):
            await adapter.revoke_connection(_expired(secret))
        assert vendor.revocations == []

    async def test_a_sign_in_with_no_refresh_token_and_no_live_token_says_so(
        self,
    ) -> None:
        vendor, adapter, secret = await _signed_in()
        values = copy.deepcopy(secret.values)
        values["expires_at"] = 0
        del values["refresh_token"]
        with pytest.raises(ServiceAdapterError, match="holds no token to revoke"):
            await adapter.revoke_connection(ConnectionSecret(values))
        assert vendor.revocations == []

    async def test_a_refused_revoke_names_the_status_and_no_token(self) -> None:
        vendor, adapter, secret = await _signed_in()
        vendor.revoke_answer = (403, {"error": "no"})
        with pytest.raises(ServiceAdapterError, match="HTTP 403") as caught:
            await adapter.revoke_connection(secret)
        assert secret.access_token not in str(caught.value)
        assert len(vendor.revocations) == 1

    async def test_a_refused_fresh_token_is_not_retried_again(self) -> None:
        vendor, adapter, secret = await _signed_in()
        vendor.revoke_answer = (401, {"error": {".tag": "invalid_access_token"}})
        with pytest.raises(ServiceAdapterError, match="HTTP 401"):
            await adapter.revoke_connection(_expired(secret))
        assert len(vendor.revocations) == 1
        assert len(_token_requests(vendor, "refresh_token")) == 1

    async def test_a_refused_stored_token_is_asked_once_more_with_a_new_one(
        self,
    ) -> None:
        vendor, adapter, secret = await _signed_in()
        vendor.revoke_answer = (401, {"error": {".tag": "invalid_access_token"}})
        with pytest.raises(ServiceAdapterError, match="HTTP 401"):
            await adapter.revoke_connection(secret)
        assert len(vendor.revocations) == 2
        assert len(_token_requests(vendor, "refresh_token")) == 1

    async def test_the_vendor_being_down_is_unavailable(self) -> None:
        vendor, adapter, secret = await _signed_in()
        vendor.revoke_answer = (503, {})
        with pytest.raises(ServiceUnavailableError):
            await adapter.revoke_connection(secret)


class TestSecrecy:
    async def test_no_token_reaches_a_log_or_an_error(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.DEBUG)
        vendor, adapter, secret = await _signed_in()
        stale = _expired(secret)
        await adapter.revoke_connection(stale)
        temporary = _bearer(vendor.revocations[0])
        vendor.revoke_answer = (500, {})
        with pytest.raises(ServiceUnavailableError) as caught:
            await adapter.revoke_connection(secret)
        secrets_seen = [
            secret.access_token,
            secret.values["refresh_token"],
            temporary,
        ]
        for value in secrets_seen:
            assert value and value not in caplog.text
            assert value not in str(caught.value)


class TestOtherEntriesAreUnchanged:
    def test_only_dropbox_revokes_by_bearer(self) -> None:
        flags = {
            slug: entry.definition.auth.oauth.revocation_bearer
            for slug, entry in CATALOG.items()
            if entry.definition.auth.oauth is not None
        }
        assert {slug for slug, flag in flags.items() if flag} == {"dropbox"}

    def test_only_google_revokes_whole_grants(self) -> None:
        """Dropbox ends the one sign-in it is given and no other of the same
        account (measured), so a reconnect must still revoke the old one."""
        flags = {
            slug: entry.definition.auth.oauth.revocation_ends_grant
            for slug, entry in CATALOG.items()
            if entry.definition.auth.oauth is not None
        }
        assert {slug for slug, flag in flags.items() if flag} == {"google-workspace"}

    def test_google_and_atlassian_keep_the_form_revocation_they_had(self) -> None:
        google = CATALOG["google-workspace"].definition.auth.oauth
        atlassian = CATALOG["atlassian"].definition.auth.oauth
        assert google is not None and atlassian is not None
        assert google.revocation_url == "https://oauth2.googleapis.com/revoke"
        assert google.revocation_discovered is False
        assert (
            atlassian.revocation_discovered is True and atlassian.revocation_url is None
        )
        assert CATALOG["airtable"].definition.auth.oauth.remove_access is not None  # type: ignore[union-attr]

    async def test_an_entry_without_the_setting_still_revokes_with_a_form(self) -> None:
        vendor = FakeOAuthServer()
        adapter, _ = _adapter(
            vendor,
            STATIC.replace(
                "    client_settings: EXAMPLE\n",
                f"    client_settings: EXAMPLE\n    revocation_url: {ISSUER}/revoke\n",
            ),
        )
        secret = await _sign_in(adapter, vendor)
        await adapter.revoke_connection(secret)
        [revoked] = vendor.revoked
        assert revoked["token"] == secret.values["refresh_token"]
        assert revoked["token_type_hint"] == "refresh_token"
