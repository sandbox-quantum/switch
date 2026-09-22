"""The state token is the only thing binding a tenant across the install.

It is minted on a page a customer's admin loaded and comes back from the
public internet, so every test here is about what happens when what comes back
is not what went out. The consequence of getting it wrong is not a failed
install: it is an attacker's Slack workspace attached to somebody else's
tenant, delivering messages into their rooms.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json

import pytest

from switch_core.bridges.collaboration.install_state import (
    InstallState,
    InstallStateError,
    mint,
    verify,
)

_SECRET = "test-jwt-secret"

_STATE = InstallState(tenant_id="tenant-a", state_id="state-1", platform="slack")


def test_a_minted_state_verifies_back_to_what_went_in() -> None:
    assert verify(mint(_STATE, secret=_SECRET), secret=_SECRET) == _STATE


def test_the_token_is_safe_in_a_url() -> None:
    """It travels as a query parameter through a redirect the platform builds."""
    token = mint(_STATE, secret=_SECRET)
    assert all(c.isalnum() or c in "-_." for c in token)


class TestForgery:
    def test_an_edited_tenant_is_refused(self) -> None:
        """The attack the signature exists to stop.

        Swapping the tenant in a captured state is how you would attach your
        own workspace to someone else's rooms.
        """
        token = mint(_STATE, secret=_SECRET)
        payload, signature = token.removeprefix("v1.").split(".")
        decoded = json.loads(base64.urlsafe_b64decode(payload + "=="))
        decoded["tid"] = "tenant-b"
        forged = (
            base64.urlsafe_b64encode(json.dumps(decoded).encode()).decode().rstrip("=")
        )

        with pytest.raises(InstallStateError):
            verify(f"v1.{forged}.{signature}", secret=_SECRET)

    def test_a_state_from_another_deployment_is_refused(self) -> None:
        token = mint(_STATE, secret="a-different-secret")
        with pytest.raises(InstallStateError, match="not signed by this deployment"):
            verify(token, secret=_SECRET)

    def test_the_key_is_not_the_jwt_key_itself(self) -> None:
        """Domain separation, so one signature can never be read as the other.

        Asserted by construction rather than by outcome: the token is signed
        under a derived key, so signing the same payload with the raw secret
        produces something this refuses.
        """
        token = mint(_STATE, secret=_SECRET)
        payload = token.removeprefix("v1.").split(".")[0]
        raw = hmac.new(_SECRET.encode(), payload.encode(), hashlib.sha256).digest()
        naive = base64.urlsafe_b64encode(raw).decode().rstrip("=")

        with pytest.raises(InstallStateError):
            verify(f"v1.{payload}.{naive}", secret=_SECRET)


class TestMalformed:
    @pytest.mark.parametrize(
        "token",
        [
            "",
            "not-a-token",
            "v1.",
            "v1.only-one-part",
            "v1.a.b.c",
            "v1.!!!.!!!",
            "v2." + mint(_STATE, secret=_SECRET).removeprefix("v1."),
        ],
    )
    def test_garbage_is_an_error_and_not_a_crash(self, token: str) -> None:
        """Reachable by anyone who finds the callback URL.

        Every one of these has to be a refused install rather than a traceback,
        because the caller is unauthenticated by nature.
        """
        with pytest.raises(InstallStateError):
            verify(token, secret=_SECRET)

    def test_a_well_signed_payload_that_is_not_a_state_is_refused(self) -> None:
        """Signed by us, but not this. A key used for two things is a bug."""
        payload = base64.urlsafe_b64encode(b'{"sub":"agent-1"}').decode().rstrip("=")
        key = hmac.new(
            _SECRET.encode(), b"switch/messaging-install-state/v1", hashlib.sha256
        ).digest()
        signature = (
            base64.urlsafe_b64encode(
                hmac.new(key, payload.encode(), hashlib.sha256).digest()
            )
            .decode()
            .rstrip("=")
        )

        with pytest.raises(InstallStateError, match="malformed"):
            verify(f"v1.{payload}.{signature}", secret=_SECRET)
