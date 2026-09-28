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
    mint_compact,
    verify,
    verify_compact,
)
from switch_core.keys import Keyring, Purpose

_MASTER = "a" * 40
_KEYRING = Keyring.parse(f"k1:{_MASTER}", legacy_secret=None)
_LEGACY = "test-jwt-secret"

_STATE = InstallState(tenant_id="tenant-a", state_id="state-1", platform="slack")


def test_a_minted_state_verifies_back_to_what_went_in() -> None:
    assert verify(mint(_STATE, keyring=_KEYRING), keyring=_KEYRING) == _STATE


def test_the_token_is_safe_in_a_url() -> None:
    """It travels as a query parameter through a redirect the platform builds."""
    token = mint(_STATE, keyring=_KEYRING)
    assert all(c.isalnum() or c in "-_." for c in token)


class TestForgery:
    def test_an_edited_tenant_is_refused(self) -> None:
        """The attack the signature exists to stop.

        Swapping the tenant in a captured state is how you would attach your
        own workspace to someone else's rooms.
        """
        token = mint(_STATE, keyring=_KEYRING)
        payload, signature = token.removeprefix("v1.").split(".")
        decoded = json.loads(base64.urlsafe_b64decode(payload + "=="))
        decoded["tid"] = "tenant-b"
        forged = (
            base64.urlsafe_b64encode(json.dumps(decoded).encode()).decode().rstrip("=")
        )

        with pytest.raises(InstallStateError):
            verify(f"v1.{forged}.{signature}", keyring=_KEYRING)

    def test_a_state_from_another_deployment_is_refused(self) -> None:
        token = mint(
            _STATE, keyring=Keyring.parse(f"k1:{'b' * 40}", legacy_secret=None)
        )
        with pytest.raises(InstallStateError, match="not signed by this deployment"):
            verify(token, keyring=_KEYRING)

    def test_the_key_is_not_the_master_key_itself(self) -> None:
        """Domain separation, so one signature can never be read as the other.

        Asserted by construction rather than by outcome: the token is signed
        under a derived key, so signing the same payload with the raw master
        secret produces something this refuses.
        """
        token = mint(_STATE, keyring=_KEYRING)
        payload = token.removeprefix("v1.").split(".")[0]
        raw = hmac.new(_MASTER.encode(), payload.encode(), hashlib.sha256).digest()
        naive = base64.urlsafe_b64encode(raw).decode().rstrip("=")

        with pytest.raises(InstallStateError):
            verify(f"v1.{payload}.{naive}", keyring=_KEYRING)


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
            "v2." + mint(_STATE, keyring=_KEYRING).removeprefix("v1."),
        ],
    )
    def test_garbage_is_an_error_and_not_a_crash(self, token: str) -> None:
        """Reachable by anyone who finds the callback URL.

        Every one of these has to be a refused install rather than a traceback,
        because the caller is unauthenticated by nature.
        """
        with pytest.raises(InstallStateError):
            verify(token, keyring=_KEYRING)

    def test_a_well_signed_payload_that_is_not_a_state_is_refused(self) -> None:
        """Signed by us, but not this. A key used for two things is a bug."""
        payload = base64.urlsafe_b64encode(b'{"sub":"agent-1"}').decode().rstrip("=")
        key = _KEYRING.derive(Purpose.INSTALL_STATE)
        signature = (
            base64.urlsafe_b64encode(
                hmac.new(key, payload.encode(), hashlib.sha256).digest()
            )
            .decode()
            .rstrip("=")
        )

        with pytest.raises(InstallStateError, match="malformed"):
            verify(f"v1.{payload}.{signature}", keyring=_KEYRING)


def _legacy_token(secret: str) -> str:
    """A state as it was signed with `JWT_SECRET_KEY` before `SECRET_KEYS`."""
    payload = (
        base64.urlsafe_b64encode(
            json.dumps(
                {"plat": "slack", "sid": "state-1", "tid": "tenant-a"},
                separators=(",", ":"),
                sort_keys=True,
            ).encode()
        )
        .decode()
        .rstrip("=")
    )
    key = hmac.new(
        secret.encode(), b"switch/messaging-install-state/v1", hashlib.sha256
    ).digest()
    signature = hmac.new(key, payload.encode(), hashlib.sha256).digest()
    return f"v1.{payload}.{base64.urlsafe_b64encode(signature).decode().rstrip('=')}"


class TestKeyChanges:
    def test_a_state_minted_before_a_rotation_still_verifies(self) -> None:
        rotated = Keyring.parse(f"k2:{'c' * 40},k1:{_MASTER}", legacy_secret=None)
        assert verify(mint(_STATE, keyring=_KEYRING), keyring=rotated) == _STATE

    def test_a_state_signed_with_the_legacy_secret_verifies_while_it_is_set(
        self,
    ) -> None:
        keyring = Keyring.parse(f"k1:{_MASTER}", legacy_secret=_LEGACY)
        assert verify(_legacy_token(_LEGACY), keyring=keyring) == _STATE

    def test_and_not_once_it_is_removed(self) -> None:
        with pytest.raises(InstallStateError, match="not signed"):
            verify(_legacy_token(_LEGACY), keyring=_KEYRING)


class TestTheCompactForm:
    """The form a Telegram deep link can carry: 64 characters at most, from
    `[A-Za-z0-9_-]`, and bound to its platform by the key rather than a field."""

    _STATE = InstallState(
        tenant_id="3f1c2a8e-7b4d-4e0a-9c6f-1d2e3f4a5b6c",
        state_id="a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d",
        platform="telegram",
    )

    def test_it_verifies_back_to_what_went_in(self) -> None:
        token = mint_compact(self._STATE, keyring=_KEYRING)
        assert (
            verify_compact(token, platform="telegram", keyring=_KEYRING) == self._STATE
        )

    def test_it_fits_a_telegram_start_parameter(self) -> None:
        token = mint_compact(self._STATE, keyring=_KEYRING)
        assert len(token) <= 64
        assert all(c.isalnum() or c in "-_" for c in token)

    def test_a_token_for_another_platform_is_refused(self) -> None:
        token = mint_compact(self._STATE, keyring=_KEYRING)
        with pytest.raises(InstallStateError):
            verify_compact(token, platform="discord", keyring=_KEYRING)

    def test_a_token_from_another_deployment_is_refused(self) -> None:
        token = mint_compact(
            self._STATE, keyring=Keyring.parse(f"k1:{'b' * 40}", legacy_secret=None)
        )
        with pytest.raises(InstallStateError):
            verify_compact(token, platform="telegram", keyring=_KEYRING)

    def test_an_edited_tenant_is_refused(self) -> None:
        token = mint_compact(self._STATE, keyring=_KEYRING)
        raw = bytearray(base64.urlsafe_b64decode(token.removeprefix("c1") + "=="))
        raw[0] ^= 0x01
        forged = "c1" + base64.urlsafe_b64encode(bytes(raw)).decode().rstrip("=")

        with pytest.raises(InstallStateError):
            verify_compact(forged, platform="telegram", keyring=_KEYRING)

    def test_a_truncated_token_is_refused(self) -> None:
        token = mint_compact(self._STATE, keyring=_KEYRING)
        with pytest.raises(InstallStateError):
            verify_compact(token[:-4], platform="telegram", keyring=_KEYRING)

    def test_the_two_forms_do_not_stand_in_for_each_other(self) -> None:
        v1 = mint(self._STATE, keyring=_KEYRING)
        compact = mint_compact(self._STATE, keyring=_KEYRING)

        with pytest.raises(InstallStateError):
            verify_compact(v1, platform="telegram", keyring=_KEYRING)
        with pytest.raises(InstallStateError):
            verify(compact, keyring=_KEYRING)

    def test_ids_that_are_not_uuids_cannot_be_minted(self) -> None:
        """A programming error, raised rather than minted into a token that
        would verify to different ids."""
        with pytest.raises(ValueError):
            mint_compact(_STATE, keyring=_KEYRING)

    def test_a_token_minted_before_a_rotation_still_verifies(self) -> None:
        rotated = Keyring.parse(f"k2:{'c' * 40},k1:{_MASTER}", legacy_secret=None)
        token = mint_compact(self._STATE, keyring=_KEYRING)
        assert (
            verify_compact(token, platform="telegram", keyring=rotated) == self._STATE
        )
